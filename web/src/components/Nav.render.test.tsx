// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { Nav } from './Nav'

// Six tabs was a filing cabinet. The IA contract: THREE primary tabs, the kill switch
// always one click away, and the diagnostics surfaces still reachable — demoted, never
// deleted.

afterEach(cleanup)

const props = {
  data: null,
  asof: 'awaiting first cycle',
  onTab: vi.fn(),
  paused: false,
  onPauseChange: vi.fn(),
  onRefresh: vi.fn(),
  alertCount: 0,
  alertWorst: null,
  onOpenAlerts: vi.fn(),
}

describe('<Nav /> information architecture', () => {
  it('offers exactly three primary tabs: Home, Datanets, Assistant', () => {
    render(<Nav {...props} tab="home" />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['Home', 'Datanets', 'Assistant'])
  })

  it('no longer surfaces Overview, Strategy, Activity, Health or Learning as top-level tabs', () => {
    render(<Nav {...props} tab="home" />)
    for (const gone of [/^Overview$/, /^Strategy$/, /^Activity$/, /^Health$/, /^Learning$/]) {
      expect(screen.queryByRole('tab', { name: gone })).toBeNull()
    }
  })

  it('keeps diagnostics reachable — as a link, not a tab', async () => {
    const onTab = vi.fn()
    render(<Nav {...props} onTab={onTab} tab="home" />)
    const diag = screen.getByRole('button', { name: 'Diagnostics' })
    expect(screen.queryByRole('tab', { name: 'Diagnostics' })).toBeNull()
    await userEvent.click(diag)
    expect(onTab).toHaveBeenCalledWith('diagnostics')
  })

  it('marks the current tab for assistive tech', () => {
    render(<Nav {...props} tab="datanets" />)
    expect(screen.getByRole('tab', { name: 'Datanets' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Home' })).toHaveAttribute('aria-selected', 'false')
  })

  it('puts the kill switch in the header, on every tab', () => {
    render(<Nav {...props} tab="assistant" />)
    expect(screen.getByRole('button', { name: /pause spending/i })).toBeInTheDocument()
  })

  it('shows Resume in the header once paused', () => {
    render(<Nav {...props} paused tab="home" />)
    expect(screen.getByRole('button', { name: /resume node/i })).toBeInTheDocument()
  })
})
