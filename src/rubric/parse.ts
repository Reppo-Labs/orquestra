// src/rubric/parse.ts
import { z } from 'zod'
import { type DatanetRubric, RubricUnavailableError } from './types.js'

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const MetadataSchema = z.object({
  datanetId: z.union([z.string(), z.number()]).optional(),
  tokenId: z.union([z.string(), z.number()]).optional(),
  subnetName: z.string().optional(),
  subnetDescription: z.string().optional(),
  onboardingPublishers: z.string().optional(),
  onboardingVoters: z.string().optional(),
  nativeTokenSymbol: z.string().optional(),
  accessFeeREPPO: z.unknown().optional(),
  emissionsPerEpochREPPO: z.unknown().optional(),
  status: z.string().optional(),
  upVoteVolume: z.unknown().optional(),
  downVoteVolume: z.unknown().optional(),
})

/** Parse Reppo datanet metadata into a DatanetRubric.
 *  Throws RubricUnavailableError only when the metadata carries NOTHING usable.
 *  Capability is gated downstream (the design's two-tier model): the voter needs
 *  `voterRubric` (or at least `goal`); the minter needs `publisherSpec`. A datanet
 *  with a goal + publisher spec but no voter rubric is still mintable, so we must
 *  not reject it here. */
export function parseDatanetRubric(raw: unknown): DatanetRubric {
  const m = MetadataSchema.parse(raw)
  const id = m.datanetId ?? m.tokenId
  const goal = m.subnetDescription?.trim() ?? ''
  const publisherSpec = m.onboardingPublishers?.trim() ?? ''
  const voterRubric = m.onboardingVoters?.trim() ?? ''

  if (id == null) throw new RubricUnavailableError('datanet metadata has no datanetId/tokenId')
  if (!goal && !voterRubric && !publisherSpec) {
    throw new RubricUnavailableError(`datanet ${id}: metadata carries no goal, voter rubric, or publisher spec`)
  }

  return {
    datanetId: String(id),
    name: m.subnetName?.trim() ?? `datanet ${id}`,
    goal,
    publisherSpec,
    voterRubric,
    canVote: voterRubric !== '',
    canMint: publisherSpec !== '',
    status: m.status ?? 'UNKNOWN',
    economics: {
      accessFeeReppo: num(m.accessFeeREPPO),
      emissionsPerEpochReppo: num(m.emissionsPerEpochREPPO),
      upVoteVolume: num(m.upVoteVolume),
      downVoteVolume: num(m.downVoteVolume),
      nativeTokenSymbol: m.nativeTokenSymbol ?? 'REPPO',
    },
  }
}
