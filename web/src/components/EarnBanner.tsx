import type { Earn, Pnl } from '../api'
import { fmt, fmtCount, fmtReppo } from '../lib/format'

/** What the banner asserts. `earning` in the backend means only "emissions were
 *  detected" — it says NOTHING about profit. Rendering it as a green EARNING pill
 *  above a red negative Net REPPO told the operator the opposite of the truth, so
 *  the banner now leads with profit/loss and treats emissions-detected as detail. */
export type EarnTone = 'profit' | 'loss' | 'neutral'

export interface EarnBannerState {
  tone: EarnTone
  /** The claim, in plain words. */
  headline: string
  /** The arithmetic behind the claim. */
  detail: string
}

/** Pure: derive the banner from the node's real numbers.
 *
 *  THE VERDICT IS REALIZED MONEY: claimedReppo − spentReppo. `pnl.netReppo` is NOT that —
 *  src/dashboard/pnl.ts defines earnedReppo = claimed + CLAIMABLE, so netReppo counts
 *  emissions that are due but have never been collected. A node that has claimed nothing,
 *  spent 600 and is owed 900 would be announced, in green, as "Up 300" — money it does not
 *  have — directly above a profit chart that (correctly) draws it at −600. Money the node is
 *  owed is stated as what it is: owed.
 *
 *  Order matters. "No emissions yet" is checked BEFORE the loss test: a node that has spent
 *  on minting but has not been paid yet is early, not losing — emissions lag votes by roughly
 *  an epoch. */
export function earnState(pnl: Pnl | null | undefined, earn: Earn | null | undefined): EarnBannerState {
  if (!pnl) {
    return {
      tone: 'neutral',
      headline: 'Waiting for the first cycle',
      detail: 'Nothing has been spent or earned yet.',
    }
  }
  const { claimedReppo, claimableReppo, spentReppo } = pnl
  const net = claimedReppo - spentReppo
  // Owed, not held. Always additive to the story, never to the verdict.
  const owed = claimableReppo > 0
    ? ` A further ${fmtReppo(claimableReppo)} is due but not yet claimed — it is not counted here.`
    : ''
  if (claimedReppo <= 0) {
    return {
      tone: 'neutral',
      headline: 'No earnings yet — too early to tell',
      detail: (spentReppo > 0
        ? `You've spent ${fmtReppo(spentReppo)} minting and been paid nothing back so far. Emissions lag votes by roughly an epoch.`
        : (earn?.mintedPods ?? 0) > 0
          ? 'Pods are published, but no emissions have been claimed yet.'
          : 'The node has not minted or earned anything yet.') + owed,
    }
  }
  if (net < 0) {
    return {
      tone: 'loss',
      headline: `Losing ${fmtReppo(-net)}`,
      detail: `You've spent ${fmtReppo(spentReppo)} minting and claimed ${fmtReppo(claimedReppo)} back.${owed}`,
    }
  }
  if (net > 0) {
    return {
      tone: 'profit',
      headline: `Up ${fmtReppo(net)}`,
      detail: `You've claimed ${fmtReppo(claimedReppo)} and spent ${fmtReppo(spentReppo)} minting.${owed}`,
    }
  }
  return {
    tone: 'neutral',
    headline: 'Breaking even',
    detail: `You've claimed ${fmtReppo(claimedReppo)} and spent ${fmtReppo(spentReppo)} minting.${owed}`,
  }
}

/** Overview banner: profit or loss first, in the operator's own money terms; the
 *  emissions mechanics (pods minted, claimable, claimed) sit underneath as detail.
 *  Green/red here mean profit/loss and nothing else. The raw pod vote tallies that
 *  used to sit here (`21033942↑/1518750↓`) are gone — they carry no unit an operator
 *  can act on, and they read as an earnings signal when they are not one. */
export function EarnBanner({ pnl, earn }: { pnl: Pnl | null | undefined; earn: Earn | null | undefined }) {
  const s = earnState(pnl, earn)
  const toneClass = s.tone === 'profit' ? 'pos' : s.tone === 'loss' ? 'neg' : 'muted'
  const dotClass = s.tone === 'profit' ? 'on' : s.tone === 'loss' ? 'bad' : 'off'
  return (
    <div className={`earn-banner ${s.tone}`} role="status" aria-label="Profit and loss summary">
      <span className={`dot ${dotClass}`} aria-hidden="true" />
      <div className="earn-main">
        <div className={`earn-head ${toneClass}`}>{s.headline}</div>
        <div className="earn-detail muted">{s.detail}</div>
      </div>
      {earn && (
        // Subordinate mechanics — never the headline. "claimable 0 with N pending" is
        // honest: on-chain detection knows a payout is due before it knows its amount.
        <div className="earn-facts muted" aria-label="Emissions detail">
          <span className="bseg">{fmtCount(earn.mintedPods)} pod{earn.mintedPods === 1 ? '' : 's'} minted</span>
          <span className="bseg">
            {fmtReppo(earn.claimableReppo)} claimable
            {(earn.claimablePairs ?? 0) > 0 ? ` (${fmtCount(earn.claimablePairs)} pending)` : ''}
          </span>
          <span className="bseg">{fmtReppo(earn.claimedReppo)} claimed</span>
          {(earn.claimedTokens ?? [])
            .filter((t) => t.amount > 0)
            .map((t) => (
              <span className="bseg" key={t.symbol}>{fmt(t.amount)} {t.symbol} claimed</span>
            ))}
        </div>
      )}
    </div>
  )
}
