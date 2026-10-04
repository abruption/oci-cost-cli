import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TelegramCredential } from './types.js'

const KEYRING_SERVICE = 'oci-cost-cli'
const KEYRING_ACCOUNT = 'telegram'

/**
 * Minimal shape of the bits of @napi-rs/keyring's `Entry` class we use.
 * Declared here (rather than imported as a type) so tests can inject a fake
 * implementation without needing a real OS keyring/Secret Service — CI
 * runners generally don't have one.
 */
export interface KeyringImpl {
  setPassword(service: string, account: string, value: string): void
  getPassword(service: string, account: string): string | null
  deletePassword(service: string, account: string): boolean
}

async function loadRealKeyring(): Promise<KeyringImpl | null> {
  try {
    const { Entry } = await import('@napi-rs/keyring')
    if (!Entry) return null
    return {
      setPassword: (service, account, value) => new Entry(service, account).setPassword(value),
      getPassword: (service, account) => {
        try {
          return new Entry(service, account).getPassword() ?? null
        } catch {
          return null
        }
      },
      deletePassword: (service, account) => {
        try {
          return new Entry(service, account).deletePassword()
        } catch {
          return false
        }
      },
    }
  } catch {
    return null
  }
}

export function configDir(): string {
  return join(homedir(), '.config', 'oci-cost-cli')
}

export function configFilePath(): string {
  return join(configDir(), 'config.json')
}

export function storageMetadataPath(): string {
  return join(configDir(), 'credential-store.json')
}

type CredentialBackend = 'keyring' | 'file' | 'deleted'

function readStorageMetadata(): CredentialBackend | null {
  const path = storageMetadataPath()
  if (!existsSync(path)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(`cannot read Telegram credential storage metadata: ${e instanceof Error ? e.message : String(e)}`, {
      cause: e,
    })
  }
  const backend = (parsed as { active?: unknown }).active
  if (backend !== 'keyring' && backend !== 'file' && backend !== 'deleted') {
    throw new Error('Telegram credential storage metadata is invalid')
  }
  return backend
}

function writeStorageMetadata(active: CredentialBackend): void {
  const dir = configDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = storageMetadataPath()
  writeFileSync(path, JSON.stringify({ active }, null, 2) + '\n', { mode: 0o600 })
  chmodSync(dir, 0o700)
  chmodSync(path, 0o600)
}

function removeFileCredential(): void {
  const path = configFilePath()
  if (existsSync(path)) rmSync(path)
}

function readFileCredential(): TelegramCredential | null {
  const path = configFilePath()
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<TelegramCredential>
    if (!parsed.botToken || !parsed.chatId) return null
    return { botToken: parsed.botToken, chatId: parsed.chatId }
  } catch {
    return null
  }
}

function writeFileCredential(cred: TelegramCredential): void {
  const dir = configDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = configFilePath()
  writeFileSync(path, JSON.stringify(cred, null, 2) + '\n', { mode: 0o600 })
  // mkdirSync/writeFileSync `mode` can be affected by umask — force it explicitly.
  chmodSync(dir, 0o700)
  chmodSync(path, 0o600)
}

export interface SaveResult {
  storedIn: 'keyring' | 'file'
}

/**
 * Two-tier credential storage, mirroring the pattern already proven in
 * `agy-cli-usage`: try the OS keyring first (real, encrypted-at-rest
 * secure storage when available), fall back to a config file with
 * restrictive permissions (0600/0700) — the same trust model as
 * ~/.aws/credentials, ~/.npmrc, or `gh` CLI's config. No SQLite, no
 * home-grown encryption: an app-level cipher whose key must also live on
 * disk for unattended cron access provides no real security over plain
 * file permissions.
 *
 * The primary deployment target for `report`/`install-cron` is a headless
 * Linux cron job (no desktop Secret Service running), so the file fallback
 * is expected to be the common path in practice, not an edge case. A
 * secret-free metadata file records the authoritative tier so backend
 * availability changes cannot revive an older credential.
 */
export async function saveTelegramCredential(
  cred: TelegramCredential,
  keyring: () => Promise<KeyringImpl | null> = loadRealKeyring,
): Promise<SaveResult> {
  const impl = await keyring()
  if (impl) {
    let savedToKeyring = false
    try {
      impl.setPassword(KEYRING_SERVICE, KEYRING_ACCOUNT, JSON.stringify(cred))
      savedToKeyring = true
    } catch {
      // fall through to file
    }
    if (savedToKeyring) {
      writeStorageMetadata('keyring')
      removeFileCredential()
      return { storedIn: 'keyring' }
    }
  }
  // Mark the file as authoritative before writing it. If the write fails,
  // subsequent reads fail closed instead of reviving an older keyring value.
  writeStorageMetadata('file')
  writeFileCredential(cred)
  if (impl) {
    try {
      impl.deletePassword(KEYRING_SERVICE, KEYRING_ACCOUNT)
    } catch {
      // Metadata keeps any inaccessible stale keyring value from winning.
    }
  }
  return { storedIn: 'file' }
}

export async function loadTelegramCredential(
  keyring: () => Promise<KeyringImpl | null> = loadRealKeyring,
): Promise<TelegramCredential | null> {
  const activeBackend = readStorageMetadata()
  if (activeBackend === 'deleted') return null
  if (activeBackend === 'file') {
    const credential = readFileCredential()
    if (!credential) throw new Error('Telegram credential metadata points to a missing or invalid config file')
    return credential
  }

  const impl = await keyring()
  if (activeBackend === 'keyring' && !impl) {
    throw new Error('Telegram credential is stored in the OS keyring, but the keyring is unavailable')
  }
  if (impl) {
    const raw = impl.getPassword(KEYRING_SERVICE, KEYRING_ACCOUNT)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<TelegramCredential>
        if (parsed.botToken && parsed.chatId) return { botToken: parsed.botToken, chatId: parsed.chatId }
      } catch {
        if (activeBackend === 'keyring') throw new Error('Telegram credential in the OS keyring is invalid')
      }
    }
    if (activeBackend === 'keyring') {
      throw new Error('Telegram credential metadata points to the OS keyring, but no credential was found')
    }
  }
  // No metadata means this is a legacy installation. Preserve the original
  // keyring-first lookup until the next save records an authoritative tier.
  return readFileCredential()
}

export async function deleteTelegramCredential(
  keyring: () => Promise<KeyringImpl | null> = loadRealKeyring,
): Promise<void> {
  // Persist a tombstone first so an inaccessible stale backend can never
  // reactivate after the user clears the credential.
  writeStorageMetadata('deleted')
  removeFileCredential()
  const impl = await keyring()
  if (impl) {
    try {
      impl.deletePassword(KEYRING_SERVICE, KEYRING_ACCOUNT)
    } catch {
      // The tombstone remains authoritative even if the OS store is locked.
    }
  }
}

/** Probes which storage tier a save would use, without writing anything —
 *  used by `config set-telegram --dry-run`. */
export async function wouldStoreInKeyring(
  keyring: () => Promise<KeyringImpl | null> = loadRealKeyring,
): Promise<boolean> {
  return (await keyring()) !== null
}

export function maskToken(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length)
  return `${value.slice(0, 4)}${'*'.repeat(value.length - 8)}${value.slice(-4)}`
}
