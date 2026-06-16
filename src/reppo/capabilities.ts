// src/reppo/capabilities.ts
// Feature gates keyed off the reppo CLI version on PATH. Unlike version.ts's
// startup preflight (warn-only, blocks nothing), these are per-feature checks the
// runtime consults before emitting a CLI flag the installed CLI may not understand.
import { isVersionAtLeast } from './version.js'

/** The reppo CLI version that ships `grant-access --token primary` (paying a
 *  datanet's access fee in its non-REPPO primary token). Older CLIs only know
 *  `accessSubnetWithREPPOFee`, so a non-REPPO grant must be skipped, not fired. */
export const NONREPPO_GRANT_MIN_VERSION = '0.8.5'

/** True when the reppo CLI banner is >= 0.8.5 — i.e. it supports paying access
 *  fees in a datanet's primary token via `grant-access --token primary`. Tolerant
 *  of noisy banners (date/build/runtime tokens) via the shared parser. */
export function supportsNonReppoGrants(version: string): boolean {
  return isVersionAtLeast(version, NONREPPO_GRANT_MIN_VERSION)
}
