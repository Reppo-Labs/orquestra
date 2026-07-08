import type { ReactNode } from 'react'
import type { Pnl, Snapshot } from '../api'
import { fmt, sign } from '../lib/format'
import { Tip } from './Tip'

function VeReppoLabel() {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      veREPPO
      <Tip label="veREPPO explained">
        <b>veREPPO ≠ locked REPPO</b>
        <p style={{ margin: '6px 0 0' }}>
          The protocol applies a duration-based multiplier: longer locks earn
          proportionally more voting power. The result can exceed the amount
          of REPPO you locked.
        </p>
      </Tip>
    </span>
  )
}

function LlmCostLabel() {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      LLM cost / cycle
      <Tip label="LLM cost explained">
        <b>Estimate of last cycle's LLM bill</b>
        <p style={{ margin: '6px 0 0' }}>
          All LLM calls made during the cycle (vote scoring, panel deliberation,
          mint scoring, dedup, learning), priced from list rates per model. It is an
          estimate, not your provider invoice. Panel scoring calls the model several
          times per pod, so this scales with pods scored, not just votes cast.
        </p>
      </Tip>
    </span>
  )
}

/** Big value + small qualifier, so the card value never wraps. */
function llmCost(s: Snapshot): { v: ReactNode; sub?: string } {
  const u = s.llm
  if (!u || u.calls === 0) return { v: '—' }
  if (u.estCostUsd === null) return { v: `${u.calls} calls`, sub: `${fmt(u.inputTokens + u.outputTokens)} tok` }
  const approx = u.unpricedCalls > 0 ? '≥' : '~'
  return { v: `${approx}$${u.estCostUsd.toFixed(2)}`, sub: `${u.calls} calls` }
}

export function PnlCards({ pnl, snapshot }: { pnl: Pnl | null; snapshot: Snapshot | null }) {
  // First paint (nothing loaded yet): shape-matched shimmer instead of a wall of
  // dashes, so the layout reads as "loading", not "empty node".
  const loading = pnl === null && snapshot === null
  const skel = <span className="skel" aria-hidden="true" />
  if (loading) {
    const labels: ReactNode[] = ['Net REPPO', 'Spent (mint)', 'Gas (ETH)', <LlmCostLabel key="llm" />, 'REPPO balance', <VeReppoLabel key="ve" />, 'Epoch']
    return (
      <div className="cards stagger">
        {labels.map((k, i) => (
          <div className={`card ${i === 0 ? 'hero' : ''}`} key={i}>
            <div className="k">{k}</div>
            <div className="v">{skel}</div>
          </div>
        ))}
      </div>
    )
  }
  const llm = snapshot ? llmCost(snapshot) : { v: '—' as ReactNode }
  const ep = snapshot?.epoch
  // [label, value, hero?, sub?] — sub renders small under the value so values never wrap.
  const cards: [ReactNode, ReactNode, boolean?, string?][] = [
    ['Net REPPO', pnl ? <span className={sign(pnl.netReppo)}>{fmt(pnl.netReppo)}</span> : '—', true],
    ['Spent (mint)', pnl ? fmt(pnl.spentReppo) : '—'],
    ['Gas (ETH)', pnl ? fmt(pnl.gasSpentEth) : '—'],
    [<LlmCostLabel key="llm" />, llm.v, false, llm.sub],
    ['REPPO balance', snapshot ? fmt(snapshot.balance.reppo) : '—'],
    [<VeReppoLabel key="ve" />, snapshot ? fmt(snapshot.balance.veReppo) : '—'],
    ['Epoch', ep ? String(ep.epoch) : '—', false, ep ? `${Math.max(0, Math.round(ep.secondsRemaining / 3600))}h left` : undefined],
  ]
  return (
    <div className="cards stagger">
      {cards.map(([k, v, hero, sub], i) => (
        <div className={`card ${hero ? 'hero' : ''}`} key={i}>
          <div className="k">{k}</div>
          <div className="v">{v}</div>
          {sub && <div className="sub">{sub}</div>}
        </div>
      ))}
    </div>
  )
}
