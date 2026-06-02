// src/index.ts
import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { loadConfig } from './config/load.js'
import { needsOnboarding, persistOnboarding } from './onboarding/persist.js'
import { runOnboarding } from './onboarding/interview.js'
import { buildStrategyConfig } from './onboarding/build.js'
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
  const p = terminalPrompter()
  try {
    const answers = await runOnboarding(p)
    const config = buildStrategyConfig(answers)
    persistOnboarding(DATA_DIR, config, answers.notes)
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
  const ledger = new BudgetLedger(DATA_DIR, config.budget)
  const executor = new WalletExecutor(defaultReppoCli, ledger)
  const hl = createHyperliquidAdapter()

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
    getAdapter: (id) => (id === 'hyperliquid' ? hl : undefined),
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
  console.error('orquestra: fatal:', (e as Error).message)
  process.exitCode = 1
})
