// src/reppo/network.test.ts
import { describe, it, expect } from 'vitest'
import { reppoNetwork, networkAddresses, isRobinhood } from './network.js'

describe('reppoNetwork', () => {
  it('defaults to mainnet when REPPO_NETWORK is unset', () => {
    expect(reppoNetwork({})).toBe('mainnet')
  })

  it('accepts robinhood', () => {
    expect(reppoNetwork({ REPPO_NETWORK: 'robinhood' })).toBe('robinhood')
    expect(isRobinhood({ REPPO_NETWORK: 'robinhood' })).toBe(true)
  })

  it('falls back to mainnet on an unknown value (CLI surfaces the typo loudly)', () => {
    expect(reppoNetwork({ REPPO_NETWORK: 'goerli' })).toBe('mainnet')
  })
})

describe('networkAddresses', () => {
  it('mainnet matches the legacy hardcoded reader addresses', () => {
    const a = networkAddresses('mainnet')
    expect(a.podManager).toBe('0x5C563f853eb4db33005A5C1aD9290e8560254A80')
    expect(a.subnetManager).toBe('0x2629a8083065938b533b117704935d727270ee7a')
    expect(a.veReppo).toBe('0x0EFBE19Cb7B07D934D01990a8989E9CaA98b9009')
    expect(a.reppoToken).toBe('0xFf8104251E7761163faC3211eF5583FB3F8583d6')
  })

  it('robinhood carries the RBV1 addresses and no REPPO token', () => {
    const a = networkAddresses('robinhood')
    expect(a.podManager).toBe('0xeAd1A577B02829b7F634aD7eE30Fbbc2CDF7e478')
    expect(a.subnetManager).toBe('0xDAd72306b2ee410B20795D353cF7913AA7Eb15aa')
    expect(a.veReppo).toBe('0x15949C1727076a546eB055e9AB9E5bD32f069Db2')
    expect(a.reppoToken).toBeNull()
  })
})
