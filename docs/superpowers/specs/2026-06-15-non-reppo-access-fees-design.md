# Non-REPPO datanet access fees — design

**Date:** 2026-06-15
**Status:** Approved (design); implementation pending
**Author:** Ana (with Claude Code)
**Repos touched:** `reppo-cli` (enabler), `orquestra` (consumer). **No smart-contract change.**

## Problem

Orquestra assumes every datanet access grant is paid in **REPPO**. Some datanets
charge their one-time **access grant fee in their own (primary) token** — e.g.
Exylos charges in `$EXY`. The node must enable such a datanet, pay the access fee
in the correct token, and **never silently mispay** (never pay REPPO when the
datanet wants EXY, never fire an unsupported CLI call).

## Key finding — the protocol already supports this; only the CLI lags

The on-chain `SubnetManager` contract (repo `economic-contracts`,
`src/SubnetManager.sol`) already exposes a **symmetric REPPO / primary-token fee
model** for every fee (create, access, publish, republish). For access:

- `accessSubnetWithPrimaryTokenFee(uint256 subnetId, address to)` — `SubnetManager.sol:327`
- `getAccessFeePrimaryToken(uint256 subnetId)` — `:506`
- `setAccessFeePrimaryToken(...)` — `:141` (the datanet creator sets the EXY fee)
- `getSubnetPrimaryToken(uint256 subnetId) → address` — `:570` (returns EXY's address)

`ISubnetManager.sol` confirms all of them. **So no Solidity / audit / governance /
redeploy is needed.** The work is in two TypeScript repos we own:

1. **`reppo-cli`** — the CLI's hand-maintained ABI omits the primary-token access
   methods, and `grant-access` has no token choice. The fix mirrors `mint-pod`,
   which already does this for minting (`mintPodWithREPPO` / `mintPodWithPrimaryToken`,
   `--token reppo|primary`).
2. **`orquestra`** — consume the CLI's new fee-token output and pass `--token
   primary` when a datanet's access fee is non-REPPO.

"$EXY datanet" maps onto Reppo's existing **primary-token** concept (the
`nativeToken` used for emissions and `mintPodWithPrimaryToken`). This extends an
existing currency model to the access path; it does not invent one.

## Decisions (settled during brainstorming)

1. **Remove the grant-access budget entirely** (REPPO too). Enabling a datanet is
   already the operator's consent to pay its one-time, per-subnet, cached access
   fee. Removing it also means a non-REPPO access fee needs **no multi-token
   budget ledger**.
   - **Security note (accepted):** this removes the *ceiling on the fee amount*.
     The fee is set by the datanet creator, so without a cap the node pays whatever
     it is (up to wallet balance) the first time it acts on an enabled datanet.
     Consent is preserved via explicit-enable + one-time + cached. No sanity ceiling.
2. **Scope = the one-time access grant only.** Mint fees stay REPPO in Orquestra.
   (Non-REPPO *minting* is already CLI-capable via `mint-pod --token primary`; only
   Orquestra's ledger doesn't track non-REPPO mint spend — left as a documented seam,
   since mints are recurring/unbounded and would need a real per-token cap.)
3. **Fail-closed = skip the datanet with a recorded reason.** Matches the existing
   per-datanet isolation invariant in `runtime/cycle.ts`.
4. **Metadata parse is tolerant and defaults to REPPO**, so today's datanets are
   unaffected.

## Phase 0 — `reppo-cli`: add primary-token access fee (the enabler)

Repo: `~/code/reppo-cli` (TypeScript, Clipanion v4, viem, Vitest; published `@reppo/cli`,
currently v0.8.4; Orquestra pins 0.8.3). Mirrors the `mint-pod` precedent exactly.

- **`src/chain/abis.ts`** — add to `SUBNET_MANAGER_ABI` the methods the contract
  already has but the ABI omits:
  - `function accessSubnetWithPrimaryTokenFee(uint256 subnetId, address to)`
  - `function getAccessFeePrimaryToken(uint256 subnetId) view returns (uint256)`
  - `function getSubnetPrimaryToken(uint256 subnetId) view returns (address)`
- **`src/chain/contracts.ts`** — add a generic `erc20(network, address)` resolver
  (only `reppoToken()` exists today) for the primary token's
  `balanceOf` / `allowance` / `decimals` / `symbol`.
- **`src/chain/receipt.ts`** — generalize `reppoFeeFromReceipt(receipt, tokenAddr, account)`
  → `tokenFeeFromReceipt(...)`; the REPPO call becomes a thin wrapper. Used to report
  the actual fee paid in the correct token.
- **`src/commands/grant-access.ts`** — add `token = Option.String('--token', 'reppo')`
  with `INVALID_TOKEN` validation, copied from `mint-pod.ts:94,139-145`.
  - `functionName = this.token === 'reppo' ? 'accessSubnetWithREPPOFee' : 'accessSubnetWithPrimaryTokenFee'`
  - fee getter by token: `getAccessFeeREPPO` vs `getAccessFeePrimaryToken`
  - **primary path:** resolve the token via `getSubnetPrimaryToken(datanetId)`, build
    its `erc20(...)`, **read `decimals()` (do NOT hardcode 18)**, check `balanceOf` /
    `allowance` against *that* token, and surface `feeToken: { symbol, address, decimals }`
    + the amount in the result JSON (alongside the existing REPPO fields).
  - keep idempotency two-phase write, `decodeRevert`, `ACCESS_ALREADY_GRANTED`.
- **`src/commands/query/datanet.ts`** — add `accessFeePrimaryToken` + the primary token
  `{ address, symbol, decimals }` to the `--json` output so consumers learn the fee
  currency. The gateway `RawSubnet` (`src/api/subnets.ts`) already carries
  `nativeTokenAddress/Symbol/Decimals`.
- **Tests** — `src/__tests__/command-error-paths.test.ts` (INVALID_TOKEN, insufficient
  primary balance/allowance) + colocated unit tests; assert decimals are read, not assumed.
- **Release** — `git tag v0.8.5`, push (GitHub Actions publishes `@reppo/cli`).

**Decimals is the one real correctness gotcha:** REPPO paths hardcode
`formatUnits(x, 18)`. A primary token may differ → read `decimals()`. Dedicated test.

## Phase 1 — `orquestra`: remove grant-access budget (self-contained precursor)

Delete:

- `src/config/schema.ts` — `budget.grantReppoMax` field (+ tooltip/doc).
- `src/wallet/ledger.ts` — `BudgetCaps.grantReppoMax`, `LedgerState.grantReppoSpent`,
  `canGrant`, `reserveGrant`, `reconcileGrant`, `releaseGrant`, and the
  `grantReppoSpent` reset line in `rollHorizonIfElapsed`.
- `src/wallet/executor.ts` — `GRANT_REPPO_EST` and the reserve/reconcile/release calls
  in `executeGrantAccess`. **Keep** the `cli.grantAccess(...)` call and the
  `ACCESS_ALREADY_GRANTED`-as-success handling.
- `src/dashboard/snapshot.ts` (`SnapshotBudget.grantReppoSpent`), `src/dashboard/pnl.ts`,
  `src/runtime/wiring.ts` budget-snapshot build — drop `grantReppoSpent`.

Persistence: existing `budget_ledger` JSON rows may contain `grantReppoSpent`. Loading
must **ignore the extra field** (tolerant parse), not throw.

Tests/docs: update `ledger.test.ts`, `executor.test.ts`, `config/schema.test.ts`,
snapshot tests, `docs/operator-guide.md` (remove `grantReppoMax` sizing guidance).

## Phase 2 — `orquestra`: non-REPPO access fee support

### 2.1 Metadata / rubric

`src/rubric/types.ts`: extend `DatanetRubric.economics`:

```ts
economics: {
  accessFeeAmount: number          // fee amount in accessFeeToken units (was accessFeeReppo)
  accessFeeToken: {                // the datanet's primary token, from the extended query datanet
    address: string
    symbol: string                 // 'REPPO' for today's datanets
    decimals: number
  }
  // ...existing fields
}
```

`src/rubric/parse.ts`: read `accessFeePrimaryToken` + the primary token
`{address, symbol, decimals}` from the CLI's (Phase-0) `query datanet --json`. When
absent (older CLI / REPPO-only datanet), default to REPPO
(`{ symbol: 'REPPO', decimals: 18, address: REPPO_TOKEN_MAINNET }`, amount from
`accessFeeREPPO`). Tolerant — today's datanets unchanged.

### 2.2 Capability gate (fail-closed) — the one seam

`src/reppo/capabilities.ts`: `NONREPPO_GRANT_MIN_VERSION = '0.8.5'` (the CLI version
Phase 0 ships), checked via existing `src/reppo/version.ts`.

In `src/runtime/cycle.ts` grant block:
- access fee token **is REPPO** → existing grant path.
- token **non-REPPO** and CLI `< 0.8.5` → **skip datanet, record reason**
  ("non-REPPO access fee needs reppo CLI ≥ 0.8.5"), via the existing per-datanet skip.
- token **non-REPPO** and CLI `≥ 0.8.5` → proceed to 2.3.

### 2.3 Executor + CLI wrapper

`src/wallet/executor.ts`: `executeGrantAccess(datanetId, token: 'reppo' | 'primary')`.
- REPPO → unchanged signing path (now without a budget gate, per Phase 1).
- non-REPPO → `token = 'primary'`. **No budget gate.** Record the actual fee paid
  (consumed by 2.5), read via the now-generic `mintFee.ts` reader pointed at the
  primary token's address.

`src/reppo/cli.ts`: `grantAccess(datanetId, opts?: { token?: 'reppo' | 'primary' })`
→ passes `--token primary`. Parse `feeToken` + amount from the result.

### 2.4 Wallet balance check

Before a non-REPPO grant, confirm the wallet holds enough of the primary token via
`eth_call balanceOf`. Insufficient → **skip datanet, record reason** ("insufficient
EXY balance for access fee"). The CLI also pre-flights this (`INSUFFICIENT_*`), but
Orquestra checks first to record a clean per-datanet skip rather than a CLI error.
The node does **not** acquire the token — funding the wallet is the operator's job.

### 2.5 Visibility — dashboard / activity

`src/dashboard/activityLog.ts`: the grant activity entry gains `feeToken` + amount,
so the operator sees "Paid 50 EXY access". `src/dashboard/pnl.ts`: show non-REPPO fees
**informationally** (not capped, not part of REPPO budget math).

### 2.6 Onboarding

`src/onboarding/`: when enabling a non-REPPO-fee datanet, the interview surfaces "this
datanet charges N EXY for access — fund the node's wallet with EXY" (no budget to set).

### 2.7 Mint seam (not built)

`executeMint` and the ledger stay REPPO-only. Mark the insertion point with a
`// SEAM: per-token mint fee cap` comment in `src/wallet/ledger.ts` /
`src/wallet/executor.ts`. (The CLI already supports `mint-pod --token primary`; only
Orquestra's per-token mint budget is deferred.)

## Sequencing

`reppo-cli` Phase 0 → release `v0.8.5` → `orquestra` Phases 1 & 2. Phase 1 (remove
grant budget) is independent and can land first in either order. Each repo gets its
own implementation plan.

## Testing

- **reppo-cli:** `--token primary` routes to `accessSubnetWithPrimaryTokenFee`; primary
  fee read from `getAccessFeePrimaryToken`; decimals read (not hardcoded);
  insufficient primary balance/allowance → structured error; `query datanet --json`
  includes the access fee token.
- **Orquestra Phase 1:** ledger/executor no longer budget grants; schema/snapshot/pnl
  drop `grantReppoSpent`; legacy ledger JSON loads cleanly.
- **Orquestra Phase 2:** parse (primary token parsed; absent ⇒ REPPO default); cycle
  (non-REPPO datanet + CLI < 0.8.5 → skipped w/ reason; ≥ 0.8.5 → grant w/ `--token
  primary`); executor (passes token, records fee, no cap); insufficient-balance skip.

## Open assumptions (resolved by the investigation)

1. ~~Metadata shape~~ → **resolved:** the access fee token = the datanet's primary
   token (`getSubnetPrimaryToken` + gateway `nativeToken*`); Phase 0 surfaces it in
   `query datanet --json`.
2. ~~CLI mechanism + version~~ → **resolved:** `grant-access --token reppo|primary`,
   mirroring `mint-pod`; shipped in the version we publish (`0.8.5`).
3. **Mint fees:** whether Orquestra should also pay/track mints in the primary token.
   CLI-capable today; deferred as a documented seam.

## Out of scope

- Smart-contract changes (not needed — `SubnetManager` already supports it).
- Acquiring/swapping into the fee token (operator funds the wallet).
- Per-token *mint* budget caps in Orquestra (seam only).
- Any change to REPPO datanets' behavior beyond removing the grant cap.
