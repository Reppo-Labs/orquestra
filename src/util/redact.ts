// src/util/redact.ts

/** Scrub credential-shaped substrings from a message before it is logged,
 *  persisted to the activity log, or served by the dashboard. CLI failures fold
 *  the full command line (including `--rpc-url https://...v2/<api-key>`) into
 *  error messages — redact at the boundaries so every exit inherits it.
 *
 *  Tx hashes are also 0x-hex but are legitimate forensic output: hex is kept
 *  when the preceding context mentions tx (txHash:, "txHash":", tx/, tx ). */
export function redactSecrets(s: string): string {
  return s
    // value following an --rpc-url flag (any provider)
    .replace(/(--rpc-url[ =])\S+/g, '$1<redacted>')
    // versioned key-path RPC providers on any host: alchemy /v2/<key>, infura /v3/<key>, …
    .replace(/(\/v[0-9]\/)[\w-]{16,}/g, '$1<redacted>')
    // quicknode-style token-in-path endpoints
    .replace(/([\w.-]+\.quiknode\.pro\/)[\w-]+/gi, '$1<redacted>')
    // bearer tokens / JWTs
    .replace(/(Bearer )\S+/g, '$1<redacted>')
    // Surplus (inf_) and Virtuals (acp_) api keys
    .replace(/\b(inf|acp)_[A-Za-z0-9]+/g, '$1_<redacted>')
    // private-key-shaped hex blobs (64+ chars so signatures aren't half-redacted),
    // EXCEPT when the preceding context labels it a tx (prose, JSON, or URL form).
    .replace(/0x[0-9a-fA-F]{64,}/g, (match, offset: number, whole: string) => {
      const before = whole.slice(Math.max(0, offset - 12), offset).toLowerCase()
      return /tx/.test(before) ? match : '0x<redacted>'
    })
}
