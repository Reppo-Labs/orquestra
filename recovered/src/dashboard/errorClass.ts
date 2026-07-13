// src/dashboard/errorClass.ts
// Turns the node's RAW failure strings into something a non-technical operator can act on.
//
// Today a broken datanet reaches the dashboard as `datanet error: Command failed: repp…` —
// truncated CLI stderr. Every code below is derived from a string this node ACTUALLY
// produces (src/runtime/cycle.ts skip reasons, src/wallet/executor.ts details, the reppo
// CLI error bodies folded in by src/reppo/exec.ts). No speculative codes.
//
// Redaction: classification runs redactSecrets over the raw text BEFORE matching, so a
// key echoed inside an RPC error can never reach operatorMessage (activity rows are
// already redacted on write — this is defense-in-depth for any other caller).
import { redactSecrets } from '../util/redact.js'
import type { ActivityEntry } from './activityLog.js'
import type { HealthReport, DatanetHealth } from './health.js'

/** Small, closed set — each one is emitted by a real code path (see the matchers below).
 *
 *  THE FOUR SUBSYSTEMS THAT CAN FAIL ARE DISTINCT, AND SO ARE THEIR CODES. Every one of them
 *  used to collapse into `rpc_unavailable` ("point RPC_URL at a private RPC") because the old
 *  matcher just asked `isTransientReppoError()`, whose regex list spans ALL of them — 11 of 14
 *  live datanets got a confidently-wrong remedy for a subsystem they were not using:
 *    - the chain RPC (an eth_call to Base failing)            → rpc_unavailable
 *    - Reppo's own public API/indexer (reppo.ai)              → reppo_api_unavailable
 *    - a data adapter's upstream (Hyperliquid 429)            → adapter_rate_limited
 *    - the LLM provider this datanet scores with (Gemini 429) → llm_quota_exhausted
 *  Only the FIRST of those is fixed by changing RPC_URL. */
export type ErrorCode =
  | 'rpc_unavailable'          // the CHAIN RPC failed (eth_call to Base / -32603 / transient-RPC guard)
  | 'reppo_api_unavailable'    // reppo.ai public API/indexer — PUBLIC_API_UNREACHABLE / _INVALID_RESPONSE
  | 'adapter_rate_limited'     // a mint adapter's upstream data source rate-limited us (hl-adapter 429)
  | 'llm_quota_exhausted'      // the model provider's quota/billing ran out mid-scoring
  | 'network_unstable'         // a transient network blip with no subsystem in the message
  | 'datanet_metadata_missing' // no goal / onboardingVoters / onboardingPublishers on-chain
  | 'budget_exhausted'         // ledger refused / per-cycle cap reached
  | 'insufficient_funds'       // wallet lacks REPPO or the datanet's access-fee token
  | 'subnet_access_missing'    // grant-access failed / VOTER_LACKS_SUBNET_ACCESS
  | 'no_adapter'               // mint enabled, no adapter configured or registered
  | 'model_unavailable'        // no API key for the model this datanet scores with
  | 'scoring_failed'           // an LLM scoring call threw for a pod (cause not identified)
  | 'no_candidates'            // adapter found data, nothing cleared scoring/dedup
  | 'cli_outdated'             // the reppo CLI on PATH is too old for this datanet
  | 'own_pod'                  // CANNOT_VOTE_FOR_OWN_POD — benign
  | 'unknown'

/** The remedy an operator can actually perform from the dashboard or their shell. */
export type SuggestedAction =
  | 'retry'             // nothing to do — the node retries on its own
  | 'disable_datanet'   // this datanet cannot work as configured; turn it off
  | 'raise_budget'      // the caps are the binding constraint
  | 'check_rpc'         // the CHAIN RPC endpoint is the binding constraint
  | 'check_model_quota' // the LLM provider's quota/billing is the binding constraint
  | 'fund_wallet'       // the node's wallet is short of REPPO / a fee token
  | 'none'              // needs a config/env change, not a dashboard action

