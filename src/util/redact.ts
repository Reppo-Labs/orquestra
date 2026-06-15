// src/util/redact.ts

// Known RPC providers that carry the API key in the URL path (`…/v2/<key>`) or as
// a host token (quiknode). Anchored so generic REST paths like /v1/transactions
// are NOT mangled.
// key char class: alphanumerics, _, -, and %-encoding (so a percent-encoded key
// is redacted whole). Deliberately excludes . = & ? so the match stops at a
// trailing sentence period or a query-string boundary instead of eating them.
const KEY = String.raw`[\w%~-]+`
const PROVIDER_KEY_PATH = new RegExp(String.raw`\b([\w-]*\.?(?:alchemy\.com|infura\.io|chainstack\.com|ankr\.com|blastapi\.io|drpc\.org|nodereal\.io|blockpi\.network)\/v[0-9]+\/)${KEY}`, 'gi')
const QUICKNODE = new RegExp(String.raw`\b([\w-]+\.quiknode\.pro\/)${KEY}`, 'gi')
// credential-in-URL shapes for ANY host:
//  basic-auth `//[user]:password@host` — password class includes `@` and is
//  greedy, so it spans an embedded `@` and backtracks to the LAST `@` before the
//  host; it stops at `/`, so a `host:port/path@x` URL (no creds) doesn't match.
const URL_BASIC_AUTH = /(\/\/[^\s/@]*:)[^\s/]+(@)/g
//  query-string key: `?apikey=SECRET` / `?auth=…` / `?token=…` (value to & or end)
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
 *  distinguishing shapes (provider URLs, bearer/JWT, inf_/acp_ prefixes).
 *
 *  Defense-in-depth, not a complete filter. The node's actual RPC path is
 *  `--rpc-url <url>`, fully redacted by the flag rule below regardless of URL
 *  shape. These extra patterns catch a credentialed URL echoed by the upstream
 *  CLI in a non-flag form. Known residual gaps (all require RFC-violating or
 *  exotic input AND the CLI echoing it): a basic-auth password with a raw `/`,
 *  and a query-string key under a non-standard parameter name. Rotate keys; do
 *  not rely on redaction as the sole control. */
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
    // Surplus (inf_) and Virtuals (acp_ / acp-) api keys. Tolerate BOTH `_` and `-`
    // separators: provider docs are inconsistent on the Virtuals prefix, and matching
    // only `_` would silently leak a real `acp-…` key. Length floor avoids prose like "inf_".
    .replace(/\b(inf|acp)[_-][A-Za-z0-9]{12,}/gi, (m) => `${m.slice(0, 4)}<redacted>`)
}
