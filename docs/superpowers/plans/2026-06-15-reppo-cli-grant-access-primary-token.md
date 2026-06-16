# reppo-cli: grant-access primary-token fee — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `reppo grant-access --token reppo|primary` so a datanet's access fee can be paid in its primary token (e.g. $EXY), and surface the primary-token access fee in `reppo query datanet --json`.

**Architecture:** The `SubnetManager` contract already exposes `accessSubnetWithPrimaryTokenFee` / `getAccessFeePrimaryToken` / `getSubnetPrimaryToken` (verified in `~/code/economic-contracts/src/SubnetManager.sol`). The CLI's hand-maintained ABI just omits them. This change mirrors the existing `mint-pod --token reppo|primary` pattern: add the ABI methods, a generic ERC20 resolver, a decimals-aware fee-from-receipt helper, then route `grant-access` by token choice and resolve the primary token on-chain. **No contract change.**

**Tech Stack:** TypeScript (ES2022, NodeNext), Clipanion v4, viem v2, Vitest. Repo: `~/code/reppo-cli` (`@reppo/cli`, currently v0.8.4).

**Spec:** `orquestra/docs/superpowers/specs/2026-06-15-non-reppo-access-fees-design.md` (Phase 0).

> All paths below are absolute under `~/code/reppo-cli`. Run every command from that repo root.

---

### Task 0: Branch and verify baseline

**Files:** none (git only)

- [ ] **Step 1: Branch off a clean main**

```bash
cd ~/code/reppo-cli
git checkout main && git pull
git checkout -b feat/grant-access-primary-token
```

- [ ] **Step 2: Verify the baseline is green**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all suites PASS (this is the pre-change baseline).

---

### Task 1: Add primary-token access methods to the SubnetManager ABI

**Files:**
- Modify: `src/chain/abis.ts:35-40`
- Test: `src/chain/contracts.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/chain/contracts.test.ts`:

```ts
import { SUBNET_MANAGER_ABI } from './abis.js';

describe('SUBNET_MANAGER_ABI — primary-token access surface', () => {
  const fnNames = SUBNET_MANAGER_ABI.filter((e) => e.type === 'function').map((e) => e.name);

  it('includes accessSubnetWithPrimaryTokenFee', () => {
    expect(fnNames).toContain('accessSubnetWithPrimaryTokenFee');
  });
  it('includes getAccessFeePrimaryToken', () => {
    expect(fnNames).toContain('getAccessFeePrimaryToken');
  });
  it('includes getSubnetPrimaryToken', () => {
    expect(fnNames).toContain('getSubnetPrimaryToken');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/chain/contracts.test.ts`
Expected: FAIL — the three `toContain` assertions fail (methods not in the ABI yet).

- [ ] **Step 3: Add the methods to the ABI**

Replace the `SUBNET_MANAGER_ABI` block in `src/chain/abis.ts` (lines 35-40) with:

```ts
export const SUBNET_MANAGER_ABI = parseAbi([
  'function accessSubnetWithREPPOFee(uint256 subnetId, address to)',
  'function accessSubnetWithPrimaryTokenFee(uint256 subnetId, address to)',
  'function hasSubnetAccess(uint256 subnetId, address address_) view returns (bool)',
  'function validSubnet(uint256 subnetId) view returns (bool)',
  'function getAccessFeeREPPO(uint256 subnetId) view returns (uint256)',
  'function getAccessFeePrimaryToken(uint256 subnetId) view returns (uint256)',
  'function getSubnetPrimaryToken(uint256 subnetId) view returns (address)',
]);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/chain/contracts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/chain/abis.ts src/chain/contracts.test.ts
git commit -m "feat(abis): add SubnetManager primary-token access methods"
```

---

### Task 2: Add a generic `erc20(address)` contract resolver

The primary token address is discovered at runtime (via `getSubnetPrimaryToken`), not pinned in `addresses.ts`, so we need a resolver that binds the ERC20 ABI to an arbitrary address.

**Files:**
- Modify: `src/chain/contracts.ts` (after `reppoToken`, ~line 58)
- Test: `src/chain/contracts.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/chain/contracts.test.ts`:

