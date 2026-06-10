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
