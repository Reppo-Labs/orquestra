// src/voter/types.test.ts
import { describe, it, expect } from 'vitest'
import type { VoterPod } from './types.js'

describe('VoterPod media fields', () => {
  it('accepts an optional mediaUrl + mediaType (a video pod)', () => {
    const videoPod: VoterPod = {
      podId: '1', validityEpoch: '1', name: 'clip', description: '',
      mediaUrl: 'https://x/clip.mp4', mediaType: 'video/mp4',
    }
    expect(videoPod.mediaType).toBe('video/mp4')
  })
  it('leaves a text pod (no media fields) valid', () => {
    const textPod: VoterPod = { podId: '2', validityEpoch: '1', name: 't', description: 'd' }
    expect(textPod.mediaUrl).toBeUndefined()
  })
})
