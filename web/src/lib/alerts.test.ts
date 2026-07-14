import { describe, expect, it } from 'vitest'
import { alertSummary, deriveAlerts, forGroup, SEVERITY_RANK, type AlertInput } from './alerts'
import { buildNetSeries } from './pnlSeries'
import type { ActivityRow, Classification, DatanetEntry, HealthDatanet, Pnl, Snapshot } from '../api'

// Three failure modes this file exists to prevent:
//  1. SILENCE — the node is broken for days and the dashboard says nothing.
//  2. NOISE — alerts invented from conditions the payloads cannot support, or raised about
//     datanets the operator has already switched off on this dashboard's own advice.
//  3. BURIAL — a dismissal taken against a mild condition hiding the severe one it became.

const NOW = Date.parse('2026-07-12T12:00:00.000Z')
const ago = (ms: number): string => new Date(NOW - ms).toISOString()
const HOUR = 3_600_000
const DAY = 86_400_000

const dn = (o: Partial<DatanetEntry> = {}): DatanetEntry => ({ vote: true, mint: false, strictness: 'balanced', ...o })
/** A datanet is only ALERTABLE if it is switched on — every blocked test needs it in the config. */
const on = (...ids: string[]): Record<string, DatanetEntry> =>
  Object.fromEntries(ids.map((id) => [id, dn()]))

const input = (over: Partial<AlertInput> = {}): AlertInput => ({
  health: [],
  config: { cadenceHours: 1, datanets: {} },
  snapshot: null,
  datanetPnl: [],
  activity: [],
  series: null,
  netNames: {},
  now: NOW,
  ...over,
})

const cls = (over: Partial<Classification> = {}): Classification => ({
  code: 'rpc_unavailable',
  operatorMessage: "Datanet 5 didn't respond — the network endpoint looks unstable.",
  suggestedAction: 'check_rpc',
  ...over,
})

const health = (over: Partial<HealthDatanet> = {}): HealthDatanet => ({
  datanetId: '5',
  votes: { executed: 0, refused: 0, error: 0 },
  mints: { executed: 0, refused: 0, error: 0 },
  topErrors: [],
  idle: true,
  ...over,
})

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  ts: NOW,
  balance: { reppo: 2000, veReppo: 0, eth: 1 },
  emissionsDue: { pods: [] },
  ...over,
})

const pnl = (netReppo: number, spentReppo = 0): Pnl =>
  ({ netReppo, earnedReppo: 0, claimedReppo: 0, claimableReppo: 0, spentReppo, gasSpentEth: 0 })

/** An executed vote — the row that proves a datanet is alive. */
const vote = (datanetId: string, at: string, gasEth = 0.000001): ActivityRow =>
  ({ ts: at, kind: 'vote', status: 'executed', datanetId, gasEth })
/** A skip — the row that proves it is not. */
const skip = (datanetId: string, at: string): ActivityRow =>
  ({ ts: at, kind: 'skip', status: 'skipped', datanetId })