```ts
import { erc20 } from './contracts.js';

describe('erc20(address) — generic ERC20 resolver', () => {
  it('binds the ERC20 ABI to an arbitrary token address', () => {
    const addr = '0x1234567890123456789012345678901234567890' as const;
    const c = erc20(addr);
    expect(c.address).toBe(addr);
    expect(c.abi.some((e) => e.type === 'function' && e.name === 'decimals')).toBe(true);
    expect(c.abi.some((e) => e.type === 'function' && e.name === 'balanceOf')).toBe(true);
    expect(c.abi.some((e) => e.type === 'function' && e.name === 'allowance')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/chain/contracts.test.ts`
Expected: FAIL — `erc20` is not exported.

- [ ] **Step 3: Add the resolver**

In `src/chain/contracts.ts`, immediately after the `reppoToken` function (ends at line 58), add:

```ts
/**
 * Generic ERC20 resolver for a token whose address is discovered at runtime
 * (e.g. a datanet's primary token via getSubnetPrimaryToken), not pinned in
 * addresses.ts. No TBD check — the caller already holds a concrete address.
 */
export function erc20(address: Address): Contract<typeof ERC20_ABI> {
  return { address, abi: ERC20_ABI };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/chain/contracts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/chain/contracts.ts src/chain/contracts.test.ts
git commit -m "feat(contracts): add generic erc20(address) resolver"
```

---

### Task 3: Generalize the fee-from-receipt helper to arbitrary decimals

`reppoFeeFromReceipt` hardcodes `formatEther` (18 decimals). A primary token can have other decimals (e.g. USDC = 6), so add `tokenFeeFromReceipt(receipt, token, caller, decimals)` and make `reppoFeeFromReceipt` a thin wrapper.

**Files:**
- Modify: `src/chain/receipt.ts:6` (import) and `:34-45` (the function)
- Test: `src/chain/receipt.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/chain/receipt.test.ts`:

```ts
import { tokenFeeFromReceipt } from './receipt.js';

describe('tokenFeeFromReceipt — arbitrary decimals', () => {
  const TOKEN = '0x00000000000000000000000000000000000000Ee' as const;
  const CALLER = '0x726c000000000000000000000000000000000000' as const;
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const topicFor = (addr: string) => '0x' + addr.toLowerCase().slice(2).padStart(64, '0');
  const log = (rawAmount: bigint) => ({
    address: TOKEN,
    data: '0x' + rawAmount.toString(16).padStart(64, '0'),
    topics: [TRANSFER, topicFor(CALLER), topicFor('0x' + 'b'.repeat(40))],
  });

  it('formats a 6-decimal token fee (50 EXY) correctly', () => {
    const receipt = { logs: [log(50n * 10n ** 6n)] } as unknown as TransactionReceipt;
    expect(tokenFeeFromReceipt(receipt, TOKEN, CALLER, 6)).toBe('50');
  });

  it('sums multiple 6-decimal transfers from the caller', () => {
    const receipt = { logs: [log(10n * 10n ** 6n), log(5n * 10n ** 6n)] } as unknown as TransactionReceipt;
    expect(tokenFeeFromReceipt(receipt, TOKEN, CALLER, 6)).toBe('15');
  });

  it('matches an 18-decimal amount as a plain integer string', () => {
    const receipt = { logs: [log(2n * 10n ** 18n)] } as unknown as TransactionReceipt;
    expect(tokenFeeFromReceipt(receipt, TOKEN, CALLER, 18)).toBe('2');
  });

  it('returns "0" when no transfer from the caller exists', () => {
    expect(tokenFeeFromReceipt({ logs: [] } as unknown as TransactionReceipt, TOKEN, CALLER, 6)).toBe('0');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/chain/receipt.test.ts`
Expected: FAIL — `tokenFeeFromReceipt` is not exported.

- [ ] **Step 3: Implement the generalized helper**

In `src/chain/receipt.ts`, change the viem import on line 6 from:

```ts
import { WaitForTransactionReceiptTimeoutError, formatEther } from 'viem';
```

to:

```ts
import { WaitForTransactionReceiptTimeoutError, formatEther, formatUnits } from 'viem';
```

Then replace the `reppoFeeFromReceipt` function (lines 34-45) with:

