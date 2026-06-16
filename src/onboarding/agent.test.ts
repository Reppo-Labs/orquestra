// src/onboarding/agent.test.ts
import { describe, it, expect, vi } from 'vitest'
import { MockLanguageModelV1 } from 'ai/test'
import { runConversationalOnboarding, runOnboardingTurn, seedOnboardingMessages, buildOnboardingTools, summarizeAccessFee, SYSTEM, type OnboardingAgentDeps } from './agent.js'
import type { Prompter } from './types.js'
import type { DatanetRubric } from '../rubric/types.js'

const validAnswers = {
  datanets: [{ id: '9', vote: true, mint: true, strictness: 'conservative' as const, adapter: 'hyperliquid' }],
  lockReppo: 0, lockDurationDays: 30, voteRateMaxPerCycle: 25,
  mintReppoMax: 100, horizonDays: 30, cadenceHours: 6, notes: 'picky',
}
const silentPrompter: Prompter = { ask: async () => 'ok', info: () => {} }

function deps(model: OnboardingAgentDeps['model']): OnboardingAgentDeps {
  return {
    model,
    prompter: silentPrompter,
    listDatanets: vi.fn(async () => [{ id: '9', name: 'TradingGym AI', status: 'ACTIVE', description: 'HL', accessFeeReppo: 50, emissionsPerEpochReppo: 500, upVoteVolume: 1, downVoteVolume: 1 }]),
    getDatanetDetails: vi.fn(async () => ({ datanetId: '9', name: 'TradingGym AI', goal: 'g', publisherSpec: 'p', voterRubric: 'v', subnetUuid: 'cm-test-9', canVote: true, canMint: true, status: 'ACTIVE', economics: { accessFeeReppo: 50, emissionsPerEpochReppo: 500, upVoteVolume: 1, downVoteVolume: 1, nativeTokenSymbol: 'REPPO' } })),
    getBalance: vi.fn(async () => ({ eth: 0.05, reppo: 1234.5, veReppo: 500, usdc: 10 })),
  }
}

describe('runConversationalOnboarding', () => {
  it('returns the answers the model passes to the finalize tool', async () => {
    let call = 0
    const model = new MockLanguageModelV1({
      doGenerate: async () => {
        call++
        if (call === 1) {
          return {
            finishReason: 'tool-calls', usage: { promptTokens: 1, completionTokens: 1 }, rawCall: { rawPrompt: null, rawSettings: {} },
            toolCalls: [{ toolCallType: 'function', toolCallId: 't1', toolName: 'finalize', args: JSON.stringify(validAnswers) }],
          }
        }
        return { finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 }, rawCall: { rawPrompt: null, rawSettings: {} }, text: 'All set.' }
      },
    })
    const answers = await runConversationalOnboarding(deps(model))
    expect(answers.datanets[0].id).toBe('9')
    expect(answers.notes).toBe('picky')
  })
})

