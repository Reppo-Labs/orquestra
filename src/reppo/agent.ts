// src/reppo/agent.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { reppoEnv, withRpcUrl } from './exec.js'

const execFileAsync = promisify(execFile)
const FILE = 'agent.json'

/** Reppo platform agent identity. `mint-pod` requires REPPO_AGENT_ID (>=0.8.0);
 *  registration also yields an apiKey, persisted for completeness. */
export interface AgentCreds { agentId: string; apiKey: string }

/** Pure: extract creds from `reppo register-agent --json`. */
export function parseAgentRegistration(raw: unknown): AgentCreds {
  const d = (raw as Record<string, unknown>) ?? {}
  return {
    agentId: String(d.agentId ?? d.id ?? ''),
    apiKey: String(d.apiKey ?? d.api_key ?? ''),
  }
}

/** Read persisted agent creds from the data dir; null if absent/empty/corrupt. */
export function readAgentStore(dataDir: string): AgentCreds | null {
  const path = join(dataDir, FILE)
  if (!existsSync(path)) return null
  try {
    const c = parseAgentRegistration(JSON.parse(readFileSync(path, 'utf-8')))
    return c.agentId ? c : null
  } catch {
    return null
  }
}

/** Atomic write (tmp + rename), matching the ledger/state persistence pattern. */
export function writeAgentStore(dataDir: string, creds: AgentCreds): void {
  const path = join(dataDir, FILE)
  writeFileSync(`${path}.tmp`, JSON.stringify(creds, null, 2))
  renameSync(`${path}.tmp`, path)
}

/** Live: register an agent identity on the Reppo platform (signs with the wallet).
 *  One-time per operator — callers gate it behind ensureAgentId's idempotency. */
export async function registerAgentJson(name: string, description: string): Promise<AgentCreds> {
  const { stdout } = await execFileAsync(
    'reppo',
    withRpcUrl(['register-agent', '--name', name, '--description', description, '--json']),
    { env: reppoEnv(), timeout: 120_000 },
  )
  try {
    return parseAgentRegistration(JSON.parse(stdout))
  } catch {
    throw new Error(`registerAgentJson: bad reppo output: ${stdout.slice(0, 200)}`)
  }
}

export interface EnsureAgentDeps {
  /** true when any datanet has mint enabled — voting-only nodes need no agent. */
  mintingEnabled: boolean
  /** REPPO_AGENT_ID from the environment, if the operator set it manually. */
  envAgentId?: string
  readStored(): AgentCreds | null
  register(): Promise<AgentCreds>
  writeStored(creds: AgentCreds): void
  /** make the creds visible to subsequent CLI calls (e.g. set process.env). */
  setEnv(creds: AgentCreds): void
}

export type EnsureAgentResult = { source: 'skipped' | 'env' | 'stored' | 'registered'; agentId?: string }

/** Ensure a REPPO_AGENT_ID is available before minting. Idempotent, mirroring the
 *  one-time veREPPO lock: register once, persist to the data volume, reuse after.
 *  Precedence: operator-set env → persisted store → fresh registration. */
export async function ensureAgentId(deps: EnsureAgentDeps): Promise<EnsureAgentResult> {
  if (!deps.mintingEnabled) return { source: 'skipped' }

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
