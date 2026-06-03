// src/reppo/listDatanets.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface DatanetSummary {
  id: string
  name: string
  status: string
  description: string
  accessFeeReppo: number
  emissionsPerEpochReppo: number
  upVoteVolume: number
  downVoteVolume: number
}

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

/** Map `reppo list datanets --json` into compact summaries for the onboarding agent. */
export function parseDatanetList(raw: unknown): DatanetSummary[] {
  const rows = (raw as { datanets?: unknown[] })?.datanets
  if (!Array.isArray(rows)) return []
  return rows.map((r) => {
    const d = r as Record<string, unknown>
    return {
      id: String(d.id ?? d.tokenId ?? ''),
      name: String(d.name ?? d.subnetName ?? `datanet ${String(d.id ?? '')}`),
      status: String(d.status ?? 'UNKNOWN'),
      description: String(d.subnetDescription ?? d.description ?? '').trim(),
      accessFeeReppo: num(d.accessFeeREPPO),
      emissionsPerEpochReppo: num(d.emissionsPerEpochREPPO),
      upVoteVolume: num(d.upVoteVolume),
      downVoteVolume: num(d.downVoteVolume),
    }
  }).filter((d) => d.id !== '')
}

/** Live catalog via the reppo CLI. */
export async function listDatanetsJson(): Promise<DatanetSummary[]> {
  const { stdout } = await execFileAsync('reppo', ['list', 'datanets', '--status', 'ACTIVE', '--json'], {
    env: { ...process.env, REPPO_NETWORK: process.env.REPPO_NETWORK ?? 'mainnet' }, timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
  })
  return parseDatanetList(JSON.parse(stdout))
}
