// src/reppo/queryEmissionsDue.ts
import { runReppoStdout } from './exec.js'


export interface ClaimableEmission { podId: string; datanetId: string; epoch: number; reppo: number }
export interface EmissionsDue { totalReppo: number; pods: ClaimableEmission[] }

const toFinite = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
/** Amount may be a nested {raw,formatted} object or a plain number/string. */
const amountReppo = (a: unknown): number => {
  if (a && typeof a === 'object' && 'formatted' in (a as Record<string, unknown>)) return toFinite((a as Record<string, unknown>).formatted)
  return toFinite(a)
}

/** Pure: extract claimable emissions from `reppo query emissions-due --json`. */
export function parseEmissionsDue(raw: unknown): EmissionsDue {
  const rows = (raw as { emissions?: unknown[] })?.emissions
  if (!Array.isArray(rows)) return { totalReppo: 0, pods: [] }
  const pods: ClaimableEmission[] = []
  for (const r of rows) {
    const d = r as Record<string, unknown>
    const podId = String(d.podId ?? d.pod ?? '')
    if (podId === '') continue
    pods.push({
      podId,
      datanetId: String(d.datanetId ?? d.subnetId ?? ''),
      epoch: toFinite(d.epoch),
      reppo: amountReppo(d.amount ?? d.reppo),
    })
  }
  return { totalReppo: pods.reduce((s, p) => s + p.reppo, 0), pods }
}

/** Live unclaimed emissions across our pods via the reppo CLI. */
export async function queryEmissionsDueJson(): Promise<EmissionsDue> {
  const stdout = await runReppoStdout(['query', 'emissions-due', '--json'])
  try { return parseEmissionsDue(JSON.parse(stdout)) } catch { throw new Error(`queryEmissionsDueJson: bad reppo output: ${stdout.slice(0, 200)}`) }
}
