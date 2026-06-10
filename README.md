# orquestra

Reppo's official agentic swarm node. Run a node on your machine: it curates
(votes) across any Datanet and mints where it has a data adapter, bounded by a
budget you set in an LLM onboarding interview, signing with your own wallet.

See `docs/design/2026-06-02-orquestra-design.md` for the architecture and
`docs/superpowers/specs/` for feature-level designs.

## Run a node

Prerequisites: Docker, a **dedicated** wallet funded with ETH (Base) and REPPO,
and an LLM API key (Anthropic, OpenAI, Google, Surplus, or Virtuals).

1. **Configure environment** — copy [.env.example](.env.example) to `.env` and
   fill it in. Every variable is documented inline; minimum: `REPPO_PRIVATE_KEY`,
   `LLM_PROVIDER`, `LLM_API_KEY`. Add `PINATA_JWT` if you want to mint.

2. **Build the image**

   ```sh
   docker build -t orquestra .
   ```

3. **First run — onboarding interview** (interactive; writes your strategy
   config into the data volume)

   ```sh
   mkdir -p ./orquestra-data
   docker run -it --rm --env-file .env \
     -v "$PWD/orquestra-data:/data" \
     orquestra configure
   ```

   An example of what it produces:
   [docs/examples/strategy.config.example.json](docs/examples/strategy.config.example.json).

4. **Run the node**

   ```sh
   docker run -d --name orquestra \
     --env-file .env \
     --restart unless-stopped \
     -p 127.0.0.1:7070:7070 \
     -v "$PWD/orquestra-data:/data" \
     orquestra
   ```

   - `-p 127.0.0.1:7070:7070` is **required to see the dashboard** — open
     http://127.0.0.1:7070. The `127.0.0.1` prefix keeps it off your network;
     the dashboard has no auth.
   - `--restart unless-stopped` brings the node back after crashes/reboots.
   - The container reports liveness via Docker healthcheck (`docker ps` shows
     `healthy` once the dashboard answers).

5. **Watch it work** — the dashboard shows balances, per-datanet cycle health,
   budget burn vs. your caps, and why any datanet is idle. Logs:
   `docker logs -f orquestra`.

### Safety model

- The node can never spend beyond the budget caps in your strategy config; the
  budget ledger refuses before signing, not after.
- Enabling a datanet (vote/mint) is the consent to pay its one-time subnet
  access grant; set `budget.grantReppoMax` to cap or disable grants.
- Use a dedicated wallet. The private key sits in `.env` in plaintext.

## Develop

- `npm install`
- `npm test` — unit + integration suite (vitest)
- `npm run typecheck`
- `npm run build`

The `reppo` CLI ≥ 0.8.0 must be on `PATH` for a locally-run node (the Docker
image pins it). The node checks at startup and warns on a version mismatch.

## License

[MIT](LICENSE)
