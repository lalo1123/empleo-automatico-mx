// Popup: renders different states based on auth + profile + plan + draft.
// States:
//  1) Logged out                 → "Inicia sesión para empezar"
//  2) Logged in, no profile      → "Sube tu CV en Opciones"
//  3) Logged in, at plan limit   → "Llegaste al límite de tu plan."
//  4) Logged in, active draft    → draft summary
//  5) Logged in, ready           → "Navega a una vacante. Verás el botón flotante."

import { MESSAGE_TYPES, PLAN_LABELS } from "../lib/schemas.js";
import { sendMessage } from "../lib/messaging.js";

const root = document.getElementById("root");
const popFooter = document.getElementById("popFooter");
const popFooterOptions = document.getElementById("popFooterOptions");
const popFooterAccount = document.getElementById("popFooterAccount");
const popFooterVersion = document.getElementById("popFooterVersion");
const popHeaderVersion = document.getElementById("popHeaderVersion");

// Resolve manifest version once (defensive: chrome.runtime may be undefined in dev preview)
function getVersion() {
  try {
    const m = chrome?.runtime?.getManifest?.();
    if (m && m.version) return `v${m.version}`;
  } catch (_) {}
  return "v0.1.0";
}
const VERSION_LABEL = getVersion();
if (popHeaderVersion) popHeaderVersion.textContent = VERSION_LABEL;
if (popFooterVersion) popFooterVersion.textContent = VERSION_LABEL;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "onClick") node.addEventListener("click", v);
    else if (k === "html") node.innerHTML = v;
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function clear() {
  root.replaceChildren();
}

function openOptions() {
  if (chrome.runtime && chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  else window.open(chrome.runtime.getURL("options/options.html"));
  window.close();
}

async function openBilling() {
  try {
    await sendMessage({ type: MESSAGE_TYPES.OPEN_BILLING });
  } catch (_) { /* ignore */ }
  window.close();
}

// Wire footer (always visible after first render)
function showFooter() {
  if (popFooter && popFooter.hasAttribute("hidden")) popFooter.removeAttribute("hidden");
}

if (popFooterOptions) {
  popFooterOptions.addEventListener("click", (e) => { e.preventDefault(); openOptions(); });
}
if (popFooterAccount) {
  popFooterAccount.addEventListener("click", (e) => { e.preventDefault(); openOptions(); });
}

function planBadge(plan) {
  const key = (plan || "free").toLowerCase();
  return el(
    "span",
    { class: "plan-badge", "data-plan": key },
    PLAN_LABELS[key] || "Plan Gratis"
  );
}

function usageBlock(usage, opts = {}) {
  if (!usage || usage.limit == null || usage.current == null) return null;
  const limitNum = usage.limit === -1 ? Infinity : Number(usage.limit);
  const current = Number(usage.current) || 0;
  const limitLabel = usage.limit === -1 ? "ilimitado" : String(usage.limit);
  const pct = limitNum === Infinity ? 8 : Math.min(100, Math.round((current / Math.max(1, limitNum)) * 100));

  const wrapClass = opts.atLimit ? "usage usage--limit" : "usage";
  return el(
    "div",
    { class: wrapClass },
    el(
      "div",
      { class: "usage__head" },
      el("span", { class: "usage__label" }, "Postulaciones este mes"),
      el(
        "span",
        { class: "usage__value" },
        `${current}`,
        el("span", { class: "usage__sep" }, " / "),
        `${limitLabel}`
      )
    ),
    el(
      "div",
      { class: "usage__bar", "aria-hidden": "true" },
      el("div", { class: "usage__fill", style: `width: ${pct}%` })
    )
  );
}

function renderError(message) {
  clear();
  showFooter();
  const card = el(
    "section",
    { class: "card" },
    el(
      "div",
      { class: "card__head" },
      el("h1", {}, "Algo salió mal"),
      el("p", {}, message || "No pudimos cargar tu información. Intenta de nuevo.")
    ),
    el("div", { class: "error" }, message),
    el(
      "div",
      { class: "actions" },
      el("button", { class: "btn--block", onClick: openOptions }, "Abrir opciones")
    )
  );
  root.appendChild(card);
}

function renderLoggedOut() {
  clear();
  showFooter();
  const card = el(
    "section",
    { class: "card card--accent" },
    el(
      "div",
      { class: "card__head" },
      el("div", { class: "card__eyebrow" }, "Bienvenido"),
      el("h1", {}, "Inicia sesión para empezar"),
      el(
        "p",
        {},
        "Accede con tu cuenta de SkyBrandMX para postularte a más empleos con cartas generadas por IA."
      )
    ),
    el(
      "div",
      { class: "actions" },
      el("button", { class: "btn--block", onClick: openOptions }, "Abrir opciones")
    )
  );
  root.appendChild(card);
}

function renderNoProfile(user) {
  clear();
  showFooter();
  const card = el(
    "section",
    { class: "card" },
    el(
      "div",
      { class: "card__head card__head--row" },
      el(
        "div",
        {},
        el("div", { class: "card__eyebrow" }, "Siguiente paso"),
        el("h1", {}, "Sube tu CV en Opciones")
      ),
      planBadge(user?.plan)
    ),
    el(
      "p",
      {},
      "Necesitamos tu CV en PDF para que la IA personalice cada carta de presentación."
    ),
    el(
      "div",
      { class: "actions" },
      el("button", { class: "btn--block", onClick: openOptions }, "Abrir opciones")
    )
  );
  root.appendChild(card);
}

function renderPlanLimit(user, usage) {
  clear();
  showFooter();
  const limit = usage?.limit ?? 3;
  const current = usage?.current ?? limit;
  const card = el(
    "section",
    { class: "card card--danger" },
    el(
      "div",
      { class: "card__head card__head--row" },
      el(
        "div",
        {},
        el("div", { class: "card__eyebrow" }, "Plan al máximo"),
        el("h1", {}, "Llegaste al límite de tu plan.")
      ),
      planBadge(user?.plan)
    ),
    el(
      "p",
      {},
      `Usaste ${current}/${limit} postulaciones este mes en el ${PLAN_LABELS[user?.plan] || "Plan Gratis"}. Sube de plan para seguir postulándote.`
    ),
    usageBlock(usage, { atLimit: true }),
    el(
      "div",
      { class: "actions" },
      el("button", { class: "btn--block", onClick: openBilling }, "Ver planes")
    ),
    el(
      "div",
      { class: "actions actions--center" },
      el("button", { class: "link", onClick: openOptions }, "Mi cuenta")
    )
  );
  root.appendChild(card);
}

function renderReady(user, usage) {
  clear();
  showFooter();
  const card = el(
    "section",
    { class: "card" },
    el(
      "div",
      { class: "card__head card__head--row" },
      el(
        "div",
        {},
        el("div", { class: "card__eyebrow" }, "Listo para postular"),
        el("h1", {}, `Hola${user?.name ? `, ${user.name.split(" ")[0]}` : ""}`)
      ),
      planBadge(user?.plan)
    ),
    usageBlock(usage),
    el(
      "div",
      { class: "tip" },
      el(
        "span",
        { class: "tip__icon", "aria-hidden": "true" },
        sparkleSvg()
      ),
      el(
        "div",
        { class: "tip__body" },
        el("strong", {}, "Navega a una vacante."),
        el("span", {}, "Verás el botón flotante \u201cPostular con IA\u201d en OCC, Computrabajo, Bumeran, Indeed o LinkedIn.")
      )
    ),
    el(
      "div",
      { class: "actions actions--center" },
      el("button", { class: "link", onClick: openOptions }, "Mi cuenta")
    )
  );
  root.appendChild(card);
}

function sparkleSvg() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const p1 = document.createElementNS(ns, "path");
  p1.setAttribute("d", "M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1");
  svg.appendChild(p1);
  return svg;
}

