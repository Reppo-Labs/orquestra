# orquestra one-pager — design spec

**Date:** 2026-06-08
**Status:** Approved design (brainstorming complete)
**Deliverable:** A single-page, non-technical explainer document for orquestra.

## Purpose & audience

A broad public-facing explainer that works for three overlapping audiences in one read:

1. **Potential node operators** — people who might run orquestra to earn $REPPO. Want "what's in it for me" + how to start.
2. **Investors / partners** — want the opportunity and why it matters strategically.
3. **General crypto-curious public** — start from near-zero; explain the whole concept plainly.

**The hook (dual):** *You earn $REPPO around the clock, and in doing so you help build the high-quality data that AI depends on.* "Do well by doing good." This is the spine of the page.

## Structure — Option A: story arc

Top-to-bottom narrative, one page:

1. **Title + subhead (the hook)** — "orquestra" + tagline ("Put a swarm of AI agents to work — earn $REPPO while helping build the data AI runs on"), plus a one-line plain restatement (runs on your own computer, works for you 24/7).

2. **The big idea (2–3 sentences)** — Modern AI is only as good as its data, and good data is scarce and hard to organize. Reppo is a network that rewards people for curating and contributing high-quality data. orquestra is the easiest way to join — and get paid for it.

3. **What orquestra is (plain definition)** — A program you run on your own machine. It puts a small team of AI agents to work on the Reppo network on your behalf. One setup, then it runs.

4. **What your agents actually do (jargon-free "how")** — Two jobs:
   - **Judge quality** (internally: voting/curation) — agents review data others submit and vote on what's good, helping the best rise.
   - **Contribute data** (internally: minting) — where the node has a data source, agents package and submit new high-quality data.
   - Both earn $REPPO when contributions prove valuable.

5. **What's in it for you** —
   - Earn around the clock (agents work while you sleep).
   - You stay in control: your own wallet, a budget *you* set in a friendly setup interview; agents can *propose* but never spend beyond your limits (the safety story in one line).
   - Set it and forget it: answer a few questions once; it runs on a schedule.

6. **The bigger picture (mission payoff)** — Every node makes the network's data better, which makes AI better. Running orquestra means you're part of a global, decentralized effort to give AI the quality data it needs.

7. **Get started (call to action)** — One line on how simple it is to begin + where to go next (link/command — destination TBD by Ana).

## Deliberate choices (confirmed with user)

- **Jargon policy:** keep `$REPPO`, `Reppo`, and "node"; translate `mint` / `vote` / `Datanet` / `veREPPO` into plain language.
- **No earnings figures:** stay qualitative. Earnings depend on the network and nothing is promised in the codebase — no "$X/month" claims.
- **Tone:** confident and warm, not hypey. No "guaranteed returns" language.

## Source of truth

Grounded in `docs/design/2026-06-02-orquestra-design.md` and `README.md`:
- orquestra = Reppo's official self-hostable agentic swarm node.
- Earns $REPPO **only** by publishing (minting) + voting — no compute/inference-selling path.
- Safety boundary: LLM agents propose intents; a deterministic budget/wallet manager is the only signer, bounded by hard caps the operator sets in onboarding. This is what backs the "agents can never overspend" claim — keep it accurate.
- Operator signs with their own wallet; budget set via an LLM onboarding interview.

## Open item

- **CTA destination** — the real link/command for "get started" is a placeholder until Ana provides it.
