// src/telemetry/errorCode.ts — recover the ONE useful token from an error message
// without transmitting the message.
//
// ── Why this exists ─────────────────────────────────────────────────────────────────
// Most of what a node gets wrong is not a JavaScript fault. It is the reppo CLI refusing
// an action for a stated reason: VOTER_LACKS_SUBNET_ACCESS, INSUFFICIENT_REPPO_BALANCE,
// TX_RECEIPT_TIMEOUT. Those failures reach us as a thrown Error whose stack is identical
// for every one of them — `run (dist/reppo/cli.js:…)` — so a (class, frames) signature
// reduces the entire failure space of the CLI to a single indistinguishable fingerprint.
// Live proof: one install recorded ~90 errors that were, as far as telemetry could tell,
// all the same event.
//
// The reason lives in the message, and the message is exactly what must never travel.
//
// ── Why an ALLOWLIST, not a regex ───────────────────────────────────────────────────
// The codes ARE a bounded public vocabulary: reppo-cli's chain/errors.ts calls them "the
// public contract — agent skill recipes match on them". So the safe move is to recognize
// members of a known set, never to extract whatever looks code-shaped.
//
// A pattern like /[A-Z][A-Z0-9_]+/ over the message text would be a message leak wearing
// a costume. CLI error text quotes RPC bodies, pod titles, and remote API responses — all
// attacker-influenced — so a shape-matching extractor lets a pod named
// `MY_POD_IS_GREAT` mint an arbitrary "error code" and put chosen text on the wire. An
// allowlist can only ever emit a string that was already compiled into this file.
//
// reppo-cli learned this exact lesson one level down: its own header explains that
// selectors are decoded with viem's typed error walker "NOT a regex over the message
// string", because a regex read the first 4 bytes of an embedded contract address as an
// error selector. Same trap, same answer.

/** The reppo CLI's published error vocabulary, plus the codes orquestra raises itself.
 *
 *  Deliberately curated rather than scraped. The scrape of reppo-cli's sources also
 *  yields env var names (REPPO_PRIVATE_KEY, REPPO_API_KEY) and status words (ACTIVE,
 *  INACTIVE) that are not error codes: an env var name matching here would report
 *  "a message mentioned the private-key variable" as though it were a fault, which is
 *  both wrong and needlessly alarming. Entries here must be actual failure codes.
 *
 *  Adding an entry is a payload change — the value becomes transmittable fleet-wide on
 *  the next upgrade — so it should be reviewed like one. */
export const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set([
  // ── on-chain reverts decoded by the CLI (chain/errors.ts SELECTORS) ──
  'ACCESS_ALREADY_GRANTED',
  'ALREADY_CLAIMED',
  'CANNOT_VOTE_FOR_OWN_POD',
  'INSUFFICIENT_ALLOWANCE',
  'INSUFFICIENT_VOTING_POWER',
  'INVALID_SUBNET',
  'NOT_LOCKUP_OWNER',
  'NOT_POD_OWNER',
  'POD_DOES_NOT_EXIST',
  'POD_NOT_FOUND',
  'POD_NOT_VALID_FOR_EPOCH',
  'PUBLISHER_LACKS_SUBNET_ACCESS',
  'UNAUTHORIZED',
  'VOTER_LACKS_SUBNET_ACCESS',
  'ZERO_VOTES',
  // ── wallet / balance ──
  'INSUFFICIENT_REPPO_BALANCE',
  'INSUFFICIENT_TOKEN_BALANCE',
  'DURATION_OUT_OF_BOUNDS',
  'LOCKUP_NOT_EXPIRED',
  'LOCKUP_NOT_FOUND',
  // ── transaction lifecycle ──
  'APPROVE_REVERTED',
  'TX_RECEIPT_TIMEOUT',
  'TX_REVERTED',
  'REVERT',
  // ── idempotency store ──
  'IDEMPOTENCY_ARGS_MISMATCH',
  'IDEMPOTENCY_COMMAND_MISMATCH',
  'IDEMPOTENCY_FAILED_AFTER_BROADCAST',
  'IDEMPOTENCY_IN_FLIGHT',
  'IDEMPOTENCY_LEGACY_ENTRY',
  'IDEMPOTENCY_TERMINAL_STATE',
  // ── platform / public API (the pod- and vote-visibility surface) ──
  'PLATFORM_API_AUTH_FAILED',
  'PLATFORM_API_ERROR',
  'PLATFORM_API_INVALID_RESPONSE',
  'PLATFORM_API_NOT_CONFIGURED',
  'PLATFORM_API_UNAUTHORIZED',
  'PLATFORM_API_UNREACHABLE',
  'PUBLIC_API_ERROR',
  'PUBLIC_API_INVALID_RESPONSE',
  'PUBLIC_API_UNREACHABLE',
  'POD_NOT_INDEXED',
  // ── IPFS pinning (mint phase 2) ──
  'IPFS_PIN_FAILED',
  'IPFS_PIN_UNREACHABLE',
  'MISSING_PINATA_JWT',
  'DATASET_FILE_NOT_FOUND',
  // ── configuration / environment ──
  'ADDRESS_NOT_CONFIGURED',
  'DATANET_HAS_NO_PRIMARY_TOKEN',
  'DATANET_NOT_FOUND',
  'MISSING_AGENT_API_KEY',
  'MISSING_AGENT_ID',
  'MISSING_PRIVATE_KEY',
  'INVALID_NETWORK',
  'INVALID_PRIVATE_KEY',
  'UNSUPPORTED_ON_NETWORK',
  'CLI_INIT_ERROR',
  'INTERNAL_ERROR',
])

