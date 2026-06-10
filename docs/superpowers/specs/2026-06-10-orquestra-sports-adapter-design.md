# Orquestra: Sports Signals Adapter (datanet 11) — Design

**Date:** 2026-06-10
**Status:** Approved
**Target:** Datanet 11 "Sports Signals" — verified live: 4,000 REPPO emissions/epoch
(vs #2's 3,000) with ~9× less up-vote competition (17.7M vs 154M volume). Access
fee 100 REPPO; grants follow datanet membership, so enabling mint auto-grants.

## What the datanet wants (verified from on-chain metadata)

Publisher spec: *"Submit public sources that contain real sports signal — articles,
podcasts, beat reporter posts, analyst threads."* Voters *"figure out which takes
are real signal and which are noise."* The description stresses that *"the most
valuable signal often isn't in the box score."*

So the adapter **curates genuine analyst takes from credible sources** — it does
NOT generate its own predictions (off-spec) and does NOT dump scores/headlines
(the node itself downvotes those on #11 as noise today).

## Architecture

New self-contained `src/adapter/sports/`, mirroring the proven gdelt shape
(Approach A; a shared "source→signal" core is deliberately deferred until a third
adapter justifies the refactor — rule of three):

```
src/adapter/sports/
  feeds.ts    — fetch + parse curated RSS feeds (curl + withRetry, per-feed tolerance)
  signal.ts   — LLM extracts each item's core take + scores signal strength
  index.ts    — createSportsAdapter(): throttle → fetch → synthesize → filterNovel
```

Registered in the composition root's adapter array (`createSportsAdapter({ model })`);
routed by `adapter: "sports"` in strategy config. Reused as-is: `clampPodName` /
`POD_DESC_MAX`, gdelt's `filterNovel` (text-overlap dedup), `withRetry`, and the
`sourceUrl`/`imageUrl` → `mint-pod --url/--image-url` path (reppo-cli ≥0.8.2).

## Sourcing (feeds.ts)

- **Default feed list**: curated free, no-auth RSS feeds skewed to analysis (The
  Ringer, ESPN analysis verticals, Yahoo Sports analysis, CBS Sports analysis,
  team-beat aggregators). Operator-overridable via `adapterParams.feeds: string[]`.
- **Fetch**: `curl -fsS` per feed through `withRetry`; one feed's failure is
  logged and tolerated (others proceed).
- **`parseRss(xml)`**: pure, tolerant regex-based extraction — `title`, `link`,
  `description`, `pubDate`, `image` (from `media:content` / `media:thumbnail` /
  `enclosure`). No new dependencies. Malformed items skipped.
- **Freshness**: items older than `maxAgeHours` (default 48) dropped.
- **Throttle**: same 30-min per-source guard as gdelt, armed only on success.

## Signal extraction (signal.ts)

One batched `generateObject` call (`mode: 'tool'`, works across all providers),
with gdelt's untrusted-content guard. Inputs: datanet rubric + operator strategy
(`focus` e.g. "NBA and Premier League", `angle`, `brief`, `topN`,
`minSignal` 1-10, default 7) + the item list.

Output per selected item:
- `take` — the analyst's core claim, ≤200 chars, **extracted in the source's
  voice, never invented**
- `title` — ≤50 chars (pod name; falls back to clamped take)
- `signal` — 1-10: opinionated? defensible? pre-consensus? non-obvious?
- `stance`, `rationale` — one-liners for the dataset

The prompt encodes the datanet's anti-noise rubric explicitly: no box-score
recaps, no bare headlines, the take must be attributable to its source. Items
below `minSignal` are dropped. LLM failure → `[]` (logged, never throws into
the cycle).

## Candidates & pod shape

- `canonicalKey` = sha256(`sports:<datanetId>:<normalized take>`) — gdelt's exact
  dedup pattern, stable across feed churn.
- `podName` = `clampPodName(title ?? take)`.
- `podDescription` = `"Take: <take> — <source domain> (signal <n>/10)"`, clamped
  to `POD_DESC_MAX`.
- `dataset` = `{ kind: 'sports-signal', schema_version: 1, take, stance,
  rationale, signal, source: { url, title, published }, image }`.
- `sourceUrl` = article link (the pod's clickable face); `imageUrl` = RSS media
  image when present (pod card image).
- Novelty backstop: `filterNovel(candidates, existingPodNames)` over take text.

## Config (data-only activation)

```json
"11": {
  "vote": true, "mint": true, "strictness": "balanced",
  "adapter": "sports",
  "adapterParams": {
    "focus": "<operator's sports/leagues>",
    "angle": "<e.g. contrarian, injury-aware>",
    "topN": 4, "minSignal": 7
  }
}
```

Enabling mint is the consent to pay the one-time 100-REPPO access grant
(auto-granted on the first cycle; wallet holds ~4.9k REPPO).

## Error handling

Inherits the cycle's per-datanet isolation. Specific behaviors: feed fetch
failure → that feed skipped; ALL feeds failed → `[]` this cycle, throttle not
armed; RSS parse tolerance per item; LLM failure → `[]`; CLI field limits
enforced by the existing clamps; idempotent mints via `mint-<canonicalKey>`.

## Testing

- `feeds.test.ts`: `parseRss` against a fixture XML (real-feed shaped, incl. one
  malformed item + media/enclosure image variants); freshness filter.
- `signal.test.ts`: injected `generate` — selection, `minSignal` gate, title
  fallback to clamped take, source/image threading, LLM-failure → [].
- `index.test.ts` (adapter): throttle (success-only arming), per-feed failure
  tolerance, novelty dedup, candidate shape (sourceUrl/imageUrl present).
- Downstream already covered: selectMints carry, cliBoundary `--url/--image-url`.

## Out of scope

- Generating our own predictions (off-spec for this datanet).
- Odds/lines APIs and auth-required sources (revisit if curation underperforms).
- A shared source→signal engine refactor with gdelt (deferred to a third adapter).
- Podcast/audio sources (the spec mentions them; text feeds first).
