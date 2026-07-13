// The alert surface. The node can be broken for days — a datanet erroring every cycle, the
// mint budget spent, the wallet too poor to sign — and until now the dashboard said nothing
// unless the operator went looking. This module decides what deserves an interruption.
//
// RULES OF THIS FILE
// 1. Every condition is derived from a payload the node ACTUALLY serves. No condition is
//    invented for completeness; if the data cannot support it, it is not here.
// 2. Numbers are stated with their derivation ("about 43 more transactions, at the gas
//    prices this node actually paid"), never as bare oracles.
// 3. PAUSED IS NOT AN ALERT. PauseControl + PausedBanner + Home's next-action already say
//    it on every tab. A fourth voice would be noise, and the brief says do not double-alert.
// 4. Remedies reuse `actionPlan` — the exact wiring the Datanets rows already use. A broken
//    thing must never be a dead end, and it must not grow a second, divergent remedy path.
import type { ActivityRow, Classification, DatanetPnl, ErrorCode, HealthDatanet, Snapshot, StrategyConfig } from '../api'
import { actionPlan, recoveredDatanets, workState, type ActionPlan } from './datanetStatus'
import { fmt, fmtCount, fmtEth, fmtReppo } from './format'
import { lossAcceleration, type NetSeries } from './pnlSeries'

/** critical = money, or the node's ability to run at all, is at stake NOW.
 *  warning  = it is not working and will not fix itself.
 *  info     = worth knowing, nothing is broken. */
export type Severity = 'critical' | 'warning' | 'info'

/** Sort order. Lower wins. The operator's eye must land on the costliest thing first. */
export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 }

export interface Alert {
  /** Stable across refreshes — dismissal is keyed on it.
   *
   *  THE SEVERITY IS PART OF THE KEY, and it has to be: `wallet:eth` flips warning →
   *  critical as the gas runs out, and `idle:<id>` flips info ("nothing to work on — not
   *  costing you anything") → warning ("has done nothing for 5 days — earning you nothing").
   *  With a severity-free id, a dismissal taken against the MILD version silently buries the
   *  SEVERE one: the operator who decided to top up the wallet at the weekend never sees the
   *  card that says the node is about to stop. A condition that escalates gets a new id, so
   *  it comes back. */
  id: string
  severity: Severity
  title: string
  detail: string
  datanetId?: string
  /** The remedy, from the same actionPlan the Datanets rows use. kind 'none' = no button. */
  action: ActionPlan
  /** Where to send the operator when there is no in-place remedy. */
  link?: 'datanets' | 'diagnostics'
}

/** Blocking codes, severity-mapped. `insufficient_funds` is the only one CRITICAL on its
 *  own: a node that cannot pay cannot do anything at all. The rest stop one datanet.
 *
 *  The upstream-outage codes (Reppo's API, an adapter's data source, a plain network blip) are
 *  WARNING, not critical: they cost the operator nothing, they clear on their own, and their
 *  card says so. They are still said out loud, because a datanet that earned nothing is news
 *  even when nobody is at fault. */
const CODE_SEVERITY: Partial<Record<ErrorCode, Severity>> = {
  insufficient_funds: 'critical',
  rpc_unavailable: 'warning',
  reppo_api_unavailable: 'warning',
  adapter_rate_limited: 'warning',
  llm_quota_exhausted: 'warning',
  network_unstable: 'warning',
  datanet_metadata_missing: 'warning',
  subnet_access_missing: 'warning',
  no_adapter: 'warning',
  model_unavailable: 'warning',
  scoring_failed: 'warning',
  cli_outdated: 'warning',
  unknown: 'warning',
}

/** Codes that mean "working as designed, nothing to do" — a datanet idle for these reasons
 *  is quiet, not broken, and must not be dressed up as a fault. */
const BENIGN: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['no_candidates', 'own_pod'])

export interface AlertInput {
  health: HealthDatanet[]
  config: StrategyConfig
  snapshot: Snapshot | null
  datanetPnl: DatanetPnl[]
  activity: ActivityRow[]
  series: NetSeries | null
  netNames: Record<string, string>
  now: number
}

