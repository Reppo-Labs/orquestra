// src/reppo/cli.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface VoteArgs { podId: string; direction: 'up' | 'down'; idempotencyKey: string }
export interface LockArgs { amountReppo: number; durationSeconds: number; idempotencyKey: string }
export interface MintArgs {
  datanetId: string; podName: string; podDescription: string; datasetPath: string; idempotencyKey: string
}
/** Result of an on-chain action: tx hash + gas spent (ETH), parsed from the CLI's --json output. */
export interface ChainResult { txHash: string; gasEth: number }

/** The signing surface. Injected into WalletExecutor; the default shells out to `reppo`. */
export interface ReppoCli {
  lock(args: LockArgs): Promise<ChainResult>
  vote(args: VoteArgs): Promise<ChainResult>
  mintPod(args: MintArgs): Promise<ChainResult>
}

async function run(args: string[]): Promise<ChainResult> {
  const { stdout } = await execFileAsync('reppo', [...args, '--json'], {
    env: { ...process.env, REPPO_NETWORK: process.env.REPPO_NETWORK ?? 'mainnet' },
    timeout: 120_000,
  })
  const j = JSON.parse(stdout) as { txHash?: string; tx?: string; gasEth?: number }
  return { txHash: j.txHash ?? j.tx ?? '', gasEth: Number(j.gasEth ?? 0) }
}

/** Default CLI-backed signer. Exact sub-flags (e.g. mint metadata flags, vote
 *  direction encoding) are confirmed against `reppo --help` at integration. */
export const defaultReppoCli: ReppoCli = {
  lock: (a) => run(['lock', '--duration', String(a.durationSeconds), '--idempotency-key', a.idempotencyKey, String(a.amountReppo)]),
  vote: (a) => run(['vote', '--pod', a.podId, '--direction', a.direction, '--idempotency-key', a.idempotencyKey]),
  mintPod: (a) => run(['mint-pod', '--datanet', a.datanetId, '--pod-name', a.podName, '--pod-description', a.podDescription, '--dataset', a.datasetPath, '--idempotency-key', a.idempotencyKey, '--agree-to-terms']),
}
