import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _resetDbs } from '../dashboard/db.js'
import { insertLesson, clearLessons, setLearnEnabled } from './store.js'
import { buildLessonsBlock } from './inject.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orq-inject-')) })
afterEach(() => { _resetDbs(); rmSync(dir, { recursive: true, force: true }) })

const lesson = (text: string) => ({ datanetId: '9', text, source: 'calibration' as const, createdEpoch: 100, createdTs: '2026-06-15T00:00:00.000Z', active: 1 as const })

describe('buildLessonsBlock', () => {
  it('is empty on a cold start (no lessons → byte-identical prompt)', () => {
    expect(buildLessonsBlock(dir, '9')).toBe('')
  })

  it('renders a trusted, numbered block of active lessons', () => {
    insertLesson(dir, lesson('high-conviction calls aligned 40% — tighten sourcing'))
    insertLesson(dir, lesson('down-votes aligned 80%'))
    const block = buildLessonsBlock(dir, '9')
    expect(block).toContain("trusted — distilled from THIS node's own past outcomes")
    expect(block).toContain('1. high-conviction calls aligned 40%')
    expect(block).toContain('2. down-votes aligned 80%')
  })

  it('is empty when learning is disabled for the datanet (operator veto)', () => {
    insertLesson(dir, lesson('x'))
    setLearnEnabled(dir, '9', false)
    expect(buildLessonsBlock(dir, '9')).toBe('')
  })

  it('ignores deactivated lessons', () => {
    insertLesson(dir, lesson('old'))
    clearLessons(dir, '9')
    expect(buildLessonsBlock(dir, '9')).toBe('')
  })

  it('is scoped per datanet', () => {
    insertLesson(dir, lesson('for 9'))
    expect(buildLessonsBlock(dir, '2')).toBe('')
  })
})
