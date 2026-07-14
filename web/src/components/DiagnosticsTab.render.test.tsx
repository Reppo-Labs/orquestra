// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { DiagnosticsTab } from './DiagnosticsTab'
import type { ActivityRow } from '../api'

// The activity log stopped being a top-level tab and moved in here. The one thing that made
// it readable must survive the move: a raw CLI error is a single unbroken 300-character
// string, and un-clamped it widens the table past the panel's overflow:hidden and clips the
// Status and Tx columns off the screen. So it is clamped to two lines, and clicking it opens.

afterEach(cleanup)

const LONG = `Command failed: reppo vote --datanet 11 ${'x'.repeat(300)}`

const props = {
  health: null,
  healthLoaded: true,
  datanets: { '11': { vote: true, mint: false, strictness: 'balanced' as const } },
  netNames: { '11': 'Sports signals' },
  onOpenPanel: vi.fn(),
  onConfigChanged: vi.fn(),
  onBack: vi.fn(),
}

describe('<DiagnosticsTab /> — the activity log it now hosts', () => {
  it('clamps a long detail to two lines and expands it on click', async () => {
    const activity: ActivityRow[] = [
      { ts: new Date().toISOString(), kind: 'skip', status: 'skipped', datanetId: '11', detail: LONG } as ActivityRow,
    ]
    render(<DiagnosticsTab activity={activity} {...props} />)

    const cell = screen.getByTitle('click to expand')
    expect(cell).toHaveClass('detail-clamp')              // the 2-line clamp (styles.css)
    expect(cell).not.toHaveClass('open')
    expect(cell.closest('td')).toHaveClass('detail-cell') // the bounded column width

    await userEvent.click(cell)

    expect(screen.getByTitle('click to collapse')).toHaveClass('detail-clamp', 'open')
  })
})
