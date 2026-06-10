// src/util/redact.ts

// Known RPC providers that carry the API key in the URL path (`…/v2/<key>`) or as
// a host token (quiknode). Anchored so generic REST paths like /v1/transactions
// are NOT mangled.
const PROVIDER_KEY_PATH = /\b([\w-]*\.?(?:alchemy\.com|infura\.io|chainstack\.com|ankr\.com|blastapi\.io|drpc\.org|nodereal\.io|blockpi\.network)\/v[0-9]+\/)[\w-]+/gi
const QUICKNODE = /\b([\w-]+\.quiknode\.pro\/)[\w-]+/gi

/** Scrub credential-shaped substrings from a message before it is logged,
 *  persisted to the activity log, or served by the dashboard. CLI failures fold
 *  the full command line (including `--rpc-url https://...v2/<api-key>`) into
 *  error messages — redact at the boundaries so every exit inherits it.
 *
 *  Note on 0x-hex: 32-byte hex blobs (tx hashes, signatures) are NOT redacted —
 *  they are legitimate, public, forensically-useful output, and the node never
 *  passes a private key on a CLI argv (it goes via env), so a private key never
 *  reaches this folded-command-line path. Redaction targets KEYS, which have
 *  distinguishing shapes (provider URLs, bearer/JWT, inf_/acp_ prefixes). */
export function redactSecrets(s: string): string {
  return s
    // value following an --rpc-url flag (any provider)
    .replace(/(--rpc-url[ =])\S+/g, '$1<redacted>')
    // keyed RPC provider URLs (host-anchored, so /v1/genericPath is untouched)
    .replace(PROVIDER_KEY_PATH, '$1<redacted>')
    .replace(QUICKNODE, '$1<redacted>')
    // bearer tokens / JWTs
    .replace(/(Bearer )\S+/g, '$1<redacted>')
    // Surplus (inf_) and Virtuals (acp_) api keys — length floor avoids prose like "inf_"
    .replace(/\b(inf|acp)_[A-Za-z0-9]{12,}/g, '$1_<redacted>')
}
