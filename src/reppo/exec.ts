// src/reppo/exec.ts
// Shared helpers for shelling out to the `reppo` CLI. Centralizes the env
// (REPPO_NETWORK default), the optional --rpc-url flag, and — critically — error
// redaction, so no CLI invocation can leak the rpc-url key in a thrown message.
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

/** Run a `reppo` query and return raw stdout. Applies the shared env + --rpc-url
 *  and REDACTS any rejection (execFile's message is the full command line, which
 *  carries the rpc-url key). All read-only query helpers go through this so the
 *  redaction boundary is the exec layer, not each call site. */
export async function runReppoStdout(args: string[], timeoutMs = 60_000): Promise<string> {
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
