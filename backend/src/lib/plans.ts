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
    priceMxn: { monthly: 0, yearly: 0 }
  },
  pro: {
    id: "pro",
    name: "Pro",
    monthlyLimit: 100,
    softCap: 100,
    priceMxn: { monthly: 199, yearly: 1990 }
  },
  premium: {
    id: "premium",
    name: "Premium",
    monthlyLimit: 500,    // Spec says "unlimited", protected by soft cap.
    softCap: 500,
    priceMxn: { monthly: 399, yearly: 3990 }
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
