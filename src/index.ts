// src/index.ts
import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { loadConfig } from './config/load.js'
import { needsOnboarding, persistOnboarding } from './onboarding/persist.js'
import { buildStrategyConfig } from './onboarding/build.js'
import { runConversationalOnboarding } from './onboarding/agent.js'
import { listDatanetsJson } from './reppo/listDatanets.js'
import { queryBalanceJson } from './reppo/queryBalance.js'
import { ensureAgentId, registerAgentJson, readAgentStore, writeAgentStore } from './reppo/agent.js'
import { terminalPrompter } from './runtime/prompter.js'
import { startScheduler } from './runtime/scheduler.js'
import { BudgetLedger } from './wallet/ledger.js'
import { WalletExecutor } from './wallet/executor.js'
import { defaultReppoCli } from './reppo/cli.js'
import { getDatanetRubric } from './rubric/load.js'
import { createHyperliquidAdapter } from './adapter/hyperliquid/index.js'
import { resolveModel, type LlmProvider } from './llm/model.js'
import { createLlmScorer } from './voter/score.js'
import { candidateScoreInput } from './minter/score.js'
import { runCycle, type CycleDeps } from './runtime/cycle.js'
import { listPodsJson, deriveCurrentEpoch } from './reppo/listPods.js'
import { DedupState } from './runtime/state.js'
import type { StrategyConfig } from './config/schema.js'
import { appendActivity } from './dashboard/activityLog.js'
import { collectSnapshot, writeSnapshot, readSnapshot, type SnapshotBudget } from './dashboard/snapshot.js'
import { queryVotingPowerJson } from './reppo/queryVotingPower.js'
import { queryEmissionsDueJson } from './reppo/queryEmissionsDue.js'
import { queryEpochJson } from './reppo/queryEpoch.js'
import { startDashboard } from './dashboard/server.js'
import { backfillActivityLog } from './dashboard/backfill.js'
import { readActivity } from './dashboard/activityLog.js'
import { earnSummary, formatEarnStatus, writeEarnStatus, selectOurPods, type OwnPodVote } from './dashboard/earnStatus.js'
import { queryDatanetPodVotes } from './reppo/queryOwnPods.js'

