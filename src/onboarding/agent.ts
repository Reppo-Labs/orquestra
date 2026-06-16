// src/onboarding/agent.ts
import { generateText, tool, type LanguageModel, type CoreMessage } from 'ai'
import { z } from 'zod'
import type { Prompter, OnboardingAnswers } from './types.js'
import type { DatanetSummary } from '../reppo/listDatanets.js'
import type { WalletBalance } from '../reppo/queryBalance.js'
import type { DatanetRubric } from '../rubric/types.js'
import { OnboardingAnswersSchema, validateAnswers } from './schema.js'

/** What one onboarding turn needs — no prompter, so HTTP and CLI both fit. */
export interface OnboardingToolDeps {
  model: LanguageModel
  listDatanets(): Promise<DatanetSummary[]>
  getDatanetDetails(datanetId: string): Promise<DatanetRubric | { error: string }>
  getBalance(): Promise<WalletBalance>
}

export interface OnboardingAgentDeps extends OnboardingToolDeps {
  prompter: Prompter
}

export const SYSTEM = `You are Orquestra's onboarding assistant. Help the operator configure a self-hosted Reppo agent node: which datanets to VOTE and/or MINT on, how much REPPO to lock (veREPPO voting power) and for how long, budget caps (votes/cycle, mint REPPO), the budget horizon, and how often the node runs (cadence hours). Do NOT ask about gas — gas on Base is negligible and not operator-configured.
Use list_datanets to answer "what's available" with live data. Use get_datanet_details to explain what a datanet wants and whether minting is possible.
IMPORTANT: minting requires a data adapter. Datanet 9 (TradingGym AI) uses "hyperliquid"; datanet 2 (Geopolitical) uses "gdelt". For datanets without an adapter, set mint=false (vote-only).
PERSONALIZED MINT STRATEGY — this is what makes each operator's node unique and avoids everyone minting the same data. For every datanet the operator chooses to MINT, GUIDE them to define a strategy by asking (one topic at a time, explaining tradeoffs, and suggesting options drawn from the datanet's rubric):
  - focus: which regions/topics/keywords to cover (e.g. "Middle East energy", "Taiwan/China", "sanctions").
  - angle: their stance — contrarian vs consensus, risk-focused, which kinds of claims to favor. (Datanet 2 rewards sharp, well-reasoned minority takes, so encourage a distinctive angle.)
  - how strict, and how many items per cycle (topN).
Pass these as that datanet's adapterParams { focus, angle, topN, minImportance } in finalize. Capture the operator's overall approach as freeform 'notes' (saved as the strategy brief, used for both minting and voting).
ACCESS FEE FUNDING: some datanets charge their one-time access fee in a NON-REPPO token (e.g. EXY). get_datanet_details returns an 'accessFeeNote' for these — relay it to the operator so they know to fund this node's wallet with that token; otherwise the node can enable the datanet but the first grant will fail until funded. REPPO-fee datanets need no special note.
You may RECOMMEND choices from the catalog economics, but always confirm each decision with the operator before finishing. When the operator confirms, call finalize with the complete structured answers. Keep messages short.
After each topic is settled, call update_draft with the fields agreed so far — the operator's UI renders a live draft of the configuration from these calls.
Use get_wallet_balance to look up the operator's REPPO/veREPPO/ETH/USDC holdings when they express amounts relative to their balance (e.g. '80% of my REPPO').`

/** Deterministic operator-facing funding note for a datanet's access fee. Returns a
 *  concise line ONLY when the datanet charges a NON-REPPO access fee (accessFeeToken set);
 *  undefined for REPPO-fee datanets (the common case), so onboarding is unchanged for them.
 *  A non-REPPO fee is an ERC20 the SubnetManager pulls via transferFrom — so the operator
 *  must BOTH fund the wallet AND approve the SubnetManager for the token, or the first grant
 *  reverts on INSUFFICIENT_ALLOWANCE. e.g.
 *  "Access fee: 50 EXY (one-time) — fund this node's wallet with EXY and approve it for the
 *   SubnetManager (`reppo approve --spender subnet-manager --token 0x…`)". */
