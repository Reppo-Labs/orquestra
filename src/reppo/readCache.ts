// src/reppo/readCache.ts
// Freshness-policied cache decorator over ReppoReader — the ONE place read caching lives
// (openspec change reduce-rpc-calls, design D1/D2). Three classes:
//   - tick-scoped memo: reads a cycle may repeat (pod lists, balances, scans) — served once
//     per cycle, cleared by beginCycle() from the scheduler tick;
//   - TTL: slow-moving data (the datanet list);
//   - epoch-derived: epoch info expires when the epoch can have rolled over.
// Entries carry invalidation tags; WalletExecutor writes evict what they stale (design D3).
// Caching wraps READS only — vote/mint dedup records and the budget ledger stay
// authoritative, so a stale read can never repeat a write or breach a cap.
import type { ReppoReader, EpochInfo } from './reader.js'

export type CacheTag = 'pods' | 'votes' | 'emissions' | 'balance'

interface Entry {
  value: Promise<unknown>
  /** null → no wall-clock expiry (tick-scoped entries live until beginCycle). */
  expiresAt: number | null
  tickScoped: boolean
  tags: readonly CacheTag[]
}

const LIST_DATANETS_TTL_MS = 10 * 60_000 // matches the dashboard's old datanet-name cache
/** Epoch expiry clamp: floor tolerates clock skew in `secondsRemaining` (a skewed value
 *  must not pin a stale epoch), cap bounds trust in a long remaining time. */
const EPOCH_TTL_FLOOR_MS = 30_000
const EPOCH_TTL_MAX_MS = 10 * 60_000

export interface CachedReader {
  reader: ReppoReader
  /** Clear all tick-scoped memos. Called by the scheduler at the start of every cycle. */
  beginCycle(): void
  /** Evict entries carrying any of these tags (write-triggered invalidation). */
  invalidateTags(tags: readonly CacheTag[]): void
}

export interface ReadCacheDeps {
  now?: () => number
  log?: (msg: string) => void
}

export function makeCachedReader(inner: ReppoReader, deps: ReadCacheDeps = {}): CachedReader {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((m: string) => console.error(m))
  const entries = new Map<string, Entry>()

  function cached<T>(
    key: string,
    opts: { tickScoped: boolean; ttlMs?: number; tags?: readonly CacheTag[]; expiryFrom?: (v: T) => number },
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      const hit = entries.get(key)
      if (hit && (hit.expiresAt === null || hit.expiresAt > now())) return hit.value as Promise<T>
      const value = fn()
      const entry: Entry = {
        value,
        expiresAt: opts.ttlMs !== undefined ? now() + opts.ttlMs : null,
        tickScoped: opts.tickScoped,
        tags: opts.tags ?? [],
      }
      entries.set(key, entry)
      value.then(
        (v) => {
          // Derive expiry from the result (epoch: secondsRemaining) once it exists.
          if (opts.expiryFrom && entries.get(key) === entry) entry.expiresAt = now() + opts.expiryFrom(v)
        },
        () => {
          // Never cache a failure — the next read must retry, not replay the error.
          if (entries.get(key) === entry) entries.delete(key)
        },
      )
      return value
    } catch (e) {
      // Cache machinery must never take reads down: correctness over savings.
      log(`readCache: internal error on ${key}, falling through to direct read: ${(e as Error).message}`)
      return fn()
    }
  }

  const epochTtl = (e: EpochInfo): number =>
    Math.min(Math.max(e.secondsRemaining * 1000, EPOCH_TTL_FLOOR_MS), EPOCH_TTL_MAX_MS)

  const reader: ReppoReader = {
    // --- tick-scoped memos (fresh once per cycle) ---
    listPods: (d, o) => cached(`listPods|${d}|${o.all}`, { tickScoped: true, tags: ['pods'] }, () => inner.listPods(d, o)),
    datanetPodVotes: (d) => cached(`datanetPodVotes|${d}`, { tickScoped: true, tags: ['pods', 'votes'] }, () => inner.datanetPodVotes(d)),
    emissionsDue: () => cached('emissionsDue', { tickScoped: true, tags: ['emissions'] }, () => inner.emissionsDue()),
    balance: () => cached('balance', { tickScoped: true, tags: ['balance'] }, () => inner.balance()),
    votingPower: () => cached('votingPower', { tickScoped: true, tags: ['balance'] }, () => inner.votingPower()),
    subnetEmissionInfo: (r, s) => cached(`subnetEmissionInfo|${s}`, { tickScoped: true }, () => inner.subnetEmissionInfo(r, s)),
    tokenBalance: (r, t, o) => cached(`tokenBalance|${t}|${o}`, { tickScoped: true, tags: ['balance'] }, () => inner.tokenBalance(r, t, o)),
    epochVoteVolume: (r, p) => cached(`epochVoteVolume|${[...new Set(p)].sort().join(',')}`, { tickScoped: true, tags: ['votes'] }, () => inner.epochVoteVolume(r, p)),
    votePowerBudget: (r, w) => cached(`votePowerBudget|${w}`, { tickScoped: true, tags: ['votes'] }, () => inner.votePowerBudget(r, w)),
    subnetPools: (r, s) => cached(`subnetPools|${s}`, { tickScoped: true, tags: ['emissions'] }, () => inner.subnetPools(r, s)),
    claimableOnchain: (r, w, d, o) => cached(`claimableOnchain|${w}`, { tickScoped: true, tags: ['emissions'] }, () => inner.claimableOnchain(r, w, d, o)),
    voterClaimableOnchain: (r, w, pods, d, o) =>
      cached(`voterClaimableOnchain|${w}|${[...new Set(pods)].sort().join(',')}`, { tickScoped: true, tags: ['emissions'] }, () => inner.voterClaimableOnchain(r, w, pods, d, o)),
    // --- TTL (slow-moving) ---
    listDatanets: () => cached('listDatanets', { tickScoped: false, ttlMs: LIST_DATANETS_TTL_MS }, () => inner.listDatanets()),
    // --- epoch-derived expiry ---
    epoch: () => cached('epoch', { tickScoped: false, expiryFrom: epochTtl }, () => inner.epoch()),
  }

  return {
    reader,
    beginCycle() {
      for (const [k, e] of entries) if (e.tickScoped) entries.delete(k)
    },
    invalidateTags(tags) {
      for (const [k, e] of entries) if (e.tags.some((t) => tags.includes(t))) entries.delete(k)
    },
  }
}
