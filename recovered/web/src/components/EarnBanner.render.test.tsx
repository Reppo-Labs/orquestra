// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { EarnBanner, earnState } from './EarnBanner'
import type { Earn, Pnl } from '../api'

// The banner is the most-read line on the dashboard. These tests pin the one property
// that matters: it must never tell an operator they are earning while the node's net
// REPPO is negative.

afterEach(cleanup)

const pnl = (p: Partial<Pnl>): Pnl => ({
  netReppo: 0, earnedReppo: 0, claimedReppo: 0, claimableReppo: 0, spentReppo: 0, gasSpentEth: 0, ...p,
})
const earn = (e: Partial<Earn> = {}): Earn => ({
  earning: true, mintedPods: 0, claimableReppo: 0, claimedReppo: 0, totalUpVotes: 0, totalDownVotes: 0, ...e,
})

// The live audit case: emissions detected (backend `earning: true`) but net REPPO < 0.
const LOSING = pnl({ earnedReppo: 8383, spentReppo: 10289.481, netReppo: -1906.481 })

describe('earnState', () => {
  it('calls a negative net a loss, showing both sides of the arithmetic', () => {
    const s = earnState(LOSING, earn({ earning: true }))
    expect(s.tone).toBe('loss')
    expect(s.headline).toBe('Losing 1,906 REPPO')
    expect(s.detail).toContain('10,289 REPPO')
    expect(s.detail).toContain('8,383 REPPO')
  })

  it('calls a positive net a profit', () => {
    const s = earnState(pnl({ earnedReppo: 500, spentReppo: 200, netReppo: 300 }), earn())
    expect(s.tone).toBe('profit')
    expect(s.headline).toBe('Up 300 REPPO')
  })

  it('treats break-even as neutral, not as a gain', () => {
    const s = earnState(pnl({ earnedReppo: 100, spentReppo: 100, netReppo: 0 }), earn())
    expect(s.tone).toBe('neutral')
    expect(s.headline).toBe('Breaking even')
  })

  it('is neutral (too early), NOT a loss, when nothing has been earned yet', () => {
    const s = earnState(pnl({ earnedReppo: 0, spentReppo: 4000, netReppo: -4000 }), earn({ earning: false }))
    expect(s.tone).toBe('neutral')
    expect(s.headline).toMatch(/too early/i)
    expect(s.detail).toContain('4,000 REPPO')
  })

  it('is neutral on a fresh node with no pnl at all', () => {
    const s = earnState(null, null)
    expect(s.tone).toBe('neutral')
    expect(s.headline).toMatch(/first cycle/i)
  })
})

describe('<EarnBanner /> render', () => {
  it('never shows an EARNING claim while the node is down on net REPPO', () => {
    const { container, queryByText } = render(<EarnBanner pnl={LOSING} earn={earn({ earning: true })} />)
    expect(queryByText(/EARNING/i)).toBeNull()
    const head = container.querySelector('.earn-head')
    expect(head).toHaveTextContent('Losing 1,906 REPPO')
    // loss colour, never the profit colour
    expect(head).toHaveClass('neg')
    expect(head).not.toHaveClass('pos')
    expect(container.querySelector('.dot')).toHaveClass('bad')
  })

  it('uses the profit colour only when net REPPO is positive', () => {
    const { container } = render(
      <EarnBanner pnl={pnl({ earnedReppo: 500, spentReppo: 200, netReppo: 300 })} earn={earn()} />,
    )
    expect(container.querySelector('.earn-head')).toHaveClass('pos')
    expect(container.querySelector('.dot')).toHaveClass('on')
  })

  it('keeps pods/claimable/claimed as subordinate detail, not the headline', () => {
    const { container } = render(
      <EarnBanner pnl={LOSING} earn={earn({ mintedPods: 12, claimableReppo: 0, claimablePairs: 3, claimedReppo: 8383 })} />,
    )
    const facts = container.querySelector('.earn-facts')
    expect(facts).toHaveTextContent('12 pods minted')
    expect(facts).toHaveTextContent('0 REPPO claimable (3 pending)')
    expect(facts).toHaveTextContent('8,383 REPPO claimed')
  })

  it('drops the unitless raw vote tallies that used to sit in the banner', () => {
    const { container } = render(
      <EarnBanner pnl={LOSING} earn={earn({ totalUpVotes: 21033942, totalDownVotes: 1518750 })} />,
    )
    expect(container.textContent).not.toContain('21033942')
    expect(container.textContent).not.toContain('↑')
  })

  it('exposes the banner to assistive tech as a status region', () => {
    const { getByRole } = render(<EarnBanner pnl={LOSING} earn={earn()} />)
    expect(getByRole('status', { name: /profit and loss/i })).toBeInTheDocument()
  })
})
