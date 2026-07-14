// Handler-level tests: every endpoint is a pure(ish) function (ctx, request) →
// { status, body }, exercised here without starting an HTTP server. Transport
// concerns (body parsing, cross-site guards, static SPA) are covered in server.test.ts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { matchRoute, routes, type RouteContext, type OnboardingSession } from './routes.js'
import { appendActivity } from './activityLog.js'
import { writeEarnStatus } from './earnStatus.js'
import { writeConfig, readConfigText } from '../config/load.js'
import { getDb } from './db.js'
import { insertProposal, readProposals } from '../learn/store.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orq-routes-'))
  writeConfig(dir, {
    horizonDays: 30, cadenceHours: 1, claimEmissions: true,
    stake: { lockReppo: 0, lockDurationDays: 30 },
    budget: { voteRateMaxPerCycle: 30, mintReppoMax: 500, claimGasEthMax: 0.05 },
    datanets: { '9': { vote: true, mint: false, strictness: 'balanced' } }, notes: '',
  } as never)
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const session = (): OnboardingSession => ({ messages: [], draft: null, finalized: null })
const ctx = (opts: RouteContext['opts'] = {}): RouteContext => ({ dataDir: dir, opts, session: session() })

/** Invoke the handler registered for method+path directly (no server). */
const call = async (method: 'GET' | 'POST', url: string, over: { body?: unknown; ctx?: RouteContext } = {}) => {
  const m = matchRoute(routes, method, url)
  if (!m) throw new Error(`no route for ${method} ${url}`)
  return m.route.handler(over.ctx ?? ctx(), { url, method, body: over.body, param: m.param })
}

describe('matchRoute', () => {
  it('matches an exact GET route', () => {
    const m = matchRoute(routes, 'GET', '/api/config')
    expect(m?.route.path).toBe('/api/config')
    expect(m?.param).toBeUndefined()
  })

  it('matches an exact POST route', () => {
    expect(matchRoute(routes, 'POST', '/api/strategy')?.route.path).toBe('/api/strategy')
  })

  it('matches a prefix route and extracts the trailing param', () => {
    const m = matchRoute(routes, 'POST', '/api/learn/proposals/7')
    expect(m?.route.path).toBe('/api/learn/proposals/')
    expect(m?.param).toBe('7')
  })

  it('does not cross methods (POST to a read route → no match)', () => {
    expect(matchRoute(routes, 'POST', '/api/health')).toBeNull()
    expect(matchRoute(routes, 'GET', '/api/strategy')).toBeNull()
  })

  it('unknown path → null', () => {
    expect(matchRoute(routes, 'GET', '/api/nope')).toBeNull()
    expect(matchRoute(routes, 'POST', '/api/nope')).toBeNull()
  })
})

describe('read handlers', () => {
  it('/api/config returns the whitelisted strategy config', async () => {
    const r = await call('GET', '/api/config')
    expect(r.status).toBe(200)
    expect(r.body).toHaveProperty('cadenceHours', 1)
    expect(r.body).toHaveProperty('budget')
  })

  it('/api/activity returns recorded entries newest-first', async () => {
    appendActivity(dir, { ts: 't', cycleId: 'c1', kind: 'vote', datanetId: '9', podId: '1', direction: 'up', conviction: 9, reason: 'r', status: 'executed', txHash: '0x1' })
    const r = await call('GET', '/api/activity')
    expect(r.status).toBe(200)
    expect((r.body as { podId: string }[])[0].podId).toBe('1')
  })

  it('/api/pnl returns { pnl, snapshot } (both null-tolerant)', async () => {
    const r = await call('GET', '/api/pnl')
    expect(r.status).toBe(200)
    expect(r.body).toHaveProperty('pnl')
    expect(r.body).toHaveProperty('snapshot')
  })

  it('/api/earn returns the persisted earn status', async () => {
    writeEarnStatus(dir, { ts: 't', mintedPods: 1, claimedReppo: 0, claimedTokens: [], claimableReppo: 5, totalUpVotes: 2, totalDownVotes: 0, pods: [], earning: true })
    const r = await call('GET', '/api/earn')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ mintedPods: 1, claimableReppo: 5, earning: true })
  })

  it('/api/health aggregates recent activity per datanet', async () => {
    appendActivity(dir, { ts: new Date().toISOString(), cycleId: 'c1', kind: 'vote', datanetId: '9', podId: '1', direction: 'up', conviction: 9, reason: 'r', status: 'executed', txHash: '0x1' })
    const r = await call('GET', '/api/health')
    expect(r.status).toBe(200)
    const d9 = (r.body as { datanets: { datanetId: string; votes: { executed: number } }[] }).datanets.find((d) => d.datanetId === '9')
    expect(d9?.votes.executed).toBe(1)
  })

  it('/api/learn returns the learn view for configured datanets', async () => {
    const r = await call('GET', '/api/learn')
    expect(r.status).toBe(200)
    expect((r.body as { datanets: Record<string, unknown> }).datanets).toHaveProperty('9')
  })

  it('/api/models lists availableProviders (names only)', async () => {
    const r = await call('GET', '/api/models', { ctx: ctx({ availableProviders: ['google'] }) })
    expect(r.status).toBe(200)
    const provs = (r.body as { providers: { provider: string; hasKey: boolean }[] }).providers
    expect(provs).toHaveLength(1)
    expect(provs[0]).toMatchObject({ provider: 'google', hasKey: true })
  })

  it('/api/agent returns null when no agent store exists', async () => {
    const r = await call('GET', '/api/agent')
    expect(r.status).toBe(200)
    expect(r.body).toBeNull()
  })

  it('/api/onboarding/status reports needed=false when config exists', async () => {
    const r = await call('GET', '/api/onboarding/status')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ needed: false, chatAvailable: false })
  })

  it('/api/datanets serves an id→name object ({} without a CLI)', async () => {
    const r = await call('GET', '/api/datanets')
    expect(r.status).toBe(200)
    expect(typeof r.body).toBe('object')
  })
})

