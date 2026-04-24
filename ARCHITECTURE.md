# Arquitectura — Empleo Automático MX

> **Este documento es el contrato entre módulos.** Los agentes que implementen cada módulo deben respetar las interfaces definidas aquí. Si algo no cuadra, preguntar al director antes de cambiarlo.

## Objetivo MVP

Extensión de Chrome que, mientras el usuario navega OCC Mundial (occ.com.mx), detecta vacantes de empleo, extrae su contenido, llama a nuestro backend para generar una carta de presentación personalizada, llena el formulario de postulación, y espera aprobación humana antes de enviar.

## Filosofía

- **Human-in-the-loop**: nunca enviar sin aprobación explícita.
- **Backend-mediated IA**: la extensión no llama a Gemini directo; pasa por `api.skybrandmx.com` que valida plan, descuenta uso y cobra la llamada.
- **Perfil local**: perfil y drafts viven en `chrome.storage.local`. Sólo el texto del CV y el job posting viajan al backend cuando hace falta.
- **Sin build step**: JS vanilla, ES modules nativos. El usuario debe poder instalar con "Load unpacked".
- **Un portal primero**: OCC. Computrabajo/LinkedIn en iteraciones futuras. No premature abstractions, pero mantén `source` field en todos los datos para que escale.

## Stack

- Manifest V3, service worker como background.
- `chrome.storage.local` para persistencia (perfil, drafts, JWT).
- `chrome.runtime.sendMessage` para IPC.
- Backend `api.skybrandmx.com` (Cloudflare Worker + Hono + D1) para auth, generación de cartas y parseo de CV.
- `pdf.js` (bundled en `/vendor`) para extracción de texto del CV en cliente.
- HTML/CSS/JS vanilla para UI.

## Estructura de carpetas

```
/
├── manifest.json
├── README.md
├── ARCHITECTURE.md           ← este archivo
├── package.json              ← solo tracking, no build
├── icons/                    ← icon16/48/128 png (placeholders)
├── vendor/
│   └── pdf.min.js            ← pdf.js UMD build
├── lib/                      ← módulos puros, importables via ES modules
│   ├── schemas.js            ← JSDoc types, constantes
│   ├── config.js             ← API_BASE_URL y URLs de marketing
│   ├── storage.js            ← abstracción chrome.storage
│   ├── auth.js               ← JWT + user cache en chrome.storage
│   ├── backend.js            ← cliente HTTP para api.skybrandmx.com
│   ├── cv-parser.js          ← extracción de texto del PDF (pdf.js)
│   └── messaging.js          ← helpers sendMessage / onMessage tipados
├── background/
│   └── service-worker.js     ← router de mensajes, orquestación
├── content/
│   ├── occ.js                ← content script OCC
│   └── occ.css               ← estilos del botón flotante
├── popup/
│   ├── popup.html / .css / .js   ← UI de aprobación de draft
└── options/
    └── options.html / .css / .js  ← login/signup, subir CV, cuenta, ajustes
```

## Módulos y contratos

### `lib/schemas.js`  (ya creado — fuente de verdad)

Define con JSDoc:
- `UserProfile`
- `JobPosting`
- `ApplicationDraft`
- `Settings` (incluye `authToken`, `user`)
- `AuthUser`, `Usage`
- Constantes: `STORAGE_KEYS`, `MESSAGE_TYPES`, `ERROR_CODES`, `PLANS`, `PLAN_LABELS`

### `lib/storage.js`  (Agente A)

```js
export async function getProfile(): Promise<UserProfile | null>
export async function setProfile(profile: UserProfile): Promise<void>
export async function getSettings(): Promise<Settings>
export async function setSettings(settings: Partial<Settings>): Promise<void>
export async function getDrafts(): Promise<ApplicationDraft[]>
export async function addDraft(draft: ApplicationDraft): Promise<void>
export async function updateDraft(id: string, patch: Partial<ApplicationDraft>): Promise<void>
export async function getDraft(id: string): Promise<ApplicationDraft | null>
```

- Debe manejar el caso de storage vacío (devolver defaults razonables para Settings).
- Settings default: `{ authToken: null, user: null, autoApprove: false, language: "es" }`.

### `lib/backend.js`  (cliente HTTP de `api.skybrandmx.com`)

```js
export async function signup({ email, password, name })
export async function login({ email, password })
export async function logout()
export async function getAccount()
export async function generateCoverLetter({ profile, job })
export async function parseCVText({ text })

// Typed errors para branching:
export class BackendError extends Error { code: string; status: number }
export class UnauthorizedError extends BackendError   // 401 → clearToken()
export class PlanLimitError extends BackendError      // 402
export class NetworkError extends BackendError        // fetch rejected
```

