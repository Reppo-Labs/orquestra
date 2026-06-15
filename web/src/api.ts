// Typed client for the dashboard server's JSON API (src/dashboard/server.ts).
// Shapes mirror what the endpoints actually emit. Writes are unauthenticated —
// the server binds localhost and exposure is the operator's responsibility.

export interface Pnl {
  netReppo: number
  earnedReppo: number
  claimedReppo: number
  claimableReppo: number
  spentReppo: number
  gasSpentEth: number
}

export interface EpochInfo { epoch: string | number; secondsRemaining: number }

export interface BudgetCaps {
  voteGasEthMax?: number
  mintReppoMax?: number
  mintGasEthMax?: number
  claimGasEthMax?: number
  grantReppoMax?: number | null
}

export interface SnapshotBudget {
  voteGasSpentEth: number
  mintReppoSpent: number
  mintGasSpentEth: number
  claimGasSpentEth: number
  grantReppoSpent?: number
  caps: BudgetCaps
}

export interface EmissionPod { podId: string; datanetId: string; epoch: string | number; reppo: number }

export interface Snapshot {
  ts: string | number
  epoch?: EpochInfo | null
  balance: { reppo: number; veReppo: number }
  budget?: SnapshotBudget
  emissionsDue: { pods: EmissionPod[] }
}

export interface PanelTranscript {
  screenScore?: number
  panelists: { persona: string; score: number; argument: string }[]
  judge: { score: number; reason: string }
}

export interface ActivityRow {
  ts: string | number
  kind: 'vote' | 'mint' | 'claim' | 'skip'
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
  txRate?: TxRate
  skips?: number
  topErrors: { code: string; count: number }[]
  idle?: boolean
  lastSkipReason?: string
}
export interface Health { datanets: HealthDatanet[]; txRate?: TxRate }

export interface Earn {
  earning: boolean
  mintedPods: number
  claimableReppo: number
  claimedReppo: number
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
  deliberation?: { enabled?: boolean; voteBand?: number }
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

export async function loadAll(): Promise<DashData> {
  const [pnlRes, activity, config, earn, netNames] = await Promise.all([
    fetch('/api/pnl').then((r) => r.json()),
    fetch('/api/activity').then((r) => r.json()),
    fetch('/api/config').then((r) => r.json()),
    fetch('/api/earn').then((r) => r.json()).catch(() => null),
    fetch('/api/datanets').then((r) => r.json()).catch(() => ({})),
  ])
  return { pnl: pnlRes.pnl, snapshot: pnlRes.snapshot, activity, config, earn, netNames: netNames || {} }
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
export interface LearnDatanetView { enabled: boolean; lessons: LearnLesson[]; stats: LearnStatsView }
export interface LearnProposal {
  id: number
  datanetId: string
  field: 'strictness' | 'voteBand'
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
