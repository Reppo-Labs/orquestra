// src/onboarding/agent.test.ts
import { describe, it, expect, vi } from 'vitest'
import { MockLanguageModelV1 } from 'ai/test'
import { runConversationalOnboarding, type OnboardingAgentDeps } from './agent.js'
import type { Prompter } from './types.js'

const validAnswers = {
  datanets: [{ id: '9', vote: true, mint: true, strictness: 'conservative', adapter: 'hyperliquid' }],
  lockReppo: 0, lockDurationDays: 30, voteGasEthMax: 0.02, voteRateMaxPerCycle: 25,
  mintReppoMax: 100, mintGasEthMax: 0.05, horizonDays: 30, cadenceHours: 6, notes: 'picky',
}
const silentPrompter: Prompter = { ask: async () => 'ok', info: () => {} }

function deps(model: OnboardingAgentDeps['model']): OnboardingAgentDeps {
  return {
    model,
    prompter: silentPrompter,
    listDatanets: vi.fn(async () => [{ id: '9', name: 'TradingGym AI', status: 'ACTIVE', description: 'HL', accessFeeReppo: 50, emissionsPerEpochReppo: 500, upVoteVolume: 1, downVoteVolume: 1 }]),
    getDatanetDetails: vi.fn(async () => ({ datanetId: '9', name: 'TradingGym AI', goal: 'g', publisherSpec: 'p', voterRubric: 'v', canVote: true, canMint: true, status: 'ACTIVE', economics: { accessFeeReppo: 50, emissionsPerEpochReppo: 500, upVoteVolume: 1, downVoteVolume: 1, nativeTokenSymbol: 'REPPO' } })),
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
