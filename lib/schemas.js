/**
 * Shared types, constants, and schemas for Empleo Automático MX.
 * This file is the single source of truth for all data shapes and message types.
 * All modules import from here.
 */

// ============================================================================
// Storage keys
// ============================================================================

export const STORAGE_KEYS = Object.freeze({
  PROFILE: "userProfile",
  SETTINGS: "settings",
  DRAFTS: "applicationDrafts",
  ACTIVE_DRAFT_ID: "activeDraftId",
  // Express Mode toggle. Stored in chrome.storage.local under this key (NOT
  // namespaced inside SETTINGS) so the LaPieza content script can read it
  // synchronously without round-tripping through the background worker.
  // Default: true (Express on). See onFabClick + runExpressFill in
  // content/lapieza.js for the consumer side, and options.html → "Modo de
  // aplicación" radio group for the writer.
  EXPRESS_MODE: "eamx:settings:expressMode",
  // Discovery queue. Array<QueueItem> of vacancies the user marked from
  // listing pages (LaPieza first, other portals next). Cap 50, FIFO. The
  // content script writes via lib/queue.js and the options page renders
  // the same key. chrome.storage.onChanged gives us free cross-tab sync.
  // See lib/queue.js for the schema.
  QUEUE: "eamx:queue",
  // User preferences for ranking listing-page vacancies. Schema:
  //   { city, citySynonyms, modality, salaryMin, salaryMax, updatedAt }
  // Lives in chrome.storage.local so listing scans (LaPieza, OCC, etc.)
  // can read it synchronously without round-tripping. Used by
  // lib/match-score.js → computeMatchScore(profile, jobLite, preferences)
  // to layer city/modality/salary bonuses on top of the base score.
  // Default: only modality:"any" set — no city/salary set means no bias.
  PREFERENCES: "eamx:preferences",
  // ---------------------------------------------------------------------
  // Modo Auto — Premium-tier optional auto-submit (4 MX portals only).
  // ---------------------------------------------------------------------
  // The user toggle. Boolean, default false. Stored in chrome.storage.local
  // so the LaPieza content script can read it synchronously on every
  // Express fill. Modo Auto only activates when ALL of:
  //   1) cachedProfile?.plan === "premium"
  //   2) AUTO_MODE === true
  //   3) AUTO_DISCLAIMER_SEEN === true
  // Free/Pro users see the card but it's locked. All 6 portals are
  // supported with portal-specific caps (see AUTO_PORTAL_CAPS) calibrated
  // to keep activity in each portal's documented green-zone band.
  AUTO_MODE: "eamx:settings:autoMode",
  // Daily counter. Schema:
  //   { date: "YYYY-MM-DD" (local), count: number,
  //     perPortal: { linkedin?, indeed?, occ?, computrabajo?,
  //                  bumeran?, lapieza? } }
  // Caps: see AUTO_PORTAL_CAPS (linkedin/indeed 15, others 20),
  // AUTO_TOTAL_CAP = 110. Resets at local midnight when
  // saved.date !== today. Read+write atomic per submit.
  AUTO_DAILY: "eamx:auto:daily",
  // Whether the user has clicked through the disclaimer modal at least
  // once. Boolean, default false. Required to be true before AUTO_MODE
  // can flip to true.
  AUTO_DISCLAIMER_SEEN: "eamx:auto:disclaimerSeen",
  // Timestamp (ms since epoch) of the last successful auto-submit, used
  // to gate the inter-submit delay (random 30-90s). Single shared key
  // across portals — the user can't burst across portals either.
  AUTO_LAST_SUBMIT_AT: "eamx:auto:lastSubmitAt",
  // Day-pause flag. Schema:
  //   { date: "YYYY-MM-DD" (local), reason: string }
  // Set when the abort heuristic fires (2 consecutive non-OK submits in
  // the same portal). When this matches today's date, auto-submit is
  // hard-disabled even if the toggle is on. Cleared on date rollover.
  AUTO_DAY_PAUSE: "eamx:auto:dayPause"
});

