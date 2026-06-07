// src/adapter/hyperliquid/window.ts

/** A fills fetch window in UNIX MILLISECONDS (HL userFillsByTime uses ms). */
export interface FillsWindow { startTime: number; endTime: number }

/** Compute an epoch-aligned fills window.
 *
 *  HL's rolling "last 7 days" window truncated positions (we saw closes but not
 *  their opens → entry_px null). Anchoring to the datanet's validity epoch and
 *  reaching back `openLookbackDays` before it captures whole round-trips.
 *
 *  endTime tracks `now` during the epoch but is capped at the epoch end so we
 *  never fetch fills that belong to a later epoch.
 *
 *  `epoch` fields are UNIX SECONDS (from `reppo query epoch`); the window is ms. */
export function fillsWindow(
  epoch: { epochStart: number; epochDurationSeconds: number },
  openLookbackDays: number,
  nowMs: number,
): FillsWindow {
  const startSec = epoch.epochStart - openLookbackDays * 86_400
  const startTime = Math.max(0, startSec * 1000)
  const epochEndMs = (epoch.epochStart + epoch.epochDurationSeconds) * 1000
  const endTime = Math.min(Math.max(nowMs, epoch.epochStart * 1000), epochEndMs)
  return { startTime, endTime }
}
