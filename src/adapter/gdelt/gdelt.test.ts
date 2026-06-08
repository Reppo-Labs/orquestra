import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseGdelt, buildGdeltQuery } from './gdelt.js'

const raw = JSON.parse(readFileSync(join(__dirname, '../../../test/fixtures/gdelt-doc.json'), 'utf-8'))

describe('buildGdeltQuery', () => {
  it('turns a free-text focus into a valid OR query, stripping illegal chars + quoting phrases', () => {
    // GDELT rejects commas/slashes/dashes in unquoted keywords; this must produce a clean query.
    const q = buildGdeltQuery('Middle East conflict, Taiwan/China tensions, sanctions, and energy markets')
    expect(q).toBe('("Middle East conflict" OR "Taiwan China tensions" OR sanctions OR "energy markets")')
    expect(q).not.toMatch(/[,/]/)            // no illegal separators leaked
  })
  it('single keyword needs no parens/quotes', () => {
    expect(buildGdeltQuery('sanctions')).toBe('sanctions')
  })
  it('falls back to a default for empty/garbage focus', () => {
    expect(buildGdeltQuery('   ')).toBe('geopolitics')
    expect(buildGdeltQuery(',,,')).toBe('geopolitics')
  })
})

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
