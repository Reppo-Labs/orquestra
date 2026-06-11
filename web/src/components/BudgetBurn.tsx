import type { Snapshot } from '../api'
import { fmt } from '../lib/format'

export function BudgetBurn({ snapshot }: { snapshot: Snapshot | null }) {
  const b = snapshot?.budget
  const caps = b?.caps
  const bars: [string, number, number | null | undefined][] = b && caps ? [
    ['Vote gas (ETH)', b.voteGasSpentEth, caps.voteGasEthMax],
    ['Mint REPPO', b.mintReppoSpent, caps.mintReppoMax],
    ['Mint gas (ETH)', b.mintGasSpentEth, caps.mintGasEthMax],
    ['Claim gas (ETH)', b.claimGasSpentEth, caps.claimGasEthMax],
    // grantReppoMax unset = no cap (datanet membership is the consent) → show ∞
    ['Grant REPPO', b.grantReppoSpent ?? 0, caps.grantReppoMax],
  ] : []
  return (
    <>
      <h2>Budget burn</h2>
      <div className="cards">
        {bars.map(([k, spent, max]) => {
          const pct = max != null && max > 0 ? Math.min(100, Math.round((100 * spent) / max)) : 0
          const maxLabel = max === undefined || max === null ? '∞' : fmt(max)
          return (
            <div className="card" key={k}>
              <div className="k">{k}</div>
              <div className="v">{fmt(spent)} / {maxLabel}</div>
              <div className={`bar ${pct >= 80 ? 'hot' : ''}`}><div style={{ width: `${pct}%` }} /></div>
            </div>
          )
        })}
      </div>
    </>
  )
}
