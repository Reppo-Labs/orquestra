# Orquestra

Reppo's official self-hosted agentic swarm node: it curates (votes on) and
publishes (mints) data pods across Reppo datanets on the operator's behalf.

## Language

**Node operator** (or **operator**):
The person who runs an Orquestra node on their own infrastructure and owns the
wallet it spends from. Primary audience is crypto-native and terminal-comfortable;
a semi-technical earner is the secondary, growth audience.
_Avoid_: user, customer, admin.

**Node**:
A single running Orquestra instance — one process, one wallet, one strategy
config, one data directory. Not a blockchain node and not the Reppo network.
_Avoid_: agent (reserve for the registered Reppo agent identity), instance, server.

**Onboarding**:
The first-run flow where an operator defines their strategy and the node writes
its initial config. Distinct from bootstrap setup (the secrets/env an operator
supplies before the node starts).
_Avoid_: configure (overloaded), setup, install.

**Bootstrap secrets**:
The credentials an operator supplies before the node starts — wallet key, LLM
key, RPC, pinning key. Supplied through the environment, never through the
dashboard (the dashboard needs them to exist in order to run).
_Avoid_: config (reserve for the strategy), settings.

**Strategy**:
The operator's configured intent — which datanets to vote/mint, budget caps,
cadence, deliberation, and the freeform brief. The thing onboarding produces and
the dashboard edits. Held in the node's data directory, hot-reloaded each cycle.
_Avoid_: config (when ambiguous with bootstrap secrets), settings, preferences.
