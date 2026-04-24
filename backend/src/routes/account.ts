// /v1/account - returns current user + usage summary.

import { Hono } from "hono";
import type { AppContext } from "../lib/env.js";
import { sendError } from "../lib/errors.js";
import { authRequired } from "../middleware/auth.js";
import { currentPeriodBounds, currentYearMonth, getUsageCount } from "../lib/usage.js";
import { getPlan } from "../lib/plans.js";

export const accountRoutes = new Hono<AppContext>();

accountRoutes.get("/", authRequired(), async (c) => {
  try {
    const user = c.get("user");
    const yearMonth = currentYearMonth();
    const current = getUsageCount(user.id, yearMonth);
    const { periodStart, periodEnd } = currentPeriodBounds();
    const plan = getPlan(user.plan);

    return c.json({
      ok: true,
      user,
      usage: {
        current,
        limit: plan.monthlyLimit,
        periodStart,
        periodEnd
      }
    });
  } catch (err) {
    return sendError(c, err);
  }
});
