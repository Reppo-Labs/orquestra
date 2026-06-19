// src/llm/driveResolve.ts — rewrite a Google Drive *viewer/share* URL into a direct
// download URL the video path can probe + ingest. A Drive link like
// `https://drive.google.com/file/d/<ID>/view` serves an HTML viewer shell, so
// detectContentType() sees `text/html`, the pod is text-fetched, and the model scores
// the page chrome instead of the video. Rewriting to the usercontent download endpoint
// makes the HEAD/ranged probe return `video/mp4` → the pod routes to the Gemini path.

/** Drive hosts that front a file behind a viewer/share page rather than raw bytes. */
const DRIVE_HOSTS = new Set(['drive.google.com', 'docs.google.com'])

/** A Drive file id: URL-safe base64-ish, at least a handful of chars (ids run ~25–44). */
const FILE_ID = /^[A-Za-z0-9_-]{8,}$/

/** Pull the file id from the known Drive URL shapes:
 *  - /file/d/<ID>/view, /file/d/<ID>  (a real binary Drive file, either host)
 *  - /d/<ID>, ?id=<ID>  (drive.google.com share/open shapes)
 *  Returns null when no id is present.
 *
 *  docs.google.com fronts native Docs/Sheets/Slides at /<kind>/d/<ID> (e.g.
 *  /document/d/<ID>/edit) — those are NOT downloadable binary files, so on that host
 *  only /file/d/<ID> is rewritten; a bare /d/<ID> there is left alone. */
function extractFileId(u: URL): string | null {
  const filePath = u.pathname.match(/\/file\/d\/([^/]+)/)
  if (filePath && FILE_ID.test(filePath[1])) return filePath[1]
  if (u.hostname === 'docs.google.com') return null
  const dPath = u.pathname.match(/\/d\/([^/]+)/)
  if (dPath && FILE_ID.test(dPath[1])) return dPath[1]
  const byQuery = u.searchParams.get('id')
  if (byQuery && FILE_ID.test(byQuery)) return byQuery
  return null
}

/** A direct-download URL for a public Drive file. `confirm=t` skips the large-file
 *  virus-scan interstitial (which would otherwise return an HTML page, not bytes). */
function downloadUrl(fileId: string): string {
  return `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`
}

/** Rewrite a Google Drive viewer/share URL to a direct-download URL; return any
 *  non-Drive URL (or an unparseable string) unchanged. Idempotent: a URL already
 *  pointing at the usercontent download endpoint is returned as-is. Pure + sync — safe
 *  to call inline in the pod-enrichment loop before probing Content-Type. */
export function resolveDriveUrl(url: string): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return url
  }
  if (u.hostname === 'drive.usercontent.google.com') return url
  if (!DRIVE_HOSTS.has(u.hostname)) return url
  const fileId = extractFileId(u)
  return fileId ? downloadUrl(fileId) : url
}
