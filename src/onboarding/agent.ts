// src/onboarding/agent.ts
import { generateText, tool, type LanguageModel, type CoreMessage } from 'ai'
import { z } from 'zod'
import type { Prompter, OnboardingAnswers } from './types.js'
import type { DatanetSummary } from '../reppo/listDatanets.js'
import type { WalletBalance } from '../reppo/queryBalance.js'
import type { DatanetRubric } from '../rubric/types.js'
import { OnboardingAnswersSchema, validateAnswers } from './schema.js'

export interface OnboardingAgentDeps {
  model: LanguageModel
  prompter: Prompter
  listDatanets(): Promise<DatanetSummary[]>
  getDatanetDetails(datanetId: string): Promise<DatanetRubric | { error: string }>
  getBalance(): Promise<WalletBalance>
}

export const SYSTEM = `You are Orquestra's onboarding assistant. Help the operator configure a self-hosted Reppo agent node: which datanets to VOTE and/or MINT on, how much REPPO to lock (veREPPO voting power) and for how long, budget caps (vote gas, votes/cycle, mint REPPO, mint gas), the budget horizon, and how often the node runs (cadence hours).
Use list_datanets to answer "what's available" with live data. Use get_datanet_details to explain what a datanet wants and whether minting is possible.
IMPORTANT: minting requires a data adapter. Datanet 9 (TradingGym AI) uses "hyperliquid"; datanet 2 (Geopolitical) uses "gdelt". For datanets without an adapter, set mint=false (vote-only).
PERSONALIZED MINT STRATEGY — this is what makes each operator's node unique and avoids everyone minting the same data. For every datanet the operator chooses to MINT, GUIDE them to define a strategy by asking (one topic at a time, explaining tradeoffs, and suggesting options drawn from the datanet's rubric):
  - focus: which regions/topics/keywords to cover (e.g. "Middle East energy", "Taiwan/China", "sanctions").
  - angle: their stance — contrarian vs consensus, risk-focused, which kinds of claims to favor. (Datanet 2 rewards sharp, well-reasoned minority takes, so encourage a distinctive angle.)
  - how strict, and how many items per cycle (topN).
Pass these as that datanet's adapterParams { focus, angle, topN, minImportance } in finalize. Capture the operator's overall approach as freeform 'notes' (saved as the strategy brief, used for both minting and voting).
You may RECOMMEND choices from the catalog economics, but always confirm each decision with the operator before finishing. When the operator confirms, call finalize with the complete structured answers. Keep messages short.
Use get_wallet_balance to look up the operator's REPPO/veREPPO/ETH/USDC holdings when they express amounts relative to their balance (e.g. '80% of my REPPO').`

/** Build the agent's tools. onFinalize is called with validated answers when the model finalizes. */
export function buildOnboardingTools(deps: OnboardingAgentDeps, onFinalize: (a: OnboardingAnswers) => void) {
  return {
    list_datanets: tool({
      description: 'List active Reppo datanets (id, name, description, fees, emissions, vote volume).',
      parameters: z.object({}),
      // Tool errors are RETURNED (not thrown) so a CLI/network failure becomes a
      // recoverable message the assistant relays — a tool must never crash onboarding.
      execute: async () => {
        try {
          return { datanets: await deps.listDatanets() }
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) }
        }
      },
    }),
    get_datanet_details: tool({
      description: "Get a datanet's goal + publisher/voter rubric + capability.",
      parameters: z.object({ datanetId: z.string() }),
      execute: async ({ datanetId }) => {
        try {
          return await deps.getDatanetDetails(datanetId)
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) }
        }
      },
    }),
    get_wallet_balance: tool({
      description: "Get the operator's on-chain wallet balances (ETH, REPPO, veREPPO, USDC) — use this to size the lock/budget from their holdings.",
      parameters: z.object({}),
      execute: async () => {
        try {
          return await deps.getBalance()
        } catch (e) {
          return {
            error: e instanceof Error ? e.message : String(e),
            hint: 'Wallet balance needs REPPO_PRIVATE_KEY set in the environment. Ask the operator to set it, or to enter the amount directly.',
          }
        }
      },
    }),
    finalize: tool({
      description: 'Validate + save the operator-confirmed strategy. Call only after the operator confirms.',
      parameters: OnboardingAnswersSchema,
      execute: async (answers) => {
        const res = validateAnswers(answers)
        if (!res.ok) return { saved: false, error: res.error }
        onFinalize(res.answers)
        return { saved: true }
      },
    }),
  }
}

/** Run the conversational onboarding to completion; returns the finalized answers. */
export async function runConversationalOnboarding(deps: OnboardingAgentDeps): Promise<OnboardingAnswers> {
  let finalAnswers: OnboardingAnswers | null = null
  const tools = buildOnboardingTools(deps, (a) => { finalAnswers = a })
  const messages: CoreMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: 'Begin onboarding. Greet me briefly and ask what I want my node to do.' },
  ]
  deps.prompter.info('orquestra onboarding — chat with the assistant. Type "quit" to cancel.\n')

  // Hard cap on conversation turns so a model that never finalizes can't spin forever.
  let turn = 0
  const MAX_TURNS = 30
  while (!finalAnswers) {
    if (++turn > MAX_TURNS) throw new Error('onboarding: assistant did not finalize within the turn limit — aborting')
    const res = await generateText({ model: deps.model, tools, messages, maxSteps: 6 })
    messages.push(...res.response.messages)
    if (res.text.trim()) deps.prompter.info(`\nassistant: ${res.text}\n`)
    if (finalAnswers) break
    const reply = (await deps.prompter.ask('you')).trim()
    if (/^(quit|exit|cancel)$/i.test(reply)) throw new Error('onboarding cancelled')
    messages.push({ role: 'user', content: reply })
  }
  return finalAnswers!
}
