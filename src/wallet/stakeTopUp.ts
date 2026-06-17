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

/** Stable idempotency key for a top-up to a given target — a crash-retry before the
 *  lock tx lands reuses it (no double-lock); a later further bump uses a new key. */
export function stakeTopUpKey(stake: { lockReppo: number; lockDurationDays: number }): string {
  return `lock-target-${stake.lockReppo}-${stake.lockDurationDays}`
}
