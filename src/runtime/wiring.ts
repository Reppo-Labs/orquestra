// src/runtime/wiring.ts
// Composition factories extracted from index.ts so the wiring that decides what
// gets signed (dedup closures, pod enrichment, adapter routing) is unit-testable.
// index.ts stays a thin shell: env, service construction, argv dispatch, signals.
import type { LanguageModel } from 'ai'
import type { StrategyConfig } from '../config/schema.js'
import type { CycleDeps, CycleReport } from './cycle.js'
import type { CandidateScorer, DatanetAdapter } from '../adapter/types.js'
import type { VoterPod } from '../voter/types.js'
import type { DatanetRubric } from '../rubric/types.js'
import { createLlmScorer } from '../voter/score.js'
import { createPanelPodScorer, createPanelCandidateScorer } from '../panel/scorers.js'
import type { BudgetLedger } from '../wallet/ledger.js'
import type { WalletExecutor } from '../wallet/executor.js'
import type { DedupState } from './state.js'
import type { ClaimableEmission } from '../reppo/queryEmissionsDue.js'
import { runCycle } from './cycle.js'
import { getDatanetRubric } from '../rubric/load.js'
import { listPodsJson, deriveCurrentEpoch } from '../reppo/listPods.js'
import { queryEmissionsDueJson } from '../reppo/queryEmissionsDue.js'
import { queryClaimableOnchain } from '../reppo/emissionsOnchain.js'
import { makeDbPodCache } from '../reppo/podCacheStore.js'
import { queryBalanceJson } from '../reppo/queryBalance.js'
import { queryVotingPowerJson } from '../reppo/queryVotingPower.js'
import { queryEpochJson } from '../reppo/queryEpoch.js'
import { queryDatanetPodVotes } from '../reppo/queryOwnPods.js'
import { candidateScoreInput } from '../minter/score.js'
import { appendActivity, readActivity } from '../dashboard/activityLog.js'
import { collectSnapshot, writeSnapshot, readSnapshot, type SnapshotBudget } from '../dashboard/snapshot.js'
import { earnSummary, formatEarnStatus, writeEarnStatus, selectOurPods, type OwnPodVote } from '../dashboard/earnStatus.js'
import { collectOutcomes } from '../learn/collect.js'
import { runReflection } from '../learn/reflect.js'
import { buildLessonsBlock } from '../learn/inject.js'
import { getLearnEnabled } from '../learn/store.js'

/** Bound a promise so a hung reflection/collection can't stall the next cycle. The
 *  underlying work may continue in the background; we only stop waiting on it. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

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
  /** model the screen scorer + deliberation panel run on. */
  model: LanguageModel
  ledger: BudgetLedger
  executor: WalletExecutor
  dedup: DedupState
  adapters: DatanetAdapter[]
  /** Model the self-learning reflection runs on (same model as `model` in production).
   *  Omitted in tests → reflection is skipped entirely. */
  learnModel?: LanguageModel
  /** Base RPC + our wallet address. When both are set, emissions to claim are detected
   *  ON-CHAIN (the platform `emissions-due` API under-reports); else fall back to the CLI. */
  rpcUrl?: string
  walletAddress?: string
  io?: Partial<WiringIo>
}

/** Build the CycleDeps that runCycle consumes. Everything stateful (dedup, ledger)
 *  is threaded explicitly; everything IO is injectable for tests. */
