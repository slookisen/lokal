# â”€â”€â”€ Lokal: A2A Food Marketplace â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Uses tsx for TypeScript execution (same as dev).
# SQLite data persists via a mounted volume at /app/data.

FROM node:20-alpine
WORKDIR /app

# better-sqlite3 needs build tools for native compilation
RUN apk add --no-cache python3 make g++

# Install all deps (tsx is needed for runtime)
COPY package*.json ./
RUN npm ci && apk del python3 make g++

# Cache-bust on every commit. Pass --build-arg BUILD_REV=$(git rev-parse HEAD)
# at deploy time so Fly's remote builder cannot reuse a stale `COPY src/` layer.
# Visibility report 2026-04-25 found ~3 weeks of accumulated source changes
# weren't actually reaching prod because the layer was cached.
ARG BUILD_REV=dev
LABEL build_rev=$BUILD_REV
ENV GIT_SHA=$BUILD_REV
RUN echo "build_rev=$BUILD_REV" > /app/.build-rev

# Copy source + public assets
COPY src/ ./src/
COPY tsconfig.json ./
COPY openapi.yaml ./
# Vertical config bundles (Phase 4.1) — read at boot via loadConfigsAtBoot().
# App refuses to start without verticals/rfb/config.yaml.
COPY verticals/ ./verticals/
# MCP stdio packages — server.json may be referenced by registry/build tooling.
# Neither mcp-server/ nor mcp-server-dental/ are required at runtime (they are
# npm packages published separately and invoked via npx by end users).
# We COPY them for consistency with rfb pattern and to allow server.json to be
# inspected from inside the container (e.g. by CI checks or registry validators).
COPY mcp-server/ ./mcp-server/
COPY mcp-server-dental/ ./mcp-server-dental/

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

CMD ["npx", "tsx", "src/index.ts"]
