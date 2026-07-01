#!/usr/bin/env node
// oci-cost-cli — fast, readable OCI cost/usage/outbound-traffic summary
// across multiple ~/.oci/config profiles. No OCI SDK, no Python oci-cli.
//
// Usage:
//   oci-cost-cli                              current-month-to-date, all profiles
//   oci-cost-cli --profile DEFAULT            scope to one profile (repeatable)
//   oci-cost-cli --month 2026-06              a specific month
//   oci-cost-cli --last-month                 previous calendar month
//   oci-cost-cli --preset free-tier           only items outside Free Tier
//   oci-cost-cli --preset compute|storage|network
//   oci-cost-cli --service <name>             custom service filter (repeatable)
//   oci-cost-cli --json                       machine-readable aggregated output
//   oci-cost-cli --no-color                   disable ANSI colors
//   oci-cost-cli report [same flags]          send the report to Telegram once
//   oci-cost-cli install-cron --cron "<expr>" -- report [flags]
//   oci-cost-cli config set-telegram --token <t> --chat-id <c>
//   oci-cost-cli config show
//   oci-cost-cli config clear
//   oci-cost-cli --version | -v
//   oci-cost-cli --help | -h

import { loadOciConfig } from './config.js'
import { queryMultiProfile, monthRange, lastMonthRange } from './usage.js'
import { applyFilters, freeTierOffenders } from './presets.js'
import { renderProfileSection, renderFreeTierSummary } from './render.js'
import { sendTelegram } from './telegram.js'
import { installCronJob } from './cron-install.js'
import { saveTelegramCredential, loadTelegramCredential, deleteTelegramCredential, maskToken } from './credentials.js'
import type { AggregatedLineItem, Profile, ProfileUsageResult, UsageQueryRange } from './types.js'
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Node's AggregateError (e.g. thrown by `net.connect`'s Happy Eyeballs
 * dual-stack IPv4/IPv6 connection attempts on ETIMEDOUT/ECONNREFUSED) very
 * often has an EMPTY top-level `.message` — the real detail lives in
 * `.errors[]`. Using `e.message` blindly there prints a blank line and the
 * process just silently exits 1. Found via a real macOS network timeout
 * hitting the Telegram API during `report`.
 */
export const errMessage = (e: unknown): string => {
  if (e instanceof AggregateError) {
    const inner = e.errors.map((err) => errMessage(err)).join('; ')
    return e.message || inner || e.constructor.name
  }
  if (e instanceof Error) return e.message || e.constructor.name
  return String(e)
}

interface QueryOptions {
  profiles: string[]
  month: string | null
  lastMonth: boolean
  json: boolean
  preset: string | null
  services: string[]
  telegramToken: string | null
  telegramChatId: string | null
}

function parseQueryFlags(argv: string[], startAt = 0): QueryOptions {
  const o: QueryOptions = {
    profiles: [],
    month: null,
    lastMonth: false,
    json: false,
    preset: null,
    services: [],
    telegramToken: null,
    telegramChatId: null,
  }
  for (let i = startAt; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--profile') o.profiles.push(argv[++i])
    else if (a === '--month') o.month = argv[++i]
    else if (a === '--last-month') o.lastMonth = true
    else if (a === '--json') o.json = true
    else if (a === '--preset') o.preset = argv[++i]
    else if (a === '--service') o.services.push(argv[++i])
    else if (a === '--telegram-token') o.telegramToken = argv[++i]
    else if (a === '--telegram-chat-id') o.telegramChatId = argv[++i]
    else if (a === '--no-color') process.env.NO_COLOR = '1'
  }
  return o
}

function resolveProfiles(all: Map<string, Profile>, wanted: string[]): Profile[] {
  if (wanted.length === 0) return [...all.values()]
  return wanted.map((name) => {
    const p = all.get(name)
    if (!p) throw new Error(`unknown profile '${name}' — not found in ~/.oci/config`)
    return p
  })
}

function resolveRange(o: QueryOptions): UsageQueryRange {
  if (o.lastMonth) return lastMonthRange()
  return monthRange(o.month ?? undefined)
}

