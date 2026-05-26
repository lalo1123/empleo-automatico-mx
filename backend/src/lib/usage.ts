// Monthly + daily usage metering.
//
// usage_monthly  → (user_id, year_month) → count        (Plan quota enforcement)
// usage_daily    → (user_id, date)       → count        (Anti-abuse daily cap)
//
// Both counters are incremented atomically on each chargeable operation.
// The daily counter is only ENFORCED when the user's plan defines
// dailyLimit > 0 (currently only Premium = 30/day). See lib/plans.ts.

import { getPlan } from "./plans.js";
import { HttpError } from "./errors.js";
import {
  getUsageCount as dbGetUsageCount,
  incrementUsage as dbIncrementUsage,
  getDailyUsageCount as dbGetDailyUsageCount,
  incrementDailyUsage as dbIncrementDailyUsage,
  getDb
} from "./db.js";
import type { PlanId } from "../types.js";

export function currentYearMonth(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export function currentDate(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function currentPeriodBounds(now: Date = new Date()): {
  periodStart: number;
  periodEnd: number;
} {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const start = Date.UTC(y, m, 1, 0, 0, 0, 0);
  const end = Date.UTC(y, m + 1, 1, 0, 0, 0, 0);
  return {
    periodStart: Math.floor(start / 1000),
    periodEnd: Math.floor(end / 1000)
  };
}

export function getUsageCount(userId: string, yearMonth: string): number {
  return dbGetUsageCount(userId, yearMonth);
}

/**
 * Throws PLAN_LIMIT_EXCEEDED (402) if the user is at or over EITHER:
 *   - their monthly plan limit, OR
 *   - their plan's daily cap (when defined; currently Premium = 30/day)
 *
 * Returns the current monthly count (pre-increment) on success.
 *
 * The two checks have different user-facing messages so the UI can
 * branch: "limite mensual" vs "limite diario, vuelve mañana".
 */
export function assertUnderLimit(userId: string, plan: PlanId): number {
  const planDef = getPlan(plan);

  // Monthly check (existing behavior).
  const yearMonth = currentYearMonth();
  const monthlyCount = dbGetUsageCount(userId, yearMonth);
  if (planDef.monthlyLimit >= 0 && monthlyCount >= planDef.monthlyLimit) {
    throw new HttpError(
      402,
      "PLAN_LIMIT_EXCEEDED",
      "Llegaste al limite de tu plan este mes. Mejora tu plan para continuar."
    );
  }

  // Daily check (new for Premium). dailyLimit < 0 means "no daily brake".
  if (planDef.dailyLimit > 0) {
    const today = currentDate();
    const dailyCount = dbGetDailyUsageCount(userId, today);
    if (dailyCount >= planDef.dailyLimit) {
      throw new HttpError(
        402,
        "DAILY_LIMIT_EXCEEDED",
        `Llegaste al limite diario de tu plan (${planDef.dailyLimit} postulaciones/dia). Continua mañana — es una proteccion para tu cuenta en los portales.`
      );
    }
  }

  return monthlyCount;
}

/**
 * Atomic increment of BOTH counters. Returns the new monthly count
 * (preserving prior callers' contract). The daily increment is a side
 * effect — callers don't need to know the daily count to satisfy any
 * existing API surface.
 */
export function incrementUsage(userId: string): number {
  const yearMonth = currentYearMonth();
  const date = currentDate();
  dbIncrementDailyUsage(userId, date);
  return dbIncrementUsage(userId, yearMonth);
}

/**
 * Atomic "reserve a usage slot" — combines assertUnderLimit + increment
 * in a single SQLite transaction so parallel requests can't bypass the
 * limit by racing between the read (assertUnderLimit) and the write
 * (incrementUsage) when an async Gemini call sits between them.
 *
 * Returns the new monthly count after the increment. Throws 402
 * PLAN_LIMIT_EXCEEDED or DAILY_LIMIT_EXCEEDED if the slot can't be
 * reserved.
 *
 * If the Gemini call FAILS after this returns, the caller should call
 * `refundUsageSlot(userId)` to decrement the counter. Otherwise the
 * user is charged for a request that produced no value.
 */
export function reserveUsageSlot(userId: string, plan: PlanId): number {
  const planDef = getPlan(plan);
  const yearMonth = currentYearMonth();
  const date = currentDate();
  const db = getDb();

  // better-sqlite3 transactions are sync — the entire body runs under
  // SQLite's BEGIN IMMEDIATE write lock, so no other request can read
  // a stale count and re-increment between our check and write.
  const tx = db.transaction(() => {
    const monthlyCount = dbGetUsageCount(userId, yearMonth);
    if (planDef.monthlyLimit >= 0 && monthlyCount >= planDef.monthlyLimit) {
      throw new HttpError(
        402,
        "PLAN_LIMIT_EXCEEDED",
        "Llegaste al limite de tu plan este mes. Mejora tu plan para continuar."
      );
    }
    if (planDef.dailyLimit > 0) {
      const dailyCount = dbGetDailyUsageCount(userId, date);
      if (dailyCount >= planDef.dailyLimit) {
        throw new HttpError(
          402,
          "DAILY_LIMIT_EXCEEDED",
          `Llegaste al limite diario de tu plan (${planDef.dailyLimit} postulaciones/dia). Continua mañana — es una proteccion para tu cuenta en los portales.`
        );
      }
    }
    dbIncrementDailyUsage(userId, date);
    return dbIncrementUsage(userId, yearMonth);
  });

  return tx();
}

/**
 * Decrement both counters when a previously-reserved slot didn't
 * actually consume any Gemini work (e.g. Gemini call failed).
 * Best-effort — if the row doesn't exist we silently no-op.
 */
export function refundUsageSlot(userId: string): void {
  const yearMonth = currentYearMonth();
  const date = currentDate();
  const db = getDb();
  try {
    db.transaction(() => {
      db.prepare(
        `UPDATE usage_monthly SET count = MAX(0, count - 1)
         WHERE user_id = ? AND year_month = ?`
      ).run(userId, yearMonth);
      db.prepare(
        `UPDATE usage_daily SET count = MAX(0, count - 1)
         WHERE user_id = ? AND date = ?`
      ).run(userId, date);
    })();
  } catch (_) { /* swallow — best-effort */ }
}
