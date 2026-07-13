// src/runtime/wiring.ts
// Composition factories extracted from index.ts so the wiring that decides what
// gets signed (dedup closures, pod enrichment, adapter routing) is unit-testable.
// index.ts stays a thin shell: env, service construction, argv dispatch, signals.
import type { LanguageModel } from 'ai'
import type { StrategyConfig } from '../config/schema.js'
import type { CycleDeps, CycleReport, OnchainReads } from './cycle.js'
import type { DatanetAdapter } from '../adapter/types.js'
import type { VoterPod } from '../voter/types.js'
import type { DatanetRubric } from '../rubric/types.js'
import { buildScorers, effectiveDefaultModel } from './scorers.js'
import type { ModelResolver } from '../llm/resolveScoringModel.js'
import { detectContentType, isVideoType, isGenericBinaryType } from '../llm/contentType.js'
import { resolveDriveUrl } from '../llm/driveResolve.js'
import type { LlmProvider } from '../llm/model.js'
import type { BudgetLedger } from '../wallet/ledger.js'
import type { WalletExecutor } from '../wallet/executor.js'
import type { DedupState } from './state.js'
// All reppo READS go through the facade seam — never the individual query files.
import {
  defaultReppoReader, deriveCurrentEpoch, formatTokenAmount,
  type ReppoReader, type ClaimableEmission, type ClaimToken, type EmissionsDue,
  type EpochInfo, type OwnPodVote,
} from '../reppo/reader.js'
import { runCycle } from './cycle.js'
import { getDatanetRubric } from '../rubric/load.js'
import { appendActivity, readActivity, type ActivityEntry } from '../dashboard/activityLog.js'
import { collectSnapshot, writeSnapshot, readSnapshot, attachSnapshotLlm, type SnapshotBudget } from '../dashboard/snapshot.js'
import { resetLlmUsage, snapshotLlmUsage } from '../llm/usage.js'
import { earnSummary, formatEarnStatus, writeEarnStatus, selectOurPods } from '../dashboard/earnStatus.js'
import { collectOutcomes } from '../learn/collect.js'
import { collectEconomics } from '../learn/econ.js'
import { runReflection } from '../learn/reflect.js'
import { getLearnEnabled } from '../learn/store.js'
import { discoverDatanets } from '../learn/discoverDatanets.js'
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

/** Rubric + HTTP-content surface used by the cycle wiring — injectable so tests run
 *  without the CLI or the network. Reppo reads live on the ReppoReader seam instead. */
export interface WiringIo {
  getRubric(id: string): Promise<DatanetRubric>
  fetchContent(url: string): Promise<string>
  /** Probe a pod URL's Content-Type so a video pod routes to the video path. */
  detectType(url: string): Promise<{ mediaType: string; contentLength: number | null } | null>
}

const defaultIo: WiringIo = {
  getRubric: (id) => getDatanetRubric(id),
  fetchContent: (url) => fetchPodContent(url),
  detectType: (url) => detectContentType(url),
}

export interface CycleWiring {
  dataDir: string
  config: StrategyConfig
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
  /** Reppo read facade. Defaults to the CLI/RPC-backed defaultReppoReader; tests
   *  inject a fake so no `reppo` process is ever spawned. */
  reader?: ReppoReader
}

/** Floor for the on-chain emissions scans: REPPO_EMISSIONS_FLOOR_EPOCH (the epoch the node
 *  first existed) bounds the first-run deep scan so it doesn't crawl from epoch 1 and storm
 *  the RPC. Read per call so a restart with a new value takes effect. */
function emissionsFloorEpoch(): number | undefined {
  const raw = Number(process.env.REPPO_EMISSIONS_FLOOR_EPOCH)
  return Number.isFinite(raw) && raw > 0 ? raw : undefined
}

/** Build the CycleDeps that runCycle consumes. Everything stateful (dedup, ledger)
 *  is threaded explicitly; everything IO is injectable for tests. */
