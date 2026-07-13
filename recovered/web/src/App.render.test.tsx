// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { App } from './App'

// The yield leaderboard's click-through. Its whole point is that the operator lands ON the
// datanet they clicked — a jump to the top of a list of rows they then have to hunt through
// is the behaviour this replaced. Retiring the Strategy tab (its card was the old landing
// spot) must not quietly lose it, so the wiring is pinned here end to end: from the
// leaderboard row on Home to the flashed, focused row on Datanets.

afterEach(cleanup)

const SNAPSHOT = {
  ts: Date.now(),
  balance: { reppo: 2057, veReppo: 2862, eth: 0.0037 },
  emissionsDue: { pods: [] },
  datanetEconomics: [
    { datanetId: '5', emissionsPerEpochReppo: 6000, epoch: 116, epochVoteVolume: 6.09, yieldPerVote: 984.34, uncontested: false },
    { datanetId: '11', emissionsPerEpochReppo: 300, epoch: 116, epochVoteVolume: 40, yieldPerVote: 7.5, uncontested: false },
  ],
}

const CONFIG = {
  cadenceHours: 1,
  datanets: {
    '11': { vote: true, mint: true, strictness: 'balanced' },
    '5': { vote: true, mint: false, strictness: 'balanced' },
  },
}

const ROUTES: Record<string, unknown> = {
  '/api/onboarding/status': { needed: false },
  '/api/pnl': {
    pnl: { netReppo: -1906, earnedReppo: 8383, claimedReppo: 8383, claimableReppo: 0, spentReppo: 10290, gasSpentEth: 0.0003 },
    snapshot: SNAPSHOT,
  },
  '/api/activity': [],
  '/api/config': CONFIG,
  '/api/earn': null,
  '/api/datanets': { '11': 'Sports signals', '5': 'Industrial task videos' },
  '/api/datanet-pnl': { datanets: [] },
  '/api/health': { datanets: [] },
  '/api/models': { providers: [] },
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const key = Object.keys(ROUTES).find((k) => String(url).startsWith(k))
    return Promise.resolve({ ok: true, json: async () => (key ? ROUTES[key] : {}) } as unknown as Response)
  }))
  // jsdom has no layout, so it implements no scrolling. The component calls it optionally;
  // nothing here asserts on the scroll itself, only on what the operator can see: the row.
  Element.prototype.scrollIntoView = vi.fn()
})

/** Home → Node details → the "Best places to vote" board. */
async function openLeaderboard() {
  render(<App />)
  await userEvent.click(await screen.findByRole('button', { name: /Node details/ }))
  await screen.findByText(/Best places to vote/)
}

const flashedRow = () => document.querySelector('.dn-row.flash')

describe('<App /> — the yield leaderboard click-through', () => {
  it('lands the operator on the Datanets tab, ON the datanet they clicked', async () => {
    await openLeaderboard()

    // Datanet 5 tops the board: the highest yield per vote.
    await userEvent.click(screen.getByRole('button', { name: /Industrial task videos/ }))

    // …the Datanets tab
    expect(await screen.findByRole('heading', { name: 'Datanets' })).toBeInTheDocument()
    // …and THAT datanet's row is the one flashed and focused — never merely the top of the list
    await waitFor(() => {
      const flashed = flashedRow()
      expect(flashed).toHaveAttribute('aria-label', 'datanet 5 — Industrial task videos')
      expect(document.activeElement).toBe(flashed)
    })
    // Focusable, but NOT a tab stop: landing here must not add one stop per datanet for a
    // keyboard operator.
    expect(flashedRow()).toHaveAttribute('tabindex', '-1')
  })

  it('takes "adjust vote shares" to the Datanets tab with NO row focused', async () => {
    await openLeaderboard()

    await userEvent.click(screen.getByRole('button', { name: /adjust vote shares/ }))

    expect(await screen.findByRole('heading', { name: 'Datanets' })).toBeInTheDocument()
    expect(document.querySelectorAll('.dn-row').length).toBe(2) // every datanet, none singled out
    expect(flashedRow()).toBeNull()
  })

  it('does not re-scroll when the operator returns to the tab later', async () => {
    await openLeaderboard()
    await userEvent.click(screen.getByRole('button', { name: /Industrial task videos/ }))
    await waitFor(() => expect(flashedRow()).not.toBeNull())

    // Home, then back to Datanets by hand: the click-through is a spent intent, not tab state.
    await userEvent.click(screen.getByRole('tab', { name: /Home/ }))
    await userEvent.click(screen.getByRole('tab', { name: /Datanets/ }))

    await screen.findByRole('heading', { name: 'Datanets' })
    expect(flashedRow()).toBeNull()
  })
})
