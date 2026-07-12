// src/learn/reflect.ts
// Reflect step: distill deterministic calibration stats into a few grounded lessons
// (and optional config proposals). HYBRID — the numbers are computed in stats.ts and
// passed in; the LLM only phrases them. It is fed NO raw pod/panel text (defense
// against laundering an injection into a persistent "trusted" lesson), and is
// explicitly barred from "follow the crowd" lessons (the deepest design risk: the
// only signal is consensus, but chasing it defeats early rubric-correct curation).
import { z } from 'zod'
import type { LanguageModel } from 'ai'
import { generateObjectWithRetry } from '../llm/generate.js'
import { INJECTION_GUARD } from '../llm/prompt.js'
import type { StrategyConfig } from '../config/schema.js'
import { getDb } from '../dashboard/db.js'
import { readSnapshot } from '../dashboard/snapshot.js'
import { computeStats, type LearnStats } from './stats.js'
import { computeEconStats, type EconStats } from './econStats.js'
import { readOutcomes, insertLesson, clearLessons, insertProposal, hasPendingProposal, readEconEpochs } from './store.js'

/** Below this many matured outcomes, abstain entirely (cold start → no overfit lessons). */
export const MIN_SAMPLE = 5
/** Config proposals are higher-stakes than prompt nudges — require more evidence (2× lessons). */
export const MIN_SAMPLE_PROPOSAL = 10
/** The economics half needs at least 2 epochs of history before it may propose mint_enable/
 *  vote_share — one noisy epoch must not flip config. */
const MIN_ECON_EPOCHS_PROPOSAL = 2

const STRICTNESS = ['conservative', 'balanced', 'aggressive'] as const
const VOTE_SHARE_MIN = 1
const VOTE_SHARE_MAX = 10

export const ReflectionSchema = z.object({
  lessons: z.array(z.string().max(200)).max(5),
  proposals: z.array(z.object({
    field: z.enum(['strictness', 'mint_enable', 'vote_share']),
    toValue: z.string(),
    rationale: z.string().max(200),
  })).max(2),
})
export type Reflection = z.infer<typeof ReflectionSchema>

export interface CurrentTunables { strictness: string }

/** Pure: build the (system, prompt) for the reflection call from stats only. `econ` is
 *  omitted from the prompt entirely when absent or covering zero epochs — byte-identical
 *  to the pre-economics prompt in that case. */
export function buildReflectionPrompt(datanetLabel: string, stats: LearnStats, current: CurrentTunables, econ?: EconStats): { system: string; prompt: string } {
  const system =
    'You are the reflection module of a self-improving Reppo datanet voter. You refine how the node ' +
    'INTERPRETS the rubric, using only its own past calibration statistics. RULES: ' +
    '(1) Output AT MOST 5 short lessons; each MUST cite a specific number from the stats below. ' +
    '(2) Lessons may ONLY refine rubric interpretation or scoring calibration (e.g. "tighten the read on X", ' +
    '"high-conviction calls on Y held up"). They MUST NOT instruct following, matching, or predicting crowd ' +
    'consensus — chasing the majority defeats early rubric-correct curation. ' +
    '(3) If the sample is small or the signal is weak, return FEWER or ZERO lessons — never invent a pattern. ' +
    '(4) You MAY propose at most 2 tweaks ONLY when a number clearly justifies it — strictness ' +
    '(conservative/balanced/aggressive), mint_enable (true/false), or vote_share (integer 1-10); ' +
    'an operator reviews every proposal before it applies. ' +
    '(5) Profitability matters as much as alignment: if mint ROI is well below 100%, propose mint_enable=false ' +
    'or a stricter strictness; if this datanet\'s yield is high or it is uncontested and vote results are aligned, ' +
    'propose a higher vote_share. ' +
    INJECTION_GUARD
  let prompt =
    `# Datanet ${datanetLabel} — calibration over the last ${stats.sampleEpochs} epoch(s), ${stats.maturedTotal} matured decision(s)\n` +
    `## Current config\nstrictness=${current.strictness}\n` +
    `## Vote/crowd alignment (a calibration check, NOT a target)\n` +
    `- votes: ${stats.voteTotal}, aligned ${stats.voteAlignmentPct}%\n` +
    `- up-votes: ${stats.upVoteTotal}, aligned ${stats.upVoteAlignedPct}%\n` +
    `- down-votes: ${stats.downVoteTotal}, aligned ${stats.downVoteAlignedPct}%\n` +
    `## Conviction calibration\n` +
    `- high-conviction (>=7): ${stats.highConvictionTotal}, aligned ${stats.highConvictionAlignedPct}%\n` +
    `- low-conviction (<=4): ${stats.lowConvictionTotal}, aligned ${stats.lowConvictionAlignedPct}%\n` +
    `- high-conviction reversals (we were confident, crowd strongly disagreed): ${stats.highConvictionReversals}\n` +
    `## Mints\n- minted pods: ${stats.mintTotal}, net-upvoted ${stats.mintAlignmentPct}%\n\n`
  if (econ && econ.epochsCovered > 0) {
    const roiPart = econ.mintRoiPct !== null ? ` (ROI ${econ.mintRoiPct}%)` : ''
    const perVotePart = econ.voterReppoPerVote !== null ? ` (${econ.voterReppoPerVote.toExponential(2)} REPPO/vote)` : ''
    const yieldPart = econ.latestYieldPerVote !== null ? `Current emission yield: ${econ.latestYieldPerVote.toExponential(2)} REPPO per vote weight.` : ''
    const uncontestedPart = econ.latestUncontested ? ' This datanet is currently UNCONTESTED (first voter takes the epoch).' : ''
    prompt +=
      `## Economics (REPPO, last ${econ.epochsCovered} epoch(s))\n` +
      `Mint: spent ${econ.mintCostReppo} REPPO on ${econ.mintCount} mints; owner emissions claimed ${econ.ownerClaimedReppo} REPPO${roiPart}.\n` +
      `Voting: ${econ.votesCast} votes cast; voter emissions ${econ.voterClaimedReppo} REPPO${perVotePart}.\n` +
      `${yieldPart}${uncontestedPart}\n\n`
  }
  prompt += `Return lessons (each citing a number) and any justified config proposals.`
  return { system, prompt }
}

