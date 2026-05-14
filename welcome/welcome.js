/**
 * welcome.js
 * First-install onboarding flow. Drives a 3-step setup:
 *   1) Auth (signup via landing OR inline login)
 *   2) CV upload (drag-drop or click to select PDF)
 *   3) Done — links to the 6 supported portals
 *
 * State is read from chrome.storage on load and steps auto-advance.
 * Users returning to this page (post-signup) skip past completed steps.
 *
 * Shares two key contracts with options.js to avoid code duplication:
 *   - PDF text extraction via vendor/pdf.min.js (UMD or ESM)
 *   - chrome.runtime.sendMessage with MESSAGE_TYPES from lib/schemas.js
 */

import { MESSAGE_TYPES, STORAGE_KEYS, ERROR_CODES } from "../lib/schemas.js";

const LANDING_SIGNUP_URL = "https://empleo.skybrandmx.com/signup";
const LANDING_LOGIN_URL = "https://empleo.skybrandmx.com/login";
const OPTIONS_URL = chrome.runtime.getURL("options/options.html");

// =============================================================================
// DOM refs
// =============================================================================
const $ = (sel) => document.querySelector(sel);

const stepEls = Array.from(document.querySelectorAll(".step"));
const cardAuth = $("#card-auth");
const cardCv = $("#card-cv");
const cardDone = $("#card-done");

const authPending = $("#authPending");
const authDone = $("#authDone");
const authDoneEmail = $("#authDoneEmail");
const logoutBtn = $("#logoutBtn");
const goSignup = $("#goSignup");
const loginForm = $("#loginForm");
const loginEmail = $("#loginEmail");
const loginPassword = $("#loginPassword");
const loginBtn = $("#loginBtn");
const loginStatus = $("#loginStatus");

const dropZone = $("#dropZone");
const cvInput = $("#cvInput");
const cvProgress = $("#cvProgress");
const cvProgressFill = $("#cvProgressFill");
const cvProgressText = $("#cvProgressText");
const cvResult = $("#cvResult");
const cvResultSub = $("#cvResultSub");
const cvReplaceBtn = $("#cvReplaceBtn");
const cvError = $("#cvError");

const skipToOptions = $("#skipToOptions");

// =============================================================================
// Helpers
// =============================================================================

/**
 * Promise-style chrome.runtime.sendMessage. MV3 service workers can stall
 * on cold start; we use a 30s timeout to fail loudly instead of hanging.
 */
function sendMessage(message) {
  return new Promise((resolve) => {
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: "TIMEOUT", message: "El servicio no respondió" });
    }, 30_000);
    try {
      chrome.runtime.sendMessage(message, (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: "RUNTIME", message: chrome.runtime.lastError.message });
          return;
        }
        resolve(res ?? { ok: false, error: "EMPTY_RESPONSE" });
      });
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve({ ok: false, error: "THROWN", message: String(e) });
    }
  });
}

function setStep(stepKey, state) {
  // state: "active" | "done" | "locked"
  for (const el of stepEls) {
    if (el.dataset.step !== stepKey) continue;
    el.classList.remove("is-active", "is-done");
    if (state === "active") el.classList.add("is-active");
    if (state === "done") el.classList.add("is-done");
  }
}

function setCardLocked(cardEl, locked) {
  if (!cardEl) return;
  cardEl.classList.toggle("is-locked", locked);
}

function setCardDone(cardEl, done) {
  if (!cardEl) return;
  cardEl.classList.toggle("is-done", done);
}

// =============================================================================
// State sync
// =============================================================================

