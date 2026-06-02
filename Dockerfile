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
 && npm i -g @reppo/cli@latest
# TODO: pin to @reppo/cli@^0.7.0 once published — 0.7.0 exposes datanet rubric
# metadata on `query datanet`; @latest is 0.6.x today (rubric loader needs >=0.7.0).
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
ENV ORQUESTRA_DATA_DIR=/data
VOLUME /data
ENTRYPOINT ["node", "dist/index.js"]
