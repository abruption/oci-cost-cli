import { execFileSync } from 'node:child_process'
import { request } from 'node:https'

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
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`npm registry error: HTTP ${res.statusCode}`))
            return
          }
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
    req.end()
  })
}

/**
 * Compares two `major.minor.patch`-style version strings.
 * Returns -1 if `a` < `b`, 0 if equal, 1 if `a` > `b`.
 * Non-numeric/missing segments (e.g. a pre-release suffix) are treated as 0
 * — good enough for "is a real update available", not a full semver parser.
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
