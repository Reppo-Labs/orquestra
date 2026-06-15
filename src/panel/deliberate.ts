// src/panel/deliberate.ts — runPanel: three personas score in parallel, then the
// judge reconciles them into one verdict. Resilient by design: surviving panelists
// still produce a ruling; total failure is signalled so the caller can fall back.
import type { LanguageModel } from 'ai'
import type { ZodType } from 'zod'
import type { PanelistVerdict, PanelTranscript } from './types.js'
import { PERSONAS, PanelistSchema, buildPersonaPrompt, type PanelInput } from './personas.js'
import { JudgeSchema, buildJudgePrompt } from './judge.js'
import { generateObjectWithRetry } from '../llm/generate.js'

/** One structured generation. Injectable so tests script the panel without a real
 *  model (the same seam strategyChat.ts uses). */
export type PanelGenerate = <T>(args: { schema: ZodType<T>; system: string; prompt: string }) => Promise<T>

export interface RunPanelOpts {
  /** operator strategy brief — passed to the judge only */
  brief?: string
  /** learned-lessons block (trusted, node-authored) — passed to the judge only */
  lessons?: string
  /** screen score that triggered the panel; recorded in the transcript (votes only) */
  screenScore?: number
  /** override the generation backend (tests); defaults to a `generateObject` call on `model`. */
  generate?: PanelGenerate
}

export interface PanelResult {
  score: number
  reason: string
  transcript: PanelTranscript
}

/** Default backend: structured generation in tool mode with a single retry on a
 *  non-conforming response (shared with the voter scorer). */
function defaultGenerate(model: LanguageModel): PanelGenerate {
  return <T>({ schema, system, prompt }: { schema: ZodType<T>; system: string; prompt: string }): Promise<T> =>
    generateObjectWithRetry(model, schema, system, prompt)
}

/** Run the full panel for one pod/candidate. Throws ONLY when no verdict can be
 *  produced at all (every persona failed, or the judge failed) — the caller treats
 *  that as "fall back to the single-scorer result / skip the candidate". */
export async function runPanel(model: LanguageModel, input: PanelInput, opts: RunPanelOpts = {}): Promise<PanelResult> {
  const generate = opts.generate ?? defaultGenerate(model)
  // Personas score concurrently; a failed persona drops out (does not abort the panel).
  const settled = await Promise.all(
    PERSONAS.map(async (persona): Promise<PanelistVerdict | null> => {
      try {
        const { system, prompt } = buildPersonaPrompt(persona, input)
        const out = await generate({ schema: PanelistSchema, system, prompt })
        return { persona: persona.id, score: out.score, argument: out.argument }
      } catch (e) {
        console.error(`orquestra: panel persona ${persona.id} failed, dropping from panel — ${e instanceof Error ? e.message : String(e)}`)
        return null
      }
    }),
  )
  const panelists = settled.filter((v): v is PanelistVerdict => v !== null)
  if (panelists.length === 0) throw new Error('panel: all personas failed')

  const missing = PERSONAS.filter((p) => !panelists.some((v) => v.persona === p.id)).map((p) => p.id)
  // Forward the operator brief + learned lessons to the judge (the panelists argue
  // evidence only; the judge applies stance + calibration).
  const { system, prompt } = buildJudgePrompt({ ...input, brief: opts.brief, lessons: opts.lessons }, panelists, missing)
  const judge = await generate({ schema: JudgeSchema, system, prompt }) // throws → caller falls back

  const transcript: PanelTranscript = {
    ...(opts.screenScore !== undefined ? { screenScore: opts.screenScore } : {}),
    panelists,
    judge: { score: judge.score, reason: judge.reason },
  }
  return { score: judge.score, reason: judge.reason, transcript }
}
