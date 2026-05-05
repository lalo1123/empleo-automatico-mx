// Options page controller.
// Handles: login/signup + account summary (plan, usage, logout, billing),
// CV upload (pdf.js text extraction then backend parse), settings
// (language, auto-approve), and profile export/import.

import {
  MESSAGE_TYPES,
  DEFAULT_SETTINGS,
  PLAN_LABELS,
  ERROR_CODES,
  STORAGE_KEYS,
  nowISO
} from "../lib/schemas.js";
import { sendMessage } from "../lib/messaging.js";
import {
  getQueue,
  removeFromQueue,
  setQueue,
  markApplied,
  appliedThisMonth,
  QUEUE_STORAGE_KEY
} from "../lib/queue.js";
import { expandCitySynonyms, deriveImplicitPreferences } from "../lib/match-score.js";

// ---------------------------------------------------------------------------
// DOM shortcuts
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10 MB

// Auth card (logged out) refs
const authCard = $("authCard");
const tabLogin = $("tabLogin");
const tabSignup = $("tabSignup");
const loginForm = $("loginForm");
const signupForm = $("signupForm");
const loginEmail = $("loginEmail");
const loginPassword = $("loginPassword");
const loginBtn = $("loginBtn");
const loginStatus = $("loginStatus");
const signupName = $("signupName");
const signupEmail = $("signupEmail");
const signupPassword = $("signupPassword");
const signupBtn = $("signupBtn");
const signupStatus = $("signupStatus");

// Account card (logged in) refs
const nextStepsCard = $("nextStepsCard");
const accountCard = $("accountCard");
const accountName = $("accountName");
const accountEmail = $("accountEmail");
const planBadge = $("planBadge");
const usageCurrent = $("usageCurrent");
const usageLimit = $("usageLimit");
const manageBillingBtn = $("manageBillingBtn");
const logoutBtn = $("logoutBtn");
const accountStatus = $("accountStatus");

// Admin card refs (only ever shown when /account returns user.isAdmin === true).
const adminCard = $("adminCard");
const adminStatus = $("adminStatus");
const adminPlanButtons = adminCard
  ? Array.from(adminCard.querySelectorAll("[data-admin-plan]"))
  : [];

// Spanish-MX label for toast on plan change.
const PLAN_LABEL_SHORT = { free: "Gratis", pro: "Pro", premium: "Premium" };

// CV card refs
const cvExistingBanner = $("cvExistingBanner");
const cvExistingName = $("cvExistingName");
const cvExistingWhen = $("cvExistingWhen");
const cvReplaceBtn = $("cvReplace");
const dropzone = $("dropzone");
const fileInput = $("fileInput");
const cvProgress = $("cvProgress");
const cvProgressText = $("cvProgressText");
const cvPreview = $("cvPreview");
const pvName = $("pvName");
const pvRole = $("pvRole");
const pvYears = $("pvYears");
const pvSkills = $("pvSkills");
const rawJsonArea = $("rawJson");
const saveProfileBtn = $("saveProfile");
const cvStatus = $("cvStatus");

// Settings refs
const languageSelect = $("language");
const autoApproveInput = $("autoApprove");
const saveSettingsBtn = $("saveSettings");
const settingsStatus = $("settingsStatus");

// Express Mode radio refs. Lives in chrome.storage.local under
// STORAGE_KEYS.EXPRESS_MODE so the LaPieza content script can read it
// directly without round-tripping through the background worker.
const expressModeOnInput = $("expressModeOn");
const expressModeOffInput = $("expressModeOff");
const expressModeStatus = $("expressModeStatus");

// Preferences card refs. Stored in chrome.storage.local under
// STORAGE_KEYS.PREFERENCES — listing-page scanners read this on every
// scan so it must live in local (not the backend SETTINGS object).
const preferencesCard = $("preferencesCard");
const prefCityInput = $("prefCity");
const prefSalaryMinInput = $("prefSalaryMin");
const prefSalaryMaxInput = $("prefSalaryMax");
const prefModalityInputs = [
  $("prefModalityPresencial"),
  $("prefModalityRemoto"),
  $("prefModalityHibrido"),
  $("prefModalityAny")
].filter(Boolean);
const savePreferencesBtn = $("savePreferences");
const preferencesStatus = $("preferencesStatus");

// Modo Auto card refs. The card is Premium-only — toggling ON requires the
// disclaimer modal to be accepted once (AUTO_DISCLAIMER_SEEN), and the plan
// must be "premium" (or the locked CTA is shown instead). The auto-submit
// logic itself lives in content/lapieza.js (next agent), this is UI plumbing.
const autoModeCard = $("autoModeCard");
const autoModeToggle = $("autoModeToggle");
const autoStateLabel = $("autoStateLabel");
const autoCounterTotal = $("autoCounterTotal");
const autoBreakdown = $("autoBreakdown");
const autoCardLocked = $("autoCardLocked");
const autoToggleRow = $("autoToggleRow");
const autoModeStatus = $("autoModeStatus");
const autoDisclaimerModal = $("autoDisclaimerModal");

// Module-scoped cache of the logged-in user — the Modo Auto toggle reads
// plan from here on every change event so the handler can plan-gate
// without a round-trip. Refreshed inside renderAuthLoggedIn / renderAuthLoggedOut.
let currentUser = null;

const exportBtn = $("exportProfile");
const importBtn = $("importProfile");
const importInput = $("importInput");
const versionTag = $("versionTag");
const footerVersion = $("footerVersion");

function setStatus(el, kind, text) {
  if (!el) return;
  el.className = `status${kind ? " " + kind : ""}`;
  el.textContent = text || "";
}

function formatRelative(iso) {
  if (!iso) return "";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(mins) || mins < 0) return "";
  if (mins < 1) return "hace instantes";
  if (mins < 60) return `hace ${mins} min`;
  if (mins < 1440) return `hace ${Math.floor(mins / 60)} h`;
  return `hace ${Math.floor(mins / 1440)} d\u00edas`;
}