- Base URL desde `lib/config.js` (`API_BASE_URL`).
- Attach `Authorization: Bearer <jwt>` automáticamente usando `lib/auth.js`.
- En 401 limpia el token localmente y lanza `UnauthorizedError`.
- En 402 lanza `PlanLimitError` para que la UI pueda mostrar el prompt de upgrade.
- No hay structured output ni prompts aquí — eso vive en el backend.

### `lib/auth.js`

```js
export async function getToken(): Promise<string | null>
export async function setToken(token: string): Promise<void>
export async function clearToken(): Promise<void>
export async function getUser(): Promise<AuthUser | null>
export async function setUser(user: AuthUser | null): Promise<void>
export async function isLoggedIn(): Promise<boolean>
```

Guarda token + user dentro del objeto `settings` en `chrome.storage.local` (no usa una clave separada; evita duplicación con `getSettings`).

### `lib/config.js`

Exporta `API_BASE_URL` (con un flag `USE_DEV` para apuntar a localhost:8787), `MARKETING_BASE_URL`, `BILLING_URL`, `SIGNUP_URL`. Única fuente de verdad de URLs externas.

### `lib/cv-parser.js`

```js
export async function extractTextFromPDF(arrayBuffer: ArrayBuffer, pdfjsLibOverride?): Promise<string>
```

- Usa pdf.js (cargado desde `/vendor/pdf.min.js`, se inyecta en options page vía `<script>`).
- El parseo estructurado ya no vive aquí: la options page extrae texto con `extractTextFromPDF`, manda `UPLOAD_CV { text }` al service worker, y éste llama a `backend.parseCVText({ text })`.

### `lib/messaging.js`  (Agente A)

```js
export function sendMessage<T extends Message>(msg: T): Promise<any>
export function onMessage(handler: (msg: Message, sender) => Promise<any> | any): void
```

- Envuelve `chrome.runtime.sendMessage` con async/await correcto.
- `onMessage` debe permitir handlers async (retornar `true` en el listener para mantener canal abierto).

### `background/service-worker.js`

- Importa `lib/*` como ES modules.
- Registra `chrome.runtime.onMessage` y enruta por `msg.type`:
  - `GENERATE_DRAFT` → lee profile + active job, llama `backend.generateCoverLetter`, crea ApplicationDraft, guarda, devuelve draftId. Mapea `PlanLimitError` a `{ ok: false, error: "PLAN_LIMIT_EXCEEDED", message }` para la UI.
  - `GET_ACTIVE_DRAFT` → devuelve el draft más reciente no-submitted
  - `APPROVE_DRAFT` → marca como approved, devuelve fields para fillear
  - `REJECT_DRAFT` → elimina
  - `UPLOAD_CV` → recibe `{ text }`, llama `backend.parseCVText({ text })`, guarda profile
  - `SAVE_SETTINGS`, `SAVE_PROFILE`, `GET_PROFILE`, `GET_SETTINGS` → passthrough a storage
  - `SIGNUP`, `LOGIN`, `LOGOUT`, `GET_AUTH_STATUS` → passthrough a `backend`
  - `TEST_AUTH` → llama `backend.getAccount()` para verificar el JWT
  - `OPEN_BILLING` → abre `https://skybrandmx.com/account/billing` en nueva pestaña
- En `chrome.runtime.onInstalled` abre options page si no hay sesión o no hay profile.

### `content/occ.js`  (Agente B)

- Detecta cuándo está en una página de detalle de vacante OCC. URL pattern: `occ.com.mx/empleo/oferta/...` o similar (verificar en runtime).
- Si es página de vacante:
  1. Extrae `JobPosting` del DOM (título, empresa, ubicación, descripción, requisitos, salario, modalidad). Usar selectores robustos con fallbacks.
  2. Inserta un **botón flotante** abajo a la derecha: "Postular con IA ✨". Estilos en `occ.css`.
  3. Al click: `sendMessage({ type: "GENERATE_DRAFT", job })`, muestra spinner, espera respuesta.
  4. Cuando llegue el draft, abre popup de preview o inyecta un panel lateral que muestra:
     - Cover letter editable (textarea)
     - Botones: "Aprobar y postular" | "Rechazar" | "Re-generar"
  5. Al aprobar: `sendMessage({ type: "APPROVE_DRAFT", draftId })` → recibe fields → llena formulario de postulación de OCC (si está en la misma página) y hace scroll + highlight al botón de submit, pero **NO lo hace click automáticamente** — el usuario da el último click.