// ============================================================================
// Message types (IPC between content/background/popup/options)
// ============================================================================

export const MESSAGE_TYPES = Object.freeze({
  GET_PROFILE: "GET_PROFILE",
  GET_SETTINGS: "GET_SETTINGS",
  UPLOAD_CV: "UPLOAD_CV",
  SAVE_PROFILE: "SAVE_PROFILE",
  SAVE_SETTINGS: "SAVE_SETTINGS",
  TEST_AUTH: "TEST_AUTH",
  GENERATE_DRAFT: "GENERATE_DRAFT",
  GET_ACTIVE_DRAFT: "GET_ACTIVE_DRAFT",
  APPROVE_DRAFT: "APPROVE_DRAFT",
  REJECT_DRAFT: "REJECT_DRAFT",
  SIGNUP: "SIGNUP",
  LOGIN: "LOGIN",
  LOGOUT: "LOGOUT",
  GET_AUTH_STATUS: "GET_AUTH_STATUS",
  OPEN_BILLING: "OPEN_BILLING",
  // Admin-only: switch the caller's own plan without paying. Backend
  // gates this by ADMIN_USER_EMAILS — non-admins get FORBIDDEN.
  ADMIN_SET_PLAN: "ADMIN_SET_PLAN",
  // Tailored, per-vacancy ATS-CV generation. The backend reorders/rewrites
  // the user's profile to surface the skills the job posting asks for.
  // Returns { html, summary, usage } — content scripts cache the html.
  GENERATE_CV: "GENERATE_CV",
  // Open the cached CV HTML in a new tab from the service worker (content
  // scripts can't call chrome.tabs.create directly). The new tab embeds an
  // auto-print bootstrap so the user lands on the browser's print dialog.
  OPEN_GENERATED_CV: "OPEN_GENERATED_CV",
  // Adaptive per-question answer generation. Content scripts scan the apply
  // form for open-ended question fields (textareas / long inputs whose label
  // looks like an actual question) and forward them in a batch (1-12 strings)
  // to the backend. Response: { ok, answers } where answers is the same length
  // and order as the input questions. No quota cost — covered by the cover-
  // letter charge. Errors mirror GENERATE_DRAFT (UNAUTHORIZED / 422 / 502).
  ANSWER_QUESTIONS: "ANSWER_QUESTIONS",
  // Modo Auto — content-script→options ping after a successful auto-submit.
  // Body: { portal: "lapieza"|"occ"|"computrabajo"|"bumeran",
  //         daily: { date, count, perPortal } }
  // Optional: chrome.storage.onChanged on AUTO_DAILY already gives the
  // options page a free sync, but this message lets us also surface a
  // toast or analytics ping in v2 without changing storage shape.
  AUTO_SUBMIT_RESULT: "AUTO_SUBMIT_RESULT"
});

// ============================================================================
// Error codes returned by backend (or synthesized in the extension)
// ============================================================================

export const ERROR_CODES = Object.freeze({
  UNAUTHORIZED: "UNAUTHORIZED",
  PLAN_LIMIT_EXCEEDED: "PLAN_LIMIT_EXCEEDED",
  NETWORK_ERROR: "NETWORK_ERROR",
  SERVER_ERROR: "SERVER_ERROR",
  INVALID_INPUT: "INVALID_INPUT"
});

// ============================================================================
// Plans
// ============================================================================

export const PLANS = Object.freeze({
  FREE: "free",
  PRO: "pro",
  PREMIUM: "premium"
});

export const PLAN_LABELS = Object.freeze({
  free: "Plan Gratis",
  pro: "Plan Pro",
  premium: "Plan Premium"
});

// ============================================================================
// Source portals
// ============================================================================

