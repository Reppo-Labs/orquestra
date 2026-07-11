import type { Snapshot } from '../api'
import { fmt } from '../lib/format'

/** Pure display math for one burn bar. Extracted so the clamp/rounding + the "hot" (>=80%)
 *  threshold + the ∞ cap label are unit-testable without rendering (web tests run in a node
 *  env with no DOM). `pct` is clamped to 100 and 0 when max is missing/zero (no div-by-zero). */
export function budgetBar(spent: number, max: number | null | undefined): { pct: number; maxLabel: string; hot: boolean } {
  const pct = max != null && max > 0 ? Math.min(100, Math.round((100 * spent) / max)) : 0
  const maxLabel = max === undefined || max === null ? '∞' : fmt(max)
  return { pct, maxLabel, hot: pct >= 80 }
}

export function BudgetBurn({ snapshot }: { snapshot: Snapshot | null }) {
  const b = snapshot?.budget
  const caps = b?.caps
  const bars: [string, number, number | null | undefined][] = b && caps ? [
    ['Mint REPPO', b.mintReppoSpent, caps.mintReppoMax],
  ] : []
  if (!bars.length) return <div className="empty panel-box">budget pending first cycle</div>
  return (
    <div className="cards stagger">
      {bars.map(([k, spent, max]) => {
        const { pct, maxLabel, hot } = budgetBar(spent, max)
        return (
          <div className="card" key={k}>
            <div className="k">{k}</div>
            <div className="v">{fmt(spent)} <span className="faint" style={{ fontSize: 13 }}>/ {maxLabel}</span></div>
            <div className={`bar ${hot ? 'hot' : ''}`}><div style={{ width: `${pct}%` }} /></div>
          </div>
        )
      })}
    </div>
  )
}
