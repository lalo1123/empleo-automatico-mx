// Gemini client — ported from /lib/gemini.js.
// SERVER-SIDE key (env.GEMINI_API_KEY), never user-provided.
//
// Uses responseMimeType="application/json" + responseJsonSchema for structured
// output (same shape as the extension's BYOK client, so prompts stay in parity).

import type { JobPosting, UserProfile } from "../types.js";
import { HttpError } from "./errors.js";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const COVER_LETTER_SYSTEM =
  "Eres un experto en redacción de cartas de presentación para el mercado " +
  "laboral mexicano. Escribes en español, tono profesional pero humano, " +
  "entre 180 y 220 palabras. Referencias específicas del CV que coincidan " +
  "con los requisitos de la vacante. Nunca inventas información que no esté " +
  "en el CV.";

const PARSE_CV_SYSTEM =
  "Extrae información estructurada de un CV en texto. Responde SOLO con el " +
  "JSON solicitado. Si un campo no está en el CV, usa string vacía o array " +
  "vacío. Normaliza fechas a YYYY-MM cuando sea posible; si es el puesto " +
  "actual, usa null en endDate. En languages.level usa uno de: básico, " +
  "intermedio, avanzado, nativo.";

// ATS-tailored CV system prompt.
// Hard rules: never invent experience/dates/numbers; only reorder + rephrase
// existing content with the vacancy's keywords. Output is full HTML ready to
// be rendered/printed as A4 PDF (single column, no tables for layout, no
// external resources, inline <style>).
// Adaptive answers system prompt.
// The extension sends the literal question text from each form field; Gemini
// must answer each one anchored in the candidate's profile + the vacancy.
// Hard rules: no invention, fixed length (60-150 words), same array length
// and order as the input.
const ANSWER_QUESTIONS_SYSTEM =
  "Eres un experto en redacción de respuestas para formularios de aplicación " +
  "a vacantes en México.\n" +
  "Recibes una lista de preguntas (cada una literal del formulario que el " +
  "candidato está llenando) y debes responder cada una de forma específica, " +
  "anclada en el perfil del candidato y la vacante.\n\n" +
  "Reglas:\n" +
  "1. NUNCA inventes experiencia, fechas, números o títulos que no estén en " +
  "el perfil.\n" +
  "2. Cada respuesta: 60-150 palabras, español MX, profesional pero humano, " +
  "primera persona.\n" +
  "3. Si la pregunta es de \"fit/motivación/por qué eres ideal\" → conecta " +
  "2-3 puntos del perfil con requisitos de la vacante.\n" +
  "4. Si es \"disponibilidad\" → directa y breve (1-2 frases, mencionando " +
  "la empresa).\n" +
  "5. Si es \"expectativa salarial\" → si la vacante muestra rango, alinea; " +
  "si no, usa lenguaje flexible (\"dentro del rango competitivo del mercado " +
  "para...\").\n" +
  "6. Si es \"experiencia relevante\" → top 2-3 logros del perfil que " +
  "matcheen la vacante.\n" +
  "7. Si es una pregunta atípica (ej. \"¿qué te apasiona?\", \"¿qué harías " +
  "en los primeros 90 días?\") → responde anclado en el perfil, sin " +
  "clichés.\n" +
  "8. Devuelve un array de respuestas EN EL MISMO ORDEN que las preguntas. " +
  "Mismo length.";

