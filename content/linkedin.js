/**
 * content/linkedin.js — LinkedIn content script (Empleo Automático MX)
 *
 * CRITICAL — LinkedIn requires extra-conservative behaviour. LinkedIn detected
 * and banned 23.5M automated sessions in Q1 2026 and publicly banned HeyReach
 * in March 2026. LazyApply is on their public blacklist. Simplify (which uses
 * strict human-in-the-loop only) survives with 500K+ users — we replicate that
 * model here, NEVER auto-clicking any button inside the Easy Apply modal.
 *
 * Confidence on LinkedIn selectors: LOW. LinkedIn rotates class names roughly
 * quarterly and ships A/B variants to subsets of users, so every selector
 * below is marked TODO(dom) and is best-effort only. The director MUST verify
 * on a live LinkedIn job before shipping.
 *
 * Order-of-preference for extraction (same strategy as occ.js / computrabajo.js):
 *   1) JSON-LD @type JobPosting (LinkedIn does emit this for SEO)
 *   2) Modern 2025-2026 selectors (job-details-jobs-unified-top-card__*)
 *   3) Fallbacks: [class*='job-title' i], [class*='company-name' i], etc.
 *   4) Largest text block in <main>/<article> as last resort
 *
 * Differences vs occ.js / computrabajo.js:
 *   - Daily limit: max 15 cover letters per LinkedIn day (chrome.storage)
 *   - Warning toast: shown once per day on first detection
 *   - Easy Apply integration: we WAIT for the user to open the modal, then
 *     surface a "Pegar mi carta" button. We never click Easy Apply, Continue,
 *     Next, or Submit. The user does ALL navigation in the modal.
 *   - FAB delayed 800ms past document_idle to avoid early-mutation fingerprints
 *   - No data-applybot or other LinkedIn-fingerprintable attributes
 */
