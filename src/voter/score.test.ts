// src/voter/score.test.ts
import { describe, it, expect } from 'vitest'
import type { FilePart } from 'ai'
import type { DatanetRubric } from '../rubric/types.js'
import { buildVotePrompt } from './score.js'

describe('buildVotePrompt', () => {
  const r = { name: 'D', goal: 'g', voterRubric: 'v' } as DatanetRubric
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

describe('buildVotePrompt — multimodal video pods', () => {
  const r = { name: 'D', goal: 'g', voterRubric: 'v' } as DatanetRubric
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
