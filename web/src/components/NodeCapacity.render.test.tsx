// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { NodeCapacity } from './NodeCapacity'
import type { Snapshot } from '../api'

// What actually lands in the DOM for the two stall conditions an operator cannot
// otherwise see: an emptying gas tank and a spent / never-read vote-power budget.
// The pure math lives in lib/nodeCapacity.test.ts; here we assert the SURFACING.

afterEach(cleanup)

const snap = (s: Partial<Snapshot>): Snapshot =>
  ({ ts: 0, balance: { eth: 0.5, reppo: 0, veReppo: 0, usdc: 0 }, emissionsDue: { pods: [] }, ...s }) as unknown as Snapshot

const live = (over: Record<string, unknown> = {}) => snap({
  lowGas: false,
  votePower: {
    sizing: 've-reppo',
    votingPowerWei: '100' + '0'.repeat(18),
    votesCastedWei: '25' + '0'.repeat(18),
    remainingWei: '75' + '0'.repeat(18),
    epoch: 7,
    ...over,
  },
} as Partial<Snapshot>)

describe('<NodeCapacity /> render', () => {
  it('shows remaining vote power against the total, not the total alone', () => {
    const { getByText } = render(<NodeCapacity snapshot={live()} />)
    expect(getByText('75')).toBeInTheDocument()
    expect(getByText(/of 100 total/)).toBeInTheDocument()
    expect(getByText(/epoch 7/)).toBeInTheDocument()
  })

  it('shows the on-chain vote weight already cast this epoch (the external-script check)', () => {
    const { getByText } = render(<NodeCapacity snapshot={live()} />)
    expect(getByText('25')).toBeInTheDocument()
    expect(getByText('25% of power spent this epoch')).toBeInTheDocument()
  })

  it('raises a low-gas banner only when the node flagged it', () => {
    const { queryByText } = render(<NodeCapacity snapshot={live()} />)
    expect(queryByText(/Low gas/)).not.toBeInTheDocument()
    cleanup()
    const low = render(<NodeCapacity snapshot={snap({ balance: { eth: 0.0002, reppo: 0, veReppo: 0, usdc: 0 }, lowGas: true } as Partial<Snapshot>)} />)
    expect(low.getByText(/Low gas/)).toBeInTheDocument()
    expect(low.getByText(/Top up with ETH on Base/)).toBeInTheDocument()
  })

  it('warns that votes are not veREPPO-weighted when the node has no RPC', () => {
    const { getByText, container } = render(<NodeCapacity snapshot={snap({ lowGas: false, votePower: { sizing: 'legacy-no-rpc' } } as Partial<Snapshot>)} />)
    expect(getByText('Votes are not veREPPO-weighted')).toBeInTheDocument()
    expect(getByText(/RPC_URL is not set/)).toBeInTheDocument()
    expect(getByText('RPC_URL not set')).toBeInTheDocument()
    // amounts unread, NOT zero
    expect(container.querySelectorAll('.v.faint, .v .faint').length).toBeGreaterThan(0)
    expect(getByText('conviction dust')).toBeInTheDocument()
  })

  it('names a failed read as this cycle\u2019s failure, distinct from a missing RPC', () => {
    const { getByText } = render(<NodeCapacity snapshot={snap({ lowGas: false, votePower: { sizing: 'legacy-read-failed' } } as Partial<Snapshot>)} />)
    expect(getByText('budget read failed this cycle')).toBeInTheDocument()
  })

  it('renders unread amounts as "unread" rather than 0 when nothing was read', () => {
    const { getAllByText, queryByText } = render(<NodeCapacity snapshot={snap({ lowGas: false })} />)
    expect(getAllByText('unread').length).toBeGreaterThanOrEqual(2)
    expect(queryByText('Votes are not veREPPO-weighted')).not.toBeInTheDocument() // unknown ≠ degraded
    expect(queryByText('of unread total')).toBeInTheDocument()
  })

  it('survives a null snapshot (pre-first-cycle) without inventing numbers', () => {
    const { getAllByText, queryByText } = render(<NodeCapacity snapshot={null} />)
    expect(getAllByText('unread').length).toBeGreaterThanOrEqual(3)
    expect(queryByText(/Low gas/)).not.toBeInTheDocument()
  })
})
