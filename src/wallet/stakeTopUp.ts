/** Plan a veREPPO top-up: when the configured target `stake.lockReppo` exceeds the
 *  wallet's current veREPPO, lock the difference as an additional lockup (aggregate
 *  veREPPO = sum of lockups). Returns null when staking is off (target <= 0) or the
 *  wallet is already at/above target (incl. a down-bump — locks can't be reduced).
 *  Amount-only: a new lockup gets `lockDurationDays`; existing lockups keep their
 *  expiry (extending them is impossible — VeReppo is not ERC721-enumerable). */
export function planStakeTopUp(
  currentVeReppo: number,
  stake: { lockReppo: number; lockDurationDays: number },
): { lockAmount: number; durationSeconds: number } | null {
  if (stake.lockReppo <= 0) return null
  if (currentVeReppo >= stake.lockReppo) return null
  return {
    lockAmount: stake.lockReppo - currentVeReppo,
    durationSeconds: stake.lockDurationDays * 86400,
  }
}

// Per-process latch: the target last attempted for a stake top-up. Shared module state so
// setupNode (startup) and the per-cycle path agree — setupNode SEEDS it after its attempt so
// cycle-1 doesn't re-attempt the same target with a slightly different `current` reading (which
// would change the lock diff → reppo-cli IDEMPOTENCY_ARGS_MISMATCH → the top-up never lands).
// A successful lock drives veREPPO to the target so planStakeTopUp returns null next cycle anyway;
// a FAILED attempt is held off until the target changes.
let lastAttemptedTarget: number | null = null

/** True once a top-up to this exact target has been attempted in this process. */
export function wasStakeTargetAttempted(target: number): boolean {
  return lastAttemptedTarget === target
}

/** Mark a top-up to this target as attempted (success OR failure). */
export function markStakeTargetAttempted(target: number): void {
  lastAttemptedTarget = target
}

/** Stable idempotency key for a top-up to a given target — a crash-retry before the
 *  lock tx lands reuses it (no double-lock); a later further bump uses a new key. */
export function stakeTopUpKey(stake: { lockReppo: number; lockDurationDays: number }): string {
  return `lock-target-${stake.lockReppo}-${stake.lockDurationDays}`
}
