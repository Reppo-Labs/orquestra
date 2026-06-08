// src/onboarding/types.ts
import type { StrictnessLevel } from '../config/schema.js'

export interface AdapterParams {
  focus?: string
  angle?: string
  topN?: number
  minImportance?: number
}

export interface DatanetChoice {
  id: string
  vote: boolean
  mint: boolean
  strictness: StrictnessLevel
  adapter?: string
  adapterParams?: AdapterParams
}

export interface OnboardingAnswers {
  datanets: DatanetChoice[]
  lockReppo: number
  lockDurationDays: number
  voteGasEthMax: number
  voteRateMaxPerCycle: number
  mintReppoMax: number
  mintGasEthMax: number
  horizonDays: number
  cadenceHours: number
  notes: string
}

/** Abstracts the interview I/O. Production: interactive/LLM terminal; tests: scripted. */
export interface Prompter {
  /** Ask a question; returns the user's answer (or the default if blank). */
  ask(question: string, def?: string): Promise<string>
  /** Print informational text (recommendations, summaries). */
  info(message: string): void
}
