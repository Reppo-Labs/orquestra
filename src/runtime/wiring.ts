// src/runtime/wiring.ts
// Composition factories extracted from index.ts so the wiring that decides what
// gets signed (dedup closures, pod enrichment, adapter routing) is unit-testable.
// index.ts stays a thin shell: env, service construction, argv dispatch, signals.
import type { LanguageModel } from 'ai'
import type { StrategyConfig } from '../config/schema.js'
import type { CycleDeps, CycleReport } from './cycle.js'
import type { CandidateScorer, DatanetAdapter } from '../adapter/types.js'
import type { VoterPod, PodScorer } from '../voter/types.js'
import type { DatanetRubric } from '../rubric/types.js'
import { createLlmScorer, type ScorerModelCtx } from '../voter/score.js'
import { createPanelPodScorer, createPanelCandidateScorer } from '../panel/scorers.js'
import { resolveScoringModel, type ModelResolver } from '../llm/resolveScoringModel.js'
import { effectiveDefault } from '../llm/effectiveDefault.js'
import { resolveModel } from '../llm/model.js'
import { detectContentType, isVideoType, isGenericBinaryType } from '../llm/contentType.js'
import { resolveDriveUrl } from '../llm/driveResolve.js'
import type { LlmProvider } from '../llm/model.js'
import type { BudgetLedger } from '../wallet/ledger.js'
import type { WalletExecutor } from '../wallet/executor.js'
import type { DedupState } from './state.js'
import type { ClaimableEmission, ClaimToken } from '../reppo/queryEmissionsDue.js'
import { runCycle } from './cycle.js'
import { getDatanetRubric } from '../rubric/load.js'
import { listPodsJson, deriveCurrentEpoch } from '../reppo/listPods.js'
import { queryEmissionsDueJson } from '../reppo/queryEmissionsDue.js'
import { readTokenBalance } from '../reppo/tokenBalance.js'
import { queryClaimableOnchain, queryVoterClaimableOnchain } from '../reppo/emissionsOnchain.js'
import { makeDbPodCache, makeVoterScanCache } from '../reppo/podCacheStore.js'
import { queryBalanceJson } from '../reppo/queryBalance.js'
import { queryVotingPowerJson } from '../reppo/queryVotingPower.js'
import { queryEpochJson } from '../reppo/queryEpoch.js'
import { queryDatanetPodVotes } from '../reppo/queryOwnPods.js'
import { candidateScoreInput } from '../minter/score.js'
import { appendActivity, readActivity } from '../dashboard/activityLog.js'
import { collectSnapshot, writeSnapshot, readSnapshot, attachSnapshotLlm, type SnapshotBudget } from '../dashboard/snapshot.js'
import { resetLlmUsage, snapshotLlmUsage } from '../llm/usage.js'
import { earnSummary, formatEarnStatus, writeEarnStatus, selectOurPods, type OwnPodVote } from '../dashboard/earnStatus.js'
import { collectOutcomes } from '../learn/collect.js'
import { runReflection } from '../learn/reflect.js'
import { buildLessonsBlock } from '../learn/inject.js'
import { getLearnEnabled } from '../learn/store.js'
import { discoverDatanets } from '../learn/discoverDatanets.js'
import { listDatanetsJson } from '../reppo/listDatanets.js'
import { getSubnetEmissionInfo, formatTokenAmount } from '../reppo/subnetManager.js'
import { registerVoteOnPlatform } from '../reppo/platformApi.js'

/** Bound a promise so a hung reflection/collection can't stall the next cycle. The
 *  underlying work may continue in the background; we only stop waiting on it. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

/** Fetch a pod's external content for scoring context; '' on any failure (15s cap).
 *  Defense at the boundary: if the response is a video (or otherwise non-text/binary)
 *  Content-Type, return '' instead of slicing raw bytes into a text description. This
 *  closes the case where HEAD detection returned null (no Content-Type on HEAD) but the
 *  GET reveals a video — without this, binary would be scored as junk text. */
export async function fetchPodContent(url: string): Promise<string> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) return ''
    const ct = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (isVideoType(ct) || (ct && !isTextLike(ct))) return '' // never slice binary into text
    return (await res.text()).slice(0, 4000) // cap tokens
  } catch {
    return ''
  } finally {
    clearTimeout(t)
  }
}

