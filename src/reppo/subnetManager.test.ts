import { describe, it, expect } from 'vitest'
import { getSubnetEmissionInfo, formatTokenAmount } from './subnetManager.js'

const SEL = { primaryToken: '0x0d1b89d8', primaryEmissions: '0x9f9a490b', reppoEmissions: '0xd323657d' }
const w = (v: bigint): string => v.toString(16).padStart(64, '0')
const addrWord = (a: string): string => a.toLowerCase().replace(/^0x/, '').padStart(64, '0')

function makeFetch(opts: { token: string; primary: bigint; reppo: bigint }): typeof fetch {
  const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
  return (async (_url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body)
    if (method !== 'eth_call') return reply('0x')
    const sel: string = params[0].data.slice(0, 10)
    if (sel === SEL.primaryToken) return reply('0x' + addrWord(opts.token))
    if (sel === SEL.primaryEmissions) return reply('0x' + w(opts.primary))
    if (sel === SEL.reppoEmissions) return reply('0x' + w(opts.reppo))
    return reply('0x')
  }) as unknown as typeof fetch
}

describe('getSubnetEmissionInfo', () => {
  it('resolves token + emission amounts (Litebeam/LBM shape)', async () => {
    const fetchImpl = makeFetch({
      token: '0x15B15FA54b629C634958E8BD639b2fc8af654974',
      primary: 40000n * 10n ** 18n,
      reppo: 0n,
    })
    const info = await getSubnetEmissionInfo('http://rpc', 22, { fetchImpl })
    expect(info.primaryToken).toBe('0x15b15fa54b629c634958e8bd639b2fc8af654974')
    expect(info.primaryEmissionsPerEpoch).toBe(40000n * 10n ** 18n)
    expect(info.reppoEmissionsPerEpoch).toBe(0n)
  })

  it('returns zero amounts on empty responses', async () => {
    const fetchImpl = makeFetch({ token: '0x0000000000000000000000000000000000000000', primary: 0n, reppo: 0n })
    const info = await getSubnetEmissionInfo('http://rpc', 99, { fetchImpl })
    expect(info.primaryEmissionsPerEpoch).toBe(0n)
    expect(info.reppoEmissionsPerEpoch).toBe(0n)
    expect(info.primaryToken).toBe('0x0000000000000000000000000000000000000000')
  })

  it('throws on RPC error', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'boom' } }))) as unknown as typeof fetch
    await expect(getSubnetEmissionInfo('http://rpc', 1, { fetchImpl })).rejects.toThrow(/boom/)
  })
})

describe('formatTokenAmount', () => {
  it('scales by decimals', () => {
    expect(formatTokenAmount(40000n * 10n ** 18n, 18)).toBe(40000)
    expect(formatTokenAmount(1500000n, 6)).toBe(1.5)
  })
  it('returns raw number for invalid decimals', () => {
    expect(formatTokenAmount(42n, -1)).toBe(42)
  })
})
