-- Separate daily counter for the "Match real con IA" analyses.
--
-- Kept apart from usage_daily/usage_monthly (the postulaciones quota) ON
-- PURPOSE: analyzing a vacancy's match must NOT eat into the user's monthly
-- postulaciones, and the two have different per-plan limits
-- (plans.ts matchAnalysisDailyLimit). Mirrors 0004_usage_daily.sql.

CREATE TABLE IF NOT EXISTS usage_match_daily (
  user_id TEXT NOT NULL,
  date    TEXT NOT NULL,            -- 'YYYY-MM-DD' UTC
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_usage_match_daily_user_date
  ON usage_match_daily(user_id, date);
