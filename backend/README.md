# Empleo Automatico MX - Backend API

API HTTP que sirve al landing y a la extension. Corre en **Node.js 20** con
**Hono + @hono/node-server**, persiste en **SQLite** (better-sqlite3) sobre un
volumen persistente, y se despliega con **Docker** en **Dokploy** (VPS
Hostinger `82.180.133.248`).

- Framework: Hono (TypeScript, ESM)
- Auth: JWT HS256 + bcrypt (`jsonwebtoken`, `bcryptjs`)
- Pagos: **Conekta** (suscripciones recurrentes)
- IA: Google Gemini (server-side key)
- DB: SQLite via `better-sqlite3` (archivo en `/app/data/empleo.db`)

Dominio de prod: `https://api.empleo.skybrandmx.com`

---

## 1. Requisitos previos

- **Node.js 20+** instalado localmente
- **Docker** (para construir y probar la imagen local)
- Cuenta de **Conekta** con credenciales test (desarrollo) y live (prod)
- **API key de Gemini** (Google AI Studio -> "Get API key")
- Acceso al panel **Dokploy** del VPS: `http://82.180.133.248:3000`

## 2. Instalacion local

```bash
cd backend
npm install
cp .env.example .env
# Edita .env con tus valores reales
npm run dev
```

Queda corriendo en `http://localhost:8787`. Prueba el health check:

```bash
curl http://localhost:8787/healthz
# {"ok":true,"version":"0.2.0","now":1756890000}
```

## 3. Variables de entorno

| Variable                      | Tipo    | Descripcion |
|-------------------------------|---------|-------------|
| `NODE_ENV`                    | string  | `production` o `development` |
| `PORT`                        | number  | default `8787` |
| `DATABASE_PATH`               | path    | SQLite file, default `./data/empleo.db`; en prod `/app/data/empleo.db` |
| `JWT_SECRET`                  | secret  | HS256 signing key. 32 bytes hex. `openssl rand -hex 32` |
| `GEMINI_API_KEY`              | secret  | Google AI Studio |
| `GEMINI_MODEL`                | string  | ej. `gemini-2.5-flash` |
| `CONEKTA_API_KEY`             | secret  | Conekta dashboard -> Configuracion -> API keys (private) |
| `CONEKTA_WEBHOOK_KEY`         | secret  | Conekta dashboard -> Webhooks -> Clave privada del webhook |
| `CONEKTA_PLAN_PRO_MONTHLY`    | string  | plan_id generado en Conekta Planes |
| `CONEKTA_PLAN_PRO_YEARLY`     | string  | idem |
| `CONEKTA_PLAN_PREMIUM_MONTHLY`| string  | idem |
| `CONEKTA_PLAN_PREMIUM_YEARLY` | string  | idem |
| `FRONTEND_BACK_URL`           | url     | Adonde Conekta regresa al usuario post-checkout |
| `CORS_ORIGINS`                | csv     | origenes permitidos, separados por coma |

## 4. Scripts npm

| Script             | Para que |
|--------------------|----------|
| `npm run dev`      | Dev server con tsx watch (`src/server.ts`) |
| `npm run build`    | Compila TypeScript a `dist/` |
| `npm run start`    | Corre el server compilado (`dist/server.js`) |
| `npm run migrate`  | Aplica migraciones SQL sobre `DATABASE_PATH` |
| `npm run migrate:dev` | Igual pero con tsx sin compilar |
| `npm run typecheck`| `tsc --noEmit` |

## 5. Configurar planes en Conekta

1. Conekta dashboard -> **Planes -> Nuevo plan**.
2. Crea 4 planes (todos MXN, recurring):
   - **Pro mensual**: $299 MXN, intervalo `month`.
   - **Pro anual**: $2,990 MXN, intervalo `year`.
   - **Premium mensual**: $499 MXN, intervalo `month`.
   - **Premium anual**: $4,990 MXN, intervalo `year`.
3. Copia el `plan_id` de cada uno y pegalos en las env vars correspondientes.

## 6. Probar localmente con Docker

