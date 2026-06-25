// src/llm/generate.ts — shared structured-generation helper.
// generateObject across two attempts: 'tool' mode (function-calling) then 'json' mode.
// 'tool' is reliable on models that support it; 'json' is the fallback for open-weight
// models (via OpenAI-compatible proxies) that don't emit a forced tool call, and also
// serves as the schema-mismatch retry. Used by the voter scorer, panel, learn, and the
// dashboard strategy chat.
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
  // Attempt 1: 'tool' (function-calling) — reliable structured output on models that
  // support it (Claude/GPT/Gemini, virtuals-claude). Attempt 2: 'json' — the fallback for
  // open-weight models (deepseek/qwen/llama via OpenAI-compatible proxies like usepod) that
  // don't emit the forced tool call ("No object generated: the tool was not called"). The
  // mode switch also doubles as the schema-mismatch retry for tool-capable models.
  //
  // Preserve the first error: @ai-sdk/google always throws UnsupportedFunctionalityError on
  // json mode (Gemini uses responseSchema, not JSON mode) — without this, that secondary
  // "not supported" error would overwrite the real tool-mode failure and mislead operators.
  const MODES = ['tool', 'json'] as const
  let firstErr: unknown
  for (const mode of MODES) {
    try {
      const { object } = await generateObject({ model, schema, mode, system, ...payload })
      return object
    } catch (e) {
      if (firstErr === undefined) firstErr = e
    }
  }
  throw firstErr instanceof Error ? firstErr : new Error(String(firstErr))
}
