// src/adapter/podName.ts

/** The reppo CLI rejects `--pod-name` longer than this (INVALID_POD_NAME). */
export const POD_NAME_MAX = 50

/** The reppo CLI rejects `--pod-description` longer than this (INVALID_POD_DESCRIPTION). */
export const POD_DESC_MAX = 200

/** Clamp a pod name to the CLI limit. Cuts at a word boundary when one exists
 *  in the back half of the budget (avoids mid-word chops); otherwise hard-cuts.
 *  No ellipsis — the CLI limit counts characters and the full text survives in
 *  the pod description. */
export function clampPodName(name: string, max = POD_NAME_MAX): string {
  // Strip ALL leading dashes/whitespace (one pass, to a fixpoint): a value
  // beginning with `-` would be parsed as a flag by the CLI (argument injection),
  // and names/descriptions are LLM/scrape-derived, i.e. untrusted. `/^[-\s]+/`
  // also handles "- --dataset x" → "dataset x" which a single `-+` run missed.
  const trimmed = name.replace(/^[-\s]+/, '').replace(/\s+/g, ' ').trim()
  // An all-dash name collapses to '' — never emit an empty CLI arg.
  if (trimmed === '') return 'untitled'
  if (trimmed.length <= max) return trimmed
  const cut = trimmed.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()
}
