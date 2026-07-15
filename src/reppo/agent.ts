// src/reppo/agent.ts
import { readFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, type SqliteDb } from '../dashboard/db.js'
import { runReppoStdout } from './exec.js'

const LEGACY_AGENT = 'agent.json'

/** Reppo platform agent identity. `mint-pod` requires REPPO_AGENT_ID (>=0.8.0);
 *  registration also yields an apiKey, persisted for completeness.
 *  `name` = the display name last synced to the platform (absent on pre-migration rows);
 *  lets a changed REPPO_AGENT_NAME be detected and PATCHed on restart. */
export interface AgentCreds { agentId: string; apiKey: string; name?: string }

/** Pure: extract creds from `reppo register-agent --json`. */
export function parseAgentRegistration(raw: unknown): AgentCreds {
  const d = (raw as Record<string, unknown>) ?? {}
  return {
    agentId: String(d.agentId ?? d.id ?? ''),
    apiKey: String(d.apiKey ?? d.api_key ?? ''),
  }
}

const agentImported = new Set<string>()
function conn(dataDir: string): SqliteDb {
  const d = getDb(dataDir)
  if (!agentImported.has(dataDir)) {
    importLegacyAgent(d, dataDir)
    agentImported.add(dataDir)
  }
  return d
}

/** One-time import of a pre-existing agent.json into the empty `agent` row, then
 *  rename it *.imported. A corrupt file imports nothing, still renamed. */
function importLegacyAgent(d: SqliteDb, dataDir: string): void {
  const n = (d.prepare('SELECT COUNT(*) AS n FROM agent').get() as { n: number }).n
  if (n > 0) return
  const path = join(dataDir, LEGACY_AGENT)
  if (!existsSync(path)) return
  try {
    const c = parseAgentRegistration(JSON.parse(readFileSync(path, 'utf-8')))
    if (c.agentId) d.prepare('INSERT INTO agent (id, agentId, apiKey) VALUES (1, ?, ?)').run(c.agentId, c.apiKey)
  } catch { /* corrupt legacy file — skip the import, still rename so we don't retry */ }
  renameSync(path, path + '.imported')
}

/** Read persisted agent creds from the data dir; null if absent/empty/corrupt. */
export function readAgentStore(dataDir: string): AgentCreds | null {
  const row = conn(dataDir).prepare('SELECT agentId, apiKey, name FROM agent WHERE id = 1').get() as
    | { agentId: string; apiKey: string; name: string | null }
    | undefined
  if (!row) return null
  const c: AgentCreds = { agentId: String(row.agentId ?? ''), apiKey: String(row.apiKey ?? '') }
  if (row.name != null && row.name !== '') c.name = String(row.name)
  return c.agentId ? c : null
}

/** Persist agent creds to the single `agent` row (one atomic UPSERT). */
export function writeAgentStore(dataDir: string, creds: AgentCreds): void {
  conn(dataDir)
    .prepare('INSERT INTO agent (id, agentId, apiKey, name) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET agentId = excluded.agentId, apiKey = excluded.apiKey, name = excluded.name')
    .run(creds.agentId, creds.apiKey, creds.name ?? null)
}

/** Parse register-agent output. The CLI prints a human-readable block even with
 *  `--json` (the flag isn't honored), e.g.:
 *    ✓ Registered new agent "orquestra"
 *      id:     cmq4...
 *      apiKey: agent_...
 *  Try JSON first (future-proofing), then fall back to scraping `id:`/`apiKey:` lines.
 *  Throws if neither yields an agentId — so a failed registration never looks like success. */
export function parseRegisterAgentOutput(stdout: string): AgentCreds {
  try {
    const j = parseAgentRegistration(JSON.parse(stdout))
    if (j.agentId) return j
  } catch {
    // not JSON — fall through to text scraping
  }
  const id = stdout.match(/\bid:\s*(\S+)/i)?.[1] ?? ''
  const apiKey = stdout.match(/\bapiKey:\s*(\S+)/i)?.[1] ?? ''
  if (!id) throw new Error(`register-agent: could not parse credentials from output: ${stdout.slice(0, 200)}`)
  return { agentId: id, apiKey }
}

/** Node-unique agent display name so each Orquestra node is distinguishable on the Reppo
 *  platform (stats, claims) instead of every node bundling under a shared "[AGENT] orquestra".
 *  REPPO_AGENT_NAME (operator-chosen) wins; else derive from the wallet (orquestra-<8 hex>,
 *  lowercased — the wallet is per-node unique); else bare "orquestra" when no wallet is known. */
export function agentDisplayName(envName: string | undefined, walletAddress: string | undefined): string {
  const chosen = envName?.trim()
  if (chosen) return chosen
  const addr = walletAddress?.trim().replace(/^0x/i, '')
  return addr ? `orquestra-${addr.slice(0, 8).toLowerCase()}` : 'orquestra'
}

/** Live: register an agent identity on the Reppo platform (signs with the wallet).
 *  One-time per operator — callers gate it behind ensureAgentId's idempotency. */
