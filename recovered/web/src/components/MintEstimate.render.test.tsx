// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MintEstimate } from './MintEstimate'
import { buildMintEstimate } from '../lib/mintEstimate'
import type { DatanetPnl, Snapshot } from '../api'

// Turning minting on spends real money. Every number on this panel is either sourced or
// visibly UNKNOWN — a fabricated "0" here is the most expensive lie the dashboard could tell.

afterEach(cleanup)

const snapshot: Snapshot = {
  ts: Date.parse('2026-07-12T12:00:00.000Z'),
  balance: { reppo: 2000, veReppo: 0 },
  emissionsDue: { pods: [] },
  budget: {
    mintReppoSpent: 215, voteGasSpentEth: 0, mintGasSpentEth: 0, claimGasSpentEth: 0,
    caps: { mintReppoMax: 3000, mintRateMaxPerCycle: 4 },
  },
  datanetEconomics: [{
    datanetId: '9', emissionsPerEpochReppo: 1000, epoch: 116,
    epochVoteVolume: 1135826, yieldPerVote: 0.00088, uncontested: false,
  }],
}

const minted: DatanetPnl[] = [
  { datanetId: '9', reppoSpent: 620, reppoEarned: 0.03, net: -619.97, roi: 0, votesCast: 34, mintsExecuted: 124 },
]

const show = (datanetId: string, datanetPnl: DatanetPnl[] = minted) =>
  render(<MintEstimate est={buildMintEstimate({ datanetId, snapshot, datanetPnl })} name="TradingGym AI" />)

const row = (container: HTMLElement, label: string): HTMLElement =>
  Array.from(container.querySelectorAll('.me-row')).find((r) => r.textContent?.includes(label)) as HTMLElement

describe('<MintEstimate /> — a datanet this node has minted on', () => {
  it('prices the mint from real, paid mints', () => {
    const { container } = show('9')
    expect(row(container, 'Cost per mint')).toHaveTextContent('5 REPPO')
    expect(row(container, 'Cost per mint')).toHaveTextContent(/average of the 124 mints/i)
  })

  it('shows the worst a single cycle could cost', () => {
    const { container } = show('9')
    const r = row(container, 'Most one cycle could cost')
    expect(r).toHaveTextContent('20 REPPO') // 5 × the 4-mint per-cycle cap
    expect(r).toHaveTextContent(/node-wide cap/i)
  })

  it('shows what the datanet actually pays, never in scientific notation', () => {
    show('9')
    expect(screen.getByText(/1,000 REPPO \/ epoch/)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/\de-\d/)
  })

  it('warns that the access fee escapes the spending caps — the one thing not to skim', () => {
    show('9')
    expect(screen.getByText(/your spending caps do not cover it/i)).toBeInTheDocument()
  })

  it('is exposed to assistive tech as a named group', () => {
    show('9')
    expect(screen.getByRole('group', { name: /what minting on TradingGym AI costs and pays/i })).toBeInTheDocument()
  })
})

describe('<MintEstimate /> — unknowns are shown as unknown, never as 0', () => {
  it('never prints a number for the one-time access fee', () => {
    const { container } = show('9')
    const fee = row(container, 'One-time access fee')
    expect(fee).toHaveTextContent('unknown')
    expect(fee).not.toHaveTextContent('0 REPPO')
  })

  it('says the mint fee is unknown for a datanet it has never minted on', () => {
    const { container } = show('17', [])
    const fee = row(container, 'Cost per mint')
    expect(fee).toHaveTextContent('unknown')
    expect(fee).toHaveTextContent(/never minted here/i)
    expect(fee).not.toHaveTextContent('0 REPPO')
  })

  it("offers other datanets' fees only as a range, explicitly not as a quote", () => {
    show('17', [
      ...minted,
      { datanetId: '11', reppoSpent: 5200, reppoEarned: 0, net: -5200, roi: 0, votesCast: 11, mintsExecuted: 28 },
    ])
    expect(screen.getByText(/for comparison/i)).toBeInTheDocument()
    // Formatted through fmtReppo — magnitude-aware, never a raw float, never scientific.
    expect(document.body.textContent).toMatch(/paid between 5 REPPO and 185\.7 REPPO per mint/i)
    expect(document.body.textContent).toMatch(/is not a quote for this one/i)
  })

  it('says the yield is unknown for a datanet missing from the snapshot', () => {
    const { container } = show('404', [])
    const y = row(container, 'Current yield')
    expect(y).toHaveTextContent('unknown')
    expect(y).not.toHaveTextContent('0 REPPO/vote')
  })

  it('surfaces an uncontested epoch as an opportunity, not as a zero yield', () => {
    const s: Snapshot = {
      ...snapshot,
      datanetEconomics: [{
        datanetId: '10', emissionsPerEpochReppo: 5000, epoch: 116,
        epochVoteVolume: 0, yieldPerVote: null, uncontested: true,
      }],
    }
    render(<MintEstimate est={buildMintEstimate({ datanetId: '10', snapshot: s, datanetPnl: [] })} />)
    expect(screen.getByText(/nobody has voted this epoch/i)).toBeInTheDocument()
  })
})
