import { useCallback, useEffect, useRef, useState } from 'react'
import type { DatanetEntry, StrategyConfig } from '../api'
import { fetchConfig, saveStrategy } from '../api'
import { configDiff } from './configDiff'
import { deepEqual, merge3 } from './merge3'

// candidate = the full config we will save; the Datanets grid AND the Chat tab both
// mutate THIS one object, never the server. baseline = the config the SERVER holds (as far
// as we know); the diff is measured against it and it is rebased on every poll, so the
// candidate never drifts into a stale snapshot of a config other surfaces are also writing.
export type Candidate = StrategyConfig & { datanets: Record<string, DatanetEntry> }

/** Every write returns its outcome. `editAndSave` is awaited by one-click remedy buttons
 *  between setBusy(true)/setBusy(false); a void return let every one of them report
 *  "applied — next cycle" over a 400, a 500, or a node that was not even reachable. */
export interface SaveResult { ok: boolean; error?: string }

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

const asCandidate = (c: StrategyConfig): Candidate =>
  ({ ...clone(c), datanets: clone(c.datanets ?? {}) })

export interface Strategy {
  candidate: Candidate | null
  diff: string[]
  saveMsg: string
  proposalLoaded: boolean
  edit: (fn: (c: Candidate) => void) => void
  /** Mutate the config the node holds RIGHT NOW, and persist it. The one-click remedies
   *  ("turn this datanet off", "stop minting there") must not leave a dirty candidate the
   *  operator then has to remember to save — the button says it acts, so it acts.
   *
   *  It re-reads /api/config first and applies `fn` to THAT, not to the in-memory candidate:
   *   - the candidate may be minutes stale (a learning proposal, a pause, another tab), and
   *     a whole-config POST built on it would silently revert those writes;
   *   - the candidate may carry unrelated, half-finished edits (a mint cap typed as "5" on
   *     the way to "500") which a button labelled "stop minting" must never commit.
   *  Returns the outcome — callers MUST NOT assume success. */
  editAndSave: (fn: (c: Candidate) => void) => Promise<SaveResult>
  /** replace the whole candidate (a chat proposal) and flag it for review */
  applyProposal: (c: Candidate) => void
  /** Reflect a pause the SERVER already applied (POST /api/pause writes the config itself).
   *  Updates candidate AND baseline: candidate, so a later Save cannot re-persist the stale
   *  flag and silently un-pause the node; baseline, so the pause never masquerades as an
   *  unsaved change in the diff line. */
  syncPaused: (paused: boolean) => void
  save: () => Promise<SaveResult>
}

export function useStrategy(config: StrategyConfig | undefined): Strategy {
  const [candidate, setCandidate] = useState<Candidate | null>(null)
  const [baseline, setBaseline] = useState<Candidate | null>(null)
  const [saveMsg, setSaveMsg] = useState('')
  const [proposalLoaded, setProposalLoaded] = useState(false)
  // Read inside callbacks that must not re-create on every keystroke.
  const stateRef = useRef<{ candidate: Candidate | null; baseline: Candidate | null }>({ candidate: null, baseline: null })
  stateRef.current = { candidate, baseline }

  // Initialize from the first config that has datanets, then REBASE on every later poll.
  //
  // The old code initialized once and ignored every subsequent poll "to protect in-flight
  // edits". That protected the edits and lost everything else: /api/strategy is a full
  // replace, so a Save (including the auto-saving one-click remedies) re-persisted a config
  // from page load, reverting whatever the node had written since. The three-way merge keeps
  // both — the operator's untouched fields follow the server, their edited fields do not.
  useEffect(() => {
    if (!config || !config.datanets) return
    const live = asCandidate(config)
    setCandidate((prev) => {
      const base = stateRef.current.baseline
      if (prev === null || base === null) return live
      if (deepEqual(base, live)) return prev // server unchanged — nothing to rebase
      return merge3(base, prev, live) as Candidate
    })
    setBaseline(live)
  }, [config])

  const edit = useCallback((fn: (c: Candidate) => void) => {
    setCandidate((prev) => {
      if (!prev) return prev
      const next = clone(prev)
      fn(next)
      return next
    })
  }, [])

  const applyProposal = useCallback((c: Candidate) => {
    setCandidate((prev) => {
      const next = clone(c)
      // PAUSE IS NOT THE ASSISTANT'S TO CHANGE. The server parses the LLM's proposal through
      // the schema, where `paused` defaults to FALSE — so a proposal that simply doesn't
      // mention pause (the chat's system prompt never asks it to) comes back un-paused, the
      // paused banner vanishes, and Save resumes a node the operator deliberately stopped.
      // The kill switch only ever moves through PauseControl.
      const paused = prev?.paused ?? stateRef.current.baseline?.paused
      if (paused === undefined) delete next.paused
      else next.paused = paused
      return next
    })
    setProposalLoaded(true)
  }, [])

  // Persist an explicit object rather than reading `candidate` — the one-click remedies
  // compute the next config and save it in the same tick, before React has re-rendered.
  const persist = useCallback(async (next: Candidate): Promise<SaveResult> => {
    setSaveMsg('saving…')
    const res = await saveStrategy(next) // never rejects; a network failure is { ok: false }
    setSaveMsg(res.ok ? 'saved — applies next cycle' : `error: ${res.error}`)
    if (res.ok) {
      setProposalLoaded(false)
      setBaseline(clone(next)) // the server now holds this
    }
    return res
  }, [])

  const save = useCallback(async (): Promise<SaveResult> => {
    const c = stateRef.current.candidate
    if (!c) return { ok: false, error: 'no strategy loaded' }
    return persist(c)
  }, [persist])

  const editAndSave = useCallback(async (fn: (c: Candidate) => void): Promise<SaveResult> => {
    setSaveMsg('saving…')
    // Read the LIVE config and mutate THAT — never the in-memory candidate. See the doc on
    // the interface: this is what stops a one-click remedy clobbering a concurrent write or
    // smuggling the operator's unrelated unsaved edits into the node's live config.
    const live = await fetchConfig()
    if (!live || !live.datanets) {
      const error = 'could not reach the node — nothing was changed'
      setSaveMsg(`error: ${error}`)
      return { ok: false, error }
    }
    const next = asCandidate(live)
    fn(next)
    const res = await saveStrategy(next)
    setSaveMsg(res.ok ? 'saved — applies next cycle' : `error: ${res.error}`)
    if (!res.ok) return res

    // The server now holds `next`. Rebase the candidate onto it so the operator's OTHER
    // unsaved edits survive and still show in the diff line.
    const base = stateRef.current.baseline
    setCandidate((prev) => (prev && base ? (merge3(base, prev, next) as Candidate) : clone(next)))
    setBaseline(clone(next))
    return res
  }, [])

  const syncPaused = useCallback((paused: boolean) => {
    // The server already wrote this. Move BOTH sides so the diff stays quiet and a later
    // Save re-sends the true value.
    setCandidate((prev) => (prev ? { ...prev, paused } : prev))
    setBaseline((prev) => (prev ? { ...prev, paused } : prev))
  }, [])

  const diff = baseline && candidate ? configDiff(baseline, candidate) : []
  return { candidate, diff, saveMsg, proposalLoaded, edit, editAndSave, applyProposal, syncPaused, save }
}
