FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY web/package*.json ./web/
RUN npm ci --prefix web
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build

FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/* \
 && npm i -g @reppo/cli@0.12.0
# @reppo/cli@0.12.0: `list pods --all` surfaces the pod's full description + media url —
# lets the voter score the real writeup instead of a client-rendered SPA shell (the node
# reads this in parsePods). 0.11.0: query datanet surfaces the per-mint publishing fee
# (publishingFeeREPPO/publishingFeePrimaryToken) — separate from and additional to
# the one-time access fee; lets the node pre-flight mint balance instead of eating a
# TransferAmountExceedsBalance revert. Also adds query voter-emissions-due (claimability
# pre-flight for claim-voter-emissions: voted && !claimed, no amount — V2 has no
# per-voter due-amount view). 0.10.0: adds claim-voter-emissions (claimVoterEmissions) so
# the node can collect the VOTER share earned for curating other operators' pods —
# previously unclaimable (claim-emissions covers only the pod-owner share). 0.9.0: lock
# + grant-access auto-approve the ERC20 allowance (unlimited
# approve() + wait when short) so an operator never has to send approve() by hand —
# removes the manual-cast onboarding blocker. 0.8.6: grant-access --token primary (pay
# a datanet's access fee in its primary token, e.g. $EXY) + query datanet surfaces
# primaryToken {address, symbol, decimals} + approve --token <addr>. Gates the node's
# non-REPPO access path (NONREPPO_GRANT_MIN_VERSION=0.8.5). 0.8.4 added gasEth in write
# results; 0.8.0 added datanet rubric metadata + epoch data.
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# The dashboard bind is NOT set here on purpose: the code defaults to 127.0.0.1
# (loopback), so a bare `docker run -p 7070:7070 <image>` does NOT expose the
# unauthenticated panel (ADR 0002). The provided docker-compose.yml sets
# DASHBOARD_HOST=0.0.0.0 itself, because its `127.0.0.1:7070:7070` host mapping forwards
# to the container's bridge IP — there the host mapping is the exposure boundary, and
# the override lives next to it. Do NOT bake 0.0.0.0 into the image default.
ENV ORQUESTRA_DATA_DIR=/data DASHBOARD_PORT=7070
# Ownership BEFORE `VOLUME /data` — filesystem changes after a VOLUME declaration
# are discarded by some builders (kaniko, buildah, legacy). With this ordering the
# anonymous-volume case is owned by `node`; a host bind-mount may still need a
# one-time `chown -R 1000` on the host dir.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME /data
# Run as the unprivileged node user (ships with the base image).
USER node
# Read-only dashboard. Expose to localhost with `-p 127.0.0.1:7070:7070`.
EXPOSE 7070
# Liveness: the dashboard serves /api/health whenever the node process is up.
# Honors DASHBOARD_PORT so a custom port still passes the probe.
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD curl -fsS "http://127.0.0.1:${DASHBOARD_PORT}/api/health" > /dev/null || exit 1
# First-run configure requires -it AND valid LLM_* env vars (onboarding is conversational).
ENTRYPOINT ["node", "dist/index.js"]