describe('deriveAlerts — a broken datanet', () => {
  it("raises the backend's own classification, verbatim, with its own remedy", () => {
    const a = deriveAlerts(input({
      config: { cadenceHours: 1, datanets: on('5') },
      health: [health({ classification: cls() })],
      activity: [skip('5', ago(HOUR))],
      netNames: { '5': 'Robot video' },
    }))
    expect(a).toHaveLength(1)
    expect(a[0].severity).toBe('warning')
    expect(a[0].id).toBe('blocked:5:rpc_unavailable:warning') // severity in the key — it escalates
    expect(a[0].title).toContain('Robot video (datanet 5)')
    expect(a[0].detail).toBe(cls().operatorMessage) // never re-worded, never raw stderr
    expect(a[0].action).toEqual({ kind: 'explain_rpc', label: 'How to fix' }) // === actionPlan()
  })

  it('treats a wallet that cannot pay as CRITICAL, not as one more broken datanet', () => {
    const a = deriveAlerts(input({
      config: { cadenceHours: 1, datanets: on('5') },
      health: [health({ classification: cls({ code: 'insufficient_funds', suggestedAction: 'fund_wallet' }) })],
      activity: [skip('5', ago(HOUR))],
    }))
    expect(a[0].severity).toBe('critical')
    expect(a[0].action.kind).toBe('explain_funding')
  })

  it('scopes a MINT-side fault to publishing — the remedy must not kill a working vote path', () => {
    // no_adapter is raised while the datanet's votes are executing fine, and the backend's own
    // message says "voting still works". The button used to turn voting off too.
    const a = deriveAlerts(input({
      config: { cadenceHours: 1, datanets: { '7': dn({ vote: true, mint: true }) } },
      health: [health({
        datanetId: '7', idle: false,
        votes: { executed: 12, refused: 0, error: 0 },
        classification: cls({
          code: 'no_adapter',
          suggestedAction: 'disable_datanet',
          operatorMessage: 'Datanet 7 is set to publish data, but this node has no data source for it. Turn publishing off for this datanet (voting still works).',
        }),
      })],
      activity: [skip('7', ago(HOUR))],
    }))
    expect(a[0].action).toEqual({ kind: 'disable', label: 'Turn publishing off', scope: 'mint' })
  })

  it('says NOTHING about a datanet the operator already switched off', () => {
    // The remedy worked. The skip rows stay in the 7-day window regardless, so an ungated
    // alert reappears on every 30s poll with a button that now writes nothing — and the
    // operator can click it forever.
    const a = deriveAlerts(input({
      config: { cadenceHours: 1, datanets: { '5': dn({ vote: false, mint: false }) } },
      health: [health({ classification: cls({ code: 'datanet_metadata_missing', suggestedAction: 'disable_datanet' }) })],
      activity: [skip('5', ago(2 * HOUR))],
    }))
    expect(a).toEqual([])
  })

  it('says nothing about a datanet that is no longer in the strategy at all', () => {
    const a = deriveAlerts(input({
      config: { cadenceHours: 1, datanets: {} },
      health: [health({ classification: cls() })],
      activity: [skip('5', ago(2 * HOUR))],
    }))
    expect(a).toEqual([])
  })

  it('says nothing about a datanet that has RECOVERED — one blip does not last 7 days', () => {
    // Datanet 4 hit a transient RPC error six days ago and has executed 300 votes since. The
    // server still attaches the old classification; the activity log says it is fine.
    const a = deriveAlerts(input({
      config: { cadenceHours: 1, datanets: on('4') },
      health: [health({ datanetId: '4', idle: false, classification: cls() })],
      activity: [vote('4', ago(HOUR)), skip('4', ago(6 * DAY))],
    }))
    expect(a).toEqual([])
  })

  it('collapses many datanets felled by ONE cause into a single alert, naming them', () => {
    // The live failure mode: a flaky RPC knocks out 11 datanets at once. Eleven identical
    // cards is a wall the operator scrolls past — and it buries the alert that IS different.
    const ids = ['1', '2', '5', '6']
    const a = deriveAlerts(input({
      config: { cadenceHours: 1, datanets: on(...ids) },
      health: ids.map((id) => health({ datanetId: id, classification: cls() })),
      activity: ids.map((id) => skip(id, ago(HOUR))),
    }))
    expect(a).toHaveLength(1)
    expect(a[0].id).toBe('blocked-group:rpc_unavailable:warning:4') // size in the key: 4 → 11 is worse
    expect(a[0].title).toBe("4 datanets can't run — same cause")
    expect(a[0].detail).toMatch(/affected datanets: 1, 2, 5, 6\./i)
    expect(a[0].action.kind).toBe('explain_rpc') // the shared remedy, offered once
  })

  it('does not open a card about ELEVEN datanets by naming ONE of them', () => {
    const ids = ['3', '5', '7']
    const a = deriveAlerts(input({
      config: { cadenceHours: 1, datanets: on(...ids) },
      health: ids.map((id) => health({
        datanetId: id,
        classification: cls({ operatorMessage: `Datanet ${id} didn't respond — the network endpoint this node reads from looks unstable.` }),
      })),
      activity: ids.map((id) => skip(id, ago(HOUR))),
    }))
    expect(a[0].detail).toMatch(/^Each one didn't respond/)
    expect(a[0].detail).not.toMatch(/^Datanet 3/)
  })

  it('keeps a couple of failures as separate cards — two is a list, not a wall', () => {
    const a = deriveAlerts(input({
      config: { cadenceHours: 1, datanets: on('1', '2') },
      health: ['1', '2'].map((id) => health({ datanetId: id, classification: cls() })),
      activity: [skip('1', ago(HOUR)), skip('2', ago(HOUR))],
    }))
    expect(a).toHaveLength(2)
    expect(a.every((x) => x.id.startsWith('blocked:'))).toBe(true)
  })

  it('never offers a one-click BULK disable — the operator picks which to turn off', () => {
    const ids = ['1', '2', '5']
    const a = deriveAlerts(input({
      config: { cadenceHours: 1, datanets: on(...ids) },
      health: ids.map((id) =>
        health({ datanetId: id, classification: cls({ code: 'no_adapter', suggestedAction: 'disable_datanet' }) })),
      activity: ids.map((id) => skip(id, ago(HOUR))),
    }))
    expect(a[0].id).toBe('blocked-group:no_adapter:warning:3')
    expect(a[0].action.kind).toBe('none') // NOT a bulk destructive action
    expect(a[0].link).toBe('datanets')
  })

  it('groups by CAUSE, so a different failure is never hidden inside a crowd', () => {
    const a = deriveAlerts(input({
      config: { cadenceHours: 1, datanets: on('1', '2', '5', '9') },
      health: [
        ...['1', '2', '5'].map((id) => health({ datanetId: id, classification: cls() })),
        health({ datanetId: '9', classification: cls({ code: 'insufficient_funds', suggestedAction: 'fund_wallet' }) }),
      ],
      activity: ['1', '2', '5', '9'].map((id) => skip(id, ago(HOUR))),
    }))
    expect(a).toHaveLength(2)
    expect(a[0].severity).toBe('critical') // the one that is different, first
    expect(a[0].datanetId).toBe('9')
    expect(a[1].id).toBe('blocked-group:rpc_unavailable:warning:3')
  })

  it('does not raise a datanet that is merely quiet (no_candidates is working as designed)', () => {
    const a = deriveAlerts(input({
      health: [health({ classification: cls({ code: 'no_candidates', suggestedAction: 'none' }) })],
      config: { cadenceHours: 1, datanets: on('5') },
      activity: [vote('5', ago(2 * HOUR))],
    }))
    expect(a).toEqual([])
  })
})

describe('forGroup — one message, many subjects', () => {
  it('swaps the single subject for the group, keeping the backend\'s words and its verbs', () => {
    expect(forGroup("Datanet 3 didn't respond — the endpoint looks unstable.", '3'))
      .toBe("Each one didn't respond — the endpoint looks unstable.")
    expect(forGroup("Datanet 4's creator never published the rules this node needs.", '4'))
      .toBe("Each one's creator never published the rules this node needs.")
  })
  it('leaves a message it does not recognise alone rather than mangling it', () => {
    expect(forGroup('Something else entirely.', '3')).toBe('Something else entirely.')
  })
})

describe('deriveAlerts — silent for days', () => {
  const cfg = { cadenceHours: 1, datanets: on('8') }

  it('raises an enabled datanet that has been reached for days and done nothing', () => {
    const a = deriveAlerts(input({
      config: cfg,
      // The node has been REACHING datanet 8 for 4 days (skips), and it has never acted.
      activity: [skip('8', ago(4 * DAY)), skip('8', ago(HOUR)), vote('2', ago(HOUR))],
    }))
    expect(a).toHaveLength(1)
    expect(a[0].id).toBe('idle:8:warning')
    expect(a[0].severity).toBe('warning')
    expect(a[0].detail).toMatch(/never voted or minted once/i)
  })

  it('raises an enabled datanet whose last action is stale', () => {
    const a = deriveAlerts(input({ config: cfg, activity: [vote('8', ago(3 * DAY))] }))
    expect(a[0].id).toBe('idle:8:warning')
    expect(a[0].title).toMatch(/has done nothing for 3 days/i)
  })

  it('never claims a duration for a datanet the log has never seen — a fresh one is not "30 days" idle', () => {
    // A node that has run for 30 days. The operator adds datanet 9 and saves. Before the first
    // cycle even reaches it, the old code claimed: "Datanet 9 has done nothing for 30 days".
    const a = deriveAlerts(input({
      config: { cadenceHours: 1, datanets: on('9') },
      activity: [vote('2', ago(30 * DAY)), vote('2', ago(HOUR))],
    }))
    expect(a).toEqual([])
  })

  it('stays quiet for a datanet that acted recently', () => {
    expect(deriveAlerts(input({ config: cfg, activity: [vote('8', ago(2 * HOUR))] }))).toEqual([])
  })

  it('stays quiet for a datanet that is switched OFF — silence is what "off" means', () => {
    const a = deriveAlerts(input({
      config: { cadenceHours: 1, datanets: { '8': dn({ vote: false, mint: false }) } },
      activity: [skip('8', ago(4 * DAY))],
    }))
    expect(a).toEqual([])
  })

  it('downgrades to INFO when the node explains the silence benignly', () => {
    const a = deriveAlerts(input({
      config: cfg,
      health: [health({ datanetId: '8', classification: cls({ code: 'no_candidates', suggestedAction: 'none' }) })],
      activity: [skip('8', ago(4 * DAY))],
    }))
    expect(a[0].severity).toBe('info')
    expect(a[0].id).toBe('idle:8:info') // …and a different key from the warning it can become
    expect(a[0].title).toMatch(/nothing to work on/i)
  })

  it('does not double-report a datanet already reported as BLOCKED', () => {
    const a = deriveAlerts(input({
      config: { cadenceHours: 1, datanets: on('5') },
      health: [health({ datanetId: '5', classification: cls() })],
      activity: [skip('5', ago(4 * DAY))],
    }))
    expect(a).toHaveLength(1)
    expect(a[0].id).toMatch(/^blocked:/)
  })
})

describe("deriveAlerts — the operator's own caps", () => {
  const budget = (mintReppoSpent: number) => ({
    mintReppoSpent, voteGasSpentEth: 0, mintGasSpentEth: 0, claimGasSpentEth: 0,
    caps: { mintReppoMax: 1000 },
  })

  it('says so when the mint budget is spent — and offers to raise it', () => {
    const a = deriveAlerts(input({ snapshot: snap({ budget: budget(1000) }) }))
    expect(a).toHaveLength(1)
    expect(a[0].id).toBe('cap:mint-reppo:full')
    expect(a[0].severity).toBe('warning') // the operator's own limit is not a fault
    expect(a[0].detail).toMatch(/nothing is broken — this is your own limit/i)
    expect(a[0].action.kind).toBe('raise_budget')
  })

  it('gives fair warning before the cap bites', () => {
    const a = deriveAlerts(input({ snapshot: snap({ budget: budget(950) }) }))
    expect(a[0].id).toBe('cap:mint-reppo:near')
    expect(a[0].severity).toBe('info')
  })

  it('is silent well under the cap', () => {
    expect(deriveAlerts(input({ snapshot: snap({ budget: budget(215) }) }))).toEqual([])
  })
})

describe('deriveAlerts — can the wallet still pay?', () => {
  it('estimates the gas runway from the gas this node has ACTUALLY paid', () => {
    const a = deriveAlerts(input({
      snapshot: snap({ balance: { reppo: 2000, veReppo: 0, eth: 0.00002 } }),
      activity: [vote('2', ago(HOUR), 0.000001), vote('2', ago(2 * HOUR), 0.000001)],
    }))
    const gas = a.find((x) => x.id.startsWith('wallet:eth'))!
    expect(gas.severity).toBe('warning') // ~20 transactions left
    expect(gas.id).toBe('wallet:eth:warning')
    expect(gas.detail).toMatch(/about 20 more transactions/i)
    expect(gas.action.kind).toBe('explain_funding')
  })

  it('ESCALATES under a NEW key, so a dismissal of the mild version cannot bury the severe one', () => {
    // The operator dismissed "about 43 more transactions" (warning) meaning to top up at the
    // weekend. Three days later the node is 4 transactions from stopping — and with a fixed
    // key that card never comes back.
    const a = deriveAlerts(input({
      snapshot: snap({ balance: { reppo: 2000, veReppo: 0, eth: 0.000005 } }),
      activity: [vote('2', ago(HOUR), 0.000001)],
    }))
    const gas = a.find((x) => x.id.startsWith('wallet:eth'))!
    expect(gas.severity).toBe('critical')
    expect(gas.id).toBe('wallet:eth:critical')
    expect(gas.id).not.toBe('wallet:eth:warning') // a dismissal of the warning does not match it
  })

  it('says NOTHING about gas when the node has never paid any — no data, no threshold', () => {
    const a = deriveAlerts(input({ snapshot: snap({ balance: { reppo: 2000, veReppo: 0, eth: 0.0000001 } }) }))
    expect(a.find((x) => x.id.startsWith('wallet:eth'))).toBeUndefined()
  })

  it('warns when the wallet cannot afford another mint, priced from real mints', () => {
    const a = deriveAlerts(input({
      config: { datanets: { '9': dn({ mint: true }) } },
      snapshot: snap({ balance: { reppo: 40, veReppo: 0, eth: 1 } }),
      datanetPnl: [{ datanetId: '9', reppoSpent: 1000, reppoEarned: 0, net: -1000, roi: 0, votesCast: 3, mintsExecuted: 10 }],
    }))
    const w = a.find((x) => x.id.startsWith('wallet:reppo'))!
    expect(w.severity).toBe('critical')
    expect(w.detail).toMatch(/100 REPPO on average/i) // 1000/10 — observed, never invented
  })

  it('says nothing about REPPO when the node has never minted — the fee is unknown', () => {
    const a = deriveAlerts(input({
      config: { datanets: { '9': dn({ mint: true }) } },
      snapshot: snap({ balance: { reppo: 0, veReppo: 0, eth: 1 } }),
      datanetPnl: [{ datanetId: '9', reppoSpent: 0, reppoEarned: 0, net: 0, roi: null, votesCast: 3, mintsExecuted: 0 }],
    }))
    expect(a.find((x) => x.id.startsWith('wallet:reppo'))).toBeUndefined()
  })

  it('says nothing about REPPO on a vote-only node — it spends no REPPO at all', () => {
    const a = deriveAlerts(input({
      config: { cadenceHours: 1, datanets: on('9') },
      snapshot: snap({ balance: { reppo: 0, veReppo: 0, eth: 1 } }),
      datanetPnl: [{ datanetId: '9', reppoSpent: 1000, reppoEarned: 0, net: -1000, roi: 0, votesCast: 3, mintsExecuted: 10 }],
      activity: [vote('9', ago(HOUR))],
    }))
    expect(a.find((x) => x.id.startsWith('wallet:reppo'))).toBeUndefined()
  })
})

describe('deriveAlerts — accelerating loss', () => {
  const day = (n: number) => new Date(NOW - n * DAY).toISOString()
  const mint = (n: number, reppoSpent: number): ActivityRow =>
    ({ ts: day(n), kind: 'mint', status: 'executed', datanetId: '9', reppoSpent })

  it('raises the one thing a point-in-time net cannot say', () => {
    const rows = [mint(4, 10), mint(3, 10), mint(1, 400), mint(0, 400)]
    const series = buildNetSeries(rows, pnl(-1000, 1000))
    const a = deriveAlerts(input({ series, activity: rows }))
    const loss = a.find((x) => x.id.startsWith('loss:accelerating'))!
    expect(loss.severity).toBe('critical')
    expect(loss.title).toMatch(/getting worse/i)
    expect(loss.link).toBe('datanets')
  })

  it('does not fire on a node that is merely losing at a steady rate', () => {
    const rows = [mint(3, 100), mint(2, 100), mint(1, 100), mint(0, 100)]
    const series = buildNetSeries(rows, pnl(-400, 400))
    expect(deriveAlerts(input({ series, activity: rows })).find((x) => x.id.startsWith('loss:accelerating'))).toBeUndefined()
  })
})

describe('deriveAlerts — what is deliberately NOT an alert', () => {
  it("never alerts on PAUSE: PauseControl, PausedBanner and Home's next-action already say it", () => {
    const a = deriveAlerts(input({ config: { paused: true, datanets: {} } }))
    expect(a).toEqual([])
  })

  it("never calls a datanet idle while the node is PAUSED — the silence is the operator's own choice", () => {
    // Paused with configured datanets whose last executed row predates the pause by days:
    // without the gate every enabled datanet crosses staleAfter and screams "earning you
    // nothing", misattributing a deliberate stop (rule 3: paused is not an alert).
    const a = deriveAlerts(input({
      config: { paused: true, cadenceHours: 1, datanets: on('9') },
      activity: [vote('9', ago(5 * DAY))],
    }))
    expect(a.filter((x) => x.id.startsWith('idle:'))).toEqual([])
  })

  it('is completely silent on a healthy node — no "all clear" chrome', () => {
    const a = deriveAlerts(input({
      config: { cadenceHours: 1, datanets: on('9') },
      health: [health({ datanetId: '9', idle: false })],
      snapshot: snap({
        budget: { mintReppoSpent: 10, voteGasSpentEth: 0, mintGasSpentEth: 0, claimGasSpentEth: 0, caps: { mintReppoMax: 3000 } },
      }),
      activity: [vote('9', ago(HOUR))],
    }))
    expect(a).toEqual([])
  })
})

describe('severity ordering', () => {
  it('ranks critical above warning above info', () => {
    expect(SEVERITY_RANK.critical).toBeLessThan(SEVERITY_RANK.warning)
    expect(SEVERITY_RANK.warning).toBeLessThan(SEVERITY_RANK.info)
  })

  it('sorts the worst thing to the top, whatever order the conditions were found in', () => {
    const a = deriveAlerts(input({
      config: { cadenceHours: 1, datanets: on('5', '6') },
      health: [
        health({ datanetId: '5', classification: cls() }), // warning
        health({ datanetId: '6', classification: cls({ code: 'insufficient_funds', suggestedAction: 'fund_wallet' }) }), // critical
      ],
      activity: [skip('5', ago(HOUR)), skip('6', ago(HOUR))],
      snapshot: snap({ // info (near cap)
        budget: { mintReppoSpent: 950, voteGasSpentEth: 0, mintGasSpentEth: 0, claimGasSpentEth: 0, caps: { mintReppoMax: 1000 } },
      }),
    }))
    expect(a.map((x) => x.severity)).toEqual(['critical', 'warning', 'info'])
  })

  it('summarises for the header badge using the WORST severity present', () => {
    const a = deriveAlerts(input({
      config: { cadenceHours: 1, datanets: on('5', '6') },
      health: [
        health({ datanetId: '5', classification: cls() }),
        health({ datanetId: '6', classification: cls({ code: 'insufficient_funds', suggestedAction: 'fund_wallet' }) }),
      ],
      activity: [skip('5', ago(HOUR)), skip('6', ago(HOUR))],
    }))
    expect(alertSummary(a)).toEqual({ count: 2, worst: 'critical' })
    expect(alertSummary([])).toEqual({ count: 0, worst: null })
  })
})
