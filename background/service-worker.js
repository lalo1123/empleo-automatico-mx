// Background service worker (Manifest V3, ES module).
// Routes runtime messages by msg.type and orchestrates storage + backend calls.

import {
  MESSAGE_TYPES,
  SOURCES,
  ERROR_CODES,
  generateId,
  nowISO
} from "../lib/schemas.js";
import * as storage from "../lib/storage.js";
import * as auth from "../lib/auth.js";
import * as backend from "../lib/backend.js";
import { BILLING_URL } from "../lib/config.js";
import { onMessage } from "../lib/messaging.js";

/**
 * Build the semantic field map sent back on APPROVE_DRAFT.
 * The content script translates these semantic keys to actual DOM selectors
 * per portal; keeping the background agnostic to OCC/LinkedIn/etc.
 */
function buildFormFields(profile, draft) {
  const p = (profile && profile.personal) || {};
  return {
    fullName: p.fullName || "",
    email: p.email || "",
    phone: p.phone || "",
    location: p.location || "",
    linkedin: p.linkedin || "",
    website: p.website || "",
    coverLetter: draft.coverLetter || ""
  };
}

/**
 * Convert a thrown backend error into the { ok: false, error, message } shape
 * message handlers return. Preserves the error code so callers can branch.
 * @param {unknown} err
 */
function failFromError(err) {
  if (err instanceof backend.BackendError) {
    return { ok: false, error: err.code, message: err.message };
  }
  const message = (err && err.message) || "Error desconocido";
  return { ok: false, error: ERROR_CODES.SERVER_ERROR, message };
}

// ---------------------------------------------------------------------------
// Per-message handlers
// ---------------------------------------------------------------------------

async function handleGetProfile() {
  return storage.getProfile();
}

async function handleGetSettings() {
  return storage.getSettings();
}

async function handleSaveSettings(msg) {
  const patch = (msg && msg.settings) || {};
  await storage.setSettings(patch);
  return { ok: true };
}

async function handleSaveProfile(msg) {
  const profile = msg && msg.profile;
  if (!profile) return { ok: false, error: ERROR_CODES.INVALID_INPUT, message: "Falta el perfil" };
  await storage.setProfile(profile);
  return { ok: true };
}

// UPLOAD_CV payload is { text } — the options page extracts the PDF text
// locally via pdf.js (which cannot run in a MV3 service worker) and forwards
// only the text. See ARCHITECTURE and lib/cv-parser.js for rationale.
async function handleUploadCV(msg) {
  const text = msg && (msg.text || msg.rawText);
  if (typeof text !== "string" || !text.trim()) {
    return { ok: false, error: ERROR_CODES.INVALID_INPUT, message: "Falta el texto del CV" };
  }
  try {
    const profile = await backend.parseCVText({ text });
    await storage.setProfile(profile);
    return { ok: true, profile };
  } catch (e) {
    return failFromError(e);
  }
}

// TEST_AUTH replaces the old TEST_API_KEY handler. Returns the account info
// if the token is valid; the options page uses this to verify login state.
async function handleTestAuth() {
  try {
    const data = await backend.getAccount();
    return { ok: true, user: data.user, usage: data.usage };
  } catch (e) {
    return failFromError(e);
  }
}

async function handleGenerateDraft(msg) {
  const job = msg && msg.job;
  if (!job) {
    return { ok: false, error: ERROR_CODES.INVALID_INPUT, message: "Falta información de la vacante" };
  }

  if (!(await auth.isLoggedIn())) {
    return {
      ok: false,
      error: ERROR_CODES.UNAUTHORIZED,
      message: "Inicia sesión en Opciones para generar cartas."
    };
  }

  const profile = await storage.getProfile();
  if (!profile) {
    return {
      ok: false,
      error: ERROR_CODES.INVALID_INPUT,
      message: "Sube tu CV en Opciones antes de generar una carta"
    };
  }

  // Normalize job fields that may be missing from the content script.
  const normalizedJob = {
    source: job.source || SOURCES.OCC,
    url: job.url || "",
    id: job.id || "",
    title: job.title || "",
    company: job.company || "",
    location: job.location || "",
    salary: job.salary == null ? null : job.salary,
    modality: job.modality == null ? null : job.modality,
    description: job.description || "",
    requirements: Array.isArray(job.requirements) ? job.requirements : [],
    extractedAt: job.extractedAt || nowISO()
  };

  let result;
  try {
    result = await backend.generateCoverLetter({ profile, job: normalizedJob });
  } catch (e) {
    if (e instanceof backend.PlanLimitError) {
      return {
        ok: false,
        error: ERROR_CODES.PLAN_LIMIT_EXCEEDED,
        message: "Llegaste al límite de tu plan. Upgrade en empleo.skybrandmx.com/account/billing"
      };
    }
    return failFromError(e);
  }

  const draft = {
    id: generateId(),
    job: normalizedJob,
    coverLetter: result.coverLetter || "",
    suggestedAnswers: result.suggestedAnswers || {},
    formFields: {}, // filled at approve-time by the content script if applicable
    status: "draft",
    createdAt: nowISO(),
    approvedAt: null,
    submittedAt: null,
    error: null
  };

  await storage.addDraft(draft); // also sets ACTIVE_DRAFT_ID

  // The backend returns fresh usage after each generation. Cache it on the
  // user record for the popup/options.
  if (result.usage && result.usage.current != null) {
    const current = await auth.getUser();
    if (current) await auth.setUser({ ...current, usage: result.usage });
  }

  return { ok: true, draftId: draft.id, draft, usage: result.usage || null };
}

async function handleGetActiveDraft() {
  return storage.getActiveDraft();
}