function filteredResults(results: ProfileUsageResult[], o: QueryOptions): ProfileUsageResult[] {
  return results.map((r) => ({
    ...r,
    lineItems: applyFilters(r.lineItems, { preset: o.preset ?? undefined, services: o.services }),
  }))
}

async function fetchResults(o: QueryOptions): Promise<ProfileUsageResult[]> {
  const { profiles: allProfiles, errors } = loadOciConfig()
  for (const e of errors) {
    console.error(`⚠️  profile [${e.section}]: ${e.message}`)
  }
  const profiles = resolveProfiles(allProfiles, o.profiles)
  const range = resolveRange(o)
  return queryMultiProfile(profiles, range)
}

function renderText(results: ProfileUsageResult[], o: QueryOptions): string {
  if (o.preset === 'free-tier') {
    return results
      .map((r) => renderFreeTierSummary(r.profileName, freeTierOffenders(r.lineItems)))
      .join('\n\n')
  }
  const sections = results.map(renderProfileSection)
  return sections.join('\n\n')
}

function toJson(results: ProfileUsageResult[]): unknown {
  return results.map((r) => ({
    profile: r.profileName,
    tenancy: r.tenancy,
    region: r.region,
    costApiFailed: r.costApiFailed,
    error: r.error ?? null,
    outboundGB: r.outboundGB,
    lineItems: r.lineItems,
  }))
}

async function runQuery(argv: string[]): Promise<number> {
  const o = parseQueryFlags(argv)
  const results = filteredResults(await fetchResults(o), o)
  if (o.json) {
    console.log(JSON.stringify(toJson(results), null, 2))
  } else {
    console.log(renderText(results, o))
  }
  return 0
}

function toTelegramMessage(results: ProfileUsageResult[], o: QueryOptions): string {
  const lines: string[] = ['<b>OCI Cost Report</b>']
  for (const r of results) {
    lines.push('')
    lines.push(`<b>${escapeHtml(r.profileName)}</b> (${escapeHtml(r.region)})`)
    if (r.error) {
      lines.push(`✗ ${escapeHtml(r.error)}`)
      continue
    }
    const items: AggregatedLineItem[] =
      o.preset === 'free-tier' ? freeTierOffenders(r.lineItems) : r.lineItems
    if (o.preset === 'free-tier') {
      lines.push(items.length === 0 ? '✅ all items within Free Tier' : `⚠️ ${items.length} item(s) outside Free Tier`)
    } else {
      const totalsByCurrency = new Map<string, number>()
      for (const it of items) {
        if (it.cost === null || it.currency === null) continue
        totalsByCurrency.set(it.currency, (totalsByCurrency.get(it.currency) ?? 0) + it.cost)
      }
      for (const [currency, amount] of totalsByCurrency) {
        lines.push(`Cost: ${amount.toFixed(2)} ${currency}`)
      }
      if (r.costApiFailed) lines.push('⚠️ Cost API failed — totals above may be incomplete')
      lines.push(`Outbound: ${r.outboundGB.toFixed(3)} GB`)
    }
  }
  return lines.join('\n')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function runReport(argv: string[]): Promise<number> {
  const o = parseQueryFlags(argv)
  let botToken = o.telegramToken
  let chatId = o.telegramChatId
  if (!botToken || !chatId) {
    const stored = await loadTelegramCredential()
    botToken ??= stored?.botToken ?? null
    chatId ??= stored?.chatId ?? null
  }
  if (!botToken || !chatId) {
    console.error(
      "no Telegram credential available — run 'oci-cost-cli config set-telegram --token <t> --chat-id <c>' " +
        'first, or pass --telegram-token/--telegram-chat-id explicitly',
    )
    return 1
  }

  const results = filteredResults(await fetchResults(o), o)
  const text = toTelegramMessage(results, o)
  const res = await sendTelegram(botToken, chatId, text)
  if (res.status !== 200) {
    console.error(`Telegram send failed: HTTP ${res.status} ${res.body.slice(0, 200)}`)
    return 1
  }
  console.log('✓ report sent to Telegram')
  return 0
}

async function runInstallCron(argv: string[]): Promise<number> {
  let cronExpr: string | null = null
  let sepIndex = -1
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cron') cronExpr = argv[++i]
    else if (argv[i] === '--') {
      sepIndex = i
      break
    }
  }
  if (!cronExpr) {
    console.error("install-cron requires --cron \"<5-field expression>\"")
    return 1
  }
  if (sepIndex === -1 || sepIndex === argv.length - 1) {
    console.error("install-cron requires '-- <subcommand> [flags]' (the command to schedule)")
    return 1
  }
  const trailing = argv.slice(sepIndex + 1)
  const command = `${process.execPath} ${process.argv[1]} ${trailing.join(' ')}`.trim()

  try {
    const result = installCronJob(cronExpr, command)
    if (result.alreadyPresent) {
      console.log(`✓ already scheduled: ${result.line}`)
    } else {
      console.log(`✓ scheduled: ${result.line}`)
    }
    return 0
  } catch (e) {
    console.error(errMessage(e))
    return 1
  }
}

