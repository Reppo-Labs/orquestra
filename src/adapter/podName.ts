// src/adapter/podName.ts

/** The reppo CLI rejects `--pod-name` longer than this (INVALID_POD_NAME). */
export const POD_NAME_MAX = 50

/** Clamp a pod name to the CLI limit. Cuts at a word boundary when one exists
 *  in the back half of the budget (avoids mid-word chops); otherwise hard-cuts.
 *  No ellipsis — the CLI limit counts characters and the full text survives in
 *  the pod description. */
export function clampPodName(name: string, max = POD_NAME_MAX): string {
  const trimmed = name.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= max) return trimmed
  const cut = trimmed.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()
}
