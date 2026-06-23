// src/learn/discoverDatanets.ts
// Proactive datanet discovery: surface a vote_enable proposal for any active datanet
// that has emissions (emissionsPerEpochReppo > 0) but is not yet vote-enabled in config.
// Runs once per epoch alongside reflection. No LLM call needed — purely data-driven.
import type { StrategyConfig } from '../config/schema.js'
import type { DatanetSummary } from '../reppo/listDatanets.js'
import { hasPendingProposal, insertProposal } from './store.js'

export function discoverDatanets(
  dataDir: string,
  datanets: DatanetSummary[],
  config: StrategyConfig,
  currentEpoch: number,
): void {
  const now = new Date().toISOString()
  for (const dn of datanets) {
    if (dn.emissionsPerEpochReppo <= 0) continue
    const policy = config.datanets[dn.id]
    if (policy?.vote) continue // already vote-enabled
    if (hasPendingProposal(dataDir, dn.id, 'vote_enable', 'true')) continue
    insertProposal(dataDir, {
      datanetId: dn.id,
      field: 'vote_enable',
      fromValue: 'false',
      toValue: 'true',
      rationale: `${dn.name} is distributing ${dn.emissionsPerEpochReppo.toFixed(2)} REPPO/epoch in emissions and is not yet enabled for voting.`,
      basisConfigMtime: now,
      createdEpoch: currentEpoch,
      createdTs: now,
    })
  }
}
