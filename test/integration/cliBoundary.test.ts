// Process-boundary integration test: drives the REAL exec.ts/cli.ts path through a
// stub `reppo` binary on PATH that records its argv and emits canned JSON. This is
// the contract test for the flags the node emits — if a CLI flag changes shape,
// this fails even though every unit test (which mocks ReppoCli) stays green.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultReppoCli } from '../../src/reppo/cli.js'

let dir: string
let oldPath: string
let oldRpc: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orq-stub-'))
  oldPath = process.env.PATH ?? ''
  oldRpc = process.env.RPC_URL
  process.env.PATH = `${dir}:${oldPath}`
  process.env.RPC_URL = 'https://base-mainnet.g.alchemy.com/v2/TESTKEY'
})
afterEach(() => {
  process.env.PATH = oldPath
  if (oldRpc === undefined) delete process.env.RPC_URL
  else process.env.RPC_URL = oldRpc
  rmSync(dir, { recursive: true, force: true })
})

/** Install a stub `reppo` that records argv to argv.txt and behaves per mode. */
function stubReppo(mode: 'ok' | 'fail'): void {
  const argvFile = join(dir, 'argv.txt')
  const body = mode === 'ok'
    ? `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\necho '{"txHash":"0xstub","gasEth":0.0005}'\n`
    : `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\necho '{"error":{"code":"VOTER_LACKS_SUBNET_ACCESS","message":"Vote tx failed to submit"}}' >&2\nexit 1\n`
  writeFileSync(join(dir, 'reppo'), body)
  chmodSync(join(dir, 'reppo'), 0o755)
}

const recordedArgv = (): string[] => readFileSync(join(dir, 'argv.txt'), 'utf-8').trim().split('\n')

describe('reppo CLI boundary (stub binary)', () => {
  it('vote emits the 0.8.0 flag shape: --pod, --like/--dislike, --votes, --idempotency-key, --json, --rpc-url', async () => {
    stubReppo('ok')
    const r = await defaultReppoCli.vote({ podId: '922', direction: 'up', votes: 7, idempotencyKey: 'vote-922-up' })
    expect(r).toEqual({ txHash: '0xstub', gasEth: 0.0005 })
    const argv = recordedArgv()
    expect(argv).toEqual([
      'vote', '--pod', '922', '--like', '--votes', '7', '--idempotency-key', 'vote-922-up',
      '--json', '--rpc-url', 'https://base-mainnet.g.alchemy.com/v2/TESTKEY',
    ])
  })

  it('mint-pod emits --datanet, --subnet-uuid, --pod-name/-description, --dataset, --agree-to-terms', async () => {
    stubReppo('ok')
    await defaultReppoCli.mintPod({
      datanetId: '2', subnetUuid: 'cm-x', podName: 'Short name', podDescription: 'Short desc',
      datasetPath: '/tmp/d.json', idempotencyKey: 'mint-k1',
    })
    const argv = recordedArgv()
    expect(argv[0]).toBe('mint-pod')
    expect(argv[argv.indexOf('--datanet') + 1]).toBe('2')
    expect(argv[argv.indexOf('--subnet-uuid') + 1]).toBe('cm-x')
    expect(argv[argv.indexOf('--pod-name') + 1]).toBe('Short name')
    expect(argv[argv.indexOf('--pod-description') + 1]).toBe('Short desc')
    expect(argv[argv.indexOf('--dataset') + 1]).toBe('/tmp/d.json')
    expect(argv[argv.indexOf('--idempotency-key') + 1]).toBe('mint-k1')
    expect(argv).toContain('--agree-to-terms')
    expect(argv).not.toContain('--url')        // omitted when not provided
    expect(argv).not.toContain('--image-url')
  })

  it('mint-pod omits --dataset for a url-only mint (no Pinata)', async () => {
    stubReppo('ok')
    await defaultReppoCli.mintPod({
      datanetId: '2', subnetUuid: 'cm-x', podName: 'n', podDescription: 'd',
      idempotencyKey: 'mint-k3', url: 'https://news.example/article',
    })
    const argv = recordedArgv()
    expect(argv).not.toContain('--dataset')
    expect(argv[argv.indexOf('--url') + 1]).toBe('https://news.example/article')
    expect(argv).toContain('--agree-to-terms')
  })

  it('mint-pod emits --url and --image-url when the intent carries them', async () => {
    stubReppo('ok')
    await defaultReppoCli.mintPod({
      datanetId: '2', subnetUuid: 'cm-x', podName: 'n', podDescription: 'd',
      datasetPath: '/tmp/d.json', idempotencyKey: 'mint-k2',
      url: 'https://news.example/article', imageUrl: 'https://news.example/og.jpg',
    })
    const argv = recordedArgv()
    expect(argv[argv.indexOf('--url') + 1]).toBe('https://news.example/article')
    expect(argv[argv.indexOf('--image-url') + 1]).toBe('https://news.example/og.jpg')
  })

  it('grant-access takes the integer datanet id', async () => {
    stubReppo('ok')
    await defaultReppoCli.grantAccess('2')
    expect(recordedArgv().slice(0, 3)).toEqual(['grant-access', '--datanet', '2'])
  })

  it('a failing command throws the folded stderr WITH the rpc key redacted', async () => {
    stubReppo('fail')
    await expect(defaultReppoCli.vote({ podId: '1', direction: 'down', votes: 2, idempotencyKey: 'k' }))
      .rejects.toThrow(/VOTER_LACKS_SUBNET_ACCESS/)
    // and the redaction held: re-trigger to inspect the message
    const err = await defaultReppoCli.vote({ podId: '1', direction: 'down', votes: 2, idempotencyKey: 'k' }).catch((e: Error) => e)
    expect((err as Error).message).not.toContain('TESTKEY')
  })
})
