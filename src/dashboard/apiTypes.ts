// src/dashboard/apiTypes.ts
// Wire types for the dashboard JSON API — the single source of truth shared by the
// server (routes.ts handlers) and the web SPA (web/src/api.ts imports these across
// the package boundary with `import type`, which vanishes at build; the SPA bundle
// never pulls backend code).
//
// Domain types stay DEFINED in their own modules and are re-exported here. Where the
// wire genuinely differs from the domain — rows persisted by older node versions may
// predate a field, or the editor round-trips drafts before schema defaults apply —
// the wire type is DERIVED from the domain type (Omit/Pick/Partial), so a rename or
// a new field still surfaces as a compile error on both sides instead of drifting.
import type { Pnl } from './pnl.js'
import type { Snapshot, SnapshotBudget } from './snapshot.js'
import type { PersistedEarn } from './earnStatus.js'
import type { BudgetCaps } from '../wallet/ledger.js'
import type { StrategyConfig } from '../config/schema.js'
import type { LlmProvider } from '../llm/model.js'
import type { OnboardingAnswers } from '../onboarding/types.js'

// ── domain re-exports (wire shape == domain shape) ────────────────────────────────
export type { Pnl } from './pnl.js'
export type { Snapshot, SnapshotBudget } from './snapshot.js'
export type { ActivityEntry } from './activityLog.js'
export type { PanelTranscript, PanelistVerdict } from '../panel/types.js'
export type { HealthReport, DatanetHealth, KindCounts, TxRate } from './health.js'
export type { DatanetYield } from '../voter/yield.js'
export type { LlmUsageSnapshot, ModelUsage } from '../llm/usage.js'
export type { LearnView, LearnDatanetView } from '../learn/view.js'
export type { LessonRow, ProposalRow, ProposalField, ProposalStatus } from '../learn/store.js'
export type { LearnStats } from '../learn/stats.js'
export type { EconStats } from '../learn/econStats.js'
export type { EpochInfo } from '../reppo/queryEpoch.js'
export type { WalletBalance } from '../reppo/queryBalance.js'
export type { EmissionsDue, ClaimableEmission } from '../reppo/queryEmissionsDue.js'
export type { BudgetCaps } from '../wallet/ledger.js'
export type { ChatMessage, StrategyChatResult } from './strategyChat.js'
export type { OnboardingAnswers, DatanetChoice, AdapterParams } from '../onboarding/types.js'
export type { StrategyConfig, StrictnessLevel } from '../config/schema.js'
export type { LlmProvider } from '../llm/model.js'

// ── derived wire types ─────────────────────────────────────────────────────────────

/** Caps as they ride a persisted snapshot row: rows written before a cap existed
 *  simply lack it, and the dashboard renders an absent cap as "uncapped". */
export type BudgetCapsView = Partial<BudgetCaps>

export type SnapshotBudgetView = Omit<SnapshotBudget, 'caps'> & { caps: BudgetCapsView }

/** /api/pnl's `snapshot`: the latest persisted cycle row is served verbatim, and rows
 *  written by OLDER node versions may predate votingPower/budget — exactly those are
 *  loosened; everything else stays canonical. */
export type SnapshotView = Omit<Snapshot, 'votingPower' | 'budget'> &
  Partial<Pick<Snapshot, 'votingPower'>> & { budget?: SnapshotBudgetView }

/** GET /api/pnl. */
export interface PnlResponse { pnl: Pnl | null; snapshot: SnapshotView | null }

/** GET /api/earn: rows persisted by older nodes may predate claimedTokens. */
export type EarnStatus = Omit<PersistedEarn, 'claimedTokens'> &
  Partial<Pick<PersistedEarn, 'claimedTokens'>>

type CanonicalDatanetPolicy = StrategyConfig['datanets'][string]

/** One datanet's policy as the strategy editor round-trips it: vote/mint/strictness
 *  always present; the schema-defaulted fields stay optional in drafts (the canonical
 *  parse fills them on save). */
export type DatanetEntry = Pick<CanonicalDatanetPolicy, 'vote' | 'mint' | 'strictness'> &
  Partial<CanonicalDatanetPolicy>

/** The whitelisted subset GET /api/config serves (routes.ts safeConfig): every field
 *  optional (a fresh node serves {}), sub-objects partial because the tolerant
 *  fallback serves raw values from a schema-rejected file. POST /api/strategy accepts
 *  a candidate of this shape and re-validates it against the full schema. */
export interface SafeStrategyConfig extends Partial<Pick<StrategyConfig, 'horizonDays' | 'cadenceHours' | 'claimEmissions' | 'notes' | 'defaultModel' | 'nodeName'>> {
  datanets?: Record<string, DatanetEntry>
  budget?: Partial<StrategyConfig['budget']>
  stake?: Partial<StrategyConfig['stake']>
  deliberation?: Partial<StrategyConfig['deliberation']>
}

// ── endpoint shapes with no single domain owner ────────────────────────────────────

/** GET /api/onboarding/status. */
export interface OnboardingStatusView { needed: boolean; chatAvailable: boolean }

/** GET /api/agent (null when no agent is registered yet). The apiKey NEVER rides this. */
export interface AgentInfo { agentId: string; name: string | null; renameable: boolean }

/** POST /api/agent/name success body. */
export interface AgentRenameResult { name: string; updated: boolean }

/** GET /api/models — provider/model NAMES only, never keys. */
export interface ModelProvider { provider: LlmProvider; hasKey: true; models: string[] }
export interface ModelsResponse { providers: ModelProvider[] }

/** GET /api/datanets — datanet id → display name. */
export type DatanetNames = Record<string, string>

/** POST /api/run-now (200 started, 409 not — reason says why). */
export interface RunNowResult { started: boolean; reason?: string }

/** POST /api/strategy success body. */
export interface SaveStrategyResult { saved: true; appliesNextCycle: true }

/** POST /api/learn/proposals/:id body + result. */
export interface ProposalDecisionRequest { decision: 'accept' | 'reject' }
export interface ProposalDecisionView { ok: boolean; status?: string; error?: string; appliesNextCycle?: boolean }

/** Onboarding chat wire shapes (POST /api/onboarding/chat). */
export type OnboardingDraft = Partial<OnboardingAnswers>
export interface OnboardingChatRequest { message?: string; reset?: boolean }
export interface OnboardingChatView {
  reply?: string
  draft?: OnboardingDraft | null
  finalized?: OnboardingAnswers | null
  reset?: boolean
  error?: string
}

/** Every non-2xx JSON body carries this. */
export interface ApiError { error: string }
