// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { NetChart } from './NetChart'
import { buildNetSeries } from '../lib/pnlSeries'
import type { ActivityRow, Pnl } from '../api'

// A chart is allowed to be pretty. It is not allowed to be wrong, and it is not allowed to be
// unreadable without eyes.

afterEach(cleanup)

const T0 = Date.parse('2026-07-01T00:00:00.000Z')
const day = (n: number): string => new Date(T0 + n * 86_400_000).toISOString()
const mint = (d: number, reppoSpent: number): ActivityRow => ({ ts: day(d), kind: 'mint', status: 'executed', reppoSpent })
const claim = (d: number, reppoClaimed: number): ActivityRow => ({ ts: day(d), kind: 'claim', status: 'executed', reppoClaimed })
/** The REALIZED net (claimed − spent) the chart anchors to, built the way the backend builds
 *  it. `claimable` is emissions the node is owed and has NOT been paid — it must never move
 *  the curve, only sit beside it. */
const pnl = (net: number, claimableReppo = 0): Pnl => {
  const claimedReppo = net > 0 ? net : 0
  const spentReppo = net < 0 ? -net : 0
  return {
    claimedReppo, spentReppo, claimableReppo,
    earnedReppo: claimedReppo + claimableReppo,
    netReppo: claimedReppo + claimableReppo - spentReppo,
    gasSpentEth: 0,
  }
}

const losing = buildNetSeries([mint(1, 500), mint(2, 500), claim(3, 100)], pnl(-900))

describe('<NetChart /> — the trend, honestly', () => {
  it('exposes the whole trend in words to assistive tech', () => {
    render(<NetChart series={losing} />)
    const img = screen.getByRole('img')
    expect(img).toHaveAccessibleName(/realized reppo/i)
    expect(img).toHaveAccessibleName(/down 900 REPPO overall/i)
  })

  it('never draws a node that has claimed nothing above the zero line', () => {
    // 600 spent, nothing ever claimed, 900 REPPO of emissions pending. The backend's netReppo
    // reads +300, and anchoring to it filled the entire history GREEN for a node whose
    // realized position was never once positive.
    const rows = [mint(1, 200), mint(2, 200), mint(3, 200)]
    const s = buildNetSeries(rows, pnl(-600, 900))!
    const { container } = render(<NetChart series={s} />)
    expect(container.querySelector('.nc-now')).toHaveTextContent('-600 REPPO')
    expect(container.querySelector('.nc-now')).toHaveClass('neg')
    expect(container.querySelector('.nc-now')).not.toHaveClass('pos')
    // …and the money it IS owed is stated, beside the curve, never inside it.
    expect(container.querySelector('.nc-owed')).toHaveTextContent('900 REPPO due, not yet claimed')
  })

  it('shows the current value as text, not only as a shape', () => {
    const { container } = render(<NetChart series={losing} />)
    expect(container.querySelector('.nc-now')).toHaveTextContent('-900 REPPO')
    // ...and repeats the trend in a visible caption: a chart nobody can read is decoration.
    expect(container.querySelector('.nc-summary')).toHaveTextContent(/down 900 REPPO overall/i)
  })

  it('colours a loss with the loss colour and never the profit colour', () => {
    const { container } = render(<NetChart series={losing} />)
    expect(container.querySelector('.nc-now')).toHaveClass('neg')
    expect(container.querySelector('.nc-now')).not.toHaveClass('pos')
    expect(container.querySelector('.nc-dot')).toHaveClass('neg')
  })

  it('always draws the zero line, so a loss reads as BELOW break-even', () => {
    const { container } = render(<NetChart series={losing} />)
    const zero = container.querySelector('.nc-zero')!
    expect(zero).toBeInTheDocument()
    expect(container.querySelector('.nc-axis')).toHaveTextContent(/0 = break even/i)
    // The loss fill is clipped to the region BELOW the zero line (y grows downward).
    const zeroY = Number(zero.getAttribute('y1'))
    const clip = container.querySelector('#nc-clip-loss rect')!
    expect(Number(clip.getAttribute('y'))).toBe(zeroY)
  })

  it('says "recovering" when the loss is shrinking — and still owns the loss', () => {
    const { container } = render(<NetChart series={buildNetSeries([claim(1, 50), claim(2, 50)], pnl(-100))} />)
    expect(container.querySelector('.nc-trend')).toHaveTextContent('recovering')
    expect(container.querySelector('.nc-now')).toHaveTextContent('-100 REPPO')
  })

  it('says "getting worse" when the loss is deepening', () => {
    const { container } = render(<NetChart series={losing} />)
    expect(container.querySelector('.nc-trend')).toHaveTextContent('getting worse')
  })
})

describe('<NetChart /> — insufficient data must not draw a misleading line', () => {
  it('draws NO line at all from a single money event', () => {
    const { container } = render(<NetChart series={buildNetSeries([mint(1, 100)], pnl(-100))} />)
    expect(container.querySelector('svg')).toBeNull() // no chart — and not a flat line
    expect(container.querySelector('.nc-line')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent(/not enough history/i)
    // The value is still shown: an unknown TREND is not an unknown VALUE.
    expect(container.querySelector('.nc-now')).toHaveTextContent('-100 REPPO')
  })

  it('draws no line on an empty log, and says why', () => {
    const { container } = render(<NetChart series={buildNetSeries([], pnl(0))} />)
    expect(container.querySelector('svg')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent(/no mints or claims yet/i)
  })

  it('renders nothing at all when there is no authoritative net to anchor to', () => {
    const { container } = render(<NetChart series={null} />)
    expect(container).toBeEmptyDOMElement()
  })
})
