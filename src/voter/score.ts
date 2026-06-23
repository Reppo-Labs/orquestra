// src/voter/score.ts
import { z } from 'zod'
import type { CoreMessage, FilePart, LanguageModel } from 'ai'
import type { PodScorer, PodScore, VoterPod } from './types.js'
import type { DatanetRubric } from '../rubric/types.js'
import type { LlmProvider } from '../llm/model.js'
import { INJECTION_GUARD, buildRubricBlock } from '../llm/prompt.js'
import { generateObjectWithRetry } from '../llm/generate.js'
import { resolveScoringModel, type ModelResolver } from '../llm/resolveScoringModel.js'
import { ingestVideo } from '../llm/videoIngest.js'

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

/** Pure: build the input the voter scores a pod with. A TEXT pod → `{ system, prompt }`
 *  (string, unchanged). A VIDEO pod (videoPart supplied) → `{ system, messages }`: a
 *  single user message of [rubric+brief text, the video FilePart, the 1-10 instruction].
 *  brief = optional per-operator strategy injected so the operator's stance shapes curation. */
export function buildVotePrompt(
  pod: VoterPod,
  rubric: DatanetRubric,
  brief = '',
  videoPart?: FilePart,
): { system: string; prompt: string } | { system: string; messages: CoreMessage[] } {
  const briefBlock = brief.trim() ? `\n## Operator strategy (your stance)\n${brief.trim()}\n` : ''
  if (videoPart) {
    const text =
      `${buildRubricBlock(rubric)}\n` +
      `${briefBlock}\n# Pod under review (untrusted)\n## Name\n${pod.name}\n\n` +
      `The attached video is the pod's dataset. Watch it and score 1-10 STRICTLY by the rubric. ` +
      `Return a 1-10 score and a one-line reason citing the rubric.`
    const messages: CoreMessage[] = [
      { role: 'user', content: [{ type: 'text', text }, videoPart] },
    ]
    return { system: SYSTEM, messages }
  }
  const prompt =
    `${buildRubricBlock(rubric)}\n` +
    `${briefBlock}\n# Pod under review (untrusted)\n## Name\n${pod.name}\n## Description\n${pod.description}\n\n` +
    `Return a 1-10 score and a one-line reason citing the rubric.`
  return { system: SYSTEM, prompt }
}

/** Inputs needed to resolve a per-pod scoring model (Phase A) + ingest video. Passed
 *  by the wiring; absent ctx ⇒ text-only behavior on the node-default `model`. */
export interface ScorerModelCtx {
  registry: Map<LlmProvider, string>
  defaultProvider: LlmProvider
  defaultModel: string
  /** the datanet's optional { provider, model } override (config.datanets[id].model). */
  policyModel?: { provider: LlmProvider; model: string }
  /** Model resolver seam — defaults to the plain resolveModel. Threaded so the video
   *  re-resolution honors the same oauth-aware resolver as the text path. */
  resolveModel?: ModelResolver
}

/** LLM-backed scorer. `opts.brief` personalizes scoring with the operator's stance;
 *  pass a function to read the brief live (so dashboard notes edits hot-reload).
 *  When `opts.modelCtx` is supplied, a VIDEO pod is re-resolved PER POD (Phase A) to a
 *  Gemini model and watched via @ai-sdk/google; the TEXT path always scores on the
 *  fixed `model` the wiring already resolved (byte-for-byte the original behavior). */
export function createLlmScorer(
  model: LanguageModel,
  opts: { brief?: string | (() => string); modelCtx?: ScorerModelCtx | (() => ScorerModelCtx) } = {},
): PodScorer {
  const resolveBrief = () => (typeof opts.brief === 'function' ? opts.brief() : opts.brief ?? '')
  const resolveCtx = () => (typeof opts.modelCtx === 'function' ? opts.modelCtx() : opts.modelCtx)
  return {
    async scorePod(pod: VoterPod, rubric: DatanetRubric): Promise<PodScore> {
      const isVideo = !!pod.mediaUrl
      // Text pod → the original fixed-model text path, byte-for-byte unchanged. The wiring
      // already resolved `model` for this datanet (its override or the node default), so a
      // text pod never re-resolves here.
      // `mode: 'tool'` (tool-calling structured output) is supported across Anthropic
      // (incl. the Anthropic-compatible Virtuals gateway), OpenAI, and Google — unlike
      // `json` mode, which Anthropic does not support. Retry once on a transient
      // non-conforming response.
      if (!isVideo) {
        const built = buildVotePrompt(pod, rubric, resolveBrief())
        return generateObjectWithRetry(model, ScoreSchema, built.system, { prompt: (built as { prompt: string }).prompt })
      }
      // Video pod: re-resolve PER POD (a video pod needs a Gemini model). Without a ctx we
      // can't reach the registry/defaults, so a video pod is un-scoreable → THROW (selectVotes'
      // per-pod try/catch records the skip). With a ctx, resolveScoringModel enforces the
      // resolution order (override → google default → skip-with-reason).
      const ctx = resolveCtx()
      if (!ctx) throw new Error('video pod has no model context to resolve a Gemini model')
      const resolved = resolveScoringModel({
        policyModel: ctx.policyModel,
        isVideo: true,
        registry: ctx.registry,
        defaultProvider: ctx.defaultProvider,
        defaultModel: ctx.defaultModel,
      }, ctx.resolveModel) // undefined ⇒ resolveScoringModel's default (plain resolveModel)
      if ('skip' in resolved) throw new Error(resolved.skip)
      // Ingest (size-branched) → FilePart, build messages, score. A skip reason THROWS so
      // selectVotes' per-pod try/catch records it (fail-closed, never aborts the cycle).
      // contentLength (from detection, threaded onto the pod) lets ingestVideo skip a
      // known-oversize video BEFORE downloading it (null ⇒ it fetches + re-measures).
      const ingest = await ingestVideo({
        url: pod.mediaUrl as string,
        mediaType: pod.mediaType ?? 'video/mp4',
        contentLength: pod.contentLength ?? null,
        googleKey: ctx.registry.get('google'),
      })
      if ('skip' in ingest) throw new Error(ingest.skip)
      // The Files-API path returns a cleanup that deletes the uploaded file. Delete it AFTER
      // generateObject has read the fileData URI (deleting before would 404 the request) —
      // run it in finally so a scoring throw still cleans up the remote file.
      try {
        const built = buildVotePrompt(pod, rubric, resolveBrief(), ingest.part)
        return await generateObjectWithRetry(resolved.model, ScoreSchema, built.system, { messages: (built as { messages: CoreMessage[] }).messages })
      } finally {
        await ingest.cleanup?.()
      }
    },
  }
}
