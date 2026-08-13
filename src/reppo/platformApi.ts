// src/reppo/platformApi.ts
// Reppo platform REST API — distinct from on-chain CLI.
// All functions are fire-and-forget-safe: callers catch and log on failure.
import { isRobinhood } from './network.js'

const TIMEOUT_MS = 15_000

/** Per-network platform base: robinhood agents/pods/votes live on
 *  robinhood.reppo.ai (same API contract; agent ids are per-platform).
 *  Resolved at call time so REPPO_NETWORK is read live, matching how the CLI
 *  layer resolves its endpoints. Before this, updateAgentOnPlatform PATCHed
 *  reppo.ai even on robinhood — the agent id doesn't exist there, so every
 *  node start logged a 401 (isOrquestra mark failed). */
export function platformBase(): string {
  return isRobinhood() ? 'https://robinhood.reppo.ai/api/v1' : 'https://reppo.ai/api/v1'
}

/** Error carrying the platform's own answer, so the caller can persist it verbatim
 *  (src/reppo/platformErrors.ts) instead of collapsing it to a log line. */
export class PlatformApiError extends Error {
  constructor(
    message: string,
    readonly stage: 'register' | 'resolve-pod',
    readonly httpStatus?: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'PlatformApiError'
  }
}

/** Map an ON-CHAIN pod token id to the platform's pod cuid.
 *
 *  These are two different id spaces and the node only ever holds the first one:
 *  `reppo list pods` reports `podId` = the ERC-721 tokenId from the PodMinted event,
 *  while every /agents/:agentId/pods/:podId/* route resolves :podId as a DATABASE cuid
 *  (`prisma.pod.findFirst({ where: { id } })`). Posting a tokenId there is not a
 *  near-miss — it is a lookup in the wrong namespace, and the API answers a flat
 *  404 "Pod not found". Every vote this node registered took that path, which is why
 *  votes cast on-chain never appeared in the webapp.
 *
 *  The public pods catalog is the only surface that exposes BOTH ids, and it needs no
 *  auth. Resolution is per-call (the catalog changes as pods are minted); callers that
 *  register several votes in a cycle should pass a shared `cache`. */
export async function resolvePodCuid(
  tokenId: string,
  fetchImpl: typeof fetch = fetch,
  cache?: Map<string, string>,
): Promise<string> {
  const hit = cache?.get(tokenId)
  if (hit) return hit
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  let res: Response
  try {
    res = await fetchImpl(`${platformBase()}/public/pods`, { signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new PlatformApiError(`public/pods ${res.status}: ${body.slice(0, 200)}`, 'resolve-pod', res.status)
  }
  const json = (await res.json()) as { data?: { pods?: unknown[] }; pods?: unknown[] }
  const rows = json.data?.pods ?? json.pods ?? []
  let found: string | undefined
  for (const r of rows) {
    const p = r as { id?: unknown; tokenId?: unknown }
    if (p.tokenId === undefined || p.tokenId === null || typeof p.id !== 'string') continue
    const tid = String(p.tokenId)
    cache?.set(tid, p.id)
    if (tid === tokenId) found = p.id
  }
  if (!found) {
    // The pod is on-chain (we just voted on it) but the platform has no row for it —
    // the same class of failure as an unregistered mint, seen from the voter's side.
    // Reported, never guessed: posting the tokenId anyway is what produced the 404s.
    throw new PlatformApiError(
      `no platform pod for on-chain tokenId ${tokenId} in ${rows.length} public pods — the pod exists on-chain but was never registered with the platform`,
      'resolve-pod',
      undefined,
      'POD_NOT_INDEXED',
    )
  }
  return found
}

/** POST /agents/:agentId/pods/:podId/votes — index an on-chain vote for display.
 *  `podCuid` MUST be the platform pod id (see resolvePodCuid), not the on-chain tokenId.
 *  Non-fatal: a failed call never invalidates the on-chain result.
 *  Retries once on 5xx / 429 (transient errors) after a 2-second pause. */
export async function registerVoteOnPlatform(
  agentId: string,
  podId: string,
  txHash: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  delayMs = 2_000,
): Promise<string> {
  const attempt = async (): Promise<Response> => {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      return await fetchImpl(
        `${platformBase()}/agents/${encodeURIComponent(agentId)}/pods/${encodeURIComponent(podId)}/votes`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ txHash }),
          signal: ctrl.signal,
        },
      )
    } finally {
      clearTimeout(t)
    }
  }

  let res = await attempt()
  if (res.status >= 500 || res.status === 429) {
    await new Promise<void>((r) => setTimeout(r, delayMs))
    res = await attempt()
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new PlatformApiError(`platform registerVote ${res.status}: ${body.slice(0, 200)}`, 'register', res.status)
  }
  const json = (await res.json()) as { data?: { id?: string } }
  return json.data?.id ?? ''
}

/** PATCH /agents/:agentId — update the agent's platform profile (name/description/thumbnail).
 *  Docs: https://docs.reppo.ai/api/agent/custom-agents#update-an-agent
 *  Auth: the apiKey minted at registration. Throws on any non-2xx so the caller can
 *  decide whether the failure is fatal (it never is for the node — name sync is cosmetic). */
export async function updateAgentOnPlatform(
  agentId: string,
  // isOrquestra: platform-side attribution of orquestra traffic (accepted on the edit
  // endpoint since 2026-07). PATCHed true on every node start — see markAgentAsOrquestra.
  patch: { name?: string; description?: string; thumbnailURL?: string; isOrquestra?: boolean },
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetchImpl(`${platformBase()}/agents/${encodeURIComponent(agentId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(patch),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`platform updateAgent ${res.status}: ${body.slice(0, 200)}`)
    }
  } finally {
    clearTimeout(t)
  }
}
