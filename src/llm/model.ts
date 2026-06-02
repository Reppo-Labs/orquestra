// src/llm/model.ts
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { LanguageModel } from 'ai'

export type LlmProvider = 'anthropic' | 'openai' | 'google'

/** Resolve a model from any supported provider + the user's API key.
 *  "Optimize for inference" = the node runs its OWN inference on the user's
 *  chosen provider; it never sells compute. */
export function resolveModel(provider: LlmProvider, apiKey: string, model?: string): LanguageModel {
  switch (provider) {
    case 'anthropic':
      return createAnthropic({ apiKey })(model ?? 'claude-opus-4-7')
    case 'openai':
      return createOpenAI({ apiKey })(model ?? 'gpt-5.2')
    case 'google':
      return createGoogleGenerativeAI({ apiKey })(model ?? 'gemini-3-pro')
    default: {
      const _exhaustive: never = provider
      throw new Error(`unknown LLM provider: ${String(_exhaustive)}`)
    }
  }
}
