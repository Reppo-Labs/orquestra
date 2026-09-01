import type { RubricEconomics } from '../rubric/types.js'

/** A datanet is REPPO-denominated when it names no native token or names REPPO.
 *  Both the gate and the unread-probe must agree on this, so it lives in one place —
 *  they previously expressed it as two differently-phrased inverses. */
const isReppoDenominated = (symbol: string | undefined): boolean =>
  !symbol || symbol.toUpperCase() === 'REPPO'

/** Pure predicate: should a datanet's mint be gated on its publishing fee being
 *  too large relative to what it pays out?
 *
 *  MEASURED DATA (live node, 2026): a 5-REPPO publishing fee against 200
 *  REPPO/epoch emissions (2.5% ratio) returned 3.5x over 219 mints. Meanwhile
 *  a 99-REPPO fee and a 186-REPPO fee, each against larger emission pools,
 *  both lost money. The fee-to-emissions RATIO, not the raw fee and not the
 *  emission rate alone, is what separated the winning datanet from the
 *  losing ones — hence gating on `fee / emissionsPerEpochReppo`.
 *
 *  FAIL OPEN, always. The ratio is only meaningful when BOTH the fee and the
 *  emissions figure are denominated in REPPO. Some datanets pay a native
 *  token instead (e.g. WOOD) and legitimately report
 *  `emissionsPerEpochReppo: 0` because there is no REPPO emission rate to
 *  report — computing a ratio there is nonsensical (divide-by-zero, or a
 *  fee/rate pair in different units). The two possible failure directions
 *  are NOT symmetric: gating open on a bad ratio costs at most a few hundred
 *  REPPO on one datanet; gating shut on an ambiguous read silently stops
 *  EVERY mint on a node with no error surfaced, which is the worse outcome
 *  by a large margin (it is indistinguishable from the node being broken).
 *  So every ambiguous or unparseable input — missing threshold, zero/negative
 *  emissions, zero/negative fee, non-REPPO native token — returns false
 *  (no gate), never true.
 */
export function mintFeeRatioExceeded(economics: RubricEconomics, maxRatio: number | undefined): boolean {
  if (maxRatio === undefined) return false
  // Only a REPPO-denominated datanet has a REPPO emissions rate that means
  // anything to divide by. Case-insensitive: the CLI's casing of the symbol
  // is not a contract we should trust.
  if (!isReppoDenominated(economics.nativeTokenSymbol)) return false
  if (economics.emissionsPerEpochReppo <= 0) return false
  // `publishingFeeReppo` is 0 when the field was absent or unparseable
  // (rubric/parse.ts `num()` cannot distinguish "no fee" from "genuinely
  // zero fee"), so treating <= 0 as "no signal" rather than "free mint,
  // gate hard" is the fail-open choice, not an oversight.
  if (economics.publishingFeeReppo <= 0) return false
  return economics.publishingFeeReppo / economics.emissionsPerEpochReppo > maxRatio
}

/** True when a REPPO-denominated datanet reports a publishing fee that looks
 *  MISSING rather than genuinely zero — i.e. exactly the case
 *  `mintFeeRatioExceeded` fails open on. That fail-open branch is silent by
 *  design (it never blocks a mint), which means it is also silent to an
 *  operator: if a payload shape change makes every fee parse to 0, the gate
 *  quietly stops doing anything and nothing says so. Callers should log when
 *  this is true so that "the gate is off because there's nothing to gate"
 *  stays distinguishable from "the gate is off because we can no longer read
 *  the fee".
 */
export function mintFeeLooksUnread(economics: RubricEconomics): boolean {
  return isReppoDenominated(economics.nativeTokenSymbol) && economics.publishingFeeReppo <= 0 && economics.emissionsPerEpochReppo > 0
}

/** The fee-to-emissions ratio as a percentage, for display/logging. Returns 0
 *  rather than dividing by zero when there is no emissions rate to compare
 *  against — this is a rendering helper, not the gate, so it has no need to
 *  distinguish "no rate" from "0%".
 *  Display only — gating decisions must call `mintFeeRatioExceeded`, never compare
 *  this value against a threshold, since the ×100 can disagree with the raw-ratio
 *  comparison at an exact boundary.
 */
export function feeRatioPercent(economics: RubricEconomics): number {
  if (economics.emissionsPerEpochReppo <= 0) return 0
  return (economics.publishingFeeReppo / economics.emissionsPerEpochReppo) * 100
}
