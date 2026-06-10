// src/runtime/wiring.ts
// Composition factories extracted from index.ts so the wiring that decides what
// gets signed (dedup closures, pod enrichment, adapter routing) is unit-testable.
// index.ts stays a thin shell: env, service construction, argv dispatch, signals.
import type { StrategyConfig } from '../config/schema.js'
import type { CycleDeps, CycleReport } from './cycle.js'
import type { DatanetAdapter } from '../adapter/types.js'
import type { PodScorer, VoterPod } from '../voter/types.js'
import type { DatanetRubric } from '../rubric/types.js'
import type { BudgetLedger } from '../wallet/ledger.js'
import type { WalletExecutor } from '../wallet/executor.js'
import type { DedupState } from './state.js'
import type { ClaimableEmission } from '../reppo/queryEmissionsDue.js'
import { runCycle } from './cycle.js'
import { getDatanetRubric } from '../rubric/load.js'
import { listPodsJson, deriveCurrentEpoch } from '../reppo/listPods.js'
import { queryEmissionsDueJson } from '../reppo/queryEmissionsDue.js'
import { queryBalanceJson } from '../reppo/queryBalance.js'
import { queryVotingPowerJson } from '../reppo/queryVotingPower.js'
import { queryEpochJson } from '../reppo/queryEpoch.js'
import { queryDatanetPodVotes } from '../reppo/queryOwnPods.js'
import { candidateScoreInput } from '../minter/score.js'
import { appendActivity, readActivity } from '../dashboard/activityLog.js'
import { collectSnapshot, writeSnapshot, readSnapshot, type SnapshotBudget } from '../dashboard/snapshot.js'
import { earnSummary, formatEarnStatus, writeEarnStatus, selectOurPods, type OwnPodVote } from '../dashboard/earnStatus.js'

/** Fetch a pod's external content for scoring context; '' on any failure (15s cap). */
export async function fetchPodContent(url: string): Promise<string> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) return ''
    return (await res.text()).slice(0, 4000) // cap tokens
  } catch {
    return ''
  } finally {
    clearTimeout(t)
  }
}

/** IO surface used by the cycle wiring — injectable so tests run without the CLI. */
export interface WiringIo {
  getRubric(id: string): Promise<DatanetRubric>
  listPods(id: string, opts: { all: boolean }): Promise<VoterPod[]>
  emissionsDue(): Promise<{ pods: ClaimableEmission[] }>
  fetchContent(url: string): Promise<string>
}

const defaultIo: WiringIo = {
  getRubric: (id) => getDatanetRubric(id),
  listPods: (id, opts) => listPodsJson(id, opts),
  emissionsDue: () => queryEmissionsDueJson(),
  fetchContent: (url) => fetchPodContent(url),
}

export interface CycleWiring {
  dataDir: string
  config: StrategyConfig
  scorer: PodScorer
  ledger: BudgetLedger
  executor: WalletExecutor
  dedup: DedupState
  adapters: DatanetAdapter[]
  strategyBrief: string
  io?: Partial<WiringIo>
}

/** Build the CycleDeps that runCycle consumes. Everything stateful (dedup, ledger)
 *  is threaded explicitly; everything IO is injectable for tests. */
export function buildCycleDeps(w: CycleWiring): CycleDeps {
  const io: WiringIo = { ...defaultIo, ...w.io }
  const strategyFor = (id: string): Record<string, unknown> => {
    const p = (w.config.datanets[id] as { adapterParams?: Record<string, unknown> }).adapterParams ?? {}
    return { brief: w.strategyBrief, ...p }
  }
  return {
    dataDir: w.dataDir,
    topN: 12,
    getRubric: (id) => io.getRubric(id),
    getPodsAndFilter: async (id) => {
      const pods = await io.listPods(id, { all: true })
      const own = await io.listPods(id, { all: false })
        .then((p) => p.map((x) => x.podId))
        .catch((e) => {
          console.error(`orquestra: own-pods read failed for datanet ${id} — own-pod vote guard disabled this cycle: ${(e as Error).message}`)
          return [] as string[]
        })
      const currentEpoch = deriveCurrentEpoch(pods)
      const voted = w.dedup.getVotedPodIds(id)
      const ownSet = new Set(own), votedSet = new Set(voted)
      // Enrich ONLY pods we might actually vote on (current epoch, not ours, not
      // voted) — content fetches are the slow part of a cycle.
      for (const p of pods) {
        const eligible = (currentEpoch === null || p.validityEpoch === currentEpoch) && !ownSet.has(p.podId) && !votedSet.has(p.podId)
        if (eligible && p.url) { const c = await io.fetchContent(p.url); if (c) p.description = `${p.name}\n\n${c}` }
      }
      return { pods, filter: { currentEpoch, ownPodIds: own, votedPodIds: voted } }
    },
    getAdapter: (id) => w.adapters.find((a) => a.id === id),
    voteScorer: w.scorer,
    candidateScorer: {
      scoreCandidate: (c, r) => {
        // Score the DATASET against the publisher spec, not just the summary line —
        // otherwise every candidate scores low ("no trade detail / no verification")
        // and nothing ever mints. See src/minter/score.ts.
        const { name, description } = candidateScoreInput(c)
        return w.scorer.scorePod({ podId: c.canonicalKey, validityEpoch: '', name, description }, r)
      },
    },
    seenKeysFor: async (id) => new Set(w.dedup.getMintedKeys(id)),
    executor: w.executor,
    ledger: w.ledger,
    recordVote: (id, podId) => w.dedup.recordVote(id, podId),
    recordMint: (id, key) => w.dedup.recordMint(id, key),
    getEmissionsDue: async () => (await io.emissionsDue()).pods,
    seenClaims: async () => new Set(w.dedup.getClaimedKeys()),
    recordActivity: (entry) => {
      try { appendActivity(w.dataDir, entry) } catch (e) { console.error(`orquestra: activity append failed (non-fatal): ${(e as Error).message}`) }
    },
    recordClaim: (key) => w.dedup.recordClaim(key),
    strategyFor,
    getExistingPodNames: async (id) => (await io.listPods(id, { all: true }).catch(() => [])).map((p) => p.name).filter(Boolean),
    grantedSubnets: async () => new Set(w.dedup.getGrantedSubnets()),
    recordGrant: (id) => w.dedup.recordGrant(id),
    revokeGrant: (id) => w.dedup.removeGrant(id),
  }
}

