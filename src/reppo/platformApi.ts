// src/reppo/platformApi.ts
// Reppo platform REST API — distinct from on-chain CLI.
// All functions are fire-and-forget-safe: callers catch and log on failure.

const BASE = 'https://reppo.ai/api/v1'

/** POST /agents/:agentId/pods/:podId/votes — index an on-chain vote for display.
 *  Non-fatal: a failed call never invalidates the on-chain result. */
export async function registerVoteOnPlatform(
  agentId: string,
  podId: string,
  txHash: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(
    `${BASE}/agents/${encodeURIComponent(agentId)}/pods/${encodeURIComponent(podId)}/votes`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ txHash }),
    },
  )
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`platform registerVote ${res.status}: ${body.slice(0, 200)}`)
  }
  const json = (await res.json()) as { data?: { id?: string } }
  return json.data?.id ?? ''
}
