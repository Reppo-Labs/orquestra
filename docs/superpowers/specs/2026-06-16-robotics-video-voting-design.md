# Per-datanet model selection + Gemini video voting — design

**Date:** 2026-06-16
**Status:** Approved (design); implementation pending
**Author:** Ana (with Claude Code)
**Repo:** orquestra

## Problem

Two gaps, one feature:

1. **Can't watch video.** The robotics datanet's pods are **videos** — a pod's `url`
   points to an attached video file — but scoring is **text-only**.
   `src/voter/score.ts:buildVotePrompt` (lines 19-29) builds plain `{system, prompt}`
   strings; `src/runtime/wiring.ts` (~lines 160-163) fetches `pod.url` as plain text
   (max 4000 chars). Point that at an `.mp4` → binary garbage. `src/llm/generate.ts`
   passes only strings to `generateObject`, never multimodal content parts.
2. **No per-datanet model control.** The node runs ONE global model
   (`LLM_PROVIDER` + `LLM_API_KEY` → `src/llm/model.ts:resolveModel`). The operator
   can't say "score the robotics datanet with Gemini, the others with virtuals/Claude."

This is **not robotics-specific**: the mechanism is "the operator picks a model per
datanet on the dashboard, and any pod with an attached video defaults to a Gemini
model." Robotics is the first datanet that needs it; the design adds no
datanet-specific branch.

## Model-capability finding (the crux)

"Watching video" depends on the model AND the transport:
- **Claude** (`anthropic`) — images, not video.
- **Gemini** (`google` → `gemini-3-pro`) via **`@ai-sdk/google`** — watches video
  **natively** (motion + temporal + audio) through the `inlineData`/`fileData` part +
  Files API. This is the only path that truly watches a clip.
- **OpenAI** — images only.
- **`virtuals` / `surplus`** — OpenAI-compatible gateways (`createOpenAI({ baseURL })`,
  POST `/chat/completions`). `virtuals` exposes a Gemini slug (`gemini-3-flash-preview`),
  but the OpenAI Chat Completions wire schema carries only `image_url` (images), with
  **no video content part** — so video can't go through virtuals regardless of which
  model it proxies. Native video needs `@ai-sdk/google` + a Google key.

## Decisions (settled during brainstorming)

