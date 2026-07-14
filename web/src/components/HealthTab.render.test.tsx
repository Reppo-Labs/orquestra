// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { HealthTab } from './HealthTab'
import type { DatanetEntry, Health, HealthDatanet } from '../api'

// The audited lie: "Node-wide tx success: 100% (224 executed / 0 failed)" while 9 of 14
// datanets were idle and erroring. An idle datanet attempts no tx, so it cannot fail one
// — the headline must therefore be COVERAGE, and tx success must be scoped to attempts.

afterEach(cleanup)

const dn = (over: Partial<DatanetEntry> = {}): DatanetEntry => ({ vote: true, mint: false, strictness: 'balanced', ...over })
const cfg = (ids: string[]): Record<string, DatanetEntry> => Object.fromEntries(ids.map((id) => [id, dn()]))

const net = (id: string, idle: boolean, executed = 0, failed = 0): HealthDatanet => ({
  datanetId: id,
  votes: { executed, refused: 0, error: failed },
  mints: { executed: 0, refused: 0, error: 0 },
  claims: { executed: 0, refused: 0, error: 0 },
  skips: idle ? 1 : 0,
  topErrors: failed ? [{ code: 'TX_REVERTED', count: failed }] : [],
  idle,
  lastSkipReason: idle ? 'no adapter for this datanet' : undefined,
  txRate: { executed, failed, rate: executed + failed > 0 ? executed / (executed + failed) : null },
})

/** 14 datanets: 5 working (224 executed, 0 failed), 9 idle — the audited node. */
const health: Health = {
  entriesScanned: 300,
  datanets: [
    ...Array.from({ length: 5 }, (_, i) => net(`${i + 1}`, false, 45 - i, 0)),
    ...Array.from({ length: 9 }, (_, i) => net(`${i + 6}`, true)),
  ],
  txRate: { executed: 224, failed: 0, rate: 1 },
}

describe('<HealthTab /> headline', () => {
  it('leads with coverage — how much of the node is actually working', () => {
    const { getByRole } = render(<HealthTab health={health} loaded netNames={{}} />)
    const headline = getByRole('status', { name: /coverage/i })
    expect(headline).toHaveTextContent('5 of 14 datanets active')
    expect(headline).toHaveTextContent('9 idle')
  })

  it('scopes tx success to ATTEMPTED transactions and says idle datanets attempt none', () => {
    const { container } = render(<HealthTab health={health} loaded netNames={{}} />)
    const text = container.textContent ?? ''
    expect(text).toContain('Of the transactions actually attempted')
    expect(text).toContain('100% succeeded (224 executed, 0 failed)')
    expect(text).toMatch(/cannot fail one/i)
    // the old, misleading framing is gone
    expect(text).not.toContain('Node-wide tx success')
  })

  it('does not colour operational state green — green is reserved for profit', () => {
    const { container } = render(<HealthTab health={health} loaded netNames={{}} />)
    // 'active' pills are neutral (.pill.active), never .pos / .pill.up
    expect(container.querySelectorAll('.pill.active').length).toBe(5)
    expect(container.querySelectorAll('.pill.idle').length).toBe(9)
    expect(container.querySelectorAll('.pill.up').length).toBe(0)
    expect(container.querySelectorAll('.pos').length).toBe(0)
  })

  it('reports full coverage without an idle clause when every datanet is working', () => {
    const allActive: Health = {
      entriesScanned: 10,
      datanets: [net('1', false, 3, 0), net('2', false, 2, 1)],
      txRate: { executed: 5, failed: 1, rate: 5 / 6 },
    }
    const { getByRole, container } = render(<HealthTab health={allActive} loaded netNames={{}} />)
    expect(getByRole('status', { name: /coverage/i })).toHaveTextContent('2 of 2 datanets active')
    expect(container.querySelector('.health-idle')).toBeNull()
    expect(container.textContent).toContain('83% succeeded')
  })

  it('agrees with Home: switched-off datanets leave the denominator and are named separately', () => {
    // Home said "2 of 14 datanets working" while this panel said "8 of 8 datanets active".
    // One node, two headline numbers, no way to reconcile them. Both now come from coverage().
    const off = { ...cfg(['1', '2', '3', '4', '5']), '6': dn({ vote: false, mint: false }) }
    const { getByRole, container } = render(
      <HealthTab health={health} loaded datanets={off} activity={[]} netNames={{}} />,
    )
    expect(getByRole('status', { name: /coverage/i })).toHaveTextContent('5 of 5 datanets working')
    expect(container.querySelector('.health-idle')).toHaveTextContent('1 switched off')
  })

  it('says no tx were attempted rather than implying a 0% failure rate', () => {
    const fresh: Health = {
      entriesScanned: 2,
      datanets: [net('1', true)],
      txRate: { executed: 0, failed: 0, rate: null },
    }
    const { container } = render(<HealthTab health={fresh} loaded netNames={{}} />)
    expect(container.textContent).toContain('none attempted yet')
  })
})
