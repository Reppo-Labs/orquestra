// src/reppo/exec.ts
// Shared helpers for shelling out to the `reppo` CLI. Centralizes two things every
// call site needs: the env (REPPO_NETWORK default) and the optional --rpc-url flag.

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
