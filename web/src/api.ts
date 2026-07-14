// Typed client for the dashboard server's JSON API (src/dashboard/routes.ts).
// All response/request types come from the backend's single source of truth,
// src/dashboard/apiTypes.ts, via TYPE-ONLY imports across the package boundary —
// they vanish at build (the SPA bundle never pulls backend code), and any drift
// between what the server emits and what this client expects is now a compile
// error instead of a silent runtime mismatch. Writes are unauthenticated — the
// server binds localhost and exposure is the operator's responsibility.
import type {
  ActivityEntryView,
  AgentInfo,
  DatanetNames,
  DatanetPnl,
  DatanetPnlResponse,
  EarnStatus,
  HealthReportView,
  LearnView,
  ModelsResponse,
  OnboardingAnswers,
  OnboardingChatRequest,
  OnboardingChatView,
  OnboardingStatusView,
  PauseResult,
  PnlView,
  PnlResponse,
  ProposalDecisionView,
  RunNowResult,
  SafeStrategyConfig,
  SnapshotView,
  StrategyChatResult,
  ChatMessage,
} from '../../src/dashboard/apiTypes.js'

// Re-export under the names the components use (local aliases only — the
// definitions live in src/dashboard/apiTypes.ts and the domain modules behind it).
export type {
  PnlView as Pnl,
  EpochInfo,
  DatanetYield,
  PanelTranscript,
  EconStats,
  TxRate,
  OnboardingAnswers,
  OnboardingDraft,
  AgentInfo,
  ModelProvider,
  ModelsResponse,
  DatanetEntry,
  DatanetPnl,
  ErrorCode,
  SuggestedAction,
  LearnDatanetView,
  SnapshotView as Snapshot,
  SnapshotBudgetView as SnapshotBudget,
  BudgetCapsView as BudgetCaps,
  ClaimableEmission as EmissionPod,
  LlmUsageSnapshot as LlmUsage,
  ActivityEntryView as ActivityRow,
  KindCounts as HealthCounts,
  // /api/health serves the CLASSIFIED report: buildHealth's counters plus an operator-facing
  // { code, operatorMessage, suggestedAction } per currently-failing datanet.
  ClassifiedError as Classification,
  DatanetHealthView as HealthDatanet,
  HealthReportView as Health,
  EarnStatus as Earn,
  SafeStrategyConfig as StrategyConfig,
  ChatMessage as ChatMsg,
  DatanetChoice as OnboardingDatanetChoice,
  OnboardingStatusView as OnboardingStatus,
  OnboardingChatView as OnboardingChatOut,
  StrategyChatResult as ChatResult,
  LessonRow as LearnLesson,
  LearnStats as LearnStatsView,
  ProposalRow as LearnProposal,
  LearnView as LearnData,
} from '../../src/dashboard/apiTypes.js'

export interface DashData {
  pnl: PnlView | null
  snapshot: SnapshotView | null
  activity: ActivityEntryView[]
  config: SafeStrategyConfig
  earn: EarnStatus | null
  netNames: DatanetNames
  /** Per-datanet lifetime profit, worst net first — the single most actionable number an
   *  operator has ("datanet 11 spent 5,200 REPPO over 28 mints and earned 0 back").
   *  [] on an older node with no /api/datanet-pnl. */
  datanetPnl: DatanetPnl[]
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
  const [pnlRes, activity, config, earn, netNames, dnPnl] = await Promise.all([
    getJsonOrThrow<Partial<PnlResponse>>('/api/pnl', {}),
    getJson<ActivityEntryView[]>('/api/activity', []),
    getJson<SafeStrategyConfig>('/api/config', {}),
    getJson<EarnStatus | null>('/api/earn', null),
    getJson<DatanetNames>('/api/datanets', {}),
    getJson<Partial<DatanetPnlResponse>>('/api/datanet-pnl', {}),
  ])
  return {
    pnl: pnlRes.pnl ?? null,
    snapshot: pnlRes.snapshot ?? null,
    // Array.isArray guard: even a 200 must never hand a non-array to consumers that .filter/.map it.
    activity: Array.isArray(activity) ? activity : [],
    config: config ?? {},
    earn,
    netNames: netNames || {},
    datanetPnl: Array.isArray(dnPnl.datanets) ? dnPnl.datanets : [],
  }
}

