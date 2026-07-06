# orquestra

Reppo's official agentic swarm node. Run a node on your machine: it curates
(votes) across any Datanet and mints where it has a data adapter, bounded by a
budget you set in an LLM onboarding interview, signing with your own wallet.

**New operator? Read the [Operator Guide](docs/operator-guide.md)** — install,
onboarding, the dashboard, earning, and troubleshooting, end to end. Once your
node runs, the **[Strategy Guide](docs/strategy-guide.md)** shows how to make its
voting/minting behavior yours. Operating the node with an AI agent (Claude Code
etc.)? Point it at **[SKILL.md](SKILL.md)** — a ready-made operator skill.

See `docs/adr/` for key architectural decisions. The original design notes
(`docs/design/`) are internal engineering history — useful for contributors, but
they predate the shipped code and may not match it; the Operator Guide above is the
current source of truth.

## Run a node

Prerequisites: Docker (with Compose), a **dedicated** wallet funded with ETH
(Base) and REPPO, and an LLM API key (Anthropic, OpenAI, Google, Surplus,
Virtuals, or usepod — or a Claude subscription via `anthropic-oauth`, see below).

1. **Configure secrets** — copy [.env.example](.env.example) to `.env` and fill
   it in. Every variable is documented inline; minimum: `REPPO_PRIVATE_KEY`,
   `LLM_PROVIDER`, `LLM_API_KEY`. Add `PINATA_JWT` if you want to mint. These are
   the only things you set by hand — your strategy is configured later in the
   dashboard.

2. **Start the node**

   ```sh
   docker compose up -d
   ```

   This pulls the published image (`ghcr.io/reppo-labs/orquestra`), runs it
   detached with a named data volume and `restart: unless-stopped`, and binds the
   dashboard to `127.0.0.1:7070` on the host. `docker ps` shows `healthy` once it
   answers. Pin a version in `docker-compose.yml` (e.g. `:0.1.0`) for production.

