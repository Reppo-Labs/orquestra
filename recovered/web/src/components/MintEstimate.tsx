// The pre-spend estimate. Turning MINT on is the moment the operator agrees to pay, so it is
// the moment they get told what it costs — not a help page they will never open.
//
// Every number here is either sourced or explicitly UNKNOWN. There is no third rendering: an
// unknown cost never degrades to "0", because "0" is the one answer that would make an
// operator click the button they should not click.
import type { ReactNode } from 'react'
import type { MintEstimate as Est } from '../lib/mintEstimate'
import { fmt, fmtPerVote, fmtReppo } from '../lib/format'

/** An unknown value, with the reason attached. The reason is the point: "unknown" on its own
 *  is a shrug, and an operator cannot act on a shrug. */
function Unknown({ why }: { why: string }) {
  return (
    <span className="me-unknown">
      <b>unknown</b> <span className="muted">— {why}</span>
    </span>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="me-row">
      <span className="me-label">{label}</span>
      <span className="me-val">{children}</span>
    </div>
  )
}

/** What it costs, and what it pays. Rendered inline at the mint toggle and in the
 *  add-datanet modal — at the point of decision, never anywhere else. */
export function MintEstimate({ est, name }: { est: Est; name?: string }) {
  const { accessFee, mintFee, perCycleMax, budgetLeft, pays, otherDatanets } = est
  const who = name || `datanet ${est.datanetId}`

  return (
    <div className="mint-est" role="group" aria-label={`What minting on ${who} costs and pays`}>
      <div className="me-head">Before you turn minting on</div>

      <div className="me-sec">
        <div className="me-sec-head">What it will cost you</div>

        {/* The one-time grant. NOT budget-capped — the caps that protect the operator
            everywhere else do not protect them here, so this warning is not optional. */}
        <Row label="One-time access fee">
          {accessFee.known
            ? <span className="mono">{fmtReppo(accessFee.value)}</span>
            : <Unknown why={accessFee.why} />}
        </Row>
        <div className="me-warn">
          Enabling this datanet pays its access fee once, from your wallet.{' '}
          <b>Your spending caps do not cover it</b> — they cap minting, not access. This node does
          not report the fee to the dashboard, so check the datanet before you commit.
        </div>

        <Row label="Cost per mint">
          {mintFee.known ? (
            <>
              <span className="mono">{fmtReppo(mintFee.value)}</span>{' '}
              <span className="muted">— {mintFee.basis}</span>
            </>
          ) : (
            <Unknown why={mintFee.why} />
          )}
        </Row>

        {/* Context, clearly labelled as OTHER datanets. Fees differ by an order of magnitude
            between datanets, so this is never presented as this datanet's price. */}
        {!mintFee.known && otherDatanets && (
          <div className="me-note muted">
            For comparison, this node has paid between {fmtReppo(otherDatanets.min)} and{' '}
            {fmtReppo(otherDatanets.max)} per mint on {otherDatanets.count} other datanet
            {otherDatanets.count === 1 ? '' : 's'}. That is <b>not</b> a quote for this one.
          </div>
        )}

        <Row label="Most one cycle could cost">
          {perCycleMax.known ? (
            <>
              <span className="mono">{fmtReppo(perCycleMax.value)}</span>{' '}
              <span className="muted">— {perCycleMax.basis}</span>
            </>
          ) : (
            <Unknown why={perCycleMax.why} />
          )}
        </Row>

        <Row label="Left under your mint cap">
          {budgetLeft.known ? (
            <>
              <span className="mono">{fmtReppo(budgetLeft.value)}</span>{' '}
              <span className="muted">— {budgetLeft.basis}</span>
            </>
          ) : (
            <Unknown why={budgetLeft.why} />
          )}
        </Row>
      </div>

      <div className="me-sec">
        <div className="me-sec-head">What it pays</div>

        <Row label="Emissions">
          {pays.emissionsPerEpochReppo === null ? (
            <Unknown why="this datanet was not in the node's last snapshot" />
          ) : pays.emissionsPerEpochReppo > 0 ? (
            <span className="mono">{fmt(pays.emissionsPerEpochReppo)} REPPO / epoch</span>
          ) : pays.nativeTokenSymbol ? (
            <span>
              <span className="mono">{pays.nativeTokenSymbol}</span>{' '}
              <span className="muted">— pays its own token, not REPPO</span>
            </span>
          ) : (
            <span className="muted">pays nothing</span>
          )}
        </Row>

        <Row label="Current yield">
          {pays.uncontested ? (
            <span className="me-uncontested">nobody has voted this epoch — the first voter takes it</span>
          ) : pays.yieldPerVote !== null ? (
            <span className="mono" title={`exactly ${pays.yieldPerVote} REPPO per vote`}>
              {fmtPerVote(pays.yieldPerVote)}
            </span>
          ) : (
            <Unknown why={pays.yieldUnknown ?? 'the node did not report a yield for this datanet'} />
          )}
        </Row>

        <div className="me-note muted">
          Emissions are paid for <b>votes</b>, which cost no REPPO. Minting is what costs money —
          a minted pod only pays if others vote it up.
        </div>
      </div>
    </div>
  )
}