const TAILORED_CV_SYSTEM =
  "Eres un experto en redacción de CVs optimizados para ATS (Applicant " +
  "Tracking Systems).\n\n" +
  "Reglas absolutas:\n" +
  "1. NUNCA inventes experiencia, títulos, empresas o fechas que no estén " +
  "en el CV original.\n" +
  "2. NUNCA exageres logros (ej. \"incrementé 50%\" si no está en el " +
  "original).\n" +
  "3. SÍ puedes: reordenar experiencias por relevancia a la vacante, " +
  "reescribir bullets para usar las palabras clave de la vacante, ajustar " +
  "el resumen profesional para enfatizar match.\n" +
  "4. Output: HTML completo (con <!doctype html>, <html>, <head> con " +
  "estilos inline en <style>, <body>). Listo para imprimir como PDF en " +
  "formato A4.\n" +
  "5. Diseño: limpio, profesional, una página si es posible (dos máximo). " +
  "Usa secciones: Header con nombre + contacto, Resumen profesional " +
  "(3-4 líneas), Experiencia (orden inverso cronológico), Educación, " +
  "Skills.\n" +
  "6. Tipografía: system-ui, sans-serif, 10-11pt body, 14-18pt headings. " +
  "Colores: navy #0f1d2c texto, cyan #137e7a accents, blanco fondo.\n" +
  "7. ATS-friendly: NO uses tablas para layout (los ATS no las leen), NO " +
  "uses imágenes/iconos, NO columnas múltiples (single column linear " +
  "flow), incluye keywords de la vacante de forma natural en bullets.\n" +
  "8. El HTML debe incluir @page { size: A4; margin: 18mm; } y reglas " +
  "@media print con -webkit-print-color-adjust: exact y print-color-adjust: " +
  "exact para que el color se respete al imprimir.\n" +
  "9. NO cargues recursos externos (sin Google Fonts, sin imágenes, sin " +
  "scripts). Todo debe ser autocontenido.\n" +
  "10. Idioma: español MX.";

// JSON Schemas passed to Gemini. Shape must match what the extension expects.
const COVER_LETTER_SCHEMA = {
  type: "object",
  properties: {
    coverLetter: { type: "string" },
    suggestedAnswers: {
      type: "object",
      additionalProperties: { type: "string" }
    }
  },
  required: ["coverLetter"]
} as const;

const TAILORED_CV_SCHEMA = {
  type: "object",
  properties: {
    html: { type: "string" },
    summary: { type: "string" }
  },
  required: ["html", "summary"]
} as const;

const ANSWER_QUESTIONS_SCHEMA = {
  type: "object",
  properties: {
    answers: { type: "array", items: { type: "string" } }
  },
  required: ["answers"]
} as const;

const PARSE_CV_SCHEMA = {
  type: "object",
  properties: {
    personal: {
      type: "object",
      properties: {
        fullName: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        location: { type: "string" },
        linkedin: { type: "string" },
        website: { type: "string" }
      },
      required: ["fullName", "email", "phone", "location"]
    },
    summary: { type: "string" },
    experience: {
      type: "array",
      items: {
        type: "object",
        properties: {
          company: { type: "string" },
          role: { type: "string" },
          startDate: { type: "string" },
          endDate: { type: ["string", "null"] },
          description: { type: "string" },
          achievements: { type: "array", items: { type: "string" } },
          location: { type: "string" }
        },
        required: [
          "company",
          "role",
          "startDate",
          "endDate",
          "description",
          "achievements"
        ]
      }
    },
    education: {
      type: "array",
      items: {
        type: "object",
        properties: {
          institution: { type: "string" },
          degree: { type: "string" },
          field: { type: "string" },
          startDate: { type: "string" },
          endDate: { type: ["string", "null"] }
        },
        required: ["institution", "degree", "field", "startDate", "endDate"]
      }
    },
    skills: { type: "array", items: { type: "string" } },
    languages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          language: { type: "string" },
          level: {
            type: "string",
            enum: ["básico", "intermedio", "avanzado", "nativo"]
          }
        },
        required: ["language", "level"]
      }
    }
  },
  required: ["personal", "summary", "experience", "education", "skills", "languages"]
} as const;

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
}

function geminiHttpError(status: number): HttpError {
  if (status === 400)
    return new HttpError(502, "UPSTREAM_ERROR", "Error al generar respuesta (petición inválida).");
  if (status === 401 || status === 403)
    return new HttpError(500, "INTERNAL_ERROR", "Error de configuración del servicio de IA.");
  if (status === 429)
    return new HttpError(429, "RATE_LIMITED", "Servicio de IA saturado. Intenta en unos segundos.");
  if (status === 500 || status === 503)
    return new HttpError(502, "UPSTREAM_ERROR", "Servicio de IA temporalmente no disponible.");
  return new HttpError(502, "UPSTREAM_ERROR", "Error al contactar el servicio de IA.");
}

