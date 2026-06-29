// src/dashboard/strategyChat.ts
// The dashboard's "goal chat": a scoped LLM call that PROPOSES strategy-config
// changes — it never writes. The single write path is POST /api/strategy, which
// the operator triggers explicitly (Save) after seeing the proposal in the grid.
import { type LanguageModel } from 'ai'
import { z } from 'zod'
import { StrategyConfigSchema, type StrategyConfig } from '../config/schema.js'
import { generateObjectWithRetry } from '../llm/generate.js'
import type { LockConstraints } from '../reppo/queryLockConstraints.js'
import type { Snapshot } from './snapshot.js'

export interface ChatMessage { role: 'user' | 'assistant'; content: string }

const ChatOutSchema = z.object({
  reply: z.string().min(1),
  // free-form here; validated against StrategyConfigSchema after the call so an
  // invalid proposal degrades to reply+warning instead of failing the whole turn.
  proposedConfig: z.unknown().optional(),
})
type ChatOut = z.infer<typeof ChatOutSchema>

export interface StrategyChatDeps {
  messages: ChatMessage[]
  currentConfig: StrategyConfig
  lockConstraints?: LockConstraints
  /** Latest cycle snapshot — gives the assistant live on-chain context (balance,
   *  veREPPO locked, voting power, epoch, claimable emissions). */
  snapshot?: Snapshot | null
  generate?: (args: { system: string; prompt: string }) => Promise<ChatOut>
  model?: LanguageModel
}

export interface StrategyChatResult {
  reply: string
  /** present ONLY when the model proposed a config that passes schema validation. */
  proposedConfig?: StrategyConfig
  /** set when a proposal was returned but rejected by validation. */
  warning?: string
}

const defaultGenerate = (model: LanguageModel) => ({ system, prompt }: { system: string; prompt: string }): Promise<ChatOut> =>
  // Via the shared retry helper: 'tool' mode then a 'json' fallback, so open-weight models
  // (e.g. usepod's deepseek) that don't emit a forced tool call still return structured output.
  generateObjectWithRetry(model, ChatOutSchema, system, { prompt })

/** One chat turn: reply + optional validated config proposal. Never throws; never writes. */
export async function runStrategyChat(deps: StrategyChatDeps): Promise<StrategyChatResult> {
  const { system, prompt } = buildStrategyChatPrompt(deps.messages, deps.currentConfig, deps.lockConstraints, deps.snapshot)
  const generate = deps.generate ?? (deps.model ? defaultGenerate(deps.model) : null)
  if (!generate) throw new Error('runStrategyChat: provide deps.generate or deps.model')

  let out: ChatOut
  try {
    out = await generate({ system, prompt })
  } catch (e) {
    return { reply: `Sorry — the strategy assistant failed (could not reach the model): ${e instanceof Error ? e.message.split('\n')[0] : String(e)}` }
  }

  if (out.proposedConfig === undefined) return { reply: out.reply }
  const parsed = StrategyConfigSchema.safeParse(out.proposedConfig)
  if (!parsed.success) {
    return { reply: out.reply, warning: `the assistant's proposed config was invalid and was discarded: ${parsed.error.issues[0]?.message ?? 'schema error'}` }
  }
  return { reply: out.reply, proposedConfig: parsed.data }
}

/** Pure: build the (system, prompt) for one chat turn. Exposed for testing. */
export function buildStrategyChatPrompt(
  messages: ChatMessage[],
  current: StrategyConfig,
  lockConstraints?: LockConstraints,
  snapshot?: Snapshot | null,
): { system: string; prompt: string } {
  const lockFacts = lockConstraints
    ? `\n\n# veREPPO protocol constants (live from contract)\nmax lock duration: ${lockConstraints.maxLockDays} days\nepoch length: ${lockConstraints.epochDays} days\nWhen discussing lock duration, use ONLY these on-chain values — never guess or use other numbers.`
    : ''
  const snapshotFacts = snapshot
    ? `\n\n# Live on-chain state (last cycle snapshot)\n` +
      `REPPO balance: ${snapshot.balance.reppo}\n` +
      `veREPPO locked: ${snapshot.balance.veReppo}\n` +
      `ETH balance: ${snapshot.balance.eth}\n` +
      `voting power: ${snapshot.votingPower.power} (${snapshot.votingPower.lockupCount} lockup(s))\n` +
      `claimable emissions: ${snapshot.emissionsDue.totalReppo} REPPO\n` +
      (snapshot.epoch ? `current epoch: ${snapshot.epoch.epoch} (${Math.floor(snapshot.epoch.secondsRemaining / 3600)}h remaining)\n` : '') +
      `snapshot taken: ${snapshot.ts}`
    : ''
  const system =
    'You are the strategy assistant for an orquestra node (a Reppo datanet curation/minting agent). ' +
    'You PROPOSE changes to the strategy config — you can never write or apply anything yourself; the ' +
    'operator reviews your proposal in a grid and saves it explicitly. When the user asks for a change, ' +
    'return the FULL updated config as proposedConfig (not a fragment), preserving everything they did ' +
    'not ask to change — especially budget caps: never raise budget or stake values unless explicitly asked. ' +
    'Carry every per-datanet field through unchanged unless asked (vote, mint, strictness, adapter, ' +
    'adapterParams, mintMode, model, voteShare) — omitting a field silently resets it to its default. ' +
    'Keep replies short and concrete: say exactly what you changed and why. For pure questions, reply without a proposal.' +
    lockFacts +
    snapshotFacts
  const transcript = messages.map((m) => `${m.role}: ${m.content}`).join('\n')
  const prompt =
    `# Current strategy config\n${JSON.stringify(current, null, 2)}\n\n` +
    `# Conversation\n${transcript}\n\n` +
    `Respond to the last user message. Include proposedConfig ONLY if they asked for a change.`
  return { system, prompt }
}
