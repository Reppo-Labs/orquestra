// The decision layer between the node's raw telemetry and the operator's screen.
// Everything here is PURE so the judgements the UI makes ("this datanet is blocked",
// "stop minting here", "there is nothing to do") are unit-testable without a DOM.
//
// Colour rule (Phase 1, preserved): green/red mean PROFIT/LOSS only. Operational state
// is neutral or amber — a "working" datanet is not a profitable one, and a blocked
// datanet has not lost you money.
import type {
  ActivityRow, Classification, DatanetEntry, DatanetPnl, ErrorCode, HealthDatanet,
  Snapshot, SuggestedAction,
} from '../api'

/** What the node is actually doing with a datanet right now.
 *  - working: it ran and did work this window.
 *  - blocked: something is stopping it that the operator can act on.
 *  - capped:  it stopped early because it hit the OPERATOR'S OWN caps — not a fault.
 *  - quiet:   it ran and judged nothing worth acting on. Working as designed.
 *  - off:     the operator turned it off. Silence is what "off" means.
 *  - unknown: no telemetry yet (fresh datanet, or the node hasn't reached it). */
export type WorkState = 'working' | 'blocked' | 'capped' | 'quiet' | 'off' | 'unknown'

/** Codes that mean "this datanet is NOT doing its job" — everything else is the node working as
 *  designed. Derived from src/dashboard/errorClass.ts's closed code set.
 *
 *  Some of these the operator fixes (fund the wallet, swap the RPC, top up the model quota) and
 *  some clear on their own (Reppo's API is down, an adapter is rate-limited). Both belong here:
 *  the datanet earned nothing either way, and pretending it is merely 'quiet' would be the same
 *  class of lie as telling them to change RPC_URL. The classification's operatorMessage is what
 *  says whether there is anything to do — the state only says it is not working. */
const BLOCKING: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'rpc_unavailable', 'reppo_api_unavailable', 'adapter_rate_limited', 'llm_quota_exhausted',
  'network_unstable', 'datanet_metadata_missing', 'insufficient_funds', 'subnet_access_missing',
  'no_adapter', 'model_unavailable', 'scoring_failed', 'cli_outdated', 'unknown',
])

const isEnabled = (d: DatanetEntry | undefined): boolean => !!d && (d.vote || d.mint)

/**
 * Datanets whose classification is HISTORY, not their current state.
 *
 * The server attaches a classification from the newest skip/error in a 7-DAY window and does
 * not stop at a successful row, so one transient RPC blip six days ago keeps a datanet that
 * has executed 300 votes since flagged "can't run" — dropped from the working count, given a
 * warning card, and offered a destructive disable button. The activity log is the tiebreak:
 * if the newest row we can see FOR THIS DATANET is an executed vote/mint/claim, the failure
 * is over.
 *
 * (The backend is being fixed to stop emitting these. This is the defence in depth: the
 * dashboard must be right about a datanet even when handed a stale classification.)
 */
export function recoveredDatanets(activity: ActivityRow[]): Set<string> {
  const newest = new Map<string, ActivityRow>()
  for (const r of activity) {
    if (!r.datanetId) continue
    const t = new Date(r.ts).getTime()
    if (!Number.isFinite(t)) continue
    const prev = newest.get(r.datanetId)
    if (!prev || t > new Date(prev.ts).getTime()) newest.set(r.datanetId, r)
  }
  const out = new Set<string>()
  for (const [id, r] of newest) {
    if (r.kind !== 'skip' && r.status === 'executed') out.add(id)
  }
  return out
}

/** A datanet's state, from its health entry. Order matters: a BLOCKED datanet that is
 *  also executing some votes is still blocked (it is failing at something), and
 *  budget_exhausted outranks idleness because it EXPLAINS the idleness.
 *
 *  `recovered` overrides the classification entirely — see recoveredDatanets(). */
export function workState(h: HealthDatanet | undefined, recovered = false): WorkState {
  if (!h) return 'unknown'
  const code = recovered ? undefined : h.classification?.code
  if (code && BLOCKING.has(code)) return 'blocked'
  if (code === 'budget_exhausted') return 'capped'
  if (!h.idle) return 'working'
  // idle with a benign code (no_candidates / own_pod), or idle with no code at all
  return code ? 'quiet' : 'unknown'
}

export interface Coverage { working: number; total: number; blocked: number; capped: number; off: number }

