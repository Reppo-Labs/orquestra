// src/llm/generate.ts — shared structured-generation helper.
// generateObject in tool mode with a single retry on a non-conforming response
// ("No object generated: response did not match schema" is a transient the model
// usually fixes on the second try). Used by the voter scorer and the panel.
import { generateObject, type LanguageModel } from 'ai'
import type { ZodType } from 'zod'

export async function generateObjectWithRetry<T>(
  model: LanguageModel,
  schema: ZodType<T>,
  system: string,
  prompt: string,
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { object } = await generateObject({ model, schema, mode: 'tool', system, prompt })
      return object
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}
