import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALLOWLIST_FIELDS, buildPayload, serializePayload, SCHEMA_VERSION, resolveVersion, UNSTAMPED_VERSION, gitShortSha } from './payload.js'
import { toSignature, MAX_FRAMES } from './signature.js'

let dirs: string[] = []

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'orq-tel-'))
  dirs.push(d)
  return d
}

beforeEach(() => { dirs = [] })
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

describe('allowlist shape (task 2.5)', () => {
  it('the built payload key set equals the declared allowlist exactly', () => {
    // This is the test that makes the allowlist real rather than aspirational: a field
    // added to the builder without being declared fails here, and vice versa.
    const keys = Object.keys(buildPayload(tmp())).sort()
    expect(keys).toEqual([...ALLOWLIST_FIELDS].sort())
  })

  it('the serialized wire form introduces no additional top-level keys', () => {
    const parsed = JSON.parse(serializePayload(buildPayload(tmp()))) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual([...ALLOWLIST_FIELDS].sort())
  })

  it('carries a schema version and a production timestamp', () => {
    const p = buildPayload(tmp(), { now: () => new Date('2026-08-04T12:00:00.000Z') })
    expect(p.schemaVersion).toBe(SCHEMA_VERSION)
    expect(p.ts).toBe('2026-08-04T12:00:00.000Z')
  })
})

