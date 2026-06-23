// src/llm/oauth/anthropic/setupToken.ts — mint a Claude subscription OAuth token via the
// FIRST-PARTY `claude setup-token` CLI, instead of a hand-rolled PKCE flow. Anthropic rejects
// the OAuth authorize flow from third-party clients ("Invalid request format"); only the
// official CLI may mint the token. The resulting `sk-ant-oat01-…` token is then used as a
// Bearer (see makeOAuthFetch). Mirrors how ~/code/aeon obtains CLAUDE_CODE_OAUTH_TOKEN.

/** Pull the `sk-ant-oat…` token out of `claude setup-token` stdout. The CLI prints prose
 *  around the token; the token itself is a contiguous base64url-ish run on one line, so we
 *  match from the marker up to the first non-token char (newline/space/prose). */
export function parseSetupTokenOutput(stdout: string): string {
  const m = stdout.match(/sk-ant-oat[A-Za-z0-9_-]+/)
  if (!m) throw new Error('claude setup-token: no sk-ant-oat token in output')
  return m[0]
}

/** Run a command, resolving with its stdout. */
export type Exec = (cmd: string, args: string[]) => Promise<string>

/** Run `claude setup-token` (interactive: opens a browser, first-party OAuth) and return the
 *  minted token. Requires the `claude` CLI on PATH where this runs. */
export async function runSetupToken(exec: Exec): Promise<string> {
  let stdout: string
  try {
    stdout = await exec('claude', ['setup-token'])
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`claude setup-token failed (is the \`claude\` CLI installed and logged in?): ${msg}`)
  }
  return parseSetupTokenOutput(stdout)
}
