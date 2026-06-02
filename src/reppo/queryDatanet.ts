// src/reppo/queryDatanet.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Fetch a datanet's metadata JSON via the reppo CLI (>=0.7.0).
 *  Requires `reppo` on PATH and REPPO_NETWORK in env (default mainnet). */
export async function queryDatanetJson(datanetId: string): Promise<unknown> {
  const { stdout } = await execFileAsync(
    'reppo',
    ['query', 'datanet', datanetId, '--json'],
    { env: { ...process.env, REPPO_NETWORK: process.env.REPPO_NETWORK ?? 'mainnet' }, timeout: 60_000 },
  )
  return JSON.parse(stdout)
}

export type DatanetJsonFetcher = (datanetId: string) => Promise<unknown>
