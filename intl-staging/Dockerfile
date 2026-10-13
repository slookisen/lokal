# syntax=docker/dockerfile:1.6
# rfb-intl-staging — standalone SE/DK staging service (separate Fly app, not prod).
FROM node:22-bookworm-slim AS builder
WORKDIR /app
# better-sqlite3 ships prebuilt binaries; the toolchain is only a fallback.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && mkdir -p dist/data && cp src/data/*.json dist/data/
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
EXPOSE 8080
CMD ["node", "dist/index.js"]
