// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { DatanetEconomics } from './DatanetEconomics'
import type { DatanetYield, Snapshot } from '../api'

// The board recommends where to VOTE, so it must never rank a datanet the node
// will refuse to vote on. cycle.ts skips vote scoring outright when a rewards
// pool is dry ("rewards pool dry — skipping vote scoring"), so a dry datanet on
// this board is advice that contradicts the node's own behaviour.

afterEach(cleanup)

const y = (o: Partial<DatanetYield> & { datanetId: string }): DatanetYield => ({
  emissionsPerEpochReppo: 0,
  epoch: 129,
  epochVoteVolume: 0,
  yieldPerVote: null,
  uncontested: false,
  poolReppo: null,
  poolPrimaryToken: null,
  runwayEpochs: null,
  poolDry: false,
  ...o,
})

const snap = (datanetEconomics: DatanetYield[]): Snapshot =>
  ({ ts: 0, balance: { reppo: 0, veReppo: 0 }, emissionsDue: { pods: [] }, datanetEconomics }) as unknown as Snapshot

const show = (rows: DatanetYield[]) =>
  render(<DatanetEconomics snapshot={snap(rows)} netNames={{}} onGoToStrategy={() => {}} />)

// The exact live shape from the Base node at epoch 129 that surfaced the bug:
// three dry datanets (two of them uncontested, so they sorted FIRST) crowding out
// datanet 9 — the only one with a pool that could actually pay.
const epoch129: DatanetYield[] = [
  y({ datanetId: '1', nativeTokenSymbol: 'USDC', uncontested: true, poolReppo: 0, poolPrimaryToken: 0, poolDry: true }),
  y({ datanetId: '5', emissionsPerEpochReppo: 6000, nativeTokenSymbol: 'WETH', uncontested: true, poolReppo: 0.014, poolPrimaryToken: 0, poolDry: true, runwayEpochs: 2.3e-6 }),
  y({ datanetId: '6', emissionsPerEpochReppo: 5000, uncontested: true, poolReppo: 775.9, poolPrimaryToken: 0, poolDry: true, runwayEpochs: 0.155 }),
  y({ datanetId: '9', emissionsPerEpochReppo: 500, epochVoteVolume: 662591.79, yieldPerVote: 7.54e-4, poolReppo: 969.02, poolDry: false, runwayEpochs: 1.94 }),
]

describe('<DatanetEconomics /> dry-pool ranking', () => {
  it('never ranks a dry datanet, and surfaces the solvent one it used to hide', () => {
    const { container } = show(epoch129)
    const rows = [...container.querySelectorAll('.yield-net')].map((e) => e.textContent)
    expect(rows).toEqual(['9'])
    // The false promise that made the bug so misleading: a dry pool pays the
    // "first voter" nothing.
    expect(screen.queryByText(/first voter takes epoch/)).not.toBeInTheDocument()
    expect(container.textContent).toContain('3 skipped — rewards pool dry')
  })

  it('explains an all-dry board instead of blaming the node', () => {
    const { container } = show(epoch129.filter((d) => d.poolDry))
    expect(container.querySelector('.yield-row')).toBeNull()
    expect(container.textContent).toContain('no datanet can pay a vote right now')
    expect(container.textContent).toContain('every')
    expect(container.textContent).not.toContain('no rankable datanets')
  })

  it('fails open: an UNREAD pool (poolDry false, pools null) still ranks', () => {
    // poolDry is set only on a successful read, so an RPC blip must not empty the board.
    const { container } = show([y({ datanetId: '4', emissionsPerEpochReppo: 100, uncontested: true, poolDry: false })])
    expect([...container.querySelectorAll('.yield-net')].map((e) => e.textContent)).toEqual(['4'])
    expect(container.textContent).toContain('first voter takes epoch 129')
  })
})
