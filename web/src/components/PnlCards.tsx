import { useState, type ReactNode } from 'react'
import type { Pnl, Snapshot } from '../api'
import { fmt, fmtCount, fmtUsd, sign } from '../lib/format'
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
  if (u.estCostUsd === null) return { v: `${fmtCount(u.calls)} calls`, sub: `${fmtCount(u.inputTokens + u.outputTokens)} tokens` }
  const approx = u.unpricedCalls > 0 ? '≥' : '~'
  return { v: `${approx}${fmtUsd(u.estCostUsd)}`, sub: `${fmtCount(u.calls)} calls` }
}

export function PnlCards({ pnl, snapshot }: { pnl: Pnl | null; snapshot: Snapshot | null }) {
  const [showModels, setShowModels] = useState(false) // hooks run unconditionally — before the loading return
  // First paint (nothing loaded yet): shape-matched shimmer instead of a wall of
  // dashes, so the layout reads as "loading", not "empty node".
  const loading = pnl === null && snapshot === null
  const skel = <span className="skel" aria-hidden="true" />
  if (loading) {
    const labels: ReactNode[] = ['Net REPPO', 'Spent minting (REPPO)', 'Gas spent (ETH)', <LlmCostLabel key="llm" />, 'REPPO balance', <VeReppoLabel key="ve" />, 'Epoch']
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
    // Net REPPO is the one place green/red are earned: they mean profit and loss.
    ['Net REPPO', pnl ? <span className={sign(pnl.netReppo)}>{fmt(pnl.netReppo)}</span> : '—', true,
      pnl ? `${fmt(pnl.earnedReppo)} earned − ${fmt(pnl.spentReppo)} spent` : undefined],
    ['Spent minting (REPPO)', pnl ? fmt(pnl.spentReppo) : '—'],
    ['Gas spent (ETH)', pnl ? fmt(pnl.gasSpentEth) : '—'],
    [<LlmCostLabel key="llm" />, llm.v, false, llm.sub],
    ['REPPO balance', snapshot ? fmt(snapshot.balance.reppo) : '—'],
    [<VeReppoLabel key="ve" />, snapshot ? fmt(snapshot.balance.veReppo) : '—'],
    ['Epoch', ep ? String(ep.epoch) : '—', false, ep ? `${Math.max(0, Math.round(ep.secondsRemaining / 3600))}h left` : undefined],
  ]
  // Cost-by-model drilldown: costliest first, unpriced models last (still counted).
  const byModel = Object.entries(snapshot?.llm?.byModel ?? {})
    .sort(([, a], [, b]) => (b.estCostUsd ?? -1) - (a.estCostUsd ?? -1) || b.calls - a.calls)
  return (
    <>
      <div className="cards stagger">
        {cards.map(([k, v, hero, sub], i) => (
          <div className={`card ${hero ? 'hero' : ''}`} key={i}>
            <div className="k">{k}</div>
            <div className="v">{v}</div>
            {sub && <div className="sub">{sub}</div>}
          </div>
        ))}
      </div>
      {byModel.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <button
            className="link-btn"
            aria-expanded={showModels}
            aria-controls="llm-by-model"
            onClick={() => setShowModels((s) => !s)}
          >
            {showModels ? 'hide' : 'show'} LLM cost by model ({byModel.length})
          </button>
          {showModels && (
            <div className="panel-box" id="llm-by-model" style={{ marginTop: 8 }}>
              <table>
                <thead><tr><th>Model</th><th>Calls</th><th>Tokens in</th><th>Tokens out</th><th>Est. cost</th></tr></thead>
                <tbody>
                  {byModel.map(([model, m]) => (
                    <tr key={model}>
                      <td className="mono net-cell" title={model}>{model}</td>
                      <td className="mono">{m.calls}</td>
                      <td className="mono">{fmtCount(m.inputTokens)}</td>
                      <td className="mono">{fmtCount(m.outputTokens)}</td>
                      <td className="mono">
                        {m.estCostUsd === null
                          ? <span className="faint">no list price</span>
                          : fmtUsd(m.estCostUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </>
  )
}
