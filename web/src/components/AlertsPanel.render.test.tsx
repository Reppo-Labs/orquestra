// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { AlertBadge, AlertsPanel } from './AlertsPanel'
import type { Alert } from '../lib/alerts'
import type { Candidate, Strategy } from '../lib/useStrategy'

// The contract: dismissing an alert tidies the SCREEN. It never claims the node is fixed.

afterEach(cleanup)
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) } as unknown as Response))
})

const strategy = (over: Partial<Strategy> = {}): Strategy => ({
  candidate: { datanets: { '5': { vote: true, mint: true, strictness: 'balanced' } } } as Candidate,
  diff: [], saveMsg: '', proposalLoaded: false,
  edit: vi.fn(), editAndSave: vi.fn().mockResolvedValue(undefined), applyProposal: vi.fn(),
  syncPaused: vi.fn(), save: vi.fn().mockResolvedValue(undefined),
  ...over,
})

const alert = (over: Partial<Alert> = {}): Alert => ({
  id: 'blocked:5:rpc_unavailable',
  severity: 'warning',
  title: "Datanet 5 can't run",
  detail: 'The network endpoint this node reads from looks unstable.',
  datanetId: '5',
  action: { kind: 'explain_rpc', label: 'How to fix' },
  ...over,
})

const panel = (alerts: Alert[], over: Partial<Parameters<typeof AlertsPanel>[0]> = {}) =>
  render(
    <AlertsPanel
      alerts={alerts}
      strategy={strategy()}
      snapshot={null}
      dismissed={new Set()}
      onDismiss={vi.fn()}
      onRestore={vi.fn()}
      onOpenCaps={vi.fn()}
      onGoTo={vi.fn()}
      {...over}
    />,
  )

