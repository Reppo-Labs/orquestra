import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _resetDbs } from '../dashboard/db.js'
import { writeSnapshot, type Snapshot } from '../dashboard/snapshot.js'
import { addEconDeltas, type EconEpochRow } from './store.js'
import { buildLearnView } from './view.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-learnview-')) })
afterEach(() => { _resetDbs(); rmSync(dir, { recursive: true, force: true }) })

const econRow = (over: Partial<EconEpochRow> = {}): EconEpochRow => ({
  datanetId: '9', epoch: 100, ownerClaimedReppo: 50, voterClaimedReppo: 0,
  mintCostReppo: 40, mintCount: 1, votesCast: 0, ...over,
})

const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  ts: '2026-06-15T00:00:00.000Z', cycleId: 'c1',
  balance: { eth: 0, reppo: 0, veReppo: 0, usdc: 0 },
  votingPower: { power: 0, lockupCount: 0 },
  emissionsDue: { totalReppo: 0, pods: [] },
  budget: { mintReppoSpent: 0, mintGasSpentEth: 0, voteGasSpentEth: 0, claimGasSpentEth: 0, caps: {} as never },
  ...over,
})

describe('buildLearnView — econ', () => {
  it('carries econ for a datanet with econ_epochs coverage + a snapshot yield', () => {
    addEconDeltas(dir, [econRow()])
    writeSnapshot(dir, snapshot({
      datanetEconomics: [{
        datanetId: '9', emissionsPerEpochReppo: 10, epoch: 100, epochVoteVolume: 5, yieldPerVote: 2, uncontested: false,
        poolReppo: null, poolPrimaryToken: null, runwayEpochs: null, poolDry: false,
      }],
    }))
    const view = buildLearnView(dir, ['9'])
    expect(view.datanets['9'].econ).toBeDefined()
    expect(view.datanets['9'].econ?.epochsCovered).toBe(1)
    expect(view.datanets['9'].econ?.mintCostReppo).toBe(40)
    expect(view.datanets['9'].econ?.latestYieldPerVote).toBe(2)
  })

  it('omits econ when there are no econ_epochs rows for the datanet', () => {
    const view = buildLearnView(dir, ['9'])
    expect(view.datanets['9'].econ).toBeUndefined()
    expect(Object.keys(view.datanets['9'])).not.toContain('econ')
  })
})
