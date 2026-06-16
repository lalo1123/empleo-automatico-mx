-- Per-user CV/profile store. Until now the structured CV (UserProfile) lived
-- ONLY in the extension's chrome.storage.local and was re-sent in every Gemini
-- request — the server never kept a copy. To make the WEB ACCOUNT the source
-- of truth for the CV (consistent with preferences), we persist one profile row
-- per user. parse-cv / build-profile upsert here after generating, and the
-- extension syncs it down via GET /account (mirror of how preferences sync).
--
-- profile_json holds the full UserProfile (personal/summary/experience/
-- education/skills/languages/rawText + version/updatedAt) serialized, the same
-- way personal_answers is stored as JSON in the preferences table.

CREATE TABLE IF NOT EXISTS profiles (
  user_id      TEXT NOT NULL PRIMARY KEY,
  profile_json TEXT NOT NULL DEFAULT '{}',
  updated_at   INTEGER NOT NULL,            -- unix seconds, server-stamped
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
