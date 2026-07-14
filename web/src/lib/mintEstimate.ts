// What turning MINT on will actually cost, and what it pays — computed at the point of
// decision, from what the node really serves.
//
// Enabling a datanet is the operator's consent to spend: it authorises a ONE-TIME subnet
// access grant (which, per CLAUDE.md's key invariants, is deliberately NOT budget-capped —
// `budget.grantReppoMax` was retired) plus a REPPO fee on every mint. Today that consent is
// a blank cheque. This module prices it.
//
// WHAT WE CANNOT KNOW, AND WILL NOT INVENT
// ----------------------------------------
// The access fee EXISTS in the backend (src/reppo/listDatanets.ts → `accessFeeReppo`, and
// src/rubric/types.ts → `economics.accessFeeReppo`), but it is NOT SERVED to the dashboard:
// `/api/datanets` maps the catalog down to a bare id→name record (server.ts → datanetNames)
// and no other endpoint carries it. Rendering it as `0` would be a lie that costs the
// operator real money, and guessing it would be worse. It is reported as UNKNOWN, together
// with what we DO know about it: it is charged once, and no spending cap will stop it.
import type { DatanetPnl, DatanetYield, Snapshot } from '../api'

/** A number we either know and can source, or honestly do not have. There is no third state:
 *  a missing number never degrades to 0. */
export type Est<T> =
  | { known: true; value: T; basis: string }
  | { known: false; why: string }

export interface MintEstimate {
  datanetId: string
  /** One-time subnet access grant. ALWAYS unknown — see the file header. */
  accessFee: Est<number>
  /** REPPO per mint, from what THIS datanet has actually charged this node. */
  mintFee: Est<number>
  /** Worst case for one cycle: mintFee × the node-wide per-cycle mint cap. */
  perCycleMax: Est<number>
  /** What is left under the operator's own mint cap before the node stops minting. */
  budgetLeft: Est<number>
  /** What the datanet pays out, from the snapshot's economics. */
  pays: {
    emissionsPerEpochReppo: number | null
    nativeTokenSymbol?: string
    yieldPerVote: number | null
    uncontested: boolean
    /** Why the yield is unknown, when it is. */
    yieldUnknown?: string
  }
  /** Mint fees this node has paid ELSEWHERE — context for a datanet it has never minted on.
   *  Never presented as this datanet's fee. */
  otherDatanets: { min: number; max: number; count: number } | null
}

/** Observed mint fee for one datanet: lifetime REPPO spent ÷ lifetime mints. Uses the
 *  LIFETIME totals from /api/datanet-pnl (an unbounded SQL aggregate), never the capped
 *  activity window, so the average does not drift as the log rolls over. */
function observedFee(p: DatanetPnl | undefined): Est<number> {
  if (!p || p.mintsExecuted <= 0 || p.reppoSpent <= 0) {
    return {
      known: false,
      why: 'this node has never minted here, so it has never been charged — the fee is set by the datanet, not by you',
    }
  }
  const fee = p.reppoSpent / p.mintsExecuted
  return {
    known: true,
    value: fee,
    basis: `average of the ${p.mintsExecuted} mint${p.mintsExecuted === 1 ? '' : 's'} this node has paid for here`,
  }
}

/** The spread of mint fees this node has actually paid, across every datanet that charged it.
 *  Shown ONLY as context ("elsewhere you have paid 5–186 REPPO per mint"), never as an
 *  estimate for a datanet that has never charged us — real fees vary by an order of magnitude
 *  between datanets, so a cross-datanet average would be a fabrication dressed as a number. */
function feeSpread(rows: DatanetPnl[]): MintEstimate['otherDatanets'] {
  const fees = rows
    .filter((p) => p.mintsExecuted > 0 && p.reppoSpent > 0)
    .map((p) => p.reppoSpent / p.mintsExecuted)
  if (fees.length === 0) return null
  return { min: Math.min(...fees), max: Math.max(...fees), count: fees.length }
}

export function buildMintEstimate(input: {
  datanetId: string
  snapshot: Snapshot | null
  datanetPnl: DatanetPnl[]
}): MintEstimate {
  const { datanetId, snapshot, datanetPnl } = input
  const pnl = datanetPnl.find((p) => p.datanetId === datanetId)
  const econ: DatanetYield | undefined = snapshot?.datanetEconomics?.find((e) => e.datanetId === datanetId)
  const budget = snapshot?.budget
  const caps = budget?.caps

  const mintFee = observedFee(pnl)

  // Worst case for a cycle. mintRateMaxPerCycle is a NODE-WIDE ceiling (it bounds mints
  // across ALL datanets, not per datanet), so this is an upper bound on what one cycle could
  // cost if this datanet consumed every mint slot — which is exactly the number an operator
  // signing a blank cheque needs to see.
  const rate = caps?.mintRateMaxPerCycle
  const perCycleMax: Est<number> = mintFee.known && typeof rate === 'number' && rate > 0
    ? {
        known: true,
        value: mintFee.value * rate,
        basis: `${rate} mint${rate === 1 ? '' : 's'} per cycle is your node-wide cap — this is the most one cycle could cost if this datanet used every slot`,
      }
    : {
        known: false,
        why: mintFee.known
          ? 'this node does not report a per-cycle mint cap'
          : 'the fee for this datanet is unknown, so the per-cycle cost cannot be estimated',
      }

  const capMax = caps?.mintReppoMax
  const spent = budget?.mintReppoSpent
  const budgetLeft: Est<number> = typeof capMax === 'number' && capMax > 0 && typeof spent === 'number' && Number.isFinite(spent)
    ? {
        known: true,
        value: Math.max(0, capMax - spent),
        basis: 'what is left of your own mint cap before the node stops minting',
      }
    : { known: false, why: 'no mint cap is reported by this node' }

  return {
    datanetId,
    // The one number we refuse to guess. See the file header for why it cannot reach us.
    accessFee: {
      known: false,
      why: 'this node does not report the datanet\'s access fee to the dashboard',
    },
    mintFee,
    perCycleMax,
    budgetLeft,
    pays: {
      emissionsPerEpochReppo: econ ? econ.emissionsPerEpochReppo : null,
      nativeTokenSymbol: econ?.nativeTokenSymbol,
      yieldPerVote: econ?.yieldPerVote ?? null,
      uncontested: econ?.uncontested ?? false,
      yieldUnknown: !econ
        ? 'this datanet was not in the node\'s last snapshot'
        : econ.epochVoteVolume === null
          ? (econ.unavailableReason ? 'the node could not read this epoch\'s vote volume' : 'no RPC is configured on this node')
          : econ.yieldPerVote === null && !econ.uncontested
            ? 'this datanet emits no REPPO, so it has no REPPO yield per vote'
            : undefined,
    },
    otherDatanets: feeSpread(datanetPnl),
  }
}