```bash
docker compose up --build
```

Monta un volumen `empleo-data` con la base en `/app/data`. Expone `:8787`.

---

## 7. Despliegue en Dokploy

### 7.1 Push del repo

```bash
git add .
git commit -m "Backend: switch to Node + SQLite + Conekta + Dokploy"
git push origin main
```

### 7.2 Crear la aplicacion en Dokploy

1. Abre `http://82.180.133.248:3000` e inicia sesion.
2. **Projects -> [tu proyecto] -> Create Application**.
3. **Source**: Git. Apunta al repo (GitHub o GitLab). Branch `main`. Root
   path: `/backend`.
4. **Build type**: **Dockerfile**. Dokploy detecta automaticamente el
   `Dockerfile` en `backend/`.
5. **Port**: `8787`.

### 7.3 Variables de entorno

En la pantalla **Environment Variables** de la app, agrega:

```
NODE_ENV=production
PORT=8787
DATABASE_PATH=/app/data/empleo.db
JWT_SECRET=<genera con `openssl rand -hex 32`>
GEMINI_API_KEY=<tu key de AI Studio>
GEMINI_MODEL=gemini-2.5-flash
CONEKTA_API_KEY=<conekta LIVE api key>
CONEKTA_WEBHOOK_KEY=<conekta webhook private key>
CONEKTA_PLAN_PRO_MONTHLY=<plan id>
CONEKTA_PLAN_PRO_YEARLY=<plan id>
CONEKTA_PLAN_PREMIUM_MONTHLY=<plan id>
CONEKTA_PLAN_PREMIUM_YEARLY=<plan id>
FRONTEND_BACK_URL=https://empleo.skybrandmx.com/account?sub=success
CORS_ORIGINS=https://empleo.skybrandmx.com,https://skybrandmx.com,chrome-extension://*,http://localhost:3000,http://localhost:5173
```

### 7.4 Volumen persistente

1. **Volumes** (o **Mounts**) -> **Add Volume**.
2. Tipo: **Volume** (named) o **Bind mount**.
3. **Mount path**: `/app/data`.
4. **Volume name**: `empleo-data` (o el que prefieras).

Sin este volumen la base se pierde cada redeploy.

### 7.5 Dominio + HTTPS

1. **Domains -> Add Domain**.
2. Host: `api.empleo.skybrandmx.com`.
3. Container port: `8787`.
4. **HTTPS**: ON. **Certificate**: Let's Encrypt. Dokploy provisiona el cert
   automaticamente via Traefik.

### 7.6 DNS

En Hostinger hPanel -> **DNS zone editor** del dominio `skybrandmx.com`:

```
Type   Name         Value                TTL
A      api.empleo   82.180.133.248       300
```

Espera ~5 min a que propague.

### 7.7 Deploy

Clic en **Deploy** en Dokploy. El primer build compila TypeScript e instala
`better-sqlite3` (prebuilt para node 20 alpine). El `CMD` corre migraciones
antes del `node dist/server.js`, asi que las tablas estan listas en el primer
arranque.

### 7.8 Verificacion post-deploy

```bash
curl https://api.empleo.skybrandmx.com/healthz
# -> {"ok":true,"version":"0.2.0","now":<unix>}

curl https://api.empleo.skybrandmx.com/
# -> {"ok":true,"service":"skybrandmx-empleo-api","env":"production","version":"0.2.0"}
```

### 7.9 Webhook de Conekta

1. Conekta dashboard -> **Webhooks -> Nuevo webhook**.
2. URL: `https://api.empleo.skybrandmx.com/v1/webhooks/conekta`
3. Eventos: marca al menos:
   - `subscription.created`
   - `subscription.paid`
   - `subscription.payment_failed`
   - `subscription.canceled`
   - `subscription.expired`
4. Copia la **Clave privada del webhook** y ponla en `CONEKTA_WEBHOOK_KEY`
   (Dokploy -> env vars -> Redeploy).

