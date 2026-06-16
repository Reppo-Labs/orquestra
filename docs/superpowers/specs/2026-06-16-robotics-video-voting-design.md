# Watch robotics videos for voting (Gemini-native) — design

**Date:** 2026-06-16
**Status:** Approved (design); implementation pending
**Author:** Ana (with Claude Code)
**Repo:** orquestra

## Problem

The robotics datanet's pods are **videos** — a pod's `url` points to an attached
video file. To vote well, the node must actually *watch* the video and score it
against the datanet rubric. Today it cannot: scoring is **text-only**.

`src/voter/score.ts:buildVotePrompt` (lines 19-29) builds plain `{system, prompt}`
strings; the pod-enrichment loop in `src/runtime/wiring.ts` (~lines 160-163)
fetches `pod.url` as **plain text** (max 4000 chars) and concatenates it onto the
description. Pointed at an `.mp4`, that yields binary garbage. `src/llm/generate.ts`
(`generateObjectWithRetry`, line ~17) calls `generateObject({ model, schema, system,
prompt })` with strings only — no multimodal content parts, even though the Vercel
AI SDK and all three configured providers support them.

## Model-capability finding (the crux)

"Watching video" depends on the model:
- **Claude** (default provider `anthropic`, `src/index.ts:114`) — watches **images,
  not video**. Video would require sampling frames.
- **Gemini** (`google` → `gemini-3-pro`, `src/llm/model.ts` `DEFAULT_MODEL`) —
  watches **video natively** (motion + temporal + audio) via the AI SDK file part /
  Files API.
- **OpenAI** — images only.

## Decisions (settled during brainstorming)

1. **Gemini-native video.** Robotics-datanet scoring routes to Google Gemini and
   passes the actual video, so the model sees motion/temporal (essential for
   "did the robot complete the task"), not just keyframes.
2. **Voting only; adapter-agnostic.** Voting scores on-chain pods by rubric with no
   adapter, so this is purely a **scorer-input** problem — no robotics adapter.
3. **Auto-detect by Content-Type** (not a per-datanet config flag): a votable pod
   whose `url` is `video/*` takes the video path; everything else takes the
   unchanged text path. Mixed datanets and stray video pods just work.
4. **Fail-closed, per-datanet isolation.** Any failure (no Google key, fetch/codec
   error, over-size, Gemini/Files-API error) **skips that pod with a recorded
   reason** and never aborts the cycle.

## Design

### 1. Detect & route (per-pod, auto)

In the pod-enrichment loop (`src/runtime/wiring.ts`), before enriching a votable
pod, peek the `url`'s `Content-Type` (HEAD, or a ranged GET fallback):
- `video/*` → mark the pod for the **video scorer** (Gemini); capture `mediaType`
  + `Content-Length`.
- otherwise → existing **text enrichment** + text scorer (byte-for-byte unchanged).

### 2. Ingest (size-branched)

For a video pod, fetch the bytes and branch on size (`Content-Length`, threshold
`VIDEO_INLINE_MAX_BYTES` ≈ 20 MB):
- **small** → inline base64 as a video content part in one request.
- **large/long** → Gemini **Files API**: upload → poll until `ACTIVE` → reference
  in the request → delete after scoring.

Cap with `VIDEO_MAX_BYTES`: a pod whose video exceeds it is **skipped with a
recorded reason** (cost/latency guard), not fetched whole.

### 3. Multimodal scorer seam (the code change)

- `src/voter/types.ts` — `VoterPod` gains `mediaUrl?: string` + `mediaType?: string`
  (e.g. `'video/mp4'`), kept distinct from the text `description`.
- `src/voter/score.ts:buildVotePrompt` — for a video pod, return **message parts**
  (`[rubric text, video content part, "score 1-10 strictly by the rubric"]`)
  instead of a single `prompt` string; text pods keep returning the string form.
  Keep the existing `INJECTION_GUARD` and operator-brief blocks.
- `src/llm/generate.ts:generateObjectWithRetry` — accept `messages` / `ContentPart[]`
  (AI SDK supports it) in addition to `prompt`; unchanged for the string path.
- The text scoring path is byte-for-byte unchanged.

### 4. Model / config (operational prerequisite)

Video scoring routes to `google` / `gemini-3-pro` **regardless of the operator's
default LLM provider**, via per-task routing in `src/llm/` (a `videoScorer` bound to
google, alongside the existing default scorer).

- New env: a **Google/Gemini API key** (e.g. `GOOGLE_GENERATIVE_AI_API_KEY` /
  `GEMINI_API_KEY`, matching `@ai-sdk/google`). Document in `.env.example`.
- If no Google key is configured, video pods are **skipped with a recorded reason**
  ("video scoring needs a Google API key"); text datanets are unaffected.

### 5. Failure & limits (per-datanet isolation)

Fetch failure / unsupported codec / over `VIDEO_MAX_BYTES` / Gemini error /
Files-API upload timeout → **skip the pod, record the reason** (reuse the existing
per-datanet skip/record mechanism), never abort the cycle or other pods. Bound
cost/latency with a per-cycle cap on the number of video pods scored.

### 6. Cost note

LLM spend is the operator's API bill (Google), **not** the on-chain REPPO/gas
budget — the budget ledger is untouched. The caps above (`VIDEO_MAX_BYTES`,
per-cycle video-pod cap) exist to bound that API bill + cycle latency, recorded
for dashboard visibility but not enforced by the ledger.

## Testing

- Content-Type detection routes `video/*` → video scorer, others → text scorer.
- Ingest size-branch: small → inline (mocked bytes), large → Files API path
  (mocked upload/poll/reference/delete).
- `buildVotePrompt` builds correct message parts for a video pod and the unchanged
  string for a text pod.
- Skip-with-reason on: no Google key, over `VIDEO_MAX_BYTES`, fetch failure,
  Gemini error.
- Model routing: a video pod is scored with the `google` model even when the
  default provider is `anthropic`.
- Text scoring regression: existing voter tests stay green.

## Open assumptions (confirm)

1. Typical clip **size/length** distribution — sets `VIDEO_INLINE_MAX_BYTES` and how
   often the Files API path is exercised.
2. The operator can supply a **Google API key** (required for the Gemini-native path).

## Out of scope

- Frame-sampling / Claude-vision fallback (the chosen path is Gemini-native; a
  no-key datanet simply fail-closed-skips).
- A robotics **adapter** for minting (voting needs none).
- Per-token LLM budget enforcement in the ledger (LLM cost is the operator's API
  bill, bounded by the size/count caps, not the on-chain budget).
- Audio-only or non-video media types.
