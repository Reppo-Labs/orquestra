// src/reppo/version.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Minimum @reppo/cli version the node's vote/mint/grant flags require.
 *  (0.8.0: subnet-uuid minting, grant-access, rubric metadata.) */
export const REQUIRED_REPPO_VERSION = '0.8.0'

export interface VersionCheckDeps {
  getVersion?: () => Promise<string>
  warn?: (msg: string) => void
}

const defaultGetVersion = async (): Promise<string> => {
  const { stdout } = await execFileAsync('reppo', ['--version'], { timeout: 15_000 })
  return stdout.trim().split('\n')[0]
}

/** Extract the reppo CLI version from a `--version` banner. Prefers, in order:
 *  the token right after "reppo"/"cli" ("@reppo/cli 0.8.0", "reppo 0.7.0 (node
 *  20.1.0)" → 0.7.0), a `v`-tagged token ("reppo-cli v0.8.0"), else the FIRST
 *  dotted token. This dodges BOTH a build/date prefix and a runtime-version
 *  suffix (the last-token heuristic was fooled by "(node 20.1.0)"). */
function parseVersion(s: string): string | undefined {
  return (
    s.match(/(?:reppo|cli)[\s/@-]*v?(\d+\.\d+(?:\.\d+)?)/i)?.[1] ??
    s.match(/\bv(\d+\.\d+(?:\.\d+)?)/i)?.[1] ??
    s.match(/\d+\.\d+(?:\.\d+)?/)?.[0]
  )
}

/** Compare dotted versions numerically segment by segment. */
function atLeast(actual: string, required: string): boolean {
  const a = parseVersion(actual)?.split('.').map(Number) ?? []
  const r = required.split('.').map(Number)
  if (a.length === 0) return false
  for (let i = 0; i < Math.max(a.length, r.length); i++) {
    const av = a[i] ?? 0, rv = r[i] ?? 0
    if (av !== rv) return av > rv
  }
  return true
}

/** Startup preflight: warn loudly (don't crash) when the reppo CLI on PATH is
 *  older than the flags this node emits — an old CLI fails every vote/mint with
 *  confusing per-command errors instead of one clear message here. Warning, not
 *  fatal, so an operator with a newer-but-oddly-versioned build isn't blocked. */
export async function checkReppoVersion(deps: VersionCheckDeps = {}): Promise<boolean> {
  const warn = deps.warn ?? ((m: string) => console.error(m))
  const getVersion = deps.getVersion ?? defaultGetVersion
  let raw: string
  try {
    raw = await getVersion()
  } catch (e) {
    warn(`orquestra: could not determine reppo CLI version (${(e as Error).message.split('\n')[0]}) — vote/mint may fail; install @reppo/cli@${REQUIRED_REPPO_VERSION}+`)
    return false
  }
  if (!atLeast(raw, REQUIRED_REPPO_VERSION)) {
    warn(`orquestra: reppo CLI ${raw} is older than the required ${REQUIRED_REPPO_VERSION} — vote/mint/grant flags WILL fail; upgrade with: npm i -g @reppo/cli@${REQUIRED_REPPO_VERSION}`)
    return false
  }
  return true
}
