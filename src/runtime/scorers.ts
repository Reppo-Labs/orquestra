// src/runtime/scorers.ts
// The Scorers collaborator: per-datanet vote scorer resolution (with the build-once
// scorer cache) and the mint candidate scorer. Extracted from wiring.ts so the cache
// key and model routing are unit-testable in isolation (scorers.test.ts) — no CLI, no
// SDK round-trip; the model resolver is an injectable seam.
import type { LanguageModel } from 'ai'
import type { StrategyConfig } from '../config/schema.js'
import type { Scorers } from './cycle.js'
import type { CandidateScorer } from '../adapter/types.js'
import type { PodScorer } from '../voter/types.js'
import { createLlmScorer } from '../voter/score.js'
import type { VideoPipeline } from '../voter/videoPipeline.js'
import { createPanelPodScorer, createPanelCandidateScorer } from '../panel/scorers.js'
import { resolveScoringModel, type ModelResolver } from '../llm/resolveScoringModel.js'
import { effectiveDefault } from '../llm/effectiveDefault.js'
import { resolveModel } from '../llm/model.js'
import type { LlmProvider } from '../llm/model.js'
import { candidateScoreInput } from '../minter/score.js'
import { buildLessonsBlock } from '../learn/inject.js'

/** What scorer construction needs from the wiring. `config` is read LIVE off this
 *  object at every call (buildTick mutates `w.config` on hot-reload), so pass the
 *  mutable wiring object itself — CycleWiring satisfies this structurally. */
export interface ScorerEnv {
  dataDir: string
  config: StrategyConfig
  /** provider → apiKey, built once at startup from env (src/llm/registry.ts). */
  providerKeyRegistry: Map<LlmProvider, string>
  /** Model resolver seam. Defaults to the plain resolveModel; index.ts injects an
   *  oauth-aware resolver so `anthropic-oauth` resolves with a fresh Bearer token. */
  resolveModel?: ModelResolver
  /** Node default provider/model — used when a datanet has no `model` override. */
  defaultProvider: LlmProvider
  defaultModel: string
}

/** The LIVE node-default model: dashboard-selected `config.defaultModel` when its provider is
 *  keyed, else the env default (`w.defaultProvider`/`w.defaultModel`). Read from w.config each
 *  call so a dashboard default change takes effect on the next cycle (hot-reload), mirroring the
 *  vote scorer + chat. null when even the effective default has no key — callers that can't
 *  proceed without a model (mint scorer, reflection) skip/throw, matching their existing
 *  no-model behavior. Keys are env-only (registry); never read from config. */
export function effectiveDefaultModel(w: ScorerEnv): LanguageModel | null {
  const eff = effectiveDefault({
    configDefault: w.config.defaultModel,
    registry: w.providerKeyRegistry,
    envProvider: w.defaultProvider,
    envModel: w.defaultModel,
  })
  return eff.key ? (w.resolveModel ?? resolveModel)(eff.provider, eff.key, eff.model) : null
}

/** Build the Scorers collaborator the cycle consumes. `video` is the wiring's
 *  VideoPodPipeline — the scorer hands a video pod to it for per-pod Gemini
 *  resolution + ingest + cleanup. Omitted (tests) ⇒ video pods throw a recorded skip. */
