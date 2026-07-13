// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { HomeTab } from './HomeTab'
import type { Classification, DashData, HealthDatanet } from '../api'
import type { Candidate, Strategy } from '../lib/useStrategy'

// Home answers two questions and no others: am I making money, and what do I do. The card
// wall (claimed, claimable, gas, LLM cost, balances, epoch) answers neither, so it lives
// behind a disclosure. What is NEW here is the fact that was nowhere in the old UI: which
// datanet is costing the operator money, and the button that stops it.

afterEach(cleanup)

const strategy = (over: Partial<Strategy> = {}): Strategy => ({
  candidate: { datanets: { '11': { vote: true, mint: true, strictness: 'balanced' } } } as Candidate,
  diff: [], saveMsg: '', proposalLoaded: false,
  edit: vi.fn(), editAndSave: vi.fn().mockResolvedValue(undefined), applyProposal: vi.fn(),
  syncPaused: vi.fn(), save: vi.fn().mockResolvedValue(undefined),
  ...over,
})

const health = (id: string, idle: boolean, c?: Classification): HealthDatanet => ({
  datanetId: id, votes: { executed: idle ? 0 : 2, refused: 0, error: 0 },
  mints: { executed: 0, refused: 0, error: 0 }, topErrors: [], idle, classification: c,
})

/** The live node: 8,383 REPPO earned against 10,290 spent — and datanet 11 is why. */
const data = (over: Partial<DashData> = {}): DashData => ({
  pnl: { netReppo: -1906.48, earnedReppo: 8383.51, claimedReppo: 8383.51, claimableReppo: 0, spentReppo: 10290, gasSpentEth: 0.0003 },
  snapshot: null,
  activity: [{ ts: Date.now(), kind: 'vote' }],
  config: { cadenceHours: 1, datanets: { '11': { vote: true, mint: true, strictness: 'balanced' }, '2': { vote: true, mint: true, strictness: 'balanced' } } },
  earn: null,
  netNames: { '11': 'Sports signals', '2': 'Geopolitics' },
  datanetPnl: [
    { datanetId: '11', reppoSpent: 5200, reppoEarned: 0, net: -5200, roi: 0, votesCast: 11, mintsExecuted: 28 },
    { datanetId: '2', reppoSpent: 4470, reppoEarned: 0.0017, net: -4469.99, roi: 0, votesCast: 39, mintsExecuted: 45 },
  ],
  ...over,
})

const props = {
  paused: false,
  // Phase 4 surfaces (chart + alerts) are derived in App and injected. These tests are about
  // the verdict/coverage/next-action spine, so they run with both switched off; NetChart and
  // AlertsPanel have their own suites.
  series: null,
  alerts: [],
  dismissal: { dismissed: new Set<string>(), dismiss: vi.fn(), restore: vi.fn() },
  onOpenCaps: vi.fn(),
  onResume: vi.fn(),
  onGoToDatanets: vi.fn(),
  onGoToDiagnostics: vi.fn(),
  onRunNow: vi.fn(),
}

beforeEach(() => {
  localStorage.setItem('orq-firstrun-dismissed', '1') // the first-run card is not what these test
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) } as unknown as Response))
})

describe('<HomeTab /> — am I making money?', () => {
  it('leads with the honest verdict, never an EARNING claim on a negative net', () => {
    render(<HomeTab data={data()} health={[]} strategy={strategy()} {...props} />)
    expect(screen.getByRole('status', { name: /profit and loss/i })).toHaveTextContent('Losing 1,906 REPPO')
    // the old green EARNING pill (uppercase, standalone) must not exist anywhere
    expect(screen.queryByText(/\bEARNING\b/)).toBeNull()
  })

  it('states real coverage — how much of the node WORKS, not how many tx succeeded', () => {
    const h = [
      health('11', true, { code: 'rpc_unavailable', operatorMessage: 'no response', suggestedAction: 'check_rpc' }),
      health('2', false),
    ]
    render(<HomeTab data={data()} health={h} strategy={strategy()} {...props} />)
    const cov = screen.getByRole('status', { name: /coverage/i })
    expect(cov).toHaveTextContent('1 of 2 datanets working')
    expect(cov).toHaveTextContent('1 needs your attention')
  })
})

