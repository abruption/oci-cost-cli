import { createHash, createSign } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { readPrivateKey } from './config.js'
import type { Profile } from './types.js'

/** Outbound HTTPS calls give up after this long rather than hanging forever
 *  on a stalled connection (e.g. a cron job stuck indefinitely). */
const REQUEST_TIMEOUT_MS = 15_000

export interface SignedRequestParts {
  date: string
  authorization: string
  headers: Record<string, string>
}

/**
 * Builds the OCI API Signature Version 1 signing string and the resulting
 * `Authorization` header. Pure/deterministic given the same inputs — no I/O,
 * so it can be unit tested against a fixed key and fixed `date` without any
 * network access.
 *
 * https://docs.oracle.com/en-us/iaas/Content/API/Concepts/signingrequests.htm
 */
export function signRequest(
  profile: Profile,
  privateKeyPem: string,
  opts: { method: 'GET' | 'POST'; host: string; path: string; date: string; body?: string },
): SignedRequestParts {
  const { method, host, path, date, body } = opts
  const keyId = `${profile.tenancy}/${profile.user}/${profile.fingerprint}`

  const headers: Record<string, string> = { date, host }
  let headerNames = '(request-target) date host'
  let signingString = `(request-target): ${method.toLowerCase()} ${path}\ndate: ${date}\nhost: ${host}`

  if (body !== undefined) {
    const bodyHash = createHash('sha256').update(body).digest('base64')
    const contentLength = String(Buffer.byteLength(body))
    headers['content-length'] = contentLength
    headers['content-type'] = 'application/json'
    headers['x-content-sha256'] = bodyHash
    headerNames = '(request-target) date host content-length content-type x-content-sha256'
    signingString +=
      `\ncontent-length: ${contentLength}` +
      `\ncontent-type: application/json` +
      `\nx-content-sha256: ${bodyHash}`
  }

  const sign = createSign('RSA-SHA256')
  sign.update(signingString)
  const signature = sign.sign(privateKeyPem, 'base64')

  const authorization =
    `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",` +
    `headers="${headerNames}",signature="${signature}"`

  return { date, authorization, headers }
}

/**
 * Performs a signed OCI REST API call without the official SDK or the
 * Python oci-cli. Useful for any OCI REST endpoint, not just Usage API —
 * exported as a public library entry point (`oci-cost-cli/signer`).
 */
export function ociRequest(
  profile: Profile,
  method: 'GET' | 'POST',
  host: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  const privateKeyPem = readPrivateKey(profile)
  const bodyStr = body === undefined ? undefined : JSON.stringify(body)
  const date = new Date().toUTCString()
  const signed = signRequest(profile, privateKeyPem, { method, host, path, date, body: bodyStr })

  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: host,
        port: 443,
        path,
        method,
        headers: {
          ...signed.headers,
          authorization: signed.authorization,
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`request to ${host}${path} timed out after ${REQUEST_TIMEOUT_MS}ms`))
    })
    if (bodyStr !== undefined) req.write(bodyStr)
    req.end()
  })
}
