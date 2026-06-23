# Orquestra Operator Guide

Run an Orquestra node: it votes on and publishes data across Reppo datanets on
your behalf, signing with your own wallet, bounded by budgets you set. This guide
takes you from nothing to a running, earning node and explains everything the
dashboard shows.

> **Beta note.** Orquestra holds a funded wallet key and spends on-chain. Use a
> **dedicated wallet** with only what you're willing to let the node spend. Start
> with small budget caps, watch a few cycles, then scale.

---

## 1. What it does (30 seconds)

Each cycle (default hourly) the node, for every datanet you enable:

- **Votes** — scores other operators' data "pods" 1–10 against the datanet's
  rubric and up/down-votes the ones it's confident about.
- **Mints** — for datanets with a data adapter, sources + publishes its own pods.
- **Claims** — collects any finalized emissions you've earned.

You earn $REPPO when the crowd up-votes your minted pods (a share of each
datanet's per-epoch emission pool) and through voting participation. There is no
compute/inference earning path — the node earns only by publishing and voting.

---

## 2. Before you start

You need:

| Requirement | Notes |
|---|---|
| **Docker** (with Compose) | the node runs as a container |
| A **dedicated wallet** | fund with ETH on **Base** (gas) + **REPPO** (mint fees, veREPPO lock). Never your main wallet. |
| An **LLM API key** | powers scoring, the deliberation panel, and the onboarding chat. Anthropic / OpenAI / Google / Surplus / Virtuals. |
| A **Pinata JWT** | only to **mint in "pin" mode** (pins pod datasets to IPFS). Not needed for voting, or if you mint every datanet in **url-only** mode (§7). |
| A **private Base RPC** (recommended) | the public RPC rate-limits under a full cycle; Alchemy/QuickNode/Ankr remove per-datanet errors. |

Funding rule of thumb for beta: a little ETH for gas (mint/vote/claim txs are
cheap on Base, ~fractions of a cent), plus enough REPPO to cover your `mintReppoMax`
cap and any veREPPO lock you choose.

> **Sizing `mintReppoMax`:** each mint pays a REPPO fee (≈100–200 observed). The
> `reppo` CLI does not report the fee, so the node reserves a conservative **~200
> REPPO per mint** against your cap *before* signing (refuse-before, not after). A
> `mintReppoMax` below ~200 therefore refuses **every** mint — set it to roughly
> 200 × the number of mints you want per budget horizon (e.g. 400 for two). Set
> `RPC_URL` and the cap tracks the real (often lower) fee instead of the 200 estimate.

---

## 3. Install & run

### 3a. Configure secrets

```sh
cp .env.example .env
```

Fill in `.env` (every variable is documented inline). Minimum to start:

- `REPPO_PRIVATE_KEY` — your dedicated wallet
- `LLM_PROVIDER` + `LLM_API_KEY`
- `RPC_URL` — your private Base RPC (recommended)
- `PINATA_JWT` — only if minting

These are the only things you set by hand. **Your strategy is configured in the
dashboard, not here.**

### 3a-bis. Use a Claude subscription instead of an API key (optional)

You can drive the node's LLM off a Claude Pro/Max subscription (`anthropic-oauth`
provider) instead of a metered Anthropic API key. The catch: the OAuth token must be
minted by the **first-party Claude CLI** — Anthropic rejects a hand-rolled OAuth flow,
and gates the token to Claude-Code-shaped requests. Orquestra handles the request shape;
you handle the one-time mint.

> **Terms-of-service caveat.** Programmatic use of a *consumer* Claude subscription may
> violate Anthropic's terms (seat-ban risk), and Anthropic is phasing out third-party
> OAuth. Use a plan that permits it, or stick with `LLM_KEY_ANTHROPIC`.

1. **Install the `claude` CLI** on a machine you control (it is NOT in the node image):
   `npm i -g @anthropic-ai/claude-code` (or your usual install), and sign in once.
2. **Mint the token**, writing it into the node's data dir (the same `./orquestra-data`
   the container mounts at `/data`). Run on that host — it opens a browser:
   ```sh
   ORQUESTRA_DATA_DIR=./orquestra-data node dist/index.js login-anthropic
   ```
   This wraps `claude setup-token`, scrapes the long-lived `sk-ant-oat…` token, and
   writes `./orquestra-data/anthropic-oauth.json` (0600). (`dist/` exists after
   `npm run build`; or run the equivalent inside any container that has the `claude` CLI.)
