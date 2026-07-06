// src/llm/usage.ts — LLM token-usage accounting for the dashboard's per-cycle cost estimate.
//
// Operators reported the LLM bill "adds up faster than expected" (panel scoring calls the
// model several times per pod) with no visibility. Every model resolved via resolveModel
// is wrapped with `withUsageTracking`, so ALL call sites (voter scoring, panel, minter,
// dedup, learn, chats) feed one process-global accumulator — no per-call-site changes.
//
// The cycle loop resets the accumulator at cycle start and snapshots it at cycle end, so
// the dashboard shows "what this cycle spent". Costs are ESTIMATES from a static pricing
// table (USD per 1M tokens); unknown models contribute tokens but null cost, and the
// snapshot says how many calls priced vs not — never silently under-report a bill.
import { wrapLanguageModel, type LanguageModel } from 'ai'

/** USD per 1M tokens [input, output]. Static + approximate — list prices, no caching or
 *  batch discounts. Keys are matched by substring against the SDK modelId (lowercased),
 *  longest match wins, so "claude-sonnet-4-5" beats "claude" etc. Update as prices move. */
const PRICING_PER_MTOK: Record<string, [number, number]> = {
  // Anthropic
  'claude-opus-4': [15, 75],
  'claude-sonnet-4': [3, 15],
  'claude-haiku-4': [1, 5],
  'claude-3-5-haiku': [0.8, 4],
  // OpenAI
  'gpt-5': [1.25, 10],
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-4o': [2.5, 10],
  'gpt-4.1-mini': [0.4, 1.6],
  'gpt-4.1': [2, 8],
  // Google
  'gemini-3.1-pro': [2, 12], // KNOWN_MODELS default is gemini-3.1-pro-preview — must match
  'gemini-3-pro': [2, 12],
  'gemini-3-flash': [0.3, 2.5],
  'gemini-2.5-pro': [1.25, 10],
  'gemini-2.5-flash': [0.3, 2.5],
}

/** Resolve [input, output] USD/1M for a modelId; null when unknown. Longest-key
 *  substring match so more specific entries win. */
export function priceFor(modelId: string): [number, number] | null {
  const id = modelId.toLowerCase()
  let best: [number, number] | null = null
  let bestLen = 0
  for (const [key, price] of Object.entries(PRICING_PER_MTOK)) {
    if (id.includes(key) && key.length > bestLen) { best = price; bestLen = key.length }
  }
  return best
}

export interface ModelUsage {
  calls: number
  inputTokens: number
  outputTokens: number
  /** null when the model has no pricing entry (tokens still counted). */
  estCostUsd: number | null
}

export interface LlmUsageSnapshot {
  calls: number
  inputTokens: number
  outputTokens: number
  /** Sum over models WITH pricing; null when nothing was priceable. */
  estCostUsd: number | null
  /** calls whose model had no pricing entry — telltale that estCostUsd under-reports. */
  unpricedCalls: number
  byModel: Record<string, ModelUsage>
}

// Process-global accumulator: the node runs one cycle at a time (single scheduler),
// so cycle-scoped reset/snapshot needs no plumbing through 10 call sites. A chat the
// operator drives mid-cycle lands in the same window — acceptable for an estimate,
// and the dashboard labels it "all LLM calls during the cycle".
const acc = new Map<string, { calls: number; inputTokens: number; outputTokens: number }>()

export function resetLlmUsage(): void {
  acc.clear()
}

/** Record one model call's token usage. NaN-safe: the SDK reports usage as numbers but
 *  some providers omit fields — treat missing/NaN as 0 rather than poisoning the sums. */
export function recordLlmUsage(modelId: string, inputTokens: number, outputTokens: number): void {
  const cur = acc.get(modelId) ?? { calls: 0, inputTokens: 0, outputTokens: 0 }
  cur.calls += 1
  cur.inputTokens += Number.isFinite(inputTokens) ? inputTokens : 0
  cur.outputTokens += Number.isFinite(outputTokens) ? outputTokens : 0
  acc.set(modelId, cur)
}

/** Current accumulated usage with per-model cost estimates applied. */
export function snapshotLlmUsage(): LlmUsageSnapshot {
  const byModel: Record<string, ModelUsage> = {}
  let calls = 0, inputTokens = 0, outputTokens = 0, unpricedCalls = 0
  let cost = 0
  let anyPriced = false
  for (const [modelId, u] of acc) {
    const price = priceFor(modelId)
    const estCostUsd = price === null
      ? null
      : (u.inputTokens * price[0] + u.outputTokens * price[1]) / 1_000_000
    byModel[modelId] = { ...u, estCostUsd }
    calls += u.calls
    inputTokens += u.inputTokens
    outputTokens += u.outputTokens
    if (estCostUsd === null) unpricedCalls += u.calls
    else { cost += estCostUsd; anyPriced = true }
  }
  return { calls, inputTokens, outputTokens, estCostUsd: anyPriced ? cost : null, unpricedCalls, byModel }
}

/** Wrap a model so every generate call feeds the global accumulator. Mirrors
 *  withTemperatureFallback's middleware shape; usage capture must NEVER break the call —
 *  a malformed usage object is dropped, the result always passes through. */
export function withUsageTracking(model: LanguageModel): LanguageModel {
  return wrapLanguageModel({
    model,
    middleware: {
      wrapGenerate: async ({ doGenerate, model: m }) => {
        const result = await doGenerate()
        try {
          const u = result.usage as { inputTokens?: number; outputTokens?: number; promptTokens?: number; completionTokens?: number } | undefined
          if (u) recordLlmUsage(m.modelId, u.inputTokens ?? u.promptTokens ?? NaN, u.outputTokens ?? u.completionTokens ?? NaN)
        } catch { /* usage accounting never breaks the call */ }
        return result
      },
    },
  })
}
