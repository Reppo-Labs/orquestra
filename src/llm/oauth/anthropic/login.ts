// src/llm/oauth/anthropic/login.ts — one-time interactive login that links the operator's
// Claude subscription by minting a token via the first-party `claude setup-token` CLI (see
// setupToken.ts — a hand-rolled OAuth flow is rejected by Anthropic for third-party clients).
// Pure control flow over injected steps so it is unit-tested without the CLI or the filesystem.
import { runSetupToken, type Exec } from './setupToken.js'
import type { OAuthCredential } from './store.js'

export interface LoginDeps {
  /** Run a command and resolve its stdout (index.ts wires `claude setup-token` via spawn). */
  exec: Exec
  /** Persist the minted credential (store.saveCredential bound to the data dir). */
  save: (cred: OAuthCredential) => void
  /** Optional progress/success line. */
  info?: (message: string) => void
}

/** Mint a subscription token with `claude setup-token` and persist it. */
export async function loginAnthropic(deps: LoginDeps): Promise<void> {
  const token = await runSetupToken(deps.exec)
  deps.save({ access_token: token })
  deps.info?.('Anthropic subscription linked. If the node is already running, restart it to pick up `anthropic-oauth`.')
}
