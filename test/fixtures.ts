import { generateKeyPairSync } from 'node:crypto'

// Generated fresh on every test run — no static key material lives in the
// repo (avoids secret-scanner false positives like GitGuardian flagging a
// PEM-shaped string, even a throwaway one, as a potential leak).
export function generateTestKeyPair(): { privateKeyPem: string } {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  return { privateKeyPem: privateKey as unknown as string }
}

export const SAMPLE_OCI_CONFIG = `
[DEFAULT]
user=ocid1.user.oc1..aaaaaaaadefault
fingerprint=aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99
tenancy=ocid1.tenancy.oc1..aaaaaaaadefaulttenancy
region=ap-chuncheon-1
key_file=/home/test/.oci/oci_api_key.pem

[US]
user=ocid1.user.oc1..aaaaaaaaus
fingerprint=11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00
tenancy=ocid1.tenancy.oc1..aaaaaaaaustenancy
region=us-phoenix-1
key_file=/home/test/.oci/oci_api_key_us.pem

[BROKEN]
user=ocid1.user.oc1..aaaaaaaabroken
region=us-ashburn-1
`

export function sampleUsageItems() {
  return [
    { service: 'Compute', skuName: 'Virtual Machine Standard - E2 Micro - Free', skuPartNumber: 'B91714', unit: 'OCPU_HOURS', computedQuantity: 1488.5, computedAmount: 0, currency: null },
    { service: 'Block Storage', skuName: 'Block Volume - Free', skuPartNumber: 'B91962', unit: 'GB_STORAGE_HOURS', computedQuantity: 8203.2, computedAmount: 0, currency: null },
    { service: 'Virtual Cloud Network', skuName: 'Outbound Data Transfer Zone 2', skuPartNumber: 'B88514', unit: 'GB', computedQuantity: 11.559428631747, computedAmount: 0, currency: null },
  ]
}

export function sampleCostItemsAllFree() {
  return [
    { service: 'Compute', skuName: 'Virtual Machine Standard - E2 Micro - Free', skuPartNumber: 'B91714', unit: null, computedQuantity: null, currency: 'SGD', computedAmount: 0 },
    { service: 'Compute', skuName: 'Virtual Machine Standard - E2 Micro - Free', skuPartNumber: 'B91714', unit: null, computedQuantity: null, currency: 'USD', computedAmount: 0 },
    { service: 'Block Storage', skuName: 'Block Volume - Free', skuPartNumber: 'B91962', unit: null, computedQuantity: null, currency: 'SGD', computedAmount: 0 },
    { service: 'Virtual Cloud Network', skuName: 'Outbound Data Transfer Zone 2', skuPartNumber: 'B88514', unit: null, computedQuantity: null, currency: 'SGD', computedAmount: 0 },
  ]
}

export function sampleCostItemsWithOverage() {
  return [
    ...sampleCostItemsAllFree(),
    { service: 'Compute', skuName: 'Standard - A1', skuPartNumber: 'B91714', unit: null, computedQuantity: null, currency: 'USD', computedAmount: 4.2 },
  ]
}
