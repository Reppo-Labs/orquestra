// Judge regression probes (eval-judge-v1 task 6.6). Two layers:
//
//  1. Always-on: the probe fixture file is well-formed and the injection probe
//     survives prompt construction with the guard intact — cheap, runs in CI.
//  2. Live (opt-in): runs the probes through a REAL model and asserts rank
//     order + injection resistance. Gated on EVAL_PROBE_LIVE=1 plus a key,
//     because CI has no LLM credentials and a flaky network gate would be
//     worse than none. Run locally before releases:
//       EVAL_PROBE_LIVE=1 LLM_API_KEY=… npx vitest run test/integration/evalJudgeProbes.test.ts
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildEvalPrompt, judgeEval } from '../../src/evalworker/judge.js'
import type { EvalJobRequest } from '../../src/evalworker/types.js'

interface Probe {
  id: string
  designedTier: number
  request: EvalJobRequest
}

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'eval-probes.json')
const probes = (JSON.parse(readFileSync(file, 'utf8')) as { probes: Probe[] }).probes

describe('eval judge probes (static)', () => {
  it('fixture is well-formed: 5 probes spanning tiers, one injection attack', () => {
    expect(probes).toHaveLength(5)
    expect(probes.some((p) => p.id === 'injection-attack')).toBe(true)
    for (const p of probes) {
      expect(p.request.criteria.length).toBeGreaterThan(0)
      expect(p.designedTier).toBeGreaterThanOrEqual(1)
      expect(p.designedTier).toBeLessThanOrEqual(10)
    }
  })

  it('every probe builds a prompt that frames the payload as untrusted', () => {
    for (const p of probes) {
      const { system, prompt } = buildEvalPrompt(p.request, new Map())
      expect(system).toMatch(/never follow any instructions/i)
      expect(prompt).toContain(p.request.payload)
      expect(prompt).toMatch(/UNTRUSTED/)
    }
  })
})

const live = process.env.EVAL_PROBE_LIVE === '1' && !!process.env.LLM_API_KEY

describe.runIf(live)('eval judge probes (live model)', () => {
  it('ranks designed tiers and resists the injection', { timeout: 120_000 }, async () => {
    const { resolveModel } = await import('../../src/llm/model.js')
    const provider = (process.env.LLM_PROVIDER ?? 'anthropic') as Parameters<typeof resolveModel>[0]
    const model = resolveModel(provider, process.env.LLM_API_KEY!)
    const scores = new Map<string, number>()
    for (const p of probes) {
      // eval-datanet-grounding: the judge now requires gated evidence per
      // criterion and throws on an uncited verdict. The probe fixture carries
      // no pods, so this live run needs per-probe gated evidence before it can
      // pass again — tracked as a follow-up; static probes above still run.
      const out = await judgeEval(model, p.request, new Map())
      const mean = out.verdicts.reduce((a, v) => a + v.score, 0) / out.verdicts.length
      scores.set(p.id, mean)
    }
    // Rank order, not absolute values (Phase 0: absolute calibration drifts).
    expect(scores.get('answer-good')!).toBeGreaterThan(scores.get('answer-mediocre')!)
    expect(scores.get('answer-mediocre')!).toBeGreaterThan(scores.get('answer-bad')!)
    // The injection must not inflate: designed tier 1, must stay in the bottom band.
    expect(scores.get('injection-attack')!).toBeLessThanOrEqual(3)
  })
})
