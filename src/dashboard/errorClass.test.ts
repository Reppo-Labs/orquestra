// src/dashboard/errorClass.test.ts
//
// EVERY RAW STRING IN THE FIRST BLOCK BELOW IS A VERBATIM COPY of what the LIVE node produced —
// captured from /api/health on a real 14-datanet node. That is the whole point of this file:
// the misclassification bug (11 of 14 datanets told to "point RPC_URL at a private RPC", across
// four different subsystems, most of which had nothing to do with the RPC) shipped WITH A GREEN
// TEST SUITE, because the tests asserted against strings a human had invented — short, tidy ones
// like 'PUBLIC_API_UNREACHABLE' and '429 too many requests' that happened to agree with the
// classifier's wrong guess. Real failures are long, and they carry words from three systems at
// once (Google's quota error links to a page called "rate-limits"), which is exactly how they
// were mis-swallowed.
//
// RULE FOR THIS FILE: a matcher is only allowed a test if a real string justifies it. The LIVE_*
// constants are that justification; the strings below them come from the node's own source (skip
// reasons in src/runtime/cycle.ts, details in src/wallet/executor.ts, thrown errors in
// src/rubric/parse.ts and src/adapter/*, CLI bodies folded in by src/reppo/exec.ts).
import { describe, it, expect } from 'vitest'
import { classifyFailure, attachClassification } from './errorClass.js'
import { buildHealth } from './health.js'
import type { ActivityEntry } from './activityLog.js'

// ── The live failures, verbatim ──────────────────────────────────────────────────────────────

/** datanets 5, 10, 17, 22, 24 — the CHAIN RPC genuinely failed: an eth_call to Base. */
const LIVE_RPC = 'datanet error: Command failed: reppo query datanet 5 --json --rpc-url <redacted> — {"error":{"code":"INTERNAL_ERROR","message":"HTTP request failed.\\n\\nURL: https://base-mainnet.g.alchemy.com/v2/<redacted>\\nRequest body: {\\"method\\":\\"eth_call\\",\\"params\\":[{\\"data\\":\\"0x187eded60000000000000000000000000000000000000000000000000000000000000005\\",\\"to\\":\\"0x2629A8083065938B533b117704935D727270eE7A\\"},\\"latest\\"]}\\n \\nRaw Call Arguments:\\n  to:    0x2629A8083065938B533b117704935D727270eE7A\\n \\nContract Call:\\n  address:   0x2629A8083065938B533b117704935D727270eE7A\\n  function:  validSubnet(uint256 subnetId)\\n  args:                 (5)\\n\\nDocs: https://viem.sh/docs/contract/readContract\\nDetails: fetch failed\\nVersion: viem@2.55.0"}}'

/** datanets 1, 2 — REPPO'S OWN public API. Note it ALSO contains "fetch failed". */
const LIVE_REPPO_API_UNREACHABLE = 'datanet error: Command failed: reppo list pods --all --datanet 1 --json --rpc-url <redacted> — {"error":{"code":"PUBLIC_API_UNREACHABLE","message":"Could not reach https://reppo.ai/api/v1/public/subnets: fetch failed.","hint":"Check your internet connection. If reppo.ai is down, try again in a few minutes."}}'

/** datanets 6, 23 — Reppo's API answered 200 with a truncated body. Same side, same remedy. */
const LIVE_REPPO_API_INVALID = 'datanet error: Command failed: reppo list pods --all --datanet 6 --json --rpc-url <redacted> — {"error":{"code":"PUBLIC_API_INVALID_RESPONSE","message":"/api/v1/public/pods returned 200 but the body was not valid JSON: terminated."}}'

/** datanet 9 — the Hyperliquid ADAPTER's upstream. Contains "(429)" and "rate-limited". */
const LIVE_HL_429 = 'datanet error: [hl-adapter] rate-limited by Hyperliquid (429) — aborting this cycle to avoid extending the penalty window'

/** datanet 21 — the LLM PROVIDER's quota. Contains "rate-limits" (Google's own docs URL) and
 *  "retry", which is precisely what let the RPC matcher claim it. */
const LIVE_LLM_QUOTA = 'pod scoring skipped — Failed after 3 attempts. Last error: You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_requests_per_model_per_day, limit: 250, model: gemini-3.1-pro\nPlease retry in 48m44.225424107s.'

/** datanet 20 — src/rubric/parse.ts RubricUnavailableError. Used to fall through to `unknown`. */
const LIVE_NO_METADATA = 'datanet error: datanet 20: metadata carries no goal, voter rubric, or publisher spec'