export interface ClassifiedError {
  code: ErrorCode
  /** Plain English. Names the datanet when known. Never contains a key or raw stderr. */
  operatorMessage: string
  suggestedAction: SuggestedAction
}

/** "Datanet 6" / "This datanet" — keeps operatorMessage readable with or without an id. */
const subject = (datanetId?: string): string => (datanetId ? `Datanet ${datanetId}` : 'This datanet')

interface Matcher {
  code: ErrorCode
  test: (raw: string) => boolean
  action: SuggestedAction
  message: (datanetId?: string) => string
}

// ORDER IS THE CONTRACT. The FIRST match wins, so every matcher that NAMES ITS SUBSYSTEM runs
// before any matcher that merely recognises a network-shaped word. That ordering is the fix:
//
//   - The live Gemini failure literally contains the substring "rate-limits" (it links to
//     ai.google.dev/gemini-api/docs/rate-limits) and the word "retry". A generic /rate.?limit/
//     test therefore CLAIMED it — which is how an exhausted LLM quota came to be reported as a
//     bad RPC endpoint. llm_quota_exhausted runs before every rate-limit/scoring matcher.
//   - The Hyperliquid adapter's own message carries "(429)". A bare /\b429\b/ claimed that too.
//   - Both `PUBLIC_API_UNREACHABLE` and the Alchemy eth_call failure contain "fetch failed".
//     Whoever tests for the bare token wins the race — so neither of them does.
//
// rpc_unavailable is now keyed on evidence the CHAIN RPC specifically failed: a JSON-RPC method
// in the request body (eth_call…), the JSON-RPC -32603 code, or queryDatanet.ts's own
// "(transient RPC?)" guard. `INTERNAL_ERROR` alone is NOT enough — the reppo CLI wraps
// everything in it, including the Reppo-API failures above.
const MATCHERS: Matcher[] = [
  {
    // executor: `CANNOT_VOTE_FOR_OWN_POD` — the node minted the pod it tried to curate.
    code: 'own_pod',
    test: (r) => /CANNOT_VOTE_FOR_OWN_POD/i.test(r),
    action: 'none',
    message: (d) => `${subject(d)} tried to vote on a pod this node published — the node has already remembered it and won't retry.`,
  },
  {
    // executor: 'vote budget/rate exhausted' | 'mint budget exhausted' | 'claim gas budget exhausted';
    // cycle: 'per-cycle vote budget/rate exhausted…', 'mint budget below one mint reserve…',
    //        'vote rate/budget cap reached — N votes deferred to next cycle'.
    code: 'budget_exhausted',
    test: (r) => /budget below one mint reserve|deferred to next cycle|(?:budget|rate)[^\n]{0,32}(?:exhaust|cap reached)/i.test(r),
    action: 'raise_budget',
    message: (d) => `${subject(d)} stopped early because this node hit its own spending caps, not an error. Raise the budget caps (or wait for the next cycle) if you want it to do more.`,
  },
  {
    // CLI: INSUFFICIENT_REPPO_BALANCE / INSUFFICIENT_TOKEN_BALANCE / INSUFFICIENT_ALLOWANCE;
    // cycle: 'insufficient EXY balance for access fee (need 50 EXY) — fund this node's wallet…'.
    code: 'insufficient_funds',
    test: (r) => /INSUFFICIENT_(REPPO|TOKEN)_BALANCE|INSUFFICIENT_ALLOWANCE|insufficient funds|insufficient [\w.]+ balance/i.test(r),
    action: 'fund_wallet',
    message: (d) => `${subject(d)} needs more money in this node's wallet — the wallet is short of the tokens this action costs. Fund the wallet and it resumes on its own.`,
  },
  {
    // LIVE (datanet 21): 'pod scoring skipped — Failed after 3 attempts. Last error: You exceeded
    // your current quota, please check your plan and billing details… Quota exceeded for metric:
    // generativelanguage.googleapis.com/generate_requests_per_model_per_day, limit: 250, model:
    // gemini-3.1-pro. Please retry in 48m…'. This is the MODEL PROVIDER's quota, nothing else.
    //
    // FIRST, and deliberately so: the text carries "rate-limits" (in Google's own docs URL) and
    // "retry", so a rate-limit or scoring matcher placed above it would swallow it — which is
    // exactly how it used to be reported as a broken RPC endpoint.
    code: 'llm_quota_exhausted',
    test: (r) => /exceeded your (?:current )?quota|quota exceeded/i.test(r),
    action: 'check_model_quota',
    message: (d) => `${subject(d)} ran out of AI model quota — the provider of the model it scores with has stopped answering until the quota resets or the plan is topped up. Nothing on this node is broken: check the model provider's billing/quota, or switch this datanet to a model on a provider with headroom.`,
  },
  {
    // LIVE (datanet 9): '[hl-adapter] rate-limited by Hyperliquid (429) — aborting this cycle to
    // avoid extending the penalty window' — src/adapter/hyperliquid/index.ts. This is the mint
    // adapter's UPSTREAM DATA SOURCE, not the chain and not Reppo. Changing RPC_URL does nothing.
    code: 'adapter_rate_limited',
    test: (r) => /\[[\w-]+-adapter\][^\n]*rate.?limit|rate.?limited by/i.test(r),
    action: 'retry',
    message: (d) => `${subject(d)}'s data source is rate-limiting this node, so it backed off and published nothing this cycle. It is not a fault in your node and it clears on its own — the node tries again next cycle. If it never clears, publish less often on this datanet.`,
  },
  {
    // LIVE (datanets 1, 2, 6, 23): 'PUBLIC_API_UNREACHABLE … Could not reach
    // https://reppo.ai/api/v1/public/subnets: fetch failed.' and 'PUBLIC_API_INVALID_RESPONSE …
    // /api/v1/public/pods returned 200 but the body was not valid JSON: terminated.'
    //
    // This is REPPO'S OWN public API/indexer — the operator's RPC endpoint is not involved, and
    // telling them to swap it is a lie. src/reppo/exec.ts already treats both as transient and
    // retries them with backoff, so the honest remedy really is "nothing for you to do".
    code: 'reppo_api_unavailable',
    test: (r) => /PUBLIC_API_UNREACHABLE|PUBLIC_API_INVALID_RESPONSE|reppo\.ai\/api\//i.test(r),
    action: 'retry',
    message: (d) => `${subject(d)} couldn't be read because Reppo's own data service didn't answer. This is on Reppo's side, not your node — your settings, wallet and RPC are all fine. The node already retries automatically, so there is nothing for you to do; if it lasts hours, check Reppo's status.`,
  },
  {
    // LIVE (datanets 5, 10, 17, 22, 24): INTERNAL_ERROR whose message is 'HTTP request failed.
    // URL: https://base-mainnet.g.alchemy.com/v2/<redacted>  Request body: {"method":"eth_call",…}'
    // — the CHAIN RPC genuinely failed. Also queryDatanet.ts's own
    // 'INTERNAL_ERROR: datanet N … (transient RPC?)' guard, and JSON-RPC -32603.
    //
    // Keyed on the RPC CALL, never on the bare token INTERNAL_ERROR (the CLI wraps the Reppo-API
    // failures above in INTERNAL_ERROR too) and never on a bare 429/"rate limit"/"fetch failed".
    code: 'rpc_unavailable',
    test: (r) => /"method"\s*:\s*"eth_\w+"|\beth_(?:call|getLogs|blockNumber|getBlockByNumber|estimateGas|sendRawTransaction|getTransactionReceipt)\b|-32603|\(transient RPC\?\)/i.test(r),
    action: 'check_rpc',
    message: (d) => `${subject(d)} couldn't be read from the blockchain — the RPC endpoint this node reads Base through failed or is rate-limiting it. Point RPC_URL at a private RPC (Alchemy, Infura, your own node) if it keeps happening.`,
  },
  {
    // cycle: 'vote enabled but this datanet has no on-chain voter rubric (onboardingVoters)…',
    //        'mint enabled but this datanet has no on-chain publisher spec (onboardingPublishers)…';
    // LIVE (datanet 20): rubric/parse.ts RubricUnavailableError — 'datanet 20: metadata carries no
    // goal, voter rubric, or publisher spec'. That last one used to fall through to `unknown`
    // ("a reason this node doesn't recognise") purely because the matcher never looked for it.
    code: 'datanet_metadata_missing',
    test: (r) => /onboardingVoters|onboardingPublishers|no on-chain (voter rubric|publisher spec)|metadata carries no goal/i.test(r),
    action: 'disable_datanet',
    message: (d) => `${subject(d)}'s creator never published the rules this node needs (no voting rubric or publishing spec on-chain), so it can't take part. Turn this datanet off.`,
  },
  {
    // cycle: 'mint enabled but no adapter is configured for this datanet…',
    //        'mint enabled but adapter "x" is not registered on this node'.
    code: 'no_adapter',
    test: (r) => /no adapter is configured|adapter "[^"]*" is not registered/i.test(r),
    action: 'disable_datanet',
    message: (d) => `${subject(d)} is set to publish data, but this node has no data source for it. Turn publishing off for this datanet (voting still works).`,
  },
  {
    // cycle: 'non-REPPO access fee needs reppo CLI ≥ 0.8.5 (…)'.
    code: 'cli_outdated',
    test: (r) => /reppo CLI [≥>]/i.test(r),
    action: 'none',
    message: (d) => `${subject(d)} needs a newer reppo CLI than the one installed on this machine. Upgrade the reppo CLI, or turn this datanet off.`,
  },
  {
    // cycle: 'subnet access not granted (grant-access error: …)'; executor: VOTER_LACKS_SUBNET_ACCESS.
    code: 'subnet_access_missing',
    test: (r) => /VOTER_LACKS_SUBNET_ACCESS|subnet access not granted|grant-access/i.test(r),
    action: 'retry',
    message: (d) => `${subject(d)} hasn't finished its one-time access purchase yet. The node retries every cycle and starts working as soon as it goes through.`,
  },
  {
    // resolveScoringModel: 'no API key for <provider> …', 'video scoring needs a Google API key…',
    // 'video pod needs a Gemini model…'; wiring: 'no API key for the node default provider…'.
    code: 'model_unavailable',
    test: (r) => /no API key for|needs a Google API key|needs a Gemini model/i.test(r),
    action: 'none',
    message: (d) => `${subject(d)} has no usable AI model — the key for the model it is set to use isn't configured on this node. Pick a model whose provider has a key, or add the key and restart.`,
  },
  {
    // cycle: 'N mint candidate(s) discovered but none passed scoring/dedup (min score X)…'.
    code: 'no_candidates',
    test: (r) => /none passed scoring\/dedup/i.test(r),
    action: 'none',
    message: (d) => `${subject(d)} found data but judged none of it good enough to publish. Loosen its strictness if you expected pods here.`,
  },
  {
    // cycle: 'pod scoring skipped — <redacted provider error>' (selectVotes onSkip).
    code: 'scoring_failed',
    test: (r) => /pod scoring skipped|scoring failed/i.test(r),
    action: 'retry',
    message: (d) => `${subject(d)} couldn't get an AI score for some data this cycle (the model call failed). It retries next cycle.`,
  },
  {
    // LAST, and generic ON PURPOSE. exec.ts's TRANSIENT list (fetch failed, socket hang up,
    // ECONNRESET/ETIMEDOUT/ENOTFOUND/EAI_AGAIN/ECONNREFUSED, undici UND_ERR, timeouts) folds
    // network blips into CLI failures — but by the time we get here NOTHING in the message named
    // the chain RPC, Reppo's API, an adapter or a model. We do not know which hop failed, so we
    // do not claim to: no "fix your RPC", just the truth (it is transient, exec.ts retries it).
    code: 'network_unstable',
    test: (r) => /fetch failed|socket hang up|\bECONNRESET\b|\bETIMEDOUT\b|\bENOTFOUND\b|\bEAI_AGAIN\b|\bECONNREFUSED\b|\bUND_ERR|timed? ?out/i.test(r),
    action: 'retry',
    message: (d) => `${subject(d)} lost a network call this cycle — something between this node and the internet dropped the connection. The node already retries these automatically. If it keeps happening, check this machine's connection.`,
  },
]

