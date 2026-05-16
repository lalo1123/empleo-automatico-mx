/**
 * lib/queue.js — Discovery / pre-selection queue for vacancies the user
 * marked from listing pages.
 *
 * Storage key: chrome.storage.local["eamx:queue"] — an array of QueueItem.
 *
 * Design:
 *   - Cap at 50 entries, FIFO eviction (oldest savedAt drops). 50 is a
 *     deliberate compromise: enough to cover an intense weekend of LaPieza
 *     scrolling, small enough that we never blow chrome.storage.local's
 *     5MB-per-extension budget (each item is < 1KB).
 *   - Idempotent on (id, source) — adding the same vacancy twice is a no-op.
 *   - We use chrome.storage.local directly (not the background worker)
 *     because: (a) MV3 service worker round-trips add ~80ms latency, and
 *     (b) chrome.storage.onChanged gives us free cross-tab sync — the
 *     options page just listens for changes.
 *   - This file is loaded by the LaPieza content script via dynamic
 *     `import(chrome.runtime.getURL("lib/queue.js"))` (same pattern as
 *     lib/schemas.js — declared in web_accessible_resources). It's also
 *     directly importable from options.js.
 *
 * @typedef {Object} QueueItem
 * @property {string} id              vacancy id (UUID for LaPieza, hash for others)
 * @property {"lapieza"|"occ"|"computrabajo"|"bumeran"|"indeed"|"linkedin"} source
 * @property {string} url             full URL to the job-detail page
 * @property {string} title
 * @property {string} company
 * @property {string} [location]
 * @property {number} savedAt         Date.now() when added
 * @property {number} matchScore      0-100 from computeMatchScore()
 * @property {string[]} reasons       up to 3 entries from computeMatchScore
 * @property {string[]} [skillTags]   up to 3 skill tags shown as chips on the
 *                                    dashboard card. Derived from reasons or
 *                                    profile match at insert time.
 * @property {"comenzando"|"postulando_ahora"|"aplicada"} [status]
 *                                    HITL state machine. Default "comenzando".
 *                                    "aplicada" set by user clicking "✓ La envié".
 *                                    "postulando_ahora" set by content script
 *                                    when the user opens the vacancy page.
 * @property {number} [appliedAt]     Date.now() when status flipped to "aplicada"
 * @property {number} [lastOpenedAt]  Date.now() when content script saw the FAB
 *                                    fire (i.e. user is actively applying)
 */

export const QUEUE_STORAGE_KEY = "eamx:queue";
export const QUEUE_MAX = 50;

/**
 * Valid status values for QueueItem.status. Anything else is coerced to
 * "comenzando" on read (see normalizeStatus).
 */
export const QUEUE_STATUSES = Object.freeze(["comenzando", "postulando_ahora", "aplicada"]);

function normalizeStatus(s) {
  return QUEUE_STATUSES.includes(s) ? s : "comenzando";
}

/**
 * Backfill missing fields on legacy entries (pre-status-schema items) so
 * the dashboard never has to special-case undefined.status. We do this on
 * EVERY read — cheap (object spread, no storage write) and keeps the API
 * idempotent. The persistence-side migration only happens when something
 * actually mutates the item (markApplied, setStatus, etc.).
 */
function backfillItem(item) {
  if (!item || typeof item !== "object") return item;
  return {
    ...item,
    status: normalizeStatus(item.status),
    skillTags: Array.isArray(item.skillTags) ? item.skillTags.slice(0, 3).map(String) : []
  };
}

// ============================================================================
// Internal: storage shim that works both in MV3 content scripts and pages.
// All ops resolve gracefully if chrome.storage isn't available (tests, etc.).
// ============================================================================

function getStorage() {
  try {
    if (typeof chrome !== "undefined" && chrome?.storage?.local) return chrome.storage.local;
  } catch (_) {}
  return null;
}

function readQueue() {
  return new Promise((resolve) => {
    const storage = getStorage();
    if (!storage) { resolve([]); return; }
    try {
      storage.get([QUEUE_STORAGE_KEY], (res) => {
        const v = res && res[QUEUE_STORAGE_KEY];
        if (!Array.isArray(v)) { resolve([]); return; }
        // Apply backfill on read so legacy entries (pre-status schema) get
        // sensible defaults — without this, the dashboard's "qd-card--{status}"
        // class would render as "qd-card--undefined" for older items.
        resolve(v.map(backfillItem));
      });
    } catch (_) {
      resolve([]);
    }
  });
}

