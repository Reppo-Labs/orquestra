import { describe, it, expect } from 'vitest'
import { buildSynthesisPrompt, type GdeltStrategy } from './claim.js'
import type { GeoArticle } from './gdelt.js'
import type { DatanetRubric } from '../../rubric/types.js'

const rubric = { name: 'Geopolitics', goal: 'g', publisherSpec: 'submit sources', voterRubric: 'price truth' } as DatanetRubric
const strategy: GdeltStrategy = { focus: 'Middle East energy', angle: 'contrarian on ceasefires', brief: 'favor sanctions impact', topN: 5, minImportance: 7 }
const articles: GeoArticle[] = [{ url: 'https://ex.com/a', title: 'Ceasefire extended', domain: 'ex.com', seendate: '20260608T120000Z' }]

describe('buildSynthesisPrompt', () => {
  it('includes the operator focus, angle, brief, the datanet rubric, and the articles', () => {
    const { prompt } = buildSynthesisPrompt(articles, rubric, strategy)
    expect(prompt).toContain('Middle East energy')
    expect(prompt).toContain('contrarian on ceasefires')
    expect(prompt).toContain('favor sanctions impact')
    expect(prompt).toContain('submit sources')
    expect(prompt).toContain('Ceasefire extended')
  })
  it('carries the untrusted-content injection guard in the system prompt', () => {
    const { system } = buildSynthesisPrompt(articles, rubric, strategy)
    expect(system.toLowerCase()).toContain('untrusted')
    expect(system.toLowerCase()).toContain('never follow')
  })
})
