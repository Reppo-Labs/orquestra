// src/reppo/queryEmissionsDue.ts
import { runReppoStdout } from './exec.js'


/** The emission token for a claimable (pod,epoch) when it is NOT REPPO. Attached by the
 *  on-chain voter-claim wiring (resolved from the datanet's nativeToken / SubnetManager);
 *  absent ⇒ a plain REPPO claim. */
export interface ClaimToken { address: string; symbol: string; decimals: number }
export interface ClaimableEmission { podId: string; datanetId: string; epoch: number; reppo: number; token?: ClaimToken }
export interface EmissionsDue { totalReppo: number; pods: ClaimableEmission[] }

const toFinite = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

/** REPPO has 18 decimals. The per-epoch `amount` comes back as a RAW bigint string
 *  (the CLI emits `e.amount.toString()`), so it must be scaled down; a decimal string
 *  or number is already in REPPO units and taken as-is. (All amounts are display-only —
 *  `claim-emissions --pod --epoch` carries no amount; the chain pays what is owed.) */
const rawReppo = (v: unknown): number => {
  const s = typeof v === 'bigint' ? v.toString() : String(v ?? '')
  if (/^-?\d+$/.test(s)) { try { return Number(BigInt(s)) / 1e18 } catch { return 0 } } // raw 18-dec integer
  return toFinite(v) // already a decimal REPPO value
}

/** Pod-level / legacy amount: prefer the human-readable `formatted`, then a `{raw}`
 *  18-dec field, else a bare value. */
const amountReppo = (a: unknown): number => {
  if (a && typeof a === 'object') {
    const o = a as Record<string, unknown>
    if ('formatted' in o) return toFinite(o.formatted)
    if ('raw' in o) return rawReppo(o.raw)
  }
  return rawReppo(a)
}

/** Pure: extract claimable emissions from `reppo query emissions-due --json`.
 *
 *  reppo >=0.8.x shape (current):
 *    { walletAddress, totalDueREPPO:{raw,formatted},
 *      byPod: [{ podId, currentEpoch, totalDue:{raw,formatted},
 *                epochs: [{ epoch, amount, claimed }, ...] }, ...] }
 *  Claims are keyed (podId, epoch) on-chain, so we emit ONE entry per UNCLAIMED epoch.
 *  Falls back to the legacy `{ emissions: [{podId, datanetId, epoch, amount}] }` shape
 *  (reppo <0.8.x) so the parser tolerates either CLI version. */
export function parseEmissionsDue(raw: unknown): EmissionsDue {
  const o = (raw ?? {}) as Record<string, unknown>
  const pods: ClaimableEmission[] = []

  if (Array.isArray(o.byPod)) {
    for (const p of o.byPod) {
      const d = (p ?? {}) as Record<string, unknown>
      const podId = String(d.podId ?? d.pod ?? '')
      if (podId === '') continue
      const datanetId = String(d.datanetId ?? d.subnetId ?? '') // not in the >=0.8.x shape; claim is keyed pod+epoch only
      const epochs = Array.isArray(d.epochs) ? d.epochs : []
      const unclaimed = epochs.filter((e) => (e as Record<string, unknown>)?.claimed !== true)
      if (unclaimed.length) {
        for (const e of unclaimed) {
          const ed = e as Record<string, unknown>
          pods.push({ podId, datanetId, epoch: toFinite(ed.epoch), reppo: rawReppo(ed.amount) })
        }
      } else if (epochs.length === 0) {
        // No per-epoch breakdown — claim the pod's current epoch for its pod-level total.
        pods.push({ podId, datanetId, epoch: toFinite(d.currentEpoch ?? d.epoch), reppo: amountReppo(d.totalDue ?? d.amount) })
      }
    }
    return { totalReppo: pods.reduce((s, p) => s + p.reppo, 0), pods }
  }

  if (Array.isArray(o.emissions)) {
    for (const r of o.emissions) {
      const d = (r ?? {}) as Record<string, unknown>
      const podId = String(d.podId ?? d.pod ?? '')
      if (podId === '') continue
      pods.push({
        podId,
        datanetId: String(d.datanetId ?? d.subnetId ?? ''),
        epoch: toFinite(d.epoch),
        reppo: amountReppo(d.amount ?? d.reppo),
      })
    }
  }
  return { totalReppo: pods.reduce((s, p) => s + p.reppo, 0), pods }
}

/** Live unclaimed emissions across our pods via the reppo CLI. */
export async function queryEmissionsDueJson(): Promise<EmissionsDue> {
  const stdout = await runReppoStdout(['query', 'emissions-due', '--json'])
  try { return parseEmissionsDue(JSON.parse(stdout)) } catch { throw new Error(`queryEmissionsDueJson: bad reppo output: ${stdout.slice(0, 200)}`) }
}
