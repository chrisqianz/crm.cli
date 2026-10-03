/**
 * The REPL's one and only splitter. Lives here (not in repl.ts, not in
 * parser.ts) because both the executor and the Tab completer must agree on
 * what "a token" is — and neither may end up importing the other.
 */

/**
 * Split a REPL line into argv, honouring double quotes so a name with a space
 * stays one argument. Quotes are not shell quotes: no escapes, no `$`, no
 * redirection — a REPL line only ever becomes an argv array. The splitter
 * itself stays dumb; callers are what refuse an unterminated quote.
 */
export function tokenize(line: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quoted = false
  let started = false
  for (const ch of line) {
    if (ch === '"') {
      quoted = !quoted
      started = true
      continue
    }
    if (!quoted && (ch === ' ' || ch === '\t')) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += ch
    started = true
  }
  if (started) {
    tokens.push(current)
  }
  return tokens
}

/** Is the line sitting on a fresh token (trailing space), i.e. completion
 * targets a slot the user has not started typing yet? */
export function endsOpen(line: string): boolean {
  return line === '' || line.endsWith(' ') || line.endsWith('\t')
}
