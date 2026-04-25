/**
 * content/indeed.js — Indeed México content script (Empleo Automático MX)
 *
 * Confidence on Indeed selectors: LOW. mx.indeed.com sits behind Cloudflare
 * AND uses React with hashed class names that change between deploys; stable
 * hooks below are mostly `data-testid` attributes plus `id` attributes.
 *
 * Order-of-preference (same as occ.js / computrabajo.js):
 *   1) JSON-LD @type JobPosting (Indeed reliably emits this on /viewjob)
 *   2) Microdata / ARIA / semantic HTML
 *   3) data-testid + id heuristics (jobsearch-JobInfoHeader-title etc.)
 *   4) Largest text block fallback
 *
 * SOURCE = "indeed". Director will add SOURCES.INDEED to lib/schemas.js;
 * raw string is safe to use ahead of that change.
 *
 * Indeed-specific differences:
 *   - id extraction uses `?jk=` query param (job key, most reliable id)
 *   - Cloudflare challenge gating: skip mounting FAB on challenge screens
 *   - Indeed Apply iframe handling: cannot autofill cross-origin. Branch:
 *       a) Inline form (one-page textarea + submit) → autofill like OCC
 *       b) Indeed Apply iframe → copy cover letter to clipboard + pulse the
 *          "Aplica ahora" button; user pastes when prompted.
 */