/**
 * The honest node-wide headline: how much of the node is actually doing its job.
 *
 * `total` counts ENABLED datanets — a datanet the operator switched off (often on this
 * dashboard's own advice) is not a hole in the node's coverage, and leaving it in the
 * denominator meant the number could never reach N of N and the recommended remedy made the
 * node look no better. Off datanets get their own count, so they are reported, not hidden.
 *
 * A datanet the node never reached still counts in `total` — it must not vanish just because
 * it produced no telemetry. A CAPPED datanet counts as working: it did its job and then hit
 * the operator's own ceiling.
 *
 * `blocked` is also gated on enabled: turning a datanet off stops it producing NEW failures
 * but cannot erase the old ones from a 7-day window, so an ungated count kept the operator's
 * completed remedy looking un-done for a week.
 */
export function coverage(
  datanets: Record<string, DatanetEntry>,
  health: HealthDatanet[],
  recovered: ReadonlySet<string> = new Set(),
): Coverage {
  const byId = new Map(health.map((h) => [h.datanetId, h]))
  let working = 0, blocked = 0, capped = 0, off = 0, total = 0
  for (const [id, d] of Object.entries(datanets)) {
    if (id === '*') continue
    if (!isEnabled(d)) { off++; continue }
    total++
    const s = workState(byId.get(id), recovered.has(id))
    if (s === 'working' || s === 'capped') working++
    if (s === 'blocked') blocked++
    if (s === 'capped') capped++
  }
  return { working, total, blocked, capped, off }
}

/** Every action the UI can take on the operator's behalf, mapped 1:1 from the backend's
 *  SEVEN SuggestedAction values. `kind` is what the button DOES; `label` is what it says.
 *
 *  `explain_model_quota` is the newest: an exhausted LLM quota is fixed at the model provider
 *  (billing/quota) or by pointing that datanet at another model — none of the other remedies
 *  touch it, and it used to be routed to explain_rpc, which told the operator to fix an
 *  endpoint that was working perfectly. */
export type ActionKind =
  | 'disable' | 'raise_budget' | 'explain_rpc' | 'explain_model_quota' | 'explain_funding'
  | 'retry' | 'none'

/** What a `disable` remedy actually turns off.
 *  - 'mint': publishing only. Voting keeps running — it costs no REPPO in fees and still
 *    earns emissions, so switching it off to fix a MINT-side fault destroys income the
 *    operator never agreed to give up.
 *  - 'all': the datanet cannot take part at all. */
export type DisableScope = 'mint' | 'all'

export interface ActionPlan {
  kind: ActionKind
  /** Button text. Empty for 'none' — the row then shows no button at all. */
  label: string
  /** Only meaningful for kind 'disable'. */
  scope?: DisableScope
}

/**
 * Which side of a datanet a `disable_datanet` remedy should actually switch off.
 *
 * `no_adapter` is emitted while the datanet's VOTE path is running fine — the backend's own
 * operator message says so in as many words ("Turn publishing off for this datanet (voting
 * still works)"). `datanet_metadata_missing` covers a missing voter rubric OR a missing
 * publisher spec, so the code alone cannot say; the health entry can — a datanet with
 * executed votes in the window is demonstrably able to vote, whatever else is broken.
 */
export function disableScope(code: ErrorCode | undefined, h: HealthDatanet | undefined): DisableScope {
  if (code === 'no_adapter') return 'mint'
  if ((h?.votes.executed ?? 0) > 0) return 'mint' // voting demonstrably works — do not kill it
  return 'all'
}

/** classification.suggestedAction → the control the operator gets. All SEVEN backend values
 *  are handled; an unrecognised one degrades to NO button rather than a dead one. The
 *  disable remedy is SCOPED, and its label says exactly what it will do. */
export function actionPlan(c: Classification | undefined, h?: HealthDatanet): ActionPlan {
  const action: SuggestedAction | undefined = c?.suggestedAction
  switch (action) {
    case 'disable_datanet': {
      const scope = disableScope(c?.code, h)
      return scope === 'mint'
        ? { kind: 'disable', label: 'Turn publishing off', scope }
        : { kind: 'disable', label: 'Turn this datanet off', scope }
    }
    case 'raise_budget': return { kind: 'raise_budget', label: 'Raise spending caps' }
    case 'check_rpc': return { kind: 'explain_rpc', label: 'How to fix' }
    case 'check_model_quota': return { kind: 'explain_model_quota', label: 'How to fix' }
    case 'fund_wallet': return { kind: 'explain_funding', label: 'How to fix' }
    case 'retry': return { kind: 'retry', label: 'Run a cycle now' }
    default: return { kind: 'none', label: '' } // 'none', or no classification at all
  }
}

