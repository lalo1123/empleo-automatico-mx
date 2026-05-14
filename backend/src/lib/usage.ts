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
  incrementDailyUsage as dbIncrementDailyUsage
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
