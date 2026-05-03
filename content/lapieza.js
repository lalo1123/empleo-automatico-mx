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
    ANSWER_QUESTIONS: "ANSWER_QUESTIONS"
  };
  const ERR = { UNAUTHORIZED: "UNAUTHORIZED", PLAN_LIMIT_EXCEEDED: "PLAN_LIMIT_EXCEEDED", INVALID_INPUT: "INVALID_INPUT", SERVER_ERROR: "SERVER_ERROR" };
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
        ANSWER_QUESTIONS: mod.MESSAGE_TYPES.ANSWER_QUESTIONS
      });
      if (mod && mod.ERROR_CODES) Object.assign(ERR, {
        UNAUTHORIZED: mod.ERROR_CODES.UNAUTHORIZED,
        PLAN_LIMIT_EXCEEDED: mod.ERROR_CODES.PLAN_LIMIT_EXCEEDED,
        INVALID_INPUT: mod.ERROR_CODES.INVALID_INPUT,
        SERVER_ERROR: mod.ERROR_CODES.SERVER_ERROR
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

  // =========================================================================
  // Detection & extraction
  // =========================================================================

  function isApplyPage() {
    return APPLY_URL_PATTERNS.some((re) => re.test(location.href));
  }

  function isJobDetailPage() {
    // LaPieza listing/marketing paths must NOT trigger. Explicit denylist
    // first so we never have to rely on heuristics for these.
    //   /vacantes, /vacancies — the listing/search page
    //   /comunidad           — community feed
    //   /soy-empresa         — employer landing
    //   /mi-perfil           — own profile
    //   /                    — home
    //
    // The hero on these pages has an "Aplicar" newsletter-signup button that
    // matched our old hasApply heuristic and falsely lit up the FAB. Hard
    // denylist eliminates the false positive.
    const path = location.pathname || "";
    const DENY_PATHS = [
      /^\/?$/,
      /^\/vacantes\/?$/i,
      /^\/vacancies\/?$/i,
      /^\/jobs\/?$/i,
      /^\/empleos\/?$/i,
      /^\/comunidad\/?/i,
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
    // Trailing-bare paths like /vacancy or /vacante (no UUID) — also list
    // pages, must not trigger.
    if (/\/(vacancy|vacante|jobs|empleos|puesto)\/?$/i.test(path)) return false;

    // Apply pages always count — the user wants the panel here even though
    // the page has no JSON-LD or job description: we already cached the job
    // on /vacancy/<uuid> and we'll restore it from session storage.
    if (isApplyPage()) return true;

    // Stricter rule going forward: the FAB only mounts when the URL path
    // explicitly matches a job-detail pattern (/vacancy/<uuid>, etc.). The
    // old fallback "hasHeading && hasApply" was too permissive — a generic
    // "Aplicar" button on a marketing page would light up the FAB.
    return JOB_URL_PATTERNS.some((re) => re.test(location.href));
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
      chrome.storage.session.set({ [key]: job });
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
  // Resolves to a boolean; never rejects.
  function readExpressMode() {
    return new Promise((resolve) => {
      try {
        if (!chrome?.storage?.local) { resolve(true); return; }
        chrome.storage.local.get([EXPRESS_MODE_STORAGE_KEY], (r) => {
          const v = r && r[EXPRESS_MODE_STORAGE_KEY];
          resolve(typeof v === "boolean" ? v : true);
        });
      } catch (_) { resolve(true); }
    });
  }

  function draftCacheKey(url) {
    const id = idFromUrl(url || location.href);
    return DRAFT_CACHE_PREFIX + id;
  }
  function persistDraftToSession(draft) {
    if (!draft || !chrome?.storage?.session) return;
    try {
      const key = draftCacheKey(location.href);
      chrome.storage.session.set({ [key]: draft });
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
      chrome.storage.session.remove(draftCacheKey(url || location.href));
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
            chrome.storage.session.set({ [key]: { ...draft, id: res.draftId || draft.id || null } });
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

    // Side effect: when mounting on a vacancy page, eagerly extract & cache
    // the job so it survives the navigation to /apply/<uuid>. We run after
    // a short delay to let the page settle (LaPieza renders JSON-LD late
    // on some routes). On apply pages we do nothing — the FAB click will
    // restore from cache.
    if (!isApplyPage()) {
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
  function unmountFab() { fabEl?.parentNode?.removeChild(fabEl); fabEl = null; }
  function setFabBusy(b) {
    if (!fabEl) return;
    fabEl.classList.toggle("eamx-fab--busy", !!b);
    fabEl.disabled = !!b;
    const lbl = fabEl.querySelector(".eamx-fab__label");
    if (lbl) lbl.textContent = b ? "Generando" : "Postular con IA";
  }

  // Top-level FAB dispatcher. Branches on the Express toggle:
  //   - Express ON  + /vacancy/<uuid> → pre-warm draft + show "ready" toast
  //   - Express ON  + /apply/<uuid>   → run full Express fill (carta + cv + answers)
  //   - Express OFF (any page)        → legacy panel flow (current behavior)
  async function onFabClick() {
    if (!fabEl || fabEl.disabled) return;
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
  async function onFabClickExpressVacancy() {
    const { job, partial } = extractJob();
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
  async function onFabClickExpressApply() {
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
      await runExpressFill({ job, prewarmedDraft: prewarmed });
    } catch (err) {
      console.warn("[EmpleoAutomatico] Express fill threw", err);
      toast(humanizeError(err), "error");
    } finally {
      setFabBusy(false);
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
   * HITL guarantees (NEVER violated):
   *   - We NEVER click LaPieza's "Postularme" button programmatically.
   *   - We NEVER click LaPieza's "Finalizar"/submit button programmatically.
   *   - We NEVER fire form.submit() programmatically.
   *   - We only modify field values + dispatch input/change/blur events for
   *     React-friendliness.
   *   - The user always clicks the platform's CTA themselves.
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
  async function runExpressFill({ job, prewarmedDraft }) {
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
    const cvPromise = (async () => {
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
      detectAdaptiveQuestions();
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
    // Surface a one-shot toast so the user knows we found something new.
    if (!FLOW_TIPS_SHOWN.has("adaptive-questions")) {
      FLOW_TIPS_SHOWN.add("adaptive-questions");
      toast(
        "Detecté " + scanned.length + " pregunta" + (scanned.length === 1 ? "" : "s") +
        " en este formulario. Genera respuestas con IA.",
        "info",
        {
          label: "Generar respuestas",
          onClick: () => {
            // Re-open panel if it's been closed, else just kick off the fetch.
            if (!panelEl && lastJob && lastDraft) {
              openPanel({ job: lastJob, draft: lastDraft, partial: false });
            }
            fetchAnswersForDetectedQuestions();
          }
        }
      );
    }
    // Repaint the panel if it's open right now so the new section is visible.
    renderQuestionsCard();
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
        // Adaptive questions cache is per-page — drop on SPA route change.
        // The detector re-runs on the new route; old fieldRefs would resolve
        // to nothing once the form unmounts.
        detectedQuestions = []; questionAnswers = []; questionsState = "idle"; questionsError = "";
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
    try {
      // Wire up the user-edit detector early so any text the user types
      // BEFORE the FAB click is preserved by Express fill (we won't clobber
      // a field whose data-eamx-user-edited === "true").
      attachUserEditListener();
      detectAndMount();
      watchUrlChanges();
    }
    catch (err) { console.error("[EmpleoAutomatico]", err); }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