/** True for Content-Types we can safely read as text for scoring context: text/*, and the
 *  common structured-text application types (JSON, XML, CSV, NDJSON, JS, etc.). An empty
 *  Content-Type is treated permissively by the caller (legacy behavior). */
function isTextLike(mediaType: string): boolean {
  if (mediaType.startsWith('text/')) return true
  return /^application\/(json|xml|.*\+json|.*\+xml|x-ndjson|jsonl|csv|javascript|x-yaml|yaml)$/.test(mediaType)
}

/** IO surface used by the cycle wiring — injectable so tests run without the CLI. */
export interface WiringIo {
  getRubric(id: string): Promise<DatanetRubric>
  listPods(id: string, opts: { all: boolean }): Promise<VoterPod[]>
  emissionsDue(): Promise<{ pods: ClaimableEmission[] }>
  fetchContent(url: string): Promise<string>
  /** Probe a pod URL's Content-Type so a video pod routes to the video path. */
  detectType(url: string): Promise<{ mediaType: string; contentLength: number | null } | null>
}

const defaultIo: WiringIo = {
  getRubric: (id) => getDatanetRubric(id),
  listPods: (id, opts) => listPodsJson(id, opts),
  emissionsDue: () => queryEmissionsDueJson(),
  fetchContent: (url) => fetchPodContent(url),
  detectType: (url) => detectContentType(url),
}

export interface CycleWiring {
  dataDir: string
  config: StrategyConfig
  /** Startup env-default model. NO LONGER used by the mint screen scorer / deliberation panel /
   *  reflection — those now resolve the LIVE node default (config.defaultModel, hot-reloaded) via
   *  effectiveDefaultModel(). Kept because index.ts still threads it to the adapters, which stay
   *  on the env default for now (out of scope). */
  model: LanguageModel
  /** provider → apiKey, built once at startup from env (src/llm/registry.ts). The
   *  per-datanet scorer resolves a model from this; an absent key for a datanet's
   *  chosen provider → that datanet's vote is skipped with a recorded reason. */
  providerKeyRegistry: Map<LlmProvider, string>
  /** Model resolver seam. Defaults to the plain resolveModel; index.ts injects an
   *  oauth-aware resolver so `anthropic-oauth` (subscription) resolves with a fresh
   *  Bearer token instead of an env key. */
  resolveModel?: ModelResolver
  /** Node default provider/model — used when a datanet has no `model` override. */
  defaultProvider: LlmProvider
  defaultModel: string
  /** Cost/latency cap: at most this many video pods are marked (and thus scored as
   *  video) per cycle. Over the cap, extra video pods are left unmarked and fall
   *  through unscored this cycle. Default 4. */
  videoPodsPerCycle?: number
  ledger: BudgetLedger
  executor: WalletExecutor
  dedup: DedupState
  adapters: DatanetAdapter[]
  /** On/off gate for self-learning reflection. When set, reflection runs on the LIVE node
   *  default (config.defaultModel, hot-reloaded) — NOT on this value; the field is now just a
   *  presence flag (in production: the startup model). Omitted in tests / when learning is wired
   *  off → reflection is skipped entirely. */
  learnModel?: LanguageModel
  /** Base RPC + our wallet address. When both are set, emissions to claim are detected
   *  ON-CHAIN (the platform `emissions-due` API under-reports); else fall back to the CLI. */
  rpcUrl?: string
  walletAddress?: string
  /** Whether the reppo CLI on PATH supports `grant-access --token primary` (>=0.8.5).
   *  Computed ONCE at startup (index.ts) from the CLI version; threaded to the cycle so a
   *  non-REPPO access fee is skipped (recorded) rather than fired on an older CLI. */
  supportsNonReppoGrants?: boolean
  io?: Partial<WiringIo>
}

/** The LIVE node-default model: dashboard-selected `config.defaultModel` when its provider is
 *  keyed, else the env default (`w.defaultProvider`/`w.defaultModel`). Read from w.config each
 *  call so a dashboard default change takes effect on the next cycle (hot-reload), mirroring the
 *  vote scorer + chat. null when even the effective default has no key — callers that can't
 *  proceed without a model (mint scorer, reflection) skip/throw, matching their existing
 *  no-model behavior. Keys are env-only (registry); never read from config. */
