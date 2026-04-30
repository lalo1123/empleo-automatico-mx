// /v1/applications/* - Gemini-backed endpoints with plan metering.
// parse-cv is FREE (one-time onboarding flow). Both /generate (cover letter)
// and /generate-cv (ATS-tailored CV HTML) consume 1 quota unit each. /generate-cv
// costs ~2.5x more in Gemini tokens but we keep the unit price uniform — see
// comment on the route.

import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../lib/env.js";
import { loadEnv } from "../lib/env.js";
import { HttpError, sendError } from "../lib/errors.js";
import { authRequired } from "../middleware/auth.js";
import { emailVerifiedRequired } from "../middleware/email-verified.js";
import { generateCoverLetter, generateTailoredCv, parseCvText } from "../lib/gemini.js";
import { assertUnderLimit, incrementUsage } from "../lib/usage.js";
import { getPlan } from "../lib/plans.js";

// Zod schemas for inbound bodies. We intentionally keep them loose on
// optional fields (Gemini handles missing data) but strict on required keys.

const personalSchema = z.object({
  fullName: z.string(),
  email: z.string(),
  phone: z.string(),
  location: z.string(),
  linkedin: z.string().optional(),
  website: z.string().optional()
});

const experienceSchema = z.object({
  company: z.string(),
  role: z.string(),
  startDate: z.string(),
  endDate: z.string().nullable(),
  description: z.string(),
  achievements: z.array(z.string()),
  location: z.string().optional()
});

const educationSchema = z.object({
  institution: z.string(),
  degree: z.string(),
  field: z.string(),
  startDate: z.string(),
  endDate: z.string().nullable()
});

const languageSchema = z.object({
  language: z.string(),
  level: z.enum(["básico", "intermedio", "avanzado", "nativo"])
});

const profileSchema = z.object({
  version: z.literal(1).optional(),
  updatedAt: z.string().optional(),
  personal: personalSchema,
  summary: z.string(),
  experience: z.array(experienceSchema),
  education: z.array(educationSchema),
  skills: z.array(z.string()),
  languages: z.array(languageSchema),
  rawText: z.string().optional()
});

const jobSchema = z.object({
  source: z.enum(["occ", "computrabajo", "linkedin", "bumeran", "indeed", "lapieza"]),
  url: z.string(),
  id: z.string(),
  title: z.string(),
  company: z.string(),
  location: z.string(),
  salary: z.string().nullable(),
  modality: z.enum(["presencial", "remoto", "híbrido"]).nullable(),
  description: z.string(),
  requirements: z.array(z.string()),
  extractedAt: z.string()
});

const generateSchema = z.object({
  profile: profileSchema,
  job: jobSchema
});

const parseCvSchema = z.object({
  text: z.string().min(20, "El CV es demasiado corto").max(100_000, "El CV es demasiado largo")
});

export const applicationsRoutes = new Hono<AppContext>();

// /generate is quota-bearing and hits paid upstream APIs — gate on verified
// email to prevent bot-generated requests from burning Gemini budget.
// parse-cv stays open so users can finish onboarding before they verify.
applicationsRoutes.post("/generate", authRequired(), emailVerifiedRequired(), async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    const parsed = generateSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        "VALIDATION_ERROR",
        parsed.error.issues[0]?.message ?? "Perfil o vacante invalidos"
      );
    }

    const env = loadEnv();
    const user = c.get("user");
    assertUnderLimit(user.id, user.plan);

    const result = await generateCoverLetter({
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL,
      profile: parsed.data.profile,
      job: parsed.data.job
    });

    // Only increment once Gemini returned a valid response.
    const newCount = incrementUsage(user.id);
    const plan = getPlan(user.plan);

    // Log meta only, never content.
    console.log(
      `[generate] ok user=${user.id} plan=${user.plan} job=${parsed.data.job.source}:${parsed.data.job.id} usage=${newCount}/${plan.monthlyLimit}`
    );

    return c.json({
      ok: true,
      coverLetter: result.coverLetter,
      suggestedAnswers: result.suggestedAnswers,
      usage: {
        current: newCount,
        limit: plan.monthlyLimit
      }
    });
  } catch (err) {
    return sendError(c, err);
  }
});

// /generate-cv produces an ATS-optimized, vacancy-tailored CV in HTML.
//
// Quota model: charged as 1 unit (same as cover letter) even though the
// upstream Gemini cost is roughly 2.5x — we keep the unit price simple and
// uniform across application artifacts. Free users (3/mes) can mix and match
// across /generate, /generate-cv and any future application endpoints. If
// the cost mix shifts dramatically we'll revisit; for now the margin
// (~98% on Pro) absorbs it comfortably.
applicationsRoutes.post(
  "/generate-cv",
  authRequired(),
  emailVerifiedRequired(),
  async (c) => {
    try {
      const body = await c.req.json().catch(() => null);
      const parsed = generateSchema.safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          "VALIDATION_ERROR",
          parsed.error.issues[0]?.message ?? "Perfil o vacante invalidos"
        );
      }

      // Reject thin payloads early — Gemini will produce garbage from an
      // empty profile and we'd still bill the user a quota unit. 422 ==
      // "syntactically valid but semantically not enough to act on".
      const { profile, job } = parsed.data;
      if (!profile.experience || profile.experience.length === 0) {
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "Tu perfil no tiene experiencia laboral. Súbela primero para generar un CV."
        );
      }
      if (!profile.personal.fullName || !profile.personal.fullName.trim()) {
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "Tu perfil no tiene nombre completo. Complétalo antes de generar un CV."
        );
      }
      if (!job.title || !job.title.trim() || !job.description || !job.description.trim()) {
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "La vacante no tiene título o descripción suficientes."
        );
      }

      const env = loadEnv();
      const user = c.get("user");
      assertUnderLimit(user.id, user.plan);

      const result = await generateTailoredCv({
        apiKey: env.GEMINI_API_KEY,
        model: env.GEMINI_MODEL,
        profile,
        job
      });

      // Only increment once Gemini returned a valid response.
      const newCount = incrementUsage(user.id);
      const plan = getPlan(user.plan);

      // Log meta only, never content (CVs include PII).
      console.log(
        `[generate-cv] ok user=${user.id} plan=${user.plan} job=${job.source}:${job.id} usage=${newCount}/${plan.monthlyLimit}`
      );

      return c.json({
        ok: true,
        html: result.html,
        summary: result.summary,
        usage: {
          current: newCount,
          limit: plan.monthlyLimit
        }
      });
    } catch (err) {
      return sendError(c, err);
    }
  }
);

// parse-cv is intentionally free (one-time per user in the onboarding flow).
applicationsRoutes.post("/parse-cv", authRequired(), async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    const parsed = parseCvSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        "VALIDATION_ERROR",
        parsed.error.issues[0]?.message ?? "Texto del CV invalido"
      );
    }

    const env = loadEnv();
    const user = c.get("user");
    const profile = await parseCvText({
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL,
      rawText: parsed.data.text
    });

    console.log(`[parse-cv] ok user=${user.id}`);
    return c.json({ ok: true, profile });
  } catch (err) {
    return sendError(c, err);
  }
});