const HOUR = 3_600_000
const DAY = 86_400_000

/** Blocked datanets sharing ONE cause collapse into one alert at this count. Two cards is a
 *  list; eleven is a wall that hides everything else on the screen. */
const GROUP_AT = 3

const label = (id: string, names: Record<string, string>): string => {
  const n = names[id]
  return n ? `${n} (datanet ${id})` : `Datanet ${id}`
}

/** A grouped card's body must not open by naming ONE datanet under a headline that says
 *  eleven. The backend's operatorMessage is written for a single subject ("Datanet 3 didn't
 *  respond — …"); swapping that subject for "Each one" keeps the backend's exact words, and
 *  its verb agreement, while addressing the whole group. */
export function forGroup(message: string, datanetId: string): string {
  const subject = `Datanet ${datanetId}`
  return message.startsWith(subject) ? `Each one${message.slice(subject.length)}` : message
}

/** Median, not mean: one anomalous gas spike must not move the estimate. */
function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Last EXECUTED action per datanet, from the activity window. The health payload carries no
 *  timestamps, so "idle for days" is only answerable from activity — this is the derivation. */
function lastExecutedByDatanet(activity: ActivityRow[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of activity) {
    if (r.status !== 'executed' || !r.datanetId) continue
    if (r.kind !== 'vote' && r.kind !== 'mint' && r.kind !== 'claim') continue
    const t = new Date(r.ts).getTime()
    if (!Number.isFinite(t)) continue
    const prev = out.get(r.datanetId)
    if (prev === undefined || t > prev) out.set(r.datanetId, t)
  }
  return out
}

/** The OLDEST row mentioning each datanet, of any kind (a skip counts — the node reached it
 *  and decided not to act). This bounds "it has done nothing for N" to a period this datanet
 *  actually existed for.
 *
 *  The old fallback — the age of the whole activity log — belonged to no datanet at all: a
 *  datanet added seconds ago on a node that has run for a month inherited the log's full age
 *  and was instantly alerted as "has done nothing for 30 days", a duration that never
 *  happened. The config carries no enabled-at timestamp, so where the log has never seen the
 *  datanet at all we say NOTHING rather than invent one. */
function firstSeenByDatanet(activity: ActivityRow[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of activity) {
    if (!r.datanetId) continue
    const t = new Date(r.ts).getTime()
    if (!Number.isFinite(t)) continue
    const prev = out.get(r.datanetId)
    if (prev === undefined || t < prev) out.set(r.datanetId, t)
  }
  return out
}

const days = (ms: number): string => {
  const d = ms / DAY
  if (d >= 1.5) return `${Math.round(d)} days`
  if (d >= 0.9) return 'a day'
  return `${Math.max(1, Math.round(ms / HOUR))} hours`
}

/**
 * Every condition worth interrupting an operator for, worst first.
 *
 * Conditions covered (each traced to a real field):
 *  - blocked datanet            → health[].classification.code (+ operatorMessage, suggestedAction)
 *  - datanet idle for days      → activity[] executed rows, per datanet + config.datanets[].vote/mint
 *  - budget cap spent           → snapshot.budget.{mintReppoSpent,*GasSpentEth} vs .caps.*
 *  - wallet too low to operate  → snapshot.balance.{eth,reppo} vs costs OBSERVED in activity[]
 *  - loss accelerating          → lossAcceleration() over /api/activity + /api/pnl
 */