describe('GET /api/datanet-pnl (per-datanet profit)', () => {
  it('returns spend, earnings, net, roi and action counts per datanet', async () => {
    appendActivity(dir, { ts: 't', cycleId: 'c1', kind: 'vote', datanetId: '9', podId: '1', direction: 'up', conviction: 9, reason: 'r', status: 'executed', txHash: '0x1' })
    appendActivity(dir, { ts: 't', cycleId: 'c1', kind: 'mint', datanetId: '2', reppoSpent: 200, status: 'executed', txHash: '0xm' })
    appendActivity(dir, { ts: 't', cycleId: 'c1', kind: 'claim', datanetId: '2', reppoClaimed: 410, podId: 'p1', epoch: 3, status: 'executed', txHash: '0xc' })
    const r = await call('GET', '/api/datanet-pnl')
    expect(r.status).toBe(200)
    const { datanets } = r.body as { datanets: { datanetId: string }[] }
    const d2 = datanets.find((d) => d.datanetId === '2')
    expect(d2).toMatchObject({ reppoSpent: 200, reppoEarned: 410, net: 210, roi: 205, mintsExecuted: 1 })
    // the vote-only datanet: no spend ⇒ roi is null, never a fake 0%
    const d9 = datanets.find((d) => d.datanetId === '9')
    expect(d9).toMatchObject({ roi: null, votesCast: 1, reppoSpent: 0 })
  })

  it('holds no secrets', async () => {
    const r = await call('GET', '/api/datanet-pnl')
    expect(JSON.stringify(r.body)).not.toMatch(/PRIVATE_KEY|sk-ant-|inf_|--rpc-url/)
  })
})

describe('GET /api/health classification (raw stderr → operator English)', () => {
  it('attaches { code, operatorMessage, suggestedAction } to a failing datanet', async () => {
    appendActivity(dir, {
      ts: new Date().toISOString(), cycleId: 'c2', kind: 'skip', datanetId: '6',
      // VERBATIM from the live node (see errorClass.test.ts). Not a tidied-up stand-in: the
      // classifier keys on the eth_call in the request body, and a hand-shortened
      // "… — INTERNAL_ERROR" would prove nothing about the string an operator actually gets.
      reason: 'datanet error: Command failed: reppo query datanet 6 --json --rpc-url <redacted> — {"error":{"code":"INTERNAL_ERROR","message":"HTTP request failed.\\n\\nURL: https://base-mainnet.g.alchemy.com/v2/<redacted>\\nRequest body: {\\"method\\":\\"eth_call\\",\\"params\\":[{\\"to\\":\\"0x2629A8083065938B533b117704935D727270eE7A\\"},\\"latest\\"]}\\nDetails: fetch failed"}}',
      status: 'skipped',
    })
    const r = await call('GET', '/api/health')
    const body = r.body as { datanets: { datanetId: string; lastSkipReason?: string; classification?: { code: string; operatorMessage: string; suggestedAction: string } }[] }
    const d6 = body.datanets.find((d) => d.datanetId === '6')!
    expect(d6.classification).toMatchObject({ code: 'rpc_unavailable', suggestedAction: 'check_rpc' })
    expect(d6.classification!.operatorMessage).toContain('Datanet 6')
    expect(d6.classification!.operatorMessage).not.toContain('Command failed')
    // the raw reason is still there for anyone who wants it — we ADD, never replace
    expect(d6.lastSkipReason).toContain('Command failed')
  })

  it('leaves a healthy datanet unclassified', async () => {
    appendActivity(dir, { ts: new Date().toISOString(), cycleId: 'c1', kind: 'vote', datanetId: '9', podId: '1', direction: 'up', conviction: 9, reason: 'r', status: 'executed', txHash: '0x1' })
    const r = await call('GET', '/api/health')
    const body = r.body as { datanets: { datanetId: string; votes: { executed: number }; classification?: unknown }[] }
    const d9 = body.datanets.find((d) => d.datanetId === '9')!
    expect(d9.classification).toBeUndefined()
    expect(d9.votes.executed).toBe(1) // buildHealth's own fields still intact
  })
})

