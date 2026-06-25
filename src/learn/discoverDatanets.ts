// src/learn/discoverDatanets.ts
// Proactive datanet discovery: surface a vote_enable proposal for any active datanet that
// has emissions and is not yet vote-enabled in config. Emissions can be REPPO
// (emissionsPerEpochReppo > 0) OR a non-REPPO native token (dn.nativeToken set — e.g. LBM
// for Litebeam). Both are claimable by the node (PodManagerV2 pays the subnet's primary
// token too), so both qualify. Runs once per epoch alongside reflection. No LLM call needed.
import type { StrategyConfig } from '../config/schema.js'
import type { DatanetSummary } from '../reppo/listDatanets.js'
import { hasPendingProposal, insertProposal } from './store.js'

/** Resolve a subnet's per-epoch native-token emission amount (human units) for the proposal
 *  rationale. Returns null when unknown (no RPC wired, or the read failed) → the rationale
 *  falls back to a quantity-less description. Best-effort; never throws into discovery. */
export type NativeEmissionResolver = (subnetId: string) => Promise<number | null>

export async function discoverDatanets(
  dataDir: string,
  datanets: DatanetSummary[],
  config: StrategyConfig,
  currentEpoch: number,
  resolveNativeEmissions?: NativeEmissionResolver,
): Promise<void> {
  const now = new Date().toISOString()
  for (const dn of datanets) {
    const hasEmissions = dn.emissionsPerEpochReppo > 0 || Boolean(dn.nativeToken)
    if (!hasEmissions) continue
    const policy = config.datanets[dn.id]
    if (policy?.vote) continue // already vote-enabled
    if (hasPendingProposal(dataDir, dn.id, 'vote_enable', 'true')) continue

    let emissionDesc: string
    if (dn.emissionsPerEpochReppo > 0) {
      emissionDesc = `${dn.emissionsPerEpochReppo.toFixed(2)} REPPO/epoch`
    } else if (dn.nativeToken) {
      // resolve the magnitude when a resolver is wired; otherwise stay quantity-less.
      const amount = resolveNativeEmissions ? await resolveNativeEmissions(dn.id).catch(() => null) : null
      emissionDesc = amount != null
        ? `${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${dn.nativeToken.symbol}/epoch`
        : `${dn.nativeToken.symbol}/epoch`
    } else {
      continue // unreachable given the gate above; keeps the type narrow without a `!` assertion
    }

    insertProposal(dataDir, {
      datanetId: dn.id,
      field: 'vote_enable',
      fromValue: 'false',
      toValue: 'true',
      rationale: `${dn.name} is distributing ${emissionDesc} in emissions and is not yet enabled for voting.`,
      basisConfigMtime: now,
      createdEpoch: currentEpoch,
      createdTs: now,
    })
  }
}