export const SOURCES = Object.freeze({
  OCC: "occ",
  COMPUTRABAJO: "computrabajo",
  LINKEDIN: "linkedin",
  BUMERAN: "bumeran",
  INDEED: "indeed",
  LAPIEZA: "lapieza"
});

// ============================================================================
// Modo Auto — caps + portal allowlist
// ============================================================================
// Source of truth for the "Modo Auto" feature limits. Imported by:
//   - content/lapieza.js (reads cap before each auto-submit)
//   - options/options.js (renders the per-portal counter pills)
//
// Daily caps per portal for Modo Auto. Calibrated against real public
// evidence on each platform's detection thresholds:
//   LinkedIn: <15/day = green zone (per multiple 2026 sources);
//             15-30 = yellow (on radar); 30+ = red (restriction
//             likely within days).
//   Indeed:   similar — conservative 15/day to stay safe.
//   OCC / Computrabajo / Bumeran / LaPieza: less aggressive
//             detection in MX market — 20/day comfortable.
//
// Total cap = 110/day across 6 portals. vs LazyApply's 750/day,
// our differentiator is "engineered to keep you in the green zone
// per platform — not just rate-limited".
export const AUTO_PORTAL_CAPS = Object.freeze({
  linkedin:    15,
  indeed:      15,
  occ:         20,
  computrabajo:20,
  bumeran:     20,
  lapieza:     20
});

// Order matters for the UI breakdown — LinkedIn/Indeed first
// (the safer-zone portals) so users see them at the top.
export const AUTO_PORTAL_ORDER = Object.freeze([
  "linkedin", "indeed", "occ", "computrabajo", "bumeran", "lapieza"
]);

// Total cap across all portals (sum of AUTO_PORTAL_CAPS).
export const AUTO_TOTAL_CAP = 110;

// Legacy aliases — kept for backward compatibility with any external
// importers we might have missed. Both point at the new structure so the
// "single source of truth" promise still holds.
export const AUTO_MODE_DAILY_CAPS = AUTO_PORTAL_CAPS;
export const AUTO_MODE_TOTAL_CAP = AUTO_TOTAL_CAP;

// Inter-submit delay (random uniform within range). Picked to look human:
// fast enough to feel snappy (30s lower bound), slow enough to avoid
// triggering rate-limit heuristics on the portal side (90s upper bound).
// Re-rolled per submit; the single AUTO_LAST_SUBMIT_AT key gates this.
export const AUTO_MODE_INTER_DELAY_MIN_MS = 30 * 1000;
export const AUTO_MODE_INTER_DELAY_MAX_MS = 90 * 1000;

// Pre-submit countdown, second-resolution. The toast shows this counting
// down with a "Cancelar" kill-switch button. 5 seconds is the spec.
export const AUTO_MODE_COUNTDOWN_SEC = 5;

// ============================================================================
// JSDoc types
// ============================================================================

/**
 * @typedef {Object} ExperienceEntry
 * @property {string} company
 * @property {string} role
 * @property {string} startDate  - ISO YYYY-MM or YYYY-MM-DD
 * @property {string|null} endDate  - null if current
 * @property {string} description
 * @property {string[]} achievements
 * @property {string} [location]
 */

/**
 * @typedef {Object} EducationEntry
 * @property {string} institution
 * @property {string} degree
 * @property {string} field
 * @property {string} startDate
 * @property {string|null} endDate
 */

/**
 * @typedef {Object} LanguageEntry
 * @property {string} language
 * @property {"básico"|"intermedio"|"avanzado"|"nativo"} level
 */

/**
 * @typedef {Object} PersonalInfo
 * @property {string} fullName
 * @property {string} email
 * @property {string} phone
 * @property {string} location  - "Ciudad, Estado, País"
 * @property {string} [linkedin]
 * @property {string} [website]
 */

