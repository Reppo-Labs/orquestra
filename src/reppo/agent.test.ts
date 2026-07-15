// src/reppo/agent.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseAgentRegistration, parseRegisterAgentOutput, readAgentStore, writeAgentStore, ensureAgentId, agentDisplayName, syncAgentName, markAgentAsOrquestra, registerAgentJson, type EnsureAgentDeps, type SyncAgentNameDeps, type MarkOrquestraDeps } from './agent.js'
import { runReppoStdout } from './exec.js'

vi.mock('./exec.js', () => ({ runReppoStdout: vi.fn() }))

describe('registerAgentJson (CLI invocation)', () => {
  it('always registers with --is-orquestra so the platform resolves on-chain pod ids', async () => {
    vi.mocked(runReppoStdout).mockResolvedValue(JSON.stringify({ agentId: 'ag_1', apiKey: 'sk_1' }))
    await registerAgentJson('node-a', 'swarm node')
    expect(runReppoStdout).toHaveBeenCalledWith(
      ['register-agent', '--name', 'node-a', '--description', 'swarm node', '--is-orquestra', '--json'],
      120_000,
    )
  })
})

describe('agentDisplayName (node-unique identity)', () => {
  it('uses REPPO_AGENT_NAME when set (trimmed)', () => {
    expect(agentDisplayName('  My node  ', '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')).toBe('My node')
  })
  it('defaults to orquestra-<8 hex of wallet> so nodes are distinguishable', () => {
    expect(agentDisplayName(undefined, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')).toBe('orquestra-f39fd6e5')
  })
  it('lowercases the wallet slice deterministically', () => {
    expect(agentDisplayName('', '0xF39FD6E51AAD88F6F4CE6AB8827279CFFFB92266')).toBe('orquestra-f39fd6e5')
  })
  it('falls back to bare orquestra when no name and no wallet', () => {
    expect(agentDisplayName(undefined, undefined)).toBe('orquestra')
  })
})

describe('parseAgentRegistration', () => {
  it('extracts agentId + apiKey from register-agent --json', () => {
    expect(parseAgentRegistration({ agentId: 'ag_1', apiKey: 'sk_1' })).toEqual({ agentId: 'ag_1', apiKey: 'sk_1' })
  })
  it('accepts id / api_key aliases', () => {
    expect(parseAgentRegistration({ id: 'ag_2', api_key: 'sk_2' })).toEqual({ agentId: 'ag_2', apiKey: 'sk_2' })
  })
  it('returns empty strings on garbage', () => {
    expect(parseAgentRegistration(null)).toEqual({ agentId: '', apiKey: '' })
    expect(parseAgentRegistration({})).toEqual({ agentId: '', apiKey: '' })
  })
})

describe('parseRegisterAgentOutput (CLI emits TEXT even with --json)', () => {
  it('parses the human-readable text output the reppo CLI actually prints', () => {
    const stdout = `✓ Registered new agent "orquestra"\n\n  id:     cmq4cug3d0000l404g40nyjn0\n  apiKey: agent_cqj3ljok99m_wy3p83yr31d\n\n⚠ SAVE THESE CREDENTIALS NOW.\n  - The apiKey is the agent's persistent Bearer token — do not lose it.\n`
    expect(parseRegisterAgentOutput(stdout)).toEqual({ agentId: 'cmq4cug3d0000l404g40nyjn0', apiKey: 'agent_cqj3ljok99m_wy3p83yr31d' })
  })
  it('still parses genuine JSON output if a future CLI honors --json', () => {
    expect(parseRegisterAgentOutput('{"agentId":"ag_9","apiKey":"sk_9"}')).toEqual({ agentId: 'ag_9', apiKey: 'sk_9' })
  })
  it('throws when neither JSON nor an id line is present', () => {
    expect(() => parseRegisterAgentOutput('some unexpected error text')).toThrow()
  })
})

describe('agent store', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-agent-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('round-trips creds to disk', () => {
    writeAgentStore(dir, { agentId: 'ag_1', apiKey: 'sk_1' })
    expect(readAgentStore(dir)).toEqual({ agentId: 'ag_1', apiKey: 'sk_1' })
  })
  it('round-trips the synced display name when present', () => {
    writeAgentStore(dir, { agentId: 'ag_1', apiKey: 'sk_1', name: 'my-node' })
    expect(readAgentStore(dir)).toEqual({ agentId: 'ag_1', apiKey: 'sk_1', name: 'my-node' })
  })
  it('returns null when absent', () => {
    expect(readAgentStore(dir)).toBeNull()
  })
  it('returns null when stored creds have no agentId', () => {
    writeAgentStore(dir, { agentId: '', apiKey: 'sk' })
    expect(readAgentStore(dir)).toBeNull()
  })
})

describe('ensureAgentId (idempotent registration)', () => {
  const deps = (over: Partial<EnsureAgentDeps> = {}): EnsureAgentDeps => ({
    envAgentId: undefined,
    readStored: vi.fn(() => null),
    register: vi.fn(async () => ({ agentId: 'ag_new', apiKey: 'sk_new' })),
    writeStored: vi.fn(),
    setEnv: vi.fn(),
    ...over,
  })

  it('registers for EVERY node — vote-only included (the agent is the platform identity; without it registerVoteOnPlatform silently no-ops and the node is uncountable)', async () => {
    const d = deps() // no minting context at all — registration is unconditional
    const r = await ensureAgentId(d)
    expect(r.source).toBe('registered')
    expect(d.register).toHaveBeenCalledOnce()
  })

  it('uses an operator-set env agent id without registering or reading the store', async () => {
    const d = deps({ envAgentId: 'ag_env' })
    const r = await ensureAgentId(d)
    expect(r).toEqual({ source: 'env', agentId: 'ag_env' })
    expect(d.register).not.toHaveBeenCalled()
    expect(d.readStored).not.toHaveBeenCalled()
  })

  it('reuses persisted creds (sets env, does not register)', async () => {
    const stored = { agentId: 'ag_stored', apiKey: 'sk_stored' }
    const d = deps({ readStored: vi.fn(() => stored) })
    const r = await ensureAgentId(d)
    expect(r).toEqual({ source: 'stored', agentId: 'ag_stored' })
    expect(d.setEnv).toHaveBeenCalledWith(stored)
    expect(d.register).not.toHaveBeenCalled()
  })

  it('registers, persists, and sets env on first run', async () => {
    const d = deps()
    const r = await ensureAgentId(d)
    expect(r).toEqual({ source: 'registered', agentId: 'ag_new' })
    expect(d.register).toHaveBeenCalledOnce()
    expect(d.writeStored).toHaveBeenCalledWith({ agentId: 'ag_new', apiKey: 'sk_new' })
    expect(d.setEnv).toHaveBeenCalledWith({ agentId: 'ag_new', apiKey: 'sk_new' })
  })

  it('throws if registration returns no agentId (do not persist a useless cred)', async () => {
    const d = deps({ register: vi.fn(async () => ({ agentId: '', apiKey: '' })) })
    await expect(ensureAgentId(d)).rejects.toThrow(/no agentId/)
    expect(d.writeStored).not.toHaveBeenCalled()
  })
})

describe('syncAgentName (operator-changeable display name)', () => {
  const deps = (over: Partial<SyncAgentNameDeps> = {}): SyncAgentNameDeps => ({
    desiredName: 'new-name',
    readStored: vi.fn(() => ({ agentId: 'ag_1', apiKey: 'sk_1', name: 'old-name' })),
    update: vi.fn(async () => {}),
    writeStored: vi.fn(),
    ...over,
  })

  it('PATCHes and persists when the desired name differs', async () => {
    const d = deps()
    expect(await syncAgentName(d)).toBe('updated')
    expect(d.update).toHaveBeenCalledWith('ag_1', 'new-name', 'sk_1')
    expect(d.writeStored).toHaveBeenCalledWith({ agentId: 'ag_1', apiKey: 'sk_1', name: 'new-name' })
  })

  it('no-ops when the stored name already matches (idempotent restarts)', async () => {
    const d = deps({ desiredName: 'old-name' })
    expect(await syncAgentName(d)).toBe('unchanged')
    expect(d.update).not.toHaveBeenCalled()
    expect(d.writeStored).not.toHaveBeenCalled()
  })

  it('treats a pre-migration row (no stored name) as different → syncs once', async () => {
    const d = deps({ readStored: vi.fn(() => ({ agentId: 'ag_1', apiKey: 'sk_1' })) })
    expect(await syncAgentName(d)).toBe('updated')
    expect(d.update).toHaveBeenCalledOnce()
  })

  it('skips when no creds are stored (nothing to authenticate with)', async () => {
    const d = deps({ readStored: vi.fn(() => null) })
    expect(await syncAgentName(d)).toBe('no-creds')
    expect(d.update).not.toHaveBeenCalled()
  })

  it('skips when the stored row has no apiKey (cannot authenticate the PATCH)', async () => {
    const d = deps({ readStored: vi.fn(() => ({ agentId: 'ag_1', apiKey: '' })) })
    expect(await syncAgentName(d)).toBe('no-apikey')
    expect(d.update).not.toHaveBeenCalled()
  })

  it('does NOT persist the new name when the PATCH fails (retry next start)', async () => {
    const d = deps({ update: vi.fn(async () => { throw new Error('platform updateAgent 500') }) })
    await expect(syncAgentName(d)).rejects.toThrow(/500/)
    expect(d.writeStored).not.toHaveBeenCalled()
  })
})

describe('markAgentAsOrquestra (platform isOrquestra attribution)', () => {
  const deps = (over: Partial<MarkOrquestraDeps> = {}): MarkOrquestraDeps => ({
    readStored: vi.fn(() => ({ agentId: 'ag_1', apiKey: 'sk_1', name: 'n' })),
    patch: vi.fn(async () => {}),
    ...over,
  })

  it('PATCHes the stored agent with its api key every start', async () => {
    const d = deps()
    expect(await markAgentAsOrquestra(d)).toBe('marked')
    expect(d.patch).toHaveBeenCalledWith('ag_1', 'sk_1')
  })

  it('no-creds when nothing is stored (env-only id) — never PATCHes blind', async () => {
    const d = deps({ readStored: vi.fn(() => null) })
    expect(await markAgentAsOrquestra(d)).toBe('no-creds')
    expect(d.patch).not.toHaveBeenCalled()
  })

  it('no-apikey on a legacy row — cannot authenticate the PATCH', async () => {
    const d = deps({ readStored: vi.fn(() => ({ agentId: 'ag_1', apiKey: '' })) })
    expect(await markAgentAsOrquestra(d)).toBe('no-apikey')
    expect(d.patch).not.toHaveBeenCalled()
  })

  it('propagates a platform failure (caller logs it as non-fatal)', async () => {
    const d = deps({ patch: vi.fn(async () => { throw new Error('platform updateAgent 500') }) })
    await expect(markAgentAsOrquestra(d)).rejects.toThrow(/500/)
  })
})