```ts
/**
 * Actual amount of `token` paid by `caller` in a confirmed tx, as a decimal
 * string at the token's `decimals`. Sums the token's Transfer events where
 * `from` is the caller. Returns "0" when none exist. Generalizes
 * reppoFeeFromReceipt to non-18-decimal fee tokens (a datanet's primary token).
 */
export function tokenFeeFromReceipt(
  receipt: TransactionReceipt,
  token: Address,
  caller: Address,
  decimals: number,
): string {
  const tokenAddr = token.toLowerCase();
  const from = caller.toLowerCase().slice(2).padStart(64, '0');
  let total = 0n;
  for (const log of receipt.logs ?? []) {
    if (log.address.toLowerCase() !== tokenAddr) continue;
    if ((log.topics?.[0] ?? '').toLowerCase() !== TRANSFER_TOPIC) continue;
    if ((log.topics?.[1] ?? '').toLowerCase().slice(2) !== from) continue;
    try { total += BigInt(log.data); } catch { /* malformed log data — skip */ }
  }
  return formatUnits(total, decimals);
}

/**
 * Actual REPPO paid in a confirmed tx (18 decimals), as a decimal string. Thin
 * wrapper over tokenFeeFromReceipt; kept for existing REPPO-path callers.
 */
export function reppoFeeFromReceipt(receipt: TransactionReceipt, reppoToken: Address, caller: Address): string {
  return tokenFeeFromReceipt(receipt, reppoToken, caller, 18);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/chain/receipt.test.ts`
Expected: PASS (both the new `tokenFeeFromReceipt` block and the existing `reppoFeeFromReceipt` block — the wrapper preserves behavior).

- [ ] **Step 5: Commit**

```bash
git add src/chain/receipt.ts src/chain/receipt.test.ts
git commit -m "feat(receipt): add decimals-aware tokenFeeFromReceipt"
```

---

### Task 4: Add the `--token` flag + INVALID_TOKEN validation to grant-access

This task adds only the flag and its pre-flight validation (fires before any chain call, mirroring `mint-pod`). Routing comes in Task 5.

**Files:**
- Modify: `src/commands/grant-access.ts` (add `token` option + validation)
- Test: `src/__tests__/command-error-paths.test.ts` (the `grant-access` describe block, ~line 184)

- [ ] **Step 1: Write the failing test**

Inside the `describe('grant-access', ...)` block in `src/__tests__/command-error-paths.test.ts`, add:

```ts
  it('rejects unknown --token with INVALID_TOKEN', async () => {
    const r = await runCli(['grant-access', '--datanet', '19', '--token', 'bogus', ...JSON_FLAG], { REPPO_PRIVATE_KEY: FAKE_PK, REPPO_NETWORK: 'testnet' });
    expect(r.exitCode).not.toBe(0);
    expect(parseError(r.stderr).code).toBe('INVALID_TOKEN');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/command-error-paths.test.ts -t "grant-access"`
Expected: FAIL — without a `--token` option Clipanion errors with an unknown-option usage error (not `INVALID_TOKEN`), so the `code` assertion fails.

- [ ] **Step 3: Add the option and validation**

In `src/commands/grant-access.ts`, add the `token` option right after the `datanet` option (line 55):

```ts
  token = Option.String('--token', 'reppo', { description: 'Fee asset — "reppo" (default) or "primary"' });
```

Then, inside `execute()`, immediately after the `datanetId` parse `catch` block (after line 77), add:

```ts
      if (this.token !== 'reppo' && this.token !== 'primary') {
        throw cliError('INVALID_TOKEN', `--token must be "reppo" or "primary"; got "${this.token}".`);
      }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/command-error-paths.test.ts -t "grant-access"`
Expected: PASS (all grant-access error-path tests, including the new INVALID_TOKEN one).

- [ ] **Step 5: Commit**

```bash
git add src/commands/grant-access.ts src/__tests__/command-error-paths.test.ts
git commit -m "feat(grant-access): add --token reppo|primary flag + validation"
```

---

### Task 5: Route grant-access by token, resolve the primary token, emit fee-token fields

Adds a unit-testable `accessFns` mapping helper, then rewrites `execute()` to resolve the fee token (REPPO pinned, or primary discovered on-chain with its real `decimals`), run pre-flight against that token, and emit `feeToken` / `feeAmount` / `feePaid`.

**Files:**
- Modify: `src/commands/grant-access.ts` (full rewrite below)
- Test: `src/commands/grant-access.test.ts` (new)

- [ ] **Step 1: Write the failing test for the mapping helper**

