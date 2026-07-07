// src/reppo/listPods.ts
import type { VoterPod } from '../voter/types.js'
import { runReppoStdout } from './exec.js'


/** Map `reppo list pods --json` rows to VoterPods. Prefer the CLI's `description`
 *  (the full pod writeup — reppo-cli >=0.12 surfaces it in `--all`); fall back to the
 *  pod name only when it's absent/empty (older CLI, or a datanet with no writeup). The
 *  caller may still enrich further with fetched `url` content for scoring. */
export function parsePods(raw: unknown): VoterPod[] {
  const rows = (raw as { pods?: unknown[] })?.pods
  if (!Array.isArray(rows)) return []
  return rows.map((r) => {
    const p = r as Record<string, unknown>
    const name = String(p.name ?? '')
    const desc = typeof p.description === 'string' ? p.description.trim() : ''
    return {
      podId: String(p.podId ?? p.id ?? ''),
      validityEpoch: String(p.validityEpoch ?? ''),
      name,
      // Real writeup when the CLI provides one; else the title (enrichment may extend it).
      description: desc || name,
      url: typeof p.url === 'string' ? p.url : undefined,
      // NOTE: the CLI row's `mediaUrl` (thumbnail/image pointer) is deliberately NOT
      // mapped. VoterPod.mediaUrl means "detected VIDEO to ingest via Gemini" (set by
      // the enrichment loop's Content-Type probe) — mapping image thumbnails into it
      // routed every thumbnail-bearing pod to video ingest, which then failed scoring
      // trying to ingest JPEGs (regression in the pod-description change).
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
  const stdout = await runReppoStdout(args)
  try { return parsePods(JSON.parse(stdout)) } catch { throw new Error(`listPodsJson: bad reppo output: ${stdout.slice(0, 200)}`) }
}