export function buildScorers(w: ScorerEnv, video?: VideoPipeline): Scorers {
  // The operator brief is config.notes, read live so dashboard edits hot-reload
  // (buildTick swaps w.config each cycle). Used by the screen scorer and the panel judge.
  const liveBrief = (): string => w.config.notes
  // Per-datanet learned-lessons block for the judge, read live from the DB so a new
  // reflection or an operator veto/disable takes effect on the next decision.
  const liveLessons = (id: string): string => {
    try { return buildLessonsBlock(w.dataDir, id) } catch { return '' }
  }
  // Screen scorer + panel decorators are built ONCE. They read the brief and the
  // deliberation settings live (via getters / liveBrief) so a hot-reload of either
  // takes effect on the next decision without rebuilding anything.
  const getDeliberation = () => w.config.deliberation

  // Per-datanet vote scorer: resolve THIS datanet's model (its `model` override, else the
  // node default) against the env key registry, then wrap in the panel exactly as before.
  // A skip (no key for the chosen provider) is returned straight to the cycle, which
  // records it per-datanet. The datanet-level resolution is TEXT-only by construction;
  // video pods (detected + marked by the VideoPodPipeline in getPodsAndFilter) are
  // re-resolved per pod to a Gemini model inside the pipeline via opts.video.
  //
  // Build-once cache: datanets sharing a resolved provider:model reuse one scorer
  // (per datanet per cycle was rebuilding it). Safe across hot-reload — the scorer reads
  // brief/deliberation/lessons live via getters (getLessons takes datanetId at call time),
  // so the cached object stays correct. Skips are not cached (cheap, no scorer built).
  const scorerCache = new Map<string, PodScorer>()
  const voteScorerFor = (datanetId: string): { scorer: PodScorer } | { skip: string } => {
    const policyModel = (w.config.datanets[datanetId] as { model?: { provider: LlmProvider; model: string } } | undefined)?.model
    // The node default is the dashboard-selected config.defaultModel when its provider is
    // keyed, else the env default (w.defaultProvider/w.defaultModel). Read live from w.config
    // (hot-reloaded each cycle), so a dashboard default change takes effect on the next cycle.
    const eff = effectiveDefault({
      configDefault: w.config.defaultModel,
      registry: w.providerKeyRegistry,
      envProvider: w.defaultProvider,
      envModel: w.defaultModel,
    })
    const resolved = resolveScoringModel({
      policyModel,
      registry: w.providerKeyRegistry, defaultProvider: eff.provider, defaultModel: eff.model,
    }, w.resolveModel ?? resolveModel)
    if ('skip' in resolved) return { skip: resolved.skip }
    // Key by the effective provider:model (the datanet-level resolution is always the
    // text model; video pods re-resolve per pod inside the pipeline): identical
    // resolutions yield an identical scorer, so one build serves every such datanet.
    const cacheKey = policyModel ? `${policyModel.provider}:${policyModel.model}` : `${eff.provider}:${eff.model}`
    let scorer = scorerCache.get(cacheKey)
    if (!scorer) {
      // opts.video routes a video pod to the pipeline (a video pod can't be scored on
      // this datanet's text model). policyModel is fixed per cacheKey, so binding it into
      // the cached scorer is correct (datanets sharing a key share an identical
      // policyModel). Text pods ignore opts.video and score on resolved.model.
      const screen = createLlmScorer(resolved.model, {
        brief: liveBrief,
        ...(video ? { video: { pipeline: video, policyModel } } : {}),
      })
      scorer = createPanelPodScorer(screen, { model: resolved.model, getDeliberation, getBrief: liveBrief, getLessons: liveLessons })
      scorerCache.set(cacheKey, scorer)
    }
    return { scorer }
  }

  // Mint path is unchanged by per-datanet voting overrides (spec: override scopes to the
  // voting scorer only). Score the DATASET (not just the summary line) on the node default
  // model — otherwise every candidate scores low and nothing mints (src/minter/score.ts).
  // The model is the LIVE effective default (config.defaultModel, hot-reloaded), resolved at
  // scoreCandidate-call time — NOT captured at startup. A missing key (eff.key === '') THROWS,
  // which selectMints catches per-candidate and records as a skip (parity with a scoring
  // failure); it never aborts the datanet's mint batch. The screen scorer + panel are rebuilt
  // per call against the live model — cheap (no SDK round-trip until scorePod/runPanel runs),
  // and necessary because both capture `model` at construction.
  const candidateScorer: CandidateScorer = {
    scoreCandidate: (cand, rub) => {
      const model = effectiveDefaultModel(w)
      if (!model) throw new Error('no API key for the node default provider — mint candidate not scored')
      // Mint prompts never render the vote-economics block (yield is a where-to-vote
      // signal): `rub` is a MintRubric, which structurally cannot carry
      // economics.currentYield (rubric/types.ts) — the invariant is a compile-time
      // guarantee, no defensive strip needed at this boundary.
      const mintScreenScorer = createLlmScorer(model, { brief: liveBrief })
      const candidateBase: CandidateScorer = {
        scoreCandidate: (c, r) => {
          const { name, description } = candidateScoreInput(c)
          return mintScreenScorer.scorePod({ podId: c.canonicalKey, validityEpoch: '', name, description }, r)
        },
      }
      const panel = createPanelCandidateScorer(candidateBase, { model, getDeliberation, getBrief: liveBrief, getLessons: liveLessons })
      return panel.scoreCandidate(cand, rub)
    },
  }

  return { voteScorerFor, candidateScorer }
}
