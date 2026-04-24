// Auth token + user management against chrome.storage.local.
//
// The JWT and the cached user record live inside the Settings object at
// STORAGE_KEYS.SETTINGS (see schemas.js). We don't use a separate top-level
// key for the token because readSettings already merges defaults and the
// worker/options/popup all consume Settings in one shot anyway.

import { STORAGE_KEYS, DEFAULT_SETTINGS } from "./schemas.js";

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

async function readSettings() {
  const s = await getRaw(STORAGE_KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

async function writeSettings(patch) {
  const current = await readSettings();
  const merged = { ...current, ...patch };
  await setRaw({ [STORAGE_KEYS.SETTINGS]: merged });
  return merged;
}

/**
 * @returns {Promise<string|null>} JWT or null if not logged in
 */
export async function getToken() {
  const s = await readSettings();
  return s.authToken || null;
}

/**
 * @param {string} token
 */
export async function setToken(token) {
  await writeSettings({ authToken: token || null });
}

/**
 * Clears the token and the cached user. Used on logout and on 401 from backend.
 */
export async function clearToken() {
  await writeSettings({ authToken: null, user: null });
}

/**
 * @returns {Promise<import('./schemas.js').AuthUser|null>}
 */
export async function getUser() {
  const s = await readSettings();
  return s.user || null;
}

/**
 * @param {import('./schemas.js').AuthUser|null} user
 */
export async function setUser(user) {
  await writeSettings({ user: user || null });
}

/**
 * @returns {Promise<boolean>}
 */
export async function isLoggedIn() {
  const t = await getToken();
  return !!t;
}
