// src/llm/oauth/anthropic/login.ts — one-time interactive PKCE login orchestration.
// Pure control flow over injected steps so it is unit-tested without a browser, the
// network, or the filesystem. index.ts wires the real pkce/store/prompter deps.
import { generatePkce as realGeneratePkce, buildAuthorizeUrl as realBuildAuthorizeUrl, exchangeCode as realExchangeCode, type TokenSet, type Pkce } from './pkce.js'

export interface LoginDeps {
  /** Persist the resulting token set (store.saveTokenSet bound to the data dir). */
  save: (tokens: TokenSet) => void
  /** Show the authorize URL + paste instructions; resolve to the pasted `code#state`. */
  prompt: (authorizeUrl: string) => Promise<string>
  /** Optional success line. */
  info?: (message: string) => void
  // Overridable for tests; default to the real PKCE implementations.
  generatePkce?: () => Pkce
  buildAuthorizeUrl?: (a: { challenge: string; state: string }) => string
  exchangeCode?: (a: { codeAndState: string; verifier: string }) => Promise<TokenSet>
}

/** Drive the login: generate PKCE, show the URL, exchange the pasted code, persist. */
export async function loginAnthropic(deps: LoginDeps): Promise<void> {
  const generatePkce = deps.generatePkce ?? realGeneratePkce
  const buildAuthorizeUrl = deps.buildAuthorizeUrl ?? realBuildAuthorizeUrl
  const exchangeCode = deps.exchangeCode ?? realExchangeCode

  const { verifier, challenge, state } = generatePkce()
  const url = buildAuthorizeUrl({ challenge, state })
  const pasted = (await deps.prompt(url)).trim()
  if (!pasted) throw new Error('login aborted: no authorization code provided')

  const tokens = await exchangeCode({ codeAndState: pasted, verifier })
  deps.save(tokens)
  deps.info?.('Anthropic subscription linked — provider `anthropic-oauth` is now available.')
}
