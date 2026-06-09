// src/reppo/queryEpoch.ts
import { runReppoStdout } from './exec.js'


export interface EpochInfo {
  epoch: number
  epochStart: number // unix seconds
  epochDurationSeconds: number
  secondsRemaining: number
}

const toFinite = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

/** Pure: extract the current-epoch info from `reppo query epoch --json` (>=0.8.0). */
export function parseEpoch(raw: unknown): EpochInfo {
  const d = (raw as Record<string, unknown>) ?? {}
  return {
    epoch: toFinite(d.epoch),
    epochStart: toFinite(d.epochStart),
    epochDurationSeconds: toFinite(d.epochDurationSeconds),
    secondsRemaining: toFinite(d.secondsRemaining),
  }
}

/** Authoritative current on-chain epoch via the reppo CLI (read from the contracts). */
export async function queryEpochJson(): Promise<EpochInfo> {
  const stdout = await runReppoStdout(['query', 'epoch', '--json'])
  try { return parseEpoch(JSON.parse(stdout)) } catch { throw new Error(`queryEpochJson: bad reppo output: ${stdout.slice(0, 200)}`) }
}
