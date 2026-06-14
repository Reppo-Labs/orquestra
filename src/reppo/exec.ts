// src/reppo/exec.ts
// Shared helpers for shelling out to the `reppo` CLI. Centralizes the env
// (REPPO_NETWORK default), the optional --rpc-url flag, transient-error retry,
// and — critically — error redaction, so no CLI invocation can leak the rpc-url
// key in a thrown message.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { redactSecrets } from '../util/redact.js'

const execFileAsync = promisify(execFile)

/** Env for a `reppo` invocation: inherits process env, defaults REPPO_NETWORK to mainnet. */
export function reppoEnv(): NodeJS.ProcessEnv {
  return { ...process.env, REPPO_NETWORK: process.env.REPPO_NETWORK ?? 'mainnet' }
}

/** Append `--rpc-url <url>` when RPC_URL (or REPPO_RPC_URL) is set in env.
 *  The public Base RPC (mainnet.base.org) rate-limits under a full cycle's worth of
 *  datanet queries; pointing at a private RPC removes the per-datanet INTERNAL_ERROR
 *  skips. No env set → args unchanged (CLI falls back to its own default RPC). */
export function withRpcUrl(args: string[]): string[] {
  const url = (process.env.RPC_URL ?? process.env.REPPO_RPC_URL ?? '').trim()
  return url ? [...args, '--rpc-url', url] : args
}

// Transient failures worth retrying: the reppo public API (reppo.ai) and the RPC
// blip intermittently, and a single failed fetch otherwise skips a whole datanet
// for the cycle. Permanent errors (validation, CANNOT_VOTE_FOR_OWN_POD, bad args)
// do NOT match, so they fail fast instead of wasting retries.
const TRANSIENT = [
  /PUBLIC_API_UNREACHABLE/i,
  /fetch failed/i,
  /\bENOTFOUND\b/, /\bEAI_AGAIN\b/, /\bECONNRESET\b/, /\bETIMEDOUT\b/, /\bECONNREFUSED\b/,
  /socket hang up/i,
  /\bUND_ERR/i, // undici network errors
  /timed? ?out/i,
]

/** Is this reppo CLI failure a transient network/upstream blip (vs a permanent error)? */
export function isTransientReppoError(message: string): boolean {
  return TRANSIENT.some((re) => re.test(message))
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface RunReppoOpts {
  /** transient-error retries (attempts = retries + 1). Default 2. */
  retries?: number
  /** base backoff in ms (grows linearly: base, 2×base, …). Default 800. */
  backoffMs?: number
  /** injectable for tests: the single-attempt runner. */
  attempt?: (args: string[], timeoutMs: number) => Promise<string>
  /** injectable for tests: the backoff sleeper. */
  sleepFn?: (ms: number) => Promise<void>
}

/** One execFile attempt. Throws a REDACTED Error (execFile's message is the full
 *  command line, which carries the rpc-url key). */
async function execAttempt(args: string[], timeoutMs: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync('reppo', withRpcUrl(args), {
      env: reppoEnv(), timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
    })
    return stdout
  } catch (e) {
    const err = e as { message?: string; stdout?: string; stderr?: string }
    const head = (err.message ?? String(e)).split('\n')[0]
    const body = [err.stdout, err.stderr].map((s) => (s ?? '').toString().trim()).filter(Boolean).join(' | ')
    throw new Error(redactSecrets(body ? `${head} — ${body}` : head))
  }
}

/** Run a `reppo` query and return raw stdout. Applies the shared env + --rpc-url,
 *  retries transient upstream/network blips with linear backoff, and surfaces a
 *  redacted error. All read-only query helpers go through this so retry + the
 *  redaction boundary live in the exec layer, not each call site. */
export async function runReppoStdout(args: string[], timeoutMs = 60_000, opts: RunReppoOpts = {}): Promise<string> {
  const retries = opts.retries ?? 2
  const backoffMs = opts.backoffMs ?? 800
  const attempt = opts.attempt ?? execAttempt
  const nap = opts.sleepFn ?? sleep

  let lastErr: unknown
  for (let i = 0; i <= retries; i++) {
    try {
      return await attempt(args, timeoutMs)
    } catch (e) {
      lastErr = e
      const msg = e instanceof Error ? e.message : String(e)
      if (i === retries || !isTransientReppoError(msg)) break
      await nap(backoffMs * (i + 1))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}
