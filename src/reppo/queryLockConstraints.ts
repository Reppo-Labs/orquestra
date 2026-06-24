// src/reppo/queryLockConstraints.ts
// Read veREPPO protocol constants directly from the contract via eth_call.
// The contract is an ERC1967 proxy (impl: 0x0ace0e652add81c8907e4ae8fd07adbdec1bf988);
// selectors were discovered from the implementation bytecode since it is not verified on Basescan.
import { VE_REPPO_MAINNET } from './emissionsOnchain.js'

export interface LockConstraints {
  maxLockDays: number
  epochDays: number
}

// Unverified name — found by scanning all no-arg selectors and checking return value range
const SEL_MAX_LOCK = '0x76f70003'
// epochLength() — confirmed via 4byte.directory
const SEL_EPOCH_LEN = '0x57d775f8'

async function readUint(rpcUrl: string, to: string, sel: string): Promise<number> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data: sel }, 'latest'] })
  const res = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  const json = await res.json() as { result?: string }
  const hex = json.result
  if (!hex || hex === '0x') return 0
  return Number(BigInt(hex))
}

export async function queryLockConstraints(rpcUrl: string): Promise<LockConstraints> {
  const [maxSec, epochSec] = await Promise.all([
    readUint(rpcUrl, VE_REPPO_MAINNET, SEL_MAX_LOCK),
    readUint(rpcUrl, VE_REPPO_MAINNET, SEL_EPOCH_LEN),
  ])
  return {
    maxLockDays: Math.round(maxSec / 86400),
    epochDays: Math.round(epochSec / 86400),
  }
}
