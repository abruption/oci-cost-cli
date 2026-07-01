import type { AggregatedLineItem } from './types.js'

export const PRESET_NAMES = ['free-tier', 'compute', 'storage', 'network'] as const
export type PresetName = (typeof PRESET_NAMES)[number]

export function isPresetName(name: string): name is PresetName {
  return (PRESET_NAMES as readonly string[]).includes(name)
}

const SERVICE_PRESET_MAP: Record<Exclude<PresetName, 'free-tier'>, string[]> = {
  compute: ['compute'],
  storage: ['block storage', 'object storage', 'file storage'],
  network: ['virtual cloud network', 'networking', 'load balancer'],
}

/**
 * Line items that are actually costing money (cost > 0). Deliberately does
 * NOT require the "- Free" SKU-name suffix: some Always Free coverage (e.g.
 * outbound data transfer within the free allowance) reports cost=0 without
 * ever renaming the SKU, so `isFreeTierSku` alone under-detects free items —
 * cost is the ground truth. `isFreeTierSku` is kept on the line item purely
 * as a descriptive label for display, not as part of this check. A `cost`
 * of `null` (Cost API failed for this profile) is treated as "not flagged
 * here" — that risk is surfaced separately via `costApiFailed`.
 */
export function freeTierOffenders(items: AggregatedLineItem[]): AggregatedLineItem[] {
  return items.filter((i) => i.cost !== null && i.cost > 0)
}

function matchesServiceList(item: AggregatedLineItem, wanted: string[]): boolean {
  const service = item.service.toLowerCase()
  return wanted.some((w) => service.includes(w))
}

export function filterByServices(items: AggregatedLineItem[], services: string[]): AggregatedLineItem[] {
  if (services.length === 0) return items
  const wanted = services.map((s) => s.toLowerCase())
  return items.filter((i) => wanted.some((w) => i.service.toLowerCase().includes(w)))
}

export interface ApplyFiltersOptions {
  preset?: string
  services?: string[]
}

/**
 * Applies an optional built-in preset and/or an optional list of custom
 * `--service` filters. Filtering happens purely on already-fetched data —
 * it never triggers an extra API call.
 */
export function applyFilters(
  items: AggregatedLineItem[],
  { preset, services = [] }: ApplyFiltersOptions,
): AggregatedLineItem[] {
  let result = items

  if (preset) {
    if (!isPresetName(preset)) {
      throw new Error(`unknown preset '${preset}' — expected one of: ${PRESET_NAMES.join(', ')}`)
    }
    result = preset === 'free-tier' ? freeTierOffenders(result) : matchesServicePreset(result, preset)
  }

  return filterByServices(result, services)
}

function matchesServicePreset(
  items: AggregatedLineItem[],
  preset: Exclude<PresetName, 'free-tier'>,
): AggregatedLineItem[] {
  return items.filter((i) => matchesServiceList(i, SERVICE_PRESET_MAP[preset]))
}
