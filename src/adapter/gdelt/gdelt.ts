// src/adapter/gdelt/gdelt.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface GeoArticle { url: string; title: string; domain: string; seendate: string; image: string }

/** Pure: map a GDELT DOC 2.0 ArtList response to GeoArticles; drop entries without a url.
 *  `socialimage` is the article's og:image — used as the minted pod's card image. */
export function parseGdelt(raw: unknown): GeoArticle[] {
  const rows = (raw as { articles?: unknown[] })?.articles
  if (!Array.isArray(rows)) return []
  return rows
    .map((r) => {
      const a = r as Record<string, unknown>
      return {
        url: typeof a.url === 'string' ? a.url : '',
        title: String(a.title ?? ''),
        domain: String(a.domain ?? ''),
        seendate: String(a.seendate ?? ''),
        image: typeof a.socialimage === 'string' ? a.socialimage : '',
      }
    })
    .filter((a) => a.url !== '')
}

/** Pure: turn a human-readable focus ("Middle East conflict, Taiwan/China tensions, …")
 *  into a valid GDELT query. GDELT rejects commas/slashes/dashes in unquoted keywords, so we
 *  split the focus into phrases, strip every non-alphanumeric char to spaces, quote multi-word
 *  phrases, and OR them. Empty/garbage focus falls back to a safe default. */
export function buildGdeltQuery(focus: string): string {
  const phrases = focus
    .split(/,| and /i)
    .map((p) => p.replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0)
  if (phrases.length === 0) return 'geopolitics'
  const terms = phrases.map((p) => (p.includes(' ') ? `"${p}"` : p))
  return terms.length === 1 ? terms[0] : `(${terms.join(' OR ')})`
}

export interface GdeltQuery { query: string; timespanHours: number; maxRecords: number }

/** Run fn, retrying after each delay on failure. 429s are never retried — doing so
 *  escalates GDELT's penalty window (observed live: repeated 429s extend the block from
 *  seconds to minutes). Only transient errors (5xx, network) are worth retrying.
 *  Exposed for testing. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  delaysMs: number[],
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  isRetryable: (err: unknown) => boolean = () => true,
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      if (attempt >= delaysMs.length || !isRetryable(e)) throw lastErr
      await sleep(delaysMs[attempt])
    }
  }
}

const is429 = (e: unknown): boolean => e instanceof Error && e.message.includes('429')

/** Live: fetch recent geopolitical articles from GDELT DOC 2.0 (no auth, curl).
 *  Retries at 15s/60s on transient errors only. 429 is not retried — GDELT's penalty
 *  window escalates with each failed attempt; failing fast lets the next cycle (15+ min
 *  later) succeed after the window expires naturally. */
export async function fetchGeoEvents(q: GdeltQuery): Promise<GeoArticle[]> {
  const url =
    `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q.query)}` +
    `&mode=ArtList&maxrecords=${q.maxRecords}&timespan=${q.timespanHours}h&sort=DateDesc&format=json`
  const { stdout } = await withRetry(
    () => execFileAsync('curl', ['-fsS', '--max-time', '60', url], { maxBuffer: 64 * 1024 * 1024 }),
    [15_000, 60_000],
    undefined,
    (e) => !is429(e),
  )
  try {
    return parseGdelt(JSON.parse(stdout))
  } catch {
    throw new Error(`fetchGeoEvents: bad GDELT output: ${stdout.slice(0, 200)}`)
  }
}
