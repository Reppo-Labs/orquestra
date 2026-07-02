// src/reppo/queryDatanet.ts
import { runReppoStdout } from './exec.js'

/** Fetch a datanet's metadata JSON via the reppo CLI (>=0.7.0).
 *  Requires `reppo` on PATH and REPPO_NETWORK in env (default mainnet).
 *
 *  A degraded RPC can make the CLI exit 0 with a PARTIAL body — an `{error}` object,
 *  or the datanetId echoed but `.metadata` absent (the metadata multicall failed while
 *  the id resolved). That slips past runReppoStdout's transient-retry net (exit 0, no
 *  error string) and would surface downstream as a PERMANENT-looking RubricUnavailableError
 *  ("carries no goal…"), indistinguishable from a genuinely empty datanet. Detect it here
 *  and throw an INTERNAL_ERROR-tagged message so runReppoStdout classifies it transient
 *  and retries, and the per-datanet skip breadcrumb reads as an RPC blip, not misconfig. */
export async function queryDatanetJson(datanetId: string): Promise<unknown> {
  const parsed = JSON.parse(await runReppoStdout(['query', 'datanet', datanetId, '--json']))
  const o = parsed as Record<string, unknown> | null
  if (o && typeof o === 'object') {
    if (o['error'] != null) {
      throw new Error(`INTERNAL_ERROR: datanet ${datanetId} query returned an error body (transient RPC?)`)
    }
    const hasId = o['datanetId'] != null || o['tokenId'] != null
    const meta = o['metadata']
    const metaEmpty = meta == null || (typeof meta === 'object' && Object.keys(meta as object).length === 0)
    if (hasId && metaEmpty && o['subnetDescription'] == null && o['onboardingVoters'] == null) {
      throw new Error(`INTERNAL_ERROR: datanet ${datanetId} metadata absent from CLI response (transient RPC?)`)
    }
  }
  return parsed
}

export type DatanetJsonFetcher = (datanetId: string) => Promise<unknown>