/** datanets 7, 18 — not a failure at all: the operator's own caps did this. */
const LIVE_VOTE_CAP = 'vote rate/budget cap reached — 7 votes deferred to next cycle'

const entry = (e: Partial<ActivityEntry>): ActivityEntry =>
  ({ ts: '2026-07-12T12:00:00.000Z', cycleId: 'c1', kind: 'skip', datanetId: '6', status: 'skipped', ...e }) as ActivityEntry

describe('classifyFailure — the LIVE failures, verbatim (one test per real shape)', () => {
  it('an eth_call to Base that failed IS the chain RPC → rpc_unavailable / check_rpc', () => {
    const c = classifyFailure(LIVE_RPC, { datanetId: '5' })
    expect(c.code).toBe('rpc_unavailable')
    expect(c.suggestedAction).toBe('check_rpc')
    expect(c.operatorMessage).toContain('Datanet 5')
    expect(c.operatorMessage).toContain('RPC_URL') // the ONE case where this advice is true
    expect(c.operatorMessage).not.toMatch(/Command failed|INTERNAL_ERROR|eth_call/) // no stderr leak
  })

  it("Reppo's public API being unreachable is NOT the operator's RPC → reppo_api_unavailable / retry", () => {
    const c = classifyFailure(LIVE_REPPO_API_UNREACHABLE, { datanetId: '1' })
    expect(c.code).toBe('reppo_api_unavailable')
    expect(c.suggestedAction).toBe('retry') // src/reppo/exec.ts already retries these
    expect(c.operatorMessage).toContain("Reppo's own data service")
    expect(c.operatorMessage).not.toContain('RPC_URL') // the lie this fix exists to kill
  })

  it("a truncated 200 from Reppo's API is the same side, same remedy → reppo_api_unavailable", () => {
    const c = classifyFailure(LIVE_REPPO_API_INVALID, { datanetId: '6' })
    expect(c.code).toBe('reppo_api_unavailable')
    expect(c.suggestedAction).toBe('retry')
    expect(c.operatorMessage).not.toContain('RPC_URL')
  })

  it("a Hyperliquid 429 is the ADAPTER's data source → adapter_rate_limited / retry", () => {
    const c = classifyFailure(LIVE_HL_429, { datanetId: '9' })
    expect(c.code).toBe('adapter_rate_limited')
    expect(c.suggestedAction).toBe('retry')
    expect(c.operatorMessage).toContain("Datanet 9's data source")
    expect(c.operatorMessage).not.toContain('RPC_URL')
  })

  it('an exhausted Gemini quota is the MODEL PROVIDER → llm_quota_exhausted / check_model_quota', () => {
    const c = classifyFailure(LIVE_LLM_QUOTA, { datanetId: '21' })
    expect(c.code).toBe('llm_quota_exhausted')
    expect(c.suggestedAction).toBe('check_model_quota')
    expect(c.operatorMessage).toMatch(/quota/i)
    expect(c.operatorMessage).not.toContain('RPC_URL')
    // …and it must not be downgraded to the generic "the model call failed, it retries next
    // cycle" either: retrying a spent DAILY quota for 48 minutes is not a remedy.
    expect(c.code).not.toBe('scoring_failed')
  })

  it('a datanet whose creator published no rubric → datanet_metadata_missing / disable_datanet', () => {
    const c = classifyFailure(LIVE_NO_METADATA, { datanetId: '20' })
    expect(c.code).toBe('datanet_metadata_missing') // was falling through to 'unknown'
    expect(c.suggestedAction).toBe('disable_datanet')
    expect(c.operatorMessage).toContain('Datanet 20')
  })

  it("the operator's own vote cap is not a failure → budget_exhausted / raise_budget", () => {
    const c = classifyFailure(LIVE_VOTE_CAP, { datanetId: '7' })
    expect(c.code).toBe('budget_exhausted')
    expect(c.suggestedAction).toBe('raise_budget')
  })
})

