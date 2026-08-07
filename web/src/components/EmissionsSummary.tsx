import { useState } from 'react'
import type { Pnl, TokenPnl, Earn, Snapshot } from '../api'
import { fmt, sign, pct, netLabel } from '../lib/format'

/** −$3.20 / $0.45 — dollars with the sign OUTSIDE the $ and sensible precision
 *  for sub-cent nets. */
const usd = (n: number): string => {
  const abs = Math.abs(n)
  const digits = abs > 0 && abs < 0.01 ? 4 : 2
  return `${n < 0 ? '−' : ''}$${abs.toFixed(digits)}`
}

/** Prominent Overview panel: the node's emissions at a glance — all-time claimed
 *  REPPO, lifetime Net PnL in dollars, and per-token earned/spent legs (e.g. WOOD
 *  on robinhood, LBM from Litebeam). Flows + USD spots come from /api/pnl
 *  (tokens/netUsd — see src/dashboard/prices.ts); token units are NEVER summed
 *  across symbols, only their USD values are. The pod-payout list (snapshot
 *  emissionsDue) stays expandable below. */
export function EmissionsSummary({ pnl, tokens, netUsd, spentUsd, roiPct, earn, snapshot, netNames }: {
  pnl: Pnl | null
  tokens?: TokenPnl[]
  netUsd?: number | null
  spentUsd?: number | null
  roiPct?: number | null
  earn?: Earn | null
  snapshot?: Snapshot | null
  netNames?: Record<string, string>
}) {
  const [showPods, setShowPods] = useState(false)
  if (!pnl) return null
  // Non-REPPO legs get their own cards; the REPPO leg already owns the
  // Claimed/Net REPPO cards. Fall back to earn's claimed tokens (earned side
  // only) when the server predates /api/pnl tokens.
  const legs: TokenPnl[] = tokens
    ? tokens.filter((t) => t.symbol !== 'REPPO')
    : (earn?.claimedTokens ?? []).filter((t) => t.amount > 0)
        .map((t) => ({ symbol: t.symbol, earned: t.amount, spent: 0, net: t.amount, priceUsd: null, netUsd: null, earnedUsd: null, spentUsd: null }))
  // tolerate pre-feature snapshots that carry no emissionsDue at all
  const pods = snapshot?.emissionsDue?.pods ?? []
  return (
    // Cards ARE the containers — no outer panel-box (nested borders, and the
    // border would enclose the empty grid area after the per-token cards).
    // Only the expandable pod-payout TABLE gets a panel-box, like every table.
    <div>
      <div className="cards">
        <div className="card hero">
          <div className="k">Claimed (all-time)</div>
          <div className="v">{fmt(pnl.claimedReppo)} REPPO</div>
        </div>
        <div className="card hero">
          <div className="k">Net PnL ($)</div>
          <div className="v">
            {netUsd === undefined || netUsd === null
              ? <span className="faint">—</span>
              : <span className={sign(netUsd)}>{usd(netUsd)}</span>}
          </div>
          <div className="sub">
            {netUsd === undefined || netUsd === null
              ? 'price unavailable'
              : 'earned − spent, all tokens · excludes gas + LLM'}
          </div>
        </div>
        {/* Percentage return sits beside the dollar figure: the same net, divided by
            what it cost to earn it. Null (—) is honest in two distinct cases the sub
            line distinguishes — an unpriced leg, and a node that has not spent yet
            (no cost basis ⇒ a ratio would be Infinity, not "infinite profit"). */}
        <div className="card hero">
          <div className="k">Net PnL (%)</div>
          <div className="v">
            {roiPct === undefined || roiPct === null
              ? <span className="faint">—</span>
              : <span className={sign(roiPct)}>{pct(roiPct)}</span>}
          </div>
          <div className="sub">
            {roiPct !== undefined && roiPct !== null && spentUsd
              ? `return on ${usd(spentUsd)} spent`
              : netUsd === undefined || netUsd === null
                ? 'price unavailable'
                : 'no spend yet — nothing to return on'}
          </div>
        </div>
        {legs.map((t) => (
          <div className="card" key={t.symbol}>
            <div className="k">{t.symbol} earned / spent</div>
            <div className="v">
              <span className="pos">{fmt(t.earned)}</span> / <span className={t.spent > 0 ? 'neg' : ''}>{fmt(t.spent)}</span>
            </div>
            <div className="sub">
              net <span className={sign(t.net)}>{fmt(t.net)} {t.symbol}</span>
              {t.netUsd !== null && t.netUsd !== undefined ? ` · ${usd(t.netUsd)}` : ''}
            </div>
          </div>
        ))}
      </div>
      <div className="muted" style={{ marginTop: 10 }}>
        Earned total: {fmt(pnl.earnedReppo)} REPPO{legs.length ? ' (+ native tokens shown separately)' : ''}. Claims run automatically each cycle.
        {pods.length > 0 && (
          <>
            {' '}
            <button
              className="link-btn"
              aria-expanded={showPods}
              aria-controls="emissions-pods"
              onClick={() => setShowPods((s) => !s)}
            >
              {showPods ? 'hide' : 'show'} {pods.length} pod payout{pods.length === 1 ? '' : 's'} due
            </button>
          </>
        )}
      </div>
      {showPods && pods.length > 0 && (
        <div className="panel-box" id="emissions-pods" style={{ marginTop: 10 }}>
          <table>
            {/* "Due", not "REPPO due": a datanet paying a native token (WOOD on
                Sherwood) has every row at 0 REPPO, and the old header asserted
                the payout was REPPO-denominated when it was not. */}
            <thead><tr><th>Pod</th><th>Datanet</th><th>Epoch</th><th>Due</th></tr></thead>
            <tbody>
              {pods.map((p) => (
                <tr key={`${p.podId}-${p.epoch}`}>
                  <td className="mono net-cell" title={p.podId}>{p.podId}</td>
                  <td className="net-cell" title={netLabel(p.datanetId, netNames ?? {})}>{netLabel(p.datanetId, netNames ?? {})}</td>
                  <td className="mono">{String(p.epoch)}</td>
                  {/* 0 is honest: on-chain detection knows a payout is due before
                      its amount. Name the token when we know it, so "pending" on
                      a native-token datanet is not read as pending REPPO. */}
                  <td className="mono">
                    {p.reppo > 0
                      ? <span className="pos">{fmt(p.reppo)} REPPO</span>
                      : <span className="faint">pending{p.token ? ` (${p.token.symbol})` : ''}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