async function handleApproveDraft(msg) {
  const id = msg && msg.draftId;
  if (!id) return { ok: false, error: ERROR_CODES.INVALID_INPUT, message: "Falta draftId" };
  const current = await storage.getDraft(id);
  if (!current) return { ok: false, error: ERROR_CODES.INVALID_INPUT, message: "Draft no encontrado" };

  const profile = await storage.getProfile();
  const coverLetter =
    msg && typeof msg.coverLetter === "string" ? msg.coverLetter : current.coverLetter;
  const fields = buildFormFields(profile, { ...current, coverLetter });

  await storage.updateDraft(id, {
    coverLetter,
    formFields: fields,
    status: "approved",
    approvedAt: nowISO()
  });
  return { ok: true, fields };
}

async function handleRejectDraft(msg) {
  const id = msg && msg.draftId;
  if (!id) return { ok: false, error: ERROR_CODES.INVALID_INPUT, message: "Falta draftId" };
  await storage.removeDraft(id);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Auth handlers
// ---------------------------------------------------------------------------

async function handleSignup(msg) {
  const { email, password, name } = msg || {};
  if (!email || !password || !name) {
    return { ok: false, error: ERROR_CODES.INVALID_INPUT, message: "Completa nombre, correo y contraseña" };
  }
  try {
    const data = await backend.signup({ email, password, name });
    return { ok: true, user: data.user };
  } catch (e) {
    return failFromError(e);
  }
}

async function handleLogin(msg) {
  const { email, password } = msg || {};
  if (!email || !password) {
    return { ok: false, error: ERROR_CODES.INVALID_INPUT, message: "Escribe correo y contraseña" };
  }
  try {
    const data = await backend.login({ email, password });
    return { ok: true, user: data.user };
  } catch (e) {
    return failFromError(e);
  }
}

async function handleLogout() {
  try {
    await backend.logout();
    return { ok: true };
  } catch (e) {
    return failFromError(e);
  }
}

async function handleGetAuthStatus() {
  const token = await auth.getToken();
  if (!token) return { ok: true, loggedIn: false, user: null, usage: null };
  // Best-effort: try a fresh /account call; fall back to cached user if offline.
  try {
    const data = await backend.getAccount();
    return { ok: true, loggedIn: true, user: data.user, usage: data.usage };
  } catch (e) {
    if (e instanceof backend.UnauthorizedError) {
      return { ok: true, loggedIn: false, user: null, usage: null };
    }
    const user = await auth.getUser();
    return { ok: true, loggedIn: true, user, usage: null, stale: true };
  }
}

async function handleOpenBilling() {
  try {
    await chrome.tabs.create({ url: BILLING_URL });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: ERROR_CODES.SERVER_ERROR, message: (e && e.message) || "No se pudo abrir el navegador" };
  }
}

// Admin-only: switch the caller's own plan without paying. The backend
// enforces the allowlist via ADMIN_USER_EMAILS — we surface its FORBIDDEN
// response unchanged. On success we refresh the cached user so the rest of
// the UI reflects the new plan immediately (no /account roundtrip needed).
async function handleAdminSetPlan(msg) {
  const plan = msg && msg.plan;
  if (plan !== "free" && plan !== "pro" && plan !== "premium") {
    return { ok: false, error: ERROR_CODES.INVALID_INPUT, message: "Plan inválido" };
  }
  try {
    const data = await backend.setAdminPlan(plan);
    if (data && data.user) {
      await auth.setUser(data.user);
    }
    return { ok: true, user: (data && data.user) || null };
  } catch (e) {
    return failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

onMessage(async (msg) => {
  if (!msg || !msg.type) {
    return { ok: false, error: ERROR_CODES.INVALID_INPUT, message: "Mensaje sin tipo" };
  }
  switch (msg.type) {
    case MESSAGE_TYPES.GET_PROFILE:
      return handleGetProfile();
    case MESSAGE_TYPES.GET_SETTINGS:
      return handleGetSettings();
    case MESSAGE_TYPES.SAVE_SETTINGS:
      return handleSaveSettings(msg);
    case MESSAGE_TYPES.SAVE_PROFILE:
      return handleSaveProfile(msg);
    case MESSAGE_TYPES.UPLOAD_CV:
      return handleUploadCV(msg);
    case MESSAGE_TYPES.TEST_AUTH:
      return handleTestAuth();
    case MESSAGE_TYPES.GENERATE_DRAFT:
      return handleGenerateDraft(msg);
    case MESSAGE_TYPES.GET_ACTIVE_DRAFT:
      return handleGetActiveDraft();
    case MESSAGE_TYPES.APPROVE_DRAFT:
      return handleApproveDraft(msg);
    case MESSAGE_TYPES.REJECT_DRAFT:
      return handleRejectDraft(msg);
    case MESSAGE_TYPES.SIGNUP:
      return handleSignup(msg);
    case MESSAGE_TYPES.LOGIN:
      return handleLogin(msg);
    case MESSAGE_TYPES.LOGOUT:
      return handleLogout();
    case MESSAGE_TYPES.GET_AUTH_STATUS:
      return handleGetAuthStatus();
    case MESSAGE_TYPES.OPEN_BILLING:
      return handleOpenBilling();
    case MESSAGE_TYPES.ADMIN_SET_PLAN:
      return handleAdminSetPlan(msg);
    default:
      return {
        ok: false,
        error: ERROR_CODES.INVALID_INPUT,
        message: `Tipo de mensaje no soportado: ${msg.type}`
      };
  }
});

// ---------------------------------------------------------------------------
// First-install UX
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const [profile, loggedIn] = await Promise.all([
      storage.getProfile(),
      auth.isLoggedIn()
    ]);
    if (!loggedIn || !profile) {
      if (chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage();
      }
    }
  } catch (_) {
    // If storage fails here, just do nothing. The user can open Options manually.
  }
});
