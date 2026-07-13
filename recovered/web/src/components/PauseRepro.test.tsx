// @vitest-environment jsdom
// TEMPORARY reproduction harness — delete after running.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { PauseControl } from './PauseControl'

afterEach(cleanup)

describe('kill switch when the node is unreachable', () => {
  it('should surface an error and re-enable the button when fetch REJECTS', async () => {
    // exactly what the browser does when the node is down / SSH tunnel dropped
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const onChanged = vi.fn()
    render(<PauseControl paused={false} onChanged={onChanged} />)

    const btn = screen.getByRole('button', { name: /pause spending/i })
    await userEvent.click(btn)

    await new Promise((r) => setTimeout(r, 50))

    console.log('--- button text after failed click:', JSON.stringify(btn.textContent))
    console.log('--- button disabled:', btn.hasAttribute('disabled'))
    console.log('--- error text rendered:', document.querySelector('.pause-err')?.textContent ?? 'NONE')
    console.log('--- onChanged called:', onChanged.mock.calls.length)

    await waitFor(() => {
      expect(screen.getByText(/could not reach the node/i)).toBeInTheDocument()
    }, { timeout: 500 })
    expect(btn).not.toBeDisabled()
  })
})
