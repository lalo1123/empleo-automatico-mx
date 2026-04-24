// Storage wrapper over chrome.storage.local.
// All reads return defaults when storage is empty; writes are awaited.

import {
  STORAGE_KEYS,
  DEFAULT_SETTINGS
} from "./schemas.js";

/**
 * Promise-based wrapper around chrome.storage.local.get for a single key.
 * @param {string} key
 * @returns {Promise<any>}
 */
function getRaw(key) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.get([key], (result) => {
        const err = chrome.runtime && chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        resolve(result ? result[key] : undefined);
      });
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Promise-based wrapper around chrome.storage.local.set.
 * @param {Record<string, any>} obj
 * @returns {Promise<void>}
 */
function setRaw(obj) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set(obj, () => {
        const err = chrome.runtime && chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        resolve();
      });
    } catch (e) {
      reject(e);
    }
  });
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export async function getProfile() {
  const p = await getRaw(STORAGE_KEYS.PROFILE);
  return p || null;
}

export async function setProfile(profile) {
  await setRaw({ [STORAGE_KEYS.PROFILE]: profile });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSettings() {
  const s = await getRaw(STORAGE_KEYS.SETTINGS);
  // Merge with defaults so new fields added later don't break old installs.
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

export async function setSettings(patch) {
  const current = await getSettings();
  const merged = { ...current, ...(patch || {}) };
  await setRaw({ [STORAGE_KEYS.SETTINGS]: merged });
}

// ---------------------------------------------------------------------------
// Drafts (stored as an array under STORAGE_KEYS.DRAFTS + a pointer)
// ---------------------------------------------------------------------------

export async function getDrafts() {
  const d = await getRaw(STORAGE_KEYS.DRAFTS);
  return Array.isArray(d) ? d : [];
}

export async function addDraft(draft) {
  const drafts = await getDrafts();
  drafts.push(draft);
  await setRaw({
    [STORAGE_KEYS.DRAFTS]: drafts,
    [STORAGE_KEYS.ACTIVE_DRAFT_ID]: draft.id
  });
}

export async function updateDraft(id, patch) {
  const drafts = await getDrafts();
  const idx = drafts.findIndex((d) => d.id === id);
  if (idx === -1) return;
  drafts[idx] = { ...drafts[idx], ...patch };
  await setRaw({ [STORAGE_KEYS.DRAFTS]: drafts });
}

export async function getDraft(id) {
  const drafts = await getDrafts();
  return drafts.find((d) => d.id === id) || null;
}

export async function removeDraft(id) {
  const drafts = await getDrafts();
  const filtered = drafts.filter((d) => d.id !== id);
  const activeId = await getRaw(STORAGE_KEYS.ACTIVE_DRAFT_ID);
  const updates = { [STORAGE_KEYS.DRAFTS]: filtered };
  if (activeId === id) {
    updates[STORAGE_KEYS.ACTIVE_DRAFT_ID] = null;
  }
  await setRaw(updates);
}

// ---------------------------------------------------------------------------
// Active draft pointer
// ---------------------------------------------------------------------------

export async function getActiveDraftId() {
  const id = await getRaw(STORAGE_KEYS.ACTIVE_DRAFT_ID);
  return id || null;
}

export async function setActiveDraftId(id) {
  await setRaw({ [STORAGE_KEYS.ACTIVE_DRAFT_ID]: id });
}

export async function getActiveDraft() {
  const id = await getActiveDraftId();
  if (!id) return null;
  return getDraft(id);
}
