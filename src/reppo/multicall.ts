// src/reppo/multicall.ts
// Multicall3 aggregate3 batching for eth_call grids: N view reads collapse into
// ⌈N/200⌉ RPC requests so free/public endpoints aren't stormed as pod counts grow.
// Raw JSON-RPC + hand-rolled ABI, no extra dep — mirrors src/reppo/emissionsOnchain.ts.
//
// ONLY msg.sender-independent view getters may go through here: inside aggregate3 the
// EVM caller is the Multicall3 contract, not our wallet, so claim probes (eth_call with
// `from: wallet`, revert = "nothing due") would all revert and misclassify claimable
// epochs. Those stay serial — see openspec change reduce-rpc-calls, design D4.

import { rpcFetch } from './rpcEndpoints.js'

/** Canonical Multicall3 — same address on virtually every EVM chain. */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11'
const SEL_AGGREGATE3 = '0x82ad56cb' // aggregate3((address,bool,bytes)[])
/** Calls per aggregate3 request. Well under typical eth_call gas caps for view getters. */
const BATCH_SIZE = 200

export interface Call3 {
  target: string
  /** 0x-prefixed calldata (selector + args). */
  callData: string
}
export interface Call3Result {
  /** false ⇔ this inner call reverted (allowFailure=true keeps the batch alive). */
  success: boolean
  /** 0x-prefixed raw returndata ('0x' when empty). */
  returnData: string
}

export interface MulticallDeps {
  fetchImpl?: typeof fetch
  multicallAddress?: string
}

const strip = (h: string): string => h.replace(/^0x/, '')
const word = (v: bigint): string => v.toString(16).padStart(64, '0')
const addrWord = (addr: string): string => strip(addr).toLowerCase().padStart(64, '0')
const padBytes = (h: string): string => {
  const s = strip(h)
  return s.length % 64 === 0 ? s : s + '0'.repeat(64 - (s.length % 64))
}

/** ABI-encode aggregate3(Call3[]) calldata. Call3 = (address target, bool allowFailure,
 *  bytes callData); allowFailure is always true — per-call reverts must not fail the batch. */
export function encodeAggregate3(calls: Call3[]): string {
  const heads: string[] = []
  const tails: string[] = []
  let tailOff = 32 * calls.length // element offsets are relative to the start of the offsets area
  for (const c of calls) {
    heads.push(word(BigInt(tailOff)))
    const data = strip(c.callData)
    const tuple = addrWord(c.target) + word(1n) + word(0x60n) + word(BigInt(data.length / 2)) + padBytes(data)
    tails.push(tuple)
    tailOff += tuple.length / 2
  }
  return SEL_AGGREGATE3 + word(0x20n) + word(BigInt(calls.length)) + heads.join('') + tails.join('')
}

/** Decode aggregate3 returndata: (bool success, bytes returnData)[]. */
export function decodeAggregate3(resultHex: string): Call3Result[] {
  const h = strip(resultHex)
  const uintAt = (byteOff: number): bigint => BigInt('0x' + (h.slice(byteOff * 2, byteOff * 2 + 64) || '0'))
  const arrStart = Number(uintAt(0)) // offset of the array (normally 0x20)
  const n = Number(uintAt(arrStart))
  const dataStart = arrStart + 32 // element offsets are relative to here
  const out: Call3Result[] = []
  for (let i = 0; i < n; i++) {
    const elem = dataStart + Number(uintAt(dataStart + 32 * i))
    const success = uintAt(elem) !== 0n
    const bytesAt = elem + Number(uintAt(elem + 32))
    const len = Number(uintAt(bytesAt))
    const data = h.slice((bytesAt + 32) * 2, (bytesAt + 32 + len) * 2)
    out.push({ success, returnData: len === 0 ? '0x' : '0x' + data })
  }
  return out
}

async function ethCallRaw(fetchImpl: typeof fetch, url: string, to: string, data: string): Promise<string> {
  const res = await rpcFetch(fetchImpl, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  })
  if (!res.ok) throw new Error(`RPC eth_call HTTP ${res.status}`)
  const json = (await res.json()) as { result?: string; error?: { message?: string } }
  if (json?.error) throw new Error(`RPC eth_call error: ${json.error.message ?? 'unknown'}`)
  const r = json.result
  if (typeof r !== 'string' || r === '') throw new Error('RPC eth_call malformed response (no result)')
  return r
}

/** Execute `calls` via aggregate3 in chunks of BATCH_SIZE, preserving order and per-call
 *  success/revert. Chunks run sequentially (politeness to rate-limited endpoints). Throws
 *  on transport/RPC failure — the whole batch is then "unavailable this cycle", exactly
 *  like a serial read failure; it never silently drops individual results. */
export async function tryAggregate(rpcUrl: string, calls: Call3[], deps: MulticallDeps = {}): Promise<Call3Result[]> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const mc = deps.multicallAddress ?? MULTICALL3_ADDRESS
  const out: Call3Result[] = []
  for (let i = 0; i < calls.length; i += BATCH_SIZE) {
    const chunk = calls.slice(i, i + BATCH_SIZE)
    const res = await ethCallRaw(fetchImpl, rpcUrl, mc, encodeAggregate3(chunk))
    const decoded = decodeAggregate3(res)
    if (decoded.length !== chunk.length) throw new Error(`multicall: expected ${chunk.length} results, got ${decoded.length}`)
    out.push(...decoded)
  }
  return out
}

// Availability probe: one eth_getCode per (rpcUrl, address) per process. A probe FAILURE
// is not cached — a transient outage must not pin "unavailable" for the process lifetime;
// the next cycle re-probes.
const availabilityCache = new Map<string, boolean>()

/** Is Multicall3 deployed on this chain? False (uncached) on probe failure. */
export async function isMulticallAvailable(rpcUrl: string, deps: MulticallDeps = {}): Promise<boolean> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const mc = deps.multicallAddress ?? MULTICALL3_ADDRESS
  const key = `${rpcUrl}|${mc.toLowerCase()}`
  const hit = availabilityCache.get(key)
  if (hit !== undefined) return hit
  try {
    const res = await rpcFetch(fetchImpl, rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [mc, 'latest'] }),
    })
    if (!res.ok) return false
    const json = (await res.json()) as { result?: string; error?: unknown }
    if (json?.error || typeof json.result !== 'string') return false
    const available = json.result !== '0x' && json.result !== ''
    availabilityCache.set(key, available)
    return available
  } catch {
    return false
  }
}

/** Test hook: forget probed chains (mirrors src/rubric/load.ts's cache reset). */
export function resetMulticallAvailabilityCache(): void {
  availabilityCache.clear()
}
