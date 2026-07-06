import type { ReactNode } from 'react'
import type { Pnl, Snapshot } from '../api'
import { fmt, sign, epochLabel } from '../lib/format'
import { Tip } from './Tip'

function VeReppoLabel() {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      veREPPO
      <Tip label="veREPPO explained">
        <b>veREPPO ≠ locked REPPO</b>
        <p style={{ margin: '6px 0 0' }}>
          The protocol applies a duration-based multiplier — longer locks earn
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
          mint scoring, dedup, learning), priced from list rates per model — an
          estimate, not your provider invoice. Panel scoring calls the model several
          times per pod, so this scales with pods scored, not just votes cast.
        </p>
      </Tip>
    </span>
  )
}

/** "$0.87 · 42 calls", or token counts when no model was priceable. */
function llmCostValue(s: Snapshot): ReactNode {
  const u = s.llm
  if (!u || u.calls === 0) return '—'
  if (u.estCostUsd === null) return `${u.calls} calls · ${fmt(u.inputTokens + u.outputTokens)} tok`
  const approx = u.unpricedCalls > 0 ? '≥' : '~'
  return `${approx}$${u.estCostUsd.toFixed(2)} · ${u.calls} calls`
}

export function PnlCards({ pnl, snapshot }: { pnl: Pnl | null; snapshot: Snapshot | null }) {
  const cards: [ReactNode, ReactNode, boolean?][] = [
    ['Net REPPO', pnl ? <span className={sign(pnl.netReppo)}>{fmt(pnl.netReppo)}</span> : '—', true],
    ['Spent (mint)', pnl ? fmt(pnl.spentReppo) : '—'],
    ['Gas (ETH)', pnl ? fmt(pnl.gasSpentEth) : '—'],
    [<LlmCostLabel key="llm" />, snapshot ? llmCostValue(snapshot) : '—'],
    ['REPPO balance', snapshot ? fmt(snapshot.balance.reppo) : '—'],
    [<VeReppoLabel key="ve" />, snapshot ? fmt(snapshot.balance.veReppo) : '—'],
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
