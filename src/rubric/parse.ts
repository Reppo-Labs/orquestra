// src/rubric/parse.ts
import { type DatanetRubric, RubricUnavailableError } from './types.js'
import { REPPO_TOKEN_MAINNET } from '../reppo/mintFee.js'

/** Coerce any value to a finite number; objects are unwrapped via .formatted ?? .raw. */
const num = (v: unknown): number => {
  let coerced: unknown = v
  if (v !== null && typeof v === 'object') {
    const obj = v as Record<string, unknown>
    coerced = obj['formatted'] ?? obj['raw'] ?? v
  }
  const n = Number(coerced)
  return Number.isFinite(n) ? n : 0
}

/** Trim strings; return '' for anything else. */
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** Parse Reppo datanet metadata into a DatanetRubric.
 *
 *  Handles two shapes:
 *  - Flat (pre-0.7.0 platform): fields like `subnetDescription`, `subnetName`,
 *    `onboardingPublishers`, `onboardingVoters`, `nativeTokenSymbol` live at the
 *    top level.
 *  - Nested (CLI 0.7.0+): the same fields (as `description`, `name`, etc.) live
 *    under a `.metadata` object; top-level fields are `datanetId`, `network`,
 *    `valid`, `accessFeeREPPO` (object), and `metadata`.
 *
 *  The two records are merged so that nested `.metadata` values win when present.
 *
 *  Throws RubricUnavailableError only when the metadata carries NOTHING usable.
 *  Capability is gated downstream (the design's two-tier model): the voter needs
 *  `voterRubric` (or at least `goal`); the minter needs `publisherSpec`. A datanet
 *  with a goal + publisher spec but no voter rubric is still mintable. */
export function parseDatanetRubric(raw: unknown): DatanetRubric {
  const top = (raw != null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const nested =
    top['metadata'] != null && typeof top['metadata'] === 'object'
      ? (top['metadata'] as Record<string, unknown>)
      : {}

  // Merge: top-level first, then nested wins for overlapping keys.
  const m: Record<string, unknown> = { ...top, ...nested }

  const id = (m['datanetId'] ?? m['tokenId']) as string | number | undefined
  const goal = str(m['subnetDescription'] ?? m['description'])
  const name = str(m['subnetName'] ?? m['name'])
  const publisherSpec = str(m['onboardingPublishers'])
  const voterRubric = str(m['onboardingVoters'])
  const subnetUuid = str(m['subnetUuid'])

  if (id == null) throw new RubricUnavailableError('datanet metadata has no datanetId/tokenId')
  if (!goal && !voterRubric && !publisherSpec) {
    throw new RubricUnavailableError(`datanet ${id}: metadata carries no goal, voter rubric, or publisher spec`)
  }

  const nativeToken = m['nativeToken'] as Record<string, unknown> | undefined
  const nativeSymbol = str(nativeToken?.['symbol'] ?? m['nativeTokenSymbol']) || 'REPPO'

  return {
    datanetId: String(id),
    name: name || `datanet ${id}`,
    goal,
    publisherSpec,
    voterRubric,
    subnetUuid,
    canVote: voterRubric !== '',
    canMint: publisherSpec !== '',
    status: str(m['status']) || 'UNKNOWN',
    economics: {
      accessFeeReppo: num(m['accessFeeREPPO']),
      ...accessFeeToken(m, nativeToken, nativeSymbol),
      emissionsPerEpochReppo: num(m['emissionsPerEpochREPPO']),
      upVoteVolume: num(m['upVoteVolume']),
      downVoteVolume: num(m['downVoteVolume']),
      nativeTokenSymbol: nativeSymbol,
    },
  }
}

/** Derive `accessFeeToken` ONLY when the datanet charges a NON-REPPO access fee, per
 *  the reppo >=0.8.5 `query datanet --json` shape:
 *    primaryToken: { address, decimals }                       — present when valid
 *    accessFeePrimaryToken: { raw, formatted } | { unavailable }
 *  A non-REPPO fee requires: a valid primaryToken, a positive accessFeePrimaryToken
 *  amount, AND that primary token NOT being REPPO (by nativeToken symbol or address).
 *  Otherwise returns {} so the spread leaves accessFeeToken undefined — today's REPPO
 *  datanets (and older CLIs that omit these fields) are unchanged. */
function accessFeeToken(
  m: Record<string, unknown>,
  nativeToken: Record<string, unknown> | undefined,
  nativeSymbol: string,
): { accessFeeToken?: NonNullable<DatanetRubric['economics']['accessFeeToken']> } {
  const primary = m['primaryToken']
  if (primary == null || typeof primary !== 'object') return {}
  const p = primary as Record<string, unknown>
  const address = str(p['address'])
  if (!address) return {}

  // accessFeePrimaryToken: { raw, formatted } when set, { unavailable } otherwise.
  const fee = m['accessFeePrimaryToken']
  if (fee == null || typeof fee !== 'object') return {}
  const f = fee as Record<string, unknown>
  if (f['formatted'] === undefined) return {} // { unavailable } or missing → not a primary-token fee
  const amount = num(f['formatted'])
  if (!(amount > 0)) return {}

  // Only NON-REPPO primary tokens route to --token primary. A primary token that is
  // REPPO (by symbol or by the known mainnet address) stays on the REPPO path.
  const nativeAddress = str(nativeToken?.['address'])
  const isReppo =
    nativeSymbol === 'REPPO' ||
    eqAddr(address, REPPO_TOKEN_MAINNET) ||
    (nativeAddress !== '' && eqAddr(nativeAddress, REPPO_TOKEN_MAINNET))
  if (isReppo) return {}

  return {
    accessFeeToken: {
      address,
      symbol: nativeSymbol,
      decimals: Math.trunc(num(p['decimals'])),
      amount,
    },
  }
}

/** Case-insensitive EVM address compare. */
const eqAddr = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
