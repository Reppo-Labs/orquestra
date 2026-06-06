// src/reppo/listPods.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { VoterPod } from '../voter/types.js'
import { reppoEnv, withRpcUrl } from './exec.js'

const execFileAsync = promisify(execFile)

/** Map `reppo list pods --json` rows to VoterPods. description defaults to the
 *  pod name; the caller may enrich it with fetched IPFS content for scoring. */
export function parsePods(raw: unknown): VoterPod[] {
  const rows = (raw as { pods?: unknown[] })?.pods
  if (!Array.isArray(rows)) return []
  return rows.map((r) => {
    const p = r as Record<string, unknown>
    const name = String(p.name ?? '')
    return {
      podId: String(p.podId ?? p.id ?? ''),
      validityEpoch: String(p.validityEpoch ?? ''),
      name,
      description: name,
      url: typeof p.url === 'string' ? p.url : undefined,
    }
  }).filter((p) => p.podId !== '')
}

/** Current epoch = max validityEpoch across pods (string), or null if none. */
export function deriveCurrentEpoch(pods: VoterPod[]): string | null {
  let max: number | null = null
  for (const p of pods) {
    const e = Number(p.validityEpoch)
    if (Number.isFinite(e)) max = max === null ? e : Math.max(max, e)
  }
  return max === null ? null : String(max)
}

/** List pods via the reppo CLI. all=true → every published pod; false → this wallet's. */
export async function listPodsJson(datanetId: string, opts: { all: boolean }): Promise<VoterPod[]> {
  const args = ['list', 'pods', '--datanet', datanetId, '--json']
  if (opts.all) args.splice(2, 0, '--all')
  const { stdout } = await execFileAsync('reppo', withRpcUrl(args), {
    env: reppoEnv(), timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
  })
  try { return parsePods(JSON.parse(stdout)) } catch { throw new Error(`listPodsJson: bad reppo output: ${stdout.slice(0, 200)}`) }
}
