# --- Lokal: A2A Food Marketplace ---------------------------------
# Multi-stage build: tsc compiles src/ to dist/ in the build stage, and the
# runtime stage runs the compiled JavaScript with plain `node` (no tsx at boot).
# SQLite data persists via a mounted volume at /app/data.
# Dev-request: A2A dev-requests/2026-10-11-ferdigkompilert-js-i-imaget.md

# --- Stage 1: build ----------------------------------------------
FROM node:24.22.1-alpine AS build
WORKDIR /app

# better-sqlite3 needs build tools for native compilation
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

# Cache-bust the compile on every commit (same BUILD_REV as the runtime stage below).
ARG BUILD_REV=dev
RUN echo "build_rev=$BUILD_REV" > /app/.build-rev

COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/build-dist.js ./scripts/

# `npm run build` = `tsc --noEmit` (a type error fails the build) and then
# scripts/build-dist.js: per-file esbuild transpile of the files tsconfig
# compiles (no bundle; same transform tsx applies today, so imports placed
# mid-file keep working - tsc's own emit would crash at boot on them), with
# source maps for --enable-source-maps; copies src/public -> dist/public and
# src/**/*.json (src/data, i18n locales) -> dist/; fails if a required runtime
# file is missing. See the header of scripts/build-dist.js.
#
# src/_seeds is excluded in tsconfig.json and is therefore NOT in the image.
# Decision: seeding an empty DB is not part of the prod image. Prod always has
# the lokal_data volume with an existing DB. index.ts loads every ./_seeds/*
# module inside try/catch (and runs them only when the agents table is empty),
# so the missing modules are skipped and boot is not affected.
RUN npm run build

# Drop devDependencies (tsx, esbuild, ts-node, nodemon, ...). The native better-sqlite3
# binary built above stays, and the runtime stage uses the same base image, so
# it matches.
RUN npm prune --omit=dev

# --- Stage 2: runtime --------------------------------------------
FROM node:24.22.1-alpine AS runtime
WORKDIR /app

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Served from the repo root: index.ts sends path.join(__dirname, "..", "openapi.yaml").
COPY openapi.yaml ./
# Vertical config bundles (Phase 4.1) - read at boot via loadConfigsAtBoot()
# from process.cwd()/verticals. App refuses to start without verticals/rfb/config.yaml.
COPY verticals/ ./verticals/
# MCP stdio packages - server.json may be referenced by registry/build tooling.
# Neither mcp-server/ nor mcp-server-dental/ are required at runtime (they are
# npm packages published separately and invoked via npx by end users).
# We COPY them for consistency with rfb pattern and to allow server.json to be
# inspected from inside the container (e.g. by CI checks or registry validators).
COPY mcp-server/ ./mcp-server/
COPY mcp-server-dental/ ./mcp-server-dental/

# Build check: fail the image build if a file the running app needs is missing,
# if tsx is still installed, or if better-sqlite3 / uuid (ESM-only, loaded via
# require) cannot be loaded by the runtime node.
RUN for f in dist/index.js dist/public/app.html dist/data/local-orgnr-candidates.json \
      dist/data/kommune-fylke-2024.json dist/services/offthread-stats-worker.js \
      openapi.yaml verticals/rfb/config.yaml; do \
      [ -f "$f" ] || { echo "missing in image: $f" >&2; exit 1; }; \
    done \
 && [ ! -e node_modules/tsx ] \
 && node -e "require('better-sqlite3')(':memory:').prepare('select 1').get(); require('uuid').v4()"

# Cache-bust on every commit. Pass --build-arg BUILD_REV=$(git rev-parse HEAD)
# at deploy time so Fly's remote builder cannot reuse a stale build layer.
# Visibility report 2026-04-25 found ~3 weeks of accumulated source changes
# weren't actually reaching prod because the layer was cached.
ARG BUILD_REV=dev
LABEL build_rev=$BUILD_REV
ENV GIT_SHA=$BUILD_REV
RUN echo "build_rev=$BUILD_REV" > /app/.build-rev

# SQLite data directory (mount a volume here for persistence)
RUN mkdir -p /app/data
VOLUME /app/data

# Environment
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/lokal.db

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# node is PID 1 and receives SIGTERM directly (no npx/tsx in between).
CMD ["node", "--enable-source-maps", "dist/index.js"]
