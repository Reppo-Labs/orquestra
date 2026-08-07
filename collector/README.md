# Telemetry collector

AWS deployment for the operator telemetry described in [`docs/telemetry.md`](../docs/telemetry.md).

```
POST /v1/reports
      │
API Gateway HTTP API ──(stage throttling: per-source rate limit)
      │
   Lambda: ingest ──── validate → rate-check → put
      │                (logic lives in src/collector/, not here)
      ▼
DynamoDB  pk=installId, sk=receivedAt
          expiresAt (TTL) ← retention is a TABLE PROPERTY, not a cron
      │
      ▼
   Lambda: aggregate (scheduled) ── admission threshold → published aggregate
```

## Why the logic is not in this package

`src/collector/` in the node's own source tree holds validation, rate limiting, and the
admission threshold. This package is a thin adapter: read the event, call the pure
function, write the result.

Two reasons:

1. **Shared constants.** The collector validates against the same `SCHEMA_VERSION` the node
   transmits, so the fleet and the collector cannot drift into a state where reports are
   silently mis-parsed.
2. **The security-critical path is covered by the node's test suite**, which runs on every
   CI build, rather than by whatever testing an infra package happens to accumulate.

## Retention

`expiresAt` is derived from `RETENTION_DAYS` in `src/telemetry/notice.ts` — the same
constant quoted in the first-run notice and in `docs/telemetry.md`. Changing retention is a
one-line edit there; `docs.test.ts` fails if the documentation stops matching.

DynamoDB TTL deletes expired items automatically. This was the deciding reason for
DynamoDB over Postgres: a retention promise made to operators should not depend on a cron
job continuing to succeed.

## Deploy

```sh
cd collector
npm install
npx cdk deploy
```

Then set the printed endpoint on each node:

```sh
ORQUESTRA_TELEMETRY_ENDPOINT=https://<api-id>.execute-api.<region>.amazonaws.com/v1/reports
```

With that variable unset, nodes build no payload and make no network call — the default
until an endpoint is deliberately configured.

## Threshold

`MIN_DISTINCT_INSTALLS` and `WINDOW_DAYS` live in `src/collector/config.ts` and are
**security-relevant configuration**, not tuning knobs. Read the comment there before
changing either — particularly before lowering them because signals are not coming through.
