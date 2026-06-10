import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseRss, freshItems } from './feeds.js'

const fresh = new Date(Date.now() - 3600_000).toUTCString() // 1h ago, RFC-822
const xml = readFileSync(join(__dirname, '../../../test/fixtures/sports-rss.xml'), 'utf-8')
  .replaceAll('FRESH_DATE', fresh)

describe('parseRss', () => {
  it('extracts title/link/description/pubDate/image from single-line items, drops link-less', () => {
    const items = parseRss(xml)
    expect(items).toHaveLength(4) // malformed (no link) dropped
    expect(items[0]).toEqual({
      title: "Why the Celtics' defense falls apart without Porzingis",
      link: 'https://ex.com/celtics-defense',
      description: 'Beat writer breaks down rim-protection numbers & rotations.',
      pubDate: fresh,
      image: 'https://ex.com/img/celtics.jpg',
    })
  })
  it('decodes XML entities in plain-text fields', () => {
    expect(parseRss(xml)[1].title).toBe("Arsenal's midfield gamble will decide the title race")
  })
  it('reads enclosure and media:thumbnail image variants', () => {
    const items = parseRss(xml)
    expect(items[1].image).toBe('https://ex.com/img/arsenal.png')
    expect(items[2].image).toBe('https://ex.com/img/thumb.jpg')
  })
  it('returns [] on non-RSS input', () => {
    expect(parseRss('<html>not a feed</html>')).toEqual([])
    expect(parseRss('')).toEqual([])
  })

  it('decodes &amp;lt; without double-decoding (entity order) + enclosure type-before-url', () => {
    const item =
      '<rss><channel><item>' +
      '<title>A &amp;lt;tag&amp;gt; in text &amp; more</title>' +
      '<link>https://ex.com/order</link><description>d</description>' +
      '<pubDate>' + fresh + '</pubDate>' +
      '<enclosure type="image/jpeg" url="https://ex.com/img/order.jpg" length="1"/>' +
      '</item></channel></rss>'
    const [it0] = parseRss(item)
    expect(it0.title).toBe('A &lt;tag&gt; in text & more')
    expect(it0.image).toBe('https://ex.com/img/order.jpg')
  })
})

describe('freshItems', () => {
  it('drops items older than maxAgeHours; keeps unparseable dates (tolerant)', () => {
    const items = parseRss(xml)
    const kept = freshItems(items, 48)
    expect(kept.map((i) => i.link)).not.toContain('https://ex.com/stale')
    expect(kept).toHaveLength(3)
    const noDate = freshItems([{ title: 't', link: 'l', description: '', pubDate: '', image: '' }], 48)
    expect(noDate).toHaveLength(1) // tolerant: unparseable date stays
  })
})
