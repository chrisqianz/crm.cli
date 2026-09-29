/**
 * CLI ergonomics:
 *  - every subcommand shows a description in its help
 *  - `add` accepts the name/title as a positional argument
 *  - refs resolve by name/title (case-insensitive, exact), with an
 *    explicit ambiguity error (exit 3) instead of a silent pick
 *  - unknown option on a command group points at the subcommand that owns it
 *  - `crm completion bash|zsh|fish` prints ready-to-source scripts
 */
import { describe, expect, test } from 'bun:test'

import { createTestContext } from './helpers'

describe('cli ergonomics', () => {
  test('subcommand help output carries descriptions', () => {
    const { runOK } = createTestContext()
    const contact = runOK('contact', '--help')
    expect(contact).toContain('Create a contact')
    expect(contact).toContain('List contacts')
    expect(contact).toContain('Delete a contact')
    const report = runOK('report', '--help')
    expect(report).toContain('Pipeline summary')
    expect(report).toContain('Stage conversion rates')
  })

  test('contact/company/deal add accept the name as a positional argument', () => {
    const { runOK, runJSON } = createTestContext()
    const cid = runOK('contact', 'add', '张三', '--email', 'zs@a.com').trim()
    expect(cid).toMatch(/^ct_/)
    const rows = runJSON('contact', 'list', '--format', 'json') as Record<
      string,
      unknown
    >[]
    expect(rows[0]).toMatchObject({ name: '张三' })
    const coId = runOK(
      'company',
      'add',
      '某某科技',
      '--website',
      'https://x.com',
    ).trim()
    expect(coId).toMatch(/^co_/)
    const dlId = runOK('deal', 'add', 'Q3 报价', '--value', '1000').trim()
    expect(dlId).toMatch(/^dl_/)
  })

  test('add with no name at all still fails with a clear error', () => {
    const { runFail } = createTestContext()
    const r = runFail('contact', 'add')
    expect(r.stderr).toContain('--name')
  })

  test('unknown option on a command group hints at the owning subcommand', () => {
    const { runFail } = createTestContext()
    const r = runFail('contact', '--email', 'x@y.com')
    expect(r.stderr).toContain("unknown option '--email'")
    expect(r.stderr).toContain('crm contact add')
  })

  test('refs resolve by name/title, case-insensitive', () => {
    const { runOK, runJSON } = createTestContext()
    runOK('contact', 'add', '张三', '--email', 'zs@a.com')
    expect(runOK('contact', 'show', '张三')).toContain('zs@a.com')
    const co = runOK('company', 'add', 'Acme Corp').trim()
    expect(runOK('company', 'show', 'acme corp')).toContain(co)
    runOK('deal', 'add', 'Q3 报价', '--value', '100')
    const deals = runJSON('deal', 'list', '--format', 'json') as Record<
      string,
      string
    >[]
    expect(runOK('deal', 'show', 'q3 报价')).toContain(deals[0].id)
    // rm works by name too
    expect(runOK('contact', 'rm', '张三', '--force')).toBe('')
  })

  test('name lookup is exact-only: a prefix of another name is not found', () => {
    const { runOK, runFail } = createTestContext()
    runOK('contact', 'add', '张三丰', '--email', 'zsf@a.com')
    const r = runFail('contact', 'show', '张三')
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('contact not found')
  })

  test('same name twice → ambiguous: exit 3 with candidates; id still works', () => {
    const { runOK, runFail, runJSON } = createTestContext()
    runOK('contact', 'add', '张三', '--email', 'zs1@a.com')
    runOK('contact', 'add', '张三', '--email', 'zs2@a.com')
    const r = runFail('contact', 'show', '张三')
    expect(r.exitCode).toBe(3)
    expect(r.stderr).toContain('zs1@a.com')
    expect(r.stderr).toContain('zs2@a.com')
    // email still disambiguates
    expect(runOK('contact', 'show', 'zs1@a.com')).toContain('zs1@a.com')
    const ids = (
      runJSON('contact', 'list', '--format', 'json') as Record<string, string>[]
    ).map((c) => c.id)
    expect(runOK('contact', 'show', ids[0])).toContain('张三')
  })

  test('crm completion prints bash/zsh/fish scripts', () => {
    const { runOK } = createTestContext()
    const bash = runOK('completion', 'bash')
    expect(bash).toContain('complete -F')
    expect(bash).toContain('contact')
    expect(bash).toContain('audit')
    expect(bash).toContain('add list show edit rm merge')
    const zsh = runOK('completion', 'zsh')
    expect(zsh).toContain('#compdef crm')
    expect(zsh).toContain('contact')
    const fish = runOK('completion', 'fish')
    expect(fish).toContain('complete -c crm')
    expect(fish).toContain('contact')
  })
})