describe('write handlers', () => {
  it('/api/strategy 400 on an invalid candidate, file untouched', async () => {
    const before = readConfigText(dir)
    const r = await call('POST', '/api/strategy', { body: { horizonDays: -1 } })
    expect(r.status).toBe(400)
    expect(readConfigText(dir)).toBe(before)
  })

  it('/api/strategy persists a valid candidate', async () => {
    const r = await call('POST', '/api/strategy', {
      body: {
        horizonDays: 7, cadenceHours: 1,
        stake: { lockReppo: 0, lockDurationDays: 7 },
        budget: { voteRateMaxPerCycle: 13, mintReppoMax: 50 },
        datanets: { '2': { vote: true, mint: false, strictness: 'balanced' } },
        notes: 'routes test',
      },
    })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ saved: true, appliesNextCycle: true })
    expect(JSON.parse(readConfigText(dir)!).notes).toBe('routes test')
  })

  it('/api/run-now 503 without a trigger, 200/409 by trigger outcome', async () => {
    expect((await call('POST', '/api/run-now', { body: {} })).status).toBe(503)
    const started = await call('POST', '/api/run-now', { body: {}, ctx: ctx({ triggerCycle: () => ({ started: true }) }) })
    expect(started.status).toBe(200)
    const busy = await call('POST', '/api/run-now', { body: {}, ctx: ctx({ triggerCycle: () => ({ started: false, reason: 'already running' }) }) })
    expect(busy.status).toBe(409)
    expect(busy.body).toMatchObject({ started: false, reason: 'already running' })
  })

  it('/api/learn/disable validates and flips the flag', async () => {
    expect((await call('POST', '/api/learn/disable', { body: {} })).status).toBe(400)
    const r = await call('POST', '/api/learn/disable', { body: { datanetId: '9', enabled: false } })
    expect(r.status).toBe(200)
    const view = await call('GET', '/api/learn')
    expect((view.body as { datanets: Record<string, { enabled: boolean }> }).datanets['9'].enabled).toBe(false)
  })

  it('/api/learn/veto requires datanetId', async () => {
    expect((await call('POST', '/api/learn/veto', { body: {} })).status).toBe(400)
    expect((await call('POST', '/api/learn/veto', { body: { datanetId: '9' } })).status).toBe(200)
  })

  it('/api/learn/proposals/:id validates id and decision', async () => {
    expect((await call('POST', '/api/learn/proposals/abc', { body: { decision: 'accept' } })).status).toBe(400)
    expect((await call('POST', '/api/learn/proposals/1', { body: { decision: 'maybe' } })).status).toBe(400)
    expect((await call('POST', '/api/learn/proposals/999', { body: { decision: 'accept' } })).status).toBe(409)
  })

  it('/api/learn/proposals/:id accept applies via the validated writer', async () => {
    const id = insertProposal(dir, {
      datanetId: '9', field: 'strictness', fromValue: 'balanced', toValue: 'conservative',
      rationale: 'r', basisConfigMtime: 't', createdEpoch: 1, createdTs: 't',
    })
    const r = await call('POST', `/api/learn/proposals/${id}`, { body: { decision: 'accept' } })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, status: 'accepted' })
    expect(JSON.parse(readConfigText(dir)!).datanets['9'].strictness).toBe('conservative')
    expect(readProposals(dir, { status: 'pending' })).toHaveLength(0)
  })

  it('/api/agent/name validates the name and 409s with no registered agent', async () => {
    expect((await call('POST', '/api/agent/name', { body: { name: '' } })).status).toBe(400)
    expect((await call('POST', '/api/agent/name', { body: { name: 'x'.repeat(65) } })).status).toBe(400)
    const r = await call('POST', '/api/agent/name', { body: { name: 'nodey' } })
    expect(r.status).toBe(409)
  })

  it('/api/strategy/chat 503 without a model, 400 without messages, 409 without config', async () => {
    expect((await call('POST', '/api/strategy/chat', { body: { messages: [{ role: 'user', content: 'hi' }] } })).status).toBe(503)
    const withModel = ctx({ resolveChatModel: () => ({}) as never })
    expect((await call('POST', '/api/strategy/chat', { body: {}, ctx: withModel })).status).toBe(400)
    // fresh dataDir with no config row → clean 409, before any LLM call
    const bare = mkdtempSync(join(tmpdir(), 'orq-routes-noconf-'))
    try {
      const r = await call('POST', '/api/strategy/chat', {
        body: { messages: [{ role: 'user', content: 'hi' }] },
        ctx: { ...withModel, dataDir: bare },
      })
      expect(r.status).toBe(409)
      expect((r.body as { error: string }).error).toMatch(/onboarding/)
    } finally { rmSync(bare, { recursive: true, force: true }) }
  })

  it('/api/onboarding/chat 503 without a model or injected turn', async () => {
    expect((await call('POST', '/api/onboarding/chat', { body: {} })).status).toBe(503)
  })

  it('/api/onboarding/chat runs the injected turn against the session and resets', async () => {
    const fakeTurn = async (messages: { role: string }[]) => ({
      text: `${messages.filter((m) => m.role === 'user').length} user`,
      responseMessages: [{ role: 'assistant' as const, content: 'ok' }],
      finalized: null, draft: { cadenceHours: 6 },
    })
    const c = ctx({ onboardingTurn: fakeTurn as never })
    const first = await call('POST', '/api/onboarding/chat', { body: {}, ctx: c })
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ reply: '1 user', draft: { cadenceHours: 6 } })
    const second = await call('POST', '/api/onboarding/chat', { body: { message: 'hey' }, ctx: c })
    expect(second.body).toMatchObject({ reply: '2 user' })
    const reset = await call('POST', '/api/onboarding/chat', { body: { reset: true }, ctx: c })
    expect(reset.body).toMatchObject({ reset: true })
    expect(c.session.messages).toHaveLength(0)
  })

  it('/api/onboarding/confirm validates answers then persists the built config', async () => {
    expect((await call('POST', '/api/onboarding/confirm', { body: { horizonDays: -1 } })).status).toBe(400)
    const r = await call('POST', '/api/onboarding/confirm', {
      body: {
        datanets: [{ id: '9', vote: true, mint: false, strictness: 'balanced' }],
        lockReppo: 0, lockDurationDays: 30, voteRateMaxPerCycle: 25,
        mintReppoMax: 100, horizonDays: 30, cadenceHours: 6, notes: 'routes onboarding',
      },
    })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ saved: true })
    expect(JSON.parse(readConfigText(dir)!).cadenceHours).toBe(6)
  })

  it('/api/onboarding/confirm never un-pauses a paused node (kill switch survives re-onboarding)', async () => {
    // Only POST /api/pause moves the flag: buildStrategyConfig fills the schema
    // default (paused:false), so a raw persist would silently resume a node the
    // operator deliberately stopped. strategySave already carries the persisted
    // value forward; the onboarding write path must do the same.
    await call('POST', '/api/pause', { body: { paused: true } })
    const r = await call('POST', '/api/onboarding/confirm', {
      body: {
        datanets: [{ id: '9', vote: true, mint: false, strictness: 'balanced' }],
        lockReppo: 0, lockDurationDays: 30, voteRateMaxPerCycle: 25,
        mintReppoMax: 100, horizonDays: 30, cadenceHours: 6, notes: 'still paused',
      },
    })
    expect(r.status).toBe(200)
    expect(JSON.parse(readConfigText(dir)!).paused).toBe(true)
  })
})