/** Emergency kill switch (POST /api/pause). While paused the node signs nothing but keeps
 *  running. `appliesNextCycle` is always true and must be surfaced, not hidden: a cycle
 *  already in flight finishes under the old flag.
 *
 *  NEVER REJECTS. This is the "stop spending my money" control: a rejected promise leaves
 *  the caller's `setBusy(false)` unreached, so the button locks on "…" forever and the
 *  operator is told nothing while the node keeps signing. A network failure is a RESULT
 *  here ({ ok: false }), not an exception. */
export async function setPaused(paused: boolean): Promise<{ ok: boolean; paused?: boolean; appliesNextCycle?: boolean; error?: string }> {
  let r: Response
  try {
    r = await fetch('/api/pause', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paused }),
    })
  } catch {
    return { ok: false, error: 'could not reach the node — nothing changed' }
  }
  const out = (await r.json().catch(() => ({}))) as Partial<PauseResult> & { error?: string }
  return r.ok ? { ok: true, ...out } : { ok: false, error: out.error ?? `HTTP ${r.status}` }
}

/** 7-day reliability view (mirrors GET /api/health → buildHealth + attachClassification).
 *  Degrades to null on any error — the Health tab shows an unavailable state, and a
 *  transiently failing poll never wipes an already-rendered panel with a crash. */
export async function loadHealth(): Promise<HealthReportView | null> {
  return getJson<HealthReportView | null>('/api/health', null)
}

/** Platform agent identity as served by /api/agent — never includes the apiKey. */
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
 *  running or the node is still starting — not an error, surfaced as `reason`.
 *  Never rejects: this is awaited between setBusy(true) and setBusy(false) by the "retry"
 *  remedy, and a rejection would strand that button on "working…" with no message. */
export async function runNow(): Promise<{ started: boolean; reason?: string; error?: string }> {
  let r: Response
  try {
    r = await fetch('/api/run-now', { method: 'POST' })
  } catch {
    return { started: false, error: 'could not reach the node' }
  }
  const out = (await r.json().catch(() => ({}))) as Partial<RunNowResult> & { error?: string }
  if (r.ok) return { started: true }
  return { started: false, reason: out.reason, error: out.error }
}

/** NEVER REJECTS, for the same reason setPaused does not: the one-click remedies await this
 *  between setBusy(true) and setBusy(false). A rejection there strands the button on
 *  "working…" and the operator never learns the save failed. */
export async function saveStrategy(candidate: unknown): Promise<{ ok: boolean; error?: string }> {
  let r: Response
  try {
    r = await fetch('/api/strategy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(candidate),
    })
  } catch {
    return { ok: false, error: 'could not reach the node — nothing was saved' }
  }
  const out = await r.json().catch(() => ({}))
  return r.ok ? { ok: true } : { ok: false, error: out.error || String(r.status) }
}

/** The config the node holds RIGHT NOW. The one-click remedies read this immediately before
 *  they write, so they mutate the live config rather than a candidate loaded minutes ago —
 *  a whole-config POST built on a stale copy silently reverts anything the node or another
 *  surface (a learning proposal, a pause, another tab) has written since page load.
 *  null = unreachable or no config; the caller must NOT fall back to a stale copy. */
export async function fetchConfig(): Promise<SafeStrategyConfig | null> {
  try {
    const r = await fetch('/api/config')
    if (!r.ok) return null
    const c = (await r.json()) as SafeStrategyConfig | null
    return c && typeof c === 'object' ? c : null
  } catch {
    return null
  }
}

/** Providers whose API key is present in the node's env, with seed model slugs
 *  (GET /api/models — names only, never keys). Degrades to an empty list on any
 *  error (no key entry happens in the UI). */
export async function loadModels(): Promise<ModelsResponse> {
  return getJson<ModelsResponse>('/api/models', { providers: [] })
}

// ── Onboarding ──
export async function onboardingStatus(): Promise<OnboardingStatusView | null> {
  try { return await fetch('/api/onboarding/status').then((r) => r.json()) } catch { return null }
}

export async function onboardingChat(body: OnboardingChatRequest): Promise<{ ok: boolean; out: OnboardingChatView }> {
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

export async function strategyChat(messages: ChatMessage[]): Promise<{ ok: boolean; out: StrategyChatResult & { error?: string }; status: number }> {
  const r = await fetch('/api/strategy/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages }),
  })
  return { ok: r.ok, out: await r.json().catch(() => ({ reply: '' })), status: r.status }
}

// ── Self-learning (GET /api/learn + proposal decisions) ──
export async function loadLearn(): Promise<LearnView> {
  return fetch('/api/learn').then((r) => r.json())
}

export async function decideProposal(id: number, decision: 'accept' | 'reject'): Promise<ProposalDecisionView> {
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
