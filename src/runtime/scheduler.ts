// src/runtime/scheduler.ts
export interface SchedulerHandle {
  stop(): void
  /** The in-flight tick's promise, or null when idle. Lets the shutdown handler
   *  drain a running cycle before the process exits. */
  current(): Promise<void> | null
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
  }
}
