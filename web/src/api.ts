// Typed client for the dashboard server's JSON API (src/dashboard/server.ts).
// Shapes mirror what the endpoints actually emit. Writes are unauthenticated —
// the server binds localhost and exposure is the operator's responsibility.

export interface Pnl {
  netReppo: number
  earnedReppo: number
  claimedReppo: number
  claimableReppo: number
  /** still-unclaimed (pod,epoch) pairs — amounts unknown pre-claim under on-chain
   *  detection, so this can be > 0 while claimableReppo reads 0. Absent on older nodes. */
  claimablePairs?: number
  spentReppo: number
  gasSpentEth: number
}

export interface EpochInfo { epoch: string | number; secondsRemaining: number }

export interface BudgetCaps {
  voteGasEthMax?: number
  mintReppoMax?: number
  mintGasEthMax?: number
  claimGasEthMax?: number
}

export interface SnapshotBudget {
  voteGasSpentEth: number
  mintReppoSpent: number
  mintGasSpentEth: number
  claimGasSpentEth: number
  caps: BudgetCaps
}

export interface EmissionPod { podId: string; datanetId: string; epoch: string | number; reppo: number }

/** Per-datanet emission yield: REPPO emitted per unit of current-epoch vote weight.
 *  Mirrors src/voter/yield.ts exactly. */
export interface DatanetYield {
  datanetId: string
  emissionsPerEpochReppo: number
  epoch: number | null
  epochVoteVolume: number | null
  yieldPerVote: number | null
  uncontested: boolean
  nativeTokenSymbol?: string
  /** RPC error text when the epoch-volume read failed; absent = read OK or no RPC wired. */
  unavailableReason?: string
}

export interface LlmUsage {
  calls: number
  inputTokens: number
  outputTokens: number
  /** null = no priceable model this cycle (tokens still counted). */
  estCostUsd: number | null
  unpricedCalls: number
  byModel: Record<string, { calls: number; inputTokens: number; outputTokens: number; estCostUsd: number | null }>
}

export interface Snapshot {
  ts: string | number
  epoch?: EpochInfo | null
  balance: { reppo: number; veReppo: number }
  votingPower?: { power: number; lockupCount: number }
  budget?: SnapshotBudget
  emissionsDue: { pods: EmissionPod[] }
  /** per-cycle LLM usage + estimated cost; absent on pre-feature snapshots. */
  llm?: LlmUsage
  /** Fresh per cycle; absent on pre-feature snapshots. */
  datanetEconomics?: DatanetYield[]
}

export interface PanelTranscript {
  screenScore?: number
  panelists: { persona: string; score: number; argument: string }[]
  judge: { score: number; reason: string }
}

export interface ActivityRow {
  ts: string | number
  kind: 'vote' | 'mint' | 'claim' | 'skip' | 'grant' | 'stake' | 'info'
  datanetId?: string
  podId?: string
  canonicalKey?: string
  status?: string
  txHash?: string
  direction?: string
  conviction?: string | number
  reason?: string
  detail?: string
  podName?: string
  epoch?: string | number
  reppoClaimed?: number
  panel?: PanelTranscript
}

export interface HealthCounts { executed: number; refused: number; error: number }
export interface TxRate { rate: number | null; executed: number; failed: number }
export interface HealthDatanet {
  datanetId: string
  votes: HealthCounts
  mints: HealthCounts
  /** emission-claim outcomes; absent on older nodes. */
  claims?: HealthCounts
  txRate?: TxRate
  skips?: number
  topErrors: { code: string; count: number }[]
  idle?: boolean
  lastSkipReason?: string
}
export interface Health { datanets: HealthDatanet[]; txRate?: TxRate; entriesScanned?: number }

export interface Earn {
  earning: boolean
  mintedPods: number
  claimableReppo: number
  /** still-unclaimed (pod,epoch) pairs. Absent on older nodes. */
  claimablePairs?: number
  claimedReppo: number
  /** claimed NON-REPPO emission tokens (e.g. LBM), per symbol. Absent on older nodes. */
  claimedTokens?: { symbol: string; amount: number }[]
  totalUpVotes: number
  totalDownVotes: number
}

export interface DatanetEntry {
  vote: boolean
  mint: boolean
  strictness: string
  adapter?: string
  adapterParams?: Record<string, unknown>
  /** 'pin' (default) pins the dataset to IPFS (needs Pinata); 'url-only' registers
   *  the source URL with no pinning. */
  mintMode?: 'pin' | 'url-only'
  /** Per-datanet LLM override for the voting scorer (provider+model). Absent ⇒ node default. */
  model?: { provider: string; model: string }
  /** Relative weight for splitting this cycle's vote slots across vote-enabled datanets.
   *  Absent ⇒ node default of 1 (equal share). */
  voteShare?: number
}

