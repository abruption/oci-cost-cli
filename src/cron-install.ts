import { execFileSync, spawnSync } from 'node:child_process'

const CRON_FIELD = /^[\d*,\-/]+$/

/**
 * Lightweight sanity check for a standard 5-field cron expression
 * (minute hour day-of-month month day-of-week). Not a full RFC-compliant
 * parser — just enough to stop an obviously malformed expression from
 * being written into the user's crontab.
 */
export function isValidCronExpression(expr: string): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  return fields.every((f) => CRON_FIELD.test(f))
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
