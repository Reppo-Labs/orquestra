// src/onboarding/interview.ts
import type { Prompter, OnboardingAnswers, DatanetChoice } from './types.js'
import type { StrictnessLevel } from '../config/schema.js'

const yes = (s: string): boolean => /^(y|yes|true|1)$/i.test(s.trim())
const STRICTNESS: StrictnessLevel[] = ['conservative', 'balanced', 'aggressive']
const asStrictness = (s: string): StrictnessLevel =>
  (STRICTNESS as string[]).includes(s.trim()) ? (s.trim() as StrictnessLevel) : 'balanced'
const numOr = (s: string, def: number): number => {
  const n = Number(s)
  return Number.isFinite(n) ? n : def
}

/** Drive the first-run interview over an injected Prompter. All I/O is the
 *  Prompter's; this returns structured answers for buildStrategyConfig. */
export async function runOnboarding(p: Prompter): Promise<OnboardingAnswers> {
  p.info('Orquestra setup — configure how your node votes, mints, and stakes.')

  const idsRaw = await p.ask('Which datanet ids do you want to participate in? (comma-separated)', '9')
  const ids = idsRaw.split(',').map((s) => s.trim()).filter(Boolean)

  const datanets: DatanetChoice[] = []
  for (const id of ids) {
    const vote = yes(await p.ask(`Datanet ${id}: vote on pods? (Y/n)`, 'y'))
    const mint = yes(await p.ask(`Datanet ${id}: mint pods? (y/N)`, 'n'))
    const strictness = asStrictness(await p.ask(`Datanet ${id}: strictness (conservative/balanced/aggressive)`, 'balanced'))
    const adapter = (await p.ask(`Datanet ${id}: mint adapter (blank for none)`, '')).trim() || undefined
    datanets.push({ id, vote, mint, strictness, adapter })
  }

  const lockReppo = numOr(await p.ask('How much REPPO to lock (veREPPO voting power)?', '0'), 0)
  const lockDurationDays = numOr(await p.ask('Lock duration in days?', '30'), 30)
  const voteGasEthMax = numOr(await p.ask('Max ETH gas for votes (over the horizon)?', '0.02'), 0.02)
  const voteRateMaxPerCycle = numOr(await p.ask('Max votes per cycle?', '25'), 25)
  const mintReppoMax = numOr(await p.ask('Max REPPO to spend on mints (over the horizon)?', '0'), 0)
  const mintGasEthMax = numOr(await p.ask('Max ETH gas for mints (over the horizon)?', '0.05'), 0.05)
  const horizonDays = numOr(await p.ask('Budget horizon in days?', '30'), 30)
  const cadenceHours = numOr(await p.ask('How often should the node run, in hours?', '6'), 6)
  const notes = (await p.ask('Any freeform strategy notes? (optional)', '')).trim()

  return {
    datanets, lockReppo, lockDurationDays, voteGasEthMax, voteRateMaxPerCycle,
    mintReppoMax, mintGasEthMax, horizonDays, cadenceHours, notes,
  }
}
