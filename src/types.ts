export interface Profile {
  name: string
  user: string
  fingerprint: string
  tenancy: string
  region: string
  keyFile: string
  passPhrase?: string
}

export interface ConfigParseResult {
  profiles: Map<string, Profile>
  errors: ConfigParseError[]
}

export interface ConfigParseError {
  section: string
  message: string
}

export type QueryType = 'USAGE' | 'COST'

export interface UsageLineItem {
  service: string | null
  skuName: string | null
  skuPartNumber: string | null
  unit: string | null
  computedQuantity: number | null
  computedAmount: number | null
  currency: string | null
}

export interface UsageQueryRange {
  start: Date
  end: Date
}

export interface AggregatedLineItem {
  service: string
  skuName: string
  unit: string
  quantity: number
  cost: number | null
  currency: string | null
  isFreeTierSku: boolean
}

export interface ProfileUsageResult {
  profileName: string
  region: string
  tenancy: string
  lineItems: AggregatedLineItem[]
  outboundGB: number
  costApiFailed: boolean
  error?: string
  /** Unaggregated USAGE + COST API responses, exposed via --raw for
   *  consumers that don't want this tool's aggregation heuristics
   *  (currency preference, free-tier detection, outbound-transfer
   *  matching — all documented as best-effort in the README) applied. */
  raw?: { usage: UsageLineItem[]; cost: UsageLineItem[] }
}

export interface TelegramCredential {
  botToken: string
  chatId: string
}
