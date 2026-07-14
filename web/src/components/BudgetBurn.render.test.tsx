// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { BudgetBurn } from './BudgetBurn'
import type { Snapshot, BudgetCaps } from '../api'

// Real render smoke tests for BudgetBurn — complements the pure-logic budgetBar
// tests in BudgetBurn.test.ts by asserting what actually lands in the DOM: the
// spent / cap line, the ∞ uncapped label, the "hot" (>=80%) bar class, and the
// zero-cap guard (width 0%, no Infinity). Runs in jsdom (docblock above); the
// node-env tests are untouched.

afterEach(cleanup)

/** Minimal Snapshot carrying only the budget slice BudgetBurn reads. */
function snap(mintReppoSpent: number, caps: BudgetCaps): Snapshot {
  return {
    ts: 0,
    balance: { reppo: 0, veReppo: 0 },
    emissionsDue: { pods: [] },
    budget: {
      voteGasSpentEth: 0,
      mintReppoSpent,
      mintGasSpentEth: 0,
      claimGasSpentEth: 0,
      caps,
    },
  } as Snapshot
}

const bar = (c: HTMLElement) => c.querySelector('.bar') as HTMLElement
const fill = (c: HTMLElement) => c.querySelector('.bar > div') as HTMLElement

describe('<BudgetBurn /> render', () => {
  it('shows the spent value against the numeric cap and a cool (not hot) bar', () => {
    const { container } = render(<BudgetBurn snapshot={snap(25, { mintReppoMax: 100 })} />)
    expect(container.querySelector('.k')).toHaveTextContent('Mint REPPO')
    // value line is "<spent> / <cap>" (fmt-formatted)
    expect(container.querySelector('.v')).toHaveTextContent('25 / 100')
    expect(bar(container)).not.toHaveClass('hot')
    expect(fill(container)).toHaveStyle({ width: '25%' })
  })

  it('formats a large cap with thousands separators', () => {
    const { container } = render(<BudgetBurn snapshot={snap(0, { mintReppoMax: 1000 })} />)
    expect(container.querySelector('.v')).toHaveTextContent('0 / 1,000')
  })

  it('flags the bar "hot" at 80% spent and fills it 80%', () => {
    const { container } = render(<BudgetBurn snapshot={snap(80, { mintReppoMax: 100 })} />)
    expect(bar(container)).toHaveClass('hot')
    expect(fill(container)).toHaveStyle({ width: '80%' })
  })

  it('stays cool just below the 80% threshold', () => {
    const { container } = render(<BudgetBurn snapshot={snap(79, { mintReppoMax: 100 })} />)
    expect(bar(container)).not.toHaveClass('hot')
  })

  it('renders an ∞ label and an empty (0%) bar when the mint cap is uncapped', () => {
    // caps present but mintReppoMax undefined ⇒ maxLabel '∞', pct 0 (no div-by-zero)
    const { container } = render(<BudgetBurn snapshot={snap(50, {})} />)
    expect(container.querySelector('.v')).toHaveTextContent('50 / ∞')
    expect(bar(container)).not.toHaveClass('hot')
    expect(fill(container)).toHaveStyle({ width: '0%' })
  })

  it('guards a zero cap: numeric 0 label, 0% width, never Infinity or NaN', () => {
    const { container } = render(<BudgetBurn snapshot={snap(50, { mintReppoMax: 0 })} />)
    expect(container.querySelector('.v')).toHaveTextContent('50 / 0')
    expect(fill(container)).toHaveStyle({ width: '0%' })
  })

  it('shows the pending placeholder when there is no snapshot yet', () => {
    const { getByText } = render(<BudgetBurn snapshot={null} />)
    expect(getByText('budget pending first cycle')).toBeInTheDocument()
  })
})
