import { describe, expect, test } from 'bun:test'

import { parseDestination } from '../src/lib/litestream'

describe('backup: destination parsing', () => {
  test('absolute local path → file replica', () => {
    const d = parseDestination('/backups/crm')
    expect(d.kind).toBe('file')
    expect(d.path ?? '').toBe('/backups/crm')
  })

  test('relative local path is resolved against the CWD', () => {
    const d = parseDestination('backups/crm')
    expect(d.kind).toBe('file')
    expect(d.path?.startsWith('/')).toBe(true)
    expect(d.path?.endsWith('backups/crm')).toBe(true)
  })

  test('s3://bucket/prefix → s3 replica with prefix', () => {
    const d = parseDestination('s3://my-bucket/crm/backup')
    expect(d.kind).toBe('s3')
    expect(d.bucket).toBe('my-bucket')
    expect(d.prefix).toBe('crm/backup')
  })

  test('s3://bucket (no prefix) → empty prefix', () => {
    const d = parseDestination('s3://my-bucket')
    expect(d.kind).toBe('s3')
    expect(d.bucket).toBe('my-bucket')
    expect(d.prefix ?? '').toBe('')
  })

  test('unknown scheme is rejected with a clear error', () => {
    expect(() => parseDestination('gs://bucket/x')).toThrow(/local path or s3:/)
    expect(() => parseDestination('file:///x')).toThrow(/local path or s3:/)
  })

  test('empty destination is rejected', () => {
    expect(() => parseDestination('')).toThrow(/non-empty/)
  })
})
