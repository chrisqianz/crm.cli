/**
 * Minimal TTY prompts for interactive use (`crm login`, `crm admin bootstrap`).
 * Hidden-input mode disables echo so passwords do not appear in terminal
 * scrollback.
 */

function prompt(query: string, secret: boolean): Promise<string> {
  process.stdout.write(query)
  const decoder = new TextDecoder()
  let out = ''
  return new Promise((resolve, reject) => {
    // Iterate code points, not bytes: a chunk that carries a multi-byte
    // character (or arrives as a paste) used to be decoded once per byte, so a
    // pasted "admin\n" came out as "adminadminadmin…", and a non-ASCII answer
    // was silently dropped.
    const onData = (d: Buffer) => {
      for (const ch of decoder.decode(d, { stream: true })) {
        if (ch === '\r' || ch === '\n') {
          cleanup()
          process.stdout.write('\n')
          resolve(out)
          return
        }
        if (ch === '\u0003') {
          // Ctrl-C
          cleanup()
          process.stdout.write('\n')
          reject(new Error('aborted'))
          return
        }
        if (ch === '\x7f' || ch === '\b') {
          out = out.slice(0, -1)
          if (!secret) {
            process.stdout.write('\b \b')
          }
          continue
        }
        if (ch < ' ') {
          // Tabs, escapes and arrow keys are not part of an answer.
          continue
        }
        out += ch
        if (!secret) {
          // Raw mode switched the terminal's own echo off, so an answer you
          // cannot see looks exactly like a frozen terminal.
          process.stdout.write(ch)
        }
      }
    }
    const cleanup = () => {
      process.stdin.off('data', onData)
      process.stdin.setRawMode?.(false)
      // resume() below put stdin in flowing mode, and a terminal stdin keeps
      // the event loop alive forever. Without pausing it the command prints
      // its answer, saves the session, and then sits there with a blinking
      // cursor instead of handing the shell back.
      process.stdin.pause()
    }
    process.stdin.setRawMode?.(true)
    process.stdin.on('data', onData)
    process.stdin.resume()
  })
}

export function promptLine(query: string): Promise<string> {
  return prompt(query, false)
}

/** Hidden-input prompt (passwords). */
export function promptSecret(query: string): Promise<string> {
  return prompt(query, true)
}
