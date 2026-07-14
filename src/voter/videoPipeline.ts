// src/voter/videoPipeline.ts — the single owner of video-pod handling.
//
// A video pod's lifecycle used to be spread across five modules (detection in the
// wiring's pod loop, the per-cycle budget as a wiring closure, model re-resolution as
// an isVideo flag on resolveScoringModel, ingest+cleanup in voter/score.ts, and the
// panel bypass keying off pod.mediaUrl). This module concentrates all of it behind a
// small interface:
//
//   isVideoPod(pod)          — the ONE definition of "this pod is a video" (marked).
//   detectAndMark(pod)       — probe Content-Type (Drive-aware), mark the pod for the
//                              video path within the per-cycle budget. true ⇒ the pod is
//                              a detected video and MUST NOT be text-fetched (marked when
//                              under budget; left unmarked and skipped when over).
//   beginCycle()             — re-arm the per-CYCLE budget (called by the cycle's
//                              activity.beginCycle, right after startCycle).
//   scoreVideoPod(...)       — resolve the Gemini model, ingest the clip, run the
//                              caller's generate step, then clean up. The ordering
//                              constraint (delete the uploaded file only AFTER the model
//                              has read the fileData URI — also on a scoring throw) is
//                              an internal invariant of this module.
import type { FilePart, LanguageModel } from 'ai'
import type { VoterPod } from './types.js'
import { resolveModel, type LlmProvider } from '../llm/model.js'
import type { ModelResolver, ScoringModelResult } from '../llm/resolveScoringModel.js'
import { detectContentType, isVideoType, isGenericBinaryType, type ContentTypeInfo } from '../llm/contentType.js'
import { resolveDriveUrl } from '../llm/driveResolve.js'
import { ingestVideo } from '../llm/videoIngest.js'

/** Native video (motion + audio) only works via @ai-sdk/google. See spec §"Model-capability finding". */
export const VIDEO_DEFAULT_PROVIDER: LlmProvider = 'google'
export const VIDEO_DEFAULT_MODEL = 'gemini-3.1-pro-preview'

/** True iff the pod was marked for the video path (detectAndMark set mediaUrl). The one
 *  place "is a video pod" is defined — the panel bypass and the scorer branch key off it. */
export function isVideoPod(pod: VoterPod): boolean {
  return !!pod.mediaUrl
}

export interface VideoPipelineDeps {
  /** provider → apiKey, from buildProviderKeyRegistry. The google key drives both the
   *  Gemini default resolution and the Files-API ingest. */
  registry: Map<LlmProvider, string>
  /** Model resolver seam — defaults to the plain resolveModel; index.ts injects an
   *  oauth-aware resolver, threaded here so video resolution honors it too. */
  resolveModel?: ModelResolver
  /** Cost/latency cap: at most this many video pods are marked (and thus scored as
   *  video) per cycle, across ALL datanets. Default 4. */
  videoPodsPerCycle?: number
  /** Content-Type probe; defaults to detectContentType. Injectable (wiring io seam / tests). */
  detectType?: (url: string) => Promise<ContentTypeInfo | null>
  /** Ingest seam; defaults to ingestVideo. Injectable so the cleanup-ordering invariant
   *  is testable without the network. */
  ingest?: typeof ingestVideo
}

export interface VideoPipeline {
  /** Re-arm the per-CYCLE video budget. The budget is global per cycle (not per datanet):
   *  detectAndMark runs once per datanet, so a per-call counter would let
   *  `videoPodsPerCycle × datanets` videos through. */
  beginCycle(): void
  /** Probe the given pods' Content-Types concurrently (bounded pool) and cache the
   *  results for this cycle, so the caller's SERIAL detectAndMark loop hits the cache
   *  instead of the network. Detection latency drops from sum-of-probes to
   *  ~(N / pool) × slowest probe, while budget MARKING stays in the caller's stable
   *  pod order — which pods get the video slots is never race-dependent (issue #59).
   *  Never throws; a failed probe is cached as null (text path). */
  prefetch(pods: VoterPod[]): Promise<void>
  /** Probe the pod's url (Drive share links are rewritten to direct downloads first) and,
   *  when it is a video, mark it (mediaUrl/mediaType/contentLength) within the budget.
   *  Returns true for ANY detected video — marked or over-budget — because a detected
   *  video must never be text-fetched (binary sliced into a description = junk votes);
   *  over the cap it is left unmarked and skipped this cycle (retried next cycle).
   *  false ⇒ not a video (or undetectable): the caller's text path applies. */
  detectAndMark(pod: VoterPod): Promise<boolean>
  /** Score a marked video pod: resolve the Gemini model (the datanet's override must be
   *  google, else the built-in Gemini default), ingest the clip to a FilePart, run the
   *  caller's generate step on the resolved model, and clean up the uploaded file only
   *  AFTER generate settles (also on a throw). Any skip reason THROWS so selectVotes'
   *  per-pod try/catch records it (fail-closed, never aborts the cycle). */
  scoreVideoPod<T>(
    pod: VoterPod,
    policyModel: { provider: LlmProvider; model: string } | undefined,
    generate: (model: LanguageModel, part: FilePart) => Promise<T>,
  ): Promise<T>
}

/** What the vote scorer needs to score a video pod: the pipeline plus the datanet's
 *  optional { provider, model } override (config.datanets[id].model — must be google to
 *  score video). Threaded by the wiring into createLlmScorer as `opts.video`. */
export interface VideoScoreCtx {
  pipeline: VideoPipeline
  policyModel?: { provider: LlmProvider; model: string }
}

/** Per-pod video scoring model resolution, owned by the pipeline (datanet-level TEXT
 *  resolution lives in llm/resolveScoringModel.ts and knows nothing about video):
 *  1) explicit override → must be google (a video pod can't be scored on a text model);
 *  2) no override → the built-in Gemini video default. Skip-with-reason otherwise. */
