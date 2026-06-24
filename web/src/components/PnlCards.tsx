import type { ReactNode } from 'react'
import type { Pnl, Snapshot } from '../api'
import { fmt, sign, epochLabel } from '../lib/format'
import { Tip } from './Tip'

function VeReppoLabel({ lockupCount }: { lockupCount?: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      veREPPO
      <Tip label="veREPPO explained">
        <b>veREPPO ≠ locked REPPO</b>
        <p style={{ margin: '6px 0 4px' }}>
          Voting power is time-weighted:
        </p>
        <p style={{ margin: '4px 0', fontFamily: 'var(--mono)', fontSize: 11 }}>
          veREPPO = locked × (duration / max_lock)
        </p>
        <p style={{ margin: '4px 0 0' }}>
          Longer locks earn more voting power per token. Max-lock = 1:1; shorter = less.
          {lockupCount !== undefined && (
            <> Active lockup{lockupCount !== 1 ? 's' : ''}: <b>{lockupCount}</b>.</>
          )}
        </p>
      </Tip>
    </span>
  )
}

export function PnlCards({ pnl, snapshot }: { pnl: Pnl | null; snapshot: Snapshot | null }) {
  const lockupCount = snapshot?.votingPower?.lockupCount
  const cards: [ReactNode, ReactNode, boolean?][] = [
    ['Net REPPO', pnl ? <span className={sign(pnl.netReppo)}>{fmt(pnl.netReppo)}</span> : '—', true],
    ['Spent (mint)', pnl ? fmt(pnl.spentReppo) : '—'],
    ['Gas (ETH)', pnl ? fmt(pnl.gasSpentEth) : '—'],
    ['REPPO balance', snapshot ? fmt(snapshot.balance.reppo) : '—'],
    [<VeReppoLabel key="ve" lockupCount={lockupCount} />, snapshot ? fmt(snapshot.balance.veReppo) : '—'],
    ['Epoch', snapshot ? epochLabel(snapshot.epoch) : '—'],
  ]
  return (
    <div className="cards stagger">
      {cards.map(([k, v, hero], i) => (
        <div className={`card ${hero ? 'hero' : ''}`} key={i}>
          <div className="k">{k}</div>
          <div className="v">{v}</div>
        </div>
      ))}
    </div>
  )
}
