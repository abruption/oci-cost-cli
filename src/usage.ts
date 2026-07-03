import { ociRequest } from './signer.js'
import type {
  AggregatedLineItem,
  Profile,
  ProfileUsageResult,
  UsageLineItem,
  UsageQueryRange,
} from './types.js'

const USAGE_PATH = '/20200107/usage'

/**
 * Injectable seam for the signed HTTP call, mirroring the DI pattern already
 * used by `update.ts` (`RegistryFetcher`) and `credentials.ts` (the
 * `keyring` param) — lets `queryUsageAndCost`/`queryMultiProfile` be unit
 * tested (success, partial-failure, multi-profile aggregation) without a
 * live OCI call. Defaults to the real `ociRequest`.
 */
export type OciRequestFn = (
  profile: Profile,
  method: 'GET' | 'POST',
  host: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; body: string }>

export function usageApiHost(profile: Profile): string {
  return `usageapi.${profile.region}.oci.oraclecloud.com`
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

const MONTH_STR_RE = /^\d{4}-(0[1-9]|1[0-2])$/

/**
 * UTC month range for `monthStr` (YYYY-MM, zero-padded), or the current
 * month-to-date if omitted. Rejects out-of-range/malformed input instead of
 * letting `Date.UTC`'s month-overflow normalization silently roll it into a
 * different (but plausible-looking) range — e.g. `2026-13` would otherwise
 * silently become Jan-Feb 2027 with no error, which is the worst kind of bug
 * for a cost-reporting tool.
 */
export function monthRange(monthStr?: string): UsageQueryRange {
  const now = new Date()
  if (monthStr !== undefined && !MONTH_STR_RE.test(monthStr)) {
    throw new Error(`invalid --month '${monthStr}' — expected format YYYY-MM with month 01-12`)
  }
  const [year, month] = monthStr
    ? monthStr.split('-').map((s) => parseInt(s, 10))
    : [now.getUTCFullYear(), now.getUTCMonth() + 1]

  const start = new Date(Date.UTC(year, month - 1, 1))
  const end = new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1))
  return { start, end }
}

export function lastMonthRange(): UsageQueryRange {
  const now = new Date()
  const year = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear()
  const month = now.getUTCMonth() === 0 ? 12 : now.getUTCMonth()
  return monthRange(`${year}-${pad2(month)}`)
}

function toOciTimestamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, '.000Z')
}

/** SKUs whose name ends in "- Free" (OCI's Always Free tier naming convention). */
export function isFreeTierSkuName(skuName: string): boolean {
  return /-\s*free\b/i.test(skuName)
}

async function fetchUsageItems(
  profile: Profile,
  range: UsageQueryRange,
  queryType: 'USAGE' | 'COST',
  requestFn: OciRequestFn = ociRequest,
): Promise<{ items: UsageLineItem[]; failed: boolean; status: number }> {
  const host = usageApiHost(profile)
  const body = {
    tenantId: profile.tenancy,
    timeUsageStarted: toOciTimestamp(range.start),
    timeUsageEnded: toOciTimestamp(range.end),
    granularity: 'MONTHLY',
    groupBy: ['service', 'skuName', 'unit', 'skuPartNumber'],
    compartmentDepth: 1,
    queryType,
  }

  const res = await requestFn(profile, 'POST', host, USAGE_PATH, body)
  if (res.status !== 200) {
    return { items: [], failed: true, status: res.status }
  }
  const parsed = JSON.parse(res.body) as { items?: unknown[] }
  const items: UsageLineItem[] = (parsed.items ?? []).map((raw) => {
    const r = raw as Record<string, unknown>
    return {
      service: (r.service as string) ?? null,
      skuName: (r.skuName as string) ?? null,
      skuPartNumber: (r.skuPartNumber as string) ?? null,
      unit: (r.unit as string) ?? null,
      computedQuantity: (r.computedQuantity as number) ?? null,
      computedAmount: (r.computedAmount as number) ?? null,
      currency: (r.currency as string) ?? null,
    }
  })
  return { items, failed: false, status: res.status }
}

