// src/reppo/platformApi.ts
// Reppo platform REST API — distinct from on-chain CLI.
// All functions are fire-and-forget-safe: callers catch and log on failure.

const BASE = 'https://reppo.ai/api/v1'
const TIMEOUT_MS = 15_000

/** POST /agents/:agentId/pods/:podId/votes — index an on-chain vote for display.
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
        `${BASE}/agents/${encodeURIComponent(agentId)}/pods/${encodeURIComponent(podId)}/votes`,
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
    throw new Error(`platform registerVote ${res.status}: ${body.slice(0, 200)}`)
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
  patch: { name?: string; description?: string; thumbnailURL?: string },
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetchImpl(`${BASE}/agents/${encodeURIComponent(agentId)}`, {
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
