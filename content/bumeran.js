/**
 * content/bumeran.js — Bumeran México content script (Empleo Automático MX)
 *
 * Confidence on Bumeran selectors: LOW. bumeran.com.mx is fronted by Cloudflare
 * (403 to WebFetch), so DOM hooks were NOT verified live. Defensive cascade
 * (same strategy as OCC/Computrabajo agents):
 *   1) JSON-LD @type JobPosting (SEO structured data for Google for Jobs)
 *   2) Microdata / ARIA / semantic HTML (itemprop, h1, address)
 *   3) Class wildcards: aviso, empresa, ubicacion, descripcion, requisito
 *      (Bumeran historically calls postings "avisos")
 *   4) Largest text block in <main>/<article> as last resort
 * MVP assumes the user is logged into Bumeran in the same session.
 *
 * Mirrors content/computrabajo.js 1:1 in structure. Differences: SOURCE,
 * URL patterns (/empleos/aviso-..., /postulacion/...), modality synonyms
 * ("a distancia", "home office"), id extraction order (?id=, last numeric
 * path segment, url hash).
 */
(function () {
  "use strict";

  const SOURCE = "bumeran";
  const MSG = { GENERATE_DRAFT: "GENERATE_DRAFT", APPROVE_DRAFT: "APPROVE_DRAFT", REJECT_DRAFT: "REJECT_DRAFT", OPEN_BILLING: "OPEN_BILLING" };
  const ERR = { UNAUTHORIZED: "UNAUTHORIZED", PLAN_LIMIT_EXCEEDED: "PLAN_LIMIT_EXCEEDED" };
  const BILLING_URL = "https://empleo.skybrandmx.com/account/billing";

  // TODO(dom): verify against real Bumeran URLs. Covers /empleos/aviso-...
  // slug+id, legacy /empleos/<slug>-<id>, and the /postulacion/... flow.
  const JOB_URL_PATTERNS = [
    /\/empleos\/aviso-/i,
    /\/empleos\/[^/?#]+-\d+/i,
    /\/empleos\/[^/?#]+\/?[?&]/i,
    /\/postulacion\//i
  ];

  // Dynamic import of shared schemas (same pattern as occ.js/computrabajo.js).
  // MV3 content scripts can't declare ES imports via manifest; runtime dynamic
  // import via web_accessible_resources works.
  (async function syncSchema() {
    try {
      const mod = await import(chrome.runtime.getURL("lib/schemas.js"));
      if (mod && mod.MESSAGE_TYPES) Object.assign(MSG, {
        GENERATE_DRAFT: mod.MESSAGE_TYPES.GENERATE_DRAFT,
        APPROVE_DRAFT: mod.MESSAGE_TYPES.APPROVE_DRAFT,
        REJECT_DRAFT: mod.MESSAGE_TYPES.REJECT_DRAFT,
        OPEN_BILLING: mod.MESSAGE_TYPES.OPEN_BILLING
      });
      if (mod && mod.ERROR_CODES) Object.assign(ERR, {
        UNAUTHORIZED: mod.ERROR_CODES.UNAUTHORIZED,
        PLAN_LIMIT_EXCEEDED: mod.ERROR_CODES.PLAN_LIMIT_EXCEEDED
      });
    } catch (_) { /* fall back to hardcoded */ }
  })();

  let fabEl = null;
  let panelEl = null;
  let activeDraftId = null;
  let lastJob = null;
  let lastDraft = null;
  let lastUrl = location.href;

  // =========================================================================
  // Detection & extraction
  // =========================================================================

  function isJobDetailPage() {
    // Bumeran's bare /empleos index must NOT trigger.
    const href = location.href;
    const path = location.pathname || "";
    if (/\/empleos\/?$/i.test(path)) return false;

    const urlMatches = JOB_URL_PATTERNS.some((re) => re.test(href));
    // TODO(dom): verify against live Bumeran DOM
    const hasHeading = !!document.querySelector(
      "h1, [class*='aviso' i] h1, [class*='title' i], [data-testid*='title' i]"
    );
    const applyRx = /postular|postularme|aplicar|enviar|inscribir|inscribirme|apply/i;
    // TODO(dom): verify against live Bumeran DOM
    const hasApply = Array.from(document.querySelectorAll(
      "button, a[role='button'], a.btn, a[class*='apply' i], a[class*='postular' i], a[class*='aplicar' i]"
    )).some((el) => applyRx.test((el.textContent || "").trim()));
    const hasJsonLd = !!findJobPostingJsonLd();
    return (urlMatches && hasHeading) || hasJsonLd || (hasHeading && hasApply);
  }

  function findJobPostingJsonLd() {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse((s.textContent || "").trim() || "null");
        const found = searchJobPosting(data);
        if (found) return found;
      } catch (_) { /* skip */ }
    }
    return null;
  }

  function searchJobPosting(node) {
    if (!node) return null;
    if (Array.isArray(node)) {
      for (const item of node) { const f = searchJobPosting(item); if (f) return f; }
      return null;
    }
    if (typeof node !== "object") return null;
    const t = node["@type"];
    if (t === "JobPosting" || (Array.isArray(t) && t.includes("JobPosting"))) return node;
    if (Array.isArray(node["@graph"])) return searchJobPosting(node["@graph"]);
    return null;
  }

  function cleanText(s) {
    if (!s) return "";
    const d = document.createElement("div");
    d.innerHTML = String(s);
    return (d.textContent || "").replace(/\s+/g, " ").trim();
  }
  function textOf(sel) { const el = document.querySelector(sel); return el ? cleanText(el.textContent) : ""; }
  function firstNonEmpty(...v) { for (const x of v) if (x && String(x).trim()) return String(x).trim(); return ""; }

  // Bumeran posts often phrase remote as "a distancia" or "home office".
  function detectModality(text) {
    const t = (text || "").toLowerCase();
    if (/\b(home[- ]?office|remoto|teletrabajo|remote|a[- ]distancia)\b/.test(t)) return "remoto";
    if (/\bh[íi]brido\b/.test(t)) return "híbrido";
    if (/\bpresencial\b/.test(t)) return "presencial";
    return null;
  }

  function dedupe(arr) {
    const seen = new Set(); const out = [];
    for (const x of arr) { const k = x.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(x); } }
    return out;
  }

  function extractRequirements(descriptionText) {
    // TODO(dom): refine container selectors with real Bumeran DOM (Spanish
    // class fragments: "requisito", "perfil", "detail"/"content" wrappers).
    const containers = document.querySelectorAll(
      "[class*='requisito' i], [class*='requirement' i], [class*='perfil' i], [data-testid*='requirement' i]"
    );
    const bullets = [];
    containers.forEach((c) => c.querySelectorAll("li").forEach((li) => {
      const t = cleanText(li.textContent); if (t) bullets.push(t);
    }));
    if (bullets.length) return dedupe(bullets).slice(0, 30);

    if (!descriptionText) return [];
    const kw = /(experiencia|años|requisito|conocimient|manejo|dominio|nivel|inglés|ingles|licencia|certific|habilidad|escolaridad)/i;
    const lines = descriptionText.split(/\n|•|·|\*/).map((l) => l.trim())
      .filter((l) => l.length > 4 && l.length < 300 && kw.test(l));
    return dedupe(lines).slice(0, 15);
  }

  // Bumeran posting id resolution: ?id=/?aviso= query → trailing numeric
  // path segment (e.g. /empleos/aviso-foo-12345) → url hash (mirrors OCC).
  function idFromUrl(url) {
    try {
      const u = new URL(url);
      const qid = u.searchParams.get("id") || u.searchParams.get("aviso");
      if (qid) return qid;
      const segs = u.pathname.split("/").filter(Boolean);
      for (let i = segs.length - 1; i >= 0; i--) {
        const m = segs[i].match(/(\d{4,})/);
        if (m) return m[1];
      }
    } catch (_) { /* fallthrough */ }
    const m = url.match(/(\d{5,})/);
    if (m) return m[1];
    let h = 0;
    for (let i = 0; i < url.length; i++) h = ((h << 5) - h + url.charCodeAt(i)) | 0;
    return `url-${Math.abs(h)}`;
  }

  function largestTextBlock() {
    const main = document.querySelector("main, [role='main'], article") || document.body;
    let best = "";
    main.querySelectorAll("section, article, div").forEach((el) => {
      if (el.offsetParent === null) return;
      const t = cleanText(el.textContent);
      if (t.length > best.length && t.length < 8000) best = t;
    });
    return best;
  }

  function extractJob() {
    const url = location.href;
    const jsonLd = findJobPostingJsonLd();

    let title = "", company = "", loc = "", salary = null, modality = null;
    let description = "", requirements = [];

    if (jsonLd) {
      title = cleanText(jsonLd.title);
      const org = jsonLd.hiringOrganization;
      if (org) company = cleanText(typeof org === "string" ? org : org.name);
      const jl = Array.isArray(jsonLd.jobLocation) ? jsonLd.jobLocation[0] : jsonLd.jobLocation;
      if (jl && jl.address) {
        const a = jl.address;
        loc = [a.addressLocality, a.addressRegion, a.addressCountry].map(cleanText).filter(Boolean).join(", ");
      }
      const sal = jsonLd.baseSalary;
      if (sal) {
        if (typeof sal === "string") salary = sal;
        else if (sal.value) {
          const v = sal.value, unit = v.unitText || sal.unitText || "";
          if (v.minValue && v.maxValue) salary = `${v.minValue} - ${v.maxValue} ${sal.currency || ""} ${unit}`.trim();
          else if (v.value) salary = `${v.value} ${sal.currency || ""} ${unit}`.trim();
        }
      }
      description = cleanText(jsonLd.description);
      if (jsonLd.employmentType) modality = detectModality(String(jsonLd.employmentType)) || modality;
      if (Array.isArray(jsonLd.responsibilities)) requirements = jsonLd.responsibilities.map(cleanText).filter(Boolean);
      if (!requirements.length && typeof jsonLd.qualifications === "string") {
        requirements = extractRequirements(cleanText(jsonLd.qualifications));
      }
    }

    // TODO(dom): refine these selectors with real Bumeran DOM (Spanish noun
    // class fragments: aviso/empresa/ubicacion/salario/descripcion).
    title = firstNonEmpty(title, textOf("[itemprop='title']"), textOf("[data-testid='job-title']"),
      textOf("[class*='aviso' i] h1"), textOf("[class*='title' i]"), textOf("h1"));
    company = firstNonEmpty(company, textOf("[itemprop='hiringOrganization']"),
      textOf("[data-testid='company-name']"), textOf("[class*='company' i]"),
      textOf("[class*='empresa' i] a, [class*='empresa' i]"));
    loc = firstNonEmpty(loc, textOf("[itemprop='jobLocation']"), textOf("address"),
      textOf("[data-testid*='location' i]"), textOf("[class*='location' i]"),
      textOf("[class*='ubicacion' i]"), textOf("[class*='localidad' i]"));
    if (!salary) {
      salary = firstNonEmpty(textOf("[itemprop='baseSalary']"), textOf("[data-testid*='salary' i]"),
        textOf("[class*='salary' i]"), textOf("[class*='sueldo' i]"), textOf("[class*='salario' i]")) || null;
    }
    if (!description) {
      description = firstNonEmpty(textOf("[itemprop='description']"), textOf("[data-testid*='description' i]"),
        textOf("[class*='job-description' i]"), textOf("[class*='descripcion' i]"),
        textOf("[class*='detalle' i]"), largestTextBlock());
    }
    if (!modality) modality = detectModality(`${title} ${description} ${loc}`);
    if (!requirements.length) requirements = extractRequirements(description);

    const partial = !(title && company && description);
    return {
      job: {
        source: SOURCE, url, id: idFromUrl(url),
        title: title || "(sin título)",
        company: company || "(empresa desconocida)",
        location: loc || "", salary: salary || null, modality: modality || null,
        description: description || "", requirements: requirements || [],
        extractedAt: new Date().toISOString()
      },
      partial
    };
  }

  // =========================================================================
  // FAB
  // =========================================================================

  function mountFab() {
    if (fabEl && document.body.contains(fabEl)) return;
    fabEl = document.createElement("button");
    fabEl.type = "button";
    fabEl.className = "eamx-fab";
    fabEl.setAttribute("aria-label", "Postular con IA");
    fabEl.innerHTML =
      '<span class="eamx-fab__icon" aria-hidden="true">✨</span>' +
      '<span class="eamx-fab__label">Postular con IA</span>';
    fabEl.addEventListener("click", onFabClick);
    document.body.appendChild(fabEl);
  }
  function unmountFab() { fabEl?.parentNode?.removeChild(fabEl); fabEl = null; }
  function setFabBusy(b) {
    if (!fabEl) return;
    fabEl.classList.toggle("eamx-fab--busy", !!b);
    fabEl.disabled = !!b;
    const lbl = fabEl.querySelector(".eamx-fab__label");
    if (lbl) lbl.textContent = b ? "Generando" : "Postular con IA";
  }

  async function onFabClick() {
    if (!fabEl || fabEl.disabled) return;
    const { job, partial } = extractJob();
    lastJob = job;
    if (partial && job.title === "(sin título)" && job.company === "(empresa desconocida)") {
      toast("No pudimos leer esta vacante automáticamente. Cópiala o postula manualmente.", "info");
      return;
    }
    setFabBusy(true);
    try {
      const res = await sendMsg({ type: MSG.GENERATE_DRAFT, job });
      if (!res || !res.ok) { showBackendFailure(res); return; }
      activeDraftId = res.draftId || res.draft?.id || null;
      lastDraft = res.draft || null;
      openPanel({ job, draft: lastDraft, partial });
    } catch (err) {
      toast(humanizeError(err), "error");
    } finally {
      setFabBusy(false);
    }
  }

  // =========================================================================
  // Side panel
  // =========================================================================

  function openPanel({ job, draft, partial }) {
    closePanel();
    panelEl = document.createElement("aside");
    panelEl.className = "eamx-panel";
    panelEl.setAttribute("role", "dialog");
    panelEl.setAttribute("aria-label", "Borrador de postulación");

    const cover = draft?.coverLetter || "";
    const answers = draft?.suggestedAnswers || {};

    panelEl.innerHTML = `
      <header class="eamx-panel__header">
        <div class="eamx-panel__title"></div>
        <div class="eamx-panel__company"></div>
      </header>
      <div class="eamx-panel__body">
        ${partial ? `<div class="eamx-panel__warning">No pude extraer todo de la vacante — revisa la carta con más detalle.</div>` : ""}
        <label for="eamx-cover-letter"><strong>Carta de presentación</strong></label>
        <textarea id="eamx-cover-letter" class="eamx-textarea" rows="14"></textarea>
        <div class="eamx-answers"></div>
      </div>
      <footer class="eamx-panel__footer">
        <button type="button" class="eamx-btn eamx-btn--primary" data-action="approve">Aprobar y llenar formulario</button>
        <button type="button" class="eamx-btn eamx-btn--secondary" data-action="regen">Re-generar</button>
        <button type="button" class="eamx-btn eamx-btn--ghost" data-action="cancel">Cancelar</button>
      </footer>`;

    panelEl.querySelector(".eamx-panel__title").textContent = job.title || "(vacante)";
    panelEl.querySelector(".eamx-panel__company").textContent = job.company || "";
    panelEl.querySelector("#eamx-cover-letter").value = cover;

    const host = panelEl.querySelector(".eamx-answers");
    const keys = Object.keys(answers);
    if (keys.length) {
      const h = document.createElement("div");
      h.innerHTML = "<strong>Respuestas sugeridas</strong>";
      h.style.marginTop = "16px";
      host.appendChild(h);
      for (const k of keys) {
        const wrap = document.createElement("div"); wrap.className = "eamx-answer";
        const lbl = document.createElement("div"); lbl.className = "eamx-answer__label"; lbl.textContent = k;
        const val = document.createElement("div"); val.className = "eamx-answer__value";
        val.textContent = answers[k]; val.tabIndex = 0; val.title = "Clic para copiar";
        val.addEventListener("click", () => {
          navigator.clipboard?.writeText(answers[k])
            .then(() => toast("Copiado.", "success"))
            .catch(() => toast("No se pudo copiar.", "error"));
        });
        wrap.append(lbl, val); host.appendChild(wrap);
      }
    }

    panelEl.addEventListener("click", onPanelClick);
    document.body.appendChild(panelEl);
    requestAnimationFrame(() => panelEl.classList.add("eamx-panel--open"));
  }

  function closePanel() { panelEl?.parentNode?.removeChild(panelEl); panelEl = null; }

  async function onPanelClick(e) {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    if (action === "cancel") return handleCancel();
    if (action === "regen") return handleRegen();
    if (action === "approve") return handleApprove();
  }

  async function handleCancel() {
    try { if (activeDraftId) await sendMsg({ type: MSG.REJECT_DRAFT, draftId: activeDraftId }); } catch (_) {}
    activeDraftId = null; lastDraft = null;
    closePanel(); setFabBusy(false);
  }

  async function handleRegen() {
    if (!lastJob) return;
    const btns = panelEl ? panelEl.querySelectorAll("button[data-action]") : [];
    btns.forEach((b) => (b.disabled = true));
    try {
      const res = await sendMsg({ type: MSG.GENERATE_DRAFT, job: lastJob, regenerate: true });
      if (!res || !res.ok) { showBackendFailure(res); return; }
      activeDraftId = res.draftId || res.draft?.id || null;
      lastDraft = res.draft || null;
      const ta = panelEl?.querySelector("#eamx-cover-letter");
      if (ta && lastDraft) ta.value = lastDraft.coverLetter || "";
      toast("Borrador regenerado.", "success");
    } catch (err) {
      toast(humanizeError(err), "error");
    } finally {
      btns.forEach((b) => (b.disabled = false));
    }
  }

  async function handleApprove() {
    if (!activeDraftId) { toast("No hay borrador activo.", "error"); return; }
    const ta = panelEl?.querySelector("#eamx-cover-letter");
    const coverLetter = ta ? ta.value : "";
    const btns = panelEl ? panelEl.querySelectorAll("button[data-action]") : [];
    btns.forEach((b) => (b.disabled = true));
    try {
      const res = await sendMsg({ type: MSG.APPROVE_DRAFT, draftId: activeDraftId, coverLetter });
      if (!res || !res.ok) { toast(res?.error || "No se pudo aprobar.", "error"); return; }
      const fields = (res.fields && typeof res.fields === "object") ? { ...res.fields } : {};
      if (!fields.coverLetter) fields.coverLetter = coverLetter;
      fillForm(fields);
      closePanel();
      highlightSubmitButton();
      toast("Listo — revisa y da click a 'Enviar' cuando estés conforme.", "success");
    } catch (err) {
      toast(humanizeError(err), "error");
    } finally {
      btns.forEach((b) => (b.disabled = false));
      setFabBusy(false);
    }
  }

  // =========================================================================
  // Form fill & submit highlight
  // =========================================================================

  // Use the native value setter so React's synthetic events see the change.
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value); else el.value = value;
  }

  // Locate the primary Bumeran application form: prefer one with both a
  // textarea and a submit-ish button (CTA text: postular/postularme/enviar);
  // fall back to any form with a textarea.
  function findApplicationForm() {
    const forms = Array.from(document.querySelectorAll("form"));
    const rx = /postular|postularme|aplicar|enviar|inscribir|inscribirme|submit|apply|send/i;
    for (const f of forms) {
      if (!f.querySelector("textarea")) continue;
      const btn = f.querySelector("button, input[type='submit']");
      if (btn && rx.test((btn.textContent || btn.value || "").trim())) return f;
    }
    return forms.find((f) => !!f.querySelector("textarea")) || forms[0] || null;
  }

  // Resolve a semantic key (fullName/email/phone/coverLetter) against the
  // live DOM. If `key` looks like a CSS selector, try it as a selector first.
  // Semantic map: fullName→name/nombre, email→type=email or email/correo,
  // phone→type=tel or tel/celular/móvil/whatsapp,
  // coverLetter→textarea matching carta/presentación/mensaje/motivación.
  function resolveField(key, form) {
    if (/[#.[:\s>]/.test(key)) { try { const el = document.querySelector(key); if (el) return el; } catch (_) {} }
    const scope = form || document;
    const qa = (s) => Array.from(scope.querySelectorAll(s));
    const attrHay = (el) => `${el.name || ""} ${el.id || ""} ${el.placeholder || ""} ${el.getAttribute("aria-label") || ""}`;
    const prevLabel = (el) => el.previousElementSibling?.textContent || el.closest("label")?.textContent || "";
    if (key === "fullName") {
      return qa("input[name*='name' i], input[id*='name' i], input[name*='nombre' i], input[id*='nombre' i]")[0]
        || qa("input, textarea").find((el) => /name|nombre/i.test(attrHay(el)))
        || qa("input[type='text']")[0]
        || null;
    }
    if (key === "email") {
      return qa("input[type='email']")[0]
        || qa("input, textarea").find((el) => /email|correo/i.test(attrHay(el)))
        || null;
    }
    if (key === "phone") {
      return qa("input[type='tel']")[0]
        || qa("input, textarea").find((el) => /phone|tel|celular|m[oó]vil|whats?app/i.test(attrHay(el) + " " + prevLabel(el)))
        || null;
    }
    if (key === "coverLetter") {
      return qa("textarea").find((t) => /carta|presentaci[oó]n|mensaje|motivaci|cover/i.test(attrHay(t) + " " + prevLabel(t)))
        || qa("textarea")[0]
        || null;
    }
    return null;
  }

  function fillForm(fields) {
    if (!fields || typeof fields !== "object") return;
    const form = findApplicationForm();
    const filled = [], skipped = [];
    for (const [key, val] of Object.entries(fields)) {
      if (val == null || val === "") { skipped.push(key); continue; }
      const el = resolveField(key, form);
      if (!el) { skipped.push(key); continue; }
      try {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) setNativeValue(el, String(val));
        else if (el instanceof HTMLSelectElement) el.value = String(val);
        else if (el.isContentEditable) el.textContent = String(val);
        else { skipped.push(key); continue; }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        filled.push(key);
      } catch (_) { skipped.push(key); }
    }
    console.info("[EmpleoAutomatico] fillForm:", { filled, skipped });
  }

  function findSubmitButton() {
    const rx = /postular|postularme|enviar|aplicar|inscribir|inscribirme|submit|send/i;
    const form = findApplicationForm();
    const scope = form || document;
    const direct = scope.querySelector("button[type='submit'], input[type='submit']");
    if (direct) return direct;
    return Array.from(scope.querySelectorAll("button, a[role='button']"))
      .find((b) => rx.test((b.textContent || "").trim())) || null;
  }

  // Pulse the submit button. NEVER auto-click — human-in-the-loop guarantee.
  function highlightSubmitButton() {
    const btn = findSubmitButton();
    if (!btn) { toast("No encontré el botón de enviar — postula manualmente.", "info"); return; }
    btn.scrollIntoView({ behavior: "smooth", block: "center" });
    btn.classList.add("eamx-submit-pulse");
    setTimeout(() => btn.classList.remove("eamx-submit-pulse"), 12000);
  }

  // =========================================================================
  // Toast & messaging
  // =========================================================================

  function toast(message, variant = "info", action) {
    const el = document.createElement("div");
    const v = variant === "success" ? "eamx-toast--success"
      : variant === "error" ? "eamx-toast--error" : "eamx-toast--info";
    el.className = `eamx-toast ${v}`;
    el.setAttribute("role", "status");

    const msgSpan = document.createElement("span");
    msgSpan.textContent = message;
    el.appendChild(msgSpan);

    if (action && action.label && typeof action.onClick === "function") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "eamx-toast__action";
      btn.textContent = action.label;
      btn.addEventListener("click", (ev) => { ev.preventDefault(); action.onClick(); });
      el.appendChild(btn);
    }

    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("eamx-toast--show"));
    const duration = action ? 8000 : 4000;
    setTimeout(() => { el.classList.remove("eamx-toast--show"); setTimeout(() => el.remove(), 400); }, duration);
  }

  function showBackendFailure(res) {
    const code = res?.error;
    const message = res?.message || "No se pudo generar el borrador.";
    if (code === ERR.PLAN_LIMIT_EXCEEDED) {
      toast("Llegaste al l\u00edmite de tu plan.", "error", {
        label: "Ver planes",
        onClick: () => openBilling()
      });
      return;
    }
    if (code === ERR.UNAUTHORIZED) {
      toast("Tu sesi\u00f3n expir\u00f3.", "error", {
        label: "Inicia sesi\u00f3n",
        onClick: () => openOptionsPage()
      });
      return;
    }
    toast(message, "error");
  }

  function openBilling() {
    sendMsg({ type: MSG.OPEN_BILLING }).catch(() => {
      window.open(BILLING_URL, "_blank", "noopener,noreferrer");
    });
  }

  function openOptionsPage() {
    window.open(chrome.runtime.getURL("options/options.html"), "_blank", "noopener");
  }

  function sendMsg(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (response) => {
          const err = chrome.runtime.lastError;
          if (err) return reject(new Error(err.message || "runtime error"));
          resolve(response);
        });
      } catch (err) { reject(err); }
    });
  }

  function humanizeError(err) {
    const msg = err?.message || String(err || "error");
    if (/sesi[oó]n/i.test(msg)) return "Inicia sesión en Opciones para continuar.";
    if (/context|extension/i.test(msg)) return "Recarga la página e inténtalo de nuevo.";
    return `Error: ${msg}`;
  }

  // =========================================================================
  // SPA nav watching & bootstrap
  // =========================================================================

  function detectAndMount() {
    if (isJobDetailPage()) mountFab();
    else { unmountFab(); closePanel(); }
  }

  function throttle(fn, ms) {
    let pending = false, lastArgs;
    return function (...args) {
      lastArgs = args;
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; fn.apply(null, lastArgs); }, ms);
    };
  }

  function watchUrlChanges() {
    const onChange = () => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        activeDraftId = null; lastDraft = null; lastJob = null;
        setTimeout(detectAndMount, 300);
        setTimeout(detectAndMount, 1200);
      }
    };
    const origPush = history.pushState, origReplace = history.replaceState;
    history.pushState = function () { const r = origPush.apply(this, arguments); window.dispatchEvent(new Event("eamx:locationchange")); return r; };
    history.replaceState = function () { const r = origReplace.apply(this, arguments); window.dispatchEvent(new Event("eamx:locationchange")); return r; };
    window.addEventListener("popstate", onChange);
    window.addEventListener("eamx:locationchange", onChange);

    const mo = new MutationObserver(throttle(() => {
      if (location.href !== lastUrl) { onChange(); return; }
      const want = isJobDetailPage();
      const have = !!(fabEl && document.body.contains(fabEl));
      if (want && !have) mountFab();
      else if (!want && have) { unmountFab(); closePanel(); }
    }, 600));
    mo.observe(document.body, { childList: true, subtree: true });
  }

  function boot() {
    try { detectAndMount(); watchUrlChanges(); }
    catch (err) { console.error("[EmpleoAutomatico]", err); }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