function writeQueue(queue) {
  return new Promise((resolve) => {
    const storage = getStorage();
    if (!storage) { resolve(); return; }
    try {
      storage.set({ [QUEUE_STORAGE_KEY]: queue }, () => resolve());
    } catch (_) {
      resolve();
    }
  });
}

function sameItem(a, b) {
  return a && b && a.id === b.id && a.source === b.source;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Read the full queue. Always returns an array (empty if unset/corrupt).
 * @returns {Promise<QueueItem[]>}
 */
export async function getQueue() {
  return readQueue();
}

/**
 * Add an item to the queue. Idempotent on (id, source) — if the item is
 * already there, the queue is returned unchanged (added=false). When the
 * cap is exceeded, the OLDEST item (smallest savedAt) is evicted.
 *
 * @param {QueueItem} item
 * @returns {Promise<{ added: boolean, queue: QueueItem[] }>}
 */
export async function addToQueue(item) {
  if (!item || !item.id || !item.source) return { added: false, queue: await readQueue() };
  const queue = await readQueue();
  const exists = queue.some((q) => sameItem(q, item));
  if (exists) return { added: false, queue };

  // Normalize the item we store. We trust the caller for matchScore/reasons
  // but coerce types defensively — corrupt entries break the options-page
  // render.
  const reasons = Array.isArray(item.reasons) ? item.reasons.slice(0, 3).map(String) : [];
  // Derive skillTags from the caller's reasons if they didn't supply explicit
  // tags. This keeps the dashboard non-empty without forcing every call site
  // (LaPieza onMarkClick + the matches panel "Marcar todas") to compute tags.
  const callerTags = Array.isArray(item.skillTags) ? item.skillTags.slice(0, 3).map(String) : null;
  const tags = (callerTags && callerTags.length)
    ? callerTags
    : deriveSkillTags(reasons, item.title);
  const normalized = {
    id: String(item.id),
    source: String(item.source),
    url: String(item.url || ""),
    title: String(item.title || ""),
    company: String(item.company || ""),
    location: item.location ? String(item.location) : undefined,
    savedAt: Number.isFinite(item.savedAt) ? Number(item.savedAt) : Date.now(),
    matchScore: Number.isFinite(item.matchScore) ? Math.max(0, Math.min(100, Math.round(item.matchScore))) : 0,
    reasons,
    skillTags: tags,
    // Default status when first added — content script bumps it to
    // "postulando_ahora" via touchOpened() when the user opens the vacancy.
    status: normalizeStatus(item.status) || "comenzando"
  };

  let next = queue.concat([normalized]);
  // FIFO eviction: drop oldest by savedAt until we're at the cap. We sort a
  // shallow copy so callers can keep their own ordering. The 50-item cap
  // matches the project comment in the queue spec.
  if (next.length > QUEUE_MAX) {
    next = next
      .slice()
      .sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0))
      .slice(next.length - QUEUE_MAX);
  }
  await writeQueue(next);
  return { added: true, queue: next };
}

/**
 * Remove an item by (id, source). No-op if it isn't there.
 * @param {string} id
 * @param {string} source
 * @returns {Promise<QueueItem[]>}
 */
export async function removeFromQueue(id, source) {
  if (!id || !source) return readQueue();
  const queue = await readQueue();
  const next = queue.filter((q) => !(q.id === id && q.source === source));
  if (next.length === queue.length) return queue;
  await writeQueue(next);
  return next;
}

/**
 * @param {string} id
 * @param {string} source
 * @returns {Promise<boolean>}
 */
export async function isInQueue(id, source) {
  if (!id || !source) return false;
  const queue = await readQueue();
  return queue.some((q) => q.id === id && q.source === source);
}

/**
 * Replace the queue wholesale. Used by the "Vaciar cola" button on the
 * options page; not part of the routine flow.
 * @param {QueueItem[]} queue
 * @returns {Promise<void>}
 */
export async function setQueue(queue) {
  const safe = Array.isArray(queue) ? queue : [];
  await writeQueue(safe);
}

// ============================================================================
// Status helpers — HITL state machine
// ============================================================================

/**
 * Find the matching item by (id, source) and apply a partial patch. Returns
 * the new queue array. No-op if the item isn't found. We always rewrite the
 * whole queue (cheap at N=50) so chrome.storage.onChanged listeners pick
 * the new state up everywhere.
 *
 * @param {string} id
 * @param {string} source
 * @param {(item: QueueItem) => QueueItem} patcher
 * @returns {Promise<QueueItem[]>}
 */
