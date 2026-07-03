import { request as httpsRequest } from 'node:https'

/** Outbound HTTPS calls give up after this long rather than hanging forever
 *  on a stalled connection (e.g. a cron job stuck indefinitely). */
const REQUEST_TIMEOUT_MS = 15_000

/**
 * Sends a Telegram message via the Bot API. Generalized from
 * ~/Projects/oci-traffic-report/report.js's `sendTelegram` (which hardcoded
 * the token/chat_id at module scope) into a pure function taking both as
 * arguments, so callers control where the credential comes from.
 */
export function sendTelegram(
  botToken: string,
  chatId: string,
  text: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    const req = httpsRequest(
      {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${botToken}/sendMessage`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
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
      req.destroy(new Error(`request to api.telegram.org timed out after ${REQUEST_TIMEOUT_MS}ms`))
    })
    req.write(body)
    req.end()
  })
}
