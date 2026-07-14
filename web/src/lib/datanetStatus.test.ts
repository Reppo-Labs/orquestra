import { describe, expect, it } from 'vitest'
import {
  actionPlan, applyDisable, coverage, disableScope, emissionsStarted, isLosing, losingDatanets,
  nextAction, pendingByDatanet, recoveredDatanets, voteSharePct, workState,
} from './datanetStatus'
import type { ActivityRow, Classification, DatanetEntry, DatanetPnl, HealthDatanet, Snapshot } from '../api'

const health = (id: string, idle: boolean, c?: Classification, votesExecuted?: number): HealthDatanet => ({
  datanetId: id,
  votes: { executed: votesExecuted ?? (idle ? 0 : 3), refused: 0, error: 0 },
  mints: { executed: 0, refused: 0, error: 0 },
  topErrors: [],
  idle,
  classification: c,
})

const cls = (code: Classification['code'], suggestedAction: Classification['suggestedAction']): Classification =>
  ({ code, operatorMessage: `plain english about ${code}`, suggestedAction })

const pnl = (p: Partial<DatanetPnl> & { datanetId: string }): DatanetPnl => ({
  reppoSpent: 0, reppoEarned: 0, net: 0, roi: null, votesCast: 0, mintsExecuted: 0, ...p,
})

const dn = (o: Partial<DatanetEntry> = {}): DatanetEntry => ({ vote: true, mint: false, strictness: 'balanced', ...o })

/** A config, as a record — coverage's denominator is the ENABLED datanets, not a bare id list. */
const cfg = (ids: string[], over: Record<string, Partial<DatanetEntry>> = {}): Record<string, DatanetEntry> =>
  Object.fromEntries(ids.map((id) => [id, dn(over[id])]))

describe('workState', () => {
  it('calls an RPC failure blocked even while some votes went through', () => {
    expect(workState(health('1', false, cls('rpc_unavailable', 'check_rpc')))).toBe('blocked')
  })

  it('separates "hit YOUR cap" from "broken" — a capped datanet is not a fault', () => {
    expect(workState(health('7', true, cls('budget_exhausted', 'raise_budget')))).toBe('capped')
  })

  it('treats "found nothing good enough" as quiet, not broken', () => {
    expect(workState(health('9', true, cls('no_candidates', 'none')))).toBe('quiet')
  })

  it('is unknown with no telemetry at all — never a silent "working"', () => {
    expect(workState(undefined)).toBe('unknown')
  })

  it('is working when it ran and nothing classified it', () => {
    expect(workState(health('5', false))).toBe('working')
  })

  it('drops a STALE classification: a datanet that has worked since is not blocked', () => {
    // The 7-day health window still carries a transient RPC error from six days ago, and the
    // server attaches it regardless of the 300 votes executed since. Reporting that datanet as
    // "can't run" understates coverage, raises a false alert, and offers to turn OFF a datanet
    // that is earning.
    expect(workState(health('4', false, cls('rpc_unavailable', 'check_rpc')), true)).toBe('working')
  })
})

describe('recoveredDatanets — which failures are HISTORY', () => {
  const row = (datanetId: string, kind: ActivityRow['kind'], status: string, ts: string): ActivityRow =>
    ({ datanetId, kind, status, ts })

  it('recovers a datanet whose newest row is executed work', () => {
    const a = [
      row('4', 'vote', 'executed', '2026-07-12T10:00:00Z'), // newest
      row('4', 'skip', 'skipped', '2026-07-06T10:00:00Z'),
    ]
    expect(recoveredDatanets(a).has('4')).toBe(true)
  })

  it('does NOT recover a datanet still failing — its newest row is the skip', () => {
    const a = [
      row('4', 'skip', 'skipped', '2026-07-12T10:00:00Z'), // newest
      row('4', 'vote', 'executed', '2026-07-06T10:00:00Z'),
    ]
    expect(recoveredDatanets(a).has('4')).toBe(false)
  })

  it('does not recover a datanet whose newest row is an ERRORED transaction', () => {
    const a = [row('4', 'mint', 'error', '2026-07-12T10:00:00Z')]
    expect(recoveredDatanets(a).has('4')).toBe(false)
  })
})

