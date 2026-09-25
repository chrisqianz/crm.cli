/**
 * Minimal TTY prompts for interactive use (`crm login`, `crm admin bootstrap`).
 * Hidden-input mode disables echo so passwords do not appear in terminal
 * scrollback.
 */

function prompt(query: string, secret: boolean): Promise<string> {
  process.stdout.write(query)
  let out = ''
  return new Promise((resolve, reject) => {
    const onData = (d: Buffer) => {
      for (const byte of d) {
        if (byte === 13 || byte === 10) {
          cleanup()
          process.stdout.write('\n')
          resolve(out)
        } else if (byte === 3) {
          // Ctrl-C
          cleanup()
          process.stdout.write('\n')
          reject(new Error('aborted'))
        } else if (secret) {
          if (byte === 127 || byte === 8) {
            out = out.slice(0, -1)
          } else if (byte >= 32 && byte < 127) {
            out += String.fromCharCode(byte)
          }
        } else {
          out += d.toString('utf8').replace(/[\r\n]/g, '')
        }
      }
    }
    const cleanup = () => {
      process.stdin.off('data', onData)
      process.stdin.setRawMode?.(false)
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
