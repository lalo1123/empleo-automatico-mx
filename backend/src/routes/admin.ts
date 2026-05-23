// /v1/admin/* - admin-only routes for the product owner.
//
// Currently exposes a single endpoint to switch the caller's own plan
// without going through Conekta. Used to test how the extension behaves
// across Free / Pro / Premium tiers without paying.
//
// Auth: standard JWT (authRequired) PLUS the user's email must appear in
// ADMIN_USER_EMAILS. Non-admins get FORBIDDEN.

import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../lib/env.js";
import { isAdminEmail, loadEnv } from "../lib/env.js";
import { HttpError, sendError } from "../lib/errors.js";
import { authRequired } from "../middleware/auth.js";
import {
  findUserById,
  rowToUser,
  setUserPlan,
  setUsageCount,
  setDailyUsageCount
} from "../lib/db.js";
import { getPlan } from "../lib/plans.js";
import { currentYearMonth, currentDate } from "../lib/usage.js";

// Body schema: just the target plan. We don't accept arbitrary expiry —
// admin overrides default to "now + 30 days" so the test session doesn't
// silently expire mid-poke. Free plans have no expiry (null).
const setPlanSchema = z.object({
  plan: z.enum(["free", "pro", "premium"])
});

// Body schema for the usage manipulation endpoint. "zero" resets both
// counters to 0 (so the user can keep testing); "max" sets the monthly
// counter to one MORE than the plan's monthlyLimit (so the next AI call
// throws PLAN_LIMIT_EXCEEDED immediately — perfect for testing the
// plan-limit modal without spending real quota). Premium plans (which
// have monthlyLimit === -1, unlimited) get monthlyCount = 99999 when
// asked for "max" so the daily cap path can also be exercised.
const setUsageSchema = z.object({
  action: z.enum(["zero", "max"])
});

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

export const adminRoutes = new Hono<AppContext>();

adminRoutes.post("/me/plan", authRequired(), async (c) => {
  try {
    const env = loadEnv();
    const user = c.get("user");

    if (!isAdminEmail(env, user.email)) {
      throw new HttpError(
        403,
        "FORBIDDEN",
        "Esta acción está reservada al equipo de SkyBrandMX."
      );
    }

    const body = await c.req.json().catch(() => null);
    const parsed = setPlanSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        "VALIDATION_ERROR",
        parsed.error.issues[0]?.message ?? "Plan inválido"
      );
    }

    const { plan } = parsed.data;
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = plan === "free" ? null : now + THIRTY_DAYS_SECONDS;

    setUserPlan(user.id, plan, expiresAt);

    const refreshed = findUserById(user.id);
    if (!refreshed) {
      throw new HttpError(
        500,
        "INTERNAL_ERROR",
        "No se pudo recuperar el usuario tras actualizar el plan."
      );
    }

    // Non-PII log — only the user id and the plan, no email.
    console.log(`[admin] user=${user.id} plan-set ${plan}`);

    return c.json({ ok: true, user: rowToUser(refreshed, env) });
  } catch (err) {
    return sendError(c, err);
  }
});

// POST /v1/admin/me/usage — force the caller's monthly + daily usage
// counters to a known state. Lets the extension's options-page admin UI
// reproduce PLAN_LIMIT_EXCEEDED (action="max") or reset after testing
// (action="zero") without burning real cuota.
adminRoutes.post("/me/usage", authRequired(), async (c) => {
  try {
    const env = loadEnv();
    const user = c.get("user");

    if (!isAdminEmail(env, user.email)) {
      throw new HttpError(
        403,
        "FORBIDDEN",
        "Esta acción está reservada al equipo de SkyBrandMX."
      );
    }

    const body = await c.req.json().catch(() => null);
    const parsed = setUsageSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        "VALIDATION_ERROR",
        parsed.error.issues[0]?.message ?? "Acción inválida"
      );
    }

    const { action } = parsed.data;
    const yearMonth = currentYearMonth();
    const today = currentDate();
    const planDef = getPlan(user.plan);

    let monthlyCount: number;
    let dailyCount: number;
    if (action === "zero") {
      monthlyCount = 0;
      dailyCount = 0;
    } else {
      // "max" — set monthly to (plan limit + 1) so the very next AI
      // call throws PLAN_LIMIT_EXCEEDED. For unlimited plans (Premium,
      // monthlyLimit === -1) use a large constant so we can still
      // exercise the modal even though the gate never fires
      // organically. Also bump daily to (dailyLimit + 1) when set, so
      // the daily-cap path is exercisable too.
      monthlyCount = planDef.monthlyLimit < 0 ? 99999 : planDef.monthlyLimit + 1;
      dailyCount = planDef.dailyLimit > 0 ? planDef.dailyLimit + 1 : 0;
    }

    setUsageCount(user.id, yearMonth, monthlyCount);
    setDailyUsageCount(user.id, today, dailyCount);

    // Non-PII log — user id + action, no email.
    console.log(`[admin] user=${user.id} usage-set ${action} → monthly=${monthlyCount} daily=${dailyCount}`);

    // Refresh the user row so the response matches what /account would
    // return next time the extension polls.
    const refreshed = findUserById(user.id);
    return c.json({
      ok: true,
      user: refreshed ? rowToUser(refreshed, env) : null,
      usage: {
        current: monthlyCount,
        limit: planDef.monthlyLimit
      }
    });
  } catch (err) {
    return sendError(c, err);
  }
});