/** Apply a scoped disable to a datanet entry. One definition, used by every surface that
 *  offers the remedy — Home, the Datanets rows and the alert cards must not diverge. */
export function applyDisable(d: DatanetEntry, scope: DisableScope): void {
  d.mint = false
  if (scope === 'all') d.vote = false
}

/** REPPO due but unclaimed, per datanet, from the snapshot's emission pods. This is money
 *  the datanet HAS earned and the node has not collected — leaving it out of a datanet's
 *  P&L is what makes every minting datanet look like a loss-maker until its first claim
 *  lands, roughly an epoch later. */
export function pendingByDatanet(snapshot: Snapshot | null | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const p of snapshot?.emissionsDue?.pods ?? []) {
    if (!p.datanetId || !Number.isFinite(p.reppo)) continue
    out[p.datanetId] = (out[p.datanetId] ?? 0) + p.reppo
  }
  return out
}

/** Has this node been paid emissions AT ALL yet? Until it has, "losing money" is a verdict
 *  the data cannot support: emissions lag votes and mints by roughly an epoch, so a datanet
 *  that minted an hour ago has spent but could not possibly have been paid. EarnBanner says
 *  exactly this ("too early to tell") — the next-action card must not contradict the banner
 *  directly above it. */
export const emissionsStarted = (pnl: { claimedReppo: number; claimableReppo: number } | null | undefined): boolean =>
  !!pnl && ((pnl.claimedReppo ?? 0) > 0 || (pnl.claimableReppo ?? 0) > 0)

export interface LossView {
  /** Judged with pending emissions credited. */
  losing: boolean
  /** net + emissions due but unclaimed — what the datanet is really worth today. */
  effectiveNet: number
  pending: number
}

/** A datanet that is COSTING the operator money: it spent REPPO minting and is STILL down
 *  once the emissions it is already owed are credited. A vote-only datanet (0 spend) can
 *  never appear here — it has no ROI and nothing to stop.
 *
 *  `started` false ⇒ never losing: the node has not been paid a single REPPO anywhere, so
 *  nothing has had time to pay and there is no verdict to give. */
export function lossView(p: DatanetPnl, pending: number, started: boolean): LossView {
  const effectiveNet = p.net + pending
  return { losing: started && p.reppoSpent > 0 && effectiveNet < 0, effectiveNet, pending }
}

export interface LosingOpts {
  /** REPPO due but unclaimed, per datanet id (pendingByDatanet). */
  pending?: Record<string, number>
  /** emissionsStarted(pnl) — has ANY emission reached this node yet? */
  started: boolean
}

export const isLosing = (p: DatanetPnl, opts: LosingOpts): boolean =>
  lossView(p, opts.pending?.[p.datanetId] ?? 0, opts.started).losing

/** Worst-first, and only the ones actually losing money once pending emissions are credited.
 *  Sorted on the EFFECTIVE net, which is the number the operator is being asked to act on. */
export const losingDatanets = (rows: DatanetPnl[], opts: LosingOpts): DatanetPnl[] => {
  const eff = (p: DatanetPnl) => p.net + (opts.pending?.[p.datanetId] ?? 0)
  return rows.filter((p) => isLosing(p, opts)).sort((a, b) => eff(a) - eff(b))
}

/** The ONE thing to do next. Home shows exactly this and nothing else — a list of five
 *  "next actions" is not a next action.
 *
 *  Priority is by cost of inaction: the node not signing at all > a live critical alert >
 *  money bleeding now > the node unable to run > the node running below its own ceiling >
 *  anything else still open > nothing at all. */
export type NextActionKind = 'resume' | 'alerts' | 'stop_minting' | 'fix_blocked' | 'raise_budget' | 'wait' | 'none'

export interface NextAction {
  kind: NextActionKind
  headline: string
  detail: string
  /** Button text; '' = informational only, no button. */
  cta: string
  /** The datanet the action is about, when it is about one. */
  datanetId?: string
}