describe('prohibited content (task 2.6)', () => {
  // Values drawn from a realistic node: a wallet address, the Sherwood datanet + WOOD
  // token, and strategy thresholds from a live strategy config.
  const WALLET = '0x1234567890AbCdEf1234567890aBcDeF12345678'
  const SUBNET = 'cms3uejpj0001jf040zjgwqwm'
  const WOOD = '0xF8BC08092C06dB6148114DCf82AF881F1085f92b'

  it('contains no wallet address, in any form', () => {
    const wire = serializePayload(buildPayload(tmp()))
    expect(wire).not.toContain(WALLET)
    expect(wire).not.toContain(WALLET.toLowerCase())
    // Nor any 0x-prefixed 40-hex-char string at all — the point is that there is no
    // field an address could occupy, not that this particular one is filtered.
    expect(wire).not.toMatch(/0x[0-9a-fA-F]{40}/)
  })

  it('contains no datanet, subnet, or token identifier', () => {
    const wire = serializePayload(buildPayload(tmp()))
    for (const forbidden of [SUBNET, WOOD, 'WOOD', 'datanet', 'subnet']) {
      expect(wire.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
  })

  it('contains no strategy thresholds, balances, earnings, or ROI', () => {
    const wire = serializePayload(buildPayload(tmp())).toLowerCase()
    for (const forbidden of [
      'minselfscore', 'topn', 'voterate', 'mintreppomax', 'horizon',
      'balance', 'reppo', 'roi', 'yield', 'earnings', 'gas',
    ]) {
      expect(wire).not.toContain(forbidden)
    }
  })

  it('contains no pod content, panel transcript, or free-text field', () => {
    const wire = serializePayload(buildPayload(tmp())).toLowerCase()
    for (const forbidden of ['podname', 'panel', 'transcript', 'reason', 'detail', 'message']) {
      expect(wire).not.toContain(forbidden)
    }
  })

  it('contains no RPC URL', () => {
    const wire = serializePayload(buildPayload(tmp()))
    expect(wire).not.toMatch(/https?:\/\//)
  })
})

describe('error signatures (tasks 2.3, 2.7, 2.8)', () => {
  it('never transmits the error message', () => {
    const err = new Error('failed to mint pod "Acme Q3 Report" for datanet 3')
    const sig = toSignature(err)
    const wire = JSON.stringify(sig)
    expect(wire).not.toContain('Acme Q3 Report')
    expect(wire).not.toContain('datanet 3')
    expect(sig.errorClass).toBe('Error')
  })

  it('strips credentials from a message-bearing stack (task 2.7)', () => {
    // The redaction layer is defense in depth; the structural defense is that the first
    // stack line (which holds the message) is not a frame and is therefore dropped.
    const err = new Error(
      'Command failed: reppo vote --rpc-url https://base-mainnet.g.alchemy.com/v2/SECRETKEY123',
    )
    const wire = JSON.stringify(toSignature(err))
    expect(wire).not.toContain('SECRETKEY123')
    expect(wire).not.toContain('alchemy.com')
  })

  it('produces an identical signature for the same fault on differently-configured nodes (task 2.8)', () => {
    // Same code path, different machines and different operator config. If these diverged,
    // a real fleet-wide bug could never reach the distinct-install admission threshold.
    const nodeA = new Error('vote failed on datanet 3 with topN 1')
    nodeA.stack = [
      'Error: vote failed on datanet 3 with topN 1',
      '    at castVote (/Users/ana/code/orquestra/dist/reppo/vote.js:42:11)',
      '    at runCycle (/Users/ana/code/orquestra/dist/runtime/cycle.js:118:7)',
    ].join('\n')

    const nodeB = new Error('vote failed on datanet 7 with topN 5')
    nodeB.stack = [
      'Error: vote failed on datanet 7 with topN 5',
      '    at castVote (/app/dist/reppo/vote.js:42:11)',
      '    at runCycle (/app/dist/runtime/cycle.js:118:7)',
    ].join('\n')

    expect(toSignature(nodeA)).toEqual(toSignature(nodeB))
  })

  it('normalizes away the operator username in absolute paths', () => {
    const err = new Error('boom')
    err.stack = ['Error: boom', '    at f (/Users/anajulia/code/orquestra/src/runtime/cycle.ts:9:1)'].join('\n')
    const wire = JSON.stringify(toSignature(err))
    expect(wire).not.toContain('anajulia')
    expect(wire).toContain('src/runtime/cycle.ts:9')
  })

  it('caps frame count', () => {
    const err = new Error('deep')
    err.stack = ['Error: deep', ...Array.from({ length: 40 }, (_, i) => `    at f${i} (/app/src/a.ts:${i}:1)`)].join('\n')
    expect(toSignature(err).frames).toHaveLength(MAX_FRAMES)
  })

  it('handles non-Error throws without leaking their content', () => {
    const sig = toSignature({ secret: 'wallet-key-material' })
    expect(sig.errorClass).toBe('UnknownError')
    expect(sig.frames).toEqual([])
    expect(JSON.stringify(sig)).not.toContain('wallet-key-material')
  })

  it('signatures reaching the payload stay free of message text', () => {
    const err = new Error('pod "Confidential Alpha" rejected')
    const wire = serializePayload(buildPayload(tmp(), { errorSignatures: [toSignature(err)] }))
    expect(wire).not.toContain('Confidential Alpha')
  })
})

describe('resolveVersion', () => {
  // Four of six live installs reported the literal '0.1.0' — a well-formed semver that
  // was never released, so in a per-version rollup it silently sorts as "some old
  // release" and every source-run node collapses into one indistinguishable bucket.
  it('marks an unstamped build as dev and names the commit', () => {
    expect(resolveVersion({ pkgVersion: UNSTAMPED_VERSION, sha: '9f3a1c2' })).toBe('0.0.0-dev+9f3a1c2')
  })

  it('is still unmistakably dev when the commit cannot be read', () => {
    expect(resolveVersion({ pkgVersion: UNSTAMPED_VERSION, sha: null })).toBe('0.0.0-dev')
  })

  it('passes a stamped release version through untouched', () => {
    // The release workflow does `npm pkg set version=…` into the image's package.json.
    expect(resolveVersion({ pkgVersion: '0.4.62', sha: '9f3a1c2' })).toBe('0.4.62')
  })

  it('lets an explicit override win over everything', () => {
    expect(resolveVersion({ override: '1.2.3-rc1', pkgVersion: '0.4.62', sha: 'abc1234' })).toBe('1.2.3-rc1')
  })

  it('ignores an override the collector would reject rather than sending it', () => {
    // A field failing SAFE_VERSION is rejected at ingest field-by-field, which drops the
    // WHOLE report — counts and signatures with it. Falling back beats going dark.
    expect(resolveVersion({ override: 'not a version!', pkgVersion: '0.4.62' })).toBe('0.4.62')
    expect(resolveVersion({ override: 'x'.repeat(40), pkgVersion: UNSTAMPED_VERSION, sha: 'abc1234' })).toBe('0.0.0-dev+abc1234')
  })

  it('every outcome satisfies the collector version rule', () => {
    const SAFE = /^[A-Za-z0-9_.\-+]{1,32}$/
    for (const v of [
      resolveVersion({ pkgVersion: UNSTAMPED_VERSION, sha: '9f3a1c2' }),
      resolveVersion({ pkgVersion: UNSTAMPED_VERSION, sha: null }),
      resolveVersion({ pkgVersion: '0.4.62' }),
      resolveVersion({ override: '1.2.3-rc1' }),
      resolveVersion({ pkgVersion: 'weird version with spaces' }),
    ]) expect(SAFE.test(v)).toBe(true)
  })
})

describe('gitShortSha — repo layouts', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'orq-git-')) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const SHA = '80f5e14aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

  it('reads a normal clone (.git is a directory, loose ref)', () => {
    mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true })
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), `${SHA}\n`)
    expect(gitShortSha(root)).toBe('80f5e14')
  })

  it('reads a fresh clone whose ref is only in packed-refs', () => {
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(root, '.git', 'packed-refs'), `# pack-refs with: peeled\n${SHA} refs/heads/main\n`)
    expect(gitShortSha(root)).toBe('80f5e14')
  })

  it('reads a detached HEAD', () => {
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, '.git', 'HEAD'), `${SHA}\n`)
    expect(gitShortSha(root)).toBe('80f5e14')
  })

  it('reads a WORKTREE, where .git is a file and refs live in the common dir', () => {
    // This is not hypothetical: the first build of this code reported a bare '0.0.0-dev'
    // because it assumed .git was always a directory. Tests passed — they supplied the
    // sha directly — and only running the built binary exposed it.
    const common = join(root, 'main-repo', '.git')
    const wt = join(common, 'worktrees', 'feature')
    mkdirSync(join(common, 'refs', 'heads'), { recursive: true })
    mkdirSync(wt, { recursive: true })
    writeFileSync(join(common, 'refs', 'heads', 'main'), `${SHA}\n`)
    writeFileSync(join(wt, 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(wt, 'commondir'), '../..\n')
    mkdirSync(join(root, 'wt'), { recursive: true })
    writeFileSync(join(root, 'wt', '.git'), `gitdir: ${wt}\n`)
    expect(gitShortSha(join(root, 'wt'))).toBe('80f5e14')
  })

  it('returns null when there is no git at all (a released image)', () => {
    expect(gitShortSha(root)).toBeNull()
  })
})
