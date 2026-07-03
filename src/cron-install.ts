import { execFileSync, spawnSync } from 'node:child_process'

const CRON_FIELD = /^[\d*,\-/]+$/

/**
 * Validates a single cron field beyond the character-set check: rejects
 * empty list elements (e.g. `1,,2`, a leading/trailing comma, or a bare
 * `/` with no step) and reversed ranges (e.g. `5-3`, where start > end).
 * Still not a full RFC-compliant parser — e.g. it doesn't bounds-check
 * values against each field's valid range (0-59 for minutes, etc.).
 */
function isValidCronField(field: string): boolean {
  if (!CRON_FIELD.test(field)) return false
  for (const part of field.split(',')) {
    if (part.length === 0) return false // e.g. '1,,2' or a leading/trailing comma

    const [range, step, ...extra] = part.split('/')
    if (extra.length > 0 || step === '') return false // e.g. 'a/b/c' or a bare trailing '/'

    if (range === '*') continue
    const rangeMatch = range.match(/^(\d+)-(\d+)$/)
    if (rangeMatch && Number(rangeMatch[1]) > Number(rangeMatch[2])) return false // e.g. '5-3'
  }
  return true
}

/**
 * Lightweight sanity check for a standard 5-field cron expression
 * (minute hour day-of-month month day-of-week). Not a full RFC-compliant
 * parser — just enough to stop an obviously malformed expression from
 * being written into the user's crontab.
 */
export function isValidCronExpression(expr: string): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  return fields.every(isValidCronField)
}

/**
 * Quote a single argv token for safe inclusion in a POSIX shell command
 * line. Crontab entries are executed via `sh -c`, so joining trailing argv
 * tokens with a bare space (as `install-cron` used to) both (a) lets shell
 * metacharacters in a token be interpreted by cron every time the job fires
 * — a command-injection vector — and (b) loses the original argv boundary
 * for any token containing whitespace, silently corrupting it when cron
 * re-splits the line. Always-quoting (even already-"safe" tokens) keeps the
 * logic simple and avoids having to enumerate "dangerous" characters.
 */
export function shellQuoteArg(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

export interface CrontabIO {
  read(): string
  write(content: string): void
}

/** Real crontab(1) access — swapped out in tests via dependency injection. */
export const realCrontabIO: CrontabIO = {
  read(): string {
    try {
      return execFileSync('crontab', ['-l'], { encoding: 'utf8' })
    } catch {
      // "no crontab for user" exits non-zero — treat as an empty crontab.
      return ''
    }
  },
  write(content: string): void {
    const res = spawnSync('crontab', ['-'], { input: content, encoding: 'utf8' })
    if (res.status !== 0) {
      throw new Error(`crontab write failed: ${res.stderr || res.error?.message || 'unknown error'}`)
    }
  },
}

export interface InstallCronResult {
  installed: boolean
  alreadyPresent: boolean
  line: string
  /** True when `dryRun` was requested — `write()` was never called. */
  dryRun: boolean
}

/**
 * Idempotently adds `<cronExpr> <command>` to the user's crontab. Running
 * this twice with the same expression+command does not create a duplicate
 * line.
 *
 * With `dryRun: true`, still reads the current crontab to determine
 * `alreadyPresent` (an honest preview), but never calls `io.write()`.
 */
export function installCronJob(
  cronExpr: string,
  command: string,
  io: CrontabIO = realCrontabIO,
  dryRun = false,
): InstallCronResult {
  if (!isValidCronExpression(cronExpr)) {
    throw new Error(`invalid cron expression: '${cronExpr}' (expected 5 space-separated fields)`)
  }

  const line = `${cronExpr} ${command}`
  const existing = io.read()
  const lines = existing.split('\n').filter((l) => l.trim().length > 0)

  if (lines.includes(line)) {
    return { installed: false, alreadyPresent: true, line, dryRun }
  }

  if (dryRun) {
    return { installed: false, alreadyPresent: false, line, dryRun: true }
  }

  lines.push(line)
  io.write(lines.join('\n') + '\n')
  return { installed: true, alreadyPresent: false, line, dryRun: false }
}

export interface UninstallCronResult {
  removed: boolean
  /** True when the exact `<cronExpr> <command>` line was not found in the crontab. */
  found: boolean
  line: string
  /** True when `dryRun` was requested — `write()` was never called. */
  dryRun: boolean
}

/**
 * Removes the exact `<cronExpr> <command>` line previously written by
 * `installCronJob` — same composition (cron expression + shell-quoted
 * command), so `uninstall-cron` must be called with the same `--cron` and
 * trailing `-- <subcommand> [flags]` that were used to install it. Leaves
 * every other crontab line untouched.
 */
export function uninstallCronJob(
  cronExpr: string,
  command: string,
  io: CrontabIO = realCrontabIO,
  dryRun = false,
): UninstallCronResult {
  if (!isValidCronExpression(cronExpr)) {
    throw new Error(`invalid cron expression: '${cronExpr}' (expected 5 space-separated fields)`)
  }

  const line = `${cronExpr} ${command}`
  const existing = io.read()
  const lines = existing.split('\n').filter((l) => l.trim().length > 0)

  if (!lines.includes(line)) {
    return { removed: false, found: false, line, dryRun }
  }

  if (dryRun) {
    return { removed: false, found: true, line, dryRun: true }
  }

  const remaining = lines.filter((l) => l !== line)
  io.write(remaining.length > 0 ? remaining.join('\n') + '\n' : '')
  return { removed: true, found: true, line, dryRun: false }
}

/**
 * Every crontab line this tool could have installed contains its own
 * script path (see `buildScheduledCommand`), which always includes the
 * package name — so a substring match on `marker` is enough to separate
 * this tool's cron lines from a user's unrelated ones, without needing to
 * track installed jobs in a separate state file.
 */
export function listCronJobs(io: CrontabIO = realCrontabIO, marker = 'oci-cost-cli'): string[] {
  const existing = io.read()
  return existing.split('\n').filter((l) => l.trim().length > 0 && l.includes(marker))
}