/**
 * @typedef {Object} UserProfile
 * @property {1} version
 * @property {string} updatedAt  - ISO timestamp
 * @property {PersonalInfo} personal
 * @property {string} summary  - professional summary / headline
 * @property {ExperienceEntry[]} experience
 * @property {EducationEntry[]} education
 * @property {string[]} skills
 * @property {LanguageEntry[]} languages
 * @property {string} rawText  - full extracted CV text (fallback for prompts)
 */

/**
 * @typedef {Object} JobPosting
 * @property {"occ"|"computrabajo"|"linkedin"|"bumeran"|"indeed"|"lapieza"} source
 * @property {string} url
 * @property {string} id  - portal's unique id or url hash
 * @property {string} title
 * @property {string} company
 * @property {string} location
 * @property {string|null} salary
 * @property {string|null} modality  - "presencial" | "remoto" | "híbrido" | null
 * @property {string} description
 * @property {string[]} requirements
 * @property {string} extractedAt  - ISO timestamp
 */

/**
 * @typedef {Object} ApplicationDraft
 * @property {string} id  - uuid or timestamp-based
 * @property {JobPosting} job
 * @property {string} coverLetter
 * @property {Record<string,string>} suggestedAnswers  - for open-ended form questions
 * @property {Record<string,string>} formFields  - selector → value mapping for autofill
 * @property {"draft"|"approved"|"submitted"|"rejected"|"failed"} status
 * @property {string} createdAt
 * @property {string|null} approvedAt
 * @property {string|null} submittedAt
 * @property {string|null} error
 */

/**
 * @typedef {Object} AuthUser
 * @property {string} id
 * @property {string} email
 * @property {string} name
 * @property {"free"|"pro"|"premium"} plan
 * @property {number|null} [planExpiresAt]  - unix seconds
 * @property {boolean} [isAdmin]  - true when email is on backend ADMIN_USER_EMAILS
 */

/**
 * @typedef {Object} Usage
 * @property {number} current
 * @property {number} limit  - -1 means unlimited
 * @property {number} [periodStart]
 * @property {number} [periodEnd]
 */

/**
 * @typedef {Object} UserPreferences
 * @property {string} [city]              Ideal city, e.g. "Ciudad de México"
 * @property {string[]} [citySynonyms]    Computed list — variants of city
 * @property {"presencial"|"remoto"|"hibrido"|"any"} [modality]  Default "any"
 * @property {number} [salaryMin]         MXN per month, optional
 * @property {number} [salaryMax]         MXN per month, optional
 * @property {number} updatedAt           Date.now()
 */

/**
 * @typedef {Object} Settings
 * @property {string|null} authToken  - JWT from backend, null if logged out
 * @property {AuthUser|null} user
 * @property {boolean} autoApprove
 * @property {"es"|"en"} language
 */

// ============================================================================
// Default values
// ============================================================================

export const DEFAULT_SETTINGS = Object.freeze({
  authToken: null,
  user: null,
  autoApprove: false,
  language: "es"
});

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generates a unique id for drafts.
 * @returns {string}
 */
export function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * @returns {string} current ISO timestamp
 */
export function nowISO() {
  return new Date().toISOString();
}

/**
 * Builds the default UserPreferences object. Stored under
 * STORAGE_KEYS.PREFERENCES in chrome.storage.local. The default has only
 * modality:"any" + updatedAt — every other field is optional and "unset"
 * means "no scoring bonus from this dimension".
 * @returns {UserPreferences}
 */
export function defaultPreferences() {
  return {
    modality: "any",
    updatedAt: Date.now()
  };
}

/**
 * Builds an empty/default UserProfile.
 * @returns {UserProfile}
 */
export function emptyProfile() {
  return {
    version: 1,
    updatedAt: nowISO(),
    personal: {
      fullName: "",
      email: "",
      phone: "",
      location: ""
    },
    summary: "",
    experience: [],
    education: [],
    skills: [],
    languages: [],
    rawText: ""
  };
}
