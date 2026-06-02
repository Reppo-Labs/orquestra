// src/llm/model.ts
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { LanguageModel } from 'ai'

export type LlmProvider = 'anthropic' | 'openai' | 'google'

/** Resolve a model from any supported provider + the user's API key.
 *  "Optimize for inference" = the node runs its OWN inference on the user's
 *  chosen provider; it never sells compute. */
// Default model slugs per provider. NOTE: provider slugs change over time —
// update these (or always pass an explicit `model`) when providers rename models;
// an unknown slug fails at request time, not build time.
const DEFAULT_MODEL: Record<LlmProvider, string> = {
  anthropic: 'claude-opus-4-7',
  openai: 'gpt-5.2',
  google: 'gemini-3-pro',
}

export function resolveModel(provider: LlmProvider, apiKey: string, model?: string): LanguageModel {
  switch (provider) {
    case 'anthropic':
      return createAnthropic({ apiKey })(model ?? DEFAULT_MODEL.anthropic)
    case 'openai':
      return createOpenAI({ apiKey })(model ?? DEFAULT_MODEL.openai)
    case 'google':
      return createGoogleGenerativeAI({ apiKey })(model ?? DEFAULT_MODEL.google)
    default: {
      const _exhaustive: never = provider
      throw new Error(`unknown LLM provider: ${String(_exhaustive)}`)
    }
  }
}
