import { ociRequest } from './signer.js'
import type {
  AggregatedLineItem,
  Profile,
  ProfileUsageResult,
  UsageLineItem,
  UsageQueryRange,
} from './types.js'

const USAGE_PATH = '/20200107/usage'

export function usageApiHost(profile: Profile): string {
  return `usageapi.${profile.region}.oci.oraclecloud.com`
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** UTC month range for `monthStr` (YYYY-MM), or the current month-to-date if omitted. */
export function monthRange(monthStr?: string): UsageQueryRange {
  const now = new Date()
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

  const res = await ociRequest(profile, 'POST', host, USAGE_PATH, body)
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

/**
 * Pure aggregation of already-fetched USAGE + COST line items — no I/O, so
 * it's directly unit-testable against fixture JSON without a live OCI call.
 *
 * Preserves gotchas discovered in ~/Projects/oci-traffic-report/report.js:
 *  - The same SKU can appear in multiple currencies (e.g. a $0 free-tier
 *    line reported in both SGD and USD). USD is preferred; non-USD entries
 *    are only summed together when no USD entry exists for that SKU.
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

  // cost aggregation (by service+skuName), USD-preferred per report.js's proven logic
  const costByKey = new Map<string, { service: string; skuName: string; cost: number; currency: string }>()
  for (const item of costItems) {
    const service = item.service ?? 'Unknown'
    const skuName = item.skuName ?? service
    const key = `${service}|${skuName}`
    const cost = item.computedAmount ?? 0
    const currency = (item.currency ?? '').trim()
    if (!currency) continue
    const existing = costByKey.get(key)
    if (!existing || (existing.currency !== 'USD' && currency === 'USD')) {
      costByKey.set(key, { service, skuName, cost, currency })
    } else if (existing.currency === currency) {
      existing.cost += cost
    }
  }

  const lineItems: AggregatedLineItem[] = []
  const coveredByUsage = new Set<string>() // service|skuName (unit-agnostic — costByKey has no unit dimension)
  for (const u of usageByKey.values()) {
    const costKey = `${u.service}|${u.skuName}`
    coveredByUsage.add(costKey)
    const c = costByKey.get(costKey)
    lineItems.push({
      service: u.service,
      skuName: u.skuName,
      unit: u.unit,
      quantity: u.qty,
      cost: c ? c.cost : null,
      currency: c ? c.currency : null,
      isFreeTierSku: isFreeTierSkuName(u.skuName),
    })
  }
  // cost-only line items (rare, but keep parity with report.js which treats
  // usage and cost as separately-sourced aggregates)
  for (const [key, c] of costByKey) {
    if (!coveredByUsage.has(key)) {
      lineItems.push({
        service: c.service,
        skuName: c.skuName,
        unit: '',
        quantity: 0,
        cost: c.cost,
        currency: c.currency,
        isFreeTierSku: isFreeTierSkuName(c.skuName),
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
): Promise<ProfileUsageResult> {
  let usageRes: Awaited<ReturnType<typeof fetchUsageItems>>
  try {
    usageRes = await fetchUsageItems(profile, range, 'USAGE')
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

  const costRes = await fetchUsageItems(profile, range, 'COST').catch(() => ({
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
): Promise<ProfileUsageResult[]> {
  const settled = await Promise.allSettled(profiles.map((p) => queryUsageAndCost(p, range)))
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
