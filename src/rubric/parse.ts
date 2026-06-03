// src/rubric/parse.ts
import { type DatanetRubric, RubricUnavailableError } from './types.js'

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

  if (id == null) throw new RubricUnavailableError('datanet metadata has no datanetId/tokenId')
  if (!goal && !voterRubric && !publisherSpec) {
    throw new RubricUnavailableError(`datanet ${id}: metadata carries no goal, voter rubric, or publisher spec`)
  }

  const nativeToken = m['nativeToken'] as Record<string, unknown> | undefined

  return {
    datanetId: String(id),
    name: name || `datanet ${id}`,
    goal,
    publisherSpec,
    voterRubric,
    canVote: voterRubric !== '',
    canMint: publisherSpec !== '',
    status: str(m['status']) || 'UNKNOWN',
    economics: {
      accessFeeReppo: num(m['accessFeeREPPO']),
      emissionsPerEpochReppo: num(m['emissionsPerEpochREPPO']),
      upVoteVolume: num(m['upVoteVolume']),
      downVoteVolume: num(m['downVoteVolume']),
      nativeTokenSymbol: str(nativeToken?.['symbol'] ?? m['nativeTokenSymbol']) || 'REPPO',
    },
  }
}
