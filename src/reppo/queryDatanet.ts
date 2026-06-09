// src/reppo/queryDatanet.ts
import { runReppoStdout } from './exec.js'

/** Fetch a datanet's metadata JSON via the reppo CLI (>=0.7.0).
 *  Requires `reppo` on PATH and REPPO_NETWORK in env (default mainnet). */
export async function queryDatanetJson(datanetId: string): Promise<unknown> {
  return JSON.parse(await runReppoStdout(['query', 'datanet', datanetId, '--json']))
}

export type DatanetJsonFetcher = (datanetId: string) => Promise<unknown>