Conekta firma el body con HMAC-SHA1 en el header `Digest: SHA1=<hex>`. El
backend valida antes de procesar; cualquier request sin firma valida es
rechazado con 401 `WEBHOOK_SIGNATURE_INVALID`.

---

## Estructura del proyecto

```
backend/
|-- src/
|   |-- app.ts                   - Hono app factory
|   |-- server.ts                - Node entry (@hono/node-server + shutdown)
|   |-- types.ts                 - domain types
|   |-- middleware/
|   |   |-- auth.ts              - JWT verify + attach user
|   |   |-- cors.ts              - whitelist origins (skybrandmx.com, localhost, extension)
|   |   |-- rate-limit.ts        - in-memory bucket for /auth/*
|   |-- routes/
|   |   |-- auth.ts              - signup, login, logout
|   |   |-- account.ts           - GET /account
|   |   |-- applications.ts      - generate, parse-cv
|   |   |-- billing.ts           - checkout, cancel (Conekta)
|   |   |-- webhooks.ts          - /conekta
|   |-- lib/
|   |   |-- env.ts               - process.env reader + Zod validation + AppContext
|   |   |-- db.ts                - better-sqlite3 singleton + typed queries
|   |   |-- jwt.ts               - sign/verify HS256 (jsonwebtoken)
|   |   |-- password.ts          - bcryptjs
|   |   |-- gemini.ts            - Gemini client (server-side key)
|   |   |-- conekta.ts           - Conekta REST client + Digest signature verify
|   |   |-- plans.ts             - plan prices + plan_id lookup
|   |   |-- usage.ts             - monthly metering
|   |   |-- errors.ts            - HttpError + codes
|   |-- scripts/
|       |-- migrate.ts           - runs all .sql files in ./migrations (idempotent)
|-- migrations/
|   |-- 0001_init.sql             - schema inicial (users, sessions, subscriptions,
|                                    usage_monthly, webhook_events, schema_migrations)
|-- Dockerfile                    - multi-stage, node:20-alpine
|-- .dockerignore
|-- docker-compose.yml            - local testing con volumen persistente
|-- .env.example
|-- package.json
`-- tsconfig.json
```

## Seguridad

- **Passwords**: bcryptjs con cost 10.
- **JWT**: 30 dias, JTI unico por sesion, revocable en `sessions.revoked`.
- **CORS**: whitelist estricta (dominios skybrandmx.com + `chrome-extension://*` + localhost).
- **Gemini key**: solo en `env.GEMINI_API_KEY`, jamas expuesta al cliente.
- **Webhooks Conekta**: HMAC-SHA1 sobre el raw body, comparacion constant-time.
- **Idempotencia**: `webhook_events.id` (PK) deduplica eventos re-enviados.
- **SQL**: 100% prepared statements (`db.prepare(...).get/run/all`).
- **PII**: nunca se loguean emails, contrasenas, contenido de CVs ni cartas.
  Solo meta: user_id, accion, estado, ids de vacante.

## Que NO incluye este MVP

- Verificacion de email (se agregara con Resend en fase 2).
- Recuperacion de contrasena.
- Admin dashboard.
- Email transaccional.

---

## Checklist para el director despues de desplegar

1. `curl https://api.empleo.skybrandmx.com/healthz` -> `{"ok":true}`
2. Signup via `POST /v1/auth/signup` devuelve JWT y `users` tiene la fila.
3. Login via `POST /v1/auth/login` funciona y genera nueva sesion.
4. `GET /v1/account` con Bearer devuelve `{ user, usage }`.
5. `POST /v1/applications/parse-cv` con un CV de prueba devuelve `profile`
   (valida que Gemini esta conectado).
6. `POST /v1/billing/checkout` con `{plan:"pro",interval:"monthly"}` devuelve
   una URL de Conekta Checkout. Completar el pago en sandbox debe disparar
   `subscription.created` y actualizar la suscripcion a `active`.
7. Webhook de Conekta: dispara evento de prueba desde el dashboard y verifica
   que `webhook_events` tiene la fila con `processed=1`.
8. Reinicia el container - la DB sobrevive (volumen persistente OK).
