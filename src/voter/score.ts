// src/voter/score.ts
import { z } from 'zod'
import type { CoreMessage, FilePart, LanguageModel } from 'ai'
import type { PodScorer, PodScore, VoterPod } from './types.js'
import type { VoteRubric } from '../rubric/types.js'
import { INJECTION_GUARD, buildRubricBlock, buildEconomicsBlock } from '../llm/prompt.js'
import { currentDateLine } from '../llm/dateContext.js'
import { generateObjectWithRetry } from '../llm/generate.js'
import { isVideoPod, type VideoScoreCtx } from './videoPipeline.js'

const ScoreSchema = z.object({
  score: z.number().int().min(1).max(10),
  // Generous cap: capable models routinely write ~280+ char reasons, and an over-tight
  // bound made every score fail validation ("response did not match schema"). The reason
  // is only logged, so a roomy limit just prevents pathological runaway.
  reason: z.string().max(600),
})

const SYSTEM =
  'You are a Reppo datanet voter. Score the pod 1-10 STRICTLY by the datanet rubric below. ' +
  INJECTION_GUARD

/** SYSTEM plus the current-date line — computed per call, not at module load, so a
 *  long-running node never drifts a day behind (src/llm/dateContext.ts). */
const systemNow = (): string => `${SYSTEM} ${currentDateLine()}`

/** Pure: build the input the voter scores a pod with. A TEXT pod → `{ system, prompt }`
 *  (string, unchanged). A VIDEO pod (videoPart supplied) → `{ system, messages }`: a
 *  single user message of [rubric+brief text, the video FilePart, the 1-10 instruction].
 *  brief = optional per-operator strategy injected so the operator's stance shapes curation. */
export function buildVotePrompt(
  pod: VoterPod,
  rubric: VoteRubric,
  brief = '',
  videoPart?: FilePart,
): { system: string; prompt: string } | { system: string; messages: CoreMessage[] } {
  const briefBlock = brief.trim() ? `\n## Operator strategy (your stance)\n${brief.trim()}\n` : ''
  const econBlock = buildEconomicsBlock(rubric.economics.currentYield)
  if (videoPart) {
    const text =
      `${buildRubricBlock(rubric)}\n${econBlock}` +
      `${briefBlock}\n# Pod under review (untrusted)\n## Name\n${pod.name}\n\n` +
      `The attached video is the pod's dataset. Watch it and score 1-10 STRICTLY by the rubric. ` +
      `Return a 1-10 score and a one-line reason citing the rubric.`
    const messages: CoreMessage[] = [
      { role: 'user', content: [{ type: 'text', text }, videoPart] },
    ]
    return { system: systemNow(), messages }
  }
  const prompt =
    `${buildRubricBlock(rubric)}\n${econBlock}` +
    `${briefBlock}\n# Pod under review (untrusted)\n## Name\n${pod.name}\n## Description\n${pod.description}\n\n` +
    `Return a 1-10 score and a one-line reason citing the rubric.`
  return { system: systemNow(), prompt }
}

/** LLM-backed scorer. `opts.brief` personalizes scoring with the operator's stance;
 *  pass a function to read the brief live (so dashboard notes edits hot-reload).
 *  When `opts.video` is supplied, a VIDEO pod is scored through the VideoPodPipeline
 *  (per-pod Gemini resolution + ingest + cleanup, all owned there); the TEXT path
 *  always scores on the fixed `model` the wiring already resolved. */
export function createLlmScorer(
  model: LanguageModel,
  opts: { brief?: string | (() => string); video?: VideoScoreCtx } = {},
): PodScorer {
  const resolveBrief = () => (typeof opts.brief === 'function' ? opts.brief() : opts.brief ?? '')
  return {
    async scorePod(pod: VoterPod, rubric: VoteRubric): Promise<PodScore> {
      // Text pod → the original fixed-model text path, byte-for-byte unchanged. The wiring
      // already resolved `model` for this datanet (its override or the node default), so a
      // text pod never re-resolves here.
      // `mode: 'tool'` (tool-calling structured output) is supported across Anthropic
      // (incl. the Anthropic-compatible Virtuals gateway), OpenAI, and Google — unlike
      // `json` mode, which Anthropic does not support. Retry once on a transient
      // non-conforming response.
      if (!isVideoPod(pod)) {
        const built = buildVotePrompt(pod, rubric, resolveBrief())
        return generateObjectWithRetry(model, ScoreSchema, built.system, { prompt: (built as { prompt: string }).prompt })
      }
      // Video pod: hand off to the pipeline (per-pod Gemini resolution → ingest →
      // generate → cleanup-after-read). Without a ctx we can't reach the pipeline, so a
      // video pod is un-scoreable → THROW (selectVotes' per-pod try/catch records the
      // skip); the pipeline likewise throws its skip reasons (fail-closed, never aborts
      // the cycle). This scorer keeps only the prompt/schema knowledge it shares with
      // the text path — everything video-specific lives in the pipeline.
      const v = opts.video
      if (!v) throw new Error('video pod has no model context to resolve a Gemini model')
      return v.pipeline.scoreVideoPod(pod, v.policyModel, (videoModel, part) => {
        const built = buildVotePrompt(pod, rubric, resolveBrief(), part)
        return generateObjectWithRetry(videoModel, ScoreSchema, built.system, { messages: (built as { messages: CoreMessage[] }).messages })
      })
    },
  }
}
