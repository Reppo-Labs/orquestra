// src/reppo/cli.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { reppoEnv, withRpcUrl } from './exec.js'

const execFileAsync = promisify(execFile)

export interface VoteArgs { podId: string; direction: 'up' | 'down'; votes: number; idempotencyKey: string }
export interface LockArgs { amountReppo: number; durationSeconds: number; idempotencyKey: string }
export interface MintArgs {
  datanetId: string; subnetUuid: string; podName: string; podDescription: string; datasetPath: string; idempotencyKey: string
}
export interface ClaimEmissionsArgs { podId: string; epoch: number; idempotencyKey: string }
/** Result of an on-chain action: tx hash + gas spent (ETH), parsed from the CLI's --json output. */
export interface ChainResult { txHash: string; gasEth: number }

/** The signing surface. Injected into WalletExecutor; the default shells out to `reppo`. */
export interface ReppoCli {
  lock(args: LockArgs): Promise<ChainResult>
  vote(args: VoteArgs): Promise<ChainResult>
  mintPod(args: MintArgs): Promise<ChainResult>
  claimEmissions(args: ClaimEmissionsArgs): Promise<ChainResult>
  /** One-time access grant — prerequisite for voting/minting. Keyed by the integer datanet id. */
  grantAccess(datanetId: string): Promise<ChainResult>
}

async function run(args: string[]): Promise<ChainResult> {
  let stdout: string
  try {
    ({ stdout } = await execFileAsync('reppo', withRpcUrl([...args, '--json']), {
      env: reppoEnv(),
      timeout: 120_000,
    }))
  } catch (e) {
    // execFile rejects with an error carrying `stdout`/`stderr`, but its `.message` is just
    // "Command failed: <cmd>" — so a reppo failure written to stderr (e.g. vote errors)
    // surfaces as a BLANK reason. Fold both streams into the thrown message so the activity
    // log records the real cause instead of an empty "Command failed".
    const err = e as { message?: string; stdout?: string; stderr?: string }
    const head = (err.message ?? String(e)).split('\n')[0]
    const body = [err.stdout, err.stderr].map((s) => (s ?? '').toString().trim()).filter(Boolean).join(' | ')
    throw new Error(body ? `${head} — ${body}` : head)
  }
  const j = JSON.parse(stdout) as { txHash?: string; tx?: string; gasEth?: number }
  if (j.gasEth === undefined) {
    console.warn('reppo CLI returned no gasEth; recording 0 — gas caps may under-count')
  }
  return { txHash: j.txHash ?? j.tx ?? '', gasEth: Number(j.gasEth ?? 0) }
}

/** Default CLI-backed signer. Exact sub-flags (e.g. mint metadata flags, vote
 *  direction encoding) are confirmed against `reppo --help` at integration. */
export const defaultReppoCli: ReppoCli = {
  lock: (a) => run(['lock', '--duration', String(a.durationSeconds), '--idempotency-key', a.idempotencyKey, String(a.amountReppo)]),
  // reppo 0.8.0 vote: `--like`/`--dislike` (not `--direction`) + a required `--votes <n>`
  // weight. We weight by the scorer's conviction (1-10), bounded well within voting power.
  vote: (a) => run(['vote', '--pod', a.podId, a.direction === 'up' ? '--like' : '--dislike', '--votes', String(a.votes), '--idempotency-key', a.idempotencyKey]),
  mintPod: (a) => run(['mint-pod', '--datanet', a.datanetId, '--subnet-uuid', a.subnetUuid, '--pod-name', a.podName, '--pod-description', a.podDescription, '--dataset', a.datasetPath, '--idempotency-key', a.idempotencyKey, '--agree-to-terms']),
  claimEmissions: (a) => run(['claim-emissions', '--pod', a.podId, '--epoch', String(a.epoch), '--idempotency-key', a.idempotencyKey]),
  grantAccess: (datanetId) => run(['grant-access', '--datanet', datanetId]),
}
