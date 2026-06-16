// /v1/account - returns current user + usage summary.
// /v1/account/preferences - get/put user job preferences.

import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../lib/env.js";
import { HttpError, sendError } from "../lib/errors.js";
import { authRequired } from "../middleware/auth.js";
import { emailVerifiedRequired } from "../middleware/email-verified.js";
import { currentPeriodBounds, currentYearMonth, getUsageCount } from "../lib/usage.js";
import { getPlan } from "../lib/plans.js";
import { getPreferences, upsertPreferences, getStoredProfile, saveStoredProfile } from "../lib/db.js";
import { profileSchema } from "./applications.js";

export const accountRoutes = new Hono<AppContext>();

accountRoutes.get("/", authRequired(), async (c) => {
  try {
    const user = c.get("user");
    const yearMonth = currentYearMonth();
    const current = getUsageCount(user.id, yearMonth);
    const { periodStart, periodEnd } = currentPeriodBounds();
    const plan = getPlan(user.plan);
    // Surface preferences in the SAME response so the extension can
    // sync ciudad/modalidad/salario without a second round-trip on
    // every panel open. Bigger payload but ~200 bytes — well worth it
    // for the latency cut.
    const preferences = getPreferences(user.id);
    // Profile (CV) too, so the extension can sync it down from the account on
    // the same round-trip it already does for preferences. null if not set.
    const storedProfile = getStoredProfile(user.id);

    return c.json({
      ok: true,
      user,
      usage: {
        current,
        limit: plan.monthlyLimit,
        periodStart,
        periodEnd
      },
      preferences,
      profile: storedProfile ? storedProfile.profile : null
    });
  } catch (err) {
    return sendError(c, err);
  }
});

// Preferences sub-resource — city, modality, salary range. Both web and
// extension read/write the same row. The extension keeps a local mirror
// in chrome.storage.local["eamx:preferences"] for fast scoring; on next
// /account/preferences GET it overwrites the local cache with the server
// value (server = canonical truth).

const preferencesSchema = z.object({
  city: z.string().max(100).optional().default(""),
  citySynonyms: z.array(z.string().max(80)).max(20).optional().default([]),
  modality: z.enum(["presencial", "remoto", "hibrido", "any"]).optional().default("any"),
  salaryMin: z.number().int().nonnegative().max(10_000_000).optional().nullable(),
  salaryMax: z.number().int().nonnegative().max(10_000_000).optional().nullable(),
  expectedSalary: z.string().max(120).optional().default(""),
  // Auto-submit toggle. true (default) = "Automático total": an individual
  // ⚡ Postular fills AND sends. false = "Revisar antes de enviar": the
  // extension stops at the final submit button so the user sends it.
  autoSubmit: z.boolean().optional().default(true),
  // Personal auto-answers (vehículo, licencia, viajar, …). Free-form map at
  // the edge; unknown keys are dropped and values trimmed/capped by
  // sanitizePersonalAnswers inside db.upsertPreferences.
  personalAnswers: z.record(z.string().max(200)).optional().default({})
});

accountRoutes.get("/preferences", authRequired(), emailVerifiedRequired(), async (c) => {
  try {
    const user = c.get("user");
    return c.json({ ok: true, preferences: getPreferences(user.id) });
  } catch (err) {
    return sendError(c, err);
  }
});

accountRoutes.put("/preferences", authRequired(), emailVerifiedRequired(), async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    const parsed = preferencesSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        "VALIDATION_ERROR",
        parsed.error.issues[0]?.message ?? "Preferencias inválidas"
      );
    }
    // Salary range sanity check — if both set, min must be ≤ max.
    if (
      parsed.data.salaryMin != null &&
      parsed.data.salaryMax != null &&
      parsed.data.salaryMin > parsed.data.salaryMax
    ) {
      throw new HttpError(
        400,
        "VALIDATION_ERROR",
        "Salario mínimo no puede ser mayor al máximo."
      );
    }
    const user = c.get("user");
    const next = upsertPreferences({ userId: user.id, ...parsed.data });
    return c.json({ ok: true, preferences: next });
  } catch (err) {
    return sendError(c, err);
  }
});

// Profile (CV) sub-resource — the canonical CV store. The web account manages
// it (upload-as-text / "Crear con IA") and the extension syncs it down via
// GET /account. parse-cv / build-profile also upsert here after generating.
accountRoutes.get("/profile", authRequired(), emailVerifiedRequired(), async (c) => {
  try {
    const user = c.get("user");
    const stored = getStoredProfile(user.id);
    return c.json({ ok: true, profile: stored ? stored.profile : null });
  } catch (err) {
    return sendError(c, err);
  }
});

accountRoutes.put("/profile", authRequired(), emailVerifiedRequired(), async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    const parsed = profileSchema.safeParse(body && (body as { profile?: unknown }).profile !== undefined
      ? (body as { profile: unknown }).profile
      : body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        "VALIDATION_ERROR",
        parsed.error.issues[0]?.message ?? "Perfil inválido"
      );
    }
    const user = c.get("user");
    // Stamp version + a fresh updatedAt so the extension's sync can compare.
    const full = { version: 1, ...parsed.data, updatedAt: new Date().toISOString() };
    saveStoredProfile(user.id, full);
    return c.json({ ok: true, profile: full });
  } catch (err) {
    return sendError(c, err);
  }
});