async function patchItem(id, source, patcher) {
  if (!id || !source || typeof patcher !== "function") return readQueue();
  const queue = await readQueue();
  let touched = false;
  const next = queue.map((q) => {
    if (q.id === id && q.source === source) {
      touched = true;
      const patched = patcher(q) || q;
      // Always re-apply backfill so the patcher can return partial objects.
      return backfillItem({ ...q, ...patched });
    }
    return q;
  });
  if (!touched) return queue;
  await writeQueue(next);
  return next;
}

/**
 * Mark a queue item as applied. Sets status="aplicada" and stamps appliedAt.
 * Idempotent: calling twice keeps the original appliedAt.
 *
 * @param {string} id
 * @param {string} source
 * @returns {Promise<QueueItem[]>}
 */
export async function markApplied(id, source) {
  return patchItem(id, source, (item) => ({
    status: "aplicada",
    appliedAt: Number.isFinite(item.appliedAt) ? item.appliedAt : Date.now()
  }));
}

/**
 * Add an item to the queue AND mark it as applied in one call. Used by the
 * chain when the user clicks Finalizar on a vacancy that was never starred —
 * we still want it in the "Postuladas" history so the matches panel can
 * show "✓ Ya postulada" on subsequent renders.
 *
 * If the item is already in the queue, just updates status/appliedAt.
 * If not, adds it with status="aplicada" from the start.
 *
 * @param {QueueItem} item
 * @returns {Promise<{queue: QueueItem[], wasNew: boolean}>}
 */
export async function upsertApplied(item) {
  if (!item || !item.id || !item.source) return { queue: await readQueue(), wasNew: false };
  const queue = await readQueue();
  const exists = queue.some((q) => sameItem(q, item));
  if (exists) {
    const next = await markApplied(item.id, item.source);
    return { queue: next, wasNew: false };
  }
  // Add fresh with status pre-set so we don't make two storage writes.
  await addToQueue({ ...item, status: "aplicada" });
  // addToQueue defaulted appliedAt to undefined — stamp it now.
  const next = await markApplied(item.id, item.source);
  return { queue: next, wasNew: true };
}

/**
 * Check if a vacancy has been applied to (status="aplicada" in queue).
 * Used by the matches panel to render "✓ Postulada" badges.
 *
 * @param {string} id
 * @param {string} source
 * @returns {Promise<boolean>}
 */
export async function isApplied(id, source) {
  if (!id || !source) return false;
  const queue = await readQueue();
  const item = queue.find((q) => q.id === String(id) && q.source === String(source));
  return !!(item && item.status === "aplicada");
}

/**
 * Bulk-fetch applied IDs for a given source — much cheaper than calling
 * isApplied() in a loop when rendering ~25 cards.
 *
 * @param {string} source
 * @returns {Promise<Set<string>>} Set of vacancy IDs marked as applied
 */
export async function appliedIdsForSource(source) {
  if (!source) return new Set();
  const queue = await readQueue();
  return new Set(
    queue
      .filter((q) => q.source === String(source) && q.status === "aplicada")
      .map((q) => String(q.id))
  );
}

/**
 * Set status explicitly. Coerces invalid values to "comenzando".
 *
 * @param {string} id
 * @param {string} source
 * @param {"comenzando"|"postulando_ahora"|"aplicada"} status
 * @returns {Promise<QueueItem[]>}
 */
export async function setStatus(id, source, status) {
  const next = normalizeStatus(status);
  return patchItem(id, source, (item) => {
    const patch = { status: next };
    // Stamp appliedAt the first time we flip to "aplicada".
    if (next === "aplicada" && !Number.isFinite(item.appliedAt)) {
      patch.appliedAt = Date.now();
    }
    return patch;
  });
}

/**
 * Update lastOpenedAt to "now". Called by the content script when the user
 * opens the vacancy page (or clicks the FAB) so the dashboard knows the
 * vacancy is actively being worked on. Also bumps status to
 * "postulando_ahora" UNLESS the item is already "aplicada" (don't regress
 * a finished application).
 *
 * @param {string} id
 * @param {string} source
 * @returns {Promise<QueueItem[]>}
 */
export async function touchOpened(id, source) {
  return patchItem(id, source, (item) => {
    const patch = { lastOpenedAt: Date.now() };
    if (item.status !== "aplicada") {
      patch.status = "postulando_ahora";
    }
    return patch;
  });
}

