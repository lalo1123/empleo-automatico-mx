-- Empleo Automatico MX - email verification.
-- Adds an `email_verified` flag to users and a table to track verification
-- tokens. For MVP the token is surfaced to the user directly (no email yet);
-- once Resend/SES is wired in, the same table is reused by the mailer.

ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS email_verifications (
  token        TEXT    PRIMARY KEY,
  user_id      TEXT    NOT NULL,
  expires_at   INTEGER NOT NULL,
  consumed_at  INTEGER,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON email_verifications(user_id);
