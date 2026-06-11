import type { ReactNode } from 'react'
import type { Pnl, Snapshot } from '../api'
import { fmt, sign, epochLabel } from '../lib/format'

export function PnlCards({ pnl, snapshot }: { pnl: Pnl | null; snapshot: Snapshot | null }) {
  const cards: [string, ReactNode, boolean?][] = [
    ['Net REPPO', pnl ? <span className={sign(pnl.netReppo)}>{fmt(pnl.netReppo)}</span> : '—', true],
    ['Earned', pnl ? fmt(pnl.earnedReppo) : '—'],
    ['Claimed', pnl ? fmt(pnl.claimedReppo) : '—'],
    ['Claimable', pnl ? <span className={pnl.claimableReppo > 0 ? 'pos' : ''}>{fmt(pnl.claimableReppo)}</span> : '—'],
    ['Spent (mint)', pnl ? fmt(pnl.spentReppo) : '—'],
    ['Gas (ETH)', pnl ? fmt(pnl.gasSpentEth) : '—'],
    ['REPPO balance', snapshot ? fmt(snapshot.balance.reppo) : '—'],
    ['veREPPO', snapshot ? fmt(snapshot.balance.veReppo) : '—'],
    ['Epoch', snapshot ? epochLabel(snapshot.epoch) : '—'],
  ]
  return (
    <div className="cards stagger">
      {cards.map(([k, v, hero]) => (
        <div className={`card ${hero ? 'hero' : ''}`} key={k}>
          <div className="k">{k}</div>
          <div className="v">{v}</div>
        </div>
      ))}
    </div>
  )
}