describe('<HomeTab /> — what do I do?', () => {
  it('names the money-losing datanet and offers exactly ONE next action', () => {
    render(<HomeTab data={data()} health={[]} strategy={strategy()} {...props} />)
    expect(screen.getByText('Datanet 11 is losing you money')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /stop minting there/i })).toHaveLength(1)
  })

  it('stops minting on the worst datanet — and persists it immediately', async () => {
    const editAndSave = vi.fn().mockResolvedValue(undefined)
    render(<HomeTab data={data()} health={[]} strategy={strategy({ editAndSave })} {...props} />)

    await userEvent.click(screen.getByRole('button', { name: /stop minting there/i }))

    await waitFor(() => expect(editAndSave).toHaveBeenCalled())
    const c = { datanets: { '11': { vote: true, mint: true, strictness: 'balanced' } } } as Candidate
    ;(editAndSave.mock.calls[0][0] as (c: Candidate) => void)(c)
    expect(c.datanets['11'].mint).toBe(false)
    expect(c.datanets['11'].vote).toBe(true) // voting still earns — only the SPEND stops
    expect(await screen.findByText(/minting off — applies next cycle/i)).toBeInTheDocument()
  })

  it('puts resuming a paused node above every other action', () => {
    render(<HomeTab data={data()} health={[]} strategy={strategy()} {...props} paused />)
    expect(screen.getByText('Your node is paused')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /stop minting there/i })).toBeNull()
  })

  it('says plainly when there is nothing to do, and gives no busywork button', () => {
    const clean = data({
      datanetPnl: [],
      config: { cadenceHours: 1, datanets: { '2': { vote: true, mint: false, strictness: 'balanced' } } },
    })
    render(<HomeTab data={clean} health={[health('2', false)]} strategy={strategy()} {...props} />)
    expect(screen.getByText('Nothing needs your attention')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /stop minting|review|resume/i })).toBeNull()
  })

  it('NEVER says "nothing needs your attention" with a CRITICAL alert on the same screen', () => {
    // The wallet is 8 transactions from running out of gas. Nothing is blocked, nothing is
    // losing, nothing is capped — and the biggest element on Home used to tell the operator,
    // in plain English, that they could close the tab.
    const clean = data({
      datanetPnl: [],
      config: { cadenceHours: 1, datanets: { '2': { vote: true, mint: false, strictness: 'balanced' } } },
    })
    const gas: Alert = {
      id: 'wallet:eth:critical',
      severity: 'critical',
      title: 'The wallet is running out of gas',
      detail: 'When it runs out, the node stops voting, minting and claiming.',
      action: { kind: 'explain_funding', label: 'How to fix' },
    }
    const { container } = render(
      <HomeTab data={clean} health={[health('2', false)]} strategy={strategy()} {...props} alerts={[gas]} />,
    )

    expect(screen.queryByText('Nothing needs your attention')).toBeNull()
    expect(screen.queryByText(/you do not need to be here/i)).toBeNull()
    // The one-next-action card itself now points at the alert instead of contradicting it.
    expect(container.querySelector('.na-head')).toHaveTextContent(/needs you now/i)
  })

  it('does not tell the operator to stop minting on a datanet that has not had time to pay', () => {
    // A brand-new node: one mint of 180 REPPO, emissions ~an epoch away, nothing ever claimed.
    // EarnBanner says "No earnings yet — too early to tell". The next-action card used to say
    // the opposite, directly beneath it, with a one-click button that persists immediately.
    const fresh = data({
      pnl: { netReppo: -180, earnedReppo: 0, claimedReppo: 0, claimableReppo: 0, spentReppo: 180, gasSpentEth: 0 },
      config: { cadenceHours: 1, datanets: { '2': { vote: true, mint: true, strictness: 'balanced' } } },
      datanetPnl: [{ datanetId: '2', reppoSpent: 180, reppoEarned: 0, net: -180, roi: 0, votesCast: 0, mintsExecuted: 1 }],
    })
    render(<HomeTab data={fresh} health={[]} strategy={strategy()} {...props} />)

    expect(screen.getByRole('status', { name: /profit and loss/i })).toHaveTextContent(/too early to tell/i)
    expect(screen.queryByText(/is losing you money/)).toBeNull()
    expect(screen.queryByRole('button', { name: /stop minting/i })).toBeNull()
  })

  it('credits the emissions a datanet is already OWED before calling it a loss-maker', () => {
    const owed = data({
      config: { cadenceHours: 1, datanets: { '2': { vote: true, mint: true, strictness: 'balanced' } } },
      datanetPnl: [{ datanetId: '2', reppoSpent: 180, reppoEarned: 0, net: -180, roi: 0, votesCast: 0, mintsExecuted: 1 }],
      snapshot: {
        ts: Date.now(), balance: { reppo: 1, veReppo: 0 },
        emissionsDue: { pods: [{ podId: 'p', datanetId: '2', epoch: 1, reppo: 300 }] },
      },
    })
    render(<HomeTab data={owed} health={[]} strategy={strategy()} {...props} />)
    expect(screen.queryByText('Datanet 2 is losing you money')).toBeNull()
  })

  it('sends "Review spending caps" to the CAPS, not to the top of the datanet list', () => {
    // onGoToDatanets drops the operator on a long list with the caps collapsed inside a
    // disclosure they were never told about. The button's own label promises the caps.
    const onOpenCaps = vi.fn()
    const onGoToDatanets = vi.fn()
    const capped = data({
      datanetPnl: [],
      config: { cadenceHours: 1, datanets: { '2': { vote: true, mint: false, strictness: 'balanced' } } },
    })
    const h = [health('2', true, { code: 'budget_exhausted', operatorMessage: 'hit your cap', suggestedAction: 'raise_budget' })]
    render(<HomeTab data={capped} health={h} strategy={strategy()} {...props} onOpenCaps={onOpenCaps} onGoToDatanets={onGoToDatanets} />)

    fireEvent.click(screen.getByRole('button', { name: /review spending caps/i }))
    expect(onOpenCaps).toHaveBeenCalled()
    expect(onGoToDatanets).not.toHaveBeenCalled()
  })

  it('does not claim minting stopped when the save FAILED', async () => {
    const editAndSave = vi.fn().mockResolvedValue({ ok: false, error: 'could not reach the node — nothing was saved' })
    render(<HomeTab data={data()} health={[]} strategy={strategy({ editAndSave })} {...props} />)

    await userEvent.click(screen.getByRole('button', { name: /stop minting there/i }))

    expect(await screen.findByText(/could not stop minting on datanet 11/i)).toBeInTheDocument()
    expect(screen.queryByText(/minting off — applies next cycle/i)).toBeNull()
    // …and the button is not stranded on "working…"
    expect(screen.getByRole('button', { name: /stop minting there/i })).toBeEnabled()
  })
})