/** Classify a raw error/skip reason into { code, operatorMessage, suggestedAction }.
 *  Empty/absent input classifies as 'unknown'. The raw text is REDACTED before it is
 *  matched, so nothing key-shaped can influence or leak into the result. */
export function classifyFailure(raw: string | undefined, ctx: { datanetId?: string } = {}): ClassifiedError {
  const text = redactSecrets((raw ?? '').trim())
  const m = text ? MATCHERS.find((x) => x.test(text)) : undefined
  if (!m) {
    return {
      code: 'unknown',
      operatorMessage: `${subject(ctx.datanetId)} failed for a reason this node doesn't recognise. It retries next cycle — if it never recovers, turn it off.`,
      suggestedAction: 'retry',
    }
  }
  return { code: m.code, operatorMessage: m.message(ctx.datanetId), suggestedAction: m.action }
}

export type ClassifiedDatanetHealth = DatanetHealth & { classification?: ClassifiedError }
export interface ClassifiedHealthReport extends Omit<HealthReport, 'datanets'> {
  datanets: ClassifiedDatanetHealth[]
}

/** The CURRENT failure text per datanet, or nothing when the datanet has recovered.
 *
 *  A classification is a claim about the datanet's state NOW: it drives the "N of M working"
 *  headline, a "can't run" alert, and remedies as destructive as "turn this datanet off". So a
 *  failure only counts while it is still the datanet's latest word. Walking the newest-first
 *  window, the FIRST decisive row per datanet wins:
 *    - a failure (a skip with a reason, or an errored row with a detail) → classify it;
 *    - an EXECUTED row (vote/mint/claim/grant/stake landed on-chain) → the datanet demonstrably
 *      works, so any older failure is history and is NOT reported.
 *  Everything else (refused-budget, a reasonless skip, 'info') is indecisive and is skipped
 *  over — only real execution proves recovery. A failure that RECURRED after the last executed
 *  row is therefore still classified, which is the point: it is broken right now.
 *
 *  `entries` is the SAME newest-first window buildHealth aggregated, so the classification
 *  always describes the state the panel is showing. */
