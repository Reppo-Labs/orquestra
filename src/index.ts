// src/index.ts — thin shell: env, service construction, argv dispatch, signals.
// All cycle wiring lives in src/runtime/wiring.ts (unit-tested there).
import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { loadConfig } from './config/load.js'
import { needsOnboarding, persistOnboarding } from './onboarding/persist.js'
import { buildStrategyConfig } from './onboarding/build.js'
import { runConversationalOnboarding } from './onboarding/agent.js'
import { listDatanetsJson } from './reppo/listDatanets.js'
import { checkReppoVersion, getReppoVersionString } from './reppo/version.js'
import { supportsNonReppoGrants } from './reppo/capabilities.js'
import { queryBalanceJson, queryWalletAddress } from './reppo/queryBalance.js'
import { ensureAgentId, registerAgentJson, readAgentStore, writeAgentStore } from './reppo/agent.js'
import { terminalPrompter } from './runtime/prompter.js'
import { startScheduler } from './runtime/scheduler.js'
import { BudgetLedger } from './wallet/ledger.js'
import { WalletExecutor, MINT_REPPO_FALLBACK } from './wallet/executor.js'
import { defaultReppoCli } from './reppo/cli.js'
import { readMintReppoFee, readClaimedReppo } from './reppo/mintFee.js'
import { getDatanetRubric } from './rubric/load.js'
import { createHyperliquidAdapter } from './adapter/hyperliquid/index.js'
import { createGdeltAdapter } from './adapter/gdelt/index.js'
import { createSportsAdapter } from './adapter/sports/index.js'
import { resolveModel, DEFAULT_MODEL, type LlmProvider } from './llm/model.js'
import { buildProviderKeyRegistry } from './llm/registry.js'
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
    persistOnboarding(DATA_DIR, buildStrategyConfig(answers))
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
    if (res.source === 'registered') console.error(`orquestra: registered Reppo agent ${res.agentId} — persisted to ${DATA_DIR}/activity.db`)
    else if (res.source !== 'skipped') console.error(`orquestra: using Reppo agent ${res.agentId} (${res.source})`)
  } catch (e) {
    console.error(`orquestra: agent registration failed — mints will error until REPPO_AGENT_ID is set (run \`reppo register-agent\`): ${(e as Error).message}`)
  }
}