describe('coverage', () => {
  // The live node: most datanets knocked out by a flaky RPC.
  const datanets = cfg(['1', '2', '5', '7', '9'])
  const hs = [
    health('1', true, cls('rpc_unavailable', 'check_rpc')),
    health('2', true, cls('rpc_unavailable', 'check_rpc')),
    health('5', false),
    health('7', true, cls('budget_exhausted', 'raise_budget')), // capped = worked, then hit the ceiling
    health('9', true, cls('no_candidates', 'none')),
  ]

  it('counts working datanets and names how many need the operator', () => {
    expect(coverage(datanets, hs)).toEqual({ working: 2, total: 5, blocked: 2, capped: 1, off: 0 })
  })

  it('keeps a configured-but-never-reached datanet in the denominator', () => {
    // datanet 20 produced no health entry at all — it must not vanish from "X of Y".
    const withNew = { ...datanets, '20': dn() }
    expect(coverage(withNew, hs).total).toBe(6)
    expect(coverage(withNew, hs).working).toBe(2)
  })

  it('takes a switched-OFF datanet OUT of the denominator and reports it separately', () => {
    // The operator turned 6 and 7 off — often on this dashboard's own advice. Keeping them in
    // the denominator means the number can never reach N of N, and following the remedy makes
    // the node look no better.
    const withOff = { ...datanets, '6': dn({ vote: false, mint: false }), '7': dn({ vote: false, mint: false }) }
    const c = coverage(withOff, hs)
    expect(c.total).toBe(4)
    expect(c.off).toBe(2)
    expect(c.capped).toBe(0) // 7 is off — it is not "at your cap", it is not running at all
  })

  it('does not count a switched-off datanet as BLOCKED — its old skips are not a live fault', () => {
    // Doing exactly what the dashboard said (turn it off) must clear the warning, not leave
    // "1 needs your attention" on Home for the 7 days the skip rows stay in the window.
    const off = { '1': dn({ vote: false, mint: false }) }
    expect(coverage(off, [health('1', true, cls('datanet_metadata_missing', 'disable_datanet'))]).blocked).toBe(0)
  })

  it('does not count a RECOVERED datanet as blocked', () => {
    expect(coverage(cfg(['1']), [health('1', false, cls('rpc_unavailable', 'check_rpc'))], new Set(['1'])))
      .toEqual({ working: 1, total: 1, blocked: 0, capped: 0, off: 0 })
  })
})

describe('actionPlan — every backend suggestedAction reaches a control', () => {
  it('scopes a MINT-ONLY fault to publishing — voting still earns and must not be killed', () => {
    // no_adapter is raised while the vote path is running fine; the backend's own message says
    // "voting still works". A button that then turns voting off destroys the operator's income.
    const plan = actionPlan(cls('no_adapter', 'disable_datanet'), health('7', false))
    expect(plan).toEqual({ kind: 'disable', label: 'Turn publishing off', scope: 'mint' })
  })

  it('scopes to the WHOLE datanet when nothing about it works', () => {
    const dead = health('4', true, undefined, 0) // no executed votes at all
    const plan = actionPlan(cls('datanet_metadata_missing', 'disable_datanet'), dead)
    expect(plan).toEqual({ kind: 'disable', label: 'Turn this datanet off', scope: 'all' })
  })

  it('keeps voting alive when the datanet demonstrably votes, whatever else is broken', () => {
    const voting = health('4', false, undefined, 12)
    expect(disableScope('datanet_metadata_missing', voting)).toBe('mint')
    expect(disableScope('datanet_metadata_missing', undefined)).toBe('all')
  })

  it('maps raise_budget to the spending caps', () => {
    expect(actionPlan(cls('budget_exhausted', 'raise_budget')).kind).toBe('raise_budget')
  })
  it('maps check_rpc to an explanation (the dashboard holds no secrets and cannot fix RPC)', () => {
    expect(actionPlan(cls('rpc_unavailable', 'check_rpc')).kind).toBe('explain_rpc')
  })
  it('maps check_model_quota to its OWN explanation — never to explain_rpc', () => {
    // The seventh action. An exhausted LLM quota is fixed at the model provider; routing it to
    // explain_rpc (which is what the backend's misclassification did) told the operator to
    // replace an RPC endpoint that was working perfectly.
    const plan = actionPlan(cls('llm_quota_exhausted', 'check_model_quota'))
    expect(plan.kind).toBe('explain_model_quota')
    expect(plan.kind).not.toBe('explain_rpc')
    expect(plan.label).toBe('How to fix') // a real button, not a dead end
  })
  it('maps fund_wallet to an explanation — the easy one to forget', () => {
    expect(actionPlan(cls('insufficient_funds', 'fund_wallet')).kind).toBe('explain_funding')
  })
  it('maps retry to run-now — including the upstream outages that clear on their own', () => {
    expect(actionPlan(cls('unknown', 'retry')).kind).toBe('retry')
    expect(actionPlan(cls('reppo_api_unavailable', 'retry')).kind).toBe('retry')
    expect(actionPlan(cls('adapter_rate_limited', 'retry')).kind).toBe('retry')
    expect(actionPlan(cls('network_unstable', 'retry')).kind).toBe('retry')
  })
  it('every backend suggestedAction reaches a control — no action falls through to none', () => {
    const actions = ['retry', 'disable_datanet', 'raise_budget', 'check_rpc', 'check_model_quota', 'fund_wallet'] as const
    for (const a of actions) {
      expect(actionPlan(cls('unknown', a)).kind).not.toBe('none')
    }
  })
  it('gives "none" NO button rather than a dead one', () => {
    expect(actionPlan(cls('no_candidates', 'none'))).toEqual({ kind: 'none', label: '' })
    expect(actionPlan(undefined).kind).toBe('none')
  })
})

