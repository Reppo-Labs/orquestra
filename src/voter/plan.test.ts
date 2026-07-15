// src/voter/plan.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createVotePlanner, type VotePlannerOpts } from './plan.js'
import type { VoteIntent, ExecResult } from '../wallet/intents.js'

const REPPO = 10n ** 18n

const intent = (podId: string, conviction = 9): VoteIntent =>
  ({ kind: 'vote', datanetId: 'x', podId, direction: 'up', conviction, reason: 'r' })

/** Ledger fake mirroring the real one: the cast side effect (executor reserve) is what
 *  spends the budget, so the fake cast decrements it. */
function fakeLedger(total: number) {
  const state = { remaining: total }
  return {
    state,
    canVote: () => state.remaining > 0,
    votesRemaining: () => state.remaining,
  }
}

function makePlanner(over: Partial<VotePlannerOpts> & { ledgerTotal?: number } = {}) {
  const ledger = fakeLedger(over.ledgerTotal ?? 99)
  const executed: { datanetId: string; intent: VoteIntent }[] = []
  const cast = vi.fn(async (datanetId: string, i: VoteIntent): Promise<ExecResult> => {
    if (!ledger.canVote()) return { ok: false, status: 'refused-budget', detail: 'cap' }
    ledger.state.remaining--
    executed.push({ datanetId, intent: i })
    return { ok: true, status: 'executed', txHash: `0x${i.podId}` }
  })
  const deferred: [string, number][] = []
  const planner = createVotePlanner({
    voteWeights: new Map([['1', 1], ['2', 1]]),
    voteRateMaxPerCycle: over.voteRateMaxPerCycle ?? 4,
    weigher: null,
    ledger,
    cast,
    onDeferred: (id, n) => deferred.push([id, n]),
    ...over,
  })
  return { planner, cast, executed, deferred, ledger }
}

describe('createVotePlanner — pass 1', () => {
  it('casts up to the datanet slot share and stashes the rest for finish()', async () => {
    // cap 4 split over weights 1:1 → 2 slots each.
    const { planner, executed, deferred } = makePlanner()
    const sink = await planner.castPass1('1', [intent('a'), intent('b'), intent('c')])
    expect(executed.map((e) => e.intent.podId)).toEqual(['a', 'b'])
    expect(sink).toHaveLength(2)
    await planner.castPass1('2', []) // datanet 2 has nothing — its slots free up
    await planner.finish() // redistribution drains the stash
    expect(executed.map((e) => e.intent.podId)).toEqual(['a', 'b', 'c'])
    expect(deferred).toEqual([]) // everything cast — no deferral breadcrumb
  })

  it('stops on a refused-budget cast and stashes the remainder', async () => {
    const { planner, cast, deferred } = makePlanner({ ledgerTotal: 1, voteRateMaxPerCycle: 4 })
    await planner.castPass1('1', [intent('a'), intent('b'), intent('c')])
    expect(cast).toHaveBeenCalledTimes(1) // 'a' executed; 'b' never attempted (canVote false)
    await planner.finish()
    expect(deferred).toEqual([['1', 2]]) // b + c deferred, one breadcrumb with the count
  })

  it('never calls cast when the ledger is already exhausted', async () => {
    const { planner, cast } = makePlanner({ ledgerTotal: 0 })
    const sink = await planner.castPass1('1', [intent('a')])
    expect(cast).not.toHaveBeenCalled()
    expect(sink).toEqual([])
  })

  it('results land in the SAME array castPass1 returned — finish() appends to it', async () => {
    const { planner } = makePlanner({ voteRateMaxPerCycle: 2 }) // 1 slot per datanet
    const sink = await planner.castPass1('1', [intent('a'), intent('b')])
    expect(sink).toHaveLength(1)
    await planner.castPass1('2', [])
    await planner.finish()
    expect(sink).toHaveLength(2) // pass-2 vote appended to the ref the report holds
  })
})

describe('createVotePlanner — pass 2 redistribution', () => {
  it('re-splits remaining budget by voteShare until stashes drain', async () => {
    // cap 6, weights 1:1 → 3 slots each. Datanet 1 has 5 intents, datanet 2 has 1:
    // pass 1 casts 3 + 1; pass 2 re-splits the 2 unused to datanet 1.
    const { planner, executed } = makePlanner({ voteRateMaxPerCycle: 6 })
    await planner.castPass1('1', ['a', 'b', 'c', 'd', 'e'].map((p) => intent(p)))
    await planner.castPass1('2', [intent('z')])
    expect(executed).toHaveLength(4)
    await planner.finish()
    expect(executed.map((e) => e.intent.podId)).toEqual(['a', 'b', 'c', 'z', 'd', 'e'])
  })

  it('breaks (no infinite loop) when every redistribution cast is refused', async () => {
    const cast = vi.fn(async (): Promise<ExecResult> => ({ ok: false, status: 'refused-budget' }))
    const ledger = { canVote: () => true, votesRemaining: () => 10 } // ledger says yes, executor refuses
    const deferred: [string, number][] = []
    const planner = createVotePlanner({
      voteWeights: new Map([['1', 1]]), voteRateMaxPerCycle: 2, weigher: null,
      ledger, cast, onDeferred: (id, n) => deferred.push([id, n]),
    })
    await planner.castPass1('1', [intent('a'), intent('b'), intent('c')])
    await planner.finish() // must terminate via the progressed guard
    expect(deferred).toEqual([['1', 3]])
  })
})

describe('createVotePlanner — weigher sizing', () => {
  it('sizes each cast intent with voteWeightWei from the weigher', async () => {
    const { planner, executed } = makePlanner({ weigher: () => 250n * REPPO })
    await planner.castPass1('1', [intent('a')])
    expect(executed[0].intent.voteWeightWei).toBe((250n * REPPO).toString())
  })

  it('a 0n weigher answer refuses WITHOUT calling cast, lands in the sink, and defers the rest', async () => {
    const { planner, cast, deferred } = makePlanner({ weigher: () => 0n })
    const sink = await planner.castPass1('1', [intent('a'), intent('b')])
    expect(cast).not.toHaveBeenCalled()
    expect(sink[0].status).toBe('refused-budget')
    await planner.finish()
    // slice(i) on refusal includes the refused intent itself — 'a' AND 'b' stay stashed
    // and are retried next cycle (mirrors the original pass-1 semantics exactly).
    expect(deferred).toEqual([['1', 2]])
  })

  it('null weigher passes intents through without voteWeightWei (legacy sizing)', async () => {
    const { planner, executed } = makePlanner({ weigher: null })
    await planner.castPass1('1', [intent('a')])
    expect(executed[0].intent.voteWeightWei).toBeUndefined()
  })
})
