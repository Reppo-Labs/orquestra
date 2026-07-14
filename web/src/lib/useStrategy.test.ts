// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useStrategy, type Candidate } from './useStrategy'
import type { StrategyConfig } from '../api'

// /api/strategy is a FULL REPLACE, and the one-click remedies POST it without an explicit
// Save. Everything this hook does is therefore load-bearing on the operator's money: what it
// sends, what it refuses to send, and whether it tells the truth about the outcome.

afterEach(cleanup)

const CONFIG: StrategyConfig = {
  cadenceHours: 1,
  claimEmissions: false, // hand-edited: gas is expensive, so they batch their claims
  paused: false,
  budget: { mintReppoMax: 3000 },
  datanets: {
    '2': { vote: true, mint: true, strictness: 'balanced' },
    '3': { vote: true, mint: false, strictness: 'aggressive' },
  },
}

/** The node's answers: GET /api/config serves `live`; POST /api/strategy records the body. */
function mockNode(live: StrategyConfig, save: { ok: boolean; error?: string; reject?: boolean } = { ok: true }) {
  const posted: unknown[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/config') return { ok: true, json: async () => live } as unknown as Response
    if (url === '/api/strategy') {
      if (save.reject) throw new TypeError('Failed to fetch') // the node is restarting
      posted.push(JSON.parse(String(init?.body)))
      return {
        ok: save.ok,
        status: save.ok ? 200 : 400,
        json: async () => (save.ok ? { ok: true } : { error: save.error ?? 'invalid config' }),
      } as unknown as Response
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { posted, fetchMock }
}

beforeEach(() => vi.restoreAllMocks())

describe('useStrategy — editAndSave reports the truth', () => {
  it('returns ok and persists the change', async () => {
    const { posted } = mockNode(CONFIG)
    const { result } = renderHook(() => useStrategy(CONFIG))
    await waitFor(() => expect(result.current.candidate).not.toBeNull())

    let res: { ok: boolean } | undefined
    await act(async () => { res = await result.current.editAndSave((c) => { c.datanets['2'].mint = false }) })

    expect(res?.ok).toBe(true)
    expect((posted[0] as Candidate).datanets['2'].mint).toBe(false)
  })

  it('does NOT report success when the node REFUSES the save', async () => {
    // The button used to print "Datanet 2: minting off — applies next cycle" over a 400. The
    // node kept minting; the operator kept losing money and believed they had stopped it.
    mockNode(CONFIG, { ok: false, error: 'invalid config' })
    const { result } = renderHook(() => useStrategy(CONFIG))
    await waitFor(() => expect(result.current.candidate).not.toBeNull())

    let res: { ok: boolean; error?: string } | undefined
    await act(async () => { res = await result.current.editAndSave((c) => { c.datanets['2'].mint = false }) })

    expect(res?.ok).toBe(false)
    expect(res?.error).toBe('invalid config')
    expect(result.current.saveMsg).toMatch(/error/i)
  })

  it('RESOLVES (never rejects) when the node is unreachable — the button must come back', async () => {
    // A rejection here strands the caller's setBusy(false): the remedy button locks on
    // "working…" forever with no message, and the config is unchanged.
    mockNode(CONFIG, { ok: true, reject: true })
    const { result } = renderHook(() => useStrategy(CONFIG))
    await waitFor(() => expect(result.current.candidate).not.toBeNull())

    let res: { ok: boolean; error?: string } | undefined
    await act(async () => { res = await result.current.editAndSave((c) => { c.datanets['2'].mint = false }) })

    expect(res?.ok).toBe(false)
    expect(res?.error).toMatch(/could not reach the node/i)
  })
})

describe('useStrategy — a one-click remedy writes ONLY what it says it writes', () => {
  it('posts the LIVE config, not the stale candidate — a concurrent write is not clobbered', async () => {
    // 09:00 page load. 09:20 the operator accepts a learning proposal in Diagnostics; the node
    // writes datanet 3 → conservative. 09:25 they click "turn off minting" on datanet 2.
    const live: StrategyConfig = JSON.parse(JSON.stringify(CONFIG))
    const { posted } = mockNode(live)
    const { result } = renderHook(() => useStrategy(CONFIG))
    await waitFor(() => expect(result.current.candidate).not.toBeNull())

    live.datanets!['3'].strictness = 'conservative' // written by the node, behind this tab

    await act(async () => { await result.current.editAndSave((c) => { c.datanets['2'].mint = false }) })

    const body = posted[0] as Candidate
    expect(body.datanets['2'].mint).toBe(false) // the remedy applied
    expect(body.datanets['3'].strictness).toBe('conservative') // …and did not revert the node's write
  })

  it("does not smuggle the operator's unrelated, unsaved edits into the live config", async () => {
    // They typed "5" into mint REPPO max on the way to "500", got distracted, went Home, and
    // clicked "Stop minting there". That button must not set the node's mint budget to 5.
    const { posted } = mockNode(CONFIG)
    const { result } = renderHook(() => useStrategy(CONFIG))
    await waitFor(() => expect(result.current.candidate).not.toBeNull())

    act(() => { result.current.edit((c) => { c.budget = { ...c.budget, mintReppoMax: 5 } }) })
    await act(async () => { await result.current.editAndSave((c) => { c.datanets['2'].mint = false }) })

    const body = posted[0] as Candidate
    expect(body.budget?.mintReppoMax).toBe(3000) // the half-typed number never left the tab
    expect(body.datanets['2'].mint).toBe(false)
    // …and the operator's edit is not lost either — it is still pending, and still in the diff.
    expect(result.current.candidate?.budget?.mintReppoMax).toBe(5)
    expect(result.current.diff.join(' ')).toMatch(/mintReppoMax/)
  })

  it('round-trips claimEmissions instead of silently resetting it to true', async () => {
    // claimEmissions has .default(true) in the schema, and /api/strategy is a full-replace
    // parse: a save that omits it flips it back on and the node starts spending claim gas.
    const { posted } = mockNode(CONFIG)
    const { result } = renderHook(() => useStrategy(CONFIG))
    await waitFor(() => expect(result.current.candidate).not.toBeNull())

    await act(async () => { await result.current.editAndSave((c) => { c.datanets['2'].mint = false }) })
    expect((posted[0] as Candidate).claimEmissions).toBe(false)

    // …and an explicit Save from the SaveBar keeps it too.
    await act(async () => { await result.current.save() })
    expect((posted[1] as Candidate).claimEmissions).toBe(false)
  })
})

describe('useStrategy — the kill switch is not the assistant’s to touch', () => {
  it('keeps the node paused when a chat proposal omits `paused`', async () => {
    // The server parses the LLM's proposal through the schema, where paused defaults to FALSE.
    // The proposal comes back un-paused, the banner disappears, and Save resumes a node the
    // operator deliberately stopped — without ever asking them.
    const paused: StrategyConfig = { ...CONFIG, paused: true }
    const { posted } = mockNode(paused)
    const { result } = renderHook(() => useStrategy(paused))
    await waitFor(() => expect(result.current.candidate?.paused).toBe(true))

    act(() => {
      result.current.applyProposal({
        cadenceHours: 1,
        budget: { mintReppoMax: 200 },
        datanets: { '2': { vote: true, mint: true, strictness: 'balanced' } },
        paused: false, // what the schema default produced — NOT what the operator asked for
      } as Candidate)
    })

    expect(result.current.candidate?.paused).toBe(true) // the banner stays up
    await act(async () => { await result.current.save() })
    expect((posted[0] as Candidate).paused).toBe(true) // and the node stays stopped
  })
})

describe('useStrategy — the candidate follows the node', () => {
  it('rebases on the poll: a config the node changed elsewhere is adopted, edits survive', async () => {
    mockNode(CONFIG)
    const { result, rerender } = renderHook(({ c }: { c: StrategyConfig }) => useStrategy(c), {
      initialProps: { c: CONFIG },
    })
    await waitFor(() => expect(result.current.candidate).not.toBeNull())

    act(() => { result.current.edit((c) => { c.datanets['2'].mint = false }) }) // unsaved edit

    // The next 30s poll brings a config the node wrote behind the dashboard's back.
    const next: StrategyConfig = JSON.parse(JSON.stringify(CONFIG))
    next.datanets!['3'].strictness = 'conservative'
    next.paused = true
    rerender({ c: next })

    await waitFor(() => expect(result.current.candidate?.datanets['3'].strictness).toBe('conservative'))
    expect(result.current.candidate?.paused).toBe(true) // a pause from another tab is respected
    expect(result.current.candidate?.datanets['2'].mint).toBe(false) // the unsaved edit survives
    expect(result.current.diff).toEqual(['datanets.2.mint true→false']) // …and only that shows as unsaved
  })
})
