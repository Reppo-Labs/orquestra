// src/voter/plan.ts — the vote pass as one module: per-datanet slot allocation
// (Pass 1), weigher sizing, and the post-loop redistribution of unused budget
// (Pass 2). Before this module the policy was smeared across four regions of
// runCycle; the cycle now only decides WHEN to vote (inside its per-datanet
// loop) — HOW MANY and HOW HEAVY live here.
//
// The planner owns budget POLICY only. Per-vote side effects — signing, dedup,
// own-pod detection, grant eviction, platform registration, activity rows —
// stay in the injected `cast` (runCycle's closure), so the planner is testable
// with a three-line fake and the effects stay next to the deps they touch.
import { allocateVoteSlots } from './allocate.js'
import type { VoteWeigher } from './weight.js'
import type { VoteIntent, ExecResult } from '../wallet/intents.js'

export interface VotePlannerOpts {
  /** datanetId → voteShare for every vote-enabled datanet ('*' excluded). */
  voteWeights: Map<string, number>
  voteRateMaxPerCycle: number
  /** Per-epoch vote-power sizing (src/voter/weight.ts). null ⇒ legacy sizing:
   *  intents pass through unsized and the executor falls back to conviction×1e18. */
  weigher: VoteWeigher | null
  /** The narrow ledger surface the planner needs — the cast side effect (executor
   *  reserve) is what actually spends it. */
  ledger: { canVote(): boolean; votesRemaining(): number }
  /** Executes one vote and performs every per-vote side effect. Must return
   *  refused-budget (not throw) when the executor's cap refuses. */
  cast(datanetId: string, intent: VoteIntent): Promise<ExecResult>
  /** One deferral breadcrumb per datanet whose stash didn't drain (retried next
   *  cycle — dedup records executed votes only). */
  onDeferred(datanetId: string, count: number): void
}

export interface VotePlanner {
  /** Pass 1: cast up to this datanet's slot share, stash the rest for finish().
   *  Returns the datanet's results array — finish() appends Pass-2 results to the
   *  SAME reference, so the caller's report stays accurate without re-reading. */
  castPass1(datanetId: string, intents: VoteIntent[]): Promise<ExecResult[]>
  /** Pass 2: redistribute the unused global budget across stashed intents by
   *  voteShare, then emit one deferral breadcrumb per datanet with leftovers. */
  finish(): Promise<void>
}

export function createVotePlanner(opts: VotePlannerOpts): VotePlanner {
  const voteSlots = allocateVoteSlots(opts.voteWeights, opts.voteRateMaxPerCycle)
  const leftoverIntents = new Map<string, VoteIntent[]>() // scored-but-unvoted, per datanet
  const voteSinks = new Map<string, ExecResult[]>()        // each datanet's results (same ref castPass1 returned)

  // Size one intent with the weigher, then cast. A 0n answer means the epoch's
  // vote-power budget is spent — signing would revert InsufficientVotingPower and
  // waste gas, so refuse locally (same deferral semantics as a ledger refusal;
  // the per-pod activity row is suppressed by cast's refused-budget contract).
  const castOne = async (datanetId: string, intent: VoteIntent, sink: ExecResult[]): Promise<ExecResult> => {
    if (opts.weigher) {
      const weightWei = opts.weigher(intent.conviction)
      if (weightWei === 0n) {
        const refused: ExecResult = { ok: false, status: 'refused-budget', detail: 'vote-power budget exhausted this epoch' }
        sink.push(refused)
        return refused
      }
      intent = { ...intent, voteWeightWei: weightWei.toString() }
    }
    const r = await opts.cast(datanetId, intent)
    sink.push(r)
    return r
  }

  return {
    async castPass1(datanetId, intents) {
      const sink: ExecResult[] = []
      voteSinks.set(datanetId, sink)
      const cap = voteSlots.get(datanetId) ?? 0
      let cast = 0
      const pending: VoteIntent[] = []
      for (let i = 0; i < intents.length; i++) {
        // Stop at this datanet's slot share, or once the global cap is exhausted — and on a
        // refusal (monotonic within a cycle). Remaining intents are stashed for Pass 2; a
        // single deferral note is emitted by finish() (not one refused row per pod).
        if (cast >= cap || !opts.ledger.canVote()) { pending.push(...intents.slice(i)); break }
        const r = await castOne(datanetId, intents[i], sink)
        if (r.status === 'refused-budget') { pending.push(...intents.slice(i)); break }
        cast++
      }
      if (pending.length) leftoverIntents.set(datanetId, pending)
      return sink
    },

    // Redistribute the unused global vote budget to datanets that still have scored,
    // unvoted intents, weighted by voteShare. Re-splitting `votesRemaining` each round
    // lets a datanet with fewer leftovers than its allotment hand the surplus to the
    // rest, until the budget is spent or all stashes drain. The ledger remains the hard
    // cap (cast refuses past it).
    async finish() {
      if (![...leftoverIntents.values()].some((arr) => arr.length > 0)) return
      while (opts.ledger.canVote()) {
        const pending = [...leftoverIntents].filter(([, arr]) => arr.length > 0)
        if (pending.length === 0) break
        const remaining = opts.ledger.votesRemaining()
        if (remaining <= 0) break
        // Every pending id passed through castPass1, so it is always in voteWeights and
        // voteSinks. A missing entry would be a real bug — skip it rather than invent a
        // weight-1 phantom or cast into a throwaway array that vanishes from the report.
        const split = allocateVoteSlots(new Map(pending.map(([id]) => [id, opts.voteWeights.get(id)!])), remaining)
        let progressed = false
        for (const [id, arr] of pending) {
          const sink = voteSinks.get(id)
          if (!sink) continue
          let n = split.get(id) ?? 0
          while (n > 0 && arr.length > 0 && opts.ledger.canVote()) {
            const r = await castOne(id, arr[0], sink)
            if (r.status === 'refused-budget') break
            arr.shift(); n--; progressed = true
          }
        }
        if (!progressed) break
      }
      for (const [id, arr] of leftoverIntents) {
        if (arr.length > 0) opts.onDeferred(id, arr.length)
      }
    },
  }
}
