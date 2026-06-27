import { describe, it, expect, beforeEach } from 'vitest'
import { foldExecError, parseChainResult, resetWarnedNoGas } from './cli.js'

describe('foldExecError', () => {
  it('folds stderr into the message so the activity log records the real cause', () => {
    const e = Object.assign(new Error('Command failed: reppo vote --pod 1'), {
      stdout: '', stderr: '{"error":{"code":"VOTER_LACKS_SUBNET_ACCESS","message":"Vote tx failed to submit"}}',
    })
    const out = foldExecError(e)
    expect(out.message).toContain('Command failed: reppo vote --pod 1')
    expect(out.message).toContain('VOTER_LACKS_SUBNET_ACCESS')
  })

  it('keeps just the head when both streams are empty (no trailing separator)', () => {
    const e = Object.assign(new Error('Command failed: reppo vote'), { stdout: '', stderr: '' })
    expect(foldExecError(e).message).toBe('Command failed: reppo vote')
  })

  it('redacts the rpc-url key from the folded command line', () => {
    const e = Object.assign(
      new Error('Command failed: reppo vote --pod 1 --rpc-url https://base-mainnet.g.alchemy.com/v2/SECRET123'),
      { stdout: '', stderr: 'boom' },
    )
    const out = foldExecError(e)
    expect(out.message).not.toContain('SECRET123')
    expect(out.message).toContain('--rpc-url <redacted>')
    expect(out.message).toContain('boom')
  })

  it('takes only the first line of a multi-line message', () => {
    const e = Object.assign(new Error('head line\nsecond line with --rpc-url https://x/v2/KEY'), { stdout: '', stderr: '' })
    expect(foldExecError(e).message).toBe('head line')
  })

  it('tolerates a non-Error rejection', () => {
    expect(foldExecError('string failure').message).toContain('string failure')
  })
})

describe('parseChainResult', () => {
  beforeEach(() => resetWarnedNoGas())

  it('parses txHash and gasEth', () => {
    expect(parseChainResult('{"txHash":"0xabc","gasEth":0.001}', () => {})).toEqual({ txHash: '0xabc', gasEth: 0.001 })
  })

  it('accepts the legacy tx field and defaults gas to 0', () => {
    expect(parseChainResult('{"tx":"0xdef"}', () => {})).toEqual({ txHash: '0xdef', gasEth: 0 })
  })

  it('warns exactly once per process when gasEth is missing', () => {
    const warns: string[] = []
    parseChainResult('{"txHash":"0x1"}', (m) => warns.push(m))
    parseChainResult('{"txHash":"0x2"}', (m) => warns.push(m))
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/no gasEth/)
  })

  it('does not warn when gasEth is present', () => {
    const warns: string[] = []
    parseChainResult('{"txHash":"0x1","gasEth":0.002}', (m) => warns.push(m))
    expect(warns).toEqual([])
  })

  it('throws on non-JSON stdout (caller folds it into an error)', () => {
    expect(() => parseChainResult('not json', () => {})).toThrow()
  })
})

describe('parseChainResult podId (mint-pod result)', () => {
  it('parses podId when the CLI reports it (string)', () => {
    const r = parseChainResult('{"txHash":"0x1","gasEth":0.01,"podId":"508"}', () => {})
    expect(r.podId).toBe('508')
  })
  it('coerces a numeric podId to string', () => {
    const r = parseChainResult('{"txHash":"0x1","gasEth":0.01,"podId":508}', () => {})
    expect(r.podId).toBe('508')
  })
  it('podId absent → undefined (vote/claim/grant results)', () => {
    expect(parseChainResult('{"txHash":"0x1","gasEth":0.001}', () => {}).podId).toBeUndefined()
  })
})

describe('parseChainResult reppoFee', () => {
  it('parses reppoFee when the CLI reports it (0.8.4+)', () => {
    const r = parseChainResult('{"txHash":"0x1","gasEth":0.001,"reppoFee":"100"}', () => {})
    expect(r.reppoFee).toBe(100)
  })
  it('reppoFee absent → undefined (older CLI)', () => {
    expect(parseChainResult('{"txHash":"0x1","gasEth":0.001}', () => {}).reppoFee).toBeUndefined()
  })
})

describe('parseChainResult grant-access fee (reppo >=0.8.5)', () => {
  it('keeps feeAmount as the formatted STRING (no Number() — preserves precision)', () => {
    const r = parseChainResult(
      '{"txHash":"0xg","gasEth":0.0005,"feeToken":{"symbol":"EXY","address":"0xExy","decimals":6},"feeAmount":{"raw":"50000000","formatted":"50"}}',
      () => {},
    )
    expect(r.feeAmount).toBe('50')
    expect(typeof r.feeAmount).toBe('string')
    expect(r.feeToken).toEqual({ symbol: 'EXY', address: '0xExy', decimals: 6 })
  })

  it('parses feePaid (receipt-derived actual) as a string', () => {
    const r = parseChainResult('{"txHash":"0xg","gasEth":0.0005,"feePaid":"49.999"}', () => {})
    expect(r.feePaid).toBe('49.999')
  })

  it('grant-fee fields absent on a plain vote/mint result → undefined', () => {
    const r = parseChainResult('{"txHash":"0x1","gasEth":0.001}', () => {})
    expect(r.feeAmount).toBeUndefined()
    expect(r.feePaid).toBeUndefined()
    expect(r.feeToken).toBeUndefined()
  })
})
