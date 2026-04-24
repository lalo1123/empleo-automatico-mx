// Monthly usage metering. One row per (user_id, year_month).

import { getPlan } from "./plans.js";
import { HttpError } from "./errors.js";
import {
  getUsageCount as dbGetUsageCount,
  incrementUsage as dbIncrementUsage
} from "./db.js";
import type { PlanId } from "../types.js";

export function currentYearMonth(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
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
 * Throws PLAN_LIMIT_EXCEEDED (402) if the user is at or over their quota.
 * Returns the current count (pre-increment) on success.
 */
export function assertUnderLimit(userId: string, plan: PlanId): number {
  const yearMonth = currentYearMonth();
  const count = dbGetUsageCount(userId, yearMonth);
  const limit = getPlan(plan).monthlyLimit;
  if (limit >= 0 && count >= limit) {
    throw new HttpError(
      402,
      "PLAN_LIMIT_EXCEEDED",
      "Llegaste al limite de tu plan este mes. Mejora tu plan para continuar."
    );
  }
  return count;
}

/**
 * Atomic increment via UPSERT. Returns the new count.
 */
export function incrementUsage(userId: string): number {
  const yearMonth = currentYearMonth();
  return dbIncrementUsage(userId, yearMonth);
}
