// src/reppo/cli.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { reppoEnv, withRpcUrl } from './exec.js'

const execFileAsync = promisify(execFile)

export interface VoteArgs { podId: string; direction: 'up' | 'down'; votes: number; idempotencyKey: string }
export interface LockArgs { amountReppo: number; durationSeconds: number; idempotencyKey: string }
export interface MintArgs {
  datanetId: string; subnetUuid: string; podName: string; podDescription: string; datasetPath: string; idempotencyKey: string
  /** human-viewable source page → mint-pod --url (optional). */
  url?: string
  /** pod card image → mint-pod --image-url (optional). */
  imageUrl?: string
}
export interface ClaimEmissionsArgs { podId: string; epoch: number; idempotencyKey: string }
/** Result of an on-chain action: tx hash + gas spent (ETH), parsed from the CLI's --json output. */
export interface ChainResult {
  txHash: string
  gasEth: number
  /** actual REPPO paid (mint fee / grant fee), reported by reppo >=0.8.4. */
  reppoFee?: number
}

/** The signing surface. Injected into WalletExecutor; the default shells out to `reppo`. */
export interface ReppoCli {
  lock(args: LockArgs): Promise<ChainResult>
  vote(args: VoteArgs): Promise<ChainResult>
  mintPod(args: MintArgs): Promise<ChainResult>
  claimEmissions(args: ClaimEmissionsArgs): Promise<ChainResult>
  /** One-time access grant — prerequisite for voting/minting. Keyed by the integer datanet id. */
  grantAccess(datanetId: string): Promise<ChainResult>
}

import { redactSecrets } from '../util/redact.js'

let warnedNoGas = false
/** test hook: reset the warn-once latch. */
export function resetWarnedNoGas(): void { warnedNoGas = false }

/** Fold an execFile rejection into one redacted, cause-bearing Error.
 *  execFile's `.message` is just "Command failed: <cmd>" — the real reppo error
 *  is on stderr/stdout, so both streams are folded in; the command line itself
 *  carries `--rpc-url https://...v2/<api-key>`, so the result is redacted. */
export function foldExecError(e: unknown): Error {
  const err = e as { message?: string; stdout?: string; stderr?: string }
  const head = (err.message ?? String(e)).split('\n')[0]
  const body = [err.stdout, err.stderr].map((s) => (s ?? '').toString().trim()).filter(Boolean).join(' | ')
  return new Error(redactSecrets(body ? `${head} — ${body}` : head))
}

/** Parse a reppo --json stdout into a ChainResult. Warns once per process when
 *  the CLI omits gasEth (reppo 0.8.0 reports only txHash) — structural, not
 *  per-call, so it must not spam every transaction. */
export function parseChainResult(stdout: string, warn: (m: string) => void = (m) => console.warn(m)): ChainResult {
  const j = JSON.parse(stdout) as { txHash?: string; tx?: string; gasEth?: number; reppoFee?: number | string }
  if (j.gasEth === undefined && !warnedNoGas) {
    warnedNoGas = true
    warn('reppo CLI reports no gasEth (0.8.0 omits it); recording 0 — gas caps under-count until the CLI adds it')
  }
  const fee = j.reppoFee !== undefined ? Number(j.reppoFee) : undefined
  return { txHash: j.txHash ?? j.tx ?? '', gasEth: Number(j.gasEth ?? 0), ...(fee !== undefined && !Number.isNaN(fee) ? { reppoFee: fee } : {}) }
}

async function run(args: string[]): Promise<ChainResult> {
  let stdout: string
  try {
    ({ stdout } = await execFileAsync('reppo', withRpcUrl([...args, '--json']), {
      env: reppoEnv(),
      timeout: 120_000,
    }))
  } catch (e) {
    throw foldExecError(e)
  }
  return parseChainResult(stdout)
}

/** Default CLI-backed signer. Exact sub-flags (e.g. mint metadata flags, vote
 *  direction encoding) are confirmed against `reppo --help` at integration. */
export const defaultReppoCli: ReppoCli = {
  lock: (a) => run(['lock', '--duration', String(a.durationSeconds), '--idempotency-key', a.idempotencyKey, String(a.amountReppo)]),
  // reppo 0.8.0 vote: `--like`/`--dislike` (not `--direction`) + a required `--votes <n>`
  // weight. We weight by the scorer's conviction (1-10), bounded well within voting power.
  vote: (a) => run(['vote', '--pod', a.podId, a.direction === 'up' ? '--like' : '--dislike', '--votes', String(a.votes), '--idempotency-key', a.idempotencyKey]),
  mintPod: (a) => run([
    'mint-pod', '--datanet', a.datanetId, '--subnet-uuid', a.subnetUuid,
    '--pod-name', a.podName, '--pod-description', a.podDescription,
    '--dataset', a.datasetPath, '--idempotency-key', a.idempotencyKey, '--agree-to-terms',
    ...(a.url ? ['--url', a.url] : []),
    ...(a.imageUrl ? ['--image-url', a.imageUrl] : []),
  ]),
  claimEmissions: (a) => run(['claim-emissions', '--pod', a.podId, '--epoch', String(a.epoch), '--idempotency-key', a.idempotencyKey]),
  grantAccess: (datanetId) => run(['grant-access', '--datanet', datanetId]),
}
