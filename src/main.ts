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
//   oci-cost-cli --output text|json           output format (default: text). --json is an alias for --output json
//   oci-cost-cli --raw                        (--output json only) also include unaggregated USAGE/COST API items
//   oci-cost-cli --no-color                   disable ANSI colors
//   oci-cost-cli report [same flags] [--dry-run]         send the report to Telegram once
//   oci-cost-cli install-cron --cron "<expr>" [--dry-run] -- report [flags]
//   oci-cost-cli uninstall-cron --cron "<expr>" [--dry-run] -- report [flags]
//   oci-cost-cli list-cron
//   oci-cost-cli config set-telegram --token <t> --chat-id <c> [--dry-run]
//   oci-cost-cli config show
//   oci-cost-cli config clear [--dry-run]
//   oci-cost-cli update [--apply] [--dry-run]
//   oci-cost-cli --version | -v
//   oci-cost-cli --help | -h

import { loadOciConfig } from './config.js'
import { queryMultiProfile, monthRange, lastMonthRange } from './usage.js'
import { applyFilters, freeTierOffenders, isPresetName, PRESET_NAMES } from './presets.js'
import { renderProfileSection, renderFreeTierSummary } from './render.js'
import { sendTelegram } from './telegram.js'
import { installCronJob, uninstallCronJob, listCronJobs, shellQuoteArg } from './cron-install.js'
import {
  saveTelegramCredential,
  loadTelegramCredential,
  deleteTelegramCredential,
  wouldStoreInKeyring,
  maskToken,
} from './credentials.js'
import { fetchLatestVersion, compareVersions, realNpmInstallRunner } from './update.js'
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

type OutputFormat = 'text' | 'json'
const OUTPUT_FORMATS: OutputFormat[] = ['text', 'json']

/**
 * Reads the value for a flag that requires one, rejecting when the next
 * token is itself a recognized flag in this parsing context (or missing
 * entirely) instead of blindly consuming it. Without this, e.g.
 * `--service --output json` lets `--service` silently swallow `--output` as
 * its value, leaving `json` a stray token and `--output` defaulting to
 * text — exactly the bug this guards against.
 */
function requireValue(argv: string[], i: number, flag: string, knownFlags: ReadonlySet<string>): string {
  const v = argv[i]
  if (v === undefined || knownFlags.has(v)) {
    throw new Error(`${flag} requires a value`)
  }
  return v
}

/** Every long flag `parseQueryFlags` recognizes — used both to stop a
 *  value-consuming flag from swallowing a sibling flag, and to reject a
 *  genuinely unrecognized `--xxx` token instead of silently ignoring it. */
const QUERY_FLAGS = new Set([
  '--profile',
  '--month',
  '--last-month',
  '--json',
  '--output',
  '--raw',
  '--preset',
  '--service',
  '--telegram-token',
  '--telegram-chat-id',
  '--dry-run',
  '--no-color',
])

export interface QueryOptions {
  profiles: string[]
  month: string | null
  lastMonth: boolean
  outputFormat: OutputFormat
  raw: boolean
  preset: string | null
  services: string[]
  telegramToken: string | null
  telegramChatId: string | null
  dryRun: boolean
}

/** Exported (alongside `resolveHelpTarget`/`buildScheduledCommand`) so flag
 *  parsing — including the unrecognized/swallowed-flag validation below —
 *  is directly unit-testable without spawning the CLI as a subprocess. */
