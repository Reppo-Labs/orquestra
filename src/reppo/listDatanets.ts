// src/reppo/listDatanets.ts
import { runReppoStdout } from './exec.js'
import { REPPO_TOKEN_MAINNET } from './mintFee.js'

/** Case-insensitive EVM address compare (mirrors rubric/parse.ts). */
const eqAddr = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

export interface NativeToken { symbol: string; address: string; decimals: number }

export interface DatanetSummary {
  id: string
  name: string
  status: string
  description: string
  accessFeeReppo: number
  emissionsPerEpochReppo: number
  /** Present when the datanet emits a non-REPPO token (e.g. LBM for Litebeam).
   *  emissionsPerEpochReppo will be 0 in this case. */
  nativeToken?: NativeToken
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
    const nt = d.nativeToken as Record<string, unknown> | undefined
    const ntSymbol = String(nt?.symbol ?? '').trim()
    const ntAddress = String(nt?.address ?? '').trim()
    // REPPO-vs-native decision keys off the ADDRESS, never the symbol — mirrors rubric/parse.ts.
    // A non-REPPO datanet with a blank/missing catalog symbol must still be detected (symbol
    // falls back to '?'); a REPPO datanet mislabeled with another symbol must NOT surface.
    const nativeToken: NativeToken | undefined = (ntAddress && !eqAddr(ntAddress, REPPO_TOKEN_MAINNET))
      ? { symbol: ntSymbol || '?', address: ntAddress, decimals: num(nt?.decimals) }
      : undefined
    return {
      id: String(d.id ?? d.tokenId ?? ''),
      name: String(d.name ?? d.subnetName ?? `datanet ${String(d.id ?? '')}`),
      status: String(d.status ?? 'UNKNOWN'),
      description: String(d.subnetDescription ?? d.description ?? '').trim(),
      accessFeeReppo: num(d.accessFeeREPPO),
      emissionsPerEpochReppo: num(d.emissionsPerEpochREPPO),
      nativeToken,
      upVoteVolume: num(d.upVoteVolume),
      downVoteVolume: num(d.downVoteVolume),
    }
  }).filter((d) => d.id !== '')
}

/** Live catalog via the reppo CLI. */
export async function listDatanetsJson(): Promise<DatanetSummary[]> {
  const stdout = await runReppoStdout(['list', 'datanets', '--status', 'ACTIVE', '--json'])
  try {
    return parseDatanetList(JSON.parse(stdout))
  } catch {
    throw new Error(`listDatanetsJson: could not parse reppo CLI output: ${stdout.slice(0, 200)}`)
  }
}