/** The whitelisted subset of strategy.config.json that /api/config serves. */
export interface StrategyConfig {
  horizonDays?: number
  cadenceHours?: number
  claimEmissions?: boolean
  datanets?: Record<string, DatanetEntry>
  notes?: string
  budget?: Record<string, number | undefined>
  stake?: Record<string, number | undefined>
  deliberation?: { enabled?: boolean; votePanel?: boolean }
  /** Node default LLM model (provider+model). Absent ⇒ the env LLM_PROVIDER default.
   *  Used wherever a datanet has no per-datanet override and by the assistant chat. */
  defaultModel?: { provider: string; model: string }
}

export interface ChatMsg { role: 'user' | 'assistant'; content: string }

export interface DashData {
  pnl: Pnl | null
  snapshot: Snapshot | null
  activity: ActivityRow[]
  config: StrategyConfig
  earn: Earn | null
  netNames: Record<string, string>
}

/** Fetch JSON, returning `fallback` on any HTTP error or network/parse failure.
 *  A 500 body is `{ error }` (server.ts), not the expected shape — without the r.ok
 *  guard that object would poison state (e.g. a non-array `activity` crashes the
 *  Activity tab on `.filter`). Degrade to a safe fallback instead. */
async function getJson<T>(url: string, fallback: T): Promise<T> {
  try {
    const r = await fetch(url)
    if (!r.ok) return fallback
    return (await r.json()) as T
  } catch {
    return fallback
  }
}

/** Like getJson but tolerates only HTTP errors (degrade), NOT a network failure.
 *  Used for the load-critical endpoint so a fully-unreachable backend rejects loadAll
 *  → App shows a `load error` banner, distinct from a healthy fresh node. */
async function getJsonOrThrow<T>(url: string, fallback: T): Promise<T> {
  const r = await fetch(url) // network failure throws → surfaces as a load error
  if (!r.ok) return fallback
  return (await r.json()) as T
}

export async function loadAll(): Promise<DashData> {
  const [pnlRes, activity, config, earn, netNames] = await Promise.all([
    getJsonOrThrow<{ pnl?: Pnl | null; snapshot?: Snapshot | null }>('/api/pnl', {}),
    getJson<ActivityRow[]>('/api/activity', []),
    getJson<StrategyConfig>('/api/config', {}),
    getJson<Earn | null>('/api/earn', null),
    getJson<Record<string, string>>('/api/datanets', {}),
  ])
  return {
    pnl: pnlRes.pnl ?? null,
    snapshot: pnlRes.snapshot ?? null,
    // Array.isArray guard: even a 200 must never hand a non-array to consumers that .filter/.map it.
    activity: Array.isArray(activity) ? activity : [],
    config: config ?? {},
    earn,
    netNames: netNames || {},
  }
}

/** 7-day reliability view (mirrors GET /api/health → src/dashboard/health.ts buildHealth).
 *  Degrades to null on any error — the Health tab shows an unavailable state, and a
 *  transiently failing poll never wipes an already-rendered panel with a crash. */
export async function loadHealth(): Promise<Health | null> {
  return getJson<Health | null>('/api/health', null)
}

/** Platform agent identity as served by /api/agent — never includes the apiKey. */
export interface AgentInfo { agentId: string; name: string | null; renameable: boolean }

export async function getAgent(): Promise<AgentInfo | null> {
  return getJson<AgentInfo | null>('/api/agent', null)
}

export async function renameAgent(name: string): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch('/api/agent/name', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  const out = (await r.json().catch(() => ({}))) as { error?: string }
  return r.ok ? { ok: true } : { ok: false, error: out.error ?? `HTTP ${r.status}` }
}

/** Trigger an off-schedule cycle. started:false (HTTP 409) means a cycle is already
 *  running or the node is still starting — not an error, surfaced as `reason`. */
export async function runNow(): Promise<{ started: boolean; reason?: string; error?: string }> {
  const r = await fetch('/api/run-now', { method: 'POST' })
  const out = (await r.json().catch(() => ({}))) as { started?: boolean; reason?: string; error?: string }
  if (r.ok) return { started: true }
  return { started: false, reason: out.reason, error: out.error }
}

export async function saveStrategy(candidate: unknown): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch('/api/strategy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(candidate),
  })
  const out = await r.json().catch(() => ({}))
  return r.ok ? { ok: true } : { ok: false, error: out.error || String(r.status) }
}

// ── Model picker (mirrors GET /api/models — names only, never keys) ──
export interface ModelProvider { provider: string; hasKey: boolean; models: string[] }
export interface ModelsResponse { providers: ModelProvider[] }

