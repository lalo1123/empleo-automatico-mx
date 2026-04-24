// Popup: renders different states based on auth + profile + plan + draft.
// States:
//  1) Logged out           → "Inicia sesión para empezar"
//  2) Logged in, no profile → "Sube tu CV en Opciones"
//  3) Logged in, at plan limit → "Upgrade" prompt with billing button
//  4) Logged in, active draft → draft summary
//  5) Logged in, ready      → "Listo. Navega a una vacante en OCC."

import { MESSAGE_TYPES, PLAN_LABELS } from "../lib/schemas.js";
import { sendMessage } from "../lib/messaging.js";

const root = document.getElementById("root");

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
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  else window.open(chrome.runtime.getURL("options/options.html"));
  window.close();
}

async function openBilling() {
  try {
    await sendMessage({ type: MESSAGE_TYPES.OPEN_BILLING });
  } catch (_) { /* ignore */ }
  window.close();
}

function renderError(message) {
  clear();
  root.appendChild(el("div", { class: "error" }, message));
  root.appendChild(
    el("button", { class: "secondary", onClick: openOptions }, "Abrir opciones")
  );
}

function renderLoggedOut() {
  clear();
  root.appendChild(el("h1", {}, "Empleo Autom\u00e1tico MX"));
  root.appendChild(
    el(
      "p",
      {},
      "Inicia sesi\u00f3n con tu cuenta de SkyBrandMX para empezar a postularte con IA."
    )
  );
  root.appendChild(el("button", { onClick: openOptions }, "Iniciar sesi\u00f3n"));
  root.appendChild(el("div", { class: "footer" }, "skybrandmx.com"));
}

function renderNoProfile() {
  clear();
  root.appendChild(el("h1", {}, "Falta tu CV"));
  root.appendChild(
    el(
      "p",
      {},
      "Sube tu CV en Opciones para que la IA lo use al generar tus cartas."
    )
  );
  root.appendChild(el("button", { onClick: openOptions }, "Subir CV en Opciones"));
}

function renderPlanLimit(user, usage) {
  clear();
  root.appendChild(el("h1", {}, "Llegaste al l\u00edmite"));
  const limit = usage?.limit ?? 3;
  root.appendChild(
    el(
      "p",
      {},
      `Usaste ${usage?.current ?? limit}/${limit} postulaciones este mes en el ` +
        `${PLAN_LABELS[user?.plan] || "Plan Gratis"}. Sube de plan para seguir postul\u00e1ndote.`
    )
  );
  root.appendChild(el("button", { onClick: openBilling }, "Ver planes y upgrade"));
  root.appendChild(
    el("button", { class: "link", onClick: openOptions }, "Opciones / Mi cuenta")
  );
}

function renderReady(user, usage) {
  clear();
  root.appendChild(el("h1", {}, "Listo"));
  root.appendChild(
    el(
      "p",
      {},
      "Navega a una vacante en OCC y aparecer\u00e1 el bot\u00f3n \u201cPostular con IA\u201d."
    )
  );
  if (usage && usage.limit != null && usage.current != null) {
    const limitLabel = usage.limit === -1 ? "ilimitado" : String(usage.limit);
    root.appendChild(
      el(
        "div",
        { class: "stats" },
        el(
          "div",
          {},
          el("div", { class: "stats-num" }, `${usage.current} / ${limitLabel}`),
          el("div", { class: "stats-label" }, `Postulaciones este mes \u00b7 ${PLAN_LABELS[user?.plan] || "Plan Gratis"}`)
        )
      )
    );
  }
  root.appendChild(
    el("button", { class: "link", onClick: openOptions }, "Opciones / Mi cuenta")
  );
}

function truncate(s, max) {
  if (!s) return "";
  const trimmed = s.trim().replace(/\s+/g, " ");
  return trimmed.length > max ? trimmed.slice(0, max - 1) + "\u2026" : trimmed;
}

async function onReject(draftId) {
  try {
    await sendMessage({ type: MESSAGE_TYPES.REJECT_DRAFT, draftId });
    await render();
  } catch (e) {
    renderError(`No se pudo descartar: ${e.message}`);
  }
}

function renderDraft(draft) {
  clear();
  const { job, coverLetter } = draft;
  const card = el(
    "div",
    { class: "job-card" },
    el("div", { class: "job-title" }, job.title || "Vacante"),
    el("div", { class: "job-company" }, [job.company, job.location].filter(Boolean).join(" \u00b7 ")),
    el("div", { class: "cover-preview" }, truncate(coverLetter, 180))
  );
  root.appendChild(el("h1", {}, "Borrador listo"));
  root.appendChild(card);
  root.appendChild(
    el(
      "p",
      { class: "subtle" },
      "Vuelve a la pesta\u00f1a de la vacante para revisar y aprobar."
    )
  );
  root.appendChild(
    el(
      "div",
      { class: "btn-group" },
      el("button", { class: "secondary", onClick: openOptions }, "Opciones"),
      el("button", { class: "danger", onClick: () => onReject(draft.id) }, "Descartar")
    )
  );
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
      renderNoProfile();
      return;
    }

    if (draft && draft.status === "draft") {
      renderDraft(draft);
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