function truncate(s, max) {
  if (!s) return "";
  const trimmed = s.trim().replace(/\s+/g, " ");
  return trimmed.length > max ? trimmed.slice(0, max - 1) + "\u2026" : trimmed;
}

async function onApprove(_draftId) {
  // The actual approval lives on the content-script panel; from popup we just
  // close so the user can return to the tab.
  window.close();
}

async function onReject(draftId) {
  try {
    await sendMessage({ type: MESSAGE_TYPES.REJECT_DRAFT, draftId });
    await render();
  } catch (e) {
    renderError(`No se pudo descartar: ${e.message}`);
  }
}

function renderDraft(draft, user) {
  clear();
  showFooter();
  const { job, coverLetter } = draft;
  const card = el(
    "section",
    { class: "card card--accent" },
    el(
      "div",
      { class: "card__head card__head--row" },
      el(
        "div",
        {},
        el("div", { class: "card__eyebrow" }, "Borrador listo"),
        el("h1", {}, "Revisa antes de aprobar")
      ),
      planBadge(user?.plan)
    ),
    el(
      "div",
      { class: "job-card" },
      el("div", { class: "job-card__title" }, job?.title || "Vacante"),
      el(
        "div",
        { class: "job-card__company" },
        [job?.company, job?.location].filter(Boolean).join(" \u00b7 ") || "—"
      ),
      el("div", { class: "job-card__cover" }, truncate(coverLetter, 280))
    ),
    el(
      "p",
      { class: "subtle" },
      "Vuelve a la pestaña de la vacante para revisar y aprobar el borrador."
    ),
    el(
      "div",
      { class: "btn-group" },
      el("button", { onClick: () => onApprove(draft.id) }, "Ver y aprobar"),
      el("button", { class: "danger", onClick: () => onReject(draft.id) }, "Descartar")
    )
  );
  root.appendChild(card);
}

function isAtPlanLimit(usage) {
  if (!usage) return false;
  if (usage.limit === -1 || usage.limit == null) return false;
  return (usage.current ?? 0) >= usage.limit;
}

async function render() {
  try {
    const [profile, authRes, draft] = await Promise.all([
      sendMessage({ type: MESSAGE_TYPES.GET_PROFILE }),
      sendMessage({ type: MESSAGE_TYPES.GET_AUTH_STATUS }),
      sendMessage({ type: MESSAGE_TYPES.GET_ACTIVE_DRAFT })
    ]);

    const loggedIn = !!(authRes && authRes.loggedIn);
    if (!loggedIn) {
      renderLoggedOut();
      return;
    }

    const hasProfile = !!(profile && profile.personal && profile.personal.fullName);
    if (!hasProfile) {
      renderNoProfile(authRes.user);
      return;
    }

    if (draft && draft.status === "draft") {
      renderDraft(draft, authRes.user);
      return;
    }

    if (isAtPlanLimit(authRes.usage)) {
      renderPlanLimit(authRes.user, authRes.usage);
      return;
    }

    renderReady(authRes.user, authRes.usage);
  } catch (e) {
    renderError(e.message || "Error al cargar el popup");
  }
}

render();
