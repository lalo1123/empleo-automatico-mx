-- Application history — synced from the Chrome extension's queueModule
-- when a user finalizes a postulación. Lets the web app surface a real
-- "Historial" view instead of relying on per-device chrome.storage.local.
--
-- Sources mirror the lib/queue.js SOURCE constants:
--   "lapieza" | "occ" | "computrabajo" | "bumeran" | "indeed" | "linkedin"
--
-- Status tracks the postulación lifecycle:
--   "applied"  → user clicked Finalizar (default for new rows)
--   "viewed"   → recruiter opened it (future: surfaced via portal API where possible)
--   "rejected" → final reject signal
--   "hired"    → final hire signal
--
-- The (user_id, source, vacancy_id) tuple is UNIQUE — if the user accidentally
-- re-fires the chain on a vacancy that's already tracked, we ON CONFLICT IGNORE
-- so the timeline stays clean (oldest wins).

CREATE TABLE IF NOT EXISTS applications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT    NOT NULL,
  source       TEXT    NOT NULL,                                 -- portal slug
  vacancy_id   TEXT    NOT NULL,                                 -- as returned by idFromUrl(...) per portal
  url          TEXT    NOT NULL DEFAULT '',
  title        TEXT    NOT NULL DEFAULT '',
  company      TEXT    NOT NULL DEFAULT '',
  location     TEXT    NOT NULL DEFAULT '',
  match_score  INTEGER NOT NULL DEFAULT 0,
  status       TEXT    NOT NULL DEFAULT 'applied',
  applied_at   INTEGER NOT NULL,                                 -- unix seconds (server-stamped)
  source_ts    INTEGER,                                          -- the savedAt the extension reports (ms) — optional
  reasons_json TEXT    NOT NULL DEFAULT '[]',                    -- the match reasons array as JSON

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (user_id, source, vacancy_id)
);

-- Common queries: list-by-user-paginated, count-by-month, group-by-source.
-- The PK index is already on (id); we add user_id + applied_at for the
-- "newest first" listing in /account/historial.
CREATE INDEX IF NOT EXISTS idx_applications_user_applied
  ON applications(user_id, applied_at DESC);

CREATE INDEX IF NOT EXISTS idx_applications_user_source
  ON applications(user_id, source);

CREATE INDEX IF NOT EXISTS idx_applications_user_status
  ON applications(user_id, status);
