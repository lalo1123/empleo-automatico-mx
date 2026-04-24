-- Empleo Automatico MX - initial schema.
-- SQLite (better-sqlite3). All timestamps are unix seconds (INTEGER).

CREATE TABLE IF NOT EXISTS users (
  id                  TEXT    PRIMARY KEY,
  email               TEXT    NOT NULL UNIQUE,
  password_hash       TEXT    NOT NULL,
  name                TEXT,
  plan                TEXT    NOT NULL DEFAULT 'free',      -- 'free' | 'pro' | 'premium'
  plan_expires_at     INTEGER,
  conekta_customer_id TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_conekta_customer ON users(conekta_customer_id);

CREATE TABLE IF NOT EXISTS sessions (
  jti         TEXT    PRIMARY KEY,
  user_id     TEXT    NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                        TEXT    PRIMARY KEY,
  user_id                   TEXT    NOT NULL,
  conekta_subscription_id   TEXT    UNIQUE,
  plan                      TEXT    NOT NULL,               -- 'pro' | 'premium'
  interval                  TEXT    NOT NULL,               -- 'monthly' | 'yearly'
  status                    TEXT    NOT NULL,               -- 'pending' | 'active' | 'paused' | 'cancelled' | 'expired'
  current_period_end        INTEGER,
  will_cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_conekta ON subscriptions(conekta_subscription_id);

CREATE TABLE IF NOT EXISTS usage_monthly (
  user_id    TEXT    NOT NULL,
  year_month TEXT    NOT NULL,                               -- 'YYYY-MM' in UTC
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, year_month),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id          TEXT    PRIMARY KEY,                           -- provider-supplied id for idempotency
  source      TEXT    NOT NULL,                              -- 'conekta'
  event_type  TEXT,
  payload     TEXT    NOT NULL,                              -- JSON string
  processed   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_source ON webhook_events(source);
