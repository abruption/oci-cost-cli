import { request as httpsRequest } from 'node:https'

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
        let chunks = ''
        res.on('data', (c) => (chunks += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: chunks }))
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

export function progressBar(pct: number, len = 20): string {
  const filled = Math.max(0, Math.min(len, Math.round((pct / 100) * len)))
  return '█'.repeat(filled) + '░'.repeat(len - filled)
}
