# Non-REPPO datanet access fees — design

**Date:** 2026-06-15
**Status:** Approved (design); implementation pending
**Author:** Ana (with Claude Code)

## Problem

Orquestra today assumes every datanet access grant is paid in **REPPO**. Some
datanets on the Reppo protocol will charge their one-time **access grant fee in
their own token** — e.g. the Exylos datanet charges in `$EXY`. The node must be
able to enable such a datanet, pay the access fee in the correct token, and
**never silently mispay** (never pay REPPO when the datanet wants EXY, never
fire an unsupported CLI call).

The capability to pay a non-REPPO access fee is **coming to the reppo CLI /
protocol** but is not in the surface Orquestra targets today (CLI pinned at
`0.8.3`; `grant-access --help` reads "Pay the **REPPO** access fee", no
`--fee-token` flag; datanet metadata exposes `accessFeeREPPO` only). So the work
is: build the fee-currency abstraction now, behind one capability flag, and wire
real execution when the CLI ships it.

## Decisions (settled during brainstorming)

1. **Remove the grant-access budget entirely** (for REPPO too). Enabling a
   datanet is already the operator's consent to pay its one-time, per-subnet,
   cached access fee. The `grantReppoMax` cap adds little: grants only fire for
   explicitly-enabled datanets and never repeat. Removing it also means a
   non-REPPO access fee needs **no multi-token budget ledger at all**.
   - **Security note (accepted):** removing the cap removes the *ceiling on the
     fee amount*. The access fee is set by the datanet creator, so without a cap
     the node pays whatever that fee is (up to wallet balance) the first time it
     acts on an enabled datanet. Consent is preserved via explicit-enable +
     one-time + cached. No sanity ceiling is added.
2. **Scope = the one-time access grant only.** Mint fees stay REPPO. A
   documented seam is left so a per-token *mint* cap can drop in later without
   rework (mints are recurring/unbounded and would genuinely need a cap).
3. **Fail-closed = skip the datanet with a recorded reason.** Matches the
   existing per-datanet isolation invariant in `runtime/cycle.ts` (a missing
   capability skips only that datanet, is recorded, and never aborts the cycle).
4. **Metadata parse is tolerant and defaults to REPPO**, so all of today's
   datanets are unaffected.

## Phase 1 — Remove grant-access budget (self-contained precursor)

Ships as its own commit/PR; no behavior change for the node beyond dropping the
grant cap.

Delete:

- `src/config/schema.ts` — `budget.grantReppoMax` field (and its tooltip/doc).
- `src/wallet/ledger.ts` — `BudgetCaps.grantReppoMax`, `LedgerState.grantReppoSpent`,
  `canGrant`, `reserveGrant`, `reconcileGrant`, `releaseGrant`, and the
  `grantReppoSpent` reset line in `rollHorizonIfElapsed`.
- `src/wallet/executor.ts` — `GRANT_REPPO_EST` and the reserve/reconcile/release
  calls inside `executeGrantAccess`. **Keep** the `cli.grantAccess(...)` call and
  the `ACCESS_ALREADY_GRANTED`-as-success handling.
- `src/dashboard/snapshot.ts` (`SnapshotBudget.grantReppoSpent`), `src/dashboard/pnl.ts`,
  `src/runtime/wiring.ts` budget-snapshot build — drop `grantReppoSpent`.

Persistence: existing `budget_ledger` JSON rows may contain `grantReppoSpent`.
Loading must **ignore the extra field** (tolerant parse), not throw.

Tests/docs: update `src/wallet/ledger.test.ts` (grant cap cases),
`src/wallet/executor.test.ts` (grant budget cases), `src/config/schema.test.ts`,
snapshot tests, and `docs/operator-guide.md` (remove `grantReppoMax` sizing
guidance).

## Phase 2 — Non-REPPO access fee support

### 2.1 Metadata / rubric — *assumption, confirm with Reppo team*

`src/rubric/types.ts`: extend `DatanetRubric.economics` with an optional fee
token reference:

```ts
economics: {
  accessFeeAmount: number          // fee amount, denominated in accessFeeToken (was accessFeeReppo)
  accessFeeToken?: {               // absent ⇒ REPPO
    address: string
    symbol: string
    decimals: number
  }
  // ...existing fields
}
```

`src/rubric/parse.ts`: parse tolerantly.
- When the protocol exposes a non-REPPO access fee token, read its
  `{address, symbol, decimals}` and the token-denominated amount.
- When absent (every datanet today), default to REPPO:
  `{ symbol: 'REPPO', decimals: 18, address: REPPO_TOKEN_MAINNET }`, amount from
  the existing `accessFeeREPPO` field.