/** An on-chain revert the CLI could not name, e.g. `UNKNOWN_REVERT_0x5dd58b8b`.
 *
 *  Allowed by PATTERN rather than by membership because the useful part is the 4-byte
 *  selector, which cannot be enumerated ahead of time. Safe to admit anyway: the shape is
 *  fully constrained — a fixed prefix and exactly eight lowercase hex digits — so nothing
 *  attacker-chosen survives it beyond a selector that is already public chain data, and
 *  it is precisely the value needed to look the error up with `cast 4byte`. */
const UNKNOWN_REVERT = /^UNKNOWN_REVERT_0x[0-9a-f]{8}$/

/** Candidate tokens. Lowercase is admitted after the first character ONLY so that
 *  `UNKNOWN_REVERT_0x5dd58b8b` survives tokenization — a SCREAMING_SNAKE-only class cuts
 *  at the `x` and yields no token at all. Widening this is safe because it is not a
 *  filter: it merely proposes substrings, and every one of them must then be a member of
 *  the allowlist or match the revert pattern. The security property lives there, not here. */
const CANDIDATE = /\b[A-Z][A-Za-z0-9_]{2,63}\b/g

/** The first recognized error code in `text`, or null.
 *
 *  Returns null far more often than not, and that is the intended bias: an unrecognized
 *  failure reports as (class, frames) exactly as before, losing nothing that was
 *  previously transmitted. */
export function extractErrorCode(text: string): string | null {
  if (typeof text !== 'string' || text === '') return null
  // Bound the scan: a pathological message must not turn fingerprinting into the
  // expensive part of a failure path.
  const hay = text.length > 4_000 ? text.slice(0, 4_000) : text
  for (const m of hay.matchAll(CANDIDATE)) {
    const token = m[0]
    if (KNOWN_ERROR_CODES.has(token) || UNKNOWN_REVERT.test(token)) return token
  }
  return null
}

/** Pull a code off a thrown value: an explicit `.code` property when the thrower set one
 *  (PlatformApiError, the CLI's own structured errors), else the message text. The
 *  explicit property is checked first but held to the SAME allowlist — a code field is
 *  not more trustworthy than a message just because it has a name. */
export function errorCodeOf(err: unknown): string | null {
  const e = err as { code?: unknown; message?: unknown }
  if (typeof e?.code === 'string') {
    const direct = extractErrorCode(e.code)
    if (direct !== null) return direct
  }
  return typeof e?.message === 'string' ? extractErrorCode(e.message) : null
}
