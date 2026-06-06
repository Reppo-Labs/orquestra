// src/reppo/queryEpoch.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { reppoEnv, withRpcUrl } from './exec.js'

const execFileAsync = promisify(execFile)

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
  const { stdout } = await execFileAsync('reppo', withRpcUrl(['query', 'epoch', '--json']), {
    env: reppoEnv(), timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
  })
  try { return parseEpoch(JSON.parse(stdout)) } catch { throw new Error(`queryEpochJson: bad reppo output: ${stdout.slice(0, 200)}`) }
}