describe('runOnboardingTurn (one HTTP-shaped turn, no prompter)', () => {
  it('returns assistant text and a null finalized when the model just replies', async () => {
    const model = new MockLanguageModelV1({
      doGenerate: async () => ({
        finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 }, rawCall: { rawPrompt: null, rawSettings: {} },
        text: 'Welcome! What should your node do?',
      }),
    })
    const r = await runOnboardingTurn(deps(model), seedOnboardingMessages())
    expect(r.text).toMatch(/Welcome/)
    expect(r.finalized).toBeNull()
    expect(r.responseMessages.length).toBeGreaterThan(0)
  })

  it('captures finalized answers when the model calls finalize', async () => {
    let call = 0
    const model = new MockLanguageModelV1({
      doGenerate: async () => {
        call++
        if (call === 1) {
          return {
            finishReason: 'tool-calls', usage: { promptTokens: 1, completionTokens: 1 }, rawCall: { rawPrompt: null, rawSettings: {} },
            toolCalls: [{ toolCallType: 'function', toolCallId: 't1', toolName: 'finalize', args: JSON.stringify(validAnswers) }],
          }
        }
        return { finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 }, rawCall: { rawPrompt: null, rawSettings: {} }, text: 'All set.' }
      },
    })
    const r = await runOnboardingTurn(deps(model), seedOnboardingMessages())
    expect(r.finalized?.notes).toBe('picky')
  })

  it('surfaces update_draft calls as the turn draft', async () => {
    let call = 0
    const model = new MockLanguageModelV1({
      doGenerate: async () => {
        call++
        if (call === 1) {
          return {
            finishReason: 'tool-calls', usage: { promptTokens: 1, completionTokens: 1 }, rawCall: { rawPrompt: null, rawSettings: {} },
            toolCalls: [{ toolCallType: 'function', toolCallId: 'd1', toolName: 'update_draft', args: JSON.stringify({ cadenceHours: 6, mintReppoMax: 100 }) }],
          }
        }
        return { finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 }, rawCall: { rawPrompt: null, rawSettings: {} }, text: 'Noted 6h cadence.' }
      },
    })
    const r = await runOnboardingTurn(deps(model), seedOnboardingMessages())
    expect(r.draft).toMatchObject({ cadenceHours: 6, mintReppoMax: 100 })
    expect(r.finalized).toBeNull()
  })
})

describe('onboarding tools', () => {
  const dummy = null as unknown as OnboardingAgentDeps['model']

  it('finalize captures valid answers and rejects invalid ones without capturing', async () => {
    const captured: unknown[] = []
    const tools = buildOnboardingTools(deps(dummy), (a) => captured.push(a))
    const ok = await tools.finalize.execute(validAnswers, { toolCallId: 'a', messages: [] } as never)
    expect(ok).toMatchObject({ saved: true })
    expect(captured).toHaveLength(1)
    const bad = await tools.finalize.execute({ ...validAnswers, horizonDays: -1 }, { toolCallId: 'b', messages: [] } as never)
    expect(bad).toMatchObject({ saved: false })
    expect((bad as { error?: string }).error).toBeTruthy()
    expect(captured).toHaveLength(1) // invalid finalize did not capture
  })

  it('list_datanets returns the injected catalog', async () => {
    const tools = buildOnboardingTools(deps(dummy), () => {})
    const res = await tools.list_datanets.execute({}, { toolCallId: 'c', messages: [] } as never)
    expect((res as { datanets: { id: string }[] }).datanets[0].id).toBe('9')
  })

  it('get_wallet_balance returns the injected balance', async () => {
    const tools = buildOnboardingTools(deps(dummy), () => {})
    const res = await tools.get_wallet_balance.execute({}, { toolCallId: 'b', messages: [] } as never)
    expect((res as { reppo: number }).reppo).toBe(1234.5)
  })

  it('a failing tool returns an error instead of throwing (never crashes onboarding)', async () => {
    const d: OnboardingAgentDeps = { ...deps(dummy), getBalance: vi.fn(async () => { throw new Error('MISSING_ADDRESS') }) }
    const tools = buildOnboardingTools(d, () => {})
    const res = await tools.get_wallet_balance.execute({}, { toolCallId: 'e', messages: [] } as never)
    expect((res as { error?: string }).error).toMatch(/MISSING_ADDRESS/)
    expect((res as { hint?: string }).hint).toMatch(/REPPO_PRIVATE_KEY/)
  })
})

describe('onboarding strategy elicitation', () => {
  it('the system prompt guides eliciting per-datanet mint strategy (focus/angle)', () => {
    expect(SYSTEM.toLowerCase()).toContain('focus')
    expect(SYSTEM.toLowerCase()).toContain('angle')
    expect(SYSTEM.toLowerCase()).toContain('strategy')
  })

  it('finalize captures adapterParams and they survive validation', async () => {
    const captured: unknown[] = []
    const tools = buildOnboardingTools(deps(null as unknown as OnboardingAgentDeps['model']), (a) => captured.push(a))
    const ans = {
      ...validAnswers,
      datanets: [{ id: '2', vote: true, mint: true, strictness: 'balanced' as const, adapter: 'gdelt',
        adapterParams: { focus: 'Middle East', angle: 'contrarian', topN: 4, minImportance: 7 } }],
    }
    const res = await tools.finalize.execute(ans, { toolCallId: 'a', messages: [] } as never)
    expect(res).toMatchObject({ saved: true })
    expect((captured[0] as { datanets: { adapterParams?: { focus?: string } }[] }).datanets[0].adapterParams?.focus).toBe('Middle East')
  })
})