/** What the alert surface currently holds. nextAction MUST see this: five of the conditions
 *  deriveAlerts() can raise (wallet gas, wallet REPPO, accelerating loss, caps, idleness)
 *  reach none of the other inputs, so without it the biggest, most reassuring element on
 *  Home says "Nothing needs your attention" with a CRITICAL alert live on the same screen. */
export interface AlertLoad { total: number; critical: number }

export function nextAction(input: {
  paused: boolean
  losing: DatanetPnl[]
  cov: Coverage
  hasRun: boolean
  alerts?: AlertLoad
}): NextAction {
  const { paused, losing, cov, hasRun } = input
  const alerts = input.alerts ?? { total: 0, critical: 0 }
  if (paused) {
    return {
      kind: 'resume',
      headline: 'Your node is paused',
      detail: 'It is signing nothing — no votes, no mints, no claims. It earns nothing while paused.',
      cta: 'Resume the node',
    }
  }
  // A critical alert means money, or the node's ability to run at all, is at stake NOW. It
  // outranks a losing datanet: a wallet with no gas stops voting, minting AND claiming.
  if (alerts.critical > 0) {
    return {
      kind: 'alerts',
      headline: alerts.critical === 1
        ? 'Something needs you now'
        : `${alerts.critical} things need you now`,
      detail: 'The alerts above are the ones that cost you money or stop the node running. Each one says what is wrong and what to do about it.',
      cta: '',
    }
  }
  const worst = losing[0]
  if (worst) {
    return {
      kind: 'stop_minting',
      headline: `Datanet ${worst.datanetId} is losing you money`,
      detail: `It has spent more REPPO minting than it earned back, over ${worst.mintsExecuted} mint${worst.mintsExecuted === 1 ? '' : 's'} — including the emissions it is already owed. Stop minting there and it stops costing you — voting still earns.`,
      cta: 'Stop minting there',
      datanetId: worst.datanetId,
    }
  }
  if (cov.blocked > 0) {
    return {
      kind: 'fix_blocked',
      headline: `${cov.blocked} datanet${cov.blocked === 1 ? " can't" : "s can't"} run`,
      detail: 'They are not costing you money, but they are not earning either. Each one says what is wrong and what to do about it.',
      cta: 'Review datanets',
    }
  }
  if (!hasRun) {
    return {
      kind: 'wait',
      headline: 'Waiting for the first cycle',
      detail: 'The node runs on its own cadence and nothing has been signed yet. You can trigger a cycle now instead of waiting.',
      cta: 'Run a cycle now',
    }
  }
  if (cov.capped > 0) {
    return {
      kind: 'raise_budget',
      headline: 'Your node is hitting its own spending caps',
      detail: `${cov.capped} datanet${cov.capped === 1 ? ' stopped' : 's stopped'} early because your caps said so, not because anything failed. Raise them to let it do more.`,
      cta: 'Review spending caps',
    }
  }
  // Anything still open — a near-cap warning, an idle datanet — is not "nothing".
  if (alerts.total > 0) {
    return {
      kind: 'alerts',
      headline: alerts.total === 1 ? '1 thing needs your attention' : `${alerts.total} things need your attention`,
      detail: 'Nothing is losing you money and nothing is blocked, but the alerts above are still open. Dismissing one hides the card; it does not fix the node.',
      cta: '',
    }
  }
  return {
    kind: 'none',
    headline: 'Nothing needs your attention',
    detail: 'The node is running, nothing is blocked, and nothing is losing money. It votes and mints on its own — you do not need to be here.',
    cta: '',
  }
}

/** voteShare in plain words: the slice of this cycle's votes this datanet gets. A bare
 *  "7" means nothing on its own — it is a weight RELATIVE to the other vote-enabled
 *  datanets, so that ratio is what the operator is shown. Returns null when the datanet
 *  does not vote (it gets no slice at all). */
export function voteSharePct(id: string, datanets: Record<string, DatanetEntry>): number | null {
  const entry = datanets[id]
  if (!entry?.vote) return null
  const total = Object.entries(datanets)
    .filter(([k, d]) => k !== '*' && d.vote)
    .reduce((sum, [, d]) => sum + Math.max(1, d.voteShare ?? 1), 0)
  if (total <= 0) return null
  return (Math.max(1, entry.voteShare ?? 1) / total) * 100
}
