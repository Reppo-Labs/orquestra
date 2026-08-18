// The prohibited-content assertions in payload.test.ts run against an EMPTY data dir,
// where there is nothing to leak and they pass trivially. This file is the version with
// teeth: it populates the activity log with exactly the data the payload must never
// carry — a wallet address, real datanet and pod identifiers, token symbols, panel
// transcript text, and a credential-bearing error detail — and then asserts none of it
// reaches the wire.
//
// This is the regression test for the most likely future mistake: someone adds a useful
// per-datanet or per-pod breakdown to counts.ts, and a strategy-revealing field starts
// shipping to every operator by default.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { toSignature } from './signature.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendActivity } from '../dashboard/activityLog.js'
import { buildPayload, serializePayload } from './payload.js'
import { readCounts } from './counts.js'

const WALLET = '0x1234567890AbCdEf1234567890aBcDeF12345678'
const SUBNET = 'cms3uejpj0001jf040zjgwqwm'
const POD_NAME = 'NVDA Tokenized Stock Liquidity Snapshot'
const PANEL_TEXT = 'judge: this pod scores 9 because the operator strategy targets WOOD emissions'
const SECRET_URL = 'https://base-mainnet.g.alchemy.com/v2/SUPERSECRETKEY123'

let dirs: string[] = []

function seeded(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orq-leak-'))
  dirs.push(dir)

  appendActivity(dir, {
    ts: new Date().toISOString(), cycleId: 'c1', kind: 'vote', datanetId: SUBNET,
    podId: '922', podName: POD_NAME, direction: 'up', conviction: 9,
    reason: 'strong liquidity signal', status: 'executed', txHash: WALLET,
    gasEth: 0.00042, detail: `sent from ${WALLET}`,
  })
  appendActivity(dir, {
    ts: new Date().toISOString(), cycleId: 'c1', kind: 'vote', datanetId: SUBNET,
    podId: '923', direction: 'down', status: 'error',
    detail: `Command failed: reppo vote --rpc-url ${SECRET_URL}`,
  })
  appendActivity(dir, {
    ts: new Date().toISOString(), cycleId: 'c2', kind: 'mint', datanetId: SUBNET,
    canonicalKey: 'nvda-usdg-0.05', status: 'executed', reppoSpent: 7200,
  })
  appendActivity(dir, {
    ts: new Date().toISOString(), cycleId: 'c2', kind: 'mint', datanetId: SUBNET,
    status: 'refused-budget', detail: 'mintReppoMax 1000 would be exceeded',
  })
  appendActivity(dir, {
    ts: new Date().toISOString(), cycleId: 'c2', kind: 'claim', datanetId: SUBNET,
    reppoClaimed: 1234.5, claimedTokenSymbol: 'WOOD', claimedTokenAmount: 7200,
    status: 'executed',
  })
  appendActivity(dir, {
    ts: new Date().toISOString(), cycleId: 'c3', kind: 'skip', datanetId: SUBNET,
    reason: PANEL_TEXT, status: 'skipped',
  })

  return dir
}

beforeEach(() => { dirs = [] })
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

describe('no leakage from a populated activity log', () => {
  it('counts are actually non-trivial (guards against a vacuous test)', () => {
    // If this fails, every assertion below is meaningless.
    const c = readCounts(seeded())
    expect(c.cycles).toBe(3)
    expect(c.votes.attempted).toBe(2)
    expect(c.votes.failed).toBe(1)
    expect(c.mints.attempted).toBe(1) // executed only; refused-budget is not an attempt
    expect(c.refusedBudget).toBe(1)
    expect(c.errors).toBe(1)
  })

  it('transmits no wallet address', () => {
    const wire = serializePayload(buildPayload(seeded()))
    expect(wire).not.toContain(WALLET)
    expect(wire).not.toContain(WALLET.toLowerCase())
    expect(wire).not.toMatch(/0x[0-9a-fA-F]{40}/)
  })

  it('transmits no datanet, pod, or token identifier', () => {
    const wire = serializePayload(buildPayload(seeded()))
    for (const v of [SUBNET, POD_NAME, 'NVDA', 'WOOD', 'nvda-usdg-0.05', '922', '923']) {
      expect(wire).not.toContain(v)
    }
  })

  it('transmits no panel or reason free text', () => {
    const wire = serializePayload(buildPayload(seeded()))
    expect(wire).not.toContain(PANEL_TEXT)
    expect(wire).not.toContain('strong liquidity signal')
  })

  it('transmits no credential, even though one is in the activity log', () => {
    const wire = serializePayload(buildPayload(seeded()))
    expect(wire).not.toContain('SUPERSECRETKEY123')
    expect(wire).not.toContain('alchemy.com')
  })

  it('transmits no earnings, spend, or threshold figures', () => {
    const wire = serializePayload(buildPayload(seeded()))
    for (const v of ['1234.5', '7200', '0.00042', 'mintReppoMax']) {
      expect(wire).not.toContain(v)
    }
  })

  it('the whole wire form is still only the allowlisted keys', () => {
    const parsed = JSON.parse(serializePayload(buildPayload(seeded()))) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(
      ['arch', 'counts', 'errorSignatures', 'installId', 'nodeVersion', 'orquestraVersion', 'platform', 'schemaVersion', 'ts'],
    )
  })
})

describe('leakage — the error code is an allowlist, not a message channel', () => {
  /** A CLI failure whose message is stuffed with everything the payload forbids. */
  const hostile = (): Error => {
    const e = new Error(
      'Command failed: reppo vote --rpc-url https://base-mainnet.g.alchemy.com/v2/SUPERSECRETKEY123 ' +
      '--pod 3750 --datanet 3 — wallet 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 ' +
      'pod "NVDA momentum, strong liquidity signal" earned 1234.5 WOOD — ' +
      'error: VOTER_LACKS_SUBNET_ACCESS: voter lacks subnet access',
    )
    e.stack = `Error: ${e.message}\n    at run (/app/dist/reppo/cli.js:140:11)`
    return e
  }

  it('emits the code and NOTHING else from a message full of forbidden values', () => {
    const wire = JSON.stringify(toSignature(hostile()))
    expect(JSON.parse(wire).code).toBe('VOTER_LACKS_SUBNET_ACCESS')
    for (const forbidden of [
      'SUPERSECRETKEY123', 'alchemy.com',
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      'NVDA', 'WOOD', 'strong liquidity signal', '1234.5', '3750',
    ]) {
      expect(wire).not.toContain(forbidden)
    }
  })

  it('a signature object still has only the three known keys', () => {
    const sig = toSignature(hostile()) as unknown as Record<string, unknown>
    expect(Object.keys(sig).sort()).toEqual(['code', 'errorClass', 'frames'])
  })

  it('an unrecognized failure carries no code at all — absent, not empty', () => {
    const e = new Error('wallet 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 did something odd')
    e.stack = `Error: ${e.message}\n    at run (/app/dist/reppo/cli.js:140:11)`
    const sig = toSignature(e) as unknown as Record<string, unknown>
    expect('code' in sig).toBe(false)
    expect(JSON.stringify(sig)).not.toContain('0xf39')
  })
})