- Si detecta un formulario de postulación antes de que el usuario genere draft, muestra el botón directamente sobre el formulario.
- Debe ser tolerante: si OCC cambia el DOM, el botón debería seguir apareciendo aunque el autofill falle. Degradación graciosa.
- Selectores: investigar en vivo. Si no puedes verificar el DOM exacto, deja TODO comments + selectores candidatos + heurísticas (por ejemplo, buscar `h1` + contenedor con "Empresa" cerca).

### `popup/popup.*`

Vista rápida al click del ícono, con estos estados:
- Logged out → "Inicia sesión para empezar" + botón "Iniciar sesión" (abre Opciones).
- Logged in, sin CV → "Sube tu CV en Opciones".
- Logged in, draft activo → resumen (título/empresa/carta truncada) + botones Opciones/Descartar.
- Logged in, en el límite del plan → "Llegaste al límite" + botón "Ver planes" (abre billing).
- Logged in, listo → "Navega a una vacante en OCC" + contador `X/Y postulaciones este mes`.

Estilo: minimalista, limpio, máx 400px ancho x 500px alto.

### `options/options.*`

Secciones:
1. **Cuenta**:
   - Si logged out: tabs Login / Signup, con `email/password` y (en signup) `name`.
   - Si logged in: saludo con nombre, badge del plan, `X/Y postulaciones este mes`, botón "Gestionar suscripción / Upgrade" (abre skybrandmx.com/account/billing) y "Cerrar sesión".
2. **CV**: drag-and-drop o input file (PDF). Al subir: extrae texto con pdf.js → envía `UPLOAD_CV { text }` al SW → muestra preview del perfil estructurado → botón guardar. Permite edición manual del JSON.
3. **Configuración**: select de idioma (es/en), toggle auto-aprobar, exportar/importar profile.

Estilo: layout centrado, tarjetas por sección. Español por default.

## Plan de mensajes (fuente única: schemas.js)

| type                   | sender   | receiver   | payload                     | reply                       |
|------------------------|----------|------------|-----------------------------|-----------------------------|
| `GET_PROFILE`          | popup/options/content | background | —                | `UserProfile \| null`       |
| `GET_SETTINGS`         | popup/options/content | background | —                | `Settings`                  |
| `UPLOAD_CV`            | options  | background | `{ text }`                  | `{ ok, profile } \| fail`   |
| `SAVE_PROFILE`         | options  | background | `{ profile }`               | `{ ok }`                    |
| `SAVE_SETTINGS`        | options  | background | `{ settings }`              | `{ ok }`                    |
| `SIGNUP`               | options  | background | `{ email, password, name }` | `{ ok, user } \| fail`      |
| `LOGIN`                | options  | background | `{ email, password }`       | `{ ok, user } \| fail`      |
| `LOGOUT`               | options  | background | —                           | `{ ok }`                    |
| `GET_AUTH_STATUS`      | popup/options | background | —                      | `{ ok, loggedIn, user, usage }` |
| `TEST_AUTH`            | options  | background | —                           | `{ ok, user, usage } \| fail` |
| `OPEN_BILLING`         | popup/options/content | background | —                | `{ ok }`                    |
| `GENERATE_DRAFT`       | content  | background | `{ job }`                   | `{ ok, draftId, draft, usage } \| fail` |
| `GET_ACTIVE_DRAFT`     | popup/content | background | —                      | `ApplicationDraft \| null`  |
| `APPROVE_DRAFT`        | content/popup | background | `{ draftId, coverLetter? }` | `{ ok, fields }`     |
| `REJECT_DRAFT`         | content/popup | background | `{ draftId }`        | `{ ok }`                    |

Fail shape is `{ ok: false, error: <ERROR_CODES>, message: string }` (see `lib/schemas.js#ERROR_CODES`).

El payload de `UPLOAD_CV` es `{ text }` (no ArrayBuffer): la options page extrae el texto del PDF con pdf.js (pdf.js no puede correr en un SW de MV3), y sólo el texto viaja al background.

## Qué está fuera de alcance del MVP

- Submit automático del formulario final (siempre lo da el usuario).
- Integración con más portales (Computrabajo, LinkedIn) — solo OCC por ahora.
- Scheduling / bulk apply.
- Dashboard / analytics serio.
- Login a OCC automatizado — se asume que el usuario ya está logueado en su navegador.
- Backend propio o base de datos remota.

## Lo que necesitamos del usuario

- Cuenta en skybrandmx.com (Plan Gratis da 3 postulaciones/mes).
- CV en PDF de prueba.
- Cuenta activa de OCC Mundial logueada en el navegador.
- Eventualmente: iconos (placeholders están bien para MVP).
