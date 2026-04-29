// Options page controller.
// Handles: login/signup + account summary (plan, usage, logout, billing),
// CV upload (pdf.js text extraction then backend parse), settings
// (language, auto-approve), and profile export/import.

import {
  MESSAGE_TYPES,
  DEFAULT_SETTINGS,
  PLAN_LABELS,
  ERROR_CODES,
  nowISO
} from "../lib/schemas.js";
import { sendMessage } from "../lib/messaging.js";

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

    if (profile) updatePreviewFromProfile(profile);
    await refreshExistingBanner();
    await refreshAuthState();
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
