/**
 * content/occ.js — OCC Mundial content script (Empleo Automático MX, Agente B)
 *
 * Confidence on OCC selectors: LOW/MEDIUM.
 * occ.com.mx returns 403 to unauthenticated fetches (including WebFetch), so
 * selectors below were NOT verified on a live page. Order-of-preference:
 *   1) JSON-LD @type JobPosting (Google for Jobs; most portals emit it for SEO)
 *   2) Microdata / ARIA / semantic HTML (itemprop, h1, address)
 *   3) Heuristic class-name matches (job-title, empresa, ubicacion, sueldo)
 *   4) Regex fallbacks (modality from text; bullets from description)
 * MVP assumes the user is already logged into OCC in the same browser session.
 *
 * Message types mirror MESSAGE_TYPES in lib/schemas.js. We also dynamic-import
 * schemas.js at boot (option a from the spec) to validate this stays in sync.
 */
(function () {
  "use strict";

  // Debug marker — open DevTools Console on OCC page; if this line shows up,
  // the content script IS injecting. Then inspect window.__eamx_loaded.
  console.log("[EmpleoAutomatico] occ.js loaded on", location.href);
  try { window.__eamx_loaded = { source: "occ", at: new Date().toISOString() }; } catch (_) {}

  // Visible boot banner: a tiny pill at the top-left of the page, fades after 4s.
  // This proves the script injected without requiring DevTools.
  function showBootBanner() {
    try {
      if (document.getElementById("eamx-boot-banner")) return;
      const b = document.createElement("div");
      b.id = "eamx-boot-banner";
      b.textContent = "✨ Empleo Automatico cargado";
      Object.assign(b.style, {
        position: "fixed", top: "12px", left: "12px",
        background: "linear-gradient(135deg,#137e7a,#105971)",
        color: "#fff", padding: "8px 14px", borderRadius: "9999px",
        fontFamily: "system-ui,sans-serif", fontSize: "13px", fontWeight: "600",
        zIndex: "2147483647", boxShadow: "0 8px 24px -8px rgba(16,89,113,.5)",
        opacity: "0", transition: "opacity .25s ease"
      });
      document.documentElement.appendChild(b);
      requestAnimationFrame(() => { b.style.opacity = "1"; });
      setTimeout(() => { b.style.opacity = "0"; }, 4000);
      setTimeout(() => { b.remove(); }, 4500);
    } catch (_) {}
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", showBootBanner);
  } else {
    showBootBanner();
  }

  const SOURCE = "occ";
  const PORTAL_LABEL = "OCC Mundial";
  const TIP_STORAGE_KEY = "eamx_panel_tips_shown";
  const TIP_DISMISS_KEY = "eamx_panel_tips_dismissed";
  const TIP_MAX_SHOWS = 3;
  const REGEN_CAP = 5;
  const MSG = { GENERATE_DRAFT: "GENERATE_DRAFT", APPROVE_DRAFT: "APPROVE_DRAFT", REJECT_DRAFT: "REJECT_DRAFT", OPEN_BILLING: "OPEN_BILLING" };
  const ERR = { UNAUTHORIZED: "UNAUTHORIZED", PLAN_LIMIT_EXCEEDED: "PLAN_LIMIT_EXCEEDED" };
  const BILLING_URL = "https://empleo.skybrandmx.com/account/billing";

  // Inline icons (lucide-style, 16px, stroke 1.75) — avoid external libs.
  const ICONS = {
    building: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01M16 6h.01M12 6h.01M8 10h.01M16 10h.01M12 10h.01M8 14h.01M16 14h.01M12 14h.01"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    pin: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 7-8 13-8 13s-8-6-8-13a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    money: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
    laptop: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><line x1="2" y1="20" x2="22" y2="20"/></svg>',
    sparkles: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/></svg>',
    list: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
    chev: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>',
    copy: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    bulb: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2V17h6v-.3c0-.8.4-1.5 1-2A7 7 0 0 0 12 2z"/></svg>',
    warn: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="eamx-btn__refresh"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
    arrowRight: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>',
    bigCheck: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>'
  };

  const JOB_URL_PATTERNS = [
    /\/empleo\/oferta\//i,
    /\/empleos\/oferta\//i,
    /\/empleo\/[^/]+\/\d+/i,
    /\/vacante\//i
  ];

  // Listing path detection — search results, category pages, etc. The OCC
  // listings live under /empleos/ with optional category/location suffixes,
  // and a few legacy aliases (/empleos-en-, /empleos-de-) we keep for safety.
  const LISTING_PATH_RX = [
    /^\/empleos\/?/i,
    /^\/empleos-en-/i,
    /^\/empleos-de-/i,
    /^\/buscar\//i,
    /^\/?$/  // homepage might have featured jobs
  ];

  // Anchor regex — accept any /empleo/ link variant. Matches /empleo/oferta/<id>/...
  // and /empleo/<slug>/<id>/ alike, so listings that show shorter URLs aren't missed.
  const VACANCY_ANCHOR_RX = /\/empleo(?:s)?(?:\/oferta)?\/[^/?#]+/i;

  // Storage key for user preferences (city, modality, salary). Mirrors lib/schemas.js.
  const PREFERENCES_STORAGE_KEY = "eamx:preferences";

  // Dynamic import of the shared schemas module — content scripts cannot
  // declare ES-module imports via manifest, but runtime dynamic import works
  // in MV3. If it fails we keep the hardcoded MSG mirror above.
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
  let regenCount = 1; // counts versions shown for current panel session

  // Discovery / listing-page module state. These mirror the lapieza.js block.
  let matchScoreModule = null;
  let queueModule = null;
  let cachedProfile = null;
  let cachedPreferences = null;
  let profileLoaded = false;
  let preferencesLoaded = false;
  let listingObserver = null;
  let listingScanTimer = null;

  // Best-matches panel state. Module-scoped so we can re-render on storage
  // changes without rebuilding the skeleton.
  let matchesPanelEl = null;
  let matchesQueueListener = null;
  let matchesEscHandler = null;
  let matchesCurrentTopN = [];

  // =========================================================================
  // Detection & extraction
  // =========================================================================

  function isJobDetailPage() {
    // OCC uses /empleo/oferta/... for direct detail pages AND /empleos/... for
    // search results with a split-pane right panel showing the selected job.
    // Both expose a "Postularme" button and a heading — that's enough signal.
    const urlMatches = JOB_URL_PATTERNS.some((re) => re.test(location.href));
    const onAnOccPage = /(^|\.)occ\.com\.mx$/i.test(location.hostname);
    const hasHeading = !!document.querySelector(
      "h1, [class*='job-title' i], [data-testid*='title' i]"
    );
    const applyRx = /postularme|postular|aplicar|postúlate|postulate|apply/i;
    const hasApply = Array.from(document.querySelectorAll(
      "button, a[role='button'], a.btn, a[class*='apply' i], a[class*='postular' i]"
    )).some((el) => applyRx.test((el.textContent || "").trim()));
    const hasJsonLd = !!findJobPostingJsonLd();
    const detected = (urlMatches && hasHeading) || hasJsonLd || (hasHeading && hasApply) || (onAnOccPage && hasApply);
    // Debug breadcrumbs — open DevTools → Console to see if detection works.
    if (detected) {
      console.log("[EmpleoAutomatico] detected job page", { url: location.href, hasJsonLd, hasApply });
    }
    return detected;
  }

  // Listing-page detector. Path allowlist first (cheap regex check) and a
  // DOM-probe fallback so unknown URL aliases still light up the badges
  // when they render multiple vacancy anchors. Mirrors lapieza.js's
  // isListingPage / isListingPath split — kept inline as one helper here
  // because OCC has fewer routes.
  function isListingPage() {
    const path = location.pathname || "";
    if (LISTING_PATH_RX.some((rx) => rx.test(path))) return true;
    // Fallback: any path with multiple vacancy anchors.
    try {
      if (typeof findVacancyCards === "function") {
        const cards = findVacancyCards();
        if (Array.isArray(cards) && cards.length >= 2) return true;
      }
    } catch (_) { /* ignore */ }
    return false;
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
    if (/\b(home[- ]?office|remoto|teletrabajo|remote)\b/.test(t)) return "remoto";
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
    // TODO(dom): refine container selectors with real OCC DOM.
    const containers = document.querySelectorAll(
      "[class*='requirement' i], [class*='requisito' i], [data-testid*='requirement' i]"
    );
    const bullets = [];
    containers.forEach((c) => c.querySelectorAll("li").forEach((li) => {
      const t = cleanText(li.textContent); if (t) bullets.push(t);
    }));
    if (bullets.length) return dedupe(bullets).slice(0, 30);

    if (!descriptionText) return [];
    const kw = /(experiencia|años|requisito|conocimient|manejo|dominio|nivel|inglés|ingles|licencia|certific|habilidad)/i;
    const lines = descriptionText.split(/\n|•|·|\*/).map((l) => l.trim())
      .filter((l) => l.length > 4 && l.length < 300 && kw.test(l));
    return dedupe(lines).slice(0, 15);
  }

  function idFromUrl(url) {
    try {
      const u = new URL(url);
      // 1) /empleo/oferta/<num>/... → numeric id (canonical OCC).
      const num = u.pathname.match(/\/empleo(?:s)?\/oferta\/(\d{4,})/i);
      if (num) return num[1];
      // 2) Last numeric path segment (covers /empleo/<slug>/<id>/ variants).
      const segs = u.pathname.split("/").filter(Boolean);
      for (let i = segs.length - 1; i >= 0; i--) {
        const m = segs[i].match(/(\d{4,})/);
        if (m) return m[1];
      }
      // 3) Slug fallback — last non-empty segment, used for cards w/o numeric id.
      const last = segs[segs.length - 1];
      if (last && last.length > 3) return last;
    } catch (_) { /* fallthrough to flat patterns */ }
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

  // Find the OCC job-detail panel: on /empleos/... search results pages, the
  // selected job is shown on the right side. We locate it by walking up from
  // the unique "Postularme" button to the nearest article/aside/section
  // container, then scope all extraction to that subtree.
  function findDetailPanel() {
    const applyRx = /^(postularme|postular|aplicar)$/i;
    const buttons = Array.from(document.querySelectorAll("button, a"));
    for (const btn of buttons) {
      if (!applyRx.test((btn.textContent || "").trim())) continue;
      // Walk up to the first reasonable container.
      let p = btn.parentElement;
      let depth = 0;
      while (p && depth < 12) {
        if (p.tagName === "ARTICLE" || p.tagName === "ASIDE" || p.tagName === "SECTION" || p.tagName === "MAIN") return p;
        if (p.matches?.("[role='region'], [role='complementary'], [class*='detail' i], [class*='vacante' i], [class*='oferta' i], [class*='aviso' i]")) return p;
        p = p.parentElement;
        depth++;
      }
      // Fallback: 5 levels up from button.
      let f = btn.parentElement;
      for (let i = 0; i < 5 && f?.parentElement; i++) f = f.parentElement;
      if (f) return f;
    }
    return null;
  }

  function pickInScope(scope, selector) {
    if (!scope) return "";
    const el = scope.querySelector(selector);
    return el ? cleanText(el.textContent) : "";
  }

  function extractJob() {
    const url = location.href;
    const jsonLd = findJobPostingJsonLd();
    const detail = findDetailPanel();

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

    // Prefer extraction from the detail panel (right side on /empleos/ pages).
    // Falls back to whole-document selectors when the panel isn't found.
    title = firstNonEmpty(
      title,
      pickInScope(detail, "h1, h2, h3"),
      pickInScope(detail, "[itemprop='title'], [data-testid*='title' i], [class*='job-title' i]"),
      textOf("[itemprop='title']"), textOf("[data-testid='job-title']"),
      textOf("[class*='job-title' i]"),
      // Last-resort h1 — but only if it doesn't look like pagination/UI noise.
      (() => {
        const h = textOf("h1");
        return /llegaste al final|p[áa]gina \d+|resultados$/i.test(h) ? "" : h;
      })()
    );
    company = firstNonEmpty(
      company,
      pickInScope(detail, "[itemprop='hiringOrganization']"),
      pickInScope(detail, "a[href*='/empresa' i], a[href*='/company' i]"),
      pickInScope(detail, "[class*='company-name' i], [class*='empresa' i] a, [class*='empresa' i]"),
      textOf("[itemprop='hiringOrganization']"),
      textOf("[class*='company-name' i]")
    );
    loc = firstNonEmpty(
      loc,
      pickInScope(detail, "[itemprop='jobLocation']"),
      pickInScope(detail, "address, [class*='location' i], [class*='ubicacion' i]"),
      textOf("[itemprop='jobLocation']"), textOf("address")
    );
    if (!salary) {
      salary = firstNonEmpty(
        pickInScope(detail, "[itemprop='baseSalary'], [class*='salary' i], [class*='sueldo' i]"),
        textOf("[itemprop='baseSalary']"),
        textOf("[class*='salary' i]"),
        textOf("[class*='sueldo' i]")
      ) || null;
    }
    if (!description) {
      description = firstNonEmpty(
        detail ? cleanText(detail.textContent) : "",
        textOf("[itemprop='description']"),
        textOf("[data-testid*='description' i]"),
        textOf("[class*='job-description' i]"),
        textOf("[class*='descripcion' i]"),
        largestTextBlock()
      );
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
    // Append to <html> not <body>: many SPA hosts (OCC, Indeed, LinkedIn)
    // hydrate React into <body> and wipe injected children. <html> survives.
    if (fabEl && document.documentElement.contains(fabEl)) return;
    fabEl = document.createElement("button");
    fabEl.type = "button";
    fabEl.className = "eamx-fab";
    fabEl.setAttribute("aria-label", "Postular con IA");
    fabEl.innerHTML =
      '<span class="eamx-fab__icon" aria-hidden="true">✨</span>' +
      '<span class="eamx-fab__label">Postular con IA</span>';
    // Inline styles as last-resort fallback so even if our stylesheet didn't
    // apply (CSP, shadow DOM, etc), the FAB is still visible & clickable.
    Object.assign(fabEl.style, {
      position: "fixed", right: "24px", bottom: "24px",
      zIndex: "2147483600",
      display: "inline-flex", alignItems: "center", gap: "10px",
      padding: "14px 22px", minHeight: "56px",
      border: "0", borderRadius: "9999px",
      background: "linear-gradient(135deg,#137e7a 0%,#105971 100%)",
      color: "#ffffff", cursor: "pointer",
      font: "600 14.5px/1 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif",
      boxShadow: "0 12px 28px -8px rgba(16,89,113,.5)"
    });
    fabEl.addEventListener("click", onFabClick);
    document.documentElement.appendChild(fabEl);
    // Repaint label based on current route (listing vs vacancy).
    paintFabLabel();
    console.log("[EmpleoAutomatico] FAB mounted");
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

  // FAB mode resolver: "listing" on search/category pages (best-matches
  // panel), "vacancy" on job-detail (legacy single-job panel), null when
  // we shouldn't be visible at all.
  function fabMode() {
    if (isListingPage() && !isJobDetailPage()) return "listing";
    if (isJobDetailPage()) return "vacancy";
    return null;
  }

  function paintFabLabel() {
    if (!fabEl) return;
    const lbl = fabEl.querySelector(".eamx-fab__label");
    if (!lbl) return;
    if (fabMode() === "listing") {
      lbl.textContent = "Mejores matches";
      fabEl.setAttribute("aria-label", "Ver mejores matches en esta página");
    } else {
      lbl.textContent = "Postular con IA";
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
    // Graceful degradation: if we extracted essentially nothing, tell the user.
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

  // -------- Tip-strip storage helpers ----------
  function readTipState() {
    return new Promise((resolve) => {
      try {
        if (!chrome?.storage?.local) return resolve({ shown: 0, dismissed: false });
        chrome.storage.local.get([TIP_STORAGE_KEY, TIP_DISMISS_KEY], (data) => {
          resolve({
            shown: Number(data?.[TIP_STORAGE_KEY] || 0),
            dismissed: !!data?.[TIP_DISMISS_KEY]
          });
        });
      } catch (_) { resolve({ shown: 0, dismissed: false }); }
    });
  }
  function writeTipState(patch) {
    try { chrome?.storage?.local?.set(patch, () => {}); } catch (_) {}
  }

  // -------- DOM helpers ----------
  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === "class") e.className = v;
        else if (k === "html") e.innerHTML = v;
        else if (k === "text") e.textContent = v;
        else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2).toLowerCase(), v);
        else e.setAttribute(k, v === true ? "" : String(v));
      }
    }
    for (const c of children) {
      if (c == null || c === false) continue;
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return e;
  }

  function placeholderChip(label, iconHtml) {
    const c = el("span", { class: "eamx-panel__chip eamx-panel__chip--placeholder", html: iconHtml });
    c.appendChild(document.createTextNode(label));
    return c;
  }

  function makeChip(text, iconHtml) {
    const c = el("span", { class: "eamx-panel__chip", html: iconHtml });
    c.appendChild(document.createTextNode(text));
    return c;
  }

  function wordStats(text) {
    const trimmed = (text || "").trim();
    if (!trimmed) return { words: 0, mins: 0 };
    const words = trimmed.split(/\s+/).filter(Boolean).length;
    const mins = Math.max(1, Math.round(words / 220));
    return { words, mins };
  }

  function flashCopy(btn) {
    const orig = btn.innerHTML;
    btn.classList.add("eamx-mini-btn--ok");
    btn.innerHTML = `${ICONS.check}<span>Copiado</span>`;
    setTimeout(() => {
      btn.classList.remove("eamx-mini-btn--ok");
      btn.innerHTML = orig;
    }, 1500);
  }

  function setRegenCounter(n) {
    if (!panelEl) return;
    const counter = panelEl.querySelector("[data-regen-counter]");
    if (counter) counter.textContent = `Versión ${Math.min(n, REGEN_CAP)}/${REGEN_CAP}`;
  }

  function updateWordCount() {
    if (!panelEl) return;
    const ta = panelEl.querySelector("#eamx-cover-letter");
    const out = panelEl.querySelector("[data-word-count]");
    if (!ta || !out) return;
    const { words, mins } = wordStats(ta.value);
    out.textContent = words === 0
      ? "0 palabras"
      : `${words} palabras · ~${mins} min de lectura`;
  }

  // -------- Build & open panel ----------
  async function openPanel({ job, draft, partial }) {
    closePanel();
    regenCount = 1;
    panelEl = document.createElement("aside");
    panelEl.className = "eamx-panel";
    panelEl.setAttribute("role", "dialog");
    panelEl.setAttribute("aria-label", "Borrador de postulación");

    const cover = draft?.coverLetter || "";
    const answers = draft?.suggestedAnswers || {};
    const tipState = await readTipState();
    const showTip = !tipState.dismissed && tipState.shown < TIP_MAX_SHOWS;

    // ---- Header ----
    const header = el("header", { class: "eamx-panel__header" },
      el("p", { class: "eamx-panel__eyebrow" }, "Paso 2 de 3 · Revisa la carta"),
      el("h1", { class: "eamx-panel__title", text: job.title || "(vacante sin título)" }),
      buildCompanyRow(job),
      buildMetaRow(job)
    );
    const closeBtn = el("button", {
      type: "button",
      class: "eamx-panel__close",
      "aria-label": "Cerrar panel",
      "data-action": "cancel",
      html: ICONS.close
    });
    header.appendChild(closeBtn);

    // ---- Body ----
    const body = el("div", { class: "eamx-panel__body" });
    if (showTip) body.appendChild(buildTipStrip());
    if (partial) body.appendChild(buildWarning());
    body.appendChild(buildCoverSection(cover));
    const answersSection = buildAnswersSection(answers);
    if (answersSection) body.appendChild(answersSection);

    // ---- Footer ----
    const footer = buildFooter();

    panelEl.appendChild(header);
    panelEl.appendChild(body);
    panelEl.appendChild(footer);

    panelEl.addEventListener("click", onPanelClick);
    panelEl.addEventListener("input", (e) => {
      if (e.target && e.target.id === "eamx-cover-letter") updateWordCount();
    });
    document.body.appendChild(panelEl);
    requestAnimationFrame(() => panelEl.classList.add("eamx-panel--open"));

    // Set initial word count.
    updateWordCount();

    // Track tip impression.
    if (showTip) writeTipState({ [TIP_STORAGE_KEY]: tipState.shown + 1 });
  }

  function buildCompanyRow(job) {
    const row = el("div", { class: "eamx-panel__company-row", html: ICONS.building });
    const isPlaceholder = !job.company || job.company === "(empresa desconocida)";
    if (isPlaceholder) {
      row.appendChild(el("span", { class: "eamx-panel__company eamx-panel__company--placeholder", text: "— sin dato —" }));
    } else {
      row.appendChild(el("span", { class: "eamx-panel__company", text: job.company }));
      const verified = el("span", { class: "eamx-panel__verified", "aria-label": "Empresa verificada", title: "Empresa verificada", html: ICONS.check });
      row.appendChild(verified);
    }
    return row;
  }

  function buildMetaRow(job) {
    const row = el("div", { class: "eamx-panel__meta" });
    // Location
    if (job.location && job.location.trim()) {
      row.appendChild(makeChip(job.location, ICONS.pin));
    } else {
      row.appendChild(placeholderChip("ubicación — sin dato —", ICONS.pin));
    }
    // Salary
    if (job.salary && String(job.salary).trim()) {
      row.appendChild(makeChip(String(job.salary), ICONS.money));
    } else {
      row.appendChild(placeholderChip("sueldo — sin dato —", ICONS.money));
    }
    // Modality
    if (job.modality) {
      row.appendChild(makeChip(job.modality, ICONS.laptop));
    } else {
      row.appendChild(placeholderChip("modalidad — sin dato —", ICONS.laptop));
    }
    return row;
  }

  function buildTipStrip() {
    const strip = el("div", { class: "eamx-tipstrip" });
    strip.innerHTML = `
      <span class="eamx-tipstrip__icon">${ICONS.bulb}</span>
      <div class="eamx-tipstrip__text"><strong>Tip:</strong> revisa la carta y edítala si quieres. Tú das el último clic en <em>Enviar</em> dentro del portal — nosotros nunca enviamos por ti.</div>
      <button type="button" class="eamx-tipstrip__close" aria-label="No volver a mostrar este tip" data-action="dismiss-tip">×</button>
    `;
    return strip;
  }

  function buildWarning() {
    const w = el("div", { class: "eamx-panel__warning", role: "status" });
    w.innerHTML = `
      <span class="eamx-panel__warning-icon">${ICONS.warn}</span>
      <div class="eamx-panel__warning-text"><strong>Lectura parcial de la vacante.</strong> No pude extraer todos los detalles. Revisa la carta y agrégale lo que haga falta antes de aprobar.</div>
      <button type="button" class="eamx-panel__warning-close" aria-label="Cerrar aviso" data-action="dismiss-warning">×</button>
    `;
    return w;
  }

  function buildCoverSection(coverText) {
    const section = el("div", { class: "eamx-section eamx-cover" });
    const head = el("div", { class: "eamx-section__head" },
      (() => {
        const t = el("div", { class: "eamx-section__title", html: ICONS.sparkles });
        t.appendChild(el("label", { for: "eamx-cover-letter", text: "Carta de presentación" }));
        return t;
      })(),
      (() => {
        const h = el("div", { class: "eamx-section__hint" });
        h.innerHTML = `Generada con IA · editable · <span data-regen-counter>Versión 1/${REGEN_CAP}</span>`;
        return h;
      })()
    );
    section.appendChild(head);

    const fieldWrap = el("div", { class: "eamx-cover__field" });
    const ta = el("textarea", {
      id: "eamx-cover-letter",
      class: "eamx-textarea",
      rows: "12",
      "aria-label": "Carta de presentación editable"
    });
    ta.value = coverText;
    fieldWrap.appendChild(ta);
    fieldWrap.appendChild(el("div", { class: "eamx-cover__overlay" },
      el("div", { class: "eamx-cover__spinner" }),
      el("span", { text: "Generando nueva versión…" })
    ));
    section.appendChild(fieldWrap);

    const footer = el("div", { class: "eamx-cover__footer" });
    footer.appendChild(el("span", { class: "eamx-cover__count", "data-word-count": "true", text: "0 palabras" }));
    const copyBtn = el("button", {
      type: "button",
      class: "eamx-mini-btn",
      "data-action": "copy-cover",
      title: "Copiar carta al portapapeles"
    });
    copyBtn.innerHTML = `${ICONS.copy}<span>Copiar</span>`;
    footer.appendChild(copyBtn);
    section.appendChild(footer);

    return section;
  }

  function buildAnswersSection(answers) {
    const keys = Object.keys(answers || {});
    if (!keys.length) return null;
    const section = el("div", { class: "eamx-section eamx-section--answers" });
    section.appendChild(el("div", { class: "eamx-section__head" },
      (() => {
        const t = el("div", { class: "eamx-section__title", html: ICONS.list });
        t.appendChild(el("span", { text: "Respuestas sugeridas" }));
        return t;
      })(),
      el("div", { class: "eamx-section__hint", text: "Clic para expandir y copiar" })
    ));

    const list = el("div", { class: "eamx-answers" });
    for (const k of keys) {
      const card = el("div", { class: "eamx-answer" });
      const summary = el("button", {
        type: "button",
        class: "eamx-answer__summary",
        "aria-expanded": "false"
      });
      summary.appendChild(el("span", { class: "eamx-answer__label", text: k }));
      const chev = el("span", { class: "eamx-answer__chev", html: ICONS.chev });
      summary.appendChild(chev);
      summary.addEventListener("click", () => {
        const open = card.classList.toggle("eamx-answer--open");
        summary.setAttribute("aria-expanded", String(open));
      });
      const body = el("div", { class: "eamx-answer__body" });
      const ta = el("textarea", { class: "eamx-answer__value", rows: "3" });
      ta.value = String(answers[k] || "");
      body.appendChild(ta);
      const actions = el("div", { class: "eamx-answer__actions" });
      const copy = el("button", {
        type: "button",
        class: "eamx-mini-btn",
        title: "Copiar respuesta"
      });
      copy.innerHTML = `${ICONS.copy}<span>Copiar</span>`;
      copy.addEventListener("click", (ev) => {
        ev.stopPropagation();
        navigator.clipboard?.writeText(ta.value)
          .then(() => flashCopy(copy))
          .catch(() => toast("No se pudo copiar.", "error"));
      });
      actions.appendChild(copy);
      body.appendChild(actions);
      card.append(summary, body);
      list.appendChild(card);
    }
    section.appendChild(list);
    return section;
  }

  function buildFooter() {
    const footer = el("footer", { class: "eamx-panel__footer" });
    const actions = el("div", { class: "eamx-panel__actions" });
    const primary = el("button", {
      type: "button",
      class: "eamx-btn eamx-btn--primary",
      "data-action": "approve"
    });
    primary.innerHTML = `<span>Aprobar y postular</span>${ICONS.arrowRight}<span class="eamx-btn__step">Paso 2/3</span>`;
    const secondary = el("button", {
      type: "button",
      class: "eamx-btn eamx-btn--secondary",
      "data-action": "regen"
    });
    secondary.innerHTML = `${ICONS.refresh}<span>Re-generar</span>`;
    const ghost = el("button", {
      type: "button",
      class: "eamx-btn eamx-btn--ghost",
      "data-action": "cancel",
      text: "Cancelar"
    });
    actions.append(primary, secondary, ghost);
    footer.appendChild(actions);
    footer.appendChild(el("p", {
      class: "eamx-panel__microcopy",
      html: `Al aprobar: llenamos el formulario por ti. Tú das el clic final en <strong>Enviar</strong> dentro de ${PORTAL_LABEL}.`
    }));
    return footer;
  }

  function closePanel() { panelEl?.parentNode?.removeChild(panelEl); panelEl = null; }

  async function onPanelClick(e) {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    if (action === "cancel") return handleCancel();
    if (action === "regen") return handleRegen();
    if (action === "approve") return handleApprove();
    if (action === "copy-cover") return handleCopyCover(btn);
    if (action === "dismiss-tip") return handleDismissTip(btn);
    if (action === "dismiss-warning") return handleDismissWarning(btn);
  }

  async function handleCancel() {
    try { if (activeDraftId) await sendMsg({ type: MSG.REJECT_DRAFT, draftId: activeDraftId }); } catch (_) {}
    activeDraftId = null; lastDraft = null;
    closePanel(); setFabBusy(false);
  }

  function handleCopyCover(btn) {
    const ta = panelEl?.querySelector("#eamx-cover-letter");
    if (!ta) return;
    navigator.clipboard?.writeText(ta.value || "")
      .then(() => flashCopy(btn))
      .catch(() => toast("No se pudo copiar.", "error"));
  }

  function handleDismissTip(btn) {
    writeTipState({ [TIP_DISMISS_KEY]: true });
    const strip = btn.closest(".eamx-tipstrip");
    if (strip) strip.remove();
  }

  function handleDismissWarning(btn) {
    const w = btn.closest(".eamx-panel__warning");
    if (w) w.remove();
  }

  async function handleRegen() {
    if (!lastJob) return;
    if (regenCount >= REGEN_CAP) {
      toast(`Llegaste al límite de ${REGEN_CAP} versiones para esta vacante.`, "info");
      return;
    }
    const btns = panelEl ? panelEl.querySelectorAll("button[data-action]") : [];
    const regenBtn = panelEl?.querySelector("[data-action='regen']");
    const fieldWrap = panelEl?.querySelector(".eamx-cover__field");
    btns.forEach((b) => (b.disabled = true));
    if (regenBtn) regenBtn.setAttribute("data-loading", "true");
    if (fieldWrap) fieldWrap.classList.add("eamx-cover__field--regenerating");
    try {
      const res = await sendMsg({ type: MSG.GENERATE_DRAFT, job: lastJob, regenerate: true });
      if (!res || !res.ok) { showBackendFailure(res); return; }
      activeDraftId = res.draftId || res.draft?.id || null;
      lastDraft = res.draft || null;
      const ta = panelEl?.querySelector("#eamx-cover-letter");
      if (ta && lastDraft) {
        ta.value = lastDraft.coverLetter || "";
        ta.classList.remove("eamx-textarea--pulse");
        // Force reflow to restart animation
        void ta.offsetWidth;
        ta.classList.add("eamx-textarea--pulse");
        updateWordCount();
      }
      regenCount = Math.min(REGEN_CAP, regenCount + 1);
      setRegenCounter(regenCount);
      toast("Borrador regenerado.", "success");
    } catch (err) {
      toast(humanizeError(err), "error");
    } finally {
      btns.forEach((b) => (b.disabled = false));
      if (regenBtn) regenBtn.removeAttribute("data-loading");
      if (fieldWrap) fieldWrap.classList.remove("eamx-cover__field--regenerating");
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
      // Ensure the (possibly edited) cover letter is filled even if background
      // forgot to include it in `fields`.
      const fields = (res.fields && typeof res.fields === "object") ? { ...res.fields } : {};
      if (!fields.coverLetter) fields.coverLetter = coverLetter;
      fillForm(fields);
      highlightSubmitButton();
      // Show in-panel success state for ~2s, then auto-close.
      showApproveSuccess();
      toast("Listo — revisa y da click a 'Enviar' cuando estés conforme.", "success");
      setTimeout(() => { closePanel(); setFabBusy(false); }, 2200);
    } catch (err) {
      toast(humanizeError(err), "error");
      btns.forEach((b) => (b.disabled = false));
      setFabBusy(false);
    }
  }

  function showApproveSuccess() {
    if (!panelEl) return;
    const body = panelEl.querySelector(".eamx-panel__body");
    if (!body) return;
    body.style.position = "relative";
    const overlay = el("div", { class: "eamx-panel__success", role: "status" });
    const iconWrap = el("div", { class: "eamx-panel__success-icon", html: ICONS.bigCheck });
    const title = el("p", { class: "eamx-panel__success-title", text: "Listo. Llenamos el formulario." });
    const text = el("p", { class: "eamx-panel__success-text" });
    text.innerHTML = `Busca el botón de <strong>Enviar</strong> resaltado en dorado y dale clic cuando estés conforme.`;
    overlay.append(iconWrap, title, text);
    body.appendChild(overlay);
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

  // Locate the primary OCC application form: prefer one with both a textarea
  // and a submit-ish button; fall back to any form with a textarea.
  function findApplicationForm() {
    const forms = Array.from(document.querySelectorAll("form"));
    const rx = /postular|aplicar|enviar|submit|apply|send/i;
    for (const f of forms) {
      if (!f.querySelector("textarea")) continue;
      const btn = f.querySelector("button, input[type='submit']");
      if (btn && rx.test((btn.textContent || btn.value || "").trim())) return f;
    }
    return forms.find((f) => !!f.querySelector("textarea")) || forms[0] || null;
  }

  // Resolve a semantic key (fullName, email, phone, coverLetter) against the
  // live DOM. If `key` looks like a CSS selector, try it as a selector first.
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
        || qa("input, textarea").find((el) => /phone|tel|celular|m[oó]vil/i.test(attrHay(el)))
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
    const rx = /postular|enviar|aplicar|submit|send/i;
    const form = findApplicationForm();
    const scope = form || document;
    const direct = scope.querySelector("button[type='submit'], input[type='submit']");
    if (direct) return direct;
    return Array.from(scope.querySelectorAll("button, a[role='button']"))
      .find((b) => rx.test((b.textContent || "").trim())) || null;
  }

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

    // Append to <html> (not <body>) — host pages often have transformed
    // ancestors that break `position: fixed` on body-level children.
    document.documentElement.appendChild(el);
    requestAnimationFrame(() => el.classList.add("eamx-toast--show"));
    const duration = action ? 8000 : 4000;
    setTimeout(() => { el.classList.remove("eamx-toast--show"); setTimeout(() => el.remove(), 400); }, duration);
  }

  // Translate a failed backend response into the right toast + action.
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
    // Prefer service-worker-mediated tab open for consistency.
    sendMsg({ type: MSG.OPEN_BILLING }).catch(() => {
      window.open(BILLING_URL, "_blank", "noopener,noreferrer");
    });
  }

  function openOptionsPage() {
    // chrome.runtime.openOptionsPage isn't available from content scripts, so
    // open the options page URL in a new tab via the standard runtime URL.
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
  // content/lapieza.js). On OCC search/listing routes we walk the DOM,
  // score every vacancy card against the user's CV via lib/match-score.js,
  // and inject a small overlay (badge + Marcar button). The button writes
  // to chrome.storage.local["eamx:queue"] via lib/queue.js. The Options
  // page reads the same key. HITL-only: nothing here ever submits an
  // application or auto-clicks Postularme.
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
  // change in another tab. Mirrors the lapieza.js storage.onChanged wiring.
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
  // containers. Same heuristic as lapieza.js.
  function findCardRoot(anchor) {
    let p = anchor.parentElement;
    let depth = 0;
    while (p && depth < 8) {
      try {
        const cs = getComputedStyle(p);
        if (cs.display === "block" || cs.display === "flex" || cs.display === "grid") {
          const rect = p.getBoundingClientRect();
          const tall = rect.height > 80;
          const hasH = !!p.querySelector("h1, h2, h3, h4, [class*='title' i]");
          if (tall && hasH) return p;
        }
      } catch (_) { /* getComputedStyle can throw on detached nodes */ }
      p = p.parentElement;
      depth++;
    }
    return null;
  }

  // Cheap jobLite from a card. We only need enough to score against, not the
  // full JobPosting shape. OCC selectors mirror lapieza's heuristic:
  // h1-h4 for title, [class*='company'|'empresa'|'employer'] for company.
  function extractJobLiteFromCard(card, anchor) {
    const titleEl = card.querySelector("h1, h2, h3, h4, [class*='title' i] strong, [class*='title' i]");
    let title = "";
    if (titleEl) title = cleanText(titleEl.textContent);
    if (!title) {
      // Fallback: anchor text often has the title for OCC cards too.
      title = cleanText(anchor.textContent);
    }
    const companyEl = card.querySelector("[class*='empresa' i], [class*='company' i], [class*='employer' i]");
    let company = companyEl ? cleanText(companyEl.textContent) : "";
    if (!company) {
      // Walk through leaf text nodes and pick the first non-title visible
      // text — OCC sometimes renders the company as a plain <span>.
      const texts = Array.from(card.querySelectorAll("*"))
        .map((el) => el.children.length === 0 ? cleanText(el.textContent) : "")
        .filter((t) => t && t !== title && t.length > 1 && t.length < 80);
      if (texts.length) company = texts[0];
    }
    const url = anchor.href;
    const id = idFromUrl(url);
    const locationEl = card.querySelector("[class*='location' i], [class*='ubicacion' i], [class*='ciudad' i], address");
    const loc = locationEl ? cleanText(locationEl.textContent) : "";
    return {
      id,
      url,
      title: title || "(sin título)",
      company: company || "(empresa)",
      location: loc || ""
    };
  }

  // Find every vacancy anchor that's NOT already inside a card we've
  // overlaid. Returns the unique set of (anchor, cardRoot) tuples.
  //
  // Selector strategy: OCC-specific fast paths first (data-testid, article
  // wrappers, /empleo/oferta/ direct hrefs), generic href regex second.
  //
  // TODO(dom): verify the fast-path selectors against a logged-in OCC
  // session. The patterns below are heuristic — derived from common
  // React job-board class names. The regex fallback covers them all.
  function findVacancyCards() {
    const seenAnchor = new WeakSet();
    const anchors = [];
    // Fast paths — try these first so we don't pay the full a[href] cost
    // when the DOM is large. Each guarded so a missing selector doesn't
    // throw. Order matters: most specific to most generic.
    const fastSelectors = [
      'a[href*="/empleo/oferta/"]',
      '[data-testid*="job"] a[href]',
      '[data-testid*="vacancy"] a[href]',
      'article a[href*="/empleo/"]'
    ];
    for (const sel of fastSelectors) {
      try {
        document.querySelectorAll(sel).forEach((a) => {
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
      if (VACANCY_ANCHOR_RX.test(a.href || "")) {
        seenAnchor.add(a);
        anchors.push(a);
      }
    });

    const seenCard = new WeakSet();
    const out = [];
    for (const a of anchors) {
      // Visual card is the wrapper above the anchor (the anchor has the
      // click handler but the wrapper has the grid spacing). findCardRoot
      // walks up to find the wrapper; if it can't, fall back to the anchor.
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
    const fastSelectors = [
      'a[href*="/empleo/oferta/"]',
      '[data-testid*="job"] a[href]',
      '[data-testid*="vacancy"] a[href]',
      'article a[href*="/empleo/"]'
    ];
    for (const sel of fastSelectors) {
      try {
        document.querySelectorAll(sel).forEach((a) => {
          if (!seenAnchor.has(a) && VACANCY_ANCHOR_RX.test(a.href || "")) {
            seenAnchor.add(a);
            anchors.push(a);
          }
        });
      } catch (_) {}
    }
    document.querySelectorAll("a[href]").forEach((a) => {
      if (seenAnchor.has(a)) return;
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

  // Throttled re-scan funnel for MutationObserver / storage updates.
  function scheduleListingScan(delayMs = 600) {
    if (listingScanTimer) clearTimeout(listingScanTimer);
    listingScanTimer = setTimeout(async () => {
      listingScanTimer = null;
      if (!isListingPage()) return;
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
      if (!isListingPage()) return;
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
  // HITL guarantees: this panel never auto-clicks Postularme, never opens
  // multiple tabs programmatically, never submits anything. "Marcar" only
  // writes to chrome.storage.local["eamx:queue"].

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
      <div class="eamx-matches-panel__bulk" data-eamx-matches-bulk hidden>
        <button type="button" class="eamx-matches-panel__bulk-btn" data-action="mark-top-5">⭐ Marcar top 5 de un solo clic</button>
        <p class="eamx-matches-panel__bulk-hint">Marcar = guardar en tu cola. La extensión NO postula sola — tú abres cada vacante y le das clic al botón Postularme cuando quieras.</p>
      </div>
    `;
    // TODO(occ-pagination): OCC paginates via ?page=N URL changes which
    // unmount the panel on navigation. For v1 we skip the load-more button
    // entirely; the panel still works on the current page (~20-30 cards).
    // The user can click OCC's "Siguiente" themselves and re-open the FAB.

    matchesPanelEl.addEventListener("click", onMatchesPanelClick);
    document.documentElement.appendChild(matchesPanelEl);
    requestAnimationFrame(() => matchesPanelEl?.classList.add("eamx-matches-panel--open"));

    // Escape closes the panel.
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
    // "open" links are real <a target="_blank"> — let the browser handle them.
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

    // Find every visible card. Capped at 100 — past that, the panel becomes
    // memory-heavy and the user can't really compare so many anyway.
    let cards = [];
    try { cards = findAllVacancyCards() || []; } catch (err) {
      console.warn("[EmpleoAutomatico] findAllVacancyCards threw", err);
      cards = [];
    }
    if (cards.length > 100) cards = cards.slice(0, 100);

    // Empty state #2 — no cards detected.
    if (!cards.length) {
      host.innerHTML = `
        <div class="eamx-matches-empty">
          <div class="eamx-matches-empty__icon" aria-hidden="true">🔍</div>
          <h3>No detecté vacantes</h3>
          <p>No detecté vacantes en esta página. Si crees que es un bug, dame screenshot.</p>
          <button type="button" class="eamx-matches-empty__cta" data-action="rescan">Volver a escanear</button>
        </div>
      `;
      if (bulk) bulk.hidden = true;
      console.log("[EmpleoAutomatico] best matches panel opened: 0 matches (no cards)");
      return;
    }

    const effectivePrefs = (matchScoreModule && typeof matchScoreModule.effectivePreferences === "function")
      ? matchScoreModule.effectivePreferences(cachedPreferences, cachedProfile)
      : cachedPreferences;

    const scored = cards.map(({ anchor, card }) => {
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
    const footer = cards.length < 5
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

    console.log(`[EmpleoAutomatico] best matches panel opened: ${topN.length} matches`);
  }

  // Build a single <li> for the matches list. Identical structure to lapieza.
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
    const dotLoc = safeLoc ? ` · ${safeLoc}` : "";
    return `
      <li class="eamx-match-item">
        <div class="eamx-match-item__rank" aria-hidden="true">${rank}</div>
        <div class="eamx-match-item__body">
          <div class="eamx-match-item__head">
            <span class="eamx-match-item__score eamx-match-item__score--${badgeLevel}">${score}%</span>
            <span class="eamx-match-item__title">${safeTitle}</span>
          </div>
          <div class="eamx-match-item__company">${safeCompany}${dotLoc}</div>
          ${reasonsBlock}
          <div class="eamx-match-item__actions">
            <button type="button" data-action="mark" data-id="${safeId}" class="eamx-match-item__mark" aria-pressed="false">
              <span aria-hidden="true">⭐</span><span>Marcar</span>
            </button>
            <a data-action="open" href="${safeUrl}" target="_blank" rel="noopener" class="eamx-match-item__open">Abrir vacante →</a>
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
      // Card disappeared (OCC re-rendered). Don't crash — fall back to
      // opening the URL we still have on the button's parent <a>.
      const link = btn.parentElement?.querySelector('a[data-action="open"]');
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
        toast("Quitada de tu cola.", "info");
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
          toast("Agregada a tu cola.", "success");
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
      toast(msg || "Listo.", "success");
    } else if (added > 0) {
      toast(`${added} de ${total} agregadas.`, "info");
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
        lastUrl = location.href;
        activeDraftId = null; lastDraft = null; lastJob = null;
        // Tear down listing overlays — they're tied to the previous route's
        // DOM. detectAndMount() below re-arms them if we're still on a
        // listing path.
        stopListingObserver();
        // Best-matches panel is page-scoped; close on SPA route change.
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

    const mo = new MutationObserver(throttle(() => {
      if (location.href !== lastUrl) { onChange(); return; }
      const want = isJobDetailPage() || isListingPage();
      const have = !!(fabEl && document.body.contains(fabEl));
      if (want && !have) mountFab();
      else if (!want && have) { unmountFab(); closePanel(); closeMatchesPanel(); }
      else if (want && have) {
        // Same page still wants the FAB, but the mode might have changed
        // (vacancy → listing via in-SPA nav). Repaint the label to keep
        // it accurate.
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
