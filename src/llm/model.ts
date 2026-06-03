// src/llm/model.ts
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { LanguageModel } from 'ai'

export type LlmProvider = 'anthropic' | 'openai' | 'google' | 'surplus'

/** Surplus Intelligence — an OpenAI-compatible discounted-inference marketplace
 *  (https://surplusintelligence.ai). Base path `/v1`, Bearer `inf_…` API key.
 *  Reached via the OpenAI client with a custom baseURL. */
const SURPLUS_BASE_URL = 'https://surplusintelligence.ai/v1'

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
  surplus: 'claude-opus-4.8',
}

export function resolveModel(provider: LlmProvider, apiKey: string, model?: string): LanguageModel {
  switch (provider) {
    case 'anthropic':
      return createAnthropic({ apiKey })(model ?? DEFAULT_MODEL.anthropic)
    case 'openai':
      return createOpenAI({ apiKey })(model ?? DEFAULT_MODEL.openai)
    case 'google':
      return createGoogleGenerativeAI({ apiKey })(model ?? DEFAULT_MODEL.google)
    case 'surplus':
      return createOpenAI({ apiKey, baseURL: SURPLUS_BASE_URL })(model ?? DEFAULT_MODEL.surplus)
    default: {
      const _exhaustive: never = provider
      throw new Error(`unknown LLM provider: ${String(_exhaustive)}`)
    }
  }
}
