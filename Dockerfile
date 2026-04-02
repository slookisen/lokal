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

# Copy source + public assets
COPY src/ ./src/
COPY tsconfig.json ./
COPY openapi.yaml ./

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
