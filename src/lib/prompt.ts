/**
 * Minimal TTY prompts for interactive use (`crm login`, `crm admin bootstrap`).
 * Hidden-input mode disables echo so passwords do not appear in terminal
 * scrollback.
 */

// Piped stdin often delivers multiple lines in one chunk; the character
// tail after the line a prompt consumed is preserved for the next prompt.
let pending = ''

// ── Piped stdin ──
//
// On this Bun build a command-level 'data' listener can miss piped input:
// the events may fire before commander has dispatched to the command, and a
// pipe that was already full at exec time is drained by the runtime during
// bootstrap. A prompt therefore never waits on its own event. Instead a
// module-level listener — attached at CLI startup, before any command runs —
// owns piped input, splits it into lines, and hands each line to the next
// prompt that asks for one. An active readline (the REPL) keeps its own
// listener, so it stays on the event path and we never contend for the fd.

const capturing = !process.stdin.isTTY
let pipedRemainder = ''
let pipedEnded = false
const pipedWaiters: Array<(line: string | null) => void> = []

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

function pipedTakeLine(): string | null {
  const lineEnd = pipedRemainder.indexOf('\n')
  if (lineEnd === -1) {
    return null
  }
  const line = stripCr(pipedRemainder.slice(0, lineEnd))
  pipedRemainder = pipedRemainder.slice(lineEnd + 1)
  return line
}

if (capturing) {
  process.stdin.on('data', (d: Buffer) => {
    pipedRemainder += d.toString('utf8')
    // Hand out lines only while a prompt is actually waiting; the rest
    // stays buffered in pipedRemainder for later prompts.
    for (;;) {
      const waiter = pipedWaiters[0]
      if (waiter === undefined) {
        break
      }
      const line = pipedTakeLine()
      if (line === null) {
        break
      }
      pipedWaiters.shift()
      waiter(line)
    }
  })
  process.stdin.on('end', () => {
    pipedEnded = true
    // EOF: make the trailing partial line consumable as a line, hand out
    // whatever is buffered to waiting prompts, and resolve the rest with
    // null. When nobody is waiting, the buffer is left intact for prompts
    // that come later.
    if (pipedRemainder !== '') {
      pipedRemainder = `${stripCr(pipedRemainder)}\n`
    }
    for (;;) {
      const waiter = pipedWaiters[0]
      if (waiter === undefined) {
        break
      }
      const line = pipedTakeLine()
      if (line === null) {
        for (const rest of pipedWaiters.splice(0)) {
          rest(null)
        }
        break
      }
      pipedWaiters.shift()
      waiter(line)
    }
  })
}

function pipedNextLine(): Promise<string | null> {
  if (!capturing) {
    return Promise.resolve(null)
  }
  const ready = pipedTakeLine()
  if (ready !== null) {
    return Promise.resolve(ready)
  }
  if (pipedEnded) {
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    pipedWaiters.push(resolve)
  })
}

// Data listeners beyond this module's own capture — i.e. an active
// readline sharing the stream (the REPL). When one exists, prompts use the
// event path instead of the capture.
function externalConsumers(): number {
  return process.stdin.listenerCount('data') - (capturing ? 1 : 0)
}

async function promptPiped(query: string): Promise<string> {
  process.stdout.write(query)
  const line = await pipedNextLine()
  process.stdout.write('\n')
  if (line === null) {
    throw new Error('aborted')
  }
  return line
}

function prompt(query: string, secret: boolean): Promise<string> {
  // Interactive terminals and streams shared with an active readline (the
  // REPL) use the event path. A bare one-shot command on piped stdin would
  // never receive the events on this runtime, so it serves lines from the
  // startup capture instead.
  if (process.stdin.isTTY || externalConsumers() > 0) {
    return promptEvents(query, secret)
  }
  return promptPiped(query)
}

function promptEvents(query: string, secret: boolean): Promise<string> {
  process.stdout.write(query)
  const decoder = new TextDecoder()
  let out = ''
  return new Promise((resolve, reject) => {
    // Iterate code points, not bytes: a chunk that carries a multi-byte
    // character (or arrives as a paste) used to be decoded once per byte, so a
    // pasted "admin\n" came out as "adminadminadmin…", and a non-ASCII answer
    // was silently dropped.
    //
    // Piped stdin (tests, scripts) often delivers several lines in ONE chunk.
    // A prompt only owns its own line: the characters after the newline are
    // kept in `pending` for the next prompt instead of being swallowed.
    const consume = (chars: string[]): void => {
      let pos = 0
      for (const ch of chars) {
        pos += 1
        if (ch === '\r' || ch === '\n') {
          pending = chars.slice(pos).join('')
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
    const onData = (d: Buffer) => {
      const chars = [...(pending + decoder.decode(d, { stream: true }))]
      pending = ''
      consume(chars)
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