async function fetchPodContent(url: string): Promise<string> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) return ''
    return (await res.text()).slice(0, 4000) // cap tokens
  } catch {
    return ''
  } finally {
    clearTimeout(t)
  }
}

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
  const dedup = new DedupState(DATA_DIR)
  // Adapter registry — add new adapters here; routing is by adapter id from config.
  const adapters = [createHyperliquidAdapter()]

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
      console.error(
        `orquestra: veREPPO lock ${r.status}` +
          (r.txHash ? ` (${r.txHash})` : '') +
          (r.detail ? ` — ${r.detail}` : ''),
      )
    }
  }

  // Reppo agent identity for minting (reppo >=0.8.0 `mint-pod` requires REPPO_AGENT_ID).
  // Idempotent like the veREPPO lock: operator-set env wins, else reuse the persisted
  // agent.json, else register once and persist. Gated on minting being enabled so a
  // voting-only node never registers. A failure here is non-fatal — voting still runs;
  // mints will error visibly until an agent id is available.
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

  const deps: CycleDeps = {
    dataDir: DATA_DIR,
    topN: 12,
    getRubric: (id) => getDatanetRubric(id),
    getPodsAndFilter: async (id) => {
      const pods = await listPodsJson(id, { all: true })
      const own = await listPodsJson(id, { all: false })
        .then((p) => p.map((x) => x.podId))
        .catch((e) => {
          console.error(`orquestra: own-pods read failed for datanet ${id} — own-pod vote guard disabled this cycle: ${(e as Error).message}`)
          return [] as string[]
        })
      const currentEpoch = deriveCurrentEpoch(pods)
      const voted = dedup.getVotedPodIds(id)
      const ownSet = new Set(own), votedSet = new Set(voted)
      for (const p of pods) {
        const eligible = (currentEpoch === null || p.validityEpoch === currentEpoch) && !ownSet.has(p.podId) && !votedSet.has(p.podId)
        if (eligible && p.url) { const c = await fetchPodContent(p.url); if (c) p.description = `${p.name}\n\n${c}` }
      }
      return { pods, filter: { currentEpoch, ownPodIds: own, votedPodIds: voted } }
    },
    getAdapter: (id) => adapters.find((a) => a.id === id),
    voteScorer: scorer,
    candidateScorer: {
      scoreCandidate: (c, r) => {
        // Score the DATASET against the publisher spec, not just the summary line —
        // otherwise every candidate scores low ("no trade detail / no verification")
        // and nothing ever mints. See src/minter/score.ts.
        const { name, description } = candidateScoreInput(c)
        return scorer.scorePod({ podId: c.canonicalKey, validityEpoch: '', name, description }, r)
      },
    },
    seenKeysFor: async (id) => new Set(dedup.getMintedKeys(id)),
    executor,
    ledger,
    recordVote: (id, podId) => dedup.recordVote(id, podId),
    recordMint: (id, key) => dedup.recordMint(id, key),
    getEmissionsDue: async () => (await queryEmissionsDueJson()).pods,
    seenClaims: async () => new Set(dedup.getClaimedKeys()),
    recordActivity: (entry) => {
      try { appendActivity(DATA_DIR, entry) } catch (e) { console.error(`orquestra: activity append failed (non-fatal): ${(e as Error).message}`) }
    },
    recordClaim: (key) => dedup.recordClaim(key),
  }

  const nDatanets = Object.keys(config.datanets).filter((k) => k !== '*').length
  console.error(`orquestra: starting — cadence ${config.cadenceHours}h, ${nDatanets} datanet(s)`)
  const handle = startScheduler(config.cadenceHours, async () => {
    const cycleId = new Date().toISOString()
    const report = await runCycle(config, cycleId, deps)
    const v = report.datanets.reduce((a, r) => a + r.votes.length, 0)
    const m = report.datanets.reduce((a, r) => a + r.mints.length, 0)
    const c = report.claims.length
    console.error(`orquestra: cycle ${cycleId} — ${v} votes, ${m} mints, ${c} claims executed`)

    // Snapshot the on-chain view for the dashboard (best-effort; never throws into the loop).
    try {
      const budget: SnapshotBudget = {
        mintReppoSpent: ledger.state.mintReppoSpent,
        mintGasSpentEth: ledger.state.mintGasSpentEth,
        voteGasSpentEth: ledger.state.voteGasSpentEth,
        claimGasSpentEth: ledger.state.claimGasSpentEth,
        caps: config.budget,
      }
      const snap = await collectSnapshot(DATA_DIR, cycleId, {
        balance: () => queryBalanceJson(),
        votingPower: () => queryVotingPowerJson(),
        emissionsDue: () => queryEmissionsDueJson(),
        epoch: () => queryEpochJson(),
        budget: () => budget,
      })
      writeSnapshot(DATA_DIR, snap)
    } catch (e) {
      console.error(`orquestra: snapshot write failed (non-fatal): ${(e as Error).message}`)
    }

    // Earn-test report each cycle (the G1 signal — does minting actually pay?). Reuse the
    // snapshot's emissions-due, add our pods' on-chain vote tallies (the leading signal),
    // log it, and persist earn-status.json for the dashboard (/api/earn). Best-effort.
    try {
      const snap = readSnapshot(DATA_DIR)
      const activity = readActivity(DATA_DIR, { limit: 100_000 })
      const mintDatanets = Object.entries(config.datanets).filter(([k, d]) => k !== '*' && d.mint).map(([k]) => k)
      // On-chain `creator` is empty on our pods, so identify ours by the mint names we
      // recorded, matched against the full datanet pod list.
      const ourNames = activity
        .filter((e) => e.kind === 'mint' && e.status === 'executed' && e.cycleId !== 'backfill' && e.podName)
        .map((e) => e.podName as string)
      const votes: OwnPodVote[] = []
      for (const id of mintDatanets) {
        try { votes.push(...selectOurPods(await queryDatanetPodVotes(id), ourNames)) } catch (e) { console.error(`orquestra: earn pod-votes query failed for datanet ${id}: ${(e as Error).message}`) }
      }
      const summary = earnSummary(activity, snap?.emissionsDue ?? { totalReppo: 0, pods: [] }, votes)
      writeEarnStatus(DATA_DIR, { ...summary, ts: new Date().toISOString() })
      console.error(formatEarnStatus(summary))
    } catch (e) {
      console.error(`orquestra: earn-status update failed (non-fatal): ${(e as Error).message}`)
    }
  })

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

/** One-time migration: surface pre-dashboard votes/mints in the activity log. */
async function runBackfill(): Promise<void> {
  const config = loadConfig(DATA_DIR)
  const datanetIds = Object.keys(config.datanets).filter((k) => k !== '*')
  const ts = new Date().toISOString()
  const r = await backfillActivityLog(DATA_DIR, datanetIds, (id) => listPodsJson(id, { all: false }), ts)
  if (r.skipped) console.error('orquestra: backfill skipped — activity log already has backfilled rows.')
  else console.error(`orquestra: backfill complete — ${r.votes} votes, ${r.mints} mints written to activity-log.jsonl`)
}

const cmd = process.argv[2]
const run = cmd === 'configure' ? onboard : cmd === 'backfill' ? runBackfill : start
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
