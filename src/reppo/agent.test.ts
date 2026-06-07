// src/reppo/agent.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseAgentRegistration, parseRegisterAgentOutput, readAgentStore, writeAgentStore, ensureAgentId, type EnsureAgentDeps } from './agent.js'

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
    mintingEnabled: true,
    envAgentId: undefined,
    readStored: vi.fn(() => null),
    register: vi.fn(async () => ({ agentId: 'ag_new', apiKey: 'sk_new' })),
    writeStored: vi.fn(),
    setEnv: vi.fn(),
    ...over,
  })

  it('skips entirely when minting is disabled (voting-only node needs no agent)', async () => {
    const d = deps({ mintingEnabled: false })
    const r = await ensureAgentId(d)
    expect(r.source).toBe('skipped')
    expect(d.register).not.toHaveBeenCalled()
    expect(d.readStored).not.toHaveBeenCalled()
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