3. **Onboard in the dashboard** — on first run the node has no strategy yet and
   waits for you to configure one in the dashboard (no terminal interview needed).
   The dashboard is localhost-only and unauthenticated, so reach it over an SSH
   tunnel from your laptop:

   ```sh
   ssh -L 7070:localhost:7070 <your-host>
   ```

   Then open <http://localhost:7070> and chat through onboarding (which datanets
   to vote/mint, budget caps, cadence, your strategy brief). The moment you save,
   the node starts its first cycle. (Running locally rather than on a remote host?
   Skip the tunnel — the dashboard is already at <http://localhost:7070>.)

4. **Watch it work** — the dashboard shows balances, P&L, budget burn vs. your
   caps, emissions, and an activity feed of every vote, mint, claim, and skip (with
   the reason a datanet was idle). Logs: `docker compose logs -f`.

**Updating:** `docker compose pull && docker compose up -d`.

### Safety model

- The node can never spend beyond the budget caps in your strategy config; the
  budget ledger refuses before signing, not after.
- Enabling a datanet (vote/mint) is the consent to pay its one-time subnet
  access grant (and, for minting, a per-mint publishing fee — check both with
  `reppo query datanet <id>`). Only enable datanets you intend to pay for.
- Use a dedicated wallet. The private key sits in `.env` in plaintext.
- The dashboard is **unauthenticated** and bound to localhost on purpose
  ([ADR 0002](docs/adr/0002-dashboard-unauthenticated-localhost-bind.md)). Reach
  it via the SSH tunnel above — never publish port 7070 to the internet, or
  anyone could rewrite your strategy and spend your budget.

### Build from source / audit

The published image is built from this repo's `Dockerfile`. To build and run it
yourself instead of pulling:

Always tag the image **`orquestra:latest`** — do not use per-feature or per-version
image tags. Rollback is by git, not by image tag (`git checkout <commit> && docker
build -t orquestra:latest .`).

```sh
docker build -t orquestra:latest .
# then point docker-compose.yml's `image:` at `orquestra:latest`, or docker run it directly
```

Headless/CI with no dashboard? Run the terminal onboarding fallback:
`docker run -it --rm --env-file .env -v "$PWD/orquestra-data:/data" orquestra:latest configure`.
It produces a strategy like
[docs/examples/strategy.config.example.json](docs/examples/strategy.config.example.json).

Want to use a Claude Pro/Max subscription instead of a metered Anthropic API key? The token
must be minted by the first-party Claude CLI (Anthropic rejects a hand-rolled OAuth flow). The
Docker image does **not** include the `claude` CLI. Use whichever option fits:

**Option A — from a source checkout (needs `claude` CLI on PATH):**
```sh
npm install && npm run build
ORQUESTRA_DATA_DIR=./orquestra-data node dist/index.js login-anthropic
```

**Option B — manual token file (no build at all):**
```sh
claude setup-token   # opens browser auth, prints sk-ant-oat01-… token
echo '{"access_token":"sk-ant-oat01-PASTE_TOKEN_HERE"}' \
  > ./orquestra-data/anthropic-oauth.json
chmod 600 ./orquestra-data/anthropic-oauth.json
```

**Option C — Docker only (no Node.js and no `claude` CLI on the host):**

Mint the token in a throwaway container — `setup-token` prints an auth URL you can open in
any browser (even on another machine) and paste the code back:
```sh
docker run -it --rm node:22 npx -y @anthropic-ai/claude-code setup-token
```
Copy the printed `sk-ant-oat01-…` token, then write the credential file straight into the
running node's data volume and restart — no host tooling touched:
```sh
docker exec orquestra sh -c 'umask 077; printf %s "{\"access_token\":\"sk-ant-oat01-PASTE_TOKEN_HERE\"}" > /data/anthropic-oauth.json'
docker restart orquestra
```

All options write `anthropic-oauth.json` to the data dir the container reads. Then set
`LLM_PROVIDER=anthropic-oauth` and restart the node. Note: programmatic use of a consumer
subscription may violate Anthropic's terms (seat-ban risk) — see `.env.example`.

> **Pitfall:** don't create or edit the JSON in TextEdit / Notes / a chat app — smart-quote
> substitution (`“access_token”` instead of `"access_token"`) makes it invalid JSON, and the
> node then logs `LLM_PROVIDER=anthropic-oauth but no subscription is linked` even though the
> file looks fine. Verify it parses:
> ```sh
> docker exec orquestra node -e 'JSON.parse(require("fs").readFileSync("/data/anthropic-oauth.json","utf8")); console.log("valid")'
> ```

### After you start the node

The node is autonomous — once your strategy is confirmed there is nothing you need to do.
It runs a cycle on your configured cadence (e.g. every hour); each cycle it votes and mints
within your budget caps, and every action lands in the dashboard's **Activity** tab as it
happens. The first cycle starts shortly after onboarding completes, so the dashboard's
panels are empty until then.

- **Watch**: Activity tab (per-action log), overview cards (PnL, budget burn, emissions).
- **Adjust**: Strategy tab or the assistant chat — changes are validated and apply from the
  next cycle (config is hot-reloaded; nothing restarts).
- **Health**: `GET /api/health` on the dashboard port for scripted liveness checks.

## Develop

Requires Node ≥ 22.5 (`node:sqlite`).

- `npm install && npm --prefix web install`
- `npm test` — unit + integration suite (vitest)
- `npm run typecheck`
- `npm run build` — backend + the web dashboard

The `reppo` CLI must be on `PATH` for a locally-run node — **0.12.0 recommended**
(what the Docker image pins; voting quality degrades below 0.12 because older
CLIs don't surface pod descriptions). Hard minimum 0.8.0; the node warns at
startup on a version mismatch.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full dev loop, test
layout, and PR checklist.

## License

[MIT](LICENSE)
