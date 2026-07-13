// @vitest-environment jsdom
// TEMPORARY verification of PR #121 (clamped, click-to-expand activity detail) inside the
// new DiagnosticsTab. Deleted after the run.
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { DiagnosticsTab } from './DiagnosticsTab'
import type { ActivityRow } from '../api'

const LONG = 'Command failed: reppo vote --datanet 11 ' + 'x'.repeat(300)

describe('DiagnosticsTab hosts the clamped activity detail', () => {
  it('clamps and expands on click', async () => {
    const activity: ActivityRow[] = [
      { ts: new Date().toISOString(), kind: 'skip', status: 'skipped', datanetId: '11', detail: LONG } as ActivityRow,
    ]
    render(<DiagnosticsTab activity={activity} health={null} healthLoaded datanets={{ '11': { vote: true, mint: false, strictness: 'balanced' } }}
      netNames={{ '11': 'Sports' }} onOpenPanel={vi.fn()} onConfigChanged={vi.fn()} onBack={vi.fn()} />)

    const cell = document.querySelector('.detail-clamp') as HTMLElement
    expect(cell).toBeTruthy()
    expect(cell).not.toHaveClass('open')
    expect(cell.closest('td')).toHaveClass('detail-cell')
    await userEvent.click(cell)
    expect(document.querySelector('.detail-clamp')).toHaveClass('open')
    expect(screen.getByTitle('click to collapse')).toBeInTheDocument()
  })
})
