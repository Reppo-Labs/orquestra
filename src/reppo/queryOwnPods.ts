// src/reppo/queryOwnPods.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { reppoEnv, withRpcUrl } from './exec.js'
import type { OwnPodVote } from '../dashboard/earnStatus.js'

const execFileAsync = promisify(execFile)
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

/** Live: our own pods (no --all = this wallet's) with current vote tallies. */
export async function queryOwnPodVotes(datanetId: string): Promise<OwnPodVote[]> {
  const { stdout } = await execFileAsync('reppo', withRpcUrl(['list', 'pods', '--datanet', datanetId, '--json']), {
    env: reppoEnv(), timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
  })
  try {
    return parseOwnPodVotes(JSON.parse(stdout))
  } catch {
    throw new Error(`queryOwnPodVotes: bad reppo output: ${stdout.slice(0, 200)}`)
  }
}
