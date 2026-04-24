// better-sqlite3 singleton + typed helpers. All queries use prepared statements.
// better-sqlite3 is SYNC (node-native) — this is fine for our workload and the
// single-container deployment model.

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { loadEnv } from "./env.js";
import type {
  BillingInterval,
  PlanId,
  SessionRow,
  SubscriptionRow,
  SubscriptionStatus,
  User,
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

export function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    plan: row.plan,
    planExpiresAt: row.plan_expires_at,
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
