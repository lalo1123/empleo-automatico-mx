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
  ACTIVE_DRAFT_ID: "activeDraftId"
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
  ANSWER_QUESTIONS: "ANSWER_QUESTIONS"
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
