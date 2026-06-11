// src/index.ts — thin shell: env, service construction, argv dispatch, signals.
// All cycle wiring lives in src/runtime/wiring.ts (unit-tested there).
import { resolve, join } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { loadConfig } from './config/load.js'
import { needsOnboarding, persistOnboarding } from './onboarding/persist.js'
import { buildStrategyConfig } from './onboarding/build.js'
import { runConversationalOnboarding } from './onboarding/agent.js'
import { listDatanetsJson } from './reppo/listDatanets.js'
import { checkReppoVersion } from './reppo/version.js'
import { queryBalanceJson } from './reppo/queryBalance.js'
import { ensureAgentId, registerAgentJson, readAgentStore, writeAgentStore } from './reppo/agent.js'
import { terminalPrompter } from './runtime/prompter.js'
import { startScheduler } from './runtime/scheduler.js'
import { BudgetLedger } from './wallet/ledger.js'
import { WalletExecutor } from './wallet/executor.js'
import { defaultReppoCli } from './reppo/cli.js'
import { getDatanetRubric } from './rubric/load.js'
import { createHyperliquidAdapter } from './adapter/hyperliquid/index.js'
import { createGdeltAdapter } from './adapter/gdelt/index.js'
import { createSportsAdapter } from './adapter/sports/index.js'
import { resolveModel, type LlmProvider } from './llm/model.js'
import { createLlmScorer } from './voter/score.js'
import { DedupState } from './runtime/state.js'
import type { StrategyConfig } from './config/schema.js'
import { buildCycleDeps, buildTick, type CycleWiring } from './runtime/wiring.js'
import { startDashboard } from './dashboard/server.js'

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

/** One-time idempotent setup: veREPPO lock + Reppo agent identity for minting. */
async function setupNode(config: StrategyConfig, executor: WalletExecutor): Promise<void> {
  if (config.stake.lockReppo > 0) {
    // Idempotent: the veREPPO lock is one-time. If the wallet already holds veREPPO
    // (locked on a prior run), skip — re-locking would just error every restart.
    const existing = await queryBalanceJson().catch(() => null)
    if (existing && existing.veReppo > 0) {
      console.error(`orquestra: already holding ${existing.veReppo} veREPPO — skipping lock.`)
    } else {
      const r = await executor.lock({
        amountReppo: config.stake.lockReppo,
        durationSeconds: config.stake.lockDurationDays * 86400,
        idempotencyKey: `lock-${config.stake.lockReppo}-${config.stake.lockDurationDays}`,
      })
      console.error(`orquestra: veREPPO lock ${r.status}` + (r.txHash ? ` (${r.txHash})` : '') + (r.detail ? ` — ${r.detail}` : ''))
    }
  }

  // Reppo agent identity for minting (reppo >=0.8.0 `mint-pod` requires REPPO_AGENT_ID).
  // Idempotent like the lock: env wins, else persisted agent.json, else register once.
  // Non-fatal on failure — voting still runs; mints error visibly until an id exists.
  const mintingEnabled = Object.entries(config.datanets).some(([k, d]) => k !== '*' && d.mint)
  try {
    const res = await ensureAgentId({
      mintingEnabled,
      envAgentId: process.env.REPPO_AGENT_ID,
      readStored: () => readAgentStore(DATA_DIR),
      register: () => registerAgentJson('orquestra', 'Reppo Orquestra swarm node — publishes data pods'),
      writeStored: (c) => writeAgentStore(DATA_DIR, c),
      setEnv: (c) => {
        process.env.REPPO_AGENT_ID = c.agentId
        // apiKey env name is a best-effort guess; if mint-pod needs a different name,
        // first run surfaces it. The id is the confirmed requirement.
        if (c.apiKey) process.env.REPPO_API_KEY = c.apiKey
      },
    })
    if (res.source === 'registered') console.error(`orquestra: registered Reppo agent ${res.agentId} — persisted to ${DATA_DIR}/agent.json`)
    else if (res.source !== 'skipped') console.error(`orquestra: using Reppo agent ${res.agentId} (${res.source})`)
  } catch (e) {
    console.error(`orquestra: agent registration failed — mints will error until REPPO_AGENT_ID is set (run \`reppo register-agent\`): ${(e as Error).message}`)
  }
}

async function start(): Promise<void> {
  await checkReppoVersion() // warn-only preflight: old CLI fails every vote/mint cryptically
  if (needsOnboarding(DATA_DIR)) await onboard()
  const config: StrategyConfig = loadConfig(DATA_DIR)

  const provider = (process.env.LLM_PROVIDER ?? 'anthropic') as LlmProvider
  const model = resolveModel(provider, process.env.LLM_API_KEY ?? '')
  const strategyBrief = (() => {
    try { return readFileSync(join(DATA_DIR, 'strategy-notes.md'), 'utf-8') } catch { return '' }
  })()
  // One shared BudgetLedger instance: the executor reserves/records spend on it,
  // and runCycle calls startCycle on it — the single source of budget truth.
  const ledger = new BudgetLedger(DATA_DIR, config.budget)
  const executor = new WalletExecutor(defaultReppoCli, ledger)
  const wiring: CycleWiring = {
    dataDir: DATA_DIR, config,
    scorer: createLlmScorer(model, { brief: strategyBrief }),
    ledger, executor,
    dedup: new DedupState(DATA_DIR),
    // Adapter registry — add new adapters here; routing is by adapter id from config.
    adapters: [createHyperliquidAdapter(), createGdeltAdapter({ model }), createSportsAdapter({ model })],
    strategyBrief,
  }

  await setupNode(config, executor)

  const nDatanets = Object.keys(config.datanets).filter((k) => k !== '*').length
  console.error(`orquestra: starting — cadence ${config.cadenceHours}h, ${nDatanets} datanet(s)`)
  // reloadConfig: dashboard saves apply at the next cycle (validated; last-good on failure)
  const handle = startScheduler(config.cadenceHours, buildTick(wiring, buildCycleDeps(wiring), { reloadConfig: () => loadConfig(DATA_DIR) }))

  const dashEnabled = (process.env.DASHBOARD_ENABLED ?? 'true') !== 'false'
  const dashPort = Number(process.env.DASHBOARD_PORT ?? 7070)
  const dash = dashEnabled ? await startDashboard(DATA_DIR, dashPort) : null
  if (dash) console.error(`orquestra: dashboard on http://localhost:${dash.port}`)

  // As PID 1 in a container, Node only stops on SIGINT/SIGTERM if we handle them —
  // without this, Ctrl-C and `docker stop` are ignored. Stop the scheduler + exit.
  const shutdown = (sig: string): void => {
    console.error(`\norquestra: received ${sig} — stopping scheduler and exiting.`)
    handle.stop()
    if (dash) void dash.close()
    process.exit(0)
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
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
