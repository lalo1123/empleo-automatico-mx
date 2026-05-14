-- Per-day usage counter, parallel to usage_monthly.
--
-- Why: Premium plan's monthlyLimit (500) is high. Without a per-day brake
-- a power-user could burn 200 postulaciones in one afternoon — each one
-- triggering Gemini calls (cover + tailored CV + Q&A + auto-quiz). That
-- breaks our cost projections.
--
-- A daily cap is enforced in assertUnderLimit (lib/usage.ts) using this
-- table. Free/Pro plans have dailyLimit=-1 so the check is a no-op for
-- them — the monthlyLimit already caps their daily burn implicitly.
--
-- Date key format: 'YYYY-MM-DD' in UTC. Idempotent.

CREATE TABLE IF NOT EXISTS usage_daily (
  user_id TEXT    NOT NULL,
  date    TEXT    NOT NULL,                                   -- 'YYYY-MM-DD' in UTC
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_usage_daily_user_date ON usage_daily(user_id, date);
