# orquestra

Reppo's official agentic swarm node. Run a node on your machine: it curates
(votes) across any Datanet and mints where it has a data adapter, bounded by a
budget you set in an LLM onboarding interview, signing with your own wallet.

**New operator? Read the [Operator Guide](docs/operator-guide.md)** — install,
onboarding, the dashboard, earning, and troubleshooting, end to end.

See `docs/design/2026-06-02-orquestra-design.md` for the architecture,
`docs/adr/` for key decisions, and `docs/superpowers/specs/` for feature designs.

## Run a node

Prerequisites: Docker (with Compose), a **dedicated** wallet funded with ETH
(Base) and REPPO, and an LLM API key (Anthropic, OpenAI, Google, Surplus, or
Virtuals).

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

4. **Watch it work** — the dashboard shows balances, per-datanet cycle health,
   budget burn vs. your caps, panel deliberations, and why any datanet is idle.
   Logs: `docker compose logs -f`.

**Updating:** `docker compose pull && docker compose up -d`.

### Safety model

- The node can never spend beyond the budget caps in your strategy config; the
  budget ledger refuses before signing, not after.
- Enabling a datanet (vote/mint) is the consent to pay its one-time subnet
  access grant; set `budget.grantReppoMax` to cap or disable grants.
- Use a dedicated wallet. The private key sits in `.env` in plaintext.
- The dashboard is **unauthenticated** and bound to localhost on purpose
  ([ADR 0002](docs/adr/0002-dashboard-unauthenticated-localhost-bind.md)). Reach
  it via the SSH tunnel above — never publish port 7070 to the internet, or
  anyone could rewrite your strategy and spend your budget.

### Build from source / audit

The published image is built from this repo's `Dockerfile`. To build and run it
yourself instead of pulling:

```sh
docker build -t orquestra .
# then point docker-compose.yml's `image:` at `orquestra`, or docker run it directly
```

Headless/CI with no dashboard? Run the terminal onboarding fallback:
`docker run -it --rm --env-file .env -v "$PWD/orquestra-data:/data" orquestra configure`.
It produces a strategy like
[docs/examples/strategy.config.example.json](docs/examples/strategy.config.example.json).

## Develop

- `npm install`
- `npm test` — unit + integration suite (vitest)
- `npm run typecheck`
- `npm run build`

The `reppo` CLI ≥ 0.8.0 must be on `PATH` for a locally-run node (the Docker
image pins it). The node checks at startup and warns on a version mismatch.

## License

[MIT](LICENSE)
