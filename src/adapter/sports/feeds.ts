// src/adapter/sports/feeds.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { withRetry } from '../gdelt/gdelt.js'

const execFileAsync = promisify(execFile)

export interface FeedItem { title: string; link: string; description: string; pubDate: string; image: string }

/** Default curated free, no-auth analysis-leaning feeds (probed live 2026-06-10).
 *  Operator-overridable via adapterParams.feeds. curl needs -L (301/308 redirects). */
export const DEFAULT_FEEDS = [
  'https://www.espn.com/espn/rss/nba/news',
  'https://www.espn.com/espn/rss/nfl/news',
  'https://www.espn.com/espn/rss/soccer/news',
  'https://www.cbssports.com/rss/headlines/nba/',
  'https://www.cbssports.com/rss/headlines/nfl/',
  'https://www.cbssports.com/rss/headlines/soccer/',
  'https://sports.yahoo.com/nba/rss.xml',
]

const decode = (s: string): string =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").trim()

const field = (block: string, tag: string): string => {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
  return m ? decode(m[1]) : ''
}

/** Pure: extract items from an RSS body. GLOBAL regex over the whole string —
 *  several real feeds (ESPN) serve single-line XML, so line-based scans miss all.
 *  Items without a link are dropped; image comes from media:content /
 *  media:thumbnail / enclosure (first present wins). */
export function parseRss(xml: string): FeedItem[] {
  const out: FeedItem[] = []
  for (const m of xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)) {
    const block = m[1]
    const link = field(block, 'link')
    if (!link) continue
    const image =
      block.match(/<media:content[^>]*url="([^"]+)"/i)?.[1] ??
      block.match(/<media:thumbnail[^>]*url="([^"]+)"/i)?.[1] ??
      block.match(/<enclosure[^>]*url="([^"]+)"[^>]*type="image\//i)?.[1] ?? ''
    out.push({ title: field(block, 'title'), link, description: field(block, 'description'), pubDate: field(block, 'pubDate'), image })
  }
  return out
}

/** Drop items older than maxAgeHours. Unparseable/missing dates are KEPT
 *  (tolerant-read style — a feed with odd dates shouldn't go dark). */
export function freshItems(items: FeedItem[], maxAgeHours: number, now = Date.now()): FeedItem[] {
  const cutoff = now - maxAgeHours * 3600_000
  return items.filter((i) => {
    const t = Date.parse(i.pubDate)
    return Number.isNaN(t) || t >= cutoff
  })
}

/** Live: fetch one feed (curl -fsSL, 20s, via withRetry 10s/30s). Throws on failure —
 *  the caller treats each feed independently. */
export async function fetchFeed(url: string): Promise<FeedItem[]> {
  const { stdout } = await withRetry(
    () => execFileAsync('curl', ['-fsSL', '--max-time', '20', url], { maxBuffer: 16 * 1024 * 1024 }),
    [10_000, 30_000],
  )
  return parseRss(stdout)
}
