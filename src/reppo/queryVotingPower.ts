// src/reppo/queryVotingPower.ts
import { runReppoStdout } from './exec.js'


export interface VotingPower { power: number; lockupCount: number }

const toFinite = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const formattedNum = (v: unknown): number => {
  if (v && typeof v === 'object' && 'formatted' in (v as Record<string, unknown>)) return toFinite((v as Record<string, unknown>).formatted)
  return toFinite(v)
}

/** Pure: extract VotingPower from `reppo query voting-power --json`. */
export function parseVotingPower(raw: unknown): VotingPower {
  const d = (raw as Record<string, unknown>) ?? {}
  return { power: formattedNum(d?.votingPower ?? d?.power), lockupCount: toFinite(d?.lockupCount) }
}

export async function queryVotingPowerJson(): Promise<VotingPower> {
  const stdout = await runReppoStdout(['query', 'voting-power', '--json'])
  try { return parseVotingPower(JSON.parse(stdout)) } catch { throw new Error(`queryVotingPowerJson: bad reppo output: ${stdout.slice(0, 200)}`) }
}
