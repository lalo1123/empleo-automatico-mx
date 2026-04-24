# Empleo Automático MX — Landing + Dashboard

Marketing site and user dashboard for **Empleo Automático MX** (by SkyBrandMX).

- Framework: Next.js 15 (App Router) with React Server Components
- Language: TypeScript strict
- Styling: Tailwind CSS v4 (inline `@theme`)
- Hosting: Docker container on **Dokploy** (Hostinger VPS `82.180.133.248`)
- Contract: `../COMMERCIAL.md` is the single source of truth for the backend API contract and pricing.

This app is the **public face** — signup, login, dashboard, pricing, legal pages. The extension and the Hono/Node backend live in sibling directories and are out of scope here.

---

## Prerequisites

- **Node.js 20+** and **npm** (for local dev)
- **Docker** (optional locally; required on the Dokploy host)
- The backend running somewhere (by default `http://localhost:8787/v1`). Without it, login/signup will return a `NETWORK_ERROR` banner — the marketing pages still render fine.

## Setup (local development)

```bash
cd landing
npm install
cp .env.example .env.local
# edit .env.local — uncomment the dev values at the bottom of the file
npm run dev
```

Open http://localhost:3000.

### Scripts

| Command             | What it does                                   |
| ------------------- | ---------------------------------------------- |
| `npm run dev`       | Next dev server on port 3000                   |
| `npm run build`     | Production build (emits `.next/standalone`)    |
| `npm run start`     | Serve the production build                     |
| `npm run typecheck` | `tsc --noEmit` — strict type check             |
| `npm run lint`     | `next lint`                                    |

### Build the Docker image locally

```bash
cd landing
docker build \
  --build-arg NEXT_PUBLIC_API_URL=https://api.empleo.skybrandmx.com/v1 \
  --build-arg NEXT_PUBLIC_SITE_URL=https://empleo.skybrandmx.com \
  -t empleo-landing .

docker run --rm -p 3000:3000 \
  -e AUTH_COOKIE_DOMAIN=localhost \
  empleo-landing
```

## Environment variables

See `.env.example`. There are **two categories**:

| Variable                | Category            | Example                                   | Notes                                                           |
| ----------------------- | ------------------- | ----------------------------------------- | --------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL`   | **Build arg**       | `https://api.empleo.skybrandmx.com/v1`    | Inlined into the client JS at `next build`. Must be a build arg. |
| `NEXT_PUBLIC_SITE_URL`  | **Build arg**       | `https://empleo.skybrandmx.com`           | Inlined into metadata / OG tags / sitemap.                      |
| `AUTH_COOKIE_DOMAIN`    | **Runtime env**     | `.skybrandmx.com` (prod), `localhost` (dev) | Server-side only; safe to change without rebuild.              |
| `NODE_ENV`              | **Runtime env**     | `production`                              | Set by the Dockerfile runner stage by default.                  |

**Why the distinction**: `NEXT_PUBLIC_*` values are baked into the compiled client bundle during `next build`. Changing them later requires rebuilding the image. Everything else (cookie domain, etc.) is read from `process.env` at request time and can be swapped by restarting the container.

The JWT lives in an **httpOnly cookie** (`skybrand_session`). Browser JS cannot read it — all authenticated calls go through server actions or `/app/api/*` route handlers.

## Deployment (Dokploy + Hostinger VPS)

Target host: `82.180.133.248`, Dokploy UI at `https://<your-dokploy-host>`.

### 1. Push the code

```bash
git add landing/
git commit -m "landing: pivot to Dokploy"
git push origin main
```

### 2. Create the Application in Dokploy

1. Dokploy UI → **Create Application** → type: **Application**.
2. **Source**: Git. Point at the repo and branch (e.g. `main`).
3. **Build type**: `Dockerfile`.
4. **Base directory**: `landing/` (monorepo — Dokploy must build from this subfolder).
5. **Dockerfile path**: `Dockerfile` (relative to base directory).

### 3. Configure environment

In the Application's **Environment** tab:

**Build Args** (baked into the image at `docker build`):
```
NEXT_PUBLIC_API_URL=https://api.empleo.skybrandmx.com/v1
NEXT_PUBLIC_SITE_URL=https://empleo.skybrandmx.com
```

**Runtime Env** (injected at container start):
```
NODE_ENV=production
AUTH_COOKIE_DOMAIN=.skybrandmx.com
```

### 4. Set the domain

In the Application's **Domains** tab:

