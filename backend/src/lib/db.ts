// better-sqlite3 singleton + typed helpers. All queries use prepared statements.
// better-sqlite3 is SYNC (node-native) — this is fine for our workload and the
// single-container deployment model.

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { loadEnv, isAdminEmail } from "./env.js";
import type { AppEnv } from "./env.js";
import type {
  Application,
  ApplicationEvent,
  ApplicationRow,
  ApplicationSource,
  ApplicationStatus,
  ApplicationStep,
  BillingInterval,
  EmailVerificationRow,
  Modality,
  PlanId,
  PreferencesRow,
  SessionRow,
  SubscriptionRow,
  SubscriptionStatus,
  User,
  UserPreferences,
  UserRow
} from "../types.js";

let dbSingleton: DatabaseType | null = null;

export function getDb(): DatabaseType {
  if (dbSingleton) return dbSingleton;
  const env = loadEnv();
  const absPath = resolve(env.DATABASE_PATH);
  mkdirSync(dirname(absPath), { recursive: true });

  const db = new Database(absPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  dbSingleton = db;
  return db;
}

export function closeDb(): void {
  if (dbSingleton) {
    try {
      dbSingleton.close();
    } catch {
      /* ignore */
    }
    dbSingleton = null;
  }
}

// Sentinel stored in `users.password_hash` for accounts that only signed in
// via Google. Not a valid bcrypt hash, so verifyPassword() always returns
// false against it — protects the email/password login path from being used
// by Google-only accounts. See migrations/0003_google_oauth.sql.
export const GOOGLE_ONLY_PASSWORD_SENTINEL = "GOOGLE_ONLY";

export function rowToUser(row: UserRow, env?: AppEnv): User {
  // env is optional so legacy callers don't break — when absent we fall
  // back to loadEnv() (cached after first call). isAdmin is fully derived
  // from ADMIN_USER_EMAILS, never persisted.
  const e = env ?? loadEnv();
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    plan: row.plan,
    planExpiresAt: row.plan_expires_at,
    // Coerce 0/1 from SQLite into a real boolean for callers. Older rows
    // (pre-migration) will return 0 from the ADD COLUMN default.
    emailVerified: row.email_verified === 1,
    avatarUrl: row.avatar_url,
    isAdmin: isAdminEmail(e, row.email),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// USERS ---------------------------------------------------------------------

export function findUserByEmail(email: string): UserRow | null {
  const stmt = getDb().prepare<[string], UserRow>(
    "SELECT * FROM users WHERE email = ? LIMIT 1"
  );
  return stmt.get(email.toLowerCase()) ?? null;
}

export function findUserById(id: string): UserRow | null {
  const stmt = getDb().prepare<[string], UserRow>(
    "SELECT * FROM users WHERE id = ? LIMIT 1"
  );
  return stmt.get(id) ?? null;
}

export function createUser(data: {
  id: string;
  email: string;
  passwordHash: string;
  name: string | null;
  now: number;
}): UserRow {
  const { id, email, passwordHash, name, now } = data;
  getDb()
    .prepare(
      `INSERT INTO users (id, email, password_hash, name, plan, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'free', ?, ?)`
    )
    .run(id, email.toLowerCase(), passwordHash, name, now, now);
  const created = findUserById(id);
  if (!created) throw new Error("User inserted but not retrievable");
  return created;
}

export function updateUserPlan(
  userId: string,
  plan: PlanId,
  planExpiresAt: number | null
): void {
  getDb()
    .prepare(
      `UPDATE users SET plan = ?, plan_expires_at = ?, updated_at = ? WHERE id = ?`
    )
    .run(plan, planExpiresAt, Math.floor(Date.now() / 1000), userId);
}

/**
 * Admin helper — set the user's plan + expiry directly. No Conekta side
 * effects; webhook events still override this if a real subscription is
 * later activated. Reuses `updateUserPlan` so behavior stays identical to
 * the webhook-driven path.
 */
export function setUserPlan(
  userId: string,
  plan: PlanId,
  planExpiresAt: number | null
): void {
  updateUserPlan(userId, plan, planExpiresAt);
}

export function setConektaCustomerId(
  userId: string,
  conektaCustomerId: string
): void {
  getDb()
    .prepare(
      `UPDATE users SET conekta_customer_id = ?, updated_at = ? WHERE id = ?`
    )
    .run(conektaCustomerId, Math.floor(Date.now() / 1000), userId);
}

export function findUserByConektaCustomerId(
  conektaCustomerId: string
): UserRow | null {
  const stmt = getDb().prepare<[string], UserRow>(
    "SELECT * FROM users WHERE conekta_customer_id = ? LIMIT 1"
  );
  return stmt.get(conektaCustomerId) ?? null;
}

export function markUserEmailVerified(userId: string): void {
  getDb()
    .prepare(
      `UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?`
    )
    .run(Math.floor(Date.now() / 1000), userId);
}

// GOOGLE OAUTH --------------------------------------------------------------

/** Look up a user by their Google subject id. */
export function findUserByGoogleId(googleId: string): UserRow | null {
  const stmt = getDb().prepare<[string], UserRow>(
    "SELECT * FROM users WHERE google_id = ? LIMIT 1"
  );
  return stmt.get(googleId) ?? null;
}

/**
 * Link an existing user to a Google account. Sets `google_id`, marks the
 * email as verified (Google verified it for us), and updates `avatar_url`
 * if provided. Idempotent — safe to call when already linked.
 */
export function linkGoogleAccount(
  userId: string,
  googleId: string,
  avatarUrl: string | null
): void {
  const now = Math.floor(Date.now() / 1000);
  if (avatarUrl !== null) {
    getDb()
      .prepare(
        `UPDATE users
         SET google_id = ?, email_verified = 1, avatar_url = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(googleId, avatarUrl, now, userId);
  } else {
    getDb()
      .prepare(
        `UPDATE users
         SET google_id = ?, email_verified = 1, updated_at = ?
         WHERE id = ?`
      )
      .run(googleId, now, userId);
  }
}

/**
 * Create a passwordless user from a verified Google profile. The
 * `password_hash` column is filled with the GOOGLE_ONLY sentinel — see
 * migrations/0003_google_oauth.sql for why. `email_verified` is set to 1
 * because Google has already verified the email.
 */
export function createGoogleUser(data: {
  id: string;
  email: string;
  name: string | null;
  googleId: string;
  avatarUrl: string | null;
  now: number;
}): UserRow {
  const { id, email, name, googleId, avatarUrl, now } = data;
  getDb()
    .prepare(
      `INSERT INTO users
         (id, email, password_hash, name, plan, email_verified, google_id, avatar_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'free', 1, ?, ?, ?, ?)`
    )
    .run(
      id,
      email.toLowerCase(),
      GOOGLE_ONLY_PASSWORD_SENTINEL,
      name,
      googleId,
      avatarUrl,
      now,
      now
    );
  const created = findUserById(id);
  if (!created) throw new Error("Google user inserted but not retrievable");
  return created;
}

// EMAIL VERIFICATIONS -------------------------------------------------------

export function createEmailVerification(data: {
  token: string;
  userId: string;
  expiresAt: number;
  now: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO email_verifications (token, user_id, expires_at, consumed_at, created_at)
       VALUES (?, ?, ?, NULL, ?)`
    )
    .run(data.token, data.userId, data.expiresAt, data.now);
}

export function findEmailVerification(
  token: string
): EmailVerificationRow | null {
  const stmt = getDb().prepare<[string], EmailVerificationRow>(
    "SELECT * FROM email_verifications WHERE token = ? LIMIT 1"
  );
  return stmt.get(token) ?? null;
}

export function consumeEmailVerification(
  token: string,
  now: number
): void {
  getDb()
    .prepare(
      `UPDATE email_verifications SET consumed_at = ? WHERE token = ?`
    )
    .run(now, token);
}

/** Count non-consumed, non-expired tokens for rate-limiting resends. */
export function countActiveEmailVerifications(
  userId: string,
  now: number
): number {
  const stmt = getDb().prepare<[string, number], { c: number }>(
    `SELECT COUNT(*) as c FROM email_verifications
     WHERE user_id = ? AND consumed_at IS NULL AND expires_at > ?`
  );
  return stmt.get(userId, now)?.c ?? 0;
}

/** Invalidate all outstanding tokens for a user (e.g. on resend or consume). */
export function expireEmailVerifications(userId: string, now: number): void {
  getDb()
    .prepare(
      `UPDATE email_verifications SET expires_at = ?
       WHERE user_id = ? AND consumed_at IS NULL AND expires_at > ?`
    )
    .run(now - 1, userId, now);
}

// SESSIONS ------------------------------------------------------------------

export function createSession(data: {
  jti: string;
  userId: string;
  expiresAt: number;
  now: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (jti, user_id, expires_at, revoked, created_at)
       VALUES (?, ?, ?, 0, ?)`
    )
    .run(data.jti, data.userId, data.expiresAt, data.now);
}

export function findSession(jti: string): SessionRow | null {
  const stmt = getDb().prepare<[string], SessionRow>(
    "SELECT * FROM sessions WHERE jti = ? LIMIT 1"
  );
  return stmt.get(jti) ?? null;
}

export function revokeSession(jti: string): void {
  getDb()
    .prepare("UPDATE sessions SET revoked = 1 WHERE jti = ?")
    .run(jti);
}

// SUBSCRIPTIONS -------------------------------------------------------------

export function createSubscription(data: {
  id: string;
  userId: string;
  conektaSubscriptionId: string | null;
  plan: PlanId;
  interval: BillingInterval;
  status: SubscriptionStatus;
  now: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO subscriptions
         (id, user_id, conekta_subscription_id, plan, interval, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.id,
      data.userId,
      data.conektaSubscriptionId,
      data.plan,
      data.interval,
      data.status,
      data.now,
      data.now
    );
}

export function findSubscriptionByConektaId(
  conektaSubscriptionId: string
): SubscriptionRow | null {
  const stmt = getDb().prepare<[string], SubscriptionRow>(
    "SELECT * FROM subscriptions WHERE conekta_subscription_id = ? LIMIT 1"
  );
  return stmt.get(conektaSubscriptionId) ?? null;
}

export function findSubscriptionById(id: string): SubscriptionRow | null {
  const stmt = getDb().prepare<[string], SubscriptionRow>(
    "SELECT * FROM subscriptions WHERE id = ? LIMIT 1"
  );
  return stmt.get(id) ?? null;
}

export function findActiveSubscription(
  userId: string
): SubscriptionRow | null {
  const stmt = getDb().prepare<[string], SubscriptionRow>(
    `SELECT * FROM subscriptions
     WHERE user_id = ? AND status IN ('pending','active','paused')
     ORDER BY created_at DESC LIMIT 1`
  );
  return stmt.get(userId) ?? null;
}

export function updateSubscription(data: {
  id: string;
  status: SubscriptionStatus;
  currentPeriodEnd: number | null;
  willCancelAtPeriodEnd: number;
  conektaSubscriptionId?: string | null;
}): void {
  if (data.conektaSubscriptionId !== undefined) {
    getDb()
      .prepare(
        `UPDATE subscriptions
         SET status = ?, current_period_end = ?, will_cancel_at_period_end = ?,
             conekta_subscription_id = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        data.status,
        data.currentPeriodEnd,
        data.willCancelAtPeriodEnd,
        data.conektaSubscriptionId,
        Math.floor(Date.now() / 1000),
        data.id
      );
    return;
  }
  getDb()
    .prepare(
      `UPDATE subscriptions
       SET status = ?, current_period_end = ?, will_cancel_at_period_end = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      data.status,
      data.currentPeriodEnd,
      data.willCancelAtPeriodEnd,
      Math.floor(Date.now() / 1000),
      data.id
    );
}

// WEBHOOKS ------------------------------------------------------------------

export function recordWebhookEvent(data: {
  id: string;
  source: "conekta";
  eventType: string;
  payload: string;
  now: number;
}): boolean {
  // Returns true if the event is new (inserted), false if duplicate.
  try {
    getDb()
      .prepare(
        `INSERT INTO webhook_events (id, source, event_type, payload, processed, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`
      )
      .run(data.id, data.source, data.eventType, data.payload, data.now);
    return true;
  } catch {
    return false;
  }
}

export function markWebhookProcessed(id: string): void {
  getDb()
    .prepare("UPDATE webhook_events SET processed = 1 WHERE id = ?")
    .run(id);
}

// USAGE ---------------------------------------------------------------------

export function getUsageCount(userId: string, yearMonth: string): number {
  const stmt = getDb().prepare<[string, string], { count: number }>(
    "SELECT count FROM usage_monthly WHERE user_id = ? AND year_month = ? LIMIT 1"
  );
  return stmt.get(userId, yearMonth)?.count ?? 0;
}

export function incrementUsage(userId: string, yearMonth: string): number {
  getDb()
    .prepare(
      `INSERT INTO usage_monthly (user_id, year_month, count)
       VALUES (?, ?, 1)
       ON CONFLICT(user_id, year_month)
       DO UPDATE SET count = count + 1`
    )
    .run(userId, yearMonth);
  return getUsageCount(userId, yearMonth);
}

// DAILY USAGE ---------------------------------------------------------------
// Per-day counter (parallel to usage_monthly). See lib/plans.ts dailyLimit
// docs and migration 0004_usage_daily.sql for rationale.

export function getDailyUsageCount(userId: string, date: string): number {
  const stmt = getDb().prepare<[string, string], { count: number }>(
    "SELECT count FROM usage_daily WHERE user_id = ? AND date = ? LIMIT 1"
  );
  return stmt.get(userId, date)?.count ?? 0;
}

export function incrementDailyUsage(userId: string, date: string): number {
  getDb()
    .prepare(
      `INSERT INTO usage_daily (user_id, date, count)
       VALUES (?, ?, 1)
       ON CONFLICT(user_id, date)
       DO UPDATE SET count = count + 1`
    )
    .run(userId, date);
  return getDailyUsageCount(userId, date);
}

// Admin-only: force the monthly counter to an exact value. Used by the
// admin UI in the extension to test PLAN_LIMIT_EXCEEDED flows without
// having to actually exhaust the quota by sending real applications.
// Called from /v1/admin/me/usage. Non-admins never reach this code path
// (the route enforces the allowlist).
export function setUsageCount(userId: string, yearMonth: string, count: number): number {
  getDb()
    .prepare(
      `INSERT INTO usage_monthly (user_id, year_month, count)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, year_month)
       DO UPDATE SET count = excluded.count`
    )
    .run(userId, yearMonth, count);
  return getUsageCount(userId, yearMonth);
}

export function setDailyUsageCount(userId: string, date: string, count: number): number {
  getDb()
    .prepare(
      `INSERT INTO usage_daily (user_id, date, count)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, date)
       DO UPDATE SET count = excluded.count`
    )
    .run(userId, date, count);
  return getDailyUsageCount(userId, date);
}

// APPLICATIONS HISTORY -------------------------------------------------------
// Synced from the Chrome extension when the user finalizes a postulación
// (extension calls TRACK_APPLICATION → service worker → backend
// trackApplication → here). The web app reads them back via /account/historial.

const VALID_APPLICATION_SOURCES: ApplicationSource[] =
  ["lapieza", "occ", "computrabajo", "bumeran", "indeed", "linkedin"];
const VALID_APPLICATION_STATUS: ApplicationStatus[] =
  ["applied", "viewed", "rejected", "hired"];

export function isValidApplicationSource(s: unknown): s is ApplicationSource {
  return typeof s === "string" && (VALID_APPLICATION_SOURCES as string[]).includes(s);
}
export function isValidApplicationStatus(s: unknown): s is ApplicationStatus {
  return typeof s === "string" && (VALID_APPLICATION_STATUS as string[]).includes(s);
}

const VALID_STEPS: ApplicationStep[] = [
  "starting", "cv", "cv_personalized", "cover", "questions", "quiz",
  "ready", "submitted", "error", "plan_limit", "closed", "no_form",
  "already_applied"
];
export function isValidApplicationStep(s: unknown): s is ApplicationStep {
  return typeof s === "string" && (VALID_STEPS as string[]).includes(s);
}

function parseEvents(json: string | null | undefined): ApplicationEvent[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e) => e && typeof e === "object" && isValidApplicationStep((e as { step?: unknown }).step) && Number.isFinite((e as { at?: unknown }).at))
      .slice(-50) as ApplicationEvent[];
  } catch (_) { return []; }
}

/** Marshal a row to the API shape. */
export function rowToApplication(row: ApplicationRow): Application {
  let reasons: string[] = [];
  try {
    const parsed = JSON.parse(row.reasons_json || "[]");
    if (Array.isArray(parsed)) reasons = parsed.filter((r) => typeof r === "string");
  } catch (_) { /* keep [] */ }
  return {
    id: row.id,
    source: row.source,
    vacancyId: row.vacancy_id,
    url: row.url,
    title: row.title,
    company: row.company,
    location: row.location,
    matchScore: row.match_score,
    status: row.status,
    appliedAt: row.applied_at,
    sourceTs: row.source_ts,
    reasons,
    events: parseEvents(row.events_json)
  };
}

/**
 * Append a single event to an application's events_json array. Looks
 * the row up by (user_id, source, vacancy_id) — same composite key as
 * insertApplication.
 *
 * If the row doesn't exist yet AND the caller passed bootstrap data
 * (url/title/company/location/matchScore), creates the row first with
 * status="applied". This lets the extension report in-progress steps
 * (cv/cover/questions/quiz) before the user finalizes — the row
 * appears immediately in /account/historial showing "started, didn't
 * submit yet" timeline.
 *
 * Cap at 50 events per row to bound storage.
 */
export function appendApplicationEvent(input: {
  userId: string;
  source: ApplicationSource;
  vacancyId: string;
  step: ApplicationStep;
  label?: string;
  meta?: Record<string, unknown>;
  /** Bootstrap data — used to create the row if it doesn't exist. */
  bootstrap?: {
    url?: string;
    title?: string;
    company?: string;
    location?: string;
    matchScore?: number;
  };
}): boolean {
  let row = getDb()
    .prepare<[string, string, string], ApplicationRow>(
      `SELECT * FROM applications
       WHERE user_id = ? AND source = ? AND vacancy_id = ?
       LIMIT 1`
    )
    .get(input.userId, input.source, input.vacancyId);
  if (!row && input.bootstrap) {
    // Auto-create the row so subsequent events have somewhere to land.
    insertApplication({
      userId: input.userId,
      source: input.source,
      vacancyId: input.vacancyId,
      url: input.bootstrap.url ?? "",
      title: input.bootstrap.title ?? "",
      company: input.bootstrap.company ?? "",
      location: input.bootstrap.location ?? "",
      matchScore: input.bootstrap.matchScore ?? 0,
      status: "applied",
      reasons: []
    });
    row = getDb()
      .prepare<[string, string, string], ApplicationRow>(
        `SELECT * FROM applications
         WHERE user_id = ? AND source = ? AND vacancy_id = ?
         LIMIT 1`
      )
      .get(input.userId, input.source, input.vacancyId);
  }
  if (!row) return false;

  const events = parseEvents(row.events_json);
  // Idempotency: if the LAST event has the same step within the last
  // 5 seconds, skip — the extension fires reportBulkStatus many times
  // per step and we only want the first one per step.
  const nowSec = Math.floor(Date.now() / 1000);
  const last = events[events.length - 1];
  if (last && last.step === input.step && (nowSec - last.at) < 5) {
    return false;
  }
  const next: ApplicationEvent = {
    step: input.step,
    at: nowSec
  };
  if (input.label) next.label = String(input.label).slice(0, 120);
  if (input.meta && typeof input.meta === "object") {
    // Keep meta small — sanitize values to scalars only.
    const safeMeta: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input.meta)) {
      if (k.length > 32) continue;
      if (typeof v === "string") safeMeta[k] = v.slice(0, 200);
      else if (typeof v === "number" && Number.isFinite(v)) safeMeta[k] = v;
      else if (typeof v === "boolean") safeMeta[k] = v;
    }
    if (Object.keys(safeMeta).length) next.meta = safeMeta;
  }
  const trimmed = events.concat(next).slice(-50);

  getDb()
    .prepare(
      `UPDATE applications SET events_json = ?
       WHERE user_id = ? AND source = ? AND vacancy_id = ?`
    )
    .run(JSON.stringify(trimmed), input.userId, input.source, input.vacancyId);

  // When the step is "submitted" also bump the row's applied_at
  // forward so the historial sorts the user's actual submit moment
  // (not their original insertApplication call).
  if (input.step === "submitted") {
    getDb()
      .prepare(
        `UPDATE applications SET applied_at = ?, source_ts = ?
         WHERE user_id = ? AND source = ? AND vacancy_id = ?`
      )
      .run(nowSec, Date.now(), input.userId, input.source, input.vacancyId);
  }

  return true;
}

/**
 * Insert a new application row. ON CONFLICT (user_id, source, vacancy_id)
 * DO NOTHING — if the extension fires TRACK_APPLICATION twice for the same
 * vacancy (e.g. user re-opened the chain manually after auto-finalize), the
 * oldest insert wins and the timeline stays clean.
 *
 * Returns the existing or newly-inserted row.
 */
export function insertApplication(input: {
  userId: string;
  source: ApplicationSource;
  vacancyId: string;
  url?: string;
  title?: string;
  company?: string;
  location?: string;
  matchScore?: number;
  status?: ApplicationStatus;
  sourceTs?: number | null;
  reasons?: string[];
}): ApplicationRow {
  const nowSec = Math.floor(Date.now() / 1000);
  const reasonsJson = JSON.stringify(Array.isArray(input.reasons) ? input.reasons.slice(0, 20) : []);
  getDb()
    .prepare(
      `INSERT INTO applications
        (user_id, source, vacancy_id, url, title, company, location, match_score, status, applied_at, source_ts, reasons_json)
       VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, source, vacancy_id) DO NOTHING`
    )
    .run(
      input.userId,
      input.source,
      input.vacancyId,
      input.url ?? "",
      input.title ?? "",
      input.company ?? "",
      input.location ?? "",
      Math.max(0, Math.min(100, Number(input.matchScore ?? 0) | 0)),
      input.status ?? "applied",
      nowSec,
      input.sourceTs ?? null,
      reasonsJson
    );
  const row = getDb()
    .prepare<[string, string, string], ApplicationRow>(
      `SELECT * FROM applications
       WHERE user_id = ? AND source = ? AND vacancy_id = ?
       LIMIT 1`
    )
    .get(input.userId, input.source, input.vacancyId);
  if (!row) {
    // Should be unreachable — insert + ON CONFLICT then select can't race
    // because better-sqlite3 is sync. Defensive throw so a logic error is
    // surfaced loudly instead of silently returning a fake row.
    throw new Error("insertApplication: row vanished after upsert");
  }
  return row;
}

/**
 * List a user's applications, newest first, with optional filters.
 * Pagination is offset-based (simple, since result sets stay small for
 * individual users — months not years).
 */
export function listApplications(args: {
  userId: string;
  source?: ApplicationSource;
  status?: ApplicationStatus;
  /** Inclusive lower bound. Unix seconds. */
  fromTs?: number;
  /** Exclusive upper bound. Unix seconds. */
  toTs?: number;
  limit?: number;
  offset?: number;
}): ApplicationRow[] {
  const limit = Math.min(200, Math.max(1, args.limit ?? 50));
  const offset = Math.max(0, args.offset ?? 0);
  const where: string[] = ["user_id = ?"];
  const params: (string | number)[] = [args.userId];
  if (args.source) { where.push("source = ?"); params.push(args.source); }
  if (args.status) { where.push("status = ?"); params.push(args.status); }
  if (Number.isFinite(args.fromTs)) { where.push("applied_at >= ?"); params.push(args.fromTs!); }
  if (Number.isFinite(args.toTs))   { where.push("applied_at <  ?"); params.push(args.toTs!); }
  params.push(limit, offset);
  const sql = `
    SELECT * FROM applications
    WHERE ${where.join(" AND ")}
    ORDER BY applied_at DESC, id DESC
    LIMIT ? OFFSET ?
  `;
  return getDb().prepare(sql).all(...params) as ApplicationRow[];
}

export function countApplications(args: {
  userId: string;
  source?: ApplicationSource;
  status?: ApplicationStatus;
  fromTs?: number;
  toTs?: number;
}): number {
  const where: string[] = ["user_id = ?"];
  const params: (string | number)[] = [args.userId];
  if (args.source) { where.push("source = ?"); params.push(args.source); }
  if (args.status) { where.push("status = ?"); params.push(args.status); }
  if (Number.isFinite(args.fromTs)) { where.push("applied_at >= ?"); params.push(args.fromTs!); }
  if (Number.isFinite(args.toTs))   { where.push("applied_at <  ?"); params.push(args.toTs!); }
  const sql = `SELECT COUNT(*) AS n FROM applications WHERE ${where.join(" AND ")}`;
  const row = getDb().prepare(sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** Per-source counts for the user, used by dashboard stats. */
export function applicationCountsBySource(userId: string): Record<ApplicationSource, number> {
  const out: Record<ApplicationSource, number> = {
    lapieza: 0, occ: 0, computrabajo: 0, bumeran: 0, indeed: 0, linkedin: 0
  };
  const rows = getDb()
    .prepare<[string], { source: ApplicationSource; n: number }>(
      `SELECT source, COUNT(*) AS n FROM applications WHERE user_id = ? GROUP BY source`
    )
    .all(userId);
  for (const r of rows) {
    if (isValidApplicationSource(r.source)) out[r.source] = r.n;
  }
  return out;
}

// PREFERENCES ---------------------------------------------------------------
// Single row per user. The extension also keeps a local copy in
// chrome.storage.local["eamx:preferences"] for fast scoring without a
// network round-trip; the server row is the canonical truth and overrides
// the local cache on next /account fetch.

const VALID_MODALITY: Modality[] = ["presencial", "remoto", "hibrido", "any"];
export function isValidModality(m: unknown): m is Modality {
  return typeof m === "string" && (VALID_MODALITY as string[]).includes(m);
}

export function rowToPreferences(row: PreferencesRow): UserPreferences {
  let citySynonyms: string[] = [];
  try {
    const parsed = JSON.parse(row.city_synonyms || "[]");
    if (Array.isArray(parsed)) citySynonyms = parsed.filter((s) => typeof s === "string");
  } catch (_) { /* keep [] */ }
  return {
    city: row.city || "",
    citySynonyms,
    modality: isValidModality(row.modality) ? row.modality : "any",
    salaryMin: row.salary_min,
    salaryMax: row.salary_max,
    expectedSalary: row.expected_salary || "",
    updatedAt: row.updated_at
  };
}

/** Default preferences when no row exists yet — matches the extension's
 *  `defaultPreferences()` shape from lib/schemas.js. */
export function defaultPreferences(): UserPreferences {
  return {
    city: "",
    citySynonyms: [],
    modality: "any",
    salaryMin: null,
    salaryMax: null,
    expectedSalary: "",
    updatedAt: Math.floor(Date.now() / 1000)
  };
}

export function getPreferences(userId: string): UserPreferences {
  const row = getDb()
    .prepare<[string], PreferencesRow>(
      `SELECT * FROM preferences WHERE user_id = ? LIMIT 1`
    )
    .get(userId);
  if (!row) return defaultPreferences();
  return rowToPreferences(row);
}

export function upsertPreferences(input: {
  userId: string;
  city?: string;
  citySynonyms?: string[];
  modality?: Modality;
  salaryMin?: number | null;
  salaryMax?: number | null;
  expectedSalary?: string;
}): UserPreferences {
  const nowSec = Math.floor(Date.now() / 1000);
  const city = (input.city ?? "").slice(0, 100);
  const citySynonymsJson = JSON.stringify(
    Array.isArray(input.citySynonyms) ? input.citySynonyms.slice(0, 20) : []
  );
  const modality: Modality = isValidModality(input.modality) ? input.modality : "any";
  const salaryMin = Number.isFinite(input.salaryMin) ? Math.max(0, Math.min(10_000_000, input.salaryMin as number)) : null;
  const salaryMax = Number.isFinite(input.salaryMax) ? Math.max(0, Math.min(10_000_000, input.salaryMax as number)) : null;
  const expectedSalary = (input.expectedSalary ?? "").trim().slice(0, 120);

  getDb()
    .prepare(
      `INSERT INTO preferences (user_id, city, city_synonyms, modality, salary_min, salary_max, expected_salary, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         city = excluded.city,
         city_synonyms = excluded.city_synonyms,
         modality = excluded.modality,
         salary_min = excluded.salary_min,
         salary_max = excluded.salary_max,
         expected_salary = excluded.expected_salary,
         updated_at = excluded.updated_at`
    )
    .run(input.userId, city, citySynonymsJson, modality, salaryMin, salaryMax, expectedSalary, nowSec);

  return getPreferences(input.userId);
}
