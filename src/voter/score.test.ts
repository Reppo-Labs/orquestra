// src/voter/score.test.ts
import { describe, it, expect } from 'vitest'
import type { FilePart } from 'ai'
import { toVoteRubric, toMintRubric, type DatanetRubric } from '../rubric/types.js'
import { buildVotePrompt } from './score.js'

describe('buildVotePrompt', () => {
  const r = {
    name: 'D',
    goal: 'g',
    voterRubric: 'v',
    economics: { accessFeeReppo: 0, emissionsPerEpochReppo: 0, upVoteVolume: 0, downVoteVolume: 0, nativeTokenSymbol: 'REPPO' },
  } as DatanetRubric
  const pod = { podId: '1', validityEpoch: '1', name: 'p', description: 'd' }
  it('includes the operator strategy brief when provided', () => {
    const out = buildVotePrompt(pod, r, 'be contrarian on ceasefires')
    expect('prompt' in out && out.prompt).toContain('be contrarian on ceasefires')
  })
  it('omits the brief section when empty', () => {
    const out = buildVotePrompt(pod, r, '')
    expect('prompt' in out && out.prompt).not.toContain('Operator strategy')
  })
})

describe('buildVotePrompt datanet economics', () => {
  const baseRubric = {
    name: 'D',
    goal: 'g',
    voterRubric: 'v',
    economics: { accessFeeReppo: 0, emissionsPerEpochReppo: 0, upVoteVolume: 0, downVoteVolume: 0, nativeTokenSymbol: 'REPPO' },
  } as DatanetRubric
  const pod = { podId: '1', validityEpoch: '1', name: 'p', description: 'd' }

  const yld = {
    datanetId: 'D',
    emissionsPerEpochReppo: 500,
    epoch: 42,
    epochVoteVolume: 2_000_000,
    yieldPerVote: 500 / 2_000_000,
    uncontested: false,
  }

  it('renders the economics block when rubric.economics.currentYield is set', () => {
    // toVoteRubric clones, so the yield never leaks into other tests sharing baseRubric.
    const rubric = toVoteRubric(baseRubric, yld)
    const built = buildVotePrompt(pod, rubric) as { system: string; prompt: string }
    expect(built.prompt).toContain('## Datanet economics')
    expect(built.prompt).toContain('500 REPPO per epoch')
    // economics sit ABOVE the untrusted pod block
    expect(built.prompt.indexOf('## Datanet economics')).toBeLessThan(built.prompt.indexOf('# Pod under review'))
  })

  it('omits the block when currentYield is absent (back-compat)', () => {
    const built = buildVotePrompt(pod, baseRubric) as { prompt: string }
    expect(built.prompt).not.toContain('## Datanet economics')
  })

  it('a mint-scoped rubric (toMintRubric) never renders the block, even from a yield-carrying vote rubric', () => {
    // Mirrors wiring.ts's mint screen path, which scores candidates through this same
    // prompt builder: MintRubric structurally cannot carry currentYield, so the mint
    // prompt is economics-free by type, not by convention.
    const mintRubric = toMintRubric(toVoteRubric(baseRubric, yld))
    const built = buildVotePrompt(pod, mintRubric) as { prompt: string }
    expect(built.prompt).not.toContain('## Datanet economics')
  })
})

describe('buildVotePrompt — multimodal video pods', () => {
  const r = {
    name: 'D',
    goal: 'g',
    voterRubric: 'v',
    economics: { accessFeeReppo: 0, emissionsPerEpochReppo: 0, upVoteVolume: 0, downVoteVolume: 0, nativeTokenSymbol: 'REPPO' },
  } as DatanetRubric
  const videoPart: FilePart = { type: 'file', data: 'BASE64', mimeType: 'video/mp4' }

  it('returns messages (rubric text + video FilePart + instruction) for a video pod', () => {
    const pod = { podId: '1', validityEpoch: '1', name: 'clip', description: '', mediaUrl: 'https://x/c.mp4', mediaType: 'video/mp4' }
    const out = buildVotePrompt(pod, r, 'be strict', videoPart)
    expect('messages' in out).toBe(true)
    if ('messages' in out) {
      const content = out.messages[0].content as Array<{ type: string }>
      expect(out.messages[0].role).toBe('user')
      expect(content.some((p) => p.type === 'text')).toBe(true)
      expect(content.some((p) => p.type === 'file')).toBe(true)
      // rubric + brief still travel in the text part
      const text = (content.find((p) => p.type === 'text') as unknown as { text: string }).text
      expect(text).toContain('be strict')
      expect(text).toContain('score') // the 1-10 instruction
    }
  })

  it('still returns a string prompt for a text pod (no video part)', () => {
    const pod = { podId: '2', validityEpoch: '1', name: 't', description: 'd' }
    const out = buildVotePrompt(pod, r, '')
    expect('prompt' in out).toBe(true)
  })
})
