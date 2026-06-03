// src/runtime/state.ts
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'

interface Shape { votedPodIds: Record<string, string[]>; mintedKeys: Record<string, string[]>; claimedKeys: Record<string, string[]> }
const FILE = 'vote-state.json'
const fresh = (): Shape => ({ votedPodIds: {}, mintedKeys: {}, claimedKeys: {} })

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
        claimedKeys: parsed.claimedKeys ?? {},
      }
    } catch {
      this.state = fresh() // corrupt → start empty (worst case a re-vote attempt, which the chain dedups by epoch)
    }
  }
  getVotedPodIds(datanetId: string): string[] { return this.state.votedPodIds[datanetId] ?? [] }
  getMintedKeys(datanetId: string): string[] { return this.state.mintedKeys[datanetId] ?? [] }
  recordVote(datanetId: string, podId: string): void { this.add(this.state.votedPodIds, datanetId, podId) }
  recordMint(datanetId: string, key: string): void { this.add(this.state.mintedKeys, datanetId, key) }
  getClaimedKeys(datanetId: string): string[] { return this.state.claimedKeys[datanetId] ?? [] }
  recordClaim(datanetId: string, key: string): void { this.add(this.state.claimedKeys, datanetId, key) }
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
