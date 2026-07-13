// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { PauseControl, PausedBanner } from './PauseControl'

// The kill switch is the one control an operator reaches for in a panic. It must say what
// it did, it must not lie about WHEN it takes effect, and it must never be red — red means
// money lost, and a paused node has lost nothing.

afterEach(cleanup)

const okPause = (paused: boolean) =>
  vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ paused, appliesNextCycle: true }),
  } as unknown as Response)

describe('<PauseControl />', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('POSTs the new paused state and reports it back to the app', async () => {
    const fetchMock = okPause(true)
    vi.stubGlobal('fetch', fetchMock)
    const onChanged = vi.fn()
    render(<PauseControl paused={false} onChanged={onChanged} />)

    await userEvent.click(screen.getByRole('button', { name: /pause spending/i }))

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(true))
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/pause')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ paused: true })
  })

  it('offers Resume — and only Resume — while paused', async () => {
    vi.stubGlobal('fetch', okPause(false))
    const onChanged = vi.fn()
    render(<PauseControl paused onChanged={onChanged} />)

    const btn = screen.getByRole('button', { name: /resume node/i })
    expect(btn).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('button', { name: /pause spending/i })).toBeNull()

    await userEvent.click(btn)
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(false))
  })

  it('surfaces an UNREACHABLE node instead of locking the emergency stop on "…" forever', async () => {
    // The node is mid-restart (or the SSH tunnel dropped). fetch REJECTS. setBusy(false) and
    // setErr() were both skipped: the button stayed disabled showing "…", the operator got no
    // message, believed spending had stopped, and the node came back up and kept spending.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const onChanged = vi.fn()
    render(<PauseControl paused={false} onChanged={onChanged} />)

    await userEvent.click(screen.getByRole('button', { name: /pause spending/i }))

    expect(await screen.findByText(/could not reach the node/i)).toBeInTheDocument()
    const btn = screen.getByRole('button', { name: /pause spending/i })
    expect(btn).toBeEnabled() // the control comes back — it is not stranded on "…"
    expect(onChanged).not.toHaveBeenCalled() // and it never claims a pause that did not happen
  })

  it('surfaces a refusal instead of pretending the node stopped', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 409, json: async () => ({ error: 'no strategy config yet' }),
    } as unknown as Response))
    const onChanged = vi.fn()
    render(<PauseControl paused={false} onChanged={onChanged} />)

    await userEvent.click(screen.getByRole('button', { name: /pause spending/i }))

    expect(await screen.findByText(/no strategy config yet/i)).toBeInTheDocument()
    expect(onChanged).not.toHaveBeenCalled() // never claim a pause that did not happen
  })
})

describe('<PausedBanner />', () => {
  it('renders nothing while the node is running', () => {
    const { container } = render(<PausedBanner paused={false} onChanged={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('states the paused truth unambiguously and stays honest about when it applies', () => {
    render(<PausedBanner paused onChanged={vi.fn()} />)
    const banner = screen.getByRole('status', { name: /node paused/i })
    expect(banner).toHaveTextContent('Node paused — signing nothing.')
    expect(banner).toHaveTextContent(/no votes, no mints, no claims/i)
    // the appliesNextCycle nuance — surfaced, not hidden
    expect(banner).toHaveTextContent(/cycle already in progress finishes under the old setting/i)
    expect(screen.getByRole('button', { name: /resume/i })).toBeInTheDocument()
  })

  it('is amber, not red — a paused node has not lost money', () => {
    const { container } = render(<PausedBanner paused onChanged={vi.fn()} />)
    expect(container.querySelector('.dot')).toHaveClass('warm')
    expect(container.querySelector('.neg')).toBeNull()
    expect(container.querySelector('.dot.bad')).toBeNull()
  })

  it('resumes from the banner itself', async () => {
    vi.stubGlobal('fetch', okPause(false))
    const onChanged = vi.fn()
    render(<PausedBanner paused onChanged={onChanged} />)
    await userEvent.click(screen.getByRole('button', { name: /resume/i }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(false))
  })
})