export interface AggregationResult {
  lineItems: AggregatedLineItem[]
  outboundGB: number
}

interface CostBucket {
  service: string
  skuName: string
  currency: string
  cost: number
}

/**
 * Decides which already-summed-per-currency bucket(s) become line item(s)
 * for a SKU. Mirrors report.js's proven logic for the common cases:
 *  - A single currency: use it as-is.
 *  - USD present alongside other currencies: USD wins, the others are
 *    intentionally dropped (documented in the README).
 * The bug this exists to fix: when there is NO USD entry and 2+ *distinct*
 * non-USD currencies are present (e.g. SGD then EUR, no USD ever reported),
 * the old code silently kept only the first-seen currency and discarded the
 * rest — no summing (correctly, currencies can't be summed), but also no
 * visibility. Returning every bucket in that case means the caller renders
 * one line item per currency instead of losing data.
 */
function resolveCostBuckets(perCurrency: Map<string, CostBucket>): CostBucket[] {
  const buckets = [...perCurrency.values()]
  if (buckets.length <= 1) return buckets
  const usd = buckets.find((b) => b.currency === 'USD')
  return usd ? [usd] : buckets
}

/**
 * Pure aggregation of already-fetched USAGE + COST line items — no I/O, so
 * it's directly unit-testable against fixture JSON without a live OCI call.
 *
 * Preserves gotchas discovered in ~/Projects/oci-traffic-report/report.js:
 *  - The same SKU can appear in multiple currencies (e.g. a $0 free-tier
 *    line reported in both SGD and USD). USD is preferred; non-USD entries
 *    are only summed together (within the same currency) when no USD entry
 *    exists for that SKU. If 2+ *distinct* non-USD currencies are present
 *    with no USD entry, each becomes its own line item — see
 *    `resolveCostBuckets` — rather than silently dropping all but one.
 *  - "outbound data transfer" detection is a case-insensitive substring
 *    match on `skuName` (heuristic, matches OCI's actual SKU naming).
 */
export function aggregateUsageAndCost(
  usageItems: UsageLineItem[],
  costItems: UsageLineItem[],
): AggregationResult {
  // usage aggregation (by service+skuName+unit) + outbound-transfer detection
  const usageByKey = new Map<string, { service: string; skuName: string; unit: string; qty: number }>()
  let outboundGB = 0
  for (const item of usageItems) {
    const service = item.service ?? 'Unknown'
    const skuName = item.skuName ?? service
    const unit = item.unit ?? ''
    const qty = item.computedQuantity ?? 0
    const key = `${service}|${skuName}|${unit}`
    const existing = usageByKey.get(key)
    if (existing) existing.qty += qty
    else usageByKey.set(key, { service, skuName, unit, qty })

    if (skuName.toLowerCase().includes('outbound data transfer')) outboundGB += qty
  }

  // cost aggregation (by service+skuName), bucketed per-currency so a
  // second/third distinct currency is summed within itself instead of
  // being discarded — see resolveCostBuckets for how buckets become rows.
  const costByKey = new Map<string, Map<string, CostBucket>>()
  for (const item of costItems) {
    const service = item.service ?? 'Unknown'
    const skuName = item.skuName ?? service
    const key = `${service}|${skuName}`
    const cost = item.computedAmount ?? 0
    const currency = (item.currency ?? '').trim()
    if (!currency) continue
    let perCurrency = costByKey.get(key)
    if (!perCurrency) {
      perCurrency = new Map()
      costByKey.set(key, perCurrency)
    }
    const existing = perCurrency.get(currency)
    if (existing) existing.cost += cost
    else perCurrency.set(currency, { service, skuName, currency, cost })
  }

  const lineItems: AggregatedLineItem[] = []
  const coveredByUsage = new Set<string>() // service|skuName (unit-agnostic — costByKey has no unit dimension)
  for (const u of usageByKey.values()) {
    const costKey = `${u.service}|${u.skuName}`
    coveredByUsage.add(costKey)
    const buckets = resolveCostBuckets(costByKey.get(costKey) ?? new Map())
    if (buckets.length === 0) {
      lineItems.push({
        service: u.service,
        skuName: u.skuName,
        unit: u.unit,
        quantity: u.qty,
        cost: null,
        currency: null,
        isFreeTierSku: isFreeTierSkuName(u.skuName),
      })
      continue
    }
    buckets.forEach((b, i) => {
      lineItems.push({
        service: u.service,
        skuName: u.skuName,
        // Usage quantity/unit only apply once per SKU — extra currency
        // buckets (the multi-non-USD-currency case) get 0/'' so we don't
        // fabricate duplicate usage.
        unit: i === 0 ? u.unit : '',
        quantity: i === 0 ? u.qty : 0,
        cost: b.cost,
        currency: b.currency,
        isFreeTierSku: isFreeTierSkuName(u.skuName),
      })
    })
  }
  // cost-only line items (rare, but keep parity with report.js which treats
  // usage and cost as separately-sourced aggregates)
  for (const [key, perCurrency] of costByKey) {
    if (coveredByUsage.has(key)) continue
    for (const b of resolveCostBuckets(perCurrency)) {
      lineItems.push({
        service: b.service,
        skuName: b.skuName,
        unit: '',
        quantity: 0,
        cost: b.cost,
        currency: b.currency,
        isFreeTierSku: isFreeTierSkuName(b.skuName),
      })
    }
  }

  return { lineItems, outboundGB }
}