export async function registerAgentJson(name: string, description: string): Promise<AgentCreds> {
  // via runReppoStdout so a registration failure's folded command line (which
  // carries the --rpc-url key) is redacted like every other reppo call.
  // --is-orquestra (@reppo/cli >= 0.12.3): without it the platform registers a
  // "custom" agent and rejects on-chain pod ids on the /votes endpoint with
  // 404 "Pod not found" — votes execute on-chain but never appear on the platform.
  const stdout = await runReppoStdout(['register-agent', '--name', name, '--description', description, '--is-orquestra', '--json'], 120_000)
  return parseRegisterAgentOutput(stdout)
}

export interface EnsureAgentDeps {
  /** REPPO_AGENT_ID from the environment, if the operator set it manually. */
  envAgentId?: string
  readStored(): AgentCreds | null
  register(): Promise<AgentCreds>
  writeStored(creds: AgentCreds): void
  /** make the creds visible to subsequent CLI calls (e.g. set process.env). */
  setEnv(creds: AgentCreds): void
}

export type EnsureAgentResult = { source: 'env' | 'stored' | 'registered'; agentId?: string }

/** Ensure a REPPO_AGENT_ID is available. Every node registers an agent — not just
 *  minting nodes: the agent is the node's platform identity, and vote registration
 *  (registerVoteOnPlatform) needs its id+apiKey, so a vote-only node without one is
 *  invisible to the platform (uncountable, unattributed votes). Registration is a
 *  free platform API call (no chain tx). Idempotent, mirroring the one-time veREPPO
 *  lock: register once, persist to the data volume, reuse after.
 *  Precedence: operator-set env → persisted store → fresh registration. */
export async function ensureAgentId(deps: EnsureAgentDeps): Promise<EnsureAgentResult> {
  if (deps.envAgentId && deps.envAgentId.trim() !== '') {
    return { source: 'env', agentId: deps.envAgentId.trim() }
  }

  const stored = deps.readStored()
  if (stored && stored.agentId) {
    deps.setEnv(stored)
    return { source: 'stored', agentId: stored.agentId }
  }

  const creds = await deps.register()
  if (!creds.agentId) throw new Error('register-agent returned no agentId')
  deps.writeStored(creds)
  deps.setEnv(creds)
  return { source: 'registered', agentId: creds.agentId }
}

export interface SyncAgentNameDeps {
  /** the display name the operator wants (REPPO_AGENT_NAME / wallet-derived). */
  desiredName: string
  readStored(): AgentCreds | null
  /** PATCH the platform profile (see platformApi.updateAgentOnPlatform). */
  update(agentId: string, name: string, apiKey: string): Promise<void>
  writeStored(creds: AgentCreds): void
}

export type SyncAgentNameResult = 'no-creds' | 'no-apikey' | 'unchanged' | 'updated'

/** Keep the platform display name in step with the operator's choice. Registration is
 *  one-time, so without this a changed REPPO_AGENT_NAME after first start was silently
 *  ignored (stored creds short-circuit re-registration). Idempotent: PATCHes only when
 *  the stored last-synced name differs from the desired one; a NULL stored name
 *  (pre-migration row) counts as different → synced once, then recorded.
 *  Callers treat failures as non-fatal — the name is cosmetic, the node keeps running. */
export async function syncAgentName(deps: SyncAgentNameDeps): Promise<SyncAgentNameResult> {
  const stored = deps.readStored()
  if (!stored) return 'no-creds'
  if (!stored.apiKey) return 'no-apikey' // env-provided id or legacy row — cannot authenticate the PATCH
  if (stored.name === deps.desiredName) return 'unchanged'
  await deps.update(stored.agentId, deps.desiredName, stored.apiKey)
  deps.writeStored({ ...stored, name: deps.desiredName })
  return 'updated'
}

export interface MarkOrquestraDeps {
  readStored(): AgentCreds | null
  /** PATCH { isOrquestra: true } on the platform profile (platformApi.updateAgentOnPlatform). */
  patch(agentId: string, apiKey: string): Promise<void>
}

export type MarkOrquestraResult = 'no-creds' | 'no-apikey' | 'marked'

/** Mark this agent as an Orquestra node on the platform (isOrquestra: true) so its
 *  votes/mints are attributed to orquestra traffic. Runs EVERY start: nodes registered
 *  before the platform accepted the flag (2026-07) self-mark on their next restart, and
 *  the store gains no schema column for a done-latch — the PATCH is idempotent
 *  server-side and one request per boot. Callers treat failures as non-fatal. */
export async function markAgentAsOrquestra(deps: MarkOrquestraDeps): Promise<MarkOrquestraResult> {
  const stored = deps.readStored()
  if (!stored) return 'no-creds'
  if (!stored.apiKey) return 'no-apikey' // env-provided id or legacy row — cannot authenticate the PATCH
  await deps.patch(stored.agentId, stored.apiKey)
  return 'marked'
}
