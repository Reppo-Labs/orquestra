# Dashboard is unauthenticated; localhost-bind + SSH tunnel is the exposure model

**Status:** accepted

## Context

The dashboard has write endpoints (save strategy, strategy chat, onboarding) and,
with the Docker-image distribution, is the blessed first-run config surface. An
earlier decision removed the dashboard auth token. Audience A runs on a headless
VPS, so they must reach the dashboard remotely to onboard — which makes an open,
unauthenticated config panel attached to a funded wallet a real exposure if the
port is public.

## Decision

Keep the dashboard **unauthenticated**, and make **localhost-bind + SSH tunnel** the
exposure model: `docker-compose.yml` publishes `127.0.0.1:7070`, and operators
onboard/administer over `ssh -L 7070:localhost:7070 <host>`. The dashboard is never
reachable from the internet by default, so no auth is needed and the operator keeps
full self-custody. An **optional dashboard secret remains a designed-for-but-deferred
config flag** — not deleted, to be enabled when audience B (who will not SSH-tunnel)
arrives.

## Considered options

- **Reintroduce a dashboard secret now** so the port can be safely exposed to
  `0.0.0.0` — deferred, not rejected: unnecessary for audience A, who tunnel by habit,
  and it adds a credential to manage before there's a user who needs it.
- **Ship compose with no published port at all** — rejected as default: more friction
  than a localhost bind for no extra safety once the bind is localhost-only.

## Consequences

- README must document the SSH-tunnel onboarding step; it is awkward as the *primary*
  first-run action and is the main reason audience B will need the optional secret.
- "The dashboard has no auth" is deliberate, not an oversight. Do not "fix" it by
  exposing the port — exposing an unauthenticated dashboard on a funded node is how a
  wallet gets drained. Add the optional secret first.