Create `src/commands/grant-access.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { accessFns } from './grant-access.js';

describe('accessFns', () => {
  it('maps "reppo" to the REPPO access method + fee getter', () => {
    expect(accessFns('reppo')).toEqual({
      access: 'accessSubnetWithREPPOFee',
      feeGetter: 'getAccessFeeREPPO',
    });
  });

  it('maps "primary" to the primary-token access method + fee getter', () => {
    expect(accessFns('primary')).toEqual({
      access: 'accessSubnetWithPrimaryTokenFee',
      feeGetter: 'getAccessFeePrimaryToken',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/commands/grant-access.test.ts`
Expected: FAIL — `accessFns` is not exported.

- [ ] **Step 3: Rewrite grant-access.ts**

Replace the **entire** contents of `src/commands/grant-access.ts` with:

```ts
/**
 * `reppo grant-access --datanet <id> [--to <addr>] [--token reppo|primary]` —
 * pay the datanet access fee and grant `--to` access. Paid in REPPO by default,
 * or in the datanet's primary token with `--token primary` (mirrors
 * `mint-pod --token`). Defaults `--to` to the address from REPPO_PRIVATE_KEY.
 *
 * On-chain the concept is a "subnet". For REPPO we call
 * `accessSubnetWithREPPOFee` + `getAccessFeeREPPO`; for the primary token,
 * `accessSubnetWithPrimaryTokenFee` + `getAccessFeePrimaryToken`, with the token
 * address resolved via `getSubnetPrimaryToken` and its `decimals()` read on-chain
 * (never assumed 18).
 *
 * Pre-flight (all surface error codes BEFORE the cache write):
 *   1. INVALID_TOKEN                    (--token not reppo|primary)
 *   2. validSubnet(datanetId)           → DATANET_NOT_FOUND
 *   3. hasSubnetAccess(datanetId, to)   → ACCESS_ALREADY_GRANTED
 *   4. fee getter                       → fee amount (in the fee token)
 *   5. feeToken balance >= fee          → INSUFFICIENT_REPPO_BALANCE / INSUFFICIENT_TOKEN_BALANCE
 *   6. feeToken allowance(caller→sm) ≥  → INSUFFICIENT_ALLOWANCE
 *
 * Idempotency: begin → submit → markSubmitted → wait → markConfirmed.
 * Args fingerprint: { datanetId, to, token }.
 */
import { Option } from 'clipanion';
import { formatUnits, isAddress, type Address } from 'viem';
import { BaseCommand } from './_base.js';
import { cliError, emit } from '../output/format.js';
import { createClients, nextNonce } from '../chain/clients.js';
import { subnetManager, reppoToken, erc20 } from '../chain/contracts.js';
import { decodeRevert } from '../chain/errors.js';
import { handleSubmittedCacheDecision } from './write-cache.js';
import { waitForWriteReceipt, receiptGasEth, tokenFeeFromReceipt } from '../chain/receipt.js';
import { begin, markSubmitted, markConfirmed, markFailed, peekIdempotent } from '../state/idempotency.js';

const COMMAND = 'grant-access';

/** Maps the --token choice to the SubnetManager access method + fee getter. */
export function accessFns(token: 'reppo' | 'primary'): {
  access: 'accessSubnetWithREPPOFee' | 'accessSubnetWithPrimaryTokenFee';
  feeGetter: 'getAccessFeeREPPO' | 'getAccessFeePrimaryToken';
} {
  return token === 'reppo'
    ? { access: 'accessSubnetWithREPPOFee', feeGetter: 'getAccessFeeREPPO' }
    : { access: 'accessSubnetWithPrimaryTokenFee', feeGetter: 'getAccessFeePrimaryToken' };
}

export class GrantAccessCommand extends BaseCommand {
  static override paths = [['grant-access']];

  static override usage = BaseCommand.Usage({
    description: 'Pay the datanet access fee (REPPO or the datanet primary token) and grant an address access.',
    examples: [
      ['Grant the wallet derived from REPPO_PRIVATE_KEY access to datanet 19 (paid in REPPO)',
        'reppo grant-access --datanet 19'],
      ['Pay the access fee in the datanet primary token instead',
        'reppo grant-access --datanet 19 --token primary'],
      ['Grant a different address access',
        'reppo grant-access --datanet 19 --to 0x726c…E31d'],
      ['With idempotency key',
        'reppo grant-access --datanet 19 --idempotency-key grant-19-self'],
      ['Dry-run',
        'reppo grant-access --datanet 19 --dry-run'],
    ],
  });

  datanet = Option.String('--datanet', { required: true, description: 'Datanet (subnet) ID to grant access to' });
  token = Option.String('--token', 'reppo', { description: 'Fee asset — "reppo" (default) or "primary"' });
  to = Option.String('--to', { description: 'Address to grant access to (defaults to address derived from REPPO_PRIVATE_KEY)' });
  idempotencyKey = Option.String('--idempotency-key');
  dryRun = Option.Boolean('--dry-run', false);

  async execute(): Promise<number> {
    try {
      const cfg = this.loadConfig();
      const pk = cfg.privateKey;
      if (!pk) {
        throw cliError('MISSING_PRIVATE_KEY', 'No signing key available.', 'Set REPPO_PRIVATE_KEY in env.');
      }

      let datanetId: bigint;
      try {
        datanetId = BigInt(this.datanet);
      } catch {
        throw cliError('INVALID_DATANET_ID', `Datanet id must be a non-negative integer; got "${this.datanet}".`);
      }

      if (this.token !== 'reppo' && this.token !== 'primary') {
        throw cliError('INVALID_TOKEN', `--token must be "reppo" or "primary"; got "${this.token}".`);
      }
      const fns = accessFns(this.token);

      const clients = createClients({
        network: cfg.network,
        privateKey: pk,
        ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}),
      });

      const target: Address = this.to
        ? (isAddress(this.to)
            ? this.to
            : (() => { throw cliError('INVALID_ADDRESS', `Invalid --to address: ${this.to}`); })())
        : clients.account.address;

      const args = { datanetId: datanetId.toString(), to: target.toLowerCase(), token: this.token };

      const decision = await peekIdempotent<Record<string, unknown>>(
        this.idempotencyKey, COMMAND, args, this.dryRun,
      );
      if (decision.kind === 'return-confirmed') {
        emit({ ...decision.result, idempotent: true, status: 'confirmed' },
          [`(cached, confirmed) tx: ${decision.txHash ?? 'n/a'}`]);
        return 0;
      }
      if (decision.kind === 'return-submitted') {
        const clients2 = createClients({
          network: cfg.network,
          privateKey: pk,
          ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}),
        });
        return handleSubmittedCacheDecision(decision, {
          idempotencyKey: this.idempotencyKey,
          command: COMMAND,
          args,
          network: cfg.network,
          publicClient: clients2.publicClient,
          buildResult: async () => ({ datanetId: datanetId.toString(), to: target, token: this.token }),
        });
      }

      const sm = subnetManager(cfg.network);

      // Resolve the fee token: REPPO (pinned) or the datanet's primary token
      // (discovered on-chain). decimals MUST be read for the primary token,
      // never assumed 18 — a non-18-decimal token would otherwise corrupt every
      // amount.
      let feeTokenAddress: Address;
      let feeTokenDecimals: number;
      let feeTokenSymbol: string;
      if (this.token === 'reppo') {
        feeTokenAddress = reppoToken(cfg.network).address;
        feeTokenDecimals = 18;
        feeTokenSymbol = 'REPPO';
      } else {
        feeTokenAddress = await clients.publicClient.readContract({
          address: sm.address, abi: sm.abi, functionName: 'getSubnetPrimaryToken', args: [datanetId],
        });
        const ft = erc20(feeTokenAddress);
        const [dec, sym] = await Promise.all([
          clients.publicClient.readContract({ ...ft, functionName: 'decimals' }),
          clients.publicClient.readContract({ ...ft, functionName: 'symbol' }),
        ]);
        feeTokenDecimals = Number(dec);
        feeTokenSymbol = sym;
      }
      const feeToken = erc20(feeTokenAddress);

      // Pre-flight in parallel where independent.
      const [valid, alreadyHasAccess, fee, balance, allowance] = await Promise.all([
        clients.publicClient.readContract({ address: sm.address, abi: sm.abi, functionName: 'validSubnet', args: [datanetId] }),
        clients.publicClient.readContract({ address: sm.address, abi: sm.abi, functionName: 'hasSubnetAccess', args: [datanetId, target] }),
        clients.publicClient.readContract({ address: sm.address, abi: sm.abi, functionName: fns.feeGetter, args: [datanetId] }),
        clients.publicClient.readContract({ ...feeToken, functionName: 'balanceOf', args: [clients.account.address] }),
        clients.publicClient.readContract({ ...feeToken, functionName: 'allowance', args: [clients.account.address, sm.address] }),
      ]);

      if (!valid) {
        throw cliError('DATANET_NOT_FOUND', `Datanet ${datanetId} does not exist on ${cfg.network}.`,
          `Verify the id; check \`reppo query datanet ${datanetId}\` before granting access.`);
      }
      if (alreadyHasAccess) {
        throw cliError('ACCESS_ALREADY_GRANTED', `${target} already has access to datanet ${datanetId}.`,
          'Nothing to do — skip the call.');
      }
      if (balance < fee) {
        throw cliError(
          this.token === 'reppo' ? 'INSUFFICIENT_REPPO_BALANCE' : 'INSUFFICIENT_TOKEN_BALANCE',
          `Caller has ${formatUnits(balance, feeTokenDecimals)} ${feeTokenSymbol} but the fee is ${formatUnits(fee, feeTokenDecimals)} ${feeTokenSymbol}.`,
          `Acquire more ${feeTokenSymbol} before granting access.`,
        );
      }
      if (allowance < fee) {
        throw cliError('INSUFFICIENT_ALLOWANCE',
          `${feeTokenSymbol} allowance from ${clients.account.address} to SubnetManager is ${formatUnits(allowance, feeTokenDecimals)}, ` +
          `below the fee of ${formatUnits(fee, feeTokenDecimals)} ${feeTokenSymbol}.`,
          `Approve the SubnetManager (${sm.address}) for at least ${formatUnits(fee, feeTokenDecimals)} ${feeTokenSymbol} ` +
          `(send the approve() tx manually, e.g. via cast).`);
      }

      const feeFields = {
        feeToken: { symbol: feeTokenSymbol, address: feeTokenAddress, decimals: feeTokenDecimals },
        feeAmount: { raw: fee.toString(), formatted: formatUnits(fee, feeTokenDecimals) },
        // Legacy REPPO field for back-compat with existing consumers; only set on the REPPO path.
        ...(this.token === 'reppo'
          ? { feeREPPO: { raw: fee.toString(), formatted: formatUnits(fee, 18) } }
          : {}),
      };

      if (this.dryRun) {
        const sim = await clients.publicClient.simulateContract({
          address: sm.address, abi: sm.abi, functionName: fns.access,
          args: [datanetId, target], account: clients.account,
        }).catch((e) => {
          const decoded = decodeRevert(e);
          throw cliError(decoded.code, 'Simulation reverted', decoded.hint);
        });
        emit({
          simulated: true,
          datanetId: datanetId.toString(),
          to: target,
          token: this.token,
          ...feeFields,
          gas: sim.request.gas?.toString() ?? null,
        });
        return 0;
      }

      if (this.idempotencyKey) await begin(this.idempotencyKey, COMMAND, args);

      let tx: `0x${string}`;
      try {
        const nonce = await nextNonce(clients.publicClient, clients.account.address);
        tx = await clients.walletClient.writeContract({
          address: sm.address, abi: sm.abi, functionName: fns.access,
          args: [datanetId, target],
          chain: clients.walletClient.chain, account: clients.account, nonce,
        });
      } catch (e) {
        const decoded = decodeRevert(e);
        if (this.idempotencyKey) await markFailed(this.idempotencyKey, COMMAND, args, decoded.code);
        throw cliError(decoded.code, 'grant-access tx failed to submit', decoded.hint);
      }

      if (this.idempotencyKey) {
        await markSubmitted(this.idempotencyKey, COMMAND, args, tx, {
          datanetId: datanetId.toString(), to: target, token: this.token, ...feeFields,
        });
      }

      const receipt = await waitForWriteReceipt(clients.publicClient, tx);
      if (receipt.status === 'reverted') {
        if (this.idempotencyKey) await markFailed(this.idempotencyKey, COMMAND, args, 'TX_REVERTED', tx);
        throw cliError('TX_REVERTED', `grant-access tx reverted: ${tx}`);
      }

      const result = {
        txHash: tx,
        gasEth: receiptGasEth(receipt),
        feePaid: tokenFeeFromReceipt(receipt, feeTokenAddress, clients.account.address, feeTokenDecimals),
        datanetId: datanetId.toString(),
        to: target,
        token: this.token,
        ...feeFields,
        block: receipt.blockNumber.toString(),
        basescanUrl: cfg.network === 'mainnet'
          ? `https://basescan.org/tx/${tx}`
          : `https://sepolia.basescan.org/tx/${tx}`,
      };
      if (this.idempotencyKey) await markConfirmed(this.idempotencyKey, COMMAND, args, result, tx);

      emit(result, [
        `✓ Granted ${target} access to datanet ${datanetId}`,
        `  fee paid: ${result.feePaid} ${feeTokenSymbol}`,
        `  tx: ${result.basescanUrl}`,
        `  block: ${receipt.blockNumber}`,
      ]);
      return 0;
    } catch (err) {
      this.handleError(err);
    }
  }
}
```

- [ ] **Step 4: Run unit + error-path + typecheck**

Run: `npx vitest run src/commands/grant-access.test.ts src/__tests__/command-error-paths.test.ts && npm run typecheck`
Expected: PASS — `accessFns` tests pass, all grant-access error-path tests still pass, and typecheck is clean.

- [ ] **Step 5: Manual on-chain verification (testnet, dry-run — no funds moved)**

Run (replace `<id>` with a real testnet datanet whose primary token is set, and `<key>` with a funded testnet key):

```bash
REPPO_NETWORK=testnet REPPO_PRIVATE_KEY=<key> npx tsx src/bin.ts grant-access --datanet <id> --token primary --dry-run --json
```

Expected: JSON with `simulated: true`, a `feeToken` whose `symbol`/`decimals` match the datanet's primary token, and a `feeAmount.formatted` consistent with those decimals. (A revert here decodes to a structured error — capture it for the report.)

- [ ] **Step 6: Commit**

```bash
git add src/commands/grant-access.ts src/commands/grant-access.test.ts
git commit -m "feat(grant-access): pay access fee in datanet primary token"
```

---

### Task 6: Surface the primary-token access fee in `query datanet --json`

So consumers (Orquestra) learn the access-fee currency without a write.

**Files:**
- Modify: `src/commands/query/datanet.ts` (import + read + result)
- Test: `src/commands/query/datanet.test.ts` (extend the chain mock + add assertions)

- [ ] **Step 1: Extend the failing test**

In `src/commands/query/datanet.test.ts`, update the `vi.mock('../../chain/clients.js')` dispatch (lines 15-25) to also answer the primary-token reads:

```ts
vi.mock('../../chain/clients.js', () => ({
  createReadClient: vi.fn(() => ({
    readContract: ({ functionName }: { functionName: string }) => {
      if (functionName === 'validSubnet') return Promise.resolve(true);
      if (functionName === 'getAccessFeeREPPO') return Promise.resolve(50n * 10n ** 18n);
      if (functionName === 'hasSubnetAccess') return Promise.resolve(false);
      if (functionName === 'currentEpoch') return Promise.resolve(97n);
      if (functionName === 'getSubnetPrimaryToken') return Promise.resolve('0xEeEE000000000000000000000000000000000000');
      if (functionName === 'getAccessFeePrimaryToken') return Promise.resolve(25n * 10n ** 18n);
      if (functionName === 'decimals') return Promise.resolve(18);
      return Promise.resolve(undefined);
    },
  })),
}));
```

Extend the `Result` interface (lines 105-111) with:

```ts
  accessFeePrimaryToken: { formatted?: string } | { unavailable: string };
  primaryToken?: { address: string; decimals: number };
