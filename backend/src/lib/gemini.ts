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
      maxOutputTokens: 1200,
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
      maxOutputTokens: 2500,
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