async function refreshState() {
  // Auth: check both TEST_AUTH (live token validation) AND
  // chrome.storage.local["settings"]["authToken"] as a backup signal —
  // immediately after a successful LOGIN message the storage write
  // races the background's TEST_AUTH response. If we only believed
  // TEST_AUTH.loggedIn we'd briefly show the login form again before
  // the next refresh tick (storage onChange) caught up. Reading the
  // token from storage closes that race.
  const [authRes, storage] = await Promise.all([
    sendMessage({ type: MESSAGE_TYPES.TEST_AUTH }),
    new Promise((res) => chrome.storage.local.get([STORAGE_KEYS.PROFILE, STORAGE_KEYS.SETTINGS], res))
  ]);

  const settings = (storage && storage[STORAGE_KEYS.SETTINGS]) || {};
  const tokenInStorage = !!(settings && settings.authToken);

  // TEST_AUTH returns { ok: true } even when not logged in (the call
  // succeeded; the auth state is in `loggedIn`). Treat as logged in
  // when EITHER the live test confirms it OR we have a token in
  // storage (covers the immediate-post-login race).
  const liveAuth = !!(authRes && authRes.ok && authRes.loggedIn);
  const isLoggedIn = liveAuth || tokenInStorage;
  const userEmail =
    (authRes && authRes.user && authRes.user.email) ||
    (settings && settings.user && settings.user.email) ||
    "";
  const profile = storage && storage[STORAGE_KEYS.PROFILE];
  const hasCv = !!(profile && (profile.rawText || (profile.experiences && profile.experiences.length)));

  console.log("[welcome] refreshState:", {
    isLoggedIn, liveAuth, tokenInStorage, hasCv, userEmail,
    authResOk: authRes?.ok, authResLoggedIn: authRes?.loggedIn
  });

  // Reset the CV card's "result" state on every refresh. Without this,
  // a previous refreshState() call that set cvResult.hidden=false would
  // leak into subsequent calls (e.g. user logs out → cvResult would
  // still claim "CV cargado" until the page reload).
  if (cvResult) cvResult.hidden = true;
  if (cvProgress) cvProgress.hidden = true;
  if (cvError) cvError.hidden = true;
  if (dropZone) dropZone.hidden = false;

  // Swap Step 1 between "show login form" and "show success card with
  // sign-out link". Without this both states stack and the user sees
  // the password input below "✓ Sesión iniciada", which they read as
  // "I still need to log in again".
  if (!isLoggedIn) {
    if (authPending) authPending.hidden = false;
    if (authDone) authDone.hidden = true;
    setStep("auth", "active");
    setStep("cv", "locked");
    setStep("done", "locked");
    setCardLocked(cardAuth, false);
    setCardLocked(cardCv, true);
    setCardLocked(cardDone, true);
    return;
  }
  if (authPending) authPending.hidden = true;
  if (authDone) authDone.hidden = false;
  if (authDoneEmail) authDoneEmail.textContent = userEmail || "Tu sesión está activa";
  setStep("auth", "done");
  setCardDone(cardAuth, true);
  setCardLocked(cardAuth, false);

  if (!hasCv) {
    setStep("cv", "active");
    setStep("done", "locked");
    setCardLocked(cardCv, false);
    setCardLocked(cardDone, true);
    return;
  }
  // CV uploaded — mark step done, hide the drop zone, surface the
  // success card with the user's parsed name. The drop zone hidden is
  // critical: previous build showed BOTH the drop zone AND the success
  // card simultaneously, confusing users who thought they had to upload
  // again.
  setStep("cv", "done");
  setCardDone(cardCv, true);
  setStep("done", "active");
  setCardLocked(cardDone, false);
  if (dropZone) dropZone.hidden = true;
  cvResult.hidden = false;
  const personName = (profile && (profile.fullName || (profile.personal && profile.personal.fullName))) || "";
  if (personName) {
    cvResultSub.textContent = `Listo, ${personName.split(" ")[0]}. Tu perfil está cargado.`;
  } else {
    cvResultSub.textContent = "Tu perfil está cargado y listo para postular.";
  }
}

// =============================================================================
// Step 1: Auth
// =============================================================================

goSignup.href = LANDING_SIGNUP_URL;
goSignup.addEventListener("click", (ev) => {
  // The landing handles signup + email verify; the user comes back here
  // (or to Options) after completing it. We open in a NEW TAB so the
  // welcome page stays anchored as their setup checklist.
  // Nothing else to do — default <a target="_blank"> behavior.
});

// "Cerrar sesión" inside the auth success card. Fire-and-forget LOGOUT
// message — refreshState() picks up the new state via the storage
// onChanged listener and reverts Step 1 to the login form.
if (logoutBtn) {
  logoutBtn.addEventListener("click", async (ev) => {
    ev.preventDefault();
    logoutBtn.disabled = true;
    try {
      await sendMessage({ type: MESSAGE_TYPES.LOGOUT });
    } catch (_) { /* ignore */ }
    logoutBtn.disabled = false;
    await refreshState();
  });
}

loginForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const email = (loginEmail.value || "").trim();
  const password = loginPassword.value || "";
  if (!email || !password) {
    loginStatus.className = "login__status is-error";
    loginStatus.textContent = "Escribe correo y contraseña.";
    return;
  }
  loginBtn.disabled = true;
  loginStatus.className = "login__status";
  loginStatus.textContent = "Iniciando sesión…";
  const res = await sendMessage({ type: MESSAGE_TYPES.LOGIN, email, password });
  loginBtn.disabled = false;
  if (res && res.ok) {
    loginStatus.className = "login__status is-ok";
    loginStatus.textContent = "¡Listo! Tu cuenta está lista.";
    loginPassword.value = "";
    await refreshState();
    // Auto-scroll the CV card into view so the user sees the next step.
    setTimeout(() => cardCv.scrollIntoView({ behavior: "smooth", block: "center" }), 300);
  } else {
    loginStatus.className = "login__status is-error";
    loginStatus.textContent = (res && res.message)
      || "No pudimos iniciar sesión. Verifica tus datos.";
  }
});

// =============================================================================
// Step 2: CV upload
// =============================================================================

