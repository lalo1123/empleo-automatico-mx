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
import { findUserById, rowToUser, setUserPlan } from "../lib/db.js";

// Body schema: just the target plan. We don't accept arbitrary expiry —
// admin overrides default to "now + 30 days" so the test session doesn't
// silently expire mid-poke. Free plans have no expiry (null).
const setPlanSchema = z.object({
  plan: z.enum(["free", "pro", "premium"])
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