3. **Select the provider** in `.env` and restart:
   ```sh
   LLM_PROVIDER=anthropic-oauth
   ```
   `docker compose up -d` (or recreate the container). There is **no** env key for this
   provider — availability comes from the stored token, not a key. The dashboard model
   picker also lists `anthropic-oauth` once the token is present.

The token is long-lived; if it is ever revoked or expires, re-run step 2 and restart.
A node set to `anthropic-oauth` with no token logs a startup WARNING and every LLM call
fails until you log in — it does not fall back to an API key.

### 3b. Start the node

```sh
docker compose up -d
```

This pulls the published image, runs it detached with a persistent data volume
and `restart: unless-stopped`, and binds the dashboard to `127.0.0.1:7070`.
`docker ps` shows `healthy` once it's up.

Build from source (the supported path): always tag the image **`orquestra:latest`** —
do not use per-feature or per-version image tags. Rollback is by git, not by image
tag (`git checkout <commit> && docker build -t orquestra:latest .`):

```sh
docker build -t orquestra:latest .
```

Point `docker-compose.yml`'s `image:` at `orquestra:latest` (or run directly with
`docker run ... orquestra:latest`). To upgrade: rebuild `orquestra:latest` from the
new commit and recreate the container.

### 3c. Reach the dashboard

The dashboard is **unauthenticated and localhost-only by design** — never expose
port 7070 to the internet. To open it from your laptop when the node runs on a
remote host, use an SSH tunnel:

```sh
ssh -L 7070:localhost:7070 <your-host>
```

then open **<http://localhost:7070>**. Running the node locally? Skip the tunnel —
it's already at that URL.

### 3d. Headless / declarative deploy (Kubernetes, GitOps)

For a fully declarative deploy with no dashboard interview, pre-seed the strategy and
make the config file the source of truth:

1. **Set `CONFIG_SOURCE=file`** in the environment. On every boot the node re-applies
   `strategy.config.json` from `ORQUESTRA_DATA_DIR` into its config row and skips
   onboarding. A redeployed ConfigMap therefore takes effect on the next pod restart
   (add a config checksum annotation to your Deployment so a config change rolls pods).
   You'll typically also set `DASHBOARD_ENABLED=false`.
2. **Mount `strategy.config.json`** into the data dir (e.g. a ConfigMap volume at `/data`,
   or an initContainer that writes it there). Start from
   [docs/examples/strategy.config.example.json](examples/strategy.config.example.json).
3. **Validate in CI before deploy** so a malformed config never reaches a pod (where it
   fails at boot — fail-fast, exit non-zero, not a silent default):
   ```sh
   orquestra validate-config path/to/strategy.config.json   # exit 0 = valid, 1 = invalid
   ```
   The trackable JSON Schema is [docs/strategy.config.schema.json](strategy.config.schema.json)
   (generated from the code via `npm run gen:schema`) — wire it into your editor or a CI
   schema-lint for early feedback.

Notes:
- Without `CONFIG_SOURCE=file`, a `strategy.config.json` present on first boot is still
  imported **once** (then renamed `.imported`) and the SQLite config row becomes canonical
  — fine for a one-shot seed, but a later file change is ignored. Use `CONFIG_SOURCE=file`
  when you want the file to stay authoritative.
- Strategy edits in this mode = change the file + redeploy. The dashboard Save path still
  works if enabled, but the next file reconcile on boot overrides it.

---

## 4. First run — onboarding

On first start the node has no strategy and waits for you to configure one in the
dashboard (the startup log prints the tunnel command + URL). Open the dashboard
and you'll land in **onboarding**: a chat on the left, a live strategy "score
sheet" on the right.

Tell the assistant what you want, e.g.:

- *"Vote-only on the safest datanets to start"*
- *"Mint geopolitical news with a contrarian angle, small budget"*
- *"80% of my REPPO into a 90-day veREPPO lock"*

As you settle each topic the right panel fills in (datanets, budgets, cadence). It
asks one thing at a time and recommends options. When you confirm, it writes your
strategy and the node starts its first cycle.

