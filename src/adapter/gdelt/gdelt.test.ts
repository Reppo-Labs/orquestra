import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseGdelt } from './gdelt.js'

const raw = JSON.parse(readFileSync(join(__dirname, '../../../test/fixtures/gdelt-doc.json'), 'utf-8'))

describe('parseGdelt', () => {
  it('maps articles to GeoArticle and drops url-less entries', () => {
    const a = parseGdelt(raw)
    expect(a).toHaveLength(2)
    expect(a[0]).toEqual({ url: 'https://ex.com/a', title: 'Israel and Lebanon extend ceasefire', domain: 'ex.com', seendate: '20260608T120000Z' })
  })
  it('returns [] on malformed input', () => {
    expect(parseGdelt({})).toEqual([])
    expect(parseGdelt(null)).toEqual([])
  })
})
