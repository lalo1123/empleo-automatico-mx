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
  const BILLING_URL = "https://empleo.skybrandmx.com/account/billing";

  // TODO(dom): verify against real Indeed MX URLs. /viewjob is the canonical
  // detail page; /empleo/ is the slugged path-based variant; /m/ is mobile.
  const JOB_URL_PATTERNS = [
    /\/viewjob(\?|$|\/)/i,
    /[?&]jk=[A-Za-z0-9]+/i,
    /\/empleo\/[^/]+\/[^/]+/i,
    /\/m\/viewjob/i
  ];

  // Indeed listing URLs: /jobs?q=..., /q-...-jobs.html (legacy), /trabajo,
  // /empleos. The query-string variants (?q, ?l) are the canonical path on
  // mx.indeed.com. We're conservative — be liberal with detection because
  // findVacancyCards bails fast when no cards render.
  const LISTING_PATH_RX = [
    /^\/jobs\/?$/i,
    /^\/trabajo\/?$/i,
    /^\/empleos?\/?$/i,
    /^\/?$/  // home — Indeed sometimes shows recent jobs panel
  ];

  // Card href pattern: viewjob page (with jk=) is canonical. Any /viewjob
  // anchor with a jk= param is a vacancy card link.
  const VACANCY_ANCHOR_RX = /\/(?:viewjob|rc\/clk|empleo|company)/i;

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

  // ===== Discovery state (listing-page badges + best-matches panel) =====
  // Lazy-loaded modules — same MV3 pattern as schemas.js above.
  let matchScoreModule = null;
  let queueModule = null;
  // Profile + preferences cache; refreshed via chrome.storage.onChanged.
  let cachedProfile = null;
  let profileLoaded = false;
  const PREFERENCES_STORAGE_KEY = "eamx:preferences";
  let cachedPreferences = null;
  let preferencesLoaded = false;
  // Listing observer + scan throttle.
  let listingObserver = null;
  let listingScanTimer = null;
  let listingScanPending = false;
  let listingScanTrailing = false;
  // Best-matches panel state.
  let matchesPanelEl = null;
  let matchesEscHandler = null;
  let matchesQueueListener = null;
  let matchesScrollHandler = null;
  let matchesScrollDebounce = null;
  let matchesCurrentTopN = [];
  // Wider-search accumulator. Indeed paginates via ?start=N — like LaPieza,
  // a click-next REPLACES cards rather than appending, so we snapshot
  // jobLites + scores after each page and stash them keyed by id.
  let widerSearchPool = null;

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

  // Quick listing-path check used by Discovery (badges + matches panel).
  // Indeed listings live at /jobs?q=... (canonical), /trabajo, /empleos;
  // the home / sometimes also surfaces a "recent jobs" rail.
  function isListingPath() {
    const path = location.pathname || "";
    return LISTING_PATH_RX.some((re) => re.test(path));
  }

  // Loose "is this anything we should mount on" check — listing OR detail.
  function isListingPage() {
    if (isListingPath()) return true;
    // Filter pages like /jobs?q=marketing&l=CDMX. If we see vacancy cards,
    // treat it as a listing.
    try {
      if (typeof findVacancyCards === "function") {
        const cards = findVacancyCards();
        if (Array.isArray(cards) && cards.length >= 1) return true;
      }
    } catch (_) {}
    return false;
  }

  // Top-level FAB mode: which behavior the FAB should adopt right now.
  function fabMode() {
    if (isJobDetailPage() && !isListingPath()) return "vacancy";
    if (isListingPage()) return "listing";
    return "vacancy";
  }

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
    if (fabEl && document.body.contains(fabEl)) {
      // Already mounted — re-attach the listener (defense for SPA route
      // changes that don't unmount) and repaint the label so listing↔detail
      // transitions stay accurate.
      try { fabEl.removeEventListener("click", onFabClick); } catch (_) {}
      fabEl.addEventListener("click", onFabClick);
      paintFabLabel();
      return;
    }
    // Nuke any stale FAB from a previous content-script instance.
    try {
      const stale = document.querySelector(".eamx-fab");
      if (stale) stale.parentNode?.removeChild(stale);
    } catch (_) {}
    fabEl = document.createElement("button");
    fabEl.type = "button";
    fabEl.className = "eamx-fab";
    fabEl.innerHTML =
      '<span class="eamx-fab__icon" aria-hidden="true">✨</span>' +
      '<span class="eamx-fab__label">Postular con IA</span>';
    fabEl.addEventListener("click", onFabClick);
    document.body.appendChild(fabEl);
    paintFabLabel();
  }
  // Repaint the FAB icon/label based on the current route mode. Called
  // after mount and after every SPA URL change.
  function paintFabLabel() {
    if (!fabEl) return;
    const mode = fabMode();
    const icon = fabEl.querySelector(".eamx-fab__icon");
    const lbl = fabEl.querySelector(".eamx-fab__label");
    if (mode === "listing") {
      if (icon) icon.textContent = "🎯";
      if (lbl) lbl.textContent = "Mejores matches";
      fabEl.setAttribute("aria-label", "Ver mejores matches en esta página");
      fabEl.dataset.eamxFabMode = "listing";
    } else {
      if (icon) icon.textContent = "✨";
      if (lbl) lbl.textContent = "Postular con IA";
      fabEl.setAttribute("aria-label", "Postular con IA");
      fabEl.dataset.eamxFabMode = mode;
    }
  }
  function unmountFab() { fabEl?.parentNode?.removeChild(fabEl); fabEl = null; }
  function setFabBusy(b) {
    if (!fabEl) return;
    fabEl.classList.toggle("eamx-fab--busy", !!b);
    fabEl.disabled = !!b;
    const lbl = fabEl.querySelector(".eamx-fab__label");
    if (lbl) {
      if (b) lbl.textContent = "Generando";
      else paintFabLabel();
    }
  }

  async function onFabClick() {
    if (!fabEl || fabEl.disabled) return;
    // Listing branch: open the best-matches side panel. Read-only.
    if (fabMode() === "listing") return openBestMatchesPanel();
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

  // =========================================================================
  // Discovery: listing-page badges + best-matches panel
  // =========================================================================
  //
  // Ported from content/lapieza.js. Indeed-specific differences:
  //   - Card selectors: data-jk anchor (canonical), .tapItem, .cardOutline,
  //     [data-testid*='job-card'], [data-testid='slider_item']. Indeed's
  //     React deploys hash class names; data-jk is the single most stable
  //     hook.
  //   - jobLite.id → data-jk attribute (job key) when the card exposes it,
  //     else extracted from /viewjob?jk= URL.
  //   - Pagination: ?start=N (10/page). Conservative 1500ms inter-page
  //     delay because Indeed is more aggressive about bot detection than
  //     LaPieza.
  //   - Cap: 100 vacancies / 10 pages.
  //   - Active job in the side-panel rail is excluded (it's already on
  //     screen as the detail view) — we filter cards by visibility ratio.
  //
  // HITL contract preserved: Discovery is read-only. We never auto-click
  // any "Apply" / "Easy Apply" button (Modo Auto territory, out of scope).

  // ----- HTML helpers -----

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function cssEscape(value) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      try { return CSS.escape(value); } catch (_) {}
    }
    return String(value).replace(/["\\]/g, "\\$&");
  }
  function isInsideOurUI(el) {
    if (!el) return false;
    return !!el.closest(".eamx-matches-panel, .eamx-panel, .eamx-toast, .eamx-card-overlay");
  }

  // ----- Lazy module loaders -----

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
  // Watch for profile / preference / queue updates so listing badges and
  // matches panel stay live across tabs and Options writes.
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
          scheduleListingScan(50);
        }
      });
    } catch (_) {}
  }

  // ----- Card detection (Indeed) -----

  // Walk up from a vacancy anchor to its visual card root. Indeed uses
  // <a class="tapItem"> / <a data-jk> for the link; the card outline is
  // sometimes the anchor itself (when display:block) and sometimes a
  // wrapper (.cardOutline / [class*='resultContent']). We accept the
  // ancestor whose height fits a card-sized box AND contains at most one
  // vacancy anchor (otherwise we hit a multi-card grid).
  function findCardRoot(anchor) {
    if (!anchor) return null;
    const anchorRect = anchor.getBoundingClientRect();
    if (anchorRect.height >= 80 && anchorRect.height <= 600) return anchor;
    let p = anchor.parentElement;
    let depth = 0;
    while (p && depth < 6) {
      try {
        const cs = getComputedStyle(p);
        if (cs.display === "block" || cs.display === "flex" || cs.display === "grid") {
          const rect = p.getBoundingClientRect();
          const tall = rect.height > 80 && rect.height < 600;
          const hasH = !!p.querySelector("h1, h2, h3, h4, [class*='title' i], [data-testid*='title' i]");
          let cardCount = 0;
          try {
            cardCount = p.querySelectorAll("a[data-jk], a.tapItem, a[href*='/viewjob']").length;
          } catch (_) {}
          if (tall && hasH && cardCount <= 1) return p;
        }
      } catch (_) {}
      p = p.parentElement;
      depth++;
    }
    return anchor;
  }

  // The data-jk attribute is Indeed's canonical job id. Prefer that, then
  // the URL-based idFromUrl, then a hash fallback. The URL on listing
  // anchors is usually /rc/clk?...&jk=<key> or /viewjob?jk=<key>, and the
  // jk param is what /viewjob keys on for the same vacancy.
  function idFromCardUrl(url, anchor) {
    try {
      const dataJk = anchor?.getAttribute?.("data-jk");
      if (dataJk) return dataJk;
    } catch (_) {}
    return idFromUrl(url);
  }

  // Build a jobLite from a card. Cheap: only enough to score against.
  function extractJobLiteFromCard(card, anchor) {
    // Title — Indeed uses data-testid='jobTitle' and h2.jobTitle; legacy
    // class .resultContent has h2 with the title.
    let title = "";
    const titleEl = card.querySelector(
      "h2.jobTitle, [data-testid='jobTitle'], h2[class*='jobTitle' i] span, " +
      "h2 a[data-testid*='title' i] span, h1, h2, h3"
    );
    if (titleEl) title = cleanText(titleEl.textContent);
    if (!title) title = cleanText(anchor.textContent);

    // Company — Indeed: data-testid='company-name', .companyName,
    // [class*='companyName' i].
    let company = "";
    const companyEl = card.querySelector(
      "[data-testid='company-name'], .companyName, [class*='companyName' i], " +
      "[itemprop='hiringOrganization'], [class*='employerName' i]"
    );
    if (companyEl) company = cleanText(companyEl.textContent);

    // Location — data-testid='text-location', .companyLocation.
    let loc = "";
    const locEl = card.querySelector(
      "[data-testid='text-location'], [data-testid='job-location'], " +
      ".companyLocation, [class*='companyLocation' i], [class*='location' i]"
    );
    if (locEl) loc = cleanText(locEl.textContent);

    const url = anchor.href || "";
    const id = idFromCardUrl(url, anchor);
    return {
      id,
      url,
      title: title || "(sin título)",
      company: company || "(empresa)",
      location: loc || ""
    };
  }

  // Find every vacancy anchor that hasn't been overlaid yet.
  // Selector preference: data-jk (canonical) → tapItem (legacy listing) →
  // generic /viewjob hrefs (mosaic results).
  function findVacancyCards() {
    const seenAnchor = new WeakSet();
    const anchors = [];
    const skipOurs = (a) => isInsideOurUI(a);
    // Fast path: anchors with data-jk are 1-to-1 with Indeed vacancies.
    document.querySelectorAll("a[data-jk]").forEach((a) => {
      if (skipOurs(a)) return;
      if (!seenAnchor.has(a)) { seenAnchor.add(a); anchors.push(a); }
    });
    // Legacy: tapItem class.
    document.querySelectorAll("a.tapItem[href]").forEach((a) => {
      if (skipOurs(a)) return;
      if (!seenAnchor.has(a)) { seenAnchor.add(a); anchors.push(a); }
    });
    // Fallback: any <a> whose href looks like a vacancy URL.
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
      if (!card) continue;
      if (seenCard.has(card)) continue;
      seenCard.add(card);
      if (card.hasAttribute("data-eamx-card-overlay")) continue;
      out.push({ anchor: a, card });
    }
    return out;
  }

  // Same as findVacancyCards but without the overlay-stamp skip filter.
  // Used by the matches panel so it can score every visible card,
  // including those the inline overlay path has already badged.
  function findAllVacancyCards() {
    const seenAnchor = new WeakSet();
    const anchors = [];
    document.querySelectorAll("a[data-jk]").forEach((a) => {
      if (isInsideOurUI(a)) return;
      if (!seenAnchor.has(a)) { seenAnchor.add(a); anchors.push(a); }
    });
    document.querySelectorAll("a.tapItem[href]").forEach((a) => {
      if (isInsideOurUI(a)) return;
      if (!seenAnchor.has(a)) { seenAnchor.add(a); anchors.push(a); }
    });
    document.querySelectorAll("a[href]").forEach((a) => {
      if (seenAnchor.has(a)) return;
      if (isInsideOurUI(a)) return;
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

  // ----- Inline overlay (badge + Marcar) -----

  async function injectOverlay({ anchor, card }) {
    try {
      card.setAttribute("data-eamx-card-overlay", "1");
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
        toast("Quitada de tu cola.", "info");
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
          toast("⭐ Marcada. Revísala después en Opciones → Mi cola.", "success");
        }
      }
    } catch (err) {
      console.warn("[EmpleoAutomatico] queue toggle failed", err);
      toast("No se pudo guardar en la cola.", "error");
    } finally {
      btn.disabled = false;
    }
  }

  // ----- Listing scan + observer -----

  function scheduleListingScan(delayMs = 800) {
    if (listingScanPending) {
      listingScanTrailing = true;
      return;
    }
    listingScanPending = true;
    listingScanTimer = setTimeout(async () => {
      listingScanTimer = null;
      try {
        if (!isListingPath()) return;
        const ok = await ensureDiscoveryDeps();
        if (!ok) return;
        if (!profileLoaded) await loadProfileOnce();
        const cards = findVacancyCards();
        cards.forEach((c) => { injectOverlay(c); });
      } finally {
        listingScanPending = false;
        if (listingScanTrailing) {
          listingScanTrailing = false;
          // Trailing rescan to catch late hydration. 1000ms instead of 800ms
          // (LaPieza) — Indeed is React-heavy, more conservative spacing
          // helps us avoid being seen as bot-like by the observer.
          setTimeout(() => scheduleListingScan(0), 1000);
        }
      }
    }, delayMs);
  }
  function startListingObserver() {
    if (listingObserver) return;
    // 800ms throttle — Indeed re-renders heavily; we want to avoid firing
    // a scan on every micro-mutation. The trailing flag inside
    // scheduleListingScan picks up late-arriving cards.
    listingObserver = new MutationObserver(() => {
      if (!isListingPath()) return;
      scheduleListingScan(800);
    });
    try {
      listingObserver.observe(document.body, { childList: true, subtree: true });
    } catch (_) {}
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
    document.querySelectorAll("[data-eamx-overlay-host]").forEach((el) => {
      try { el.remove(); } catch (_) {}
    });
    document.querySelectorAll("[data-eamx-card-overlay]").forEach((el) => {
      try { el.removeAttribute("data-eamx-card-overlay"); } catch (_) {}
      try { el.classList.remove("eamx-card--poor"); } catch (_) {}
    });
  }

  // ----- Best-matches side panel -----

  async function openBestMatchesPanel() {
    if (matchesPanelEl && document.documentElement.contains(matchesPanelEl)) {
      try { matchesPanelEl.focus({ preventScroll: true }); } catch (_) {}
      return;
    }
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
        <p class="eamx-matches-panel__loadmore-hint">Carga hasta 100 vacantes de Indeed y te muestra las mejores según tus preferencias y CV.</p>
      </div>
      <div class="eamx-matches-panel__bulk" data-eamx-matches-bulk hidden>
        <button type="button" class="eamx-matches-panel__bulk-btn" data-action="mark-top-5">⭐ Marcar top 5 de un solo clic</button>
        <p class="eamx-matches-panel__bulk-hint">Marcar = guardar en tu cola. La extensión NO postula sola — tú abres cada vacante y le das clic al botón Postular cuando quieras.</p>
      </div>
    `;
    matchesPanelEl.addEventListener("click", onMatchesPanelClick);
    document.documentElement.appendChild(matchesPanelEl);
    requestAnimationFrame(() => matchesPanelEl?.classList.add("eamx-matches-panel--open"));

    matchesEscHandler = (ev) => {
      if (ev.key === "Escape" || ev.key === "Esc") {
        ev.stopPropagation();
        closeMatchesPanel();
      }
    };
    document.addEventListener("keydown", matchesEscHandler, true);
    try {
      if (chrome?.storage?.onChanged) {
        matchesQueueListener = (changes, area) => {
          if (area !== "local") return;
          if (changes && changes["eamx:queue"]) repaintMarkButtons();
        };
        chrome.storage.onChanged.addListener(matchesQueueListener);
      }
    } catch (_) {}

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
    if (matchesScrollHandler) {
      try { window.removeEventListener("scroll", matchesScrollHandler, true); } catch (_) {}
      matchesScrollHandler = null;
    }
    if (matchesScrollDebounce) { clearTimeout(matchesScrollDebounce); matchesScrollDebounce = null; }
    matchesCurrentTopN = [];
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
    if (closeBtn) { ev.preventDefault(); closeMatchesPanel(); return; }
    const action = ev.target.closest("[data-action]");
    if (!action) return;
    const what = action.getAttribute("data-action");
    if (what === "mark") {
      ev.preventDefault();
      ev.stopPropagation();
      onMatchesMarkClick(action, action.getAttribute("data-id"));
      return;
    }
    if (what === "mark-top-5") { ev.preventDefault(); onMatchesMarkTop5(action); return; }
    if (what === "open-options") {
      ev.preventDefault();
      try { chrome.runtime.openOptionsPage(); } catch (_) { openOptionsPage(); }
      return;
    }
    if (what === "rescan") { ev.preventDefault(); renderMatchesPanelContent(); return; }
    if (what === "go-jobs") {
      ev.preventDefault();
      try { closeMatchesPanel(); } catch (_) {}
      try { location.href = "https://mx.indeed.com/jobs"; } catch (_) {}
      return;
    }
    if (what === "wider-search") { ev.preventDefault(); onMatchesWiderSearch(action); return; }
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
    // "quick-apply" links — let the <a target="_blank"> open normally.
  }

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
      return;
    }

    let cards = [];
    try { cards = findAllVacancyCards() || []; } catch (err) {
      console.warn("[EmpleoAutomatico] findAllVacancyCards threw", err);
      cards = [];
    }
    if (cards.length > 100) cards = cards.slice(0, 100);

    if (!cards.length) {
      const onListingAlready = /^\/(?:jobs|trabajo|empleos?)/i.test(location.pathname);
      const headline = onListingAlready ? "No detecté vacantes" : "Estás en una página sin vacantes";
      const body = onListingAlready
        ? "No encontré cards de vacantes aquí. Si crees que es un bug, dame screenshot."
        : "Para ver tus mejores matches, abre el listado de Indeed. Te llevo:";
      const ctaText = onListingAlready ? "Volver a escanear" : "Ir a Empleos →";
      const ctaAction = onListingAlready ? "rescan" : "go-jobs";
      host.innerHTML = `
        <div class="eamx-matches-empty">
          <div class="eamx-matches-empty__icon" aria-hidden="true">🔍</div>
          <h3>${headline}</h3>
          <p>${body}</p>
          <button type="button" class="eamx-matches-empty__cta" data-action="${ctaAction}">${ctaText}</button>
        </div>
      `;
      if (bulk) bulk.hidden = true;
      return;
    }

    const effectivePrefs = (matchScoreModule && typeof matchScoreModule.effectivePreferences === "function")
      ? matchScoreModule.effectivePreferences(cachedPreferences, cachedProfile)
      : cachedPreferences;

    let scored;
    if (widerSearchPool && widerSearchPool.size) {
      scored = Array.from(widerSearchPool.values()).map((entry) => {
        let score = entry.score, reasons = entry.reasons || [], level = entry.level || "unknown";
        try {
          if (matchScoreModule) {
            const r = matchScoreModule.computeMatchScore(cachedProfile, entry.jobLite, effectivePrefs);
            score = r.score; reasons = r.reasons || []; level = matchScoreModule.levelForScore(score);
          }
        } catch (_) {}
        return { jobLite: entry.jobLite, anchor: null, card: null, score, reasons, level };
      });
    } else {
      scored = cards.map(({ anchor, card }) => {
        const jobLite = extractJobLiteFromCard(card, anchor);
        let score = 0, reasons = [], level = "unknown";
        try {
          if (matchScoreModule) {
            const r = matchScoreModule.computeMatchScore(cachedProfile, jobLite, effectivePrefs);
            score = r.score; reasons = r.reasons || []; level = matchScoreModule.levelForScore(score);
          }
        } catch (_) {}
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
    const avgScore = Math.round(topN.reduce((sum, m) => sum + (m.score || 0), 0) / Math.max(1, topN.length));
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
          <span class="eamx-matches-panel__stat-value">${cards.length}</span>
        </div>
        <button type="button" class="eamx-matches-panel__stat eamx-matches-panel__stat--clickable" data-action="open-preferences" title="${escapeHtml(filtersTitle)}">
          <span class="eamx-matches-panel__stat-label">Filtros</span>
          <span class="eamx-matches-panel__stat-value">${filtersValue}</span>
        </button>
      </div>
    `;
    const topItem = topN[0];
    const topReasons = topItem ? (Array.isArray(topItem.reasons) ? topItem.reasons : []).slice(0, 2) : [];
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
    const footer = cards.length < 5
      ? `<p class="eamx-matches-panel__hint">Scroll para más vacantes.</p>`
      : "";
    host.innerHTML = `${stats}${top1Banner}${lowFitNote}<ol class="eamx-matches-list">${list}</ol>${footer}`;

    if (queueModule) {
      try {
        const queue = await queueModule.getQueue();
        const queueIds = new Set((queue || []).map((q) => `${q.source}::${q.id}`));
        topN.forEach((m) => {
          const btn = matchesPanelEl?.querySelector(`button[data-action="mark"][data-id="${cssEscape(m.jobLite.id)}"]`);
          if (btn) paintMarkButton(btn, queueIds.has(`${SOURCE}::${m.jobLite.id}`));
        });
      } catch (_) {}
    }

    if (bulk) bulk.hidden = false;

    const loadMore = matchesPanelEl?.querySelector("[data-eamx-matches-loadmore]");
    if (loadMore) {
      const effective = Math.max(cards.length, (widerSearchPool && widerSearchPool.size) || 0);
      loadMore.hidden = effective < 5 || effective >= 100;
    }
  }

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

  async function onMatchesMarkClick(btn, id) {
    if (!btn || !id) return;
    const match = matchesCurrentTopN.find((m) => m.jobLite.id === id);
    if (!match) return;
    const ok = await ensureDiscoveryDeps();
    if (!ok || !queueModule) { toast("No se pudo abrir la cola.", "error"); return; }
    btn.disabled = true;
    try {
      const already = await queueModule.isInQueue(match.jobLite.id, SOURCE);
      if (already) {
        await queueModule.removeFromQueue(match.jobLite.id, SOURCE);
        paintMarkButton(btn, false);
        toast("Quitada de tu cola.", "info");
      } else {
        const item = {
          id: match.jobLite.id, source: SOURCE, url: match.jobLite.url,
          title: match.jobLite.title, company: match.jobLite.company,
          location: match.jobLite.location, savedAt: Date.now(),
          matchScore: Number(match.score) || 0,
          reasons: Array.isArray(match.reasons) ? match.reasons.slice(0, 3) : []
        };
        const { added } = await queueModule.addToQueue(item);
        if (added) { paintMarkButton(btn, true); toast("Agregada a tu cola.", "success"); }
      }
    } catch (err) {
      console.warn("[EmpleoAutomatico] matches mark toggle failed", err);
      toast("No se pudo guardar en la cola.", "error");
    } finally { btn.disabled = false; }
  }

  async function onMatchesMarkTop5(bulkBtn) {
    if (!bulkBtn) return;
    const ok = await ensureDiscoveryDeps();
    if (!ok || !queueModule) { toast("No se pudo abrir la cola.", "error"); return; }
    const top5 = matchesCurrentTopN.slice(0, 5);
    if (!top5.length) { toast("No hay vacantes para marcar.", "info"); return; }
    bulkBtn.disabled = true;
    const original = bulkBtn.innerHTML;
    bulkBtn.innerHTML = '<span aria-hidden="true">⏳</span> Marcando…';
    let added = 0, already = 0, failed = 0;
    for (const m of top5) {
      try {
        const inQueue = await queueModule.isInQueue(m.jobLite.id, SOURCE);
        if (inQueue) { already++; continue; }
        const { added: ok2 } = await queueModule.addToQueue({
          id: m.jobLite.id, source: SOURCE, url: m.jobLite.url,
          title: m.jobLite.title, company: m.jobLite.company,
          location: m.jobLite.location, savedAt: Date.now(),
          matchScore: Number(m.score) || 0,
          reasons: Array.isArray(m.reasons) ? m.reasons.slice(0, 3) : []
        });
        if (ok2) added++; else failed++;
      } catch (err) { console.warn("[EmpleoAutomatico] mark-top-5 partial fail", err); failed++; }
    }
    bulkBtn.disabled = false;
    bulkBtn.innerHTML = original;
    repaintMarkButtons();
    const total = top5.length;
    if (failed === 0 && added + already === total) {
      const msg = already
        ? `${added} agregadas (${already} ya estaban en tu cola).`
        : `${added} vacantes agregadas a tu cola.`;
      toast(msg || "Listo.", "success");
    } else if (added > 0) {
      toast(`${added} de ${total} agregadas.`, "info");
    } else {
      toast("No se pudo marcar ninguna. Inténtalo de nuevo.", "error");
    }
  }

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

  // ----- Wider-search (?start=N pagination) -----

  // Snapshot the current page's cards into [{ jobLite, score, reasons, level }].
  // Used by the wider-search loop to build a cumulative pool because Indeed's
  // pagination REPLACES (not appends) cards on each page change.
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
          score = r.score; reasons = r.reasons || [];
          level = matchScoreModule.levelForScore(score);
        }
      } catch (_) {}
      out.push({ jobLite, score, reasons, level });
    }
    return out;
  }

  // Indeed pagination via ?start=N. Indeed's "next page" button has
  // aria-label="Next Page" or data-testid="pagination-page-next". We use
  // the URL approach (incrementing ?start by 10 each time) instead of
  // clicking — programmatic clicks are easier to detect as automation
  // than URL navigation. BUT we don't want to navigate: we want to keep
  // the matches panel open. So we click the next-button and let Indeed's
  // own SPA handle the URL change.
  function findIndeedNextPageButton() {
    const tries = [
      'a[data-testid="pagination-page-next"]',
      'a[aria-label="Next Page"]',
      'a[aria-label="Página siguiente"]',
      'button[aria-label="Next Page"]',
      'button[aria-label*="next" i]',
      'button[aria-label*="siguiente" i]',
      'nav[role="navigation"] a[rel="next"]'
    ];
    for (const sel of tries) {
      try {
        const el = document.querySelector(sel);
        if (el && !el.hasAttribute("disabled") && !el.classList.contains("disabled")) return el;
      } catch (_) {}
    }
    return null;
  }

  async function onMatchesWiderSearch(btn) {
    if (!btn || btn.disabled) return;
    const original = btn.textContent;
    btn.disabled = true;

    // CONSERVATIVE caps for Indeed (vs LaPieza's 14 pages × 700ms).
    // Indeed has aggressive bot detection; we cap at 10 pages and use
    // 1500ms+ between page loads to stay under Cloudflare's threshold.
    const MAX_PAGES = 10;
    const PER_PAGE_TIMEOUT_MS = 5000;   // Indeed React hydration is slower
    const POLL_INTERVAL_MS = 400;
    const INTER_PAGE_DELAY_MS = 1800;   // Conservative — well over the 1500ms floor

    const pool = new Map();
    for (const entry of snapshotCurrentCardsAsPoolEntries()) {
      pool.set(entry.jobLite.id, entry);
    }
    let stallStreak = 0;
    let lastFirstAnchorHref = "";
    try {
      for (let page = 1; page <= MAX_PAGES; page++) {
        // Cap by absolute pool size — once we hit 100 vacancies, stop.
        if (pool.size >= 100) break;
        btn.textContent = `Página ${page}/${MAX_PAGES} · ${pool.size} vacantes`;
        const nextBtn = findIndeedNextPageButton();
        if (!nextBtn) break;
        try {
          const firstAnchor = document.querySelector("a[data-jk]") || document.querySelector("a.tapItem[href]");
          lastFirstAnchorHref = firstAnchor?.getAttribute("href") || firstAnchor?.getAttribute("data-jk") || "";
        } catch (_) { lastFirstAnchorHref = ""; }
        try { nextBtn.click(); } catch (_) {}
        const polls = Math.max(1, Math.round(PER_PAGE_TIMEOUT_MS / POLL_INTERVAL_MS));
        let pageChanged = false;
        for (let p = 0; p < polls; p++) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          let firstNow = "";
          try {
            const a = document.querySelector("a[data-jk]") || document.querySelector("a.tapItem[href]");
            firstNow = a?.getAttribute("href") || a?.getAttribute("data-jk") || "";
          } catch (_) {}
          if (firstNow && firstNow !== lastFirstAnchorHref) { pageChanged = true; break; }
        }
        if (!pageChanged) {
          stallStreak++;
          if (stallStreak >= 2) break;
          continue;
        }
        stallStreak = 0;
        const before = pool.size;
        for (const entry of snapshotCurrentCardsAsPoolEntries()) {
          pool.set(entry.jobLite.id, entry);
        }
        const grew = pool.size > before;
        if (!grew) {
          stallStreak++;
          if (stallStreak >= 2) break;
        } else { stallStreak = 0; }
        // 1800ms — well over the 1500ms floor the spec requires.
        // Indeed's Cloudflare frontend treats < 1s click cadences as
        // bot-like; this puts us in the human-paced range.
        await new Promise((r) => setTimeout(r, INTER_PAGE_DELAY_MS));
      }
      widerSearchPool = pool;
      await renderMatchesPanelContent();
      const best = matchesCurrentTopN[0]?.score ?? 0;
      toast(`Análisis ampliado: ${pool.size} vacantes consideradas, mejor match ${best}%`, "success");
    } catch (err) {
      console.warn("[EmpleoAutomatico] wider search failed", err);
      toast("No se pudo ampliar la búsqueda. Intenta de nuevo.", "error");
    } finally {
      btn.disabled = false;
      btn.textContent = original || "🔍 Buscar más amplio";
    }
  }

  // ===== SPA nav watching & bootstrap =====

  function detectAndMount() {
    // Cloudflare gate: never mount on a challenge screen. The user might
    // refresh/solve, after which our MutationObserver will retry detection.
    if (isCloudflareChallenge()) { unmountFab(); closePanel(); return; }
    // The FAB now serves both detail (Postular) AND listing (Mejores
    // matches) modes. paintFabLabel() picks the right copy from fabMode().
    const onDetail = isJobDetailPage();
    const onListing = isListingPage();
    if (onDetail || onListing) {
      mountFab();
      paintFabLabel();
    } else {
      // Left both contexts — drop the wider-search pool so a return visit
      // re-scores from scratch (filters may have changed).
      widerSearchPool = null;
      unmountFab();
      closePanel();
      closeMatchesPanel();
    }
    // Listing badges run on a separate axis. Scan when on a known listing
    // path; otherwise tear down so we don't leak overlays into other routes.
    if (isListingPath()) {
      ensureDiscoveryDeps().then(() => {
        Promise.all([loadProfileOnce(), loadPreferencesOnce()]).then(() => {
          // 250ms gives Indeed React time to hydrate the first card batch
          // before our scan fires. Conservative — LaPieza uses 150ms.
          scheduleListingScan(250);
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
        lastUrl = location.href;
        activeDraftId = null; lastDraft = null; lastJob = null;
        // Tear down listing overlays — they're tied to the previous route.
        stopListingObserver();
        // Best-matches panel + wider-search pool are page-scoped.
        widerSearchPool = null;
        closeMatchesPanel();
        setTimeout(detectAndMount, 300);
        setTimeout(detectAndMount, 1200);
      }
    };
    const origPush = history.pushState, origReplace = history.replaceState;
    history.pushState = function () { const r = origPush.apply(this, arguments); window.dispatchEvent(new Event("eamx:locationchange")); return r; };
    history.replaceState = function () { const r = origReplace.apply(this, arguments); window.dispatchEvent(new Event("eamx:locationchange")); return r; };
    window.addEventListener("popstate", onChange);
    window.addEventListener("eamx:locationchange", onChange);

    // 800ms throttle (vs LaPieza's 600ms) — Indeed is React-heavy and
    // Cloudflare is more sensitive to high-frequency DOM observation.
    const mo = new MutationObserver(throttle(() => {
      if (location.href !== lastUrl) { onChange(); return; }
      if (isCloudflareChallenge()) { if (fabEl) { unmountFab(); closePanel(); } return; }
      const want = isJobDetailPage() || isListingPage();
      const have = !!(fabEl && document.body.contains(fabEl));
      if (want && !have) { mountFab(); paintFabLabel(); }
      else if (!want && have) { widerSearchPool = null; unmountFab(); closePanel(); closeMatchesPanel(); }
      else if (want && have) {
        // Same page, but maybe the mode changed (detail ↔ listing via SPA
        // nav that didn't fire popstate first). Repaint label.
        paintFabLabel();
      }
    }, 800));
    mo.observe(document.body, { childList: true, subtree: true });
  }

  function boot() {
    try {
      // Profile + queue change watcher (storage.onChanged) — re-render
      // listing badges when the user uploads a new CV or removes from
      // queue in another tab.
      watchProfileChanges();
      detectAndMount();
      watchUrlChanges();
    } catch (err) { console.error("[EmpleoAutomatico]", err); }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