async function runConfig(argv: string[]): Promise<number> {
  const sub = argv[0]
  if (sub === 'set-telegram') {
    let token: string | null = null
    let chatId: string | null = null
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === '--token') token = argv[++i]
      else if (argv[i] === '--chat-id') chatId = argv[++i]
    }
    if (!token || !chatId) {
      console.error('config set-telegram requires --token <t> --chat-id <c>')
      return 1
    }
    const result = await saveTelegramCredential({ botToken: token, chatId })
    console.log(`✓ saved (${result.storedIn === 'keyring' ? 'OS keyring' : 'config file, 0600'})`)
    return 0
  }
  if (sub === 'show') {
    const cred = await loadTelegramCredential()
    if (!cred) {
      console.log('no Telegram credential stored')
      return 0
    }
    console.log(`token:   ${maskToken(cred.botToken)}`)
    console.log(`chat id: ${maskToken(cred.chatId)}`)
    return 0
  }
  if (sub === 'clear') {
    await deleteTelegramCredential()
    console.log('✓ Telegram credential removed (keyring + config file)')
    return 0
  }
  console.error("unknown 'config' subcommand — expected 'set-telegram', 'show', or 'clear'")
  return 1
}

function printHelp(): void {
  console.log(`oci-cost-cli — OCI cost/usage/outbound-traffic summary across multiple profiles

Usage:
  oci-cost-cli [--profile <name>]... [--month YYYY-MM | --last-month] [--preset <name>] [--service <name>]... [--json] [--no-color]
  oci-cost-cli report [same flags] [--telegram-token <t> --telegram-chat-id <c>]
  oci-cost-cli install-cron --cron "<5-field expr>" -- report [flags]
  oci-cost-cli config set-telegram --token <t> --chat-id <c>
  oci-cost-cli config show
  oci-cost-cli config clear
  oci-cost-cli --version | -v
  oci-cost-cli --help | -h

Presets: free-tier, compute, storage, network`)
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  if (argv.includes('--no-color')) process.env.NO_COLOR = '1'
  if (argv[0] === '-h' || argv[0] === '--help') {
    printHelp()
    return 0
  }
  if (argv[0] === '-v' || argv[0] === '--version') {
    // Read package.json via fs rather than a JSON import-attribute (Node
    // 18's `assert`/`with` support is inconsistent across patch versions).
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }
    console.log(pkg.version)
    return 0
  }

  try {
    if (argv[0] === 'report') return await runReport(argv.slice(1))
    if (argv[0] === 'install-cron') return await runInstallCron(argv.slice(1))
    if (argv[0] === 'config') return await runConfig(argv.slice(1))
    return await runQuery(argv)
  } catch (e) {
    console.error(errMessage(e))
    return 1
  }
}

// Only run the CLI when this file is executed directly (as the `bin` entry
// point) — guarded so `errMessage` etc. can be imported for unit testing
// without triggering a full CLI run + process.exit(). Both sides go
// through realpathSync: import.meta.url is already symlink-resolved by
// Node's ESM loader, but a bare `resolve(argv[1])` is not — npm's global
// `bin` entries (and, in this dev environment, even the project directory
// itself) are frequently symlinks, so comparing un-resolved paths here
// silently breaks the installed CLI entirely (verified empirically).
function isMainModule(): boolean {
  if (!process.argv[1]) return false
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
  } catch {
    return false
  }
}

if (isMainModule()) {
  main().then((code) => process.exit(code))
}