export function buildCycleDeps(w: CycleWiring): CycleDeps {
  const io: WiringIo = { ...defaultIo, ...w.io }
  const reader = w.reader ?? defaultReppoReader
  // The operator brief is config.notes, read live so dashboard edits hot-reload
  // (buildTick swaps w.config each cycle). Used by the screen scorer, the panel
  // judge, and the adapters.
  const liveBrief = (): string => w.config.notes
  // Raw pass-through by design: each adapter parses/validates these params itself
  // (e.g. parseGdeltParams / parseSportsParams) so the typing lives at the adapter.
  const strategyFor = (id: string): Record<string, unknown> => {
    const p = w.config.datanets[id]?.adapterParams ?? {}
    return { brief: liveBrief(), ...p }
  }
  // LLM scoring collaborator — the scorer cache + model routing live in scorers.ts,
  // reading config live off `w` (hot-reload safe).
  const scorers = buildScorers(w)
  // Per-CYCLE video budget (not per-datanet). getPodsAndFilter runs once per datanet, so a
  // local counter there would let `videoPodsPerCycle × datanets` videos through. Hold the
  // remaining budget in this closure and reset it once per cycle via beginCycle
  // (runCycle calls it right after startCycle). Decremented as videos are marked across all
  // datanets in the cycle.
  const videoCap = w.videoPodsPerCycle ?? 4
  let videoBudget = videoCap

  // Per-CYCLE activity snapshot. The SQLite history (up to 100k rows, never rotated)
  // feeds several derived views: the own-mint pod-name backstop (previously re-read once
  // PER DATANET), the pod→datanet claim enrichment, and the voter-claim pod set. Reading
  // it inside each consumer reconstructed the whole table N_datanets+2 times per cycle —
  // the dominant per-cycle cost and memory churn. Read it lazily at most ONCE per cycle;
  // beginCycle (called by runCycle right after startCycle) invalidates it. Same query,
  // same data — consumers derive their views from the in-memory snapshot.
  let activitySnapshot: ActivityEntry[] | null = null
  const cycleActivity = (): ActivityEntry[] =>
    (activitySnapshot ??= readActivity(w.dataDir, { limit: 100_000 }))
  // Executed-mint pod names (the earn-attribution source), derived once per cycle from
  // the snapshot; consumed per datanet by getPodsAndFilter's own-pod name backstop.
  let mintedNamesMemo: Set<string> | null = null
  const mintedNames = (): Set<string> =>
    (mintedNamesMemo ??= new Set(
      cycleActivity()
        .filter((e) => e.kind === 'mint' && e.status === 'executed' && e.podName)
        .map((e) => e.podName as string),
    ))

  // Attach the NON-REPPO emission token to claimable (pod,epoch)s so the executor can read the
  // claimed native amount from the tx receipt. The on-chain claim scanners return datanetId='' and
  // no token; we resolve pod→datanet from our own vote/mint activity and datanet→token from the
  // catalog. Best-effort + only when there ARE claims (avoids a per-cycle CLI call when idle).
  const enrichTokens = async (due: ClaimableEmission[]): Promise<ClaimableEmission[]> => {
    if (due.length === 0) return due
    const podDatanet = new Map<string, string>()
    for (const e of cycleActivity()) {
      if ((e.kind === 'vote' || e.kind === 'mint') && e.podId && e.datanetId) podDatanet.set(e.podId, e.datanetId)
    }
    const tokenByDatanet = new Map<string, ClaimToken>()
    try {
      for (const d of await reader.listDatanets()) if (d.nativeToken) tokenByDatanet.set(d.id, d.nativeToken)
    } catch { /* best-effort: skip token enrichment this cycle (claims still record REPPO) */ }
    return due.map((em) => {
      const datanetId = em.datanetId || podDatanet.get(em.podId) || ''
      return { ...em, datanetId, token: tokenByDatanet.get(datanetId) }
    })
  }

  // On-chain reads are wired PRESENT-OR-ABSENT AS A UNIT — the RPC decision is made
  // ONCE here (not per field). The wallet-scoped tier (fee pre-check, voter emissions)
  // nests the same way: absent when the wallet address could not be derived at startup.
  const rpcUrl = w.rpcUrl
  const walletAddress = w.walletAddress
  const onchain: OnchainReads | undefined = rpcUrl
    ? {
        // Per-datanet emission-yield volume — read-only, needs RPC alone.
        getEpochVoteVolume: (podIds) => reader.epochVoteVolume(rpcUrl, podIds),
        ...(walletAddress
          ? {
              wallet: {
                address: walletAddress,
                readTokenBalance: (token: string, owner: string) => reader.tokenBalance(rpcUrl, token, owner),
                // Voter emissions: claimable on pods the wallet VOTED on (not owned). The pod
                // set comes from our executed-vote activity (the wallet doesn't own them, so
                // they're absent from the owner Transfer-log cache); claimable (pod,epoch) is
                // then detected on-chain. RPC-only — no platform-API fallback exists.
                getVoterEmissionsDue: async () => {
                  const votedPodIds = [...new Set(
                    cycleActivity() // per-cycle snapshot — no extra table scan for the claim phase
                      .filter((e) => e.kind === 'vote' && e.status === 'executed' && e.podId)
                      .map((e) => e.podId as string),
                  )]
                  // Voter emissions always pay REPPO — do NOT enrich with nativeToken (that field
                  // describes publisher/mint emissions only). Enriching here causes readClaimedToken
                  // to hunt for a non-REPPO transfer that never lands and records claimedTokenAmount=0.
                  return reader.voterClaimableOnchain(rpcUrl, walletAddress, votedPodIds, w.dataDir, { floorEpoch: emissionsFloorEpoch() })
                },
              },
            }
          : {}),
      }
    : undefined

  return {
    dataDir: w.dataDir,
    // Activity log + per-cycle arming + platform vote registration, as one collaborator.
    activity: {
      record: (entry) => {
        try { appendActivity(w.dataDir, entry) } catch (e) { console.error(`orquestra: activity append failed (non-fatal): ${(e as Error).message}`) }
      },
      beginCycle: () => { videoBudget = videoCap; activitySnapshot = null; mintedNamesMemo = null },
      // Cred check deferred to call time so late-arriving or rotated creds take effect
      // without restarting the node (env vars set from SQLite at startup but re-read here).
      registerVoteOnPlatform: (podId: string, txHash: string): Promise<void> => {
        const agentId = process.env.REPPO_AGENT_ID
        const apiKey = process.env.REPPO_API_KEY
        if (!agentId || !apiKey) return Promise.resolve()
        return registerVoteOnPlatform(agentId, podId, txHash, apiKey).then(() => {})
      },
    },
    reads: {
      getRubric: (id) => io.getRubric(id),
      getPodsAndFilter: async (id) => {
        const pods = await reader.listPods(id, { all: true })
        const own = await reader.listPods(id, { all: false })
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
        const minted = mintedNames() // per-cycle memo — was a full activity re-scan PER DATANET
        for (const p of pods) if (p.name && minted.has(p.name)) ownSet.add(p.podId)
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
          // The CLI now surfaces the pod's full writeup as `description` (reppo-cli >=0.12).
          // When we already have that real writeup (description differs from the bare title),
          // do NOT fetch the url — for SPA-backed datanets (e.g. ArAIstotle) a server-side
          // fetch returns the app-shell HTML, which would CLOBBER good content with junk and
          // produce bad votes. Only fetch to enrich when we have title-only (no writeup).
          if (p.description.trim() !== p.name.trim()) continue
          const c = await io.fetchContent(p.url)
          if (c) p.description = `${p.name}\n\n${c}`
        }
        return { pods, filter: { currentEpoch, ownPodIds: [...ownSet], votedPodIds: voted } }
      },
      // Live veREPPO for the per-cycle stake top-up — same balance query setupNode/snapshot use.
      // null on a failed read (NOT 0): maybeTopUpStake skips this cycle's top-up rather than
      // treating a read miss as zero veREPPO, which would lock the FULL target on top of whatever
      // the wallet already holds (over-lock). The top-up retries next cycle.
      getVeReppo: async () => (await reader.balance().catch(() => null))?.veReppo ?? null,
      // Claim source: detect claimable (pod,epoch) ON-CHAIN when RPC + wallet are known
      // (the platform `emissions-due` API under-reports — it hid 20 claimable pairs). The
      // CLI path is the fallback when no RPC is configured. A throw is tolerated by the
      // cycle's claim phase (it skips claiming that cycle). The owner-scan watermark makes
      // the first run backfill history from REPPO_EMISSIONS_FLOOR_EPOCH — without it, the
      // fixed 3-epoch window permanently hid older unclaimed emissions (operator report:
      // "claimed once, then only manual claims worked").
      getEmissionsDue: async () => enrichTokens((rpcUrl && walletAddress)
        ? await reader.claimableOnchain(rpcUrl, walletAddress, w.dataDir, { floorEpoch: emissionsFloorEpoch() })
        : (await reader.emissionsDue()).pods),
    },
    // Adapter routing + the per-datanet inputs the cycle threads into adapter.discover.
    adapters: {
      get: (id) => w.adapters.find((a) => a.id === id),
      topN: 12,
      strategyFor,
      existingPodNames: async (id) => {
        const pods = await reader.listPods(id, { all: true }).catch(() => [] as VoterPod[])
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
    },
    scorers,
    // Persistent dedup — thin views over DedupState (SQLite). Grants are always
    // supported in production wiring, so the grant cache is always present.
    dedup: {
      seenKeysFor: async (id) => new Set(w.dedup.getMintedKeys(id)),
      recordVote: (id, podId) => w.dedup.recordVote(id, podId),
      recordMint: (id, key) => w.dedup.recordMint(id, key),
      seenClaims: async () => new Set(w.dedup.getClaimedKeys()),
      recordClaim: (key) => w.dedup.recordClaim(key),
      grants: {
        granted: async () => new Set(w.dedup.getGrantedSubnets()),
        record: (id) => w.dedup.recordGrant(id),
        revoke: (id) => w.dedup.removeGrant(id),
      },
    },
    executor: w.executor,
    ledger: w.ledger,
    supportsNonReppoGrants: w.supportsNonReppoGrants ?? false,
    ...(onchain ? { onchain } : {}),
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
  const reader = w.reader ?? defaultReppoReader
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

    // The epoch is read ONCE per tick and shared by the snapshot and the econ collector.
    // collectSnapshot silently merges a FAILED epoch read over the PREVIOUS snapshot's
    // value with no failure flag — right for display, but the econ collector must never
    // bucket new activity into that stale epoch: a sustained RPC outage would pile every
    // cycle's mints/votes into one old (datanet, epoch) bucket, additively corrupting the
    // exact numbers reflection cites. epochLive is the ground truth for THIS tick;
    // undefined = the read failed → econ collection defers (the watermark holds).
    let epochLive: EpochInfo | undefined
    try { epochLive = await reader.epoch() } catch (e) {
      console.error(`orquestra: epoch query failed this tick (non-fatal): ${(e as Error).message}`)
    }

    // Snapshot the on-chain view for the dashboard (best-effort; never throws into the loop).
    try {
      const budget: SnapshotBudget = {
        mintReppoSpent: w.ledger.state.mintReppoSpent,
        mintGasSpentEth: w.ledger.state.mintGasSpentEth,
        voteGasSpentEth: w.ledger.state.voteGasSpentEth,
        claimGasSpentEth: w.ledger.state.claimGasSpentEth,
        caps: config.budget,
      }
      // Claimable for the dashboard: SAME on-chain detection the claim phase uses (when RPC +
      // wallet are known), so "claimable" reflects what the node will actually claim. The
      // platform CLI is the fallback only — it under-reports (returned 0 while pairs were
      // claimable on-chain), which left operators staring at "claimable: 0" with REPPO parked.
      // REUSE the claim phase's post-claim scan result (report.emissionsDue) instead of
      // re-scanning PodManager a second time this cycle — the scan is the expensive RPC path,
      // and a stuck claimable epoch pins its watermark, so a re-scan re-walks the whole tail.
      // When claiming is disabled the claim phase never scanned, so do the one scan here.
      const emissionsDueOnchain = async (): Promise<EmissionsDue> => {
        if (!w.rpcUrl || !w.walletAddress) return reader.emissionsDue()
        const pods = config.claimEmissions
          ? report.emissionsDue
          : await reader.claimableOnchain(w.rpcUrl, w.walletAddress, w.dataDir, { floorEpoch: emissionsFloorEpoch() })
        return { totalReppo: pods.reduce((s, p) => s + p.reppo, 0), pods }
      }
      const snap = await collectSnapshot(w.dataDir, cycleId, {
        balance: () => reader.balance(),
        votingPower: () => reader.votingPower(),
        emissionsDue: emissionsDueOnchain,
        // Throwing when the hoisted read failed preserves collectSnapshot's existing
        // merge-over-previous fallback exactly (its `safe()` catches and keeps prev.epoch).
        epoch: async () => { if (!epochLive) throw new Error('epoch read failed this tick'); return epochLive },
        budget: () => budget,
      })
      // Per-cycle LLM spend (tokens + est USD) — reset above, accumulated by the
      // withUsageTracking middleware on every resolved model during the cycle.
      snap.llm = snapshotLlmUsage()
      // Per-datanet economics: fresh each cycle from the report (see Snapshot doc).
      snap.datanetEconomics = report.datanetEconomics
      writeSnapshot(w.dataDir, snap)
    } catch (e) {
      console.error(`orquestra: snapshot write failed (non-fatal): ${(e as Error).message}`)
    }

    // Earn-test report each cycle (the G1 signal — does minting actually pay?). Reuse the
    // snapshot's emissions-due, add our pods' on-chain vote tallies (the leading signal),
    // log it, and persist earn-status.json for the dashboard (/api/earn). Best-effort.
    try {
      const snap = readSnapshot(w.dataDir)
      // Deliberately a FRESH read, not the deps' per-cycle snapshot: the earn attribution
      // below must include the rows THIS cycle just appended. This is one of only two
      // activity table scans per cycle (the other is the lazy snapshot in buildCycleDeps).
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
      // Own-pod ids per datanet, for the econ collector's owner-claim attribution below.
      // Scope is the SAME learnDatanets loop collectOutcomes already runs (vote- or mint-
      // enabled datanets) — this is the broadest own-pod data the cycle fetches; a datanet
      // neither voted nor minted on this cycle has no OwnPodVote[] in scope at all. Built for
      // EVERY learn-datanet (not just mint-enabled ones) so owner claims still attribute
      // after mint is turned off for a datanet whose pods are still earning emissions.
      const ownPodIdsByDatanet = new Map<string, Set<string>>()
      for (const id of learnDatanets) {
        let all: OwnPodVote[]
        try { all = await reader.datanetPodVotes(id) } catch (e) { console.error(`orquestra: pod-votes query failed for datanet ${id}: ${(e as Error).message}`); continue }
        const ours = selectOurPods(all, ourNames)
        ownPodIdsByDatanet.set(id, new Set(ours.map((p) => p.podId)))
        if (config.datanets[id]?.mint) votes.push(...ours) // earn signal: our minted pods only
        // Observe step: match matured votes/mints to these tallies. Best-effort, and
        // reusing the array we just fetched — no extra CLI call. Skipped when learning is
        // disabled for the datanet (operator veto stops DB churn, not just injection) or
        // when the epoch is unknown (epoch query failed → placeholder 0; never matures).
        if (currentEpoch > 0 && getLearnEnabled(w.dataDir, id)) {
          try { collectOutcomes(w.dataDir, id, all, currentEpoch) } catch (e) { console.error(`orquestra: learn collect failed for ${id} (non-fatal): ${(e as Error).message}`) }
        }
      }
      // Economics half of the learn loop — ONE call per cycle (not per datanet): buckets
      // this tick's newly-executed claim/mint/vote activity into per-(datanet, epoch) REPPO
      // totals. Uses epochLive (the tick's SINGLE queryEpochJson read, shared with the
      // snapshot) — NOT snap.epoch, which merges a failed read over the previous snapshot's
      // value and would bucket new activity into a stale epoch. Best-effort: a collector
      // failure must never abort the cycle or the rest of this learn block.
      if (epochLive) {
        try { collectEconomics(w.dataDir, ownPodIdsByDatanet, epochLive) }
        catch (e) { console.error(`orquestra: econ collect failed (non-fatal): ${(e as Error).message}`) }
      } else {
        // Deferred, not lost: the activity-id watermark holds, and mint/vote epochs are
        // ts-derived (econ.ts epochAt), so the next successful cycle attributes correctly.
        console.error('orquestra: epoch read failed — econ collection deferred (watermark holds)')
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
          const allDatanets = await reader.listDatanets()
          // When RPC is wired, resolve each non-REPPO datanet's per-epoch native emission
          // amount from the SubnetManager so the proposal rationale shows magnitude (e.g.
          // "40,000 LBM/epoch"). Best-effort: a failed read falls back to a quantity-less desc.
          const rpcUrl = w.rpcUrl
          const resolveNativeEmissions = rpcUrl
            ? async (subnetId: string): Promise<number | null> => {
                const info = await reader.subnetEmissionInfo(rpcUrl, subnetId)
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
