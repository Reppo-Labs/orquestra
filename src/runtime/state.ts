// src/runtime/state.ts
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'

// claimedKeys is a FLAT `${podId}:${epoch}` set, NOT datanet-scoped: emissions are
// claimed on-chain by (pod, epoch) alone (the CLI takes only --pod --epoch), and a pod
// belongs to exactly one datanet, so the datanet dimension is redundant and would risk
// a re-claim if the CLI's datanetId ever shifted between versions.
// grantedSubnets is a FLAT set of subnet UUIDs (not datanet-scoped): subnet access is
// granted to the wallet per-subnet, and a subnet maps 1:1 to a datanet, so the datanet
// dimension is redundant. Prevents re-granting (a one-time on-chain setup) every cycle.
interface Shape { votedPodIds: Record<string, string[]>; mintedKeys: Record<string, string[]>; claimedKeys: string[]; grantedSubnets: string[] }
const FILE = 'vote-state.json'
const fresh = (): Shape => ({ votedPodIds: {}, mintedKeys: {}, claimedKeys: [], grantedSubnets: [] })

/** Persisted dedup state: which pods we've voted on + which dataset keys we've
 *  minted, per datanet. Prevents re-voting (gas/power waste) + re-minting. */
export class DedupState {
  private state: Shape
  constructor(private readonly dataDir: string) {
    const path = join(dataDir, FILE)
    if (!existsSync(path)) { this.state = fresh(); return }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<Shape>
      this.state = {
        votedPodIds: parsed.votedPodIds ?? {},
        mintedKeys: parsed.mintedKeys ?? {},
        // tolerate a legacy/absent value: only accept a flat array, else start empty
        claimedKeys: Array.isArray(parsed.claimedKeys) ? parsed.claimedKeys : [],
        grantedSubnets: Array.isArray(parsed.grantedSubnets) ? parsed.grantedSubnets : [],
      }
    } catch {
      this.state = fresh() // corrupt → start empty (worst case a re-vote attempt, which the chain dedups by epoch)
    }
  }
  getVotedPodIds(datanetId: string): string[] { return this.state.votedPodIds[datanetId] ?? [] }
  getMintedKeys(datanetId: string): string[] { return this.state.mintedKeys[datanetId] ?? [] }
  recordVote(datanetId: string, podId: string): void { this.add(this.state.votedPodIds, datanetId, podId) }
  recordMint(datanetId: string, key: string): void { this.add(this.state.mintedKeys, datanetId, key) }
  /** Flat (podId:epoch) claim set — see note on Shape; not datanet-scoped. */
  getClaimedKeys(): string[] { return this.state.claimedKeys }
  /** Flat set of subnet UUIDs the wallet has been granted access to. */
  getGrantedSubnets(): string[] { return this.state.grantedSubnets }
  recordGrant(subnetId: string): void {
    const set = new Set(this.state.grantedSubnets); set.add(subnetId); this.state.grantedSubnets = [...set]
    try {
      this.save()
    } catch (e) {
      console.error(`orquestra: failed to persist dedup state (in-memory dedup still holds): ${(e as Error).message}`)
    }
  }
  /** Evict a stale grant-cache entry (on-chain access disagreed with the cache). */
  removeGrant(subnetId: string): void {
    const set = new Set(this.state.grantedSubnets); set.delete(subnetId); this.state.grantedSubnets = [...set]
    try {
      this.save()
    } catch (e) {
      console.error(`orquestra: failed to persist dedup state (in-memory dedup still holds): ${(e as Error).message}`)
    }
  }
  recordClaim(key: string): void {
    const set = new Set(this.state.claimedKeys); set.add(key); this.state.claimedKeys = [...set]
    try {
      this.save()
    } catch (e) {
      console.error(`orquestra: failed to persist dedup state (in-memory dedup still holds): ${(e as Error).message}`)
    }
  }
  private add(map: Record<string, string[]>, dn: string, v: string): void {
    // Update in-memory FIRST so reads stay correct this session even if the disk
    // write fails; persistence is best-effort and must never throw into the caller
    // (a throw here would crash the cycle and orphan a just-landed on-chain action).
    const set = new Set(map[dn] ?? []); set.add(v); map[dn] = [...set]
    try {
      this.save()
    } catch (e) {
      console.error(`orquestra: failed to persist dedup state (in-memory dedup still holds): ${(e as Error).message}`)
    }
  }
  private save(): void {
    const path = join(this.dataDir, FILE)
    writeFileSync(`${path}.tmp`, JSON.stringify(this.state, null, 2)); renameSync(`${path}.tmp`, path)
  }
}
