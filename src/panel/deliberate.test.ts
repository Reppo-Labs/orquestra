// src/panel/deliberate.test.ts
import { describe, it, expect } from 'vitest'
import type { DatanetRubric } from '../rubric/types.js'
import { runPanel, type PanelGenerate } from './deliberate.js'
import { buildPersonaPrompt, PERSONAS } from './personas.js'
import { buildJudgePrompt } from './judge.js'

const rubric = { name: 'D', goal: 'g', voterRubric: 'v', canVote: true, canMint: true } as DatanetRubric
const input = { name: 'pod', description: 'desc', rubric }
const model = null as never // unused: every test injects `generate`

// Route by which prompt is being generated. Persona prompts carry the stance word;
// the judge system prompt says "JUDGE".
function scripted(overrides: Partial<Record<string, { score: number; text: string } | Error>> = {}): PanelGenerate {
  return (async ({ system }) => {
    const who = system.includes('You are the JUDGE') ? 'judge'
      : system.includes('You are the BULL') ? 'bull'
      : system.includes('You are the BEAR') ? 'bear'
      : 'purist'
    const o = overrides[who]
    if (o instanceof Error) throw o
    const score = o?.score ?? (who === 'bull' ? 8 : who === 'bear' ? 3 : 6)
    return who === 'judge'
      ? { score, reason: o?.text ?? 'judge reason' }
      : { score, argument: o?.text ?? `${who} argument` }
  }) as PanelGenerate
}

describe('runPanel', () => {
  it('collects 3 panelists and returns the judge verdict + transcript', async () => {
    const r = await runPanel(model, input, { generate: scripted(), screenScore: 7 })
    expect(r.score).toBe(6)
    expect(r.reason).toBe('judge reason')
    expect(r.transcript.panelists.map((p) => p.persona).sort()).toEqual(['bear', 'bull', 'purist'])
    expect(r.transcript.screenScore).toBe(7)
    expect(r.transcript.judge.score).toBe(6)
  })

  it('omits screenScore from the transcript when not supplied (mint path)', async () => {
    const r = await runPanel(model, input, { generate: scripted() })
    expect(r.transcript.screenScore).toBeUndefined()
  })

  it('proceeds with surviving panelists when one persona fails', async () => {
    const r = await runPanel(model, input, { generate: scripted({ bear: new Error('boom') }) })
    expect(r.transcript.panelists.map((p) => p.persona).sort()).toEqual(['bull', 'purist'])
    expect(r.score).toBe(6) // judge still rules
  })

  it('throws when every persona fails (caller falls back)', async () => {
    const gen = scripted({ bull: new Error('x'), bear: new Error('y'), purist: new Error('z') })
    await expect(runPanel(model, input, { generate: gen })).rejects.toThrow(/all personas failed/)
  })

  it('throws when the judge fails (caller falls back)', async () => {
    await expect(runPanel(model, input, { generate: scripted({ judge: new Error('judge down') }) })).rejects.toThrow('judge down')
  })
})

describe('persona prompts', () => {
  it('each persona carries its stance and the injection guard', () => {
    for (const p of PERSONAS) {
      const { system } = buildPersonaPrompt(p, input)
      expect(system.toLowerCase()).toContain('untrusted')
      expect(system).toContain(p.id.toUpperCase())
    }
  })
  it('persona prompt does NOT include the operator brief (only the judge does)', () => {
    const { system, prompt } = buildPersonaPrompt(PERSONAS[0], input)
    expect(`${system}${prompt}`).not.toContain('Operator strategy')
  })
  it('appends the economics block when input.economics is set (vote path)', () => {
    const { prompt } = buildPersonaPrompt(PERSONAS[0], {
      ...input,
      economics: '\n## Datanet economics\nThis datanet emits 500 REPPO per epoch.\n',
    })
    expect(prompt).toContain('## Datanet economics')
    expect(prompt.indexOf('## Datanet economics')).toBeLessThan(prompt.indexOf('# Pod under review'))
  })
  it('no economics block when absent (mint path)', () => {
    const { prompt } = buildPersonaPrompt(PERSONAS[0], input)
    expect(prompt).not.toContain('## Datanet economics')
  })
})

describe('judge prompt', () => {
  it('includes the operator brief when provided', () => {
    const { prompt } = buildJudgePrompt({ ...input, brief: 'be contrarian' }, [{ persona: 'bull', score: 8, argument: 'a' }])
    expect(prompt).toContain('be contrarian')
    expect(prompt).toContain('Operator strategy')
  })
  it('lists panelist scores and names missing voices', () => {
    const { system, prompt } = buildJudgePrompt(input, [
      { persona: 'purist', score: 6, argument: 'strict' },
      { persona: 'bull', score: 9, argument: 'up' },
    ], ['bear'])
    expect(system).toContain('PURIST')
    expect(prompt).toContain('purist (score 6)')
    expect(prompt).toContain('bull (score 9)')
    expect(prompt).toMatch(/Missing voices/)
    expect(prompt).toContain('bear')
  })
  it('appends the economics block when input.economics is set (vote path)', () => {
    const { prompt } = buildJudgePrompt(
      { ...input, economics: '\n## Datanet economics\nThis datanet emits 500 REPPO per epoch.\n' },
      [],
    )
    expect(prompt).toContain('## Datanet economics')
    expect(prompt.indexOf('## Datanet economics')).toBeLessThan(prompt.indexOf('# Pod under review'))
  })
  it('no economics block when absent (mint path)', () => {
    const { prompt } = buildJudgePrompt(input, [])
    expect(prompt).not.toContain('## Datanet economics')
  })
})