export async function reflect(model: LanguageModel, datanetLabel: string, stats: LearnStats, current: CurrentTunables, econ?: EconStats): Promise<Reflection> {
  const { system, prompt } = buildReflectionPrompt(datanetLabel, stats, current, econ)
  return generateObjectWithRetry(model, ReflectionSchema, system, { prompt })
}

/** Orchestrate one datanet's reflection: stats → LLM lessons → persist (replacing the
 *  prior active lessons) + queue any valid config proposals. Best-effort caller wraps
 *  this; it abstains (no LLM call) below the cold-start sample floor. */
export async function runReflection(
  dataDir: string,
  model: LanguageModel,
  datanetId: string,
  config: StrategyConfig,
  currentEpoch: number,
): Promise<void> {
  const stats = computeStats(readOutcomes(dataDir, datanetId), datanetId)
  if (stats.maturedTotal < MIN_SAMPLE) return // cold start — gather more before learning

  const current: CurrentTunables = {
    strictness: config.datanets[datanetId]?.strictness ?? 'balanced',
  }
  const currentMint = String(config.datanets[datanetId]?.mint ?? false)
  const currentVoteShare = String(config.datanets[datanetId]?.voteShare ?? 1)

  const snapshot = readSnapshot(dataDir)
  const latestYield = snapshot?.datanetEconomics?.find((d) => d.datanetId === datanetId)
  const econ = computeEconStats(datanetId, readEconEpochs(dataDir, datanetId), latestYield)

  const reflection = await reflect(model, datanetId, stats, current, econ)

  const now = new Date().toISOString()
  // Supersede the prior active set atomically: the LLM call has already returned, so
  // there is no await between BEGIN and COMMIT. A crash/throw mid-way must not leave the
  // datanet with zero lessons (silently dropping learned calibration).
  const db = getDb(dataDir)
  db.exec('BEGIN')
  try {
    clearLessons(dataDir, datanetId) // operator veto persists as active=0
    for (const text of reflection.lessons) {
      if (text.trim()) insertLesson(dataDir, { datanetId, text: text.trim(), source: 'calibration', createdEpoch: currentEpoch, createdTs: now, active: 1 })
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }

  if (stats.maturedTotal < MIN_SAMPLE_PROPOSAL) return // not enough evidence for config changes
  for (const p of reflection.proposals) {
    if (p.field === 'strictness') {
      if (!(STRICTNESS as readonly string[]).includes(p.toValue) || p.toValue === current.strictness) continue
      if (hasPendingProposal(dataDir, datanetId, 'strictness', p.toValue)) continue
      insertProposal(dataDir, { datanetId, field: 'strictness', fromValue: current.strictness, toValue: p.toValue, rationale: p.rationale, basisConfigMtime: now, createdEpoch: currentEpoch, createdTs: now })
    } else if (p.field === 'mint_enable') {
      // Economics-derived tunables need >=2 epochs of history — one noisy epoch must not flip config.
      if (econ.epochsCovered < MIN_ECON_EPOCHS_PROPOSAL) continue
      if ((p.toValue !== 'true' && p.toValue !== 'false') || p.toValue === currentMint) continue
      if (hasPendingProposal(dataDir, datanetId, 'mint_enable', p.toValue)) continue
      insertProposal(dataDir, { datanetId, field: 'mint_enable', fromValue: currentMint, toValue: p.toValue, rationale: p.rationale, basisConfigMtime: now, createdEpoch: currentEpoch, createdTs: now })
    } else if (p.field === 'vote_share') {
      if (econ.epochsCovered < MIN_ECON_EPOCHS_PROPOSAL) continue
      if (!/^\d+$/.test(p.toValue)) continue
      const n = Number(p.toValue)
      if (n < VOTE_SHARE_MIN || n > VOTE_SHARE_MAX || p.toValue === currentVoteShare) continue
      if (hasPendingProposal(dataDir, datanetId, 'vote_share', p.toValue)) continue
      insertProposal(dataDir, { datanetId, field: 'vote_share', fromValue: currentVoteShare, toValue: p.toValue, rationale: p.rationale, basisConfigMtime: now, createdEpoch: currentEpoch, createdTs: now })
    }
  }
}
