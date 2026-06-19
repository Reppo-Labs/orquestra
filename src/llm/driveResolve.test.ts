import { describe, it, expect } from 'vitest'
import { resolveDriveUrl } from './driveResolve.js'

const DL = (id: string) => `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`

describe('resolveDriveUrl', () => {
  it('rewrites a /file/d/<ID>/view viewer URL to a direct download', () => {
    expect(resolveDriveUrl('https://drive.google.com/file/d/1AbC_dEfGhI/view?usp=sharing')).toBe(DL('1AbC_dEfGhI'))
  })

  it('rewrites /file/d/<ID> without a trailing segment', () => {
    expect(resolveDriveUrl('https://drive.google.com/file/d/1AbC_dEfGhI')).toBe(DL('1AbC_dEfGhI'))
  })

  it('rewrites an open?id=<ID> share URL', () => {
    expect(resolveDriveUrl('https://drive.google.com/open?id=1AbC_dEfGhI')).toBe(DL('1AbC_dEfGhI'))
  })

  it('rewrites a uc?id=<ID> URL', () => {
    expect(resolveDriveUrl('https://drive.google.com/uc?id=1AbC_dEfGhI&export=download')).toBe(DL('1AbC_dEfGhI'))
  })

  it('rewrites a docs.google.com /d/<ID> URL', () => {
    expect(resolveDriveUrl('https://docs.google.com/file/d/1AbC_dEfGhI/edit')).toBe(DL('1AbC_dEfGhI'))
  })

  it('is idempotent on an already-resolved usercontent download URL', () => {
    const u = DL('1AbC_dEfGhI')
    expect(resolveDriveUrl(u)).toBe(u)
  })

  it('passes a direct MP4 URL through unchanged', () => {
    const u = 'https://cdn.example.com/clips/run.mp4'
    expect(resolveDriveUrl(u)).toBe(u)
  })

  it('passes an IPFS gateway URL through unchanged', () => {
    const u = 'https://ipfs.io/ipfs/Qm123/pod.json'
    expect(resolveDriveUrl(u)).toBe(u)
  })

  it('returns a Drive URL with no extractable id unchanged', () => {
    const u = 'https://drive.google.com/drive/folders/1AbC_dEfGhI'
    // folder URL has no /d/<id> nor ?id= → no rewrite
    expect(resolveDriveUrl(u)).toBe(u)
  })

  it('returns an unparseable string unchanged', () => {
    expect(resolveDriveUrl('not a url')).toBe('not a url')
  })
})
