// src/reppo/queryDatanet.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { reppoEnv, withRpcUrl } from './exec.js'

const execFileAsync = promisify(execFile)

/** Fetch a datanet's metadata JSON via the reppo CLI (>=0.7.0).
 *  Requires `reppo` on PATH and REPPO_NETWORK in env (default mainnet). */
export async function queryDatanetJson(datanetId: string): Promise<unknown> {
  const { stdout } = await execFileAsync(
    'reppo',
    withRpcUrl(['query', 'datanet', datanetId, '--json']),
    { env: reppoEnv(), timeout: 60_000 },
  )
  return JSON.parse(stdout)
}

export type DatanetJsonFetcher = (datanetId: string) => Promise<unknown>
