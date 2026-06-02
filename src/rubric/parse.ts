// src/rubric/parse.ts
import { z } from 'zod'
import { type DatanetRubric, RubricUnavailableError } from './types.js'

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number)
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
 *  Throws RubricUnavailableError if the rubric-essential fields are absent —
 *  the voter cannot operate generically on a datanet with no goal/vote rubric. */
export function parseDatanetRubric(raw: unknown): DatanetRubric {
  const m = MetadataSchema.parse(raw)
  const id = m.datanetId ?? m.tokenId
  const goal = m.subnetDescription?.trim() ?? ''
  const publisherSpec = m.onboardingPublishers?.trim() ?? ''
  const voterRubric = m.onboardingVoters?.trim() ?? ''

  if (id == null) throw new RubricUnavailableError('datanet metadata has no datanetId/tokenId')
  // Voting requires the voter rubric; minting needs goal or publisherSpec.
  if (!voterRubric) {
    throw new RubricUnavailableError(`datanet ${id}: no onboardingVoters — cannot judge pods`)
  }
  if (!goal && !publisherSpec) {
    throw new RubricUnavailableError(`datanet ${id}: no subnetDescription or onboardingPublishers`)
  }

  return {
    datanetId: String(id),
    name: m.subnetName?.trim() ?? `datanet ${id}`,
    goal,
    publisherSpec,
    voterRubric,
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
