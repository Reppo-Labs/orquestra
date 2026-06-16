// src/reppo/cli.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { reppoEnv, withRpcUrl } from './exec.js'

const execFileAsync = promisify(execFile)

export interface VoteArgs { podId: string; direction: 'up' | 'down'; votes: number; idempotencyKey: string }
export interface LockArgs { amountReppo: number; durationSeconds: number; idempotencyKey: string }
export interface MintArgs {
  datanetId: string; subnetUuid: string; podName: string; podDescription: string; idempotencyKey: string
  /** local dataset file to pin to IPFS (needs PINATA_JWT). Omitted for url-only mints. */
  datasetPath?: string
  /** human-viewable source page → mint-pod --url. Required when datasetPath is omitted. */
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
  /** The token an access fee was paid in (reppo >=0.8.5 grant-access result). Present on
   *  non-REPPO grants — informational (the fee is consent-bounded, not budget-gated). */
  feeToken?: { symbol: string; address: string; decimals: number }
  /** On-chain fee QUOTE, human-formatted (e.g. "50"), from the grant-access result. Kept as
   *  a STRING — Number()-ing it would lose precision and silently turn '' into 0. */
  feeAmount?: string
  /** Receipt-derived ACTUAL fee paid (string), from the grant-access result. Prefer this over
   *  the quote when present. */
  feePaid?: string
}

/** Token choice for an access grant. 'reppo' is the default (byte-identical to the
 *  pre-0.8.5 call — no flag added). 'primary' pays in the datanet's primary token. */
export interface GrantAccessOpts { token?: 'reppo' | 'primary' }

/** The signing surface. Injected into WalletExecutor; the default shells out to `reppo`. */
export interface ReppoCli {
  lock(args: LockArgs): Promise<ChainResult>
  vote(args: VoteArgs): Promise<ChainResult>
  mintPod(args: MintArgs): Promise<ChainResult>
  claimEmissions(args: ClaimEmissionsArgs): Promise<ChainResult>
  /** One-time access grant — prerequisite for voting/minting. Keyed by the integer datanet id.
   *  `opts.token` defaults to 'reppo' (existing path); 'primary' pays the fee in the
   *  datanet's primary token via `grant-access --token primary` (reppo >=0.8.5). */
  grantAccess(datanetId: string, opts?: GrantAccessOpts): Promise<ChainResult>
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
  const j = JSON.parse(stdout) as {
    txHash?: string; tx?: string; gasEth?: number; reppoFee?: number | string
    // grant-access >=0.8.5 (best-effort; absent on vote/mint/claim results):
    feeToken?: { symbol?: string; address?: string; decimals?: number }
    feeAmount?: { raw?: string; formatted?: string } | number | string
    feePaid?: string
  }
  if (j.gasEth === undefined && !warnedNoGas) {
    warnedNoGas = true
    warn('reppo CLI reports no gasEth (0.8.0 omits it); recording 0 — gas caps under-count until the CLI adds it')
  }
  const fee = j.reppoFee !== undefined ? Number(j.reppoFee) : undefined
  return {
    txHash: j.txHash ?? j.tx ?? '',
    gasEth: Number(j.gasEth ?? 0),
    ...(fee !== undefined && !Number.isNaN(fee) ? { reppoFee: fee } : {}),
    ...parseGrantFee(j),
  }
}

/** Best-effort extract of the access-fee fields from a grant-access >=0.8.5 result.
 *  Returns {} when absent so vote/mint/claim parsing is unaffected. */
function parseGrantFee(j: {
  feeToken?: { symbol?: string; address?: string; decimals?: number }
  feeAmount?: { raw?: string; formatted?: string } | number | string
  feePaid?: string
}): Partial<Pick<ChainResult, 'feeToken' | 'feeAmount' | 'feePaid'>> {
  const out: Partial<Pick<ChainResult, 'feeToken' | 'feeAmount' | 'feePaid'>> = {}
  if (j.feeToken && typeof j.feeToken === 'object' && j.feeToken.address) {
    out.feeToken = {
      symbol: String(j.feeToken.symbol ?? ''),
      address: String(j.feeToken.address),
      decimals: Number(j.feeToken.decimals ?? 0),
    }
  }
  if (j.feeAmount !== undefined) {
    // Keep the formatted value as a STRING — Number()-ing it loses precision and turns ''
    // into 0. The grant fee is informational (consent-bounded), so a string is all we need.
    const v = typeof j.feeAmount === 'object' ? (j.feeAmount.formatted ?? j.feeAmount.raw) : j.feeAmount
    if (v !== undefined) out.feeAmount = String(v)
  }
  if (typeof j.feePaid === 'string') out.feePaid = j.feePaid
  return out
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
  // --dataset pins to IPFS (needs PINATA_JWT); omitted for url-only mints, where
  // --url alone is the pod content. mint-pod requires one of them — guarded upstream.
  mintPod: (a) => run([
    'mint-pod', '--datanet', a.datanetId, '--subnet-uuid', a.subnetUuid,
    '--pod-name', a.podName, '--pod-description', a.podDescription,
    '--idempotency-key', a.idempotencyKey, '--agree-to-terms',
    ...(a.datasetPath ? ['--dataset', a.datasetPath] : []),
    ...(a.url ? ['--url', a.url] : []),
    ...(a.imageUrl ? ['--image-url', a.imageUrl] : []),
  ]),
  claimEmissions: (a) => run(['claim-emissions', '--pod', a.podId, '--epoch', String(a.epoch), '--idempotency-key', a.idempotencyKey]),
  // 'reppo' (default) is byte-identical to the pre-0.8.5 call — no --token flag added.
  // 'primary' pays the datanet's primary-token access fee (reppo >=0.8.5; gated upstream
  // on the CLI version so an older CLI never sees the unknown flag).
  grantAccess: (datanetId, opts) => run([
    'grant-access', '--datanet', datanetId,
    ...(opts?.token === 'primary' ? ['--token', 'primary'] : []),
  ]),
}
