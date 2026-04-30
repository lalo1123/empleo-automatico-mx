/**
 * content/lapieza.js — LaPieza.io content script (Empleo Automático MX)
 *
 * Confidence on LaPieza selectors: LOW. lapieza.io is fronted by Cloudflare
 * (likely 403 to WebFetch), so DOM hooks were NOT verified live. Defensive
 * cascade (same strategy as OCC/Computrabajo/Bumeran agents):
 *   1) JSON-LD @type JobPosting (LaPieza ATS likely emits Google for Jobs SEO)
 *   2) Microdata / ARIA / semantic HTML (itemprop, h1, address)
 *   3) Class wildcards: vacancy, vacante, position, puesto, empresa, ubicacion,
 *      descripcion, requisito, salario
 *   4) Largest text block in <main>/<article> as last resort
 * MVP assumes the user is logged into LaPieza in the same session.
 *
 * Mirrors content/bumeran.js 1:1 in structure. Differences: SOURCE,
 * URL patterns (/vacancy/<uuid>, /vacante/, /jobs/, /empleos/),
 * id extraction (UUID-first, then numeric/hash),
 * apply-button copy (Aplicar a esta vacante / Postularme).
 */
(function () {
  "use strict";

  const SOURCE = "lapieza";
  const MSG = {
    GENERATE_DRAFT: "GENERATE_DRAFT",
    APPROVE_DRAFT: "APPROVE_DRAFT",
    REJECT_DRAFT: "REJECT_DRAFT",
    OPEN_BILLING: "OPEN_BILLING",
    GENERATE_CV: "GENERATE_CV",
    OPEN_GENERATED_CV: "OPEN_GENERATED_CV"
  };
  const ERR = { UNAUTHORIZED: "UNAUTHORIZED", PLAN_LIMIT_EXCEEDED: "PLAN_LIMIT_EXCEEDED", INVALID_INPUT: "INVALID_INPUT" };
  const BILLING_URL = "https://empleo.skybrandmx.com/account/billing";

  // TODO(dom): verify against real LaPieza URLs. Confirmed pattern:
  // /vacancy/<uuid>. Speculative: /vacante/, /jobs/, /empleos/, /puesto/.
  const JOB_URL_PATTERNS = [
    /\/vacancy\/[a-f0-9-]{8,}/i,
    /\/vacante\/[a-f0-9-]{8,}/i,
    /\/vacancy\/[^/?#]+/i,
    /\/vacante\/[^/?#]+/i,
    /\/jobs\/[^/?#]+/i,
    /\/empleos\/[^/?#]+/i,
    /\/puesto\/[^/?#]+/i
  ];

  // Dynamic import of shared schemas (same pattern as occ.js/bumeran.js).
  // MV3 content scripts can't declare ES imports via manifest; runtime dynamic
  // import via web_accessible_resources works.
  (async function syncSchema() {
    try {
      const mod = await import(chrome.runtime.getURL("lib/schemas.js"));
      if (mod && mod.MESSAGE_TYPES) Object.assign(MSG, {
        GENERATE_DRAFT: mod.MESSAGE_TYPES.GENERATE_DRAFT,
        APPROVE_DRAFT: mod.MESSAGE_TYPES.APPROVE_DRAFT,
        REJECT_DRAFT: mod.MESSAGE_TYPES.REJECT_DRAFT,
        OPEN_BILLING: mod.MESSAGE_TYPES.OPEN_BILLING,
        GENERATE_CV: mod.MESSAGE_TYPES.GENERATE_CV,
        OPEN_GENERATED_CV: mod.MESSAGE_TYPES.OPEN_GENERATED_CV
      });
      if (mod && mod.ERROR_CODES) Object.assign(ERR, {
        UNAUTHORIZED: mod.ERROR_CODES.UNAUTHORIZED,
        PLAN_LIMIT_EXCEEDED: mod.ERROR_CODES.PLAN_LIMIT_EXCEEDED,
        INVALID_INPUT: mod.ERROR_CODES.INVALID_INPUT
      });
    } catch (_) { /* fall back to hardcoded */ }
  })();

  let fabEl = null;
  let panelEl = null;
  let activeDraftId = null;
  let lastJob = null;
  let lastDraft = null;
  let lastUrl = location.href;

  // Tailored-CV state machine. Lives at module scope (not inside the panel)
  // so re-rendering the panel doesn't lose the cached HTML. States:
  //   "idle"       — initial, button visible, nothing generated yet
  //   "loading"    — request in flight, spinner shown
  //   "success"    — html in cvHtml, summary in cvSummary, action buttons shown
  //   "error"      — cvError holds a user-facing message, retry available
  let cvState = "idle";
  let cvHtml = "";
  let cvSummary = "";
  let cvError = "";

  // In-flow assistant state. After the user approves the draft we keep watching
  // the page and offer contextual help on the portal's apply form (CV upload,
  // cover-letter textarea, multiple-choice questions, final submit button).
  let flowActive = false;
  let flowObserver = null;
  let flowDebounceTimer = null;
  const FLOW_PROCESSED = new WeakSet(); // elements we've already attached to
  const FLOW_TIPS_SHOWN = new Set();    // dedupe tip-keys for one-shot toasts

  // =========================================================================
  // Detection & extraction
  // =========================================================================

  function isJobDetailPage() {
    // LaPieza index/list paths must NOT trigger.
    const href = location.href;
    const path = location.pathname || "";
    if (/\/(vacancy|vacante|jobs|empleos|puesto)\/?$/i.test(path)) return false;

    const urlMatches = JOB_URL_PATTERNS.some((re) => re.test(href));
    // TODO(dom): verify against live LaPieza DOM
    const hasHeading = !!document.querySelector(
      "h1, [class*='vacancy' i] h1, [class*='vacante' i] h1, [class*='title' i], [data-testid*='title' i]"
    );
    // LaPieza copy: "Aplicar a esta vacante", "Postularme", "Aplicar".
    const applyRx = /^(aplicar(\s+a\s+esta\s+vacante)?|postular(me)?|apply|aplicar ahora)$/i;
    const looseApplyRx = /aplicar|postular|postularme|apply/i;
    // TODO(dom): verify against live LaPieza DOM
    const hasApply = Array.from(document.querySelectorAll(
      "button, a[role='button'], a.btn, a[class*='apply' i], a[class*='postular' i], a[class*='aplicar' i]"
    )).some((el) => {
      const t = (el.textContent || "").trim();
      return applyRx.test(t) || looseApplyRx.test(t);
    });
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

  // LaPieza posts may phrase remote as "remoto", "home office", or "a distancia".
  function detectModality(text) {
    const t = (text || "").toLowerCase();
    if (/\b(home[- ]?office|remoto|teletrabajo|remote|a[- ]distancia|trabajo\s+remoto)\b/.test(t)) return "remoto";
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
    // TODO(dom): refine container selectors with real LaPieza DOM.
    const containers = document.querySelectorAll(
      "[class*='requisito' i], [class*='requirement' i], [class*='perfil' i], [class*='qualification' i], [data-testid*='requirement' i]"
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

  // LaPieza id resolution: UUID from /vacancy/<uuid> path → query string id →
  // trailing numeric path segment → url hash. The UUID format is the canonical
  // LaPieza identifier (e.g. /vacancy/3c4f8a1e-...).
  function idFromUrl(url) {
    try {
      const u = new URL(url);
      // 1) UUID in /vacancy/<uuid> or /vacante/<uuid>
      const uuidMatch = u.pathname.match(/\/(?:vacancy|vacante|jobs|empleos|puesto)\/([a-f0-9][a-f0-9-]{7,})/i);
      if (uuidMatch) return uuidMatch[1];
      // 2) Query string id
      const qid = u.searchParams.get("id") || u.searchParams.get("vacancy") || u.searchParams.get("vacante");
      if (qid) return qid;
      // 3) Last numeric path segment
      const segs = u.pathname.split("/").filter(Boolean);
      for (let i = segs.length - 1; i >= 0; i--) {
        const m = segs[i].match(/(\d{4,})/);
        if (m) return m[1];
      }
      // 4) Last non-empty segment that looks slug-like
      const last = segs[segs.length - 1];
      if (last && last.length > 3) return last;
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

    // TODO(dom): refine these selectors with real LaPieza DOM (English/Spanish
    // class fragments common in modern ATSes: vacancy/position/job-title).
    title = firstNonEmpty(title, textOf("[itemprop='title']"), textOf("[data-testid='job-title']"),
      textOf("[class*='vacancy' i] h1"), textOf("[class*='vacante' i] h1"),
      textOf("[class*='job-title' i]"), textOf("[class*='position' i]"),
      textOf("[class*='title' i]"), textOf("h1"));
    company = firstNonEmpty(company, textOf("[itemprop='hiringOrganization']"),
      textOf("[data-testid='company-name']"), textOf("[class*='company' i]"),
      textOf("[class*='empresa' i] a, [class*='empresa' i]"),
      textOf("[class*='employer' i]"), textOf("[class*='organization' i]"));
    loc = firstNonEmpty(loc, textOf("[itemprop='jobLocation']"), textOf("address"),
      textOf("[data-testid*='location' i]"), textOf("[class*='location' i]"),
      textOf("[class*='ubicacion' i]"), textOf("[class*='localidad' i]"),
      textOf("[class*='ciudad' i]"));
    if (!salary) {
      salary = firstNonEmpty(textOf("[itemprop='baseSalary']"), textOf("[data-testid*='salary' i]"),
        textOf("[class*='salary' i]"), textOf("[class*='sueldo' i]"), textOf("[class*='salario' i]"),
        textOf("[class*='compensation' i]")) || null;
    }
    if (!description) {
      description = firstNonEmpty(textOf("[itemprop='description']"), textOf("[data-testid*='description' i]"),
        textOf("[class*='job-description' i]"), textOf("[class*='descripcion' i]"),
        textOf("[class*='detail' i]"), textOf("[class*='vacancy-detail' i]"),
        largestTextBlock());
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
        <section class="eamx-cv-card" data-eamx-cv-card aria-label="CV personalizado para esta vacante">
          <div class="eamx-cv-card__head">
            <span class="eamx-cv-card__icon" aria-hidden="true">📄</span>
            <div>
              <div class="eamx-cv-card__title">CV personalizado para esta vacante</div>
              <div class="eamx-cv-card__sub">La IA reordena tu CV resaltando los skills que esta vacante pide. Mismas experiencias, mismas fechas — solo mejor estructurado.</div>
            </div>
          </div>
          <div class="eamx-cv-card__body" data-eamx-cv-body></div>
        </section>
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

    // Paint the tailored-CV card in whatever state we currently hold. If the
    // user re-opens the panel after a successful generation we want to keep
    // the cached html and surface the "Abrir y descargar PDF" action.
    renderCvCard();

    panelEl.addEventListener("click", onPanelClick);
    document.body.appendChild(panelEl);
    requestAnimationFrame(() => panelEl.classList.add("eamx-panel--open"));
  }

  function closePanel() { panelEl?.parentNode?.removeChild(panelEl); panelEl = null; }

  // =========================================================================
  // Tailored CV card — render + state machine
  // =========================================================================

  // renderCvCard re-paints the body of the eamx-cv-card section based on the
  // module-level cvState. Idempotent — safe to call after every state change.
  // We replace innerHTML rather than diffing because the card is small and
  // re-attaching the click delegation costs nothing (delegation lives on the
  // panel root, not the card).
  function renderCvCard() {
    if (!panelEl) return;
    const body = panelEl.querySelector("[data-eamx-cv-body]");
    if (!body) return;

    if (cvState === "loading") {
      body.innerHTML =
        '<div class="eamx-cv-card__status" role="status" aria-live="polite">' +
          '<span class="eamx-cv-card__spinner" aria-hidden="true"></span>' +
          '<span>Generando CV (puede tardar 15s)…</span>' +
        '</div>';
      return;
    }

    if (cvState === "success") {
      const headline = [lastJob?.company, lastJob?.title]
        .map((s) => (s || "").trim())
        .filter(Boolean)
        .join(" · ");
      body.innerHTML =
        '<div class="eamx-cv-card__success">' +
          '<span class="eamx-cv-card__check" aria-hidden="true">✓</span>' +
          '<span>CV generado' + (headline ? ' — ' + escapeHtml(headline) : '') + '</span>' +
        '</div>' +
        (cvSummary
          ? '<p class="eamx-cv-card__summary">' + escapeHtml(cvSummary) + '</p>'
          : '') +
        '<div class="eamx-cv-card__actions">' +
          '<button type="button" class="eamx-btn eamx-btn--primary eamx-cv-card__primary" data-action="cv-open">' +
            '<span aria-hidden="true">📄</span> Abrir y descargar PDF' +
          '</button>' +
          '<button type="button" class="eamx-btn eamx-btn--ghost" data-action="cv-regen">Re-generar</button>' +
        '</div>';
      return;
    }

    if (cvState === "error") {
      body.innerHTML =
        '<div class="eamx-cv-card__error" role="alert">' +
          escapeHtml(cvError || "No se pudo generar el CV.") +
        '</div>' +
        '<div class="eamx-cv-card__actions">' +
          '<button type="button" class="eamx-btn eamx-btn--primary eamx-cv-card__primary" data-action="cv-generate">Reintentar</button>' +
        '</div>';
      return;
    }

    // idle (default)
    body.innerHTML =
      '<div class="eamx-cv-card__actions">' +
        '<button type="button" class="eamx-btn eamx-btn--primary eamx-cv-card__primary" data-action="cv-generate">' +
          '<span aria-hidden="true">✨</span> Generar CV personalizado' +
        '</button>' +
      '</div>';
  }

  // Set state + repaint. Always go through this so the UI never drifts from
  // the cvState/cvHtml/cvSummary/cvError tuple.
  function setCvState(next, patch) {
    cvState = next;
    if (patch) {
      if ("html" in patch) cvHtml = patch.html || "";
      if ("summary" in patch) cvSummary = patch.summary || "";
      if ("error" in patch) cvError = patch.error || "";
    }
    renderCvCard();
  }

  async function handleGenerateCv() {
    if (!lastJob) {
      // Defensive: panel only opens after extractJob succeeds, but a user
      // could click after an SPA route change while the card is stale.
      toast("No tengo la vacante. Vuelve a abrir el panel.", "info");
      return;
    }
    setCvState("loading");
    try {
      const res = await sendMsg({ type: MSG.GENERATE_CV, job: lastJob });
      if (!res || !res.ok) {
        const code = res?.error;
        if (code === ERR.PLAN_LIMIT_EXCEEDED) {
          setCvState("error", { error: "Llegaste al límite de tu plan. Sube de plan para seguir generando." });
          // Mirror the cover-letter UX: also fire a toast with a CTA.
          toast("Llegaste al límite de tu plan.", "error", {
            label: "Ver planes",
            onClick: () => openBilling()
          });
          return;
        }
        if (code === ERR.UNAUTHORIZED) {
          setCvState("error", { error: "Tu sesión expiró. Inicia sesión en Opciones para continuar." });
          toast("Tu sesión expiró.", "error", {
            label: "Inicia sesión",
            onClick: () => openOptionsPage()
          });
          return;
        }
        // 422 PROFILE_TOO_THIN comes through as INVALID_INPUT. The backend
        // message is fine but we override with a clearer "next step" line.
        if (code === ERR.INVALID_INPUT && /perfil|cv|profile/i.test(res?.message || "")) {
          setCvState("error", {
            error: "Sube un CV más detallado en Opciones para que la IA tenga más contexto."
          });
          return;
        }
        setCvState("error", { error: res?.message || "No se pudo generar el CV." });
        return;
      }
      setCvState("success", {
        html: res.html || "",
        summary: res.summary || "",
        error: ""
      });
    } catch (err) {
      setCvState("error", { error: humanizeError(err) });
    }
  }

  // Open the cached HTML in a new tab via the service worker. We try blob:
  // first; if the runtime returns an error suggesting the URL was blocked
  // (rare on Chromium MV3 but possible on some forks), we retry with a
  // data: URL. The HTML is auto-printed ~800ms after first paint by a
  // bootstrap script the service worker injects if absent.
  async function handleOpenCv() {
    if (!cvHtml) {
      toast("Genera el CV primero.", "info");
      return;
    }
    try {
      let res = await sendMsg({ type: MSG.OPEN_GENERATED_CV, html: cvHtml });
      if (!res || !res.ok) {
        // Retry with data: URL fallback before surfacing the error.
        res = await sendMsg({ type: MSG.OPEN_GENERATED_CV, html: cvHtml, useDataUrl: true });
      }
      if (!res || !res.ok) {
        toast(res?.message || "No se pudo abrir el CV.", "error");
      }
    } catch (err) {
      toast(humanizeError(err), "error");
    }
  }

  async function onPanelClick(e) {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    if (action === "cancel") return handleCancel();
    if (action === "regen") return handleRegen();
    if (action === "approve") return handleApprove();
    if (action === "cv-generate" || action === "cv-regen") return handleGenerateCv();
    if (action === "cv-open") return handleOpenCv();
  }

  async function handleCancel() {
    try { if (activeDraftId) await sendMsg({ type: MSG.REJECT_DRAFT, draftId: activeDraftId }); } catch (_) {}
    activeDraftId = null; lastDraft = null;
    // Reset the tailored-CV cache so the next vacancy starts fresh.
    cvState = "idle"; cvHtml = ""; cvSummary = ""; cvError = "";
    stopFlowAssistant();
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
      // Persist the (possibly edited) cover letter so the in-flow assistant
      // pastes the latest text when it finds a textarea later in the funnel.
      if (lastDraft) lastDraft.coverLetter = coverLetter;
      fillForm(fields);
      closePanel();
      // Adaptive in-flow guidance: keep watching the page after approval so
      // we can light up file inputs, textareas, questions, and the final
      // submit button as the portal's apply flow progresses.
      startFlowAssistant();
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

  // Locate the primary LaPieza application form: prefer one with both a
  // textarea and a submit-ish button (CTA text: aplicar/postular/enviar);
  // fall back to any form with a textarea.
  function findApplicationForm() {
    const forms = Array.from(document.querySelectorAll("form"));
    const rx = /aplicar|postular|postularme|enviar|inscribir|inscribirme|submit|apply|send/i;
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
    const rx = /aplicar|postular|postularme|enviar|inscribir|inscribirme|submit|apply|send/i;
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
      toast("Llegaste al límite de tu plan.", "error", {
        label: "Ver planes",
        onClick: () => openBilling()
      });
      return;
    }
    if (code === ERR.UNAUTHORIZED) {
      toast("Tu sesión expiró.", "error", {
        label: "Inicia sesión",
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
  // In-flow adaptive assistant
  // =========================================================================
  // Lifecycle: armed by handleApprove(), torn down by handleCancel() or any
  // SPA URL change. While armed, a single MutationObserver (debounced 250ms)
  // re-runs the detector functions over the live DOM. Each detector guards
  // against double-attach via FLOW_PROCESSED (WeakSet) and one-shot tip-keys
  // via FLOW_TIPS_SHOWN (Set). HITL preserved everywhere — we never auto-
  // submit and never overwrite user-typed text without a confirm.

  function startFlowAssistant() {
    if (flowActive) return;
    flowActive = true;
    FLOW_TIPS_SHOWN.clear();
    runFlowDetectors();
    flowObserver = new MutationObserver(() => {
      if (flowDebounceTimer) return;
      flowDebounceTimer = setTimeout(() => {
        flowDebounceTimer = null;
        if (flowActive) runFlowDetectors();
      }, 250);
    });
    try { flowObserver.observe(document.body, { childList: true, subtree: true }); }
    catch (_) { /* body may be missing in edge cases */ }
  }

  function stopFlowAssistant() {
    flowActive = false;
    if (flowObserver) { try { flowObserver.disconnect(); } catch (_) {} flowObserver = null; }
    if (flowDebounceTimer) { clearTimeout(flowDebounceTimer); flowDebounceTimer = null; }
    // Remove any lingering helper UI we attached.
    document.querySelectorAll(
      ".eamx-flow-tooltip, .eamx-flow-paste-btn, .eamx-flow-hint"
    ).forEach((el) => { try { el.remove(); } catch (_) {} });
    FLOW_TIPS_SHOWN.clear();
  }

  function runFlowDetectors() {
    try {
      detectFileInputs();
      detectCoverLetterTextarea();
      detectQuestions();
      detectFinalSubmit();
    } catch (err) {
      console.warn("[EmpleoAutomatico] flow detector error", err);
    }
  }

  // Visibility check — element is rendered and inside the viewport-eligible
  // tree. Skips display:none/hidden ancestors and zero-area elements.
  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    if (el.offsetParent === null && el.tagName !== "BODY") {
      // file inputs are commonly visually hidden but still useful;
      // however we still want them to have non-zero rect.
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  // Walk up the DOM looking for descriptive text (label, fieldset legend,
  // aria-label, surrounding paragraphs). Used to classify questions.
  function nearbyText(el, depth = 4) {
    const parts = [];
    parts.push(el.getAttribute("aria-label") || "");
    parts.push(el.getAttribute("placeholder") || "");
    parts.push(el.name || "");
    parts.push(el.id || "");
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) parts.push(lbl.textContent || "");
    }
    let p = el.parentElement;
    let i = 0;
    while (p && i < depth) {
      if (p.tagName === "LABEL") parts.push(p.textContent || "");
      if (p.tagName === "FIELDSET") {
        const lg = p.querySelector("legend");
        if (lg) parts.push(lg.textContent || "");
      }
      // Capture sibling headings/paragraphs as question text.
      const prev = p.previousElementSibling;
      if (prev && /^(P|H[1-6]|SPAN|DIV|LEGEND)$/i.test(prev.tagName) && (prev.textContent || "").length < 240) {
        parts.push(prev.textContent || "");
      }
      p = p.parentElement;
      i++;
    }
    return parts.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
  }

  // Position helper-UI relative to a target element. Returns a positioner
  // function used by the helper to keep itself anchored on scroll/resize.
  function anchorTo(host, target, placement) {
    const reposition = () => {
      const r = target.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) { host.style.display = "none"; return; }
      host.style.display = "";
      if (placement === "above-right") {
        host.style.top = `${Math.max(8, r.top + window.scrollY - 40)}px`;
        host.style.left = `${Math.max(8, r.right + window.scrollX - 140)}px`;
      } else if (placement === "below") {
        host.style.top = `${r.bottom + window.scrollY + 8}px`;
        host.style.left = `${r.left + window.scrollX}px`;
      } else { // "right" default
        host.style.top = `${r.top + window.scrollY}px`;
        host.style.left = `${r.right + window.scrollX + 10}px`;
      }
    };
    reposition();
    const onScroll = () => reposition();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    // Stash cleanup hook on the host so removeFlowHelper can release listeners.
    host.__eamxCleanup = () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
    return reposition;
  }

  function removeFlowHelper(host) {
    if (!host) return;
    try { host.__eamxCleanup?.(); } catch (_) {}
    try { host.remove(); } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // State 1 — File input for CV
  // ---------------------------------------------------------------------------
  function detectFileInputs() {
    const inputs = Array.from(document.querySelectorAll("input[type='file']"));
    for (const input of inputs) {
      if (FLOW_PROCESSED.has(input)) continue;
      // Skip irrelevant file inputs (e.g., images for cover photo). Heuristic
      // by accept attribute and surrounding labels.
      const accept = (input.getAttribute("accept") || "").toLowerCase();
      const ctx = nearbyText(input);
      const cvHint = /cv|curriculum|currículum|resume|hoja de vida/i.test(ctx);
      const acceptHint = /pdf|doc|application/.test(accept);
      // Either hint is enough; some LaPieza inputs have generic accept.
      const looksLikeCv = cvHint || acceptHint || /upload|adjuntar|subir/i.test(ctx);
      if (!looksLikeCv) continue;

      // file inputs are often visually hidden; anchor on the closest visible
      // wrapper (the label or styled button that proxies the click).
      const anchor = findFileInputAnchor(input);
      if (!anchor || !isVisible(anchor)) continue;

      FLOW_PROCESSED.add(input);
      attachFileInputTip(anchor);
    }
  }

  function findFileInputAnchor(input) {
    // 1) Associated <label for="">
    if (input.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (lbl && isVisible(lbl)) return lbl;
    }
    // 2) Wrapping label
    const wrap = input.closest("label");
    if (wrap && isVisible(wrap)) return wrap;
    // 3) Visible parent with rect
    let p = input.parentElement;
    for (let i = 0; i < 5 && p; i++) {
      if (isVisible(p)) return p;
      p = p.parentElement;
    }
    return input;
  }

  function attachFileInputTip(anchor) {
    const tip = document.createElement("div");
    tip.className = "eamx-flow-tooltip eamx-flow-tooltip--file";
    tip.setAttribute("role", "status");
    // Copy nudges the user toward our tailored CV. Browsers don't allow
    // programmatic file-input fill (security), so this is the strongest
    // affordance we have.
    tip.innerHTML =
      '<span class="eamx-flow-tooltip__icon" aria-hidden="true">📎</span>' +
      '<span class="eamx-flow-tooltip__text">¿Ya tienes el CV personalizado? Súbelo aquí. Si no, regrésate y dale clic a <strong>“Generar CV personalizado”</strong> en el panel de Empleo Automático.</span>' +
      '<button type="button" class="eamx-flow-tooltip__close" aria-label="Cerrar aviso">×</button>';
    document.documentElement.appendChild(tip);
    anchorTo(tip, anchor, "below");
    tip.querySelector(".eamx-flow-tooltip__close").addEventListener("click", () => removeFlowHelper(tip));
    // Auto-dismiss after 8s — this copy is longer than the previous one.
    setTimeout(() => removeFlowHelper(tip), 8000);
  }

  // ---------------------------------------------------------------------------
  // State 2 — Cover-letter / message textarea
  // ---------------------------------------------------------------------------
  function detectCoverLetterTextarea() {
    if (!lastDraft?.coverLetter) return; // nothing to paste
    const candidates = Array.from(document.querySelectorAll("textarea"))
      .filter((t) => isVisible(t) && !FLOW_PROCESSED.has(t));
    if (!candidates.length) return;

    // Prefer textareas whose surrounding text matches cover-letter keywords;
    // fall back to the largest visible textarea on the page.
    const rx = /carta|mensaje|presentaci(?:[oó])n|cover\s*letter|motivation|motivaci/i;
    let target = candidates.find((t) => rx.test(nearbyText(t)));
    if (!target) {
      candidates.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return (rb.width * rb.height) - (ra.width * ra.height);
      });
      target = candidates[0];
    }
    if (!target) return;
    FLOW_PROCESSED.add(target);
    attachPasteCoverButton(target);
  }

  function attachPasteCoverButton(textarea) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "eamx-flow-paste-btn";
    btn.setAttribute("aria-label", "Pegar carta IA generada");
    btn.innerHTML = '<span aria-hidden="true">✨</span><span>Pegar carta IA</span>';
    document.documentElement.appendChild(btn);
    anchorTo(btn, textarea, "above-right");

    btn.addEventListener("click", () => {
      const cover = lastDraft?.coverLetter || "";
      if (!cover) { toast("No hay carta disponible.", "info"); return; }
      const existing = (textarea.value || "").trim();
      const hasUserText = existing.length > 50;
      if (hasUserText) {
        const ok = window.confirm("¿Reemplazar lo que escribiste con la carta IA?");
        if (!ok) return;
      }
      try {
        setNativeValue(textarea, cover);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.dispatchEvent(new Event("change", { bubbles: true }));
      } catch (_) {
        textarea.value = cover;
      }
      // Quick success state on the button.
      btn.classList.add("eamx-flow-paste-btn--ok");
      btn.innerHTML = '<span aria-hidden="true">✓</span><span>Pegado</span>';
      setTimeout(() => { btn.classList.add("eamx-flow-paste-btn--fade"); }, 1500);
      setTimeout(() => removeFlowHelper(btn), 2000);
    });
  }

  // ---------------------------------------------------------------------------
  // State 3 — Multiple-choice / radio / yes-no question hints
  // ---------------------------------------------------------------------------
  function detectQuestions() {
    const answers = lastDraft?.suggestedAnswers;
    if (!answers || typeof answers !== "object") return;
    const keys = Object.keys(answers).filter((k) => answers[k]);
    if (!keys.length) return;

    // Group inputs by their nearest fieldset/group container so we attach a
    // hint once per question, not once per radio option.
    const inputs = Array.from(document.querySelectorAll(
      "input[type='radio'], input[type='checkbox'], select, input[type='text']"
    )).filter((el) => isVisible(el));

    const groups = new Map(); // container -> {input, ctx}
    for (const input of inputs) {
      const container = input.closest("fieldset, [role='radiogroup'], [role='group'], .eamx-question, [data-question], div") || input.parentElement;
      if (!container || groups.has(container)) continue;
      groups.set(container, input);
    }

    for (const [container, input] of groups) {
      if (FLOW_PROCESSED.has(container)) continue;
      const ctx = nearbyText(input, 6);
      if (!ctx || ctx.length < 4) continue;
      const matchKey = keys.find((k) => {
        const needle = k.toLowerCase().trim();
        if (!needle) return false;
        // Loose match: question text contains the answer key OR the key
        // contains a meaningful chunk (>= 4 chars) of the question text.
        if (ctx.includes(needle)) return true;
        const tokens = needle.split(/\s+/).filter((t) => t.length >= 4);
        return tokens.some((t) => ctx.includes(t));
      });
      if (!matchKey) continue;
      FLOW_PROCESSED.add(container);
      attachQuestionHint(container, matchKey, String(answers[matchKey]));
    }
  }

  function attachQuestionHint(container, label, value) {
    const hint = document.createElement("div");
    hint.className = "eamx-flow-hint";
    hint.setAttribute("role", "status");
    const safe = (value || "").toString().slice(0, 240);
    hint.innerHTML =
      '<span class="eamx-flow-hint__badge">Sugerencia</span>' +
      `<span class="eamx-flow-hint__text">${escapeHtml(safe)}</span>` +
      '<button type="button" class="eamx-flow-hint__close" aria-label="Cerrar sugerencia">×</button>';
    // Inline (in-flow): append directly into the container so it sits with
    // the question instead of floating. This avoids anchoring math when the
    // user tabs through fields.
    try {
      if (getComputedStyle(container).position === "static") {
        container.style.position = "relative";
      }
      container.appendChild(hint);
    } catch (_) {
      document.documentElement.appendChild(hint);
      anchorTo(hint, container, "below");
    }
    hint.querySelector(".eamx-flow-hint__close").addEventListener("click", () => removeFlowHelper(hint));
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ---------------------------------------------------------------------------
  // State 4 — Final submit button
  // ---------------------------------------------------------------------------
  // Final-step regex: matches the canonical "send application" copies in
  // Spanish/English. Excludes "siguiente"/"continuar"/"next" which appear on
  // intermediate wizard steps.
  const FLOW_FINAL_RX = /enviar\s+postulaci[oó]n|enviar\s+aplicaci[oó]n|aplicar\s+ahora|finalizar(?:\s+postulaci[oó]n)?|submit\s+application|send\s+application/i;
  const FLOW_NEXT_RX = /\b(siguiente|continuar|next|continue)\b/i;

  function detectFinalSubmit() {
    const buttons = Array.from(document.querySelectorAll("button, a[role='button'], input[type='submit']"));
    for (const btn of buttons) {
      if (FLOW_PROCESSED.has(btn)) continue;
      if (!isVisible(btn)) continue;
      const text = (btn.textContent || btn.value || "").trim();
      if (!text) continue;
      if (FLOW_NEXT_RX.test(text)) continue; // intermediate step
      if (!FLOW_FINAL_RX.test(text)) continue;
      FLOW_PROCESSED.add(btn);
      try { btn.classList.add("eamx-submit-pulse"); } catch (_) {}
      // Fire a one-shot toast (dedupe to avoid spam if multiple final
      // buttons appear, e.g. sticky + footer).
      if (!FLOW_TIPS_SHOWN.has("final-submit")) {
        FLOW_TIPS_SHOWN.add("final-submit");
        toast("Listo. Revisa todo y dale Enviar cuando estés conforme. Tú das el último clic.", "success");
      }
    }
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
        // Tailored CV cache is per-vacancy — drop on SPA route change.
        cvState = "idle"; cvHtml = ""; cvSummary = ""; cvError = "";
        // SPA route changed: tear down any in-flow helpers tied to the old
        // page. The assistant will re-arm if the user approves on the new
        // route. We clear the dedupe set so detectors can re-attach to
        // freshly-rendered inputs/textareas/buttons.
        stopFlowAssistant();
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