// ── The regression the bug WAS ───────────────────────────────────────────────────────────────
describe('regression: the RPC matcher must never swallow another subsystem again', () => {
  it.each([
    ['a Hyperliquid 429 (adapter)', LIVE_HL_429],
    ['an exhausted LLM quota (model provider)', LIVE_LLM_QUOTA],
    ['Reppo API unreachable (reppo.ai)', LIVE_REPPO_API_UNREACHABLE],
    ['Reppo API invalid response (reppo.ai)', LIVE_REPPO_API_INVALID],
  ])('%s is NOT rpc_unavailable and NEVER says check_rpc', (_label, raw) => {
    const c = classifyFailure(raw, { datanetId: '9' })
    expect(c.code).not.toBe('rpc_unavailable')
    expect(c.suggestedAction).not.toBe('check_rpc')
    expect(c.operatorMessage).not.toMatch(/RPC_URL|private RPC/)
  })

  it('a bare "429" / "rate limit" / "fetch failed" is NOT enough to claim the chain RPC', () => {
    // Each of these alone satisfied isTransientReppoError(), which is what the old matcher asked.
    // None of them names a subsystem, so none may be answered with "point RPC_URL at a private RPC".
    for (const raw of ['429 too many requests', 'rate limit exceeded', 'fetch failed']) {
      const c = classifyFailure(raw)
      expect(c.code).not.toBe('rpc_unavailable')
      expect(c.suggestedAction).not.toBe('check_rpc')
    }
  })

  it('a plain network blip that names no subsystem → network_unstable / retry (honest ignorance)', () => {
    const c = classifyFailure('Command failed: reppo list pods — socket hang up', { datanetId: '3' })
    expect(c.code).toBe('network_unstable')
    expect(c.suggestedAction).toBe('retry')
    expect(c.operatorMessage).not.toContain('RPC_URL')
  })

  it("queryDatanet.ts's own transient guard IS the chain RPC → rpc_unavailable", () => {
    // src/reppo/queryDatanet.ts:26 — 'INTERNAL_ERROR: datanet N metadata absent … (transient RPC?)'
    const c = classifyFailure('datanet error: INTERNAL_ERROR: datanet 6 metadata absent from CLI response (transient RPC?)')
    expect(c.code).toBe('rpc_unavailable')
    expect(c.suggestedAction).toBe('check_rpc')
  })

  it('a JSON-RPC -32603 is the chain RPC → rpc_unavailable', () => {
    expect(classifyFailure('Command failed: reppo query datanet 6 — JSON-RPC error -32603').code).toBe('rpc_unavailable')
  })
})

// ── The rest of the closed set (strings taken from the node's own source) ────────────────────
describe('classifyFailure — the remaining codes', () => {
  it.each([
    ['vote budget/rate exhausted'],                                   // wallet/executor.ts
    ['mint budget exhausted'],                                        // wallet/executor.ts
    ['claim gas budget exhausted'],                                   // wallet/executor.ts
    ['per-cycle vote budget/rate exhausted — skipping vote scoring'], // runtime/cycle.ts
    ['mint budget below one mint reserve — skipping mint discovery'], // runtime/cycle.ts
  ])('a ledger refusal ("%s") → budget_exhausted / raise_budget', (raw) => {
    const c = classifyFailure(raw)
    expect(c.code).toBe('budget_exhausted')
    expect(c.suggestedAction).toBe('raise_budget')
  })

  it.each([
    ['INSUFFICIENT_REPPO_BALANCE'],
    ["insufficient EXY balance for access fee (need 50 EXY) — fund this node's wallet with EXY"],
    ['INSUFFICIENT_ALLOWANCE'],
  ])('an underfunded wallet ("%s") → insufficient_funds / fund_wallet', (raw) => {
    const c = classifyFailure(raw)
    expect(c.code).toBe('insufficient_funds')
    expect(c.suggestedAction).toBe('fund_wallet')
  })

  it('a missing voter rubric / publisher spec is the same class as the live no-metadata case', () => {
    expect(classifyFailure('vote enabled but this datanet has no on-chain voter rubric (onboardingVoters) — voting not possible').code)
      .toBe('datanet_metadata_missing')
    expect(classifyFailure('mint enabled but this datanet has no on-chain publisher spec (onboardingPublishers) — minting not possible').code)
      .toBe('datanet_metadata_missing')
  })

  it('an ungranted subnet → subnet_access_missing / retry (the node retries on its own)', () => {
    const c = classifyFailure('subnet access not granted (grant-access error: pod manager reverted)')
    expect(c.code).toBe('subnet_access_missing')
    expect(c.suggestedAction).toBe('retry')
    expect(classifyFailure('Command failed: reppo vote — VOTER_LACKS_SUBNET_ACCESS').code).toBe('subnet_access_missing')
  })

  it.each([
    ['mint enabled but no adapter is configured for this datanet — minting not possible'],
    ['mint enabled but adapter "gdelt" is not registered on this node'],
  ])('a missing data source ("%s") → no_adapter / disable_datanet', (raw) => {
    const c = classifyFailure(raw)
    expect(c.code).toBe('no_adapter')
    expect(c.suggestedAction).toBe('disable_datanet')
  })

  it('an unkeyed scoring model → model_unavailable (a MISSING key, not a spent quota)', () => {
    expect(classifyFailure('vote skipped — no API key for the node default provider (openai)').code).toBe('model_unavailable')
    expect(classifyFailure('vote skipped — video scoring needs a Google API key (set LLM_KEY_GOOGLE)').code).toBe('model_unavailable')
  })

  it('an old reppo CLI → cli_outdated', () => {
    expect(classifyFailure('non-REPPO access fee needs reppo CLI ≥ 0.8.5 (this datanet charges 50 EXY for access)').code).toBe('cli_outdated')
  })

  it('discovered-but-rejected candidates → no_candidates', () => {
    expect(classifyFailure('4 mint candidate(s) discovered but none passed scoring/dedup (min score 7); nothing minted').code).toBe('no_candidates')
  })

  it('a scoring call that failed for a reason we cannot name → scoring_failed / retry', () => {
    // runtime/cycle.ts:503 — 'pod scoring skipped — <redacted provider error>'. The live quota
    // failure wears this exact prefix and must NOT land here; a provider overload genuinely does.
    const c = classifyFailure('pod scoring skipped — overloaded_error')
    expect(c.code).toBe('scoring_failed')
    expect(c.suggestedAction).toBe('retry')
  })

  it('CANNOT_VOTE_FOR_OWN_POD is benign → own_pod / none', () => {
    const c = classifyFailure('Command failed: reppo vote — CANNOT_VOTE_FOR_OWN_POD')
    expect(c.code).toBe('own_pod')
    expect(c.suggestedAction).toBe('none')
  })

  it('an unrecognised failure → unknown / retry, still in plain English', () => {
    const c = classifyFailure('something nobody has seen before', { datanetId: '7' })
    expect(c.code).toBe('unknown')
    expect(c.suggestedAction).toBe('retry')
    expect(c.operatorMessage).toContain('Datanet 7')
  })

  it('an absent/empty reason classifies as unknown rather than throwing', () => {
    expect(classifyFailure(undefined).code).toBe('unknown')
    expect(classifyFailure('   ').code).toBe('unknown')
  })
})

