// src/runtime/setupStake.ts — the startup veREPPO top-up, extracted from index.ts so the
// PAUSE gate over it is unit-testable (index.ts runs on import and cannot be imported).
//
// Why the pause check lives HERE and not only in runCycle: this is the one signing path that
// runs BEFORE the scheduler, so runCycle's gate never sees it. It is also the one signing path
// the BudgetLedger does not cap — a lock is not one of its spend categories — so `paused` is
// the ONLY defense against a restart (docker `unless-stopped`, crash-loop, host reboot) moving
// REPPO into a multi-day lockup on a node the operator deliberately stopped.
import { planStakeTopUp, stakeTopUpKey, markStakeTargetAttempted } from '../wallet/stakeTopUp.js'
import type { StrategyConfig } from '../config/schema.js'

export interface StakeSetupDeps {
  /** Current veREPPO, or null when the balance could not be read (NOT zero — see below). */
  getVeReppo: () => Promise<number | null>
  lock: (args: { amountReppo: number; durationSeconds: number; idempotencyKey: string }) => Promise<{
    status: 'executed' | 'refused-budget' | 'error'
    txHash?: string
    detail?: string
  }>
  log?: (msg: string) => void
}

/** Idempotent startup stake setup: top up veREPPO to `stake.lockReppo` by locking the
 *  difference. Refuses entirely while the node is paused. Never throws — a lock error is
 *  non-fatal (the node still runs/votes on existing veREPPO). */
export async function setupStake(
  config: Pick<StrategyConfig, 'paused' | 'stake'>,
  deps: StakeSetupDeps,
): Promise<void> {
  const log = deps.log ?? ((m: string) => console.error(m))
  if (config.stake.lockReppo <= 0) return

  // ── PAUSE: the operator's kill switch, honored on the startup path too. ──────────────
  // Refuse BEFORE the balance read and before any signing, and do NOT latch the target:
  // unpausing must let the per-cycle top-up do the lock the operator actually consented to.
  if (config.paused) {
    log(
      `orquestra: node is PAUSED — skipping the startup veREPPO lock (target ${config.stake.lockReppo} REPPO). ` +
        'Nothing is signed while paused; unpause and the next cycle tops the stake up.',
    )
    return
  }

  // The lock is a TARGET, not one-time: top up to config.stake.lockReppo by locking the
  // difference as an additional lockup. Skip when already at/above target.
  const current = await deps.getVeReppo()
  if (current === null) {
    // A failed balance read is NOT zero — locking against current=0 would lock the FULL
    // target on top of whatever the wallet already holds (over-lock). Skip the lock here;
    // the per-cycle top-up retries once the balance query recovers.
    log('orquestra: could not read veREPPO balance — skipping stake setup')
    return
  }

  const plan = planStakeTopUp(current, config.stake)
  if (!plan) {
    log(`orquestra: veREPPO ${current} ≥ target ${config.stake.lockReppo} — no lock needed.`)
    // Nothing to retry — seed the latch so cycle-1 doesn't re-evaluate the same target.
    markStakeTargetAttempted(config.stake.lockReppo)
    return
  }

  log(`orquestra: topping up veREPPO ${current} → ${config.stake.lockReppo} (+${plan.lockAmount}, ${config.stake.lockDurationDays}d)`)
  const r = await deps.lock({
    amountReppo: plan.lockAmount,
    durationSeconds: plan.durationSeconds,
    idempotencyKey: stakeTopUpKey(config.stake),
  })
  log(`orquestra: veREPPO lock ${r.status}` + (r.txHash ? ` (${r.txHash})` : '') + (r.detail ? ` — ${r.detail}` : ''))
  // Seed the latch ONLY on a confirmed lock, so cycle-1 doesn't re-attempt the same target
  // with a slightly different `current` reading (→ IDEMPOTENCY_ARGS_MISMATCH in reppo-cli).
  // A FAILED startup lock is deliberately LEFT unlatched so the per-cycle top-up retries it
  // (and records the reason to the dashboard) instead of leaving the node at zero veREPPO
  // with no explanation until a manual restart.
  if (r.status === 'executed') markStakeTargetAttempted(config.stake.lockReppo)
}
