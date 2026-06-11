import type { ReactNode } from 'react'
import type { Pnl, Snapshot } from '../api'
import { fmt, sign, epochLabel } from '../lib/format'

export function PnlCards({ pnl, snapshot }: { pnl: Pnl | null; snapshot: Snapshot | null }) {
  const cards: [string, ReactNode][] = [
    ['Epoch', snapshot ? epochLabel(snapshot.epoch) : '—'],
    ['Net REPPO', pnl ? <span className={sign(pnl.netReppo)}>{fmt(pnl.netReppo)}</span> : '—'],
    ['Earned', pnl ? fmt(pnl.earnedReppo) : '—'],
    ['Claimed', pnl ? fmt(pnl.claimedReppo) : '—'],
    ['Claimable', pnl ? fmt(pnl.claimableReppo) : '—'],
    ['Spent (mint)', pnl ? fmt(pnl.spentReppo) : '—'],
    ['Gas (ETH)', pnl ? fmt(pnl.gasSpentEth) : '—'],
    ['REPPO bal', snapshot ? fmt(snapshot.balance.reppo) : '—'],
    ['veREPPO', snapshot ? fmt(snapshot.balance.veReppo) : '—'],
  ]
  return (
    <div className="cards">
      {cards.map(([k, v]) => (
        <div className="card" key={k}>
          <div className="k">{k}</div>
          <div className="v">{v}</div>
        </div>
      ))}
    </div>
  )
}
