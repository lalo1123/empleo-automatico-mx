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
    console.log("[EmpleoAutomatico] FAB mounted");
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
