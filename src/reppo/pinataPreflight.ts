// src/reppo/pinataPreflight.ts
// Scope check on the Pinata key BEFORE any on-chain mint spend.
//
// The mint pipeline is three stages: (1) on-chain mint, (2) IPFS pin, (3) platform
// registration — and the CLI pins via the LEGACY pinning API (pinJSONToIPFS). Pinata's
// default new keys are "Files"-scoped and fail that endpoint with 403 NO_SCOPES_FOUND,
// which strands the pipeline at stage 2 AFTER the fee is paid: the pod exists on-chain,
// earns, and never appears in the webapp (operator report: pods #3828/#3829 on
// datanet 25). `GET /data/testAuthentication` is itself a legacy-API endpoint, so a
// Files-only key fails it the same way the pin would — a deterministic probe that
// costs one HTTPS call and no gas.
//
// Failure direction: any non-2xx AND any transport failure skip minting for the cycle
// (fail closed). A Pinata outage means the stage-2 pin would fail anyway — minting
// through it would strand pods, which is the exact outcome this probe exists to
// prevent. Success is cached per key for the process lifetime (scopes change only with
// the key, and a key change means a new .env and a restart); failures are never
// cached, so a fixed key recovers on the next cycle.

const TEST_AUTH_URL = 'https://api.pinata.cloud/data/testAuthentication'
const TIMEOUT_MS = 10_000

export type PinataPreflightResult = { ok: true } | { ok: false; reason: string }

const okByKey = new Set<string>()

/** Exposed for tests only — the cache is process-global on purpose. */
export function resetPinataPreflightCache(): void {
  okByKey.clear()
}

export async function checkPinataPinScopes(
  jwt: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<PinataPreflightResult> {
  if (!jwt || jwt.trim() === '') {
    return { ok: false, reason: 'PINATA_JWT is not set — pin-mode minting needs a Pinata key with legacy pinning scopes' }
  }
  if (okByKey.has(jwt)) return { ok: true }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetchImpl(TEST_AUTH_URL, {
      headers: { authorization: `Bearer ${jwt}` },
      signal: ctrl.signal,
    })
    if (res.ok) {
      okByKey.add(jwt)
      return { ok: true }
    }
    const body = await res.text().catch(() => '')
    const scopeIssue = res.status === 403 && /NO_SCOPES_FOUND/i.test(body)
    return {
      ok: false,
      reason: scopeIssue
        ? 'Pinata key lacks legacy pinning scopes (403 NO_SCOPES_FOUND) — new "Files"-scoped keys cannot pin; ' +
          'create a key with legacy Pinning scopes (pinJSONToIPFS) at pinata.cloud'
        : `Pinata auth check failed (HTTP ${res.status}) — pin-mode minting would strand pods at the IPFS stage`,
    }
  } catch (e) {
    return {
      ok: false,
      reason: `Pinata unreachable (${e instanceof Error ? e.message.split('\n')[0] : String(e)}) — ` +
        'skipping pin-mode mints this cycle rather than stranding pods at the IPFS stage',
    }
  } finally {
    clearTimeout(t)
  }
}
