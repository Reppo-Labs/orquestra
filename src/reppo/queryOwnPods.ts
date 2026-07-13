// src/reppo/queryOwnPods.ts
import { runReppoStdout } from './exec.js'

/** Per-pod vote tallies for our own pods (leading earn signal — emissions follow votes).
 *  Defined here (the query that produces it); consumers import it from reader.ts. */
export interface OwnPodVote { podId: string; name: string; validityEpoch: string; upVotes: number; downVotes: number }

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

/** Pure: extract our pods' vote tallies from `reppo list pods --datanet <id> --json`.
 *  Unlike parsePods (voting path), this keeps up/down votes — the leading earn signal. */
export function parseOwnPodVotes(raw: unknown): OwnPodVote[] {
  const rows = (raw as { pods?: unknown[] })?.pods
  if (!Array.isArray(rows)) return []
  return rows
    .map((r) => {
      const p = r as Record<string, unknown>
      return {
        podId: String(p.podId ?? p.id ?? ''),
        name: String(p.name ?? ''),
        validityEpoch: String(p.validityEpoch ?? ''),
        upVotes: num(p.upVotes),
        downVotes: num(p.downVotes),
      }
    })
    .filter((p) => p.podId !== '')
}

/** Live: ALL pods on a datanet with current vote tallies. Uses --all and matches our
 *  pods by recorded mint name (see selectOurPods), because the on-chain `creator` field
 *  is empty so the CLI's "own pods" filter returns nothing. */
export async function queryDatanetPodVotes(datanetId: string): Promise<OwnPodVote[]> {
  const stdout = await runReppoStdout(['list', 'pods', '--datanet', datanetId, '--all', '--json'], 90_000)
  try {
    return parseOwnPodVotes(JSON.parse(stdout))
  } catch {
    throw new Error(`queryDatanetPodVotes: bad reppo output: ${stdout.slice(0, 200)}`)
  }
}
