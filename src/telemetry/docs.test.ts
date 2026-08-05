// Keeps docs/telemetry.md honest.
//
// Under default-on, that document is the operator's only account of what leaves their
// machine, and most operators will read it instead of running `--show`. A doc that drifts
// from the code is therefore not a documentation bug — it is a false privacy claim made to
// every operator at once. This test makes drift a CI failure.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALLOWLIST_FIELDS } from './payload.js'
import { RETENTION_DAYS } from './notice.js'
import { OPT_OUT_ENV } from './consent.js'

const DOC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'telemetry.md')

function doc(): string {
  return readFileSync(DOC, 'utf-8')
}

/** Field names appear as `` `name` `` in the leading column of the "What is sent" table. */
function documentedFields(text: string): string[] {
  const table = text.slice(text.indexOf('## What is sent'), text.indexOf('## What is never sent'))
  const names = new Set<string>()
  for (const line of table.split('\n')) {
    const m = line.match(/^\|\s*`([a-zA-Z]+)`(?:\s*\/\s*`([a-zA-Z]+)`)?\s*\|/)
    if (!m) continue
    names.add(m[1])
    if (m[2]) names.add(m[2])
  }
  return [...names]
}

describe('docs/telemetry.md matches the code', () => {
  it('documents exactly the allowlisted fields — no more, no fewer', () => {
    expect(documentedFields(doc()).sort()).toEqual([...ALLOWLIST_FIELDS].sort())
  })

  it('states the retention period the code uses', () => {
    expect(doc()).toContain(`**${RETENTION_DAYS} days**`)
  })

  it('names the real opt-out environment variable', () => {
    expect(doc()).toContain(OPT_OUT_ENV)
  })

  it('still states the load-bearing prohibitions', () => {
    // If someone relaxes one of these in code, deleting the line here is a deliberate act,
    // not an oversight.
    const t = doc()
    for (const claim of [
      'Your wallet address',
      'Datanet or subnet identifiers',
      'Pod names, pod content, or panel transcripts',
      'RPC URLs',
    ]) {
      expect(t).toContain(claim)
    }
  })

  it('tells the operator how to see the payload themselves', () => {
    expect(doc()).toContain('orquestra telemetry --show')
  })
})