export function parseQueryFlags(argv: string[], startAt = 0): QueryOptions {
  const o: QueryOptions = {
    profiles: [],
    month: null,
    lastMonth: false,
    outputFormat: 'text',
    raw: false,
    preset: null,
    services: [],
    telegramToken: null,
    telegramChatId: null,
    dryRun: false,
  }
  for (let i = startAt; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--profile') o.profiles.push(requireValue(argv, ++i, '--profile', QUERY_FLAGS))
    else if (a === '--month') o.month = requireValue(argv, ++i, '--month', QUERY_FLAGS)
    else if (a === '--last-month') o.lastMonth = true
    else if (a === '--json') o.outputFormat = 'json' // alias for --output json
    else if (a === '--output') {
      const v = requireValue(argv, ++i, '--output', QUERY_FLAGS)
      if (!OUTPUT_FORMATS.includes(v as OutputFormat)) {
        throw new Error(`invalid --output '${v}' — expected one of: ${OUTPUT_FORMATS.join(', ')}`)
      }
      o.outputFormat = v as OutputFormat
    } else if (a === '--raw') o.raw = true
    else if (a === '--preset') {
      // Validated here (rather than later in applyFilters) so a typo like
      // `--preset comptue` fails before any network I/O — consistent with
      // how --output is already validated eagerly.
      const v = requireValue(argv, ++i, '--preset', QUERY_FLAGS)
      if (!isPresetName(v)) {
        throw new Error(`unknown preset '${v}' — expected one of: ${PRESET_NAMES.join(', ')}`)
      }
      o.preset = v
    } else if (a === '--service') o.services.push(requireValue(argv, ++i, '--service', QUERY_FLAGS))
    else if (a === '--telegram-token') o.telegramToken = requireValue(argv, ++i, '--telegram-token', QUERY_FLAGS)
    else if (a === '--telegram-chat-id')
      o.telegramChatId = requireValue(argv, ++i, '--telegram-chat-id', QUERY_FLAGS)
    else if (a === '--dry-run') o.dryRun = true
    else if (a === '--no-color') process.env.NO_COLOR = '1'
    else if (a.startsWith('--')) throw new Error(`unrecognized flag '${a}'`)
  }
  return o
}

