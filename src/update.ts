import { execFileSync } from 'node:child_process'
import { request } from 'node:https'

/** Outbound HTTPS calls give up after this long rather than hanging forever
 *  on a stalled connection (e.g. a cron job stuck indefinitely). */
const REQUEST_TIMEOUT_MS = 15_000

/** Injectable so tests never hit the real npm registry. */
export type RegistryFetcher = (packageName: string) => Promise<string>

export async function fetchLatestVersion(packageName: string, fetcher: RegistryFetcher = fetchFromNpmRegistry): Promise<string> {
  return fetcher(packageName)
}

function fetchFromNpmRegistry(packageName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
      { method: 'GET', headers: { accept: 'application/json' } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`npm registry error: HTTP ${res.statusCode}`))
            return
          }
          const body = Buffer.concat(chunks).toString('utf8')
          try {
            const parsed = JSON.parse(body) as { version?: string }
            if (!parsed.version) throw new Error('npm registry response has no version field')
            resolve(parsed.version)
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)))
          }
        })
      },
    )
    req.on('error', reject)
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`request to registry.npmjs.org timed out after ${REQUEST_TIMEOUT_MS}ms`))
    })
    req.end()
  })
}

/**
 * Compares two `major.minor.patch`-style version strings.
 * Returns -1 if `a` < `b`, 0 if equal, 1 if `a` > `b`.
 *
 * Each segment is parsed with `parseInt`, which reads only the segment's
 * leading digits — so a pre-release suffix glued onto a numeric segment
 * (e.g. `'0-rc1'`) contributes just that leading number (`0`), and a
 * segment that is missing or starts with a non-digit becomes 0. This is
 * good enough for "is a real update available", not a full semver parser:
 * it does not distinguish a release from its own pre-release suffix (e.g.
 * `compareVersions('0.4.0', '0.4.0-rc1')` is `0`), which is acceptable
 * because `fetchLatestVersion` reads npm's `latest` dist-tag, which by
 * convention never points at a pre-release.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}

export interface NpmInstallResult {
  ok: boolean
  output: string
}

/** Injectable so tests never actually invoke npm/mutate global packages. */
export type NpmInstallRunner = (packageName: string, version: string) => NpmInstallResult

export const realNpmInstallRunner: NpmInstallRunner = (packageName, version) => {
  try {
    const output = execFileSync('npm', ['install', '-g', `${packageName}@${version}`], { encoding: 'utf8' })
    return { ok: true, output }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, output: err.stderr || err.stdout || err.message || 'npm install failed' }
  }
}