describe('applyDisable — the remedy does exactly what its label says', () => {
  it('mint scope stops the SPEND and leaves the earning path running', () => {
    const d = dn({ vote: true, mint: true })
    applyDisable(d, 'mint')
    expect(d).toMatchObject({ vote: true, mint: false })
  })
  it('all scope stops the datanet entirely', () => {
    const d = dn({ vote: true, mint: true })
    applyDisable(d, 'all')
    expect(d).toMatchObject({ vote: false, mint: false })
  })
})

describe('losing datanets — emissions lag, and a lag is not a loss', () => {
  // The live node's most actionable fact: datanet 11 spent 5,200 REPPO over 28 mints for 0 back.
  const rows: DatanetPnl[] = [
    pnl({ datanetId: '11', reppoSpent: 5200, reppoEarned: 0, net: -5200, roi: 0, mintsExecuted: 28, votesCast: 11 }),
    pnl({ datanetId: '2', reppoSpent: 4470, reppoEarned: 0.0017, net: -4469.99, roi: 0, mintsExecuted: 45 }),
    pnl({ datanetId: '5', reppoEarned: 0.645, net: 0.645, votesCast: 99 }), // vote-only: earns, spends nothing
    pnl({ datanetId: '1', votesCast: 35 }), // vote-only, earned nothing — idle, NOT losing
  ]
  const started = { started: true }

  it('only counts a datanet as losing when it actually SPENT and is down on the deal', () => {
    expect(isLosing(rows[0], started)).toBe(true)
    expect(isLosing(rows[3], started)).toBe(false) // 0 spend, 0 earned → nothing to stop
  })

  it('ranks the worst loss first', () => {
    expect(losingDatanets(rows, started).map((r) => r.datanetId)).toEqual(['11', '2'])
  })

  it('gives NO verdict before the node has ever been paid — a fresh mint has not had time to pay', () => {
    // The failure this prevents: a brand-new node mints once for 180 REPPO, emissions are ~an
    // epoch away, and Home tells the operator to stop minting there — directly below a banner
    // that says "No earnings yet — too early to tell".
    const fresh = [pnl({ datanetId: '2', reppoSpent: 180, net: -180, mintsExecuted: 1 })]
    expect(losingDatanets(fresh, { started: false })).toEqual([])
    expect(isLosing(fresh[0], { started: false })).toBe(false)
  })

  it('credits the emissions a datanet is ALREADY OWED before calling it a loss-maker', () => {
    const p = [pnl({ datanetId: '2', reppoSpent: 180, net: -180, mintsExecuted: 1 })]
    // 200 REPPO due on-chain but not yet claimed → the datanet is up, not down.
    expect(losingDatanets(p, { started: true, pending: { '2': 200 } })).toEqual([])
    // 100 due → still down 80, and still worth telling them.
    expect(losingDatanets(p, { started: true, pending: { '2': 100 } }).map((r) => r.datanetId)).toEqual(['2'])
  })

  it('reads pending emissions per datanet straight off the snapshot', () => {
    const s = {
      emissionsDue: { pods: [
        { podId: 'a', datanetId: '2', epoch: 1, reppo: 120 },
        { podId: 'b', datanetId: '2', epoch: 1, reppo: 80 },
        { podId: 'c', datanetId: '9', epoch: 1, reppo: 5 },
      ] },
    } as unknown as Snapshot
    expect(pendingByDatanet(s)).toEqual({ '2': 200, '9': 5 })
    expect(pendingByDatanet(null)).toEqual({})
  })

  it('knows whether emissions have started arriving at all', () => {
    expect(emissionsStarted({ claimedReppo: 0, claimableReppo: 0 })).toBe(false)
    expect(emissionsStarted({ claimedReppo: 0, claimableReppo: 900 })).toBe(true)
    expect(emissionsStarted({ claimedReppo: 8383, claimableReppo: 0 })).toBe(true)
    expect(emissionsStarted(null)).toBe(false)
  })
})

