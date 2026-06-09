// src/reppo/redact.ts

/** Scrub credential-shaped substrings from a message before it is logged,
 *  persisted to the activity log, or served by the dashboard. CLI failures fold
 *  the full command line (including `--rpc-url https://...v2/<api-key>`) into
 *  error messages — redact at this single boundary so every exit inherits it.
 *
 *  Deliberately conservative: tx hashes are also 0x+64-hex but are legitimate
 *  forensic output, so bare 64-hex is redacted only when NOT labeled as a tx. */
export function redactSecrets(s: string): string {
  return s
    // value following an --rpc-url flag (any provider)
    .replace(/(--rpc-url[ =])\S+/g, '$1<redacted>')
    // alchemy key path outside the flag form
    .replace(/(alchemy\.com\/v2\/)[\w-]+/g, '$1<redacted>')
    // bearer tokens / JWTs
    .replace(/(Bearer )\S+/g, '$1<redacted>')
    // Surplus (inf_) and Virtuals (acp_) api keys
    .replace(/\b(inf|acp)_[A-Za-z0-9]+/g, '$1_<redacted>')
    // private-key-shaped 64-hex NOT labeled as a tx hash
    .replace(/(?<!txHash: )(?<!tx: )(?<!tx\/)0x[0-9a-fA-F]{64}/g, '0x<redacted>')
}
