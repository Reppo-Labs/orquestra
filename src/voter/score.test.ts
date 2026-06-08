// src/voter/score.test.ts
import { describe, it, expect } from 'vitest'
import type { DatanetRubric } from '../rubric/types.js'
import { buildVotePrompt } from './score.js'

describe('buildVotePrompt', () => {
  const r = { name: 'D', goal: 'g', voterRubric: 'v' } as DatanetRubric
  const pod = { podId: '1', validityEpoch: '1', name: 'p', description: 'd' }
  it('includes the operator strategy brief when provided', () => {
    expect(buildVotePrompt(pod, r, 'be contrarian on ceasefires').prompt).toContain('be contrarian on ceasefires')
  })
  it('omits the brief section when empty', () => {
    expect(buildVotePrompt(pod, r, '').prompt).not.toContain('Operator strategy')
  })
})