function yearsOfExperience(experience) {
  // Compute the chronological span covered by all experience entries
  // (merging overlaps), NOT the naive sum of individual durations — that
  // double-counts parallel jobs and listed-twice roles.
  if (!Array.isArray(experience) || !experience.length) return 0;
  const ranges = [];
  for (const e of experience) {
    const s = e.startDate && new Date(e.startDate);
    const f = e.endDate ? new Date(e.endDate) : new Date();
    if (!s || Number.isNaN(s.getTime()) || Number.isNaN(f.getTime())) continue;
    if (f.getTime() < s.getTime()) continue;
    ranges.push([s.getTime(), f.getTime()]);
  }
  if (!ranges.length) return 0;
  ranges.sort((a, b) => a[0] - b[0]);
  let totalMs = 0;
  let curStart = ranges[0][0];
  let curEnd = ranges[0][1];
  for (let i = 1; i < ranges.length; i++) {
    const [s, f] = ranges[i];
    if (s <= curEnd) {
      if (f > curEnd) curEnd = f;
    } else {
      totalMs += curEnd - curStart;
      curStart = s;
      curEnd = f;
    }
  }
  totalMs += curEnd - curStart;
  const years = totalMs / (1000 * 60 * 60 * 24 * 365.25);
  return Math.round(years * 10) / 10;
}

function updatePreviewFromProfile(profile) {
  pvName.textContent = profile?.personal?.fullName || "\u2014";
  pvRole.textContent = profile?.experience?.[0]?.role || "\u2014";
  const yrs = yearsOfExperience(profile?.experience);
  pvYears.textContent = yrs > 0 ? `${yrs}` : "\u2014";
  const top = (profile?.skills || []).slice(0, 3);
  pvSkills.textContent = top.length ? top.join(", ") : "\u2014";
  rawJsonArea.value = JSON.stringify(profile, null, 2);
  cvPreview.classList.remove("is-hidden");
}

// ---------------------------------------------------------------------------
// pdf.js loader — tolerant to either UMD (window.pdfjsLib) or .mjs module.
// The worker URL must point to the extension resource so the ServiceWorker
// spawned by pdf.js can load correctly under MV3.
// ---------------------------------------------------------------------------
async function getPdfLib() {
  if (window.pdfjsLib) return window.pdfjsLib;
  try {
    const mod = await import(chrome.runtime.getURL("vendor/pdf.min.mjs"));
    const lib = mod.default || mod;
    if (!window.pdfjsLib) window.pdfjsLib = lib;
    return lib;
  } catch (_) {
    throw new Error(
      "No se pudo cargar pdf.js. Verifica que vendor/pdf.min.js exista."
    );
  }
}

async function extractPdfText(arrayBuffer) {
  const lib = await getPdfLib();
  if (lib.GlobalWorkerOptions) {
    lib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.min.js");
  }
  const pdf = await lib.getDocument({ data: arrayBuffer }).promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join(" ") + "\n\n";
  }
  return text;
}

// ---------------------------------------------------------------------------
// Auth card
// ---------------------------------------------------------------------------

// Signup is on the website now, so the tabs / signup form may not exist.
// These helpers are tolerant of missing elements.
function showLoginTab() {
  tabLogin?.classList.add("is-active");
  tabSignup?.classList.remove("is-active");
  tabLogin?.setAttribute("aria-selected", "true");
  tabSignup?.setAttribute("aria-selected", "false");
  loginForm?.classList.remove("is-hidden");
  signupForm?.classList.add("is-hidden");
}

function showSignupTab() {
  tabSignup?.classList.add("is-active");
  tabLogin?.classList.remove("is-active");
  tabSignup?.setAttribute("aria-selected", "true");
  tabLogin?.setAttribute("aria-selected", "false");
  signupForm?.classList.remove("is-hidden");
  loginForm?.classList.add("is-hidden");
}

// Tabs are no longer rendered in the extension (signup happens on the
// landing). Guard the listeners so nothing crashes if the elements are absent.
if (tabLogin) tabLogin.addEventListener("click", showLoginTab);
if (tabSignup) tabSignup.addEventListener("click", showSignupTab);

loginBtn.addEventListener("click", async () => {
  const email = loginEmail.value.trim();
  const password = loginPassword.value;
  if (!email || !password) {
    setStatus(loginStatus, "err", "Escribe correo y contrase\u00f1a");
    return;
  }
  loginBtn.disabled = true;
  setStatus(loginStatus, "", "Iniciando sesi\u00f3n\u2026");
  try {
    const res = await sendMessage({ type: MESSAGE_TYPES.LOGIN, email, password });
    if (res?.ok) {
      setStatus(loginStatus, "ok", "\u00a1Listo!");
      loginPassword.value = "";
      await refreshAuthState();
    } else {
      setStatus(loginStatus, "err", res?.message || "No se pudo iniciar sesi\u00f3n");
    }
  } catch (e) {
    setStatus(loginStatus, "err", e.message || "Error al iniciar sesi\u00f3n");
  } finally {
    loginBtn.disabled = false;
  }
});

// Signup flow lives on the website now. The extension only does login.
// (See options.html: the "Crea tu cuenta gratis" CTA opens
//  https://empleo.skybrandmx.com/signup?source=extension in a new tab.)

logoutBtn.addEventListener("click", async () => {
  logoutBtn.disabled = true;
  setStatus(accountStatus, "", "Cerrando sesi\u00f3n\u2026");
  try {
    await sendMessage({ type: MESSAGE_TYPES.LOGOUT });
    setStatus(accountStatus, "ok", "Sesi\u00f3n cerrada");
    await refreshAuthState();
  } catch (e) {
    setStatus(accountStatus, "err", e.message || "Error al cerrar sesi\u00f3n");
  } finally {
    logoutBtn.disabled = false;
  }
});

manageBillingBtn.addEventListener("click", async () => {
  try {
    await sendMessage({ type: MESSAGE_TYPES.OPEN_BILLING });
  } catch (e) {
    setStatus(accountStatus, "err", e.message || "No se pudo abrir");
  }
});

// ---------------------------------------------------------------------------
// Admin card — switch plan (admin-only)
// ---------------------------------------------------------------------------

for (const btn of adminPlanButtons) {
  btn.addEventListener("click", async () => {
    const plan = btn.dataset.adminPlan;
    if (plan !== "free" && plan !== "pro" && plan !== "premium") return;

    // Disable the whole group while the request is in flight so we don't
    // race two clicks. Re-enable in finally.
    for (const b of adminPlanButtons) b.disabled = true;
    setStatus(adminStatus, "", "Cambiando plan\u2026");

    try {
      const res = await sendMessage({ type: MESSAGE_TYPES.ADMIN_SET_PLAN, plan });
      if (!res?.ok) {
        setStatus(adminStatus, "err", res?.message || "No se pudo cambiar el plan");
        return;
      }
      // Refresh from the server so usage + plan badge re-render consistently.
      await refreshAuthState();
      setStatus(
        adminStatus,
        "ok",
        `Plan cambiado a ${PLAN_LABEL_SHORT[plan] || plan}`
      );
    } catch (e) {
      setStatus(adminStatus, "err", e.message || "Error al cambiar el plan");
    } finally {
      for (const b of adminPlanButtons) b.disabled = false;
    }
  });
}