export function summarizeAccessFee(rubric: DatanetRubric): string | undefined {
  const t = rubric.economics.accessFeeToken
  if (!t) return undefined
  return `Access fee: ${t.amount} ${t.symbol} (one-time) — fund this node's wallet with ${t.symbol} and approve it for the SubnetManager (\`reppo approve --spender subnet-manager --token ${t.address}\`)`
}

/** Build the agent's tools. onFinalize is called with validated answers when the
 *  model finalizes; onDraft (optional) receives partial working drafts for live UIs. */
export function buildOnboardingTools(
  deps: OnboardingToolDeps,
  onFinalize: (a: OnboardingAnswers) => void,
  onDraft?: (d: Partial<OnboardingAnswers>) => void,
) {
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
          const details = await deps.getDatanetDetails(datanetId)
          // Attach a deterministic non-REPPO access-fee funding note when applicable, so the
          // assistant surfaces "fund the wallet with EXY" rather than relying on the model to
          // notice the raw economics.accessFeeToken object. Absent ⇒ REPPO datanet, unchanged.
          if (!('error' in details)) {
            const accessFeeNote = summarizeAccessFee(details)
            if (accessFeeNote) return { ...details, accessFeeNote }
          }
          return details
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
    update_draft: tool({
      description: 'Report the current working draft (the fields agreed so far) so the operator UI can render it live. Call after each settled topic; safe to call often. This does NOT save anything.',
      parameters: OnboardingAnswersSchema.partial(),
      execute: async (draft) => {
        onDraft?.(draft as Partial<OnboardingAnswers>)
        return { ok: true }
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

/** The opening transcript every onboarding conversation starts from. */
export function seedOnboardingMessages(): CoreMessage[] {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: 'Begin onboarding. Greet me briefly and ask what I want my node to do.' },
  ]
}

export interface OnboardingTurnResult {
  /** assistant text to show the operator */
  text: string
  /** messages produced this turn — append to the transcript before the next turn */
  responseMessages: CoreMessage[]
  /** present when the model called finalize with valid answers this turn */
  finalized: OnboardingAnswers | null
  /** last update_draft payload of this turn (live UI preview), if any */
  draft: Partial<OnboardingAnswers> | null
}

/** Run ONE onboarding turn over an explicit transcript. Pure with respect to
 *  I/O: callers own the transcript (CLI loop, HTTP session) and persistence. */
export async function runOnboardingTurn(deps: OnboardingToolDeps, messages: CoreMessage[]): Promise<OnboardingTurnResult> {
  let finalized: OnboardingAnswers | null = null
  let draft: Partial<OnboardingAnswers> | null = null
  const tools = buildOnboardingTools(deps, (a) => { finalized = a }, (d) => { draft = d })
  const res = await generateText({ model: deps.model, tools, messages, maxSteps: 6 })
  return { text: res.text, responseMessages: res.response.messages, finalized, draft }
}

/** Run the conversational onboarding to completion; returns the finalized answers. */
export async function runConversationalOnboarding(deps: OnboardingAgentDeps): Promise<OnboardingAnswers> {
  const messages = seedOnboardingMessages()
  deps.prompter.info('orquestra onboarding — chat with the assistant. Type "quit" to cancel.\n')

  // Hard cap on conversation turns so a model that never finalizes can't spin forever.
  let turn = 0
  const MAX_TURNS = 30
  while (true) {
    if (++turn > MAX_TURNS) throw new Error('onboarding: assistant did not finalize within the turn limit — aborting')
    const res = await runOnboardingTurn(deps, messages)
    messages.push(...res.responseMessages)
    if (res.text.trim()) deps.prompter.info(`\nassistant: ${res.text}\n`)
    if (res.finalized) return res.finalized
    const reply = (await deps.prompter.ask('you')).trim()
    if (/^(quit|exit|cancel)$/i.test(reply)) throw new Error('onboarding cancelled')
    messages.push({ role: 'user', content: reply })
  }
}
