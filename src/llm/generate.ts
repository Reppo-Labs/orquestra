// src/llm/generate.ts — shared structured-generation helper.
// generateObject in tool mode with a single retry on a non-conforming response
// ("No object generated: response did not match schema" is a transient the model
// usually fixes on the second try). Used by the voter scorer and the panel.
//
// Input is EITHER a text `prompt` (text pods, the original path — byte-for-byte
// unchanged on the wire) OR `messages` (multimodal: a video pod's rubric text +
// FilePart). Exactly one is required.
import { generateObject, type CoreMessage, type LanguageModel } from 'ai'
import type { ZodType } from 'zod'

export type GenerateInput = { prompt: string } | { messages: CoreMessage[] }

export async function generateObjectWithRetry<T>(
  model: LanguageModel,
  schema: ZodType<T>,
  system: string,
  input: GenerateInput,
): Promise<T> {
  const payload = 'prompt' in input ? { prompt: input.prompt } : { messages: input.messages }
  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { object } = await generateObject({ model, schema, mode: 'tool', system, ...payload })
      return object
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}
