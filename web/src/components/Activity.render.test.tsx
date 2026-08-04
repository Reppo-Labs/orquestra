// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { Activity } from './Activity'
import type { ActivityRow } from '../api'

// The claim row used to name REPPO unconditionally, so datanet 3 (Sherwood,
// which pays WOOD) reported a real 737 WOOD payout as "epoch 127 · 0 REPPO" —
// a successful claim rendered as having earned nothing. These pin the detail
// against the token the claim actually paid.

afterEach(cleanup)

const claim = (over: Partial<ActivityRow> = {}): ActivityRow => ({
  ts: '2026-08-04T15:51:42.609Z',
  cycleId: 'c1',
  kind: 'claim',
  datanetId: '3',
  podId: '3',
  epoch: 127,
  status: 'executed',
  ...over,
} as ActivityRow)

const show = (r: ActivityRow) =>
  render(<Activity activity={[r]} netNames={{ '3': 'Sherwood Trading Strategies' }} onOpenPanel={() => {}} />)

describe('Activity — claim detail', () => {
  it('names the native token a claim actually paid', () => {
    show(claim({ reppoClaimed: 0, claimedTokenSymbol: 'WOOD', claimedTokenAmount: 737.118891402 }))
    expect(screen.getByText(/epoch 127 · 737\.119 WOOD/)).toBeInTheDocument()
    // and never reports that payout as zero REPPO
    expect(screen.queryByText(/0 REPPO/)).not.toBeInTheDocument()
  })

  it('still shows REPPO for a plain REPPO claim', () => {
    show(claim({ reppoClaimed: 12.5 }))
    expect(screen.getByText(/epoch 127 · 12\.5 REPPO/)).toBeInTheDocument()
  })

  it('shows both legs when a claim paid REPPO and a native token', () => {
    show(claim({ reppoClaimed: 2, claimedTokenSymbol: 'WOOD', claimedTokenAmount: 100 }))
    expect(screen.getByText(/2 REPPO \+ 100 WOOD/)).toBeInTheDocument()
  })

  it('does not name a token when nothing measurable was claimed', () => {
    // Which token this would have paid is exactly what is unknown here, so the
    // old "0 REPPO" was an assertion the row does not support.
    show(claim({ reppoClaimed: 0 }))
    expect(screen.getByText(/epoch 127 · nothing claimed/)).toBeInTheDocument()
    expect(screen.queryByText(/REPPO/)).not.toBeInTheDocument()
  })
})
