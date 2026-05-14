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
import {
  answerQuestions,
  answerQuiz,
  generateCoverLetter,
  generateTailoredCv,
  parseCvText
} from "../lib/gemini.js";
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

// Answer-questions: 1-12 literal question strings, each 5-300 chars.
// Cap of 12 sized for the worst-case form (Computrabajo questionnaires
// usually max out around 8-10 questions); each window of 5-300 chars
// drops obvious noise (single-char fields, paragraph dumps).
const answerQuestionsSchema = z.object({
  questions: z
    .array(
      z
        .string()
        .min(5, "Cada pregunta debe tener al menos 5 caracteres.")
        .max(300, "Cada pregunta debe tener máximo 300 caracteres.")
    )
    .min(1, "Envía al menos una pregunta.")
    .max(12, "Máximo 12 preguntas por solicitud."),
  profile: profileSchema,
  job: jobSchema
});

// Answer-quiz: a single multiple-choice knowledge question + 2-8 options.
// Question window 5-500 chars covers everything from "¿Qué es X?" to longer
// scenario questions. Option keys are the literal labels rendered by the
// form (usually "A"/"B"/"C"/"D" but LaPieza sometimes uses "1"/"2"/"3");
// 1-3 chars uppercase tolerates both shapes without letting free-form text
// through. Per-option text capped at 300 chars to drop pathological inputs.
const answerQuizSchema = z.object({
  question: z
    .string()
    .min(5, "La pregunta debe tener al menos 5 caracteres.")
    .max(500, "La pregunta debe tener máximo 500 caracteres."),
  options: z
    .array(
      z.object({
        key: z
          .string()
          .min(1, "La llave de la opción no puede estar vacía.")
          .max(3, "La llave de la opción debe tener máximo 3 caracteres.")
          .regex(/^[A-Z0-9]+$/, "La llave de la opción debe ser alfanumérica en mayúsculas."),
        text: z
          .string()
          .min(1, "El texto de la opción no puede estar vacío.")
          .max(300, "El texto de la opción debe tener máximo 300 caracteres.")
      })
    )
    .min(2, "Se requieren al menos 2 opciones.")
    .max(8, "Máximo 8 opciones por pregunta."),
  profile: profileSchema,
  job: jobSchema
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

// /generate-cv-pdf produces the same ATS-tailored CV as /generate-cv but
// rendered as an A4 PDF buffer (via puppeteer-core + Alpine chromium).
//
// Why a separate endpoint vs a `?format=pdf` flag on /generate-cv:
//   - Lets the extension request the cheaper HTML output during onboarding
//     UX flows (preview, download as HTML) without paying the puppeteer
//     render cost.
//   - Returns a binary octet-stream (not JSON), so the shape is different.
//   - Quota: this endpoint is **0 units** when /generate-cv has already
//     been called for the same job in the same session (i.e. we just
//     re-render existing HTML to PDF). For now we just always charge 1
//     unit and let the extension cache the HTML client-side to avoid
//     paying twice. The cleaner cache-by-job-id flow is a follow-up.
//
// The PDF is meant for programmatic upload to portal file inputs (LaPieza
// "Añadir nuevo CV" being the first wired up). The extension creates a
// File object from this blob and dispatches a synthetic change event on
// the portal's <input type="file">. See content/lapieza.js chain.
applicationsRoutes.post(
  "/generate-cv-pdf",
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
      const { profile, job } = parsed.data;
      if (!profile.experience || profile.experience.length === 0) {
        throw new HttpError(422, "VALIDATION_ERROR", "Tu perfil no tiene experiencia laboral.");
      }
      if (!profile.personal.fullName || !profile.personal.fullName.trim()) {
        throw new HttpError(422, "VALIDATION_ERROR", "Tu perfil no tiene nombre completo.");
      }
      if (!job.title || !job.title.trim() || !job.description || !job.description.trim()) {
        throw new HttpError(422, "VALIDATION_ERROR", "La vacante no tiene titulo o descripcion suficientes.");
      }

      const env = loadEnv();
      const user = c.get("user");
      assertUnderLimit(user.id, user.plan);

      // 1) Generate the tailored HTML CV (same path as /generate-cv).
      const result = await generateTailoredCv({
        apiKey: env.GEMINI_API_KEY,
        model: env.GEMINI_MODEL,
        profile,
        job
      });

      // 2) Render that HTML to a PDF buffer via puppeteer-core.
      const { htmlToPdf } = await import("../lib/pdf.js");
      const pdfBuf = await htmlToPdf(result.html);

      // 3) Charge the quota only after BOTH the AI call and the render
      // succeed. Failure to render shouldn't burn the user's quota.
      const newCount = incrementUsage(user.id);
      const plan = getPlan(user.plan);
      console.log(
        `[generate-cv-pdf] ok user=${user.id} plan=${user.plan} job=${job.source}:${job.id} bytes=${pdfBuf.length} usage=${newCount}/${plan.monthlyLimit}`
      );

      // Return as binary octet-stream. The extension caller uses
      // arrayBuffer() to get the bytes and constructs a File object for
      // programmatic upload to LaPieza's file input.
      const filenameSafe = (profile.personal.fullName || "CV").replace(/[^a-z0-9\s-]/gi, "").trim().replace(/\s+/g, "-") || "CV";
      return new Response(new Uint8Array(pdfBuf), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${filenameSafe}-CV.pdf"`,
          "Content-Length": String(pdfBuf.length),
          // Surface usage in custom headers so the extension can update
          // its quota indicator without a separate /account round-trip.
          "X-EAMX-Usage-Current": String(newCount),
          "X-EAMX-Usage-Limit": String(plan.monthlyLimit)
        }
      });
    } catch (err) {
      return sendError(c, err);
    }
  }
);

