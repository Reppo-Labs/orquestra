import type { ReactNode } from 'react'

// Single source of truth for the strictness control across the datanet cards and
// the add-datanet modal. Values MUST match the Strictness enum in
// src/config/schema.ts; thresholds mirror STRICTNESS_THRESHOLDS there.
export const STRICT = ['conservative', 'balanced', 'aggressive'] as const

/** Option label that surfaces the up-threshold inline so the picker is self-explaining. */
export const STRICT_LABEL: Record<string, string> = {
  conservative: 'conservative — up ≥8',
  balanced: 'balanced — up ≥7',
  aggressive: 'aggressive — up ≥6',
}

/** Tooltip body explaining how a 1-10 score becomes an action. */
export function strictnessTip(): ReactNode {
  return (
    <>
      <b>How a 1-10 pod score becomes a vote.</b>
      <table className="tip-table">
        <thead><tr><th></th><th>upvote ≥</th><th>downvote ≤</th></tr></thead>
        <tbody>
          <tr><td>conservative</td><td>8</td><td>4</td></tr>
          <tr><td>balanced</td><td>7</td><td>3</td></tr>
          <tr><td>aggressive</td><td>6</td><td>2</td></tr>
        </tbody>
      </table>
      Scores in the middle are skipped. A mint needs a score ≥ the upvote threshold,
      so aggressive votes &amp; mints more (and spends more); conservative only acts on
      strong signals.
    </>
  )
}