/** Build the scheduler tick: run a cycle, then best-effort snapshot + earn-status
 *  for the dashboard. Reporting failures never abort the loop. */
export function buildTick(w: CycleWiring, deps: CycleDeps): () => Promise<void> {
  return async () => {
    const cycleId = new Date().toISOString()
    const report: CycleReport = await runCycle(w.config, cycleId, deps)
    const v = report.datanets.reduce((a, r) => a + r.votes.length, 0)
    const m = report.datanets.reduce((a, r) => a + r.mints.length, 0)
    console.error(`orquestra: cycle ${cycleId} — ${v} votes, ${m} mints, ${report.claims.length} claims executed`)

    // Snapshot the on-chain view for the dashboard (best-effort; never throws into the loop).
    try {
      const budget: SnapshotBudget = {
        mintReppoSpent: w.ledger.state.mintReppoSpent,
        mintGasSpentEth: w.ledger.state.mintGasSpentEth,
        voteGasSpentEth: w.ledger.state.voteGasSpentEth,
        claimGasSpentEth: w.ledger.state.claimGasSpentEth,
        grantReppoSpent: w.ledger.state.grantReppoSpent,
        caps: w.config.budget,
      }
      const snap = await collectSnapshot(w.dataDir, cycleId, {
        balance: () => queryBalanceJson(),
        votingPower: () => queryVotingPowerJson(),
        emissionsDue: () => queryEmissionsDueJson(),
        epoch: () => queryEpochJson(),
        budget: () => budget,
      })
      writeSnapshot(w.dataDir, snap)
    } catch (e) {
      console.error(`orquestra: snapshot write failed (non-fatal): ${(e as Error).message}`)
    }

    // Earn-test report each cycle (the G1 signal — does minting actually pay?). Reuse the
    // snapshot's emissions-due, add our pods' on-chain vote tallies (the leading signal),
    // log it, and persist earn-status.json for the dashboard (/api/earn). Best-effort.
    try {
      const snap = readSnapshot(w.dataDir)
      const activity = readActivity(w.dataDir, { limit: 100_000 })
      const mintDatanets = Object.entries(w.config.datanets).filter(([k, d]) => k !== '*' && d.mint).map(([k]) => k)
      // On-chain `creator` is empty on our pods, so identify ours by the mint names we
      // recorded, matched against the full datanet pod list.
      const ourNames = activity
        .filter((e) => e.kind === 'mint' && e.status === 'executed' && e.cycleId !== 'backfill' && e.podName)
        .map((e) => e.podName as string)
      const votes: OwnPodVote[] = []
      for (const id of mintDatanets) {
        try { votes.push(...selectOurPods(await queryDatanetPodVotes(id), ourNames)) } catch (e) { console.error(`orquestra: earn pod-votes query failed for datanet ${id}: ${(e as Error).message}`) }
      }
      const summary = earnSummary(activity, snap?.emissionsDue ?? { totalReppo: 0, pods: [] }, votes)
      writeEarnStatus(w.dataDir, { ...summary, ts: new Date().toISOString() })
      console.error(formatEarnStatus(summary))
    } catch (e) {
      console.error(`orquestra: earn-status update failed (non-fatal): ${(e as Error).message}`)
    }
  }
}
