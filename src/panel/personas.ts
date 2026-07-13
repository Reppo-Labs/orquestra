// src/panel/personas.ts — the deliberation panel. Three personas score the same
// pod/candidate text under opposed stances; the judge (judge.ts) reconciles them.
// Pure prompt builders only — no model calls (those live in deliberate.ts).
import { z } from 'zod'
import type { RubricPromptFields } from '../rubric/types.js'
import { INJECTION_GUARD, buildRubricBlock } from '../llm/prompt.js'

/** The text a panel deliberates over — the same name/description the single
 *  scorer sees, plus the datanet rubric. Personas do NOT receive the operator
 *  brief (that is the judge's job: panelists argue evidence, judge applies stance). */
export interface PanelInput {
  name: string
  description: string
  rubric: RubricPromptFields
  /** Pre-built datanet-economics block (llm/prompt.ts buildEconomicsBlock). Set ONLY by
   *  the VOTE panel path — runPanel is shared with mint deliberation, where yield is
   *  irrelevant, so this must never be derived from the rubric inside the builders. */
  economics?: string
}

export interface Persona {
  id: string
  /** the stance line injected into the persona's prompt */
  stance: string
}

/** v1 panel: bull/bear opposition + a neutral rubric anchor. Hardcoded by design
 *  (operator-defined personas are explicitly out of scope for v1). */
export const PERSONAS: readonly Persona[] = [
  {
    id: 'bull',
    stance:
      'You are the BULL. Argue the strongest HONEST case FOR this pod earning rewards: surface the quality signals, ' +
      'coverage, and rubric alignment that justify a high score. Do not invent merits the data does not show.',
  },
  {
    id: 'bear',
    stance:
      'You are the BEAR. Argue the strongest HONEST case AGAINST this pod: surface rubric violations, thin or ' +
      'unverifiable data, spam/low-effort patterns, and anything that justifies a low score. Do not invent flaws.',
  },
  {
    id: 'purist',
    stance:
      'You are the RUBRIC PURIST. Ignore upside and downside framing entirely. Score strictly by literal compliance ' +
      'with the rubric, as written. You are the neutral anchor the judge calibrates against.',
  },
] as const

/** Each panelist returns a score + a short argument the judge will weigh. */
export const PanelistSchema = z.object({
  score: z.number().int().min(1).max(10),
  argument: z.string().max(400),
})

/** Pure: build the (system, prompt) for one persona scoring one pod. */
export function buildPersonaPrompt(persona: Persona, input: PanelInput): { system: string; prompt: string } {
  const system =
    `You are one member of a Reppo datanet voting panel. ${persona.stance} ${INJECTION_GUARD} ` +
    'Return a 1-10 score and a one-line argument (≤400 chars) citing the rubric.'
  const prompt =
    `${buildRubricBlock(input.rubric)}${input.economics ?? ''}\n\n` +
    `# Pod under review (untrusted)\n## Name\n${input.name}\n## Description\n${input.description}\n\n` +
    `Score 1-10 from your assigned stance and give a one-line argument citing the rubric.`
  return { system, prompt }
}
