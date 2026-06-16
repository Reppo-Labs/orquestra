// src/llm/contentType.ts — probe a URL's Content-Type (and size) cheaply, so the
// pod-enrichment loop can route a video pod to the video path WITHOUT downloading it.
export interface ContentTypeInfo {
  /** lowercase media type, e.g. `video/mp4` (params stripped). */
  mediaType: string
  /** byte length when the server reports it; null when unknown. */
  contentLength: number | null
}

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

/** True iff `mediaType` is a `video/*` type (case-insensitive, params ignored). */
export function isVideoType(mediaType: string | undefined | null): boolean {
  return !!mediaType && /^video\//i.test(mediaType.trim())
}

function parseType(res: Response): string | null {
  const ct = res.headers.get('content-type')
  return ct ? ct.split(';')[0].trim().toLowerCase() : null
}

function parseLength(res: Response): number | null {
  const cl = res.headers.get('content-length')
  if (cl && /^\d+$/.test(cl)) return Number(cl)
  // ranged GET: Content-Range: bytes 0-0/<total>
  const cr = res.headers.get('content-range')
  const m = cr?.match(/\/(\d+)\s*$/)
  return m ? Number(m[1]) : null
}

const PROBE_TIMEOUT_MS = 15_000

/** One probe request with its OWN AbortController + timer. A single shared timer across the
 *  HEAD and the ranged-GET would let a slow HEAD burn the GET's budget (the GET then throws
 *  on the already-aborted signal), so each gets a fresh 15s window. */
async function probe(fetchImpl: FetchImpl, url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

/** HEAD-probe `url` for its Content-Type + size; fall back to a 1-byte ranged GET
 *  when HEAD is unsupported. Returns null on total failure (caller treats as text). */
export async function detectContentType(
  url: string,
  fetchImpl: FetchImpl = fetch,
): Promise<ContentTypeInfo | null> {
  try {
    const head = await probe(fetchImpl, url, { method: 'HEAD' })
    if (head.ok) {
      const mediaType = parseType(head)
      if (mediaType) return { mediaType, contentLength: parseLength(head) }
    }
  } catch {
    // fall through to the ranged GET (its own fresh timeout)
  }
  try {
    const ranged = await probe(fetchImpl, url, { method: 'GET', headers: { Range: 'bytes=0-0' } })
    if (!ranged.ok && ranged.status !== 206) return null
    const mediaType = parseType(ranged)
    return mediaType ? { mediaType, contentLength: parseLength(ranged) } : null
  } catch {
    return null
  }
}
