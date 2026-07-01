import type { AggregatedLineItem, ProfileUsageResult } from './types.js'

const useColor = (): boolean => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const c = (code: string, s: string): string => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s)
const dim = (s: string): string => c('2', s)
const bold = (s: string): string => c('1', s)
const yellow = (s: string): string => c('33', s)
const green = (s: string): string => c('32', s)
const red = (s: string): string => c('31', s)

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}
function padStartN(s: string, width: number): string {
  return s.length >= width ? s : ' '.repeat(width - s.length) + s
}

/** Hand-rolled fixed-width table — no external dependency, matches the
 * zero-deps posture of the core query path. */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const headerLine = headers.map((h, i) => pad(h, widths[i])).join('  ')
  const sep = widths.map((w) => '-'.repeat(w)).join('  ')
  const bodyLines = rows.map((r) => r.map((cell, i) => pad(cell ?? '', widths[i])).join('  '))
  return [headerLine, sep, ...bodyLines].join('\n')
}

export function formatAmount(amount: number, currency: string): string {
  return `${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`
}

function costCell(item: AggregatedLineItem): string {
  if (item.cost === null || item.currency === null) return dim('—')
  const text = formatAmount(item.cost, item.currency)
  return item.cost > 0 ? yellow(text) : text
}

export function renderProfileSection(result: ProfileUsageResult): string {
  const header = bold(`▸ ${result.profileName}  (${result.tenancy.slice(0, 24)}…, ${result.region})`)

  if (result.error) {
    return `${header}\n  ${red('✗ ' + result.error)}`
  }

  const lines: string[] = [header]

  if (result.lineItems.length === 0) {
    lines.push(dim('  (no usage in this period)'))
  } else {
    const rows = result.lineItems
      .slice()
      .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0))
      .map((item) => [
        item.service,
        item.skuName,
        `${item.quantity.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${item.unit}`.trim(),
        costCell(item),
      ])
    lines.push(
      renderTable(['SERVICE', 'SKU', 'USAGE', 'COST'], rows)
        .split('\n')
        .map((l) => '  ' + l)
        .join('\n'),
    )
  }

  if (result.costApiFailed) {
    lines.push(yellow('  ⚠️  Cost API failed for this profile — costs above may be incomplete, not $0.'))
  }
  lines.push(`  outbound transfer: ${padStartN(result.outboundGB.toFixed(3), 10)} GB`)

  return lines.join('\n')
}

export function renderFreeTierSummary(profileName: string, offenders: AggregatedLineItem[]): string {
  if (offenders.length === 0) {
    return `▸ ${profileName}  ${green('✅ all items within Free Tier')}`
  }
  const rows = offenders.map((i) => [i.service, i.skuName, costCell(i)])
  return [
    `▸ ${profileName}  ${yellow(`⚠️  ${offenders.length} item(s) outside Free Tier eligibility`)}`,
    renderTable(['SERVICE', 'SKU', 'COST'], rows)
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n'),
  ].join('\n')
}
