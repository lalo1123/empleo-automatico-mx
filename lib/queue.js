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
 */

export const QUEUE_STORAGE_KEY = "eamx:queue";
export const QUEUE_MAX = 50;

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
        resolve(Array.isArray(v) ? v : []);
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
  const normalized = {
    id: String(item.id),
    source: String(item.source),
    url: String(item.url || ""),
    title: String(item.title || ""),
    company: String(item.company || ""),
    location: item.location ? String(item.location) : undefined,
    savedAt: Number.isFinite(item.savedAt) ? Number(item.savedAt) : Date.now(),
    matchScore: Number.isFinite(item.matchScore) ? Math.max(0, Math.min(100, Math.round(item.matchScore))) : 0,
    reasons: Array.isArray(item.reasons) ? item.reasons.slice(0, 3).map(String) : []
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
