// src/index.ts — thin shell: env, service construction, argv dispatch, signals.
// All cycle wiring lives in src/runtime/wiring.ts (unit-tested there).
import { resolve } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { loadConfig, reconcileConfigFile, CONFIG_FILENAME } from './config/load.js'
import { validateConfigText } from './config/validate.js'
import { needsOnboarding, persistOnboarding } from './onboarding/persist.js'
import { buildStrategyConfig } from './onboarding/build.js'
import { runConversationalOnboarding } from './onboarding/agent.js'
import { listDatanetsJson } from './reppo/listDatanets.js'
import { checkReppoVersion, getReppoVersionString } from './reppo/version.js'
import { supportsNonReppoGrants } from './reppo/capabilities.js'
import { queryBalanceJson, queryWalletAddress } from './reppo/queryBalance.js'
import { ensureAgentId, registerAgentJson, readAgentStore, writeAgentStore, agentDisplayName } from './reppo/agent.js'
import { terminalPrompter } from './runtime/prompter.js'
import { startScheduler } from './runtime/scheduler.js'
import { BudgetLedger } from './wallet/ledger.js'
import { WalletExecutor, MINT_REPPO_FALLBACK } from './wallet/executor.js'
import { planStakeTopUp, stakeTopUpKey, markStakeTargetAttempted } from './wallet/stakeTopUp.js'
import { defaultReppoCli } from './reppo/cli.js'
import { readMintReppoFee, readClaimedReppo } from './reppo/mintFee.js'
import { getDatanetRubric } from './rubric/load.js'
import { createHyperliquidAdapter } from './adapter/hyperliquid/index.js'
import { createGdeltAdapter } from './adapter/gdelt/index.js'
import { createSportsAdapter } from './adapter/sports/index.js'
import { resolveModel, DEFAULT_MODEL, type LlmProvider } from './llm/model.js'
import { effectiveDefault } from './llm/effectiveDefault.js'
import { buildProviderKeyRegistry } from './llm/registry.js'
import { spawn } from 'node:child_process'
import { loadCredential, saveCredential, hasOAuthCredential } from './llm/oauth/anthropic/store.js'
import { createTokenManager } from './llm/oauth/anthropic/tokenManager.js'
import { oauthAwareResolver, OAUTH_KEY_SENTINEL } from './llm/oauth/anthropic/resolver.js'
import { loginAnthropic } from './llm/oauth/anthropic/login.js'
import { DedupState } from './runtime/state.js'
import type { StrategyConfig } from './config/schema.js'
import { buildCycleDeps, buildTick, type CycleWiring } from './runtime/wiring.js'
import { startDashboard } from './dashboard/server.js'

const DATA_DIR = resolve(process.env.ORQUESTRA_DATA_DIR ?? './data')

/** Parse an optional positive-integer env var; undefined (use the default downstream) on
 *  absent OR non-numeric/non-positive input. `Number(undefined)` is NaN, so a bare ternary
 *  on truthiness would pass NaN through for a value like "abc". */
function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