export function buildCycleDeps(w: CycleWiring): CycleDeps {
  const io: WiringIo = { ...defaultIo, ...w.io }
  // The operator brief is config.notes, read live so dashboard edits hot-reload
  // (buildTick swaps w.config each cycle). Used by the screen scorer, the panel
  // judge, and the adapters.
  const liveBrief = (): string => w.config.notes
  const strategyFor = (id: string): Record<string, unknown> => {
    const p = (w.config.datanets[id] as { adapterParams?: Record<string, unknown> } | undefined)?.adapterParams ?? {}
    return { brief: liveBrief(), ...p }
  }
  // Per-datanet learned-lessons block for the judge, read live from the DB so a new
  // reflection or an operator veto/disable takes effect on the next decision.
  const liveLessons = (id: string): string => {
    try { return buildLessonsBlock(w.dataDir, id) } catch { return '' }
  }

  // Screen scorer + panel decorators are built ONCE. They read the brief and the
  // deliberation settings live (via getters / liveBrief) so a hot-reload of either
  // takes effect on the next decision without rebuilding anything.
  const screenScorer = createLlmScorer(w.model, { brief: liveBrief })
  const getDeliberation = () => w.config.deliberation
  const voteScorer = createPanelPodScorer(screenScorer, { model: w.model, getDeliberation, getBrief: liveBrief, getLessons: liveLessons })
  // Mint base scorer: score the DATASET against the publisher spec, not just the
  // summary line — otherwise every candidate scores low and nothing mints (see
  // src/minter/score.ts). The panel (when enabled) replaces this for mints.
  const candidateBase: CandidateScorer = {
    scoreCandidate: (cand, rub) => {
      const { name, description } = candidateScoreInput(cand)
      return screenScorer.scorePod({ podId: cand.canonicalKey, validityEpoch: '', name, description }, rub)
    },
  }
  const candidateScorer = createPanelCandidateScorer(candidateBase, { model: w.model, getDeliberation, getBrief: liveBrief, getLessons: liveLessons })
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
      // Name-based own-pod backstop: the platform's creator field is empty on our
      // pods, so the creator-based query above misses some — each miss wastes an
      // LLM scoring call and burns a one-time CANNOT_VOTE_FOR_OWN_POD error. Our
      // executed mints' names (the earn-attribution source) close the gap.
      const mintedNames = new Set(
        readActivity(w.dataDir, { limit: 100_000 })
          .filter((e) => e.kind === 'mint' && e.status === 'executed' && e.podName)
          .map((e) => e.podName as string),
      )
      for (const p of pods) if (p.name && mintedNames.has(p.name)) ownSet.add(p.podId)
      // Enrich ONLY pods we might actually vote on (current epoch, not ours, not
      // voted) — content fetches are the slow part of a cycle.
      for (const p of pods) {
        const eligible = (currentEpoch === null || p.validityEpoch === currentEpoch) && !ownSet.has(p.podId) && !votedSet.has(p.podId)
        if (eligible && p.url) { const c = await io.fetchContent(p.url); if (c) p.description = `${p.name}\n\n${c}` }
      }
      return { pods, filter: { currentEpoch, ownPodIds: [...ownSet], votedPodIds: voted } }
    },
    getAdapter: (id) => w.adapters.find((a) => a.id === id),
    voteScorer,
    candidateScorer,
    seenKeysFor: async (id) => new Set(w.dedup.getMintedKeys(id)),
    executor: w.executor,
    ledger: w.ledger,
    recordVote: (id, podId) => w.dedup.recordVote(id, podId),
    recordMint: (id, key) => w.dedup.recordMint(id, key),
    // Claim source: detect claimable (pod,epoch) ON-CHAIN when RPC + wallet are known
    // (the platform `emissions-due` API under-reports — it hid 20 claimable pairs). The
    // CLI path is the fallback when no RPC is configured. A throw is tolerated by the
    // cycle's claim phase (it skips claiming that cycle).
    getEmissionsDue: async () => (w.rpcUrl && w.walletAddress)
      ? queryClaimableOnchain(w.rpcUrl, w.walletAddress, makeDbPodCache(w.dataDir))
      : (await io.emissionsDue()).pods,
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

export interface TickOpts {
  /** Re-read the strategy config each tick (dashboard hot-reload). Throwing keeps
   *  the LAST-GOOD config — a bad save must not crash the loop. */
  reloadConfig?: () => StrategyConfig
  /** false skips the best-effort snapshot/earn reporting (tests). */
  reporting?: boolean
}

/** Build the scheduler tick: re-read config, run a cycle, then best-effort
 *  snapshot + earn-status for the dashboard. Reporting failures never abort the loop. */