describe('nextAction — exactly one thing to do', () => {
  const cov = { working: 5, total: 5, blocked: 0, capped: 0, off: 0 }
  const worst = [pnl({ datanetId: '11', reppoSpent: 5200, net: -5200, mintsExecuted: 28 })]
  const quiet = { total: 0, critical: 0 }

  it('puts resuming a paused node above everything else', () => {
    const a = nextAction({ paused: true, losing: worst, cov, hasRun: true, alerts: quiet })
    expect(a.kind).toBe('resume')
    expect(a.headline).toMatch(/paused/i)
  })

  it('leads with the money-losing datanet and names it', () => {
    const a = nextAction({ paused: false, losing: worst, cov, hasRun: true, alerts: quiet })
    expect(a.kind).toBe('stop_minting')
    expect(a.datanetId).toBe('11')
    expect(a.detail).toContain('28 mints')
    expect(a.cta).toBe('Stop minting there')
  })

  it('falls to blocked datanets when nothing is losing money', () => {
    const a = nextAction({ paused: false, losing: [], cov: { ...cov, blocked: 3 }, hasRun: true, alerts: quiet })
    expect(a.kind).toBe('fix_blocked')
    expect(a.headline).toBe("3 datanets can't run")
  })

  it('offers a cycle on a node that has never run', () => {
    expect(nextAction({ paused: false, losing: [], cov, hasRun: false, alerts: quiet }).kind).toBe('wait')
  })

  it('suggests raising caps only once nothing is broken or bleeding', () => {
    const a = nextAction({ paused: false, losing: [], cov: { ...cov, capped: 2 }, hasRun: true, alerts: quiet })
    expect(a.kind).toBe('raise_budget')
  })

  it('says so plainly when there is nothing to do — and offers no button', () => {
    const a = nextAction({ paused: false, losing: [], cov, hasRun: true, alerts: quiet })
    expect(a.kind).toBe('none')
    expect(a.cta).toBe('')
  })

  it('NEVER says "nothing needs your attention" while a CRITICAL alert is live', () => {
    // The wallet is nearly out of gas: nothing is blocked, nothing is losing, nothing is
    // capped. The old logic never saw the alert set and reassured the operator, in plain
    // English, that they could close the tab — with the critical card on the same screen.
    const a = nextAction({ paused: false, losing: [], cov, hasRun: true, alerts: { total: 1, critical: 1 } })
    expect(a.kind).toBe('alerts')
    expect(a.headline).toMatch(/needs? you now/i)
    expect(a.detail).not.toMatch(/you do not need to be here/i)
  })

  it('outranks a losing datanet with a critical alert — a dead wallet stops everything', () => {
    const a = nextAction({ paused: false, losing: worst, cov, hasRun: true, alerts: { total: 2, critical: 1 } })
    expect(a.kind).toBe('alerts')
  })

  it('does not claim "nothing" while a non-critical alert is still open', () => {
    const a = nextAction({ paused: false, losing: [], cov, hasRun: true, alerts: { total: 2, critical: 0 } })
    expect(a.kind).toBe('alerts')
    expect(a.headline).toBe('2 things need your attention')
  })
})

describe('voteSharePct — the weight in plain words', () => {
  it('turns a bare weight into the share of the cycle it actually buys', () => {
    const datanets = { '1': dn({ voteShare: 3 }), '2': dn({ voteShare: 1 }), '*': dn({ vote: false }) }
    expect(voteSharePct('1', datanets)).toBe(75)
    expect(voteSharePct('2', datanets)).toBe(25)
  })

  it('treats a missing weight as the schema default of 1', () => {
    const datanets = { '1': dn({}), '2': dn({}) }
    expect(voteSharePct('1', datanets)).toBe(50)
  })

  it('gives a non-voting datanet no share at all — null, not a misleading 0%', () => {
    expect(voteSharePct('1', { '1': dn({ vote: false }), '2': dn({}) })).toBeNull()
  })
})
