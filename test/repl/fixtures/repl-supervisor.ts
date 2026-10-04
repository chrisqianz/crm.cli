/**
 * Supervisor fixture for test/repl/exit.test.ts — kept as a real file so
 * no layer of shell or `bun -e` quoting can corrupt it.
 *
 * argv: [repl-supervisor.ts, <payload-base64>]
 *
 * Spawns the CLI with a stdin pipe that stays OPEN after the input is
 * written (the shape of a supervisor piping commands without hanging up).
 * If the child exits, forwards its stdout (then its stderr, each line
 * prefixed `ERR:`) and mirrors its exit code; if the watchdog fires first,
 * kills the child, prints SUPERVISOR_HELD_STILL_RUNNING and exits 8.
 */
const spec = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'))
const child = Bun.spawn(['bun', spec.cli, ...(spec.argv ?? [])], {
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'pipe',
  env: { HOME: process.env.HOME, PATH: process.env.PATH, ...spec.env },
  cwd: spec.repo,
})
child.stdin.write(spec.input)
const timer = setTimeout(() => {
  console.log('SUPERVISOR_HELD_STILL_RUNNING')
  child.kill()
  process.exit(8)
}, spec.hold * 1000)
const code = await child.exited
clearTimeout(timer)
process.stdout.write(await new Response(child.stdout).text())
const errText = await new Response(child.stderr).text()
for (const line of errText.split('\n')) {
  if (line) {
    process.stdout.write(`ERR:${line}\n`)
  }
}
process.exit(code)
