# Telemetry

Orquestra sends anonymous software-health data so bugs can be fixed for **all** node
operators, not just the ones who happen to file an issue.

It is **on by default**. This page is the complete description of what that means. If
anything here disagrees with what your node actually sends, the node is authoritative and
it is a bug — run `orquestra telemetry --show` and open an issue.

## See it yourself

```sh
orquestra telemetry --show
```

That prints the exact bytes your node would transmit, built from your node's real current
state. It is the same serializer the sender uses, so the two cannot drift. It transmits
nothing.

## Turn it off

```sh
orquestra telemetry --off        # permanent, persisted in your data dir
ORQUESTRA_TELEMETRY_DISABLED=1   # one run only, does not change your stored setting
```

Both take effect immediately, including mid-cycle. `orquestra telemetry` with no flag
shows the current state.

## Nothing is sent before you are told

A node will not transmit until it has displayed the telemetry notice at least once. On a
fresh install, and on a node upgraded from a version that predates telemetry, the first
run prints the notice and sends nothing. Transmission begins on the following run.

If you configure through `orquestra configure`, the notice appears during the interview
with a one-keystroke opt-out, and telemetry may start from the first cycle.

## What is sent

| Field | What it is |
|---|---|
| `schemaVersion` | Version of this payload format |
| `ts` | When the payload was built (ISO 8601) |
| `installId` | Random UUID, minted on first run, stored in your data dir |
| `orquestraVersion` | Release version of this build. A build that was never stamped by the release pipeline reports `0.0.0-dev+<short-sha>` — dev builds are never reported as a release version. Override with `ORQUESTRA_VERSION`. |
| `nodeVersion` | Your Node.js version |
| `platform` / `arch` | e.g. `darwin` / `arm64` |
| `counts` | Cycles run; votes and mints attempted vs failed; budget refusals; total errors |
| `errorSignatures` | Error class, normalized stack frames, and — when recognized — a reppo error code (e.g. `VOTER_LACKS_SUBNET_ACCESS`). **Never the message.** The code is matched against a fixed allowlist compiled into the node, so this field can only ever contain a string that already exists in the source; anything unrecognized is omitted. |

`counts` is keyed by action kind and status only — never by datanet, pod, or token.

## What is never sent

- **Your wallet address**, in any form. Not hashed either: the set of node addresses is
  small and publicly enumerable on-chain, so a hash would be reversible by brute force.
- Your private key, or anything read from `.env`.
- Datanet or subnet identifiers.
- Strategy configuration — thresholds, vote rates, selection counts, budget caps.
- Balances, earnings, REPPO or token amounts, ROI, gas figures.
- Pod names, pod content, or panel transcripts.
- RPC URLs.
- Error **messages**, or any free-text string of any origin.

### Deliberately excluded, though they were considered

Two fields were weighed and left out: **which data adapters you have enabled**, and **which
LLM provider you use**. Both would help prioritize maintenance, and neither is strategy in
the strict sense.

They are excluded because node operators compete for the same emissions, and the line
worth holding is "software health, never anything about how you play". Adapter selection
sits close enough to that line to be worth refusing. If they are ever added, it will be as
an explicit change to this page and a `schemaVersion` bump, not quietly.

### Why error messages are excluded

Error messages routinely embed text this node did not author — pod content, external API
responses, RPC error bodies. Rather than filter that, the payload has no field for it.
What is sent is a fingerprint:

```json
{ "errorClass": "TypeError", "frames": ["castVote (dist/reppo/vote.js:42)"] }
```

Absolute paths are normalized (`/Users/you/code/orquestra/dist/...` → `dist/...`), so your
username and directory layout are not transmitted, and the same fault on two differently
configured nodes produces the same fingerprint.

## Identity

`installId` is a random UUID with no relationship to your wallet, hostname, MAC address, or
data directory path. Two nodes on one machine with different data directories have
unrelated ids. It exists so a bug reported by ten nodes can be told apart from one node
reporting ten times.

## Retention

Raw reports are retained for **90 days**, then deleted. Aggregates derived from them may be
kept longer.

## How reports are used

A signal is only acted on once it has been reported by several distinct installs. A report
from a single install is never acted on by itself — the collector accepts reports without
authentication, so no individual report is treated as trustworthy.

## Changes to this page

The field list above is asserted against the code by a test, so it cannot silently drift.
Any change to what is collected bumps `schemaVersion` in the same change.
