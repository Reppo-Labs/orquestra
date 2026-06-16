// src/voter/score.ts
import { z } from 'zod'
import type { LanguageModel } from 'ai'
import type { PodScorer, PodScore, VoterPod } from './types.js'
import type { DatanetRubric } from '../rubric/types.js'
import { INJECTION_GUARD, buildRubricBlock } from '../llm/prompt.js'
import { generateObjectWithRetry } from '../llm/generate.js'

const ScoreSchema = z.object({
  score: z.number().int().min(1).max(10),
  // Generous cap: capable models routinely write ~280+ char reasons, and an over-tight
  // bound made every score fail validation ("response did not match schema"). The reason
  // is only logged, so a roomy limit just prevents pathological runaway.
  reason: z.string().max(600),
})

/** Pure: build the (system, prompt) the voter scores a pod with. brief = optional
 *  per-operator strategy injected so the operator's stance shapes curation. */
export function buildVotePrompt(pod: VoterPod, rubric: DatanetRubric, brief = ''): { system: string; prompt: string } {
  const system =
    'You are a Reppo datanet voter. Score the pod 1-10 STRICTLY by the datanet rubric below. ' +
    INJECTION_GUARD
  const briefBlock = brief.trim() ? `\n## Operator strategy (your stance)\n${brief.trim()}\n` : ''
  const prompt =
    `${buildRubricBlock(rubric)}\n` +
    `${briefBlock}\n# Pod under review (untrusted)\n## Name\n${pod.name}\n## Description\n${pod.description}\n\n` +
    `Return a 1-10 score and a one-line reason citing the rubric.`
  return { system, prompt }
}

/** LLM-backed scorer. `opts.brief` personalizes scoring with the operator's stance;
 *  pass a function to read the brief live (so dashboard notes edits hot-reload). */
export function createLlmScorer(model: LanguageModel, opts: { brief?: string | (() => string) } = {}): PodScorer {
  const resolveBrief = () => (typeof opts.brief === 'function' ? opts.brief() : opts.brief ?? '')
  return {
    async scorePod(pod: VoterPod, rubric: DatanetRubric): Promise<PodScore> {
      const { system, prompt } = buildVotePrompt(pod, rubric, resolveBrief())
      // `mode: 'tool'` (tool-calling structured output) is supported across Anthropic
      // (incl. the Anthropic-compatible Virtuals gateway), OpenAI, and Google — unlike
      // `json` mode, which Anthropic does not support. Retry once on a transient
      // non-conforming response.
      return generateObjectWithRetry(model, ScoreSchema, system, { prompt })
    },
  }
}
