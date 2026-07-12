// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import type { OnboardingAnswers } from '../api'

// Real render + interaction smoke test for Onboarding. The '../api' network layer
// is mocked (we never touch api.ts) so the test drives the component's own state
// machine: initial stepper → begin the interview → finalize → confirm. The key
// assertion is that Confirm POSTs the finalized answers unchanged — i.e. the
// payload shape the server's POST /api/onboarding/confirm expects.

// A representative finalized strategy — the exact object the assistant "finalizes"
// and the component must hand to onboardingConfirm verbatim.
const ANSWERS: OnboardingAnswers = {
  datanets: [{ id: '42', vote: true, mint: false, strictness: 'balanced' }],
  lockReppo: 100,
  lockDurationDays: 30,
  voteRateMaxPerCycle: 5,
  mintReppoMax: 250,
  horizonDays: 14,
  cadenceHours: 6,
  notes: 'vote-only test run',
  nodeName: 'test-node',
}

const { chatMock, confirmMock } = vi.hoisted(() => ({
  chatMock: vi.fn(),
  confirmMock: vi.fn(),
}))

vi.mock('../api', () => ({
  onboardingChat: chatMock,
  onboardingConfirm: confirmMock,
}))

// Import after the mock is registered so the component binds the mocked fns.
const { Onboarding } = await import('./Onboarding')

const AVAILABLE = { needed: true, chatAvailable: true }

beforeEach(() => {
  // jsdom implements no layout, so Element.scrollIntoView is absent — the finalize
  // effect calls it to signpost the Start button. Stub it (test-only, component untouched).
  Element.prototype.scrollIntoView = vi.fn()
  chatMock.mockReset().mockResolvedValue({ ok: true, out: { reply: 'here is your strategy', finalized: ANSWERS } })
  confirmMock.mockReset().mockResolvedValue({ ok: true })
})
afterEach(cleanup)

describe('<Onboarding /> render + confirm path', () => {
  it('renders the four-step stepper with Connect active before starting', () => {
    const { container } = render(
      <Onboarding status={AVAILABLE} netNames={{}} onDone={() => {}} />,
    )
    const steps = [...container.querySelectorAll('.ob-step')].map((s) => s.textContent)
    expect(steps).toHaveLength(4)
    expect(steps.join(' ')).toContain('Connect')
    expect(steps.join(' ')).toContain('Interview')
    expect(steps.join(' ')).toContain('Review')
    expect(steps.join(' ')).toContain('Start')
    // Step 1 (Connect) is the active one on first render.
    expect(container.querySelector('.ob-step.active')).toHaveTextContent('Connect')
    // The entry action is present and enabled (chat is available).
    expect(screen.getByRole('button', { name: 'Start onboarding' })).toBeEnabled()
  })

  it('disables the start button and shows the LLM warning when chat is unavailable', () => {
    render(
      <Onboarding status={{ needed: true, chatAvailable: false }} netNames={{}} onDone={() => {}} />,
    )
    expect(screen.getByRole('button', { name: 'Start onboarding' })).toBeDisabled()
    expect(screen.getByText(/onboarding assistant needs an LLM/i)).toBeInTheDocument()
  })

  it('begins the interview, finalizes, and confirms the finalized answers verbatim', async () => {
    const user = userEvent.setup()
    const onDone = vi.fn()
    render(<Onboarding status={AVAILABLE} netNames={{ '42': 'Geopolitics' }} onDone={onDone} />)

    await user.click(screen.getByRole('button', { name: 'Start onboarding' }))

    // begin() resets the server session, then takes one assistant turn that finalizes.
    expect(chatMock).toHaveBeenCalledWith({ reset: true })

    // Finalizing surfaces the review sheet + the Start-the-node action.
    const confirmBtn = await screen.findByRole('button', { name: 'Start the node' })
    // Now on Review (step 3): the finalized sheet header is shown.
    expect(screen.getByText('final strategy — review & confirm')).toBeInTheDocument()

    await user.click(confirmBtn)

    // The exact payload POSTed to /api/onboarding/confirm is the finalized answers.
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(confirmMock).toHaveBeenCalledWith(ANSWERS)
    const sent = confirmMock.mock.calls[0][0] as OnboardingAnswers
    expect(sent).toMatchObject({
      datanets: [{ id: '42', vote: true, mint: false, strictness: 'balanced' }],
      mintReppoMax: 250,
      voteRateMaxPerCycle: 5,
      nodeName: 'test-node',
    })

    // A successful confirm advances the stepper to Start(4).
    expect(await screen.findByText(/saved — the node starts its first cycle shortly/)).toBeInTheDocument()
  })
})
