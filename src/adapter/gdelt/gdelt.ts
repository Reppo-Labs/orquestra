// src/adapter/gdelt/gdelt.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface GeoArticle { url: string; title: string; domain: string; seendate: string }

/** Pure: map a GDELT DOC 2.0 ArtList response to GeoArticles; drop entries without a url. */
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
      }
    })
    .filter((a) => a.url !== '')
}

export interface GdeltQuery { query: string; timespanHours: number; maxRecords: number }

/** Live: fetch recent geopolitical articles from GDELT DOC 2.0 (no auth, curl). */
export async function fetchGeoEvents(q: GdeltQuery): Promise<GeoArticle[]> {
  const url =
    `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q.query)}` +
    `&mode=ArtList&maxrecords=${q.maxRecords}&timespan=${q.timespanHours}h&sort=DateDesc&format=json`
  const { stdout } = await execFileAsync('curl', ['-fsS', '--max-time', '60', url], { maxBuffer: 64 * 1024 * 1024 })
  try {
    return parseGdelt(JSON.parse(stdout))
  } catch {
    throw new Error(`fetchGeoEvents: bad GDELT output: ${stdout.slice(0, 200)}`)
  }
}