export function buildTick(w: CycleWiring, deps: CycleDeps, opts: TickOpts = {}): () => Promise<void> {
  let config = w.config // last-good
  let lastReflectedEpoch = -1 // reflect at most once per epoch boundary (this process)
  const reflecting = new Set<string>() // datanets with an in-flight reflection (mutual exclusion)
  return async () => {
    if (opts.reloadConfig) {
      try {
        const fresh = opts.reloadConfig()
        if (JSON.stringify(fresh.budget) !== JSON.stringify(config.budget)) w.ledger.updateCaps(fresh.budget)
        if (fresh.horizonDays !== config.horizonDays) w.ledger.updateHorizonDays(fresh.horizonDays)
        config = fresh
        w.config = fresh // buildCycleDeps closures (strategyFor) read w.config at call time
      } catch (e) {
        console.error(`orquestra: config reload failed — keeping last-good config: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    const cycleId = new Date().toISOString()
    const report: CycleReport = await runCycle(config, cycleId, deps)
    const v = report.datanets.reduce((a, r) => a + r.votes.length, 0)
    const m = report.datanets.reduce((a, r) => a + r.mints.length, 0)
    console.error(`orquestra: cycle ${cycleId} — ${v} votes, ${m} mints, ${report.claims.length} claims executed`)
    if (opts.reporting === false) return

    // Snapshot the on-chain view for the dashboard (best-effort; never throws into the loop).
    try {
      const budget: SnapshotBudget = {
        mintReppoSpent: w.ledger.state.mintReppoSpent,
        mintGasSpentEth: w.ledger.state.mintGasSpentEth,
        voteGasSpentEth: w.ledger.state.voteGasSpentEth,
        claimGasSpentEth: w.ledger.state.claimGasSpentEth,
        caps: config.budget,
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
      // All datanets we vote OR mint on — the self-learning observe step covers votes
      // (cast on others' pods) too, not just our own mints.
      const learnDatanets = Object.entries(config.datanets).filter(([k, d]) => k !== '*' && (d.vote || d.mint)).map(([k]) => k)
      // On-chain `creator` is empty on our pods, so identify ours by the mint names we
      // recorded, matched against the full datanet pod list.
      const ourNames = activity
        .filter((e) => e.kind === 'mint' && e.status === 'executed' && e.cycleId !== 'backfill' && e.podName)
        .map((e) => e.podName as string)
      const currentEpoch = Number(snap?.epoch?.epoch ?? -1)
      const votes: OwnPodVote[] = []
      for (const id of learnDatanets) {
        let all: OwnPodVote[]
        try { all = await queryDatanetPodVotes(id) } catch (e) { console.error(`orquestra: pod-votes query failed for datanet ${id}: ${(e as Error).message}`); continue }
        if (config.datanets[id]?.mint) votes.push(...selectOurPods(all, ourNames)) // earn signal: our minted pods only
        // Observe step: match matured votes/mints to these tallies. Best-effort, and
        // reusing the array we just fetched — no extra CLI call. Skipped when learning is
        // disabled for the datanet (operator veto stops DB churn, not just injection) or
        // when the epoch is unknown (epoch query failed → placeholder 0; never matures).
        if (currentEpoch > 0 && getLearnEnabled(w.dataDir, id)) {
          try { collectOutcomes(w.dataDir, id, all, currentEpoch) } catch (e) { console.error(`orquestra: learn collect failed for ${id} (non-fatal): ${(e as Error).message}`) }
        }
      }
      const summary = earnSummary(activity, snap?.emissionsDue ?? { totalReppo: 0, pods: [] }, votes)
      writeEarnStatus(w.dataDir, { ...summary, ts: new Date().toISOString() })
      console.error(formatEarnStatus(summary))

      // Reflect once per epoch boundary: one LLM call per learn-datanet, gated again by
      // a cold-start sample floor inside runReflection. Best-effort + a hard timeout so
      // a slow reflection can never stall the next cycle. Skipped when no learnModel.
      if (currentEpoch > 0 && currentEpoch > lastReflectedEpoch && w.learnModel) {
        const model = w.learnModel
        for (const id of learnDatanets) {
          if (!getLearnEnabled(w.dataDir, id)) continue        // operator veto: no LLM spend
          if (reflecting.has(id)) continue                     // prior run still in flight — don't race the supersede
          reflecting.add(id)
          // .finally clears the guard when the REAL promise settles (not when withTimeout
          // gives up); the timeout only bounds how long we WAIT, so a slow reflection can't
          // stall the next cycle but also can't start a second concurrent run for this datanet.
          const run = runReflection(w.dataDir, model, id, config, currentEpoch).finally(() => reflecting.delete(id))
          try { await withTimeout(run, 60_000) }
          catch (e) { console.error(`orquestra: reflection failed for ${id} (non-fatal): ${(e as Error).message}`) }
        }
        lastReflectedEpoch = currentEpoch
      }
    } catch (e) {
      console.error(`orquestra: earn-status / learn update failed (non-fatal): ${(e as Error).message}`)
    }
  }
}
