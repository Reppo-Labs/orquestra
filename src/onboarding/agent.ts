// src/onboarding/agent.ts
import { generateText, tool, type LanguageModel, type CoreMessage } from 'ai'
import { z } from 'zod'
import type { Prompter, OnboardingAnswers } from './types.js'
import type { DatanetSummary } from '../reppo/listDatanets.js'
import type { DatanetRubric } from '../rubric/types.js'
import { OnboardingAnswersSchema, validateAnswers } from './schema.js'

export interface OnboardingAgentDeps {
  model: LanguageModel
  prompter: Prompter
  listDatanets(): Promise<DatanetSummary[]>
  getDatanetDetails(datanetId: string): Promise<DatanetRubric | { error: string }>
}

const SYSTEM = `You are Orquestra's onboarding assistant. Help the operator configure a self-hosted Reppo agent node: which datanets to VOTE and/or MINT on, how much REPPO to lock (veREPPO voting power) and for how long, budget caps (vote gas, votes/cycle, mint REPPO, mint gas), the budget horizon, and how often the node runs (cadence hours).
Use list_datanets to answer "what's available" with live data. Use get_datanet_details to explain what a datanet wants and whether minting is possible.
IMPORTANT: minting requires a data adapter. Today only datanet 9 (TradingGym AI) has one ("hyperliquid"); for every other datanet set mint=false (vote-only).
You may RECOMMEND choices from the catalog economics, but always confirm each decision with the operator before finishing. When the operator confirms, call finalize with the complete structured answers. Keep messages short.`

/** Build the agent's tools. onFinalize is called with validated answers when the model finalizes. */
export function buildOnboardingTools(deps: OnboardingAgentDeps, onFinalize: (a: OnboardingAnswers) => void) {
  return {
    list_datanets: tool({
      description: 'List active Reppo datanets (id, name, description, fees, emissions, vote volume).',
      parameters: z.object({}),
      execute: async () => ({ datanets: await deps.listDatanets() }),
    }),
    get_datanet_details: tool({
      description: "Get a datanet's goal + publisher/voter rubric + capability.",
      parameters: z.object({ datanetId: z.string() }),
      execute: async ({ datanetId }) => deps.getDatanetDetails(datanetId),
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

  while (!finalAnswers) {
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