function effectiveDefaultModel(w: CycleWiring): LanguageModel | null {
  const eff = effectiveDefault({
    configDefault: w.config.defaultModel,
    registry: w.providerKeyRegistry,
    envProvider: w.defaultProvider,
    envModel: w.defaultModel,
  })
  return eff.key ? (w.resolveModel ?? resolveModel)(eff.provider, eff.key, eff.model) : null
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
  const getDeliberation = () => w.config.deliberation
  // Per-datanet vote scorer: resolve THIS datanet's model (its `model` override, else the
  // node default) against the env key registry, then wrap in the panel exactly as before.
  // A skip (no key for the chosen provider) is returned straight to the cycle, which
  // records it per-datanet. isVideo is false in Phase A (no video detection yet).
  //
  // Build-once cache: datanets sharing a resolved provider:model reuse one scorer
  // (per datanet per cycle was rebuilding it). Safe across hot-reload — the scorer reads
  // brief/deliberation/lessons live via getters (getLessons takes datanetId at call time),
  // so the cached object stays correct. Skips are not cached (cheap, no scorer built).
  const scorerCache = new Map<string, PodScorer>()
  const voteScorerFor = (datanetId: string): { scorer: PodScorer } | { skip: string } => {
    const policyModel = (w.config.datanets[datanetId] as { model?: { provider: LlmProvider; model: string } } | undefined)?.model
    // The node default is the dashboard-selected config.defaultModel when its provider is
    // keyed, else the env default (w.defaultProvider/w.defaultModel). Read live from w.config
    // (hot-reloaded each cycle), so a dashboard default change takes effect on the next cycle.
    const eff = effectiveDefault({
      configDefault: w.config.defaultModel,
      registry: w.providerKeyRegistry,
      envProvider: w.defaultProvider,
      envModel: w.defaultModel,
    })
    const resolved = resolveScoringModel({
      policyModel, isVideo: false,
      registry: w.providerKeyRegistry, defaultProvider: eff.provider, defaultModel: eff.model,
    }, w.resolveModel ?? resolveModel)
    if ('skip' in resolved) return { skip: resolved.skip }
    // Key by the effective provider:model (isVideo always false in Phase A): identical
    // resolutions yield an identical scorer, so one build serves every such datanet.
    const cacheKey = policyModel ? `${policyModel.provider}:${policyModel.model}` : `${eff.provider}:${eff.model}`
    let scorer = scorerCache.get(cacheKey)
    if (!scorer) {
      // modelCtx lets the screen scorer RE-RESOLVE to a Gemini model for a video pod (a
      // video pod can't be scored on this datanet's text model). policyModel is fixed per
      // cacheKey, so binding it into the cached scorer is correct (datanets sharing a key
      // share an identical policyModel). Text pods ignore modelCtx and score on resolved.model.
      const modelCtx: ScorerModelCtx = {
        registry: w.providerKeyRegistry, defaultProvider: eff.provider, defaultModel: eff.model, policyModel,
        resolveModel: w.resolveModel ?? resolveModel,
      }
      const screen = createLlmScorer(resolved.model, { brief: liveBrief, modelCtx })
      scorer = createPanelPodScorer(screen, { model: resolved.model, getDeliberation, getBrief: liveBrief, getLessons: liveLessons })
      scorerCache.set(cacheKey, scorer)
    }
    return { scorer }
  }
  // Mint path is unchanged by per-datanet voting overrides (spec: override scopes to the
  // voting scorer only). Score the DATASET (not just the summary line) on the node default
  // model — otherwise every candidate scores low and nothing mints (src/minter/score.ts).
  // The model is the LIVE effective default (config.defaultModel, hot-reloaded), resolved at
  // scoreCandidate-call time — NOT captured at startup. A missing key (eff.key === '') THROWS,
  // which selectMints catches per-candidate and records as a skip (parity with a scoring
  // failure); it never aborts the datanet's mint batch. The screen scorer + panel are rebuilt
  // per call against the live model — cheap (no SDK round-trip until scorePod/runPanel runs),
  // and necessary because both capture `model` at construction.
  const candidateScorer: CandidateScorer = {
    scoreCandidate: (cand, rub) => {
      const model = effectiveDefaultModel(w)
      if (!model) throw new Error('no API key for the node default provider — mint candidate not scored')
      const mintScreenScorer = createLlmScorer(model, { brief: liveBrief })
      const candidateBase: CandidateScorer = {
        scoreCandidate: (c, r) => {
          const { name, description } = candidateScoreInput(c)
          return mintScreenScorer.scorePod({ podId: c.canonicalKey, validityEpoch: '', name, description }, r)
        },
      }
      const panel = createPanelCandidateScorer(candidateBase, { model, getDeliberation, getBrief: liveBrief, getLessons: liveLessons })
      return panel.scoreCandidate(cand, rub)
    },
  }
  // Per-CYCLE video budget (not per-datanet). getPodsAndFilter runs once per datanet, so a
  // local counter there would let `videoPodsPerCycle × datanets` videos through. Hold the
  // remaining budget in this closure and reset it once per cycle via resetVideoBudget
  // (runCycle calls it right after startCycle). Decremented as videos are marked across all
  // datanets in the cycle.
  const videoCap = w.videoPodsPerCycle ?? 4
  let videoBudget = videoCap

  // Attach the NON-REPPO emission token to claimable (pod,epoch)s so the executor can read the
  // claimed native amount from the tx receipt. The on-chain claim scanners return datanetId='' and
  // no token; we resolve pod→datanet from our own vote/mint activity and datanet→token from the
  // catalog. Best-effort + only when there ARE claims (avoids a per-cycle CLI call when idle).
  const enrichTokens = async (due: ClaimableEmission[]): Promise<ClaimableEmission[]> => {
    if (due.length === 0) return due
    const podDatanet = new Map<string, string>()
    for (const e of readActivity(w.dataDir, { limit: 100_000 })) {
      if ((e.kind === 'vote' || e.kind === 'mint') && e.podId && e.datanetId) podDatanet.set(e.podId, e.datanetId)
    }
    const tokenByDatanet = new Map<string, ClaimToken>()
    try {
      for (const d of await listDatanetsJson()) if (d.nativeToken) tokenByDatanet.set(d.id, d.nativeToken)
    } catch { /* best-effort: skip token enrichment this cycle (claims still record REPPO) */ }
    return due.map((em) => {
      const datanetId = em.datanetId || podDatanet.get(em.podId) || ''
      return { ...em, datanetId, token: tokenByDatanet.get(datanetId) }
    })
  }

  return {
    dataDir: w.dataDir,
    topN: 12,
    resetVideoBudget: () => { videoBudget = videoCap },
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
      // Enrich ONLY pods we might actually vote on (current epoch, not ours, not voted)
      // — content fetches are the slow part of a cycle. For each, probe Content-Type:
      // a video/* pod is marked (mediaUrl/mediaType/contentLength) for the Gemini video
      // path instead of text-fetched; a per-CYCLE cap (videoBudget, shared across datanets)
      // bounds how many videos we score. A DETECTED video is NEVER text-fetched — under the
      // cap it is marked; over the cap it is left unmarked and skipped (continue) this cycle.
      for (const p of pods) {
        const eligible = (currentEpoch === null || p.validityEpoch === currentEpoch) && !ownSet.has(p.podId) && !votedSet.has(p.podId)
        if (!eligible || !p.url) continue
        // A Google Drive viewer/share link (drive.google.com/file/d/<ID>/view) serves an
        // HTML shell, not bytes — detectType would see text/html and the pod would be
        // text-fetched (model scores the page chrome, not the video). Rewrite it to a
        // direct-download URL FIRST so the probe sees video/* and ingestVideo can fetch it.
        // Non-Drive URLs pass through unchanged.
        const mediaSrc = resolveDriveUrl(p.url)
        const resolvedFromDrive = mediaSrc !== p.url
        let info: { mediaType: string; contentLength: number | null } | null = null
        try { info = await io.detectType(mediaSrc) } catch { info = null }
        // video/* routes to the Gemini path. A Drive-resolved URL whose download endpoint
        // reports a generic binary type (application/octet-stream — common for Drive file
        // downloads) is also treated as the clip: we only rewrite Drive links, and a binary
        // body on a video datanet IS the video. Gemini needs a concrete video mime to ingest,
        // so a coerced type defaults to video/mp4 when detection didn't give a video/* type.
        const isVideo = info && (isVideoType(info.mediaType) || (resolvedFromDrive && isGenericBinaryType(info.mediaType)))
        if (info && isVideo) {
          // A detected video MUST NOT be text-fetched (binary sliced into description = junk
          // votes), whether or not it fits the cap. Under the cap → mark for the video path;
          // over the cap → leave unmarked and skip it entirely this cycle (retried next cycle).
          if (videoBudget > 0) {
            p.mediaUrl = mediaSrc
            p.mediaType = isVideoType(info.mediaType) ? info.mediaType : 'video/mp4'
            if (info.contentLength !== null) p.contentLength = info.contentLength
            videoBudget--
          }
          continue
        }
        const c = await io.fetchContent(p.url)
        if (c) p.description = `${p.name}\n\n${c}`
      }
      return { pods, filter: { currentEpoch, ownPodIds: [...ownSet], votedPodIds: voted } }
    },
    getAdapter: (id) => w.adapters.find((a) => a.id === id),
    voteScorerFor,
    candidateScorer,
    seenKeysFor: async (id) => new Set(w.dedup.getMintedKeys(id)),
    // Live veREPPO for the per-cycle stake top-up — same balance query setupNode/snapshot use.
    // null on a failed read (NOT 0): maybeTopUpStake skips this cycle's top-up rather than
    // treating a read miss as zero veREPPO, which would lock the FULL target on top of whatever
    // the wallet already holds (over-lock). The top-up retries next cycle.
    getVeReppo: async () => (await queryBalanceJson().catch(() => null))?.veReppo ?? null,
    executor: w.executor,
    ledger: w.ledger,
    recordVote: (id, podId) => w.dedup.recordVote(id, podId),
    // Cred check deferred to call time so late-arriving or rotated creds take effect
    // without restarting the node (env vars set from SQLite at startup but re-read here).
    registerVoteOnPlatform: (podId: string, txHash: string): Promise<void> => {
      const agentId = process.env.REPPO_AGENT_ID
      const apiKey = process.env.REPPO_API_KEY
      if (!agentId || !apiKey) return Promise.resolve()
      return registerVoteOnPlatform(agentId, podId, txHash, apiKey).then(() => {})
    },
    recordMint: (id, key) => w.dedup.recordMint(id, key),
    // Claim source: detect claimable (pod,epoch) ON-CHAIN when RPC + wallet are known
    // (the platform `emissions-due` API under-reports — it hid 20 claimable pairs). The
    // CLI path is the fallback when no RPC is configured. A throw is tolerated by the
    // cycle's claim phase (it skips claiming that cycle).
    getEmissionsDue: async () => enrichTokens((w.rpcUrl && w.walletAddress)
      ? await queryClaimableOnchain(w.rpcUrl, w.walletAddress, makeDbPodCache(w.dataDir))
      : (await io.emissionsDue()).pods),
    // Voter emissions: claimable on pods the wallet VOTED on (not owned). The pod set comes
    // from our executed-vote activity (the wallet doesn't own them, so they're absent from the
    // owner Transfer-log cache); claimable (pod,epoch) is then detected on-chain. RPC-only —
    // no platform-API fallback exists for voter claims.
    getVoterEmissionsDue: async () => {
      if (!w.rpcUrl || !w.walletAddress) return []
      const votedPodIds = [...new Set(
        readActivity(w.dataDir, { limit: 100_000 })
          .filter((e) => e.kind === 'vote' && e.status === 'executed' && e.podId)
          .map((e) => e.podId as string),
      )]
      // Floor the voter scan at REPPO_EMISSIONS_FLOOR_EPOCH (the epoch the node first existed)
      // so a first-run deep scan doesn't crawl from epoch 1 and storm the RPC. The active-epoch
      // gate inside bounds it further to epochs the wallet actually voted in.
      const floorRaw = Number(process.env.REPPO_EMISSIONS_FLOOR_EPOCH)
      const floorEpoch = Number.isFinite(floorRaw) && floorRaw > 0 ? floorRaw : undefined
      // Voter emissions always pay REPPO — do NOT enrich with nativeToken (that field
      // describes publisher/mint emissions only). Enriching here causes readClaimedToken
      // to hunt for a non-REPPO transfer that never lands and records claimedTokenAmount=0.
      return queryVoterClaimableOnchain(w.rpcUrl, w.walletAddress, votedPodIds, makeVoterScanCache(w.dataDir), { floorEpoch })
    },
    seenClaims: async () => new Set(w.dedup.getClaimedKeys()),
    recordActivity: (entry) => {
      try { appendActivity(w.dataDir, entry) } catch (e) { console.error(`orquestra: activity append failed (non-fatal): ${(e as Error).message}`) }
    },
    recordClaim: (key) => w.dedup.recordClaim(key),
    strategyFor,
    getExistingPodNames: async (id) => {
      const pods = await io.listPods(id, { all: true }).catch(() => [] as VoterPod[])
      const currentEpoch = deriveCurrentEpoch(pods)
      // Current-epoch pods are the most likely semantic duplicates of new candidates;
      // sort them first, then cap to avoid flooding the LLM judge with stale history.
      const MAX_EXISTING = 50
      const sorted = currentEpoch === null ? pods : [
        ...pods.filter((p) => p.validityEpoch === currentEpoch),
        ...pods.filter((p) => p.validityEpoch !== currentEpoch),
      ]
      return sorted.slice(0, MAX_EXISTING).map((p) => p.name).filter(Boolean)
    },
    grantedSubnets: async () => new Set(w.dedup.getGrantedSubnets()),
    recordGrant: (id) => w.dedup.recordGrant(id),
    revokeGrant: (id) => w.dedup.removeGrant(id),
    supportsNonReppoGrants: w.supportsNonReppoGrants ?? false,
    // Wallet ERC20 balance reader for the NON-REPPO access-fee pre-check (cycle.ts). Wired
    // ONLY when both an RPC URL and the wallet address are known — same RPC the CLI uses.
    // When omitted (no RPC), the cycle skips the pre-check and lets the CLI fail closed.
    ...(w.rpcUrl && w.walletAddress
      ? {
          walletAddress: w.walletAddress,
          readTokenBalance: (token: string, owner: string) => readTokenBalance(w.rpcUrl as string, token, owner),
        }
      : {}),
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
    // Zero the LLM usage window so the snapshot below reports THIS cycle's spend
    // (operators asked for per-cycle LLM cost — panel scoring multiplies calls per pod).
    resetLlmUsage()
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
      // Per-cycle LLM spend (tokens + est USD) — reset above, accumulated by the
      // withUsageTracking middleware on every resolved model during the cycle.
      snap.llm = snapshotLlmUsage()
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
      // a slow reflection can never stall the next cycle. `w.learnModel` is the on/off gate
      // (omitted in tests / when learning is wired off); the model reflection actually runs on
      // is the LIVE node default (config.defaultModel, hot-reloaded) resolved here — not the
      // startup model. If the live default has no key, skip this epoch's reflection (same as
      // having no learnModel) rather than reflect on a stale/unkeyed model.
      const learnModel = w.learnModel ? effectiveDefaultModel(w) : null
      if (currentEpoch > 0 && currentEpoch > lastReflectedEpoch) {
        // Datanet discovery: propose vote_enable for any active datanet with emissions
        // that isn't yet vote-enabled. No LLM needed — runs regardless of learnModel.
        try {
          const allDatanets = await listDatanetsJson()
          // When RPC is wired, resolve each non-REPPO datanet's per-epoch native emission
          // amount from the SubnetManager so the proposal rationale shows magnitude (e.g.
          // "40,000 LBM/epoch"). Best-effort: a failed read falls back to a quantity-less desc.
          const rpcUrl = w.rpcUrl
          const resolveNativeEmissions = rpcUrl
            ? async (subnetId: string): Promise<number | null> => {
                const info = await getSubnetEmissionInfo(rpcUrl, subnetId)
                if (info.primaryEmissionsPerEpoch <= 0n) return null
                const dn = allDatanets.find((d) => d.id === subnetId)
                return formatTokenAmount(info.primaryEmissionsPerEpoch, dn?.nativeToken?.decimals ?? 18)
              }
            : undefined
          await discoverDatanets(w.dataDir, allDatanets, config, currentEpoch, resolveNativeEmissions)
        } catch (e) { console.error(`orquestra: datanet discovery failed (non-fatal): ${(e as Error).message}`) }

        if (learnModel) {
          const model = learnModel
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
        }
        lastReflectedEpoch = currentEpoch
      }
    } catch (e) {
      console.error(`orquestra: earn-status / learn update failed (non-fatal): ${(e as Error).message}`)
    }

    // Final LLM-usage attach: reflection (above) makes LLM calls AFTER the snapshot was
    // written — re-attach the full window to this cycle's row so those tokens aren't
    // wiped unreported by the next cycle's reset. Best-effort, never throws into the loop.
    try {
      attachSnapshotLlm(w.dataDir, cycleId, snapshotLlmUsage())
    } catch (e) {
      console.error(`orquestra: llm usage attach failed (non-fatal): ${(e as Error).message}`)
    }
  }
}
