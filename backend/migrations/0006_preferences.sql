-- User preferences (city / modality / salary range) — moved from the
-- extension's chrome.storage.local into the backend so the web app can
-- show them on /account/preferences and so they sync across devices
-- when the user reinstalls the extension.
--
-- Stored as a single row per user. JSON shape mirrors the UserPreferences
-- typedef in lib/schemas.js (extension). Field names are kept identical
-- (camelCase in JSON, snake_case in column for SQLite convention).
--
-- city_synonyms is a JSON array of strings — variants of `city` computed
-- on the client when the canonical city is set (e.g. "CDMX" → ["Ciudad
-- de México", "DF", "Distrito Federal"]).

CREATE TABLE IF NOT EXISTS preferences (
  user_id        TEXT    NOT NULL PRIMARY KEY,
  city           TEXT    NOT NULL DEFAULT '',
  city_synonyms  TEXT    NOT NULL DEFAULT '[]',           -- JSON array
  modality       TEXT    NOT NULL DEFAULT 'any',          -- presencial|remoto|hibrido|any
  salary_min     INTEGER,                                 -- nullable, MXN/month
  salary_max     INTEGER,                                 -- nullable, MXN/month
  updated_at     INTEGER NOT NULL,                        -- unix seconds

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
