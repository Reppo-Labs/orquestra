// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { DatanetsTab } from './DatanetsTab'
import type { Classification, DatanetPnl, HealthDatanet, Snapshot } from '../api'
import type { Candidate, Strategy } from '../lib/useStrategy'

// One row per datanet, answering the three questions an operator actually has: is it
// earning, is it working, what does it pay. And: a broken datanet is never a dead end —
// its plain-English message arrives with the button that fixes it.

afterEach(cleanup)

const candidate = (): Candidate => ({
  cadenceHours: 1,
  datanets: {
    '11': { vote: true, mint: true, strictness: 'balanced', adapter: 'sports', voteShare: 1 },
    '5': { vote: true, mint: false, strictness: 'aggressive', voteShare: 3 },
    '*': { vote: false, mint: false, strictness: 'balanced' },
  },
})

function stubStrategy(over: Partial<Strategy> = {}): Strategy {
  return {
    candidate: candidate(),
    diff: [],
    saveMsg: '',
    proposalLoaded: false,
    edit: vi.fn(),
    editAndSave: vi.fn().mockResolvedValue(undefined),
    applyProposal: vi.fn(),
    syncPaused: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
}

const cls = (code: Classification['code'], suggestedAction: Classification['suggestedAction'], msg: string): Classification =>
  ({ code, operatorMessage: msg, suggestedAction })

const health = (id: string, idle: boolean, c?: Classification): HealthDatanet => ({
  datanetId: id, votes: { executed: idle ? 0 : 4, refused: 0, error: 0 },
  mints: { executed: 0, refused: 0, error: 0 }, topErrors: [], idle, classification: c,
})

// The live node's headline fact: datanet 11 spent 5,200 REPPO over 28 mints and earned 0.
const PNL: DatanetPnl[] = [
  { datanetId: '11', reppoSpent: 5200, reppoEarned: 0, net: -5200, roi: 0, votesCast: 11, mintsExecuted: 28 },
  { datanetId: '5', reppoSpent: 0, reppoEarned: 0.645, net: 0.645, roi: null, votesCast: 99, mintsExecuted: 0 },
]

const snapshot = {
  ts: Date.now(),
  balance: { reppo: 2057, veReppo: 2862, eth: 0.0037 },
  emissionsDue: { pods: [] },
  datanetEconomics: [
    { datanetId: '11', emissionsPerEpochReppo: 0, epoch: 116, epochVoteVolume: 4, yieldPerVote: null, uncontested: false, nativeTokenSymbol: 'USDC' },
    { datanetId: '5', emissionsPerEpochReppo: 6000, epoch: 116, epochVoteVolume: 6.09, yieldPerVote: 984.34, uncontested: false },
  ],
} as unknown as Snapshot

const base = {
  netNames: { '11': 'Sports signals', '5': 'Industrial task videos' },
  snapshot,
  onReconfigure: vi.fn(),
}

const row = (name: RegExp) => screen.getByText(name).closest('.dn-row') as HTMLElement

beforeEach(() => {
  // /api/models is fetched on mount; anything else degrades safely.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ providers: [] }) } as unknown as Response))
})

describe('<DatanetsTab /> — the row', () => {
  it('answers earning / working / pays on a single row', () => {
    render(<DatanetsTab strategy={stubStrategy()}
      health={[health('11', true, cls('no_adapter', 'disable_datanet', 'Datanet 11 has minting on but no data source.'))]}
      datanetPnl={PNL} {...base} />)

    const r = row(/Sports signals/)
    expect(r).toHaveTextContent('-5,200 REPPO')  // EARNING: the loss
    expect(r).toHaveTextContent('0%')            // its return (spent 5,200, earned 0)
    expect(r).toHaveTextContent('28 mints')      // the volume behind it
    expect(within(r).getByText('needs you')).toBeInTheDocument() // WORKING
    expect(r).toHaveTextContent(/USDC \(native\)/)              // PAYS
  })

  it('renders a null ROI as "—", never a fake 0%', () => {
    render(<DatanetsTab strategy={stubStrategy()} health={[]} datanetPnl={PNL} {...base} />)
    // datanet 5 spent nothing: no return ratio exists
    expect(row(/Industrial task videos/)).toHaveTextContent('return —')
  })

  it('colours the loss red and the gain green — money is the only thing that earns colour', () => {
    render(<DatanetsTab strategy={stubStrategy()} health={[]} datanetPnl={PNL} {...base} />)
    expect(row(/Sports signals/).querySelector('.dn-val')).toHaveClass('neg')
    expect(row(/Industrial task videos/).querySelector('.dn-val')).toHaveClass('pos')
  })

  it('puts the money-losing datanet first, whatever the config order', () => {
    render(<DatanetsTab strategy={stubStrategy()} health={[]} datanetPnl={PNL} {...base} />)
    const names = Array.from(document.querySelectorAll('.dn-name')).map((n) => n.textContent)
    expect(names[0]).toBe('Sports signals')
  })
})

describe('<DatanetsTab /> — a broken datanet is never a dead end', () => {
  it('shows the plain-English operatorMessage and NEVER raw stderr', () => {
    const msg = "Datanet 11 didn't respond — the network endpoint this node reads from looks unstable."
    render(<DatanetsTab strategy={stubStrategy()} health={[health('11', true, cls('rpc_unavailable', 'check_rpc', msg))]}
      datanetPnl={PNL} {...base} />)
    const r = row(/Sports signals/)
    expect(r).toHaveTextContent(msg)
    expect(r.textContent).not.toMatch(/Command failed|stderr|viem|eth_call/i)
  })

  it('turns PUBLISHING off for a mint-only fault — and leaves voting, which earns, alone', async () => {
    // no_adapter is a mint-side fault: the vote path is running fine, and the backend's own
    // message says "voting still works". The button used to turn voting off as well —
    // destroying the only path that earns without spending, in one click, with no undo.
    const editAndSave = vi.fn().mockResolvedValue({ ok: true })
    render(<DatanetsTab strategy={stubStrategy({ editAndSave })}
      health={[health('11', false, cls('no_adapter', 'disable_datanet', 'Datanet 11 is set to publish data, but this node has no data source for it. Turn publishing off for this datanet (voting still works).'))]}
      datanetPnl={PNL} {...base} />)

    await userEvent.click(screen.getByRole('button', { name: /turn publishing off/i }))

    await waitFor(() => expect(editAndSave).toHaveBeenCalled())
    const c = candidate()
    ;(editAndSave.mock.calls[0][0] as (c: Candidate) => void)(c)
    expect(c.datanets['11'].mint).toBe(false)
    expect(c.datanets['11'].vote).toBe(true) // the income keeps running
    expect(await within(row(/Sports signals/)).findByText(/voting keeps running/i)).toBeInTheDocument()
  })

  it('turns the WHOLE datanet off when nothing about it can work', async () => {
    const editAndSave = vi.fn().mockResolvedValue({ ok: true })
    // No executed votes anywhere: this datanet cannot take part at all.
    const dead: HealthDatanet = {
      datanetId: '11', votes: { executed: 0, refused: 0, error: 2 }, mints: { executed: 0, refused: 0, error: 0 },
      topErrors: [], idle: true,
      classification: cls('datanet_metadata_missing', 'disable_datanet', "Datanet 11's creator never published the rules this node needs."),
    }
    render(<DatanetsTab strategy={stubStrategy({ editAndSave })} health={[dead]} datanetPnl={PNL} {...base} />)

    await userEvent.click(screen.getByRole('button', { name: /turn this datanet off/i }))

    await waitFor(() => expect(editAndSave).toHaveBeenCalled())
    const c = candidate()
    ;(editAndSave.mock.calls[0][0] as (c: Candidate) => void)(c)
    expect(c.datanets['11'].vote).toBe(false)
    expect(c.datanets['11'].mint).toBe(false)
  })

  it('does not report success when the save FAILED', async () => {
    const editAndSave = vi.fn().mockResolvedValue({ ok: false, error: 'could not reach the node — nothing was saved' })
    render(<DatanetsTab strategy={stubStrategy({ editAndSave })}
      health={[health('11', false, cls('no_adapter', 'disable_datanet', 'No data source for this datanet.'))]}
      datanetPnl={PNL} {...base} />)

    await userEvent.click(screen.getByRole('button', { name: /turn publishing off/i }))

    const r = row(/Sports signals/)
    expect(await within(r).findByText(/not saved: could not reach the node/i)).toBeInTheDocument()
    expect(within(r).queryByText(/applies next cycle/i)).toBeNull()
    // …and the button is usable again — never stranded on "working…"
    expect(screen.getByRole('button', { name: /turn publishing off/i })).toBeEnabled()
  })

  it('offers no disable button on a datanet that is already off — a button that does nothing is a lie', async () => {
    // The operator followed the remedy. The skip rows stay in the 7-day window, so the
    // classification (and its button) came back on the next poll — writing nothing, and
    // reporting "turned off" every time.
    const s = stubStrategy()
    s.candidate!.datanets['11'] = { vote: false, mint: false, strictness: 'balanced' }
    render(<DatanetsTab strategy={s}
      health={[health('11', true, cls('datanet_metadata_missing', 'disable_datanet', 'Datanet 11 has no rules published.'))]}
      datanetPnl={PNL} {...base} />)

    expect(screen.queryByRole('button', { name: /turn this datanet off|turn publishing off/i })).toBeNull()
    // The row says what is true — it is off — instead of re-offering a remedy it already took.
    expect(within(row(/Sports signals/)).getByText('switched off')).toBeInTheDocument()
  })

  it('offers no PUBLISHING-off button on a datanet whose minting is already off', async () => {
    const s = stubStrategy()
    s.candidate!.datanets['11'] = { vote: true, mint: false, strictness: 'balanced' } // votes only
    render(<DatanetsTab strategy={s}
      health={[health('11', false, cls('no_adapter', 'disable_datanet', 'Datanet 11 has no data source.'))]}
      datanetPnl={PNL} {...base} />)

    expect(screen.queryByRole('button', { name: /turn publishing off/i })).toBeNull()
    expect(within(row(/Sports signals/)).getByText(/already off/i)).toBeInTheDocument()
  })

  it('does not report a RECOVERED datanet as needing you', async () => {
    // One transient RPC error six days ago; 300 executed votes since. The server still
    // attaches the old classification — the row must not keep saying "needs you" for a week.
    const activity: ActivityRow[] = [
      { ts: new Date(Date.now() - 3600_000).toISOString(), kind: 'vote', status: 'executed', datanetId: '11' },
      { ts: new Date(Date.now() - 6 * 86_400_000).toISOString(), kind: 'skip', status: 'skipped', datanetId: '11' },
    ]
    render(<DatanetsTab strategy={stubStrategy()}
      health={[health('11', false, cls('rpc_unavailable', 'check_rpc', 'Datanet 11 did not respond.'))]}
      datanetPnl={PNL} {...base} activity={activity} />)

    const r = row(/Sports signals/)
    expect(within(r).getByText('working')).toBeInTheDocument()
    expect(within(r).queryByText('needs you')).toBeNull()
    expect(screen.queryByRole('button', { name: /how to fix/i })).toBeNull()
  })

  it('wires check_rpc to an explanation — the dashboard holds no secrets and cannot fix RPC', async () => {
    render(<DatanetsTab strategy={stubStrategy()}
      health={[health('11', true, cls('rpc_unavailable', 'check_rpc', 'Datanet 11 did not respond.'))]}
      datanetPnl={PNL} {...base} />)

    const btn = screen.getByRole('button', { name: /how to fix/i })
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(btn)
    expect(btn).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('RPC_URL')).toBeInTheDocument()
  })

  it('wires check_model_quota to the MODEL PROVIDER, and never mentions RPC_URL', async () => {
    // The live Gemini-quota datanet. Under the old classifier this row said "point RPC_URL at a
    // private RPC" — a confident remedy for a subsystem that was not the one that failed.
    render(<DatanetsTab strategy={stubStrategy()}
      health={[health('11', true, cls('llm_quota_exhausted', 'check_model_quota', 'Datanet 11 ran out of AI model quota.'))]}
      datanetPnl={PNL} {...base} />)

    const btn = screen.getByRole('button', { name: /how to fix/i })
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(btn)
    expect(btn).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/AI model provider/i)).toBeInTheDocument()
    expect(screen.getByText(/quota or credit ran out/i)).toBeInTheDocument()
  })

  it('wires check_model_quota to the MODEL PROVIDER, and never mentions RPC_URL', async () => {
    // The live Gemini-quota datanet. Under the old classifier this row said "point RPC_URL at a
    // private RPC" — a confident remedy aimed at a subsystem that had not failed.
    render(<DatanetsTab strategy={stubStrategy()}
      health={[health('11', true, cls('llm_quota_exhausted', 'check_model_quota', 'Datanet 11 ran out of AI model quota.'))]}
      datanetPnl={PNL} {...base} />)

    const btn = screen.getByRole('button', { name: /how to fix/i })
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(btn)
    expect(btn).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/AI model provider/i)).toBeInTheDocument()
    expect(screen.queryByText('RPC_URL')).toBeNull() // the lie, gone from the surface too
  })

  it('wires fund_wallet to an explanation that shows what the wallet actually holds', async () => {
    render(<DatanetsTab strategy={stubStrategy()}
      health={[health('11', true, cls('insufficient_funds', 'fund_wallet', 'The wallet is short of REPPO.'))]}
      datanetPnl={PNL} {...base} />)

    await userEvent.click(screen.getByRole('button', { name: /how to fix/i }))
    expect(screen.getByText(/2,057 REPPO/)).toBeInTheDocument()
  })

  it('gives a benign "none" action NO button', () => {
    render(<DatanetsTab strategy={stubStrategy()}
      health={[health('11', true, cls('no_candidates', 'none', 'Datanet 11 judged nothing good enough to publish.'))]}
      datanetPnl={PNL} {...base} />)
    expect(screen.queryByRole('button', { name: /turn this datanet off|how to fix|run a cycle/i })).toBeNull()
  })
})

