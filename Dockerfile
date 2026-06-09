FROM node:20-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/* \
 && npm i -g @reppo/cli@0.8.0
# @reppo/cli@0.8.0: datanet rubric metadata on `query datanet` + epoch data (current epoch).
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
ENV ORQUESTRA_DATA_DIR=/data
VOLUME /data
# Run as the unprivileged node user (ships with the base image). /data must be
# writable by it — `docker run -v` host dirs may need a one-time `chown -R 1000`.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
# Read-only dashboard (see DASHBOARD_PORT). Expose to localhost with `-p 127.0.0.1:7070:7070`.
EXPOSE 7070
# Liveness: the dashboard serves /api/health whenever the node process is up.
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD curl -fsS http://127.0.0.1:7070/api/health > /dev/null || exit 1
# First-run configure requires -it AND valid LLM_* env vars (onboarding is conversational).
ENTRYPOINT ["node", "dist/index.js"]