function renderAuthLoggedIn(user, usage) {
  // Cache the user so the Modo Auto toggle handler can plan-gate without
  // re-fetching. Updated by every refreshAuthState call.
  currentUser = user || null;
  authCard.classList.add("is-hidden");
  accountCard.classList.remove("is-hidden");
  nextStepsCard?.classList.remove("is-hidden");
  accountName.textContent = user?.name || user?.email || "\u2014";
  accountEmail.textContent = user?.email || "\u2014";
  planBadge.textContent = PLAN_LABELS[user?.plan] || "Plan Gratis";
  planBadge.dataset.plan = user?.plan || "free";
  if (usage && usage.current != null) {
    usageCurrent.textContent = String(usage.current);
    usageLimit.textContent = usage.limit === -1 ? "ilimitado" : String(usage.limit ?? "\u2014");
  } else {
    usageCurrent.textContent = "\u2014";
    usageLimit.textContent = "\u2014";
  }

  // Admin card visibility is purely UX — the backend still enforces the
  // allowlist, so flipping isAdmin in DevTools won't grant any real powers.
  if (adminCard) {
    adminCard.classList.toggle("is-hidden", !user?.isAdmin);
    if (user?.isAdmin) {
      const currentPlan = user?.plan || "free";
      for (const btn of adminPlanButtons) {
        btn.classList.toggle("is-current", btn.dataset.adminPlan === currentPlan);
      }
    }
  }
}

function renderAuthLoggedOut() {
  currentUser = null;
  authCard.classList.remove("is-hidden");
  accountCard.classList.add("is-hidden");
  nextStepsCard?.classList.add("is-hidden");
  adminCard?.classList.add("is-hidden");
  showLoginTab();
}

async function refreshAuthState() {
  try {
    const res = await sendMessage({ type: MESSAGE_TYPES.GET_AUTH_STATUS });
    if (res?.loggedIn && res.user) {
      renderAuthLoggedIn(res.user, res.usage);
      if (res.stale) {
        setStatus(accountStatus, "err", "Sin conexi\u00f3n con el servidor. Datos mostrados pueden estar desactualizados.");
      }
    } else {
      renderAuthLoggedOut();
    }
  } catch (_) {
    renderAuthLoggedOut();
  }
  // Modo Auto card depends on plan \u2014 repaint after every auth change so the
  // locked CTA / unlocked toggle stays consistent with the actual user state.
  try { paintAutoMode(); } catch (_) { /* paintAutoMode defined below */ }
}

// ---------------------------------------------------------------------------
// CV card
// ---------------------------------------------------------------------------

function openFilePicker() {
  fileInput.click();
}

dropzone.addEventListener("click", openFilePicker);
dropzone.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" || ev.key === " ") {
    ev.preventDefault();
    openFilePicker();
  }
});

["dragenter", "dragover"].forEach((t) =>
  dropzone.addEventListener(t, (ev) => {
    ev.preventDefault();
    dropzone.classList.add("drag");
  })
);
["dragleave", "drop"].forEach((t) =>
  dropzone.addEventListener(t, (ev) => {
    ev.preventDefault();
    dropzone.classList.remove("drag");
  })
);
dropzone.addEventListener("drop", (ev) => {
  const file = ev.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) handleFile(file);
  fileInput.value = "";
});

cvReplaceBtn.addEventListener("click", () => {
  cvExistingBanner.classList.add("is-hidden");
  openFilePicker();
});

async function handleFile(file) {
  setStatus(cvStatus, "", "");
  if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") {
    setStatus(cvStatus, "err", "Solo se acepta PDF");
    return;
  }
  if (file.size > MAX_PDF_BYTES) {
    setStatus(cvStatus, "err", "El archivo supera los 10 MB");
    return;
  }

  cvPreview.classList.add("is-hidden");
  cvProgress.classList.remove("is-hidden");
  cvProgressText.textContent = "Extrayendo texto del PDF\u2026";

  try {
    const buf = await file.arrayBuffer();
    const rawText = await extractPdfText(buf);
    if (!rawText || rawText.trim().length < 40) {
      throw new Error(
        "No se pudo extraer texto del PDF (quiz\u00e1s es un escaneo). Usa un PDF con texto seleccionable."
      );
    }

    cvProgressText.textContent = "Analizando&hellip;";
    const res = await sendMessage({ type: MESSAGE_TYPES.UPLOAD_CV, text: rawText });
    if (!res?.ok) {
      if (res?.error === ERROR_CODES.UNAUTHORIZED) {
        throw new Error("Tu sesi\u00f3n expir\u00f3. Vuelve a iniciar sesi\u00f3n e int\u00e9ntalo de nuevo.");
      }
      throw new Error(res?.message || "Error al analizar el CV");
    }

    updatePreviewFromProfile(res.profile);
    setStatus(cvStatus, "ok", "CV analizado. Revisa y guarda.");
  } catch (e) {
    setStatus(cvStatus, "err", e.message || "Error al procesar el CV");
  } finally {
    cvProgress.classList.add("is-hidden");
  }
}

saveProfileBtn.addEventListener("click", async () => {
  let profile;
  try {
    profile = JSON.parse(rawJsonArea.value);
  } catch (e) {
    setStatus(cvStatus, "err", "El JSON no es v\u00e1lido");
    return;
  }
  profile.updatedAt = nowISO();
  saveProfileBtn.disabled = true;
  try {
    const res = await sendMessage({ type: MESSAGE_TYPES.SAVE_PROFILE, profile });
    if (!res?.ok) throw new Error(res?.message || "No se pudo guardar");
    setStatus(cvStatus, "ok", "Perfil guardado");
    await refreshExistingBanner();
  } catch (e) {
    setStatus(cvStatus, "err", e.message);
  } finally {
    saveProfileBtn.disabled = false;
  }
});

async function refreshExistingBanner() {
  const profile = await sendMessage({ type: MESSAGE_TYPES.GET_PROFILE });
  if (profile?.personal?.fullName) {
    cvExistingName.textContent = `CV cargado: ${profile.personal.fullName}`;
    cvExistingWhen.textContent = `\u2014 actualizado ${formatRelative(profile.updatedAt)}`;
    cvExistingBanner.classList.remove("is-hidden");
  } else {
    cvExistingBanner.classList.add("is-hidden");
  }
}

