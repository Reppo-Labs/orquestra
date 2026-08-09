// Pure view-model for the "Gas & vote power" block — the two things that silently
// stall a node: an empty gas tank (every vote/mint/claim is an on-chain tx) and an
// exhausted or never-read per-epoch vote-power budget.
//
// Kept out of the component so the honesty rules are unit-testable in the node env:
//   * UNREAD IS NOT ZERO. The backend omits an amount it could not read (an RPC blip,
//     no RPC at all) rather than writing 0 — so `null` here means "unknown" and must
//     render as "unread", never as a scary 0 that implies a wallet with no power.
//   * The two legacy sizing causes stay distinct: no RPC configured is a permanent
//     misconfiguration only the operator can fix; a failed read self-heals.
import type { Snapshot } from '../api'

const WEI = 1e18

/** Raw 18-dec decimal string → a display number. `undefined` (the backend omitted an
 *  amount it could not read) stays null — the caller renders "unread", not 0. A
 *  malformed string is treated the same way, never as 0. */
export function weiToNum(wei: string | undefined | null): number | null {
  if (wei === undefined || wei === null || wei === '') return null
  try {
    const n = Number(BigInt(wei)) / WEI // display precision only — never used for spend math
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

export type VoteSizingState = 'veReppo' | 'no-rpc' | 'read-failed' | 'unknown'

export interface VotePowerCardView {
  sizing: VoteSizingState
  /** short badge text for the sizing card. */
  sizingLabel: string
  /** one sentence an operator can act on. */
  sizingNote: string
  /** true when votes are landing as conviction dust instead of real veREPPO weight. */
  degraded: boolean
  /** still spendable this epoch (null = unread). */
  remaining: number | null
  /** total veREPPO voting power (null = unread) — the number the ticker used to show alone. */
  total: number | null
  /** already cast this epoch, straight from votesCastedByVoterForEpoch (null = unread). */
  spent: number | null
  /** % of this epoch's power already spent, 0–100 (null = unread/no power). */
  spentPct: number | null
  epoch: number | null
}

const SIZING: Record<VoteSizingState, { label: string; note: string }> = {
  veReppo: {
    label: 'veREPPO-weighted',
    note: 'Votes are sized from the wallet\u2019s on-chain voting power for this epoch.',
  },
  'no-rpc': {
    label: 'conviction dust',
    note: 'RPC_URL is not set, so every vote is cast at conviction\u00d71e18 \u2014 dust next to your stake. Set RPC_URL and restart to vote with real weight.',
  },
  'read-failed': {
    label: 'conviction dust',
    note: 'The vote-power read failed this cycle, so votes fell back to conviction\u00d71e18 dust. It self-heals once the RPC responds \u2014 if it persists, check RPC_URL.',
  },
  unknown: {
    label: 'unread',
    note: 'No vote sizing reported yet \u2014 no datanet has voting enabled, or this node has not completed a cycle since the field was added.',
  },
}

export function votePowerView(snapshot: Snapshot | null): VotePowerCardView {
  const vp = snapshot?.votePower
  const sizing: VoteSizingState =
    vp?.sizing === 've-reppo' ? 'veReppo'
    : vp?.sizing === 'legacy-no-rpc' ? 'no-rpc'
    : vp?.sizing === 'legacy-read-failed' ? 'read-failed'
    : 'unknown'
  const remaining = weiToNum(vp?.remainingWei)
  const total = weiToNum(vp?.votingPowerWei)
  const spent = weiToNum(vp?.votesCastedWei)
  // Percent of the epoch's power already spent. Needs BOTH legs read and a nonzero
  // total — a wallet with no power at all is 0% spent, not 100%.
  const spentPct =
    spent !== null && total !== null && total > 0
      ? Math.min(100, Math.max(0, Math.round((100 * spent) / total)))
      : null
  return {
    sizing,
    sizingLabel: SIZING[sizing].label,
    sizingNote: SIZING[sizing].note,
    degraded: sizing === 'no-rpc' || sizing === 'read-failed',
    remaining,
    total,
    spent,
    spentPct,
    epoch: vp?.epoch ?? null,
  }
}

export interface GasCardView {
  /** wallet ETH as last read (null before the first cycle). */
  eth: number | null
  /** true only when the NODE flagged it (snapshot.lowGas) \u2014 the threshold lives
   *  backend-side (LOW_GAS_WARN_ETH) and is never duplicated here. */
  low: boolean
  /** true for rows written before lowGas existed: show the balance, claim no verdict. */
  unjudged: boolean
  note: string
}

export function gasView(snapshot: Snapshot | null): GasCardView {
  if (!snapshot) return { eth: null, low: false, unjudged: true, note: 'Awaiting the first cycle.' }
  const eth = typeof snapshot.balance?.eth === 'number' ? snapshot.balance.eth : null
  const low = snapshot.lowGas === true
  const unjudged = snapshot.lowGas === undefined
  return {
    eth,
    low,
    unjudged,
    note: low
      ? 'Wallet ETH is below the node\u2019s low-gas threshold: votes, mints and claims are about to start failing for gas. Top up with ETH on Base.'
      : unjudged
        ? 'This snapshot predates the low-gas check \u2014 balance shown without a verdict.'
        : 'Gas covers every vote, mint and claim \u2014 all of them are on-chain transactions.',
  }
}
