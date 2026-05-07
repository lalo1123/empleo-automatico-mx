/**
 * content/computrabajo.js — Computrabajo México content script (Empleo Automático MX)
 *
 * Confidence on Computrabajo selectors: LOW/MEDIUM. computrabajo.com.mx sits
 * behind Cloudflare and returns 403 to WebFetch, so the DOM hooks below were
 * NOT verified on a live page. Order-of-preference (same strategy as OCC):
 *   1) JSON-LD @type JobPosting (Computrabajo emits SEO structured data)
 *   2) Microdata / ARIA / semantic HTML (itemprop, h1, address)
 *   3) Heuristic class-name matches (oferta, empresa, ubicacion, salario)
 *   4) Largest text block in <main>/<article> as last resort
 * MVP assumes the user is already logged into Computrabajo in the same session.
 *
 * Mirrors content/occ.js 1:1 in structure. Differences: SOURCE, URL patterns,
 * id extraction (Computrabajo uses `?id=XYZ` query string), and fillForm maps
 * `phone` in addition to fullName/email/coverLetter.
 */
(function () {
  "use strict";

  const SOURCE = "computrabajo";
  const MSG = { GENERATE_DRAFT: "GENERATE_DRAFT", APPROVE_DRAFT: "APPROVE_DRAFT", REJECT_DRAFT: "REJECT_DRAFT", OPEN_BILLING: "OPEN_BILLING" };
  const ERR = { UNAUTHORIZED: "UNAUTHORIZED", PLAN_LIMIT_EXCEEDED: "PLAN_LIMIT_EXCEEDED" };
  const BILLING_URL = "https://empleo.skybrandmx.com/account/billing";

  // TODO(dom): verify against real Computrabajo URLs. These cover the common
  // "oferta-de-trabajo-de-..." slug pattern plus a generic /ofertas-de-trabajo/
  // fallback and /empleos/ (older layout).
  //
  // NOTE: detail vs listing on Computrabajo share the /ofertas-de-trabajo/
  // prefix. The slug "oferta-de-trabajo-de-..." identifies a detail page; the
  // bare /ofertas-de-trabajo/?... path is the listing. We therefore keep
  // JOB_URL_PATTERNS narrow (only forms that imply a single detail) and rely
  // on LISTING_PATH_RX + DOM probe to disambiguate.
  const JOB_URL_PATTERNS = [
    /\/ofertas-de-trabajo\/oferta-de-trabajo-de-/i,
    /\/ofertas-de-trabajo\/[^/]+[?&]id=/i,
    /\/empleos\/[^/]+-\d+/i,
    /\/oferta\/\d+/i
  ];

  // Listing-page detection. Computrabajo's main listing root is
  // /ofertas-de-trabajo/ (with optional ?p=N pagination + ?q=, ?lo=, etc.
  // filters). Variants we keep on the allowlist for safety:
  //   /trabajos-en-<ciudad>/    — older slug-style city pages
  //   /trabajos-de-<rol>/       — role-based slug pages
  //   /empleos/                 — legacy layout fallback
  // Detail pages match /ofertas-de-trabajo/oferta-de-trabajo-de-... — that
  // longer slug is excluded by isListingPath via the JOB_URL_PATTERNS check
  // before the regex test.
  const LISTING_PATH_RX = [
    /^\/ofertas-de-trabajo\/?$/i,
    /^\/trabajos-en-/i,
    /^\/trabajos-de-/i,
    /^\/empleos\/?$/i,
    /^\/?$/  // homepage
  ];

  // Anchor regex for vacancy detail links. Computrabajo's canonical detail
  // URL is /ofertas-de-trabajo/oferta-de-trabajo-de-<slug>-<id> — but we also
  // accept the rarer /oferta/<id> form and the /empleos/ legacy form.
  // Listing-only paths (?p=2, /ofertas-de-trabajo/?q=...) are excluded by
  // requiring the "oferta-de-trabajo-de-" or "/oferta/<n>" segment.
  const VACANCY_ANCHOR_RX = /(?:\/ofertas-de-trabajo\/oferta-de-trabajo-de-[^/?#]+|\/oferta\/\d+|\/empleos\/[^/?#]+-\d+)/i;

  // Storage key for user preferences (city, modality, salary). Mirrors lib/schemas.js.
  const PREFERENCES_STORAGE_KEY = "eamx:preferences";

  // Dynamic import of shared schemas — same pattern as occ.js. In MV3 content
  // scripts can't declare ES-module imports, but runtime dynamic import works.
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

  // Discovery / listing-page module state — mirrors content/occ.js + lapieza.
  let matchScoreModule = null;
  let queueModule = null;
  let cachedProfile = null;
  let cachedPreferences = null;
  let profileLoaded = false;
  let preferencesLoaded = false;
  let listingObserver = null;
  let listingScanTimer = null;
  // Tracks the current top-N rendered list so the queue-onChanged listener
  // can re-paint button states without re-running findVacancyCards.
  let matchesPanelEl = null;
  let matchesQueueListener = null;
  let matchesEscHandler = null;
  let matchesCurrentTopN = [];
  // Wider-search accumulator. Computrabajo paginates via ?p=N URL changes,
  // which DO unmount the page (unlike LaPieza's MUI Pagination), so we
  // accumulate by snapshotting cards on each page before navigating + storing
  // the cumulative pool keyed by id. Cleared on panel close + on SPA route
  // change OUT of the listing (intra-listing pagination preserves it).
  let widerSearchPool = null;

  // =========================================================================
  // Detection & extraction
  // =========================================================================

  function isJobDetailPage() {
    const urlMatches = JOB_URL_PATTERNS.some((re) => re.test(location.href));
    const hasHeading = !!document.querySelector(
      "h1, [class*='oferta' i] h1, [class*='title' i], [data-testid*='title' i]"
    );
    const applyRx = /postular|aplicar|postúlate|postulate|inscribir|inscribirme|apply/i;
    const hasApply = Array.from(document.querySelectorAll(
      "button, a[role='button'], a.btn, a[class*='apply' i], a[class*='postular' i], a[class*='aplicar' i], a[class*='inscribir' i]"
    )).some((el) => applyRx.test((el.textContent || "").trim()));
    const hasJsonLd = !!findJobPostingJsonLd();
    return (urlMatches && hasHeading) || hasJsonLd || (hasHeading && hasApply);
  }

  // Listing-page detector. Path allowlist first (cheap regex check) and a
  // DOM-probe fallback so unknown URL aliases still light up the badges
  // when they render multiple vacancy anchors. Mirrors content/occ.js.
  // Detail pages are excluded: /ofertas-de-trabajo/oferta-de-trabajo-de-...
  // matches both LISTING_PATH_RX (the bare prefix) AND JOB_URL_PATTERNS, so
  // we test the detail patterns FIRST and bail before classifying as listing.
  function isListingPage() {
    const path = location.pathname || "";
    // Detail-style URLs (oferta-de-trabajo-de-...) are NOT listings even
    // though they share the /ofertas-de-trabajo/ prefix.
    if (JOB_URL_PATTERNS.some((rx) => rx.test(location.href))) return false;
    if (LISTING_PATH_RX.some((rx) => rx.test(path))) return true;
    // Fallback: any path with multiple vacancy anchors visible.
    try {
      if (typeof findVacancyCards === "function") {
        const cards = findVacancyCards();
        if (Array.isArray(cards) && cards.length >= 2) return true;
      }
    } catch (_) { /* ignore */ }
    return false;
  }

  // Convenience alias for parity with lapieza.js call sites — same semantics.
  function isListingPath() {
    return isListingPage();
  }

  // FAB mode resolver — mirrors content/occ.js.
  //   "listing" → on /ofertas-de-trabajo/, /trabajos-de-..., etc.
  //   "vacancy" → on /ofertas-de-trabajo/oferta-de-trabajo-de-... and /oferta/<id>
  //   null      → don't mount the FAB at all
  function fabMode() {
    if (isListingPage() && !isJobDetailPage()) return "listing";
    if (isJobDetailPage()) return "vacancy";
    return null;
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
    const t = (text || "").toLowerCase();
    if (/\b(home[- ]?office|remoto|teletrabajo|remote|a distancia)\b/.test(t)) return "remoto";
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
    // TODO(dom): refine container selectors with real Computrabajo DOM.
    // Computrabajo commonly uses class-name patterns like "requisit", "perfil",
    // or generic "detail"/"content" blocks, so we cast a wide net here.
    const containers = document.querySelectorAll(
      "[class*='requisit' i], [class*='requirement' i], [class*='perfil' i], [data-testid*='requirement' i]"
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

  // Computrabajo id resolution:
  //   1) Query string ?id=XYZ or ?oferta=XYZ on some detail layouts.
  //   2) Trailing alphanumeric token on the slug
  //      (/oferta-de-trabajo-de-<role>-<company>-<token>) — Computrabajo's
  //      canonical id is a base32-ish ~10-12 char trailing segment.
  //   3) /oferta/<digits> direct numeric id.
  //   4) Last 5+ digit number in the URL.
  //   5) Hash of the full URL (last resort, stable across calls).
  function idFromUrl(url) {
    try {
      const u = new URL(url);
      const qid = u.searchParams.get("id") || u.searchParams.get("oferta");
      if (qid) return qid;
      // /oferta/<id> — pure numeric form on some legacy layouts.
      const numMatch = u.pathname.match(/\/oferta\/(\d+)/i);
      if (numMatch) return numMatch[1];
      // /oferta-de-trabajo-de-<...slug...>-<token>
      // The token is whatever comes after the LAST hyphen before any
      // trailing slash. Computrabajo uses ~10-12 base32-ish chars.
      const slugMatch = u.pathname.match(/\/oferta-de-trabajo-de-([^/?#]+)/i);
      if (slugMatch) {
        const tail = slugMatch[1].split("-").filter(Boolean);
        const last = tail[tail.length - 1];
        if (last && /^[A-Za-z0-9]{6,}$/.test(last)) return last;
        // Fallback: full slug (still stable as a unique identifier).
        if (slugMatch[1]) return slugMatch[1];
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

    // TODO(dom): refine these selectors with real Computrabajo DOM.
    // Computrabajo commonly uses Spanish class fragments: "oferta", "empresa",
    // "ubicacion"/"localidad", "salario"/"sueldo".
    title = firstNonEmpty(title, textOf("[itemprop='title']"), textOf("[data-testid='job-title']"),
      textOf("[class*='oferta' i] h1"), textOf("[class*='title' i]"), textOf("h1"));
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
    if (fabEl && document.body.contains(fabEl)) {
      // Already mounted — defensive re-attach + repaint label so SPA
      // transitions between listing and vacancy modes don't leave the
      // wrong copy on screen.
      try { fabEl.removeEventListener("click", onFabClick); } catch (_) {}
      fabEl.addEventListener("click", onFabClick);
      paintFabLabel();
      return;
    }
    fabEl = document.createElement("button");
    fabEl.type = "button";
    fabEl.className = "eamx-fab";
    fabEl.setAttribute("aria-label", "Postular con IA");
    fabEl.innerHTML =
      '<span class="eamx-fab__icon" aria-hidden="true">✨</span>' +
      '<span class="eamx-fab__label">Postular con IA</span>';
    fabEl.addEventListener("click", onFabClick);
    document.body.appendChild(fabEl);
    paintFabLabel();
  }
  function unmountFab() { fabEl?.parentNode?.removeChild(fabEl); fabEl = null; }
  function setFabBusy(b) {
    if (!fabEl) return;
    fabEl.classList.toggle("eamx-fab--busy", !!b);
    fabEl.disabled = !!b;
    const lbl = fabEl.querySelector(".eamx-fab__label");
    if (!lbl) return;
    if (b) {
      lbl.textContent = "Generando";
    } else {
      // Restore the route-specific label rather than hard-coding the
      // vacancy copy — listings use a different label.
      paintFabLabel();
    }
  }

  // Repaint the FAB icon, label, and aria-label so they reflect the current
  // route mode. Called after mount and after every SPA URL change.
  function paintFabLabel() {
    if (!fabEl) return;
    const lbl = fabEl.querySelector(".eamx-fab__label");
    const icon = fabEl.querySelector(".eamx-fab__icon");
    if (fabMode() === "listing") {
      if (icon) icon.textContent = "🎯";
      if (lbl) lbl.textContent = "Mejores matches";
      fabEl.setAttribute("aria-label", "Ver mejores matches en esta página");
    } else {
      if (icon) icon.textContent = "✨";
      if (lbl) lbl.textContent = "Postular con IA";
      fabEl.setAttribute("aria-label", "Postular con IA");
    }
  }

  async function onFabClick() {
    if (!fabEl || fabEl.disabled) return;
    // Listing-page click → open best-matches panel. Vacancy-page click →
    // existing single-job draft flow. fabMode resolves which one we're on.
    if (fabMode() === "listing") {
      try { await openBestMatchesPanel(); }
      catch (err) {
        console.warn("[EmpleoAutomatico] best-matches open failed", err);
        toast("No se pudo abrir el panel de matches.", "error");
      }
      return;
    }
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

  // Locate the primary Computrabajo application form: prefer one with both a
  // textarea and a submit-ish button; fall back to any form with a textarea.
  // Computrabajo uses "inscribir" / "postular" / "enviar" on its submit CTAs.
  function findApplicationForm() {
    const forms = Array.from(document.querySelectorAll("form"));
    const rx = /postular|aplicar|enviar|inscribir|inscribirme|submit|apply|send/i;
    for (const f of forms) {
      if (!f.querySelector("textarea")) continue;
      const btn = f.querySelector("button, input[type='submit']");
      if (btn && rx.test((btn.textContent || btn.value || "").trim())) return f;
    }
    return forms.find((f) => !!f.querySelector("textarea")) || forms[0] || null;
  }

  // Resolve a semantic key (fullName, email, phone, coverLetter) against the
  // live DOM. If `key` looks like a CSS selector, try it as a selector first.
  //
  // Semantic mapping (Computrabajo forms typically include these fields):
  //   fullName    → input matching name/nombre
  //   email       → input[type=email] or matching email/correo
  //   phone       → input[type=tel] or matching tel/cel/whatsapp/móvil  (NEW vs OCC)
  //   coverLetter → first textarea or one matching presentación/mensaje/carta
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
    const rx = /postular|enviar|aplicar|inscribir|inscribirme|submit|send/i;
    const form = findApplicationForm();
    const scope = form || document;
    const direct = scope.querySelector("button[type='submit'], input[type='submit']");
    if (direct) return direct;
    return Array.from(scope.querySelectorAll("button, a[role='button']"))
      .find((b) => rx.test((b.textContent || "").trim())) || null;
  }

  // Scroll the submit button into view and pulse it so the user sees where to
  // click. NEVER auto-click — human-in-the-loop guarantee.
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

  // toast supports three call shapes:
  //   toast(msg, variant)
  //   toast(msg, variant, { label, onClick })       — adds action button (8s default)
  //   toast(msg, variant, { durationMs })           — custom timeout, no button
  //   toast(msg, variant, { label, onClick, durationMs })
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
    const hasAction = !!(action && action.label && typeof action.onClick === "function");
    const duration = (action && Number.isFinite(action.durationMs))
      ? Math.max(800, action.durationMs | 0)
      : (hasAction ? 8000 : 4000);
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
  // Discovery & Queue — listing-page badges + matches panel (ported from
  // content/lapieza.js + content/occ.js). On Computrabajo listing routes
  // (/ofertas-de-trabajo/?..., /trabajos-de-..., /trabajos-en-...) we walk
  // the DOM, score every vacancy card against the user's CV via
  // lib/match-score.js, and inject a small overlay (badge + Marcar button).
  // The button writes to chrome.storage.local["eamx:queue"] via lib/queue.js.
  // The Options page reads the same key. HITL-only: nothing here ever
  // submits an application or auto-clicks Postular/Inscribirme.
  // =========================================================================

  // Lazy-load lib/match-score and lib/queue. Returns true when both are
  // available. Failures are silent — the caller falls back to "unknown" badges.
  async function ensureDiscoveryDeps() {
    if (matchScoreModule && queueModule) return true;
    try {
      if (!matchScoreModule) {
        matchScoreModule = await import(chrome.runtime.getURL("lib/match-score.js"));
      }
      if (!queueModule) {
        queueModule = await import(chrome.runtime.getURL("lib/queue.js"));
      }
      return !!(matchScoreModule && queueModule);
    } catch (err) {
      console.warn("[EmpleoAutomatico] discovery deps load failed", err);
      return false;
    }
  }

  // One-shot read of the user profile from chrome.storage.local. Cached so
  // repeated listing scans don't repeatedly hit storage.
  function loadProfileOnce() {
    if (profileLoaded) return Promise.resolve(cachedProfile);
    return new Promise((resolve) => {
      try {
        if (!chrome?.storage?.local) { profileLoaded = true; resolve(null); return; }
        chrome.storage.local.get(["userProfile"], (r) => {
          cachedProfile = (r && r.userProfile) || null;
          profileLoaded = true;
          resolve(cachedProfile);
        });
      } catch (_) { profileLoaded = true; resolve(null); }
    });
  }

  // One-shot read of user preferences. null means "not configured" — the
  // scorer treats that as legacy mode (no city/modality/salary bonus).
  function loadPreferencesOnce() {
    if (preferencesLoaded) return Promise.resolve(cachedPreferences);
    return new Promise((resolve) => {
      try {
        if (!chrome?.storage?.local) { preferencesLoaded = true; resolve(null); return; }
        chrome.storage.local.get([PREFERENCES_STORAGE_KEY], (r) => {
          const v = r && r[PREFERENCES_STORAGE_KEY];
          cachedPreferences = (v && typeof v === "object") ? v : null;
          preferencesLoaded = true;
          resolve(cachedPreferences);
        });
      } catch (_) { preferencesLoaded = true; resolve(null); }
    });
  }

  // Re-render listing badges + matches panel when CV/preferences/queue
  // change in another tab. Mirrors the lapieza.js/occ.js storage.onChanged
  // wiring so cross-tab edits propagate live.
  function watchProfileChanges() {
    try {
      if (!chrome?.storage?.onChanged) return;
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (changes.userProfile) {
          cachedProfile = changes.userProfile.newValue || null;
          profileLoaded = true;
          scheduleListingScan(50);
        }
        if (changes[PREFERENCES_STORAGE_KEY]) {
          const next = changes[PREFERENCES_STORAGE_KEY].newValue;
          cachedPreferences = (next && typeof next === "object") ? next : null;
          preferencesLoaded = true;
          scheduleListingScan(50);
          if (matchesPanelEl && document.documentElement.contains(matchesPanelEl)) {
            try { renderMatchesPanelContent(); } catch (_) {}
          }
        }
        if (changes["eamx:queue"]) {
          // Queue changed (likely from another tab via "Quitar"); re-render
          // the Marcar buttons so they reflect the new state.
          scheduleListingScan(50);
        }
      });
    } catch (_) { /* ignore */ }
  }

  // Walk up from a vacancy <a> to its visual card root. Pick the closest
  // ancestor that is block/flex/grid display, ≥80px tall, and contains a
  // heading. Bail at 8 levels — beyond that we'd just be picking up sidebar
  // containers. Same heuristic as lapieza.js / occ.js.
  function findCardRoot(anchor) {
    if (!anchor) return null;
    // Computrabajo's listing markup wraps each card in <article> with the
    // anchor inside. The anchor itself is rarely card-shaped (it's just the
    // title link), so we don't try the anchor-as-root shortcut here.
    let p = anchor.parentElement;
    let depth = 0;
    while (p && depth < 8) {
      try {
        const cs = getComputedStyle(p);
        if (cs.display === "block" || cs.display === "flex" || cs.display === "grid") {
          const rect = p.getBoundingClientRect();
          const tall = rect.height > 80 && rect.height < 800;
          const hasH = !!p.querySelector("h1, h2, h3, h4, [class*='title' i]");
          if (tall && hasH) return p;
        }
      } catch (_) { /* getComputedStyle can throw on detached nodes */ }
      p = p.parentElement;
      depth++;
    }
    return null;
  }

  // Cheap jobLite from a card. Computrabajo selectors:
  //   - title:    h1-h4 (cards typically use <h2><a>) + [class*='title']
  //   - company:  .iO .it-blank, [class*='company'/'empresa'], <a> in card head
  //   - location: .iO span containing ciudad/state, [class*='location'/
  //               'ubicacion'/'ciudad'], <p> with city text near the title
  // We cast a wide net because Computrabajo's class names (.iO, .box_offer,
  // .it-blank) are obfuscated/legacy and may rotate. Heuristics → fallbacks.
  function extractJobLiteFromCard(card, anchor) {
    const titleEl = card.querySelector("h1, h2, h3, h4, [class*='title' i] strong, [class*='title' i]");
    let title = "";
    if (titleEl) title = cleanText(titleEl.textContent);
    if (!title) {
      // Fallback: anchor text is usually the title for Computrabajo cards.
      title = cleanText(anchor.textContent);
    }
    const companyEl = card.querySelector(
      "[class*='empresa' i], [class*='company' i], [class*='employer' i], a.it-blank, .it-blank"
    );
    let company = companyEl ? cleanText(companyEl.textContent) : "";
    if (!company) {
      // Walk through leaf text nodes and pick the first non-title visible
      // text. Computrabajo sometimes renders the company as a plain <a>.
      const texts = Array.from(card.querySelectorAll("*"))
        .map((el) => el.children.length === 0 ? cleanText(el.textContent) : "")
        .filter((t) => t && t !== title && t.length > 1 && t.length < 80);
      if (texts.length) company = texts[0];
    }
    const url = anchor.href;
    const id = idFromUrl(url);
    const locationEl = card.querySelector(
      "[class*='location' i], [class*='ubicacion' i], [class*='ciudad' i], p[class*='loc' i], address"
    );
    const loc = locationEl ? cleanText(locationEl.textContent) : "";
    return {
      id,
      url,
      title: title || "(sin título)",
      company: company || "(empresa)",
      location: loc || ""
    };
  }

  // Guard — skip anchors that live INSIDE our own injected UI (matches
  // panel, toast, etc.). Without this guard the listing scanner would
  // scrape the panel's own "Abrir vacante →" links and inject overlays
  // INSIDE the panel items.
  function isInsideOurUI(el) {
    if (!el) return false;
    return !!el.closest(".eamx-matches-panel, .eamx-panel, .eamx-toast, .eamx-card-overlay");
  }

  // Find every vacancy anchor that's NOT already inside a card we've
  // overlaid. Returns the unique set of (anchor, cardRoot) tuples.
  //
  // Computrabajo selector strategy (from least → most specific):
  //   1) <article.box_offer> + <article.iO>                    — current layout
  //   2) <article> with an <h2> that has an anchor              — generic SEO layout
  //   3) <a href*="/ofertas-de-trabajo/oferta-de-trabajo-de-">  — fast-path link
  //   4) Generic href regex                                     — safety net
  //
  // TODO(dom): some of these class names are educated guesses (.iO, .it-blank
  // are Computrabajo's actual class fragments per public site inspection).
  // Verify against a logged-in session and refine the fast paths.
  function findVacancyCards() {
    const seenAnchor = new WeakSet();
    const anchors = [];
    const skipOurs = (a) => isInsideOurUI(a);

    // Fast paths — try these first so we don't pay the full a[href] cost
    // when the DOM is large. Each guarded so a missing selector doesn't
    // throw. Order matters: most specific to most generic.
    const fastSelectors = [
      'article.box_offer a[href]',
      'article.iO a[href]',
      'article[class*="offer" i] a[href]',
      '[class*="box_offer" i] a[href]',
      'article h2 a[href]',
      'a[href*="/oferta-de-trabajo-de-"]'
    ];
    for (const sel of fastSelectors) {
      try {
        document.querySelectorAll(sel).forEach((a) => {
          if (skipOurs(a)) return;
          if (!seenAnchor.has(a) && VACANCY_ANCHOR_RX.test(a.href || "")) {
            seenAnchor.add(a);
            anchors.push(a);
          }
        });
      } catch (_) { /* invalid selector — skip */ }
    }
    // Fallback: any <a> whose href matches the vacancy URL pattern.
    document.querySelectorAll("a[href]").forEach((a) => {
      if (seenAnchor.has(a)) return;
      if (skipOurs(a)) return;
      if (VACANCY_ANCHOR_RX.test(a.href || "")) {
        seenAnchor.add(a);
        anchors.push(a);
      }
    });

    const seenCard = new WeakSet();
    const out = [];
    for (const a of anchors) {
      // Visual card is the wrapper above the anchor. findCardRoot walks up
      // to find an article/div with reasonable height + a heading; if it
      // can't, fall back to the anchor itself.
      const card = findCardRoot(a) || a;
      if (!card) continue;
      if (seenCard.has(card)) continue;
      seenCard.add(card);
      // Skip if already overlaid (idempotency).
      if (card.hasAttribute("data-eamx-card-overlay")) continue;
      out.push({ anchor: a, card });
    }
    return out;
  }

  // Same as findVacancyCards but WITHOUT the overlay-skip filter, used by
  // the matches panel so cards already overlaid still get scored.
  function findAllVacancyCards() {
    const seenAnchor = new WeakSet();
    const anchors = [];
    const skipOurs = (a) => isInsideOurUI(a);
    const fastSelectors = [
      'article.box_offer a[href]',
      'article.iO a[href]',
      'article[class*="offer" i] a[href]',
      '[class*="box_offer" i] a[href]',
      'article h2 a[href]',
      'a[href*="/oferta-de-trabajo-de-"]'
    ];
    for (const sel of fastSelectors) {
      try {
        document.querySelectorAll(sel).forEach((a) => {
          if (skipOurs(a)) return;
          if (!seenAnchor.has(a) && VACANCY_ANCHOR_RX.test(a.href || "")) {
            seenAnchor.add(a);
            anchors.push(a);
          }
        });
      } catch (_) {}
    }
    document.querySelectorAll("a[href]").forEach((a) => {
      if (seenAnchor.has(a)) return;
      if (skipOurs(a)) return;
      if (VACANCY_ANCHOR_RX.test(a.href || "")) {
        seenAnchor.add(a);
        anchors.push(a);
      }
    });
    const seenCard = new WeakSet();
    const out = [];
    for (const a of anchors) {
      const card = findCardRoot(a) || a;
      if (!card || seenCard.has(card)) continue;
      seenCard.add(card);
      out.push({ anchor: a, card });
    }
    return out;
  }

  // Inject the overlay (badge + Marcar button) into a card.
  async function injectOverlay({ anchor, card }) {
    try {
      // Stamp the host so we never double-inject.
      card.setAttribute("data-eamx-card-overlay", "1");
      // Positioning context for the absolute overlay.
      try {
        if (getComputedStyle(card).position === "static") {
          card.style.position = "relative";
        }
      } catch (_) {}

      const jobLite = extractJobLiteFromCard(card, anchor);
      let score = null;
      let reasons = [];
      let level = "unknown";
      if (cachedProfile && matchScoreModule) {
        const eff = (typeof matchScoreModule.effectivePreferences === "function")
          ? matchScoreModule.effectivePreferences(cachedPreferences, cachedProfile)
          : cachedPreferences;
        const r = matchScoreModule.computeMatchScore(cachedProfile, jobLite, eff);
        score = r.score;
        reasons = r.reasons || [];
        level = matchScoreModule.levelForScore(score);
      }

      // Apply the "poor" fade to the host card when score < 40.
      try {
        if (score !== null && level === "poor") card.classList.add("eamx-card--poor");
      } catch (_) {}

      const overlay = document.createElement("div");
      overlay.className = "eamx-card-overlay";
      overlay.setAttribute("data-eamx-overlay-host", "1");

      const badge = document.createElement("span");
      badge.className = `eamx-match-badge eamx-match-badge--${level}`;
      if (score === null) {
        badge.textContent = "—";
        badge.title = "Sube tu CV en Opciones para ver match scores";
      } else {
        badge.textContent = `${score}% match`;
        badge.title = reasons.length ? reasons.join(" · ") : "Match calculado contra tu CV";
      }
      overlay.appendChild(badge);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "eamx-mark-btn";
      btn.setAttribute("data-eamx-mark", jobLite.id);
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        onMarkClick(btn, jobLite, { score: score === null ? 0 : score, reasons });
      });
      overlay.appendChild(btn);

      // Initial label depends on whether the job is already in the queue.
      let already = false;
      try {
        if (queueModule) already = await queueModule.isInQueue(jobLite.id, SOURCE);
      } catch (_) {}
      paintMarkButton(btn, already);

      card.appendChild(overlay);
    } catch (err) {
      console.warn("[EmpleoAutomatico] overlay inject failed", err);
    }
  }

  function paintMarkButton(btn, marked) {
    if (!btn) return;
    if (marked) {
      btn.classList.add("eamx-mark-btn--marked");
      btn.innerHTML = '<span aria-hidden="true">✓</span><span>Marcada</span>';
      btn.setAttribute("aria-pressed", "true");
      btn.setAttribute("aria-label", "Quitar de la cola");
    } else {
      btn.classList.remove("eamx-mark-btn--marked");
      btn.innerHTML = '<span aria-hidden="true">⭐</span><span>Marcar</span>';
      btn.setAttribute("aria-pressed", "false");
      btn.setAttribute("aria-label", "Marcar para revisar después");
    }
  }

  async function onMarkClick(btn, jobLite, scoring) {
    if (!queueModule) {
      const ok = await ensureDiscoveryDeps();
      if (!ok) { toast("No se pudo abrir la cola.", "error"); return; }
    }
    btn.disabled = true;
    try {
      const already = await queueModule.isInQueue(jobLite.id, SOURCE);
      if (already) {
        await queueModule.removeFromQueue(jobLite.id, SOURCE);
        paintMarkButton(btn, false);
        toast("Quitada de tu cola.", "info", { durationMs: 2500 });
      } else {
        const item = {
          id: jobLite.id,
          source: SOURCE,
          url: jobLite.url,
          title: jobLite.title,
          company: jobLite.company,
          location: jobLite.location,
          savedAt: Date.now(),
          matchScore: Number(scoring?.score) || 0,
          reasons: Array.isArray(scoring?.reasons) ? scoring.reasons.slice(0, 3) : []
        };
        const { added } = await queueModule.addToQueue(item);
        if (added) {
          paintMarkButton(btn, true);
          toast("⭐ Marcada. Revísala después en Opciones → Mi cola.", "success", { durationMs: 3500 });
        }
      }
    } catch (err) {
      console.warn("[EmpleoAutomatico] queue toggle failed", err);
      toast("No se pudo guardar en la cola.", "error");
    } finally {
      btn.disabled = false;
    }
  }

  // Throttled re-scan funnel for MutationObserver / storage updates.
  function scheduleListingScan(delayMs = 600) {
    if (listingScanTimer) clearTimeout(listingScanTimer);
    listingScanTimer = setTimeout(async () => {
      listingScanTimer = null;
      if (!isListingPath()) return;
      const ok = await ensureDiscoveryDeps();
      if (!ok) return;
      if (!profileLoaded) await loadProfileOnce();
      const cards = findVacancyCards();
      cards.forEach((c) => { injectOverlay(c); });
    }, delayMs);
  }

  function startListingObserver() {
    if (listingObserver) return;
    listingObserver = new MutationObserver(() => {
      if (!isListingPath()) return;
      scheduleListingScan(600);
    });
    try {
      listingObserver.observe(document.body, { childList: true, subtree: true });
    } catch (_) { /* body may be missing */ }
  }

  function stopListingObserver() {
    if (listingObserver) {
      try { listingObserver.disconnect(); } catch (_) {}
      listingObserver = null;
    }
    if (listingScanTimer) {
      clearTimeout(listingScanTimer);
      listingScanTimer = null;
    }
    // Tear down any overlays we already injected.
    document.querySelectorAll("[data-eamx-overlay-host]").forEach((el) => {
      try { el.remove(); } catch (_) {}
    });
    document.querySelectorAll("[data-eamx-card-overlay]").forEach((el) => {
      try { el.removeAttribute("data-eamx-card-overlay"); } catch (_) {}
      try { el.classList.remove("eamx-card--poor"); } catch (_) {}
    });
  }

  // =========================================================================
  // Best-matches shortlist panel (listing pages)
  // =========================================================================
  // HITL guarantees: this panel never auto-clicks Postular/Inscribirme,
  // never opens multiple tabs programmatically, never submits anything.
  // "Marcar" only writes to chrome.storage.local["eamx:queue"]. The
  // "⚡ Postular →" link uses a normal target="_blank" — the user clicks it.

  async function openBestMatchesPanel() {
    // Idempotent: if already open, just refocus.
    if (matchesPanelEl && document.documentElement.contains(matchesPanelEl)) {
      try { matchesPanelEl.focus({ preventScroll: true }); } catch (_) {}
      return;
    }

    // Build skeleton synchronously so the user sees something instantly.
    matchesPanelEl = document.createElement("aside");
    matchesPanelEl.className = "eamx-matches-panel";
    matchesPanelEl.setAttribute("role", "dialog");
    matchesPanelEl.setAttribute("aria-label", "Mejores matches");
    matchesPanelEl.tabIndex = -1;
    matchesPanelEl.innerHTML = `
      <header class="eamx-matches-panel__head">
        <h2>🎯 Mejores matches en esta página</h2>
        <button type="button" class="eamx-matches-panel__close" aria-label="Cerrar">✕</button>
      </header>
      <p class="eamx-matches-panel__lead">Top 25 vacantes ordenadas por afinidad con tu CV. Tú decides a cuáles postular.</p>
      <div class="eamx-matches-panel__content" data-eamx-matches-content>
        <div class="eamx-matches-panel__loading">Analizando vacantes…</div>
      </div>
      <div class="eamx-matches-panel__loadmore" data-eamx-matches-loadmore hidden>
        <button type="button" class="eamx-matches-panel__loadmore-btn" data-action="wider-search">🔍 Buscar más amplio</button>
        <p class="eamx-matches-panel__loadmore-hint">Carga hasta 100 vacantes de Computrabajo y te muestra las mejores según tus preferencias y CV.</p>
      </div>
      <div class="eamx-matches-panel__bulk" data-eamx-matches-bulk hidden>
        <button type="button" class="eamx-matches-panel__bulk-btn" data-action="mark-top-5">⭐ Marcar top 5 de un solo clic</button>
        <p class="eamx-matches-panel__bulk-hint">Marcar = guardar en tu cola. La extensión NO postula sola — tú abres cada vacante y le das clic al botón Postular cuando quieras.</p>
      </div>
    `;

    matchesPanelEl.addEventListener("click", onMatchesPanelClick);
    document.documentElement.appendChild(matchesPanelEl);
    requestAnimationFrame(() => matchesPanelEl?.classList.add("eamx-matches-panel--open"));

    // Escape key closes the panel.
    matchesEscHandler = (ev) => {
      if (ev.key === "Escape" || ev.key === "Esc") {
        ev.stopPropagation();
        closeMatchesPanel();
      }
    };
    document.addEventListener("keydown", matchesEscHandler, true);

    // Subscribe to queue changes so external "Quitar" actions update the
    // per-item buttons immediately.
    try {
      if (chrome?.storage?.onChanged) {
        matchesQueueListener = (changes, area) => {
          if (area !== "local") return;
          if (changes && changes["eamx:queue"]) {
            repaintMarkButtons();
          }
        };
        chrome.storage.onChanged.addListener(matchesQueueListener);
      }
    } catch (_) {}

    // Heavy work: load deps, profile, score cards.
    await renderMatchesPanelContent();
  }

  function closeMatchesPanel() {
    if (!matchesPanelEl) return;
    try {
      if (matchesQueueListener && chrome?.storage?.onChanged) {
        chrome.storage.onChanged.removeListener(matchesQueueListener);
      }
    } catch (_) {}
    matchesQueueListener = null;
    if (matchesEscHandler) {
      try { document.removeEventListener("keydown", matchesEscHandler, true); } catch (_) {}
      matchesEscHandler = null;
    }
    matchesCurrentTopN = [];
    // Keep widerSearchPool alive across user-initiated close → reopen so
    // they don't lose their accumulated multi-page sweep just by closing
    // the panel. The pool is dropped explicitly when the user navigates
    // OUT of the listing — see watchUrlChanges.
    try { matchesPanelEl.classList.remove("eamx-matches-panel--open"); } catch (_) {}
    const node = matchesPanelEl;
    matchesPanelEl = null;
    let prefersReduced = false;
    try {
      prefersReduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_) {}
    const remove = () => { try { node.remove(); } catch (_) {} };
    if (prefersReduced) remove();
    else setTimeout(remove, 240);
  }

  function onMatchesPanelClick(ev) {
    const closeBtn = ev.target.closest(".eamx-matches-panel__close");
    if (closeBtn) {
      ev.preventDefault();
      closeMatchesPanel();
      return;
    }
    const action = ev.target.closest("[data-action]");
    if (!action) return;
    const what = action.getAttribute("data-action");
    if (what === "mark") {
      ev.preventDefault();
      ev.stopPropagation();
      const id = action.getAttribute("data-id");
      onMatchesMarkClick(action, id);
      return;
    }
    if (what === "mark-top-5") {
      ev.preventDefault();
      onMatchesMarkTop5(action);
      return;
    }
    if (what === "open-options") {
      ev.preventDefault();
      try { chrome.runtime.openOptionsPage(); } catch (_) { openOptionsPage(); }
      return;
    }
    if (what === "rescan") {
      ev.preventDefault();
      renderMatchesPanelContent();
      return;
    }
    if (what === "go-vacantes") {
      // Take the user to Computrabajo's main listing where the matches
      // panel can find cards. Hard-navigate so the listing loads fresh.
      ev.preventDefault();
      try { closeMatchesPanel(); } catch (_) {}
      try { location.href = "https://www.computrabajo.com.mx/ofertas-de-trabajo/"; } catch (_) {}
      return;
    }
    if (what === "wider-search") {
      ev.preventDefault();
      onMatchesWiderSearch(action);
      return;
    }
    if (what === "open-preferences") {
      ev.preventDefault();
      try {
        const url = chrome.runtime.getURL("options/options.html") + "#preferences";
        window.open(url, "_blank", "noopener");
      } catch (_) {
        try { chrome.runtime.openOptionsPage(); } catch (_) { openOptionsPage(); }
      }
      return;
    }
    // "open" / "quick-apply" links are real <a target="_blank"> — let the
    // browser handle them.
  }

  // =========================================================================
  // Wider-search loop — page through Computrabajo's ?p=N pagination,
  // accumulating jobLites + scores into a cumulative pool.
  // =========================================================================
  // Computrabajo paginates via real URL changes (?p=2, ?p=3, …) which
  // unmount the page DOM, so we can't keep the panel alive across the
  // navigation. Strategy:
  //   1. Snapshot the current page's cards into pool[id].
  //   2. Persist pool (+ a "wider-search session" marker) to
  //      chrome.storage.session, keyed by listing path so a stray nav
  //      doesn't trip the loop.
  //   3. Bump ?p=N+1 and let the page reload.
  //   4. On boot, the listing handler checks the marker and resumes — it
  //      reads the stored pool, snapshots THIS page's cards, decides
  //      whether to bump again or finalize.
  // For v1 we keep it simpler: a single same-page "snapshot then nav" loop
  // up to MAX_PAGES, similar to lapieza but URL-based.

  // Snapshot the live cards on the current page into a [{ jobLite, score,
  // reasons, level }] array. Used by wider-search to build a cumulative pool.
  function snapshotCurrentCardsAsPoolEntries() {
    let cards;
    try { cards = findAllVacancyCards() || []; } catch (_) { cards = []; }
    const out = [];
    const effectivePrefs = (matchScoreModule && typeof matchScoreModule.effectivePreferences === "function")
      ? matchScoreModule.effectivePreferences(cachedPreferences, cachedProfile)
      : cachedPreferences;
    for (const { anchor, card } of cards) {
      const jobLite = extractJobLiteFromCard(card, anchor);
      if (!jobLite || !jobLite.id) continue;
      let score = 0, reasons = [], level = "unknown";
      try {
        if (matchScoreModule && cachedProfile) {
          const r = matchScoreModule.computeMatchScore(cachedProfile, jobLite, effectivePrefs);
          score = r.score;
          reasons = r.reasons || [];
          level = matchScoreModule.levelForScore(score);
        }
      } catch (_) { /* leave defaults */ }
      out.push({ jobLite, score, reasons, level });
    }
    return out;
  }

  // Find Computrabajo's "Siguiente" pagination link. Computrabajo renders a
  // standard <a> tag with rel="next" or text content "Siguiente"/"Next".
  // Returns the href (string) or null. We don't return the element itself
  // because the wider-search loop fetches the next page's HTML rather than
  // navigating — see onMatchesWiderSearch.
  function findComputrabajoNextPageHref() {
    // Prefer rel="next" — most semantic + stable.
    try {
      const linkRel = document.querySelector('a[rel="next"], link[rel="next"]');
      if (linkRel && linkRel.getAttribute("href")) return linkRel.getAttribute("href");
    } catch (_) {}
    // Fallback: explicit "Siguiente" / "Next" text on a paginator anchor.
    const candidates = document.querySelectorAll(
      'a[href*="?p="], a[href*="&p="], nav a, .pagination a, [class*="paginat" i] a'
    );
    const rx = /siguiente|next|→|>>/i;
    for (const a of candidates) {
      if (rx.test((a.textContent || "").trim())) {
        const href = a.getAttribute("href");
        if (href) return href;
      }
    }
    // Last resort: build ?p=N+1 from the current URL.
    try {
      const u = new URL(location.href);
      const p = parseInt(u.searchParams.get("p") || "1", 10);
      if (Number.isFinite(p) && p < 50) {
        u.searchParams.set("p", String(p + 1));
        return u.toString();
      }
    } catch (_) {}
    return null;
  }

  /**
   * Wider-search loop — fetch subsequent listing pages via fetch() (not
   * navigation, so the panel stays open), parse them in a temp DOM, score
   * cards, accumulate.
   *
   * Why fetch + DOMParser instead of clicking next: Computrabajo's pagination
   * unmounts the page DOM, which would close our panel and lose the user's
   * scroll position. Fetching the next page's HTML server-side keeps the
   * current page intact and is behaviorally equivalent to a normal user
   * paginating (same User-Agent, same cookies — fetch() inherits them).
   *
   * Caps: 7 pages × ~15 vacantes/page ≈ 100 candidates. Inter-page delay of
   * 500ms keeps us off any "too fast" detection.
   */
  async function onMatchesWiderSearch(btn) {
    if (!btn || btn.disabled) return;
    const original = btn.textContent;
    btn.disabled = true;
    const MAX_PAGES = 7;
    const POOL_CAP = 100;
    const INTER_PAGE_DELAY_MS = 500;

    // Cumulative pool keyed by jobLite.id. Survives page-boundary fetches.
    const pool = new Map();
    // Seed with the live page's cards.
    for (const entry of snapshotCurrentCardsAsPoolEntries()) {
      pool.set(entry.jobLite.id, entry);
    }
    let stallStreak = 0;
    let nextHref = findComputrabajoNextPageHref();
    try {
      for (let page = 2; page <= MAX_PAGES; page++) {
        if (pool.size >= POOL_CAP) break;
        if (!nextHref) break;
        btn.textContent = `Página ${page}/${MAX_PAGES} · ${pool.size} vacantes`;
        // Resolve relative URLs against the current origin.
        let absoluteHref;
        try { absoluteHref = new URL(nextHref, location.href).toString(); }
        catch (_) { break; }
        // Defensive: only fetch URLs on the same origin so we don't leak
        // anything cross-site.
        if (!absoluteHref.startsWith(location.origin)) break;

        let pageHtml = "";
        try {
          const res = await fetch(absoluteHref, {
            credentials: "include",
            redirect: "follow",
            headers: { Accept: "text/html" }
          });
          if (!res.ok) break;
          pageHtml = await res.text();
        } catch (err) {
          console.warn("[EmpleoAutomatico] wider-search fetch failed", err);
          break;
        }

        // Parse the HTML in a detached document so we don't run any of the
        // remote page's scripts.
        let doc;
        try { doc = new DOMParser().parseFromString(pageHtml, "text/html"); }
        catch (_) { break; }
        if (!doc) break;

        const newEntries = snapshotPoolEntriesFromDoc(doc);
        const before = pool.size;
        for (const entry of newEntries) {
          pool.set(entry.jobLite.id, entry);
          if (pool.size >= POOL_CAP) break;
        }
        const grew = pool.size > before;
        if (!grew) {
          stallStreak++;
          if (stallStreak >= 2) break;
        } else {
          stallStreak = 0;
        }

        // Find the next page's "Siguiente" link from the freshly fetched doc.
        nextHref = findNextHrefFromDoc(doc) || null;
        if (!nextHref) break;
        await new Promise((r) => setTimeout(r, INTER_PAGE_DELAY_MS));
      }
      widerSearchPool = pool;
      await renderMatchesPanelContent();
      const best = matchesCurrentTopN[0]?.score ?? 0;
      toast(
        `Análisis ampliado: ${pool.size} vacantes consideradas, mejor match ${best}%`,
        "success",
        { durationMs: 4500 }
      );
    } catch (err) {
      console.warn("[EmpleoAutomatico] wider search failed", err);
      toast("No se pudo ampliar la búsqueda. Intenta de nuevo.", "error");
    } finally {
      btn.disabled = false;
      btn.textContent = original || "🔍 Buscar más amplio";
    }
  }

  // Snapshot pool entries from a fetched-and-parsed Document (different from
  // snapshotCurrentCardsAsPoolEntries, which scans the live page). We can't
  // use findAllVacancyCards directly because it queries `document` — instead
  // we replicate the anchor scan against the fetched doc.
  function snapshotPoolEntriesFromDoc(doc) {
    const seenAnchor = new WeakSet();
    const anchors = [];
    const fastSelectors = [
      'article.box_offer a[href]',
      'article.iO a[href]',
      'article[class*="offer" i] a[href]',
      '[class*="box_offer" i] a[href]',
      'article h2 a[href]',
      'a[href*="/oferta-de-trabajo-de-"]'
    ];
    for (const sel of fastSelectors) {
      try {
        doc.querySelectorAll(sel).forEach((a) => {
          if (!seenAnchor.has(a) && VACANCY_ANCHOR_RX.test(a.getAttribute("href") || "")) {
            seenAnchor.add(a);
            anchors.push(a);
          }
        });
      } catch (_) {}
    }
    doc.querySelectorAll("a[href]").forEach((a) => {
      if (seenAnchor.has(a)) return;
      if (VACANCY_ANCHOR_RX.test(a.getAttribute("href") || "")) {
        seenAnchor.add(a);
        anchors.push(a);
      }
    });

    const out = [];
    const effectivePrefs = (matchScoreModule && typeof matchScoreModule.effectivePreferences === "function")
      ? matchScoreModule.effectivePreferences(cachedPreferences, cachedProfile)
      : cachedPreferences;
    const seenCard = new WeakSet();
    for (const a of anchors) {
      // Walk up to the card root in the fetched doc — same heuristic as the
      // live findCardRoot, but we can't use getComputedStyle on detached nodes.
      let card = null;
      let p = a.parentElement;
      let depth = 0;
      while (p && depth < 8) {
        const hasH = !!p.querySelector("h1, h2, h3, h4, [class*='title' i]");
        if (hasH) { card = p; break; }
        p = p.parentElement;
        depth++;
      }
      card = card || a;
      if (seenCard.has(card)) continue;
      seenCard.add(card);

      // Inline a lightweight version of extractJobLiteFromCard. We can't
      // resolve href relative to a detached doc the same way, so use the
      // anchor's getAttribute("href") + a base URL of location.
      const titleEl = card.querySelector("h1, h2, h3, h4, [class*='title' i] strong, [class*='title' i]");
      let title = titleEl ? cleanText(titleEl.textContent) : cleanText(a.textContent);
      const companyEl = card.querySelector(
        "[class*='empresa' i], [class*='company' i], [class*='employer' i], a.it-blank, .it-blank"
      );
      let company = companyEl ? cleanText(companyEl.textContent) : "";
      const locationEl = card.querySelector(
        "[class*='location' i], [class*='ubicacion' i], [class*='ciudad' i], p[class*='loc' i], address"
      );
      const loc = locationEl ? cleanText(locationEl.textContent) : "";
      let url;
      try { url = new URL(a.getAttribute("href") || "", location.href).toString(); }
      catch (_) { url = a.getAttribute("href") || ""; }
      const id = idFromUrl(url);
      const jobLite = {
        id,
        url,
        title: title || "(sin título)",
        company: company || "(empresa)",
        location: loc || ""
      };
      let score = 0, reasons = [], level = "unknown";
      try {
        if (matchScoreModule && cachedProfile) {
          const r = matchScoreModule.computeMatchScore(cachedProfile, jobLite, effectivePrefs);
          score = r.score;
          reasons = r.reasons || [];
          level = matchScoreModule.levelForScore(score);
        }
      } catch (_) {}
      out.push({ jobLite, score, reasons, level });
    }
    return out;
  }

  // Find the "Siguiente" link from a parsed document — same heuristic as
  // findComputrabajoNextPageHref but operates on a passed-in Document.
  function findNextHrefFromDoc(doc) {
    try {
      const linkRel = doc.querySelector('a[rel="next"], link[rel="next"]');
      if (linkRel && linkRel.getAttribute("href")) return linkRel.getAttribute("href");
    } catch (_) {}
    const candidates = doc.querySelectorAll(
      'a[href*="?p="], a[href*="&p="], nav a, .pagination a, [class*="paginat" i] a'
    );
    const rx = /siguiente|next|→|>>/i;
    for (const a of candidates) {
      if (rx.test((a.textContent || "").trim())) {
        const href = a.getAttribute("href");
        if (href) return href;
      }
    }
    return null;
  }

  // Render the content area. Idempotent — can be called repeatedly (e.g.
  // after the user uploads their CV in another tab, or preferences change).
  async function renderMatchesPanelContent() {
    if (!matchesPanelEl) return;
    const host = matchesPanelEl.querySelector("[data-eamx-matches-content]");
    const bulk = matchesPanelEl.querySelector("[data-eamx-matches-bulk]");
    if (!host) return;

    const ok = await ensureDiscoveryDeps();
    const loaders = [];
    if (!profileLoaded) loaders.push(loadProfileOnce());
    if (!preferencesLoaded) loaders.push(loadPreferencesOnce());
    if (loaders.length) await Promise.all(loaders);

    // Empty state #1 — no profile uploaded.
    if (!cachedProfile) {
      host.innerHTML = `
        <div class="eamx-matches-empty">
          <div class="eamx-matches-empty__icon" aria-hidden="true">📄</div>
          <h3>Sube tu CV primero</h3>
          <p>Para rankear las vacantes según tu perfil, necesito leer tu CV (lo hago localmente — Gemini sólo recibe el extracto).</p>
          <button type="button" class="eamx-matches-empty__cta" data-action="open-options">Abrir Opciones →</button>
        </div>
      `;
      if (bulk) bulk.hidden = true;
      console.log("[EmpleoAutomatico] best matches panel opened: 0 matches (no profile)");
      return;
    }

    // Find every visible card. Capped at 100 — past that the panel becomes
    // memory-heavy and the user can't really compare so many anyway.
    let cards = [];
    try { cards = findAllVacancyCards() || []; } catch (err) {
      console.warn("[EmpleoAutomatico] findAllVacancyCards threw", err);
      cards = [];
    }
    if (cards.length > 100) cards = cards.slice(0, 100);

    // Empty state #2 — no cards detected.
    if (!cards.length && !(widerSearchPool && widerSearchPool.size)) {
      const onListingAlready = LISTING_PATH_RX.some((rx) => rx.test(location.pathname || ""));
      const headline = onListingAlready ? "No detecté vacantes" : "Estás en una página sin vacantes";
      const body = onListingAlready
        ? "No encontré cards de vacantes aquí. Si crees que es un bug, dame screenshot."
        : "Para ver tus mejores matches, abre el listado de Computrabajo. Te llevo:";
      const ctaText = onListingAlready ? "Volver a escanear" : "Ir a Vacantes →";
      const ctaAction = onListingAlready ? "rescan" : "go-vacantes";
      host.innerHTML = `
        <div class="eamx-matches-empty">
          <div class="eamx-matches-empty__icon" aria-hidden="true">🔍</div>
          <h3>${headline}</h3>
          <p>${body}</p>
          <button type="button" class="eamx-matches-empty__cta" data-action="${ctaAction}">${ctaText}</button>
        </div>
      `;
      if (bulk) bulk.hidden = true;
      console.log("[EmpleoAutomatico] best matches panel opened: 0 matches (no cards)");
      return;
    }

    const effectivePrefs = (matchScoreModule && typeof matchScoreModule.effectivePreferences === "function")
      ? matchScoreModule.effectivePreferences(cachedPreferences, cachedProfile)
      : cachedPreferences;

    // Build the scored set. Two paths:
    //   A) widerSearchPool present → use accumulated cumulative pool.
    //   B) Otherwise → score the live cards on screen.
    let scored;
    if (widerSearchPool && widerSearchPool.size) {
      scored = Array.from(widerSearchPool.values()).map((entry) => {
        let score = entry.score, reasons = entry.reasons || [], level = entry.level || "unknown";
        try {
          if (matchScoreModule) {
            const r = matchScoreModule.computeMatchScore(cachedProfile, entry.jobLite, effectivePrefs);
            score = r.score;
            reasons = r.reasons || [];
            level = matchScoreModule.levelForScore(score);
          }
        } catch (_) { /* keep entry defaults */ }
        return { jobLite: entry.jobLite, anchor: null, card: null, score, reasons, level };
      });
    } else {
      scored = cards.map(({ anchor, card }) => {
        const jobLite = extractJobLiteFromCard(card, anchor);
        let score = 0, reasons = [], level = "unknown";
        try {
          if (matchScoreModule) {
            const r = matchScoreModule.computeMatchScore(cachedProfile, jobLite, effectivePrefs);
            score = r.score;
            reasons = r.reasons || [];
            level = matchScoreModule.levelForScore(score);
          }
        } catch (_) { /* keep defaults */ }
        return { jobLite, anchor, card, score, reasons, level };
      });
    }

    scored.sort((a, b) => (b.score - a.score) || 0);
    const topN = scored.slice(0, 25);
    matchesCurrentTopN = topN;

    const lowFitNote = topN.every((m) => m.score < 30)
      ? `<div class="eamx-matches-panel__note">Pocas vacantes en esta página coinciden con tu perfil. Prueba con otros filtros o con palabras clave.</div>`
      : "";

    const bestScore = topN[0]?.score ?? 0;
    const avgScore = Math.round(
      topN.reduce((sum, m) => sum + (m.score || 0), 0) / Math.max(1, topN.length)
    );
    const bestLevel = topN[0]?.level || "unknown";

    const prefsForUi = effectivePrefs || cachedPreferences;
    const prefsIcons = [];
    if (prefsForUi?.city) prefsIcons.push("📍");
    if (prefsForUi?.modality && prefsForUi.modality !== "any") prefsIcons.push("🏠");
    if (Number.isFinite(prefsForUi?.salaryMin) || Number.isFinite(prefsForUi?.salaryMax)) prefsIcons.push("💰");
    const filtersValue = prefsIcons.length
      ? prefsIcons.join(" ")
      : `<span class="eamx-matches-panel__stat-value--muted">Sin filtros</span>`;
    const filtersTitle = prefsIcons.length
      ? "Click para editar tus preferencias"
      : "Click para configurar ciudad, modalidad y salario";
    const viewsCount = (widerSearchPool && widerSearchPool.size) || cards.length;
    const stats = `
      <div class="eamx-matches-panel__stats eamx-matches-panel__stats--four">
        <div class="eamx-matches-panel__stat">
          <span class="eamx-matches-panel__stat-label">Mejor</span>
          <span class="eamx-matches-panel__stat-value eamx-matches-panel__stat-value--${bestLevel}">${bestScore}%</span>
        </div>
        <div class="eamx-matches-panel__stat">
          <span class="eamx-matches-panel__stat-label">Promedio</span>
          <span class="eamx-matches-panel__stat-value">${avgScore}%</span>
        </div>
        <div class="eamx-matches-panel__stat">
          <span class="eamx-matches-panel__stat-label">Vistas</span>
          <span class="eamx-matches-panel__stat-value">${viewsCount}</span>
        </div>
        <button type="button" class="eamx-matches-panel__stat eamx-matches-panel__stat--clickable" data-action="open-preferences" title="${escapeHtml(filtersTitle)}">
          <span class="eamx-matches-panel__stat-label">Filtros</span>
          <span class="eamx-matches-panel__stat-value">${filtersValue}</span>
        </button>
      </div>
    `;

    const topItem = topN[0];
    const topReasons = topItem
      ? (Array.isArray(topItem.reasons) ? topItem.reasons : []).slice(0, 2)
      : [];
    const topReasonsLine = topReasons.length
      ? `<div class="eamx-matches-panel__top1-reasons">✓ ${topReasons.map(escapeHtml).join(" · ")}</div>`
      : "";
    const top1Banner = topItem
      ? `
        <div class="eamx-matches-panel__top1">
          <div class="eamx-matches-panel__top1-badge">🏆 Mejor match en esta página</div>
          <div class="eamx-matches-panel__top1-title">${escapeHtml(topItem.jobLite.title || "(sin título)")}</div>
          <div class="eamx-matches-panel__top1-company">${escapeHtml(topItem.jobLite.company || "")}</div>
          ${topReasonsLine}
          <div class="eamx-matches-panel__top1-actions">
            <a href="${encodeURI(topItem.jobLite.url || "#")}" target="_blank" rel="noopener" class="eamx-matches-panel__top1-cta">Abrir mejor vacante →</a>
          </div>
        </div>
      `
      : "";
    const list = topN.map((m, i) => renderMatchItem(m, i + 1)).join("");
    const footer = cards.length < 5 && !(widerSearchPool && widerSearchPool.size)
      ? `<p class="eamx-matches-panel__hint">Scroll para más vacantes.</p>`
      : "";
    host.innerHTML = `${stats}${top1Banner}${lowFitNote}<ol class="eamx-matches-list">${list}</ol>${footer}`;

    // Resolve initial marked state for each row asynchronously.
    if (queueModule) {
      try {
        const queue = await queueModule.getQueue();
        const queueIds = new Set((queue || []).map((q) => `${q.source}::${q.id}`));
        topN.forEach((m) => {
          const btn = matchesPanelEl?.querySelector(`button[data-action="mark"][data-id="${cssEscape(m.jobLite.id)}"]`);
          if (btn) paintMarkButton(btn, queueIds.has(`${SOURCE}::${m.jobLite.id}`));
        });
      } catch (_) { /* leave optimistic state */ }
    }

    if (bulk) bulk.hidden = false;

    // Show "Buscar más amplio" once we have enough cards visible to justify
    // a wider sweep. Hide < 5 cards (user should fix filters first) and
    // hide once we hit the 100-card pool ceiling.
    const loadMore = matchesPanelEl?.querySelector("[data-eamx-matches-loadmore]");
    if (loadMore) {
      const effective = Math.max(
        cards.length,
        (widerSearchPool && widerSearchPool.size) || 0
      );
      loadMore.hidden = effective < 5 || effective >= 100;
    }

    console.log(`[EmpleoAutomatico] best matches panel opened: ${topN.length} matches`);
  }

  // Build a single <li> for the matches list. Mirrors lapieza's renderMatchItem
  // structure: rank circle, score badge + title, company line, location row,
  // reasons list, then the Marcar + ⚡ Postular action row.
  function renderMatchItem(match, rank) {
    const { jobLite, score, reasons, level } = match;
    const badgeLevel = level || "unknown";
    const safeTitle = escapeHtml(jobLite.title || "(sin título)");
    const safeCompany = escapeHtml(jobLite.company || "(empresa)");
    const safeLoc = jobLite.location ? escapeHtml(jobLite.location) : "";
    const safeUrl = encodeURI(jobLite.url || "#");
    const safeId = escapeHtml(jobLite.id || "");
    const reasonItems = (Array.isArray(reasons) ? reasons : [])
      .slice(0, 3)
      .map((r) => `<li>✓ ${escapeHtml(r)}</li>`)
      .join("");
    const reasonsBlock = reasonItems
      ? `<ul class="eamx-match-item__reasons">${reasonItems}</ul>`
      : "";
    // Location row — shown ONLY when we have one. Empresa always renders;
    // location goes on its own line with a 📍 marker so it's scannable.
    const locRow = safeLoc
      ? `<div class="eamx-match-item__location"><span aria-hidden="true">📍</span><span>${safeLoc}</span></div>`
      : "";
    return `
      <li class="eamx-match-item">
        <div class="eamx-match-item__rank" aria-hidden="true">${rank}</div>
        <div class="eamx-match-item__body">
          <div class="eamx-match-item__head">
            <span class="eamx-match-item__score eamx-match-item__score--${badgeLevel}">${score}%</span>
            <span class="eamx-match-item__title">${safeTitle}</span>
          </div>
          <div class="eamx-match-item__company">${safeCompany}</div>
          ${locRow}
          ${reasonsBlock}
          <div class="eamx-match-item__actions">
            <button type="button" data-action="mark" data-id="${safeId}" class="eamx-match-item__mark" aria-pressed="false">
              <span aria-hidden="true">⭐</span><span>Marcar</span>
            </button>
            <a data-action="quick-apply" href="${safeUrl}" target="_blank" rel="noopener" class="eamx-match-item__apply" data-job-id="${safeId}">⚡ Postular →</a>
          </div>
        </div>
      </li>
    `;
  }

  // Click on a per-item Marcar/Marcada button. Toggle behavior.
  async function onMatchesMarkClick(btn, id) {
    if (!btn || !id) return;
    const match = matchesCurrentTopN.find((m) => m.jobLite.id === id);
    if (!match) {
      const link = btn.parentElement?.querySelector('a[data-action="quick-apply"], a[data-action="open"]');
      if (link) {
        toast("Esta vacante ya no está visible. Abriéndola en nueva pestaña.", "info");
        try { window.open(link.href, "_blank", "noopener"); } catch (_) {}
      }
      return;
    }
    const ok = await ensureDiscoveryDeps();
    if (!ok || !queueModule) {
      toast("No se pudo abrir la cola.", "error");
      return;
    }
    btn.disabled = true;
    try {
      const already = await queueModule.isInQueue(match.jobLite.id, SOURCE);
      if (already) {
        await queueModule.removeFromQueue(match.jobLite.id, SOURCE);
        paintMarkButton(btn, false);
        toast("Quitada de tu cola.", "info", { durationMs: 2500 });
      } else {
        const item = {
          id: match.jobLite.id,
          source: SOURCE,
          url: match.jobLite.url,
          title: match.jobLite.title,
          company: match.jobLite.company,
          location: match.jobLite.location,
          savedAt: Date.now(),
          matchScore: Number(match.score) || 0,
          reasons: Array.isArray(match.reasons) ? match.reasons.slice(0, 3) : []
        };
        const { added } = await queueModule.addToQueue(item);
        if (added) {
          paintMarkButton(btn, true);
          toast("Agregada a tu cola.", "success", { durationMs: 2500 });
        }
      }
    } catch (err) {
      console.warn("[EmpleoAutomatico] matches mark toggle failed", err);
      toast("No se pudo guardar en la cola.", "error");
    } finally {
      btn.disabled = false;
    }
  }

  // Bulk action: add the top 5 to the queue. Reports partial success.
  async function onMatchesMarkTop5(bulkBtn) {
    if (!bulkBtn) return;
    const ok = await ensureDiscoveryDeps();
    if (!ok || !queueModule) {
      toast("No se pudo abrir la cola.", "error");
      return;
    }
    const top5 = matchesCurrentTopN.slice(0, 5);
    if (!top5.length) {
      toast("No hay vacantes para marcar.", "info");
      return;
    }
    bulkBtn.disabled = true;
    const original = bulkBtn.innerHTML;
    bulkBtn.innerHTML = '<span aria-hidden="true">⏳</span> Marcando…';

    let added = 0, already = 0, failed = 0;
    for (const m of top5) {
      try {
        const inQueue = await queueModule.isInQueue(m.jobLite.id, SOURCE);
        if (inQueue) { already++; continue; }
        const { added: ok2 } = await queueModule.addToQueue({
          id: m.jobLite.id,
          source: SOURCE,
          url: m.jobLite.url,
          title: m.jobLite.title,
          company: m.jobLite.company,
          location: m.jobLite.location,
          savedAt: Date.now(),
          matchScore: Number(m.score) || 0,
          reasons: Array.isArray(m.reasons) ? m.reasons.slice(0, 3) : []
        });
        if (ok2) added++;
        else failed++;
      } catch (err) {
        console.warn("[EmpleoAutomatico] mark-top-5 partial fail", err);
        failed++;
      }
    }

    bulkBtn.disabled = false;
    bulkBtn.innerHTML = original;

    repaintMarkButtons();

    const total = top5.length;
    if (failed === 0 && added + already === total) {
      const msg = already
        ? `${added} agregadas (${already} ya estaban en tu cola).`
        : `${added} vacantes agregadas a tu cola.`;
      toast(msg || "Listo.", "success", { durationMs: 3500 });
    } else if (added > 0) {
      toast(`${added} de ${total} agregadas.`, "info", { durationMs: 3500 });
    } else {
      toast("No se pudo marcar ninguna. Inténtalo de nuevo.", "error");
    }
  }

  // Sync per-item buttons with the latest queue snapshot. Cheap — only
  // touches buttons currently in the panel.
  async function repaintMarkButtons() {
    if (!matchesPanelEl || !queueModule) return;
    let queue = [];
    try { queue = await queueModule.getQueue(); } catch (_) { return; }
    const set = new Set((queue || []).map((q) => `${q.source}::${q.id}`));
    matchesPanelEl.querySelectorAll('button[data-action="mark"][data-id]').forEach((btn) => {
      const id = btn.getAttribute("data-id");
      if (!id) return;
      paintMarkButton(btn, set.has(`${SOURCE}::${id}`));
    });
  }

  // CSS.escape polyfill for older Chromium content scripts.
  function cssEscape(value) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      try { return CSS.escape(value); } catch (_) {}
    }
    return String(value).replace(/["\\]/g, "\\$&");
  }

  // Minimal HTML escaper for innerHTML interpolation.
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // =========================================================================
  // SPA nav watching & bootstrap
  // =========================================================================

  function detectAndMount() {
    // FAB mounts on BOTH listing and vacancy routes (different labels).
    if (isJobDetailPage() || isListingPage()) {
      mountFab();
      paintFabLabel();
    } else {
      unmountFab();
      closePanel();
      closeMatchesPanel();
    }

    // Listing badges run on a separate axis from the FAB — only when on a
    // known listing path. Tear down when navigating away so we don't leak
    // overlays into other routes.
    if (isListingPage()) {
      ensureDiscoveryDeps().then(() => {
        Promise.all([loadProfileOnce(), loadPreferencesOnce()]).then(() => {
          scheduleListingScan(150);
          startListingObserver();
        });
      });
    } else {
      stopListingObserver();
    }
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
        const wasListing = LISTING_PATH_RX.some((rx) => rx.test(new URL(lastUrl, location.origin).pathname || ""));
        lastUrl = location.href;
        activeDraftId = null; lastDraft = null; lastJob = null;
        // Tear down listing overlays — they're tied to the previous route's
        // DOM. detectAndMount() below re-arms them if we're still on a
        // listing path.
        stopListingObserver();
        // Best-matches panel scope rules:
        //  - Computrabajo paginates listings via ?p=N (the URL changes but
        //    we stay on a listing). We want the panel + widerSearchPool to
        //    SURVIVE these intra-listing transitions.
        //  - Leaving the listing entirely (e.g. clicking into a detail
        //    page) drops both.
        if (!isListingPage()) {
          widerSearchPool = null;
          closeMatchesPanel();
        } else if (!wasListing) {
          // We just arrived on a listing from a non-listing route — drop
          // any stale pool from a previous session.
          widerSearchPool = null;
        }
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
      const want = isJobDetailPage() || isListingPage();
      const have = !!(fabEl && document.body.contains(fabEl));
      if (want && !have) mountFab();
      else if (!want && have) { widerSearchPool = null; unmountFab(); closePanel(); closeMatchesPanel(); }
      else if (want && have) {
        // Same page still wants the FAB, but the mode might have changed
        // (vacancy → listing via in-SPA nav). Repaint the label.
        paintFabLabel();
      }
    }, 600));
    mo.observe(document.body, { childList: true, subtree: true });
  }

  function boot() {
    try {
      // storage.onChanged listener — re-render listing badges + matches
      // panel when the user uploads a new CV / changes prefs / removes
      // from the queue in another tab.
      watchProfileChanges();
      detectAndMount();
      watchUrlChanges();
    } catch (err) { console.error("[EmpleoAutomatico]", err); }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
