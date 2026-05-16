# syntax=docker/dockerfile:1.6
# Lokal Render Worker — multi-stage build on the official Playwright image.
# The base image already includes Chromium and all required system libs.

# ── Stage 1: build TypeScript ────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.45.0-jammy AS builder

WORKDIR /app

# Install dependencies (use full deps including dev for tsc)
COPY package.json package-lock.json* ./
RUN npm install --include=dev --no-audit --no-fund

# Copy sources and build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop devDeps for the final image
RUN npm prune --omit=dev

# ── Stage 2: runtime ─────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.45.0-jammy AS runtime

ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app

# Copy compiled output and pruned node_modules from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# The base image ships with a non-root `pwuser` account.
USER pwuser

EXPOSE 8080

CMD ["node", "dist/index.js"]
