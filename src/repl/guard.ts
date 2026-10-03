import type { Command } from 'commander'

/**
 * Thrown in place of `process.exit()` while a REPL line is executing.
 *
 * Command actions report failures through `die()` (and `die()` is
 * `console.error` + `process.exit`), which is exactly right for one-shot use
 * and fatal inside a loop. Swapping `process.exit` for a thrower for the
 * duration of one parse turns "the command is done, with this status" into a
 * value the loop can act on; restoring it in `finally` means a crash here
 * cannot leave the process unable to exit later.
 */
class ReplExit extends Error {
  code: number
  constructor(code: number) {
    super(`repl-exit:${code}`)
    this.code = code
  }
}

/**
 * Run one async action with `process.exit` swapped for a thrower — the
 * general mechanism behind `execGuarded`. Anything that can reach `die()`
 * (a commander parse, a direct `dispatch()` call for the fuzzy layer) runs
 * through here so a failure costs the line, never the session. Genuine
 * bugs re-throw with their stack rather than being swallowed; nesting is
 * safe because each layer restores whatever exit it found.
 */
export interface GuardedResult<T> {
  errored: boolean
  exitCode: number
  ok: boolean
  value?: T
}

async function withExitGuard<T>(
  fn: () => Promise<T>,
): Promise<GuardedResult<T>> {
  const realExit = process.exit
  process.exit = ((code?: number) => {
    throw new ReplExit(code ?? 0)
  }) as typeof process.exit
  try {
    const value = await fn()
    return { ok: true, value, exitCode: 0, errored: false }
  } catch (e) {
    if (e instanceof ReplExit) {
      return { ok: false, exitCode: e.code, errored: e.code !== 0 }
    }
    if (e && typeof e === 'object' && 'exitCode' in e) {
      const code = Number((e as { exitCode: unknown }).exitCode)
      return { ok: false, exitCode: code, errored: code !== 0 }
    }
    throw e // genuine bugs surface as stack traces, not swallowed
  } finally {
    process.exit = realExit
  }
}

/**
 * Run one REPL line through the same commander program one-shot uses — same
 * commands, same flags, same output, same exit codes — without letting the
 * command end the session.
 *
 * Commander's own usage errors (unknown command/option, `--help`) surface as
 * thrown objects carrying `.exitCode`, which is how one-shot decides its exit
 * status too.
 */
export async function execGuarded(
  program: Command,
  argv: string[],
): Promise<{ exitCode: number; errored: boolean }> {
  const g = await withExitGuard(() =>
    program.parseAsync(['node', 'crm', ...argv]),
  )
  return { exitCode: g.exitCode, errored: g.errored }
}

/** A direct call (`dispatch()` for the fuzzy open layer) under the same
 * protection: die() prints its own copy, the guard keeps the loop alive. */
export function callGuarded<T>(
  fn: () => Promise<T>,
): Promise<GuardedResult<T>> {
  return withExitGuard(fn)
}