async function onboard(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true })
  // Registry-aware: an operator may set LLM_KEY_<PROVIDER> and drop LLM_API_KEY.
  // buildProviderKeyRegistry folds the legacy LLM_API_KEY into the default provider's
  // slot, so registry.get(provider) is the right key from either source.
  const provider = (process.env.LLM_PROVIDER ?? 'anthropic') as LlmProvider
  const apiKey = buildProviderKeyRegistry(process.env).get(provider) ?? ''
  if (!apiKey) {
    console.error('orquestra: onboarding needs an LLM key — set LLM_KEY_<PROVIDER> (or LLM_PROVIDER + LLM_API_KEY) and re-run.')
    process.exitCode = 1
    return
  }
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
async function setupNode(config: StrategyConfig, executor: WalletExecutor, agentName: string): Promise<void> {
  if (config.stake.lockReppo > 0) {
    // The lock is a TARGET, not one-time: top up to config.stake.lockReppo by locking
    // the difference as an additional lockup. Skip when already at/above target. A lock
    // error is non-fatal — the node still runs/votes on existing veREPPO.
    const existing = await queryBalanceJson().catch(() => null)
    if (existing === null) {
      // A failed balance read is NOT zero — locking against current=0 would lock the FULL
      // target on top of whatever the wallet already holds (over-lock). Skip the lock here;
      // the per-cycle top-up retries once the balance query recovers.
      console.error('orquestra: could not read veREPPO balance — skipping stake setup')
    } else {
      const plan = planStakeTopUp(existing.veReppo, config.stake)
      if (!plan) {
        console.error(`orquestra: veREPPO ${existing.veReppo} ≥ target ${config.stake.lockReppo} — no lock needed.`)
        // Nothing to retry — seed the latch so cycle-1 doesn't re-evaluate the same target.
        markStakeTargetAttempted(config.stake.lockReppo)
      } else {
        console.error(`orquestra: topping up veREPPO ${existing.veReppo} → ${config.stake.lockReppo} (+${plan.lockAmount}, ${config.stake.lockDurationDays}d)`)
        const r = await executor.lock({
          amountReppo: plan.lockAmount,
          durationSeconds: plan.durationSeconds,
          idempotencyKey: stakeTopUpKey(config.stake),
        })
        console.error(`orquestra: veREPPO lock ${r.status}` + (r.txHash ? ` (${r.txHash})` : '') + (r.detail ? ` — ${r.detail}` : ''))
        // Seed the latch ONLY on a confirmed lock, so cycle-1 doesn't re-attempt the same target
        // with a slightly different `current` reading (→ IDEMPOTENCY_ARGS_MISMATCH in reppo-cli).
        // A FAILED startup lock is deliberately LEFT unlatched so the per-cycle top-up retries it
        // (and records the reason to the dashboard) instead of leaving the node at zero veREPPO
        // with no explanation until a manual restart.
        if (r.status === 'executed') markStakeTargetAttempted(config.stake.lockReppo)
      }
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
      register: () => registerAgentJson(agentName, 'Reppo Orquestra swarm node — publishes data pods'),
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
  // Surface the resolved data dir so an operator can confirm it points at the mounted
  // volume. If this prints a path that isn't on a Docker volume, `compose down && up` will
  // silently discard the strategy config + ledgers (kept across a plain restart).
  console.error(`orquestra: data dir ${DATA_DIR} (persist strategy/ledgers/activity here — keep this on a mounted volume)`)

  // Multi-provider key registry (env-only): the per-datanet vote scorer resolves a model
  // from this. Built FIRST so the node-default model's key is derived from it too — an
  // operator who sets LLM_KEY_<PROVIDER> and drops LLM_API_KEY still gets a non-empty key
  // for the default model (onboarding/strategy chat, mint scorer, panel, learn, adapters).
  // buildProviderKeyRegistry folds the back-compat LLM_PROVIDER/LLM_API_KEY default in.
  const providerKeyRegistry = buildProviderKeyRegistry(process.env)
  // Subscription OAuth (anthropic-oauth): a stored token set makes the provider AVAILABLE
  // (a SENTINEL key in the registry — the real credential is a refreshed Bearer token, not an
  // env key) and resolves its models through a token-manager-backed resolver. `resolve` wraps
  // resolveModel so every model use (default, chat, vote scorer, mint, learn) can speak oauth;
  // it is also threaded into the cycle wiring below.
  const oauthTokens = createTokenManager({ load: () => loadCredential(DATA_DIR) })
  if (hasOAuthCredential(DATA_DIR)) providerKeyRegistry.set('anthropic-oauth', OAUTH_KEY_SENTINEL)
  const resolve = oauthAwareResolver(() => oauthTokens.getAccessToken())
  const envProvider = (process.env.LLM_PROVIDER ?? 'anthropic') as LlmProvider
  const envModel = DEFAULT_MODEL[envProvider]
  // Non-chat default model (mint/panel/learn/adapters): env default at startup.
  const envDefaultKey = providerKeyRegistry.get(envProvider) ?? ''
  const model = resolve(envProvider, envDefaultKey, envModel)
  // Fail-fast guidance: anthropic-oauth resolves a model even with no credential (the token is
  // fetched per request), so without this the node boots clean and fails deep inside the first
  // cycle. Warn at startup instead. (config.defaultModel can also pick oauth; the env default is
  // the common case and the one that silently breaks onboarding.)
  if (envProvider === 'anthropic-oauth' && !hasOAuthCredential(DATA_DIR)) {
    console.error('orquestra: WARNING — LLM_PROVIDER=anthropic-oauth but no subscription is linked. Run `orquestra login-anthropic` then restart; until then every LLM call fails.')
  }
  // Per-request node-default CHAT model: re-resolve from the CURRENT config.defaultModel
  // (hot — a dashboard change takes effect with no restart) + the env-only key registry.
  // null when even the effective default has no key (handlers 503). loadConfig is tolerant:
  // a fresh node with no config yet falls back to the env default (bootstrap).
  // Warn-once latch: resolveChatModel runs per chat request AND per /api/onboarding/status
  // poll (~30s), so a stale config.defaultModel (its provider's key removed from env) would
  // otherwise spam the same fallback warning to stderr forever. Log at most once per distinct
  // message (mirrors warnedGrantReppoMax in src/config/load.ts).
  let lastFallbackWarned: string | undefined
  const resolveChatModel = (): ReturnType<typeof resolveModel> | null => {
    let configDefault: { provider: LlmProvider; model: string } | undefined
    try { configDefault = loadConfig(DATA_DIR).defaultModel } catch { configDefault = undefined }
    const eff = effectiveDefault({ configDefault, registry: providerKeyRegistry, envProvider, envModel })
    if (eff.usedFallback && eff.usedFallback !== lastFallbackWarned) {
      lastFallbackWarned = eff.usedFallback
      console.error(`orquestra: ${eff.usedFallback}`)
    }
    return eff.key ? resolve(eff.provider, eff.key, eff.model) : null
  }

  // Dashboard FIRST: on a fresh node it hosts the conversational onboarding;
  // the scheduler starts only once a strategy config exists.
  const dashEnabled = (process.env.DASHBOARD_ENABLED ?? 'true') !== 'false'
  const dashPort = Number(process.env.DASHBOARD_PORT ?? 7070)
  const dash = dashEnabled ? await startDashboard(DATA_DIR, dashPort, { resolveChatModel, availableProviders: [...providerKeyRegistry.keys()] }) : null
  if (dash) console.error(`orquestra: dashboard on http://localhost:${dash.port}`)

  // Declarative deploy (CONFIG_SOURCE=file): treat strategy.config.json in DATA_DIR as the
  // source of truth — re-apply it to the config row on every boot (a redeployed K8s ConfigMap
  // takes effect on pod restart) and skip onboarding. A malformed file throws ConfigInvalidError
  // here → the top-level catch exits non-zero (fail fast, no crash-looping on a started node).
  if ((process.env.CONFIG_SOURCE ?? '').trim() === 'file') {
    const { reconciled } = reconcileConfigFile(DATA_DIR)
    if (reconciled) console.error(`orquestra: applied ${CONFIG_FILENAME} (CONFIG_SOURCE=file) — config row reconciled from the mounted file`)
    else if (needsOnboarding(DATA_DIR)) throw new Error(`CONFIG_SOURCE=file but no ${CONFIG_FILENAME} in ${DATA_DIR} and no existing config — seed the file before boot`)
  }

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
    resolveModel: resolve,
    defaultProvider: envProvider,
    defaultModel: envModel,
    // Cost/latency cap on video pods scored per cycle (the LLM bill is the operator's,
    // not the on-chain budget). Default (4) lives in buildCycleDeps. NaN-safe: a non-numeric
    // value falls back to undefined (the default) rather than passing NaN through, which
    // would make `videoBudget > 0` always false and silently disable the whole video feature.
    videoPodsPerCycle: parsePositiveInt(process.env.VIDEO_PODS_PER_CYCLE),
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

  // Node-unique agent name so each operator is distinguishable on the Reppo platform
  // (REPPO_AGENT_NAME override, else orquestra-<wallet slice>) instead of all sharing "orquestra".
  await setupNode(config, executor, agentDisplayName(process.env.REPPO_AGENT_NAME, walletAddress))

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

/** `orquestra login-anthropic` — one-time login that links the operator's Claude subscription
 *  by minting a token with the first-party `claude setup-token` CLI (a hand-rolled OAuth flow is
 *  rejected by Anthropic for third-party clients). Persists the token to DATA_DIR for the
 *  `anthropic-oauth` provider. Requires the `claude` CLI on PATH where this runs. */
async function loginAnthropicCmd(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true })
  // `claude setup-token` is interactive (prints a URL, polls the browser auth, then prints the
  // token). Tee its stdout to the terminal so the operator sees the URL + progress, while we
  // capture stdout to scrape the token; stdin/stderr are inherited for its own prompts.
  const execClaude = (cmd: string, args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['inherit', 'pipe', 'inherit'] })
      let out = ''
      child.stdout?.on('data', (d: Buffer) => { out += d.toString(); process.stdout.write(d) })
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`claude setup-token exited ${code}`))))
    })
  try {
    await loginAnthropic({
      exec: execClaude,
      save: (c) => saveCredential(DATA_DIR, c),
      info: (m) => console.error(`\n${m}`),
    })
    console.error(`orquestra: saved subscription token to ${DATA_DIR}/anthropic-oauth.json — set LLM_PROVIDER=anthropic-oauth (or pick it in the dashboard) to use it.`)
  } catch (e) {
    console.error(`orquestra: login-anthropic failed — ${(e as Error).message}`)
    process.exitCode = 1
  }
}

/** `orquestra validate-config <path>` — validate a strategy.config.json against the schema and
 *  exit 0/1. For CI / pre-deploy gating so a malformed config is caught before it reaches a pod
 *  (where it would fail at boot). Reads the file argument, never the data dir. */
function validateConfigCmd(): void {
  const path = process.argv[3]
  if (!path) {
    console.error('usage: orquestra validate-config <path-to-strategy.config.json>')
    process.exitCode = 2
    return
  }
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch (e) {
    console.error(`orquestra: cannot read ${path}: ${(e as Error).message}`)
    process.exitCode = 2
    return
  }
  const result = validateConfigText(text)
  if (result.ok) {
    console.error(`orquestra: ${path} is a valid strategy config ✓`)
  } else {
    console.error(`orquestra: ${path} is INVALID:\n${result.error}`)
    process.exitCode = 1
  }
}

const cmd = process.argv[2]
const run =
  cmd === 'configure' ? onboard
  : cmd === 'login-anthropic' ? loginAnthropicCmd
  : cmd === 'validate-config' ? async () => validateConfigCmd()
  : start
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