/**
 * Count queue items where appliedAt is in the current calendar month
 * (local time). Used by the dashboard counter pill — "{N} en cola · {M}
 * este mes". We use local time deliberately: the user expects "this month"
 * to mean their wall clock, not UTC.
 *
 * @param {QueueItem[]} queue
 * @returns {number}
 */
export function appliedThisMonth(queue) {
  if (!Array.isArray(queue) || !queue.length) return 0;
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  let count = 0;
  for (const item of queue) {
    if (!item || item.status !== "aplicada") continue;
    const t = item.appliedAt;
    if (!Number.isFinite(t)) continue;
    const d = new Date(t);
    if (d.getFullYear() === year && d.getMonth() === month) count++;
  }
  return count;
}

// ============================================================================
// Skill tag derivation
// ============================================================================

const SKILL_TAG_MAX_LEN = 24;
const SKILL_TAG_LIMIT = 3;
// Role suffixes / common job-title noise we drop when falling back to tokens
// from the title. Lowercase, accent-stripped.
const TITLE_FILLER = new Set([
  "senior", "junior", "ssr", "sr", "jr", "ii", "iii", "lead", "principal",
  "de", "del", "la", "el", "los", "las", "y", "para", "con", "sin", "un", "una",
  "mid", "level", "i", "ingeniero", "ingeniera", "analista", "desarrollador",
  "desarrolladora", "gerente", "director", "directora", "coordinador",
  "coordinadora", "asistente", "ejecutivo", "ejecutiva", "especialista"
]);

function stripAccents(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function clipTag(tag) {
  const trimmed = String(tag || "").trim();
  if (!trimmed) return "";
  if (trimmed.length <= SKILL_TAG_MAX_LEN) return trimmed;
  return trimmed.slice(0, SKILL_TAG_MAX_LEN - 1).trimEnd() + "…";
}

/**
 * Derive up to 3 skill chips from match-score reasons + the job title.
 * Order of preference:
 *   1. "X skills coinciden: A, B, C" → ["A","B","C"]
 *   2. "Tu experiencia incluye: X, Y" → ["X","Y"]
 *   3. Top 2 non-filler tokens from the title.
 *
 * @param {string[]} reasons
 * @param {string} [title]
 * @returns {string[]}
 */
export function deriveSkillTags(reasons, title) {
  const tags = [];
  const seen = new Set();
  const push = (raw) => {
    const t = clipTag(raw);
    if (!t) return;
    const k = stripAccents(t).toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    tags.push(t);
  };

  // Pass 1 — explicit "skills coinciden" line. The reason format from
  // lib/match-score.js is: "{N} skill[s] coinciden: A, B, C".
  for (const reason of (Array.isArray(reasons) ? reasons : [])) {
    if (tags.length >= SKILL_TAG_LIMIT) break;
    if (typeof reason !== "string") continue;
    const m = /skills?\s+coinciden\s*:\s*(.+)$/i.exec(reason);
    if (!m) continue;
    const list = m[1].split(/[,;·]+/).map((s) => s.trim()).filter(Boolean);
    for (const s of list) {
      if (tags.length >= SKILL_TAG_LIMIT) break;
      push(s);
    }
  }

  // Pass 2 — "Tu experiencia incluye: X, Y".
  if (tags.length < SKILL_TAG_LIMIT) {
    for (const reason of (Array.isArray(reasons) ? reasons : [])) {
      if (tags.length >= SKILL_TAG_LIMIT) break;
      if (typeof reason !== "string") continue;
      const m = /experiencia\s+incluye\s*:\s*(.+)$/i.exec(reason);
      if (!m) continue;
      const list = m[1].split(/[,;·]+/).map((s) => s.trim()).filter(Boolean);
      for (const s of list) {
        if (tags.length >= SKILL_TAG_LIMIT) break;
        push(s);
      }
    }
  }

  // Pass 3 — fall back to the top non-filler tokens from the title. We cap
  // this at 2 (not 3) because title tokens are weaker signals than explicit
  // skill matches; 1-2 is enough to give the card visual weight.
  if (!tags.length && title) {
    const tokens = String(title)
      .replace(/\(.+?\)/g, " ")
      .split(/[\s\/,\-]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    for (const tok of tokens) {
      if (tags.length >= 2) break;
      const norm = stripAccents(tok).toLowerCase();
      if (!norm || TITLE_FILLER.has(norm) || norm.length < 2) continue;
      push(tok);
    }
  }

  return tags;
}
