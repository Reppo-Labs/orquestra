# Security Policy

Orquestra runs an autonomous node that signs on-chain transactions with an
operator-supplied wallet key. Please treat security issues accordingly.

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report privately via one of:

- GitHub **Security Advisories** → "Report a vulnerability" on this repository, or
- email **security@reppo.xyz**

Please include reproduction steps, affected version (image tag or commit), and
the impact you observed. We aim to acknowledge within 3 business days.

## Supported versions

Beta moves fast; only the latest published image
(`ghcr.io/reppo-labs/orquestra:latest`) and `main` receive security fixes.
Pin a version tag in production and update promptly when a fix ships.

## Threat model (what protects an operator)

- **Budget caps are the real spend boundary.** The wallet key sits in `.env` in
  plaintext, so use a **dedicated** wallet. The budget ledger refuses to sign
  before a cap would be exceeded (`src/wallet/`); never weaken this.
- **The dashboard is unauthenticated and localhost-bound by design** (ADR 0002).
  Outside Docker it binds `127.0.0.1`; the published image binds `0.0.0.0` and
  relies on the compose `127.0.0.1:7070:7070` mapping. Reach it over an SSH
  tunnel — never expose port 7070 to a network without adding authentication.
- **Secrets come from the environment only**, are never read from the dashboard,
  and are redacted before logging (`src/util/redact.ts`).
- **Datanet rubric/pod text is untrusted** third-party input and is fenced from
  the LLM as data, not instructions (`src/llm/prompt.ts`).

If you find a way to make the node spend beyond its configured caps, expose the
dashboard write endpoints, or leak the wallet key, that is a high-severity issue —
please report it privately.
