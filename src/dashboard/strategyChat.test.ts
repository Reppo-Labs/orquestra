import { describe, it, expect } from 'vitest'
import { runStrategyChat, buildStrategyChatPrompt } from './strategyChat.js'
import { StrategyConfigSchema } from '../config/schema.js'

const current = StrategyConfigSchema.parse({
  horizonDays: 7, cadenceHours: 1,
  stake: { lockReppo: 0, lockDurationDays: 7 },
  budget: { voteGasEthMax: 0.02, voteRateMaxPerCycle: 13, mintReppoMax: 50, mintGasEthMax: 0.01 },
  datanets: { '2': { vote: true, mint: true, strictness: 'balanced', adapter: 'gdelt' } },
})

describe('runStrategyChat', () => {
  it('returns the reply and a VALIDATED proposedConfig; never writes anything', async () => {
    const proposed = { ...current, notes: 'add sports', datanets: { ...current.datanets, '11': { vote: true, mint: true, strictness: 'balanced', adapter: 'sports' } } }
    const out = await runStrategyChat({
      messages: [{ role: 'user', content: 'activate sports datanet 11' }],
      currentConfig: current,
      generate: async () => ({ reply: 'Added datanet 11 with the sports adapter.', proposedConfig: proposed }),
    })
    expect(out.reply).toContain('Added datanet 11')
    expect(out.proposedConfig?.datanets['11']).toMatchObject({ vote: true, mint: true, adapter: 'sports' })
  })

  // The assistant is only ASKED to preserve fields; an LLM that drops `paused` would have it
  // parsed back to the schema default (false). The proposal the operator reviews and saves must
  // never carry a resume decision the operator did not make — the pause is /api/pause's alone.
  it('a proposal that DROPPED paused cannot propose un-pausing a paused node', async () => {
    const paused = StrategyConfigSchema.parse({ ...current, paused: true })
    const { paused: _dropped, ...withoutPaused } = { ...paused, notes: 'turn off datanet 2' }
    const out = await runStrategyChat({
      messages: [{ role: 'user', content: 'turn off datanet 2, it is losing money' }],
      currentConfig: paused,
      generate: async () => ({ reply: 'Disabled datanet 2.', proposedConfig: withoutPaused }),
    })
    expect(out.proposedConfig?.paused).toBe(true)
    expect(out.proposedConfig?.notes).toBe('turn off datanet 2') // the real change still lands
  })

  it('a proposal cannot pause a running node either — the assistant never touches the kill switch', async () => {
    const out = await runStrategyChat({
      messages: [{ role: 'user', content: 'stop everything' }],
      currentConfig: current, // paused: false
      generate: async () => ({ reply: 'Paused.', proposedConfig: { ...current, paused: true } }),
    })
    expect(out.proposedConfig?.paused).toBe(false)
  })

  // The assistant is only ASKED to preserve fields; an LLM that drops `paused` would have it
  // parsed back to the schema default (false). The proposal the operator reviews and saves must
  // never carry a resume decision the operator did not make — the pause is /api/pause's alone.
  it('a proposal that DROPPED paused cannot propose un-pausing a paused node', async () => {
    const paused = StrategyConfigSchema.parse({ ...current, paused: true })
    const { paused: _dropped, ...withoutPaused } = { ...paused, notes: 'turn off datanet 2' }
    const out = await runStrategyChat({
      messages: [{ role: 'user', content: 'turn off datanet 2, it is losing money' }],
      currentConfig: paused,
      generate: async () => ({ reply: 'Disabled datanet 2.', proposedConfig: withoutPaused }),
    })
    expect(out.proposedConfig?.paused).toBe(true)
    expect(out.proposedConfig?.notes).toBe('turn off datanet 2') // the real change still lands
  })

  it('a proposal cannot pause a running node either — the assistant never touches the kill switch', async () => {
    const out = await runStrategyChat({
      messages: [{ role: 'user', content: 'stop everything' }],
      currentConfig: current, // paused: false
      generate: async () => ({ reply: 'Paused.', proposedConfig: { ...current, paused: true } }),
    })
    expect(out.proposedConfig?.paused).toBe(false)
  })

  it('drops an INVALID proposedConfig but keeps the reply (no partial garbage to the grid)', async () => {
    const out = await runStrategyChat({
      messages: [{ role: 'user', content: 'do something weird' }],
      currentConfig: current,
      generate: async () => ({ reply: 'Here is a broken idea.', proposedConfig: { horizonDays: -5 } }),
    })
    expect(out.reply).toContain('broken idea')
    expect(out.proposedConfig).toBeUndefined()
    expect(out.warning).toMatch(/invalid/i)
  })

  it('tolerates a reply with no proposal (pure conversation)', async () => {
    const out = await runStrategyChat({
      messages: [{ role: 'user', content: 'what am I running?' }],
      currentConfig: current,
      generate: async () => ({ reply: 'You vote on datanet 2 and mint via gdelt.' }),
    })
    expect(out.proposedConfig).toBeUndefined()
    expect(out.warning).toBeUndefined()
  })

  it('LLM failure → friendly error reply, no proposal, no throw', async () => {
    const out = await runStrategyChat({
      messages: [{ role: 'user', content: 'x' }],
      currentConfig: current,
      generate: async () => { throw new Error('llm down') },
    })
    expect(out.reply).toMatch(/could not reach|failed/i)
    expect(out.proposedConfig).toBeUndefined()
  })
})

describe('buildStrategyChatPrompt', () => {
  it('includes the current config, the safety rules, and the conversation', () => {
    const { system, prompt } = buildStrategyChatPrompt(
      [{ role: 'user', content: 'be more aggressive on geopolitics' }], current,
    )
    expect(system).toMatch(/never.*write|propose/i)        // propose-only contract
    expect(system).toContain('budget')                     // budget-awareness rule
    expect(prompt).toContain('"2"')                        // current config embedded
    expect(prompt).toContain('be more aggressive on geopolitics')
  })
})