describe('<DatanetsTab /> — presets replace the raw dropdowns', () => {
  it('offers three named presets per datanet, not a 1-10 threshold picker', () => {
    render(<DatanetsTab strategy={stubStrategy()} health={[]} datanetPnl={PNL} {...base} />)
    const group = screen.getByRole('radiogroup', { name: /how picky on datanet 11/i })
    expect(within(group).getAllByRole('radio').map((r) => (r as HTMLInputElement).value))
      .toEqual(['conservative', 'balanced', 'aggressive'])
    expect(within(group).getByRole('radio', { name: /Cautious/ })).toBeInTheDocument()
    expect(within(group).getByRole('radio', { name: /Balanced/ })).toBeChecked()
  })

  it('writes an EXISTING strictness value — no new config vocabulary', async () => {
    const edit = vi.fn()
    render(<DatanetsTab strategy={stubStrategy({ edit })} health={[]} datanetPnl={PNL} {...base} />)
    const group = screen.getByRole('radiogroup', { name: /how picky on datanet 11/i })

    await userEvent.click(within(group).getByRole('radio', { name: /Cautious/ }))

    const c = candidate()
    ;(edit.mock.calls[0][0] as (c: Candidate) => void)(c)
    expect(c.datanets['11'].strictness).toBe('conservative')
  })

  it('states the vote weight as a share of the cycle, not a bare integer', () => {
    render(<DatanetsTab strategy={stubStrategy()} health={[]} datanetPnl={PNL} {...base} />)
    // weights 1 and 3 across the two voting datanets → 25% / 75%
    expect(row(/Sports signals/)).toHaveTextContent('25% of votes')
    expect(row(/Industrial task videos/)).toHaveTextContent('75% of votes')
  })

  it('hides adapter, mint mode and vote model behind Advanced', async () => {
    render(<DatanetsTab strategy={stubStrategy()} health={[]} datanetPnl={PNL} {...base} />)
    expect(screen.queryByLabelText(/adapter for datanet 11/i)).toBeNull()

    const adv = within(row(/Sports signals/)).getByRole('button', { name: /Advanced/ })
    expect(adv).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(adv)

    expect(adv).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByLabelText(/adapter for datanet 11/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/mint mode for datanet 11/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/vote model provider for datanet 11/i)).toBeInTheDocument()
  })
})

describe('<DatanetsTab /> — nothing was lost', () => {
  it('keeps add-datanet, reconfigure, save and every node setting reachable', async () => {
    render(<DatanetsTab strategy={stubStrategy()} health={[]} datanetPnl={PNL} {...base} />)
    expect(screen.getByRole('button', { name: /add datanet/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /reconfigure with assistant/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument()

    const settings = screen.getByRole('button', { name: /Node settings/ })
    expect(settings).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(settings)

    // caps + cadence + lock + deliberation + brief: all still here, one disclosure away
    expect(screen.getByRole('heading', { name: /Spending caps & cadence/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Strategy brief/i })).toBeInTheDocument()
    expect(screen.getByLabelText(/multi-agent panel/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/default model provider/i)).toBeInTheDocument()
    expect(screen.getByText(/lock REPPO/i)).toBeInTheDocument()
  })
})