async function callGenerate(
  apiKey: string,
  model: string,
  body: Record<string, unknown>
): Promise<GeminiResponse> {
  const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
  } catch {
    throw new HttpError(502, "UPSTREAM_ERROR", "Sin conexión con el servicio de IA.");
  }

  if (!res.ok) {
    // Drain body but don't surface — some error shapes echo the API key.
    try {
      await res.text();
    } catch {
      /* ignore */
    }
    throw geminiHttpError(res.status);
  }

  try {
    return (await res.json()) as GeminiResponse;
  } catch {
    throw new HttpError(502, "UPSTREAM_ERROR", "Respuesta inválida del servicio de IA.");
  }
}

function extractJson<T>(response: GeminiResponse): T {
  const candidate = response.candidates?.[0];
  const parts = candidate?.content?.parts;
  const first = Array.isArray(parts) ? parts.find((p) => typeof p.text === "string") : null;
  if (!first || !first.text) {
    throw new HttpError(502, "UPSTREAM_ERROR", "La IA no devolvió una respuesta válida.");
  }
  try {
    return JSON.parse(first.text) as T;
  } catch {
    throw new HttpError(502, "UPSTREAM_ERROR", "La IA devolvió JSON inválido.");
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GenerateCoverLetterArgs {
  apiKey: string;
  model: string;
  profile: UserProfile;
  job: JobPosting;
}

export interface GenerateCoverLetterResult {
  coverLetter: string;
  suggestedAnswers: Record<string, string>;
}

export async function generateCoverLetter(
  args: GenerateCoverLetterArgs
): Promise<GenerateCoverLetterResult> {
  const { apiKey, model, profile, job } = args;
  if (!apiKey) throw new HttpError(500, "INTERNAL_ERROR", "Configuración del servicio incompleta.");
  if (!profile) throw new HttpError(400, "VALIDATION_ERROR", "Falta el perfil del candidato.");
  if (!job) throw new HttpError(400, "VALIDATION_ERROR", "Falta la información de la vacante.");

  const userText =
    `Vacante (JSON):\n${JSON.stringify(job, null, 2)}\n\n` +
    `Perfil del candidato (JSON):\n${JSON.stringify(profile, null, 2)}\n\n` +
    `Genera la carta de presentación y respuestas sugeridas para preguntas ` +
    `abiertas comunes (experiencia relevante, disponibilidad, expectativa ` +
    `salarial si hay señal, motivación). 2-3 coincidencias concretas entre ` +
    `perfil y requisitos.`;

  const body = {
    systemInstruction: { parts: [{ text: COVER_LETTER_SYSTEM }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig: {
      temperature: 0.7,
      // 2.5 burns "thinking" tokens before the response — disable thinking and
      // size the budget for the JSON cover letter (~600 tokens worst case).
      maxOutputTokens: 3000,
      thinkingConfig: { thinkingBudget: 0 },
      responseMimeType: "application/json",
      responseJsonSchema: COVER_LETTER_SCHEMA
    }
  };

  const res = await callGenerate(apiKey, model, body);
  const out = extractJson<{
    coverLetter?: string;
    suggestedAnswers?: Record<string, string>;
  }>(res);

  const coverLetter = typeof out.coverLetter === "string" ? out.coverLetter : "";
  if (!coverLetter) {
    throw new HttpError(502, "UPSTREAM_ERROR", "La IA no devolvió una carta válida.");
  }
  const suggestedAnswers =
    out.suggestedAnswers && typeof out.suggestedAnswers === "object"
      ? out.suggestedAnswers
      : {};
  return { coverLetter, suggestedAnswers };
}

export interface ParseCvArgs {
  apiKey: string;
  model: string;
  rawText: string;
}

export type ParseCvResult = Omit<UserProfile, "version" | "updatedAt" | "rawText">;

export async function parseCvText(args: ParseCvArgs): Promise<ParseCvResult> {
  const { apiKey, model, rawText } = args;
  if (!apiKey) throw new HttpError(500, "INTERNAL_ERROR", "Configuración del servicio incompleta.");
  if (!rawText || !rawText.trim()) {
    throw new HttpError(400, "VALIDATION_ERROR", "El CV está vacío.");
  }

  const body = {
    systemInstruction: { parts: [{ text: PARSE_CV_SYSTEM }] },
    contents: [{ role: "user", parts: [{ text: `Texto del CV:\n\n${rawText}` }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 4000,
      thinkingConfig: { thinkingBudget: 0 },
      responseMimeType: "application/json",
      responseJsonSchema: PARSE_CV_SCHEMA
    }
  };

  const res = await callGenerate(apiKey, model, body);
  const out = extractJson<Partial<ParseCvResult>>(res);
  const personal = out.personal ?? {
    fullName: "",
    email: "",
    phone: "",
    location: ""
  };

  return {
    personal: {
      fullName: personal.fullName ?? "",
      email: personal.email ?? "",
      phone: personal.phone ?? "",
      location: personal.location ?? "",
      ...(personal.linkedin ? { linkedin: personal.linkedin } : {}),
      ...(personal.website ? { website: personal.website } : {})
    },
    summary: out.summary ?? "",
    experience: Array.isArray(out.experience) ? out.experience : [],
    education: Array.isArray(out.education) ? out.education : [],
    skills: Array.isArray(out.skills) ? out.skills : [],
    languages: Array.isArray(out.languages) ? out.languages : []
  };
}

// ---------------------------------------------------------------------------
// Tailored CV (ATS-optimized HTML, per-vacancy)
// ---------------------------------------------------------------------------

export interface GenerateTailoredCvArgs {
  apiKey: string;
  model: string;
  profile: UserProfile;
  job: JobPosting;
}

export interface GenerateTailoredCvResult {
  /** Full HTML document (`<!doctype html>...`), self-contained, A4 print-ready. */
  html: string;
  /** Short Spanish-MX summary of what was reordered/rephrased to match the job. */
  summary: string;
}

/**
 * Produces an ATS-optimized HTML CV tailored to a specific vacancy.
 *
 * Same retry/error semantics as `generateCoverLetter`: a successful Gemini
 * response with a non-empty `html` string is required, otherwise we throw
 * UPSTREAM_ERROR. Gemini is constrained via responseJsonSchema so the model
 * cannot drift off-shape.
 *
 * Cost note: this call is ~2.5x heavier than a cover letter (longer prompt,
 * longer output). For pricing fairness we still count it as 1 quota unit —
 * see comment on `/v1/applications/generate-cv` in routes/applications.ts.
 */
export async function generateTailoredCv(
  args: GenerateTailoredCvArgs
): Promise<GenerateTailoredCvResult> {
  const { apiKey, model, profile, job } = args;
  if (!apiKey) throw new HttpError(500, "INTERNAL_ERROR", "Configuración del servicio incompleta.");
  if (!profile) throw new HttpError(400, "VALIDATION_ERROR", "Falta el perfil del candidato.");
  if (!job) throw new HttpError(400, "VALIDATION_ERROR", "Falta la información de la vacante.");

  const userText =
    `Vacante (JSON):\n${JSON.stringify(job, null, 2)}\n\n` +
    `Perfil del candidato (JSON):\n${JSON.stringify(profile, null, 2)}\n\n` +
    `Genera un CV completo en HTML optimizado para ATS, adaptado a esta ` +
    `vacante. Reordena la experiencia por relevancia a la vacante, ` +
    `reescribe bullets para incluir las palabras clave del puesto sin ` +
    `inventar nada, y ajusta el resumen profesional para enfatizar el ` +
    `match. Devuelve también un "summary" breve (1-2 frases en español MX) ` +
    `explicando qué reordenaste o reformulaste para alinear con la vacante.`;

  const body = {
    systemInstruction: { parts: [{ text: TAILORED_CV_SYSTEM }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig: {
      // Conservative creativity: enough flexibility to rephrase bullets, not
      // enough to invent facts.
      temperature: 0.4,
      // HTML can be long with many bullets; size for a 2-page CV worst-case.
      maxOutputTokens: 6000,
      thinkingConfig: { thinkingBudget: 0 },
      responseMimeType: "application/json",
      responseJsonSchema: TAILORED_CV_SCHEMA
    }
  };

  const res = await callGenerate(apiKey, model, body);
  const out = extractJson<{ html?: string; summary?: string }>(res);

  const html = typeof out.html === "string" ? out.html.trim() : "";
  if (!html) {
    throw new HttpError(502, "UPSTREAM_ERROR", "La IA no devolvió un CV válido.");
  }
  // Sanity check: the prompt forces an HTML document; reject anything that
  // doesn't at least start with a doctype/<html> so we don't ship garbage.
  const head = html.slice(0, 400).toLowerCase();
  if (!head.includes("<!doctype") && !head.includes("<html")) {
    throw new HttpError(502, "UPSTREAM_ERROR", "La IA no devolvió HTML válido.");
  }

  const summary = typeof out.summary === "string" && out.summary.trim()
    ? out.summary.trim()
    : "CV adaptado a la vacante.";

  return { html, summary };
}

// ---------------------------------------------------------------------------
// Adaptive form answers
// ---------------------------------------------------------------------------

export interface AnswerQuestionsArgs {
  apiKey: string;
  model: string;
  profile: UserProfile;
  job: JobPosting;
  /** 1-12 literal question strings as captured from the application form. */
  questions: string[];
}

export interface AnswerQuestionsResult {
  /** Same length and order as `questions`. */
  answers: string[];
}

/**
 * Generates one adaptive answer per question detected in the application form.
 *
 * Quota model: this endpoint exists to make the *single* unit billed by
 * `/generate` (cover letter) more useful, so it is **not** charged. The route
 * still gates on `assertUnderLimit` to prevent free abuse, but never calls
 * `incrementUsage`. See routes/applications.ts for the wiring.
 *
 * Output validation:
 * - `answers` must be an array of the same length as `questions`. Otherwise
 *   we throw 502 UPSTREAM_ERROR (no fallback — the model failed at the
 *   contract level).
 * - Empty/whitespace strings inside the array are replaced with a generic
 *   per-slot fallback so partial failures don't take the whole call down.
 */
export async function answerQuestions(
  args: AnswerQuestionsArgs
): Promise<AnswerQuestionsResult> {
  const { apiKey, model, profile, job, questions } = args;
  if (!apiKey) throw new HttpError(500, "INTERNAL_ERROR", "Configuración del servicio incompleta.");
  if (!profile) throw new HttpError(400, "VALIDATION_ERROR", "Falta el perfil del candidato.");
  if (!job) throw new HttpError(400, "VALIDATION_ERROR", "Falta la información de la vacante.");
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new HttpError(400, "VALIDATION_ERROR", "No hay preguntas para responder.");
  }

  const userText =
    `Vacante (JSON):\n${JSON.stringify(job, null, 2)}\n\n` +
    `Perfil del candidato (JSON):\n${JSON.stringify(profile, null, 2)}\n\n` +
    `Preguntas detectadas en el formulario (en orden):\n` +
    `${JSON.stringify(questions, null, 2)}\n\n` +
    `Responde cada pregunta siguiendo las reglas. Devuelve un array ` +
    `"answers" con el MISMO número de elementos y EN EL MISMO ORDEN que las ` +
    `preguntas.`;

  const body = {
    systemInstruction: { parts: [{ text: ANSWER_QUESTIONS_SYSTEM }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig: {
      // Some flexibility for varied phrasings, not too creative.
      temperature: 0.6,
      // Worst case: 12 questions × ~300 tokens each.
      maxOutputTokens: 4000,
      thinkingConfig: { thinkingBudget: 0 },
      responseMimeType: "application/json",
      responseJsonSchema: ANSWER_QUESTIONS_SCHEMA
    }
  };

  const res = await callGenerate(apiKey, model, body);
  const out = extractJson<{ answers?: unknown }>(res);

  if (!Array.isArray(out.answers)) {
    throw new HttpError(502, "UPSTREAM_ERROR", "La IA no respondió todas las preguntas.");
  }
  if (out.answers.length !== questions.length) {
    throw new HttpError(502, "UPSTREAM_ERROR", "La IA no respondió todas las preguntas.");
  }

  const answers: string[] = out.answers.map((a) => {
    if (typeof a !== "string") return "[respuesta no disponible — reformula la pregunta]";
    const trimmed = a.trim();
    return trimmed.length > 0
      ? trimmed
      : "[respuesta no disponible — reformula la pregunta]";
  });

  return { answers };
}
