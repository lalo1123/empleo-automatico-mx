# Empleo Automático MX — Especificación Comercial (SkyBrandMX)

> **Contrato entre módulos comerciales.** Los agentes que implementen backend, landing y el refactor de la extensión deben respetar todo lo que está aquí. Si algo no cuadra, preguntar al director antes de cambiarlo.

## Marca y producto

- **Marca**: SkyBrandMX
- **Producto**: Empleo Automático MX
- **Propuesta de valor** (una línea): "Postúlate a 20 empleos en 10 minutos — IA genera cartas personalizadas por vacante en OCC, Computrabajo y LinkedIn."
- **Tagline corto**: "Tu copiloto de búsqueda de empleo."
- **URL objetivo**: `skybrandmx.com` o `empleo.skybrandmx.com` (usuario decide)
- **Fundadora/dueño**: usuario (persona física con actividad empresarial o moral bajo SkyBrandMX)

## Modelo de negocio

### Tiers de precios

| Plan      | Precio (MXN/mes) | Postulaciones/mes | Target                            |
|-----------|------------------|-------------------|-----------------------------------|
| Gratis    | $0               | 3                 | Trial para validar funcionalidad  |
| Pro       | $199             | 100               | Usuario activo en búsqueda        |
| Premium   | $399             | Ilimitado         | Búsqueda intensiva / job-hoppers  |

**Anualidad**: descuento de 2 meses (Pro $1,990/año, Premium $3,990/año) — habilitar en fase 2.

### Economía unitaria

- Costo variable por postulación completa (cover + CV optimizado + Q&A + auto-quiz): **~$0.019 USD** (~$0.38 MXN)
- Costo fijo infra (Hostinger VPS via Dokploy): ~$15 USD/mes
- Pro @ 100 post/mes = $1.90 USD costo variable → precio $299 MXN (~$15 USD) → **margen ~77% neto** (después de Conekta 5%)
- Premium @ 500 post/mes (soft cap, 30/día) = $9.50 USD costo → precio $499 MXN (~$25 USD) → **margen ~64% neto**

## Stack técnico (decidido por director — no cambiar sin discutir)

### Backend
- **Runtime**: Node.js 20+ (self-hosted)
- **Framework**: Hono con `@hono/node-server`
- **Database**: SQLite (archivo en volumen persistente de Dokploy) — `better-sqlite3`
- **Auth**: JWT (HS256) con bcrypt para passwords
- **Payments**: **Conekta** (suscripciones recurrentes con cards, OXXO, SPEI)
- **Email transaccional**: SKIP para MVP
- **Lenguaje**: TypeScript
- **Deployment**: Docker container → Dokploy en VPS Hostinger (82.180.133.248)

### Landing / Dashboard
- **Framework**: Next.js 15 (App Router) con `output: "standalone"`
- **Hosting**: Docker container → Dokploy (mismo VPS que backend)
- **Styling**: Tailwind CSS v4
- **UI**: vanilla Tailwind, sin librería de componentes
- **Lenguaje**: TypeScript

### Extensión
- Se mantiene como está (vanilla JS, MV3)
- Apunta a `api.empleo.skybrandmx.com` en prod, `localhost:8787` en dev

