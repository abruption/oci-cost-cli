// Pure-logic tests — no live OCI/keyring/network calls.
// Run against compiled output with: node --test dist/test/unit.test.js

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createVerify, createPublicKey } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseOciConfig } from '../src/config.js'
import { signRequest } from '../src/signer.js'
import { aggregateUsageAndCost, isFreeTierSkuName, monthRange, lastMonthRange } from '../src/usage.js'
import { applyFilters, freeTierOffenders, filterByServices } from '../src/presets.js'
import { isValidCronExpression, installCronJob } from '../src/cron-install.js'
import { saveTelegramCredential, loadTelegramCredential, maskToken, configFilePath } from '../src/credentials.js'
import { fetchLatestVersion, compareVersions } from '../src/update.js'
import { errMessage } from '../src/main.js'
import type { Profile } from '../src/types.js'
import {
  generateTestKeyPair,
  SAMPLE_OCI_CONFIG,
  sampleUsageItems,
  sampleCostItemsAllFree,
  sampleCostItemsWithOverage,
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