You can re-run onboarding anytime from **Strategy → ↻ reconfigure with assistant**.

---

## 5. The dashboard

Four tabs:

### Overview
Your at-a-glance state: net REPPO, earned/claimed/claimable, mint spend, gas,
balances, current epoch. Below that:
- **Budget burn** — spend vs each cap, with bars that turn red near the limit.
- **Claimable emissions** — pods with finalized rewards waiting to be claimed
  (the node claims them automatically).

### Strategy
The control surface. Each datanet is a card:
- **vote / mint** chips toggle what the node does there.
- **adapter** — the data source for minting (`gdelt`, `hyperliquid`, `sports`); a
  datanet with no adapter is vote-only.
- **strictness** — how confident the node must be to act. Hover the ⓘ for the exact
  score thresholds. Short version: **conservative** = picky (only acts on strong
  signals, spends least), **aggressive** = participates widely (more votes/mints,
  spends more), **balanced** = middle.
- **+ mint strategy** — for minted datanets, set focus / angle / items-per-cycle,
  and **mint mode** (see §7).
- **+ add datanet** — opens a picker of all active datanets by name.

Below the cards: **budget & cadence** (caps, how often the node runs — fractional
hours allowed, e.g. `0.5` = 30 min), **deliberation** (multi-agent panel on/off),
and your **strategy brief** (the freeform goal the node votes and mints by).

Changes don't apply until you hit **Save** — the diff line shows exactly what
you're about to change. Saves take effect on the next cycle (no restart).

### Assistant
The strategy chat in its own tab. Describe a goal in plain language; it proposes a
full config change that loads into your Strategy tab for review. Nothing applies
until you Save. Use it for "be more aggressive on geopolitics" or "what's my
current setup?".

