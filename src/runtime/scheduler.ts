// src/runtime/scheduler.ts
export interface SchedulerHandle {
  stop(): void
  /** The in-flight tick's promise, or null when idle. Lets the shutdown handler
   *  drain a running cycle before the process exits. */
  current(): Promise<void> | null
  /** Trigger an off-schedule tick now (the dashboard "run now" button). Respects the
   *  no-overlap guard: if a cycle is already running (or the scheduler is stopped), it
   *  does NOT queue a second one — returns { started: false } with the reason instead.
   *  The interval timer is unchanged; the next scheduled fire still happens on cadence. */
  runNow(): { started: boolean; reason?: string }
}

/** Run `tick` immediately, then every `cadenceHours`. Never overlaps: if a tick
 *  is still running when the interval fires, that fire is skipped. */
export function startScheduler(cadenceHours: number, tick: () => Promise<void>): SchedulerHandle {
  let busy = false
  let stopped = false
  let running: Promise<void> | null = null
  const runGuarded = (): Promise<void> => {
    if (busy || stopped) return Promise.resolve()
    busy = true
    // Track ONLY real runs (after the guard) so current() reflects an actual in-flight
    // tick, not a skipped fire.
    running = (async () => {
      try {
        await tick()
      } catch (e) {
        console.error('orquestra: cycle failed:', (e as Error).message)
      } finally {
        busy = false
        running = null
      }
    })()
    return running
  }
  void runGuarded()
  const id = setInterval(() => void runGuarded(), cadenceHours * 3600_000)
  return {
    stop() {
      stopped = true
      clearInterval(id)
    },
    current() {
      return running
    },
    runNow() {
      if (stopped) return { started: false, reason: 'scheduler stopped' }
      // busy is set synchronously inside runGuarded before its first await, so this
      // check and the call below can't interleave — a concurrent cycle is never double-run.
      if (busy) return { started: false, reason: 'a cycle is already running' }
      void runGuarded()
      return { started: true }
    },
  }
}