```

And add assertions inside the existing `'merges the catalog row matched by tokenId into output.metadata'` test, after the existing metadata assertions and before that test's closing `});`:

```ts
    // Primary-token access fee surfaced for non-REPPO-fee datanets.
    expect('formatted' in out.accessFeePrimaryToken ? out.accessFeePrimaryToken.formatted : null).toBe('25');
    expect(out.primaryToken?.address).toBe('0xEeEE000000000000000000000000000000000000');
    expect(out.primaryToken?.decimals).toBe(18);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/commands/query/datanet.test.ts`
Expected: FAIL — `out.accessFeePrimaryToken` / `out.primaryToken` are undefined (command doesn't emit them yet).

- [ ] **Step 3: Implement the reads + output**

In `src/commands/query/datanet.ts`:

(a) Add `erc20` to the contracts import (line 25), so it reads:

```ts
import { trySubnetManager, tryVeReppo, erc20 } from '../../chain/contracts.js';
```

(b) Immediately after the `accessFeeREPPO` block (after line 134, before the `// Optional caller-access check.` comment on line 136), add:

```ts
      // Primary-token access fee — for datanets that charge access in their own
      // token rather than REPPO. Best-effort and decimals-aware: a revert here
      // (or a datanet with no primary token) must NOT break the REPPO answer.
      let accessFeePrimaryToken: Numeric = unavailable('not read');
      let primaryToken: { address: string; decimals: number } | undefined;
      if (valid) {
        try {
          const primaryAddr = (await client.readContract({
            ...sm, functionName: 'getSubnetPrimaryToken', args: [datanetId],
          })) as Address;
          const ft = erc20(primaryAddr);
          const [dec, pFee] = await Promise.all([
            client.readContract({ ...ft, functionName: 'decimals' }),
            client.readContract({ ...sm, functionName: 'getAccessFeePrimaryToken', args: [datanetId] }),
          ]);
          const decimals = Number(dec);
          primaryToken = { address: primaryAddr, decimals };
          accessFeePrimaryToken = { raw: pFee.toString(), formatted: formatUnits(pFee, decimals) };
        } catch {
          accessFeePrimaryToken = unavailable('primary-token access fee unavailable');
        }
      }
```

