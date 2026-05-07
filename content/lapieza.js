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
    OPEN_GENERATED_CV: "OPEN_GENERATED_CV",
    ANSWER_QUESTIONS: "ANSWER_QUESTIONS",
    ANSWER_QUIZ: "ANSWER_QUIZ"
  };
  const ERR = { UNAUTHORIZED: "UNAUTHORIZED", PLAN_LIMIT_EXCEEDED: "PLAN_LIMIT_EXCEEDED", INVALID_INPUT: "INVALID_INPUT", SERVER_ERROR: "SERVER_ERROR" };
  // Modo Auto storage keys — must mirror lib/schemas.js STORAGE_KEYS exactly.
  // Hardcoded so the auto-submit gates work synchronously without waiting for
  // the dynamic import to settle. The syncSchema() block below overwrites
  // these from the live schemas module on a best-effort basis.
  const STORAGE_KEYS = {
    AUTO_MODE: "eamx:settings:autoMode",
    AUTO_DAILY: "eamx:auto:daily",
    AUTO_DISCLAIMER_SEEN: "eamx:auto:disclaimerSeen",
    AUTO_LAST_SUBMIT_AT: "eamx:auto:lastSubmitAt",
    AUTO_DAY_PAUSE: "eamx:auto:dayPause"
  };
  // Per-portal Modo Auto caps. Hardcoded fallbacks mirror lib/schemas.js
  // (AUTO_PORTAL_CAPS / AUTO_PORTAL_ORDER / AUTO_TOTAL_CAP) so the
  // auto-submit gate works even before syncSchema() finishes. Calibrated
  // against published green-zone thresholds: LinkedIn/Indeed 15/day,
  // OCC/Computrabajo/Bumeran/LaPieza 20/day, total 110/day.
  let AUTO_PORTAL_CAPS = { linkedin: 15, indeed: 15, occ: 20, computrabajo: 20, bumeran: 20, lapieza: 20 };
  let AUTO_PORTAL_ORDER = ["linkedin", "indeed", "occ", "computrabajo", "bumeran", "lapieza"];
  let AUTO_TOTAL_CAP = 110;
  const BILLING_URL = "https://empleo.skybrandmx.com/account/billing";

  // Confirmed via live test: vacancy page is /vacancy/<uuid>, apply page is
  // /apply/<uuid> (same UUID — LaPieza preserves the job id across the route
  // change). Apply pages don't have JSON-LD or detailed metadata, so we
  // restore the cached job from chrome.storage.session keyed by that UUID.
  const JOB_URL_PATTERNS = [
    /\/vacancy\/[a-f0-9-]{8,}/i,
    /\/vacante\/[a-f0-9-]{8,}/i,
    /\/vacancy\/[^/?#]+/i,
    /\/vacante\/[^/?#]+/i,
    /\/jobs\/[^/?#]+/i,
    /\/empleos\/[^/?#]+/i,
    /\/puesto\/[^/?#]+/i
  ];

  // Apply-form URL patterns. When we're on these, the FAB+panel must mount,
  // and we expect to restore lastJob from session storage (cached when the
  // user was previously on /vacancy/<same-uuid>). If no cache exists we still
  // mount: extractJob will pull whatever metadata it can from the apply
  // sidebar (title + company are usually shown there).
  const APPLY_URL_PATTERNS = [
    /\/apply\/[a-f0-9-]{8,}/i,
    /\/apply\/[^/?#]+/i,
    /\/postular\/[^/?#]+/i,
    /\/postularse\/[^/?#]+/i,
    /\/aplicar\/[^/?#]+/i,
    /\/postulacion\/[^/?#]+/i,
    /\/application\/[^/?#]+/i
  ];

  const JOB_CACHE_PREFIX = "eamx:lapieza:job:";
  // Express Mode pre-warmed draft cache key prefix. We store the GENERATE_DRAFT
  // result on /vacancy/<uuid> so the matching /apply/<uuid> page can paste the
  // cover letter without waiting for the network. Cleared on SPA route change
  // and on cancel/finish.
  const DRAFT_CACHE_PREFIX = "eamx:lapieza:draft:";
  // chrome.storage.local key for the Express toggle. Mirrors STORAGE_KEYS.EXPRESS_MODE
  // (lib/schemas.js) — we hardcode here because content scripts can't reliably
  // import the schema module synchronously and we need this on every FAB click.
  const EXPRESS_MODE_STORAGE_KEY = "eamx:settings:expressMode";

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
        OPEN_GENERATED_CV: mod.MESSAGE_TYPES.OPEN_GENERATED_CV,
        ANSWER_QUESTIONS: mod.MESSAGE_TYPES.ANSWER_QUESTIONS,
        ANSWER_QUIZ: mod.MESSAGE_TYPES.ANSWER_QUIZ || "ANSWER_QUIZ"
      });
      if (mod && mod.ERROR_CODES) Object.assign(ERR, {
        UNAUTHORIZED: mod.ERROR_CODES.UNAUTHORIZED,
        PLAN_LIMIT_EXCEEDED: mod.ERROR_CODES.PLAN_LIMIT_EXCEEDED,
        INVALID_INPUT: mod.ERROR_CODES.INVALID_INPUT,
        SERVER_ERROR: mod.ERROR_CODES.SERVER_ERROR
      });
      if (mod && mod.STORAGE_KEYS) Object.assign(STORAGE_KEYS, {
        AUTO_MODE: mod.STORAGE_KEYS.AUTO_MODE || STORAGE_KEYS.AUTO_MODE,
        AUTO_DAILY: mod.STORAGE_KEYS.AUTO_DAILY || STORAGE_KEYS.AUTO_DAILY,
        AUTO_DISCLAIMER_SEEN: mod.STORAGE_KEYS.AUTO_DISCLAIMER_SEEN || STORAGE_KEYS.AUTO_DISCLAIMER_SEEN,
        AUTO_LAST_SUBMIT_AT: mod.STORAGE_KEYS.AUTO_LAST_SUBMIT_AT || STORAGE_KEYS.AUTO_LAST_SUBMIT_AT,
        AUTO_DAY_PAUSE: mod.STORAGE_KEYS.AUTO_DAY_PAUSE || STORAGE_KEYS.AUTO_DAY_PAUSE
      });
      // Per-portal cap config — overwrite the hardcoded fallback if the
      // live schemas module exposes the new exports. Defensive checks so
      // an older lib/schemas.js (without these) doesn't blow us up.
      if (mod && mod.AUTO_PORTAL_CAPS && typeof mod.AUTO_PORTAL_CAPS === "object") {
        AUTO_PORTAL_CAPS = mod.AUTO_PORTAL_CAPS;
      }
      if (mod && Array.isArray(mod.AUTO_PORTAL_ORDER)) {
        AUTO_PORTAL_ORDER = mod.AUTO_PORTAL_ORDER;
      }
      if (mod && typeof mod.AUTO_TOTAL_CAP === "number") {
        AUTO_TOTAL_CAP = mod.AUTO_TOTAL_CAP;
      }
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

  // Adaptive open-ended questions detected on the apply form. Mirrors the
  // cvState pattern: module-scoped so panel re-renders preserve the cache.
  // detectedQuestions: [{ el, question, fieldRef }] — el is a soft reference
  // (DOM may be re-rendered by SPA so we always re-resolve via fieldRef when
  // pasting). questionAnswers: string[] aligned by index with detectedQuestions.
  // States: "idle" (none scanned yet) | "loading" (request in flight) |
  // "success" (answers populated) | "error" (questionsError holds copy).
  let detectedQuestions = [];
  let questionAnswers = [];
  let questionsState = "idle";
  let questionsError = "";
  // Auto-incrementing counter for the data-eamx-q-id attribute we stamp on
  // fields without an id. Lives at module scope so we keep generating fresh
  // refs if the user re-scans (SPA nav, regen).
  let questionRefSeq = 0;

  // In-flow assistant state. After the user approves the draft we keep watching
  // the page and offer contextual help on the portal's apply form (CV upload,
  // cover-letter textarea, multiple-choice questions, final submit button).
  let flowActive = false;
  let flowObserver = null;
  let flowDebounceTimer = null;
  const FLOW_PROCESSED = new WeakSet(); // elements we've already attached to
  const FLOW_TIPS_SHOWN = new Set();    // dedupe tip-keys for one-shot toasts

  // -----------------------------------------------------------------------
  // Auto-quiz state. SECOND documented exception to HITL (after Modo Auto).
  // Quiz auto-answer is allowed because:
  //   1) The user explicitly opted into Express by clicking the FAB.
  //   2) Quiz answers are FACTUAL public knowledge (Power Query, DAX, Excel,
  //      JS, etc.), not deceptive — no recruiter is misled by a correct
  //      multiple-choice tick.
  //   3) The user can override at any time via three kill switches:
  //        a) Esc key → cancels the loop, keeps the form fillable manually.
  //        b) Clicking any quiz option themselves → loop detects the user-
  //           initiated click (no eamx-quiz-clicking flag) and yields.
  //        c) The FINAL submit-to-recruiter button is NOT auto-clicked —
  //           the user always confirms the application herself.
  //
  // The loop is module-scoped (not inside a closure that runFlowDetectors
  // creates fresh each call) so a single guard `quizLoopActive` reliably
  // dedupes against the MutationObserver firing while we're mid-loop.
  let quizLoopActive = false;
  // Set when the user pressed Esc OR clicked a quiz option themselves. The
  // loop checks this between every step. Reset when the loop starts.
  let quizLoopAborted = false;
  // Document-level Esc + click listeners. Stored so we can detach them
  // when the loop ends. Single instance per loop run.
  let quizEscListener = null;
  let quizClickListener = null;
  // Last counter we acted on, used to detect "next question rendered" by
  // polling for a counter change. Format: { current, total } | null.
  let quizLastCounter = null;
  // Configurable cadence — visible delays so the user can see what's
  // happening. Tuned by hand on the 15-question Power BI test.
  const QUIZ_INTER_ANSWER_DELAY_MS = 1500;
  const QUIZ_INTER_QUESTION_DELAY_MS = 1200;
  const QUIZ_STALL_POLL_MS = 800;
  const QUIZ_STALL_MAX_POLLS = 3;
  const QUIZ_MAX_QUESTIONS = 30;
  // Sticky toast handle. We update a single DOM node across the loop instead
  // of spamming a fresh toast per question. Cleared on loop end.
  let quizStickyToast = null;

  // =========================================================================
  // Detection & extraction
  // =========================================================================

  function isApplyPage() {
    return APPLY_URL_PATTERNS.some((re) => re.test(location.href));
  }

  // Listing-page detector. Returns true on LaPieza routes whose primary
  // content is a feed of vacancy cards. We check both an explicit path
  // allowlist AND a DOM probe (any visible vacancy anchor), so the function
  // works even when LaPieza adds a new /algo/jobs/ alias we didn't anticipate.
  //
  // The DOM probe deliberately runs LAST — it's more expensive than a regex,
  // and the explicit allowlist already covers ≥95% of legit traffic.
  function isListingPage() {
    const path = location.pathname || "";
    const LISTING_ALLOWED = [
      /^\/?$/,
      /^\/vacantes\/?$/i,
      /^\/vacancies\/?$/i,
      /^\/jobs\/?$/i,
      /^\/empleos\/?$/i,
      /^\/comunidad\/jobs\/?$/i,
      /^\/comunidad\/empleos\/?$/i
    ];
    if (LISTING_ALLOWED.some((re) => re.test(path))) return true;
    // Filter views like /vacantes/categoria/marketing or /search?... — when
    // they render cards, treat them as listings too. Only run this when the
    // findVacancyCards helper is already defined (it lives later in the file
    // but is hoisted via function declaration, so this is safe at runtime).
    try {
      if (typeof findVacancyCards === "function") {
        const cards = findVacancyCards();
        if (Array.isArray(cards) && cards.length >= 1) return true;
      }
    } catch (_) { /* ignore */ }
    return false;
  }

  function isJobDetailPage() {
    // LaPieza listing/marketing paths historically were a hard denylist here
    // (so the FAB stayed off the home/search routes). With the best-matches
    // panel work we DO want the FAB to mount on listing pages — but with a
    // different label and a different click handler. To keep the call sites
    // (mountFab/unmountFab in detectAndMount) untouched, we now return true
    // for both job-detail AND listing pages, and let the FAB click router
    // branch on isListingPage() vs isApplyPage() vs JOB_URL_PATTERNS.
    //
    // Pages that should still NOT mount the FAB at all (employer landing,
    // login, etc.) stay on the denylist.
    const path = location.pathname || "";
    const DENY_PATHS = [
      /^\/soy[- ]?empresa\/?/i,
      /^\/mi[- ]?perfil\/?/i,
      /^\/profile\/?/i,
      /^\/login\/?/i,
      /^\/signup\/?/i,
      /^\/registro\/?/i,
      /^\/about\/?/i,
      /^\/contacto\/?/i,
      /^\/blog\/?/i,
      /^\/precios\/?/i,
      /^\/pricing\/?/i
    ];
    if (DENY_PATHS.some((re) => re.test(path))) return false;
    // Trailing-bare paths like /vacancy or /vacante (no UUID) — old listing
    // aliases without cards. Let isListingPage's DOM probe decide instead of
    // refusing outright; if no cards render we fall through to false.
    if (/\/(vacancy|vacante|jobs|empleos|puesto)\/?$/i.test(path)) {
      return isListingPage();
    }

    // Apply pages always count — the user wants the panel here even though
    // the page has no JSON-LD or job description: we already cached the job
    // on /vacancy/<uuid> and we'll restore it from session storage.
    if (isApplyPage()) return true;

    // Job-detail URL — Express/Review flow.
    if (JOB_URL_PATTERNS.some((re) => re.test(location.href))) return true;

    // Listing route — Best-matches flow.
    return isListingPage();
  }

  // Persist the job extracted from /vacancy/<uuid> so we can restore it on
  // /apply/<same-uuid>. We use chrome.storage.session because:
  //   - it's automatically cleared when the browser closes (no stale data)
  //   - it's per-extension, not exposed to the page
  //   - it survives SPA navigation and even hard reloads within a session
  //
  // Both reads/writes are best-effort: if storage isn't available the flow
  // still works (FAB just falls back to whatever extractJob can read off
  // the apply page).
  function jobCacheKey(url) {
    const id = idFromUrl(url || location.href);
    return JOB_CACHE_PREFIX + id;
  }
  function persistJobToSession(job) {
    if (!job || !chrome?.storage?.session) return;
    try {
      const key = jobCacheKey(job.url || location.href);
      // chrome.storage.session.set returns a Promise in MV3; without a
      // .catch() handler the rejection becomes an unhandled exception
      // ("Access to storage is not allowed from this context") that
      // surfaced as a click-handler abort during live testing. Always
      // attach a noop catch.
      Promise.resolve(chrome.storage.session.set({ [key]: job })).catch(() => {});
    } catch (_) { /* ignore */ }
  }
  async function restoreJobFromSession() {
    if (!chrome?.storage?.session) return null;
    try {
      const key = jobCacheKey(location.href);
      const obj = await new Promise((resolve) => {
        chrome.storage.session.get([key], (r) => resolve(r || {}));
      });
      const job = obj && obj[key];
      if (job && typeof job === "object" && job.title) return job;
    } catch (_) { /* ignore */ }
    return null;
  }

  // -------------------------------------------------------------------------
  // Express Mode — toggle + pre-warmed draft cache
  // -------------------------------------------------------------------------

  // Best-effort read of the Express toggle from chrome.storage.local. Default
  // is true (Express ON) when the key is missing — same default as options.js.
  // Resolves to a boolean; never rejects. Side effect: updates cachedExpressMode
  // so synchronous code paths (like detectCoverLetterTextarea) can skip the
  // legacy in-flow assistant when Express is on.
  let cachedExpressMode = true;
  function readExpressMode() {
    return new Promise((resolve) => {
      try {
        if (!chrome?.storage?.local) { resolve(true); return; }
        chrome.storage.local.get([EXPRESS_MODE_STORAGE_KEY], (r) => {
          const v = r && r[EXPRESS_MODE_STORAGE_KEY];
          const resolved = typeof v === "boolean" ? v : true;
          cachedExpressMode = resolved;
          resolve(resolved);
        });
      } catch (_) { resolve(true); }
    });
  }
  // Prime the cache on boot + react to changes in another tab/options page.
  try {
    readExpressMode();
    if (chrome?.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        const c = changes[EXPRESS_MODE_STORAGE_KEY];
        if (c && typeof c.newValue === "boolean") cachedExpressMode = c.newValue;
      });
    }
  } catch (_) { /* ignore */ }

  function draftCacheKey(url) {
    const id = idFromUrl(url || location.href);
    return DRAFT_CACHE_PREFIX + id;
  }
  function persistDraftToSession(draft) {
    if (!draft || !chrome?.storage?.session) return;
    try {
      const key = draftCacheKey(location.href);
      Promise.resolve(chrome.storage.session.set({ [key]: draft })).catch(() => {});
    } catch (_) { /* ignore */ }
  }
  async function restoreDraftFromSession() {
    if (!chrome?.storage?.session) return null;
    try {
      const key = draftCacheKey(location.href);
      const obj = await new Promise((resolve) => {
        chrome.storage.session.get([key], (r) => resolve(r || {}));
      });
      const draft = obj && obj[key];
      if (draft && typeof draft === "object" && (draft.coverLetter || draft.id)) return draft;
    } catch (_) { /* ignore */ }
    return null;
  }
  function clearDraftSession(url) {
    if (!chrome?.storage?.session) return;
    try {
      Promise.resolve(
        chrome.storage.session.remove(draftCacheKey(url || location.href))
      ).catch(() => {});
    } catch (_) { /* ignore */ }
  }

  // Pre-warm the cover-letter generation in the background while the user is
  // still on /vacancy/<uuid>. By the time they click "Postularme" → land on
  // /apply/<uuid>, the draft is already in chrome.storage.session and the
  // Express fill can paste it instantly. Silent on errors — the apply-page
  // FAB click will fall back to a fresh request.
  async function prewarmExpressDraft(job) {
    if (!job || !job.title) return;
    try {
      const res = await sendMsg({ type: MSG.GENERATE_DRAFT, job });
      if (!res || !res.ok) return; // silent: user hasn't done anything wrong yet
      const draft = res.draft || null;
      if (draft) {
        // Stash the draft under the matching uuid key so /apply/<uuid> finds it.
        try {
          if (chrome?.storage?.session) {
            const key = DRAFT_CACHE_PREFIX + idFromUrl(job.url || location.href);
            Promise.resolve(
              chrome.storage.session.set({ [key]: { ...draft, id: res.draftId || draft.id || null } })
            ).catch(() => {});
          }
        } catch (_) {}
      }
    } catch (_) { /* silent */ }
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
      // 1) UUID in /vacancy/<uuid>, /apply/<uuid>, /postular/<uuid>, etc.
      // Critical: vacancy and apply MUST resolve to the same id so the
      // session-storage cache key matches across the navigation.
      const uuidMatch = u.pathname.match(
        /\/(?:vacancy|vacante|jobs|empleos|puesto|apply|postular|postularse|aplicar|postulacion|application)\/([a-f0-9][a-f0-9-]{7,})/i
      );
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
  // Adaptive question scanner
  // =========================================================================
  // LaPieza (and ATSes generally) inject the apply form with arbitrary
  // open-ended question fields — e.g. "¿Por qué eres la persona ideal para
  // este puesto?" or "Cuéntanos sobre tu experiencia con X". We can't enumerate
  // these client-side, so we ship a heuristic scanner: walk all <textarea> and
  // long <input type="text"> nodes, classify each by its surrounding text, and
  // batch the survivors to the backend. Cap at 10 to bound Gemini cost.

  // Question heuristic: text length > 25, ends in "?" or contains question
  // words. Greedy on purpose — false positives waste a Gemini call but false
  // negatives leave the user stuck typing manually.
  const QUESTION_WORDS_RX = /\b(por\s*qu[eé]|qu[eé]|c[oó]mo|cu[aá]l|cu[aá]les|describe|explica|cu[eé]ntanos|comparte|dinos|platic[ae]nos|h[aá]blanos|qu[eé]\s+te|por\s*qu[eé])\b/i;
  function looksLikeQuestion(text) {
    if (!text) return false;
    const t = text.trim();
    if (t.length < 6) return false;
    if (t.length > 25) return true;
    if (/\?\s*$/.test(t)) return true;
    if (QUESTION_WORDS_RX.test(t)) return true;
    return false;
  }

  // Skip-list for fields that look like basic profile info — we already fill
  // those via fillForm/buildFormFields. The match is deliberately broad: a
  // single token hit is enough to skip the field.
  const QUESTION_SKIP_RX = /\b(nombre|name|email|correo|phone|tel[eé]fono|celular|m[oó]vil|whats?app|ubicaci[oó]n|location|ciudad|direcci[oó]n|address|zip|postal|c[oó]digo\s*postal|edad|age|rfc|curp|fecha\s+de\s+nacimiento|birthdate|birth[- ]?date|date\s+of\s+birth|cv|curriculum|currículum|resume|hoja\s+de\s+vida|linkedin|website|sitio\s*web|portafolio|portfolio|salario|sueldo|expectativa|salary|password|contraseña|usuario|username)\b/i;

  // Pull the most-likely question text for a given field. Priority:
  //  1) <label for=fieldId> textContent (canonical)
  //  2) wrapping <label>
  //  3) the field's `placeholder`
  //  4) the field's `aria-label`
  //  5) a sibling/parent heading (h1-h4) within 4 DOM levels
  // Returns trimmed text or "".
  function questionTextFor(el) {
    const tryText = (s) => (s || "").replace(/\s+/g, " ").trim();
    // 1) Explicit label
    if (el.id) {
      try {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) {
          const t = tryText(lbl.textContent);
          if (t) return t;
        }
      } catch (_) {}
    }
    // 2) Wrapping label
    const wrap = el.closest("label");
    if (wrap) {
      // Strip the input's own value if any (rare but possible for label > input).
      const t = tryText(wrap.textContent);
      if (t) return t;
    }
    // 3) Placeholder
    const ph = tryText(el.getAttribute("placeholder"));
    if (ph) return ph;
    // 4) aria-label
    const al = tryText(el.getAttribute("aria-label"));
    if (al) return al;
    // 5) Walk ancestors looking for headings/legends within 4 levels.
    let p = el.parentElement;
    let depth = 0;
    while (p && depth < 4) {
      // Direct heading inside the parent
      const h = p.querySelector("h1, h2, h3, h4, legend");
      if (h && h.contains(el) === false) {
        const t = tryText(h.textContent);
        if (t && t.length < 280) return t;
      }
      // Previous sibling heading
      const prev = p.previousElementSibling;
      if (prev && /^(H[1-4]|LEGEND|P|DIV|SPAN)$/i.test(prev.tagName)) {
        const t = tryText(prev.textContent);
        if (t && t.length < 280) return t;
      }
      p = p.parentElement;
      depth++;
    }
    return "";
  }

  // Stable identifier for a field so we can re-resolve it after the panel
  // re-renders or after a brief SPA repaint. Prefer existing `id`; otherwise
  // stamp a fresh data-eamx-q-id attribute.
  function ensureFieldRef(el) {
    if (el.id) return el.id;
    const existing = el.getAttribute("data-eamx-q-id");
    if (existing) return existing;
    questionRefSeq += 1;
    const ref = `eamx-q-${Date.now().toString(36)}-${questionRefSeq}`;
    try { el.setAttribute("data-eamx-q-id", ref); } catch (_) {}
    return ref;
  }

  // Resolve a fieldRef back to a live DOM node. Works whether the ref points
  // at a real id or a stamped data-eamx-q-id attribute.
  function resolveFieldRef(ref) {
    if (!ref) return null;
    try {
      const byId = document.getElementById(ref);
      if (byId) return byId;
    } catch (_) {}
    try {
      const escaped = (typeof CSS !== "undefined" && CSS.escape) ? CSS.escape(ref) : ref.replace(/"/g, "\\\"");
      return document.querySelector(`[data-eamx-q-id="${escaped}"]`);
    } catch (_) {
      return null;
    }
  }

  // Scan the live DOM for open-ended question fields. Returns up to 10
  // candidates ordered roughly by document order. Idempotent — does NOT
  // mutate detectedQuestions; the caller decides when to commit.
  function scanQuestionFields() {
    const candidates = Array.from(document.querySelectorAll(
      "textarea, input[type='text']"
    ));
    const out = [];
    const seenRefs = new Set();
    for (const el of candidates) {
      if (out.length >= 10) break;
      // Visibility: skip hidden/zero-area inputs.
      if (!isVisible(el)) continue;
      // Skip if disabled or read-only — user can't fill them anyway.
      if (el.disabled || el.readOnly) continue;
      // Pull question text from labels/placeholder/headings.
      const question = questionTextFor(el);
      if (!question) continue;
      // Drop boring profile-info fields.
      const ctxHay = `${question} ${el.name || ""} ${el.id || ""} ${el.getAttribute("placeholder") || ""}`;
      if (QUESTION_SKIP_RX.test(ctxHay)) continue;
      // Apply the question heuristic.
      if (!looksLikeQuestion(question)) continue;
      // Stamp/ensure ref + dedupe.
      const fieldRef = ensureFieldRef(el);
      if (seenRefs.has(fieldRef)) continue;
      seenRefs.add(fieldRef);
      out.push({ el, question, fieldRef });
    }
    return out;
  }

  // =========================================================================
  // FAB
  // =========================================================================

  // Decide which FAB mode applies to the current URL. Returns one of:
  //   "apply"    — on /apply/<uuid>; existing Express fill flow.
  //   "vacancy"  — on /vacancy/<uuid>; existing Express pre-warm flow.
  //   "listing"  — on /, /vacantes, /comunidad/jobs, etc.; opens best-matches.
  // Defaults to "vacancy" if we somehow can't classify (preserves old behavior).
  function fabMode() {
    if (isApplyPage()) return "apply";
    // Match vacancy detail URLs in BOTH formats:
    //   /vacancy/<uuid>  — canonical (e.g. /vacancy/9726cb82-...)
    //   /vacante/<slug>  — slug form with optional 6-hex suffix
    //                     (e.g. /vacante/data-analyst-...-50ce33)
    //
    // Bug history: the previous regex required the segment to start
    // with hex chars, which missed every slug-form vacancy URL — so
    // the FAB on a real vacancy page said "Mejores matches" instead
    // of "Postular con IA" because fabMode fell through to "listing".
    //
    // Now we accept any non-empty segment after /vacancy/ or /vacante/.
    // Trailing-slash / empty-segment listing roots (/vacante, /vacante/)
    // are still rejected by the [^/?#]+ requirement.
    const path = location.pathname || "";
    if (/\/(?:vacancy|vacante)\/[^/?#]+/i.test(path)) return "vacancy";
    if (isListingPage()) return "listing";
    // Fallback — older /jobs/<slug>/, /empleos/<slug>/ detail pages.
    if (JOB_URL_PATTERNS.some((re) => re.test(location.href))) return "vacancy";
    return "vacancy";
  }

  function mountFab() {
    if (fabEl && document.body.contains(fabEl)) {
      // Already mounted — but the user may have navigated between modes
      // without unmounting (SPA route change inside detectAndMount), OR
      // another content-script re-injection cycle could leave us with a
      // stale node whose original click listener has been lost (live test
      // verified: dispatchEvent on the visible FAB confirmed click was
      // received by the element, but onFabClick never ran). Defensive
      // re-attach: remove + add is a no-op if the listener was still
      // there, but recovers when it isn't.
      try { fabEl.removeEventListener("click", onFabClick); } catch (_) {}
      fabEl.addEventListener("click", onFabClick);
      paintFabLabel();
      return;
    }
    // If a stale FAB from a previous content-script instance is still in
    // the DOM (e.g. F5 re-injected the script but didn't clean up the
    // previous DOM node), nuke it before creating a fresh one. Otherwise
    // we'd end up with two FABs visually overlapping.
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

    // Side effect: when mounting on a vacancy page, eagerly extract & cache
    // the job so it survives the navigation to /apply/<uuid>. We run after
    // a short delay to let the page settle (LaPieza renders JSON-LD late
    // on some routes). On apply pages we do nothing — the FAB click will
    // restore from cache. On listing pages we also skip — there's no single
    // job to extract.
    if (fabMode() === "vacancy") {
      setTimeout(() => {
        try {
          const { job, partial } = extractJob();
          if (!partial && job && job.title && job.title !== "(sin título)") {
            persistJobToSession(job);
          }
        } catch (_) { /* ignore */ }
      }, 1500);
    }
  }

  // Repaint the FAB icon, label, and aria-label so they reflect the current
  // route mode. Called after mount and after every SPA URL change.
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
      if (b) {
        lbl.textContent = "Generando";
      } else {
        // Restore the mode-appropriate label.
        paintFabLabel();
      }
    }
  }

  // Top-level FAB dispatcher. Branches on the page mode:
  //   - Listing page (/, /vacantes, /comunidad/jobs, etc.) → openBestMatchesPanel
  //   - Express ON  + /vacancy/<uuid> → pre-warm draft + show "ready" toast
  //   - Express ON  + /apply/<uuid>   → run full Express fill (carta + cv + answers)
  //   - Express OFF (any non-listing) → legacy panel flow (current behavior)
  async function onFabClick() {
    if (!fabEl || fabEl.disabled) return;
    // Listing branch — Express toggle is irrelevant here, the panel is read-only.
    if (fabMode() === "listing") return openBestMatchesPanel();

    // If this vacancy is in the user's queue, mark it as "postulando_ahora"
    // so the dashboard pill flips to cyan-pulse in real time. We do this
    // before kicking off any generation so even if the request fails, the
    // user can still see in their dashboard "tried to apply at X time".
    // Best-effort: ensureDiscoveryDeps lazy-loads lib/queue.js the first
    // time we need it; a load failure (rare, ad-blocker chains) silently
    // skips this — the FAB action still proceeds normally.
    try {
      await ensureDiscoveryDeps();
      if (queueModule && typeof queueModule.touchOpened === "function") {
        const id = idFromUrl(location.href);
        if (id) await queueModule.touchOpened(id, SOURCE);
      }
    } catch (_) { /* swallow */ }

    let express = true;
    try { express = await readExpressMode(); } catch (_) { express = true; }
    if (!express) return onFabClickReview();
    if (isApplyPage()) return onFabClickExpressApply();
    return onFabClickExpressVacancy();
  }

  // Legacy "Revisión completa" path. Identical to the original onFabClick:
  // generate the draft, open the panel, let the user review/edit/approve.
  async function onFabClickReview() {
    let { job, partial } = extractJob();

    // If we're on the apply form, the page has no job description — we
    // need the cached job from when the user was on /vacancy/<uuid>. If
    // there's no cache (e.g. user landed straight on /apply/ via shared
    // link), we still let the request through with whatever metadata we
    // could pull off the apply sidebar; the backend will surface the
    // 422 thin-payload error if it's truly empty.
    if (isApplyPage()) {
      const cached = await restoreJobFromSession();
      if (cached) {
        job = cached;
        partial = false;
      }
    }

    lastJob = job;
    persistJobToSession(job);

    if (partial && job.title === "(sin título)" && job.company === "(empresa desconocida)") {
      toast("Abre primero la vacante (página /vacancy/...) para que la IA la lea, luego dale a Postular.", "info");
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

  // Express FAB click on /vacancy/<uuid>. Job-extract, persist, kick off
  // background draft generation, show a toast pointing at LaPieza's own
  // "Postularme" button. We do NOT auto-click that button — HITL.
  // Read the quick-apply flag set by the matches panel's "⚡ Postular →"
  // button and chain the entire apply flow:
  //   1. pre-warm cover letter
  //   2. countdown 3s (Esc cancels — same kill switch contract as Modo Auto)
  //   3. auto-click LaPieza's "¡Me quiero postular!" button
  //   4. auto-confirm the location-warning modal if it appears
  //   5. on /apply/<uuid> arrival, auto-fire Express fill (no FAB click)
  //   6. auto-quiz already kicks in independently for the knowledge test
  //   7. STOP at "Finalizar" — that's the user's HITL clic final
  //
  // Best-effort: any failure aborts gracefully and falls back to the
  // user clicking the FAB / Postularme themselves.
  let quickApplyAborted = false;
  let quickApplyEscHandler = null;
  async function maybeAutoPrewarmFromQuickApply() {
    if (!chrome?.storage?.session) return;
    let id = "";
    try { id = idFromUrl(location.href); } catch (_) {}
    if (!id) return;
    // Two flag flavors for backwards compat. The new chain uses
    // eamx:quickapply:<id>; older builds wrote eamx:autoprewarm:<id>.
    const quickKey = `eamx:quickapply:${id}`;
    const oldKey = `eamx:autoprewarm:${id}`;
    let flag = null;
    let usedKey = "";
    try {
      flag = await new Promise((resolve) => {
        chrome.storage.session.get([quickKey, oldKey], (r) => {
          if (r && r[quickKey]) { usedKey = quickKey; resolve(r[quickKey]); return; }
          if (r && r[oldKey]) { usedKey = oldKey; resolve(r[oldKey]); return; }
          resolve(null);
        });
      });
    } catch (_) { return; }
    if (!flag) return;
    // Stale-flag guard.
    if (Date.now() - (flag.setAt || 0) > 5 * 60_000) {
      try { Promise.resolve(chrome.storage.session.remove([quickKey, oldKey])).catch(() => {}); } catch (_) {}
      return;
    }
    // Clear the flag immediately so a page refresh doesn't re-fire.
    try { Promise.resolve(chrome.storage.session.remove([quickKey, oldKey])).catch(() => {}); } catch (_) {}

    // Branch by flag type:
    // - autoprewarm flag (legacy) → just pre-warm + toast
    // - quickapply flag (new chain) → pre-warm + auto-click LaPieza CTAs
    if (usedKey === oldKey) {
      try { onFabClickExpressVacancy(); } catch (_) {}
      return;
    }
    // New chain — full quick-apply.
    try { onFabClickExpressVacancy(); } catch (_) {}
    // 3s countdown with Esc kill switch, then click LaPieza's
    // "¡Me quiero postular!" button.
    quickApplyAborted = false;
    quickApplyEscHandler = (ev) => {
      if (ev.key === "Escape" || ev.key === "Esc") {
        quickApplyAborted = true;
        try { document.removeEventListener("keydown", quickApplyEscHandler, true); } catch (_) {}
        quickApplyEscHandler = null;
        toast("Postular cancelado. Continúa manual.", "info");
      }
    };
    try { document.addEventListener("keydown", quickApplyEscHandler, true); } catch (_) {}
    toast("⚡ Auto-postulando en 3s… (Esc cancela)", "info", { durationMs: 3500 });
    await new Promise((r) => setTimeout(r, 3000));
    if (quickApplyAborted) return;
    // Find LaPieza's apply CTA.
    const applyBtn = findLaPiezaApplyCTA();
    if (!applyBtn) {
      toast("No encontré el botón Postularme. Dale clic tú.", "info");
      return;
    }
    // Set a generic "next /apply/ should auto-fire Express" flag BEFORE
    // we click — the click triggers SPA navigation to /apply/<uuid>, and
    // because the apply UUID differs from the /vacante/ slug-id, we can't
    // re-use the per-id flag. The next-apply flag is consumed by
    // maybeAutoFireExpressOnApply() on the apply page.
    try {
      Promise.resolve(
        chrome.storage.session.set({
          "eamx:quickapply:next-apply": { setAt: Date.now() }
        })
      ).catch(() => {});
    } catch (_) {}
    try { applyBtn.click(); } catch (_) {}
    // Wait briefly for the location-warning modal to appear, then click
    // "Sí, continuar con postulación" if visible.
    for (let i = 0; i < 8; i++) {
      if (quickApplyAborted) return;
      await new Promise((r) => setTimeout(r, 350));
      const continueBtn = findLaPiezaLocationContinueCTA();
      if (continueBtn) {
        try { continueBtn.click(); } catch (_) {}
        break;
      }
      // If URL already changed to /apply/, no modal appeared — done.
      if (isApplyPage()) break;
    }
    // Cleanup esc listener — the rest of the chain (Express on /apply/,
    // auto-quiz on test) is handled independently.
    try {
      if (quickApplyEscHandler) document.removeEventListener("keydown", quickApplyEscHandler, true);
    } catch (_) {}
    quickApplyEscHandler = null;
  }

  // Apply-side handler for the quick-apply chain. Runs on /apply/<uuid>
  // arrival. If the "next-apply" flag was set on /vacante/ during the
  // chain (and is fresh — set within last 60s), auto-fire Express fill
  // without waiting for a FAB click. Then clear the flag so a refresh
  // doesn't re-fire.
  //
  // Idempotency: clears the flag immediately so this only ever fires
  // once per chain. If anything throws, the user can still click the FAB
  // manually as the fallback.
  async function maybeAutoFireExpressOnApply() {
    if (!chrome?.storage?.session) return;
    const key = "eamx:quickapply:next-apply";
    let flag = null;
    try {
      flag = await new Promise((resolve) => {
        chrome.storage.session.get([key], (r) => resolve(r ? r[key] : null));
      });
    } catch (_) { return; }
    if (!flag) return;
    // Stale guard — 60s window between vacancy click and apply arrival.
    if (Date.now() - (flag.setAt || 0) > 60_000) {
      try { Promise.resolve(chrome.storage.session.remove([key])).catch(() => {}); } catch (_) {}
      return;
    }
    // Clear immediately so refreshes don't re-fire.
    try { Promise.resolve(chrome.storage.session.remove([key])).catch(() => {}); } catch (_) {}
    // Give LaPieza a beat to render the apply form before we start.
    await new Promise((r) => setTimeout(r, 800));
    // Run the multi-step chain: walk through CV step → cover letter →
    // Q&A → quiz (auto-quiz handles) → STOP at Finalizar.
    try { chainApplyStepsToFinalize(); } catch (_) {}
  }

  // Multi-step apply-flow chain. LaPieza's apply form has multiple
  // sub-steps on the same /apply/<uuid> URL — content swaps per step:
  //
  //   1. CV selection      → no fillable fields, just click Continuar
  //   2. Cover letter      → Express fills via prewarmed draft + Continuar
  //   3. Adaptive Q&A      → Express fills via answer-questions API
  //   4. Knowledge quiz    → auto-quiz module handles its own loop
  //   5. Final review      → STOP, highlight Finalizar (HITL)
  //
  // We poll once per step (cap 8 iterations as a safety net), call
  // runExpressFill ONLY when there's actual work to do (skip noisy
  // overlay on CV/review steps), and click Continuar to advance. We
  // never click Finalizar — that's the user's HITL contract.
  //
  // Kill switches:
  //   - Esc during any wait → quickApplyAborted = true, exit
  //   - Page leaves /apply/  → exit (user navigated away)
  //   - 8 iterations         → toast + exit (safety cap)
  async function chainApplyStepsToFinalize() {
    quickApplyAborted = false;
    quickApplyEscHandler = (ev) => {
      if (ev.key === "Escape" || ev.key === "Esc") {
        quickApplyAborted = true;
        try { document.removeEventListener("keydown", quickApplyEscHandler, true); } catch (_) {}
        quickApplyEscHandler = null;
        toast("Cadena cancelada. Continúa manual.", "info");
      }
    };
    try { document.addEventListener("keydown", quickApplyEscHandler, true); } catch (_) {}

    toast("⚡ Cadena: te llevo paso a paso… (Esc cancela)", "info", { durationMs: 4500 });

    for (let i = 0; i < 8; i++) {
      if (quickApplyAborted) break;
      if (!isApplyPage()) break;

      // Wait for current step's DOM to settle before scanning. After a
      // Continuar click LaPieza needs ~600-1200ms to swap step content;
      // 1000ms is a safe middle ground.
      await new Promise((r) => setTimeout(r, 1000));
      if (quickApplyAborted) break;
      if (!isApplyPage()) break;

      // Quiz step → auto-quiz module handles. Wait for its radios to
      // disappear before we look for Continuar. Cap wait at 90s in case
      // the quiz hangs.
      if (looksLikeQuizStep()) {
        const startedAt = Date.now();
        while (looksLikeQuizStep() && Date.now() - startedAt < 90_000) {
          if (quickApplyAborted) break;
          await new Promise((r) => setTimeout(r, 1500));
        }
        if (quickApplyAborted) break;
        continue;
      }

      // Final step → STOP. Highlight + tell user to dale Finalizar.
      if (findApplyFlowFinalizeBtn()) {
        try { highlightExpressSubmitButton(); } catch (_) {}
        toast("✓ Listo. Revisa todo y dale Finalizar.", "success", { durationMs: 6000 });
        break;
      }

      // Has fillable fields on THIS step? Run Express fill (opens overlay,
      // generates cover letter / Q&A answers, fills them). Skip when there's
      // nothing to fill (CV step, review step) so we don't show a noisy
      // overlay on every step.
      //
      // skipCv:true → the chain NEVER triggers our CV generation pipeline
      // (which opens a print-to-PDF tab, jarring during an automated flow
      // and the user already has LaPieza's "PRINCIPAL" CV pre-selected).
      // The FAB still triggers tailored CV generation manually if the
      // user wants it.
      let hasCover = false, hasQuestions = false;
      try { hasCover = !!findExpressCoverLetterField(); } catch (_) {}
      try { hasQuestions = (scanQuestionFields() || []).length > 0; } catch (_) {}
      if (hasCover || hasQuestions) {
        try { await onFabClickExpressApply({ skipCv: true }); } catch (_) {}
        // runExpressFill ends with overlay.hide() ~1.5s after the final
        // toast. Wait for that to clear before we click Continuar so the
        // user can see what got filled.
        await new Promise((r) => setTimeout(r, 2200));
        if (quickApplyAborted) break;
        if (!isApplyPage()) break;
      }

      // Click Continuar to advance.
      const continueBtn = findApplyFlowContinueBtn();
      if (continueBtn) {
        try { continueBtn.click(); } catch (_) {}
      }
      // If neither Continuar nor Finalizar is visible, we'll loop again
      // (the DOM may still be settling after a previous click).
    }

    // Cleanup esc listener.
    try {
      if (quickApplyEscHandler) document.removeEventListener("keydown", quickApplyEscHandler, true);
    } catch (_) {}
    quickApplyEscHandler = null;
  }

  // Heuristic: are we on a quiz step? Quiz steps have multiple visible
  // radio buttons inside option-card structures. CV-selection radios
  // (also radios) live inside cards labelled "PRINCIPAL" / "CV - ...";
  // we exclude those.
  function looksLikeQuizStep() {
    let radios = [];
    try { radios = Array.from(document.querySelectorAll('input[type="radio"]')); } catch (_) { return false; }
    let count = 0;
    for (const r of radios) {
      try {
        if (!isVisible(r)) continue;
      } catch (_) { continue; }
      const ctx = r.closest("label, [class*='option' i], [class*='question' i], [class*='quiz' i], [class*='answer' i]");
      if (!ctx) continue;
      const txt = (ctx.textContent || "").toLowerCase();
      // Exclude CV-selection cards.
      if (/principal|hoja\s*de\s*vida|^cv\s*-/i.test(txt)) continue;
      count++;
      if (count >= 2) return true;
    }
    return false;
  }

  // Match LaPieza's apply-flow "Continuar" button (NOT the final submit).
  // Strict text match so we don't grab "Continuar leyendo" or similar
  // unrelated CTAs. Excludes our own UI by class.
  function findApplyFlowContinueBtn() {
    const rx = /^continuar$|^siguiente$|^next$/i;
    const candidates = Array.from(document.querySelectorAll("button, a[role=button]"));
    return candidates.find((el) => {
      try {
        if (el.closest(".eamx-fab, .eamx-panel, .eamx-overlay, .eamx-matches-panel, .eamx-toast, [data-eamx]")) return false;
      } catch (_) { /* ignore */ }
      const t = (el.textContent || "").trim();
      if (!rx.test(t)) return false;
      try { return isVisible(el) && !el.disabled; } catch (_) { return false; }
    }) || null;
  }

  // Match LaPieza's FINAL submit button (Finalizar / Enviar postulación).
  // Stricter than findLaPiezaSubmitButton — that one matches "postular"
  // too and would false-positive on our own FAB ("Postular con IA").
  // Used by the chain to detect "we're at the final step, STOP".
  function findApplyFlowFinalizeBtn() {
    const rx = /^finalizar(\s+postulaci[oó]n)?$|^enviar(\s+postulaci[oó]n)?$/i;
    const candidates = Array.from(document.querySelectorAll("button, a[role=button], input[type=submit]"));
    return candidates.find((el) => {
      try {
        if (el.closest(".eamx-fab, .eamx-panel, .eamx-overlay, .eamx-matches-panel, .eamx-toast, [data-eamx]")) return false;
      } catch (_) { /* ignore */ }
      const t = ((el.textContent || el.value || "")).trim();
      if (!rx.test(t)) return false;
      try { return isVisible(el) && !el.disabled; } catch (_) { return false; }
    }) || null;
  }

  // LaPieza's primary apply CTA on /vacante/<slug>. Text variants seen
  // live: "¡Me quiero postular!", "Postularme", "Aplicar". Match any
  // visible button containing those.
  function findLaPiezaApplyCTA() {
    const rx = /^[\s¡!]*me\s+quiero\s+postular[\s!.]*$|^postularme$|^aplicar(?:\s+ahora)?$/i;
    const candidates = Array.from(document.querySelectorAll("button, a[role=button]"));
    return candidates.find((el) => {
      const t = (el.textContent || "").trim();
      if (!rx.test(t)) return false;
      try { return isVisible(el) && !el.disabled; } catch (_) { return false; }
    }) || null;
  }

  // The location-mismatch warning modal LaPieza shows when the user's
  // profile city differs from the vacancy's. Confirm CTA: "Sí, continuar
  // con postulación" / variants. We look for a red-styled / primary
  // button inside a visible modal.
  function findLaPiezaLocationContinueCTA() {
    const rx = /^s[ií],?\s+continuar(\s+con\s+postulaci[oó]n)?$/i;
    const candidates = Array.from(document.querySelectorAll("button"));
    return candidates.find((el) => {
      const t = (el.textContent || "").trim();
      if (!rx.test(t)) return false;
      try { return isVisible(el) && !el.disabled; } catch (_) { return false; }
    }) || null;
  }

  async function onFabClickExpressVacancy() {
    let job, partial;
    try {
      ({ job, partial } = extractJob());
    } catch (_) {
      toast("No pudimos leer esta vacante. Intenta de nuevo.", "error");
      return;
    }
    if (partial && job.title === "(sin título)" && job.company === "(empresa desconocida)") {
      toast("Abre primero la vacante (página /vacancy/...) para que la IA la lea.", "info");
      return;
    }
    lastJob = job;
    persistJobToSession(job);
    // Fire-and-forget — generation typically takes 6-15s; the user will
    // navigate to /apply/<uuid> in that window. If they're faster, the
    // apply-side click will simply re-request.
    prewarmExpressDraft(job);
    toast("⚡ Listo. Dale 'Postularme' y te lleno todo.", "info", { durationMs: 4000 });
  }

  // Express FAB click on /apply/<uuid>. Restore job + draft from session,
  // show progress overlay, fire 3 parallel requests, fill fields as each
  // resolves. See runExpressFill JSDoc for full guarantees.
  //
  // opts.skipCv (default false) → don't run the CV-generation pipeline.
  // Used by the quick-apply chain to avoid opening a print-to-PDF tab
  // mid-flow when LaPieza already has a "PRINCIPAL" CV pre-selected.
  async function onFabClickExpressApply(opts = {}) {
    const { job: extracted, partial } = extractJob();
    let job = extracted;
    const cached = await restoreJobFromSession();
    if (cached) {
      job = cached;
    } else if (partial && job.title === "(sin título)" && job.company === "(empresa desconocida)") {
      // Deep-linked user — no cached context, can't run Express safely.
      toast(
        "Abre primero la vacante desde LaPieza, así tengo el contexto completo.",
        "info"
      );
      return;
    }
    lastJob = job;
    persistJobToSession(job);

    // Pre-warmed draft (if any) lives in chrome.storage.session.
    const prewarmed = await restoreDraftFromSession();
    if (prewarmed) {
      lastDraft = prewarmed;
      activeDraftId = prewarmed.id || null;
    }

    setFabBusy(true);
    try {
      await runExpressFill({ job, prewarmedDraft: prewarmed, skipCv: !!opts.skipCv });
    } catch (err) {
      console.warn("[EmpleoAutomatico] Express fill threw", err);
      toast(humanizeError(err), "error");
    } finally {
      setFabBusy(false);
    }
  }

  // =========================================================================
  // Modo Auto — premium-only optional auto-submit (gated 4 ways, 5 kill
  // switches). All identifiers prefixed with `auto` to avoid collisions
  // with the existing HITL helpers. See runExpressFill JSDoc for the full
  // list of guarantees and the documented exception.
  //
  // Gates (all must be true to even ATTEMPT a click):
  //   1) cachedProfile.plan === "premium"
  //   2) chrome.storage.local[AUTO_MODE] === true
  //   3) chrome.storage.local[AUTO_DISCLAIMER_SEEN] === true
  //   4) under daily cap (120 total / 30 per portal) AND not day-paused AND
  //      30s+ since last submit on any portal.
  //
  // Kill switches (any one halts the flow):
  //   1) Escape key during countdown
  //   2) Sanity recheck after countdown (URL drift, CAPTCHA appears, button
  //      disappears, fields cleared)
  //   3) CAPTCHA detection (pre-flight + post-countdown)
  //   4) Day-pause after 2 consecutive failures in the same session
  //   5) Inter-submit delay (30s minimum) — silent throttle
  // =========================================================================

  /**
   * Read the AUTO_MODE toggle from chrome.storage.local. Returns false on
   * any error (most defensive default — Modo Auto is opt-in).
   */
  async function readAutoMode() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([STORAGE_KEYS.AUTO_MODE], (r) => {
          resolve(!!(r && r[STORAGE_KEYS.AUTO_MODE]));
        });
      } catch (_) { resolve(false); }
    });
  }

  /** Has the user accepted the Modo Auto disclaimer modal? */
  async function readDisclaimerSeen() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([STORAGE_KEYS.AUTO_DISCLAIMER_SEEN], (r) => {
          resolve(!!(r && r[STORAGE_KEYS.AUTO_DISCLAIMER_SEEN]));
        });
      } catch (_) { resolve(false); }
    });
  }

  /** YYYY-MM-DD in local time. Used as the rollover key for daily counters. */
  function autoTodayKey() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }

  /**
   * Read the daily counter. Auto-resets when the date doesn't match today.
   * Shape: { date: "YYYY-MM-DD", count: number, perPortal: { [SOURCE]: n } }.
   */
  async function readAutoDaily() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([STORAGE_KEYS.AUTO_DAILY], (r) => {
          const v = r && r[STORAGE_KEYS.AUTO_DAILY];
          if (v && v.date === autoTodayKey()) resolve(v);
          else resolve({ date: autoTodayKey(), count: 0, perPortal: {} });
        });
      } catch (_) { resolve({ date: autoTodayKey(), count: 0, perPortal: {} }); }
    });
  }

  async function writeAutoDaily(value) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [STORAGE_KEYS.AUTO_DAILY]: value }, () => resolve());
      } catch (_) { resolve(); }
    });
  }

  /**
   * Day-pause record. Persists for the rest of the day after 2 consecutive
   * portal errors. Shape: { date: "YYYY-MM-DD", reason: string } | null.
   */
  async function readDayPause() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([STORAGE_KEYS.AUTO_DAY_PAUSE], (r) => {
          const v = r && r[STORAGE_KEYS.AUTO_DAY_PAUSE];
          if (v && v.date === autoTodayKey()) resolve(v);
          else resolve(null);
        });
      } catch (_) { resolve(null); }
    });
  }

  async function setDayPause(reason) {
    return autoWriteStorage(STORAGE_KEYS.AUTO_DAY_PAUSE, { date: autoTodayKey(), reason });
  }

  /** Last successful auto-submit timestamp (any portal). 0 means never. */
  async function readLastSubmitAt() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([STORAGE_KEYS.AUTO_LAST_SUBMIT_AT], (r) => {
          resolve(Number(r && r[STORAGE_KEYS.AUTO_LAST_SUBMIT_AT]) || 0);
        });
      } catch (_) { resolve(0); }
    });
  }

  /** Generic single-key writer — small helper used by setDayPause + the success path. */
  async function autoWriteStorage(key, value) {
    return new Promise((resolve) => {
      try { chrome.storage.local.set({ [key]: value }, () => resolve()); }
      catch (_) { resolve(); }
    });
  }

  /** Plan check — premium gate. Free/pro users never see auto-submit. */
  async function autoIsPremium() {
    await loadProfileOnce();
    return cachedProfile && cachedProfile.plan === "premium";
  }

  /**
   * Cap check — composite gate that combines the day-pause, total cap
   * (AUTO_TOTAL_CAP, currently 110), portal-specific cap (from
   * AUTO_PORTAL_CAPS keyed by SOURCE — 20 for lapieza), and the
   * inter-submit delay (30s minimum since last submit on ANY portal).
   * Returns { ok: true, daily, portalCount, portalCap } or
   * { ok: false, reason }.
   */
  async function canAutoSubmitNow() {
    // Day-pause check (unchanged).
    const dp = await readDayPause();
    if (dp) return { ok: false, reason: `Pausado hoy: ${dp.reason}` };

    const daily = await readAutoDaily();
    const total = daily.count || 0;
    const portalCap = AUTO_PORTAL_CAPS[SOURCE] ?? 20;
    const portalCount = (daily.perPortal && daily.perPortal[SOURCE]) || 0;

    if (total >= AUTO_TOTAL_CAP) {
      return { ok: false, reason: `Cap diario total alcanzado (${AUTO_TOTAL_CAP})` };
    }
    if (portalCount >= portalCap) {
      return { ok: false, reason: `Cap diario alcanzado en ${SOURCE} (${portalCap})` };
    }

    // Inter-submit delay (unchanged): 30s minimum since last submit.
    const last = await readLastSubmitAt();
    const elapsed = Date.now() - last;
    if (elapsed < 30000) {
      return { ok: false, reason: `Espera ${Math.ceil((30000 - elapsed) / 1000)}s antes del siguiente auto-submit` };
    }
    return { ok: true, daily, portalCount, portalCap };
  }

  /**
   * Locate LaPieza's Finalizar/submit button. We prefer a text match over a
   * generic [type=submit] selector to avoid clicking unrelated buttons (the
   * app shell sometimes has a "Guardar" button that's also type=submit).
   */
  function findLaPiezaSubmitButton() {
    // Mirror highlightExpressSubmitButton's selector cascade so the button
    // Modo Auto clicks is the SAME one the user just saw glowing. Previously
    // this used an anchored regex (^...$) which missed real LaPieza copy
    // like "Finalizar postulación" or "Enviar postulación", causing a
    // false-positive "no encontré el botón Finalizar" abort.
    const form = (typeof findApplicationForm === "function") ? findApplicationForm() : null;
    const scope = form || document;
    const candidates = Array.from(scope.querySelectorAll(
      "button, input[type=submit], a[role=button]"
    )).filter((el) => {
      try { return isVisible(el); } catch (_) { return true; }
    });
    const rx = /(finalizar|postularme|postular|enviar(?:\s+postulaci[oó]n)?|aplicar(?:\s+ahora)?|submit\s+application|send\s+application|apply)/i;
    const matches = candidates.filter((el) => {
      const t = ((el.textContent || el.value || "") + "").trim();
      return rx.test(t);
    });
    if (matches.length) {
      // Pick the largest by area — same heuristic as highlightExpressSubmitButton
      // so we click whatever the user is staring at.
      matches.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return (rb.width * rb.height) - (ra.width * ra.height);
      });
      return matches[0];
    }
    // Fallback: any submit button inside an apply form.
    if (form) {
      const sub = form.querySelector("button[type=submit], input[type=submit]");
      if (sub) return sub;
    }
    const anyForm = document.querySelector("form");
    if (anyForm) {
      const sub = anyForm.querySelector("button[type=submit], input[type=submit]");
      if (sub) return sub;
    }
    return null;
  }

  /**
   * Detect any visible CAPTCHA / hCaptcha / reCAPTCHA widget. We check both
   * the iframe src and the className/id heuristic. Returns the element so
   * the caller can log/scroll if needed; null if nothing is found.
   */
  function detectCaptcha() {
    return document.querySelector(
      'iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], ' +
      '[class*="captcha"], [class*="recaptcha"], [class*="hcaptcha"], ' +
      '[id*="captcha"], [id*="recaptcha"], [id*="hcaptcha"]'
    );
  }

  /**
   * Pre-flight + post-countdown sanity check. Returns { ok, reason }. Called
   * twice in maybeAutoSubmit — once before the countdown starts, once right
   * before the click — so the page has a chance to drift (CAPTCHA appears,
   * URL changes, fields get cleared by a SPA re-render) and we'll catch it.
   */
  function autoSubmitSanityCheck() {
    if (!isApplyPage()) return { ok: false, reason: "Ya no estás en la página de postulación" };
    const tas = Array.from(document.querySelectorAll("textarea"));
    const hasContent = tas.some((t) => (t.value || "").trim().length > 20);
    if (tas.length > 0 && !hasContent) return { ok: false, reason: "Los campos están vacíos" };
    if (detectCaptcha()) return { ok: false, reason: "CAPTCHA detectado, completa manual" };
    if (!findLaPiezaSubmitButton()) return { ok: false, reason: "No encontré el botón de Finalizar" };
    return { ok: true };
  }

  /**
   * Show a 3-5s countdown toast with an Escape kill switch. Returns
   * { cancel(), promise } — promise resolves true (proceed) on timeout,
   * false (abort) on cancel or Escape. The Escape listener is attached at
   * capture phase so it preempts page-level handlers.
   */
  function showAutoSubmitCountdown(seconds) {
    let cancelled = false;
    let escHandler = null;
    const controller = {
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        if (escHandler) {
          try { document.removeEventListener("keydown", escHandler, true); } catch (_) {}
          escHandler = null;
        }
      },
      promise: null
    };
    controller.promise = new Promise((resolve) => {
      let elapsed = 0;
      const tick = setInterval(() => {
        elapsed += 1;
        if (cancelled) {
          clearInterval(tick);
          if (escHandler) {
            try { document.removeEventListener("keydown", escHandler, true); } catch (_) {}
            escHandler = null;
          }
          resolve(false);
          return;
        }
        if (elapsed >= seconds) {
          clearInterval(tick);
          if (escHandler) {
            try { document.removeEventListener("keydown", escHandler, true); } catch (_) {}
            escHandler = null;
          }
          resolve(true);
        }
      }, 1000);
      escHandler = (ev) => {
        if (ev.key === "Escape") {
          controller.cancel();
          clearInterval(tick);
          resolve(false);
        }
      };
      try { document.addEventListener("keydown", escHandler, true); } catch (_) {}
      // Use a single info toast — toast() doesn't support a button click
      // handler that reaches back into our controller, so the Escape key is
      // the documented kill switch for v1.
      toast(`⚡ Modo Auto: enviando en ${seconds}s... (Esc para cancelar)`, "info", { durationMs: seconds * 1000 });
    });
    return controller;
  }

  /**
   * Build a minimal jobLite for queue + logging. Falls back to lastJob (the
   * cached vacancy from /vacancy/<uuid>) when the runExpressFill caller
   * didn't pass one through.
   */
  function extractJobLiteFromUrl(jobOverride) {
    const j = jobOverride || lastJob || null;
    return {
      id: idFromUrl(location.href),
      source: SOURCE,
      url: location.href,
      title: (j && j.title) || "",
      company: (j && j.company) || ""
    };
  }

  // Failure counter for the day-pause heuristic. Module-scoped (not stored)
  // — a page reload resets it, which is intentional: the user can keep going
  // manually after a reload, and the day-pause requires 2 in a row in the
  // SAME session to avoid spurious pauses across days.
  let autoSubmitFailStreak = 0;

  async function markAutoSubmitFailure() {
    autoSubmitFailStreak++;
    if (autoSubmitFailStreak >= 2) {
      await setDayPause("Dos errores consecutivos del portal");
      toast("⛔ Modo Auto pausado el resto del día. Vuelve mañana o aplica manual.", "error", { durationMs: 7000 });
      autoSubmitFailStreak = 0; // reset so the next session starts clean
    }
  }

  async function incrementAutoDaily() {
    const daily = await readAutoDaily();
    daily.count = (daily.count || 0) + 1;
    daily.perPortal = daily.perPortal || {};
    daily.perPortal[SOURCE] = (daily.perPortal[SOURCE] || 0) + 1;
    await writeAutoDaily(daily);
    return daily;
  }

  /**
   * The main hook. Called from runExpressFill AFTER all three pipelines
   * (cover, questions, CV) have settled successfully. No-op for free/pro,
   * disclaimer-not-seen, toggle-off, day-paused, capped, or inter-submit
   * throttled. Otherwise: 3-5s countdown → re-sanity → click → verify → log.
   *
   * Errors NEVER throw: the wrapping try/catch swallows everything because
   * Modo Auto failures must NOT break the manual HITL fallback path.
   */
  async function maybeAutoSubmit(jobLite) {
    try {
      // Gate 1: toggle on.
      if (!(await readAutoMode())) return;
      // Gate 2: disclaimer seen.
      if (!(await readDisclaimerSeen())) return;
      // Gate 3: premium plan.
      if (!(await autoIsPremium())) return;
      // Gate 4: cap + delay + day-pause.
      const cap = await canAutoSubmitNow();
      if (!cap.ok) {
        toast(`Modo Auto: ${cap.reason}`, "info", { durationMs: 4500 });
        return;
      }

      // Pre-flight sanity (kill switch #2/#3 first pass).
      const sanity = autoSubmitSanityCheck();
      if (!sanity.ok) {
        toast(`Modo Auto cancelado: ${sanity.reason}`, "info", { durationMs: 4500 });
        return;
      }

      // Random 3-5s countdown with Escape kill switch (#1).
      const seconds = 3 + Math.floor(Math.random() * 3);
      const cd = showAutoSubmitCountdown(seconds);
      const proceed = await cd.promise;
      if (!proceed) {
        toast("Modo Auto cancelado por ti.", "info");
        return;
      }

      // Re-sanity (kill switch #2/#3 second pass — page may have changed
      // during the countdown, e.g. CAPTCHA appeared, SPA navigated away).
      const sanity2 = autoSubmitSanityCheck();
      if (!sanity2.ok) {
        toast(`Modo Auto cancelado: ${sanity2.reason}`, "info", { durationMs: 4500 });
        return;
      }

      // Single deliberate click. We do NOT dispatch synthetic events at the
      // document level — only the platform's own click on the button.
      const btn = findLaPiezaSubmitButton();
      if (!btn) {
        toast("Modo Auto: no encontré el botón Finalizar", "error");
        return;
      }
      console.log("[EmpleoAutomatico] auto-submit fired:", { portal: SOURCE, jobId: jobLite && jobLite.id });
      try { btn.click(); } catch (clickErr) {
        console.warn("[EmpleoAutomatico] auto-submit click threw", clickErr);
        toast("Modo Auto: el clic en Finalizar falló. Revisa manualmente.", "error");
        await markAutoSubmitFailure();
        return;
      }

      // Verify after 3s. If we're still on the apply page AND no error
      // banner appeared, the submit didn't take — likely a multi-step
      // wizard or a silent failure. Don't increment the counter and don't
      // mark applied; just inform the user.
      await new Promise((r) => setTimeout(r, 3000));
      const stillOnApply = isApplyPage();
      const errorVisible = !!document.querySelector('[class*="error" i]:not([class*="border" i])');
      if (errorVisible) {
        toast("Modo Auto: el portal devolvió un error. No incrementé el contador.", "error");
        await markAutoSubmitFailure();
        return;
      }
      if (stillOnApply) {
        toast("Modo Auto: el envío no se confirmó. Revisa manualmente.", "info");
        await markAutoSubmitFailure();
        return;
      }

      // Success path. Reset the failure streak so a clean session starts
      // fresh after a successful submit.
      autoSubmitFailStreak = 0;
      await incrementAutoDaily();
      await autoWriteStorage(STORAGE_KEYS.AUTO_LAST_SUBMIT_AT, Date.now());
      if (jobLite && jobLite.id && queueModule && typeof queueModule.markApplied === "function") {
        try { await queueModule.markApplied(jobLite.id, SOURCE); } catch (_) { /* ignore */ }
      }
      const daily = await readAutoDaily();
      const portalCount = (daily.perPortal && daily.perPortal[SOURCE]) || 0;
      const portalCap = AUTO_PORTAL_CAPS[SOURCE] ?? 20;
      const company = (jobLite && jobLite.company) || "esta vacante";
      toast(
        `✓ Auto-aplicado a ${company}. ${portalCount}/${portalCap} hoy en ${SOURCE}`,
        "success",
        { durationMs: 5000 }
      );
    } catch (err) {
      console.warn("[EmpleoAutomatico] maybeAutoSubmit failed", err);
    }
  }

  // =========================================================================
  // Express Mode — orchestrator + UI helpers
  // =========================================================================

  /**
   * Run the Express fill flow on /apply/<uuid>. Auto-fills the cover-letter
   * textarea, the per-question answers, and (in a new tab) the tailored CV.
   * The user does the final review and clicks LaPieza's own submit button.
   *
   * HITL guarantees (NEVER violated, except via Modo Auto — see below):
   *   - We NEVER click LaPieza's "Postularme" button programmatically.
   *   - We NEVER click LaPieza's "Finalizar"/submit button programmatically.
   *   - We NEVER fire form.submit() programmatically.
   *   - We only modify field values + dispatch input/change/blur events for
   *     React-friendliness.
   *   - The user always clicks the platform's CTA themselves.
   *
   * Documented exception — Modo Auto (see maybeAutoSubmit below):
   *   The auto-submit flow MAY click LaPieza's Finalizar button, but only
   *   after passing four gates: (1) plan === "premium", (2) AUTO_MODE
   *   toggle is on, (3) AUTO_DISCLAIMER_SEEN is true, (4) under the daily
   *   cap. Five kill switches guard the click itself: Esc key, sanity
   *   recheck after countdown, CAPTCHA detection, day-pause on 2 errors,
   *   and the inter-submit delay. Free/pro users and users who haven't
   *   accepted the disclaimer never see this code path.
   *
   * Error handling:
   *   - GENERATE_DRAFT failure → error toast + open the panel so the user can
   *     retry from there. No fields are half-filled.
   *   - ANSWER_QUESTIONS failure → still fill the cover letter; toast tells
   *     the user the answers must be written manually.
   *   - GENERATE_CV failure → carta + answers still populate; toast reminds
   *     the user to upload their existing CV.
   *
   * @param {Object} opts
   * @param {Object} opts.job — the job posting (restored from session cache).
   * @param {Object|null} opts.prewarmedDraft — draft cached from /vacancy/<uuid>,
   *        or null if the user came in cold.
   */
  async function runExpressFill({ job, prewarmedDraft, skipCv = false }) {
    if (!job || !job.title) {
      toast("No tengo la vacante. Abre /vacancy/<id> primero.", "info");
      return;
    }

    // 1) Scan the form right now (synchronous — apply forms are usually
    //    server-rendered). We always re-scan inside runExpressFill so SPA
    //    mutations between vacancy → apply are picked up.
    const scanned = scanQuestionFields();
    detectedQuestions = scanned;

    // 2) Locate the cover-letter target field. We try the same heuristics as
    //    detectCoverLetterTextarea but applied to apply-page DOM directly.
    const coverField = findExpressCoverLetterField();

    // Build the progress overlay aligned with the FAB. We push 3 steps in:
    //   carta / cv / preguntas. Steps are skipped when their target doesn't
    //   exist (no carta field on form / no questions detected).
    const overlay = buildExpressOverlay({
      hasCover: !!coverField,
      hasQuestions: scanned.length > 0
    });
    overlay.show();

    // Track per-step status so we can surface a meaningful final toast.
    const status = { cover: "skipped", questions: "skipped", cv: "skipped" };
    const errors = [];

    // 3) Cover-letter pipeline. If we have a pre-warmed draft, use it
    //    immediately; otherwise fire a fresh GENERATE_DRAFT request.
    const coverPromise = (async () => {
      if (!coverField) return null;
      try {
        let draft = prewarmedDraft;
        if (!draft || !draft.coverLetter) {
          overlay.markPending("cover");
          const res = await sendMsg({ type: MSG.GENERATE_DRAFT, job });
          if (!res || !res.ok) {
            handleExpressDraftFailure(res, { job });
            overlay.markError("cover", "No se pudo generar la carta");
            errors.push("draft");
            status.cover = "error";
            return null;
          }
          draft = res.draft || null;
          activeDraftId = res.draftId || draft?.id || null;
          lastDraft = draft;
          persistDraftToSession(draft);
        } else {
          activeDraftId = draft.id || activeDraftId;
          lastDraft = draft;
        }
        const cover = (draft && draft.coverLetter) ? String(draft.coverLetter) : "";
        if (!cover) {
          overlay.markError("cover", "Carta vacía");
          status.cover = "error";
          return null;
        }
        if (!isUserEdited(coverField)) {
          fillFieldWithPulse(coverField, cover);
          status.cover = "ok";
          overlay.markDone("cover");
        } else {
          overlay.markDone("cover", "Respetado (lo editaste)");
          status.cover = "ok";
        }
        return cover;
      } catch (err) {
        console.warn("[EmpleoAutomatico] Express cover failed", err);
        overlay.markError("cover", humanizeError(err));
        errors.push("draft");
        status.cover = "error";
        return null;
      }
    })();

    // 4) Questions pipeline. Skipped when no questions detected.
    const questionsPromise = (async () => {
      if (!scanned.length) return null;
      overlay.markPending("questions", `0/${scanned.length}`);
      try {
        const res = await sendMsg({
          type: MSG.ANSWER_QUESTIONS,
          job,
          questions: scanned.map((q) => q.question)
        });
        if (!res || !res.ok) {
          // Per spec: degraded mode — keep the cover-letter step but tell the
          // user they have to write the questions manually.
          overlay.markError("questions", "No se generaron — escríbelas tú");
          errors.push("questions");
          status.questions = "error";
          return null;
        }
        const answers = Array.isArray(res.answers) ? res.answers : [];
        questionAnswers = answers.slice();
        questionsState = "success";

        // Stagger fills 200ms apart so the user sees them populate sequentially.
        let filled = 0;
        for (let i = 0; i < scanned.length; i++) {
          const q = scanned[i];
          const value = answers[i];
          if (!value) continue;
          const target = resolveFieldRef(q.fieldRef);
          if (!target) continue;
          if (isUserEdited(target)) continue;
          fillFieldWithPulse(target, value);
          filled++;
          overlay.markPending("questions", `${filled}/${scanned.length}`);
          // 200ms stagger between fields so the typing-pulse effect is visible.
          await new Promise((r) => setTimeout(r, 200));
        }
        overlay.markDone("questions", `${filled}/${scanned.length}`);
        status.questions = "ok";
        return answers;
      } catch (err) {
        console.warn("[EmpleoAutomatico] Express questions failed", err);
        overlay.markError("questions", "Error generando respuestas");
        errors.push("questions");
        status.questions = "error";
        return null;
      }
    })();

    // 5) CV pipeline. Open the generated HTML in a new tab with auto-print
    //    so the user just confirms the print dialog. Failure is non-blocking.
    //
    // Step-aware gate: LaPieza's apply form has multiple steps (cover-letter
    // step → CV upload step → review). On the cover-letter / questions step,
    // there's no file input visible and opening the CV in a new tab is
    // confusing UX ("why did you open a CV when I'm answering a question?").
    // We detect a CV file input on the current step; if absent, SKIP the
    // CV generation entirely and toast a hint pointing the user to come
    // back to the FAB on the next step. This keeps the user's quota
    // unspent until they actually need the CV.
    const hasCvFileInput = (() => {
      const inputs = Array.from(document.querySelectorAll("input[type=file]"));
      if (!inputs.length) return false;
      // Filter to "looks like a CV upload": label/placeholder/name mentions
      // CV / curriculum / resume / archivo. Otherwise we'd false-positive on
      // generic file inputs.
      const rx = /cv|curriculum|currículum|resume|hoja[\s-]de[\s-]vida|archivo/i;
      return inputs.some((inp) => {
        if (!isVisible(inp)) return false;
        const aria = (inp.getAttribute("aria-label") || "") + " " +
                     (inp.getAttribute("name") || "") + " " +
                     (inp.getAttribute("placeholder") || "") + " " +
                     (inp.id || "") + " " +
                     (inp.parentElement?.textContent || "").slice(0, 200);
        return rx.test(aria);
      });
    })();
    const cvPromise = (async () => {
      // Quick-apply chain explicitly opts out of CV generation: LaPieza
      // already has a "PRINCIPAL" CV pre-selected, and opening a
      // print-to-PDF tab mid-chain breaks the automated flow. Tailored
      // CV generation is still available via a manual FAB click.
      if (skipCv) {
        overlay.markDone("cv", "Usa tu CV principal de LaPieza");
        status.cv = "skipped";
        return null;
      }
      // Step 1 (cover letter / questions): no CV upload field visible.
      // Skip the generation — saves a Gemini call AND a confusing tab open.
      if (!hasCvFileInput) {
        overlay.markDone("cv", "Se generará cuando llegues al paso de subir CV");
        status.cv = "skipped";
        return null;
      }
      overlay.markPending("cv");
      try {
        const res = await sendMsg({ type: MSG.GENERATE_CV, job });
        if (!res || !res.ok) {
          overlay.markError("cv", "No se pudo generar el CV");
          errors.push("cv");
          status.cv = "error";
          return null;
        }
        cvHtml = res.html || "";
        cvSummary = res.summary || "";
        cvState = "success";
        if (!cvHtml) {
          overlay.markError("cv", "CV vacío");
          status.cv = "error";
          return null;
        }
        // Open the cached HTML in a new tab via the service worker. This is
        // the SAME flow as the panel "Abrir y descargar PDF" button — the
        // bootstrap script auto-fires the print dialog ~800ms after first paint.
        let openRes = await sendMsg({ type: MSG.OPEN_GENERATED_CV, html: cvHtml });
        if (!openRes || !openRes.ok) {
          openRes = await sendMsg({ type: MSG.OPEN_GENERATED_CV, html: cvHtml, useDataUrl: true });
        }
        if (!openRes || !openRes.ok) {
          overlay.markError("cv", "No se pudo abrir el CV");
          status.cv = "error";
          return null;
        }
        overlay.markDone("cv");
        status.cv = "ok";
        return cvHtml;
      } catch (err) {
        console.warn("[EmpleoAutomatico] Express CV failed", err);
        overlay.markError("cv", humanizeError(err));
        errors.push("cv");
        status.cv = "error";
        return null;
      }
    })();

    // 6) Wait for all three to settle. We use Promise.allSettled because we
    //    already classified each step's outcome individually above and we
    //    never want to short-circuit (e.g. CV failure shouldn't kill carta).
    await Promise.allSettled([coverPromise, questionsPromise, cvPromise]);

    // 7) If the cover letter failed AND there was a draft path (i.e. the
    //    target field exists), that's the most critical failure — open the
    //    panel for retry as the spec requires.
    if (status.cover === "error" && coverField) {
      try {
        if (lastDraft) {
          openPanel({ job, draft: lastDraft, partial: false });
        } else {
          // No draft at all — the panel needs SOMETHING. Open with a synthetic
          // empty draft so the user can hit "Re-generar".
          openPanel({ job, draft: { coverLetter: "" }, partial: false });
        }
      } catch (_) { /* ignore */ }
      // The handleExpressDraftFailure helper already showed a typed toast.
      // Hide overlay after a beat.
      setTimeout(() => overlay.hide(), 1500);
      return;
    }

    // 8) Highlight LaPieza's submit button + show final toast. The toast copy
    //    branches on which steps succeeded / failed so the user knows what to
    //    do next.
    setTimeout(() => overlay.hide(), 1500);
    highlightExpressSubmitButton();

    let toastMsg = "✓ Listo. Revisa los campos y dale 'Finalizar' →";
    let toastVariant = "success";
    if (status.cover !== "ok" && coverField) {
      // Already handled above with a panel open; shouldn't reach here.
    }
    if (status.cover === "skipped" && status.questions === "ok" && coverField === null) {
      toastMsg = "✓ Respuestas listas. Sube tu CV cuando lo pida.";
    }
    if (status.questions === "error" && status.cover === "ok") {
      toastMsg = "Algunas respuestas no se generaron, llénalas manualmente.";
      toastVariant = "info";
    }
    if (status.cv === "error" && status.cover === "ok") {
      // Append a CV note if the carta succeeded — don't overwrite the success
      // copy entirely, just append the warning so the user knows.
      toast(
        "El CV personalizado no se pudo generar — usa tu CV actual.",
        "info",
        { durationMs: 5000 }
      );
    }
    toast(toastMsg, toastVariant, { durationMs: 6000 });

    // Arm the in-flow assistant (file-input tip, fallback paste buttons,
    // submit-button pulse on later wizard steps). It's idempotent.
    startFlowAssistant();

    // Modo Auto — Premium-only optional auto-submit. Reads its own gates
    // (plan + toggle + disclaimer + cap + sanity) and is a no-op for free
    // /pro users or when the toggle is off. This is the documented exception
    // to the HITL guarantees declared in this function's JSDoc — gated 4
    // ways and wrapped in 5 kill switches (see maybeAutoSubmit below).
    if (typeof maybeAutoSubmit === "function") {
      maybeAutoSubmit(extractJobLiteFromUrl(job)).catch(() => {});
    }
  }

  // Find the cover-letter target textarea on the apply page. Heuristic:
  //   1) textarea whose label/placeholder matches carta / presentación /
  //      motivación / cover / por qué / ideal
  //   2) otherwise, the largest visible textarea on the page (by area)
  //   3) returns null if no textarea exists at all (e.g. quick-apply forms)
  function findExpressCoverLetterField() {
    const textareas = Array.from(document.querySelectorAll("textarea"))
      .filter((t) => isVisible(t) && !t.disabled && !t.readOnly);
    if (!textareas.length) return null;
    const rx = /carta|presentaci[oó]n|motivaci[oó]n|cover\s*letter|motivation|por\s*qu[eé]|ideal/i;
    const labelHay = (t) => {
      const parts = [
        t.getAttribute("placeholder") || "",
        t.getAttribute("aria-label") || "",
        t.name || "",
        t.id || ""
      ];
      if (t.id) {
        try {
          const lbl = document.querySelector(`label[for="${CSS.escape(t.id)}"]`);
          if (lbl) parts.push(lbl.textContent || "");
        } catch (_) {}
      }
      const wrap = t.closest("label");
      if (wrap) parts.push(wrap.textContent || "");
      return parts.join(" ").toLowerCase();
    };
    const matched = textareas.find((t) => rx.test(labelHay(t)));
    if (matched) return matched;
    // Fallback: largest area
    textareas.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (rb.width * rb.height) - (ra.width * ra.height);
    });
    return textareas[0] || null;
  }

  // Detect "user-edited" fields so Express doesn't clobber what the user
  // typed before clicking. We tag fields with data-eamx-user-edited="true"
  // on every input event from outside the express handler. The flag is
  // cleared only when the user explicitly cancels.
  // We also defensively guard against pre-existing non-trivial values:
  // any textarea/input with > 30 characters is treated as user-typed.
  function isUserEdited(el) {
    if (!el) return false;
    if (el.dataset && el.dataset.eamxUserEdited === "true") return true;
    const v = (el.value || "").trim();
    if (v.length > 30) return true;
    return false;
  }

  // Track user edits while the FAB is in flight. We attach the listener on
  // first runExpressFill call and never remove it — it's a passive flag
  // setter, doesn't trigger re-renders.
  let _userEditListenerAttached = false;
  function attachUserEditListener() {
    if (_userEditListenerAttached) return;
    _userEditListenerAttached = true;
    document.addEventListener("input", (ev) => {
      const t = ev.target;
      if (!t) return;
      if (!(t instanceof HTMLInputElement) && !(t instanceof HTMLTextAreaElement)) return;
      // Express runs set values via setNativeValue + dispatch input. To
      // avoid marking those, we set t.dataset.eamxFilling="true" briefly
      // around the programmatic write (see fillFieldWithPulse).
      if (t.dataset && t.dataset.eamxFilling === "true") return;
      try { t.dataset.eamxUserEdited = "true"; } catch (_) {}
    }, true);
  }

  // Set the field value + dispatch input/change/blur (React-friendly) +
  // briefly add the `.eamx-field-typing` class so the user sees the field
  // pulse. The class is removed after 1.6s (1.5s anim + buffer).
  function fillFieldWithPulse(el, value) {
    if (!el) return;
    attachUserEditListener();
    try {
      // Mark the field so the document-level "input" listener doesn't flag
      // this programmatic write as a user edit.
      try { el.dataset.eamxFilling = "true"; } catch (_) {}

      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        setNativeValue(el, value);
      } else if (el.isContentEditable) {
        el.textContent = value;
      } else {
        try { el.value = value; } catch (_) {}
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      try { el.dispatchEvent(new Event("blur", { bubbles: true })); } catch (_) {}

      // Visible pulse — 1.5s outline animation.
      try {
        el.classList.add("eamx-field-typing");
        setTimeout(() => { try { el.classList.remove("eamx-field-typing"); } catch (_) {} }, 1600);
      } catch (_) {}
    } finally {
      // Clear the filling-flag on the next tick so the user-edit listener
      // doesn't pick up the synthetic input event.
      setTimeout(() => { try { delete el.dataset.eamxFilling; } catch (_) {} }, 50);
    }
  }

  // -------------------------------------------------------------------------
  // Express progress overlay — small floating card pinned above the FAB.
  // Steps:
  //   cover     "Carta de presentación"
  //   cv        "CV personalizado"
  //   questions "Respuestas (n/m)"
  // Each step has 3 visual states: pending (⏳), done (✓), error (×).
  // -------------------------------------------------------------------------
  function buildExpressOverlay({ hasCover, hasQuestions }) {
    let host = document.querySelector(".eamx-express-overlay");
    if (host) try { host.remove(); } catch (_) {}
    host = document.createElement("div");
    host.className = "eamx-express-overlay";
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");

    const steps = [];
    if (hasCover) steps.push({ key: "cover", label: "Carta de presentación" });
    steps.push({ key: "cv", label: "CV personalizado" });
    if (hasQuestions) steps.push({ key: "questions", label: "Respuestas" });

    let inner = '<div class="eamx-express-overlay__title">⚡ Llenando…</div>';
    for (const s of steps) {
      inner += `<div class="eamx-express-overlay__step eamx-express-overlay__step--pending" data-step="${escapeHtml(s.key)}">` +
        '<span class="eamx-express-overlay__icon" aria-hidden="true">⏳</span>' +
        `<span class="eamx-express-overlay__label">${escapeHtml(s.label)}</span>` +
        '<span class="eamx-express-overlay__detail"></span>' +
      '</div>';
    }
    host.innerHTML = inner;
    document.documentElement.appendChild(host);

    function find(stepKey) { return host.querySelector(`[data-step="${stepKey}"]`); }
    function setIcon(stepEl, icon) {
      const i = stepEl.querySelector(".eamx-express-overlay__icon");
      if (i) i.textContent = icon;
    }
    function setDetail(stepEl, detail) {
      const d = stepEl.querySelector(".eamx-express-overlay__detail");
      if (d) d.textContent = detail ? ` ${detail}` : "";
    }

    return {
      show: () => { /* already mounted */ },
      hide: () => { try { host.remove(); } catch (_) {} },
      markPending: (key, detail) => {
        const el = find(key); if (!el) return;
        el.classList.remove("eamx-express-overlay__step--done", "eamx-express-overlay__step--error");
        el.classList.add("eamx-express-overlay__step--pending");
        setIcon(el, "⏳");
        if (detail !== undefined) setDetail(el, detail);
      },
      markDone: (key, detail) => {
        const el = find(key); if (!el) return;
        el.classList.remove("eamx-express-overlay__step--pending", "eamx-express-overlay__step--error");
        el.classList.add("eamx-express-overlay__step--done");
        setIcon(el, "✓");
        if (detail !== undefined) setDetail(el, detail);
      },
      markError: (key, detail) => {
        const el = find(key); if (!el) return;
        el.classList.remove("eamx-express-overlay__step--pending", "eamx-express-overlay__step--done");
        el.classList.add("eamx-express-overlay__step--error");
        setIcon(el, "×");
        if (detail !== undefined) setDetail(el, detail);
      }
    };
  }

  // Surface a panel-style error for a failed GENERATE_DRAFT inside Express.
  // Mirrors showBackendFailure (toast with action) but keyed for Express.
  function handleExpressDraftFailure(res, _ctx) {
    const code = res?.error;
    const message = res?.message || "No se pudo generar la carta.";
    if (code === ERR.PLAN_LIMIT_EXCEEDED) {
      toast("Llegaste al límite de tu plan.", "error", {
        label: "Ver planes",
        onClick: () => openBilling()
      });
      return;
    }
    if (code === ERR.UNAUTHORIZED) {
      toast("Inicia sesión para continuar.", "error", {
        label: "Inicia sesión",
        onClick: () => openOptionsPage()
      });
      return;
    }
    if (code === ERR.INVALID_INPUT && /perfil|cv|profile/i.test(message)) {
      toast("Sube un CV más completo en Opciones.", "info", {
        label: "Abrir Opciones",
        onClick: () => openOptionsPage()
      });
      return;
    }
    toast(message, "error");
  }

  // Find LaPieza's most-prominent submit-ish button + apply the
  // .eamx-submit-highlight class. Selector cascade per spec:
  //   1) buttons containing "Finalizar"/"Enviar"/"Aplicar"
  //   2) any button[type=submit] inside the application form
  // We pick the most visible one by area; the CSS class handles the 3-pulse
  // animation + static glow.
  function highlightExpressSubmitButton() {
    const candidates = [];
    const form = findApplicationForm();
    const scope = form || document;
    // 1) text-match cascade
    const rx = /(finalizar|postularme|postular|enviar(?:\s+postulaci[oó]n)?|aplicar(?:\s+ahora)?|submit\s+application|send\s+application|apply)/i;
    const txtBtns = Array.from(scope.querySelectorAll("button, a[role='button'], input[type='submit']"))
      .filter((b) => isVisible(b))
      .filter((b) => rx.test(((b.textContent || b.value || "")).trim()));
    candidates.push(...txtBtns);
    // 2) type=submit fallback
    const sub = Array.from(scope.querySelectorAll("button[type='submit'], input[type='submit']"))
      .filter((b) => isVisible(b));
    candidates.push(...sub);
    if (!candidates.length) {
      toast("No encontré el botón de Finalizar — postula manualmente.", "info");
      return;
    }
    // De-dupe + pick the largest by area.
    const seen = new Set();
    const unique = candidates.filter((b) => {
      if (seen.has(b)) return false;
      seen.add(b);
      return true;
    });
    unique.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (rb.width * rb.height) - (ra.width * ra.height);
    });
    const btn = unique[0];
    try {
      btn.scrollIntoView({ behavior: "smooth", block: "center" });
      btn.classList.add("eamx-submit-highlight");
      // Static glow remains; we leave the class until the user navigates away.
    } catch (_) { /* ignore */ }
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

    // The legacy `draft.suggestedAnswers` map is intentionally NOT rendered
    // anymore — those keys were hard-coded and rarely matched real LaPieza
    // questions. The new flow is adaptive: scanQuestionFields() reads the
    // actual question labels off the DOM, batches them to /answer-questions,
    // and renders one card per detected question. See renderQuestionsCard.

    panelEl.innerHTML = `
      <header class="eamx-panel__header">
        <div class="eamx-panel__title"></div>
        <div class="eamx-panel__company"></div>
      </header>
      <div class="eamx-panel__body">
        ${partial ? `<div class="eamx-panel__warning">No pude extraer todo de la vacante — revisa la carta con más detalle.</div>` : ""}
        <label for="eamx-cover-letter"><strong>Carta de presentación</strong></label>
        <textarea id="eamx-cover-letter" class="eamx-textarea" rows="14"></textarea>
        <section class="eamx-questions" data-eamx-questions hidden></section>
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
        <button type="button" class="eamx-btn eamx-btn--primary" data-action="approve">Aprobar y llenar todo</button>
        <button type="button" class="eamx-btn eamx-btn--secondary" data-action="regen">Re-generar</button>
        <button type="button" class="eamx-btn eamx-btn--ghost" data-action="cancel">Cancelar</button>
      </footer>`;

    panelEl.querySelector(".eamx-panel__title").textContent = job.title || "(vacante)";
    panelEl.querySelector(".eamx-panel__company").textContent = job.company || "";
    panelEl.querySelector("#eamx-cover-letter").value = cover;

    // Best-effort: scan the page now so the panel surfaces detected questions
    // immediately. Most LaPieza apply pages render the form server-side, so a
    // synchronous scan catches them. The flow assistant re-scans later as the
    // SPA mutates the DOM (see runFlowDetectors → detectAdaptiveQuestions).
    if (questionsState === "idle" && !detectedQuestions.length) {
      const scanned = scanQuestionFields();
      if (scanned.length) {
        detectedQuestions = scanned;
        // Kick off the answer fetch in the background; the UI shows a loading
        // state until answers arrive.
        fetchAnswersForDetectedQuestions();
      }
    }
    renderQuestionsCard();

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
  // Best-matches shortlist panel (listing pages)
  // =========================================================================
  // Lifecycle: opened by the FAB click on listing routes (/, /vacantes,
  // /comunidad/jobs, etc.). Reads cards via findAllVacancyCards() — like
  // findVacancyCards but WITHOUT the overlay-skip filter, so cards already
  // overlaid by the inline-overlay path still get scored in the panel.
  // Top 25 by match score, with optional preferences-aware bonuses
  // (city / modality / salary) layered on top.
  //
  // HITL guarantees (NEVER violate):
  //   - The panel never auto-clicks "Postular" or any LaPieza CTA.
  //   - "Marcar" only writes to chrome.storage.local["eamx:queue"]; it does
  //     NOT submit any application or open a tab.
  //   - "Marcar top 5" iterates Marcar — same guarantee scaled.
  //   - "Abrir vacante" requires a deliberate user click on each item; we
  //     never open multiple tabs programmatically.

  // Module-scoped panel state. We don't reuse `panelEl` because the regular
  // openPanel() flow can coexist with this one (e.g. user comes back to a
  // /vacancy/ tab while the matches panel is up in another tab — different
  // pages, different DOM, but same module instance on hot-reload).
  let matchesPanelEl = null;
  let matchesScrollHandler = null;
  let matchesScrollDebounce = null;
  let matchesQueueListener = null;
  let matchesEscHandler = null;
  // Tracks the current top-N rendered list so the queue-onChanged listener
  // can re-paint button states without re-running findVacancyCards.
  let matchesCurrentTopN = [];

  // Wider-search accumulator. LaPieza paginates by REPLACING the cards on
  // each page click — not appending — so a naive "click next 5 times then
  // re-render" would leave us looking only at the final page's cards. We
  // instead snapshot jobLites + scores after each page click and stash
  // them here, keyed by id, so the render path can use the cumulative
  // pool. Cleared on panel close + on SPA route change.
  let widerSearchPool = null; // null = use live cards; Map = use accumulated pool

  /**
   * Open the best-matches shortlist panel on a LaPieza listing page.
   *
   * Renders a side panel anchored to the right side of the viewport that
   * shows the top 10 vacancies on the page ranked by match score against
   * the user's cached profile. From the panel, the user can:
   *   - Click "Abrir vacante" on any item to navigate to the detail page
   *     (opens in a new tab).
   *   - Click "⭐ Marcar" / "✓ Marcada" to toggle each item in the queue.
   *   - Click "⭐ Marcar top 5" to add the top 5 in one shot.
   *   - Close via the × button, the Escape key, or clicking the backdrop.
   *
   * HITL: this function NEVER applies to a job, NEVER auto-opens detail
   * tabs, NEVER clicks LaPieza's CTAs. Marking is queue-only — the user
   * still has to open each vacancy and apply by hand.
   *
   * @returns {Promise<void>}
   */
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
        <p class="eamx-matches-panel__loadmore-hint">Carga hasta 100 vacantes de LaPieza y te muestra las mejores según tus preferencias y CV.</p>
      </div>
      <div class="eamx-matches-panel__bulk" data-eamx-matches-bulk hidden>
        <button type="button" class="eamx-matches-panel__bulk-btn" data-action="mark-top-5">⭐ Marcar top 5 de un solo clic</button>
        <p class="eamx-matches-panel__bulk-hint">Marcar = guardar en tu cola. La extensión NO postula sola — tú abres cada vacante y le das clic al botón Postular cuando quieras.</p>
      </div>
    `;

    // Wire close interactions BEFORE we attach to DOM so even an early
    // failure path can be dismissed.
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
            // Repaint buttons based on the new queue snapshot. We don't
            // re-run findVacancyCards because the score order is locked.
            repaintMarkButtons();
          }
        };
        chrome.storage.onChanged.addListener(matchesQueueListener);
      }
    } catch (_) { /* ignore */ }

    // Now do the heavy work async: load deps, profile, score cards.
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
    if (matchesScrollDebounce) {
      clearTimeout(matchesScrollDebounce);
      matchesScrollDebounce = null;
    }
    matchesCurrentTopN = [];
    // Keep widerSearchPool alive across user-initiated close → reopen so
    // they don't lose their accumulated 100-vacancy sweep just by closing
    // the panel (Buscar más amplio is a 30-90s loop — re-doing it on
    // every close is brutal). The pool is dropped explicitly on SPA
    // route change in onChange() — see "spa nav watching" section.
    try { matchesPanelEl.classList.remove("eamx-matches-panel--open"); } catch (_) {}
    const node = matchesPanelEl;
    matchesPanelEl = null;
    // Allow the slide-out transition to complete before we unmount. Skip
    // the delay when reduced-motion is requested.
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
      // Take the user to LaPieza's main vacancy listing where the matches
      // panel can actually find cards. Hard-navigate (not router-push) so
      // the listing loads fresh and our content script re-runs the scan.
      ev.preventDefault();
      try { closeMatchesPanel(); } catch (_) {}
      try { location.href = "https://lapieza.io/vacantes"; } catch (_) {}
      return;
    }
    if (what === "quick-apply") {
      // "⚡ Postular" — open the vacancy in a new tab AND set a session
      // flag so our content script chains the FULL apply flow on arrival:
      //   1. pre-warm cover letter
      //   2. countdown 3s (Esc cancels)
      //   3. auto-click "¡Me quiero postular!"
      //   4. auto-confirm location-mismatch modal
      //   5. on /apply/<uuid>, auto-fire Express fill (no FAB click needed)
      //   6. auto-quiz already kicks in independently
      //   7. STOP at "Finalizar" — that's the user's HITL clic final
      // The flag is keyed on the vacancy id so it ONLY fires for the
      // vacancy we just opened. See maybeAutoPrewarmFromQuickApply.
      const jobId = action.getAttribute("data-job-id") || "";
      if (jobId && chrome?.storage?.session) {
        try {
          Promise.resolve(
            chrome.storage.session.set({
              [`eamx:quickapply:${jobId}`]: { setAt: Date.now() }
            })
          ).catch(() => {});
        } catch (_) {}
      }
      // Let the <a target="_blank"> open normally — don't preventDefault.
      // The new tab loads /vacante/<id>, content script reads the flag,
      // chains the full flow.
      return;
    }
    if (what === "load-more") {
      // Legacy single-shot load; kept as a fallback handler in case the
      // skeleton is ever re-rendered by an older code path. Modern panels
      // emit "wider-search" instead — see onMatchesWiderSearch.
      ev.preventDefault();
      onMatchesLoadMore(action);
      return;
    }
    if (what === "wider-search") {
      ev.preventDefault();
      onMatchesWiderSearch(action);
      return;
    }
    if (what === "open-preferences") {
      // Click on the Filtros stat → jump to the Options page with the
      // preferences card focused. We pass #preferences so options.js can
      // scrollIntoView the right card.
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

  // Find every vacancy card on the page WITHOUT the overlay-skip filter
  // that findVacancyCards applies. The overlay skip is correct for the
  // inline-overlay path (we don't want to double-inject) but wrong for
  // the matches panel path: once injectOverlay has stamped cards we'd
  // hide them from the shortlist scoring. Returns the same shape as
  // findVacancyCards: [{ anchor, card }]. WeakSet de-dupes by node so
  // duplicate hrefs to the same card don't double-count.
  // Guard — skip anchors that live INSIDE our own injected UI (matches
  // panel, queued-reminder banner, etc.). The matches panel renders
  // "Abrir vacante →" links pointing to /vacante/<id> URLs; without
  // this guard, the listing scanner would treat each panel item as if
  // it were a real LaPieza vacancy card and inject another overlay
  // INSIDE the panel item — visually the rank circle, score badge,
  // AND a duplicate Marcar button stack on top of the title.
  function isInsideOurUI(el) {
    if (!el) return false;
    return !!el.closest(".eamx-matches-panel, .eamx-panel, .eamx-toast, .eamx-card-overlay");
  }

  function findAllVacancyCards() {
    const seenAnchor = new WeakSet();
    const anchors = [];
    document.querySelectorAll("a.vacancy-card-link[href]").forEach((a) => {
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

  // Cheap card count for the wider-search progress loop. Same set of
  // anchors as findAllVacancyCards but skips the per-card walk because
  // we only care about the total, not the (anchor, card) tuples.
  function countAllVacancyAnchors() {
    let n = 0;
    const seen = new WeakSet();
    document.querySelectorAll("a.vacancy-card-link[href]").forEach((a) => {
      if (!seen.has(a)) { seen.add(a); n++; }
    });
    document.querySelectorAll("a[href]").forEach((a) => {
      if (seen.has(a)) return;
      if (VACANCY_ANCHOR_RX.test(a.href || "")) {
        seen.add(a);
        n++;
      }
    });
    return n;
  }

  // Wider-search auto-load loop. Scrolls to the bottom of the listing
  // page repeatedly to coax LaPieza's infinite scroll into hydrating more
  // cards, then re-ranks against the user's profile + preferences. Caps
  // at 100 cards or 5 iterations (whichever first) and bails early when
  // two consecutive iterations don't grow the card count (LaPieza
  // exhausted its result set).
  //
  // HITL note: this still doesn't do anything destructive — it only
  // scrolls the host page (a normal user action LaPieza already supports)
  // and re-renders our side panel. No requests are sent, no applications
  // are submitted.
  // Locate LaPieza's MUI Pagination "next page" button. Tries the official
  // aria-label first ("Go to next page") with a Spanish fallback, then a
  // structural fallback (last button in .MuiPagination-ul). Returns null
  // when LaPieza's listing isn't paginated (single-page result, etc.).
  function findLaPiezaNextPageButton() {
    const tries = [
      'button[aria-label="Go to next page"]',
      'button[aria-label="next page"]',
      'button[aria-label*="next" i]',
      'button[aria-label*="siguiente" i]',
      '.MuiPagination-ul li:last-child button',
       '.MuiPagination-root button:not([aria-label*="page" i]):last-of-type'
    ];
    for (const sel of tries) {
      try {
        const el = document.querySelector(sel);
        if (el && !el.disabled) return el;
      } catch (_) { /* invalid selector — skip */ }
    }
    return null;
  }

  /**
   * Wider-search loop — paginate through LaPieza's listing by clicking the
   * MUI "Next page" button programmatically, polling for the new cards to
   * hydrate, then re-ranking the cumulative set.
   *
   * Why click instead of scroll: LaPieza is NOT an infinite-scroll listing.
   * Live DOM check confirmed it uses MUI Pagination buttons (no ?page=N URL,
   * no auto-loading on scroll). The previous scroll-to-bottom approach did
   * literally nothing on this site. Clicking the official "Next" button
   * fires LaPieza's own state-update handler — same path a normal user
   * takes — so it's behaviorally indistinguishable from a human paginating.
   *
   * The URL doesn't change while paginating (verified live), so the SPA
   * route-change listener doesn't fire and the matches panel stays open.
   *
   * Caps: 5 pages × ~12 vacantes/page ≈ 60 candidatos. Inter-page delay of
   * 800ms (human-paced) keeps us off any "too fast" detection.
   */
  // Snapshot the live cards on the current page into a {id → entry} map.
  // Used by the wider-search loop to build a cumulative pool because
  // LaPieza's MUI Pagination REPLACES (not appends) cards on each page
  // change — so without this snapshotting we'd only ever see the last
  // page after the loop finishes.
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

  async function onMatchesWiderSearch(btn) {
    if (!btn || btn.disabled) return;
    const original = btn.textContent;
    btn.disabled = true;
    // 14 covers the typical full LaPieza listing (we saw 14 pages live).
    // Each page is ~12 cards = ~168 vacantes total. The cumulative pool
    // map dedupes by id so re-visiting a page (e.g. when the loop bails
    // and restarts) doesn't double-count.
    const MAX_PAGES = 14;
    const PER_PAGE_TIMEOUT_MS = 4000;
    const POLL_INTERVAL_MS = 300;
    const INTER_PAGE_DELAY_MS = 700;
    // Cumulative pool, keyed by jobLite.id. Survives page-change
    // unmounting because we extract jobLites BEFORE clicking next.
    const pool = new Map();
    // Seed the pool with whatever's on screen right now (page 1 worth).
    for (const entry of snapshotCurrentCardsAsPoolEntries()) {
      pool.set(entry.jobLite.id, entry);
    }
    let stallStreak = 0;
    let lastFirstAnchorHref = "";
    try {
      for (let page = 1; page <= MAX_PAGES; page++) {
        btn.textContent = `Página ${page}/${MAX_PAGES} · ${pool.size} vacantes`;
        const nextBtn = findLaPiezaNextPageButton();
        if (!nextBtn) break; // single-page result, stop early
        // Capture the first anchor's href BEFORE click so we can confirm
        // LaPieza actually changed the cards (not just re-rendered the
        // same set). On the last page this stays the same → we bail.
        try {
          const firstAnchor = document.querySelector("a.vacancy-card-link[href]");
          lastFirstAnchorHref = firstAnchor?.getAttribute("href") || "";
        } catch (_) { lastFirstAnchorHref = ""; }
        // Fire React's onClick.
        try { nextBtn.click(); } catch (_) { /* should never throw */ }
        // Poll until the first card's href changes (= page swapped) or
        // the pool grows (defensive). 300ms × ~13 polls = ~4s timeout.
        const polls = Math.max(1, Math.round(PER_PAGE_TIMEOUT_MS / POLL_INTERVAL_MS));
        let pageChanged = false;
        for (let p = 0; p < polls; p++) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          let firstNow = "";
          try {
            const a = document.querySelector("a.vacancy-card-link[href]");
            firstNow = a?.getAttribute("href") || "";
          } catch (_) {}
          if (firstNow && firstNow !== lastFirstAnchorHref) {
            pageChanged = true;
            break;
          }
        }
        if (!pageChanged) {
          stallStreak++;
          if (stallStreak >= 2) break;
          continue;
        }
        stallStreak = 0;
        // Snapshot this page's cards into the cumulative pool.
        const before = pool.size;
        for (const entry of snapshotCurrentCardsAsPoolEntries()) {
          pool.set(entry.jobLite.id, entry);
        }
        const grew = pool.size > before;
        if (!grew) {
          // Page changed but no new ids — listing duplicated or our
          // dedup caught all entries (e.g. featured posts repeated).
          // Bail rather than spinning forever.
          stallStreak++;
          if (stallStreak >= 2) break;
        } else {
          stallStreak = 0;
        }
        // Human-paced pause between pages so we don't hammer LaPieza's
        // search backend.
        await new Promise((r) => setTimeout(r, INTER_PAGE_DELAY_MS));
      }
      // Activate the pool for the panel render. renderMatchesPanelContent
      // checks widerSearchPool first and uses it instead of live cards.
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

  // Trigger LaPieza's own infinite scroll by scrolling the host page to the
  // bottom, wait for new cards to render, then re-rank. We never fetch
  // additional pages programmatically — only nudge LaPieza's existing UI.
  // Kept for backwards compatibility; current panels emit wider-search.
  async function onMatchesLoadMore(btn) {
    if (!btn || btn.disabled) return;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Cargando…";
    try {
      const before = findVacancyCards().length + (matchesCurrentTopN?.length || 0);
      // Scroll the body to the bottom — LaPieza listens for this and
      // hydrates the next page of vacancies into the same DOM.
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
      // Poll up to 4 seconds (8 × 500ms) for new cards to render. We bail
      // as soon as we detect any growth.
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const now = findVacancyCards().length + (matchesCurrentTopN?.length || 0);
        if (now > before) break;
      }
      // Restore scroll position so the user doesn't lose context of the panel.
      window.scrollTo({ top: 0, behavior: "smooth" });
      // Re-rank the now-larger card set.
      await renderMatchesPanelContent();
    } catch (err) {
      console.warn("[EmpleoAutomatico] load more failed", err);
    } finally {
      btn.disabled = false;
      btn.textContent = original || "⬇ Cargar más vacantes de LaPieza";
    }
  }

  // Render the content area. Idempotent — can be called repeatedly (e.g.
  // after scroll re-population, after the user uploads their CV).
  async function renderMatchesPanelContent() {
    if (!matchesPanelEl) return;
    const host = matchesPanelEl.querySelector("[data-eamx-matches-content]");
    const bulk = matchesPanelEl.querySelector("[data-eamx-matches-bulk]");
    if (!host) return;

    // Lazy-load deps + profile + preferences. We load profile and prefs
    // in parallel — both are local storage reads, both are cheap, and the
    // scorer needs both to be available before we render.
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

    // Find cards on the page right now. We use findAllVacancyCards (no
    // overlay-skip) instead of findVacancyCards because the matches
    // panel needs to score every visible card, including those the
    // inline-overlay path has already stamped. Cap at 100 to mirror the
    // wider-search ceiling — past that point the panel becomes
    // memory-heavy and the user can't really compare so many anyway.
    let cards = [];
    try { cards = findAllVacancyCards() || []; } catch (err) {
      console.warn("[EmpleoAutomatico] findAllVacancyCards threw", err);
      cards = [];
    }
    if (cards.length > 100) cards = cards.slice(0, 100);

    // Empty state #2 — no cards at all. Two flavors:
    //  a) We're already on a listing route (/vacantes, /comunidad/jobs,
    //     etc.) but no cards rendered → probably a transient/empty
    //     filter result. CTA: "Volver a escanear".
    //  b) We're on the homepage / company landing / unknown route → the
    //     useful CTA is taking the user to the listing where vacancies
    //     ARE shown. CTA: "Ir a Vacantes →".
    if (!cards.length) {
      const onListingAlready = /^\/(?:vacantes|vacancies|jobs|empleos|comunidad)/i.test(location.pathname);
      const headline = onListingAlready ? "No detecté vacantes" : "Estás en una página sin vacantes";
      const body = onListingAlready
        ? "No encontré cards de vacantes aquí. Si crees que es un bug, dame screenshot."
        : "Para ver tus mejores matches, abre el listado de LaPieza. Te llevo:";
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

    // Score every card. matchScoreModule is loaded by ensureDiscoveryDeps;
    // if it failed (rare, ad-blocker chains, etc.) we just sort by document
    // order and fall back to the unknown level.
    //
    // effectivePrefs merges user-saved preferences with implicit defaults
    // derived from the CV (city ← personal.location, salary ← summary or
    // rawText, modality ← summary scan). Saved values always win when set;
    // implicit values fill the gaps. Returns null when neither side has
    // anything actionable, in which case the scorer runs the legacy path.
    const effectivePrefs = (matchScoreModule && typeof matchScoreModule.effectivePreferences === "function")
      ? matchScoreModule.effectivePreferences(cachedPreferences, cachedProfile)
      : cachedPreferences;
    // Build the scored set. Two paths:
    //   A) If we have a wider-search pool (user clicked "Buscar más amplio"
    //      and we accumulated jobLites across multiple LaPieza pages),
    //      use that — it has more vacancies than the current visible page.
    //   B) Otherwise, score the live cards on screen.
    let scored;
    if (widerSearchPool && widerSearchPool.size) {
      // Pool entries already have score + reasons from the moment they were
      // accumulated, so we re-score with the latest preferences (cheap) and
      // pass through. anchor/card live refs are null because past pages
      // have been unmounted by LaPieza's pagination — that's fine, the
      // panel doesn't need them, and "Abrir vacante" uses the URL.
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
        let score = 0;
        let reasons = [];
        let level = "unknown";
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

    // Sort by score desc, then take 25. We doubled the cap from the
    // original 10 because v1 testing showed users want a wider shortlist
    // — at 10 the panel hides quality candidates that scored mid-tier.
    // The "Cargar más" footer button triggers LaPieza's own infinite-
    // scroll so the cap can keep growing as the user fetches more pages.
    scored.sort((a, b) => (b.score - a.score) || 0);
    const topN = scored.slice(0, 25);
    matchesCurrentTopN = topN;

    // Render
    const lowFitNote = topN.every((m) => m.score < 30)
      ? `<div class="eamx-matches-panel__note">Pocas vacantes en esta página coinciden con tu perfil. Prueba con otros filtros o con palabras clave.</div>`
      : "";
    // Stats strip — shows the best score, the average, the card count,
    // and a fourth Filtros cell summarizing the user's active preferences.
    // Helps the user calibrate at a glance ("is the top match really
    // good?") and discover that they have preference filters configured.
    const bestScore = topN[0]?.score ?? 0;
    const avgScore = Math.round(
      topN.reduce((sum, m) => sum + (m.score || 0), 0) / Math.max(1, topN.length)
    );
    const bestLevel = topN[0]?.level || "unknown";
    // Build the Filtros cell. Each set preference contributes one icon —
    // we keep it tiny so the 4-cell strip fits in the existing panel
    // width. Click → opens Options with the preferences card focused.
    // The Filtros cell reflects the EFFECTIVE prefs (saved + implicit
    // from CV) — so even on first run, when the user hasn't opened the
    // preferences card yet, they see "📍🏠💰" if their CV had enough
    // signal for us to derive defaults.
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
    // Top-1 banner — calls out the single best match in this page so the
    // user knows where to spend a quota slot if they only have time for
    // one. Surfaces up to two of the top-1's reason lines so the user can
    // see *why* the algorithm picked this one (e.g. skill match + city).
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

    // Resolve initial marked state for each row asynchronously. We render
    // optimistic "⭐ Marcar" first, then upgrade to "✓ Marcada" once the
    // queue read resolves. This way the list paints in a single frame.
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

    // Show the "Buscar más amplio" button whenever we have enough cards
    // visible to justify a wider sweep. We hide it when there are < 5
    // cards because the user should fix their filters first; the auto-
    // scroll loop won't summon vacancies that don't exist.
    //
    // Capped at 100 cards by the loop itself (see onMatchesWiderSearch),
    // so we also hide the button once we hit that ceiling — there's no
    // more headroom to grow.
    const loadMore = matchesPanelEl?.querySelector("[data-eamx-matches-loadmore]");
    if (loadMore) {
      // Visibility uses the larger of (live cards, pool size). When the
      // user reopens the panel after a previous wider-search, pool.size
      // is the meaningful number — we already have N vacancies cached,
      // so "Buscar más amplio" should hide once we hit the 100 ceiling.
      const effective = Math.max(
        cards.length,
        (widerSearchPool && widerSearchPool.size) || 0
      );
      loadMore.hidden = effective < 5 || effective >= 100;
    }

    // Wire the scroll re-populate handler when there are too few cards.
    if (cards.length < 5) attachMatchesScrollHandler();
    else detachMatchesScrollHandler();

    console.log(`[EmpleoAutomatico] best matches panel opened: ${topN.length} matches`);
  }

  // Build a single <li> for the matches list.
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

  // Click on a per-item Marcar/Marcada button. Toggle behavior, re-uses the
  // same paintMarkButton helper as the inline-card overlay.
  async function onMatchesMarkClick(btn, id) {
    if (!btn || !id) return;
    const match = matchesCurrentTopN.find((m) => m.jobLite.id === id);
    if (!match) {
      // Card disappeared (LaPieza re-rendered). Don't crash — fall back to
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

    let added = 0;
    let already = 0;
    let failed = 0;
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

    // Re-paint per-item buttons. The storage.onChanged listener will also
    // fire, but doing it inline is faster.
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

  // While the panel is open and the listing has fewer than 5 cards, watch
  // window scroll and re-render when LaPieza loads more results. Debounced
  // 800ms to avoid hammering the DOM during fast scroll.
  function attachMatchesScrollHandler() {
    if (matchesScrollHandler) return;
    matchesScrollHandler = () => {
      if (matchesScrollDebounce) clearTimeout(matchesScrollDebounce);
      matchesScrollDebounce = setTimeout(() => {
        matchesScrollDebounce = null;
        if (!matchesPanelEl) return;
        renderMatchesPanelContent();
      }, 800);
    };
    try { window.addEventListener("scroll", matchesScrollHandler, { passive: true, capture: true }); } catch (_) {}
  }
  function detachMatchesScrollHandler() {
    if (matchesScrollHandler) {
      try { window.removeEventListener("scroll", matchesScrollHandler, true); } catch (_) {}
      matchesScrollHandler = null;
    }
    if (matchesScrollDebounce) {
      clearTimeout(matchesScrollDebounce);
      matchesScrollDebounce = null;
    }
  }

  // CSS.escape polyfill that's safe in older Chromium content scripts.
  function cssEscape(value) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      try { return CSS.escape(value); } catch (_) {}
    }
    return String(value).replace(/["\\]/g, "\\$&");
  }

  // Minimal HTML escaper for innerHTML interpolation. We only emit text
  // pulled from the DOM (titles/companies/locations) — the encoded set
  // covers what could break out of the surrounding markup.
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

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

  // =========================================================================
  // Adaptive questions card — render + state machine
  // =========================================================================

  // Re-paint the eamx-questions section based on detectedQuestions /
  // questionAnswers / questionsState. Idempotent. We render every time the
  // panel opens AND every time the state transitions, so the user always
  // sees the latest snapshot. Hidden (display:none via [hidden]) when there
  // are no detected questions to keep the panel tidy.
  function renderQuestionsCard() {
    if (!panelEl) return;
    const host = panelEl.querySelector("[data-eamx-questions]");
    if (!host) return;

    if (!detectedQuestions.length) {
      host.hidden = true;
      host.innerHTML = "";
      return;
    }
    host.hidden = false;

    const headerHtml =
      '<div class="eamx-questions__head">' +
        '<span class="eamx-questions__title">' +
          '<span aria-hidden="true">💬</span> Preguntas detectadas en este formulario' +
        '</span>' +
        '<span class="eamx-questions__count">' +
          escapeHtml(String(detectedQuestions.length)) +
          (detectedQuestions.length === 1 ? ' pregunta' : ' preguntas') +
        '</span>' +
      '</div>';

    if (questionsState === "loading") {
      host.innerHTML = headerHtml +
        '<div class="eamx-questions__status" role="status" aria-live="polite">' +
          '<span class="eamx-cv-card__spinner" aria-hidden="true"></span>' +
          '<span>Generando respuestas con IA…</span>' +
        '</div>' +
        // Show the questions even while loading so the user sees what's coming.
        renderQuestionCardsHtml(/*answersReady*/ false);
      return;
    }

    if (questionsState === "error") {
      host.innerHTML = headerHtml +
        '<div class="eamx-questions__error" role="alert">' +
          escapeHtml(questionsError || "No se pudieron generar las respuestas.") +
        '</div>' +
        '<div class="eamx-questions__actions">' +
          '<button type="button" class="eamx-mini-btn" data-action="questions-retry">Reintentar</button>' +
        '</div>';
      return;
    }

    // success or idle (with detected questions but no fetch yet)
    host.innerHTML = headerHtml + renderQuestionCardsHtml(/*answersReady*/ questionsState === "success");
  }

  // Build the per-question card HTML. We always render textareas (even when
  // empty / loading) so the layout is stable and the user can pre-edit while
  // the backend works. Each card carries data-q-index pointing back into the
  // detectedQuestions array.
  function renderQuestionCardsHtml(answersReady) {
    let out = "";
    for (let i = 0; i < detectedQuestions.length; i++) {
      const q = detectedQuestions[i];
      const ans = answersReady ? (questionAnswers[i] || "") : "";
      out +=
        '<div class="eamx-question-card" data-q-index="' + i + '">' +
          '<p class="eamx-question-label">' + escapeHtml(q.question) + '</p>' +
          '<textarea class="eamx-question-answer" data-q-index="' + i + '" ' +
            'placeholder="' + (answersReady ? '' : 'Generando respuesta…') + '" ' +
            'rows="4">' + escapeHtml(ans) + '</textarea>' +
          '<div class="eamx-question-card__actions">' +
            '<button type="button" class="eamx-mini-btn" data-action="paste-question" ' +
              'data-field-ref="' + escapeHtml(q.fieldRef) + '" data-q-index="' + i + '"' +
              (answersReady ? '' : ' disabled') + '>' +
              '<span aria-hidden="true">✨</span> Pegar en formulario' +
            '</button>' +
          '</div>' +
        '</div>';
    }
    return out;
  }

  // Set state + repaint. Mirrors setCvState — single source of truth.
  function setQuestionsState(next, patch) {
    questionsState = next;
    if (patch) {
      if ("answers" in patch) questionAnswers = Array.isArray(patch.answers) ? patch.answers.slice() : [];
      if ("error" in patch) questionsError = patch.error || "";
    }
    renderQuestionsCard();
  }

  // Kick off ANSWER_QUESTIONS for the currently detected list. Safe to call
  // multiple times — re-entrant calls bail if already loading.
  async function fetchAnswersForDetectedQuestions() {
    if (!lastJob) return;
    if (!detectedQuestions.length) return;
    if (questionsState === "loading") return;
    const questions = detectedQuestions.map((q) => q.question);
    setQuestionsState("loading", { error: "" });
    try {
      const res = await sendMsg({
        type: MSG.ANSWER_QUESTIONS,
        questions,
        job: lastJob
      });
      if (!res || !res.ok) {
        handleQuestionsBackendFailure(res);
        return;
      }
      const answers = Array.isArray(res.answers) ? res.answers : [];
      // Defensive — backend guarantees length match but cheap to verify.
      if (answers.length !== questions.length) {
        setQuestionsState("error", {
          answers: [],
          error: "Servicio de IA temporalmente no disponible. Intenta de nuevo."
        });
        return;
      }
      setQuestionsState("success", { answers, error: "" });

      // Auto-paste — for each detected question, pop the AI-generated
      // answer into its form field. Skip fields we've already pasted
      // this session (idempotency via data-eamx-q-pasted) so re-runs
      // of the scan don't keep overwriting. Stagger 200ms between
      // fields so the visual cyan-pulse fires sequentially, mimicking
      // Express fill.
      for (let i = 0; i < detectedQuestions.length; i++) {
        // Sync the cached questionAnswers so pasteQuestionAnswer reads
        // the right value when there's no panel textarea to source from.
        questionAnswers[i] = answers[i] || "";
      }
      let pastedCount = 0;
      for (let i = 0; i < detectedQuestions.length; i++) {
        const q = detectedQuestions[i];
        const target = q && resolveFieldRef(q.fieldRef);
        // One-shot guard — don't re-paste into a field we already filled.
        if (target?.dataset?.eamxQPasted === "true") continue;
        await new Promise((r) => setTimeout(r, i === 0 ? 0 : 200));
        try {
          if (pasteQuestionAnswer(i)) {
            pastedCount++;
            try { if (target?.dataset) target.dataset.eamxQPasted = "true"; } catch (_) {}
          }
        } catch (_) { /* skip this field, continue with the rest */ }
      }
      if (pastedCount > 0) {
        toast(
          "✓ Respuesta IA pegada. Revisa y dale 'Finalizar' →",
          "success",
          { durationMs: 5000 }
        );
      }
    } catch (err) {
      setQuestionsState("error", { error: humanizeError(err) });
    }
  }

  // Branch the panel UX on the typed error code surfaced by the service-worker.
  function handleQuestionsBackendFailure(res) {
    const code = res && res.error;
    const msg = (res && res.message) || "";
    if (code === ERR.UNAUTHORIZED) {
      setQuestionsState("error", { error: "Inicia sesión para continuar." });
      toast("Inicia sesión para continuar.", "error", {
        label: "Inicia sesión",
        onClick: () => openOptionsPage()
      });
      return;
    }
    if (code === ERR.PLAN_LIMIT_EXCEEDED) {
      setQuestionsState("error", { error: "Llegaste al límite de tu plan." });
      toast("Llegaste al límite.", "error", {
        label: "Ver planes",
        onClick: () => openBilling()
      });
      return;
    }
    // 422 PROFILE_TOO_THIN comes through as INVALID_INPUT — branch on the
    // message text the same way we do in handleGenerateCv.
    if (code === ERR.INVALID_INPUT && /perfil|cv|profile/i.test(msg)) {
      setQuestionsState("error", {
        error: "Sube un CV más completo en Opciones para que la IA tenga más contexto."
      });
      toast("Sube un CV más completo en Opciones.", "info", {
        label: "Abrir Opciones",
        onClick: () => openOptionsPage()
      });
      return;
    }
    if (code === ERR.SERVER_ERROR) {
      setQuestionsState("error", {
        error: "Servicio de IA temporalmente no disponible. Intenta de nuevo."
      });
      return;
    }
    // Catch-all: hide the section and log. The user can still answer manually.
    console.warn("[EmpleoAutomatico] answer-questions failed", res);
    detectedQuestions = [];
    questionAnswers = [];
    setQuestionsState("idle", { answers: [], error: "" });
  }

  // Paste the (possibly edited) answer for question index `i` into its
  // resolved DOM field. Uses the same setNativeValue + input/change/blur
  // sequence as the cover-letter paste, then highlights the field with a
  // 1.5s outline pulse. Returns true if the field was found + filled.
  function pasteQuestionAnswer(i) {
    const q = detectedQuestions[i];
    if (!q) return false;
    // Read the latest user-edited value out of the textarea instead of using
    // the cached questionAnswers — this lets the user tweak the text before
    // pasting.
    const card = panelEl?.querySelector(`.eamx-question-card[data-q-index="${i}"]`);
    const ta = card?.querySelector(".eamx-question-answer");
    const value = ta ? (ta.value || "") : (questionAnswers[i] || "");
    if (!value.trim()) {
      toast("La respuesta está vacía. Genérala o escríbela primero.", "info");
      return false;
    }
    const target = resolveFieldRef(q.fieldRef);
    if (!target) {
      toast("No encontré el campo en el formulario. Recarga e inténtalo.", "error");
      return false;
    }
    try {
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        setNativeValue(target, value);
      } else if (target.isContentEditable) {
        target.textContent = value;
      } else {
        try { target.value = value; } catch (_) {}
      }
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      try { target.dispatchEvent(new Event("blur", { bubbles: true })); } catch (_) {}
    } catch (err) {
      console.warn("[EmpleoAutomatico] paste-question failed", err);
      toast("No se pudo pegar la respuesta.", "error");
      return false;
    }
    // 1.5s outline pulse — class name is honored by occ.css with a reduced-
    // motion override.
    try {
      target.classList.add("eamx-paste-success");
      setTimeout(() => { try { target.classList.remove("eamx-paste-success"); } catch (_) {} }, 1500);
    } catch (_) {}
    return true;
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
    if (action === "questions-retry") return fetchAnswersForDetectedQuestions();
    if (action === "paste-question") {
      const idx = parseInt(btn.getAttribute("data-q-index") || "-1", 10);
      if (Number.isFinite(idx) && idx >= 0) {
        const ok = pasteQuestionAnswer(idx);
        if (ok) toast("Respuesta pegada.", "success");
      }
      return;
    }
  }

  async function handleCancel() {
    try { if (activeDraftId) await sendMsg({ type: MSG.REJECT_DRAFT, draftId: activeDraftId }); } catch (_) {}
    activeDraftId = null; lastDraft = null;
    // Reset the tailored-CV cache so the next vacancy starts fresh.
    cvState = "idle"; cvHtml = ""; cvSummary = ""; cvError = "";
    // Reset the adaptive-questions cache too — different vacancy = different
    // questions, and stale fieldRefs from the prior page would resolve wrong.
    detectedQuestions = []; questionAnswers = []; questionsState = "idle"; questionsError = "";
    // Express pre-warmed draft is keyed by uuid; drop it so a fresh request
    // runs the next time the user enters this same vacancy.
    clearDraftSession();
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
      // Re-fetch question answers too — the regenerated draft may produce a
      // different tone/voice for the same questions.
      if (detectedQuestions.length) fetchAnswersForDetectedQuestions();
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

      // Adaptive questions: also paste each detected question's answer into
      // its target field. Read straight from the panel textareas so the user
      // gets the latest edited text, then fall back to questionAnswers cache.
      let pastedCount = 0;
      if (detectedQuestions.length && questionsState === "success") {
        for (let i = 0; i < detectedQuestions.length; i++) {
          if (pasteQuestionAnswer(i)) pastedCount++;
        }
      }

      closePanel();
      // Adaptive in-flow guidance: keep watching the page after approval so
      // we can light up file inputs, textareas, questions, and the final
      // submit button as the portal's apply flow progresses.
      startFlowAssistant();
      highlightSubmitButton();
      const tail = pastedCount > 0
        ? ` Respondí ${pastedCount} pregunta${pastedCount === 1 ? "" : "s"} también.`
        : "";
      toast("Listo — revisa y da click a 'Enviar' cuando estés conforme." + tail, "success");
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

  // Shared toast helper. The third arg can be either:
  //   - { label, onClick } — adds an action button (8s default duration)
  //   - { label, onClick, durationMs } — same, with custom duration
  //   - { durationMs } — no action button, custom duration
  // When no third arg: 4s info / 4s success / 4s error.
  function toast(message, variant = "info", action) {
    // Single-toast policy: clear any previously-shown toasts so we don't
    // stack on top. All toasts share `position:fixed; left:24px; bottom:24px`,
    // so multiple visible toasts overlap and become unreadable. Sticky
    // toasts (the auto-quiz progress ticker) opt out of cleanup via the
    // .eamx-toast--sticky class so they survive concurrent toast() calls.
    try {
      document.querySelectorAll(".eamx-toast:not(.eamx-toast--sticky)").forEach((t) => {
        try {
          t.classList.remove("eamx-toast--show");
          setTimeout(() => { try { t.remove(); } catch (_) {} }, 200);
        } catch (_) {}
      });
    } catch (_) { /* ignore */ }

    const el = document.createElement("div");
    const v = variant === "success" ? "eamx-toast--success"
      : variant === "error" ? "eamx-toast--error" : "eamx-toast--info";
    el.className = `eamx-toast ${v}`;
    if (action && action.sticky === true) el.classList.add("eamx-toast--sticky");
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
    // Bug history: used requestAnimationFrame to defer the .show class one
    // frame so the CSS transition fires from opacity:0 → 1. Live testing
    // showed that on LaPieza the rAF callback was never invoked (toast
    // stuck at opacity:0, transform:translateY(16px)) — possibly LaPieza
    // suppresses rAF in some routes. Belt-and-suspenders: schedule via
    // BOTH rAF and a 16ms setTimeout. Whichever fires first adds the
    // class; the second is a no-op (classList.add is idempotent).
    requestAnimationFrame(() => el.classList.add("eamx-toast--show"));
    setTimeout(() => el.classList.add("eamx-toast--show"), 16);
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
    // Auto-quiz cleanup. The loop respects quizLoopAborted between every
    // step, so flipping it here lets an in-flight loop unwind safely on
    // SPA navigation / cancel. The .finally() on runAutoQuizLoop also
    // detaches kill switches and clears the sticky toast.
    if (quizLoopActive) {
      quizLoopAborted = true;
    } else {
      detachQuizKillSwitches();
      clearQuizStickyToast();
    }
  }

  function runFlowDetectors() {
    try {
      detectFileInputs();
      detectCoverLetterTextarea();
      detectQuestions();
      detectAdaptiveQuestions();
      // Multiple-choice knowledge quiz auto-answer. The detector is cheap
      // (one querySelector + a button-text scan), so it's safe to run on
      // every MutationObserver tick. The actual loop only starts if a quiz
      // question is detected AND quizLoopActive === false. Idempotency lives
      // inside maybeStartAutoQuizLoop, not here.
      maybeStartAutoQuizLoop();
      detectFinalSubmit();
    } catch (err) {
      console.warn("[EmpleoAutomatico] flow detector error", err);
    }
  }

  // Adaptive in-flow question detection. Called from runFlowDetectors so it
  // re-runs as the SPA mutates the apply form. If we find new questions on a
  // page where we don't have them yet (e.g. user approved on the listing
  // page and LaPieza navigates to a multi-step form), scan + fetch + show
  // a toast pointing the user back at the panel.
  // Idempotent: bails if a fetch is already in flight or if the page hasn't
  // surfaced any new questions since the last scan.
  function detectAdaptiveQuestions() {
    if (questionsState === "loading") return;
    const scanned = scanQuestionFields();
    if (!scanned.length) return;
    // Compare to detectedQuestions by fieldRef set — if the set hasn't
    // changed, the SPA mutation didn't add anything new.
    const oldRefs = new Set(detectedQuestions.map((q) => q.fieldRef));
    const newRefs = new Set(scanned.map((q) => q.fieldRef));
    let same = oldRefs.size === newRefs.size;
    if (same) {
      for (const r of newRefs) { if (!oldRefs.has(r)) { same = false; break; } }
    }
    if (same && questionsState !== "idle") return;

    detectedQuestions = scanned;
    renderQuestionsCard();

    // Auto-fire — no manual "Generar respuestas" button. The user already
    // gave consent by clicking the FAB / running Express; subsequent
    // questions on later steps of the same form should fill themselves
    // without an extra click. Toast is informational only.
    if (!FLOW_TIPS_SHOWN.has("adaptive-questions")) {
      FLOW_TIPS_SHOWN.add("adaptive-questions");
      toast(
        "⚡ Generando respuesta a " + scanned.length + " pregunta" +
        (scanned.length === 1 ? "" : "s") + " con IA…",
        "info",
        { durationMs: 3500 }
      );
    }
    // Kick off the fetch immediately. fetchAnswersForDetectedQuestions
    // will auto-paste each answer once they come back (see the success
    // branch of setQuestionsState).
    fetchAnswersForDetectedQuestions();
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
  //
  // Express-mode coexistence: when the user has Express ON, the floating
  // FAB is the SINGLE entry point — it does cover letter + CV + adaptive
  // questions in one shot. Showing the legacy "✨ Pegar carta IA" inline
  // button on top of that confused users (they'd click the inline button,
  // get only the cover letter, miss the rest of the Express fill).
  //
  // So: skip this detector entirely when Express is enabled. The floating
  // FAB takes over. Users with Express OFF (legacy "Revisión completa"
  // mode) still see the inline Pegar button as before.
  function detectCoverLetterTextarea() {
    if (!lastDraft?.coverLetter) return; // nothing to paste
    // Express coexistence guard — read storage synchronously via cached flag.
    if (cachedExpressMode === true) return;
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
  // Multiple-choice quiz auto-answer
  // =========================================================================
  // SECOND documented exception to HITL. See module-level state notes for
  // the rationale and the three kill switches. Lifecycle:
  //   1) runFlowDetectors → maybeStartAutoQuizLoop (every observer tick).
  //   2) If a quiz is detected and !quizLoopActive, we fire runAutoQuizLoop.
  //   3) The loop walks question-by-question, sending each to the backend
  //      (ANSWER_QUIZ → handleAnswerQuiz → backend.answerQuiz). On a valid
  //      answerKey, click the matching button + the "Siguiente pregunta"
  //      advance button.
  //   4) The loop exits when the next button copy matches FINAL submit (we
  //      stop and let the user click Finalizar) or when the counter shows
  //      we've reached `total`.
  //
  // Why one-question-at-a-time (vs. batch ANSWER_QUESTIONS): the LaPieza UI
  // ONLY shows one quiz question at a time. We can't batch without scraping
  // future questions, which we can't see. Backend-side, single-question
  // calls are also cheaper context — each prompt is small.

  // Regex for the "advance to next question" button text (NOT the final
  // submit button). Mid-quiz the button reads "Siguiente pregunta"; on the
  // last question of the quiz it reads "Continuar". Both are auto-clickable.
  // Anything matching FLOW_FINAL_RX above is a recruiter-side submit and
  // we do NOT auto-click it.
  const QUIZ_NEXT_RX = /^(siguiente\s+pregunta|continuar|siguiente|next)\s*$/i;
  // Option button leading-letter parser. Matches "A)Campo de filtro",
  // "B)foo", etc. — the format LaPieza emits. The capture group gives us
  // the letter to send to the backend.
  const QUIZ_OPTION_RX = /^([A-Z])\)(.*)$/s;
  // Question-text heuristic. Length bounds keep us from mis-classifying
  // a footer paragraph or a tiny tooltip as the question.
  const QUIZ_QUESTION_MIN_LEN = 5;
  const QUIZ_QUESTION_MAX_LEN = 300;
  // Counter regex (e.g. "1 / 15", "  3/15  "). Captures both numbers.
  const QUIZ_COUNTER_RX = /^\s*(\d+)\s*\/\s*(\d+)\s*$/;

  /**
   * Detect the current quiz state on the page. Returns null if no quiz is
   * visible OR if the container has fewer than 2 options (we won't
   * blindly answer a single-option question — could be a non-quiz UI we
   * misclassified).
   *
   * Selector cascade — first match wins:
   *   1) div.details__form__preguntas (the live-verified primary).
   *   2) Any element containing ≥2 button.multi-select-button children.
   *
   * @returns {{
   *   container: HTMLElement,
   *   question: string,
   *   counter: { current: number, total: number } | null,
   *   options: Array<{ key: string, text: string, button: HTMLButtonElement }>,
   *   nextButton: HTMLButtonElement | null
   * } | null}
   */
  function detectQuizQuestion() {
    let container = document.querySelector("div.details__form__preguntas");
    if (!container || !isVisible(container)) {
      // Fallback: any element with ≥2 visible multi-select buttons. We
      // walk up from each button group to find the smallest common
      // ancestor — that's most likely the quiz container.
      const allOptions = Array.from(document.querySelectorAll("button.multi-select-button"))
        .filter(isVisible);
      if (allOptions.length < 2) return null;
      // Cheap heuristic: take the first option's parent as the container.
      // For LaPieza this matches in practice; if it doesn't, the question-
      // text walk below will fail gracefully and we'll bail.
      container = allOptions[0].parentElement || allOptions[0];
    }

    // Options — only direct or nested multi-select buttons inside this
    // container. We re-query (vs. reusing allOptions) because the
    // container fallback may have repositioned us.
    const optionButtons = Array.from(container.querySelectorAll("button.multi-select-button"))
      .filter(isVisible);
    const options = [];
    const seenKeys = new Set();
    for (const btn of optionButtons) {
      const text = (btn.textContent || "").trim();
      const m = text.match(QUIZ_OPTION_RX);
      if (!m) continue;
      const key = m[1].toUpperCase();
      if (seenKeys.has(key)) continue;
      const optText = (m[2] || "").trim();
      if (!optText) continue;
      seenKeys.add(key);
      options.push({ key, text: optText, button: btn });
    }
    if (options.length < 2) return null;

    // Counter — walk the container looking for the X/Y pattern. Limit the
    // scan depth so we don't pick up a footer pagination accidentally.
    let counter = null;
    const counterCandidates = container.querySelectorAll("p, span, div");
    for (const el of counterCandidates) {
      // Skip elements that aren't simple leaves — counter is always a
      // bare "N / M" string in its own node.
      if (el.children && el.children.length > 0) continue;
      const txt = (el.textContent || "").trim();
      const m = txt.match(QUIZ_COUNTER_RX);
      if (m) {
        const cur = parseInt(m[1], 10);
        const tot = parseInt(m[2], 10);
        if (Number.isFinite(cur) && Number.isFinite(tot) && tot > 0) {
          counter = { current: cur, total: tot };
          break;
        }
      }
    }

    // Question text — walk descendants for the first leaf-ish element
    // ending with "?", within length bounds, that ISN'T one of our option
    // buttons. Falling back to the FIRST such element on the document if
    // the container scan finds nothing (LaPieza occasionally renders the
    // question outside the .preguntas div).
    let question = "";
    const pickQuestion = (root) => {
      const walker = root.querySelectorAll("p, div, span, h1, h2, h3, h4, h5, h6");
      for (const el of walker) {
        if (el.children && el.children.length > 0) continue;
        if (el.tagName === "BUTTON") continue;
        const txt = (el.textContent || "").trim();
        if (!txt) continue;
        if (txt.length < QUIZ_QUESTION_MIN_LEN || txt.length > QUIZ_QUESTION_MAX_LEN) continue;
        if (!txt.endsWith("?")) continue;
        if (!isVisible(el)) continue;
        // Skip the counter line if it accidentally ends with "?".
        if (QUIZ_COUNTER_RX.test(txt)) continue;
        return txt;
      }
      return "";
    };
    question = pickQuestion(container) || pickQuestion(document.body);
    if (!question) return null;

    // Next button — visible <button> whose text matches QUIZ_NEXT_RX and
    // ISN'T disabled. We scan globally because LaPieza renders the button
    // outside the .preguntas container.
    let nextButton = null;
    const allButtons = Array.from(document.querySelectorAll("button"));
    for (const btn of allButtons) {
      if (!isVisible(btn)) continue;
      const txt = (btn.textContent || "").trim();
      if (!txt) continue;
      if (!QUIZ_NEXT_RX.test(txt)) continue;
      if (btn.disabled) continue;
      if (btn.getAttribute("aria-disabled") === "true") continue;
      const cls = btn.className || "";
      if (typeof cls === "string" && /\bdisabled\b/i.test(cls)) continue;
      nextButton = btn;
      break;
    }

    return { container, question, counter, options, nextButton };
  }

  /**
   * Idempotent entrypoint called from runFlowDetectors. Starts the loop only
   * if (a) a quiz is currently visible, (b) we're not already running, and
   * (c) we have lastJob + cachedProfile. Pre-flight checks for auth happen
   * lazily — the first ANSWER_QUIZ call returns UNAUTHORIZED if the user is
   * logged out, and we surface that via toast.
   */
  function maybeStartAutoQuizLoop() {
    if (quizLoopActive) return;
    const state = detectQuizQuestion();
    if (!state) return;
    // We have a quiz. Fire the loop (async, non-blocking). The loop itself
    // sets quizLoopActive=true on entry so subsequent observer ticks bail
    // here.
    quizLoopActive = true;
    quizLoopAborted = false;
    quizLastCounter = null;
    runAutoQuizLoop().catch((err) => {
      console.warn("[EmpleoAutomatico] auto-quiz loop error", err);
    }).finally(() => {
      quizLoopActive = false;
      detachQuizKillSwitches();
      clearQuizStickyToast();
    });
  }

  /**
   * Sticky toast that updates in place across questions. We DOM-mutate the
   * existing node instead of spawning a fresh toast — avoids stacking 15
   * toasts on top of each other through a Power BI test.
   */
  function setQuizStickyToast(message, variant = "info") {
    if (!quizStickyToast || !document.body.contains(quizStickyToast)) {
      // Use the regular toast() helper for the first call so styling +
      // animation match. Then capture the DOM node for in-place updates.
      // sticky:true flags the node with .eamx-toast--sticky so future
      // toast() calls don't clobber the in-place quiz progress ticker.
      toast(message, variant, { durationMs: 60000, sticky: true });
      // The toast() helper appends to document.body; grab the most recent
      // .eamx-toast we appended.
      const all = document.querySelectorAll(".eamx-toast");
      quizStickyToast = all.length ? all[all.length - 1] : null;
      return;
    }
    // Update text in place. Keep the variant class accurate.
    const span = quizStickyToast.querySelector("span");
    if (span) span.textContent = message;
    quizStickyToast.classList.remove("eamx-toast--info", "eamx-toast--success", "eamx-toast--error");
    quizStickyToast.classList.add(
      variant === "success" ? "eamx-toast--success"
        : variant === "error" ? "eamx-toast--error" : "eamx-toast--info"
    );
  }

  function clearQuizStickyToast() {
    if (!quizStickyToast) return;
    try {
      quizStickyToast.classList.remove("eamx-toast--show");
      const node = quizStickyToast;
      setTimeout(() => { try { node.remove(); } catch (_) {} }, 400);
    } catch (_) {}
    quizStickyToast = null;
  }

  /**
   * Three kill switches:
   *   1) Esc key during the loop.
   *   2) User clicks any quiz option themselves (detected by the absence of
   *      our `data-eamx-quiz-clicking` flag, which we stamp milliseconds
   *      before our programmatic click).
   *   3) The FINAL submit-to-recruiter button is NEVER auto-clicked —
   *      handled inside the loop by checking FLOW_FINAL_RX on the next
   *      button text.
   */
  function attachQuizKillSwitches() {
    detachQuizKillSwitches();
    quizEscListener = (ev) => {
      if (ev.key === "Escape" || ev.key === "Esc") {
        if (!quizLoopActive) return;
        quizLoopAborted = true;
        toast("Auto-quiz cancelado. Continúa manual.", "info", { durationMs: 4000 });
      }
    };
    quizClickListener = (ev) => {
      if (!quizLoopActive) return;
      const target = ev.target;
      if (!target || !(target.closest)) return;
      const btn = target.closest("button.multi-select-button");
      if (!btn) return;
      // If this click came from us (we set the flag before clicking) it's
      // not a user takeover.
      if (btn.dataset && btn.dataset.eamxQuizClicking === "true") return;
      quizLoopAborted = true;
      toast("Detecté que tomaste el control del quiz. Auto-quiz cancelado.", "info", { durationMs: 4000 });
    };
    document.addEventListener("keydown", quizEscListener, true);
    document.addEventListener("click", quizClickListener, true);
  }

  function detachQuizKillSwitches() {
    if (quizEscListener) {
      try { document.removeEventListener("keydown", quizEscListener, true); } catch (_) {}
      quizEscListener = null;
    }
    if (quizClickListener) {
      try { document.removeEventListener("click", quizClickListener, true); } catch (_) {}
      quizClickListener = null;
    }
  }

  /**
   * Wait for the next quiz question to render. We poll for either:
   *   - the counter changing (current + 1, ideal)
   *   - the question text changing (when no counter is rendered)
   * Returns true on a successful advance, false on stall (3 stalled polls
   * of QUIZ_STALL_POLL_MS each = ~2.4s total budget).
   */
  async function waitForNextQuizQuestion(prevQuestion, prevCounter) {
    for (let i = 0; i < QUIZ_STALL_MAX_POLLS; i++) {
      await new Promise((r) => setTimeout(r, QUIZ_STALL_POLL_MS));
      if (quizLoopAborted) return false;
      const next = detectQuizQuestion();
      if (!next) {
        // Container may be gone — quiz finished (we landed on a confirmation
        // step or the next form section). Treat as success: the caller will
        // re-evaluate and exit the loop cleanly.
        return true;
      }
      const counterAdvanced = prevCounter && next.counter
        && next.counter.current > prevCounter.current;
      const questionChanged = next.question !== prevQuestion;
      if (counterAdvanced || questionChanged) return true;
    }
    return false;
  }

  /**
   * Programmatically click an option button. We stamp a transient
   * `data-eamx-quiz-clicking` flag a frame before dispatching the click so
   * the document-level click kill switch knows this came from us.
   */
  function programmaticClick(btn) {
    try {
      if (btn && btn.dataset) btn.dataset.eamxQuizClicking = "true";
      btn.click();
    } finally {
      // Clear the flag after the event has propagated. Use rAF + microtask
      // so the kill-switch listener (capture phase) runs first and sees
      // the flag, then we strip it before any future user click.
      requestAnimationFrame(() => {
        try { if (btn && btn.dataset) delete btn.dataset.eamxQuizClicking; } catch (_) {}
      });
    }
  }

  /**
   * Main loop. See module-level docs for the HITL story. Stops on:
   *   - quizLoopAborted (Esc / user click)
   *   - QUIZ_MAX_QUESTIONS exceeded (defensive cap)
   *   - Backend error (don't barrel through with bad answers)
   *   - Next button matches FLOW_FINAL_RX (recruiter-side submit — user
   *     confirms manually)
   *   - Stall (3 polls without the counter advancing)
   *   - No more quiz container detected (we cleared the form)
   */
  async function runAutoQuizLoop() {
    // Pre-flight: lastJob + cachedProfile. The Express flow on /vacancy/<uuid>
    // sets both; if we got here without them the apply-side cache restore
    // didn't fire. Bail with an actionable toast.
    if (!lastJob) {
      toast("Auto-quiz: abre la vacante primero para que la IA la lea.", "info", { durationMs: 4500 });
      return;
    }
    if (!cachedProfile) {
      toast("Auto-quiz: sube tu CV en Opciones antes de empezar.", "info", { durationMs: 4500 });
      return;
    }
    attachQuizKillSwitches();

    let answeredOk = 0;
    let totalSeen = 0;

    for (let iter = 0; iter < QUIZ_MAX_QUESTIONS; iter++) {
      if (quizLoopAborted) break;

      const state = detectQuizQuestion();
      if (!state) {
        // Container is gone — quiz finished or LaPieza navigated away.
        break;
      }

      // Track total from the counter, falling back to "?" if not visible.
      if (state.counter && state.counter.total > 0) totalSeen = state.counter.total;
      const currentNum = state.counter ? state.counter.current : (iter + 1);
      const totalLabel = totalSeen || "?";

      // Update sticky toast for THIS question.
      setQuizStickyToast(`IA contestando pregunta ${currentNum}/${totalLabel}...`, "info");

      // Build the request payload. options stripped to just {key, text}.
      const payload = {
        type: MSG.ANSWER_QUIZ,
        question: state.question,
        options: state.options.map((o) => ({ key: o.key, text: o.text })),
        job: lastJob
      };

      let res;
      try {
        res = await sendMsg(payload);
      } catch (err) {
        toast(humanizeError(err), "error");
        break;
      }
      if (!res || !res.ok) {
        // Stop on first error — avoid clicking wrong answers in a panic.
        if (res && res.error === ERR.UNAUTHORIZED) {
          toast("Inicia sesión para continuar el quiz.", "error", {
            label: "Iniciar sesión",
            onClick: () => openOptionsPage()
          });
        } else if (res && res.error === ERR.PLAN_LIMIT_EXCEEDED) {
          toast("Llegaste al límite de tu plan.", "error", {
            label: "Ver planes",
            onClick: () => openBilling()
          });
        } else {
          toast((res && res.message) || "Auto-quiz: la IA no pudo responder.", "error");
        }
        break;
      }

      const answerKey = (res.answerKey || "").toUpperCase();
      const choice = state.options.find((o) => o.key === answerKey);
      if (!choice) {
        // Backend returned a key we don't have in the DOM. Shouldn't happen
        // (handler validates) but defend anyway.
        toast(`Auto-quiz: la IA respondió "${answerKey}" pero no está en pantalla.`, "error");
        break;
      }

      // Verify the option button is still in the DOM (LaPieza may have
      // re-rendered between the request firing and the response landing).
      if (!document.body.contains(choice.button)) {
        // Re-detect and re-find by key.
        const fresh = detectQuizQuestion();
        const refreshed = fresh && fresh.options.find((o) => o.key === answerKey);
        if (!refreshed) {
          toast("Auto-quiz: el quiz cambió justo ahora. Revisa manualmente.", "info");
          break;
        }
        choice.button = refreshed.button;
      }

      if (quizLoopAborted) break;

      programmaticClick(choice.button);
      answeredOk++;

      // Visible pause so the user can see what we picked. Gives them a
      // window to hit Esc if they disagree before we advance.
      await new Promise((r) => setTimeout(r, QUIZ_INTER_ANSWER_DELAY_MS));
      if (quizLoopAborted) break;

      // Re-detect to find the now-enabled next button (LaPieza enables
      // it only after an option is selected). We also re-check the
      // question text to detect mid-tick re-renders.
      const afterClick = detectQuizQuestion();
      const nextBtn = (afterClick && afterClick.nextButton) || state.nextButton;
      if (!nextBtn) {
        // No advance button — likely the final state where the user has to
        // manually click Finalizar. Stop the loop with a friendly toast.
        setQuizStickyToast(
          `✓ Quiz completo. ${answeredOk}/${totalSeen || answeredOk} respondidas. Revisa y dale Continuar.`,
          "success"
        );
        // Convert sticky to auto-dismiss.
        setTimeout(() => clearQuizStickyToast(), 6000);
        return;
      }

      // FINAL submit guard. If the next button reads like a recruiter-side
      // submit (Enviar postulación / Finalizar / Aplicar ahora), we DO NOT
      // click it. The user always confirms the application herself.
      const nextText = (nextBtn.textContent || "").trim();
      if (FLOW_FINAL_RX.test(nextText)) {
        setQuizStickyToast(
          `✓ Quiz listo. ${answeredOk}/${totalSeen || answeredOk} respondidas. Revisa y dale Finalizar tú.`,
          "success"
        );
        setTimeout(() => clearQuizStickyToast(), 6000);
        return;
      }

      // Capture pre-advance signals so waitForNextQuizQuestion can detect
      // the change.
      const prevQuestion = state.question;
      const prevCounter = state.counter;
      quizLastCounter = prevCounter;

      programmaticClick(nextBtn);

      // Wait for either the counter to advance or the container to vanish.
      const advanced = await waitForNextQuizQuestion(prevQuestion, prevCounter);
      if (!advanced) {
        toast("Auto-quiz: no detecté la siguiente pregunta. Revisa manualmente.", "info", { durationMs: 5000 });
        break;
      }

      // Inter-question pause — gives the SPA time to settle and the user
      // a brief window to scan what's about to happen.
      await new Promise((r) => setTimeout(r, QUIZ_INTER_QUESTION_DELAY_MS));
      if (quizLoopAborted) break;

      // If the counter says we're done (current === total before this
      // tick AND no quiz container after advance), we've already drifted
      // past the final question. Re-check on next loop iteration; the
      // detectQuizQuestion null-return up top handles it.
    }

    // Final summary.
    if (quizLoopAborted) {
      // Already toasted by the kill switch — just clean up.
      clearQuizStickyToast();
      return;
    }
    setQuizStickyToast(
      `✓ Quiz completo. ${answeredOk}/${totalSeen || answeredOk} respondidas. Revisa y dale Continuar.`,
      "success"
    );
    setTimeout(() => clearQuizStickyToast(), 6000);
  }

  // =========================================================================
  // Discovery & Queue — listing page badges + queue marker
  // =========================================================================
  // On LaPieza listing routes (/vacantes, /vacancies, /comunidad/jobs, /),
  // we walk the DOM finding vacancy cards, score each one against the
  // user's profile via lib/match-score.js, and inject a small overlay
  // (badge + Marcar button). The button writes to chrome.storage.local
  // under "eamx:queue" via lib/queue.js. The options page renders the
  // same key. Defensive everywhere — the React DOM here re-renders often.

  const LISTING_PATH_RX = [
    /^\/?$/,                      // home (with "Últimas publicaciones")
    /^\/vacantes\/?$/i,
    /^\/vacancies\/?$/i,
    /^\/comunidad\/?(jobs|empleos)?\/?$/i,
    /^\/jobs\/?$/i,
    /^\/empleos\/?$/i
  ];

  // The single most stable signal for "this is a vacancy card": an <a>
  // whose href contains /vacancy/ or /vacante/ followed by any segment.
  //
  // Live LaPieza DOM check (verified via the user's browser) confirmed two
  // URL formats, both valid:
  //   /vacancy/9726cb82-82cc-4061-b74d-854166a2ddbb   (canonical UUID — detail)
  //   /vacante/director-de-ti-confidential-1f1a71    (slug-shorthex — listing)
  // The previous regex required a hex-only start, so it missed the slug
  // form on the listing page (cards begin with letters: "director-de-ti…").
  // Result: matches panel said "No detecté vacantes" with 12 cards present.
  // The relaxed regex captures any non-empty segment; the LaPieza-specific
  // class selector .vacancy-card-link keeps false positives down.
  const VACANCY_ANCHOR_RX = /\/(?:vacancy|vacante)\/([^/?#]+)/i;

  // Module-scoped lazy-loaded helpers. We dynamic-import lib/match-score.js
  // and lib/queue.js the same way we do schemas.js — content scripts can't
  // use static ES imports declared in the manifest.
  let matchScoreModule = null;
  let queueModule = null;
  let cachedProfile = null;
  let profileLoaded = false;
  // Cached user preferences for ranking — { city, citySynonyms, modality,
  // salaryMin, salaryMax, updatedAt }. Loaded lazily by loadPreferencesOnce
  // and refreshed by chrome.storage.onChanged. Passed as the 3rd arg to
  // matchScoreModule.computeMatchScore everywhere we score a card.
  // Default null = "no preferences set" → legacy scoring.
  const PREFERENCES_STORAGE_KEY = "eamx:preferences";
  let cachedPreferences = null;
  let preferencesLoaded = false;
  let listingObserver = null;
  let listingScanTimer = null;

  function isListingPath() {
    const path = location.pathname || "";
    return LISTING_PATH_RX.some((re) => re.test(path));
  }

  // Lazy-load lib/match-score and lib/queue. Returns a boolean indicating
  // whether both are available. Failures are silent — the caller falls back
  // to an "unknown" badge state when the modules aren't loaded.
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

  // One-shot read of the user profile from chrome.storage.local. The key
  // is "userProfile" (STORAGE_KEYS.PROFILE in lib/schemas.js). We cache the
  // result so listing scans are zero-cost; storage.onChanged refreshes it.
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

  // One-shot read of user preferences from chrome.storage.local. Same
  // pattern as loadProfileOnce — null means "not configured", which the
  // scorer treats as legacy mode (no city/modality/salary bonus). The
  // storage.onChanged listener in watchProfileChanges keeps cachedPreferences
  // fresh when the user updates them in the Options page.
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

  // Watch for profile updates so the listing badges refresh after the user
  // uploads a CV in another tab. Also tracks preference changes — when the
  // user updates their city/salary/modality in Options, the visible cards
  // re-score and the matches panel re-renders if it's currently open.
  function watchProfileChanges() {
    try {
      if (!chrome?.storage?.onChanged) return;
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (changes.userProfile) {
          cachedProfile = changes.userProfile.newValue || null;
          profileLoaded = true;
          // Re-score visible cards.
          scheduleListingScan(50);
        }
        if (changes[PREFERENCES_STORAGE_KEY]) {
          // Preferences changed — refresh cache + re-score visible cards
          // + re-render the matches panel if it's open. Sourced from any
          // tab that wrote to chrome.storage.local.
          const next = changes[PREFERENCES_STORAGE_KEY].newValue;
          cachedPreferences = (next && typeof next === "object") ? next : null;
          preferencesLoaded = true;
          scheduleListingScan(50);
          if (matchesPanelEl && document.documentElement.contains(matchesPanelEl)) {
            // Best-effort — fail silently if the panel is mid-render.
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

  // Walk up from a vacancy <a> to its visual card root. We pick the closest
  // ancestor that is (a) block/flex display, (b) at least 80px tall, (c)
  // contains a heading. Bail at 8 levels — beyond that we'd just be picking
  // up sidebar containers.
  function findCardRoot(anchor) {
    if (!anchor) return null;
    // First, check if the anchor itself qualifies as the visual card root.
    // On LaPieza, <a class="vacancy-card-link"> is rendered with display:
    // block + height ~207px and contains the title heading directly. The
    // styled-components wrapper around it is part of the listing GRID,
    // NOT a per-card boundary, so walking up there is wrong.
    //
    // Live DOM check confirmed: walking up 5 levels from the anchor lands
    // on the entire vacancies-grid wrapper (height ~2063px containing all
    // 12 cards). Stamping that wrapper once meant all subsequent
    // injectOverlay calls bailed via the data-eamx-card-overlay guard,
    // and only ONE badge would render (or zero, if the wrapper had no
    // single visible card).
    //
    // New strategy:
    //   1) Try the anchor itself if it's card-shaped (80-600px tall).
    //   2) Walk up, but ONLY accept ancestors whose height < 600px AND
    //      whose subtree contains at most ONE other vacancy anchor
    //      (otherwise we're hitting a multi-card grid).
    const anchorRect = anchor.getBoundingClientRect();
    if (anchorRect.height >= 80 && anchorRect.height <= 600) {
      // The anchor IS the card. Done.
      return anchor;
    }
    let p = anchor.parentElement;
    let depth = 0;
    while (p && depth < 6) {
      try {
        const cs = getComputedStyle(p);
        if (cs.display === "block" || cs.display === "flex" || cs.display === "grid") {
          const rect = p.getBoundingClientRect();
          const tall = rect.height > 80 && rect.height < 600;
          const hasH = !!p.querySelector("h1, h2, h3, h4, [class*='title' i]");
          // Reject multi-card wrappers: if this ancestor contains more
          // than one vacancy-card-link, it's a grid not a card.
          let cardCount = 0;
          try {
            cardCount = p.querySelectorAll("a.vacancy-card-link, a[href*='/vacancy/'], a[href*='/vacante/']").length;
          } catch (_) {}
          if (tall && hasH && cardCount <= 1) return p;
        }
      } catch (_) { /* getComputedStyle can throw on detached nodes */ }
      p = p.parentElement;
      depth++;
    }
    // Last-resort fallback: the anchor itself even if it's outside the
    // 80-600px range. Better to attach the overlay to a slightly-wrong
    // element than to skip the card entirely.
    return anchor;
  }

  // Build a jobLite from a card. This is intentionally cheap: we only need
  // enough to score against, not the full JobPosting shape.
  function extractJobLiteFromCard(card, anchor) {
    const titleEl = card.querySelector("h1, h2, h3, h4, [class*='title' i] strong, [class*='title' i]");
    let title = "";
    if (titleEl) title = cleanText(titleEl.textContent);
    if (!title) {
      // Fallback: anchor text often has the title for LaPieza cards.
      title = cleanText(anchor.textContent);
    }
    const companyEl = card.querySelector("[class*='empresa' i], [class*='company' i], [class*='employer' i]");
    let company = companyEl ? cleanText(companyEl.textContent) : "";
    // Last-ditch: walk through text nodes and pick the second visible non-title text.
    if (!company) {
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
  // Selector strategy: LaPieza-specific class first, generic href regex
  // second. The class selector is the fast path; the regex is the safety
  // net for variants we might not have seen (e.g. featured vacancies in
  // /comunidad with a different wrapper class).
  function findVacancyCards() {
    const seenAnchor = new WeakSet();
    const anchors = [];
    // Defensive: skip anchors inside our own injected UI. Same reasoning
    // as findAllVacancyCards — the matches panel renders /vacante/ links
    // that would otherwise be treated as real listing cards.
    const skipOurs = (a) => isInsideOurUI(a);
    // Fast path: LaPieza emits <a class="vacancy-card-link">.
    document.querySelectorAll("a.vacancy-card-link[href]").forEach((a) => {
      if (skipOurs(a)) return;
      if (!seenAnchor.has(a)) { seenAnchor.add(a); anchors.push(a); }
    });
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
      // For LaPieza the visible card is the wrapper div above the anchor,
      // not the anchor itself (the anchor has the click handler but the
      // wrapper has the grid spacing). findCardRoot walks up to find the
      // wrapper; if it can't, fall back to the anchor itself.
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

  // Inject the overlay (badge + Marcar button) into a card.
  async function injectOverlay({ anchor, card }) {
    try {
      // Stamp the host so we never double-inject.
      card.setAttribute("data-eamx-card-overlay", "1");
      // We need positioning context for the absolute overlay.
      try {
        if (getComputedStyle(card).position === "static") {
          card.style.position = "relative";
        }
      } catch (_) {}

      const jobLite = extractJobLiteFromCard(card, anchor);
      // Score against cached profile + effective prefs (saved with
      // CV-derived fallback). cachedPreferences may be null until
      // loadPreferencesOnce resolves — effectivePreferences handles that
      // and falls back to the implicit defaults from the CV.
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

      // Apply the "poor" fade to the host card when score < 40 so the eye
      // gravitates to better fits without us reordering the listing.
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
      // Stop propagation so clicking the button doesn't navigate via the
      // anchor underneath.
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

  // Throttled re-scan. The MutationObserver below funnels every DOM change
  // through this so infinite-scroll, lazy-load, and React re-renders all
  // converge to a single batched scan after the latest change.
  //
  // Bug history: the original implementation always cleared the pending
  // timer on every call, which meant LaPieza's near-constant DOM mutations
  // (animation classes, polling) would keep deferring the scan to "600ms
  // from now" forever, and the FIRST scan never fired. As a result, the
  // listing page rendered ZERO match badges even though all dependencies
  // had loaded successfully.
  //
  // Fix: a scheduled scan that doesn't reset itself. The first call sets
  // the timer; subsequent calls during the wait window are no-ops. After
  // the scan runs the slot is freed for the next cycle. A small "trailing"
  // re-scan handles late-arriving cards via a separate flag.
  let listingScanPending = false;
  let listingScanTrailing = false;
  function scheduleListingScan(delayMs = 600) {
    if (listingScanPending) {
      // Mark trailing — when the in-flight scan finishes we'll do one more.
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
        // Refresh profile if not yet loaded — must happen before
        // findVacancyCards injects badges.
        if (!profileLoaded) await loadProfileOnce();
        // Walk + inject. injectOverlay is async (it calls isInQueue) but
        // we intentionally don't await — they run concurrently.
        const cards = findVacancyCards();
        cards.forEach((c) => { injectOverlay(c); });
      } finally {
        listingScanPending = false;
        if (listingScanTrailing) {
          listingScanTrailing = false;
          // One trailing scan to catch cards that loaded during the
          // first scan. delayMs = 800 to space them out.
          setTimeout(() => scheduleListingScan(0), 800);
        }
      }
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
    // Tear down any overlays we already injected — they're tied to a card
    // root that may unmount when LaPieza route-changes anyway, but be tidy.
    document.querySelectorAll("[data-eamx-overlay-host]").forEach((el) => {
      try { el.remove(); } catch (_) {}
    });
    document.querySelectorAll("[data-eamx-card-overlay]").forEach((el) => {
      try { el.removeAttribute("data-eamx-card-overlay"); } catch (_) {}
      try { el.classList.remove("eamx-card--poor"); } catch (_) {}
    });
  }

  // Show a toast on /vacancy/<uuid> when the user previously marked this
  // vacancy. Resolves immediately when no queue match — so the FAB-mount
  // path is unaffected for all unmarked jobs.
  let queuedReminderShown = false;
  async function maybeShowQueuedReminder() {
    if (queuedReminderShown) return;
    if (!isJobDetailPage()) return;
    // Listing pages also report isJobDetailPage true now (so the FAB mounts).
    // The reminder only makes sense on /vacancy/<uuid> or /apply/<uuid>.
    if (fabMode() === "listing") return;
    const ok = await ensureDiscoveryDeps();
    if (!ok) return;
    const id = idFromUrl(location.href);
    if (!id) return;
    try {
      const queue = await queueModule.getQueue();
      const found = queue.find((q) => q.id === id && q.source === SOURCE);
      if (!found) return;
      queuedReminderShown = true;
      const when = relativeTimeFromMs(Date.now() - (found.savedAt || Date.now()));
      toast(`⭐ Marcaste esta vacante ${when}. Dale FAB cuando estés listo.`, "info", { durationMs: 5000 });
    } catch (_) { /* ignore */ }
  }

  // Format a relative time. Mirrors the spec: <60s "hace un momento",
  // <60min "hace X min", <24h "hace X h", else "hace X días".
  function relativeTimeFromMs(deltaMs) {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) return "hace un momento";
    const sec = Math.floor(deltaMs / 1000);
    if (sec < 60) return "hace un momento";
    const min = Math.floor(sec / 60);
    if (min < 60) return `hace ${min} min`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `hace ${hr} h`;
    const days = Math.floor(hr / 24);
    return `hace ${days} día${days === 1 ? "" : "s"}`;
  }

  // =========================================================================
  // SPA nav watching & bootstrap
  // =========================================================================

  function detectAndMount() {
    if (isJobDetailPage()) {
      mountFab();
      // Refresh the FAB label whenever we re-evaluate the route (Express ↔
      // listing transitions inside the same SPA session would otherwise
      // leave a stale label in place).
      paintFabLabel();
      // Reminder toast — only relevant on /vacancy/<uuid>, never on listing.
      // The maybeShowQueuedReminder helper itself guards via isJobDetailPage,
      // but it now returns true on listings too, so add an explicit gate.
      if (fabMode() !== "listing") {
        setTimeout(() => { maybeShowQueuedReminder(); }, 1200);
      }
      // Auto-prewarm hook — when the user clicked "⚡ Postular" in the
      // matches panel, a session flag was set keyed on this vacancy's id.
      // On /vacante/, the chain pre-warms + auto-clicks "Me quiero
      // postular" + auto-confirms the location modal. On /apply/, a
      // separate handler reads the "next-apply" flag (set during the
      // vacancy chain) and auto-fires Express fill.
      if (fabMode() === "vacancy") {
        setTimeout(() => maybeAutoPrewarmFromQuickApply(), 1500);
      } else if (fabMode() === "apply") {
        setTimeout(() => maybeAutoFireExpressOnApply(), 600);
      }
    } else {
      // Left the job-detail / listing context entirely — drop the
      // wider-search pool too, since it's listing-scoped and the user's
      // filters may differ on a return visit.
      widerSearchPool = null;
      unmountFab();
      closePanel();
      closeMatchesPanel();
    }

    // Listing-page badges run on a separate axis from the FAB. We scan
    // when on a known listing path; otherwise we tear down so we don't
    // leak overlays into other routes.
    if (isListingPath()) {
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
        // Tailored CV cache is per-vacancy — drop on SPA route change.
        cvState = "idle"; cvHtml = ""; cvSummary = ""; cvError = "";
        // Adaptive questions cache is per-page — drop on SPA route change.
        // The detector re-runs on the new route; old fieldRefs would resolve
        // to nothing once the form unmounts.
        detectedQuestions = []; questionAnswers = []; questionsState = "idle"; questionsError = "";
        // Reset the queued-reminder gate so we re-fire on the new vacancy
        // (or skip on a non-vacancy route).
        queuedReminderShown = false;
        // Tear down listing overlays — they're tied to the previous route's
        // DOM. detectAndMount() below re-arms them if we're still on a
        // listing path.
        stopListingObserver();
        // SPA route changed: tear down any in-flow helpers tied to the old
        // page. The assistant will re-arm if the user approves on the new
        // route. We clear the dedupe set so detectors can re-attach to
        // freshly-rendered inputs/textareas/buttons.
        stopFlowAssistant();
        // Best-matches panel is page-scoped. If the user navigates away
        // mid-shortlist we close it AND drop the wider-search pool — the
        // underlying cards are gone, the user's filters may have changed,
        // and the pool would be misleading on the new route.
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

    const mo = new MutationObserver(throttle(() => {
      if (location.href !== lastUrl) { onChange(); return; }
      const want = isJobDetailPage();
      const have = !!(fabEl && document.body.contains(fabEl));
      if (want && !have) mountFab();
      else if (!want && have) { widerSearchPool = null; unmountFab(); closePanel(); closeMatchesPanel(); }
      else if (want && have) {
        // Same page, but maybe the mode changed (e.g. vacancy page → listing
        // via a SPA nav that didn't fire popstate first). Repaint the label
        // to keep it accurate.
        paintFabLabel();
      }
    }, 600));
    mo.observe(document.body, { childList: true, subtree: true });
  }

  function boot() {
    try {
      // Wire up the user-edit detector early so any text the user types
      // BEFORE the FAB click is preserved by Express fill (we won't clobber
      // a field whose data-eamx-user-edited === "true").
      attachUserEditListener();
      // Profile + queue change watcher (storage.onChanged) — re-render
      // listing badges when the user uploads a new CV or removes from queue
      // in another tab.
      watchProfileChanges();
      detectAndMount();
      watchUrlChanges();
    }
    catch (err) { console.error("[EmpleoAutomatico]", err); }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
