// src/llm/dateContext.ts
// Scoring models' training cutoffs precede the node's runtime era. Without an
// explicit current date in the system prompt, a scorer judges honestly-dated
// recent data as "future dates → fabricated" and rejects it (live incident:
// rwa tracking reports for the current week scored 3/10 as 'fabricated and
// unverifiable' purely for carrying this week's ISO dates).
export function currentDateLine(nowMs: number = Date.now()): string {
  return `Today's date (UTC) is ${new Date(nowMs).toISOString().slice(0, 10)}: dates on or before it are past/present, NOT future — never treat them as fabricated for recency alone.`
}
