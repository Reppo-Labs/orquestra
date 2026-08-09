import { describe, expect, it } from 'vitest'
import { gasView, votePowerView, weiToNum } from './nodeCapacity'
import type { Snapshot } from '../api'

// Pure view-model tests (node env — no DOM). The invariant under test throughout is
// UNREAD IS NOT ZERO: an amount the node could not read must surface as null/"unread"
// so the UI never renders an RPC blip as a wallet with no gas or no voting power.

const snap = (s: Partial<Snapshot>): Snapshot =>
  ({ ts: 0, balance: { eth: 0, reppo: 0, veReppo: 0, usdc: 0 }, emissionsDue: { pods: [] }, ...s }) as unknown as Snapshot

const ONE = '1000000000000000000'

describe('weiToNum', () => {
  it('converts an 18-dec decimal string to a display number', () => {
    expect(weiToNum(ONE)).toBe(1)
    expect(weiToNum('59000' + '0'.repeat(18))).toBe(59000)
    expect(weiToNum('0')).toBe(0)
  })
  it('returns null (unread) for an absent or malformed amount — never 0', () => {
    expect(weiToNum(undefined)).toBeNull()
    expect(weiToNum('')).toBeNull()
    expect(weiToNum('not-a-number')).toBeNull()
  })
})

describe('votePowerView', () => {
  it('reads the live per-epoch budget: remaining, total, cast, and % spent', () => {
    const v = votePowerView(snap({
      votePower: {
        sizing: 've-reppo',
        votingPowerWei: '100' + '0'.repeat(18),
        votesCastedWei: '25' + '0'.repeat(18),
        remainingWei: '75' + '0'.repeat(18),
        epoch: 12,
      },
    }))
    expect(v.sizing).toBe('veReppo')
    expect(v.degraded).toBe(false)
    expect(v.remaining).toBe(75)
    expect(v.total).toBe(100)
    expect(v.spent).toBe(25)
    expect(v.spentPct).toBe(25)
    expect(v.epoch).toBe(12)
  })

  it('flags the no-RPC fallback as degraded and names the fix', () => {
    const v = votePowerView(snap({ votePower: { sizing: 'legacy-no-rpc' } }))
    expect(v.degraded).toBe(true)
    expect(v.sizingLabel).toBe('conviction dust')
    expect(v.sizingNote).toContain('RPC_URL')
    // no amounts were read — they stay unread, NOT zero
    expect(v.remaining).toBeNull()
    expect(v.total).toBeNull()
    expect(v.spent).toBeNull()
    expect(v.spentPct).toBeNull()
  })

  it('keeps a failed read distinct from a missing RPC (one self-heals, one does not)', () => {
    const failed = votePowerView(snap({ votePower: { sizing: 'legacy-read-failed' } }))
    expect(failed.sizing).toBe('read-failed')
    expect(failed.degraded).toBe(true)
    expect(failed.sizingNote).toContain('self-heals')
    expect(failed.sizingNote).not.toBe(votePowerView(snap({ votePower: { sizing: 'legacy-no-rpc' } })).sizingNote)
  })

  it('treats a snapshot with no votePower block as unknown, not as zero power', () => {
    const v = votePowerView(snap({}))
    expect(v.sizing).toBe('unknown')
    expect(v.degraded).toBe(false) // we do not claim votes were dust when we do not know
    expect(v.remaining).toBeNull()
    expect(votePowerView(null).sizing).toBe('unknown')
  })

  it('does not divide by a zero total: a wallet with no power is 0% spent, not 100%', () => {
    const v = votePowerView(snap({ votePower: { sizing: 've-reppo', votingPowerWei: '0', votesCastedWei: '0', remainingWei: '0' } }))
    expect(v.total).toBe(0)
    expect(v.spentPct).toBeNull()
  })

  it('clamps the spent bar at 100% when votesCasted exceeds the decayed power', () => {
    // votesCasted ledgers the UNDECAYED amount, so spent > current power is legitimate.
    const v = votePowerView(snap({ votePower: { sizing: 've-reppo', votingPowerWei: '10' + '0'.repeat(18), votesCastedWei: '30' + '0'.repeat(18), remainingWei: '0' } }))
    expect(v.spentPct).toBe(100)
    expect(v.remaining).toBe(0) // an ACTUAL zero remainder is still reported as zero
  })
})

describe('gasView', () => {
  it('reports the balance and the node\u2019s own low-gas verdict', () => {
    const v = gasView(snap({ balance: { eth: 0.0004, reppo: 0, veReppo: 0, usdc: 0 }, lowGas: true } as Partial<Snapshot>))
    expect(v.eth).toBe(0.0004)
    expect(v.low).toBe(true)
    expect(v.unjudged).toBe(false)
    expect(v.note).toContain('Top up')
  })

  it('is calm when the node did not flag low gas', () => {
    const v = gasView(snap({ balance: { eth: 0.05, reppo: 0, veReppo: 0, usdc: 0 }, lowGas: false } as Partial<Snapshot>))
    expect(v.low).toBe(false)
    expect(v.unjudged).toBe(false)
  })

  it('claims no verdict on rows written before the low-gas check existed', () => {
    const v = gasView(snap({ balance: { eth: 0.0001, reppo: 0, veReppo: 0, usdc: 0 } }))
    expect(v.low).toBe(false) // never invent a warning the node did not raise
    expect(v.unjudged).toBe(true)
  })

  it('has nothing to show before the first cycle', () => {
    const v = gasView(null)
    expect(v.eth).toBeNull()
    expect(v.low).toBe(false)
  })
})
