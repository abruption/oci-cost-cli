import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ConfigParseError, ConfigParseResult, Profile } from './types.js'

const REQUIRED_KEYS = ['user', 'fingerprint', 'tenancy', 'region', 'key_file'] as const

export function defaultConfigPath(): string {
  return join(homedir(), '.oci', 'config')
}

/**
 * Parses a standard `~/.oci/config` INI-style file — the same file read by
 * the official OCI SDKs and the Python oci-cli. Every `[SECTION]` is treated
 * as a profile, not just `[DEFAULT]`, so multi-tenancy setups (e.g. a
 * `[DEFAULT]` + a `[US]` profile pointing at a different tenancy/region) are
 * fully supported.
 *
 * A malformed profile (missing a required key) is skipped and reported in
 * `errors` rather than aborting the whole parse — one bad profile should not
 * block the others from being usable.
 */
export function parseOciConfig(content: string): ConfigParseResult {
  const profiles = new Map<string, Profile>()
  const errors: ConfigParseError[] = []
  const raw = new Map<string, Record<string, string>>()

  let currentSection: string | null = null
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue

    const sectionMatch = line.match(/^\[(.+)\]$/)
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim()
      if (!raw.has(currentSection)) raw.set(currentSection, {})
      continue
    }

    if (currentSection === null) continue // stray key before any [SECTION]

    const kvMatch = line.match(/^(\w+)\s*=\s*(.+)$/)
    if (!kvMatch) continue
    const [, key, rawValue] = kvMatch
    // Strip inline comments: a '#' or ';' preceded by whitespace starts a
    // trailing comment, the same convention most INI-style parsers use. A
    // '#'/';' with no preceding whitespace (e.g. embedded in a path or
    // URL) is left alone so values are not silently truncated.
    const value = rawValue.replace(/\s[#;].*$/, '').trim()
    raw.get(currentSection)![key] = value
  }

  for (const [section, kv] of raw) {
    const missing = REQUIRED_KEYS.filter((k) => !kv[k])
    if (missing.length > 0) {
      errors.push({
        section,
        message: `missing required key(s): ${missing.join(', ')}`,
      })
      continue
    }
    profiles.set(section, {
      name: section,
      user: kv.user,
      fingerprint: kv.fingerprint,
      tenancy: kv.tenancy,
      region: kv.region,
      keyFile: kv.key_file,
      passPhrase: kv.pass_phrase,
    })
  }

  return { profiles, errors }
}

export function loadOciConfig(path: string = defaultConfigPath()): ConfigParseResult {
  const content = readFileSync(path, 'utf8')
  return parseOciConfig(content)
}

export function readPrivateKey(profile: Profile): string {
  if (profile.passPhrase) {
    throw new Error(
      `profile '${profile.name}' uses an encrypted private key (pass_phrase set) — ` +
        'encrypted keys are not yet supported, use an unencrypted key_file',
    )
  }
  return readFileSync(profile.keyFile, 'utf8')
}