dropZone.addEventListener("click", () => cvInput.click());

// "Reemplazar" inside the success card → reveal the drop zone again so
// the user can drag a new CV without leaving this page. We don't clear
// the success card itself — the new upload will overwrite the parsed
// profile and refreshState() will re-render.
if (cvReplaceBtn) {
  cvReplaceBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    if (dropZone) {
      dropZone.hidden = false;
      dropZone.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    cvInput.click();
  });
}
dropZone.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" || ev.key === " ") {
    ev.preventDefault();
    cvInput.click();
  }
});

["dragenter", "dragover"].forEach((evt) => {
  dropZone.addEventListener(evt, (ev) => {
    ev.preventDefault();
    dropZone.classList.add("is-dragover");
  });
});
["dragleave", "drop"].forEach((evt) => {
  dropZone.addEventListener(evt, (ev) => {
    ev.preventDefault();
    dropZone.classList.remove("is-dragover");
  });
});
dropZone.addEventListener("drop", (ev) => {
  const files = ev.dataTransfer?.files;
  if (files && files.length) handleCvFile(files[0]);
});
cvInput.addEventListener("change", (ev) => {
  const file = ev.target.files && ev.target.files[0];
  if (file) handleCvFile(file);
});

async function handleCvFile(file) {
  cvError.hidden = true;
  cvError.textContent = "";
  cvResult.hidden = true;

  // Sanity checks before reading.
  if (file.type && !/pdf/i.test(file.type)) {
    showCvError("El archivo debe ser PDF.");
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showCvError("El archivo es muy grande (máx 5 MB).");
    return;
  }

  // Show progress + read PDF.
  cvProgress.hidden = false;
  cvProgressFill.style.width = "20%";
  cvProgressText.textContent = "Leyendo PDF…";

  let text;
  try {
    const buf = await file.arrayBuffer();
    text = await extractPdfText(buf);
    if (!text || !text.trim()) throw new Error("PDF sin texto extraíble");
  } catch (e) {
    showCvError(
      "No pudimos leer el PDF. ¿Es un escaneo? Asegúrate de que el texto" +
      " sea seleccionable."
    );
    cvProgress.hidden = true;
    return;
  }

  cvProgressFill.style.width = "60%";
  cvProgressText.textContent = "Analizando con IA…";

  const res = await sendMessage({ type: MESSAGE_TYPES.UPLOAD_CV, text });

  if (!res || !res.ok) {
    if (res && res.error === ERROR_CODES.UNAUTHORIZED) {
      showCvError("Tu sesión expiró. Vuelve al paso 1 para iniciar sesión.");
    } else {
      showCvError((res && res.message) || "No pudimos analizar tu CV.");
    }
    cvProgress.hidden = true;
    return;
  }

  cvProgressFill.style.width = "100%";
  cvProgressText.textContent = "Listo.";
  setTimeout(() => { cvProgress.hidden = true; }, 300);

  await refreshState();
  // Auto-scroll to the "done" card so the user sees their next action.
  setTimeout(() => cardDone.scrollIntoView({ behavior: "smooth", block: "center" }), 400);
}

function showCvError(msg) {
  cvError.hidden = false;
  cvError.textContent = msg;
}

// =============================================================================
// pdf.js — mirror options.js's tolerant loader (UMD or ESM)
// =============================================================================

async function getPdfLib() {
  if (window.pdfjsLib) return window.pdfjsLib;
  try {
    const mod = await import(chrome.runtime.getURL("vendor/pdf.min.mjs"));
    const lib = mod.default || mod;
    if (!window.pdfjsLib) window.pdfjsLib = lib;
    return lib;
  } catch (_) {
    throw new Error("No se pudo cargar pdf.js");
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
    // Update progress bar as we walk the pages (smooth 20%→60% range).
    const pct = 20 + (40 * (i / pdf.numPages));
    cvProgressFill.style.width = `${pct.toFixed(0)}%`;
  }
  return text;
}

// =============================================================================
// Footer: skip to advanced options
// =============================================================================

skipToOptions.addEventListener("click", (ev) => {
  ev.preventDefault();
  chrome.tabs.create({ url: OPTIONS_URL });
});

// =============================================================================
// Boot
// =============================================================================

(async function init() {
  // chrome.storage.onChanged fires when the user signs in from another tab
  // (e.g. lands back from the website signup flow). Refresh state in real
  // time so the welcome page advances without a manual reload.
  chrome.storage.onChanged.addListener((changes, area) => {
    // The auth token lives inside SETTINGS (see lib/auth.js → settings.token),
    // so watching SETTINGS catches both login changes and any settings
    // touch from Options. PROFILE changes when the CV is parsed.
    const watched = [STORAGE_KEYS.PROFILE, STORAGE_KEYS.SETTINGS];
    if (Object.keys(changes).some((k) => watched.includes(k))) {
      refreshState();
    }
  });
  await refreshState();
})();
