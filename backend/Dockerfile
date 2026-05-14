# syntax=docker/dockerfile:1.7

# ---- builder --------------------------------------------------------------
FROM node:20-alpine AS builder

# better-sqlite3 ships prebuilt binaries for node 20 + linux-musl (alpine),
# but we keep build-deps handy in case a future version ships only source.
RUN apk add --no-cache python3 make g++ libc6-compat

WORKDIR /app

# Install deps first for better Docker layer caching.
COPY package.json package-lock.json* ./
RUN npm ci

# Copy sources and compile TypeScript.
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
RUN npm run build

# ---- runner ---------------------------------------------------------------
FROM node:20-alpine AS runner

# sqlite CLI is useful for debugging inside the container.
# chromium + fonts: required by puppeteer-core for the tailored-CV PDF
# rendering pipeline (see lib/pdf.ts). We install Alpine's chromium and
# point puppeteer at it via PUPPETEER_EXECUTABLE_PATH — much smaller than
# letting puppeteer download its own bundled chromium during npm install.
RUN apk add --no-cache \
      sqlite \
      libc6-compat \
      chromium \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      ttf-freefont \
      font-noto-emoji

# Skip chromium download — we use the Alpine binary above.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
# Omit dev deps, keep prod deps (better-sqlite3, hono, puppeteer-core, etc).
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled code and migrations.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations

# Persistent data dir. In Dokploy this is the mount point for the SQLite file.
RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 8787

# Run migrations then start the server. Migrations are idempotent
# (schema_migrations table).
CMD ["sh", "-c", "node dist/scripts/migrate.js && node dist/server.js"]