- **Host**: `empleo.skybrandmx.com`
- **Container port**: `3000`
- **HTTPS**: on (Dokploy provisions a Let's Encrypt cert via Traefik automatically)

### 5. Health check

The app exposes `GET /api/health` returning `{ ok: true, service: "landing", ts: ... }` with status `200`. Set that as the readiness probe path in Dokploy → **Advanced** → Health check. A root `GET /` also returns 200.

### 6. DNS (Hostinger hPanel)

Create an **A record** in the `skybrandmx.com` zone:

```
Type: A
Host: empleo
Value: 82.180.133.248
TTL:  14400 (or default)
```

Propagation is typically a few minutes. Once DNS resolves, Dokploy will issue the Let's Encrypt cert on the first HTTPS request.

### 7. Deploy

Click **Deploy** in Dokploy. On success the container is up and `https://empleo.skybrandmx.com` should return 200.

### 8. Subdomain layout (per `COMMERCIAL.md`)

- `empleo.skybrandmx.com` → this Next.js app (landing + dashboard)
- `api.empleo.skybrandmx.com` → Node/Hono backend (separate Dokploy app, other agent)
- `skybrandmx.com` (apex) → reserved for the SkyBrandMX mother brand (independent)
- The Chrome extension talks to both via `chrome-extension://<ID>`, whitelisted in the backend CORS.

## Integration points with the backend

These are the endpoints this app calls (see `lib/api.ts`). They must be live before the app is fully functional:

| Endpoint                        | Method | Called from                    | Fails gracefully? |
| ------------------------------- | ------ | ------------------------------ | :---------------: |
| `/v1/auth/signup`               | POST   | `/signup` server action        | yes (error banner)|
| `/v1/auth/login`                | POST   | `/login` server action         | yes               |
| `/v1/auth/logout`               | POST   | `/account` logout action       | yes (clears cookie even on failure) |
| `/v1/account`                   | GET    | `/account`, `/account/billing` | no — page shows error state        |
| `/v1/billing/checkout`          | POST   | `/account/billing` form        | yes               |
| `/v1/billing/cancel`            | POST   | `/account` cancel button       | yes               |

## File tree

```
landing/
├── Dockerfile                    multi-stage Next.js standalone image
├── .dockerignore
├── app/
│   ├── layout.tsx                root: Inter font, metadata, viewport
│   ├── globals.css               Tailwind v4 @theme tokens
│   ├── page.tsx                  marketing landing
│   ├── icon.svg                  branded favicon rendered by Next
│   ├── sitemap.ts                /sitemap.xml
│   ├── robots.ts                 /robots.txt
│   ├── not-found.tsx             404
│   ├── privacy/page.tsx          LFPDPPP aviso de privacidad
│   ├── terms/page.tsx            términos y condiciones
│   ├── signup/page.tsx           server action signup
│   ├── login/page.tsx            server action login
│   ├── account/page.tsx          dashboard
│   ├── account/billing/page.tsx  contratar Pro/Premium
│   ├── account/success/page.tsx  post-checkout de Conekta
│   └── api/
│       ├── health/route.ts       GET /api/health — liveness probe
│       ├── auth/login/route.ts   JSON proxy (browser clients)
│       ├── auth/signup/route.ts
│       ├── auth/logout/route.ts
│       └── me/route.ts           GET account info
├── components/
│   ├── nav.tsx
│   ├── footer.tsx
│   ├── cta.tsx
│   ├── feature-card.tsx
│   ├── pricing-table.tsx
│   ├── faq.tsx
│   └── testimonial.tsx
├── lib/
│   ├── api.ts                    fetch wrapper for backend
│   ├── auth.ts                   httpOnly cookie helpers (server-side)
│   └── plans.ts                  plan catalog (mirrors backend/src/lib/plans.ts)
├── public/
│   └── favicon.ico               placeholder
├── next.config.ts                output: "standalone"
├── tsconfig.json
├── postcss.config.mjs
├── package.json
├── .env.example
└── .gitignore
```

## Things to finish before public launch

1. Replace the `[RFC pendiente]` and `[Dirección pendiente]` placeholders in `app/privacy/page.tsx`.
2. Replace the illustrative beta testimonials in `app/page.tsx` with real testimonials (with written authorization).
3. Replace `PLACEHOLDER_EXTENSION_ID` in `app/account/page.tsx` once the extension is published to the Chrome Web Store.
4. Swap `public/favicon.ico` for a real binary `.ico` export of `app/icon.svg`.
5. Legal review of `app/terms/page.tsx` (limits of liability, refund clause compatibility with Profeco, CDMX jurisdiction).
6. Confirm `AUTH_COOKIE_DOMAIN=.skybrandmx.com` in production Dokploy env vars before switching DNS.

## Notes

- Copy is in Spanish MX. Code and comments are in English.
- UI does not use emojis except in microcopy CTAs.
- No analytics libraries installed — add PostHog/GA4 in a later milestone.
- No component libraries (no shadcn, no Radix). Plain Tailwind + HTML `<details>` for the FAQ accordion.
