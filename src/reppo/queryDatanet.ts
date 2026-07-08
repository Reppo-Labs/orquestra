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
    const metaObj = meta != null && typeof meta === 'object' ? (meta as Record<string, unknown>) : {}
    const metaEmpty = Object.keys(metaObj).length === 0
    if (hasId && metaEmpty && o['subnetDescription'] == null && o['onboardingVoters'] == null) {
      throw new Error(`INTERNAL_ERROR: datanet ${datanetId} metadata absent from CLI response (transient RPC?)`)
    }
    // Partial multicall: a `metadata` object comes back with SOME keys, but every content
    // field is empty (a degraded read that resolved the id + shape but not the strings). This
    // slips past the metaEmpty check above yet still throws a PERMANENT-looking "carries no
    // goal…" downstream. A real datanet always carries at least a description/goal, so treat
    // all-empty content as transient. Fields are checked in BOTH shapes (nested wins for 0.7.0+,
    // flat for older platforms) to mirror parseDatanetRubric's merge.
    const content = (k: string, legacy?: string): boolean => {
      const v = metaObj[k] ?? o[legacy ?? k]
      return typeof v === 'string' && v.trim() !== ''
    }
    if (!metaEmpty && hasId
      && !content('description', 'subnetDescription')
      && !content('onboardingVoters')
      && !content('onboardingPublishers')) {
      throw new Error(`INTERNAL_ERROR: datanet ${datanetId} metadata content empty in CLI response (transient RPC?)`)
    }
  }
  return parsed
}

export type DatanetJsonFetcher = (datanetId: string) => Promise<unknown>
