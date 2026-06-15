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
 && npm i -g @reppo/cli@0.8.4
# @reppo/cli@0.8.4: emits gasEth in write results (real gas caps) + mint-pod
# --image-url / source-url as the pod's primary link (needed by this branch's
# image/source-url mint flow). 0.8.0 added datanet rubric metadata + epoch data.
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# DASHBOARD_HOST=0.0.0.0: inside a bridge-networked container the compose
# `127.0.0.1:7070:7070` mapping forwards to the container's bridge IP, so the server
# must bind all interfaces for the host-side localhost mapping to reach it. The bind
# is NOT the exposure boundary in Docker — the `127.0.0.1` host mapping is (ADR 0002).
# Outside Docker the code defaults to 127.0.0.1, so a bare `node` run stays loopback-only.
ENV ORQUESTRA_DATA_DIR=/data DASHBOARD_PORT=7070 DASHBOARD_HOST=0.0.0.0
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
