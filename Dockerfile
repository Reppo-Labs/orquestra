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
 && npm i -g @reppo/cli@0.7.0
# @reppo/cli@0.7.0 is required: it exposes datanet rubric metadata on `query datanet`.
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
ENV ORQUESTRA_DATA_DIR=/data
VOLUME /data
# First-run configure requires -it AND valid LLM_* env vars (onboarding is conversational).
ENTRYPOINT ["node", "dist/index.js"]