/**
 * Fetches + aggregates USAGE + COST for a single profile.
 *
 * Cost API silently degrades to [] on failure (unlike Usage API, which
 * throws) — surfaced here as `costApiFailed` so callers never render a bare
 * 0.00 as if it were a real total.
 */
export async function queryUsageAndCost(
  profile: Profile,
  range: UsageQueryRange,
  requestFn: OciRequestFn = ociRequest,
): Promise<ProfileUsageResult> {
  let usageRes: Awaited<ReturnType<typeof fetchUsageItems>>
  try {
    usageRes = await fetchUsageItems(profile, range, 'USAGE', requestFn)
  } catch (e) {
    return {
      profileName: profile.name,
      region: profile.region,
      tenancy: profile.tenancy,
      lineItems: [],
      outboundGB: 0,
      costApiFailed: true,
      error: e instanceof Error ? e.message : String(e),
    }
  }
  if (usageRes.failed) {
    return {
      profileName: profile.name,
      region: profile.region,
      tenancy: profile.tenancy,
      lineItems: [],
      outboundGB: 0,
      costApiFailed: true,
      error: `Usage API returned HTTP ${usageRes.status}`,
    }
  }

  const costRes = await fetchUsageItems(profile, range, 'COST', requestFn).catch(() => ({
    items: [] as UsageLineItem[],
    failed: true,
    status: 0,
  }))

  const { lineItems, outboundGB } = aggregateUsageAndCost(usageRes.items, costRes.items)

  return {
    profileName: profile.name,
    region: profile.region,
    tenancy: profile.tenancy,
    lineItems,
    outboundGB,
    costApiFailed: costRes.failed,
    raw: { usage: usageRes.items, cost: costRes.items },
  }
}

export async function queryMultiProfile(
  profiles: Profile[],
  range: UsageQueryRange,
  requestFn: OciRequestFn = ociRequest,
): Promise<ProfileUsageResult[]> {
  const settled = await Promise.allSettled(profiles.map((p) => queryUsageAndCost(p, range, requestFn)))
  return settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : {
          profileName: profiles[i].name,
          region: profiles[i].region,
          tenancy: profiles[i].tenancy,
          lineItems: [],
          outboundGB: 0,
          costApiFailed: true,
          error: s.reason instanceof Error ? s.reason.message : String(s.reason),
        },
  )
}
