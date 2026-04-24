# syntax=docker/dockerfile:1.7
#
# Multi-stage Next.js 15 standalone build for Empleo Automático MX landing.
# Targets Dokploy on Hostinger VPS. `next.config.ts` must set
# `output: "standalone"` so `.next/standalone/server.js` is produced.
#
# `NEXT_PUBLIC_*` values are inlined into the client bundle at build time,
# so they MUST be provided as Docker build args (Dokploy: "Build Args"),
# NOT just at runtime. Runtime-only secrets (AUTH_COOKIE_DOMAIN, etc.) are
# passed to the runner stage by Dokploy's env var injection at container
# start — no need to bake them into the image.

# ---------- deps ----------
FROM node:20-alpine AS deps
WORKDIR /app

# libc6-compat is occasionally needed by Next's swc binary on Alpine.
RUN apk add --no-cache libc6-compat

COPY package.json package-lock.json* ./
RUN npm ci

# ---------- builder ----------
FROM node:20-alpine AS builder
WORKDIR /app

# Public env vars must be set BEFORE `next build` so they're inlined into
# the client JS bundles. Dokploy passes these as build args.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build

# ---------- runner ----------
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Non-root user for the running container.
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# `public/` is NOT bundled into `.next/standalone`, so copy it explicitly.
COPY --from=builder /app/public ./public

# Standalone output + pre-rendered static assets.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
