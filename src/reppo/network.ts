// src/reppo/network.ts
// Single source of truth for which Reppo network this node runs on and the
// contract addresses the direct-RPC readers hit. The reppo CLI resolves its
// own addresses from the same REPPO_NETWORK env (see exec.ts reppoEnv);
// this module keeps orquestra's raw eth_call/eth_getLogs readers in sync.
//
// Robinhood Chain mainnet (4663) runs the RBV1 contract variant:
//   - fees/emissions are denominated in each subnet's OWN token (no REPPO or
//     USDC on the chain) — readers map the subnet token onto the existing
//     "primary token" path and report the REPPO legs as zero;
//   - VeReppoRBV1 is a read-only voting-power mirror (no staking): power is
//     admin-synced from the wallet's Base veREPPO position by
//     robinhood.reppo.ai, so the veREPPO lock setup step is skipped.
// Addresses from robinhood.reppo.ai production config, verified live 2026-07-27.

export type ReppoNetwork = 'mainnet' | 'testnet' | 'robinhood'

export interface NetworkAddresses {
  podManager: string
  subnetManager: string
  veReppo: string
  /** null on networks without a REPPO token (robinhood). */
  reppoToken: string | null
}

const ADDRESSES: Record<ReppoNetwork, NetworkAddresses> = {
  mainnet: {
    podManager: '0x5C563f853eb4db33005A5C1aD9290e8560254A80',
    subnetManager: '0x2629a8083065938b533b117704935d727270ee7a',
    veReppo: '0x0EFBE19Cb7B07D934D01990a8989E9CaA98b9009',
    reppoToken: '0xFf8104251E7761163faC3211eF5583FB3F8583d6',
  },
  testnet: {
    podManager: '0x113CcFEcdc8Fb1662fCebd195D9573D1c5e5DFD3',
    subnetManager: '0x33c70A9f578Dc22012AEab40A10758f026004A27',
    veReppo: '0x76b4Ee62fF835142B3b29D9F91867697657b556D',
    reppoToken: '0xE224a711e18212Cf08EF3808dfa39ccBBd2f18c6',
  },
  robinhood: {
    podManager: '0xeAd1A577B02829b7F634aD7eE30Fbbc2CDF7e478', // PodManagerRBV1
    subnetManager: '0xDAd72306b2ee410B20795D353cF7913AA7Eb15aa', // SubnetManagerRBV1
    veReppo: '0x15949C1727076a546eB055e9AB9E5bD32f069Db2', // VeReppoRBV1 (mirror)
    reppoToken: null,
  },
}

/** Resolve the node's network from REPPO_NETWORK (same env the CLI reads).
 *  Unknown values fall back to mainnet with a one-time warning rather than
 *  crashing the node — the CLI validates the same env loudly on every call,
 *  so a typo still surfaces as INVALID_NETWORK in the first cycle. */
let warnedUnknown = false
export function reppoNetwork(env: NodeJS.ProcessEnv = process.env): ReppoNetwork {
  const raw = (env.REPPO_NETWORK ?? 'mainnet').trim()
  if (raw === 'mainnet' || raw === 'testnet' || raw === 'robinhood') return raw
  if (!warnedUnknown) {
    warnedUnknown = true
    console.warn(`orquestra: unknown REPPO_NETWORK "${raw}" — reader addresses default to mainnet`)
  }
  return 'mainnet'
}

export function networkAddresses(net: ReppoNetwork = reppoNetwork()): NetworkAddresses {
  return ADDRESSES[net]
}

export const isRobinhood = (env: NodeJS.ProcessEnv = process.env): boolean =>
  reppoNetwork(env) === 'robinhood'