describe('POST /api/pause (emergency kill switch)', () => {
  it('pausing still works when the on-disk config is schema-INVALID — the kill switch must not 409 exactly when last-good keeps signing', async () => {
    // A schema-invalid (but parseable) config makes the tick keep its last-good,
    // unpaused config — the node keeps signing. Pausing must not depend on full
    // config validity; un-pausing (resuming) still requires a valid config.
    getDb(dir).prepare(
      'INSERT INTO config (id, data, updatedTs) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updatedTs = excluded.updatedTs',
    ).run(JSON.stringify({ horizonDays: -1, paused: false }), new Date().toISOString())
    const r = await call('POST', '/api/pause', { body: { paused: true } })
    expect(r.status).toBe(200)
    expect(JSON.parse(readConfigText(dir)!).paused).toBe(true)
    expect((await call('POST', '/api/pause', { body: { paused: false } })).status).toBe(409)
  })

  const VALID_STRATEGY = {
    horizonDays: 7, cadenceHours: 1,
    stake: { lockReppo: 0, lockDurationDays: 7 },
    budget: { voteRateMaxPerCycle: 13, mintReppoMax: 50, mintGasEthMax: 0.01 },
    datanets: { '2': { vote: true, mint: false, strictness: 'balanced' } },
    notes: 'from routes test',
  }

  it('pauses the node, persists, and surfaces on /api/config', async () => {
    const r = await call('POST', '/api/pause', { body: { paused: true } })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ paused: true, appliesNextCycle: true })
    // persisted → the next cycle's hot-reload picks it up
    expect(JSON.parse(readConfigText(dir)!).paused).toBe(true)
    // and exposed on /api/config, so the dashboard can SHOW the kill-switch state
    const cfg = await call('GET', '/api/config')
    expect((cfg.body as { paused?: boolean }).paused).toBe(true)
  })

  it('unpauses cleanly', async () => {
    await call('POST', '/api/pause', { body: { paused: true } })
    const r = await call('POST', '/api/pause', { body: { paused: false } })
    expect(r.status).toBe(200)
    expect(JSON.parse(readConfigText(dir)!).paused).toBe(false)
  })

  it('never RAISES a budget cap (it re-serializes through the same schema every save uses)', async () => {
    const before = JSON.parse(readConfigText(dir)!)
    await call('POST', '/api/pause', { body: { paused: true } })
    const after = JSON.parse(readConfigText(dir)!)
    // Every cap the operator had set survives. The pause write goes through
    // StrategyConfigSchema, so caps the file omitted are now written out at their schema
    // DEFAULT — the same value loadConfig already applied on every read, so no effective
    // cap changes. toMatchObject (not toEqual) asserts exactly that: nothing was altered,
    // only defaults made explicit.
    expect(after.budget).toMatchObject(before.budget)
    expect(after.budget.mintReppoMax).toBe(before.budget.mintReppoMax)
    expect(after.budget.voteRateMaxPerCycle).toBe(before.budget.voteRateMaxPerCycle)
    expect(after.datanets).toMatchObject(before.datanets)
    expect(after.stake).toEqual(before.stake)
  })

  it('rejects a non-boolean body with 400, config untouched', async () => {
    const before = readConfigText(dir)
    const r = await call('POST', '/api/pause', { body: { paused: 'yes' } })
    expect(r.status).toBe(400)
    expect(readConfigText(dir)).toBe(before)
  })

  it('409s when there is no strategy config yet (nothing to pause until onboarding finishes)', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'orq-routes-pause-'))
    try {
      const r = await call('POST', '/api/pause', { body: { paused: true }, ctx: { ...ctx(), dataDir: bare } })
      expect(r.status).toBe(409)
      expect((r.body as { error: string }).error).toMatch(/onboarding/)
    } finally { rmSync(bare, { recursive: true, force: true }) }
  })

  // `paused` is the operator's kill switch, not a normal config field. POST /api/pause is the
  // ONLY route allowed to change it: a strategy save (hand-edited, an assistant proposal that
  // dropped the key, or a stale tab whose candidate still says paused:false) must never resume
  // a node the operator stopped. The schema defaults paused to false, so an omitted key would
  // otherwise silently un-pause.
  it('a strategy save that OMITS paused cannot un-pause the node', async () => {
    await call('POST', '/api/pause', { body: { paused: true } })
    const r = await call('POST', '/api/strategy', { body: VALID_STRATEGY }) // no `paused` key at all
    expect(r.status).toBe(200)
    expect((r.body as { paused?: boolean }).paused).toBe(true) // the response tells the client the truth
    expect(JSON.parse(readConfigText(dir)!).paused).toBe(true)
    // the rest of the save still applied
    expect(JSON.parse(readConfigText(dir)!).notes).toBe('from routes test')
  })

  it('a strategy save that explicitly sends paused:false cannot un-pause the node either', async () => {
    await call('POST', '/api/pause', { body: { paused: true } })
    const r = await call('POST', '/api/strategy', { body: { ...VALID_STRATEGY, paused: false } })
    expect(r.status).toBe(200)
    expect(JSON.parse(readConfigText(dir)!).paused).toBe(true)
  })

  it('a strategy save does not PAUSE a running node either — /api/pause owns the flag both ways', async () => {
    const r = await call('POST', '/api/strategy', { body: { ...VALID_STRATEGY, paused: true } })
    expect(r.status).toBe(200)
    expect(JSON.parse(readConfigText(dir)!).paused).toBe(false)
  })
})
