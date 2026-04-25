-- Empleo Automatico MX - Google OAuth (Sign-In with Google).
--
-- Adds the Google account linkage columns to `users` plus a sentinel
-- mechanism for password-less accounts. Original `password_hash` was
-- declared NOT NULL — to keep schema migrations cheap on SQLite (which
-- can't easily ALTER a NOT NULL constraint), Google-only accounts get a
-- non-bcrypt sentinel string in `password_hash`. The login path will
-- never authenticate it because verifyPassword() runs bcrypt.compare()
-- against a real bcrypt hash, and the sentinel is not a valid hash.
--
-- Sentinel constant: "GOOGLE_ONLY" (see backend/src/lib/db.ts).

ALTER TABLE users ADD COLUMN google_id TEXT;
ALTER TABLE users ADD COLUMN avatar_url TEXT;

-- Partial unique index: enforce one Google account == one user, but allow
-- many rows with NULL google_id (the email/password users).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id
  ON users(google_id) WHERE google_id IS NOT NULL;
