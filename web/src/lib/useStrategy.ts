import { useCallback, useEffect, useState } from 'react'
import type { DatanetEntry, StrategyConfig } from '../api'
import { saveStrategy } from '../api'
import { configDiff } from './configDiff'

// candidate = the full config we will save; the Strategy grid AND the Chat tab both
// mutate THIS one object, never the server. baseline = last persisted state; the diff
// is measured against it and rebased only on a successful Save. Lifting this into a
// shared hook lets the chat (its own tab) propose a config that the operator then
// reviews in the Strategy tab and saves — one candidate, two surfaces.
export type Candidate = StrategyConfig & { datanets: Record<string, DatanetEntry> }

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

export interface Strategy {
  candidate: Candidate | null
  diff: string[]
  saveMsg: string
  proposalLoaded: boolean
  edit: (fn: (c: Candidate) => void) => void
  /** replace the whole candidate (a chat proposal) and flag it for review */
  applyProposal: (c: Candidate) => void
  save: () => Promise<void>
}

export function useStrategy(config: StrategyConfig | undefined): Strategy {
  const [candidate, setCandidate] = useState<Candidate | null>(null)
  const [baseline, setBaseline] = useState<Candidate | null>(null)
  const [saveMsg, setSaveMsg] = useState('')
  const [proposalLoaded, setProposalLoaded] = useState(false)

  // Initialize ONCE from the first config that has datanets; later polls must not
  // clobber in-flight edits.
  useEffect(() => {
    if (candidate === null && config && config.datanets) {
      const c = clone(config) as Candidate
      delete c.claimEmissions // safeConfig omits schema-managed fields; keep only what we round-trip
      setCandidate(c)
      setBaseline(clone(c))
    }
  }, [config, candidate])

  const edit = useCallback((fn: (c: Candidate) => void) => {
    setCandidate((prev) => {
      if (!prev) return prev
      const next = clone(prev)
      fn(next)
      return next
    })
  }, [])

  const applyProposal = useCallback((c: Candidate) => {
    setCandidate(c)
    setProposalLoaded(true)
  }, [])

  const save = useCallback(async () => {
    if (!candidate) return
    setSaveMsg('saving…')
    const res = await saveStrategy(candidate)
    setSaveMsg(res.ok ? 'saved — applies next cycle' : `error: ${res.error}`)
    if (res.ok) {
      setProposalLoaded(false)
      setBaseline(clone(candidate)) // server now holds this → diff reads "no changes"
    }
  }, [candidate])

  const diff = baseline && candidate ? configDiff(baseline, candidate) : []
  return { candidate, diff, saveMsg, proposalLoaded, edit, applyProposal, save }
}