describe('<AlertsPanel />', () => {
  it('states the problem and offers the remedy the backend chose', () => {
    panel([alert()])
    expect(screen.getByText("Datanet 5 can't run")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'How to fix' })).toBeInTheDocument()
  })

  it('renders nothing at all on a healthy node — no "all clear" chrome', () => {
    const { container } = panel([])
    expect(container).toBeEmptyDOMElement()
  })

  it('carries the remedy through: "Turn this datanet off" actually persists', async () => {
    const s = strategy()
    panel([alert({ action: { kind: 'disable', label: 'Turn this datanet off', scope: 'all' } })], { strategy: s })
    await userEvent.click(screen.getByRole('button', { name: 'Turn this datanet off' }))
    expect(s.editAndSave).toHaveBeenCalledTimes(1) // saved, never left as a dirty candidate
    expect(await screen.findByText(/applies next cycle/i)).toBeInTheDocument()

    const c = { datanets: { '5': { vote: true, mint: true, strictness: 'balanced' } } } as Candidate
    ;((s.editAndSave as ReturnType<typeof vi.fn>).mock.calls[0][0] as (c: Candidate) => void)(c)
    expect(c.datanets['5']).toMatchObject({ vote: false, mint: false })
  })

  it('a MINT-side remedy turns publishing off and leaves voting — which earns — running', async () => {
    // The alert's own message says "voting still works". The button used to turn voting off.
    const s = strategy()
    panel([alert({
      action: { kind: 'disable', label: 'Turn publishing off', scope: 'mint' },
      detail: 'Datanet 5 is set to publish data, but this node has no data source for it. Turn publishing off for this datanet (voting still works).',
    })], { strategy: s })

    await userEvent.click(screen.getByRole('button', { name: 'Turn publishing off' }))

    const c = { datanets: { '5': { vote: true, mint: true, strictness: 'balanced' } } } as Candidate
    ;((s.editAndSave as ReturnType<typeof vi.fn>).mock.calls[0][0] as (c: Candidate) => void)(c)
    expect(c.datanets['5'].mint).toBe(false)
    expect(c.datanets['5'].vote).toBe(true)
    expect(await screen.findByText(/voting still runs/i)).toBeInTheDocument()
  })

  it('offers NO disable button on a datanet already off, or gone from the strategy', () => {
    // The health payload keeps a disabled datanet's skip rows for 7 days, so this card comes
    // back on every poll. Its button wrote nothing and reported "turned off" every time.
    const alreadyOff = strategy({
      candidate: { datanets: { '5': { vote: false, mint: false, strictness: 'balanced' } } } as Candidate,
    })
    panel([alert({ action: { kind: 'disable', label: 'Turn this datanet off', scope: 'all' } })], { strategy: alreadyOff })
    expect(screen.queryByRole('button', { name: /turn this datanet off/i })).toBeNull()
    expect(screen.getByText(/already off/i)).toBeInTheDocument()

    cleanup()
    const removed = strategy({ candidate: { datanets: {} } as Candidate })
    panel([alert({ action: { kind: 'disable', label: 'Turn this datanet off', scope: 'all' } })], { strategy: removed })
    expect(screen.queryByRole('button', { name: /turn this datanet off/i })).toBeNull()
    expect(screen.getByText(/no longer in your strategy/i)).toBeInTheDocument()
  })

  it('never reports "turned off" when the save FAILED', async () => {
    const s = strategy({ editAndSave: vi.fn().mockResolvedValue({ ok: false, error: 'could not reach the node' }) })
    panel([alert({ action: { kind: 'disable', label: 'Turn this datanet off', scope: 'all' } })], { strategy: s })

    await userEvent.click(screen.getByRole('button', { name: 'Turn this datanet off' }))

    expect(await screen.findByText(/not saved: could not reach the node/i)).toBeInTheDocument()
    expect(screen.queryByText(/applies next cycle/i)).toBeNull()
    expect(screen.getByRole('button', { name: 'Turn this datanet off' })).toBeEnabled() // not stranded
  })

  it('sends the budget remedy to the caps, not to a dead end', async () => {
    const onOpenCaps = vi.fn()
    panel([alert({ action: { kind: 'raise_budget', label: 'Raise spending caps' } })], { onOpenCaps })
    await userEvent.click(screen.getByRole('button', { name: 'Raise spending caps' }))
    expect(onOpenCaps).toHaveBeenCalled()
  })

  it('explains env-level fixes it cannot perform, rather than pretending it can', async () => {
    panel([alert()])
    await userEvent.click(screen.getByRole('button', { name: 'How to fix' }))
    expect(screen.getByText(/RPC_URL/)).toBeInTheDocument()
    expect(screen.getByText(/the dashboard cannot change it/i)).toBeInTheDocument()
  })

  it('keeps a dismissed alert COUNTED and recoverable — dismissing is not fixing', () => {
    panel([alert()], { dismissed: new Set(['blocked:5:rpc_unavailable']) })
    expect(screen.queryByText("Datanet 5 can't run")).toBeNull() // the card is hidden…
    expect(screen.getByText(/still unresolved/i)).toBeInTheDocument() // …the condition is not
    expect(screen.getByRole('button', { name: /show it/i })).toBeInTheDocument()
  })

  it('announces arrivals to assistive tech', () => {
    panel([alert(), alert({ id: 'blocked:6:rpc_unavailable', datanetId: '6' })])
    expect(screen.getByRole('status')).toHaveTextContent('2 alerts need attention')
  })
})

describe('<AlertBadge /> — unmissable from every tab', () => {
  it('shows the count and the worst severity', () => {
    render(<AlertBadge count={3} worst="critical" onClick={vi.fn()} />)
    const b = screen.getByRole('button')
    expect(b).toHaveTextContent('3 alerts')
    expect(b).toHaveClass('critical')
    expect(b).toHaveAccessibleName(/3 alerts need attention/i)
  })

  it('disappears entirely when nothing is wrong', () => {
    const { container } = render(<AlertBadge count={0} worst={null} onClick={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})
