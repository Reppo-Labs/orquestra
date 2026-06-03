// src/index.ts
import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { loadConfig } from './config/load.js'
import { needsOnboarding, persistOnboarding } from './onboarding/persist.js'
import { buildStrategyConfig } from './onboarding/build.js'
import { runConversationalOnboarding } from './onboarding/agent.js'
import { listDatanetsJson } from './reppo/listDatanets.js'
import { queryBalanceJson } from './reppo/queryBalance.js'
import { terminalPrompter } from './runtime/prompter.js'
import { startScheduler } from './runtime/scheduler.js'
import { BudgetLedger } from './wallet/ledger.js'
import { WalletExecutor } from './wallet/executor.js'
import { defaultReppoCli } from './reppo/cli.js'
import { getDatanetRubric } from './rubric/load.js'
import { createHyperliquidAdapter } from './adapter/hyperliquid/index.js'
import { resolveModel, type LlmProvider } from './llm/model.js'
import { createLlmScorer } from './voter/score.js'
import { runCycle, type CycleDeps } from './runtime/cycle.js'
import type { StrategyConfig } from './config/schema.js'

const DATA_DIR = resolve(process.env.ORQUESTRA_DATA_DIR ?? './data')

async function onboard(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true })
  const apiKey = process.env.LLM_API_KEY ?? ''
  if (!apiKey) {
    console.error('orquestra: onboarding needs an LLM key — set LLM_PROVIDER + LLM_API_KEY and re-run.')
    process.exitCode = 1
    return
  }
  const provider = (process.env.LLM_PROVIDER ?? 'anthropic') as LlmProvider
  const model = resolveModel(provider, apiKey)
  const p = terminalPrompter()
  try {
    const answers = await runConversationalOnboarding({
      model,
      prompter: p,
      listDatanets: () => listDatanetsJson(),
      getDatanetDetails: async (id) => {
        try { return await getDatanetRubric(id) } catch (e) { return { error: (e as Error).message } }
      },
      getBalance: () => queryBalanceJson(),
    })
    persistOnboarding(DATA_DIR, buildStrategyConfig(answers), answers.notes)
    p.info(`Saved strategy to ${DATA_DIR}. Run \`orquestra\` to start the node.`)
  } finally {
    p.close()
  }
}

async function start(): Promise<void> {
  if (needsOnboarding(DATA_DIR)) await onboard()
  const config: StrategyConfig = loadConfig(DATA_DIR)

  const provider = (process.env.LLM_PROVIDER ?? 'anthropic') as LlmProvider
  const apiKey = process.env.LLM_API_KEY ?? ''
  const model = resolveModel(provider, apiKey)
  const scorer = createLlmScorer(model)
  // One shared BudgetLedger instance: the executor reserves/records spend on it,
  // and runCycle calls startCycle on it — the single source of budget truth.
  const ledger = new BudgetLedger(DATA_DIR, config.budget)
  const executor = new WalletExecutor(defaultReppoCli, ledger)
  // Adapter registry — add new adapters here; routing is by adapter id from config.
  const adapters = [createHyperliquidAdapter()]

  if (config.stake.lockReppo > 0) {
    const r = await executor.lock({
      amountReppo: config.stake.lockReppo,
      durationSeconds: config.stake.lockDurationDays * 86400,
      idempotencyKey: `lock-${config.stake.lockReppo}-${config.stake.lockDurationDays}`,
    })
    console.error(`orquestra: veREPPO lock ${r.status}${r.txHash ? ` (${r.txHash})` : ''}`)
  }

  const deps: CycleDeps = {
    dataDir: DATA_DIR,
    topN: 12,
    getRubric: (id) => getDatanetRubric(id),
    getPodsAndFilter: async () => ({ pods: [], filter: { currentEpoch: null, ownPodIds: [], votedPodIds: [] } }),
    getAdapter: (id) => adapters.find((a) => a.id === id),
    voteScorer: scorer,
    candidateScorer: {
      scoreCandidate: (c, r) =>
        scorer.scorePod({ podId: c.canonicalKey, validityEpoch: '', name: c.podName, description: c.podDescription }, r),
    },
    seenKeysFor: async () => new Set<string>(),
    executor,
    ledger,
  }

  const nDatanets = Object.keys(config.datanets).filter((k) => k !== '*').length
  console.error(`orquestra: starting — cadence ${config.cadenceHours}h, ${nDatanets} datanet(s)`)
  startScheduler(config.cadenceHours, async () => {
    const cycleId = new Date().toISOString()
    const report = await runCycle(config, cycleId, deps)
    const v = report.reduce((a, r) => a + r.votes.length, 0)
    const m = report.reduce((a, r) => a + r.mints.length, 0)
    console.error(`orquestra: cycle ${cycleId} — ${v} votes, ${m} mints executed`)
  })
}

const cmd = process.argv[2]
const run = cmd === 'configure' ? onboard : start
run().catch((e) => {
  const err = e as Error
  console.error('orquestra: fatal:', err.message)
  if (err.name === 'LedgerCorruptError') {
    console.error(
      `orquestra: the budget ledger at ${DATA_DIR}/budget-ledger.json is corrupt; the node refuses to run rather than ` +
        `lose track of spend. Inspect it, or delete it to reset budget accounting to zero (caps restart from 0).`,
    )
  }
  process.exitCode = 1
})