// ---------------------------------------------------------------------------
// Settings card
// ---------------------------------------------------------------------------

saveSettingsBtn.addEventListener("click", async () => {
  const settings = {
    language: languageSelect.value,
    autoApprove: autoApproveInput.checked
  };
  saveSettingsBtn.disabled = true;
  try {
    const res = await sendMessage({ type: MESSAGE_TYPES.SAVE_SETTINGS, settings });
    if (res?.ok) setStatus(settingsStatus, "ok", "Configuraci\u00f3n guardada");
    else setStatus(settingsStatus, "err", res?.message || "No se pudo guardar");
  } catch (e) {
    setStatus(settingsStatus, "err", e.message);
  } finally {
    saveSettingsBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

exportBtn.addEventListener("click", async () => {
  const profile = await sendMessage({ type: MESSAGE_TYPES.GET_PROFILE });
  if (!profile) {
    setStatus(settingsStatus, "err", "No hay perfil para exportar");
    return;
  }
  const blob = new Blob([JSON.stringify(profile, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `empleo-automatico-perfil-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

importBtn.addEventListener("click", () => importInput.click());

importInput.addEventListener("change", async () => {
  const file = importInput.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const profile = JSON.parse(text);
    if (!profile || typeof profile !== "object" || !profile.personal) {
      throw new Error("JSON no tiene forma de UserProfile");
    }
    const res = await sendMessage({ type: MESSAGE_TYPES.SAVE_PROFILE, profile });
    if (!res?.ok) throw new Error(res?.message || "No se pudo importar");
    setStatus(settingsStatus, "ok", "Perfil importado");
    updatePreviewFromProfile(profile);
    await refreshExistingBanner();
  } catch (e) {
    setStatus(settingsStatus, "err", e.message);
  } finally {
    importInput.value = "";
  }
});

// ---------------------------------------------------------------------------
// Express Mode toggle (chrome.storage.local key: STORAGE_KEYS.EXPRESS_MODE)
//
// Why local storage and not the SETTINGS object: the LaPieza content script
// reads this on every FAB click and we want zero-latency / no-round-trip.
// Default is true — Express ON for new users.
// ---------------------------------------------------------------------------

function readExpressMode() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([STORAGE_KEYS.EXPRESS_MODE], (r) => {
        const v = r && r[STORAGE_KEYS.EXPRESS_MODE];
        // First run: stored key missing → default to true (Express on).
        if (typeof v === "boolean") resolve(v);
        else resolve(true);
      });
    } catch (_) {
      resolve(true);
    }
  });
}

function writeExpressMode(value) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [STORAGE_KEYS.EXPRESS_MODE]: !!value }, () => resolve());
    } catch (_) {
      resolve();
    }
  });
}

function paintExpressMode(value) {
  if (expressModeOnInput) expressModeOnInput.checked = !!value;
  if (expressModeOffInput) expressModeOffInput.checked = !value;
}

async function onExpressModeChange(ev) {
  // Both radios live in the same group so we toggle on either change. The
  // truthy mode is `value === "express"` (i.e. expressModeOn checked).
  const target = ev.target;
  if (!target) return;
  const next = target.value === "express";
  await writeExpressMode(next);
  paintExpressMode(next);
  setStatus(expressModeStatus, "ok", "Modo guardado");
  // Auto-clear the status line after 2.5s so it doesn't linger.
  setTimeout(() => {
    if (expressModeStatus && expressModeStatus.textContent === "Modo guardado") {
      setStatus(expressModeStatus, "", "");
    }
  }, 2500);
}

if (expressModeOnInput) expressModeOnInput.addEventListener("change", onExpressModeChange);
if (expressModeOffInput) expressModeOffInput.addEventListener("change", onExpressModeChange);

// ---------------------------------------------------------------------------
// Preferences (chrome.storage.local key: STORAGE_KEYS.PREFERENCES)
//
// Schema persisted (see lib/schemas.js → UserPreferences typedef):
//   { city, citySynonyms, modality, salaryMin, salaryMax, updatedAt }
//
// Read by listing-page scanners (LaPieza first) and passed as the third
// arg to computeMatchScore. Empty default = legacy scoring (no extra
// bonus). citySynonyms is computed at save time via expandCitySynonyms
// so the content script doesn't have to re-derive it on every scan.
// ---------------------------------------------------------------------------

// Plain numeric coercion that turns "" / undefined into null. Used so the
// stored object only carries numbers when the user actually filled the
// field, instead of carrying NaN / 0 / empty strings.
function readSalaryNumber(input) {
  if (!input) return null;
  const raw = input.value;
  if (raw === "" || raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return null;
  if (n > 1_000_000) return null;
  return Math.round(n);
}

function readPreferences() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([STORAGE_KEYS.PREFERENCES], (r) => {
        const v = r && r[STORAGE_KEYS.PREFERENCES];
        if (v && typeof v === "object") resolve(v);
        else resolve(null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

function writePreferences(value) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [STORAGE_KEYS.PREFERENCES]: value }, () => resolve());
    } catch (_) {
      resolve();
    }
  });
}

function paintPreferences(prefs) {
  const p = prefs || {};
  if (prefCityInput) prefCityInput.value = p.city || "";
  if (prefSalaryMinInput) prefSalaryMinInput.value = Number.isFinite(p.salaryMin) ? String(p.salaryMin) : "";
  if (prefSalaryMaxInput) prefSalaryMaxInput.value = Number.isFinite(p.salaryMax) ? String(p.salaryMax) : "";
  const target = p.modality || "any";
  for (const input of prefModalityInputs) {
    input.checked = input.value === target;
  }
  // If nothing checked (defensive), force "any" — the radios should always
  // have one selected so a click on Save persists a sensible default.
  if (!prefModalityInputs.some((i) => i.checked)) {
    const any = prefModalityInputs.find((i) => i.value === "any");
    if (any) any.checked = true;
  }
}

function readSelectedModality() {
  for (const input of prefModalityInputs) {
    if (input.checked) return input.value;
  }
  return "any";
}

if (savePreferencesBtn) {
  savePreferencesBtn.addEventListener("click", async () => {
    const city = (prefCityInput?.value || "").trim();
    const salaryMin = readSalaryNumber(prefSalaryMinInput);
    const salaryMax = readSalaryNumber(prefSalaryMaxInput);
    const modality = readSelectedModality();

    // Validation. We keep the rules permissive — the user might want to
    // set just a min, or just a city, etc. The only hard rule is that
    // when both salary bounds are set, min ≤ max.
    if (salaryMin != null && salaryMax != null && salaryMin > salaryMax) {
      setStatus(preferencesStatus, "err", "El salario mínimo no puede ser mayor que el máximo.");
      return;
    }

    const next = {
      modality,
      updatedAt: Date.now()
    };
    if (city) {
      next.city = city;
      // Compute the synonym list once at save time so the content scripts
      // can do an O(N) substring check per card without re-deriving the
      // table on every scan.
      try {
        next.citySynonyms = expandCitySynonyms(city);
      } catch (_) {
        next.citySynonyms = [city.toLowerCase()];
      }
    }
    if (salaryMin != null) next.salaryMin = salaryMin;
    if (salaryMax != null) next.salaryMax = salaryMax;

    savePreferencesBtn.disabled = true;
    try {
      await writePreferences(next);
      setStatus(preferencesStatus, "ok", "Preferencias guardadas");
      // Auto-clear after a few seconds so the green tick doesn't linger.
      setTimeout(() => {
        if (preferencesStatus && preferencesStatus.textContent === "Preferencias guardadas") {
          setStatus(preferencesStatus, "", "");
        }
      }, 2500);
    } catch (e) {
      setStatus(preferencesStatus, "err", e?.message || "No se pudo guardar");
    } finally {
      savePreferencesBtn.disabled = false;
    }
  });
}

// Cross-tab sync: if the user updates preferences from another extension
// page (e.g. LaPieza's "Filtros" stat opens this tab), keep the form in
// sync without forcing them to refresh.
try {
  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[STORAGE_KEYS.PREFERENCES]) {
        paintPreferences(changes[STORAGE_KEYS.PREFERENCES].newValue);
      }
    });
  }
} catch (_) { /* ignore */ }

// If the URL has #preferences, scroll the preferences card into view on
// load. The LaPieza "Filtros" stat opens the options page that way.
function maybeFocusPreferencesCard() {
  if (!preferencesCard) return;
  // Reveal the card unconditionally — it lives in the logged-in shell
  // alongside the queue card, but the user can change preferences even
  // before logging in (no backend dependency).
  preferencesCard.classList.remove("is-hidden");
  if (location.hash === "#preferences") {
    try { preferencesCard.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (_) {}
    if (prefCityInput) {
      try { prefCityInput.focus({ preventScroll: true }); } catch (_) {}
    }
  }
}

// ---------------------------------------------------------------------------
// "Mi cola" — discovery queue rendered from chrome.storage.local["eamx:queue"]
// Populated by content/lapieza.js → onMarkClick. We never write here except
// for "Quitar" (single-item delete) and "Vaciar cola" (clear). Listens to
// chrome.storage.onChanged so any tab's mark/unmark reflects instantly.
// ---------------------------------------------------------------------------

const queueSection = $("queue-section");
const queueListEl = $("queue-list");
const queueEmptyEl = $("queue-empty");
const queueActionsEl = $("queue-actions");
const queueClearBtn = $("queue-clear");
const queueStatusEl = $("queue-status");
const queueCounterQueueEl = $("qd-counter-queue");
const queueCounterAppliedEl = $("qd-counter-applied");

// Pretty source labels — keep in sync with SOURCES in lib/schemas.js. We
// avoid importing those constants because the strings are user-facing.
const QUEUE_SOURCE_LABELS = {
  lapieza: "LaPieza",
  occ: "OCC",
  computrabajo: "Computrabajo",
  bumeran: "Bumeran",
  indeed: "Indeed",
  linkedin: "LinkedIn"
};

// Status presentation — emoji + Spanish label for the right-side pill.
const STATUS_PRESENTATION = {
  comenzando: { icon: "🟠", label: "Comenzando" },          // 🟠
  postulando_ahora: { icon: "🟦", label: "Postulando ahora" }, // 🟦
  aplicada: { icon: "🟢", label: "Aplicado" }                  // 🟢
};

// Matches the brand-friendly gradients listed in the spec — picked by
// hashing the company name so each company gets a stable variant. The flame
// gradient is the rarest because we use it sparingly (visual accent, not
// the default) — having it as 1 of 5 keeps the LaPieza-heavy queue
// predominantly cyan/teal.
const LOGO_GRADIENTS = [
  "linear-gradient(135deg, #70d1c6, #137e7a)",
  "linear-gradient(135deg, #137e7a, #105971)",
  "linear-gradient(135deg, #2a9c91, #0d3f57)",
  "linear-gradient(135deg, #105971, #0f1d2c)",
  "linear-gradient(135deg, #ff6600, #c44a00)"
];

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Match the relative-time format used by content/lapieza.js so the user
// sees consistent copy across the extension. The aiapply.co reference uses
// terse forms like "Ahora", "3h", "4h" — we keep "hace X" because the
// queue cards are the user's *own* recent marks, not external feed items.
//   <60s  "Ahora"
//   <60m  "hace X min"
//   <24h  "hace X h"
//   else  "hace X días"
function queueRelative(ts) {
  if (!Number.isFinite(ts)) return "Ahora";
  const delta = Date.now() - ts;
  if (delta < 0) return "Ahora";
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return "Ahora";
  const min = Math.floor(sec / 60);
  if (min < 60) return `hace ${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `hace ${hr} h`;
  const days = Math.floor(hr / 24);
  return `hace ${days} d`;
}

// Stable-ish 32-bit hash for the company name → logo gradient mapping. We
// strip accents/case first so "Bimbó" and "bimbo" land on the same color.
function logoHash(s) {
  const norm = String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  let h = 0;
  for (let i = 0; i < norm.length; i++) {
    h = ((h << 5) - h + norm.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function logoGradient(companyName) {
  return LOGO_GRADIENTS[logoHash(companyName) % LOGO_GRADIENTS.length];
}

function logoLetter(companyName) {
  const norm = String(companyName || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
  if (!norm) return ""; // caller renders 📁 fallback
  const ch = norm[0];
  return ch ? ch.toUpperCase() : "";
}

function renderQueueItem(item) {
  const status = STATUS_PRESENTATION[item.status] ? item.status : "comenzando";
  const statusInfo = STATUS_PRESENTATION[status];
  const tags = Array.isArray(item.skillTags) ? item.skillTags.slice(0, 3) : [];
  const sourceLabel = QUEUE_SOURCE_LABELS[item.source] || item.source || "";
  const companyLine = [item.company, item.location, sourceLabel]
    .map((s) => (s || "").trim())
    .filter(Boolean)
    .join(" · ");
  const letter = logoLetter(item.company);
  const gradient = logoGradient(item.company);
  const isApplied = status === "aplicada";

  const li = document.createElement("li");
  li.className = `qd-card qd-card--${status}`;
  li.setAttribute("data-id", item.id || "");
  li.setAttribute("data-source", item.source || "");

  const tagsHtml = tags.length
    ? `<ul class="qd-card__tags" role="list">${tags
        .map((t) => `<li class="qd-card__tag">${escapeHtml(t)}</li>`)
        .join("")}</ul>`
    : "";

  const logoBody = letter
    ? `<span class="qd-card__logo-letter">${escapeHtml(letter)}</span>`
    : `<span class="qd-card__logo-fallback" aria-hidden="true">📁</span>`;

  // The "✓ La envié" button is suppressed once the user already marked it as
  // applied — leaving only "Quitar" so they can purge the entry once the
  // status becomes informational.
  const appliedBtnHtml = isApplied
    ? ""
    : `<button class="qd-card__action qd-card__action--applied" type="button" data-action="mark-applied" data-id="${escapeHtml(item.id || "")}" data-source="${escapeHtml(item.source || "")}">✓ La envié</button>`;

  li.innerHTML = `
    <div class="qd-card__logo" aria-hidden="true" style="background:${gradient}">${logoBody}</div>
    <div class="qd-card__main">
      <div class="qd-card__head">
        <div class="qd-card__title">
          <a href="${escapeHtml(item.url || "#")}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title || "(sin título)")}</a>
        </div>
        <span class="qd-card__time">${escapeHtml(queueRelative(item.savedAt))}</span>
      </div>
      <div class="qd-card__company">${escapeHtml(companyLine || "—")}</div>
      <div class="qd-card__row">
        ${tagsHtml}
        <span class="qd-card__status qd-card__status--${status}">
          <span class="qd-card__status-icon" aria-hidden="true">${statusInfo.icon}</span>
          <span class="qd-card__status-label">${escapeHtml(statusInfo.label)}</span>
        </span>
      </div>
      <div class="qd-card__actions">
        ${appliedBtnHtml}
        <button class="qd-card__action qd-card__action--remove" type="button" data-action="remove" data-id="${escapeHtml(item.id || "")}" data-source="${escapeHtml(item.source || "")}">Quitar</button>
      </div>
    </div>
  `;
  return li;
}

// Animate the counter pill briefly when its number changes. Honors
// prefers-reduced-motion via the CSS keyframe definition (see options.css
// → .qd-counter--tick / @media block).
function tickCounter(el, nextText) {
  if (!el) return;
  if (el.textContent === nextText) return;
  el.textContent = nextText;
  el.classList.remove("qd-counter--tick");
  // Force reflow so the class re-applies and the animation re-fires.
  // eslint-disable-next-line no-unused-expressions
  void el.offsetWidth;
  el.classList.add("qd-counter--tick");
}

function paintCounter(queue) {
  const total = queue.length;
  const applied = appliedThisMonth(queue);
  tickCounter(queueCounterQueueEl, `${total} en cola`);
  tickCounter(queueCounterAppliedEl, `${applied} este mes`);
}

async function paintQueue() {
  if (!queueSection) return;
  let queue = [];
  try { queue = await getQueue(); } catch (_) { queue = []; }

  // Show/hide the entire section depending on whether the user is logged in
  // (we keep it hidden in the logged-out shell). This is a soft gate — if
  // they ever marked a vacancy and then logged out, the queue still survives
  // in storage; we just don't surface it until they're back in.
  queueSection.classList.remove("is-hidden");

  paintCounter(queue);

  if (!queue.length) {
    queueEmptyEl.hidden = false;
    queueListEl.hidden = true;
    queueListEl.innerHTML = "";
    queueActionsEl.hidden = true;
    return;
  }

  // Sort newest-first so the user sees their most-recent marks at the top.
  // Within "applied" we keep them visible too — applied items aren't pulled
  // out of the queue, just visually tagged. The user can choose to "Quitar".
  const sorted = queue.slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));

  queueEmptyEl.hidden = true;
  queueListEl.hidden = false;
  queueActionsEl.hidden = false;
  queueListEl.innerHTML = "";
  for (const item of sorted) {
    queueListEl.appendChild(renderQueueItem(item));
  }
}

// Single delegated click handler covers all the per-card buttons (mark
// applied, remove). Keeps the listener count constant as the queue mutates.
if (queueListEl) {
  queueListEl.addEventListener("click", async (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;
    const btn = target.closest("[data-action]");
    if (!btn || !queueListEl.contains(btn)) return;
    const action = btn.getAttribute("data-action");
    const id = btn.getAttribute("data-id");
    const source = btn.getAttribute("data-source");
    if (!action || !id || !source) return;
    btn.disabled = true;
    try {
      if (action === "mark-applied") {
        await markApplied(id, source);
      } else if (action === "remove") {
        await removeFromQueue(id, source);
      }
      await paintQueue();
    } catch (e) {
      setStatus(queueStatusEl, "err", e?.message || "No se pudo actualizar");
    } finally {
      btn.disabled = false;
    }
  });
}

if (queueClearBtn) {
  queueClearBtn.addEventListener("click", async () => {
    const ok = window.confirm("¿Vaciar la cola completa? Esto no afecta tus postulaciones reales.");
    if (!ok) return;
    queueClearBtn.disabled = true;
    try {
      await setQueue([]);
      await paintQueue();
      setStatus(queueStatusEl, "ok", "Cola vaciada");
    } catch (e) {
      setStatus(queueStatusEl, "err", e?.message || "No se pudo vaciar");
    } finally {
      queueClearBtn.disabled = false;
    }
  });
}

// chrome.storage.onChanged keeps the options view in sync with whatever
// the LaPieza content script is doing in another tab. We re-render only
// when the queue key changes — no point repainting on every storage write.
try {
  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[QUEUE_STORAGE_KEY]) paintQueue();
    });
  }
} catch (_) { /* ignore */ }

// ---------------------------------------------------------------------------
// Modo Auto (Premium-only auto-submit toggle)
//
// Storage keys (all in chrome.storage.local — read by content/lapieza.js
// without a round-trip through the background worker):
//   AUTO_MODE              boolean — master kill switch
//   AUTO_DAILY             { date: "YYYY-MM-DD", count, perPortal: {...} }
//   AUTO_DISCLAIMER_SEEN   boolean — first-time activation gate
//   AUTO_LAST_SUBMIT_AT    used by the content script for inter-submit delay
//   AUTO_DAY_PAUSE         set by the content script after CAPTCHA / cap hit
//
// This file is UI plumbing only. The auto-submit logic, counter increment,
// and day-pause toast all live in content/lapieza.js (next agent).
// ---------------------------------------------------------------------------

// Per-portal cap. Mirrors lib/schemas.js → AUTO_MODE_DAILY_CAPS but kept
// inline so the UI doesn't have to import the constants table.
const AUTO_PER_PORTAL_CAP = 30;
const AUTO_TOTAL_CAP = 120;

// Local YYYY-MM-DD — used to detect a stale daily counter on paint.
function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function readAutoMode() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([STORAGE_KEYS.AUTO_MODE], (r) => {
        const v = r && r[STORAGE_KEYS.AUTO_MODE];
        resolve(typeof v === "boolean" ? v : false);
      });
    } catch (_) {
      resolve(false);
    }
  });
}

function writeAutoMode(value) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [STORAGE_KEYS.AUTO_MODE]: !!value }, () => resolve());
    } catch (_) {
      resolve();
    }
  });
}

