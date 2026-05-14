// Plan definitions — pricing and monthly quotas.
// Prices are reference only; actual charging is driven by Conekta plans
// configured in the Conekta dashboard. IDs come from env.

import type { AppEnv } from "./env.js";
import type { BillingInterval, PlanId } from "../types.js";

export interface PlanDefinition {
  id: PlanId;
  name: string;
  monthlyLimit: number;   // -1 means unlimited
  softCap: number;        // Hard ceiling to protect against abuse, even on unlimited.
  /**
   * Daily cap — protects against same-day burst usage that could blow our
   * Gemini cost budget on the "unlimited" plan. Free/Pro typically use
   * their monthlyLimit as the effective ceiling; Premium needs a per-day
   * brake because monthlyLimit is high (500) and 100 postulaciones in a
   * single day would push margin below 30%.
   *
   * -1 means no daily cap (defaults to monthlyLimit / day-of-month or
   * effectively infinite for the free/pro plans where monthlyLimit
   * already caps daily implicitly).
   */
  dailyLimit: number;
  priceMxn: {
    monthly: number;
    yearly: number;
  };
}

export const PLANS: Record<PlanId, PlanDefinition> = {
  free: {
    id: "free",
    name: "Gratis",
    monthlyLimit: 3,
    softCap: 3,
    dailyLimit: -1,
    priceMxn: { monthly: 0, yearly: 0 }
  },
  pro: {
    id: "pro",
    name: "Pro",
    monthlyLimit: 100,
    softCap: 100,
    dailyLimit: -1,   // monthlyLimit/100 effectively caps daily
    priceMxn: { monthly: 299, yearly: 2990 }
  },
  premium: {
    id: "premium",
    name: "Premium",
    monthlyLimit: 500,    // Spec says "unlimited", protected by soft cap.
    softCap: 500,
    // 30/día × 30 días = 900 absolute max, but the monthly soft cap of
    // 500 binds first. The daily cap stops same-day bursts (e.g. user
    // running 200 postulaciones in 2h) that would slam the Gemini budget.
    dailyLimit: 30,
    priceMxn: { monthly: 499, yearly: 4990 }
  }
};

export function getPlan(id: PlanId): PlanDefinition {
  return PLANS[id];
}

/**
 * Returns the Conekta plan_id for a plan/interval combo.
 * IDs are defined in the Conekta dashboard and injected via env.
 */
export function getConektaPlanId(
  env: AppEnv,
  plan: Exclude<PlanId, "free">,
  interval: BillingInterval
): string {
  if (plan === "pro" && interval === "monthly") return env.CONEKTA_PLAN_PRO_MONTHLY;
  if (plan === "pro" && interval === "yearly") return env.CONEKTA_PLAN_PRO_YEARLY;
  if (plan === "premium" && interval === "monthly") return env.CONEKTA_PLAN_PREMIUM_MONTHLY;
  if (plan === "premium" && interval === "yearly") return env.CONEKTA_PLAN_PREMIUM_YEARLY;
  return "";
}

export function getPrice(plan: PlanId, interval: BillingInterval): number {
  return PLANS[plan].priceMxn[interval];
}