async function start(): Promise<void> {
  // ONE `reppo --version` shell-out at startup: read the banner once, then feed the SAME
  // string to both the warn-only preflight and the per-feature capability gate (no second
  // shell-out). grant-access --token primary (non-REPPO access fees) needs reppo >=0.8.5 —
  // when the installed CLI is older, the cycle skips non-REPPO-fee datanets instead of firing
  // an unsupported flag. Fail-closed: an unreadable version → '' → preflight warns + capability false.
  const reppoVersion = await getReppoVersionString()
  await checkReppoVersion({ getVersion: async () => reppoVersion }) // warn-only: old CLI fails every vote/mint cryptically
  const canGrantNonReppo = supportsNonReppoGrants(reppoVersion)
  mkdirSync(DATA_DIR, { recursive: true })

  const provider = (process.env.LLM_PROVIDER ?? 'anthropic') as LlmProvider
  const model = resolveModel(provider, process.env.LLM_API_KEY ?? '')
  // Multi-provider key registry (env-only): the per-datanet vote scorer resolves a model
  // from this. Includes the back-compat LLM_PROVIDER/LLM_API_KEY default.
  const providerKeyRegistry = buildProviderKeyRegistry(process.env)
  const defaultModel = DEFAULT_MODEL[provider]

  // Dashboard FIRST: on a fresh node it hosts the conversational onboarding;
  // the scheduler starts only once a strategy config exists.
  const dashEnabled = (process.env.DASHBOARD_ENABLED ?? 'true') !== 'false'
  const dashPort = Number(process.env.DASHBOARD_PORT ?? 7070)
  const dash = dashEnabled ? await startDashboard(DATA_DIR, dashPort, { chatModel: model }) : null
  if (dash) console.error(`orquestra: dashboard on http://localhost:${dash.port}`)

  if (needsOnboarding(DATA_DIR)) {
    if (process.stdin.isTTY) {
      await onboard()
    } else if (dash) {
      // Blessed first-run (ADR 0001): no TTY → onboard in the dashboard. The port is
      // localhost-bound (ADR 0002), so tell the operator exactly how to reach it.
      console.error(
        `orquestra: no strategy config yet — onboard in the dashboard, then the node starts automatically.\n` +
        `           reach it over an SSH tunnel:  ssh -L ${dashPort}:localhost:${dashPort} <this-host>\n` +
        `           then open  http://localhost:${dashPort}\n` +
        `           (headless/CI alternative: run \`orquestra configure\` with -it)`,
      )
      while (needsOnboarding(DATA_DIR)) await new Promise((r) => setTimeout(r, 2000))
      console.error('orquestra: onboarding complete — starting node.')
    } else {
      throw new Error('no strategy config and no TTY or dashboard to onboard with — run `orquestra configure`')
    }
  }
  const config: StrategyConfig = loadConfig(DATA_DIR)
  // One shared BudgetLedger instance: the executor reserves/records spend on it,
  // and runCycle calls startCycle on it — the single source of budget truth.
  const ledger = new BudgetLedger(DATA_DIR, config.budget, config.horizonDays)
  // The reppo CLI omits the mint REPPO fee; read it from the tx receipt so the
  // ledger reconciles to real spend and mintReppoMax is a live cap. Same RPC the
  // CLI uses; no RPC configured => reader omitted (mint spend keeps the reserved est).
  const rpcUrl = (process.env.RPC_URL ?? process.env.REPPO_RPC_URL ?? '').trim()
  const reppoFeeReader = rpcUrl ? (txHash: string) => readMintReppoFee(rpcUrl, txHash) : undefined
  const claimReppoReader = rpcUrl ? (txHash: string) => readClaimedReppo(rpcUrl, txHash) : undefined
  const executor = new WalletExecutor(defaultReppoCli, ledger, reppoFeeReader, claimReppoReader)
  // A mint reserves a conservative MINT_REPPO_FALLBACK against mintReppoMax before
  // signing (refuse-before, not after). If the cap is below one such reserve, EVERY
  // mint is refused — warn loudly so the operator isn't left wondering why nothing mints.
  const mintEnabled = Object.entries(config.datanets).some(([k, d]) => k !== '*' && d.mint)
  if (mintEnabled && config.budget.mintReppoMax < MINT_REPPO_FALLBACK) {
    console.error(
      `orquestra: WARNING — budget.mintReppoMax (${config.budget.mintReppoMax}) is below the conservative ` +
        `per-mint reserve (${MINT_REPPO_FALLBACK} REPPO), so every mint will be refused before signing. ` +
        `Raise mintReppoMax to at least ${MINT_REPPO_FALLBACK}` +
        (reppoFeeReader ? '' : ', or set RPC_URL so the cap tracks the real (often lower) fee') + ' to mint.',
    )
  }
  // Wallet address for on-chain emissions detection (the platform `emissions-due` API
  // under-reports; we read PodManager directly). Best-effort — null falls back to the CLI.
  const walletAddress = rpcUrl ? ((await queryWalletAddress().catch(() => null)) ?? undefined) : undefined
  const wiring: CycleWiring = {
    dataDir: DATA_DIR, config,
    model,
    providerKeyRegistry,
    defaultProvider: provider,
    defaultModel,
    // Self-learning reflection runs on the same model as the scorer/panel.
    learnModel: model,
    rpcUrl: rpcUrl || undefined,
    walletAddress,
    supportsNonReppoGrants: canGrantNonReppo,
    ledger, executor,
    dedup: new DedupState(DATA_DIR),
    // Adapter registry — add new adapters here; routing is by adapter id from config.
    adapters: [createHyperliquidAdapter(), createGdeltAdapter({ model }), createSportsAdapter({ model })],
  }

  await setupNode(config, executor)

  const nDatanets = Object.keys(config.datanets).filter((k) => k !== '*').length
  console.error(`orquestra: starting — cadence ${config.cadenceHours}h, ${nDatanets} datanet(s)`)
  // reloadConfig: dashboard saves apply at the next cycle (validated; last-good on failure)
  const handle = startScheduler(config.cadenceHours, buildTick(wiring, buildCycleDeps(wiring), { reloadConfig: () => loadConfig(DATA_DIR) }))

  // As PID 1 in a container, Node only stops on SIGINT/SIGTERM if we handle them —
  // without this, Ctrl-C and `docker stop` are ignored. Stop the scheduler, drain any
  // in-flight cycle so a mint/vote between submit and dedup-persist isn't cut mid-write
  // (bounded so `docker stop`'s grace period is respected), then close the dashboard.
  const SHUTDOWN_DRAIN_MS = 10_000
  let shuttingDown = false
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    console.error(`\norquestra: received ${sig} — stopping scheduler and exiting.`)
    handle.stop()
    const inflight = handle.current()
    if (inflight) {
      console.error(`orquestra: draining in-flight cycle (up to ${SHUTDOWN_DRAIN_MS / 1000}s)…`)
      await Promise.race([inflight, new Promise((r) => setTimeout(r, SHUTDOWN_DRAIN_MS))])
    }
    if (dash) await dash.close().catch(() => {})
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
}

const cmd = process.argv[2]
const run = cmd === 'configure' ? onboard : start
run().catch((e) => {
  const err = e as Error
  console.error('orquestra: fatal:', err.message)
  if (err.name === 'LedgerCorruptError') {
    console.error(
      `orquestra: the budget ledger in ${DATA_DIR}/activity.db is corrupt; the node refuses to run rather than ` +
        `lose track of spend. Inspect the budget_ledger row, or clear it to reset budget accounting to zero (caps restart from 0).`,
    )
  }
  process.exitCode = 1
})
