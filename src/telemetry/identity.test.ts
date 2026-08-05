import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getInstallId, identityPath } from './identity.js'

let dirs: string[] = []

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'orq-tel-'))
  dirs.push(d)
  return d
}

beforeEach(() => { dirs = [] })
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

describe('getInstallId', () => {
  it('mints an id on first call and returns the same one afterwards', () => {
    const dir = tmp()
    const first = getInstallId(dir)
    expect(first).not.toBe('')
    // stability is what makes distinct-install counts meaningful: a node that re-minted
    // every restart would look like a growing fleet to the collector.
    expect(getInstallId(dir)).toBe(first)
    expect(getInstallId(dir)).toBe(first)
  })

  it('persists across a simulated restart (fresh read from disk)', () => {
    const dir = tmp()
    const minted = getInstallId(dir)
    const onDisk = JSON.parse(readFileSync(identityPath(dir), 'utf-8')) as { installId: string }
    expect(onDisk.installId).toBe(minted)
  })

  it('gives two data dirs on one machine unrelated ids', () => {
    const a = getInstallId(tmp())
    const b = getInstallId(tmp())
    expect(a).not.toBe(b)
  })

  it('replaces a corrupt identity file rather than reusing or throwing', () => {
    const dir = tmp()
    writeFileSync(identityPath(dir), '{ not json')
    const id = getInstallId(dir)
    expect(id).not.toBe('')
    expect(getInstallId(dir)).toBe(id) // and the replacement is itself stable
  })

  it('replaces a well-formed file whose installId is empty', () => {
    const dir = tmp()
    writeFileSync(identityPath(dir), JSON.stringify({ installId: '' }))
    expect(getInstallId(dir)).not.toBe('')
  })

  it('is not derived from the data dir path', () => {
    // Same basename, different parents — a path-derived id would collide.
    const a = mkdtempSync(join(tmpdir(), 'orq-a-'))
    const b = mkdtempSync(join(tmpdir(), 'orq-b-'))
    dirs.push(a, b)
    expect(getInstallId(a)).not.toBe(getInstallId(b))
  })
})