1. **Per-datanet model selection is the primary mechanism.** Each datanet may be
   assigned a `{ provider, model }`; "video → Gemini" is a default within that
   mechanism, not a hardcoded special case (altitude: route, don't special-case).
2. **Native Gemini video** via `@ai-sdk/google` for video pods (motion matters for
   "did the robot complete the task"); not frame-sampling.
3. **Keys are env-only; the dashboard never holds secrets** (ADR 0002 — the dashboard
   is unauthenticated + localhost-bound). The dashboard picks provider+model from
   providers whose key is present in env; it cannot enter keys.
4. **Datanet-agnostic auto-default:** any votable pod whose `url` is `video/*`, on any
   datanet, defaults to a Gemini model. No datanet allow-list.
5. **Fail-closed, per-datanet isolation:** any failure (no key for the chosen
   provider, a video pod routed to a non-Gemini model, fetch/codec error, over-size,
   Gemini/Files-API error) **skips that pod with a recorded reason**; never aborts the
   cycle.

## Phase A — Per-datanet model selection (the mechanism)

### A1. Multi-provider key registry (env-only)
At startup, build `Map<LlmProvider, apiKey>` from per-provider env vars —
`LLM_KEY_ANTHROPIC`, `LLM_KEY_OPENAI`, `LLM_KEY_GOOGLE`, `LLM_KEY_VIRTUALS`,
`LLM_KEY_SURPLUS` — **plus** the existing `LLM_PROVIDER` + `LLM_API_KEY` as the
**default** provider and its key (back-compat: an operator who set only those keeps
working). `availableProviders` = the map's keys. Document the new vars in
`.env.example`. Keys are read from env only, never logged (`util/redact.ts`).

### A2. Config schema (`src/config/schema.ts`)
Each datanet policy gains an optional override:
```ts
model?: { provider: LlmProvider; model: string }   // absent ⇒ node default
```
Validated by Zod (provider ∈ the LlmProvider union; model a non-empty string).

### A3. Model resolution (`src/llm/` + `src/runtime/wiring.ts`)
A scorer is resolved **per datanet/pod**, not once globally. Resolution order when
scoring a pod:
1. Datanet has an explicit `model` → resolve it. If its provider has no key in the
   registry → **skip the pod, record reason**. If the pod is a **video** and the
   provider is not `google` → **skip the pod, record reason** ("video pod needs a
   Gemini model; this datanet is set to `<provider>/<model>`").
2. No explicit model + **video pod** → default to `google` / `gemini-3-pro`
   (if a Google key exists; else **skip**, "video scoring needs a Google API key").
3. No explicit model + text pod → the node default provider/model (today's behavior).

`resolveModel(provider, key, model)` already takes all three; the new work is the
registry lookup + the per-datanet/per-pod decision, threaded through `CycleDeps`.

### A4. Dashboard picker (`web/`, `src/dashboard/server.ts`)
- New read-only endpoint (e.g. `GET /api/models`) → `{ providers: [{ provider,
  hasKey: true, models: string[] }] }` for providers **with a key**. For the
  OpenAI-compatible gateways (`virtuals`/`surplus`) the model list may be fetched live
  (`GET <baseURL>/models`, like the node already can); for `anthropic`/`google`/`openai`
  a known-slug list seeded from `DEFAULT_MODEL`. The endpoint returns provider/model
  **names only — never keys**.
- `StrategyTab.tsx`: per-datanet **provider + model** control, populated from that
  endpoint (dropdown of available providers → their models; free-text model allowed
  since slugs drift). Writes `config.datanets[i].model`. No key field anywhere.

## Phase B — Gemini video ingest (makes a Gemini selection actually watch)

Model *selection* (Phase A) is separate from model *input modality*: picking `gemini`
does nothing unless the scorer can hand it the video.

### B1. Detect (per pod, auto)
In the pod-enrichment loop (`src/runtime/wiring.ts`), peek the `url`'s `Content-Type`
(HEAD, ranged-GET fallback): `video/*` → mark as a video pod (capture `mediaType` +
`Content-Length`) and apply the video resolution path (A3); else → unchanged text
enrichment + text path.

### B2. Ingest (size-branched)
For a video pod, fetch the bytes; branch on size (`Content-Length`, threshold
`VIDEO_INLINE_MAX_BYTES` ≈ 20 MB): **small** → inline base64 video content part in one
request; **large** → Gemini **Files API** (upload → poll `ACTIVE` → reference → delete
after). Hard cap `VIDEO_MAX_BYTES`: a larger pod is **skipped with a recorded reason**,
not fetched whole.

### B3. Multimodal scorer seam
- `src/voter/types.ts` — `VoterPod` gains `mediaUrl?: string` + `mediaType?: string`,
  distinct from the text `description`.
- `src/voter/score.ts:buildVotePrompt` — for a video pod, return **message parts**
  (`[rubric text, video content part, "score 1-10 strictly by the rubric"]`); text
  pods keep returning the string form. Keep `INJECTION_GUARD` + the operator-brief block.
- `src/llm/generate.ts:generateObjectWithRetry` — accept `messages`/`ContentPart[]`
  in addition to `prompt`; the string path is byte-for-byte unchanged.

## Failure, limits, security

- **Per-datanet isolation:** every failure above → skip the pod, record the reason
  (reuse the existing skip/record mechanism); never abort the cycle or other pods.
- **Cost/latency caps:** `VIDEO_MAX_BYTES` + a per-cycle cap on video pods scored. LLM
  spend is the operator's API bill, **not** the on-chain REPPO/gas budget — the ledger
  is untouched; caps bound the bill + cycle latency, recorded for dashboard visibility.
- **Secrets:** keys env-only, never persisted to `activity.db`/config, never returned
  by any endpoint, redacted in logs. `GET /api/models` exposes provider + model names
  and `hasKey` booleans only.

## Testing
- Key registry: env vars → available providers; default back-compat (`LLM_PROVIDER`/
  `LLM_API_KEY` alone still works).
- Resolution order: explicit override used; missing-key → skip; video+non-Gemini →
  skip; video+no-default-google → skip; text → node default. (table-driven)
- Config schema: `model` override parses + rejects an unknown provider.
- `/api/models`: lists only providers with keys; returns no secrets.
- Video: Content-Type routes video→video path; inline-vs-Files-API by size (mocked);
  `buildVotePrompt` builds message parts for video, string for text; skip-with-reason on
  over-size / fetch fail / Gemini error.
- Regression: existing text voter tests stay green.

## Open assumptions (confirm)
1. Typical clip **size/length** — sets `VIDEO_INLINE_MAX_BYTES` + Files-API frequency.
2. Operator can supply a **Google API key** (required for the video path).
3. Model-slug lists per provider drift; the dashboard allows free-text model entry so a
   new slug never requires a code change.

## Out of scope
- Frame-sampling / Claude-vision fallback (chosen path is Gemini-native; no-key →
  fail-closed skip).
- A robotics **adapter** for minting (voting needs none; this is scorer-input only).
- Per-token LLM **budget** enforcement in the ledger (LLM cost is the operator's API
  bill, bounded by the size/count caps).
- Per-datanet model override for **minting/panel** (this spec scopes the override to
  the **voting scorer**; minting/panel can extend the same `model` field later).
- Audio-only or non-video media.

## Phasing
Implementation = two plans, each shippable on its own:
- **Phase A** — per-datanet model selection + multi-provider env keys + dashboard
  picker. Useful immediately (route any datanet to any configured provider/model).
- **Phase B** — Gemini video detect + ingest + multimodal scorer seam. Depends on A
  (a datanet must be resolvable to `google`/Gemini) and delivers the robotics use case.
