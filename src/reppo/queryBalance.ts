// src/reppo/queryBalance.ts
import { runReppoStdout } from './exec.js'


export interface WalletBalance {
  eth: number
  reppo: number
  veReppo: number
  usdc: number
}

const toFinite = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

const tokenNum = (token: unknown): number => {
  const t = token as Record<string, unknown> | undefined
  if (!t || typeof t !== 'object') return 0
  return toFinite(t.formatted)
}

/** Pure: extract WalletBalance from the raw `reppo query balance --json` output. */
export function parseBalance(raw: unknown): WalletBalance {
  const b = (raw as Record<string, unknown>)?.balances as Record<string, unknown> | undefined
  if (!b || typeof b !== 'object') return { eth: 0, reppo: 0, veReppo: 0, usdc: 0 }
  return {
    eth: tokenNum(b.eth),
    reppo: tokenNum(b.reppo),
    veReppo: tokenNum(b.veReppo),
    usdc: tokenNum(b.usdc),
  }
}

/** Live wallet balances via `reppo query balance --json`. */
export async function queryBalanceJson(): Promise<WalletBalance> {
  const stdout = await runReppoStdout(['query', 'balance', '--json'])
  try {
    return parseBalance(JSON.parse(stdout))
  } catch {
    throw new Error(`queryBalanceJson: could not parse reppo CLI output: ${stdout.slice(0, 200)}`)
  }
}