### Activity
Every vote, mint, claim, and skip, newest first. Filter by kind. A `⚖ 3` badge
means a multi-agent panel decided that one — click it to open the debate drawer
(bull / bear / rubric-purist scores + arguments, and the judge's verdict).

This is where you spot a misbehaving or idle datanet: a `skip` row says *why*
nothing happened — RPC error, subnet access not granted, no on-chain rubric/spec,
an unregistered adapter, or "candidates discovered but none passed scoring." If a
datanet you enabled never produces votes/mints, filter to `skip` and read the reason.

---

## 6. How earning works (and why some pods don't)

- **Emissions are per-epoch and lag.** A pod earns a share of its datanet's
  emission pool only **after that epoch finalizes** — rewards trail votes by about
  an epoch (epochs are ~48h). So freshly-minted, freshly-upvoted pods show
  `claimable: 0` for a while. This is normal, not a bug.
- **Only net-positive pods earn.** A pod must have a **positive net vote**
  (upvotes − downvotes) at finalization to be accepted into the curated dataset and
  share the pool. A net-downvoted pod earns nothing — the crowd rejected that data,
  and the mint fee you paid for it is lost.
- **Claiming is automatic.** With `claimEmissions` on (default), the node claims
  the instant rewards are due; you'll see claimable→claimed and net REPPO rise.

Practical read: watch **Activity → mints** and **Overview**. If a datanet keeps
producing net-downvoted or no-vote pods, its adapter is publishing data the crowd
doesn't value — tighten its strictness or switch it to vote-only.

---

## 7. Mint mode — pin vs url-only (do you need Pinata?)

Each minted datanet has a **mint mode**, set per datanet in the Strategy tab:

- **pin** (default) — the node uploads the pod's dataset JSON to IPFS via your
  Pinata key. Use it where the dataset *is* the value (e.g. trade data) and curators
  pull the downloadable to judge it.
- **url-only** — the node registers the candidate's **source URL** as the pod, with
  **no pinning and no Pinata**. Use it for link-type pods (e.g. news articles).
  Candidates with no source URL are skipped in this mode.

So **Pinata is required only if at least one minted datanet is in `pin` mode.** A
vote-only node, or one that mints everything url-only, doesn't need a Pinata key at
all.

Tip: before switching a datanet to url-only, confirm its pods still earn — for some
datanets curators score the pinned dataset, not just the link.

## 8. The multi-agent panel

For close calls (and every mint), the node can convene a panel — **bull**, **bear**,
and a **rubric-purist** each argue a score, and a **judge** rules. It catches
borderline mistakes a single scorer would make. Toggle it in **Strategy →
deliberation**; the `voteBand` controls how close to a threshold a vote must be to
trigger the panel (`0` = panel on mints only). Every panel decision is inspectable
in the Activity debate drawer.

Cost note: a panel decision is ~4 LLM calls vs 1. Tiering keeps clear-cut votes
cheap; only ambiguous votes and mints pay the full cost.

---

## 9. Updating

```sh
docker compose pull && docker compose up -d
```

Your data volume (strategy, ledgers, activity log) persists across updates — it lives in
the named `orquestra-data` Docker volume, not the container. `docker compose down && up`
keeps it; **`docker compose down -v` deletes it** (you'd have to re-onboard). To confirm the
node is writing to the volume, check the `orquestra: data dir /data …` line on startup — it
must read `/data`. To back it up: `docker run --rm -v orquestra-data:/data -v "$PWD:/out"
alpine tar czf /out/orquestra-backup.tgz -C /data .`

---

## 10. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Dashboard won't load | Check the SSH tunnel is up and you're hitting `localhost:7070`. `docker ps` should show `healthy`. |
| `PUBLIC_API_UNREACHABLE` in logs | A transient reppo.ai blip. The node retries automatically; a one-off is harmless. Persistent = check the node's internet/DNS. |
| Datanet skips with `INTERNAL_ERROR` / `429` / `rate limit` | The public Base RPC is rate-limiting. The node now retries these with backoff, but a busy cycle can still exhaust the retries — set `RPC_URL` to a private endpoint (Alchemy/QuickNode) for a clean run. |
| `eth_getLogs HTTP 400` in logs | The on-chain emissions scan hit an RPC `getLogs` range cap. Non-fatal: the claim phase skips that cycle and votes/mints continue. The node now chunks to ≤10k blocks; if it persists, set `RPC_URL` to a higher-capacity endpoint. |
| 0 votes every cycle | Nothing new to vote on (all current pods already voted, yours, or skipped mid-range). Normal between fresh pods. |
| Mints score low / nothing mints | The strictness gate is rejecting candidates. Don't loosen it just to force mints — that publishes low-value data that gets downvoted. |
| `claimable: 0` despite upvotes | Emissions lag — wait for the epoch to finalize (§6). |
| Onboarding chat 503s | The node started without `LLM_PROVIDER` / `LLM_API_KEY`. Set them in `.env` and restart. |
| Onboarding lost after `compose down && up` (kept on plain restart) | The data dir wasn't on the named volume. Confirm the `orquestra: data dir /data …` line at startup reads `/data`, and never run `docker compose down -v` (the `-v` deletes the `orquestra-data` volume). See §9. |

Logs: `docker compose logs -f`.

---

## 11. Safety & cost model

- The node **cannot spend beyond your budget caps** — the budget ledger refuses
  before signing, not after.
- Enabling a datanet is your consent to pay its one-time, per-subnet access
  grant fee (cached, charged once on first use). There is no separate grant
  budget cap — don't enable a datanet whose access fee you don't want to pay.
- The private key sits in `.env` in plaintext — **use a dedicated wallet**.
- The dashboard is unauthenticated and localhost-bound on purpose (see
  [ADR 0002](adr/0002-dashboard-unauthenticated-localhost-bind.md)). Never publish
  port 7070; anyone who reaches it can rewrite your strategy and spend your budget.

---

## 12. FAQ

**Do I need to keep my laptop open?** No — the node runs on its host (VPS or
machine) independently. The SSH tunnel is only for viewing/configuring the
dashboard.

**Can I change strategy while it's running?** Yes. Edit in the Strategy tab and
Save; it applies next cycle, no restart.

**How much will it spend?** Never more than your caps. Mint fees (REPPO) are the
main cost; gas on Base is negligible. Start small.

**What's "deliberation" costing me?** Extra LLM API calls on ambiguous votes and
mints. If your LLM bill matters, set the panel off or `voteBand: 0` (mints only).

**Why is net REPPO negative at first?** You pay mint fees up front; emissions lag.
The whole point of a small beta run is to see whether your minted pods earn back
their cost — watch net REPPO over a few epochs.
