// Backend API client. Replaces the old direct-to-Gemini client.
// All network calls go through `request()` which attaches the JWT and
// normalizes errors into typed Error subclasses the callers can branch on.

import { API_BASE_URL } from "./config.js";
import * as auth from "./auth.js";
import { ERROR_CODES } from "./schemas.js";

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class BackendError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.name = "BackendError";
    this.code = code;
    this.status = status || 0;
  }
}

export class UnauthorizedError extends BackendError {
  constructor(message) {
    super(ERROR_CODES.UNAUTHORIZED, message || "Tu sesión expiró. Inicia sesión de nuevo.", 401);
    this.name = "UnauthorizedError";
  }
}

export class PlanLimitError extends BackendError {
  constructor(message) {
    super(
      ERROR_CODES.PLAN_LIMIT_EXCEEDED,
      message || "Llegaste al límite de tu plan. Upgrade en empleo.skybrandmx.com/account/billing.",
      402
    );
    this.name = "PlanLimitError";
  }
}

export class NetworkError extends BackendError {
  constructor(message) {
    super(ERROR_CODES.NETWORK_ERROR, message || "Sin conexión con el servidor. Revisa tu internet.", 0);
    this.name = "NetworkError";
  }
}

// ---------------------------------------------------------------------------
// Core request wrapper
// ---------------------------------------------------------------------------

function mapStatusError(status, serverMessage) {
  const msg = serverMessage || "";
  if (status === 401) return new UnauthorizedError(msg);
  if (status === 402) return new PlanLimitError(msg);
  if (status === 400 || status === 422) {
    return new BackendError(ERROR_CODES.INVALID_INPUT, msg || "Datos inválidos.", status);
  }
  if (status === 429) {
    return new BackendError(ERROR_CODES.SERVER_ERROR, msg || "Demasiadas solicitudes, espera un momento.", status);
  }
  if (status >= 500) {
    return new BackendError(ERROR_CODES.SERVER_ERROR, msg || "El servidor tuvo un problema. Intenta de nuevo.", status);
  }
  return new BackendError(ERROR_CODES.SERVER_ERROR, msg || `Error ${status} del servidor.`, status);
}

/**
 * @param {string} path - path beginning with "/"
 * @param {{method?: string, body?: any, requireAuth?: boolean}} [opts]
 * @returns {Promise<any>}
 */
async function request(path, opts = {}) {
  const { method = "GET", body, requireAuth = true } = opts;
  const url = `${API_BASE_URL}${path}`;

  const headers = { "content-type": "application/json", accept: "application/json" };
  if (requireAuth) {
    const token = await auth.getToken();
    if (!token) {
      throw new UnauthorizedError("Necesitas iniciar sesión.");
    }
    headers.authorization = `Bearer ${token}`;
  }

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body)
    });
  } catch (_) {
    throw new NetworkError();
  }

  // 204 No Content (e.g. logout)
  if (res.status === 204) return { ok: true };

  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    // Some errors from CF/edge may not be JSON.
  }

  if (!res.ok) {
    const srvMsg = data && data.error && data.error.message;
    const srvCode = data && data.error && data.error.code;
    const err = mapStatusError(res.status, srvMsg);
    // Attach server-reported code if the generic mapping didn't already pick one up.
    if (srvCode && !err.code) err.code = srvCode;

    // On 401 the token is definitely stale — wipe it so the UI reflects reality.
    if (err instanceof UnauthorizedError) {
      try { await auth.clearToken(); } catch (_) { /* ignore */ }
    }
    throw err;
  }

  return data || { ok: true };
}

// ---------------------------------------------------------------------------
// Auth endpoints
// ---------------------------------------------------------------------------

/**
 * @param {{email: string, password: string, name: string}} args
 * @returns {Promise<{ok: true, token: string, user: import('./schemas.js').AuthUser}>}
 */
export async function signup({ email, password, name }) {
  const data = await request("/auth/signup", {
    method: "POST",
    body: { email, password, name },
    requireAuth: false
  });
  if (data && data.token) {
    await auth.setToken(data.token);
    if (data.user) await auth.setUser(data.user);
  }
  return data;
}

/**
 * @param {{email: string, password: string}} args
 * @returns {Promise<{ok: true, token: string, user: import('./schemas.js').AuthUser}>}
 */
export async function login({ email, password }) {
  const data = await request("/auth/login", {
    method: "POST",
    body: { email, password },
    requireAuth: false
  });
  if (data && data.token) {
    await auth.setToken(data.token);
    if (data.user) await auth.setUser(data.user);
  }
  return data;
}

/**
 * Best-effort logout. Always clears the local token even if the server errors.
 */
export async function logout() {
  try {
    await request("/auth/logout", { method: "POST" });
  } catch (_) {
    // Ignore server errors — local cleanup is what matters.
  } finally {
    await auth.clearToken();
  }
  return { ok: true };
}

