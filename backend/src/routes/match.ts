// /v1/match/* — "Match real con IA": accurate, semantic fit analysis of the
// candidate against ONE vacancy, plus how to raise the match. Metered by its
// OWN daily counter (usage_match_daily / plans.matchAnalysisDailyLimit), fully
// separate from the postulaciones quota — analyzing a vacancy must never burn
// a postulación.

import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../lib/env.js";
import { loadEnv } from "../lib/env.js";
import { HttpError, sendError } from "../lib/errors.js";
import { authRequired } from "../middleware/auth.js";
import { emailVerifiedRequired } from "../middleware/email-verified.js";
import { analyzeMatch } from "../lib/gemini.js";
import { reserveMatchSlot, refundMatchSlot } from "../lib/usage.js";
import { getPlan } from "../lib/plans.js";
import { profileSchema, jobSchema } from "./applications.js";

const analyzeSchema = z.object({
  profile: profileSchema,
  job: jobSchema
});

export const matchRoutes = new Hono<AppContext>();

// POST /v1/match/analyze — reserve a match slot, run Gemini, refund on failure.
matchRoutes.post("/analyze", authRequired(), emailVerifiedRequired(), async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    const parsed = analyzeSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        "VALIDATION_ERROR",
        parsed.error.issues[0]?.message ?? "Perfil o vacante inválidos"
      );
    }

    // Thin-payload pre-flight (mirror /generate-cv): no point spending a match
    // slot + a Gemini call on a profile/vacancy with nothing to compare.
    const { profile, job } = parsed.data;
    if (!profile.experience || profile.experience.length === 0) {
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Tu perfil no tiene experiencia laboral. Súbela primero para analizar tu match."
      );
    }
    if (!job.title || !job.title.trim()) {
      throw new HttpError(422, "VALIDATION_ERROR", "La vacante no tiene título suficiente.");
    }

    const env = loadEnv();
    const user = c.get("user");
    // Reserve the MATCH slot (not the postulaciones quota). Refund on failure.
    const newCount = reserveMatchSlot(user.id, user.plan);
    let result;
    try {
      result = await analyzeMatch({
        apiKey: env.GEMINI_API_KEY,
        model: env.GEMINI_MODEL,
        profile,
        job
      });
    } catch (e) {
      refundMatchSlot(user.id);
      throw e;
    }

    const limit = getPlan(user.plan).matchAnalysisDailyLimit;
    // Log meta only (never content).
    console.log(
      `[match-analyze] ok user=${user.id} plan=${user.plan} job=${job.source}:${job.id} score=${result.score} usage=${newCount}/${limit}`
    );

    return c.json({
      ok: true,
      score: result.score,
      level: result.level,
      matches: result.matches,
      gaps: result.gaps,
      improveTips: result.improveTips,
      usage: { current: newCount, limit }
    });
  } catch (err) {
    return sendError(c, err);
  }
});
