// src/util/redact.ts

// Known RPC providers that carry the API key in the URL path (`…/v2/<key>`) or as
// a host token (quiknode). Anchored so generic REST paths like /v1/transactions
// are NOT mangled.
// key char class includes %-encoding, base64url padding (=), and dots so an
// encoded/padded key is redacted whole, not just its leading word-chars.
const KEY = String.raw`[\w%.=~+-]+`
const PROVIDER_KEY_PATH = new RegExp(String.raw`\b([\w-]*\.?(?:alchemy\.com|infura\.io|chainstack\.com|ankr\.com|blastapi\.io|drpc\.org|nodereal\.io|blockpi\.network)\/v[0-9]+\/)${KEY}`, 'gi')
const QUICKNODE = new RegExp(String.raw`\b([\w-]+\.quiknode\.pro\/)${KEY}`, 'gi')
// credential-in-URL shapes that work for ANY host (basic-auth, query-string key):
//   https://user:SECRET@host/   and   ...?apikey=SECRET / ?auth=SECRET / ?token=…
const URL_BASIC_AUTH = /(\/\/[^/\s:@]+:)[^/\s@]+(@)/g
const URL_QUERY_KEY = /([?&](?:api[_-]?key|apikey|auth|access[_-]?token|token|key)=)[^&\s"']+/gi

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
    // credential-in-URL shapes (any host): basic-auth password, query-string key
    .replace(URL_BASIC_AUTH, '$1<redacted>$2')
    .replace(URL_QUERY_KEY, '$1<redacted>')
    // keyed RPC provider URLs (host-anchored, so /v1/genericPath is untouched)
    .replace(PROVIDER_KEY_PATH, '$1<redacted>')
    .replace(QUICKNODE, '$1<redacted>')
    // bearer tokens / JWTs
    .replace(/(Bearer )\S+/g, '$1<redacted>')
    // Surplus (inf_) and Virtuals (acp_) api keys — length floor avoids prose like "inf_"
    .replace(/\b(inf|acp)_[A-Za-z0-9]{12,}/g, '$1_<redacted>')
}