The exact metadata field name(s) are an open assumption (see below); the parser
isolates that assumption to one function.

### 2.2 Capability gate (fail-closed) — the one seam

Add a capability signal, version-gated through the existing
`src/reppo/version.ts` infrastructure:

```ts
// src/reppo/capabilities.ts
export const NONREPPO_GRANT_MIN_VERSION = 'TBD'  // confirm with Reppo team (> 0.8.3)
export function supportsNonReppoGrants(version: string): boolean { /* semver gte */ }
```

In `src/runtime/cycle.ts` grant block:

- access fee token **is REPPO** → existing grant path.
- token **is non-REPPO** and capability **off** → **skip datanet, record reason**
  ("non-REPPO access fee not yet supported by reppo CLI") via the existing
  per-datanet skip/record mechanism.
- token **is non-REPPO** and capability **on** → proceed to 2.3.

This is the single seam to flip when the CLI ships non-REPPO grants.

### 2.3 Executor + CLI

`src/wallet/executor.ts`: `executeGrantAccess(datanetId, feeToken?)`.
- REPPO → unchanged signing path (now without a budget gate, per Phase 1).
- non-REPPO → pass the token through to `cli.grantAccess`.
- **No budget gate.** Record the **actual fee paid** for visibility (consumed by
  2.5), read via the already-parameterizable `src/reppo/mintFee.ts` reader
  pointed at the fee token's address.

`src/reppo/cli.ts`: `grantAccess(datanetId, opts?: { feeToken?: TokenRef })`. The
non-REPPO invocation uses the assumed future CLI mechanism (auto-detect from the
datanet, or a `--fee-token` flag — open assumption). Because the call is behind
the capability gate, the non-REPPO branch only ever runs when the installed CLI
supports it.

### 2.4 Wallet balance check

Before a non-REPPO grant, confirm the wallet holds enough of the fee token via
an `eth_call balanceOf`. Insufficient → **skip datanet, record reason**
("insufficient EXY balance for access fee"). Add a small ERC20-balance helper
(distinct from `mintFee.ts`, which reads Transfer logs from receipts). The node
does **not** acquire the token — funding the wallet with EXY is the operator's
responsibility.

### 2.5 Visibility — dashboard / activity

`src/dashboard/activityLog.ts`: the grant activity entry gains `feeToken` +
amount so the operator sees e.g. "Paid 50 EXY access". `src/dashboard/pnl.ts`:
show non-REPPO fees paid **informationally** (not capped, not part of the REPPO
budget math).

### 2.6 Onboarding

`src/onboarding/`: when the operator enables a datanet whose access fee is
non-REPPO, the interview surfaces "this datanet charges N EXY for access — fund
the node's wallet with EXY" (no budget to set, since the grant budget is gone).

### 2.7 Mint seam (not built)

`executeMint` and the ledger stay REPPO-only. Mark the insertion point with a
`// SEAM: per-token mint fee cap` comment in `src/wallet/ledger.ts` /
`src/wallet/executor.ts` so a non-REPPO mint cap can be added later if mint fees
go non-REPPO.

## Testing

- **Phase 1 regressions:** ledger/executor no longer budget grants; schema,
  snapshot, and pnl drop `grantReppoSpent`; legacy ledger JSON with the field
  loads cleanly.
- **Parse:** non-REPPO `accessFeeToken` parsed correctly; absent ⇒ REPPO default;
  amount read in token units.
- **Cycle:** EXY datanet + capability **off** → skipped with the recorded reason;
  capability **on** → grant attempted with the token passed through.
- **Executor:** non-REPPO grant passes the token to the CLI, records the fee,
  applies no cap.
- **Balance:** insufficient EXY → datanet skipped with the recorded reason.

## Open assumptions (each touches only a thin seam — confirm with Reppo team)

1. **Metadata shape:** the exact field(s) the protocol exposes for a non-REPPO
   access fee (token `{address, symbol, decimals}` + amount). Isolated to
   `rubric/parse.ts`.
2. **CLI mechanism + version:** auto-detect from the datanet vs an explicit
   `--fee-token` flag, and the CLI version that ships it (`NONREPPO_GRANT_MIN_VERSION`,
   currently TBD, > 0.8.3). Isolated to `reppo/cli.ts` + `reppo/capabilities.ts`.
3. **Mint fees:** whether mints on these datanets also charge non-REPPO. Currently
   a documented seam, not built.

## Out of scope

- Acquiring/swapping into the fee token (operator funds the wallet).
- Per-token *mint* budget caps (seam only).
- Any change to REPPO datanets' behavior beyond removing the grant cap.