describe('<HomeTab /> — the losing-datanets table', () => {
  it('shows the loss, the return and the mints behind it, worst first', () => {
    render(<HomeTab data={data()} health={[]} strategy={strategy()} {...props} />)
    const first = within(screen.getByRole('table')).getAllByRole('row')[1]
    expect(first).toHaveTextContent('11 · Sports signals')
    expect(first).toHaveTextContent('-5,200 REPPO')
    expect(first).toHaveTextContent('28 mints')
    expect(within(first).getByRole('button', { name: /stop minting/i })).toBeInTheDocument()
  })

  it('never offers to stop minting on a datanet whose minting is ALREADY off', () => {
    // The live node's actual state: datanet 11 lost 5,200 REPPO and was then dropped from the
    // strategy. P&L is lifetime, so the loss persists — but a "Stop minting" button here would
    // claim to act and do nothing. Show the history; offer no fake remedy.
    const d = data({ config: { cadenceHours: 1, datanets: { '2': { vote: true, mint: false, strictness: 'balanced' } } } })
    render(<HomeTab data={d} health={[]} strategy={strategy()} {...props} />)

    const table = screen.getByRole('table')
    expect(table).toHaveTextContent('-5,200 REPPO')           // the loss is still told
    expect(within(table).queryByRole('button', { name: /stop minting/i })).toBeNull()
    expect(within(table).getAllByText(/minting already off/i).length).toBeGreaterThan(0)
    // ...and it is not proposed as the next action either
    expect(screen.queryByText(/is losing you money/)).toBeNull()
  })

  it('lists only datanets that actually SPENT and lost — never a vote-only idler', () => {
    const d = data({
      datanetPnl: [
        { datanetId: '11', reppoSpent: 5200, reppoEarned: 0, net: -5200, roi: 0, votesCast: 11, mintsExecuted: 28 },
        { datanetId: '1', reppoSpent: 0, reppoEarned: 0, net: 0, roi: null, votesCast: 35, mintsExecuted: 0 },
      ],
    })
    render(<HomeTab data={d} health={[]} strategy={strategy()} {...props} />)
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2) // header + one loser
  })
})

describe('<HomeTab /> — the card wall is gone, not deleted', () => {
  it('hides balances, LLM cost, epoch and claimable behind a details disclosure', async () => {
    render(<HomeTab data={data()} health={[]} strategy={strategy()} {...props} />)
    // the card labels themselves — the wall of trivia Home used to open with
    expect(screen.queryByText('LLM cost / cycle')).toBeNull()
    expect(screen.queryByText('veREPPO')).toBeNull()
    expect(screen.queryByText('Claimed (all-time)')).toBeNull()
    expect(screen.queryByText('REPPO balance')).toBeNull()

    const disclosure = screen.getByRole('button', { name: /Node details/ })
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(disclosure)

    expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Claimed (all-time)')).toBeInTheDocument()
    expect(screen.getByText('LLM cost / cycle')).toBeInTheDocument()
    expect(screen.getByText('veREPPO')).toBeInTheDocument()
    expect(screen.getByText('REPPO balance')).toBeInTheDocument()
  })

  it('keeps the activity log and learning reachable from the details disclosure', async () => {
    const onGoToDiagnostics = vi.fn()
    render(<HomeTab data={data()} health={[]} strategy={strategy()} {...props} onGoToDiagnostics={onGoToDiagnostics} />)
    await userEvent.click(screen.getByRole('button', { name: /Node details/ }))
    await userEvent.click(screen.getByRole('button', { name: /open diagnostics/i }))
    expect(onGoToDiagnostics).toHaveBeenCalled()
  })
})