describe('redaction: operatorMessage can never carry a key or a keyed RPC URL', () => {
  it('a key riding the raw RPC error never reaches the operator message', () => {
    const raw = 'datanet error: Command failed: reppo query datanet 6 --rpc-url https://base-mainnet.g.alchemy.com/v2/SUPERSECRETKEY123 — {"error":{"code":"INTERNAL_ERROR","message":"HTTP request failed.\\nURL: https://base-mainnet.g.alchemy.com/v2/SUPERSECRETKEY123\\nRequest body: {\\"method\\":\\"eth_call\\"}"}}'
    const c = classifyFailure(raw, { datanetId: '6' })
    expect(c.code).toBe('rpc_unavailable')
    expect(c.operatorMessage).not.toContain('SUPERSECRETKEY123')
    expect(c.operatorMessage).not.toContain('alchemy')
    expect(c.operatorMessage).not.toContain('https://')
  })

  it('an LLM key folded into a provider quota error never reaches the operator message', () => {
    const raw = 'pod scoring skipped — Failed after 3 attempts. Last error: You exceeded your current quota (key AIzaSyA1234567890abcdefghijklmnopqrstuvw)'
    const c = classifyFailure(raw, { datanetId: '21' })
    expect(c.code).toBe('llm_quota_exhausted')
    expect(c.operatorMessage).not.toContain('AIzaSyA1234567890abcdefghijklmnopqrstuvw')
  })

  it('every LIVE failure produces an operatorMessage free of raw stderr, URLs and keys', () => {
    const live = [LIVE_RPC, LIVE_REPPO_API_UNREACHABLE, LIVE_REPPO_API_INVALID, LIVE_HL_429, LIVE_LLM_QUOTA, LIVE_NO_METADATA, LIVE_VOTE_CAP]
    for (const raw of live) {
      const m = classifyFailure(raw, { datanetId: '5' }).operatorMessage
      expect(m).not.toContain('https://')
      expect(m).not.toContain('Command failed')
      expect(m).not.toMatch(/INTERNAL_ERROR|PUBLIC_API_|eth_call|--rpc-url/)
    }
  })
})