export function deriveAlerts(input: AlertInput): Alert[] {
  const { health, config, snapshot, datanetPnl, activity, series, netNames, now } = input
  const alerts: Alert[] = []
  const cfgNets = config.datanets ?? {}
  const enabled = (id: string): boolean => {
    const d = cfgNets[id]
    return !!d && (d.vote || d.mint)
  }

  // ── 1. Datanets that cannot run ──────────────────────────────────────────────
  // The backend already classified the failure AND chose the remedy. We surface both,
  // verbatim (operatorMessage is plain English and redacted server-side).
  //
  // GROUPED BY CAUSE. On a real node a flaky RPC knocks out ELEVEN datanets at once, and
  // eleven near-identical cards is a wall an operator scrolls past — it buries the one
  // alert that is actually different. One cause, one alert, with the casualties named.
  //
  // GATED ON THE CONFIG, twice over:
  //  - a datanet the operator has switched OFF (or removed from the strategy entirely) keeps
  //    its skip rows in the 7-day health window for a week. Un-gated, doing exactly what the
  //    dashboard told them to do cleared nothing: the card came straight back on the next
  //    30s poll, with a remedy button that now writes to a datanet that is already off — or
  //    is not in the config at all — and reports "turned off" either way.
  //  - a datanet whose classification is stale (it has executed work SINCE the failure) is
  //    not broken. See recoveredDatanets().
  const recovered = recoveredDatanets(activity)
  const blockedIds = new Set<string>()
  const byCode = new Map<ErrorCode, HealthDatanet[]>()
  for (const h of health) {
    if (!enabled(h.datanetId)) continue // off, or gone: silence is what "off" means
    if (workState(h, recovered.has(h.datanetId)) !== 'blocked' || !h.classification) continue
    blockedIds.add(h.datanetId)
    const group = byCode.get(h.classification.code)
    if (group) group.push(h)
    else byCode.set(h.classification.code, [h])
  }

  for (const [code, hs] of byCode) {
    const c = hs[0].classification as Classification
    const severity = CODE_SEVERITY[code] ?? 'warning'

    if (hs.length < GROUP_AT) {
      for (const h of hs) {
        // The plan is per-datanet: a `disable` remedy is scoped by that datanet's own health
        // (mint-only vs the whole datanet), so the button cannot switch off a vote path that
        // is working — and earning — to fix a mint-side fault.
        alerts.push({
          id: `blocked:${h.datanetId}:${code}:${severity}`,
          severity,
          title: `${label(h.datanetId, netNames)} can't run`,
          detail: (h.classification as Classification).operatorMessage,
          datanetId: h.datanetId,
          action: actionPlan(h.classification, h),
        })
      }
      continue
    }

    // One shared cause. A bulk "turn them all off" button would be a destructive one-click
    // action on datanets the operator never inspected — so a grouped DISABLE degrades to a
    // link, and they choose. Every other remedy (fix the RPC, fund the wallet) is shared and
    // safe to offer once.
    const plan = actionPlan(c, hs[0])
    const names = hs.map((h) => h.datanetId).sort((a, b) => Number(a) - Number(b)).join(', ')
    alerts.push({
      // The count is in the key: a cause that grows from 3 casualties to 11 is a different,
      // worse situation, and a dismissal of the small version must not bury the big one.
      id: `blocked-group:${code}:${severity}:${hs.length}`,
      severity,
      title: `${hs.length} datanets can't run — same cause`,
      detail: `${forGroup(c.operatorMessage, hs[0].datanetId)} Affected datanets: ${names}.`,
      action: plan.kind === 'disable' ? { kind: 'none', label: '' } : plan,
      link: plan.kind === 'disable' ? 'datanets' : undefined,
    })
  }

  // ── 2. Datanets ENABLED but silent for a sustained period ────────────────────
  // The "broken for days and nothing told me" case. Only claimable as far back as the
  // window actually reaches, so the copy is bounded by the log we can see.
  const lastSeen = lastExecutedByDatanet(activity)
  const firstSeen = firstSeenByDatanet(activity)
  const cadenceMs = Math.max(1, config.cadenceHours ?? 1) * HOUR
  // Stale = silent for more than 6 cycles, and at least a day. A node on a 1h cadence that
  // missed one cycle is not news; one that has missed a day of them is.
  const staleAfter = Math.max(DAY, cadenceMs * 6)
  const healthById = new Map(health.map((h) => [h.datanetId, h]))

  for (const id of Object.keys(cfgNets)) {
    if (id === '*' || !enabled(id) || blockedIds.has(id)) continue
    const seen = lastSeen.get(id)
    // No executed row → measure from the datanet's OWN oldest row. A datanet the log has
    // never mentioned (just enabled, node hasn't reached it) gets NO alert: we would be
    // asserting a duration we cannot see.
    const start = seen ?? firstSeen.get(id)
    const silentFor = start === undefined ? null : now - start
    if (silentFor === null || silentFor < staleAfter) continue

    // A datanet with a BENIGN classification is quiet on purpose (nothing to vote on).
    // That is information, not a fault — and it must not be coloured like one.
    const code = healthById.get(id)?.classification?.code
    const benign = code !== undefined && BENIGN.has(code)
    const severity: Severity = benign ? 'info' : 'warning'
    alerts.push({
      // Severity in the key: benign-idle (info) can turn into genuinely dark (warning), and
      // a dismissal of the benign one must not bury it.
      id: `idle:${id}:${severity}`,
      severity,
      title: benign
        ? `${label(id, netNames)} has nothing to work on`
        : `${label(id, netNames)} has done nothing for ${days(silentFor)}`,
      detail: benign
        ? `It is switched on and healthy, but nothing has come up that meets your rules, so it has cast nothing in ${days(silentFor)}. It is not costing you anything.`
        : seen === undefined
          ? `It is switched on, and the node has been reaching it for ${days(silentFor)}, but it has never voted or minted once in that time. It is earning you nothing.`
          : `It is switched on, but its last vote or mint was ${days(silentFor)} ago. It is earning you nothing in the meantime.`,
      datanetId: id,
      action: { kind: 'none', label: '' },
      link: benign ? undefined : 'datanets',
    })
  }

  // ── 3. The operator's own caps, spent ────────────────────────────────────────
  // Not a fault — the node did what it was told and stopped. But an operator who does not
  // know their cap is spent thinks the node is broken.
  const budget = snapshot?.budget
  const caps = budget?.caps
  if (budget && caps) {
    const capChecks: { key: string; spent: number; max: number | undefined; what: string; unit: 'reppo' | 'eth' }[] = [
      { key: 'mint-reppo', spent: budget.mintReppoSpent, max: caps.mintReppoMax, what: 'mint budget', unit: 'reppo' },
      { key: 'vote-gas', spent: budget.voteGasSpentEth, max: caps.voteGasEthMax, what: 'voting gas budget', unit: 'eth' },
      { key: 'mint-gas', spent: budget.mintGasSpentEth, max: caps.mintGasEthMax, what: 'minting gas budget', unit: 'eth' },
      { key: 'claim-gas', spent: budget.claimGasSpentEth, max: caps.claimGasEthMax, what: 'claiming gas budget', unit: 'eth' },
    ]
    for (const c of capChecks) {
      if (!c.max || !Number.isFinite(c.max) || c.max <= 0) continue
      if (!Number.isFinite(c.spent)) continue
      const ratio = c.spent / c.max
      if (ratio < 0.9) continue
      const money = (n: number) => (c.unit === 'reppo' ? fmtReppo(n) : fmtEth(n))
      const spentAll = ratio >= 1
      alerts.push({
        id: `cap:${c.key}:${spentAll ? 'full' : 'near'}`,
        severity: spentAll ? 'warning' : 'info',
        title: spentAll ? `Your ${c.what} is spent` : `Your ${c.what} is nearly spent`,
        detail: spentAll
          ? `The node has used ${money(c.spent)} of its ${money(c.max)} cap and will not spend more here until you raise the cap or the budget horizon resets. Nothing is broken — this is your own limit.`
          : `The node has used ${money(c.spent)} of its ${money(c.max)} cap (${fmt(ratio * 100)}%). It stops when it reaches the cap.`,
        action: { kind: 'raise_budget', label: 'Raise spending caps' },
      })
    }
  }

  // ── 4. Can the wallet still pay? ─────────────────────────────────────────────
  // Derived from what this node has ACTUALLY paid, never from a hardcoded "low balance"
  // number. If the node has never paid for anything we cannot estimate — and we say nothing
  // rather than invent a threshold.
  const bal = snapshot?.balance
  const gasSamples = activity
    .filter((r) => r.status === 'executed')
    .map((r) => r.gasEth)
    .filter((g): g is number => typeof g === 'number' && Number.isFinite(g) && g > 0)
  const medGas = median(gasSamples)

  if (bal && typeof bal.eth === 'number' && medGas !== null && medGas > 0) {
    const txLeft = bal.eth / medGas
    // Under ~50 transactions of gas is roughly a day of a busy node. The COUNT is what we
    // show; the threshold only decides whether to speak.
    if (txLeft < 50) {
      // Severity in the key — this is THE condition that escalates (warning → critical as the
      // runway runs out), and the one an operator is most likely to dismiss with "I'll top it
      // up at the weekend".
      const severity: Severity = txLeft < 10 ? 'critical' : 'warning'
      alerts.push({
        id: `wallet:eth:${severity}`,
        severity,
        title: 'The wallet is running out of gas',
        detail: `It holds ${fmtEth(bal.eth)} — about ${fmtCount(txLeft)} more transactions at the gas prices this node has actually been paying (${fmtEth(medGas)} each). When it runs out, the node stops voting, minting and claiming. Only you can top it up; the dashboard holds no keys.`,
        action: { kind: 'explain_funding', label: 'How to fix' },
      })
    }
  }

  // REPPO: only meaningful if the node still mints somewhere. A vote-only node spends no
  // REPPO at all, so a low REPPO balance is not an alert for it.
  const mintsOn = Object.entries(cfgNets).some(([id, d]) => id !== '*' && d.mint)
  if (bal && mintsOn && typeof bal.reppo === 'number') {
    const minted = datanetPnl.filter((p) => p.mintsExecuted > 0)
    const totalMints = minted.reduce((s, p) => s + p.mintsExecuted, 0)
    const totalSpent = minted.reduce((s, p) => s + p.reppoSpent, 0)
    // No mint has ever been paid for → no observed fee → NO estimate, and NO alert.
    if (totalMints > 0) {
      const avgFee = totalSpent / totalMints
      if (avgFee > 0 && bal.reppo < avgFee) {
        alerts.push({
          id: 'wallet:reppo:critical',
          severity: 'critical',
          title: 'The wallet cannot afford another mint',
          detail: `It holds ${fmtReppo(bal.reppo)}, and this node's mints have cost ${fmtReppo(avgFee)} on average (${fmtCount(totalMints)} paid so far). Minting will fail until you send it more REPPO. Voting is unaffected — it costs no REPPO.`,
          action: { kind: 'explain_funding', label: 'How to fix' },
        })
      }
    }
  }

  // ── 5. Losing money FASTER than before ───────────────────────────────────────
  // The one thing a point-in-time net cannot tell you. Never fires on a profitable node.
  const accel = lossAcceleration(series)
  if (accel?.accelerating && series) {
    alerts.push({
      id: 'loss:accelerating:critical',
      severity: 'critical',
      title: 'The loss is getting worse',
      detail: `The node is now losing about ${fmtReppo(-accel.recentPerDay)} per day, up from ${fmtReppo(-Math.min(accel.earlierPerDay, 0))} per day earlier in this window. Net so far: ${fmtReppo(series.current)}.`,
      action: { kind: 'none', label: '' },
      link: 'datanets',
    })
  }

  // Worst first; ties broken deterministically so the list never reshuffles under a poll.
  return alerts.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.id.localeCompare(b.id),
  )
}

/** Header badge: the count that must be visible from every tab. The worst severity present
 *  drives the colour. */
export function alertSummary(alerts: Alert[]): { count: number; worst: Severity | null } {
  if (alerts.length === 0) return { count: 0, worst: null }
  const worst = alerts.reduce<Severity>(
    (w, a) => (SEVERITY_RANK[a.severity] < SEVERITY_RANK[w] ? a.severity : w),
    'info',
  )
  return { count: alerts.length, worst }
}