(function () {
  "use strict";

  const SOURCE = "indeed"; // schemas.js will gain SOURCES.INDEED — string is safe to use early.
  const MSG = { GENERATE_DRAFT: "GENERATE_DRAFT", APPROVE_DRAFT: "APPROVE_DRAFT", REJECT_DRAFT: "REJECT_DRAFT", OPEN_BILLING: "OPEN_BILLING" };
  const ERR = { UNAUTHORIZED: "UNAUTHORIZED", PLAN_LIMIT_EXCEEDED: "PLAN_LIMIT_EXCEEDED" };
  const BILLING_URL = "https://skybrandmx.com/account/billing";

  // TODO(dom): verify against real Indeed MX URLs. /viewjob is the canonical
  // detail page; /empleo/ is the slugged path-based variant; /m/ is mobile.
  const JOB_URL_PATTERNS = [
    /\/viewjob(\?|$|\/)/i,
    /[?&]jk=[A-Za-z0-9]+/i,
    /\/empleo\/[^/]+\/[^/]+/i,
    /\/m\/viewjob/i
  ];

  // Dynamic import of shared schemas — same MV3-friendly pattern as siblings.
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

  // ===== Cloudflare challenge detection =====

  // If the user lands on a Cloudflare challenge ("Checking your browser…",
  // Turnstile widget, etc.) we must NOT mount the FAB — it would fail to
  // extract and look broken. Detected via selectors, then title, then a
  // body-text heuristic that only fires on tiny pages (challenge screens are
  // small) to avoid false positives on real listings that mention Cloudflare.
  function isCloudflareChallenge() {
    // TODO(dom): refine — Cloudflare ships several challenge variants.
    const sels = ["#challenge-running", "#cf-challenge-running", "#challenge-form",
      "iframe[src*='challenges.cloudflare.com' i]", "[data-translate='checking_browser' i]"];
    if (sels.some((s) => { try { return !!document.querySelector(s); } catch (_) { return false; } })) return true;
    const title = (document.title || "").toLowerCase();
    if (/just a moment|attention required|checking your browser/.test(title)) return true;
    if (document.body && document.body.textContent && document.body.textContent.length < 4000) {
      const t = document.body.textContent.toLowerCase();
      if (/checking your browser|verificando que eres humano|please complete the security check/.test(t)) return true;
    }
    return false;
  }

  // ===== Detection & extraction =====

  function isJobDetailPage() {
    const urlMatches = JOB_URL_PATTERNS.some((re) => re.test(location.href));
    // TODO(dom): Indeed React class names are hashed; data-testid is more
    // stable. The h1 fallback covers the SSR'd initial render.
    const hasHeading = !!document.querySelector(
      "h1[class*='JobInfoHeader' i], [data-testid='job-title'] h1, [data-testid='jobsearch-JobInfoHeader-title'], h1.jobsearch-JobInfoHeader-title, h1"
    );
    const applyRx = /aplica|aplicar|apply|postular|postúlate|postulate/i;
    const hasApply = Array.from(document.querySelectorAll(
      "button, a[role='button'], a.btn, a[class*='apply' i], [class*='IndeedApplyButton' i], [id*='indeedApplyButton' i]"
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

  function detectModality(text) {
    // Indeed surfaces both Spanish and English modality labels in MX listings.
    const t = (text || "").toLowerCase();
    if (/\b(home[- ]?office|remoto|teletrabajo|remote|trabajo a distancia)\b/.test(t)) return "remoto";
    if (/\bh[íi]brido\b|\bhybrid\b/.test(t)) return "híbrido";
    if (/\bpresencial\b|\ben sitio\b|\bon[- ]?site\b/.test(t)) return "presencial";
    return null;
  }

  function dedupe(arr) {
    const seen = new Set(); const out = [];
    for (const x of arr) { const k = x.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(x); } }
    return out;
  }

  function extractRequirements(descriptionText) {
    // TODO(dom): Indeed bullet sections are usually inside #jobDescriptionText.
    const containers = document.querySelectorAll(
      "#jobDescriptionText, [id*='jobDescription' i], [class*='requirement' i], [class*='requisito' i]"
    );
    const bullets = [];
    containers.forEach((c) => c.querySelectorAll("li").forEach((li) => {
      const t = cleanText(li.textContent); if (t) bullets.push(t);
    }));
    if (bullets.length) return dedupe(bullets).slice(0, 30);

    if (!descriptionText) return [];
    const kw = /(experiencia|años|requisito|conocimient|manejo|dominio|nivel|inglés|ingles|licencia|certific|habilidad|escolaridad|experience|years|skill|require)/i;
    const lines = descriptionText.split(/\n|•|·|\*/).map((l) => l.trim())
      .filter((l) => l.length > 4 && l.length < 300 && kw.test(l));
    return dedupe(lines).slice(0, 15);
  }

  // Indeed's job key (`jk`) is the most reliable id. Falls back to the last
  // path segment for /empleo/ slugs, then any 5+ digit number, then a hash.
  function idFromUrl(url) {
    try {
      const u = new URL(url);
      const jk = u.searchParams.get("jk");
      if (jk) return jk;
      // Path-based: /empleo/job-id-XXX → last non-empty segment.
      const segs = u.pathname.split("/").filter(Boolean);
      if (segs.length && /viewjob|empleo|m/i.test(segs[0])) {
        const last = segs[segs.length - 1];
        if (last && last.length >= 4) return last;
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
          const v = sal.value, unit = v.unitText || sal.unitText || "", cur = sal.currency || "";
          if (v.minValue && v.maxValue) salary = `${v.minValue} - ${v.maxValue} ${cur} ${unit}`.trim();
          else if (v.value) salary = `${v.value} ${cur} ${unit}`.trim();
        }
      }
      description = cleanText(jsonLd.description);
      if (jsonLd.employmentType) modality = detectModality(String(jsonLd.employmentType)) || modality;
      if (Array.isArray(jsonLd.responsibilities)) requirements = jsonLd.responsibilities.map(cleanText).filter(Boolean);
      if (!requirements.length && typeof jsonLd.qualifications === "string") requirements = extractRequirements(cleanText(jsonLd.qualifications));
    }

    // TODO(dom): React class hashes change. data-testid + id selectors first.
    title = firstNonEmpty(title,
      textOf("[data-testid='job-title'] h1"), textOf("[data-testid='jobsearch-JobInfoHeader-title']"),
      textOf("h1.jobsearch-JobInfoHeader-title"), textOf("h1[class*='JobInfoHeader' i]"),
      textOf("[itemprop='title']"), textOf("h1"));
    company = firstNonEmpty(company,
      textOf("[data-testid='inlineHeader-companyName']"), textOf("[data-testid='inlineHeader-companyName'] a"),
      textOf(".jobsearch-CompanyInfoContainer a"), textOf("[data-company-name='true']"),
      textOf("[itemprop='hiringOrganization']"), textOf("[class*='companyName' i]"));
    loc = firstNonEmpty(loc,
      textOf("[data-testid='inlineHeader-companyLocation']"), textOf("[data-testid='jobsearch-JobInfoHeader-companyLocation']"),
      textOf("[itemprop='jobLocation']"), textOf("address"), textOf("[class*='companyLocation' i]"));
    if (!salary) {
      salary = firstNonEmpty(textOf("[data-testid='inlineHeader-jobInfoLabel-Salary']"),
        textOf("[id*='salaryInfo' i]"), textOf("[class*='salary' i]"), textOf("[itemprop='baseSalary']")) || null;
      // Indeed often shows MXN amounts as plain text near the title without a container.
      if (!salary) {
        const headerText = textOf("[class*='JobInfoHeader' i]") || textOf("[data-testid*='Header' i]");
        const m = headerText && headerText.match(/(\$[\s\d.,]+(?:MXN|MX\$)?\s*(?:al mes|mensual|por hora|al año)?)/i);
        if (m) salary = m[1].trim();
      }
    }
    if (!description) {
      description = firstNonEmpty(textOf("#jobDescriptionText"), textOf("[id*='jobDescription' i]"),
        textOf("[data-testid*='description' i]"), textOf("[itemprop='description']"),
        textOf("[class*='jobsearch-JobComponent-description' i]"), largestTextBlock());
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

  // ===== FAB =====

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

  // ===== Side panel =====

  function openPanel({ job, draft, partial }) {
    closePanel();
    panelEl = document.createElement("aside");
    panelEl.className = "eamx-panel";
    panelEl.setAttribute("role", "dialog");
    panelEl.setAttribute("aria-label", "Borrador de postulación");

    const cover = draft?.coverLetter || "";
    const answers = draft?.suggestedAnswers || {};
    const inlineForm = !!detectInlineApplyForm();
    // Indeed Apply (iframe/external) can't be autofilled — copy-to-clipboard fallback.
    const primaryLabel = inlineForm ? "Aprobar y llenar formulario" : "Aprobar y copiar carta";
    const partialWarn = partial ? `<div class="eamx-panel__warning">No pude extraer todo de la vacante — revisa la carta con más detalle.</div>` : "";
    const iframeWarn = !inlineForm ? `<div class="eamx-panel__warning">Indeed Apply abre un formulario externo. Copia la carta y pégala cuando llegues al paso correspondiente.</div>` : "";
    panelEl.innerHTML = `
      <header class="eamx-panel__header"><div class="eamx-panel__title"></div><div class="eamx-panel__company"></div></header>
      <div class="eamx-panel__body">${partialWarn}${iframeWarn}
        <label for="eamx-cover-letter"><strong>Carta de presentación</strong></label>
        <textarea id="eamx-cover-letter" class="eamx-textarea" rows="14"></textarea>
        <div class="eamx-answers"></div>
      </div>
      <footer class="eamx-panel__footer">
        <button type="button" class="eamx-btn eamx-btn--primary" data-action="approve"></button>
        <button type="button" class="eamx-btn eamx-btn--secondary" data-action="copy">Copiar carta al portapapeles</button>
        <button type="button" class="eamx-btn eamx-btn--secondary" data-action="regen">Re-generar</button>
        <button type="button" class="eamx-btn eamx-btn--ghost" data-action="cancel">Cancelar</button>
      </footer>`;

    panelEl.querySelector(".eamx-panel__title").textContent = job.title || "(vacante)";
    panelEl.querySelector(".eamx-panel__company").textContent = job.company || "";
    panelEl.querySelector("#eamx-cover-letter").value = cover;
    panelEl.querySelector("[data-action='approve']").textContent = primaryLabel;

    const host = panelEl.querySelector(".eamx-answers");
    const keys = Object.keys(answers);
    if (keys.length) {
      const h = document.createElement("div");
      h.innerHTML = "<strong>Respuestas sugeridas</strong>"; h.style.marginTop = "16px";
      host.appendChild(h);
      for (const k of keys) {
        const wrap = document.createElement("div"); wrap.className = "eamx-answer";
        const lbl = document.createElement("div"); lbl.className = "eamx-answer__label"; lbl.textContent = k;
        const val = document.createElement("div"); val.className = "eamx-answer__value";
        val.textContent = answers[k]; val.tabIndex = 0; val.title = "Clic para copiar";
        val.addEventListener("click", () => navigator.clipboard?.writeText(answers[k])
          .then(() => toast("Copiado.", "success")).catch(() => toast("No se pudo copiar.", "error")));
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
    if (action === "copy") return handleCopyCoverLetter();
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

  async function handleCopyCoverLetter() {
    const ta = panelEl?.querySelector("#eamx-cover-letter");
    const txt = ta ? ta.value : "";
    if (!txt) { toast("La carta está vacía.", "info"); return; }
    try { await navigator.clipboard.writeText(txt); toast("Carta copiada. Pégala en Indeed Apply cuando llegues al paso de carta.", "success"); }
    catch (_) { toast("No se pudo copiar la carta — selecciónala manualmente.", "error"); }
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

      // BRANCH: inline form (employer-embedded) → autofill like OCC.
      // Else (Indeed Apply iframe, cross-origin, unreachable) → copy cover letter
      // + pulse the "Aplica ahora" button so the user takes over the official flow.
      if (detectInlineApplyForm()) {
        fillForm(fields); closePanel(); highlightSubmitButton();
        toast("Listo — revisa y da click a 'Enviar' cuando estés conforme.", "success");
      } else {
        try { await navigator.clipboard.writeText(coverLetter); } catch (_) { /* ignore */ }
        closePanel(); highlightApplyNowButton();
        toast("Carta copiada. Da click en 'Aplica ahora' y pégala en el paso de carta.", "success");
      }
    } catch (err) {
      toast(humanizeError(err), "error");
    } finally {
      btns.forEach((b) => (b.disabled = false));
      setFabBusy(false);
    }
  }

  // ===== Form fill & submit highlight (inline-form branch) =====

  // Use the native value setter so React's synthetic events see the change.
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value); else el.value = value;
  }

  // An "inline simple form" is a same-page <form> with at least a textarea AND
  // a submit-ish button matching aplicar/apply/enviar/submit. This is what
  // some employers embed alongside Indeed Apply; we treat it like OCC.
  function detectInlineApplyForm() {
    const rx = /aplicar|apply|enviar|submit|postular|send/i;
    const forms = Array.from(document.querySelectorAll("form"));
    for (const f of forms) {
      if (!f.querySelector("textarea")) continue;
      const btn = f.querySelector("button, input[type='submit']");
      if (btn && rx.test((btn.textContent || btn.value || "").trim())) return f;
    }
    return null;
  }

  function findApplicationForm() { return detectInlineApplyForm(); }

  // Resolve a semantic field key against the inline form. Same shape as OCC.
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
    const rx = /aplicar|apply|enviar|submit|postular|send/i;
    const form = findApplicationForm();
    const scope = form || document;
    const direct = scope.querySelector("button[type='submit'], input[type='submit']");
    if (direct) return direct;
    return Array.from(scope.querySelectorAll("button, a[role='button']"))
      .find((b) => rx.test((b.textContent || "").trim())) || null;
  }

  // Pulse a button (never clicked — HITL guarantee). missMsg shown if not found.
  function pulse(btn, missMsg) {
    if (!btn) { toast(missMsg, "info"); return; }
    btn.scrollIntoView({ behavior: "smooth", block: "center" });
    btn.classList.add("eamx-submit-pulse");
    setTimeout(() => btn.classList.remove("eamx-submit-pulse"), 12000);
  }
  function highlightSubmitButton() {
    pulse(findSubmitButton(), "No encontré el botón de enviar — postula manualmente.");
  }

  // Find Indeed's "Aplica ahora" / "Apply now" CTA. We never CLICK it.
  // TODO(dom): IndeedApplyButton class names vary across launchpad/embed/host.
  function findApplyNowButton() {
    const candidates = Array.from(document.querySelectorAll(
      "button[id*='indeedApplyButton' i], button[class*='IndeedApplyButton' i], " +
      "[data-testid*='apply' i] button, [data-testid*='apply' i] a, " +
      "a[href*='/apply' i], button[aria-label*='aplica' i], button[aria-label*='apply' i]"));
    const rx = /aplica|aplicar|apply now|apply/i;
    return candidates.find((b) => rx.test((b.textContent || b.getAttribute("aria-label") || "").trim()))
      || candidates[0] || null;
  }
  function highlightApplyNowButton() {
    pulse(findApplyNowButton(), "No encontré el botón 'Aplica ahora' — búscalo en la página.");
  }

  // ===== Toast & messaging =====

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
      toast("Llegaste al l\u00edmite de tu plan.", "error", { label: "Ver planes", onClick: () => openBilling() });
      return;
    }
    if (code === ERR.UNAUTHORIZED) {
      toast("Tu sesi\u00f3n expir\u00f3.", "error", { label: "Inicia sesi\u00f3n", onClick: () => openOptionsPage() });
      return;
    }
    toast(message, "error");
  }

  function openBilling() {
    sendMsg({ type: MSG.OPEN_BILLING }).catch(() => window.open(BILLING_URL, "_blank", "noopener,noreferrer"));
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

  // ===== SPA nav watching & bootstrap =====

  function detectAndMount() {
    // Cloudflare gate: never mount on a challenge screen. The user might
    // refresh/solve, after which our MutationObserver will retry detection.
    if (isCloudflareChallenge()) { unmountFab(); closePanel(); return; }
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
      if (isCloudflareChallenge()) { if (fabEl) { unmountFab(); closePanel(); } return; }
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