function readAutoDaily() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([STORAGE_KEYS.AUTO_DAILY], (r) => {
        const v = r && r[STORAGE_KEYS.AUTO_DAILY];
        if (v && typeof v === "object") resolve(v);
        else resolve({ date: todayKey(), count: 0, perPortal: {} });
      });
    } catch (_) {
      resolve({ date: todayKey(), count: 0, perPortal: {} });
    }
  });
}

function readDisclaimerSeen() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([STORAGE_KEYS.AUTO_DISCLAIMER_SEEN], (r) => {
        const v = r && r[STORAGE_KEYS.AUTO_DISCLAIMER_SEEN];
        resolve(typeof v === "boolean" ? v : false);
      });
    } catch (_) {
      resolve(false);
    }
  });
}

function writeDisclaimerSeen(value) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [STORAGE_KEYS.AUTO_DISCLAIMER_SEEN]: !!value }, () => resolve());
    } catch (_) {
      resolve();
    }
  });
}

// Paint the card based on:
//   1) plan: premium unlocks, else locked CTA
//   2) AUTO_MODE storage key: reflects in checkbox + ON/OFF label
//   3) AUTO_DAILY: today's count rolled up across portals
// Synchronously reads the cached values via helper promises — paint is async
// but every entry point (init, change listener, toggle handler) awaits it.
async function paintAutoMode() {
  if (!autoModeCard) return;

  const isPremium = currentUser?.plan === "premium";
  const [autoOn, daily] = await Promise.all([readAutoMode(), readAutoDaily()]);

  // Plan gate. Non-Premium: hide toggle row + breakdown, show locked CTA,
  // disable the input so even keyboard users can't flip it accidentally.
  if (!isPremium) {
    if (autoToggleRow) autoToggleRow.hidden = true;
    if (autoBreakdown) autoBreakdown.hidden = true;
    if (autoCardLocked) autoCardLocked.hidden = false;
    if (autoModeToggle) {
      autoModeToggle.disabled = true;
      autoModeToggle.checked = false;
    }
    if (autoStateLabel) autoStateLabel.textContent = "OFF";
    if (autoCounterTotal) autoCounterTotal.textContent = `0/${AUTO_TOTAL_CAP} hoy`;
    return;
  }

  // Premium path.
  if (autoCardLocked) autoCardLocked.hidden = true;
  if (autoToggleRow) autoToggleRow.hidden = false;
  if (autoModeToggle) {
    autoModeToggle.disabled = false;
    autoModeToggle.checked = !!autoOn;
  }
  if (autoStateLabel) autoStateLabel.textContent = autoOn ? "ON" : "OFF";

  // Breakdown is only meaningful when the toggle is ON. We hide it when
  // OFF so the card has less visual weight in its default state.
  if (autoBreakdown) autoBreakdown.hidden = !autoOn;

  // Counter — only count today's value. If daily.date doesn't match today,
  // treat as zero (the content script resets the counter on a new day).
  const today = todayKey();
  const sameDay = daily && daily.date === today;
  const totalToday = sameDay ? Number(daily.count || 0) : 0;
  const perPortal = sameDay && daily.perPortal && typeof daily.perPortal === "object"
    ? daily.perPortal
    : {};

  if (autoCounterTotal) {
    autoCounterTotal.textContent = `${totalToday}/${AUTO_TOTAL_CAP} hoy`;
  }

  // Per-portal counts — read from the breakdown rows by data-portal.
  if (autoBreakdown) {
    const rows = autoBreakdown.querySelectorAll(".auto-card__portal");
    for (const row of rows) {
      const portal = row.getAttribute("data-portal");
      const count = Number(perPortal[portal] || 0);
      const countEl = row.querySelector(".auto-card__portal-count");
      if (countEl) countEl.textContent = `${count}/${AUTO_PER_PORTAL_CAP}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Disclaimer modal — focus trap + scroll lock + Escape to cancel.
// ---------------------------------------------------------------------------

let _autoModalPrevFocus = null;
let _autoModalKeyHandler = null;

function openAutoDisclaimerModal() {
  if (!autoDisclaimerModal) return;
  _autoModalPrevFocus = document.activeElement;
  autoDisclaimerModal.hidden = false;
  // Lock body scroll so the user can't lose context behind the backdrop.
  document.body.style.overflow = "hidden";

  // Focus the cancel button by default (less destructive than auto-focusing
  // the flame "accept" button).
  const cancelBtn = autoDisclaimerModal.querySelector('[data-action="cancel"]');
  try { cancelBtn?.focus(); } catch (_) {}

  // Escape → cancel. Tab cycling stays within the modal.
  _autoModalKeyHandler = (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeAutoDisclaimerModal();
      return;
    }
    if (ev.key !== "Tab") return;
    const focusables = autoDisclaimerModal.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      try { last.focus(); } catch (_) {}
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      try { first.focus(); } catch (_) {}
    }
  };
  document.addEventListener("keydown", _autoModalKeyHandler);
}

function closeAutoDisclaimerModal() {
  if (!autoDisclaimerModal) return;
  autoDisclaimerModal.hidden = true;
  document.body.style.overflow = "";
  if (_autoModalKeyHandler) {
    document.removeEventListener("keydown", _autoModalKeyHandler);
    _autoModalKeyHandler = null;
  }
  if (_autoModalPrevFocus && typeof _autoModalPrevFocus.focus === "function") {
    try { _autoModalPrevFocus.focus(); } catch (_) {}
  }
  _autoModalPrevFocus = null;
}

// Modal click delegation: backdrop / cancel / accept all carry data-action.
if (autoDisclaimerModal) {
  autoDisclaimerModal.addEventListener("click", async (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.closest("[data-action]")?.getAttribute("data-action");
    if (!action) return;
    if (action === "close" || action === "cancel") {
      closeAutoDisclaimerModal();
      return;
    }
    if (action === "accept") {
      // Defensive: only Premium users get here, but double-check before
      // flipping the master switch.
      if (currentUser?.plan !== "premium") {
        closeAutoDisclaimerModal();
        setStatus(autoModeStatus, "err", "Modo Auto requiere plan Premium.");
        return;
      }
      try {
        await writeDisclaimerSeen(true);
        await writeAutoMode(true);
        await paintAutoMode();
        setStatus(autoModeStatus, "ok", "Modo Auto activado.");
      } catch (e) {
        setStatus(autoModeStatus, "err", e?.message || "No se pudo activar Modo Auto.");
      } finally {
        closeAutoDisclaimerModal();
      }
    }
  });
}

// Toggle change handler — gates on plan + disclaimer.
if (autoModeToggle) {
  autoModeToggle.addEventListener("change", async (ev) => {
    const wantOn = ev.target.checked;

    // OFF flow — no friction.
    if (!wantOn) {
      await writeAutoMode(false);
      await paintAutoMode();
      setStatus(autoModeStatus, "ok", "Modo Auto desactivado.");
      return;
    }

    // ON flow — plan gate first.
    if (currentUser?.plan !== "premium") {
      ev.target.checked = false;
      setStatus(autoModeStatus, "err", "Modo Auto requiere plan Premium.");
      return;
    }

    // Disclaimer gate. If already accepted before, flip the switch directly.
    const seen = await readDisclaimerSeen();
    if (seen) {
      await writeAutoMode(true);
      await paintAutoMode();
      setStatus(autoModeStatus, "ok", "Modo Auto activado.");
      return;
    }

    // First-time activation — show the disclaimer modal and revert the
    // toggle visual state until the user explicitly accepts.
    ev.target.checked = false;
    openAutoDisclaimerModal();
  });
}

// Cross-tab + cross-script sync: when the content script increments the
// daily counter, or another options window flips AUTO_MODE, repaint here.
try {
  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (
        changes[STORAGE_KEYS.AUTO_MODE] ||
        changes[STORAGE_KEYS.AUTO_DAILY] ||
        changes[STORAGE_KEYS.AUTO_DISCLAIMER_SEEN]
      ) {
        paintAutoMode();
      }
    });
  }
} catch (_) { /* ignore */ }

// ---------------------------------------------------------------------------
// Initial load
// ---------------------------------------------------------------------------

async function init() {
  try {
    const [settings, profile] = await Promise.all([
      sendMessage({ type: MESSAGE_TYPES.GET_SETTINGS }),
      sendMessage({ type: MESSAGE_TYPES.GET_PROFILE })
    ]);
    const s = settings || DEFAULT_SETTINGS;
    languageSelect.value = s.language || "es";
    autoApproveInput.checked = !!s.autoApprove;

    // Express Mode lives in chrome.storage.local, NOT the backend SETTINGS
    // object — load it independently.
    const express = await readExpressMode();
    paintExpressMode(express);

    // Preferences live in chrome.storage.local too. We paint them BEFORE
    // refreshAuthState because the card is shown unconditionally (the
    // user can configure preferences without being logged in).
    //
    // First-run UX: when the user has uploaded a CV but never opened the
    // preferences card, we pre-populate the form with values derived from
    // the CV (city ← personal.location, salary ← summary/rawText scan,
    // modality ← summary scan). The user sees sensible defaults instead
    // of a blank form, and can confirm or adjust before clicking Save.
    // We DON'T persist these auto-derived values until the user clicks
    // Save — that way the saved-vs-implicit precedence stays clean.
    const prefs = await readPreferences();
    if (prefs) {
      paintPreferences(prefs);
    } else if (profile) {
      const implicit = deriveImplicitPreferences(profile);
      paintPreferences({
        city: implicit.city || "",
        modality: implicit.modality || "any",
        salaryMin: implicit.salaryMin || null,
        salaryMax: implicit.salaryMax || null
      });
      // Visual hint: the status line shows the user we filled this in
      // automatically. They click Save to persist.
      if (preferencesStatus && (implicit.city || implicit.salaryMin || implicit.modality !== "any")) {
        const bits = [];
        if (implicit.city) bits.push(`ciudad: ${implicit.city}`);
        if (implicit.modality && implicit.modality !== "any") bits.push(`modalidad: ${implicit.modality}`);
        if (implicit.salaryMin || implicit.salaryMax) bits.push("salario");
        preferencesStatus.textContent = `Detectado de tu CV (${bits.join(" · ")}). Guarda para confirmar.`;
        preferencesStatus.className = "status status--info";
      }
    } else {
      paintPreferences(null);
    }
    maybeFocusPreferencesCard();

    if (profile) updatePreviewFromProfile(profile);
    await refreshExistingBanner();
    await refreshAuthState();

    // Reveal the Modo Auto card (it's hidden in markup so the locked /
    // unlocked decision is made AFTER auth resolves, instead of flashing
    // an empty toggle). refreshAuthState already called paintAutoMode,
    // but we call it again here as a no-op safety net in case the user is
    // logged out (the card still renders, just locked).
    if (autoModeCard) {
      autoModeCard.hidden = false;
      await paintAutoMode();
    }

    // Queue paints last — it depends on chrome.storage.local, not on any
    // backend state, so it's safe even when offline / logged out.
    await paintQueue();
  } catch (e) {
    setStatus(accountStatus, "err", `Error al cargar: ${e.message}`);
  }

  // Version tags — read from manifest.
  const version = chrome.runtime.getManifest?.()?.version || "";
  if (version) {
    versionTag.textContent = `v${version}`;
    footerVersion.textContent = `Empleo Autom\u00e1tico MX v${version}`;
  }
}

init();
