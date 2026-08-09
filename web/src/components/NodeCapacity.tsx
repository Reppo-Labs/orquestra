import type { Snapshot } from '../api'
import { fmt } from '../lib/format'
import { gasView, votePowerView } from '../lib/nodeCapacity'
import { Tip } from './Tip'

/** The two capacities that silently stall a node: gas and this epoch's vote power.
 *  Both facts already existed (snapshot.lowGas since the low-gas check landed; the
 *  vote-power budget since votes were sized from veREPPO) but lived only in stderr —
 *  operators were writing external scripts against votesCastedByVoterForEpoch to see
 *  them. Everything here is read from the snapshot; nothing is recomputed in the UI. */
export function NodeCapacity({ snapshot }: { snapshot: Snapshot | null }) {
  const gas = gasView(snapshot)
  const vp = votePowerView(snapshot)
  // An unread amount renders as "unread", never as 0 — a 0 would read as "your wallet
  // has no voting power", which is a completely different (and alarming) condition.
  const unread = <span className="faint">unread</span>

  return (
    <>
      {gas.low && (
        <div className="alert-banner" role="status">
          <span className="dot off" />
          <span className="bseg status">Low gas — {fmt(gas.eth)} ETH</span>
          <span className="bseg">{gas.note}</span>
        </div>
      )}
      {vp.degraded && (
        <div className="alert-banner" role="status">
          <span className="dot warm" />
          <span className="bseg status">Votes are not veREPPO-weighted</span>
          <span className="bseg">{vp.sizingNote}</span>
        </div>
      )}
      <div className="cards stagger">
        <div className="card">
          <div className="k">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              Gas left (ETH)
              <Tip label="Gas explained">
                <b>Every action is an on-chain transaction</b>
                <p style={{ margin: '6px 0 0' }}>
                  Votes, mints and emission claims all cost ETH on Base. When the tank
                  empties the node keeps cycling but every signature fails, so it looks
                  idle rather than broken. The node flags the balance itself; this card
                  shows the flag.
                </p>
              </Tip>
            </span>
          </div>
          <div className={`v ${gas.low ? 'neg' : ''}`}>{gas.eth === null ? unread : fmt(gas.eth)}</div>
          <div className="sub">{gas.low ? 'top up on Base' : gas.unjudged ? 'no low-gas verdict on this row' : 'above the low-gas threshold'}</div>
        </div>

        <div className="card">
          <div className="k">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              Vote power left
              <Tip label="Vote power explained">
                <b>This epoch&rsquo;s remaining budget, not your total stake</b>
                <p style={{ margin: '6px 0 0' }}>
                  On-chain the wallet may spend votingPower &minus; votesCasted per
                  epoch. The veREPPO figure elsewhere on this page is the TOTAL; this is
                  what is still spendable before the epoch rolls over.
                </p>
              </Tip>
            </span>
          </div>
          <div className="v">{vp.remaining === null ? unread : fmt(vp.remaining)}</div>
          <div className="sub">
            {vp.total === null ? 'of unread total' : `of ${fmt(vp.total)} total${vp.epoch !== null ? ` · epoch ${vp.epoch}` : ''}`}
          </div>
          {vp.spentPct !== null && (
            <div className={`bar ${vp.spentPct >= 80 ? 'hot' : ''}`}><div style={{ width: `${vp.spentPct}%` }} /></div>
          )}
        </div>

        <div className="card">
          <div className="k">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              Vote weight cast
              <Tip label="Vote weight cast explained">
                <b>Proof the votes carried weight</b>
                <p style={{ margin: '6px 0 0' }}>
                  Read straight from the chain (votesCastedByVoterForEpoch) for this
                  wallet and epoch. If the node cast votes this epoch and this stays at
                  zero, the weight never landed &mdash; that is the check operators were
                  scripting by hand.
                </p>
              </Tip>
            </span>
          </div>
          <div className="v">{vp.spent === null ? unread : fmt(vp.spent)}</div>
          <div className="sub">{vp.spentPct === null ? 'this epoch' : `${vp.spentPct}% of power spent this epoch`}</div>
        </div>

        <div className="card">
          <div className="k">Vote sizing</div>
          <div className={`v ${vp.degraded ? 'neg' : vp.sizing === 'veReppo' ? 'pos' : 'faint'}`}>{vp.sizingLabel}</div>
          <div className="sub">{vp.sizing === 'veReppo' ? 'sized from on-chain voting power' : vp.sizing === 'no-rpc' ? 'RPC_URL not set' : vp.sizing === 'read-failed' ? 'budget read failed this cycle' : 'not reported yet'}</div>
        </div>
      </div>
    </>
  )
}
