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

  // Version identifier — bumped on every meaningful change to the chain
  // logic. If this log doesn't appear in the user's console after they
  // claim to have reloaded the extension, they're still on the old code.
  // BUMP this on every commit that touches chain behavior so we have a
  // ground truth.
  const EAMX_LAPIEZA_VERSION = "2026-06-07-manual-marker-coverfix";
  console.log(
    `[EmpleoAutomatico] content/lapieza.js loaded — version ${EAMX_LAPIEZA_VERSION}`
  );

  // Proactive health check — Chrome can auto-update the extension or
  // the user can reload it via chrome://extensions WHILE this content
  // script is still loaded in a tab. After that point chrome.runtime
  // disconnects and every sendMessage call fails. We poll every 15s
  // for chrome.runtime.id; the moment it goes away we surface the
  // recovery banner so the user knows to refresh THIS page.
  //
  // Cheap: just a property access; no allocation.
  try {
    setInterval(() => {
      try {
        if (!chrome?.runtime?.id) {
          maybeShowContextLostBanner();
        }
      } catch (_) {
        maybeShowContextLostBanner();
      }
    }, 15000);
  } catch (_) { /* setInterval shouldn't throw, but defend anyway */ }

  const SOURCE = "lapieza";
  const MSG = {
    GENERATE_DRAFT: "GENERATE_DRAFT",
    APPROVE_DRAFT: "APPROVE_DRAFT",
    REJECT_DRAFT: "REJECT_DRAFT",
    OPEN_BILLING: "OPEN_BILLING",
    OPEN_WELCOME: "OPEN_WELCOME",
    OPEN_BACKGROUND_TAB: "OPEN_BACKGROUND_TAB",
    FOCUS_TAB: "FOCUS_TAB",
    GENERATE_CV: "GENERATE_CV",
    GENERATE_CV_PDF: "GENERATE_CV_PDF",
    OPEN_GENERATED_CV: "OPEN_GENERATED_CV",
    ANSWER_QUESTIONS: "ANSWER_QUESTIONS",
    ANSWER_QUIZ: "ANSWER_QUIZ",
    // Pre-flight check used by the matches-panel bulk auto-postular flow
    // to refuse opening 5 background tabs when the user already hit their
    // monthly plan limit. Without this the chain fires N times, all fail
    // with PLAN_LIMIT_EXCEEDED, and the user is left staring at a
    // progress card stuck on "running" forever.
    GET_AUTH_STATUS: "GET_AUTH_STATUS"
  };
  const ERR = { UNAUTHORIZED: "UNAUTHORIZED", PLAN_LIMIT_EXCEEDED: "PLAN_LIMIT_EXCEEDED", EMAIL_NOT_VERIFIED: "EMAIL_NOT_VERIFIED", INVALID_INPUT: "INVALID_INPUT", SERVER_ERROR: "SERVER_ERROR" };
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
        ANSWER_QUIZ: mod.MESSAGE_TYPES.ANSWER_QUIZ || "ANSWER_QUIZ",
        GET_AUTH_STATUS: mod.MESSAGE_TYPES.GET_AUTH_STATUS || "GET_AUTH_STATUS"
      });
      if (mod && mod.ERROR_CODES) Object.assign(ERR, {
        UNAUTHORIZED: mod.ERROR_CODES.UNAUTHORIZED,
        PLAN_LIMIT_EXCEEDED: mod.ERROR_CODES.PLAN_LIMIT_EXCEEDED,
        EMAIL_NOT_VERIFIED: mod.ERROR_CODES.EMAIL_NOT_VERIFIED || ERR.EMAIL_NOT_VERIFIED,
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
  // Sentinel key for the "most recently persisted job in this session".
  // /vacante/ uses slug ids, /apply/ uses UUID ids — they DON'T match,
  // so the URL-specific cache key built from idFromUrl() can't be read
  // on /apply/ after writing on /vacante/. The sentinel solves that:
  // every persistJobToSession also writes here, and restoreJobFromSession
  // falls back to it when the URL-specific lookup misses. Single-job
  // semantics are fine — the user is in one chain at a time per session
  // for the same vacancy.
  const JOB_LATEST_KEY = "eamx:lapieza:job:__latest";

  // Per-tab job cache key (window.sessionStorage). sessionStorage is scoped
  // to the browsing context (tab) and survives same-origin navigation, so
  // it's the ONLY storage that's both (a) carried across /vacante/ → /apply/
  // and (b) isolated per tab. The chrome.storage.session keys below are
  // SHARED across all tabs — fine for a single foreground flow, but in BULK
  // (N background tabs running concurrently) the shared JOB_LATEST_KEY
  // sentinel races: tab A on /apply/ could read tab B's job and apply to A
  // with B's cover letter / track A under B's id. The per-tab cache fixes
  // that; the chrome.storage keys remain as cross-context fallbacks.
  const JOB_TAB_KEY = "eamx:lapieza:job:__tab";

  function persistJobToSession(job) {
    if (!job) return;
    // 1) Per-tab cache (authoritative on /apply/). Race-free across the
    //    concurrent bulk tabs.
    try {
      window.sessionStorage.setItem(
        JOB_TAB_KEY,
        JSON.stringify({ ...job, persistedAt: Date.now() })
      );
    } catch (_) { /* sessionStorage blocked/full — fall back to chrome.storage */ }
    if (!chrome?.storage?.session) return;
    try {
      const key = jobCacheKey(job.url || location.href);
      // Write BOTH the URL-keyed entry (fast path for the same URL on
      // refresh) AND the latest-sentinel entry (cross-URL fallback
      // /vacante/ → /apply/). MV3 returns a Promise on .set; .catch is
      // mandatory or rejections surface as unhandled exceptions.
      Promise.resolve(chrome.storage.session.set({
        [key]: job,
        [JOB_LATEST_KEY]: { ...job, persistedAt: Date.now() }
      })).catch(() => {});
    } catch (_) { /* ignore */ }
  }
  async function restoreJobFromSession() {
    // 0) Per-tab cache FIRST — race-free across concurrent bulk tabs. This
    //    is the authoritative source on /apply/ in the bulk flow.
    try {
      const raw = window.sessionStorage.getItem(JOB_TAB_KEY);
      if (raw) {
        const j = JSON.parse(raw);
        if (j && typeof j === "object" && j.title &&
            (Date.now() - (j.persistedAt || 0) < 15 * 60_000)) {
          return j;
        }
      }
    } catch (_) { /* ignore — fall through to chrome.storage */ }
    if (!chrome?.storage?.session) return null;
    try {
      const urlKey = jobCacheKey(location.href);
      const obj = await new Promise((resolve) => {
        chrome.storage.session.get([urlKey, JOB_LATEST_KEY], (r) => resolve(r || {}));
      });
      // Try URL-specific first (most precise match).
      const urlJob = obj && obj[urlKey];
      if (urlJob && typeof urlJob === "object" && urlJob.title) return urlJob;
      // Fall back to the latest-job sentinel. Stale-guard: 10 minutes
      // — chains finish in under 5 minutes typically, so anything older
      // is probably a leftover from a previous session and should not
      // contaminate the current one.
      const latestJob = obj && obj[JOB_LATEST_KEY];
      if (latestJob && typeof latestJob === "object" && latestJob.title) {
        const age = Date.now() - (latestJob.persistedAt || 0);
        if (age < 10 * 60_000) return latestJob;
      }
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

  // -------------------------------------------------------------------------
  // Wider-search pool cache (session) — avoid re-scanning on return
  // -------------------------------------------------------------------------
  // The wider-search loop pages through up to 40 LaPieza pages (~1-2 min).
  // The pool lives in module memory and survives panel close, BUT a FULL
  // page reload (which LaPieza does on some apply flows, and which a
  // browser Back can trigger) wipes module state → widerSearchPool=null →
  // the panel re-runs the entire scan even though we JUST did it. User
  // report: "si ya postulé en uno, cuando regreso a vacantes vuelve a
  // buscar cuando ya había buscado".
  //
  // Fix: persist the pool to chrome.storage.session (survives reloads
  // within the browser session) keyed by the listing URL (pathname +
  // search, so changing filters still triggers a fresh scan). A 15-min
  // TTL bounds staleness.
  const WIDER_POOL_STORAGE_KEY = "eamx:lapieza:wider-pool";
  const WIDER_POOL_TTL_MS = 15 * 60_000;
  function widerPoolKey() {
    // pathname + search: LaPieza keeps its filters in the query string,
    // so two different filter sets map to two different cache entries.
    return location.pathname + location.search;
  }
  function persistWiderPoolToSession(pool) {
    if (!pool || !pool.size || !chrome?.storage?.session) return;
    try {
      // Strip live DOM refs (anchor/card) — they don't survive a reload
      // and aren't serializable. The panel re-resolves them as needed.
      const entries = Array.from(pool.values()).map((e) => ({
        jobLite: e.jobLite,
        score: e.score,
        reasons: Array.isArray(e.reasons) ? e.reasons : [],
        level: e.level || "unknown",
        appliedFromCard: !!e.appliedFromCard,
        closedFromCard: !!e.closedFromCard
      }));
      Promise.resolve(chrome.storage.session.set({
        [WIDER_POOL_STORAGE_KEY]: { url: widerPoolKey(), savedAt: Date.now(), entries }
      })).catch(() => {});
    } catch (_) { /* ignore */ }
  }
  async function restoreWiderPoolFromSession() {
    if (!chrome?.storage?.session) return null;
    try {
      const obj = await new Promise((resolve) => {
        chrome.storage.session.get([WIDER_POOL_STORAGE_KEY], (r) => resolve(r || {}));
      });
      const cached = obj && obj[WIDER_POOL_STORAGE_KEY];
      if (!cached || typeof cached !== "object" || !Array.isArray(cached.entries)) return null;
      if (cached.url !== widerPoolKey()) return null; // different filters/search
      if (Date.now() - (cached.savedAt || 0) > WIDER_POOL_TTL_MS) return null; // stale
      if (!cached.entries.length) return null;
      const map = new Map();
      for (const e of cached.entries) {
        if (e && e.jobLite && e.jobLite.id) {
          map.set(e.jobLite.id, { ...e, anchor: null, card: null });
        }
      }
      return map.size ? map : null;
    } catch (_) { return null; }
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
  // Generic placeholders that hide the real question — don't trust these
  // as the question source. LaPieza's open-ended Q&A step (live debug on
  // Oportun Lifecycle Marketing Manager 16/18) puts the actual question
  // in a sibling heading and uses "Tu respuesta" as the textarea
  // placeholder, which our heuristic previously prioritized over the
  // heading → looksLikeQuestion returned false → chain skipped the step.
  const GENERIC_PLACEHOLDER_RX = /^(tu\s+respuesta|your\s+answer|escribe.*aqu[íi]?|type\s+(?:your\s+)?answer|respuesta|answer)\s*[.…]?\s*$/i;

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
    // 3) Ancestor headings — checked BEFORE placeholder/aria-label
    // because the real question often lives in a h1-h4 / p above the
    // textarea while placeholder is generic ("Tu respuesta"). Walk up
    // to 5 ancestors looking for a heading sibling or a heading child
    // that isn't an ancestor of the field itself.
    //
    // LaPieza's open-ended Q&A step (live debug on Oportun Lifecycle
    // Marketing Manager 16/18) puts the question in a <p class="
    // MuiTypography-body1"> INSIDE the parent <div class="form"> — not
    // in a heading or as previousElementSibling. So we ALSO scan <p>
    // children, applying a question-shape filter to avoid grabbing
    // unrelated paragraphs like "Postulación a vacante" or counters
    // ("16/18"). The shape filter: must look like a question per
    // looksLikeQuestion() — long enough OR ends with "?" OR contains
    // question words.
    let p = el.parentElement;
    let depth = 0;
    const SKIP_HEADING_RX = /^postulaci[oó]n\s+a\s+vacante|^sobre\s+ti$|^tu\s+respuesta$/i;
    while (p && depth < 5) {
      const headings = Array.from(p.querySelectorAll("h1, h2, h3, h4, legend"));
      for (const h of headings) {
        if (h.contains(el)) continue;
        const t = tryText(h.textContent);
        if (t && t.length >= 20 && t.length < 400) return t;
      }
      // Also scan <p> elements inside this ancestor — they're the most
      // common container LaPieza uses for question prompts on the
      // open-ended Q&A step. Filter by question-shape to avoid grabbing
      // page furniture (titles, breadcrumbs, counters).
      const paragraphs = Array.from(p.querySelectorAll("p"));
      for (const pa of paragraphs) {
        if (pa.contains(el)) continue;
        const t = tryText(pa.textContent);
        if (!t || t.length < 20 || t.length >= 400) continue;
        if (SKIP_HEADING_RX.test(t)) continue;
        if (looksLikeQuestion(t)) return t;
      }
      const prev = p.previousElementSibling;
      if (prev) {
        const t = tryText(prev.textContent);
        if (t && t.length >= 20 && t.length < 400 && !SKIP_HEADING_RX.test(t)) return t;
      }
      p = p.parentElement;
      depth++;
    }
    // 4) Placeholder — but skip generic "Tu respuesta" / "Your answer"
    // type strings that aren't real questions.
    const ph = tryText(el.getAttribute("placeholder"));
    if (ph && !GENERIC_PLACEHOLDER_RX.test(ph)) return ph;
    // 5) aria-label (same generic-skip rule)
    const al = tryText(el.getAttribute("aria-label"));
    if (al && !GENERIC_PLACEHOLDER_RX.test(al)) return al;
    // 6) Last-resort: even generic placeholder is better than nothing.
    if (ph) return ph;
    if (al) return al;
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
    // Bug-fix: the cover-letter textarea is ALSO labeled like a question
    // on LaPieza ("¿Por qué eres la persona ideal para este puesto?"), so
    // looksLikeQuestion happily picks it up — meaning the cover pipeline
    // AND the Q&A pipeline both filled it, AND the Q&A answer (a separate
    // Gemini call) overwrote the carefully-crafted cover letter with a
    // shorter "email-style" response. User reported this as "se pone como
    // dos veces — primero saca el bueno del resumen y luego en otro pega
    // como si fuera correo". Exclude the cover field from the Q&A scan
    // so the cover pipeline owns it cleanly.
    let coverField = null;
    try { coverField = findExpressCoverLetterField(); } catch (_) { /* ignore */ }
    const candidates = Array.from(document.querySelectorAll(
      "textarea, input[type='text']"
    ));
    const out = [];
    const seenRefs = new Set();
    for (const el of candidates) {
      if (out.length >= 10) break;
      // Skip the cover-letter field — owned by the cover pipeline.
      if (coverField && el === coverField) continue;
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
      // If the matches panel is open, keep the FAB hidden through this
      // re-attach (a SPA route eval could otherwise un-hide it).
      setFabHidden(isMatchesPanelOpen());
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
    // Fresh mount while the matches panel is already open → keep it hidden
    // so it doesn't peek out from behind the panel.
    setFabHidden(isMatchesPanelOpen());

    // Show the "first-time FAB" tooltip if this is the user's first
    // mount in any supported portal this install. The tooltip is a
    // small bubble pointing at the FAB that explains what the button
    // does — onboarding friction reducer per user feedback ("para
    // usuario pues esta medio complicado extension no?"). One-shot
    // via chrome.storage.local["eamx:fab-tooltip-seen"].
    try { maybeShowFabFirstUseTooltip(); } catch (_) {}

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

  // First-time tooltip pointing at the FAB. One-shot: persists a
  // flag to chrome.storage.local so subsequent mounts don't show it.
  // The tooltip self-dismisses after 8s OR when the user clicks the
  // FAB / clicks anywhere on the bubble.
  function maybeShowFabFirstUseTooltip() {
    if (!fabEl) return;
    const KEY = "eamx:fab-tooltip-seen";
    try {
      chrome.storage.local.get([KEY], (r) => {
        try {
          if (r && r[KEY]) return; // already shown before
          showFabFirstUseTooltip();
          // Persist immediately so concurrent mounts (multiple
          // SPA route changes in the first 8s) don't all show it.
          try { chrome.storage.local.set({ [KEY]: { setAt: Date.now() } }); } catch (_) {}
        } catch (_) {}
      });
    } catch (_) { /* storage not available — silently skip */ }
  }

  function showFabFirstUseTooltip() {
    // Avoid duplicate: if a tooltip is already mounted, no-op.
    try { document.querySelectorAll(".eamx-fab-tip").forEach((el) => el.remove()); } catch (_) {}
    const tip = document.createElement("div");
    tip.className = "eamx-fab-tip";
    tip.innerHTML = `
      <div class="eamx-fab-tip__head">
        <span class="eamx-fab-tip__title">✨ Tu botón de auto-postular</span>
        <button type="button" class="eamx-fab-tip__close" aria-label="Cerrar" data-eamx-fab-tip-close>✕</button>
      </div>
      <div class="eamx-fab-tip__body">
        Dale click aquí cuando estés en una vacante para que la IA llene la postulación por ti.
      </div>
      <div class="eamx-fab-tip__arrow" aria-hidden="true"></div>
    `;
    document.body.appendChild(tip);
    // Auto-dismiss after 10s.
    const autoDismiss = setTimeout(() => {
      try { tip.classList.add("eamx-fab-tip--leaving"); } catch (_) {}
      setTimeout(() => { try { tip.remove(); } catch (_) {} }, 220);
    }, 10000);
    // Click the bubble (anywhere) or its close button to dismiss early.
    tip.addEventListener("click", () => {
      clearTimeout(autoDismiss);
      try { tip.classList.add("eamx-fab-tip--leaving"); } catch (_) {}
      setTimeout(() => { try { tip.remove(); } catch (_) {} }, 220);
    });
    // Also dismiss when the user actually clicks the FAB.
    const onFabClickOnce = () => {
      clearTimeout(autoDismiss);
      try { tip.remove(); } catch (_) {}
      try { fabEl.removeEventListener("click", onFabClickOnce); } catch (_) {}
    };
    try { fabEl.addEventListener("click", onFabClickOnce); } catch (_) {}
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
  // Hide/show the FAB. The matches panel is a full-height right-side sheet
  // with a HIGHER z-index than the FAB, so an open panel sits ON TOP of the
  // bottom-right FAB — the user sees it as "the button disappeared / is in
  // a weird spot". The FAB is also redundant while the panel is open (its
  // only job on a listing is to OPEN that panel, and the panel has its own
  // ✕). So we hide it for the duration the panel is open and restore it on
  // close. User report: "el botón sale a la izquierda hasta abajo y no se ve".
  function setFabHidden(hidden) {
    if (fabEl) fabEl.classList.toggle("eamx-fab--hidden", !!hidden);
  }
  function isMatchesPanelOpen() {
    return !!(matchesPanelEl && document.documentElement.contains(matchesPanelEl));
  }
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
  // Re-entrancy guard for chainApplyStepsToFinalize. Prevents the FAB
  // click handler from re-entering the chain while it's already running
  // (and prevents the chain from triggering itself via its own internal
  // calls to onFabClickExpressApply for per-step fill).
  let chainInProgress = false;
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

    // Both flag types funnel through onFabClickExpressVacancy, which now
    // does prewarm + runVacancyAutoChain (3s countdown + Esc + auto-click
    // Postularme + auto-confirm location modal + set next-apply flag).
    // Legacy autoprewarm flag also gets the full chain — anyone who
    // clicked ⚡ Postular signaled intent for the full automation.
    try { onFabClickExpressVacancy(); } catch (_) {}
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
  //   - chainInProgress flag prevents concurrent chains from racing
  async function chainApplyStepsToFinalize() {
    console.log("[EmpleoAutomatico] chainApplyStepsToFinalize() called", { chainInProgress, url: location.href.split("?")[0] });
    if (chainInProgress) {
      console.log("[EmpleoAutomatico] chain already in progress, skipping");
      return;
    }
    chainInProgress = true;
    try {
      await chainApplyStepsToFinalizeInner();
    } finally {
      // Guarantee cleanup even if the inner loop throws — without this,
      // a single error trapped chainInProgress=true forever, silently
      // disabling the FAB on /apply/ for the rest of the session.
      try {
        if (quickApplyEscHandler) document.removeEventListener("keydown", quickApplyEscHandler, true);
      } catch (_) {}
      quickApplyEscHandler = null;
      chainInProgress = false;
    }
  }

  // Report this tab's current chain step to the parent matches panel.
  // The parent listens on chrome.storage.session.onChanged for keys
  // prefixed with "eamx:bulk-status:" and patches the corresponding
  // row. Best-effort — if storage isn't available we just skip
  // (chain still runs).
  //
  // step values match BULK_STATUS_LABELS keys: "starting" | "cv" |
  // "cover" | "questions" | "quiz" | "ready" | "submitted" | "error"
  // | "plan_limit". Pass an explicit `label` to override the canned
  // text (e.g. error path: "Sin cuota del plan").
  // Steps we mirror to the backend timeline. Some intermediate steps
  // (e.g. "starting") are too noisy to persist — they happen on every
  // chain re-fire. The set below is "user-visible milestones" that
  // make sense in a postulación detail drawer.
  const TIMELINE_PERSIST_STEPS = new Set([
    "cv", "cv_personalized", "cover", "questions", "quiz",
    "ready", "submitted", "error", "plan_limit", "closed",
    "no_form", "already_applied"
  ]);

  async function reportBulkStatus(step, opts = {}) {
    let jobId = null;
    try {
      jobId = (lastJob && lastJob.id) || null;
      if (!jobId) { try { jobId = idFromUrl(location.href); } catch (_) {} }
      if (!jobId) return;
      if (!chrome?.storage?.session) return;
      const payload = { step, at: Date.now() };
      if (opts.label) payload.label = opts.label;
      await new Promise((resolve) => {
        try {
          chrome.storage.session.set(
            { [`eamx:bulk-status:${jobId}`]: payload },
            () => resolve()
          );
        } catch (_) { resolve(); }
      });
    } catch (_) { /* swallow — local progress card is best-effort */ }

    // ALSO mirror to the backend timeline so the web /account/historial
    // detail drawer can show what happened. Fire-and-forget. Gated by
    // TIMELINE_PERSIST_STEPS so we don't spam with every "starting"
    // re-fire. lastJob.id is required (we need the same id the /track
    // call used).
    if (!jobId || !TIMELINE_PERSIST_STEPS.has(step)) return;
    try {
      const eventPayload = {
        type: MSG.TRACK_EVENT,
        source: SOURCE,
        vacancyId: jobId,
        step
      };
      if (opts.label) eventPayload.label = opts.label;
      if (opts.meta && typeof opts.meta === "object") eventPayload.meta = opts.meta;
      // Bootstrap data — the server auto-creates the application row
      // on the first event if it doesn't exist (mid-chain events
      // before Finalizar otherwise would be no-ops). Sourced from
      // lastJob; safe to send on every event because the backend dedupes.
      if (lastJob && (lastJob.title || lastJob.company || lastJob.url)) {
        eventPayload.bootstrap = {
          url: lastJob.url || location.href,
          title: lastJob.title || "",
          company: lastJob.company || "",
          location: lastJob.location || ""
        };
      }
      // Don't await — fire-and-forget, never block the chain.
      try { sendMsg(eventPayload); } catch (_) {}
    } catch (_) {}
  }

  // Read the eamx:bulk-mode:<jobId> flag. Set by onMatchesBulkApplyTop
  // when this tab was opened from the bulk auto-postular flow. The
  // chain reads it at startup to decide whether to auto-click Finalizar
  // (bulk = yes, with countdown) or stay HITL (individual ⚡ Postular).
  //
  // Uses idFromUrl (NOT a local regex) so the id extraction is exactly
  // the same as the one used to SET the flag from m.jobLite.id in
  // onMatchesBulkApplyTop. Prior version used a different regex,
  // causing mismatched keys on UUIDs that didn't fit idFromUrl's
  // hex-prefix shape — user saw "✓ Listo — dale Finalizar" (HITL) on
  // rows that should have auto-finalized.
  async function readBulkModeFlag() {
    try {
      let jobId = (lastJob && lastJob.id) || null;
      if (!jobId) {
        try { jobId = idFromUrl(location.href); } catch (_) {}
      }
      console.log("[EmpleoAutomatico bulk] readBulkModeFlag: jobId=", jobId);
      if (!jobId || !chrome?.storage?.session) {
        console.log("[EmpleoAutomatico bulk] no jobId or no storage.session");
        return false;
      }
      const key = `eamx:bulk-mode:${jobId}`;
      const flag = await new Promise((resolve) => {
        try {
          chrome.storage.session.get([key], (r) => resolve(r ? r[key] : null));
        } catch (_) { resolve(null); }
      });
      console.log("[EmpleoAutomatico bulk] flag for key", key, "=", flag);
      if (!flag) return false;
      if (Date.now() - (flag.setAt || 0) > 15 * 60_000) {
        try { chrome.storage.session.remove([key]); } catch (_) {}
        console.log("[EmpleoAutomatico bulk] flag is stale, removed");
        return false;
      }
      console.log("[EmpleoAutomatico bulk] BULK MODE ACTIVE for", jobId);
      return true;
    } catch (e) {
      console.warn("[EmpleoAutomatico bulk] readBulkModeFlag threw", e);
      return false;
    }
  }

  // Clear the bulk-mode flag for this tab. Called after auto-finalize
  // (or after the chain aborts) so re-opening the same vacancy later
  // doesn't accidentally inherit the auto-finalize behavior.
  function clearBulkModeFlag() {
    try {
      let jobId = (lastJob && lastJob.id) || null;
      if (!jobId) { try { jobId = idFromUrl(location.href); } catch (_) {} }
      if (!jobId || !chrome?.storage?.session) return;
      chrome.storage.session.remove([`eamx:bulk-mode:${jobId}`]);
    } catch (_) {}
  }

  // Handle the "chain is ready, Finalize is the next button" branch.
  // Two code paths reach this state (one when no fillable fields are
  // detected up front, another after Express fill finishes) so the
  // logic is extracted to avoid drift.
  //
  // bulkMode=true → runs a 5s countdown (cancelable with Esc) then
  //                 programmaticClicks Finalizar. attachFinalize
  //                 ApplyTracker fires "submitted" via its click
  //                 listener so the parent panel marks the row done.
  // bulkMode=false → stays HITL: highlights the button, attaches the
  //                  tracker, shows "✓ Listo. Dale Finalizar".
  async function handleReadyToFinalize(finalizeBtn, bulkMode) {
    if (!finalizeBtn) return;
    try { highlightExpressSubmitButton(); } catch (_) {}
    attachFinalizeApplyTracker(finalizeBtn);
    reportBulkStatus("ready");

    if (!bulkMode) {
      // HITL: the user clicks Finalizar themselves.
      toast("✓ Listo. Revisa todo y dale Finalizar.", "success", { durationMs: 6000 });
      return;
    }

    // BULK: countdown + auto-click. The grace period lets the user
    // hit Esc if they want to review before submitting. Status step
    // = "finalizing" so the row shows a spinning dot, NOT the green
    // ready check (which would falsely suggest the submit happened).
    toast("⚡ Auto-finalizando en 5s… (Esc cancela)", "info", { durationMs: 4500 });
    for (let i = 5; i > 0; i--) {
      if (quickApplyAborted) {
        reportBulkStatus("ready");
        toast("Auto-finalize cancelado. Dale Finalizar tú.", "info", { durationMs: 4000 });
        clearBulkModeFlag();
        return;
      }
      reportBulkStatus("finalizing", { label: `Auto-finalizando en ${i}s…` });
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (quickApplyAborted) {
      clearBulkModeFlag();
      return;
    }

    // Re-find the button — DOM might have changed during the
    // countdown. If it vanished, bail gracefully.
    const stillThere = findApplyFlowFinalizeBtn() || finalizeBtn;
    if (!stillThere || !document.body.contains(stillThere)) {
      reportBulkStatus("error", { label: "Botón Finalizar desapareció" });
      clearBulkModeFlag();
      return;
    }

    // Re-attach the tracker to `stillThere` in case LaPieza re-rendered
    // the Finalizar button during the 5s countdown. Without this, the
    // tracker is on the OLD button (now detached) and the click on the
    // NEW one fires no upsertApplied → the daily cap counter never
    // increments. attachFinalizeApplyTracker has its own data-attribute
    // guard so re-attaching the same button is a no-op.
    attachFinalizeApplyTracker(stillThere);

    // Clear the flag BEFORE clicking so the click handler in
    // attachFinalizeApplyTracker doesn't accidentally re-read a stale
    // bulk flag if the page re-mounts our content script.
    clearBulkModeFlag();
    try {
      programmaticClick(stillThere);
      // reportBulkStatus("submitted") fires from the tracker's
      // capture-phase click listener (attached in
      // attachFinalizeApplyTracker). No need to duplicate it here.
    } catch (e) {
      console.warn("[EmpleoAutomatico] auto-finalize click failed", e);
      reportBulkStatus("error", { label: "No pude dar click a Finalizar" });
    }
  }

  async function chainApplyStepsToFinalizeInner() {
    console.log("[EmpleoAutomatico] chain inner: starting", { isApplyPage: isApplyPage(), url: location.href.split("?")[0] });
    quickApplyAborted = false;
    // Restore the vacancy cached on /vacante/ as EARLY as possible. The SPA
    // nav to /apply/ nulled lastJob (watchUrlChanges), and the auto-quiz
    // loop — armed independently by the flow assistant ~1.2s after /apply/
    // — bails AND stickily disables itself (FLOW_TIPS_SHOWN "auto-quiz-no-job")
    // if it fires while lastJob is null. On a CV→quiz form (no cover/Q&A step
    // to restore lastJob first) that left the quiz unanswered and the chain
    // stalling in its 90s wait. Restoring here, before any step renders,
    // guarantees the quiz step has job context. (Quiz-vacancy blocker fix.)
    if (!lastJob) {
      try {
        const cachedJob = await restoreJobFromSession();
        if (cachedJob) lastJob = cachedJob;
      } catch (_) { /* deep-linked w/o cache — the no-job toast guides the user */ }
    }
    // RESET stateful flags from any previous chain run on this same
    // URL. watchUrlChanges resets these on SPA navigation but a manual
    // history back→forward to the same /apply/<uuid> doesn't change
    // location.href, so the previous run's cvState="success" /
    // questionsState="success" would suppress fresh fetches.
    cvState = "idle"; cvHtml = ""; cvSummary = ""; cvError = "";
    detectedQuestions = []; questionAnswers = []; questionsState = "idle"; questionsError = "";
    reportBulkStatus("starting");
    // Arm the manual-entry watcher here too (not just in detectAndMount) so the
    // persistent field marker is GUARANTEED active during a chain run — the
    // detectAndMount arming proved unreliable on chain-driven navs. Idempotent.
    try { startManualEntryWatcher(); } catch (_) {}

    // Install the Esc kill switch FIRST so the user can cancel during
    // any pre-flight (auth check, terminal-state detectors, 30s no-form
    // poll). Previously the handler was installed after these blocking
    // checks, leaving a ~30+ s window where Esc did nothing.
    quickApplyEscHandler = (ev) => {
      if (ev.key === "Escape" || ev.key === "Esc") {
        quickApplyAborted = true;
        try { document.removeEventListener("keydown", quickApplyEscHandler, true); } catch (_) {}
        quickApplyEscHandler = null;
        toast("Cadena cancelada. Continúa manual.", "info");
      }
    };
    try { document.addEventListener("keydown", quickApplyEscHandler, true); } catch (_) {}

    // Detect bulk mode early. If true, the "ready" step at the end of
    // the chain runs a 5s countdown then auto-clicks Finalizar. ESC
    // (via quickApplyAborted) cancels the countdown.
    const isBulkMode = await readBulkModeFlag();
    console.log("[EmpleoAutomatico] chain inner: bulk mode =", isBulkMode);

    // TERMINAL-STATE DETECTORS: before doing any work, check if this
    // vacancy is "already applied" or "closed" — both states mean the
    // chain can't progress and the parent panel needs a clear signal
    // (NOT just "Postulando…" forever). Wait briefly for LaPieza to
    // hydrate (banner sometimes paints 200-400ms after route change)
    // then sample.
    await new Promise((r) => setTimeout(r, 600));
    if (detectAlreadyAppliedState()) {
      console.log("[EmpleoAutomatico] chain inner: ALREADY APPLIED — bailing");
      reportBulkStatus("already_applied");
      quickApplyAborted = true;
      // Persist the applied-state to our local queue so future bulks
      // skip this vacancy at the filter step. Best-effort.
      try {
        const id = idFromUrl(location.href);
        if (id && queueModule && queueModule.upsertApplied) {
          await queueModule.upsertApplied({
            id,
            source: SOURCE,
            url: location.href,
            title: (lastJob && lastJob.title) || "",
            company: (lastJob && lastJob.company) || "",
            location: (lastJob && lastJob.location) || "",
            savedAt: Date.now(),
            matchScore: 0,
            reasons: ["Detectada como ya postulada al abrir la vacante"]
          });
        }
      } catch (_) {}
      clearBulkModeFlag();
      return;
    }
    if (detectVacancyClosedState()) {
      console.log("[EmpleoAutomatico] chain inner: VACANCY CLOSED — bailing");
      reportBulkStatus("closed");
      quickApplyAborted = true;
      clearBulkModeFlag();
      return;
    }

    // NO-FORM TIMEOUT: poll up to 30s for any actionable apply-form
    // element (CV step, cover field, Q&A textarea, quiz button, or
    // Finalizar button). If nothing shows up the page is stuck and
    // we report a friendly error rather than spinning the loop on
    // empty DOM forever. Live bug: tabs reaching /apply/<uuid> for
    // a vacancy whose page failed to render the form sat on
    // "Postulando…" indefinitely (user couldn't tell why).
    {
      const NO_FORM_TIMEOUT_MS = 30_000;
      const POLL_MS = 1000;
      const startedAt = Date.now();
      let foundForm = false;
      while (Date.now() - startedAt < NO_FORM_TIMEOUT_MS) {
        if (quickApplyAborted) break;
        if (applyPageHasAnyFormElement()) { foundForm = true; break; }
        // Mid-poll, re-check the terminal-state detectors in case the
        // closed/applied banner painted later than the 600ms warmup.
        if (detectAlreadyAppliedState()) {
          reportBulkStatus("already_applied");
          quickApplyAborted = true;
          clearBulkModeFlag();
          return;
        }
        if (detectVacancyClosedState()) {
          reportBulkStatus("closed");
          quickApplyAborted = true;
          clearBulkModeFlag();
          return;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      if (!foundForm && !quickApplyAborted) {
        console.log("[EmpleoAutomatico] chain inner: NO FORM after 30s — bailing");
        reportBulkStatus("no_form");
        quickApplyAborted = true;
        clearBulkModeFlag();
        return;
      }
    }

    // PRE-FLIGHT: refuse to start the chain at all if the user has zero
    // remaining quota. Without this gate the chain would show
    // askCvChoice (asking "use principal or personalize?"), the user
    // would pick "personalize", tryUploadTailoredCv would fail with
    // PLAN_LIMIT_EXCEEDED and fall back to PRINCIPAL silently, then the
    // cover step would ALSO fail with PLAN_LIMIT_EXCEEDED and show the
    // plan-limit modal — by which point the user already chose a CV
    // for nothing. User reported case: "desde ahi deberia de decirme
    // que ya no tengo" (screenshot showed the CV picker appearing
    // first instead of the plan-limit modal).
    try {
      const auth = await sendMsg({ type: MSG.GET_AUTH_STATUS });
      if (auth && auth.ok && auth.loggedIn && auth.usage) {
        const limit = Number(auth.usage.limit);
        const current = Number(auth.usage.current) || 0;
        if (limit !== -1 && Number.isFinite(limit) && current >= limit) {
          // Show the pretty modal directly and refuse the chain. No
          // toast — the modal is the message. Marking the chain as
          // aborted (via the same flag the Esc handler sets) lets any
          // downstream observer ticks bail out gracefully.
          quickApplyAborted = true;
          reportBulkStatus("plan_limit");
          await showPlanLimitModal({
            feature: "postulaciones IA",
            usage: { current, limit },
            planName: (auth.user && auth.user.plan) || ""
          });
          return;
        }
      }
    } catch (_) { /* network blip — proceed; mid-chain failures handle the limit too */ }

    // Esc handler already installed at the top of this function so it's
    // active during the pre-flight + terminal-state detectors above.
    toast("⚡ Cadena: te llevo paso a paso… (Esc cancela)", "info", { durationMs: 4500 });
    console.log("[EmpleoAutomatico] chain inner: toast fired, entering loop");

    // Loop-stuck detector. Computes a cheap signature of the page each
    // iteration. If the signature matches the previous iter AND we
    // didn't take any meaningful action (CV/quiz-warn/fill), we count
    // it as a "no-op" tick. Three consecutive no-ops → bail with a
    // friendly toast pointing the user to do it manually.
    //
    // Live bug (user logs 2026-05-25): chain ran 20 iterations clicking
    // Continuar with no progress because LaPieza's quiz DOM changed
    // and our detector missed it. The chain went silent without
    // telling the user — the new detector turns that into a clear
    // "no pude avanzar" toast at iter 4-5 instead of iter 19.
    let lastDomSignature = "";
    let stuckTicks = 0;
    const MAX_STUCK_TICKS = 3;
    // Tracks whether the chain has done real work (CV step handled, cover/
    // Q&A filled, or a quiz step processed). Used to recognize the FINAL
    // submit step: on some LaPieza forms (e.g. ERM) the submit button is
    // labeled "Continuar" (not "Finalizar"), so findApplyFlowFinalizeBtn()
    // misses it. Once the work is done, a bare "Continuar" with nothing
    // left to fill is almost certainly the submit — in HITL we must STOP
    // there instead of clicking it (auto-submit = broken HITL contract).
    let didProductiveWork = false;
    function computeDomSignature() {
      try {
        const url = location.href.split("?")[0];
        const main = document.body.innerText.slice(0, 800).replace(/\s+/g, " ");
        return `${url}|${main}`;
      } catch (_) { return Math.random().toString(); }
    }

    // Iteration cap. Live data (Oportun Lifecycle Marketing Manager, 18-Q
    // quiz + 2-3 open-ended questions): the chain needs to survive the
    // quiz-wait loop AND the per-step Continuar clicks that come after.
    // 8 was too low — chain exited at iter 7 while the quiz was still on
    // question 6 of 18, so the open-ended Q&A step never got reached by
    // the in-chain runExpressFill call. 20 gives comfortable headroom.
    for (let i = 0; i < 20; i++) {
      console.log("[EmpleoAutomatico] chain iter:", i, { aborted: quickApplyAborted, isApplyPage: isApplyPage() });
      if (quickApplyAborted) break;
      if (!isApplyPage()) break;

      // Wait for current step's DOM to settle before scanning. After a
      // Continuar click LaPieza needs ~600-1200ms to swap step content;
      // 1000ms is a safe middle ground.
      await new Promise((r) => setTimeout(r, 1000));
      console.log("[EmpleoAutomatico] chain iter:", i, "post-wait");
      if (quickApplyAborted) break;
      if (!isApplyPage()) break;

      // PRIORITY 1: Quiz-warning modal ("Toma en cuenta lo siguiente").
      // This modal can pop AFTER the cover step AS AN OVERLAY — meaning
      // the CV-step background text is STILL in the DOM, fooling
      // isOnLaPiezaCvStep into a false positive. Live user screenshot
      // showed the CV-choice modal stacked on top of the quiz-warning
      // modal. Check overlay-modal CTAs FIRST so they take precedence.
      console.log("[EmpleoAutomatico] chain iter:", i, "checking quizWarn");
      const quizWarnBtn = findLaPiezaQuizWarningCTA();
      if (quizWarnBtn) {
        console.log("[EmpleoAutomatico] chain iter:", i, "quizWarn FOUND, clicking");
        try { quizWarnBtn.click(); } catch (_) {}
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }

      // PRIORITY 2: CV step (only when no overlay modal is active).
      // Order matters here — moving CV step ahead of quiz-warn earlier
      // fixed the 90s quiz-wait false positive. Now we put quiz-warn
      // BACK to first because it's a more specific modal-overlay signal,
      // while looksLikeQuizStep's false positive on CV-step radios is
      // already fixed (c2822de — walk up empty MUI labels).
      const onCvStepEarly = isOnLaPiezaCvStep();
      console.log("[EmpleoAutomatico] chain iter:", i, "onCvStep:", onCvStepEarly);
      if (onCvStepEarly) {
        console.log("[EmpleoAutomatico] chain iter:", i, "→ CV step branch (bulk=", isBulkMode, ")");
        reportBulkStatus("cv");
        let choice = "principal";
        // Bulk mode: SKIP the CV-choice modal entirely. The user already
        // committed to "Auto-postular top N" — popping a modal on every
        // background tab they can't even see (and that times out after
        // 8s, blocking the chain) is exactly the "stuck en cv y ya no
        // avanzo ni naa" bug they reported. Default to PRINCIPAL so we
        // don't surprise them with a personalized-CV charge per slot.
        if (!isBulkMode) {
          try { choice = await askCvChoice({ timeoutMs: 8000 }); } catch (_) {}
        }
        if (quickApplyAborted) break;
        if (!isApplyPage()) break;
        if (choice === "personalize") {
          try { await tryUploadTailoredCv(); } catch (e) {
            console.warn("[EmpleoAutomatico] tryUploadTailoredCv threw", e);
          }
          if (quickApplyAborted) break;
          if (!isApplyPage()) break;
        } else if (!isBulkMode) {
          // Silent in bulk mode (would be confusing in a background tab).
          toast("Listo, sigo con tu CV PRINCIPAL.", "info", { durationMs: 2500 });
        }
        const continueBtnCv = findApplyFlowContinueBtn();
        if (continueBtnCv) { try { continueBtnCv.click(); } catch (_) {} }
        didProductiveWork = true;
        continue;
      }

      // Quiz step → auto-quiz module handles. Wait for its radios to
      // disappear before we look for Continuar. Cap wait at 90s in case
      // the quiz hangs.
      console.log("[EmpleoAutomatico] chain iter:", i, "checking quizStep");
      const isQuizStep = looksLikeQuizStep();
      console.log("[EmpleoAutomatico] chain iter:", i, "quizStep:", isQuizStep);
      if (isQuizStep) {
        reportBulkStatus("quiz");
        didProductiveWork = true;
        const startedAt = Date.now();
        while (looksLikeQuizStep() && Date.now() - startedAt < 90_000) {
          if (quickApplyAborted) break;
          // The "quiz" container can park on a free-text question we don't
          // auto-fill (e.g. Konfío's "¿De qué volumen es tu cartera
          // activa?" at 16/19): looksLikeQuizStep stays true, so without
          // this the chain would just wait 90s then bail SILENTLY (the
          // recurring "ahi se quedó"). The standing watcher can miss it
          // (arming/race), but the chain is reliably running — so prompt
          // here too (deduped via manualEntryPrompted). Never auto-fills.
          try { promptManualEntryIfBlocked(); } catch (_) {}
          await new Promise((r) => setTimeout(r, 1500));
        }
        if (quickApplyAborted) break;
        continue;
      }

      // Detect the step state FIRST. We need to know whether there are
      // fillable fields before treating Finalize as a stop signal —
      // LaPieza shows Finalize on the cover step of short forms (only
      // 2 steps total: CV + Cover-with-Finalize), so an early bail
      // would skip the cover-letter fill entirely. Live test on
      // /apply/c77e3107... (Ejecutivo de Ventas B2B en E-Bitware)
      // proved this: cover textarea was pre-filled with the user's
      // profile summary, Finalize was visible, chain bailed → user
      // got the generic "Soy un líder comercial..." copy instead of a
      // personalized cover letter.
      const onCvStep = isOnLaPiezaCvStep();
      let hasCover = false, hasQuestions = false;
      if (!onCvStep) {
        try { hasCover = !!findExpressCoverLetterField(); } catch (_) {}
        try { hasQuestions = (scanQuestionFields() || []).length > 0; } catch (_) {}
      }
      const hasFillable = hasCover || hasQuestions;
      const finalizeBtn = findApplyFlowFinalizeBtn();
      console.log("[EmpleoAutomatico] chain step check:", {
        onCvStep,
        hasCover,
        hasQuestions,
        hasFinalize: !!finalizeBtn,
        url: location.href.split("?")[0]
      });

      // Final step (no fillable fields, no CV step pending) → STOP.
      // Delegate to handleReadyToFinalize so bulk mode can auto-click
      // (with countdown) and HITL mode shows the friendly toast.
      if (finalizeBtn && !hasFillable && !onCvStep) {
        await handleReadyToFinalize(finalizeBtn, isBulkMode);
        break;
      }

      // onCvStep here is ALWAYS false because we already handled the CV
      // step at the top of this iteration (the "onCvStepEarly" branch),
      // and that branch `continue`d. The redundant branch was removed
      // when we moved CV detection ahead of the quiz-check choke point.
      if (hasFillable) {
        didProductiveWork = true;
        // Report what we're about to do — prefer "cover" if a cover
        // textarea is visible, fall back to "questions" otherwise.
        // Both can be true (open-ended Q&A often coexists with the
        // cover field); we surface whichever felt more user-facing.
        reportBulkStatus(hasCover ? "cover" : "questions");
        // Run Express fill on this step. singleStep:true so
        // onFabClickExpressApply doesn't recurse back into
        // chainApplyStepsToFinalize. forceOverwrite:true → since the
        // user explicitly clicked ⚡ Postular, we replace LaPieza's
        // pre-existing cover letter text from a previous submission.
        try {
          await onFabClickExpressApply({
            skipCv: true,
            singleStep: true,
            forceOverwrite: true
          });
        } catch (_) {}
        await new Promise((r) => setTimeout(r, 2200));
        if (quickApplyAborted) break;
        if (!isApplyPage()) break;
      } else {
        // No fillable fields, not CV, not quiz. A bare "Continuar" here is
        // ambiguous: a mid-flow advance vs the FINAL submit. Some LaPieza
        // forms (e.g. ERM) label the submit button "Continuar" (not
        // "Finalizar"), so findApplyFlowFinalizeBtn() misses it and we'd
        // click it = auto-submit. Once we've done the real work
        // (CV/cover/Q&A/quiz), this bare step is almost certainly the
        // submit, so treat it as the finalize step: HITL STOPS (the user
        // sends it), bulk runs the normal countdown+click+track.
        if (didProductiveWork) {
          const submitLike = findApplyFlowContinueBtn();
          if (submitLike) {
            if (!isBulkMode) {
              try { highlightExpressSubmitButton(); } catch (_) {}
              try { attachFinalizeApplyTracker(submitLike); } catch (_) {}
              reportBulkStatus("ready");
              toast("✓ Listo. Revisa todo y dale tú el último botón para enviar.", "success", { durationMs: 8000 });
              break;
            }
            await handleReadyToFinalize(submitLike, true);
            break;
          }
        }
        console.log("[EmpleoAutomatico] chain step: no cover/Q&A and not CV step, will just click Continuar");
      }

      // After filling (or skipping), if Finalize is now the only path
      // forward (no Continuar button visible), we're done. STOP here
      // instead of looping forever waiting for a Continuar that won't
      // come.
      if (finalizeBtn && !findApplyFlowContinueBtn()) {
        await handleReadyToFinalize(finalizeBtn, isBulkMode);
        break;
      }

      // Click Continuar to advance.
      const continueBtn = findApplyFlowContinueBtn();
      if (continueBtn) {
        try { continueBtn.click(); } catch (_) {}
      }
      // If neither Continuar nor Finalizar is visible, we'll loop again
      // (the DOM may still be settling after a previous click).

      // LOOP-STUCK DETECTOR: if the DOM signature hasn't changed and we
      // didn't take a meaningful action this iter (no CV branch, no
      // quiz-warn click, no fillable Express run), count it as a no-op
      // tick. After MAX_STUCK_TICKS consecutive no-ops, bail with a
      // friendly toast so the user knows the chain gave up here. Better
      // than running silently through 20 iters.
      const sig = computeDomSignature();
      if (sig === lastDomSignature && !hasFillable) {
        stuckTicks++;
        console.log("[EmpleoAutomatico] chain: stuck tick", stuckTicks, "of", MAX_STUCK_TICKS);
        if (stuckTicks >= MAX_STUCK_TICKS) {
          console.log("[EmpleoAutomatico] chain: stuck — bailing");
          toast(
            "No pude avanzar este paso. Continúa manual desde aquí.",
            "info",
            { durationMs: 7000 }
          );
          reportBulkStatus("error", { label: "Atascado — revisa la pestaña" });
          break;
        }
      } else {
        stuckTicks = 0;
      }
      lastDomSignature = sig;
    }
    // chainApplyStepsToFinalize() wrapper handles esc-listener cleanup
    // and chainInProgress release in its finally block.
  }

  // Heuristic: are we on a quiz step? Quiz steps have multiple visible
  // radio buttons inside option-card structures. CV-selection radios
  // (also radios) live inside cards labelled "PRINCIPAL" / "CV - ...";
  // we exclude those.
  //
  // Why `closest()` alone wasn't enough: LaPieza's CV step wraps each
  // radio in `<label class="MuiFormControlLabel-root">` (matched by the
  // `label` selector) but the actual CV title text ("CV - EDUARDO ...
  // PRINCIPAL") lives in a SIBLING `<div class="MuiBox-root">`, so the
  // label's textContent is empty and the exclusion regex never fires.
  // Result: looksLikeQuizStep was incorrectly returning true on the CV
  // step, which short-circuited isOnLaPiezaCvStep and the chain went
  // into a 90s quiz wait on the CV screen. Fix: if the closest match
  // has empty text, widen the search by walking up to 5 ancestors and
  // taking the FIRST one with meaningful text content — that's the
  // CV option-card box.
  function looksLikeQuizStep() {
    // PATH 0: LaPieza-specific container. The questions step on the
    // modern apply form renders inside `div.details__form__preguntas`.
    // If that container is visible the chain MUST treat this as a quiz
    // step regardless of which sub-DOM (radio, multi-select-button,
    // future kind) LaPieza is shipping today.
    try {
      const container = document.querySelector("div.details__form__preguntas");
      if (container) {
        try { if (isVisible(container)) return true; } catch (_) {}
      }
    } catch (_) { /* fall through */ }

    // PATH 1: button.multi-select-button — LaPieza's modern apply flow.
    try {
      const quizBtns = Array.from(document.querySelectorAll("button.multi-select-button"))
        .filter((b) => {
          try { return isVisible(b); } catch (_) { return false; }
        });
      if (quizBtns.length >= 2) return true;
    } catch (_) { /* fall through */ }

    // PATH 1.5: Y/N quiz — LaPieza shows knock-out screening questions
    // (e.g. "Do you have 3+ years of experience with X?") with two
    // big SI/NO buttons. Detected here so the chain doesn't blow
    // past the quiz step thinking it's a no-op "click Continuar".
    try {
      const ynBtns = collectYesNoOptions(document.body);
      if (ynBtns.length >= 2) {
        // Sanity check: only flag as quiz step if there's a question
        // mark in the visible body — without it, two bare SI/NO
        // buttons could be from a cookie banner or other modal.
        const bodyTxt = (document.body.innerText || "").slice(0, 3000);
        if (bodyTxt.includes("?")) return true;
      }
    } catch (_) { /* fall through */ }

    // PATH 2: visible "Pregunta N de M" / "N / M" / "Question N of M"
    // counter anywhere on the page. The quiz UI always renders such a
    // counter at the top of each question. Cheap text scan, bounded so
    // we don't scan the entire body.
    try {
      const COUNTER_RX = /(?:pregunta|question)\s+(\d+)\s*(?:de|of|\/)\s*(\d+)/i;
      const SHORT_COUNTER_RX = /^\s*(\d+)\s*\/\s*(\d+)\s*$/;
      const candidates = document.querySelectorAll("p, span, div, h1, h2, h3, h4, strong");
      for (const el of candidates) {
        try {
          if (el.closest(".eamx-fab, .eamx-panel, .eamx-overlay, .eamx-matches-panel, .eamx-toast, .eamx-bulk-progress, [data-eamx]")) continue;
          if (!isVisible(el)) continue;
          const t = (el.textContent || "").trim();
          if (!t || t.length > 60) continue;
          if (COUNTER_RX.test(t)) return true;
          if (el.children && el.children.length === 0 && SHORT_COUNTER_RX.test(t)) {
            // Bare "5 / 18" leaf — must look like a quiz counter
            // (small numbers). Reject obvious salaries / IDs.
            const m = t.match(SHORT_COUNTER_RX);
            const cur = Number(m[1]);
            const tot = Number(m[2]);
            if (cur > 0 && tot > 0 && tot <= 200 && cur <= tot) return true;
          }
        } catch (_) {}
      }
    } catch (_) {}

    // PATH 3: multi-option-card layout (A/B/C/D buttons in
    // non-multi-select-button class). Some LaPieza variants render
    // <button> or <div role="button"> with leading "A)" "B)" etc.
    try {
      const QUIZ_OPTION_LEADING_RX = /^[A-Z][\)\.\:]\s+/;
      const buttons = Array.from(document.querySelectorAll(
        'button, div[role="button"], [class*="option" i]'
      ));
      let optionCount = 0;
      const seenKeys = new Set();
      for (const b of buttons) {
        try {
          if (!isVisible(b)) continue;
          if (b.closest(".eamx-fab, .eamx-panel, .eamx-overlay, .eamx-matches-panel, .eamx-toast, [data-eamx]")) continue;
          const t = (b.textContent || "").trim();
          if (!t || t.length > 200) continue;
          const m = t.match(QUIZ_OPTION_LEADING_RX);
          if (!m) continue;
          const key = t.charAt(0).toUpperCase();
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          optionCount++;
          if (optionCount >= 2) return true;
        } catch (_) {}
      }
    } catch (_) {}

    // PATH 4: radio-based quizzes (legacy). Walk the radios + filter
    // CV-selection look-alikes. Kept for back-compat with portals that
    // haven't migrated to the button-based quiz.
    let radios = [];
    try { radios = Array.from(document.querySelectorAll('input[type="radio"]')); } catch (_) { return false; }
    let count = 0;
    for (const r of radios) {
      try {
        if (!isVisible(r)) continue;
      } catch (_) { continue; }
      let ctx = r.closest("label, [class*='option' i], [class*='question' i], [class*='quiz' i], [class*='answer' i]");
      if (!ctx) continue;
      let txt = (ctx.textContent || "").trim().toLowerCase();
      if (!txt) {
        let p = ctx.parentElement;
        for (let i = 0; i < 5 && p; i++, p = p.parentElement) {
          const pTxt = (p.textContent || "").trim().toLowerCase();
          if (pTxt) { txt = pTxt; break; }
        }
      }
      if (/principal|hoja\s*de\s*vida|cv\s*-|\.pdf\s*\d+\s*[a-z]{3}\s*\d{4}/i.test(txt)) continue;
      count++;
      if (count >= 2) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------
  // Applied-vacancy tracker
  // ---------------------------------------------------------------------
  // When the chain reaches the final Finalizar step we attach a one-shot
  // click listener that calls queueModule.upsertApplied() AFTER the user
  // clicks. The vacancy lands in the queue with status="aplicada", and
  // future matches-panel renders show a "✓ Postulada" badge on its card
  // — so the user never accidentally postula to the same vacancy twice.
  //
  // Stamps the button with data-eamx-finalize-tracked="true" to avoid
  // double-attaching across observer ticks if the chain re-detects the
  // same button.

  function attachFinalizeApplyTracker(btn) {
    if (!btn || btn.dataset.eamxFinalizeTracked === "true") return;
    btn.dataset.eamxFinalizeTracked = "true";
    const handler = async () => {
      // Tell the parent matches panel this row is done — so the row
      // shows "✓ Postulación enviada" with a green check instead of
      // staying stuck on "✓ Listo — dale Finalizar".
      try { reportBulkStatus("submitted"); } catch (_) {}
      const job = lastJob || {};
      const url = location.href;
      const id = idFromUrl(url);
      // 1) Local queue (for the matches panel + bulk filter).
      try {
        if (queueModule && typeof queueModule.upsertApplied === "function" && id) {
          await queueModule.upsertApplied({
            id,
            source: SOURCE,
            url,
            title: job.title || "",
            company: job.company || "",
            location: job.location || "",
            savedAt: Date.now(),
            matchScore: 0,
            reasons: ["Postulada desde la extensión"]
          });
          console.log("[EmpleoAutomatico] vacancy marked applied:", id);
        }
      } catch (err) {
        console.warn("[EmpleoAutomatico] applied-tracker (local) failed", err);
      }
      // 2) Server-side sync for /account/historial. Best-effort —
      //    if it fails we already have the row in the local queue.
      if (id) {
        try {
          await sendMsg({
            type: MSG.TRACK_APPLICATION,
            source: SOURCE,
            vacancyId: id,
            url,
            title: job.title || "",
            company: job.company || "",
            location: job.location || "",
            matchScore: 0,
            status: "applied",
            sourceTs: Date.now(),
            reasons: ["Postulada desde la extensión"]
          });
        } catch (err) {
          console.warn("[EmpleoAutomatico] applied-tracker (backend) failed", err);
        }
      }
    };
    // Capture phase so we run BEFORE LaPieza's handler navigates away
    // (the page may unmount our content script after submission). Listener
    // is one-shot via { once: true } so re-clicks don't re-fire.
    btn.addEventListener("click", handler, { capture: true, once: true });
  }

  // ---------------------------------------------------------------------
  // Tailored-CV PDF upload (chain Fase 2)
  // ---------------------------------------------------------------------
  // On the CV step the chain calls tryUploadTailoredCv() which:
  //   1. Requests a per-vacancy ATS-tailored CV from the backend
  //      (GENERATE_CV_PDF — server renders via puppeteer + chromium).
  //   2. Decodes the base64 PDF response into a Uint8Array → File.
  //   3. Injects the File into LaPieza's hidden file input via the
  //      DataTransfer trick (the only programmatic file-set technique
  //      that React handlers actually pick up).
  //   4. Dispatches a synthetic `change` event so LaPieza's onChange
  //      reads the new file and updates the radio selection.
  //
  // Failure is silent + non-fatal. If anything throws — backend down,
  // user not logged in, plan limit hit, LaPieza DOM shape changed —
  // the chain continues with LaPieza's PRINCIPAL CV (which is always
  // valid). This is the "less personalized but never broken" fallback.

  // Heuristic: are we currently on LaPieza's CV-selection step?
  // Signals: heading mentions "Añade un CV" / "CV para postular" AND
  // there's at least one visible file input on the page.
  function isOnLaPiezaCvStep() {
    try {
      // Hard exclusions FIRST: if there's a visible cover textarea OR
      // visible quiz-step radios, we are demonstrably NOT on the CV
      // step. This is the strongest signal — LaPieza never shows the
      // cover textarea on the CV step, and vice versa.
      if (findExpressCoverLetterField()) return false;
      if (looksLikeQuizStep()) return false;

      // Now check for any CV-related signal in the page body. We scan
      // a 3KB window of the page text — enough to catch the step title
      // and the "PRINCIPAL" / "Añadir nuevo CV" labels, while avoiding
      // pulling the full <main>'s text content into the regex engine.
      const bodyText = (document.body?.textContent || "").slice(0, 3000).toLowerCase();
      // Strong matches: explicit CV-step headings.
      if (/a[ñn]ade\s+un\s+cv|cv\s+para\s+postular|sube\s+tu\s+cv|selecciona.*cv/i.test(bodyText)) {
        return true;
      }
      // Fallback: PRINCIPAL label + CV mention (LaPieza shows the user's
      // PRINCIPAL CV card on the CV-selection step regardless of the
      // exact step-title copy).
      if (/principal/i.test(bodyText) && /cv\s*-|cv\s+principal|a[ñn]adir\s+nuevo\s+cv/i.test(bodyText)) {
        return true;
      }
      return false;
    } catch (_) { return false; }
  }

  // LaPieza's "Añadir nuevo CV" hidden file input lives inside the
  // upload card on /apply/. We find it by walking up from each
  // input[type=file] looking for CV-related text in the ancestor chain.
  function findLaPiezaCvFileInput() {
    let inputs = [];
    try { inputs = Array.from(document.querySelectorAll('input[type="file"]')); } catch (_) { return null; }
    for (const inp of inputs) {
      if (inp.disabled) continue;
      // Match if EITHER the input's own attributes mention CV/PDF, OR a
      // labelled ancestor (max 4 levels up) does.
      const selfAttrs = (
        (inp.getAttribute("name") || "") + " " +
        (inp.getAttribute("aria-label") || "") + " " +
        (inp.getAttribute("accept") || "")
      ).toLowerCase();
      if (/cv|curriculum|currículum|resume|pdf/i.test(selfAttrs)) return inp;
      let walker = inp.parentElement;
      for (let depth = 0; depth < 4 && walker; depth++) {
        const txt = (walker.textContent || "").slice(0, 300).toLowerCase();
        if (/a[ñn]adir\s+nuevo\s+cv|añade\s+un\s+cv|cv\s+para\s+postular/i.test(txt)) {
          return inp;
        }
        walker = walker.parentElement;
      }
    }
    return null;
  }

  // Decode a base64 string into a Uint8Array. Backend sent the PDF
  // base64-encoded because chrome.runtime.sendMessage can't transfer
  // binary buffers directly — atob is the symmetric counterpart of the
  // backend's btoa encoding (see lib/backend.js generateTailoredCvPdf).
  function base64ToBytes(b64) {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  // Build a sane filename from the user's name + vacancy slug. Sanitized
  // so LaPieza accepts it (some portals reject filenames with /,?,*,etc).
  function buildCvFilename(job, profile) {
    const personName = (profile?.personal?.fullName || profile?.fullName || "CV")
      .replace(/[^a-z0-9\s-]/gi, "")
      .trim()
      .replace(/\s+/g, "-");
    const jobBit = (job?.title || job?.id || "")
      .replace(/[^a-z0-9\s-]/gi, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 40);
    return jobBit ? `${personName}-${jobBit}.pdf` : `${personName}-CV.pdf`;
  }

  // Inline modal that pauses the chain on the CV step and asks the user
  // whether to personalize the CV for this vacancy or use their PRINCIPAL.
  // Resolves to "personalize" | "principal". Defaults to "principal" if
  // the user doesn't choose within timeoutMs (so the chain stays fast
  // and never blocks indefinitely).
  //
  // Lives only while open — no module-level state — and resolves once
  // either button is clicked OR the timeout fires. The modal is keyboard
  // accessible (Enter = personalize, Esc = principal).
  function askCvChoice({ timeoutMs = 8000 } = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (choice) => {
        if (settled) return;
        settled = true;
        try { document.removeEventListener("keydown", onKey, true); } catch (_) {}
        try { backdrop.remove(); } catch (_) {}
        clearInterval(tickHandle);
        resolve(choice);
      };

      const backdrop = document.createElement("div");
      backdrop.className = "eamx-cv-choice";
      backdrop.innerHTML = `
        <div class="eamx-cv-choice__card" role="dialog" aria-modal="true">
          <div class="eamx-cv-choice__title">¿Qué CV usar para esta vacante?</div>
          <p class="eamx-cv-choice__sub">
            Por defecto seguimos con tu CV PRINCIPAL. Si quieres uno reescrito
            con las keywords de esta vacante específica, lo generamos en ~10s.
          </p>
          <div class="eamx-cv-choice__actions">
            <button type="button" class="eamx-cv-choice__btn eamx-cv-choice__btn--primary" data-eamx-cv-choice="personalize">
              ✨ Personalizar para esta vacante
            </button>
            <button type="button" class="eamx-cv-choice__btn" data-eamx-cv-choice="principal">
              Usar mi CV PRINCIPAL
            </button>
          </div>
          <div class="eamx-cv-choice__timer" data-eamx-cv-choice-timer>
            Sin elegir en <span data-eamx-cv-choice-secs>${Math.ceil(timeoutMs / 1000)}</span>s usaré tu PRINCIPAL.
          </div>
        </div>
      `;
      document.documentElement.appendChild(backdrop);

      backdrop.addEventListener("click", (ev) => {
        const btn = ev.target.closest("[data-eamx-cv-choice]");
        if (!btn) return;
        settle(btn.getAttribute("data-eamx-cv-choice"));
      });

      const onKey = (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); settle("personalize"); }
        else if (ev.key === "Escape" || ev.key === "Esc") { ev.preventDefault(); settle("principal"); }
      };
      document.addEventListener("keydown", onKey, true);

      // Countdown — visible to the user so the auto-default isn't surprising.
      const secsEl = backdrop.querySelector("[data-eamx-cv-choice-secs]");
      let remaining = Math.ceil(timeoutMs / 1000);
      const tickHandle = setInterval(() => {
        remaining -= 1;
        if (secsEl) secsEl.textContent = String(Math.max(0, remaining));
        if (remaining <= 0) settle("principal");
      }, 1000);
    });
  }

  // Plan-limit modal — replaces the plain "Llegaste al límite" toast on
  // user-initiated AI actions (Postular, Bulk auto-postular, Generar CV,
  // Generar carta). Shows a visual usage bar, names the plan/feature
  // that ran out, and offers TWO upgrade paths so the user isn't forced
  // to commit to a higher tier just to send one more application:
  //   1. "Sube de plan" → empleo.skybrandmx.com/account/billing
  //   2. "Compra créditos extra" → /account/billing?pack=1 (the landing
  //      page handles the pack SKU selection + checkout)
  // Background flows (auto-quiz mid-run, idle prewarm) still use a
  // toast — the modal would be too disruptive when the user didn't
  // just click anything. Resolves with one of:
  //   "upgrade" | "pack" | "close" | "esc"
  // Idempotent: re-opening replaces any existing modal.
  function showPlanLimitModal({ feature = "esta IA", usage = null, planName = "" } = {}) {
    return new Promise((resolve) => {
      // IDEMPOTENCY: if a plan-limit modal is already on screen, do NOT
      // create another one. Multiple chain steps (carta → CV → Q&A)
      // each call showPlanLimitModal when they hit PLAN_LIMIT_EXCEEDED,
      // and without this guard the user sees the modal flicker as each
      // call removed-the-previous + created-a-new one. User reported
      // case: "ahi como que se buguea aparece y desaparece".
      // We resolve immediately with "already_shown" so the caller can
      // chain logic but doesn't wait on a duplicate modal.
      const existing = document.querySelector(".eamx-plan-limit");
      if (existing) {
        resolve("already_shown");
        return;
      }

      let settled = false;
      const settle = (choice) => {
        if (settled) return;
        settled = true;
        try { document.removeEventListener("keydown", onKey, true); } catch (_) {}
        try { backdrop.remove(); } catch (_) {}
        resolve(choice);
      };

      // Usage display: progress bar + count. Limit -1 = unlimited (shouldn't
      // ever hit this modal, but defend). Unknown usage → hide the bar
      // entirely rather than show "?/?" which is uglier than nothing.
      let usageBlock = "";
      if (usage && Number.isFinite(Number(usage.limit)) && Number(usage.limit) > 0) {
        const limitNum = Number(usage.limit);
        const currentNum = Math.max(0, Number(usage.current) || 0);
        const pct = Math.min(100, Math.round((currentNum / limitNum) * 100));
        usageBlock = `
          <div class="eamx-plan-limit__usage">
            <div class="eamx-plan-limit__usage-row">
              <span class="eamx-plan-limit__usage-label">Tu uso este mes</span>
              <span class="eamx-plan-limit__usage-value">${currentNum} / ${limitNum}</span>
            </div>
            <div class="eamx-plan-limit__bar">
              <div class="eamx-plan-limit__bar-fill" style="width: ${pct}%"></div>
            </div>
            ${planName ? `<div class="eamx-plan-limit__plan-name">Plan actual: <strong>${escapeHtml(planName)}</strong></div>` : ""}
          </div>
        `;
      }

      const backdrop = document.createElement("div");
      backdrop.className = "eamx-plan-limit";
      backdrop.innerHTML = `
        <div class="eamx-plan-limit__card" role="dialog" aria-modal="true" aria-labelledby="eamx-plan-limit-title">
          <div class="eamx-plan-limit__icon" aria-hidden="true">⚡</div>
          <h2 class="eamx-plan-limit__title" id="eamx-plan-limit-title">Se acabaron tus ${escapeHtml(feature)} del mes</h2>
          <p class="eamx-plan-limit__sub">
            Tu cuota mensual se reinicia el día 1. Mientras tanto, elige cómo quieres seguir:
          </p>
          ${usageBlock}
          <div class="eamx-plan-limit__actions">
            <button type="button" class="eamx-plan-limit__btn eamx-plan-limit__btn--primary" data-eamx-plan-limit="upgrade">
              <span class="eamx-plan-limit__btn-icon" aria-hidden="true">🚀</span>
              <span class="eamx-plan-limit__btn-body">
                <span class="eamx-plan-limit__btn-title">Sube de plan</span>
                <span class="eamx-plan-limit__btn-sub">Pro $299/mes · Premium $499/mes · cuota grande cada mes</span>
              </span>
            </button>
            <button type="button" class="eamx-plan-limit__btn eamx-plan-limit__btn--pack" data-eamx-plan-limit="pack">
              <span class="eamx-plan-limit__btn-icon" aria-hidden="true">🪙</span>
              <span class="eamx-plan-limit__btn-body">
                <span class="eamx-plan-limit__btn-title">Compra créditos extra</span>
                <span class="eamx-plan-limit__btn-sub">Paga una vez, sin suscripción · ideal para terminar esta racha</span>
              </span>
            </button>
          </div>
          <p class="eamx-plan-limit__reset-hint">Sin riesgos: tu cuenta y CV se mantienen igual.</p>
          <button type="button" class="eamx-plan-limit__close" data-eamx-plan-limit="close">Cerrar</button>
        </div>
      `;
      document.documentElement.appendChild(backdrop);

      backdrop.addEventListener("click", (ev) => {
        const btn = ev.target.closest("[data-eamx-plan-limit]");
        if (btn) {
          const action = btn.getAttribute("data-eamx-plan-limit");
          if (action === "upgrade") openBilling();
          if (action === "pack") openBillingPack();
          settle(action);
          return;
        }
        // Click on the backdrop itself (outside the card) closes too.
        if (ev.target === backdrop) settle("close");
      });

      const onKey = (ev) => {
        if (ev.key === "Escape" || ev.key === "Esc") { ev.preventDefault(); settle("esc"); }
      };
      document.addEventListener("keydown", onKey, true);
    });
  }

  // Open the billing page with the ?pack=1 query so the landing knows
  // to highlight the credit-pack purchase flow vs the monthly tier
  // upgrade flow. The landing implements the actual checkout — keeping
  // the extension dumb about pricing/SKUs.
  function openBillingPack() {
    try {
      const url = `${BILLING_URL}?pack=1`;
      window.open(url, "_blank", "noopener");
    } catch (_) {
      // Fallback to plain billing if the new tab open fails.
      try { openBilling(); } catch (_) {}
    }
  }

  async function tryUploadTailoredCv() {
    // Restore lastJob from chrome.storage.session if it's not in-memory.
    // The /apply/ tab can land here without lastJob populated when the
    // user came in cold (no /vacante/ pre-visit in the same content-script
    // context). onFabClickExpressApply does this restore too — we mirror
    // the pattern so the CV-upload path works in the same scenarios as
    // the cover-letter / Q&A path. Live test on E-Bitware showed the
    // "Sin contexto" toast firing even when the user had clearly come
    // through /vacante/, because the chain reloaded the content script
    // context on navigation.
    if (!lastJob || !lastJob.title) {
      try {
        const restored = await restoreJobFromSession();
        if (restored) lastJob = restored;
      } catch (_) { /* fall through to the bail */ }
    }
    if (!lastJob || !lastJob.title) {
      console.log("[EmpleoAutomatico] CV upload skip: no lastJob (after session restore attempt)");
      toast("Sin contexto de vacante. Reabre la vacante y reintenta.", "info");
      return false;
    }
    // Look for the file input. LaPieza hides it behind a click on
    // "Añadir nuevo CV", so on first detect it might not be in DOM
    // yet. Auto-click that trigger button + poll for the input.
    let fileInput = findLaPiezaCvFileInput();
    if (!fileInput) {
      console.log("[EmpleoAutomatico] CV upload: no file input — clicking 'Añadir nuevo CV' trigger");
      const addCvBtn = Array.from(document.querySelectorAll("button, a"))
        .find((el) => /a[ñn]adir\s+nuevo\s+cv/i.test((el.textContent || "").trim()));
      if (addCvBtn) {
        try { addCvBtn.click(); } catch (_) {}
        // Poll up to 3s for the file input to appear.
        for (let i = 0; i < 15; i++) {
          await new Promise((r) => setTimeout(r, 200));
          fileInput = findLaPiezaCvFileInput();
          if (fileInput) break;
        }
      }
      if (!fileInput) {
        console.log("[EmpleoAutomatico] CV upload skip: no file input found even after triggering");
        toast("No encontré dónde subir el CV. Sigo con tu PRINCIPAL.", "info", { durationMs: 4000 });
        return false;
      }
    }
    console.log("[EmpleoAutomatico] CV upload starting — fileInput found:", fileInput);

    toast("⚡ Generando CV personalizado para esta vacante…", "info", { durationMs: 12000 });

    let pdfBase64;
    try {
      const res = await sendMsg({ type: MSG.GENERATE_CV_PDF, job: lastJob });
      if (!res || !res.ok) {
        if (res && res.error === ERR.PLAN_LIMIT_EXCEEDED) {
          // If we're mid-chain, the cover step is about to fail with
          // the SAME PLAN_LIMIT_EXCEEDED — showing an info toast here
          // then a modal there is a confusing 1-2 punch. Skip the
          // toast, show the modal NOW, abort the chain. If we're not
          // in a chain (rare — CV upload is rarely called standalone),
          // keep the old fallback toast behaviour.
          if (chainInProgress) {
            quickApplyAborted = true;
            showPlanLimitModal({ feature: "postulaciones IA" });
          } else {
            toast("CV personalizado: límite del mes alcanzado. Sigo con tu CV PRINCIPAL.", "info", {
              label: "Ver planes",
              onClick: () => openBilling(),
              durationMs: 10000
            });
          }
        } else if (res && res.error === ERR.UNAUTHORIZED) {
          toast("Sesión expirada. Sigo con tu CV PRINCIPAL.", "info", {
            label: "Inicia sesión",
            onClick: () => openOptionsPage(),
            durationMs: 8000
          });
        } else {
          toast("No pude generar el CV personalizado. Sigo con tu PRINCIPAL.", "info");
        }
        return false;
      }
      pdfBase64 = res.pdfBase64;
    } catch (err) {
      console.warn("[EmpleoAutomatico] generate-cv-pdf threw", err);
      toast("CV personalizado no disponible. Sigo con tu PRINCIPAL.", "info");
      return false;
    }

    if (!pdfBase64) return false;

    let bytes, file, blobUrl;
    try {
      bytes = base64ToBytes(pdfBase64);
      const filename = buildCvFilename(lastJob, cachedProfile);
      file = new File([bytes], filename, { type: "application/pdf" });
      // Build a blob URL for the preview iframe. Revoked after the
      // modal resolves (success path) or on bail.
      const blob = new Blob([bytes], { type: "application/pdf" });
      blobUrl = URL.createObjectURL(blob);
    } catch (err) {
      console.warn("[EmpleoAutomatico] CV decode failed", err);
      return false;
    }

    // Preview modal — show the generated PDF in an iframe and let the
    // user explicitly confirm before we inject it into LaPieza's file
    // input. Replaces the previous "trust me, uploading" black-box UX.
    let confirmed = false;
    try {
      confirmed = await askCvPreviewConfirm(blobUrl, lastJob);
    } catch (_) { confirmed = false; }

    // Always revoke the blob URL — browsers don't reclaim it on its own.
    try { URL.revokeObjectURL(blobUrl); } catch (_) {}

    if (!confirmed) {
      toast("Cancelado. Sigo con tu CV PRINCIPAL.", "info", { durationMs: 3000 });
      return false;
    }

    // DataTransfer is the only technique React/modern frameworks pick up.
    // Setting input.files directly with a FileList from Object.defineProperty
    // works in Chrome but not always Firefox; DataTransfer is universal.
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      // Some React onChange handlers listen for `input` instead.
      fileInput.dispatchEvent(new Event("input", { bubbles: true }));
    } catch (err) {
      console.warn("[EmpleoAutomatico] file injection failed", err);
      return false;
    }

    // Give LaPieza ~2s to process the upload (POST to their server,
    // append the new CV card to the radio list).
    toast("✓ CV personalizado subido. Validando…", "success", { durationMs: 3000 });
    await new Promise((r) => setTimeout(r, 2000));

    // CRITICAL: LaPieza appends the uploaded CV as a NEW card but DOES
    // NOT auto-switch the radio selection — PRINCIPAL stays active.
    // Live test on /apply/cf8e8a5a... (BI Analyst II en TP) confirmed:
    // both CV cards present, but PRINCIPAL still radio-checked → the
    // recruiter ends up receiving the PRINCIPAL, not our personalized
    // one. Auto-click the new card's radio so the personalized version
    // is the one LaPieza actually submits.
    try {
      await selectNewlyUploadedCv(file.name);
    } catch (err) {
      console.warn("[EmpleoAutomatico] could not auto-select new CV card", err);
      toast("Subí el CV pero no pude auto-seleccionarlo — clic en el nuevo card.", "info", { durationMs: 5000 });
    }
    return true;
  }

  // Find the CV card that matches the just-uploaded filename and click
  // its radio so LaPieza submits THAT CV instead of PRINCIPAL. Polls
  // up to 6s because the card render is async (LaPieza POSTs the file
  // to their server, gets an id back, then renders the card).
  //
  // Live DOM inspection on /apply/cf8e8a5a... showed LaPieza uses MUI:
  //   - FormControlLabel wraps each radio
  //   - A SIBLING div.container-info-cv has the visible CV name
  //   - The radio's parent label/container does NOT contain the text
  // So we can't just match label.textContent. New strategy:
  //   1. Find ALL radios on the page (Array.from input[type=radio])
  //   2. For each radio, find its associated card by walking up to a
  //      sane ancestor AND looking at the ancestor's combined text
  //   3. Match the card whose text contains our filename stem
  //      (excluding the PRINCIPAL card explicitly)
  //   4. Click that radio + dispatch change event
  async function selectNewlyUploadedCv(filename) {
    if (!filename) return false;
    // Build several candidate stems to match against because LaPieza
    // truncates long filenames. We try the first 16, 24, and 32 chars.
    const base = filename.replace(/\.pdf$/i, "").toLowerCase();
    const stems = [base.slice(0, 16), base.slice(0, 24), base.slice(0, 32), base].filter((s, i, a) => s && a.indexOf(s) === i);

    const polls = 30;
    const intervalMs = 200;

    for (let attempt = 0; attempt < polls; attempt++) {
      const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
      // Walk up each radio looking for the smallest ancestor whose
      // textContent includes our filename. Cap at 6 levels — beyond
      // that we'd be matching the whole page.
      for (const radio of radios) {
        if (radio.checked) continue; // already selected, skip
        if (!radio.offsetParent && radio.tagName !== "BODY") continue; // hidden
        let walker = radio;
        for (let depth = 0; depth < 6 && walker; depth++) {
          const txt = (walker.textContent || "").toLowerCase();
          // Hard skip if this ancestor scopes the PRINCIPAL card — we
          // never want to re-select PRINCIPAL.
          if (/principal/.test(txt) && depth < 4) {
            // PRINCIPAL is in this subtree. Skip up only if the text
            // ALSO mentions our filename (the ancestor wraps both
            // cards — keep walking up at depth 4+).
            const hasFilenameStem = stems.some((s) => s && txt.includes(s));
            if (!hasFilenameStem) {
              walker = null; // bail out of this radio's walk
              break;
            }
          }
          const hasOurStem = stems.some((s) => s && txt.includes(s));
          if (hasOurStem) {
            // Found it. Click the radio + dispatch change.
            try {
              radio.click();
              radio.dispatchEvent(new Event("change", { bubbles: true }));
              radio.dispatchEvent(new Event("input", { bubbles: true }));
              console.log("[EmpleoAutomatico] new CV auto-selected via radio click (depth=" + depth + ")");
              await new Promise((r) => setTimeout(r, 200));
              if (radio.checked) return true;
            } catch (_) { /* fall through to wrapper click */ }
            // Fallback: click the wrapper (label or MUI FormControlLabel).
            try {
              const clickTarget = radio.closest("label") || walker;
              clickTarget.click();
              await new Promise((r) => setTimeout(r, 200));
              if (radio.checked) {
                console.log("[EmpleoAutomatico] new CV auto-selected via wrapper click");
                return true;
              }
            } catch (_) { /* keep polling */ }
            break; // try next radio
          }
          walker = walker.parentElement;
        }
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    console.log("[EmpleoAutomatico] selectNewlyUploadedCv timed out — filename stems:", stems);
    return false;
  }

  // Preview modal — shown after the backend returns the personalized
  // PDF, BEFORE we inject it into LaPieza's file input. Resolves true
  // when the user explicitly confirms "Sí, subir este CV" and false
  // on cancel / Escape / 30s timeout. The user always knows what's
  // being uploaded on their behalf.
  function askCvPreviewConfirm(blobUrl, job) {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (val) => {
        if (settled) return;
        settled = true;
        try { document.removeEventListener("keydown", onKey, true); } catch (_) {}
        try { backdrop.remove(); } catch (_) {}
        resolve(val);
      };
      const jobLabel = `${(job && job.title) || "esta vacante"}${(job && job.company) ? " · " + job.company : ""}`;
      const backdrop = document.createElement("div");
      backdrop.className = "eamx-cv-preview";
      backdrop.innerHTML = `
        <div class="eamx-cv-preview__card" role="dialog" aria-modal="true">
          <div class="eamx-cv-preview__head">
            <div>
              <div class="eamx-cv-preview__title">CV personalizado generado</div>
              <div class="eamx-cv-preview__sub">Para ${escapeHtml(jobLabel)}</div>
            </div>
            <button type="button" class="eamx-cv-preview__close" data-eamx-cv-preview="cancel" aria-label="Cancelar">✕</button>
          </div>
          <div class="eamx-cv-preview__viewer">
            <iframe src="${blobUrl}" title="Preview CV" loading="eager"></iframe>
          </div>
          <div class="eamx-cv-preview__actions">
            <button type="button" class="eamx-cv-preview__btn" data-eamx-cv-preview="cancel">
              Cancelar — usar PRINCIPAL
            </button>
            <button type="button" class="eamx-cv-preview__btn eamx-cv-preview__btn--primary" data-eamx-cv-preview="confirm">
              ✓ Sí, subir este CV
            </button>
          </div>
        </div>
      `;
      document.documentElement.appendChild(backdrop);

      backdrop.addEventListener("click", (ev) => {
        const btn = ev.target.closest("[data-eamx-cv-preview]");
        if (!btn) return;
        settle(btn.getAttribute("data-eamx-cv-preview") === "confirm");
      });
      const onKey = (ev) => {
        if (ev.key === "Escape" || ev.key === "Esc") { ev.preventDefault(); settle(false); }
        else if (ev.key === "Enter") { ev.preventDefault(); settle(true); }
      };
      document.addEventListener("keydown", onKey, true);

      // Hard timeout — 30s is generous for the user to scan the PDF.
      // Default to PRINCIPAL on timeout (safe fallback) so the chain
      // doesn't deadlock forever if the user wanders off.
      setTimeout(() => settle(false), 30_000);
    });
  }

  // Match LaPieza's apply-flow "Continuar" button (NOT the final submit).
  //
  // Bug history:
  //   1. previous regex was anchored (^continuar$) and rejected
  //      icon-decorated buttons. Now uses substring match.
  //   2. live test on /apply/ found TWO "Continuar" buttons in the DOM:
  //      a hidden 0×0 mobile-menu version (parent .action-postulation)
  //      and the real visible side-panel button. isVisible() should
  //      catch the 0×0 case but live test showed the chain stalled on
  //      the CV step anyway — making the rect check explicit + raising
  //      the minimum to 10px protects against zero-width race conditions
  //      during initial render.
  function findApplyFlowContinueBtn() {
    // Substring match (case-insensitive) on a continue-style word.
    const continueRx = /(?:^|[^\p{L}])(continuar|siguiente|next)(?:[^\p{L}]|$)/iu;
    // Anything containing these words is NOT a continue button — it's
    // either final submit (finalizar/enviar/aplicar/postular/submit/apply)
    // or an abandon/cancel/back button we shouldn't click.
    const blockRx = /finalizar|enviar|submit|aplicar|postular(?:me|se)?|apply|abandonar|cancelar|cerrar|atr[áa]s|back|volver|anterior|regresar/i;
    const candidates = Array.from(document.querySelectorAll("button, a[role=button], input[type=submit]"));
    return candidates.find((el) => {
      try {
        if (el.closest(".eamx-fab, .eamx-panel, .eamx-overlay, .eamx-matches-panel, .eamx-toast, [data-eamx]")) return false;
      } catch (_) { /* ignore */ }
      const t = ((el.textContent || el.value || "")).trim();
      if (!t || t.length > 80) return false;
      if (!continueRx.test(t)) return false;
      if (blockRx.test(t)) return false;
      if (el.disabled) return false;
      // Explicit rect check — must be at least 10×10 to be a real button.
      // This skips the hidden 0×0 mobile-menu Continuar that lives in
      // .action-postulation alongside the real side-panel button.
      try {
        const r = el.getBoundingClientRect();
        if (r.width < 10 || r.height < 10) return false;
        const cs = window.getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
      } catch (_) { return false; }
      return true;
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

  // Detect the "you've already applied to this vacancy" state.
  // LaPieza variants: "Ya te postulaste", "Ya aplicaste", "Postulación
  // enviada", short badges like "POSTULADO" / "APLICADO".
  function detectAlreadyAppliedState() {
    const PHRASE_RX = [
      /\bya\s+(?:te\s+)?(?:postulaste|aplicaste|postulado)\b/i,
      /\bpostulaci[oó]n\s+enviada\b/i,
      /\baplicaci[oó]n\s+enviada\b/i,
      /\bya\s+postulado\s+(?:a|para)\s+esta\b/i,
      /\byou\s+(?:have\s+)?already\s+applied\b/i,
      /\bapplied\s+on\b/i,
      /\btu\s+postulaci[oó]n\s+(?:fue\s+)?(?:enviada|recibida)\b/i
    ];
    const BADGE_RX = [
      /^(?:\s*[•·*-]?\s*)?(?:POSTULADO|APLICADO|APPLIED|YA\s+POSTULADO)\b/i,
      /^\s*✓\s*(?:postulaste|aplicaste|postulado)\s*$/i
    ];
    try {
      const candidates = document.querySelectorAll("p, span, div, h1, h2, h3, h4, strong, em, b, label");
      for (const el of candidates) {
        try {
          if (el.closest(".eamx-fab, .eamx-panel, .eamx-overlay, .eamx-matches-panel, .eamx-toast, .eamx-bulk-progress, [data-eamx]")) continue;
          if (!isVisible(el)) continue;
          const t = (el.textContent || "").trim();
          if (!t) continue;
          if (t.length <= 250 && PHRASE_RX.some((rx) => rx.test(t))) return true;
          if (t.length <= 30 && BADGE_RX.some((rx) => rx.test(t))) return true;
        } catch (_) { /* skip */ }
      }
    } catch (_) {}
    return false;
  }

  // Detect the "this vacancy is closed / no longer available" state.
  // LaPieza variants seen live:
  //   - "CERRADA" badge (standalone, no "vacante" prefix) — case-
  //     reported by user
  //   - "La empresa ha finalizado el proceso de reclutamiento de esta
  //     vacante" — alongside the CERRADA badge
  //   - "Vacante cerrada/expirada/no disponible"
  //   - "Oferta cerrada/expirada"
  //   - "Ya no recibe postulaciones"
  //   - "Position closed/expired" / "No longer available/accepting"
  function detectVacancyClosedState() {
    // Phrase regex (allow long text snippets).
    const PHRASE_RX = [
      /\bvacante\s+(?:cerrada|expirada|no\s+disponible|no\s+activa)\b/i,
      /\bya\s+no\s+recibe\s+postulaciones\b/i,
      /\bno\s+longer\s+(?:available|accepting)\b/i,
      /\b(?:position|job|posting)\s+(?:closed|expired|filled)\b/i,
      /\boferta\s+(?:cerrada|expirada|no\s+disponible)\b/i,
      /\b(?:la\s+empresa\s+ha\s+)?finalizado?\s+el\s+proceso\s+de\s+reclutamiento\b/i,
      /\b(?:proceso\s+de\s+)?reclutamiento\s+(?:cerrado|finalizado)\b/i,
      /\bya\s+(?:cubrim|llenam)os?\s+(?:esta|la)\s+(?:vacante|posici[oó]n)\b/i
    ];
    // Standalone-badge regex — short text that contains only the
    // closed marker (e.g. a chip/badge with literal "CERRADA"). We
    // require the badge text to be SHORT (<= 30 chars) to avoid
    // false positives on description paragraphs that include the
    // word "cerrada" in a different context.
    const BADGE_RX = [
      /^(?:\s*[•·*-]?\s*)?(?:CERRADA|CLOSED|EXPIRADA|EXPIRED|FILLED)\b/i,
      /^\s*(?:vacante\s+)?(?:cerrada|expirada|inactiva)\s*$/i
    ];
    try {
      const candidates = document.querySelectorAll("p, span, div, h1, h2, h3, h4, strong, em, b, label");
      for (const el of candidates) {
        try {
          if (el.closest(".eamx-fab, .eamx-panel, .eamx-overlay, .eamx-matches-panel, .eamx-toast, .eamx-bulk-progress, [data-eamx]")) continue;
          if (!isVisible(el)) continue;
          const t = (el.textContent || "").trim();
          if (!t) continue;
          // Long-text phrase match — limit text length to avoid
          // scanning huge job descriptions.
          if (t.length <= 250 && PHRASE_RX.some((rx) => rx.test(t))) return true;
          // Short-badge match — text must be short (most badges are
          // <= 30 chars).
          if (t.length <= 30 && BADGE_RX.some((rx) => rx.test(t))) return true;
        } catch (_) {}
      }
    } catch (_) {}
    return false;
  }

  // Detect whether the apply page has SOMETHING actionable for the
  // chain (CV step, cover field, Q&A textareas, quiz buttons, finalize
  // button). If NONE are present after waiting, the chain is stuck —
  // probably a page-load failure or a layout the chain doesn't know
  // how to handle. Used as a 30s-timeout fallback in the chain.
  function applyPageHasAnyFormElement() {
    try {
      if (isOnLaPiezaCvStep()) return true;
      if (findApplyFlowFinalizeBtn()) return true;
      if (findApplyFlowContinueBtn && findApplyFlowContinueBtn()) return true;
      try { if (findExpressCoverLetterField()) return true; } catch (_) {}
      try { if ((scanQuestionFields() || []).length > 0) return true; } catch (_) {}
      if (looksLikeQuizStep()) return true;
    } catch (_) {}
    return false;
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

  // Quiz-warning modal: LaPieza shows "Toma en cuenta lo siguiente —
  // Para enviar tu postulación, deberás responder algunas preguntas de
  // conocimiento general" with two buttons:
  //   - "Seguir postulándome"  (red, primary)  → continue to quiz
  //   - "Guardar vacante y postularme más tarde"  (gray)  → abandon
  // We click the primary one to advance the chain. Live test on
  // /apply/ef92e6ce... (L'Oréal Product Technical Lead) showed this
  // modal appearing AFTER the cover-letter step, just before the quiz.
  function findLaPiezaQuizWarningCTA() {
    const rx = /^seguir\s+postul[áa]ndome$/i;
    const candidates = Array.from(document.querySelectorAll("button, a[role=button]"));
    return candidates.find((el) => {
      const t = (el.textContent || "").trim();
      if (!rx.test(t)) return false;
      try {
        if (!isVisible(el) || el.disabled) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 10 || r.height < 10) return false;
      } catch (_) { return false; }
      return true;
    }) || null;
  }

  // The location-mismatch warning modal LaPieza shows when the user's
  // profile city differs from the vacancy's. Confirm CTA: "Sí, continuar
  // con postulación" / variants. We look for a red-styled / primary
  // button inside a visible modal.
  function findLaPiezaLocationContinueCTA() {
    // Confirm button on LaPieza's "esta vacante es lejana a tu ubicación"
    // modal. Tolerant match (the label has shipped as "Sí, continuar",
    // "Si, continuar con postulación", "Continuar con la postulación") but
    // NEVER the cancel button. Not anchored ^…$ so a stray icon/whitespace
    // in textContent can't break it.
    const confirmRx = /continuar\s+con\s+(?:la\s+)?postulaci[oó]n|^s[ií][,.\s]+continuar\b/i;
    const cancelRx = /\b(?:no|cancelar|cerrar|volver|atr[aá]s)\b/i;
    const candidates = Array.from(document.querySelectorAll("button, a[role='button'], [role='button']"));
    return candidates.find((el) => {
      const t = (el.textContent || "").trim();
      if (!t) return false;
      if (cancelRx.test(t)) return false;     // never click "No, cancelar"
      if (!confirmRx.test(t)) return false;
      try { return isVisible(el) && !el.disabled; } catch (_) { return false; }
    }) || null;
  }

  // Standing auto-confirm for the "vacante lejana a tu ubicación" modal.
  // The chain (runVacancyAutoChain) has its own short watcher, but that only
  // covers ⚡ Postular. Users ALSO click LaPieza's native "¡Me quiero
  // postular!" by hand — then no chain runs and the modal just sat there
  // (user report: "no que daba ok?"). This watcher runs for the whole
  // vacancy-page lifetime and confirms the modal however the apply was
  // started. A ~1.2s grace lets the user hit "No, cancelar" first if the
  // job really is too far. It only ever clicks the CONFIRM button
  // (findLaPiezaLocationContinueCTA excludes cancel) and only advances PAST
  // a warning — it never submits anything (Finalizar stays HITL).
  // Best-effort activation for a stubborn modal button. A bare .click()
  // works for most LaPieza buttons, but some renders only react to a full
  // pointer+mouse event sequence (React components bound to pointer/mouse
  // handlers rather than the synthetic click). Fire the whole sequence
  // plus a native .click(); harmless if redundant.
  function robustModalClick(btn) {
    if (!btn) return;
    try { btn.focus(); } catch (_) {}
    const opts = { bubbles: true, cancelable: true, view: window };
    for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
      try {
        const usePointer = type.startsWith("pointer") && typeof PointerEvent === "function";
        const Ev = usePointer ? PointerEvent : MouseEvent;
        btn.dispatchEvent(new Ev(type, opts));
      } catch (_) { /* ignore individual event failures */ }
    }
    try { btn.click(); } catch (_) {}
  }

  let locationModalWatchActive = false;
  let locationModalFirstSeenAt = 0;
  let locationModalClickAttempts = 0;
  let locationModalHelpShown = false;
  function startLocationModalAutoConfirm() {
    if (locationModalWatchActive) return;
    locationModalWatchActive = true;
    locationModalFirstSeenAt = 0;
    locationModalClickAttempts = 0;
    locationModalHelpShown = false;
    const tick = () => {
      if (!locationModalWatchActive) return;
      try {
        const btn = findLaPiezaLocationContinueCTA();
        if (btn) {
          if (!locationModalFirstSeenAt) {
            locationModalFirstSeenAt = Date.now();
          } else if (Date.now() - locationModalFirstSeenAt >= 1200) {
            try { robustModalClick(btn); } catch (_) {}
            locationModalClickAttempts++;
            locationModalFirstSeenAt = 0;
            // If we've clicked several times and the modal is STILL up,
            // the page isn't reacting to synthetic clicks (a LaPieza
            // render glitch — observed live). Turn the silent deadlock
            // into a clear, actionable prompt instead of leaving the user
            // staring at a stuck modal ("salio esto y ahi se quedo").
            if (locationModalClickAttempts >= 3 && !locationModalHelpShown) {
              locationModalHelpShown = true;
              try {
                toast(
                  'Confírmalo tú: dale "Sí, continuar con postulación" para seguir.',
                  "info",
                  { durationMs: 9000 }
                );
              } catch (_) {}
            }
          }
        } else {
          // modal closed / not present — reset grace + attempt counters
          locationModalFirstSeenAt = 0;
          locationModalClickAttempts = 0;
          locationModalHelpShown = false;
        }
      } catch (_) { /* ignore */ }
      setTimeout(tick, 300);
    };
    setTimeout(tick, 300);
  }
  function stopLocationModalAutoConfirm() {
    locationModalWatchActive = false;
    locationModalFirstSeenAt = 0;
    locationModalClickAttempts = 0;
    locationModalHelpShown = false;
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
    // Fire-and-forget — generation typically takes 6-15s; the auto-chain
    // below will navigate to /apply/<uuid> in that window. If we get there
    // before generation finishes, the apply-side handler re-requests.
    prewarmExpressDraft(job);
    // Same auto-chain as the matches-panel ⚡ Postular flow: 3s countdown
    // (Esc cancels) → auto-click "Me quiero postular" → auto-confirm
    // location modal → /apply/ chain auto-fires Express + Continuar →
    // STOP at Finalizar (HITL clic final). Single function shared with
    // maybeAutoPrewarmFromQuickApply so both entry points behave the same.
    runVacancyAutoChain();
  }

  // Shared chain for vacancy → apply transition. Used by both the manual
  // FAB click and the matches-panel ⚡ Postular click. Pre-warm must be
  // kicked off BEFORE calling this (so generation overlaps the 3s
  // countdown). Sets the "next-apply" session flag right before clicking
  // Postularme so the apply-side chain knows to auto-fire Express.
  async function runVacancyAutoChain() {
    // Early CV check — fail FAST and visibly before the 3s countdown
    // gives users false confidence that the chain is running. Without
    // cachedProfile our auto-quiz and CV-personalized features bail
    // silently mid-flow; detecting at /vacante/ entry lets the user
    // upload their CV BEFORE losing 30+ seconds of chain time.
    //
    // BUG-FIX: profile is loaded lazily and ONLY on listing pages by
    // default (see detectAndMount → isListingPath branch). On a direct
    // /vacante/<slug> visit, cachedProfile stays null even when the user
    // has a CV in extension storage. Force-load here so the gate uses
    // ground truth from chrome.storage.local instead of a stale in-memory
    // null. Without this, users with a perfectly-loaded CV in the welcome
    // page were getting the "Para usar la cadena necesitas tu CV" toast.
    try { await loadProfileOnce(); } catch (_) { /* fall through to gate */ }
    if (!cachedProfile) {
      toast(
        "Para usar la cadena necesitas tu CV cargado en la extensión. Te lleva 30s.",
        "info",
        {
          label: "Subir CV ahora",
          onClick: () => {
            try { chrome.runtime.sendMessage({ type: MSG.OPEN_WELCOME }); } catch (_) {}
          },
          durationMs: 10000
        }
      );
      return;
    }

    // VACANCY-PAGE TERMINAL-STATE DETECTORS: catch "CERRADA" badges
    // and "ya postulada" banners BEFORE the 3s countdown + Postularme
    // click. User reported a vacancy with a clear "CERRADA" badge +
    // "La empresa ha finalizado el proceso de reclutamiento" message
    // where the chain still tried to apply. Detecting here means we
    // never even open /apply/ for these.
    if (detectVacancyClosedState()) {
      toast("Esta vacante está cerrada — no se puede postular.", "info", { durationMs: 5000 });
      // Mark this URL as "tried but closed" via the queue so the
      // matches panel can flag it if the user visits the listing
      // later. Best-effort.
      try {
        const id = idFromUrl(location.href);
        if (id && queueModule && typeof queueModule.upsertApplied === "function") {
          // We use upsertApplied with a closed-reason so the badge
          // shows "✓" but the reasons indicate it was closed, not
          // actually submitted.
          // NB: we DON'T mark as applied here — closed != applied.
          // Just leave it; future runs will detect closed again.
        }
      } catch (_) {}
      return;
    }
    if (detectAlreadyAppliedState()) {
      toast("Ya postulaste a esta vacante antes.", "info", { durationMs: 5000 });
      // Persist to local queue so the matches panel + bulk filter
      // know about this on subsequent runs.
      try {
        const id = idFromUrl(location.href);
        if (id && queueModule && typeof queueModule.upsertApplied === "function") {
          await queueModule.upsertApplied({
            id,
            source: SOURCE,
            url: location.href,
            title: (lastJob && lastJob.title) || "",
            company: (lastJob && lastJob.company) || "",
            location: (lastJob && lastJob.location) || "",
            savedAt: Date.now(),
            matchScore: 0,
            reasons: ["Detectada como ya postulada desde /vacante/"]
          });
        }
      } catch (_) {}
      return;
    }

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

    const applyBtn = findLaPiezaApplyCTA();
    if (!applyBtn) {
      toast("No encontré el botón Postularme. Dale clic tú.", "info");
      try {
        if (quickApplyEscHandler) document.removeEventListener("keydown", quickApplyEscHandler, true);
      } catch (_) {}
      quickApplyEscHandler = null;
      return;
    }
    // Set the "next-apply" flag BEFORE the click — the click triggers
    // SPA navigation to /apply/<uuid>, and the apply UUID differs from
    // the /vacante/ slug-id, so we can't re-use the per-id flag.
    try {
      Promise.resolve(
        chrome.storage.session.set({
          "eamx:quickapply:next-apply": { setAt: Date.now() }
        })
      ).catch(() => {});
    } catch (_) {}
    try { applyBtn.click(); } catch (_) {}

    // Auto-confirm the location-warning modal whenever it appears.
    //
    // Bug history: this used to be a fixed 10s poll. On slow networks
    // LaPieza animates the modal in LATER than that, so the window expired
    // before the modal rendered and it "se quedó" (user report + screenshot
    // of the "vacante lejana" modal sitting unclicked). Replaced with a
    // patient fire-and-forget watcher: polls every 300ms for up to 30s and
    // clicks the "Sí, continuar con postulación" button the moment it
    // shows. Self-stops on click, on Esc-abort, on navigation to /apply/
    // (modal never appeared because the location matched), or on timeout —
    // and tears down the Esc handler when it does.
    const cleanupEsc = () => {
      try {
        if (quickApplyEscHandler) document.removeEventListener("keydown", quickApplyEscHandler, true);
      } catch (_) {}
      quickApplyEscHandler = null;
    };
    const watchStartedAt = Date.now();
    const watchLocationModal = () => {
      if (quickApplyAborted) { cleanupEsc(); return; }
      if (isApplyPage()) { cleanupEsc(); return; } // advanced; /apply handler takes over
      const continueBtn = findLaPiezaLocationContinueCTA();
      if (continueBtn) {
        try { continueBtn.click(); } catch (_) {}
        cleanupEsc();
        return;
      }
      if (Date.now() - watchStartedAt > 30000) { cleanupEsc(); return; } // give up
      setTimeout(watchLocationModal, 300);
    };
    setTimeout(watchLocationModal, 250);
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
    let canFill = true;
    if (cached) {
      job = cached;
    } else if (partial && job.title === "(sin título)" && job.company === "(empresa desconocida)") {
      // Deep-linked user — no cached context, can't run Express. We can
      // still chain forward through Continuar buttons, just without the
      // tailored cover letter. Tell the user but don't bail.
      canFill = false;
      toast(
        "Sin contexto de la vacante; te llevo paso a paso pero sin carta personalizada.",
        "info"
      );
    }

    if (canFill) {
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
        await runExpressFill({
          job,
          prewarmedDraft: prewarmed,
          skipCv: !!opts.skipCv,
          forceOverwrite: !!opts.forceOverwrite
        });
      } catch (err) {
        console.warn("[EmpleoAutomatico] Express fill threw", err);
        toast(humanizeError(err), "error");
      } finally {
        setFabBusy(false);
      }
    }

    // After filling the current step (or skipping when no context), chain
    // forward through Continuar buttons until Finalizar. opts.singleStep
    // = true is set by chainApplyStepsToFinalize itself when it calls us
    // for per-step filling — that prevents infinite recursion.
    if (!opts.singleStep && !chainInProgress) {
      setTimeout(() => {
        try { chainApplyStepsToFinalize(); } catch (_) {}
      }, 800);
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
  async function runExpressFill({ job, prewarmedDraft, skipCv = false, forceOverwrite = false }) {
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
            // terminal = quota/session/email/no-CV → the toast/modal is the
            // clear signal; don't ALSO open the blank "Re-generar" panel
            // (re-generating can't fix being out of quota). User feedback:
            // "que salga eso de error por falta de peticiones, no?".
            status.coverTerminal = handleExpressDraftFailure(res, { job }) === true;
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
          // SILENT-FAILURE FIX: this branch used to set status="error" and
          // bail with NO toast and NO log — the panel then opened with an
          // empty carta and the user saw "nada". Now we surface it loudly.
          console.error(
            "[EmpleoAutomatico] cover empty after generation (res ok but coverLetter blank)",
            { draftId: activeDraftId, hadDraft: !!draft }
          );
          overlay.markError("cover", "Carta vacía");
          toast(
            "La IA no devolvió la carta. Dale “Re-generar” en el panel o inténtalo de nuevo.",
            "error",
            { durationMs: 9000 }
          );
          status.cover = "error";
          return null;
        }
        if (forceOverwrite || !isUserEdited(coverField)) {
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
          if (!forceOverwrite && isUserEdited(target)) continue;
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
    //    target field exists), open the retry panel — BUT only for
    //    transient failures. For TERMINAL failures (quota / session /
    //    email / no-CV) handleExpressDraftFailure already showed the clear
    //    modal/toast, and a blank "Re-generar" panel would just confuse
    //    (re-generating can't restore quota). User feedback: "que salga eso
    //    de error por falta de peticiones, no?" — so we show ONLY that
    //    error, no blank panel.
    if (status.cover === "error" && coverField && !status.coverTerminal) {
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
    // Terminal cover failure (quota/session/email): no retry panel — the
    // modal/toast from handleExpressDraftFailure is the signal. Just hide
    // the progress overlay so the UI doesn't look frozen.
    if (status.cover === "error" && status.coverTerminal) {
      setTimeout(() => overlay.hide(), 1200);
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
  // Returns TRUE when the failure is terminal (quota / session / email /
  // missing-CV) — i.e. "Re-generar" can't help, so the caller should NOT
  // open the blank retry panel; the toast/modal here is the clear signal.
  // Returns FALSE for transient errors where a retry panel makes sense.
  function handleExpressDraftFailure(res, _ctx) {
    const code = res?.error;
    const message = res?.message || "No se pudo generar la carta.";
    // DIAGNOSTIC: always log the exact backend code + message. Before this,
    // a cover-letter failure surfaced only as a fleeting toast — if the user
    // didn't catch it ("no vi ningún mensaje") there was zero trace of WHY
    // generation failed. This line makes every failure inspectable in the
    // page console.
    console.error(
      `[EmpleoAutomatico] GENERATE_DRAFT failed — code=${code || "(none)"} message="${message}"`,
      res
    );
    if (code === ERR.EMAIL_NOT_VERIFIED) {
      // Terminal until they verify — stop the chain so we don't re-fire
      // GENERATE_DRAFT and flood toasts. Sticky toast (no auto-dismiss) with
      // a CTA that opens the account page where they can resend the link.
      quickApplyAborted = true;
      try { reportBulkStatus("error", { label: "Verifica tu correo" }); } catch (_) {}
      try { clearBulkModeFlag(); } catch (_) {}
      toast(
        "Tu correo no está verificado. Confírmalo (revisa tu bandeja y spam) para generar cartas.",
        "error",
        {
          // 20s + sticky: toast() has no true "never dismiss" — durationMs:0
          // would clamp to 800ms (Math.max(800, 0)). sticky:true keeps a
          // later toast() from clearing it before the user can act.
          durationMs: 20000,
          sticky: true,
          label: "Abrir mi cuenta",
          onClick: () => {
            try { window.open("https://empleo.skybrandmx.com/account", "_blank", "noopener"); } catch (_) {}
          }
        }
      );
      return true;
    }
    if (code === ERR.PLAN_LIMIT_EXCEEDED) {
      // Stop the chain — otherwise the next iter would re-try the cover
      // step or move to Q&A and re-fire PLAN_LIMIT_EXCEEDED, each call
      // would try to show another modal (the idempotency guard catches
      // this, but it still wastes backend calls and burns iterations).
      quickApplyAborted = true;
      // Pretty modal instead of bare toast — user explicitly clicked
      // ⚡ Postular, so a modal is appropriate (they're in the loop).
      // Fire-and-forget: we don't await because the calling code
      // doesn't need the user's modal choice to proceed (the chain
      // already failed; the modal just gives upgrade paths).
      showPlanLimitModal({ feature: "cartas IA" });
      return true;
    }
    if (code === ERR.UNAUTHORIZED) {
      // Stop the chain — without abort the loop re-fires GENERATE_DRAFT
      // on the next iter and hits 401 again. User sees a flood of toasts
      // and the bulk-progress card never goes to "error". Auth-fail is
      // terminal until they re-login, so treat it like plan-limit.
      quickApplyAborted = true;
      reportBulkStatus("error", { label: "Sesión expirada — inicia sesión" });
      clearBulkModeFlag();
      toast("Sesión expirada. Inicia sesión para continuar.", "error", {
        label: "Inicia sesión",
        onClick: () => openOptionsPage()
      });
      return true;
    }
    if (code === ERR.INVALID_INPUT && /perfil|cv|profile/i.test(message)) {
      toast("Sube un CV más completo en Opciones.", "info", {
        label: "Abrir Opciones",
        onClick: () => openOptionsPage()
      });
      return true;
    }
    // Generic fallback. Give it 10s (default is 4s) so the user actually
    // reads WHY it failed — the whole point of this debugging pass is that
    // a 4s toast was being missed ("no vi ningún mensaje"). Transient →
    // the retry panel is useful, so this is NOT terminal.
    toast(message, "error", { durationMs: 10000 });
    return false;
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
  // Cached for refreshBulkSafety to recompute the bulk section without
  // re-running the full panel render. Updated each time the bulk
  // section is rendered.
  let lastBulkPlan = "free";
  let lastBulkRemaining = null;
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
      <div class="eamx-matches-panel__widening" data-eamx-matches-widening hidden>
        <span class="eamx-matches-panel__widening-dot" aria-hidden="true"></span>
        <span class="eamx-matches-panel__widening-text" data-eamx-widening-text>🔍 Buscando más vacantes…</span>
      </div>
      <div class="eamx-matches-panel__content" data-eamx-matches-content>
        <div class="eamx-scan-loader" data-eamx-scan-loader>
          <div class="eamx-scan-loader__halo" aria-hidden="true"></div>
          <div class="eamx-scan-loader__spinner" aria-hidden="true">
            <svg viewBox="0 0 50 50" class="eamx-scan-loader__svg">
              <defs>
                <linearGradient id="eamxSpinGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="#5eead4"/>
                  <stop offset="50%" stop-color="#22d3ee"/>
                  <stop offset="100%" stop-color="#a78bfa"/>
                </linearGradient>
              </defs>
              <circle cx="25" cy="25" r="20" fill="none" stroke-width="4" stroke="url(#eamxSpinGrad)" />
            </svg>
            <span class="eamx-scan-loader__pulse" aria-hidden="true"></span>
          </div>
          <div class="eamx-scan-loader__title">Analizando todas las vacantes</div>
          <div class="eamx-scan-loader__sub" data-eamx-scan-sub>Buscando en cada página para no perderme las mejores…</div>
          <div class="eamx-scan-loader__bar" aria-hidden="true">
            <div class="eamx-scan-loader__bar-fill" data-eamx-scan-bar style="width: 4%"></div>
          </div>
          <div class="eamx-scan-loader__stats">
            <div class="eamx-scan-loader__stat eamx-scan-loader__stat--page">
              <span class="eamx-scan-loader__stat-icon" aria-hidden="true">📄</span>
              <span class="eamx-scan-loader__stat-label">Página</span>
              <span class="eamx-scan-loader__stat-value" data-eamx-scan-page>1 / ?</span>
            </div>
            <div class="eamx-scan-loader__stat eamx-scan-loader__stat--found">
              <span class="eamx-scan-loader__stat-icon" aria-hidden="true">✨</span>
              <span class="eamx-scan-loader__stat-label">Encontradas</span>
              <span class="eamx-scan-loader__stat-value" data-eamx-scan-count>0</span>
            </div>
            <div class="eamx-scan-loader__stat eamx-scan-loader__stat--best">
              <span class="eamx-scan-loader__stat-icon" aria-hidden="true">🏆</span>
              <span class="eamx-scan-loader__stat-label">Mejor match</span>
              <span class="eamx-scan-loader__stat-value" data-eamx-scan-best>—</span>
            </div>
          </div>
          <div class="eamx-scan-loader__hint">Tarda ~1-2 min. No cierres la pestaña.</div>
        </div>
      </div>
      <div class="eamx-matches-panel__bulk" data-eamx-matches-bulk hidden>
        <button type="button" class="eamx-matches-panel__bulk-btn eamx-matches-panel__bulk-btn--primary" data-action="bulk-apply-top">⚡ Auto-postular top 5 (sin sacarte de aquí)</button>
        <button type="button" class="eamx-matches-panel__bulk-btn" data-action="mark-top-5">⭐ Solo marcar top 5 en mi cola</button>
        <p class="eamx-matches-panel__bulk-hint"><strong>⚡ Auto-postular</strong> abre cada vacante en una pestaña en segundo plano, corre la cadena (carta + CV + Q&A + quiz) y al terminar la <strong>ENVÍA automáticamente</strong> — son postulaciones reales. Tienes <strong>5 s para cancelar</strong> cada una (Esc, o "Ver pestaña"). <strong>⭐ Marcar</strong> NO envía nada: solo guarda en tu cola para revisar y postular tú después.</p>
      </div>
    `;

    // Wire close interactions BEFORE we attach to DOM so even an early
    // failure path can be dismissed.
    matchesPanelEl.addEventListener("click", onMatchesPanelClick);
    document.documentElement.appendChild(matchesPanelEl);
    requestAnimationFrame(() => matchesPanelEl?.classList.add("eamx-matches-panel--open"));
    // Hide the FAB while the panel is open — the panel covers the
    // bottom-right corner where the FAB lives, so otherwise it's stuck
    // behind the sheet ("no se ve"). Restored in closeMatchesPanel.
    setFabHidden(true);

    // Escape key closes the panel.
    matchesEscHandler = (ev) => {
      if (ev.key === "Escape" || ev.key === "Esc") {
        ev.stopPropagation();
        closeMatchesPanel();
      }
    };
    document.addEventListener("keydown", matchesEscHandler, true);

    // Subscribe to queue changes so external "Quitar" actions update the
    // per-item buttons immediately AND the safety pill (daily counter)
    // reflects new applications without requiring a panel re-open.
    try {
      if (chrome?.storage?.onChanged) {
        matchesQueueListener = (changes, area) => {
          if (area !== "local") return;
          if (changes && changes["eamx:queue"]) {
            // 1) Mark buttons (per-card "✓ Marcada" badges).
            repaintMarkButtons();
            // 2) Re-render the safety pill + chip selector so the
            //    daily counter (e.g. "Hoy en este portal: 5/20")
            //    moves the moment a Finalizar click lands a row.
            //    Without this, the pill stays stuck at the value it
            //    had when the panel first opened.
            try { refreshBulkSafety(); } catch (_) {}
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
    // Panel is closing → bring the FAB back (it was hidden while open).
    setFabHidden(false);
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
    if (what === "bulk-apply-top") {
      ev.preventDefault();
      onMatchesBulkApplyTop(action);
      return;
    }
    if (what === "bulk-select-n") {
      // User picked a different N from the chip row. Highlight the
      // new chip, un-highlight siblings, update both <span data-bulk-
      // count> placeholders in the action buttons, and persist the
      // choice per-plan so reopening the panel remembers it.
      ev.preventDefault();
      onMatchesBulkSelectN(action);
      return;
    }
    if (what === "bulk-pick-custom-n") {
      // User clicked the "Más…" chip — prompt for a custom N.
      // Validated client-side against data-bulk-max (which already
      // reflects min(monthlyRemaining, dailyRemaining)).
      ev.preventDefault();
      const max = Number(action.getAttribute("data-bulk-max")) || 0;
      if (max <= 0) {
        toast("Sin cupo disponible para postular más vacantes hoy.", "info", { durationMs: 5000 });
        return;
      }
      const raw = window.prompt(
        `¿Cuántas vacantes auto-postular? (1 – ${max})`,
        String(Math.min(max, 7))
      );
      if (raw == null) return; // user cancelled
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 1) {
        toast("Cantidad inválida.", "error", { durationMs: 4000 });
        return;
      }
      if (n > max) {
        toast(`Máximo permitido hoy: ${max}.`, "info", { durationMs: 5000 });
        return;
      }
      // Persist + refresh the bulk section so the new N becomes the
      // active chip and gets picked up by onMatchesBulkApplyTop.
      try {
        chrome.storage.local.set({ [`eamx:bulk-n:${lastBulkPlan}`]: n }, () => {
          refreshBulkSafety().catch(() => {});
        });
      } catch (_) {
        refreshBulkSafety().catch(() => {});
      }
      return;
    }
    if (what === "focus-tab") {
      // "Ver pestaña" inside the bulk-progress card — message the
      // background to bring that background tab to focus.
      ev.preventDefault();
      const tabId = Number(action.getAttribute("data-tab-id"));
      if (Number.isFinite(tabId)) {
        try { chrome.runtime.sendMessage({ type: MSG.FOCUS_TAB, tabId }); } catch (_) {}
      }
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
    if (what === "mark-applied") {
      // "✓ Ya apliqué" — manual marker for vacancies the user applied
      // to outside our chain (manually, before our tracker existed, or
      // from another device). We upsert into the queue with status
      // "aplicada"; renderMatchesPanelContent re-fetches appliedIds on
      // next render so the card flips to the dimmed/badged state.
      ev.preventDefault();
      ev.stopPropagation();
      const id = action.getAttribute("data-id");
      onMatchesManualMarkApplied(action, id);
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
    if (what === "open-preferences" || what === "filters-open-options") {
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
    if (what === "toggle-filters") {
      // Filters now live on the web. The extension is just the apply
      // engine — user explicit ask: "que la extension sea mas para
      // aplicar o autoaplicar y ya". Click → open web preferences in
      // a new tab. The extension polls /account on next open to pick
      // up the new prefs.
      ev.preventDefault();
      try {
        window.open(
          "https://empleo.skybrandmx.com/account/preferences",
          "_blank",
          "noopener,noreferrer"
        );
      } catch (_) {}
      return;
    }
    if (what === "filter-modality") {
      ev.preventDefault();
      // Update the chip group visual state. The actual save happens on
      // "Aplicar filtros" — keeps the UI responsive without writing to
      // storage on every chip click.
      const drawer = action.closest("[data-eamx-filters]");
      if (drawer) {
        const chips = drawer.querySelectorAll("[data-action='filter-modality']");
        chips.forEach((c) => {
          const isActive = c === action;
          c.classList.toggle("eamx-filters__chip--active", isActive);
          c.setAttribute("aria-pressed", isActive ? "true" : "false");
        });
      }
      return;
    }
    if (what === "filters-apply") {
      ev.preventDefault();
      onMatchesFiltersApply();
      return;
    }
    if (what === "filters-clear") {
      ev.preventDefault();
      onMatchesFiltersClear();
      return;
    }
    if (what === "open-billing") {
      // Click on the usage pill when at-or-over the monthly limit. Goes
      // straight to billing so the user can upgrade without hunting.
      ev.preventDefault();
      openBilling();
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

  // Read the total page count from MUI's pagination. The user reported
  // analyzing only 180 vacantes (~14 pages) when the listing had 36
  // pages. With the new dynamic cap, the wider-search loop stops when
  // it actually runs out of pages rather than at an arbitrary 14.
  // Returns null when we can't find a meaningful number — caller falls
  // back to a hard cap.
  function detectTotalPaginationPages() {
    try {
      // MUI Pagination renders each page as a <button aria-label="Go to page N">.
      // The total is the max N across those buttons.
      const buttons = document.querySelectorAll('.MuiPagination-ul button[aria-label*="page" i]');
      let max = 0;
      buttons.forEach((b) => {
        const txt = (b.textContent || "").trim();
        const n = Number(txt);
        if (Number.isFinite(n) && n > max) max = n;
      });
      if (max > 0) return max;
      // Fallback: parse "x de Y" or "x of Y" strings the site sometimes shows.
      const summary = document.body.innerText.match(/(?:de|of)\s+(\d{2,4})\s+(?:p[áa]ginas?|pages?)/i);
      if (summary && Number(summary[1]) > 0) return Number(summary[1]);
    } catch (_) {}
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
      // Inspect the card for "already-applied" / "closed" markers so
      // the panel can filter them OUT of the bulk top-N and BEFORE
      // wasting a quota slot on a tab whose chain would just bail.
      const cardStatus = detectCardStatus(card);
      out.push({
        jobLite,
        score,
        reasons,
        level,
        appliedFromCard: cardStatus.applied,
        closedFromCard: cardStatus.closed
      });
    }
    return out;
  }

  // Auto-trigger flag: set to true while a widening loop is in flight so
  // re-entrancy (e.g. user closes + reopens panel mid-flight) doesn't
  // start a second loop. Cleared in the finally block.
  let widerSearchInProgress = false;
  // "Scheduled" flag: set the moment a scan is queued via setTimeout
  // (200ms defer to let the panel slide-in settle), cleared when the
  // scan actually starts. Closes a race where a re-render landing in
  // the 200ms gap saw inProgress=false and would have fallen through
  // to the empty state, overwriting the loader. User-reported as
  // "Página 1/37 · 12 vacantes" + "No detecté vacantes" at the same
  // time — that gap is exactly the 200ms window.
  let widerSearchScheduled = false;
  // Retry counter for the "cards not painted yet, retry shortly"
  // branch in the scan gate. Bounded so we never recurse forever if
  // LaPieza genuinely has no vacancies to paint. 6 retries × 800ms
  // = ~5s of grace before falling through to the empty state.
  let panelEmptyRetries = 0;
  const PANEL_EMPTY_MAX_RETRIES = 6;

  /**
   * Run the wider-search loop. Called either:
   *   - From the user explicitly clicking a button (legacy path, btn passed)
   *   - Auto-fired by renderMatchesPanelContent on first panel open (no btn)
   *
   * Progress is surfaced via the [data-eamx-matches-widening] strip in
   * the panel header. When no button is passed we skip the button-text
   * updates and rely entirely on the strip.
   */
  async function onMatchesWiderSearch(btn) {
    if (widerSearchInProgress) return;
    if (btn && btn.disabled) return;
    widerSearchInProgress = true;
    const original = btn ? btn.textContent : "";
    if (btn) btn.disabled = true;
    // Show the auto-widening progress strip in the panel header.
    const wideStrip = matchesPanelEl?.querySelector("[data-eamx-matches-widening]");
    const wideText = matchesPanelEl?.querySelector("[data-eamx-widening-text]");
    if (wideStrip) wideStrip.hidden = false;
    const setProgress = (txt) => {
      if (wideText) wideText.textContent = txt;
      if (btn) btn.textContent = txt;
    };
    // Update the prominent scan loader card (the hero "Analizando todas
    // las vacantes" block). The strip is fine for "almost done" status
    // but a user opening the panel for the first time needs a clear,
    // visible signal that work is happening — not just a tiny dot.
    //
    // User feedback: "que este un cargando o un preload para que sepa
    // porque solo carga y ya".
    const updateScanLoader = ({ page, total, count, bestScore, doneLabel } = {}) => {
      const pageEl = matchesPanelEl?.querySelector("[data-eamx-scan-page]");
      const countEl = matchesPanelEl?.querySelector("[data-eamx-scan-count]");
      const bestEl = matchesPanelEl?.querySelector("[data-eamx-scan-best]");
      const barEl = matchesPanelEl?.querySelector("[data-eamx-scan-bar]");
      const subEl = matchesPanelEl?.querySelector("[data-eamx-scan-sub]");
      if (pageEl && page != null) pageEl.textContent = `${page} / ${total ?? "?"}`;
      if (countEl && count != null) countEl.textContent = String(count);
      if (bestEl && bestScore != null) {
        bestEl.textContent = bestScore > 0 ? `${bestScore}%` : "—";
      }
      if (barEl && page != null && total) {
        const pct = Math.min(100, Math.max(4, Math.round((page / total) * 100)));
        barEl.style.width = `${pct}%`;
      }
      if (subEl && doneLabel) subEl.textContent = doneLabel;
    };
    // Highest-scoring entry seen so far across the cumulative pool —
    // surfaced live in the loader as "Mejor match" so the user has a
    // signal that the wait is producing value.
    const peekBestScore = (poolMap) => {
      let best = 0;
      try {
        for (const entry of poolMap.values()) {
          const s = Number(entry.score) || 0;
          if (s > best) best = s;
        }
      } catch (_) {}
      return best;
    };
    // Hard cap of 40 covers virtually any LaPieza listing (user
    // reported a 36-page listing where the old cap of 14 missed half
    // the vacantes). We also try to detect the actual page count from
    // MUI's paginator and use the min — so a 5-page search doesn't
    // burn time clicking Next 40 times for nothing.
    //
    // Time budget at 40 pages: ~40 × (4s poll + 0.4s pause) ≈ 3 min
    // worst case. Acceptable for a one-time wider search.
    const HARD_CAP = 40;
    const detected = detectTotalPaginationPages();
    const MAX_PAGES = detected ? Math.min(detected, HARD_CAP) : HARD_CAP;
    console.log("[EmpleoAutomatico] wider-search MAX_PAGES =", MAX_PAGES, "(detected:", detected, ")");
    const PER_PAGE_TIMEOUT_MS = 4000;
    const POLL_INTERVAL_MS = 300;
    // Reduced from 700ms — at the higher cap the cumulative wait
    // matters more. 400ms is still well within human-paced.
    const INTER_PAGE_DELAY_MS = 400;
    // Cumulative pool, keyed by jobLite.id. Survives page-change
    // unmounting because we extract jobLites BEFORE clicking next.
    const pool = new Map();
    // Seed the pool with whatever's on screen right now (page 1 worth).
    for (const entry of snapshotCurrentCardsAsPoolEntries()) {
      pool.set(entry.jobLite.id, entry);
    }
    let stallStreak = 0;
    let lastFirstAnchorHref = "";
    // Initial loader state (page 1 already snapshotted into the pool).
    updateScanLoader({ page: 1, total: MAX_PAGES, count: pool.size, bestScore: peekBestScore(pool) });
    try {
      for (let page = 1; page <= MAX_PAGES; page++) {
        setProgress(`🔍 Página ${page}/${MAX_PAGES} · ${pool.size} vacantes`);
        updateScanLoader({ page, total: MAX_PAGES, count: pool.size, bestScore: peekBestScore(pool) });
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
        // Update the visible loader card live so the user sees the
        // count climbing + the best-match score appearing.
        updateScanLoader({
          page: page + 1, // we just finished `page`, about to start the next
          total: MAX_PAGES,
          count: pool.size,
          bestScore: peekBestScore(pool)
        });
        // Human-paced pause between pages so we don't hammer LaPieza's
        // search backend.
        await new Promise((r) => setTimeout(r, INTER_PAGE_DELAY_MS));
      }
      // Final touch: fill the bar to 100% before render so the
      // transition from "scanning" → "results" feels resolved.
      updateScanLoader({
        page: MAX_PAGES,
        total: MAX_PAGES,
        count: pool.size,
        bestScore: peekBestScore(pool),
        doneLabel: "✓ Listo — preparando ranking…"
      });
      // Activate the pool for the panel render. renderMatchesPanelContent
      // checks widerSearchPool first and uses it instead of live cards.
      widerSearchPool = pool;
      // Cache it so a return visit (even after a full reload from applying)
      // reuses these results instead of re-scanning all 40 pages.
      persistWiderPoolToSession(pool);
      await renderMatchesPanelContent();
      const best = matchesCurrentTopN[0]?.score ?? 0;
      setProgress(`✓ ${pool.size} vacantes analizadas · mejor ${best}%`);
      // Hide the progress strip after a short reveal so the user sees the
      // final count, but the panel returns to a clean state.
      setTimeout(() => { if (wideStrip) wideStrip.hidden = true; }, 4000);
    } catch (err) {
      console.warn("[EmpleoAutomatico] wider search failed", err);
      setProgress("No se pudo ampliar la búsqueda");
      setTimeout(() => { if (wideStrip) wideStrip.hidden = true; }, 4000);
      // Recovery: surface whatever we accumulated so far (even partial
      // pool) so the loader doesn't stay frozen until the next storage
      // change. Without this the user sees the spinning hero forever
      // when an early-iteration error trips the catch.
      try {
        if (pool && pool.size > 0) { widerSearchPool = pool; persistWiderPoolToSession(pool); }
        widerSearchInProgress = false; // clear early so the gate falls through
        await renderMatchesPanelContent();
      } catch (_) { /* even render failed — nothing more we can do gracefully */ }
    } finally {
      widerSearchInProgress = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = original || "🔍 Buscar más amplio";
      }
      // Final render so the bottom "Buscando más vacantes…" loader can
      // clear now that widerSearchInProgress is false. Without this the
      // loader stays painted in the panel until the next external
      // trigger (queue change, scroll, etc.).
      try { renderMatchesPanelContent(); } catch (_) {}
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

    // RE-SCAN AVOIDANCE: if there's no in-memory pool (e.g. the user applied
    // to a job and the page fully reloaded, wiping module state), try to
    // restore a recent pool for THIS exact search from session storage.
    // Without this, returning to /vacantes re-runs the whole 40-page scan
    // even though we just did it. Keyed by pathname+search so changing
    // filters still triggers a fresh scan; 15-min TTL bounds staleness.
    if (!widerSearchPool && !widerSearchInProgress && !widerSearchScheduled) {
      try {
        const restored = await restoreWiderPoolFromSession();
        if (restored && restored.size) {
          widerSearchPool = restored;
          console.log(
            "[EmpleoAutomatico] restored wider-search pool from session:",
            restored.size, "vacantes (skipping re-scan)"
          );
        }
      } catch (_) { /* ignore — fall through to a fresh scan */ }
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

    // SCAN-IN-PROGRESS GATE: keep the hero loader visible while the
    // wider-search is gathering pages OR is about to. Comes BEFORE
    // the empty-state check because during a scan LaPieza unmounts
    // cards between pagination ticks; a render mid-tick sees
    // cards.length === 0 and would otherwise paint "No detecté
    // vacantes" over the loader.
    //
    // Four firing modes:
    //   A) Scan running (widerSearchInProgress)            → loader stays
    //   B) Scan scheduled but not started yet (200ms gap)  → loader stays
    //   C) Can start scan (no pool, >=5 cards, !scheduled) → schedule + loader stays
    //   D) Listing-y path but cards not painted yet        → retry shortly
    //
    // The "scheduled but not started" case (B) closes a tight race:
    // we defer the scan by 200ms; a re-render landing in that gap
    // would otherwise see inProgress=false, fall through, and overwrite
    // the loader. User-reported as "Página 1/37 · 12 vacantes" co-
    // existing with "No detecté vacantes" — that's exactly this race.
    const scanRunning = !widerSearchPool && widerSearchInProgress;
    const scanScheduled = !widerSearchPool && widerSearchScheduled;
    const canStartScan = !widerSearchPool && !widerSearchInProgress && !widerSearchScheduled
                       && cards.length >= 5 && cards.length < 100;
    // Listing-page heuristic: if we're on a path that should have
    // vacancies but cards aren't visible yet, keep the loader and
    // retry on the next tick instead of bailing to the empty state.
    const onListingPath = /^\/(?:vacantes|vacancies|jobs|empleos|comunidad)/i.test(location.pathname);
    const canStartScanLater = !widerSearchPool && !widerSearchInProgress && !widerSearchScheduled
                            && cards.length === 0 && onListingPath
                            && panelEmptyRetries < PANEL_EMPTY_MAX_RETRIES;

    if (scanRunning || scanScheduled || canStartScan || canStartScanLater) {
      if (bulk) bulk.hidden = true;
      // Reset retry counter when we actually have cards or a scan
      // running — only the empty-listing retry loop should count.
      if (scanRunning || scanScheduled || canStartScan) panelEmptyRetries = 0;
      if (canStartScan) {
        // Set scheduled BEFORE the setTimeout so re-renders during the
        // 200ms defer can see the flag.
        widerSearchScheduled = true;
        setTimeout(() => {
          // Clear scheduled the moment the scan actually starts.
          widerSearchScheduled = false;
          try { onMatchesWiderSearch(null); } catch (_) {}
        }, 200);
      } else if (canStartScanLater) {
        // Cards not painted yet — retry shortly. Bounded by
        // PANEL_EMPTY_MAX_RETRIES so we don't loop forever if
        // LaPieza genuinely has no vacancies.
        panelEmptyRetries++;
        setTimeout(() => {
          try { renderMatchesPanelContent(); } catch (_) {}
        }, 800);
      }
      return;
    }
    // Reset counter once we cleared the gate (about to render real
    // content or genuine empty state).
    panelEmptyRetries = 0;

    // Empty state #2 — no cards at all (and no scan running). Two flavors:
    //  a) We're already on a listing route (/vacantes, /comunidad/jobs,
    //     etc.) but no cards rendered → probably a transient/empty
    //     filter result. CTA: "Volver a escanear".
    //  b) We're on the homepage / company landing / unknown route → the
    //     useful CTA is taking the user to the listing where vacancies
    //     ARE shown. CTA: "Ir a Vacantes →".
    //
    // DEFENSIVE: never paint empty state if the wider-search pool has
    // ANY entries — the live cards are momentarily zero because LaPieza
    // unmounts page N's DOM between pagination ticks, but the pool we
    // accumulated is still the user's matches. Letting the empty state
    // win here was the root of "Página 10/40 · 120 vacantes" co-existing
    // with "No detecté vacantes" — the widening strip's text was the
    // truth (pool has 120) but the body was painting from stale-DOM.
    //
    // Likewise, never paint empty state if a scan is in flight (either
    // running or scheduled to start) — the scan loader card belongs here
    // until it produces a pool. The gate above SHOULD have caught those
    // cases already; this is belt-and-suspenders for any future re-entry
    // path that bypasses the gate.
    const poolHasEntries = !!(widerSearchPool && widerSearchPool.size);
    const scanInFlight = widerSearchInProgress || widerSearchScheduled;
    if (!cards.length && !poolHasEntries && !scanInFlight) {
      const onListingAlready = /^\/(?:vacantes|vacancies|jobs|empleos|comunidad)/i.test(location.pathname);
      const headline = onListingAlready ? "No detecté vacantes" : "Estás en una página sin vacantes";
      const body = onListingAlready
        ? "No encontramos vacantes en esta vista. Refresca la página o ajusta tus filtros para volver a intentar."
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
    // If we get here with cards.length === 0 it MUST be because we have
    // a pool (or a scan in flight). Both will be handled below: the
    // scoring path uses widerSearchPool when present, and if only a
    // scan is in flight, the gate at the top of this function already
    // returned us before reaching here. Defensive log so we see the
    // race in the wild.
    if (!cards.length) {
      console.log(
        "[EmpleoAutomatico] zero live cards but pool/scan present — using pool",
        { poolSize: widerSearchPool?.size, scanInFlight }
      );
    }

    // (Old SCAN-IN-PROGRESS GATE moved above the empty-state check —
    // see the scanRunning/canStartScan branch up there. By the time
    // we reach this point either widerSearchPool is populated OR the
    // listing is too small/large for a scan, so just continue.)

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
        return {
          jobLite: entry.jobLite,
          anchor: null,
          card: null,
          score,
          reasons,
          level,
          appliedFromCard: !!entry.appliedFromCard,
          closedFromCard: !!entry.closedFromCard
        };
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
        const cardStatus = detectCardStatus(card);
        return {
          jobLite,
          anchor,
          card,
          score,
          reasons,
          level,
          appliedFromCard: cardStatus.applied,
          closedFromCard: cardStatus.closed
        };
      });
    }

    // AUTO-DETECTED STATUS HANDLING
    // - Closed vacancies: dropped entirely (can never be applied to).
    // - Applied vacancies: pulled OUT of the ranked top-25 (you can't
    //   apply again, so they shouldn't burn a slot) and surfaced in a
    //   separate "Ya postuladas" section below the list. User ask: "si ya
    //   se postuló mejor que ni salgan… que salgan los postulados aparte".
    //
    // "Applied" is detected PAGE-FIRST: the card's own marker that LaPieza
    // paints ("Ya postulada", attrs) → detectCardStatus → appliedFromCard.
    // The queue is the persistent fallback so a vacancy applied on a
    // PREVIOUS visit / via the chain still counts after navigation or when
    // we reuse the cached pool (whose frozen appliedFromCard predates the
    // application). User ask: "de la página no de la extensión… que detecte
    // los postulados".
    const closedDropped = scored.filter((m) => m.closedFromCard).length;
    scored = scored.filter((m) => !m.closedFromCard);

    // Applied IDs from the queue (persisted page-detections + chain
    // applications). Fetched here so the active/applied split can use it.
    let appliedIds = new Set();
    if (queueModule && typeof queueModule.appliedIdsForSource === "function") {
      try { appliedIds = await queueModule.appliedIdsForSource(SOURCE); } catch (_) {}
    }
    const isAppliedMatch = (m) =>
      !!(m && m.jobLite) &&
      (m.appliedFromCard === true || appliedIds.has(String(m.jobLite.id || "")));

    // Sync page-detected applications into the queue so the "applied"
    // state persists across navigation. Fire-and-forget.
    const autoMarkApplied = scored.filter((m) => m.appliedFromCard && m.jobLite && m.jobLite.id);
    if (autoMarkApplied.length && queueModule && typeof queueModule.upsertApplied === "function") {
      Promise.all(autoMarkApplied.map((m) =>
        queueModule.upsertApplied({
          id: m.jobLite.id,
          source: SOURCE,
          url: m.jobLite.url || "",
          title: m.jobLite.title || "",
          company: m.jobLite.company || "",
          location: m.jobLite.location || "",
          savedAt: Date.now(),
          matchScore: Number(m.score) || 0,
          reasons: ["Detectada como ya postulada desde el listado"]
        }).catch(() => {})
      )).catch(() => {});
    }

    // Split: applied → their own section; everything else competes for the
    // top-25 ranked list.
    const appliedScored = scored
      .filter(isAppliedMatch)
      .sort((a, b) => (b.score - a.score) || 0)
      .slice(0, 25);
    scored = scored.filter((m) => !isAppliedMatch(m));

    if (closedDropped > 0 || appliedScored.length > 0) {
      console.log(
        "[EmpleoAutomatico] panel render: dropped", closedDropped,
        "closed,", appliedScored.length, "applied moved to its own section"
      );
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
    // Note logic:
    //  - If there are no active (not-yet-applied) matches but there ARE
    //    applied ones, say so — the empty list is "you applied to them all",
    //    not "nothing matched".
    //  - Otherwise, the usual low-fit hint when every active match is weak.
    const lowFitNote = (topN.length === 0 && appliedScored.length > 0)
      ? `<div class="eamx-matches-panel__note">Ya te postulaste a todas las vacantes que coincidían en esta vista. Cambia los filtros o busca otra cosa para ver más.</div>`
      : (topN.length > 0 && topN.every((m) => m.score < 30))
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
    const hasPrefs = prefsIcons.length > 0;
    // Filtros chip — compact version. Same height as the other 3
    // stats so the row doesn't look uneven (user feedback: "se ve
    // muy amontonado todo"). Affordance comes from: teal border +
    // small ↗ icon next to the label + cursor pointer + hover glow.
    // Value row shows either the prefs emojis or "Configurar" prompt.
    const filtersValue = hasPrefs
      ? prefsIcons.join(" ")
      : `<span class="eamx-matches-panel__filters-empty">Configurar</span>`;
    const filtersTitle = hasPrefs
      ? "Abrir editor de preferencias en empleo.skybrandmx.com (nueva pestaña)"
      : "Configura ciudad, modalidad y salario en empleo.skybrandmx.com (nueva pestaña)";
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
          <span class="eamx-matches-panel__stat-value">${widerSearchPool?.size || cards.length}</span>
        </div>
        <button type="button" class="eamx-matches-panel__stat eamx-matches-panel__stat--filters" data-action="toggle-filters" title="${escapeHtml(filtersTitle)}" aria-label="${escapeHtml(filtersTitle)}">
          <span class="eamx-matches-panel__stat-label">
            Filtros
            <svg class="eamx-matches-panel__filters-ext" viewBox="0 0 24 24" width="10" height="10" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7"/><path d="M9 7h8v8"/></svg>
          </span>
          <span class="eamx-matches-panel__stat-value eamx-matches-panel__filters-value">${filtersValue}</span>
        </button>
      </div>
      ${renderFiltersDrawer(prefsForUi)}
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
    // (appliedIds was fetched earlier — before the active/applied split —
    // and is reused here for the per-card badge.)

    // Fetch plan usage in parallel so the panel can surface "Te quedan
    // X de Y este mes" right above the stats strip. User explicit ask:
    // "que te salga cuantos te salen de tu plan" — without this they
    // had to open the popup or guess before clicking Auto-postular top 5.
    // Best-effort; if the auth ping fails we just skip the pill rather
    // than blocking the whole panel render.
    let usagePill = "";
    let userPlan = "free";
    let userRemaining = null; // null = unknown; finite number = remaining cuota
    try {
      const auth = await sendMsg({ type: MSG.GET_AUTH_STATUS });
      if (auth && auth.ok && auth.loggedIn && auth.usage) {
        usagePill = renderUsagePill(auth.usage, auth.user);
        userPlan = (auth.user && auth.user.plan) || "free";
        const limit = Number(auth.usage.limit);
        const current = Number(auth.usage.current) || 0;
        if (limit === -1) {
          userRemaining = Infinity;
        } else if (Number.isFinite(limit)) {
          userRemaining = Math.max(0, limit - current);
        }
      }
    } catch (_) { /* offline or network blip — skip pill */ }

    const list = topN.map((m, i) => renderMatchItem(m, i + 1, appliedIds)).join("");
    // "Ya postuladas" section — applied vacancies pulled out of the ranked
    // list above, shown compactly below so the user can see what's already
    // done without it competing for the top-25. Display-only (no Marcar /
    // Postular handlers) so it needs nothing from matchesCurrentTopN.
    const appliedSection = appliedScored.length
      ? `<section class="eamx-matches-applied" aria-label="Ya postuladas">
           <h3 class="eamx-matches-applied__head">
             <span aria-hidden="true">✓</span> Ya postuladas en esta búsqueda · ${appliedScored.length}
           </h3>
           <ol class="eamx-matches-applied__list">
             ${appliedScored.map((m) => renderAppliedItem(m)).join("")}
           </ol>
         </section>`
      : "";
    const footer = cards.length < 5
      ? `<p class="eamx-matches-panel__hint">Scroll para más vacantes.</p>`
      : "";
    // Bottom loader — fills the space below the visible matches while the
    // wider-search keeps fetching more pages. Without this, scrolling
    // down past the last match landed on the panel's solid background,
    // which the user read as "broken / black" instead of "still working".
    // User feedback: "en vez de que salga en negro cuando bajo que salga
    // cargando". A second render fires in onMatchesWiderSearch's finally
    // block to clear this once the scan completes.
    const scanRunningFooter = widerSearchInProgress
      ? `<div class="eamx-matches-list-loader" aria-live="polite">
           <div class="eamx-matches-list-loader__row">
             <svg class="eamx-matches-list-loader__spinner" viewBox="0 0 50 50" aria-hidden="true">
               <circle cx="25" cy="25" r="20" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-dasharray="100" stroke-dashoffset="40"/>
             </svg>
             <span class="eamx-matches-list-loader__text">Buscando más vacantes en otras páginas…</span>
           </div>
           <div class="eamx-matches-list-loader__hint">La lista se irá ampliando sola conforme aparezcan más matches.</div>
         </div>`
      : "";
    host.innerHTML = `${usagePill}${stats}${top1Banner}${lowFitNote}<ol class="eamx-matches-list">${list}</ol>${appliedSection}${footer}${scanRunningFooter}`;

    // Regenerate the bulk section with plan-aware chips. The static
    // markup baked into the panel root only knows "top 5"; here we
    // know the plan + remaining cuota so we can offer (1, 3, 5) for
    // Free, (3, 5, 10) for Pro, (5, 10, 15, 25) for Premium — capped
    // at the user's actual remaining cuota so they can't pick "10"
    // when they only have 4 left.
    const bulkEl = matchesPanelEl?.querySelector("[data-eamx-matches-bulk]");
    if (bulkEl) {
      // Load the user's last-used N from local storage (per-plan keyed
      // so switching Free→Pro doesn't carry over an inflated default).
      let savedN = null;
      try {
        const stored = await new Promise((resolve) => {
          try {
            chrome.storage.local.get([`eamx:bulk-n:${userPlan}`], (r) => resolve(r || {}));
          } catch (_) { resolve({}); }
        });
        savedN = Number(stored[`eamx:bulk-n:${userPlan}`]) || null;
      } catch (_) {}

      // Per-portal daily cap (green-zone threshold) + how many of those
      // we already used today. The bulk section uses both to: (1) cap
      // the chip selector to (dailyCap - dailyCount), (2) render the
      // safety pill showing the counter. Defends the user against
      // portal bot-detection bans even if they manually try to push
      // past the safe limit.
      const dailyCap = AUTO_PORTAL_CAPS[SOURCE] ?? 20;
      let dailyCount = 0;
      try {
        await ensureDiscoveryDeps();
        if (queueModule && typeof queueModule.countAppliedTodayForSource === "function") {
          dailyCount = await queueModule.countAppliedTodayForSource(SOURCE);
        }
      } catch (_) {}

      // Cache so refreshBulkSafety can re-render on queue change
      // without re-running the full panel content pipeline.
      lastBulkPlan = userPlan;
      lastBulkRemaining = userRemaining;

      bulkEl.innerHTML = renderBulkSection({
        plan: userPlan,
        remaining: userRemaining,
        savedN,
        dailyCount,
        dailyCap
      });
    }

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

    // Wire the scroll re-populate handler when there are too few cards.
    if (cards.length < 5) attachMatchesScrollHandler();
    else detachMatchesScrollHandler();

    // (Auto-fire of wider-search moved to the top of this function —
    // see the FIRST-OPEN GATE branch. By the time we get here the
    // pool is already populated, or the listing was too small/large
    // to warrant a scan, so nothing to do.)

    console.log(`[EmpleoAutomatico] best matches panel opened: ${topN.length} matches`);
  }

  // Plan-usage pill rendered above the stats strip in the best-matches
  // panel. Tells the user — BEFORE they click Auto-postular top 5 — how
  // many AI-powered applications they still have for the month. Four
  // visual states keyed off the remaining count:
  //   - Premium ilimitado (limit === -1)  → green "✨ Ilimitado"
  //   - At-or-over limit                   → red, clickable → openBilling
  //   - Low (remaining < 25% of limit)     → amber warning
  //   - Plenty                             → neutral teal
  // The pill is a real <button> when in the at-limit state so the user
  // can immediately upgrade; in the other states it's a static <div>.
  // Plan-aware bulk action section. Renders a row of "N" chips so the
  // user can pick how many vacancies to auto-postular in one go, then
  // the two action buttons (Auto-postular / Solo marcar). Caps the
  // available chips at the user's remaining monthly cuota so they
  // can't pick more than they have credit for. The last-used N is
  // persisted to chrome.storage.local keyed per-plan.
  // Re-render the bulk section (chip selector + safety pill) in place
  // without going through the full renderMatchesPanelContent pipeline.
  // Triggered by the queue-change listener so the safety pill counter
  // ("Hoy en este portal: N/M") moves the moment a Finalizar lands.
  async function refreshBulkSafety() {
    if (!matchesPanelEl) return;
    const bulkEl = matchesPanelEl.querySelector("[data-eamx-matches-bulk]");
    if (!bulkEl) return;
    const dailyCap = AUTO_PORTAL_CAPS[SOURCE] ?? 20;
    let dailyCount = 0;
    try {
      if (queueModule && typeof queueModule.countAppliedTodayForSource === "function") {
        dailyCount = await queueModule.countAppliedTodayForSource(SOURCE);
      }
    } catch (_) {}
    // Preserve the user's last-selected N (read from the live DOM —
    // the chip with --active class is the source of truth).
    let savedN = null;
    try {
      const activeChip = bulkEl.querySelector(".eamx-bulk__chip--active[data-bulk-n]");
      if (activeChip) savedN = Number(activeChip.getAttribute("data-bulk-n")) || null;
    } catch (_) {}
    bulkEl.innerHTML = renderBulkSection({
      plan: lastBulkPlan,
      remaining: lastBulkRemaining,
      savedN,
      dailyCount,
      dailyCap
    });
  }

  function renderBulkSection({ plan = "free", remaining = null, savedN = null, dailyCount = 0, dailyCap = 20 } = {}) {
    // Per-plan chip options. Tuned so the user always sees a small,
    // a medium, and a "max for this plan" choice — and so Free never
    // sees an unattainable "10" chip.
    const PLAN_CHIPS = {
      free: [1, 2, 3],
      pro: [3, 5, 10],
      premium: [5, 10, 15, 25]
    };
    let chips = PLAN_CHIPS[plan] || PLAN_CHIPS.free;
    // Cap by remaining cuota so the user can't pick "10" when only 4
    // are left. Infinity (Premium ilimitado) means no cap.
    if (remaining != null && Number.isFinite(remaining)) {
      chips = chips.filter((n) => n <= remaining);
      // Always offer at least one chip so the buttons aren't lonely;
      // if remaining=0 the bulk-apply pre-flight already shows the
      // plan-limit modal so the user can't actually fire.
      if (chips.length === 0 && remaining > 0) chips = [Math.min(remaining, 3)];
      if (chips.length === 0) chips = [chips[0] ?? 3];
    }
    // ALSO cap by the per-portal daily green-zone threshold. This is
    // the anti-bot-detection floor — LinkedIn 15/day, OCC 20/day, etc.
    // Calibrated against published green-zone thresholds; competitors
    // like Breeze Apply / LazyApply skip this gate and earn bans.
    const dailyRemaining = Math.max(0, dailyCap - dailyCount);
    if (Number.isFinite(dailyRemaining)) {
      chips = chips.filter((n) => n <= dailyRemaining);
      if (chips.length === 0 && dailyRemaining > 0) chips = [dailyRemaining];
      if (chips.length === 0) chips = [1]; // defensive, the gate up the chain handles "0 left"
    }

    // Pick the initial active N: savedN if it's still in the chip set,
    // else the middle option, else the first.
    const defaultIdx = Math.min(1, chips.length - 1);
    // If savedN is bigger than the largest chip (user picked a custom
    // value last time, e.g. 18) we add it as an extra chip so the
    // active state has somewhere to land. Only when ≤ dailyRemaining.
    let resolvedActive = chips[defaultIdx];
    if (savedN && Number.isFinite(savedN) && savedN > 0 && savedN <= dailyRemaining) {
      if (chips.includes(savedN)) {
        resolvedActive = savedN;
      } else {
        // Insert savedN into chips in sorted order.
        chips = chips.concat(savedN).sort((a, b) => a - b);
        resolvedActive = savedN;
      }
    }
    const activeN = resolvedActive;

    // Maximum allowed for the custom input — same gate as the chips.
    const customMax = Math.min(
      Number.isFinite(remaining) ? remaining : 99,
      Number.isFinite(dailyRemaining) ? dailyRemaining : 99
    );

    const chipBtns = chips.map((n) => `
      <button type="button"
        class="eamx-bulk__chip ${n === activeN ? 'eamx-bulk__chip--active' : ''}"
        data-action="bulk-select-n"
        data-bulk-n="${n}"
        aria-pressed="${n === activeN ? 'true' : 'false'}">${n}</button>
    `).join("");
    // "Más…" chip — opens a numeric prompt so the user can pick any N
    // up to customMax. Pro users wanted more flexibility than the
    // fixed [3, 5, 10] set without forcing them to upgrade to Premium.
    const moreChip = customMax > (chips[chips.length - 1] || 0)
      ? `<button type="button"
           class="eamx-bulk__chip eamx-bulk__chip--more"
           data-action="bulk-pick-custom-n"
           data-bulk-max="${customMax}"
           title="Elige una cantidad personalizada (máx ${customMax})">Más…</button>`
      : "";

    // The plan label shown next to the chips. Helps the user
    // understand WHY Free only shows 1/2/3 — "Plan Gratis permite hasta
    // 3 postulaciones IA al mes". Use the Spanish label (matches the
    // canonical PLAN_LABELS in lib/schemas.js — "Plan Gratis").
    const planNoun = plan === "free" ? "Plan Gratis" : plan === "pro" ? "Plan Pro" : "Plan Premium";

    // Daily safety pill — shows the per-portal counter + tooltip
    // explaining why the cap exists. User explicit ask: "y del riesgo
    // a que bloquen o eso no?". We surface the protection so they
    // know we're being careful with their account.
    const dailyPct = dailyCap > 0 ? Math.min(100, Math.round((dailyCount / dailyCap) * 100)) : 0;
    const dailyTone = dailyCount >= dailyCap
      ? "eamx-bulk__safety--max"
      : dailyCount >= Math.floor(dailyCap * 0.75)
        ? "eamx-bulk__safety--warn"
        : "eamx-bulk__safety--ok";
    const dailyMsg = dailyCount >= dailyCap
      ? `Llegaste al cap diario seguro (${dailyCap}). Continúa mañana para no arriesgar tu cuenta.`
      : `Cap diario para no disparar detección de bot. LinkedIn e Indeed: 15/día · LaPieza, OCC, Computrabajo, Bumeran: 20/día. Total entre portales: 110/día.`;
    const safetyPill = `
      <div class="eamx-bulk__safety ${dailyTone}" title="${escapeHtml(dailyMsg)}">
        <div class="eamx-bulk__safety-row">
          <span class="eamx-bulk__safety-icon" aria-hidden="true">🛡️</span>
          <span class="eamx-bulk__safety-label">Hoy en este portal</span>
          <span class="eamx-bulk__safety-count">${dailyCount} / ${dailyCap}</span>
        </div>
        <div class="eamx-bulk__safety-bar" aria-hidden="true">
          <div class="eamx-bulk__safety-fill" style="width: ${dailyPct}%"></div>
        </div>
        <p class="eamx-bulk__safety-hint">Cap diario seguro para no arriesgar tu cuenta.</p>
      </div>
    `;

    return `
      ${safetyPill}
      <div class="eamx-bulk__selector" role="group" aria-label="Cantidad a postular">
        <span class="eamx-bulk__selector-label">Cantidad</span>
        <div class="eamx-bulk__chips">${chipBtns}${moreChip}</div>
        <span class="eamx-bulk__selector-plan">${escapeHtml(planNoun)}</span>
      </div>
      <button type="button" class="eamx-matches-panel__bulk-btn eamx-matches-panel__bulk-btn--primary" data-action="bulk-apply-top">
        <span class="eamx-bulk-btn__icon" aria-hidden="true">⚡</span>
        <span class="eamx-bulk-btn__label">Auto-postular top <span data-bulk-count>${activeN}</span></span>
        <span class="eamx-bulk-btn__hint">(sin sacarte de aquí)</span>
      </button>
      <button type="button" class="eamx-matches-panel__bulk-btn" data-action="mark-top-5">
        <span class="eamx-bulk-btn__icon" aria-hidden="true">⭐</span>
        <span class="eamx-bulk-btn__label">Solo marcar top <span data-bulk-count>${activeN}</span> en mi cola</span>
      </button>
      <p class="eamx-matches-panel__bulk-hint"><strong>⚡ Auto-postular</strong> abre cada vacante en una pestaña en segundo plano, corre la cadena (carta + CV + Q&A + quiz) y al terminar la <strong>ENVÍA automáticamente</strong> — son postulaciones reales. Tienes <strong>5 s para cancelar</strong> cada una (Esc, o "Ver pestaña"). <strong>⭐ Marcar</strong> NO envía nada: solo guarda en tu cola para revisar y postular tú después.</p>
    `;
  }

  // In-panel filters drawer. Edits the same preference object that
  // Options writes to (chrome.storage.local["eamx:preferences"]), so
  // saving here also affects the score weighting. Hidden by default;
  // toggled open by clicking the Filtros stat. We render it pre-
  // populated with the current effective prefs so the user sees what
  // they have. The storage.onChanged listener auto-re-renders the
  // whole panel on save, which is exactly the UX we want here.
  function renderFiltersDrawer(prefs) {
    const safe = prefs || {};
    const modality = safe.modality || "any";
    const city = safe.city || "";
    const salaryMin = Number.isFinite(safe.salaryMin) ? safe.salaryMin : "";
    const salaryMax = Number.isFinite(safe.salaryMax) ? safe.salaryMax : "";

    const modalityChip = (val, label) => `
      <button type="button"
        class="eamx-filters__chip ${modality === val ? 'eamx-filters__chip--active' : ''}"
        data-action="filter-modality" data-modality="${val}"
        aria-pressed="${modality === val ? 'true' : 'false'}">${label}</button>
    `;

    return `
      <div class="eamx-filters" data-eamx-filters hidden>
        <div class="eamx-filters__group">
          <label class="eamx-filters__label">Modalidad</label>
          <div class="eamx-filters__chips">
            ${modalityChip("any", "Cualquiera")}
            ${modalityChip("remote", "Remoto")}
            ${modalityChip("hybrid", "Híbrido")}
            ${modalityChip("onsite", "Presencial")}
          </div>
        </div>

        <div class="eamx-filters__group">
          <label class="eamx-filters__label" for="eamx-filters-city">Ciudad</label>
          <input
            type="text"
            id="eamx-filters-city"
            class="eamx-filters__input"
            data-filter-field="city"
            placeholder="Ej. CDMX, Monterrey, Guadalajara…"
            value="${escapeHtml(city)}"
            autocomplete="off"
          >
        </div>

        <div class="eamx-filters__group">
          <label class="eamx-filters__label">Salario mensual (MXN)</label>
          <div class="eamx-filters__salary">
            <div class="eamx-filters__salary-field">
              <span class="eamx-filters__salary-prefix">$</span>
              <input
                type="number"
                class="eamx-filters__input eamx-filters__input--salary"
                data-filter-field="salaryMin"
                placeholder="Mín"
                min="0"
                step="1000"
                value="${salaryMin}"
              >
            </div>
            <span class="eamx-filters__salary-sep">—</span>
            <div class="eamx-filters__salary-field">
              <span class="eamx-filters__salary-prefix">$</span>
              <input
                type="number"
                class="eamx-filters__input eamx-filters__input--salary"
                data-filter-field="salaryMax"
                placeholder="Máx"
                min="0"
                step="1000"
                value="${salaryMax}"
              >
            </div>
          </div>
        </div>

        <div class="eamx-filters__actions">
          <button type="button" class="eamx-filters__btn eamx-filters__btn--ghost" data-action="filters-clear">Limpiar</button>
          <button type="button" class="eamx-filters__btn eamx-filters__btn--primary" data-action="filters-apply">Aplicar filtros</button>
        </div>
        <p class="eamx-filters__hint">Los filtros también afectan el ranking de los matches. Para más opciones <a href="#" data-action="filters-open-options">edita en Opciones →</a></p>
      </div>
    `;
  }

  function renderUsagePill(usage, user) {
    const limit = Number(usage.limit);
    const current = Math.max(0, Number(usage.current) || 0);
    const planName = (user && user.plan) || "free";
    const planLabel = planName.charAt(0).toUpperCase() + planName.slice(1);

    // Modern dashboard-style stat card — Linear/Vercel/Stripe inspired.
    // No icons (they made it look boxy). Hierarchy from typography only:
    //   - hero number (24px / weight 700 / tabular nums / variant color)
    //   - tiny eyebrow label "POSTULACIONES IA" (10px, tracking, muted)
    //   - plan badge pill on the right
    //   - 4px progress track at the bottom (no rounded fill so it
    //     reads as a continuous bar like Linear's loading indicators)
    // Glassmorphism: backdrop-blur + semi-transparent gradient
    // background. Same four variants as before. Over is still a button.

    if (limit === -1) {
      return `
        <div class="eamx-usage eamx-usage--unlimited" title="Plan ${escapeHtml(planLabel)} — sin tope mensual">
          <div class="eamx-usage__row">
            <div class="eamx-usage__col">
              <div class="eamx-usage__eyebrow">Postulaciones IA</div>
              <div class="eamx-usage__hero">
                <span class="eamx-usage__num">∞</span>
                <span class="eamx-usage__suffix">este mes</span>
              </div>
            </div>
            <div class="eamx-usage__badge">${escapeHtml(planLabel)}</div>
          </div>
        </div>
      `;
    }

    if (!Number.isFinite(limit) || limit <= 0) return "";

    const remaining = Math.max(0, limit - current);
    const pct = Math.min(100, Math.round((current / limit) * 100));

    if (remaining === 0) {
      return `
        <button type="button" class="eamx-usage eamx-usage--over" data-action="open-billing" title="Click para subir de plan o comprar créditos extra">
          <div class="eamx-usage__row">
            <div class="eamx-usage__col">
              <div class="eamx-usage__eyebrow">Sin cuota este mes</div>
              <div class="eamx-usage__hero">
                <span class="eamx-usage__num">${current}</span>
                <span class="eamx-usage__suffix">/ ${limit}</span>
              </div>
            </div>
            <div class="eamx-usage__badge eamx-usage__badge--over">${escapeHtml(planLabel)}</div>
          </div>
          <div class="eamx-usage__track" aria-hidden="true">
            <div class="eamx-usage__fill" style="width: 100%"></div>
          </div>
          <div class="eamx-usage__cta">Sube de plan <span class="eamx-usage__cta-arrow">→</span></div>
        </button>
      `;
    }

    const isLow = remaining <= Math.max(1, Math.floor(limit * 0.25));
    const variantClass = isLow ? "eamx-usage--low" : "eamx-usage--ok";
    return `
      <div class="eamx-usage ${variantClass}" title="Tu cuota se reinicia el día 1">
        <div class="eamx-usage__row">
          <div class="eamx-usage__col">
            <div class="eamx-usage__eyebrow">Postulaciones IA</div>
            <div class="eamx-usage__hero">
              <span class="eamx-usage__num">${remaining}</span>
              <span class="eamx-usage__suffix">/ ${limit} este mes</span>
            </div>
          </div>
          <div class="eamx-usage__badge">${escapeHtml(planLabel)}</div>
        </div>
        <div class="eamx-usage__track" aria-hidden="true">
          <div class="eamx-usage__fill" style="width: ${pct}%"></div>
        </div>
      </div>
    `;
  }

  // Build a single <li> for the matches list.
  function renderMatchItem(match, rank, appliedIds) {
    const { jobLite, score, reasons, level } = match;
    const badgeLevel = level || "unknown";
    const safeTitle = escapeHtml(jobLite.title || "(sin título)");
    const safeCompany = escapeHtml(jobLite.company || "(empresa)");
    const safeLoc = jobLite.location ? escapeHtml(jobLite.location) : "";
    const safeUrl = encodeURI(jobLite.url || "#");
    const safeId = escapeHtml(jobLite.id || "");
    // Page-first: trust the card's own marker (appliedFromCard) as well as
    // the persisted queue. (Applied items are normally pulled into their own
    // section now, so this mainly guards any future reuse of renderMatchItem.)
    const isApplied = match.appliedFromCard === true ||
      (appliedIds && appliedIds.has(String(jobLite.id || "")));
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
    // Applied badge — shown when the vacancy is in the queue with
    // status="aplicada". Replaces the ⚡ Postular CTA with a clear
    // "ya postulada" indicator so the user doesn't try to postular
    // twice. (The card itself still opens the vacancy on click for
    // reference / re-check.)
    const appliedBadge = isApplied
      ? `<div class="eamx-match-item__applied">✓ Ya postulada</div>`
      : "";
    const applyAction = isApplied
      ? `<a href="${safeUrl}" target="_blank" rel="noopener" class="eamx-match-item__apply eamx-match-item__apply--applied">Abrir vacante</a>`
      : `<a data-action="quick-apply" href="${safeUrl}" target="_blank" rel="noopener" class="eamx-match-item__apply" data-job-id="${safeId}">⚡ Postular →</a>`;
    // Manual "ya apliqué" link — for vacancies the user applied to OUTSIDE
    // our chain (manually, before the tracker existed, or from another
    // device). Hidden once the item is already marked as applied.
    const manualMarkApplied = isApplied
      ? ""
      : `<button type="button" data-action="mark-applied" data-id="${safeId}" class="eamx-match-item__mark-applied" title="Ya apliqué a esta vacante por mi cuenta">✓ Ya apliqué</button>`;
    const itemClass = isApplied ? "eamx-match-item eamx-match-item--applied" : "eamx-match-item";
    return `
      <li class="${itemClass}">
        <div class="eamx-match-item__rank" aria-hidden="true">${rank}</div>
        <div class="eamx-match-item__body">
          ${appliedBadge}
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
            ${applyAction}
          </div>
          ${manualMarkApplied}
        </div>
      </li>
    `;
  }

  // Compact row for the "Ya postuladas" section. Display-only: no Marcar /
  // Postular buttons (so it needs nothing from matchesCurrentTopN), just the
  // score, title, company and a plain "Abrir vacante" link for reference.
  function renderAppliedItem(match) {
    const { jobLite, score, level } = match;
    const badgeLevel = level || "unknown";
    const safeTitle = escapeHtml(jobLite.title || "(sin título)");
    const safeCompany = escapeHtml(jobLite.company || "(empresa)");
    const safeUrl = encodeURI(jobLite.url || "#");
    const scoreStr = Number.isFinite(score) ? `${score}%` : "—";
    return `
      <li class="eamx-matches-applied__item">
        <span class="eamx-matches-applied__score eamx-match-item__score--${badgeLevel}">${scoreStr}</span>
        <span class="eamx-matches-applied__text">
          <span class="eamx-matches-applied__title">${safeTitle}</span>
          <span class="eamx-matches-applied__company">${safeCompany}</span>
        </span>
        <a href="${safeUrl}" target="_blank" rel="noopener" class="eamx-matches-applied__open" title="Abrir vacante en LaPieza">Abrir ↗</a>
      </li>
    `;
  }

  // Manual "✓ Ya apliqué" click — for vacancies the user applied to
  // outside our chain. Upserts into the queue with status="aplicada"
  // and re-renders the matches panel so the card flips to the dimmed
  // "ya postulada" state immediately. Idempotent — clicking again on
  // a card already marked is a no-op (upsertApplied handles it).
  async function onMatchesManualMarkApplied(btn, id) {
    if (!btn || !id) return;
    const match = matchesCurrentTopN.find((m) => m.jobLite.id === id);
    if (!match) {
      // Card data isn't in our top-N cache (e.g. panel was scrolled past
      // the entry). Fall back to a minimal upsert with just id/source/url
      // — the queue accepts that, just won't have title/company.
      try {
        const url = (btn.parentElement?.querySelector("a[data-action='quick-apply']") || {}).href || "";
        await ensureDiscoveryDeps();
        if (queueModule && typeof queueModule.upsertApplied === "function") {
          await queueModule.upsertApplied({
            id,
            source: SOURCE,
            url,
            title: "",
            company: "",
            savedAt: Date.now(),
            matchScore: 0,
            reasons: ["Marcada manualmente como postulada"]
          });
        }
      } catch (_) { /* swallow */ }
    } else {
      const { jobLite, score, reasons } = match;
      try {
        await ensureDiscoveryDeps();
        if (queueModule && typeof queueModule.upsertApplied === "function") {
          await queueModule.upsertApplied({
            id: jobLite.id,
            source: SOURCE,
            url: jobLite.url || "",
            title: jobLite.title || "",
            company: jobLite.company || "",
            location: jobLite.location || "",
            savedAt: Date.now(),
            matchScore: Number.isFinite(score) ? score : 0,
            reasons: Array.isArray(reasons) ? reasons.slice(0, 3) : ["Marcada manualmente"]
          });
        }
      } catch (_) { /* swallow */ }
    }
    // Re-render the panel content so the freshly-applied card flips
    // visually (badge + dimmed + Abrir vacante button). chrome.storage
    // .onChanged would also trigger a refresh on most platforms but the
    // explicit render here avoids a perceptible delay.
    try { renderMatchesPanelContent(); } catch (_) {}
    toast("✓ Marcada como postulada. No la verás como activa.", "success", { durationMs: 3000 });
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

  // Bulk action: open top N matches in their own tabs and trigger the
  // chain on each. We DO open N tabs programmatically here — explicitly
  // gated by the user's click on a labelled "abre N pestañas" button so
  // the surprise factor is zero. Stagger opens by 6s so chains don't
  // pile up on the backend and so each new vacancy page has time to
  // load + load profile before its chain fires.
  //
  // Each tab uses the existing quickapply session flag (set per
  // jobId, consumed by maybeAutoPrewarmFromQuickApply) — same path as
  // a single ⚡ Postular click.
  // Reads the currently-active N from the chip row in the bulk section.
  // Falls back to 5 if no chip is active (defensive — the renderer
  // always marks one chip as --active so this should be unreachable).
  function readSelectedBulkN() {
    try {
      const activeChip = matchesPanelEl?.querySelector(".eamx-bulk__chip--active");
      if (activeChip) {
        const n = Number(activeChip.getAttribute("data-bulk-n"));
        if (Number.isFinite(n) && n > 0) return n;
      }
    } catch (_) {}
    return 5;
  }

  // Chip click handler. Updates aria-pressed, --active class, the
  // <span data-bulk-count> placeholders in the action buttons, and
  // persists the choice keyed per-plan.
  async function onMatchesBulkSelectN(chipBtn) {
    if (!chipBtn) return;
    const n = Number(chipBtn.getAttribute("data-bulk-n"));
    if (!Number.isFinite(n) || n <= 0) return;

    // Update chip group visual state.
    try {
      const allChips = matchesPanelEl?.querySelectorAll(".eamx-bulk__chip") || [];
      allChips.forEach((c) => {
        const isActive = c === chipBtn;
        c.classList.toggle("eamx-bulk__chip--active", isActive);
        c.setAttribute("aria-pressed", isActive ? "true" : "false");
      });
      // Patch all data-bulk-count placeholders (one in each button).
      const counters = matchesPanelEl?.querySelectorAll("[data-bulk-count]") || [];
      counters.forEach((el) => { el.textContent = String(n); });
    } catch (_) {}

    // Persist per-plan so reopening remembers it. We need the plan to
    // key; re-ping auth status to be sure (cheap and cached).
    try {
      const auth = await sendMsg({ type: MSG.GET_AUTH_STATUS });
      const plan = (auth && auth.user && auth.user.plan) || "free";
      chrome.storage.local.set({ [`eamx:bulk-n:${plan}`]: n });
    } catch (_) { /* persistence is best-effort */ }
  }

  // Apply the values currently typed into the filters drawer. Reads
  // the modality chip + city + salary inputs, builds a preferences
  // object, writes to chrome.storage.local. The existing storage
  // .onChanged listener picks it up and re-renders the whole panel —
  // so we don't need to manually call renderMatchesPanelContent here.
  async function onMatchesFiltersApply() {
    const drawer = matchesPanelEl?.querySelector("[data-eamx-filters]");
    if (!drawer) return;
    // Modality from the active chip.
    const activeChip = drawer.querySelector(".eamx-filters__chip--active");
    const modality = activeChip ? activeChip.getAttribute("data-modality") : "any";
    // City + salary from inputs.
    const cityInput = drawer.querySelector('[data-filter-field="city"]');
    const minInput = drawer.querySelector('[data-filter-field="salaryMin"]');
    const maxInput = drawer.querySelector('[data-filter-field="salaryMax"]');
    const city = cityInput ? cityInput.value.trim() : "";
    const salaryMin = minInput && minInput.value !== "" ? Number(minInput.value) : null;
    const salaryMax = maxInput && maxInput.value !== "" ? Number(maxInput.value) : null;

    // Build the preferences object. Mirror the shape used by Options:
    // null/undefined for unset fields, "any" for modality default.
    // Preserve any existing fields we don't surface (forward-compat).
    const prev = (cachedPreferences && typeof cachedPreferences === "object") ? cachedPreferences : {};
    const next = {
      ...prev,
      modality: modality || "any",
      city: city || null,
      salaryMin: Number.isFinite(salaryMin) ? salaryMin : null,
      salaryMax: Number.isFinite(salaryMax) ? salaryMax : null,
      updatedAt: new Date().toISOString()
    };

    try {
      await new Promise((resolve, reject) => {
        try {
          chrome.storage.local.set({ [PREFERENCES_STORAGE_KEY]: next }, () => {
            const err = chrome.runtime.lastError;
            if (err) reject(err); else resolve();
          });
        } catch (e) { reject(e); }
      });
      toast("Filtros aplicados — re-ordenando matches.", "success", { durationMs: 2500 });
    } catch (e) {
      console.warn("[EmpleoAutomatico] filters-apply failed", e);
      toast("No se pudieron guardar los filtros.", "error");
    }
  }

  // Reset all panel filters back to "any" / blank / null. Writes the
  // cleared preference object and lets the storage listener re-render.
  async function onMatchesFiltersClear() {
    const cleared = {
      modality: "any",
      city: null,
      salaryMin: null,
      salaryMax: null,
      updatedAt: new Date().toISOString()
    };
    try {
      await new Promise((resolve, reject) => {
        try {
          chrome.storage.local.set({ [PREFERENCES_STORAGE_KEY]: cleared }, () => {
            const err = chrome.runtime.lastError;
            if (err) reject(err); else resolve();
          });
        } catch (e) { reject(e); }
      });
      toast("Filtros limpiados.", "info", { durationMs: 2500 });
    } catch (e) {
      console.warn("[EmpleoAutomatico] filters-clear failed", e);
      toast("No se pudieron limpiar los filtros.", "error");
    }
  }

  async function onMatchesBulkApplyTop(bulkBtn) {
    if (!bulkBtn) return;
    // Honor the user's chip selection instead of hardcoding 5. Falls
    // back to 5 if no chip is active (shouldn't happen — renderer
    // always marks one --active).
    const N = readSelectedBulkN();
    // Dynamic stagger: 6s is fine for N=3-5, but at N=10+ the user
    // waits a full minute before the last tab even opens. Scale down
    // when N is bigger so the bulk run feels responsive while keeping
    // per-tab pacing healthy for LaPieza's backend.
    //   N ≤ 5  → 6s (original pacing)
    //   N = 6-10 → 4s
    //   N > 10 → 3s (Premium territory)
    const STAGGER_MS = N <= 5 ? 6000 : N <= 10 ? 4000 : 3000;

    // Skip vacancies the user has already applied to. The "applied"
    // queue is populated by:
    //   - chain auto-tracker when the user clicks Finalizar
    //   - manual "✓ Ya apliqué" link in the matches panel
    //   - past chains that successfully finalized
    // User explicit ask: "si ya esta marcado como que se postulo que
    // no se marque para autopostular no?" — don't waste a quota unit
    // re-applying to a vacancy that's already been submitted.
    let appliedIds = new Set();
    try {
      await ensureDiscoveryDeps();
      if (queueModule && typeof queueModule.appliedIdsForSource === "function") {
        appliedIds = await queueModule.appliedIdsForSource(SOURCE);
      }
    } catch (_) { /* ignore — fall back to no filtering */ }

    const candidates = (matchesCurrentTopN || [])
      .filter((m) => m && m.jobLite && m.jobLite.url)
      // Persisted-queue filter
      .filter((m) => !appliedIds.has(String(m.jobLite.id)))
      // In-memory flag filter: the auto-marker from
      // renderMatchesPanelContent upserts to queueModule
      // fire-and-forget; if the user clicks Auto-postular before that
      // write lands, the persisted set might not include these IDs
      // yet. Filtering on the flag avoids re-applying to a vacancy
      // detected this same session.
      .filter((m) => !m.appliedFromCard)
      // Closed-from-listing flag: should never reach here because
      // scored already drops them, but defend in case some path
      // bypasses that (e.g. manual injection into matchesCurrentTopN).
      .filter((m) => !m.closedFromCard);
    const skipped = (matchesCurrentTopN || []).length - candidates.length;

    // DAILY CAP GATE — two layers of green-zone protection:
    //   1) PER-PORTAL: LinkedIn/Indeed 15, LaPieza/OCC/CT/Bumeran 20
    //   2) CROSS-PORTAL TOTAL: 110/day across all 6 portals combined
    // Layer 2 prevents a power-user from spreading across portals and
    // hitting 120+ applications in a day (which trips "too human"
    // bot-detection on several platforms). The effective limit is
    // min(perPortalRemaining, totalRemaining).
    const dailyCap = AUTO_PORTAL_CAPS[SOURCE] ?? 20;
    const totalCap = AUTO_TOTAL_CAP;
    let dailyCount = 0;
    let totalCount = 0;
    try {
      if (queueModule) {
        if (typeof queueModule.countAppliedTodayForSource === "function") {
          dailyCount = await queueModule.countAppliedTodayForSource(SOURCE);
        }
        if (typeof queueModule.countAppliedTodayAcrossSources === "function") {
          totalCount = await queueModule.countAppliedTodayAcrossSources();
        }
      }
    } catch (_) {}
    const perPortalRemaining = Math.max(0, dailyCap - dailyCount);
    const totalRemaining = Math.max(0, totalCap - totalCount);
    const dailyRemaining = Math.min(perPortalRemaining, totalRemaining);

    if (dailyRemaining === 0) {
      // Distinguish WHICH cap was hit so the user gets the right message.
      if (perPortalRemaining === 0) {
        toast(
          `Llegaste al cap diario seguro en este portal (${dailyCap}). Vuelve mañana para no arriesgar tu cuenta.`,
          "info",
          { durationMs: 9000 }
        );
      } else {
        toast(
          `Llegaste al cap diario seguro entre todos los portales (${totalCap}). Vuelve mañana — protege tu cuenta de detección de bot.`,
          "info",
          { durationMs: 9000 }
        );
      }
      return;
    }

    let topN = candidates.slice(0, N);
    if (topN.length > dailyRemaining) {
      const trimmed = topN.length - dailyRemaining;
      topN = topN.slice(0, dailyRemaining);
      // Report which cap is the binding one so the user understands.
      const reason = perPortalRemaining <= totalRemaining
        ? `del cap diario seguro de ${dailyCap} en este portal`
        : `del cap diario total seguro de ${totalCap} entre portales`;
      toast(
        `Limitando a ${dailyRemaining} para no exceder ${reason}. ${trimmed} vacante${trimmed > 1 ? "s" : ""} se quedan para mañana.`,
        "info",
        { durationMs: 7000 }
      );
    }

    if (!topN.length) {
      const msg = skipped > 0
        ? `Todas las del top ya están postuladas (${skipped} vacantes). Espera el siguiente scan o amplía búsqueda.`
        : "No hay vacantes para postular.";
      toast(msg, "info", { durationMs: 5000 });
      return;
    }
    if (skipped > 0) {
      toast(`Saltando ${skipped} ya postuladas, abriendo las siguientes ${topN.length}.`, "info", { durationMs: 4000 });
    }

    // Pre-flight: refuse to open N background tabs if the user already
    // exhausted their monthly quota. Without this check, each tab would
    // fire the chain, hit PLAN_LIMIT_EXCEEDED on the first AI call, and
    // leave the user with a progress card stuck on "running" (the child
    // tabs don't notify the parent) — exactly the bug user reported:
    // "salio medio bug si no tienes ya creditos lo mismo cuando le dio
    // en autopostulacion". GET_AUTH_STATUS returns { usage:{ current,
    // limit } } where limit === -1 means "ilimitado" (Premium).
    try {
      const auth = await sendMsg({ type: MSG.GET_AUTH_STATUS });
      if (auth && auth.ok && auth.loggedIn && auth.usage) {
        const limit = Number(auth.usage.limit);
        const current = Number(auth.usage.current) || 0;
        // -1 = unlimited (Premium). Skip the gate.
        if (limit !== -1 && Number.isFinite(limit) && current >= limit) {
          // Pretty plan-limit modal instead of a plain toast — user
          // explicitly asked for this UX: "que salga bonito que ya no
          // tiene y estaria cool que puedas comprar creditos extra".
          await showPlanLimitModal({
            feature: "postulaciones IA",
            usage: { current, limit },
            planName: (auth.user && auth.user.plan) || ""
          });
          return;
        }
        // Warn but don't block if remaining < requested N (e.g. user
        // has 2 left and we're about to fire 5 chains — they should
        // know only the first 2 will succeed before tabs get opened).
        if (limit !== -1 && Number.isFinite(limit)) {
          const remaining = limit - current;
          if (remaining < topN.length) {
            toast(
              `Te quedan ${remaining}/${limit} este mes — solo las primeras ${remaining} podrán generar carta/CV.`,
              "info",
              { durationMs: 8000 }
            );
          }
        }
      } else if (auth && auth.ok && !auth.loggedIn) {
        toast("Inicia sesión para auto-postular.", "error", {
          label: "Iniciar sesión",
          onClick: () => openOptionsPage(),
          durationMs: 8000
        });
        return;
      }
      // If auth ping itself failed (network, stale), proceed anyway —
      // each tab will surface its own error if it really hits the limit.
    } catch (_) { /* network blip — proceed */ }

    // Inline progress card inside the matches panel — user sees live
    // status of each vacancy in the bulk run without leaving this tab.
    // Persists across the stagger loop AND across the open tabs by
    // listening on chrome.storage.session for per-tab status updates.
    const progressHost = renderBulkProgressCard(topN);

    bulkBtn.disabled = true;
    const original = bulkBtn.innerHTML;
    bulkBtn.innerHTML = `⏳ Lanzando ${topN.length}…`;

    let opened = 0;
    for (let i = 0; i < topN.length; i++) {
      const m = topN[i];
      const jobId = m.jobLite.id;
      const url = m.jobLite.url;
      // Mark this slot as "abriendo" in the progress card.
      updateBulkProgressItem(progressHost, jobId, "opening", "Abriendo pestaña…");
      // Set TWO session flags for this vacancy:
      //   - eamx:quickapply:<id> → triggers the chain on tab load
      //   - eamx:bulk-mode:<id>  → tells the chain to auto-click
      //     Finalizar at the end (user explicit ask: "y que si se de
      //     finalizar si es auto postular literal"). The chain reads
      //     this at startup and clears it when done. Without this
      //     flag the chain stays HITL (stops at ✓ Listo).
      if (jobId && chrome?.storage?.session) {
        try {
          await new Promise((resolve) => {
            try {
              chrome.storage.session.set(
                {
                  [`eamx:quickapply:${jobId}`]: { setAt: Date.now() },
                  [`eamx:bulk-mode:${jobId}`]: { setAt: Date.now() }
                },
                () => resolve()
              );
            } catch (_) { resolve(); }
          });
        } catch (_) {}
      }
      // Open the tab via the background service worker so it lands as
      // active:false (background). Keeps the user anchored in the
      // matches panel watching the progress card instead of getting
      // 5 tabs slammed in their face.
      let openedTabId = null;
      try {
        const res = await sendMsg({ type: MSG.OPEN_BACKGROUND_TAB, url });
        if (res && res.ok && res.tabId != null) {
          openedTabId = res.tabId;
          opened++;
          updateBulkProgressItem(progressHost, jobId, "running", "Postulando…", openedTabId);
        } else {
          console.warn("[EmpleoAutomatico] bulk open failed (msg)", res);
          updateBulkProgressItem(progressHost, jobId, "error", (res && res.message) || "No se pudo abrir");
        }
      } catch (err) {
        console.warn("[EmpleoAutomatico] bulk open failed (throw)", err);
        updateBulkProgressItem(progressHost, jobId, "error", "No se pudo abrir");
      }
      bulkBtn.innerHTML = `⏳ ${opened}/${topN.length} en curso…`;
      // Stagger so we don't pile up.
      if (i < topN.length - 1) {
        await new Promise((r) => setTimeout(r, STAGGER_MS));
      }
    }

    bulkBtn.disabled = false;
    bulkBtn.innerHTML = original;
    toast(
      `✓ ${opened} cadenas corriendo en segundo plano. Dale "Ver pestaña" en cada fila para Finalizar.`,
      "success",
      { durationMs: 7000 }
    );
  }

  // Render the inline progress card under the bulk buttons. Returns the
  // host element so subsequent updateBulkProgressItem calls can patch
  // individual rows without re-rendering the whole thing.
  function renderBulkProgressCard(topN) {
    // Remove any prior card (if user clicked bulk twice).
    try { matchesPanelEl?.querySelector("[data-eamx-bulk-progress]")?.remove(); } catch (_) {}
    const host = document.createElement("div");
    host.className = "eamx-bulk-progress";
    host.setAttribute("data-eamx-bulk-progress", "");
    host.innerHTML = `
      <div class="eamx-bulk-progress__head">
        <span class="eamx-bulk-progress__title">⚡ Postulando ${topN.length} vacantes</span>
        <span class="eamx-bulk-progress__hint">Cada una abre en su pestaña — dale "Ver" para revisar y Finalizar</span>
      </div>
      <ul class="eamx-bulk-progress__list">
        ${topN.map((m, i) => `
          <li class="eamx-bulk-progress__item eamx-bulk-progress__item--waiting" data-bulk-item="${escapeHtml(m.jobLite.id)}">
            <div class="eamx-bulk-progress__row">
              <span class="eamx-bulk-progress__num">${i + 1}</span>
              <div class="eamx-bulk-progress__body">
                <div class="eamx-bulk-progress__job" title="${escapeHtml(m.jobLite.title || "")}">${escapeHtml(m.jobLite.title || "(sin título)")}</div>
                <div class="eamx-bulk-progress__company">${escapeHtml(m.jobLite.company || "")}</div>
              </div>
              <div class="eamx-bulk-progress__action" data-bulk-action></div>
            </div>
            <div class="eamx-bulk-progress__status" data-bulk-status>
              <span class="eamx-bulk-progress__status-dot" aria-hidden="true"></span>
              <span class="eamx-bulk-progress__status-text">En espera</span>
            </div>
          </li>
        `).join("")}
      </ul>
    `;
    // Insert at the top of the content area so it's visible above the
    // best-matches list.
    const content = matchesPanelEl?.querySelector("[data-eamx-matches-content]");
    if (content && content.parentElement) {
      content.parentElement.insertBefore(host, content);
    } else if (matchesPanelEl) {
      matchesPanelEl.appendChild(host);
    }
    // Wire the cross-tab status listener so child apply tabs can report
    // their per-step progress (chain reaches CV step, generating carta,
    // etc.). The listener stays attached for the panel's lifetime; it's
    // cleaned up when the panel is removed.
    attachBulkProgressStatusListener(host);
    return host;
  }

  // Human-readable labels for the chain steps. Keeps the user out of
  // tech-speak ("Cadena corriendo en background" was confusing — see
  // user feedback "nada tecnico"). New child tabs report their current
  // step by writing to chrome.storage.session and the parent panel
  // looks the label up here.
  const BULK_STATUS_LABELS = {
    opening: "Abriendo pestaña…",
    loading: "Cargando vacante…",
    starting: "Preparando postulación…",
    cv: "Personalizando tu CV…",
    cover: "Generando carta con IA…",
    questions: "Respondiendo preguntas…",
    quiz: "Resolviendo quiz…",
    // "finalizing" is the countdown state in bulk mode — visually
    // running (spinning dot), not ready-green, because the submit
    // hasn't happened yet. The label is overridden each second with
    // "Auto-finalizando en Ns…".
    finalizing: "Enviando postulación…",
    ready: "✓ Listo — dale Finalizar",
    submitted: "✓ Postulación enviada",
    // Terminal states that aren't errors per se, but the chain can't
    // proceed and the user should know WHY (not just "Postulando…"
    // forever). User reported: "el de generando ya habia postulado
    // porque no salio QUE YA ACABO" + "los otros ya habia postulado
    // o estaba cerrado y se quedo ahi".
    already_applied: "✓ Ya postulaste antes — saltada",
    closed: "Vacante no disponible (cerrada)",
    no_form: "Sin formulario — revisa la pestaña",
    error: "Algo falló — revisa la pestaña",
    plan_limit: "Sin cuota del plan",
    waiting: "En espera"
  };

  function bulkStatusLabel(stepKey, fallback) {
    if (stepKey && BULK_STATUS_LABELS[stepKey]) return BULK_STATUS_LABELS[stepKey];
    return fallback || "Procesando…";
  }

  // Listen for status updates posted by child apply tabs. Each chain
  // step writes { step, label?, at } to chrome.storage.session under
  // key "eamx:bulk-status:<jobId>". We patch the matching row in the
  // progress card. Idempotent — adding the same listener twice is
  // harmless because we de-dupe via a host-scoped flag.
  let bulkProgressStorageListener = null;
  function attachBulkProgressStatusListener(host) {
    if (!host) return;
    if (host.dataset.statusListenerAttached === "1") return;
    host.dataset.statusListenerAttached = "1";

    // Detach any previous listener (panel re-renders) before adding a
    // fresh one so we don't pile up duplicates leaking memory.
    if (bulkProgressStorageListener) {
      try { chrome.storage.onChanged.removeListener(bulkProgressStorageListener); } catch (_) {}
      bulkProgressStorageListener = null;
    }

    bulkProgressStorageListener = (changes, area) => {
      if (area !== "session") return;
      Object.keys(changes).forEach((key) => {
        if (!key.startsWith("eamx:bulk-status:")) return;
        const jobId = key.slice("eamx:bulk-status:".length);
        const next = changes[key].newValue;
        if (!next || typeof next !== "object") return;
        // Map step → human label. If the child writes an explicit
        // label (custom messages, like the auto-finalize countdown),
        // use that instead of the canned text.
        const text = next.label || bulkStatusLabel(next.step, "Procesando…");
        // Promote step to the visual variant.
        //   ready            → "ready" (green check, idle)
        //   submitted        → "done"  (green check, finished)
        //   already_applied  → "done"  (already done, treat as success)
        //   error / plan_limit / closed / no_form → "error" (red)
        //   anything else (cv/cover/quiz/finalizing/…) → "running"
        //                      (spinning teal dot)
        let variant = "running";
        if (next.step === "ready") variant = "ready";
        else if (next.step === "submitted" || next.step === "already_applied") variant = "done";
        else if (next.step === "error" || next.step === "plan_limit"
              || next.step === "closed" || next.step === "no_form") variant = "error";
        updateBulkProgressItem(host, jobId, variant, text, next.tabId);
      });
    };
    try { chrome.storage.onChanged.addListener(bulkProgressStorageListener); } catch (_) {}
  }

  // Patch a single row in the bulk progress card.
  // status: "opening" | "running" | "ready" | "done" | "error" | "waiting"
  // tabId (optional): when provided, the "Ver pestaña →" jump button is
  // injected/kept in the action slot. The status text lives on its own
  // line below the title/company so it has full width — fixes the bug
  // where "Cadena corriendo en background" + "Ver pestaña" both fought
  // for the same narrow column and the button got clipped.
  function updateBulkProgressItem(host, jobId, status, text, tabId) {
    if (!host || !jobId) return;
    let row;
    try { row = host.querySelector(`[data-bulk-item="${CSS.escape(jobId)}"]`); } catch (_) {}
    if (!row) return;

    const statusEl = row.querySelector("[data-bulk-status]");
    if (statusEl) {
      const dotClass = status === "ready" || status === "done" ? "eamx-bulk-progress__status-dot--ok"
                     : status === "error" ? "eamx-bulk-progress__status-dot--err"
                     : status === "running" || status === "opening" ? "eamx-bulk-progress__status-dot--spin"
                     : "";
      statusEl.innerHTML = `
        <span class="eamx-bulk-progress__status-dot ${dotClass}" aria-hidden="true"></span>
        <span class="eamx-bulk-progress__status-text">${escapeHtml(text || "")}</span>
      `;
    }

    // "Ver pestaña →" button — only when we have a tabId AND the row is
    // still in-flight (not error). We persist the button if it was
    // already set on a prior update with a tabId, so the user can keep
    // jumping back even after the row reaches "ready".
    const actionEl = row.querySelector("[data-bulk-action]");
    if (actionEl) {
      const existingTabId = Number(actionEl.getAttribute("data-tab-id"));
      const effectiveTabId = Number.isFinite(tabId) ? tabId : (Number.isFinite(existingTabId) ? existingTabId : null);
      if (effectiveTabId != null && status !== "error" && status !== "done") {
        actionEl.setAttribute("data-tab-id", String(effectiveTabId));
        actionEl.innerHTML = `<button type="button" class="eamx-bulk-progress__jump" data-action="focus-tab" data-tab-id="${effectiveTabId}">Ver →</button>`;
      } else if (status === "done") {
        actionEl.innerHTML = `<span class="eamx-bulk-progress__done">✓</span>`;
      } else if (status === "error") {
        actionEl.innerHTML = effectiveTabId != null
          ? `<button type="button" class="eamx-bulk-progress__jump eamx-bulk-progress__jump--err" data-action="focus-tab" data-tab-id="${effectiveTabId}">Revisar →</button>`
          : `<span class="eamx-bulk-progress__err">✗</span>`;
      }
    }

    row.classList.remove(
      "eamx-bulk-progress__item--waiting",
      "eamx-bulk-progress__item--opening",
      "eamx-bulk-progress__item--running",
      "eamx-bulk-progress__item--ready",
      "eamx-bulk-progress__item--done",
      "eamx-bulk-progress__item--error"
    );
    row.classList.add(`eamx-bulk-progress__item--${status}`);
  }

  // Bulk action: add the top 5 to the queue. Reports partial success.
  async function onMatchesMarkTop5(bulkBtn) {
    if (!bulkBtn) return;
    const ok = await ensureDiscoveryDeps();
    if (!ok || !queueModule) {
      toast("No se pudo abrir la cola.", "error");
      return;
    }
    // Honor the chip-selected N (same selector as bulk-apply-top) —
    // the function is still called onMatchesMarkTop5 for back-compat
    // but the "5" is now whatever the user picked.
    const N = readSelectedBulkN();
    const top5 = matchesCurrentTopN.slice(0, N);
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
      setQuestionsState("error", { error: "Sesión expirada — inicia sesión." });
      quickApplyAborted = true;
      reportBulkStatus("error", { label: "Sesión expirada — inicia sesión" });
      clearBulkModeFlag();
      toast("Sesión expirada. Inicia sesión para continuar.", "error", {
        label: "Inicia sesión",
        onClick: () => openOptionsPage()
      });
      return;
    }
    if (code === ERR.PLAN_LIMIT_EXCEEDED) {
      setQuestionsState("error", { error: "Llegaste al límite de respuestas IA de tu plan este mes." });
      // If we're in a chain, abort it — otherwise the next iter would
      // walk straight back into another AI call and hit the limit
      // again. Safe to set unconditionally; harmless outside a chain.
      quickApplyAborted = true;
      // Pretty modal — user clicked "Generar respuestas" or hit the
      // ✨ Respuesta con IA button, so they're actively in the loop.
      showPlanLimitModal({ feature: "respuestas IA" });
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
    // Sync the floating "✨ Respuesta con IA" button (if any) for this
    // field — auto-paste from the chain / observer should also visually
    // confirm on the button, so the user sees "✓ Respuesta IA pegada"
    // immediately instead of the initial "Respuesta con IA" label.
    try {
      const ref = q.fieldRef;
      const btn = document.querySelector(`.eamx-flow-paste-btn[data-eamx-ai-q-btn-for="${CSS.escape(ref)}"]`);
      if (btn) {
        btn.classList.remove("eamx-flow-paste-btn--loading", "eamx-flow-paste-btn--err");
        btn.classList.add("eamx-flow-paste-btn--ok");
        btn.innerHTML = '<span aria-hidden="true">✓</span><span>Respuesta IA · Regenerar</span>';
        btn.disabled = false;
      }
    } catch (_) { /* best-effort sync */ }
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
          setCvState("error", { error: "Llegaste al límite de CVs personalizados de tu plan este mes." });
          // Pretty modal — user clicked "Generar CV personalizado" so
          // they're actively in the loop. Modal explains usage + offers
          // upgrade and credit-pack paths.
          showPlanLimitModal({ feature: "CVs personalizados" });
          return;
        }
        if (code === ERR.UNAUTHORIZED) {
          setCvState("error", { error: "Tu sesión expiró. Inicia sesión en Opciones para continuar." });
          quickApplyAborted = true;
          reportBulkStatus("error", { label: "Sesión expirada — inicia sesión" });
          clearBulkModeFlag();
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
      toast("Listo — revisa y da clic a 'Enviar' cuando estés conforme." + tail, "success");
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
    console.error(
      `[EmpleoAutomatico] backend failure — code=${code || "(none)"} message="${message}"`,
      res
    );
    if (code === ERR.PLAN_LIMIT_EXCEEDED) {
      // Pretty modal — generic backend-failure path also used by the
      // panel "Generar carta" button which is a user-initiated click.
      showPlanLimitModal({ feature: "cartas IA" });
      return;
    }
    if (code === ERR.EMAIL_NOT_VERIFIED) {
      toast(
        "Tu correo no está verificado. Confírmalo (revisa tu bandeja y spam) para generar cartas.",
        "error",
        {
          durationMs: 20000,
          sticky: true,
          label: "Abrir mi cuenta",
          onClick: () => {
            try { window.open("https://empleo.skybrandmx.com/account", "_blank", "noopener"); } catch (_) {}
          }
        }
      );
      return;
    }
    if (code === ERR.UNAUTHORIZED) {
      toast("Tu sesión expiró.", "error", {
        label: "Inicia sesión",
        onClick: () => openOptionsPage()
      });
      return;
    }
    toast(message, "error", { durationMs: 10000 });
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
      // Fast-fail when the runtime is gone (Chrome updated/reloaded
      // the extension after this content script loaded). Without this
      // check the sendMessage call throws synchronously and the
      // catch wraps it as a generic error.
      if (!chrome?.runtime?.id) {
        try { maybeShowContextLostBanner(); } catch (_) {}
        return reject(new Error("Extension context invalidated"));
      }
      try {
        chrome.runtime.sendMessage(msg, (response) => {
          const err = chrome.runtime.lastError;
          if (err) {
            // If the error indicates the extension context is gone,
            // surface the recovery banner. The user otherwise gets a
            // toast that disappears in a few seconds with no clear
            // remediation.
            const m = err.message || "";
            if (/context\s+invalidated|extension\s+context|disconnected\s+port/i.test(m)) {
              try { maybeShowContextLostBanner(); } catch (_) {}
            }
            return reject(new Error(m || "runtime error"));
          }
          resolve(response);
        });
      } catch (err) {
        // Synchronous throws also indicate a dead context most of the
        // time ("chrome.runtime is undefined" / "Extension context
        // invalidated").
        const m = (err && err.message) || String(err);
        if (/context\s+invalidated|chrome\.runtime|extension\s+context/i.test(m)) {
          try { maybeShowContextLostBanner(); } catch (_) {}
        }
        reject(err);
      }
    });
  }

  // Persistent top-of-page banner shown when the extension context is
  // gone — Chrome auto-updated or the user reloaded the extension in
  // chrome://extensions while this tab was open. Without a fresh page
  // load NOTHING in the extension can work (sendMessage throws, the
  // FAB can't reach the SW, etc.). User reported: a vacancy listing
  // where the matches panel never opened — DevTools confirmed it was
  // exactly this state.
  //
  // Idempotent: only one banner ever in the DOM. Click "Recargar
  // ahora" calls location.reload().
  let extensionContextLostBannerShown = false;
  function maybeShowContextLostBanner() {
    if (extensionContextLostBannerShown) return;
    if (document.querySelector("[data-eamx-context-lost]")) {
      extensionContextLostBannerShown = true;
      return;
    }
    extensionContextLostBannerShown = true;
    try {
      const banner = document.createElement("div");
      banner.setAttribute("data-eamx-context-lost", "");
      banner.className = "eamx-context-lost";
      banner.innerHTML = `
        <div class="eamx-context-lost__inner">
          <span class="eamx-context-lost__icon" aria-hidden="true">⚠</span>
          <div class="eamx-context-lost__body">
            <div class="eamx-context-lost__title">La extensión se actualizó</div>
            <div class="eamx-context-lost__sub">Recarga esta página para volver a usar Empleo Automático.</div>
          </div>
          <button type="button" class="eamx-context-lost__btn" data-eamx-context-reload>Recargar ahora</button>
        </div>
      `;
      banner.addEventListener("click", (ev) => {
        if (ev.target && (ev.target).closest("[data-eamx-context-reload]")) {
          try { location.reload(); } catch (_) {}
        }
      });
      document.documentElement.appendChild(banner);
    } catch (_) { /* if even DOM access fails the page is doomed anyway */ }
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

    // Even if the question set is unchanged, ensure every detected
    // textarea has a visible "✨ Respuesta con IA" button. This makes
    // the AI suggestion discoverable in MANUAL mode (no chain) —
    // user can click the button to generate or regenerate on demand.
    for (const q of scanned) {
      const target = resolveFieldRef(q.fieldRef);
      if (target) attachAiQuestionButton(target, q.fieldRef);
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

  // Inject a floating "✨ Respuesta con IA" button anchored to a
  // detected Q&A textarea. State machine:
  //   - initial: "✨ Respuesta con IA" — user hasn't generated yet
  //   - fetching: "⏳ Generando…" — backend call in flight
  //   - filled: "✓ Respuesta IA · Regenerar" — answer pasted, click to regen
  //   - error: "✗ Reintentar" — backend / paste failed
  // The button is idempotent per textarea via data-eamx-ai-q-btn attr —
  // each textarea gets ONE button, even if detectAdaptiveQuestions fires
  // many times on the same step (MutationObserver tick spam).
  function attachAiQuestionButton(textarea, fieldRef) {
    if (!textarea || textarea.dataset.eamxAiQBtn) return;
    textarea.dataset.eamxAiQBtn = fieldRef;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "eamx-flow-paste-btn";
    btn.dataset.eamxAiQBtnFor = fieldRef;
    btn.setAttribute("aria-label", "Generar respuesta con IA");
    btn.innerHTML = '<span aria-hidden="true">✨</span><span>Respuesta con IA</span>';
    document.documentElement.appendChild(btn);
    anchorTo(btn, textarea, "above-right");

    // Anchor watcher — when LaPieza re-renders the apply step and
    // unmounts the textarea, this button becomes orphaned but its
    // anchor's window.scroll+resize listeners stay attached. Without
    // cleanup, each SPA step adds 2 leaked listeners. We watch the
    // textarea via MutationObserver on its parent; once it's gone we
    // call removeFlowHelper which fires the __eamxCleanup closure.
    try {
      const parent = textarea.parentElement;
      if (parent) {
        const mo = new MutationObserver(() => {
          if (!document.documentElement.contains(textarea)) {
            try { removeFlowHelper(btn); } catch (_) {}
            try { mo.disconnect(); } catch (_) {}
          }
        });
        mo.observe(parent, { childList: true, subtree: true });
        // Stash the observer on the button so a future explicit
        // removeFlowHelper(btn) also disconnects it.
        const prevCleanup = btn.__eamxCleanup;
        btn.__eamxCleanup = () => {
          try { mo.disconnect(); } catch (_) {}
          try { prevCleanup?.(); } catch (_) {}
        };
      }
    } catch (_) { /* anchor watcher is best-effort */ }

    const setState = (state, label) => {
      btn.classList.remove("eamx-flow-paste-btn--ok", "eamx-flow-paste-btn--err", "eamx-flow-paste-btn--loading");
      if (state === "ok") btn.classList.add("eamx-flow-paste-btn--ok");
      else if (state === "err") btn.classList.add("eamx-flow-paste-btn--err");
      else if (state === "loading") btn.classList.add("eamx-flow-paste-btn--loading");
      btn.innerHTML = label;
      btn.disabled = state === "loading";
    };

    btn.addEventListener("click", async () => {
      // Find the most recent index for this fieldRef in detectedQuestions.
      // SPA re-renders can re-stamp fieldRefs, so we search live.
      const idx = detectedQuestions.findIndex((q) => q.fieldRef === fieldRef);
      const cachedAnswer = idx >= 0 ? questionAnswers[idx] : null;
      const hasCached = !!(cachedAnswer && cachedAnswer.trim());
      // Regenerate vs paste-from-cache: if the button shows "Regenerar"
      // (ok state) we always re-call the backend. If the textarea has
      // value already, also confirm before overwriting.
      const existing = (textarea.value || "").trim();
      if (existing.length > 50) {
        const ok = window.confirm("¿Reemplazar lo que escribiste con la respuesta IA?");
        if (!ok) return;
      }
      setState("loading", '<span aria-hidden="true">⏳</span><span>Generando…</span>');
      try {
        // Always refresh the cache by re-firing the fetch — the form
        // may have advanced to a new question by the time the user
        // clicks this button.
        await fetchAnswersForDetectedQuestions();
        // pasteQuestionAnswer uses the just-fetched answer.
        const newIdx = detectedQuestions.findIndex((q) => q.fieldRef === fieldRef);
        if (newIdx < 0) {
          setState("err", '<span aria-hidden="true">✗</span><span>Pregunta no encontrada</span>');
          return;
        }
        const ok = pasteQuestionAnswer(newIdx);
        if (ok) {
          setState("ok", '<span aria-hidden="true">✓</span><span>Respuesta IA · Regenerar</span>');
        } else {
          setState("err", '<span aria-hidden="true">✗</span><span>Reintentar</span>');
        }
      } catch (err) {
        console.warn("[EmpleoAutomatico] AI question button click failed", err);
        setState("err", '<span aria-hidden="true">✗</span><span>Reintentar</span>');
      }
    });
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
  // Y/N quiz helpers. LaPieza shows knock-out screening questions on
  // technical roles with just two buttons: SI / NO (with diacritical
  // variants and English). User-reported: "1/6 Do you have 3+ years
  // of analyzing and interpreting data with Redshift, Oracle, NoSQL
  // etc. experience? [SI] [NO]" — our multi-select-button detector
  // missed this and the chain looped on Continuar forever.
  const YN_BUTTON_TEXT_RX = /^\s*(s[íi]|si|no|yes)\s*$/i;
  function normalizeYesNoKey(text) {
    const t = text.trim().toLowerCase();
    if (t === "si" || t === "sí" || t === "yes") return "SI";
    if (t === "no") return "NO";
    return null;
  }
  function collectYesNoOptions(root) {
    if (!root) return [];
    const out = [];
    const seen = new Set();
    let buttons = [];
    try { buttons = Array.from(root.querySelectorAll("button")); } catch (_) {}
    for (const btn of buttons) {
      try {
        if (!isVisible(btn)) continue;
        if (btn.disabled) continue;
        if (btn.closest(".eamx-fab, .eamx-panel, .eamx-overlay, .eamx-matches-panel, .eamx-toast, [data-eamx]")) continue;
        const text = (btn.textContent || "").trim();
        if (!text || text.length > 5) continue;
        if (!YN_BUTTON_TEXT_RX.test(text)) continue;
        const key = normalizeYesNoKey(text);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({ key, text: text.toUpperCase(), button: btn });
      } catch (_) { /* skip */ }
    }
    return out;
  }
  // Find the closest ancestor that wraps a question + its Y/N buttons.
  // Heuristic: the buttons' common ancestor that ALSO contains a "?"
  // line. We walk up from the first SI button. If nothing matches we
  // fall back to document.body so the question-text walker can still
  // find the prompt.
  function findYesNoQuizContainer() {
    const ynBtns = collectYesNoOptions(document.body);
    if (ynBtns.length < 2) return null;
    let node = ynBtns[0].button;
    for (let i = 0; i < 8 && node && node.parentElement; i++) {
      node = node.parentElement;
      const txt = (node.textContent || "").trim();
      if (txt.includes("?") && txt.length <= QUIZ_QUESTION_MAX_LEN * 4) return node;
    }
    return document.body;
  }

  function detectQuizQuestion() {
    let container = document.querySelector("div.details__form__preguntas");
    if (!container || !isVisible(container)) {
      // Fallback A: any element with ≥2 visible multi-select buttons.
      const allOptions = Array.from(document.querySelectorAll("button.multi-select-button"))
        .filter(isVisible);
      if (allOptions.length >= 2) {
        container = allOptions[0].parentElement || allOptions[0];
      } else {
        // Fallback B: Y/N quiz pattern — two visible <button> elements
        // whose text is exactly "SI"/"NO"/"SÍ"/"YES"/"NO" (≤ 5 chars).
        // LaPieza ships knock-out screening questions this way for
        // technical roles ("Do you have 3+ years of X? [SI] [NO]").
        // We detect them here so the chain doesn't get stuck on
        // looksLikeQuizStep returning false.
        const ynContainer = findYesNoQuizContainer();
        if (!ynContainer) return null;
        container = ynContainer;
      }
    }

    // Options — try multi-select-button first; if none, fall back to Y/N.
    let options = [];
    const seenKeys = new Set();
    const optionButtons = Array.from(container.querySelectorAll("button.multi-select-button"))
      .filter(isVisible);
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
    if (options.length < 2) {
      // Y/N fallback — same container, look for SI/NO buttons.
      const ynOpts = collectYesNoOptions(container);
      if (ynOpts.length >= 2) {
        options = ynOpts;
      } else {
        return null;
      }
    }

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
    // LENIENT FALLBACK — statement-style questions that DON'T end in "?".
    // LaPieza mixes knowledge questions ("What is SAP SCM?") with screening
    // statements ("Nivel de inglés CONVERSACIONAL", "Años de experiencia con
    // X", "Disponibilidad para viajar"). pickQuestion above requires a "?"
    // so those returned NO question → detectQuizQuestion returned null →
    // the auto-quiz loop treated it as "quiz finished" and STOPPED, leaving
    // the rest of the quiz unanswered (live-test: stalled at Q17/24 on the
    // English-level question). Here we recover by taking the closest
    // qualifying text node that sits just BEFORE the first option — that's
    // the question label, with or without "?".
    if (!question && options.length && options[0].button) {
      const firstOpt = options[0].button;
      const cands = document.querySelectorAll("p, div, span, h1, h2, h3, h4, h5, h6, label");
      for (const el of cands) {
        if (el.children && el.children.length > 0) continue;
        if (el.tagName === "BUTTON") continue;
        const txt = (el.textContent || "").trim();
        if (!txt) continue;
        if (txt.length < QUIZ_QUESTION_MIN_LEN || txt.length > QUIZ_QUESTION_MAX_LEN) continue;
        if (!isVisible(el)) continue;
        if (QUIZ_COUNTER_RX.test(txt)) continue;   // not the "17/24" counter
        if (QUIZ_OPTION_RX.test(txt)) continue;    // not an "A) …" option
        // Must appear BEFORE the first option in DOM order; keep the LAST
        // such match (closest to the options = the actual prompt).
        const pos = el.compareDocumentPosition(firstOpt);
        if (!(pos & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        question = txt;
      }
    }
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
    // FLOW_TIPS_SHOWN persists the per-page "we already told the user" state.
    // Without it, every MutationObserver tick re-fires runAutoQuizLoop, the
    // no-CV / no-job pre-flight bails again, and we re-toast — making the
    // bottom-left toast appear to flicker rapidly. FLOW_TIPS_SHOWN is
    // cleared on SPA URL change (see runFlowDetectors callers), so a new
    // /apply/ visit gets a fresh chance to show the tip.
    // Only "no-cv" is a STICKY bail — it needs the user to act off-page
    // (upload a CV). "no-job" used to be sticky too, which permanently
    // disabled the auto-quiz for the whole /apply/ page if the loop fired
    // before lastJob was restored (LaPieza swaps steps without a URL change,
    // so FLOW_TIPS_SHOWN never got cleared between steps). It's recoverable,
    // so it's no longer in this early-return.
    if (FLOW_TIPS_SHOWN.has("auto-quiz-no-cv")) return;
    const state = detectQuizQuestion();
    if (!state) return;
    // Pre-flight BEFORE setting quizLoopActive so the flag pattern reflects
    // reality: if we never actually entered the loop, quizLoopActive stays
    // false (it was already false).
    if (!lastJob) {
      // RECOVERABLE: the /apply/ nav nulled lastJob; restore the vacancy we
      // cached on /vacante/ and re-try once it lands. Toast only ONCE
      // (dedupe) to avoid flicker, but do NOT permanently block — once the
      // job is restored a re-invocation starts the loop.
      if (!FLOW_TIPS_SHOWN.has("auto-quiz-no-job")) {
        FLOW_TIPS_SHOWN.add("auto-quiz-no-job");
        toast("Auto-quiz: leyendo la vacante…", "info", { durationMs: 3000 });
      }
      restoreJobFromSession()
        .then((j) => {
          if (j && !lastJob) {
            lastJob = j;
            try { maybeStartAutoQuizLoop(); } catch (_) {}
          }
        })
        .catch(() => {});
      return;
    }
    if (!cachedProfile) {
      FLOW_TIPS_SHOWN.add("auto-quiz-no-cv");
      // Actionable toast: opens the welcome page (drag-drop CV uploader)
      // via the background service worker. Live test caught Chrome blocking
      // window.open("chrome-extension://.../welcome.html") with
      // ERR_BLOCKED_BY_CLIENT — content scripts can't open extension URLs
      // directly. Messaging the background is the supported path.
      toast("Falta tu CV — súbelo en 30 segundos para que el auto-quiz funcione.", "info", {
        label: "Subir CV",
        onClick: () => {
          try {
            chrome.runtime.sendMessage({ type: MSG.OPEN_WELCOME });
          } catch (_) { /* ignore */ }
        },
        durationMs: 10000
      });
      return;
    }
    // We have a quiz and the pre-flight passed. Fire the loop.
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
  // Caller contract: maybeStartAutoQuizLoop guarantees lastJob +
  // cachedProfile are set before invoking. The defensive bails below are
  // kept as a safety net for any future direct caller but no longer fire
  // the user-facing toast (caller owns that to avoid the flicker bug
  // where every observer tick re-fired the no-CV toast — fixed in
  // maybeStartAutoQuizLoop via FLOW_TIPS_SHOWN dedupe).
  // Detect a free-text field that's BLOCKING the apply flow but that we
  // intentionally don't auto-fill (salary/expectativa — see
  // QUESTION_SKIP_RX). Returns {el, question} when a visible, empty,
  // enabled text field sits next to a DISABLED next/Continuar button (i.e.
  // the form won't advance until the user types). Used to give a clear HITL
  // prompt instead of the auto-quiz silently stopping (live-test: the quiz
  // hit a "¿Cuál es tu sueldo bruto mensual ESPERADO?" textarea at 18/24
  // and just looked stuck). User choice: prompt + stop, never auto-fill
  // salary.
  function detectManualEntryBlocker() {
    try {
      const advRx = /continuar|siguiente|next|enviar|finaliz/i;
      const blocked = Array.from(document.querySelectorAll("button")).some((b) => {
        if (!isVisible(b)) return false;
        if (!advRx.test((b.textContent || "").trim())) return false;
        const cls = (b.className || "").toString();
        return b.disabled || b.getAttribute("aria-disabled") === "true" || /\bdisabled\b/i.test(cls);
      });
      if (!blocked) return null; // nothing is gating progress → not a blocker
      // We deliberately DON'T exclude the "cover letter" field here. The old
      // code skipped `el === findExpressCoverLetterField()`, but that helper's
      // "largest textarea" fallback matches ANY single textarea — so on a
      // one-field step (e.g. Konfío's "16/19 ¿De qué volumen es tu cartera?")
      // the manual field got tagged as the cover and skipped → returned null →
      // SILENT stall (the recurring "ahi se quedó"). ("cartera" even matches
      // the cover regex's bare /carta/.) Instead, the watcher applies a GRACE
      // before marking: a cover/Q&A field the AI is about to fill gets a value
      // before the grace elapses (never marked); a field STILL empty + blocking
      // after the grace is genuinely the user's to fill.
      const fields = Array.from(document.querySelectorAll("textarea, input[type='text']")).filter(isVisible);
      let fallback = null;
      for (const el of fields) {
        if (el.disabled || el.readOnly) continue;
        if ((el.value || "").trim()) continue; // already has content
        // Prefer a field whose question text we can extract (precise), but
        // DON'T require it — questionTextFor() misses some LaPieza layouts.
        const q = questionTextFor(el);
        if (q) return { el, question: q };
        if (!fallback) fallback = { el, question: "" };
      }
      if (fallback) return fallback;
    } catch (_) { /* ignore */ }
    return null;
  }

  // Dedupe so we prompt about a given blocking field ONCE (keyed by its
  // stamped fieldRef). Cleared when leaving the apply context.
  const manualEntryPrompted = new Set();

  // PERSISTENT visual marker on a blocking manual-entry field. A toast is
  // transient (auto-dismisses after durationMs) AND deduped, so on slow or
  // awkward LaPieza renders the user can miss it and the field looks silently
  // stuck (the recurring "ahi se quedó"). The marker is a glowing outline + an
  // inline badge pinned to the field itself; it stays until the field is
  // filled or the step changes. Applied idempotently from the watcher tick, so
  // it self-heals and never depends on toast timing or dedup.
  const manualMarkerFocused = new Set();
  function applyManualEntryMarker(el) {
    if (!el) return;
    try {
      el.classList.add("eamx-manual-field");
      const parent = el.parentElement;
      if (parent && !parent.querySelector(":scope > .eamx-manual-badge")) {
        const badge = document.createElement("div");
        badge.className = "eamx-manual-badge";
        badge.textContent = "✍️ Esta la respondes tú — escríbela y dale Continuar. Lo demás ya quedó listo.";
        try { parent.insertBefore(badge, el); } catch (_) {}
      }
      // Focus + scroll ONCE per field — re-focusing every tick would fight the
      // user while they type.
      let ref = "";
      try { ref = ensureFieldRef(el); } catch (_) {}
      if (ref && !manualMarkerFocused.has(ref)) {
        manualMarkerFocused.add(ref);
        try { el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (_) {}
        try { el.focus(); } catch (_) {}
      }
    } catch (_) { /* ignore */ }
  }
  function clearManualEntryMarkers() {
    try {
      document.querySelectorAll(".eamx-manual-field").forEach((el) => {
        try { el.classList.remove("eamx-manual-field"); } catch (_) {}
      });
      document.querySelectorAll(".eamx-manual-badge").forEach((b) => {
        try { b.remove(); } catch (_) {}
      });
      manualMarkerFocused.clear();
    } catch (_) { /* ignore */ }
  }

  function promptManualEntryIfBlocked() {
    const blocker = detectManualEntryBlocker();
    if (!blocker) return false;
    // Persistent marker FIRST (idempotent, no dedup) — this is the reliable
    // cue. The toast below is a best-effort attention grab (deduped).
    try { applyManualEntryMarker(blocker.el); } catch (_) {}
    let ref = "";
    try { ref = ensureFieldRef(blocker.el); } catch (_) {}
    if (ref && manualEntryPrompted.has(ref)) return true; // already toasted
    if (ref) manualEntryPrompted.add(ref);
    try { clearQuizStickyToast(); } catch (_) {}
    toast(
      "✍️ Esta pregunta la respondes tú (ej. tu sueldo esperado). Escríbela y dale Continuar — lo demás ya quedó listo.",
      "info",
      { durationMs: 60000, sticky: true }
    );
    return true;
  }

  // Standing watcher on /apply/ for a manual free-text field that blocks the
  // flow but we don't auto-fill (salary/expectativa). The auto-quiz loop's
  // blocker check only fires when a multiple-choice quiz is running; a vacancy
  // whose ONLY step is "¿Cuál es tu expectativa salarial?" has no quiz, so the
  // loop never starts and the chain just stopped silently at the empty box
  // (user: "pasó como si acabara"). This watcher covers that: it polls, and
  // when a free-text field has been BLOCKING a disabled Continuar for a few
  // seconds (grace — so the chain/Q&A had its chance to fill what it CAN),
  // it prompts the user once + focuses the field. Never auto-fills salary.
  let manualEntryWatchActive = false;
  function startManualEntryWatcher() {
    if (manualEntryWatchActive) return;
    manualEntryWatchActive = true;
    const firstSeen = new Map(); // fieldRef -> first-seen timestamp
    const GRACE_MS = 5000;
    const tick = () => {
      if (!manualEntryWatchActive) return;
      try {
        const blocker = detectManualEntryBlocker();
        if (blocker) {
          let ref = "";
          try { ref = ensureFieldRef(blocker.el); } catch (_) {}
          if (ref) {
            if (!firstSeen.has(ref)) firstSeen.set(ref, Date.now());
            // Grace: only mark after the field has been continuously blocking a
            // few seconds — long enough that the AI would have filled the
            // cover/Q&A if it was going to (so we never flash on it). A field
            // STILL empty + blocking after the grace is the user's to fill
            // (salary, cartera, etc.). promptManualEntryIfBlocked applies the
            // persistent marker AND the one-time toast (both idempotent).
            if (Date.now() - firstSeen.get(ref) >= GRACE_MS) {
              try { promptManualEntryIfBlocked(); } catch (_) {}
            }
          }
        } else {
          // Blocker gone (field filled or step advanced) → clear marker + grace.
          try { clearManualEntryMarkers(); } catch (_) {}
          try { firstSeen.clear(); } catch (_) {}
        }
      } catch (_) { /* ignore */ }
      setTimeout(tick, 1500);
    };
    setTimeout(tick, 2000);
  }
  function stopManualEntryWatcher() {
    manualEntryWatchActive = false;
    try { manualEntryPrompted.clear(); } catch (_) {}
    try { clearManualEntryMarkers(); } catch (_) {}
  }

  async function runAutoQuizLoop() {
    // Pre-flight: lastJob + cachedProfile. The Express flow on /vacancy/<uuid>
    // sets both; if we got here without them the apply-side cache restore
    // didn't fire. Bail with an actionable toast.
    if (!lastJob) return;
    if (!cachedProfile) return;
    attachQuizKillSwitches();

    let answeredOk = 0;
    let totalSeen = 0;

    for (let iter = 0; iter < QUIZ_MAX_QUESTIONS; iter++) {
      if (quizLoopAborted) break;

      const state = detectQuizQuestion();
      if (!state) {
        // detectQuizQuestion returns null when there are no multiple-choice
        // options. That's usually "quiz finished" — BUT it's also a
        // free-text question we don't auto-fill (salary/expectativa). If
        // such a field blocks a disabled Continuar, prompt the user (deduped
        // with the standing manual-entry watcher) instead of stopping silent.
        try { promptManualEntryIfBlocked(); } catch (_) {}
        // Quiz finished (or handed off to the user) — stop the loop.
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
        // Clear the "IA contestando..." sticky before bailing — otherwise
        // it lingers next to the error toast (user-confusing: the sticky
        // implies we're still working when we've actually stopped).
        clearQuizStickyToast();
        toast(humanizeError(err), "error");
        return;
      }
      if (!res || !res.ok) {
        // Stop on first error — avoid clicking wrong answers in a panic.
        // Clear sticky BEFORE showing the error so they don't fight for
        // attention. User reported case: hit PLAN_LIMIT_EXCEEDED and the
        // sticky "IA contestando pregunta 1/?" stayed up while "Ver
        // planes" toast also showed — looked like the loop was still
        // running. Convert to return (not break) to skip the misleading
        // "✓ Quiz completo" final summary at the bottom of this function.
        clearQuizStickyToast();
        if (res && res.error === ERR.UNAUTHORIZED) {
          // Abort the outer chain too — without this, the chain loops
          // back into another AI call and re-fails 401. Auth-fail is
          // terminal until the user re-logs.
          quickApplyAborted = true;
          reportBulkStatus("error", { label: "Sesión expirada — inicia sesión" });
          clearBulkModeFlag();
          toast("Sesión expirada. Inicia sesión para continuar el quiz.", "error", {
            label: "Iniciar sesión",
            onClick: () => openOptionsPage()
          });
        } else if (res && res.error === ERR.PLAN_LIMIT_EXCEEDED) {
          toast("Se acabaron tus respuestas IA del mes. El quiz se detuvo — sube de plan para seguir.", "error", {
            label: "Ver planes",
            onClick: () => openBilling(),
            durationMs: 10000
          });
        } else {
          toast((res && res.message) || "Auto-quiz: la IA no pudo responder.", "error");
        }
        return;
      }

      // Normalize the answer key — Gemini may return Y/N variants
      // ("SÍ" with diacritic, "YES", "Y", "N") that don't directly
      // match our canonical "SI"/"NO" option keys. normalizeYesNoKey
      // collapses them; for A/B/C/D quizzes the toUpperCase preserves
      // the key as-is.
      const rawKey = (res.answerKey || "").trim().toUpperCase();
      const normalizedYN = normalizeYesNoKey(rawKey);
      const answerKey = normalizedYN || rawKey;
      const choice = state.options.find((o) => o.key === answerKey);
      if (!choice) {
        // Backend returned a key we don't have in the DOM. Shouldn't happen
        // (handler validates) but defend anyway. Clear sticky + return so
        // the misleading final-summary toast doesn't fire.
        clearQuizStickyToast();
        toast(`Auto-quiz: la IA respondió "${answerKey}" pero no está en pantalla.`, "error");
        return;
      }

      // Verify the option button is still in the DOM (LaPieza may have
      // re-rendered between the request firing and the response landing).
      if (!document.body.contains(choice.button)) {
        // Re-detect and re-find by key.
        const fresh = detectQuizQuestion();
        const refreshed = fresh && fresh.options.find((o) => o.key === answerKey);
        if (!refreshed) {
          clearQuizStickyToast();
          toast("Auto-quiz: el quiz cambió justo ahora. Revisa manualmente.", "info");
          return;
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
        clearQuizStickyToast();
        toast("Auto-quiz: no detecté la siguiente pregunta. Revisa manualmente.", "info", { durationMs: 5000 });
        return;
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
  // Detect whether this listing card is already-applied or
  // closed/expired without entering /apply/. User explicit ask:
  // "que detecte automáticamente las postulaciones hechas o los
  // trabajos que estén marcados como cerrados". Lets the matches
  // panel filter these out of the ranking + bulk top-N BEFORE
  // wasting a quota slot on a tab that will just bail in the
  // chain's terminal-state detector.
  //
  // Detection strategy — both text scan AND attribute scan inside
  // the card, because LaPieza's marker can be a small chip, a
  // ribbon overlay, or just a textual hint. Tolerant of both
  // languages.
  //
  // Returns { applied: boolean, closed: boolean }.
  function detectCardStatus(card) {
    const status = { applied: false, closed: false };
    if (!card) return status;
    try {
      // Get the full text of the card once; cheaper than walking
      // children for each regex.
      const allText = (card.innerText || card.textContent || "").trim();
      if (!allText) return status;

      // Applied markers — full-text patterns (bounded by job description
      // text usually fitting in 600 chars).
      const APPLIED_RX = [
        /\bya\s+(?:te\s+)?(?:postulaste|aplicaste)\b/i,
        /\bya\s+postulado\b/i,
        /\bpostulaci[oó]n\s+enviada\b/i,
        /\baplicaci[oó]n\s+enviada\b/i,
        /\bapplied\b\s+(?:on|·|\d{1,2})/i,
        /\bya\s+aplicaste\s+(?:a|para)\s+esta\b/i
      ];
      // Closed/expired PHRASES — long enough that they don't false-
      // positive inside descriptions. Tested against the snippet text.
      const CLOSED_PHRASE_RX = [
        /\bvacante\s+(?:cerrada|expirada|no\s+disponible|no\s+activa)\b/i,
        /\boferta\s+(?:cerrada|expirada|no\s+disponible)\b/i,
        /\bya\s+no\s+recibe\s+postulaciones\b/i,
        /\b(?:position|job|posting)\s+(?:closed|expired|filled)\b/i,
        /\bno\s+longer\s+(?:available|accepting)\b/i,
        /\b(?:la\s+empresa\s+ha\s+)?finalizado?\s+el\s+proceso\s+de\s+reclutamiento\b/i,
        /\b(?:proceso\s+de\s+)?reclutamiento\s+(?:cerrado|finalizado)\b/i
      ];
      // Standalone BADGE regex — applied ONLY to short leaf text nodes
      // (≤ 30 chars), NOT to the full card snippet. Without this guard
      // a description like "AGENCIA CERRADA AL PÚBLICO LOS LUNES" in
      // the first 600 chars false-positives. Mirrors the short-text
      // guard in detectVacancyClosedState which has been correct for
      // weeks.
      const CLOSED_BADGE_RX = /\b(?:CERRADA|CLOSED|EXPIRADA|EXPIRED|FILLED)\b/;

      const snippet = allText.slice(0, 600);
      for (const rx of APPLIED_RX) {
        if (rx.test(snippet)) { status.applied = true; break; }
      }
      for (const rx of CLOSED_PHRASE_RX) {
        if (rx.test(snippet)) { status.closed = true; break; }
      }
      // Badge scan — only short leaf text nodes inside the card. We
      // collect them with a quick query and test the badge regex per
      // node. Stops on first match.
      if (!status.closed) {
        try {
          const leaves = card.querySelectorAll("span, strong, em, b, label, div, p");
          for (const el of leaves) {
            if (el.children && el.children.length > 0) continue;
            const t = (el.textContent || "").trim();
            if (!t || t.length > 30) continue;
            if (CLOSED_BADGE_RX.test(t)) { status.closed = true; break; }
          }
        } catch (_) { /* defensive */ }
      }

      // Attribute scan — LaPieza sometimes marks cards via class
      // names or data-* attrs. Walk the card and its top children
      // (one level deep is plenty — these markers live on the card
      // root or a direct ribbon child).
      const attrCheck = (el) => {
        try {
          const cls = (el.className || "").toString().toLowerCase();
          if (cls) {
            if (/\b(?:applied|postulada?|aplicada?)\b/.test(cls) && !/un.?applied|sin.?postular/.test(cls)) {
              status.applied = true;
            }
            if (/\b(?:closed|expired|cerrada?|expirada?|inactive)\b/.test(cls)) {
              status.closed = true;
            }
          }
          if (el.dataset) {
            if (el.dataset.applied === "true" || el.dataset.postulada === "true") status.applied = true;
            if (el.dataset.closed === "true" || el.dataset.expired === "true") status.closed = true;
          }
        } catch (_) {}
      };
      attrCheck(card);
      try {
        const kids = card.children || [];
        for (let i = 0; i < kids.length && i < 12; i++) attrCheck(kids[i]);
      } catch (_) {}
    } catch (_) { /* swallow — best effort */ }
    return status;
  }

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
        // Standing location-modal auto-confirm — works for a MANUAL
        // "¡Me quiero postular!" click too, not just ⚡ Postular.
        try { startLocationModalAutoConfirm(); } catch (_) {}
      } else if (fabMode() === "apply") {
        setTimeout(() => maybeAutoFireExpressOnApply(), 600);
        // Always arm the flow assistant on /apply/ — even if the user
        // never clicked the FAB and even if the chain bailed early.
        // detectAdaptiveQuestions inside runFlowDetectors is the one path
        // that catches LATE-appearing open-ended Q&A textareas (e.g.
        // questions 16-18 of an 18-step LaPieza quiz). Without this,
        // adaptive detection only ran when runExpressFill armed it,
        // missing the open-ended step entirely if the chain finished its
        // iterations before the textarea rendered.
        setTimeout(() => { try { startFlowAssistant(); } catch (_) {} }, 1200);
        // Standing watcher for a manual field (e.g. a standalone "expectativa
        // salarial" step) that blocks the flow but we don't auto-fill — prompts
        // the user instead of the chain stopping silently.
        try { startManualEntryWatcher(); } catch (_) {}
      }
    } else {
      // Left the job-detail / listing context entirely — drop the
      // wider-search pool too, since it's listing-scoped and the user's
      // filters may differ on a return visit.
      widerSearchPool = null;
      try { stopLocationModalAutoConfirm(); } catch (_) {}
      try { stopManualEntryWatcher(); } catch (_) {}
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
        // Reset the chain abort flag + tear down any dangling Esc handler so
        // the new route starts from a clean state. A prior chain that hit a
        // terminal error (UNAUTHORIZED / PLAN_LIMIT / EMAIL_NOT_VERIFIED) set
        // quickApplyAborted=true; without this, a later flow on a route that
        // doesn't re-init the chain would inherit a pre-aborted state.
        quickApplyAborted = false;
        if (quickApplyEscHandler) {
          try { document.removeEventListener("keydown", quickApplyEscHandler, true); } catch (_) {}
          quickApplyEscHandler = null;
        }
        // Tear down listing overlays — they're tied to the previous route's
        // DOM. detectAndMount() below re-arms them if we're still on a
        // listing path.
        stopListingObserver();
        // SPA route changed: tear down any in-flow helpers tied to the old
        // page. The assistant will re-arm if the user approves on the new
        // route. We clear the dedupe set so detectors can re-attach to
        // freshly-rendered inputs/textareas/buttons.
        stopFlowAssistant();
        // Manual-entry watcher is per-apply-page; drop it on route change
        // (detectAndMount re-arms it on the new /apply/).
        try { stopManualEntryWatcher(); } catch (_) {}
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