(c) In the `result` object (built at lines 147-155), add the two fields right after the `accessFeeREPPO,` line:

```ts
        accessFeeREPPO,
        accessFeePrimaryToken,
        ...(primaryToken ? { primaryToken } : {}),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/commands/query/datanet.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/query/datanet.ts src/commands/query/datanet.test.ts
git commit -m "feat(query datanet): surface primary-token access fee in JSON"
```

---

### Task 7: Version bump, full gate, release

**Files:**
- Modify: `package.json` (version)
- Modify: `README.md` (if it documents `grant-access`)

- [ ] **Step 1: Bump the version**

In `package.json`, change `"version": "0.8.4"` to `"version": "0.8.5"`.

- [ ] **Step 2: Update README if grant-access is documented**

Run: `grep -n "grant-access" README.md`
If it appears, add an example line under that section:

```
reppo grant-access --datanet 19 --token primary   # pay the access fee in the datanet primary token
```

If `grep` finds nothing, skip this step.

- [ ] **Step 3: Run the full publish gate locally**

Run: `npm run lint && npm run typecheck && npm test && npm run build`
Expected: all PASS (this is exactly what `prepublishOnly` runs).

- [ ] **Step 4: Commit and open the PR**

```bash
git add package.json README.md
git commit -m "chore: release v0.8.5 — grant-access primary-token fee"
git push -u origin feat/grant-access-primary-token
gh pr create --title "feat: grant-access --token primary (non-REPPO access fees)" \
  --body "Adds primary-token access fee support to grant-access (mirrors mint-pod --token) and surfaces the primary-token access fee in query datanet --json. No contract change — SubnetManager already exposes the methods. Unblocks orquestra non-REPPO datanet support (spec: orquestra/docs/superpowers/specs/2026-06-15-non-reppo-access-fees-design.md)."
```