function resolveVideoScoringModel(
  policyModel: { provider: LlmProvider; model: string } | undefined,
  registry: Map<LlmProvider, string>,
  resolve: ModelResolver,
): ScoringModelResult {
  if (policyModel) {
    if (policyModel.provider !== 'google') {
      return { skip: `video pod needs a Gemini model; this datanet is set to ${policyModel.provider}/${policyModel.model}` }
    }
    const key = registry.get(policyModel.provider)
    if (!key) return { skip: `no API key for ${policyModel.provider} (this datanet is set to ${policyModel.provider}/${policyModel.model})` }
    return { model: resolve(policyModel.provider, key, policyModel.model) }
  }
  const key = registry.get(VIDEO_DEFAULT_PROVIDER)
  if (!key) return { skip: 'video scoring needs a Google API key (set LLM_KEY_GOOGLE)' }
  return { model: resolve(VIDEO_DEFAULT_PROVIDER, key, VIDEO_DEFAULT_MODEL) }
}

export function createVideoPipeline(deps: VideoPipelineDeps): VideoPipeline {
  const detectType = deps.detectType ?? detectContentType
  const ingest = deps.ingest ?? ingestVideo
  const resolve = deps.resolveModel ?? resolveModel
  const videoCap = deps.videoPodsPerCycle ?? 4
  let videoBudget = videoCap
  // Per-cycle probe memo: prefetch fills it concurrently, detectAndMark reads it in the
  // caller's serial loop. Keyed by the RESOLVED media url. Cleared each cycle so a host
  // whose Content-Type changes isn't pinned to a stale verdict.
  let probeCache = new Map<string, ContentTypeInfo | null>()
  const DETECT_POOL = 8

  const probe = async (mediaSrc: string): Promise<ContentTypeInfo | null> => {
    if (probeCache.has(mediaSrc)) return probeCache.get(mediaSrc) ?? null
    let info: ContentTypeInfo | null = null
    try { info = await detectType(mediaSrc) } catch { info = null }
    probeCache.set(mediaSrc, info)
    return info
  }

  return {
    beginCycle: () => { videoBudget = videoCap; probeCache = new Map() },

    async prefetch(pods: VoterPod[]): Promise<void> {
      const urls = [...new Set(pods.filter((p) => p.url).map((p) => resolveDriveUrl(p.url!)))]
      let next = 0
      const worker = async (): Promise<void> => {
        while (next < urls.length) await probe(urls[next++])
      }
      await Promise.all(Array.from({ length: Math.min(DETECT_POOL, urls.length) }, worker))
    },

    async detectAndMark(pod: VoterPod): Promise<boolean> {
      if (!pod.url) return false
      // A Google Drive viewer/share link (drive.google.com/file/d/<ID>/view) serves an
      // HTML shell, not bytes — probing it would see text/html and the pod would be
      // text-fetched (model scores the page chrome, not the video). Rewrite it to a
      // direct-download URL FIRST so the probe sees video/* and ingest can fetch it.
      // Non-Drive URLs pass through unchanged.
      const mediaSrc = resolveDriveUrl(pod.url)
      const resolvedFromDrive = mediaSrc !== pod.url
      const info: ContentTypeInfo | null = await probe(mediaSrc)
      // video/* routes to the Gemini path. A Drive-resolved URL whose download endpoint
      // reports a generic binary type (application/octet-stream — common for Drive file
      // downloads) is also treated as the clip: we only rewrite Drive links, and a binary
      // body on a video datanet IS the video. Gemini needs a concrete video mime to ingest,
      // so a coerced type defaults to video/mp4 when detection didn't give a video/* type.
      const isVideo = info && (isVideoType(info.mediaType) || (resolvedFromDrive && isGenericBinaryType(info.mediaType)))
      if (!info || !isVideo) return false
      if (videoBudget > 0) {
        pod.mediaUrl = mediaSrc
        pod.mediaType = isVideoType(info.mediaType) ? info.mediaType : 'video/mp4'
        if (info.contentLength !== null) pod.contentLength = info.contentLength
        videoBudget--
      }
      return true
    },

    async scoreVideoPod<T>(
      pod: VoterPod,
      policyModel: { provider: LlmProvider; model: string } | undefined,
      generate: (model: LanguageModel, part: FilePart) => Promise<T>,
    ): Promise<T> {
      if (!pod.mediaUrl) throw new Error('not a video pod (no mediaUrl) — detectAndMark marks video pods')
      // Resolve the model BEFORE ingesting: a resolution skip must not download bytes.
      const resolved = resolveVideoScoringModel(policyModel, deps.registry, resolve)
      if ('skip' in resolved) throw new Error(resolved.skip)
      // Ingest (size-branched) → FilePart. A skip reason THROWS so selectVotes' per-pod
      // try/catch records it. contentLength (from detection, threaded onto the pod) lets
      // ingest skip a known-oversize video BEFORE downloading it (null ⇒ fetch + re-measure).
      const ingested = await ingest({
        url: pod.mediaUrl,
        mediaType: pod.mediaType ?? 'video/mp4',
        contentLength: pod.contentLength ?? null,
        googleKey: deps.registry.get('google'),
      })
      if ('skip' in ingested) throw new Error(ingested.skip)
      // INVARIANT: the Files-API path returns a cleanup that deletes the uploaded file.
      // Delete it AFTER generate has read the fileData URI (deleting before would 404 the
      // request) — run it in finally so a scoring throw still cleans up the remote file.
      try {
        return await generate(resolved.model, ingested.part)
      } finally {
        await ingested.cleanup?.()
      }
    },
  }
}
