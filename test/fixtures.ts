// Throwaway 2048-bit RSA key generated solely for deterministic signing
// tests (`openssl genrsa 2048`) — never used against a real OCI tenancy.
export const TEST_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCv9Xf5CzUS6FW0
LeEB13l9OmXOEMEc7YisE14I+1Us7P6Xhr6XXBoTFABimYDsy5ksvUVPz+PZ9QmB
Be2PP71q5ELooWuYO2Uhttv32WG09lCt1ihwaBI9os8ZnagltQsJOFdQGx4XX1Mz
2vOTKWaSRzgGabGio2JRdvLU7inXHq/m/HmmVro6c8mdwkHUdWm14/GZRnIFhV+y
8VbsY/oyu+kSNUAIwDBQehYcNUYaP63EMjHtlW+v6cbplkvJwx9yRPIZYmP/Sum8
daJeyqiVe7oexLrOXqgmHW5+oj4cgEh21CThtqmsMYn0+ZcRD25bdr5X2I5L/eFW
ZT5WZkj3AgMBAAECggEAIpeLYnaFlJYAY0+xsH7/71KPuRcqH9nCyLF2ByYB9LcS
xg9DYNZGegGwobGz2tmb32PGQI6KKMs3dxoHPeY2AtGlJb62PFNQ6nPcgrlFsCHM
cqBris2q6Fsdg9euutsAtGtTHvh1zfp7jPI6eG/nLlK5/OjCd0rPhVxxGNNJfnTC
WT1vaZ6ejVubx5LcByW6++RbeMPXCEBbA6eI6u3zvQuUuTFQetiZrECh1N8iCiw9
qBHUVBxP9n1ASHhNVhjQBzhTEixu3L0sa812JFo2RLQBB78S/kMDFOkeOENXh78f
g6o7XshoXEGHACEYDBnoRP7Osyi+8ksv+pUKsb0JwQKBgQDiPpkZvnPJm7RjgfGn
MIH1Dw+x3nQ0qAEqqOi964/dMoRmNdg0NT7knFxg2UbCNNUX75MzJCmZPG4TRXoW
bZoWqWrtrCrW5iYq59sHnWnT9hGB5LqikKF/hPYFgZniwZFB9mewRioInqnxVZUL
S3GHwrKm1GURWXzQe3aJWRnMKQKBgQDHGc7lXm2MADmI22KIzCHUJwp3Q0yj+FpB
1cP/FYPyLpD3/yJv9z+3OI+PKVILONLI7dNxb4S2hkukRHxrwUsq9auixwmXkOq0
AIShPJARcfzSqIMqVfCiUACkVNNE9d0oTdc21Sz0QOoqCQSIVKOdqEhZmbdSIKOD
qpbbo+QQHwKBgAQRD/twevBSxilLuqZArvVSsfuGfhw8MNktdBGF3G4jbFHSAfLe
SiUd0mNDRIxVGsd1XPX8XmsMtQXPp+QjUDO8E9n10EdQl7sJs9wtLivLLoFhNSGa
6+w43Zs3uyZiSFQhM7ftavAAuhlGaolrb7z6+O8avj5Tl3S/41+QpHARAoGAco9C
Aa40oCKc+EcrSgUSzexs1DSwC4TiAhGKxeJOWnI6zcdKvFvqmHT9/WTMJVLbzesy
B4ogNZnOOkWBxcqhgqV6zZ1ywngK4+mMZu3fA3qv+1Ikrp5maC5aQDPioEJLr14i
oBVG2X/kfK1Vo0/4GMX0Y0HUPngzPZZRWS3TEwcCgYEAppd+MvY9E3lF8z9KHyeU
M0pzsalTOc+QVAybnnt0/EgRHUauiAifyyAfzYioz1ubIGTXFOcj0OJPPVyWX/8C
fF42iE6/PAJG5w6zC7XCSkPZ+0PzUrQuoglo63ksiSiPxvBuG8ZrevGIjFi14opK
9EjoUDNDKxNVa4OIwXsc9qo=
-----END PRIVATE KEY-----
`

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