- [ ] **Step 5: Release after merge (maintainer action)**

After the PR merges to `main`:

```bash
git checkout main && git pull
git tag v0.8.5 && git push origin v0.8.5   # triggers .github/workflows/publish.yaml → npm publish @reppo/cli@0.8.5
```

Then bump the Orquestra reppo-CLI pin to `0.8.5` as part of orquestra Phase 2.

---

## Self-Review

- **Spec coverage (Phase 0):** ABI methods (Task 1) ✓ · generic ERC20 resolver (Task 2) ✓ · decimals-aware receipt reader (Task 3) ✓ · `--token` flag + validation (Task 4) ✓ · routing + primary-token resolution + balance/allowance + `feeToken`/`feeAmount`/`feePaid` output (Task 5) ✓ · `query datanet` fee-token JSON (Task 6) ✓ · tests + release v0.8.5 (Tasks 1-7) ✓. The **decimals gotcha** from the spec is covered by Task 3's 6-decimal tests and the on-chain `decimals()` read in Tasks 5 and 6.
- **Placeholder scan:** none — every code/test step has complete code; every run step has an exact command + expected result. Task 5's manual on-chain step and Task 7's release are explicitly manual (chain/maintainer actions), not placeholders.
- **Type consistency:** `accessFns` returns `{ access, feeGetter }` and is consumed as `fns.access` / `fns.feeGetter` in Task 5. `tokenFeeFromReceipt(receipt, token, caller, decimals)` (Task 3) matches its call in Task 5. `erc20(address)` (Task 2) is used in Tasks 5 and 6. Field names `feeToken` / `feeAmount` / `feePaid` / `primaryToken` / `accessFeePrimaryToken` are consistent across command output and tests.