/** Providers whose API key is present in the node's env, with seed model slugs.
 *  Degrades to an empty list on any error (no key entry happens in the UI). */
export async function loadModels(): Promise<ModelsResponse> {
  return getJson<ModelsResponse>('/api/models', { providers: [] })
}

// ── Onboarding (mirrors src/onboarding/types.ts) ──
export interface OnboardingDatanetChoice {
  id: string
  vote: boolean
  mint: boolean
  strictness: string
  adapter?: string
  adapterParams?: { focus?: string; angle?: string; topN?: number; minImportance?: number }
}

export interface OnboardingAnswers {
  datanets: OnboardingDatanetChoice[]
  lockReppo: number
  lockDurationDays: number
  voteRateMaxPerCycle: number
  mintReppoMax: number
  horizonDays: number
  cadenceHours: number
  notes: string
  /** Platform display name for the node (leaderboard); absent → orquestra-<wallet>. */
  nodeName?: string
}

export type OnboardingDraft = Partial<OnboardingAnswers>

export interface OnboardingStatus { needed: boolean; chatAvailable: boolean }

export async function onboardingStatus(): Promise<OnboardingStatus | null> {
  try { return await fetch('/api/onboarding/status').then((r) => r.json()) } catch { return null }
}

export interface OnboardingChatOut {
  reply?: string
  draft?: OnboardingDraft | null
  finalized?: OnboardingAnswers | null
  reset?: boolean
  error?: string
}

export async function onboardingChat(body: { message?: string; reset?: boolean }): Promise<{ ok: boolean; out: OnboardingChatOut }> {
  const r = await fetch('/api/onboarding/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { ok: r.ok, out: await r.json().catch(() => ({ error: `HTTP ${r.status}` })) }
}

export async function onboardingConfirm(answers: OnboardingAnswers): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch('/api/onboarding/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(answers),
  })
  const out = await r.json().catch(() => ({}))
  return r.ok ? { ok: true } : { ok: false, error: (out as { error?: string }).error || String(r.status) }
}

export interface ChatResult { reply: string; warning?: string; proposedConfig?: StrategyConfig & Record<string, unknown> }

export async function strategyChat(messages: ChatMsg[]): Promise<{ ok: boolean; out: ChatResult & { error?: string }; status: number }> {
  const r = await fetch('/api/strategy/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages }),
  })
  return { ok: r.ok, out: await r.json().catch(() => ({ reply: '' })), status: r.status }
}

// ── Self-learning (mirrors src/learn/* + /api/learn) ──
export interface LearnLesson { id: number; text: string; source: string; createdEpoch: number; createdTs: string }
export interface LearnStatsView {
  maturedTotal: number
  voteTotal: number
  voteAlignmentPct: number
  upVoteAlignedPct: number
  downVoteAlignedPct: number
  mintTotal: number
  mintAlignmentPct: number
  highConvictionTotal: number
  highConvictionAlignedPct: number
  lowConvictionAlignedPct: number
  highConvictionReversals: number
  sampleEpochs: number
}
// Mirrors src/learn/econStats.ts EconStats — numbers only, no free text.
export interface EconStats {
  datanetId: string
  epochsCovered: number
  mintCostReppo: number
  mintCount: number
  ownerClaimedReppo: number
  mintRoiPct: number | null
  voterClaimedReppo: number
  votesCast: number
  voterReppoPerVote: number | null
  latestYieldPerVote: number | null
  latestUncontested: boolean
}
export interface LearnDatanetView { enabled: boolean; lessons: LearnLesson[]; stats: LearnStatsView; econ?: EconStats }
export interface LearnProposal {
  id: number
  datanetId: string
  field: 'strictness' | 'vote_enable' | 'mint_enable' | 'vote_share'
  fromValue: string
  toValue: string
  rationale: string
  createdTs: string
}
export interface LearnData { datanets: Record<string, LearnDatanetView>; proposals: LearnProposal[] }

export async function loadLearn(): Promise<LearnData> {
  return fetch('/api/learn').then((r) => r.json())
}

export async function decideProposal(id: number, decision: 'accept' | 'reject'): Promise<{ ok: boolean; status?: string; error?: string }> {
  const r = await fetch(`/api/learn/proposals/${id}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision }),
  })
  const out = await r.json().catch(() => ({}))
  return { ok: r.ok, ...(out as object) }
}

export async function setLearnEnabled(datanetId: string, enabled: boolean): Promise<{ ok: boolean }> {
  const r = await fetch('/api/learn/disable', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ datanetId, enabled }),
  })
  return { ok: r.ok }
}

export async function vetoLessons(datanetId: string): Promise<{ ok: boolean }> {
  const r = await fetch('/api/learn/veto', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ datanetId }),
  })
  return { ok: r.ok }
}
