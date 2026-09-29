/**
 * Cross-subcommand option lookup: when the user types an option on a
 * command group (`crm contact --email x`), find which subcommand actually
 * owns the flag so the error can point at the right place.
 */
import type { Command } from 'commander'

/** Subcommand paths (space separated) whose options include `flag`. */
export function commandsWithFlag(program: Command, flag: string): string[] {
  const out: string[] = []
  const walk = (cmd: Command, path: string[]): void => {
    for (const sub of cmd.commands) {
      const p = [...path, sub.name()]
      if (sub.options.some((o) => o.long === flag)) {
        out.push(p.join(' '))
        continue
      }
      if (sub.commands.length > 0) {
        walk(sub, p)
      }
    }
  }
  walk(program, [])
  return out
}