function latestFailureText(entries: ActivityEntry[]): Map<string, string> {
  const out = new Map<string, string>()
  const decided = new Set<string>() // datanets whose newest decisive row we've already seen
  for (const e of entries) {
    if (!e.datanetId || decided.has(e.datanetId)) continue
    if (e.kind === 'info') continue // historical yield breadcrumb — never a state signal
    if (e.status === 'executed') { decided.add(e.datanetId); continue } // recovered — nothing to explain
    if (e.kind === 'skip') {
      if (e.reason) { out.set(e.datanetId, e.reason); decided.add(e.datanetId) }
    } else if (e.status === 'error') {
      if (e.detail) { out.set(e.datanetId, e.detail); decided.add(e.datanetId) }
    }
  }
  return out
}

/** Attach a classification to each datanet in a health report that currently has a failure
 *  to explain. Composed at the server layer — health.ts stays a pure counter. Datanets whose
 *  recent window holds no skip/error carry no `classification` key at all. */
export function attachClassification(report: HealthReport, entries: ActivityEntry[]): ClassifiedHealthReport {
  const failures = latestFailureText(entries)
  return {
    ...report,
    datanets: report.datanets.map((d) => {
      const raw = failures.get(d.datanetId)
      if (raw === undefined) return d
      return { ...d, classification: classifyFailure(raw, { datanetId: d.datanetId }) }
    }),
  }
}