function readPkg(): { name: string; version: string } {
  // Read package.json via fs rather than a JSON import-attribute (Node
  // 18's `assert`/`with` support is inconsistent across patch versions).
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json')
  return JSON.parse(readFileSync(pkgPath, 'utf8')) as { name: string; version: string }
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

/**
 * `raw` includes the unaggregated USAGE/COST API responses alongside the
 * aggregated `lineItems` — for consumers (e.g. an agent) that want to apply
 * their own logic instead of trusting this tool's aggregation heuristics
 * (currency preference, free-tier detection — see README "Aggregation
 * caveats"). `lineItems` still reflects --preset/--service filtering;
 * `raw` is always the complete, unfiltered API response.
 */
function toJson(results: ProfileUsageResult[], raw: boolean): unknown {
  return results.map((r) => ({
    profile: r.profileName,
    tenancy: r.tenancy,
    region: r.region,
    costApiFailed: r.costApiFailed,
    error: r.error ?? null,
    outboundGB: r.outboundGB,
    lineItems: r.lineItems,
    ...(raw ? { raw: r.raw ?? { usage: [], cost: [] } } : {}),
  }))
}

async function runQuery(argv: string[]): Promise<number> {
  const o = parseQueryFlags(argv)
  const results = filteredResults(await fetchResults(o), o)
  if (o.outputFormat === 'json') {
    console.log(JSON.stringify(toJson(results, o.raw), null, 2))
  } else {
    console.log(renderText(results, o))
  }
  return 0
}

const CURRENCY_EMOJI: Record<string, string> = { USD: '💵', SGD: '💵', EUR: '💶', GBP: '💷', JPY: '💴' }

function toTelegramMessage(results: ProfileUsageResult[], o: QueryOptions): string {
  const rangeLabel = o.lastMonth ? 'Last month' : o.month ? o.month : 'This month'
  const lines: string[] = [`📊 <b>OCI Cost Report</b>  <i>(${escapeHtml(rangeLabel)})</i>`]

  for (const r of results) {
    lines.push('')
    lines.push(`━━━━━━━━━━━━━━━`)
    lines.push(`🌐 <b>${escapeHtml(r.profileName)}</b>  <code>${escapeHtml(r.region)}</code>`)

    if (r.error) {
      lines.push(`❌ ${escapeHtml(r.error)}`)
      continue
    }

    const items: AggregatedLineItem[] =
      o.preset === 'free-tier' ? freeTierOffenders(r.lineItems) : r.lineItems

    if (o.preset === 'free-tier') {
      lines.push(
        items.length === 0
          ? '✅ All items within Free Tier'
          : `🚨 ${items.length} item(s) outside Free Tier eligibility`,
      )
      for (const it of items.slice(0, 5)) {
        const amount = it.cost !== null && it.currency !== null ? `${it.cost.toFixed(2)} ${it.currency}` : '?'
        lines.push(`   • ${escapeHtml(it.service)} / ${escapeHtml(it.skuName)} — ${escapeHtml(amount)}`)
      }
    } else {
      const totalsByCurrency = new Map<string, number>()
      for (const it of items) {
        if (it.cost === null || it.currency === null) continue
        totalsByCurrency.set(it.currency, (totalsByCurrency.get(it.currency) ?? 0) + it.cost)
      }
      if (totalsByCurrency.size === 0) {
        lines.push('💤 No cost data for this period')
      }
      for (const [currency, amount] of totalsByCurrency) {
        const emoji = CURRENCY_EMOJI[currency] ?? '💰'
        lines.push(`${emoji} ${amount.toFixed(2)} ${escapeHtml(currency)}`)
      }
      if (r.costApiFailed) lines.push('⚠️ <i>Cost API failed — totals above may be incomplete</i>')
      lines.push(`📤 Outbound: <b>${r.outboundGB.toFixed(3)} GB</b>`)
    }
  }

  return lines.join('\n')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function runReport(argv: string[]): Promise<number> {
  const o = parseQueryFlags(argv)
  const results = filteredResults(await fetchResults(o), o)
  const text = toTelegramMessage(results, o)

  if (o.dryRun) {
    console.log('[dry-run] would send to Telegram:\n')
    console.log(text)
    return 0
  }

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

  const res = await sendTelegram(botToken, chatId, text)
  if (res.status !== 200) {
    console.error(`Telegram send failed: HTTP ${res.status} ${res.body.slice(0, 200)}`)
    return 1
  }
  console.log('✓ report sent to Telegram')
  return 0
}

/**
 * Builds the shell-safe command line written into the crontab by
 * `install-cron`. Each token (including the node binary and script path,
 * which can themselves contain spaces on some installs) is individually
 * shell-quoted rather than joined with a bare space — see
 * `shellQuoteArg`'s doc comment for why. `execPath`/`scriptPath` are
 * injectable (default to the real `process.*` values) so this is directly
 * unit-testable without depending on the actual running process.
 */
export function buildScheduledCommand(
  trailingArgs: string[],
  execPath: string = process.execPath,
  scriptPath: string = process.argv[1] ?? '',
): string {
  return [execPath, scriptPath, ...trailingArgs].map(shellQuoteArg).join(' ')
}

/** Flags recognized by `install-cron`/`uninstall-cron`'s own parsing loop
 *  (everything before the `--` separator). */
const CRON_FLAGS = new Set(['--cron', '--dry-run'])

/**
 * Parses the shared `--cron "<expr>" [--dry-run] -- <subcommand> [flags]`
 * shape used by both `install-cron` and `uninstall-cron`. Returns null (and
 * prints the relevant error) when the arguments are incomplete; throws for
 * a genuinely unrecognized flag or a value-consuming flag that would
 * swallow another recognized flag. Exported for direct unit testing.
 */
export function parseCronArgs(argv: string[], subcommandName: string): { cronExpr: string; command: string } | null {
  let cronExpr: string | null = null
  let sepIndex = -1
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cron') cronExpr = requireValue(argv, ++i, '--cron', CRON_FLAGS)
    else if (argv[i] === '--dry-run') continue // read separately via argv.includes by each caller
    else if (argv[i] === '--') {
      sepIndex = i
      break
    } else if (argv[i].startsWith('--')) {
      throw new Error(`unrecognized flag '${argv[i]}'`)
    }
  }
  if (!cronExpr) {
    console.error(`${subcommandName} requires --cron "<5-field expression>"`)
    return null
  }
  if (sepIndex === -1 || sepIndex === argv.length - 1) {
    console.error(`${subcommandName} requires '-- <subcommand> [flags]' (the command that was/would be scheduled)`)
    return null
  }
  const trailing = argv.slice(sepIndex + 1)
  return { cronExpr, command: buildScheduledCommand(trailing) }
}

/** True when the trailing `-- <subcommand> [flags]` scheduled by
 *  `install-cron` includes `--telegram-token`, which would write the live
 *  bot token in plaintext into the crontab. Exported for direct testing. */
export function trailingHasPlaintextTelegramTokenRisk(trailing: string[]): boolean {
  return trailing.includes('--telegram-token')
}

async function runInstallCron(argv: string[]): Promise<number> {
  const dryRun = argv.includes('--dry-run')
  const sepIndex = argv.indexOf('--')
  const trailing = sepIndex === -1 ? [] : argv.slice(sepIndex + 1)

  // Passing the live Telegram token as an argv flag means it gets written
  // in PLAINTEXT into the crontab line (readable via `crontab -l`),
  // undermining the keyring/0600-file storage model config set-telegram
  // provides. Warn loudly rather than silently allowing it.
  if (trailingHasPlaintextTelegramTokenRisk(trailing)) {
    console.error(
      '⚠️  --telegram-token was passed to install-cron — the token will be stored in PLAINTEXT in your crontab ' +
        "(readable via 'crontab -l'). Prefer 'oci-cost-cli config set-telegram --token <t> --chat-id <c>' " +
        "(OS keyring / 0600 file) and omit --telegram-token here so 'report' reads the stored credential instead.",
    )
  }

  let parsed: { cronExpr: string; command: string } | null
  try {
    parsed = parseCronArgs(argv, 'install-cron')
  } catch (e) {
    console.error(errMessage(e))
    return 1
  }
  if (!parsed) return 1
  const { cronExpr, command } = parsed

  try {
    const result = installCronJob(cronExpr, command, undefined, dryRun)
    if (result.alreadyPresent) {
      console.log(`✓ already scheduled: ${result.line}`)
    } else if (result.dryRun) {
      console.log(`[dry-run] would add to crontab: ${result.line}`)
    } else {
      console.log(`✓ scheduled: ${result.line}`)
    }
    return 0
  } catch (e) {
    console.error(errMessage(e))
    return 1
  }
}

async function runUninstallCron(argv: string[]): Promise<number> {
  const dryRun = argv.includes('--dry-run')

  let parsed: { cronExpr: string; command: string } | null
  try {
    parsed = parseCronArgs(argv, 'uninstall-cron')
  } catch (e) {
    console.error(errMessage(e))
    return 1
  }
  if (!parsed) return 1
  const { cronExpr, command } = parsed

  try {
    const result = uninstallCronJob(cronExpr, command, undefined, dryRun)
    if (!result.found) {
      console.log(`no matching cron line found — nothing to remove: ${result.line}`)
    } else if (result.dryRun) {
      console.log(`[dry-run] would remove from crontab: ${result.line}`)
    } else {
      console.log(`✓ removed: ${result.line}`)
    }
    return 0
  } catch (e) {
    console.error(errMessage(e))
    return 1
  }
}

async function runListCron(): Promise<number> {
  const lines = listCronJobs()
  if (lines.length === 0) {
    console.log('no oci-cost-cli cron jobs installed')
    return 0
  }
  for (const line of lines) console.log(line)
  return 0
}

const SET_TELEGRAM_FLAGS = new Set(['--token', '--chat-id', '--dry-run'])

export interface SetTelegramArgs {
  token: string | null
  chatId: string | null
  dryRun: boolean
}

/** Pure flag parsing for `config set-telegram`, extracted so the
 *  unrecognized/swallowed-flag validation is directly unit-testable
 *  without going through the async credential-saving side effects. */
export function parseSetTelegramArgs(argv: string[], startAt = 1): SetTelegramArgs {
  let token: string | null = null
  let chatId: string | null = null
  let dryRun = false
  for (let i = startAt; i < argv.length; i++) {
    if (argv[i] === '--token') token = requireValue(argv, ++i, '--token', SET_TELEGRAM_FLAGS)
    else if (argv[i] === '--chat-id') chatId = requireValue(argv, ++i, '--chat-id', SET_TELEGRAM_FLAGS)
    else if (argv[i] === '--dry-run') dryRun = true
    else if (argv[i].startsWith('--')) throw new Error(`unrecognized flag '${argv[i]}'`)
  }
  return { token, chatId, dryRun }
}

async function runConfig(argv: string[]): Promise<number> {
  const sub = argv[0]
  if (sub === 'set-telegram') {
    const { token, chatId, dryRun } = parseSetTelegramArgs(argv)
    if (!token || !chatId) {
      console.error('config set-telegram requires --token <t> --chat-id <c>')
      return 1
    }
    if (dryRun) {
      const wouldUseKeyring = await wouldStoreInKeyring()
      console.log(
        `[dry-run] would save token=${maskToken(token)} chatId=${maskToken(chatId)} to ` +
          (wouldUseKeyring ? 'OS keyring' : 'config file, 0600'),
      )
      return 0
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
    const dryRun = argv.includes('--dry-run')
    if (dryRun) {
      const cred = await loadTelegramCredential()
      console.log(
        cred
          ? `[dry-run] would remove stored credential (token=${maskToken(cred.botToken)})`
          : '[dry-run] no credential stored — nothing to remove',
      )
      return 0
    }
    await deleteTelegramCredential()
    console.log('✓ Telegram credential removed (keyring + config file)')
    return 0
  }
  console.error("unknown 'config' subcommand — expected 'set-telegram', 'show', or 'clear'")
  return 1
}

/**
 * Bare `update` only checks and reports — it never touches global npm
 * packages by itself, matching every other side-effecting subcommand's
 * --dry-run-by-default spirit. `--apply` is required to actually install;
 * `--apply --dry-run` previews the exact npm command without running it.
 */
async function runUpdate(argv: string[]): Promise<number> {
  const apply = argv.includes('--apply')
  const dryRun = argv.includes('--dry-run')
  const pkg = readPkg()

  let latest: string
  try {
    latest = await fetchLatestVersion(pkg.name)
  } catch (e) {
    console.error(`could not check npm registry for updates: ${errMessage(e)}`)
    return 1
  }

  if (compareVersions(pkg.version, latest) >= 0) {
    console.log(`✓ already up to date (${pkg.version})`)
    return 0
  }

  console.log(`update available: ${pkg.version} → ${latest}`)
  if (!apply) {
    console.log(`run 'oci-cost-cli update --apply' to install, or manually: npm install -g ${pkg.name}@${latest}`)
    return 0
  }
  if (dryRun) {
    console.log(`[dry-run] would run: npm install -g ${pkg.name}@${latest}`)
    return 0
  }

  const result = realNpmInstallRunner(pkg.name, latest)
  if (!result.ok) {
    console.error(`npm install failed:\n${result.output}`)
    return 1
  }
  console.log(`✓ updated to ${latest}`)
  return 0
}

function printHelp(): void {
  console.log(`oci-cost-cli — OCI cost/usage/outbound-traffic summary across multiple profiles

Usage:
  oci-cost-cli [--profile <name>]... [--month YYYY-MM | --last-month] [--preset <name>] [--service <name>]... [--output text|json] [--raw] [--no-color]
  oci-cost-cli report [same flags] [--telegram-token <t> --telegram-chat-id <c>] [--dry-run]
  oci-cost-cli install-cron --cron "<5-field expr>" [--dry-run] -- report [flags]
  oci-cost-cli uninstall-cron --cron "<5-field expr>" [--dry-run] -- report [flags]
  oci-cost-cli list-cron
  oci-cost-cli config set-telegram --token <t> --chat-id <c> [--dry-run]
  oci-cost-cli config show
  oci-cost-cli config clear [--dry-run]
  oci-cost-cli update [--apply] [--dry-run]
  oci-cost-cli --version | -v
  oci-cost-cli --help | -h

Presets: free-tier, compute, storage, network
--json is an alias for --output json. --raw only applies to --output json.
update checks npm for a newer version; --apply installs it (npm install -g), --dry-run previews.`)
}

const SUBCOMMAND_HELP: Record<string, string> = {
  report: `oci-cost-cli report — send the cost/usage report to Telegram once

Usage:
  oci-cost-cli report [--profile <name>]... [--month YYYY-MM | --last-month] [--preset <name>] [--service <name>]... [--telegram-token <t> --telegram-chat-id <c>] [--dry-run]

Same query flags as the base command, formatted for Telegram (HTML). Uses the
stored credential (see 'oci-cost-cli config set-telegram') unless
--telegram-token/--telegram-chat-id are passed explicitly.
--dry-run prints the message that would be sent instead of sending it.`,
  'install-cron': `oci-cost-cli install-cron — schedule a command in the system crontab

Usage:
  oci-cost-cli install-cron --cron "<5-field expr>" [--dry-run] -- <subcommand> [flags]

Example:
  oci-cost-cli install-cron --cron "0 0 15 * *" -- report

--dry-run previews the crontab line without writing it. A line that is
already present is not duplicated. Avoid passing --telegram-token here — it
would be stored in plaintext in the crontab; use 'config set-telegram' instead.`,
  'uninstall-cron': `oci-cost-cli uninstall-cron — remove a previously scheduled crontab line

Usage:
  oci-cost-cli uninstall-cron --cron "<5-field expr>" [--dry-run] -- <subcommand> [flags]

Removes the exact line 'install-cron' would have added for the same --cron
and trailing subcommand/flags. --dry-run previews without writing.`,
  'list-cron': `oci-cost-cli list-cron — show currently installed oci-cost-cli cron lines

Usage:
  oci-cost-cli list-cron`,
  config: `oci-cost-cli config — manage the stored Telegram credential

Usage:
  oci-cost-cli config set-telegram --token <t> --chat-id <c> [--dry-run]
  oci-cost-cli config show
  oci-cost-cli config clear [--dry-run]

Credentials are stored in the OS keyring when available, otherwise in
~/.config/oci-cost-cli/config.json (0600). 'show' only ever prints masked
values.`,
  update: `oci-cost-cli update — check npm for a newer version

Usage:
  oci-cost-cli update [--apply] [--dry-run]

Bare 'update' only checks the npm registry and prints; it never modifies
global npm packages. --apply installs the new version (npm install -g).
--apply --dry-run previews the exact command without running it.`,
}

/**
 * -h/--help must win over every subcommand's own flag parsing, because each
 * subcommand parser silently ignores flags it doesn't recognize — so
 * without this short-circuit, `--help` gets dropped and the subcommand runs
 * for real. Two subcommands make that a destructive live side effect
 * (`report --help` sends a real Telegram message; `config clear --help`
 * deletes the stored credential), so this check must run before ANY
 * subcommand dispatch, network call, or file write.
 *
 * Scans the whole argv, not just position 0, so `report --profile X --help`
 * is caught too. Returns the subcommand name to show targeted help for, or
 * 'general' for the top-level help, or null if no help flag is present.
 */
export function resolveHelpTarget(argv: string[]): string | null {
  if (!argv.includes('-h') && !argv.includes('--help')) return null
  const sub = argv[0]
  return sub !== undefined && sub in SUBCOMMAND_HELP ? sub : 'general'
}

function printHelpFor(target: string): void {
  if (target === 'general') printHelp()
  else console.log(SUBCOMMAND_HELP[target])
}

/**
 * Scans the whole argv for -v/--version, not just position 0 — the same fix
 * `resolveHelpTarget` already applies to -h/--help (see its doc comment).
 * Without this, `oci-cost-cli --profile DEFAULT --version` silently runs a
 * real query instead of printing the version, because every subcommand
 * parser silently ignores flags it doesn't recognize.
 */
export function resolveVersionRequested(argv: string[]): boolean {
  return argv.includes('-v') || argv.includes('--version')
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  if (argv.includes('--no-color')) process.env.NO_COLOR = '1'

  const helpTarget = resolveHelpTarget(argv)
  if (helpTarget) {
    printHelpFor(helpTarget)
    return 0
  }
  if (resolveVersionRequested(argv)) {
    console.log(readPkg().version)
    return 0
  }

  try {
    if (argv[0] === 'report') return await runReport(argv.slice(1))
    if (argv[0] === 'install-cron') return await runInstallCron(argv.slice(1))
    if (argv[0] === 'uninstall-cron') return await runUninstallCron(argv.slice(1))
    if (argv[0] === 'list-cron') return await runListCron()
    if (argv[0] === 'config') return await runConfig(argv.slice(1))
    if (argv[0] === 'update') return await runUpdate(argv.slice(1))
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