describe('non-REPPO access fee surfacing in onboarding', () => {
  const baseRubric = (over: Partial<DatanetRubric> = {}): DatanetRubric => ({
    datanetId: '42', name: 'Exylos', goal: 'g', publisherSpec: 'p', voterRubric: 'v',
    subnetUuid: 'cm-42', canVote: true, canMint: false, status: 'ACTIVE',
    economics: { accessFeeReppo: 0, emissionsPerEpochReppo: 0, upVoteVolume: 0, downVoteVolume: 0, nativeTokenSymbol: 'EXY' },
    ...over,
  })

  it('summarizeAccessFee returns a funding note for a NON-REPPO fee datanet', () => {
    const note = summarizeAccessFee(baseRubric({
      economics: { accessFeeReppo: 0, accessFeeToken: { address: '0xExy', symbol: 'EXY', decimals: 6, amount: 50 }, emissionsPerEpochReppo: 0, upVoteVolume: 0, downVoteVolume: 0, nativeTokenSymbol: 'EXY' },
    }))
    expect(note).toMatch(/50 EXY/)
    expect(note).toMatch(/fund this node's wallet with EXY/)
  })

  it('summarizeAccessFee returns undefined for a REPPO-fee datanet (unchanged)', () => {
    expect(summarizeAccessFee(baseRubric())).toBeUndefined()
  })

  it('the system prompt instructs the assistant to relay the access-fee funding note', () => {
    expect(SYSTEM).toContain('accessFeeNote')
    expect(SYSTEM.toLowerCase()).toContain('fund')
  })

  it('get_datanet_details attaches accessFeeNote ONLY for a non-REPPO datanet', async () => {
    const dummy = null as unknown as OnboardingAgentDeps['model']
    // non-REPPO datanet → note attached
    const exy = buildOnboardingTools(
      { ...deps(dummy), getDatanetDetails: vi.fn(async () => baseRubric({ economics: { accessFeeReppo: 0, accessFeeToken: { address: '0xExy', symbol: 'EXY', decimals: 6, amount: 50 }, emissionsPerEpochReppo: 0, upVoteVolume: 0, downVoteVolume: 0, nativeTokenSymbol: 'EXY' } })) },
      () => {},
    )
    const exyRes = await exy.get_datanet_details.execute({ datanetId: '42' }, { toolCallId: 'a', messages: [] } as never)
    expect((exyRes as { accessFeeNote?: string }).accessFeeNote).toMatch(/50 EXY/)

    // REPPO datanet → no note
    const reppo = buildOnboardingTools({ ...deps(dummy), getDatanetDetails: vi.fn(async () => baseRubric()) }, () => {})
    const reppoRes = await reppo.get_datanet_details.execute({ datanetId: '42' }, { toolCallId: 'b', messages: [] } as never)
    expect((reppoRes as { accessFeeNote?: string }).accessFeeNote).toBeUndefined()
  })

  it('get_datanet_details still relays an error result without an accessFeeNote', async () => {
    const dummy = null as unknown as OnboardingAgentDeps['model']
    const tools = buildOnboardingTools({ ...deps(dummy), getDatanetDetails: vi.fn(async () => ({ error: 'RPC down' })) }, () => {})
    const res = await tools.get_datanet_details.execute({ datanetId: '42' }, { toolCallId: 'c', messages: [] } as never)
    expect((res as { error?: string }).error).toBe('RPC down')
    expect((res as { accessFeeNote?: string }).accessFeeNote).toBeUndefined()
  })
})
