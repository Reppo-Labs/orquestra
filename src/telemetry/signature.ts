// src/telemetry/signature.ts — reduce an exception to a countable fingerprint.
//
// This module exists to make one category of data UNSENDABLE rather than merely
// unsent. Error messages are the highest-value injection carrier in the whole payload:
// they look like legitimate debugging context, they routinely embed attacker-influenced
// text (pod content, external API responses, RPC error bodies), and the collector's
// output is intended to eventually reach an agent that writes code. So the message is
// never transmitted — there is no field for it.
//
// What IS transmitted is a normalized (errorClass, frames) pair. Two properties matter:
//   - STABLE across operators: the same fault on two differently-configured nodes must
//     produce the same signature, or it can never reach the distinct-install threshold
//     that makes it trustworthy (specs/telemetry-ingest).
//   - FREE of anything identifying: absolute paths carry usernames and deploy layout,
//     so they are normalized away to a repo-relative form.
//
// redactSecrets() is applied as defense in depth. Frames should never contain a
// credential — but "should never" plus a live wallet key is not a boundary, and this is
// the same posture src/learn/reflect.ts takes toward pod text.
import { redactSecrets } from '../util/redact.js'

/** Upper bound on transmitted frames. Deep stacks add noise, not discrimination: the top
 *  few frames identify a fault, the tail is mostly framework plumbing shared by every
 *  error. Also bounds payload size against a pathological recursion stack. */
export const MAX_FRAMES = 5

/** Upper bound on signatures in ONE report, shared by the sender and the collector.
 *
 *  This is a hard edge, not a guideline: the collector rejects an over-long array with
 *  `bad-signature`, which drops the ENTIRE report — counts included. A node erroring ten
 *  times a cycle would therefore go completely dark in telemetry at exactly the moment it
 *  became interesting. The buffer that feeds a report dedupes and truncates to this
 *  number, and the constant lives here so the two sides cannot drift apart. */
export const MAX_SIGNATURES = MAX_FRAMES * 4

export interface ErrorSignature {
  /** Constructor/name of the thrown value, e.g. 'TypeError'. 'UnknownError' for non-Errors. */
  errorClass: string
  /** Normalized `fn (path:line)` frames, outermost first, at most MAX_FRAMES. */
  frames: string[]
}

/** Strip the machine-specific prefix from a stack path.
 *
 *  `/Users/ana/code/orquestra/dist/voter/score.js` -> `dist/voter/score.js`
 *  `/app/src/runtime/cycle.ts`                     -> `src/runtime/cycle.ts`
 *  `/opt/x/node_modules/zod/lib/index.js`          -> `node_modules/zod/lib/index.js`
 *
 *  Anchoring on these markers (rather than, say, stripping cwd) is what makes a Docker
 *  node and a local `npm start` node agree: their absolute prefixes differ, the suffix
 *  from the marker onward does not. An unrecognized path degrades to its basename, which
 *  is still stable and still carries no username. */
function normalizePath(p: string): string {
  for (const marker of ['/node_modules/', '/dist/', '/src/']) {
    const i = p.lastIndexOf(marker)
    if (i !== -1) return p.slice(i + 1)
  }
  const slash = p.lastIndexOf('/')
  return slash === -1 ? p : p.slice(slash + 1)
}

// V8 frames: "    at fnName (/abs/path.js:12:34)" or "    at /abs/path.js:12:34".
// Column is dropped deliberately — it shifts under formatting changes that do not change
// the fault, which would split one signature into several.
const FRAME_WITH_FN = /^\s*at\s+(.+?)\s+\((.+):(\d+):\d+\)$/
const FRAME_BARE = /^\s*at\s+(.+):(\d+):\d+$/

function parseFrame(line: string): string | null {
  const withFn = line.match(FRAME_WITH_FN)
  if (withFn) {
    const [, fn, path, ln] = withFn
    return `${fn} (${normalizePath(path)}:${ln})`
  }
  const bare = line.match(FRAME_BARE)
  if (bare) {
    const [, path, ln] = bare
    return `(${normalizePath(path)}:${ln})`
  }
  return null
}

/** Fingerprint a thrown value.
 *
 *  Note the deliberate asymmetry with normal error handling: everything except the class
 *  name and the frame skeleton is discarded, including `.message`, `.cause`, and any
 *  custom properties. Callers wanting a human-readable error should log it locally —
 *  `src/util/redact.ts` already scrubs that path. This function is only for the wire. */
export function toSignature(err: unknown): ErrorSignature {
  const errorClass =
    err instanceof Error && typeof err.name === 'string' && err.name !== '' ? err.name : 'UnknownError'

  const stack = err instanceof Error && typeof err.stack === 'string' ? err.stack : ''
  const frames: string[] = []
  for (const line of stack.split('\n')) {
    // The first stack line is "Name: message" — parseFrame returns null for it, which is
    // how the message is excluded structurally rather than by a substring check.
    const frame = parseFrame(line)
    if (frame === null) continue
    frames.push(redactSecrets(frame))
    if (frames.length === MAX_FRAMES) break
  }

  return { errorClass: redactSecrets(errorClass), frames }
}