/**
 * @returns {Promise<{ok: true, user: import('./schemas.js').AuthUser, usage: import('./schemas.js').Usage}>}
 */
export async function getAccount() {
  const data = await request("/account", { method: "GET" });
  if (data && data.user) {
    // Refresh the cached user — plan/expiry may have changed since login.
    await auth.setUser(data.user);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Application endpoints
// ---------------------------------------------------------------------------

/**
 * @param {{profile: object, job: object}} args
 * @returns {Promise<{ok: true, coverLetter: string, suggestedAnswers: Record<string,string>, usage?: import('./schemas.js').Usage}>}
 */
export async function generateCoverLetter({ profile, job }) {
  return request("/applications/generate", {
    method: "POST",
    body: { profile, job }
  });
}

/**
 * Generate a per-vacancy tailored ATS-CV. The backend reorders/rewrites the
 * profile so the skills this posting asks for appear first, but never invents
 * experience — same companies, same dates, just better-structured HTML.
 *
 * @param {{profile: object, job: object}} args
 * @returns {Promise<{ok: true, html: string, summary: string, usage?: import('./schemas.js').Usage}>}
 */
export async function generateTailoredCv({ profile, job }) {
  return request("/applications/generate-cv", {
    method: "POST",
    body: { profile, job }
  });
}

/**
 * Adaptive per-question answer generation. Content scripts scan the apply
 * form, collect 1-12 open-ended question prompts (e.g. "¿Por qué eres la
 * persona ideal para este puesto?"), and forward them here in a single batch.
 * The backend returns one answer per question, in the same order. No quota
 * cost — the cover-letter generation already debited 1 unit.
 *
 * @param {{questions: string[], profile: object, job: object}} args
 * @returns {Promise<{ok: true, answers: string[]}>}
 */
export async function answerQuestions({ questions, profile, job }) {
  return request("/applications/answer-questions", {
    method: "POST",
    body: { questions, profile, job }
  });
}

/**
 * Multiple-choice knowledge quiz answer. One call per quiz question — the
 * LaPieza auto-quiz loop in content/lapieza.js sends ONE question at a time
 * with its lettered options, takes the returned answerKey, clicks the
 * matching button, and advances. Mirrors answerQuestions: same auth gate, no
 * quota cost (quiz answers are factual and ride the Express budget already
 * debited by the cover letter), 422 on invalid input, 502 on upstream LLM
 * failure.
 *
 * Body shape: { question, options: [{key, text}, ...], profile, job }
 * Response: { ok: true, answerKey: "B" }
 *
 * The loop is multi-question — typical LaPieza tests are 5-15 questions —
 * so each call is short-context (one question, ≤6 options) to keep latency
 * low and avoid hitting prompt token caps.
 *
 * @param {{question: string, options: Array<{key: string, text: string}>, profile: object, job: object}} args
 * @returns {Promise<{ok: true, answerKey: string}>}
 */
export async function answerQuiz({ question, options, profile, job }) {
  return request("/applications/answer-quiz", {
    method: "POST",
    body: { question, options, profile, job }
  });
}

// ---------------------------------------------------------------------------
// Admin endpoints
// ---------------------------------------------------------------------------

/**
 * Switch the caller's own plan. Requires the user's email to be on the
 * backend ADMIN_USER_EMAILS allowlist; non-admins get FORBIDDEN.
 *
 * @param {"free"|"pro"|"premium"} plan
 * @returns {Promise<{ok: true, user: import('./schemas.js').AuthUser}>}
 */
export async function setAdminPlan(plan) {
  return request("/admin/me/plan", {
    method: "POST",
    body: { plan }
  });
}

/**
 * Parse CV raw text into a structured profile via the backend.
 * The backend returns a profile object without version/updatedAt/rawText —
 * we stamp those locally so consumers can persist directly.
 * @param {{text: string}} args
 * @returns {Promise<object>} a complete UserProfile (with version/updatedAt/rawText)
 */
export async function parseCVText({ text }) {
  const data = await request("/applications/parse-cv", {
    method: "POST",
    body: { text }
  });
  const parsed = (data && data.profile) || {};
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    personal: {
      fullName: parsed.personal?.fullName || "",
      email: parsed.personal?.email || "",
      phone: parsed.personal?.phone || "",
      location: parsed.personal?.location || "",
      ...(parsed.personal?.linkedin ? { linkedin: parsed.personal.linkedin } : {}),
      ...(parsed.personal?.website ? { website: parsed.personal.website } : {})
    },
    summary: parsed.summary || "",
    experience: Array.isArray(parsed.experience) ? parsed.experience : [],
    education: Array.isArray(parsed.education) ? parsed.education : [],
    skills: Array.isArray(parsed.skills) ? parsed.skills : [],
    languages: Array.isArray(parsed.languages) ? parsed.languages : [],
    rawText: text
  };
}