(function () {
  "use strict";

  const SOURCE = "linkedin";
  const MSG = { GENERATE_DRAFT: "GENERATE_DRAFT", APPROVE_DRAFT: "APPROVE_DRAFT", REJECT_DRAFT: "REJECT_DRAFT", OPEN_BILLING: "OPEN_BILLING" };
  const ERR = { UNAUTHORIZED: "UNAUTHORIZED", PLAN_LIMIT_EXCEEDED: "PLAN_LIMIT_EXCEEDED" };
  const BILLING_URL = "https://empleo.skybrandmx.com/account/billing";

  // --- Anti-ban guardrails -------------------------------------------------
  // LinkedIn flags accounts with ~20+ application patterns per day. We hard
  // cap at 15 cover-letter generations per day to leave headroom and account
  // for retries / regenerations.
  const DAILY_LIMIT = 15;
  const STORAGE_KEY = "linkedinDailyCount";
  const WARNING_KEY = "linkedinWarningShown"; // tracks last date the warning was shown
  const FAB_INJECT_DELAY_MS = 800; // delay past document_idle before injecting FAB

  // TODO(dom): URL patterns for LinkedIn job pages. LinkedIn currently uses
  // three main shapes for the job-detail UI:
  //   1) /jobs/view/<numericId>            — direct posting permalink
  //   2) /jobs/search/?currentJobId=<id>   — search results, right-pane view
  //   3) /jobs/collections/.../?currentJobId=<id> — recommendations, right-pane
  const JOB_URL_PATTERNS = [
    /\/jobs\/view\/\d+/i,
    /\/jobs\/search\/?\?.*currentJobId=\d+/i,
    /\/jobs\/collections\/[^?]*\?.*currentJobId=\d+/i
  ];

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
  let pasteBtnEl = null;       // floating "Pegar mi carta" button shown when modal opens
  let easyApplyObserver = null; // MutationObserver watching for Easy Apply modal
  let activeDraftId = null;
  let lastJob = null;
  let lastDraft = null;
  let lastUrl = location.href;

  // =========================================================================
  // Daily limit — chrome.storage.local
  // =========================================================================

  function todayISO() { return new Date().toISOString().slice(0, 10); }

  // Returns { canProceed, record } where record is the persisted counter.
  // Resets the counter automatically if the stored date is not today.
  async function checkDailyLimit() {
    const today = todayISO();
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const record = data[STORAGE_KEY] || { date: today, count: 0 };
    if (record.date !== today) {
      record.date = today;
      record.count = 0;
    }
    return { canProceed: record.count < DAILY_LIMIT, record };
  }

  async function incrementDailyCount() {
    const today = todayISO();
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const record = data[STORAGE_KEY] || { date: today, count: 0 };
    if (record.date !== today) {
      record.date = today;
      record.count = 0;
    }
    record.count++;
    await chrome.storage.local.set({ [STORAGE_KEY]: record });
    return record.count;
  }

  // Has the once-per-day warning toast already been shown today?
  async function shouldShowDailyWarning() {
    const today = todayISO();
    const data = await chrome.storage.local.get(WARNING_KEY);
    const last = data[WARNING_KEY];
    return last !== today;
  }

  async function markWarningShown() {
    await chrome.storage.local.set({ [WARNING_KEY]: todayISO() });
  }

  // =========================================================================
  // Detection & extraction
  // =========================================================================

  function isJobDetailPage() {
    const urlMatches = JOB_URL_PATTERNS.some((re) => re.test(location.href));

    // Even when the URL looks right, the right-pane view may not be loaded yet,
    // so we corroborate with DOM heuristics. TODO(dom): LinkedIn rotates these.
    const hasHeading = !!document.querySelector(
      ".job-details-jobs-unified-top-card__job-title, " +
      ".t-24.job-details-jobs-unified-top-card__job-title, " +
      "[data-test-job-details-id], " +
      "[class*='job-title' i] h1, h1[class*='job-title' i]"
    );
    const hasJsonLd = !!findJobPostingJsonLd();
    return urlMatches || hasJsonLd || hasHeading;
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
    if (/\bh[íi]brido\b|\bhybrid\b/.test(t)) return "híbrido";
    if (/\bpresencial\b|\bon[- ]?site\b/.test(t)) return "presencial";
    return null;
  }

  function dedupe(arr) {
    const seen = new Set(); const out = [];
    for (const x of arr) { const k = x.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(x); } }
    return out;
  }

  function extractRequirements(descriptionText) {
    // TODO(dom): LinkedIn's description is rendered into a single block with
    // <strong> headers like "Requirements" / "Qualifications" / "What you'll
    // need". A targeted DOM scrape isn't reliable; we fall through to the
    // text-based heuristic which matches both EN and ES bullet styles.
    const containers = document.querySelectorAll(
      "[class*='requirement' i], [class*='requisit' i], [class*='qualific' i]"
    );
    const bullets = [];
    containers.forEach((c) => c.querySelectorAll("li").forEach((li) => {
      const t = cleanText(li.textContent); if (t) bullets.push(t);
    }));
    if (bullets.length) return dedupe(bullets).slice(0, 30);

    if (!descriptionText) return [];
    const kw = /(experiencia|años|requisito|conocimient|manejo|dominio|nivel|inglés|ingles|licencia|certific|habilidad|escolaridad|years|experience|skill|english|degree)/i;
    const lines = descriptionText.split(/\n|•|·|\*|—/).map((l) => l.trim())
      .filter((l) => l.length > 4 && l.length < 300 && kw.test(l));
    return dedupe(lines).slice(0, 15);
  }

  // LinkedIn surfaces the job id as `currentJobId` query param on right-pane
  // views and as a `/jobs/view/<id>` segment on permalinks. Fall back to any
  // 5+ digit number in the URL, then to a hash of the full URL.
  function idFromUrl(url) {
    try {
      const u = new URL(url);
      const qid = u.searchParams.get("currentJobId");
      if (qid) return qid;
    } catch (_) { /* fallthrough */ }
    const m = url.match(/\/jobs\/view\/(\d+)/i);
    if (m) return m[1];
    const m2 = url.match(/(\d{5,})/);
    if (m2) return m2[1];
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

    // TODO(dom): LinkedIn modern selectors as of late 2025 / early 2026.
    // ALL of these will rotate; the director MUST re-verify on a live page.
    title = firstNonEmpty(
      title,
      textOf(".job-details-jobs-unified-top-card__job-title h1"),
      textOf(".t-24.job-details-jobs-unified-top-card__job-title"),
      textOf(".job-details-jobs-unified-top-card__job-title"),
      textOf("[data-test-job-details-id] h1"),
      textOf("h1[class*='job-title' i]"),
      textOf("[class*='job-title' i] h1"),
      textOf("h1")
    );
    company = firstNonEmpty(
      company,
      textOf(".job-details-jobs-unified-top-card__company-name a"),
      textOf(".job-details-jobs-unified-top-card__company-name"),
      textOf(".job-details-jobs-unified-top-card__primary-description-container a"),
      textOf("[class*='company-name' i] a"),
      textOf("[class*='company-name' i]"),
      textOf("[data-test-job-details-id] [class*='company']")
    );
    loc = firstNonEmpty(
      loc,
      // First .tvm__text inside the primary description is the location chip.
      textOf(".job-details-jobs-unified-top-card__primary-description-container .tvm__text"),
      textOf(".job-details-jobs-unified-top-card__bullet"),
      textOf("[class*='location' i]"),
      textOf("[class*='workplace-type' i]")
    );
    if (!salary) {
      salary = firstNonEmpty(
        textOf("[class*='salary' i]"),
        textOf("[class*='compensation' i]"),
        textOf(".job-details-jobs-unified-top-card__job-insight [aria-label*='salary' i]")
      ) || null;
    }
    if (!description) {
      description = firstNonEmpty(
        textOf(".jobs-description__content"),
        textOf(".jobs-description__container"),
        textOf(".job-details-module .mt4"),
        textOf("[class*='jobs-description' i]"),
        textOf("[class*='job-description' i]"),
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
    if (fabEl && document.body.contains(fabEl)) return;
    fabEl = document.createElement("button");
    fabEl.type = "button";
    // Use eamx- prefix only — no data-applybot or other LinkedIn-fingerprintable
    // attributes. data-eamx-* would be safe but we don't need any here.
    fabEl.className = "eamx-fab eamx-fab--linkedin";
    fabEl.setAttribute("aria-label", "Postular con IA");
    fabEl.innerHTML =
      '<span class="eamx-fab__icon" aria-hidden="true">✨</span>' +
      '<span class="eamx-fab__label">Postular con IA</span>';
    fabEl.addEventListener("click", onFabClick);
    document.body.appendChild(fabEl);

    // Show the once-per-day safety warning on the first detection of the day.
    maybeShowDailyWarning();
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

    // Daily limit gate — blocks the entire flow when exhausted.
    const { canProceed, record } = await checkDailyLimit();
    if (!canProceed) {
      toast(
        `Llegaste al límite diario en LinkedIn (${DAILY_LIMIT} cartas). ` +
        `Para proteger tu cuenta, esperaremos hasta mañana.`,
        "error"
      );
      console.info("[EmpleoAutomatico][LinkedIn] daily limit reached:", record);
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
      // Increment counter only on a successful generation, so failed backend
      // calls don't burn the user's daily budget.
      const next = await incrementDailyCount();
      console.info(`[EmpleoAutomatico][LinkedIn] generated ${next}/${DAILY_LIMIT} today`);
      openPanel({ job, draft: lastDraft, partial, dailyCount: next });
    } catch (err) {
      toast(humanizeError(err), "error");
    } finally {
      setFabBusy(false);
    }
  }

  // =========================================================================
  // Daily safety warning toast
  // =========================================================================

  async function maybeShowDailyWarning() {
    try {
      const should = await shouldShowDailyWarning();
      if (!should) return;
      await markWarningShown();
    } catch (_) {
      // If chrome.storage is unavailable for some reason, fail open and skip
      // the warning rather than blocking the user.
      return;
    }

    // Build a richer toast with a list — the standard toast() helper only
    // renders plain text, so we mount a custom warning element here.
    const el = document.createElement("aside");
    el.className = "eamx-toast eamx-toast--warning eamx-linkedin-warning";
    el.setAttribute("role", "alertdialog");
    el.setAttribute("aria-label", "Aviso de seguridad LinkedIn");
    el.innerHTML = `
      <div class="eamx-linkedin-warning__title">⚠️ LinkedIn detecta extensiones</div>
      <div class="eamx-linkedin-warning__body">Para proteger tu cuenta:
        <ul>
          <li>Solo postularás 1-2 vacantes a la vez</li>
          <li>Tú das el clic final SIEMPRE</li>
          <li>Límite diario: ${DAILY_LIMIT} cartas</li>
        </ul>
      </div>
      <div class="eamx-linkedin-warning__actions">
        <button type="button" class="eamx-btn eamx-btn--primary" data-action="ack">Entendido</button>
      </div>
    `;
    el.addEventListener("click", (ev) => {
      const t = ev.target;
      if (t && t.getAttribute && t.getAttribute("data-action") === "ack") {
        el.classList.remove("eamx-toast--show");
        setTimeout(() => el.remove(), 300);
      }
    });
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("eamx-toast--show"));
    // Auto-dismiss after 18s if the user ignores it — still counted as shown.
    setTimeout(() => {
      if (!el.parentNode) return;
      el.classList.remove("eamx-toast--show");
      setTimeout(() => el.remove(), 400);
    }, 18000);
  }

  // =========================================================================
  // Side panel
  // =========================================================================

  function openPanel({ job, draft, partial, dailyCount }) {
    closePanel();
    panelEl = document.createElement("aside");
    panelEl.className = "eamx-panel eamx-panel--linkedin";
    panelEl.setAttribute("role", "dialog");
    panelEl.setAttribute("aria-label", "Borrador de postulación");

    const cover = draft?.coverLetter || "";
    const answers = draft?.suggestedAnswers || {};
    const remaining = Math.max(0, DAILY_LIMIT - (dailyCount || 0));

    panelEl.innerHTML = `
      <header class="eamx-panel__header">
        <div class="eamx-panel__title"></div>
        <div class="eamx-panel__company"></div>
        <div class="eamx-panel__quota">Hoy: ${dailyCount || 0} / ${DAILY_LIMIT} (${remaining} restantes)</div>
      </header>
      <div class="eamx-panel__body">
        ${partial ? `<div class="eamx-panel__warning">No pude extraer todo de la vacante — revisa la carta con más detalle.</div>` : ""}
        <div class="eamx-panel__hitl-note">
          En LinkedIn tú abres "Easy Apply" y das clic a Continuar / Enviar.
          Cuando aparezca el campo de carta, presiona <strong>Pegar mi carta</strong>.
        </div>
        <label for="eamx-cover-letter"><strong>Carta de presentación</strong></label>
        <textarea id="eamx-cover-letter" class="eamx-textarea" rows="14"></textarea>
        <div class="eamx-answers"></div>
      </div>
      <footer class="eamx-panel__footer">
        <button type="button" class="eamx-btn eamx-btn--primary" data-action="approve">Listo, esperar Easy Apply</button>
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
    stopEasyApplyWatcher();
    removePasteButton();
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
      // Note: we do NOT increment the daily count on regenerate. A regen is a
      // refinement of the same application and should not double-charge the
      // budget against the user.
      toast("Borrador regenerado.", "success");
    } catch (err) {
      toast(humanizeError(err), "error");
    } finally {
      btns.forEach((b) => (b.disabled = false));
    }
  }

  // "Approve" on LinkedIn does NOT auto-fill anything yet. It tells the user
  // to open Easy Apply themselves, then arms the MutationObserver that waits
  // for the modal's cover-letter textarea to appear. When that happens, we
  // surface the floating "Pegar mi carta" button.
  async function handleApprove() {
    if (!activeDraftId) { toast("No hay borrador activo.", "error"); return; }
    const ta = panelEl?.querySelector("#eamx-cover-letter");
    const coverLetter = ta ? ta.value : "";
    const btns = panelEl ? panelEl.querySelectorAll("button[data-action]") : [];
    btns.forEach((b) => (b.disabled = true));
    try {
      // Persist the (possibly edited) cover letter to background — it returns
      // the merged `fields` map but on LinkedIn we only use `coverLetter`.
      const res = await sendMsg({ type: MSG.APPROVE_DRAFT, draftId: activeDraftId, coverLetter });
      if (!res || !res.ok) { toast(res?.error || "No se pudo aprobar.", "error"); return; }
      const fields = (res.fields && typeof res.fields === "object") ? { ...res.fields } : {};
      if (!fields.coverLetter) fields.coverLetter = coverLetter;
      // Stash for the paste-button click handler.
      lastDraft = lastDraft || {};
      lastDraft.coverLetter = fields.coverLetter || coverLetter;

      closePanel();
      startEasyApplyWatcher();
      toast(
        "Listo. Da clic a 'Easy Apply' de LinkedIn. Cuando aparezca el campo de carta, te avisamos.",
        "success"
      );
    } catch (err) {
      toast(humanizeError(err), "error");
    } finally {
      btns.forEach((b) => (b.disabled = false));
      setFabBusy(false);
    }
  }

  // =========================================================================
  // Easy Apply integration — wait-for-modal pattern (HITL strict)
  // =========================================================================
  //
  // We do NOT click LinkedIn's Easy Apply button — the user does. We do NOT
  // click Continue, Next, or Submit inside the modal — the user does. Our only
  // automated action is filling the cover-letter textarea once it exists, and
  // even that requires the user to click our "Pegar mi carta" button first.

  // TODO(dom): Easy Apply modal selectors. LinkedIn renders the modal as a
  // <div role="dialog"> with class names that change frequently. Multiple
  // dialogs can coexist (modals, popovers); we filter by an Easy-Apply-ish
  // heading or by the presence of an apply form inside.
  function findEasyApplyModal() {
    const dialogs = document.querySelectorAll(
      "[role='dialog'], [data-test-modal], .jobs-easy-apply-modal, [class*='easy-apply' i], [class*='jobs-apply' i]"
    );
    for (const d of dialogs) {
      if (d.offsetParent === null) continue; // not visible
      const txt = (d.textContent || "").toLowerCase();
      if (
        /easy apply|solicitud sencilla|solicitud rápida|enviar solicitud|submit application|next|continue|continuar/.test(txt)
      ) {
        return d;
      }
      if (d.querySelector("form, textarea, input[type='file']")) return d;
    }
    return null;
  }

  // TODO(dom): cover-letter textarea selectors inside Easy Apply. Common ids
  // include "additional-questions" / "cover-letter"; aria-labels include
  // "Mensaje al reclutador" / "Cover letter" / "Carta de presentación".
  // We pick the first textarea whose attributes match these heuristics.
  function findCoverLetterTextarea(modal) {
    if (!modal) return null;
    const direct = modal.querySelector(
      "textarea[id*='additional' i], " +
      "textarea[id*='cover' i], " +
      "textarea[name*='cover' i], " +
      "textarea[name*='additional' i], " +
      "textarea[aria-label*='presentación' i], " +
      "textarea[aria-label*='presentacion' i], " +
      "textarea[aria-label*='cover' i], " +
      "textarea[aria-label*='reclutador' i], " +
      "textarea[aria-label*='message' i], " +
      "textarea[aria-label*='mensaje' i]"
    );
    if (direct) return direct;
    // Fallback: any textarea inside the modal whose surrounding label hints at
    // a cover letter. LinkedIn often uses <label for="..."> patterns.
    const tas = Array.from(modal.querySelectorAll("textarea"));
    for (const ta of tas) {
      const label = ta.id && modal.querySelector(`label[for='${ta.id}']`);
      const labelTxt = (label?.textContent || "").toLowerCase();
      if (/carta|presentaci[oó]n|cover|mensaje|recruit|reclutador|motivaci/i.test(labelTxt)) {
        return ta;
      }
    }
    // Last-ditch: if the modal exposes exactly one textarea, assume that's it.
    return tas.length === 1 ? tas[0] : null;
  }

  function startEasyApplyWatcher() {
    stopEasyApplyWatcher(); // idempotent

    const tryAttach = () => {
      const modal = findEasyApplyModal();
      if (!modal) return false;
      const ta = findCoverLetterTextarea(modal);
      if (ta) {
        showPasteButton(ta);
        return true;
      }
      return false;
    };

    // Try once now in case the modal is already open.
    if (tryAttach()) return;

    // Otherwise, watch the body for the modal/textarea to appear.
    easyApplyObserver = new MutationObserver(throttle(() => {
      tryAttach();
      // Also remove the paste button if the modal goes away (user closed it).
      const modal = findEasyApplyModal();
      if (!modal) removePasteButton();
    }, 300));
    easyApplyObserver.observe(document.body, { childList: true, subtree: true });

    // Auto-disarm after 10 minutes — if the user walked away, we don't want a
    // dangling observer running indefinitely.
    setTimeout(stopEasyApplyWatcher, 10 * 60 * 1000);
  }

  function stopEasyApplyWatcher() {
    if (easyApplyObserver) {
      try { easyApplyObserver.disconnect(); } catch (_) {}
      easyApplyObserver = null;
    }
  }

  // Floating action button anchored visually near the textarea. We do NOT
  // mutate the modal DOM, so LinkedIn cannot fingerprint our injection. The
  // button is appended to <body> with a high z-index instead.
  function showPasteButton(textarea) {
    if (pasteBtnEl && document.body.contains(pasteBtnEl)) {
      // Already shown — refresh its position in case the modal moved.
      positionPasteButton(textarea);
      return;
    }
    pasteBtnEl = document.createElement("button");
    pasteBtnEl.type = "button";
    pasteBtnEl.className = "eamx-paste-btn";
    pasteBtnEl.setAttribute("aria-label", "Pegar mi carta de presentación en LinkedIn");
    pasteBtnEl.innerHTML = '<span aria-hidden="true">📋</span> Pegar mi carta';
    pasteBtnEl.addEventListener("click", () => onPasteClick(textarea));
    document.body.appendChild(pasteBtnEl);
    positionPasteButton(textarea);

    // Re-position on scroll/resize (LinkedIn modals scroll independently).
    window.addEventListener("scroll", () => positionPasteButton(textarea), { passive: true, capture: true });
    window.addEventListener("resize", () => positionPasteButton(textarea), { passive: true });

    // If the textarea is detached from the DOM later, hide the button.
    const watch = new MutationObserver(() => {
      if (!document.body.contains(textarea)) {
        removePasteButton();
        watch.disconnect();
      }
    });
    watch.observe(document.body, { childList: true, subtree: true });
  }

  function positionPasteButton(textarea) {
    if (!pasteBtnEl || !textarea) return;
    try {
      const r = textarea.getBoundingClientRect();
      // Anchor just above the top-right corner of the textarea, clamped to
      // viewport. Falls back to bottom-right if the textarea is off-screen.
      const top = Math.max(8, r.top - 44);
      const left = Math.min(window.innerWidth - 180, r.right - 160);
      pasteBtnEl.style.top = `${top}px`;
      pasteBtnEl.style.left = `${left}px`;
    } catch (_) {
      pasteBtnEl.style.top = "auto";
      pasteBtnEl.style.bottom = "96px";
      pasteBtnEl.style.right = "24px";
      pasteBtnEl.style.left = "auto";
    }
  }

  function removePasteButton() {
    pasteBtnEl?.parentNode?.removeChild(pasteBtnEl);
    pasteBtnEl = null;
  }

  function onPasteClick(textarea) {
    if (!textarea || !document.body.contains(textarea)) {
      toast("No encontré el campo de carta — postula manualmente.", "error");
      removePasteButton();
      return;
    }
    const value = lastDraft?.coverLetter || "";
    if (!value.trim()) {
      toast("No hay carta para pegar. Genera un borrador primero.", "error");
      return;
    }
    try {
      setNativeValue(textarea, value);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
      textarea.focus();
      toast("Carta pegada. Revisa y da clic a 'Siguiente' o 'Enviar' tú mismo.", "success");
      // Do NOT click any button. We keep the paste button visible in case the
      // user wants to re-paste after edits.
    } catch (err) {
      console.error("[EmpleoAutomatico][LinkedIn] paste failed:", err);
      toast("No pude pegar la carta. Cópiala desde el panel manualmente.", "error");
    }
  }

  // =========================================================================
  // Form fill helpers (only used for the Easy Apply textarea)
  // =========================================================================

  // Use the native value setter so React's synthetic events see the change.
  // LinkedIn's Easy Apply form is React-based, so a plain `el.value = x` will
  // be silently ignored by the framework.
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value); else el.value = value;
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
    const duration = action ? 8000 : 4500;
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
    sendMsg({ type: MSG.OPEN_BILLING }).catch(() => {
      window.open(BILLING_URL, "_blank", "noopener,noreferrer");
    });
  }

  function openOptionsPage() {
    window.open(chrome.runtime.getURL("options/options.html"), "_blank", "noopener");
  }

  // No cross-origin XHR — only chrome.runtime messages to the background SW.
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
    else { unmountFab(); closePanel(); stopEasyApplyWatcher(); removePasteButton(); }
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
        stopEasyApplyWatcher();
        removePasteButton();
        // Two-pass detect to handle LinkedIn's async right-pane load: the URL
        // changes before the job DOM is in place, so a single immediate check
        // would miss the heading.
        setTimeout(detectAndMount, 400);
        setTimeout(detectAndMount, 1500);
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
      else if (!want && have) { unmountFab(); closePanel(); stopEasyApplyWatcher(); removePasteButton(); }
    }, 800));
    mo.observe(document.body, { childList: true, subtree: true });
  }

  function boot() {
    try {
      // Anti-detection: delay our first DOM mutation past document_idle so we
      // don't hit LinkedIn's load-time mutation heuristics.
      setTimeout(() => {
        try { detectAndMount(); watchUrlChanges(); }
        catch (err) { console.error("[EmpleoAutomatico][LinkedIn]", err); }
      }, FAB_INJECT_DELAY_MS);
    } catch (err) { console.error("[EmpleoAutomatico][LinkedIn]", err); }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