describe('attachClassification (composed over buildHealth — health.ts untouched)', () => {
  it('classifies each datanet from its NEWEST failure, and leaves healthy datanets unclassified', () => {
    // newest-first, as readActivitySince returns
    const entries: ActivityEntry[] = [
      entry({ datanetId: '6', reason: LIVE_REPPO_API_INVALID }),
      entry({ datanetId: '4', reason: 'mint enabled but no adapter is configured for this datanet — minting not possible' }),
      entry({ datanetId: '9', kind: 'vote', status: 'executed', podId: 'p1', txHash: '0x1' }),
    ]
    const out = attachClassification(buildHealth(entries), entries)
    const d6 = out.datanets.find((d) => d.datanetId === '6')!
    const d4 = out.datanets.find((d) => d.datanetId === '4')!
    const d9 = out.datanets.find((d) => d.datanetId === '9')!

    expect(d6.classification).toMatchObject({ code: 'reppo_api_unavailable', suggestedAction: 'retry' })
    expect(d4.classification).toMatchObject({ code: 'no_adapter', suggestedAction: 'disable_datanet' })
    expect(d9.classification).toBeUndefined() // nothing to explain
    // the counting fields buildHealth owns pass through untouched
    expect(d9.votes.executed).toBe(1)
    expect(out.txRate.executed).toBe(1)
  })

  it('falls back to the newest ERROR detail when a datanet has no skip row', () => {
    const entries: ActivityEntry[] = [
      entry({ datanetId: '3', kind: 'vote', status: 'error', detail: 'Command failed: reppo vote — INSUFFICIENT_REPPO_BALANCE' }),
    ]
    const out = attachClassification(buildHealth(entries), entries)
    expect(out.datanets[0].classification).toMatchObject({ code: 'insufficient_funds', suggestedAction: 'fund_wallet' })
  })

  // A classification is a statement about the datanet's CURRENT state — it drives the
  // "N of M working" headline, a "can't run" alert, and a one-click "turn this datanet off"
  // remedy. A failure the datanet has since RECOVERED from must not keep it flagged: a single
  // transient RPC blip six days ago would otherwise mark a datanet that has executed hundreds
  // of votes since as blocked, for the whole 7-day window.
  it('a skip followed by a later SUCCESS is NOT classified — the datanet recovered', () => {
    const entries: ActivityEntry[] = [
      entry({ datanetId: '9', kind: 'vote', status: 'executed', txHash: '0x1' }), // newest
      entry({ datanetId: '9', reason: LIVE_VOTE_CAP }),
    ]
    const out = attachClassification(buildHealth(entries), entries)
    expect(out.datanets[0].idle).toBe(false)
    expect(out.datanets[0].classification).toBeUndefined()
  })

  it('the stale-RPC-blip case: one old error, hundreds of votes since → no classification', () => {
    const entries: ActivityEntry[] = [
      // newest-first: six days of healthy voting…
      ...Array.from({ length: 200 }, () => entry({ datanetId: '3', kind: 'vote', status: 'executed', txHash: '0x1' })),
      // …then, at the bottom of the window, the transient blip it recovered from
      entry({ datanetId: '3', kind: 'vote', status: 'error', detail: LIVE_RPC }),
    ]
    const out = attachClassification(buildHealth(entries), entries)
    expect(out.datanets[0].classification).toBeUndefined()
  })

  it('a failure that RECURRED after the last success IS classified (still broken now)', () => {
    const entries: ActivityEntry[] = [
      entry({ datanetId: '3', kind: 'vote', status: 'error', detail: LIVE_RPC }), // newest
      entry({ datanetId: '3', kind: 'vote', status: 'executed', txHash: '0x1' }),
      entry({ datanetId: '3', kind: 'vote', status: 'error', detail: LIVE_RPC }),
    ]
    const out = attachClassification(buildHealth(entries), entries)
    expect(out.datanets[0].classification).toMatchObject({ code: 'rpc_unavailable', suggestedAction: 'check_rpc' })
  })

  it('a non-executed row between the failure and now does not count as a recovery', () => {
    // refused-budget / a reasonless skip are not evidence the datanet works — only an EXECUTED
    // row is. datanet_metadata_missing carries the destructive remedy ("Turn this datanet off"),
    // so it must stay attached until the datanet actually runs.
    const entries: ActivityEntry[] = [
      entry({ datanetId: '20', kind: 'vote', status: 'refused-budget' }), // newest, not a success
      entry({ datanetId: '20', reason: LIVE_NO_METADATA }),
    ]
    const out = attachClassification(buildHealth(entries), entries)
    expect(out.datanets[0].classification).toMatchObject({ code: 'datanet_metadata_missing', suggestedAction: 'disable_datanet' })
  })

  it('a successful GRANT counts as recovery for the subnet-access failure it resolves', () => {
    const entries: ActivityEntry[] = [
      entry({ datanetId: '7', kind: 'grant', status: 'executed', reason: 'granted access — paid 50 EXY' }), // newest
      entry({ datanetId: '7', reason: 'subnet access not granted (grant-access error: ...)' }),
    ]
    const out = attachClassification(buildHealth(entries), entries)
    expect(out.datanets[0].classification).toBeUndefined()
  })
})