### Infraestructura (todo self-hosted en un VPS Hostinger)
- **Marca madre**: `skybrandmx.com`
- **Subdominio producto**: `empleo.skybrandmx.com` → Landing (Next.js container)
- **Subdominio API**: `api.empleo.skybrandmx.com` → Backend (Node container)
- **VPS**: Hostinger KVM, IP `82.180.133.248`
- **Orquestador**: Dokploy (Docker + Traefik + Let's Encrypt auto-renewal)
- **DNS**: Hostinger hPanel

## Arquitectura de flujo

```
  ┌───────────────────┐                 ┌────────────────────────┐
  │   Extensión       │                 │  Landing (Next.js)     │
  │   Chrome MV3      │  ◀──login──▶   │  skybrandmx.com        │
  └──────┬────────────┘                 └──────┬─────────────────┘
         │                                     │
         │ Bearer JWT                          │ Bearer JWT
         ▼                                     ▼
  ┌────────────────────────────────────────────────────────┐
  │  Backend API (Cloudflare Worker + Hono + D1)           │
  │  api.skybrandmx.com                                     │
  │  - /auth/signup, /auth/login, /auth/logout              │
  │  - /account                                              │
  │  - /applications/generate, /applications/parse-cv        │
  │  - /billing/checkout, /billing/cancel                    │
  │  - /webhooks/mercadopago                                 │
  └────────┬──────────────────┬──────────────────────────────┘
           │                  │
           │                  │
           ▼                  ▼
    ┌───────────────┐   ┌────────────────┐
    │  Gemini API   │   │  MercadoPago   │
    │  (Google)     │   │  (Subscriptions)│
    └───────────────┘   └────────────────┘
```

## Contrato de API (single source of truth)

### Convenciones
- Base URL (prod): `https://api.empleo.skybrandmx.com/v1`
- Base URL (dev): `http://localhost:8787/v1`
- Content-Type: `application/json`
- Auth: header `Authorization: Bearer <jwt>` (excepto endpoints públicos)
- Errores: `{ ok: false, error: { code: string, message: string } }`, status 4xx/5xx
- Éxitos: `{ ok: true, ...data }`, status 2xx

### Endpoints

#### POST /v1/auth/signup
```json
// Request
{ "email": "user@example.com", "password": "min8chars", "name": "Juan Pérez" }
// Response 201
{ "ok": true, "token": "<jwt>", "user": { "id": "...", "email": "...", "name": "...", "plan": "free" } }
```

#### POST /v1/auth/login
```json
{ "email": "...", "password": "..." }
// Response 200
{ "ok": true, "token": "<jwt>", "user": { ... } }
```

#### POST /v1/auth/logout
Auth: Bearer. Response 204 (invalida el JTI en la tabla sessions).

#### GET /v1/account
Auth: Bearer.
```json
// Response 200
{
  "ok": true,
  "user": { "id": "...", "email": "...", "name": "...", "plan": "pro", "planExpiresAt": 1746921600 },
  "usage": { "current": 17, "limit": 100, "periodStart": 1745078400, "periodEnd": 1747670400 }
}
```

#### POST /v1/applications/generate
Auth: Bearer.
```json
// Request
{ "profile": { /* UserProfile */ }, "job": { /* JobPosting */ } }
// Response 200
{ "ok": true, "coverLetter": "...", "suggestedAnswers": { }, "usage": { "current": 18, "limit": 100 } }
// Response 402 si excede plan
{ "ok": false, "error": { "code": "PLAN_LIMIT_EXCEEDED", "message": "Llegaste al límite de tu plan. Upgrade para continuar." } }
```

#### POST /v1/applications/parse-cv
Auth: Bearer.
```json
// Request
{ "text": "texto completo del CV" }
// Response 200
{ "ok": true, "profile": { /* UserProfile sin version/updatedAt/rawText */ } }
```

#### POST /v1/billing/checkout
Auth: Bearer.
```json
// Request
{ "plan": "pro" | "premium", "interval": "monthly" | "yearly" }
// Response 200
{ "ok": true, "checkoutUrl": "https://pay.conekta.com/..." }
```

#### POST /v1/billing/cancel
Auth: Bearer. Cancela al final del período actual.
```json
// Response 200
{ "ok": true, "status": "will_cancel_at_period_end", "effectiveAt": 1746921600 }
```

#### POST /v1/webhooks/conekta
Sin auth (valida firma `Digest` header de Conekta). Recibe eventos `subscription.created`, `subscription.paid`, `subscription.payment_failed`, `subscription.canceled`, `subscription.expired`. Idempotente (deduplica por event id).

### Rate limits
- Signup/login: 10 req/min/IP (protección contra brute force)
- Generate/parse: según plan (gratis 3/mes, pro 100/mes, premium ilimitado con soft cap de 500/mes)

## Esquema de base de datos (D1 — SQLite)

Ver `backend/migrations/0001_init.sql` (lo crea el agente backend). Tablas esperadas:

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT,
  plan TEXT NOT NULL DEFAULT 'free', -- 'free' | 'pro' | 'premium'
  plan_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  jti TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conekta_subscription_id TEXT UNIQUE,
  plan TEXT NOT NULL,
  interval TEXT NOT NULL,  -- 'monthly' | 'yearly'
  status TEXT NOT NULL,    -- 'pending' | 'active' | 'paused' | 'cancelled' | 'expired'
  current_period_end INTEGER,
  will_cancel_at_period_end INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE usage_monthly (
  user_id TEXT NOT NULL,
  year_month TEXT NOT NULL,  -- '2026-04'
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, year_month),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,    -- idempotency key del provider
  source TEXT NOT NULL,   -- 'conekta'
  event_type TEXT,
  payload TEXT NOT NULL,  -- JSON
  processed INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX idx_sessions_user ON sessions(user_id);
```

## Seguridad

- **JWT**: HS256 con secret de 256 bits mínimo. Tokens expiran en 30 días. Cada token tiene JTI único persistido en `sessions` para poder revocar.
- **Passwords**: bcrypt con cost 10.
- **CORS**: whitelist estricta. Permitir `chrome-extension://<ID>` (el ID de la extensión una vez publicada), `https://skybrandmx.com`, `https://*.skybrandmx.com`, y localhost para dev.
- **Gemini key**: solo en env vars del Worker. Nunca en frontend.
- **Conekta webhooks**: verificar firma con el header `Digest` (Conekta firma con HMAC-SHA1 sobre el body). Secret del webhook en env `CONEKTA_WEBHOOK_KEY`.
- **SQL**: usar prepared statements siempre (D1 los soporta).
- **Rate limiting**: por IP en endpoints de auth; por user_id en generate/parse.
- **Contenido usuario**: no loggear CVs ni cartas completas (son PII). Solo meta: userId, timestamp, job title, token count.

## Legal (obligatorio antes de cobrar)

- **Aviso de privacidad integral** (LFPDPPP 2025) — página `/privacy` en landing. Debe incluir:
  - Identidad del responsable (SkyBrandMX, RFC, domicilio)
  - Datos que se recaban (email, password hash, CV texto plano, pagos vía MP)
  - Finalidades primarias (operar el servicio) y secundarias (mejoras, analytics) — consentimiento explícito para secundarias
  - Derechos ARCO (Acceso, Rectificación, Cancelación, Oposición)
  - Email de contacto: `privacidad@skybrandmx.com`
- **Términos y condiciones** — página `/terms`. Debe incluir:
  - Prohibición de uso indebido (scraping masivo, spam a reclutadores, postular a empleos que no apliquen)
  - Sin garantía de empleo (el servicio es una herramienta, no un reclutador)
  - Límites de responsabilidad
  - Reembolsos (política de 7 días si no has usado el plan)
  - Cancelación: toma efecto al final del período
- **RFC y facturación**: el usuario (SkyBrandMX) debe dar de alta la actividad y emitir CFDI. MP puede emitir por él a través de su integración con CFDI, pero si factura el emprendedor debe tener RFC con actividad empresarial o ser persona moral.

## Fases del rollout

**Fase 1 — Este build (MVP comercial)**
- [x] Extensión funcional con Gemini directo (BYOK) ← ya está
- [ ] Backend con auth, Gemini proxy, metering
- [ ] MercadoPago subscripciones (Pro + Premium)
- [ ] Landing 1 página + signup/login/dashboard + privacy + terms
- [ ] Refactor extensión: quita BYOK, usa backend

**Fase 2 — Post-lanzamiento (iteraciones 1-2 meses)**
- [ ] Email verification (Resend)
- [ ] Password reset
- [ ] Soporte Computrabajo en extensión
- [ ] Analytics (PostHog o similar)
- [ ] Chrome Web Store submission

**Fase 3 — Crecimiento**
- [ ] Soporte LinkedIn Easy Apply
- [ ] Dashboard de postulaciones (historial, tracking de respuestas)
- [ ] Recomendaciones de vacantes
- [ ] Optimizer de CV (con IA)

## Estructura de carpetas del monorepo

```
/
├── manifest.json + lib/ + content/ + popup/ + options/ + etc.  ← extensión (root, por ahora)
├── backend/                    ← Cloudflare Worker (nuevo)
│   ├── src/
│   ├── migrations/
│   ├── wrangler.toml
│   └── package.json
├── landing/                    ← Next.js app (nuevo)
│   ├── app/
│   ├── components/
│   └── package.json
├── COMMERCIAL.md               ← este archivo
├── ARCHITECTURE.md             ← arquitectura de la extensión
├── README.md
└── ...
```

## Notas para agentes

- Cada agente tiene un scope claro (backend, landing, extension refactor). **No pisar trabajo de otro agente.**
- **Fuente de verdad de contrato API**: este archivo.
- **Lenguaje UI**: español MX siempre. Código y comentarios en inglés.
- **Moneda**: MXN siempre en la UI ("$299 MXN"). No usar símbolo $ solo porque puede confundir con USD.
- **Not before agreed**: no cambiar precios, nombre del producto, marca, ni stack sin avisar al director.
