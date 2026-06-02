// src/runtime/scheduler.ts
export interface SchedulerHandle {
  stop(): void
}

/** Run `tick` immediately, then every `cadenceHours`. Never overlaps: if a tick
 *  is still running when the interval fires, that fire is skipped. */
export function startScheduler(cadenceHours: number, tick: () => Promise<void>): SchedulerHandle {
  let busy = false
  let stopped = false
  const runGuarded = async () => {
    if (busy || stopped) return
    busy = true
    try {
      await tick()
    } catch (e) {
      console.error('orquestra: cycle failed:', (e as Error).message)
    } finally {
      busy = false
    }
  }
  void runGuarded()
  const id = setInterval(() => void runGuarded(), cadenceHours * 3600_000)
  return {
    stop() {
      stopped = true
      clearInterval(id)
    },
  }
}