// /answer-questions generates one adaptive answer per question detected in
// the application form by the extension.
//
// Quota model: charged as **0 units**. This endpoint exists to extend the
// value of the single unit already billed by /generate (cover letter) for
// the same application. We still gate on `assertUnderLimit` so users
// already over quota cannot call this for free, but we never call
// `incrementUsage` — using it does not consume any monthly allowance.
applicationsRoutes.post(
  "/answer-questions",
  authRequired(),
  emailVerifiedRequired(),
  async (c) => {
    try {
      const body = await c.req.json().catch(() => null);
      const parsed = answerQuestionsSchema.safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          "VALIDATION_ERROR",
          parsed.error.issues[0]?.message ?? "Las preguntas o el perfil son inválidos."
        );
      }

      // Same pre-flight as /generate-cv: a thin profile produces useless
      // output. We reject before hitting Gemini so the user gets a clear
      // 422 instead of a generic upstream failure.
      const { profile, job, questions } = parsed.data;
      if (!profile.experience || profile.experience.length === 0) {
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "Tu perfil no tiene experiencia laboral. Completa tu CV antes de generar respuestas."
        );
      }
      if (!profile.personal.fullName || !profile.personal.fullName.trim()) {
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "Tu perfil no tiene nombre completo. Completa tu CV antes de generar respuestas."
        );
      }

      const env = loadEnv();
      const user = c.get("user");
      // Gate on quota but DO NOT increment — see route comment above.
      assertUnderLimit(user.id, user.plan);

      const result = await answerQuestions({
        apiKey: env.GEMINI_API_KEY,
        model: env.GEMINI_MODEL,
        profile,
        job,
        questions
      });

      // Log meta only — never log question text or generated answers
      // (both can carry PII like salary expectations or personal stories).
      console.log(
        `[answer-questions] ok user=${user.id} plan=${user.plan} job=${job.source}:${job.id} questions=${questions.length}`
      );

      return c.json({
        ok: true,
        answers: result.answers
      });
    } catch (err) {
      // Same error envelope as the other application routes.
      const user = c.get("user");
      if (user) {
        console.log(
          `[answer-questions] fail user=${user.id} plan=${user.plan}`
        );
      }
      return sendError(c, err);
    }
  }
);

// /answer-quiz picks the correct option for a single multiple-choice
// knowledge question embedded in an application form (LaPieza, OCC tech
// screens, etc).
//
// Quota model: charged as **0 units** — same rationale as /answer-questions.
// The user already paid 1 unit for the cover letter on the same application;
// quiz answering is part of completing that same application. We still gate
// on `assertUnderLimit` so users already over quota cannot call this for
// free, but never call `incrementUsage`.
applicationsRoutes.post(
  "/answer-quiz",
  authRequired(),
  emailVerifiedRequired(),
  async (c) => {
    try {
      const body = await c.req.json().catch(() => null);
      const parsed = answerQuizSchema.safeParse(body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          "VALIDATION_ERROR",
          parsed.error.issues[0]?.message ?? "Pregunta o opciones inválidas."
        );
      }

      // Same pre-flight as /generate-cv and /answer-questions: a thin
      // profile means we have no signal to provide as context. The quiz
      // answer mostly relies on factual knowledge, but we keep the gate
      // consistent across application endpoints so the extension can
      // surface a single "complete your CV" affordance.
      const { profile, job, question, options } = parsed.data;
      if (!profile.experience || profile.experience.length === 0) {
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "Tu perfil no tiene experiencia laboral. Completa tu CV antes de generar respuestas."
        );
      }
      if (!profile.personal.fullName || !profile.personal.fullName.trim()) {
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "Tu perfil no tiene nombre completo. Completa tu CV antes de generar respuestas."
        );
      }

      const env = loadEnv();
      const user = c.get("user");
      // Gate on quota but DO NOT increment — see route comment above.
      assertUnderLimit(user.id, user.plan);

      const result = await answerQuiz({
        apiKey: env.GEMINI_API_KEY,
        model: env.GEMINI_MODEL,
        question,
        options,
        profile,
        job
      });

      // Log meta only — never log the question text or the chosen answer.
      // Quiz content is often proprietary (employer-licensed test banks)
      // and the chosen answer would let a leak reconstruct the question.
      console.log(
        `[answer-quiz] ok user=${user.id} plan=${user.plan} job=${job.source}:${job.id} q_len=${question.length} options=${options.length}`
      );

      return c.json({
        ok: true,
        answerKey: result.answerKey,
        reason: result.reason
      });
    } catch (err) {
      const user = c.get("user");
      if (user) {
        console.log(
          `[answer-quiz] fail user=${user.id} plan=${user.plan}`
        );
      }
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
