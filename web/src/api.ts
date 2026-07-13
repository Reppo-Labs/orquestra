// Typed client for the dashboard server's JSON API (src/dashboard/routes.ts).
// All response/request types come from the backend's single source of truth,
// src/dashboard/apiTypes.ts, via TYPE-ONLY imports across the package boundary —
// they vanish at build (the SPA bundle never pulls backend code), and any drift
// between what the server emits and what this client expects is now a compile
// error instead of a silent runtime mismatch. Writes are unauthenticated — the
// server binds localhost and exposure is the operator's responsibility.
import type {
  ActivityEntry,
  AgentInfo,
  DatanetNames,
  EarnStatus,
  HealthReport,
  LearnView,
  ModelsResponse,
  OnboardingAnswers,
  OnboardingChatRequest,
  OnboardingChatView,
  OnboardingStatusView,
  Pnl,
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
  Pnl,
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
  LearnDatanetView,
  SnapshotView as Snapshot,
  SnapshotBudgetView as SnapshotBudget,
  BudgetCapsView as BudgetCaps,
  ClaimableEmission as EmissionPod,
  LlmUsageSnapshot as LlmUsage,
  ActivityEntry as ActivityRow,
  KindCounts as HealthCounts,
  DatanetHealth as HealthDatanet,
  HealthReport as Health,
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
  pnl: Pnl | null
  snapshot: SnapshotView | null
  activity: ActivityEntry[]
  config: SafeStrategyConfig
  earn: EarnStatus | null
  netNames: DatanetNames
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
    getJsonOrThrow<Partial<PnlResponse>>('/api/pnl', {}),
    getJson<ActivityEntry[]>('/api/activity', []),
    getJson<SafeStrategyConfig>('/api/config', {}),
    getJson<EarnStatus | null>('/api/earn', null),
    getJson<DatanetNames>('/api/datanets', {}),
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
export async function loadHealth(): Promise<HealthReport | null> {
  return getJson<HealthReport | null>('/api/health', null)
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
 *  running or the node is still starting — not an error, surfaced as `reason`. */
export async function runNow(): Promise<{ started: boolean; reason?: string; error?: string }> {
  const r = await fetch('/api/run-now', { method: 'POST' })
  const out = (await r.json().catch(() => ({}))) as Partial<RunNowResult> & { error?: string }
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
