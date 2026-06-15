// Gemini client — ported from /lib/gemini.js.
// SERVER-SIDE key (env.GEMINI_API_KEY), never user-provided.
//
// Uses responseMimeType="application/json" + responseJsonSchema for structured
// output (same shape as the extension's BYOK client, so prompts stay in parity).

import type { JobPosting, UserProfile } from "../types.js";
import { HttpError } from "./errors.js";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const COVER_LETTER_SYSTEM =
  "Eres un experto en redacción de respuestas para el campo \"¿Por qué " +
  "eres la persona ideal para este puesto?\" de formularios de aplicación " +
  "en México (LaPieza, OCC, Computrabajo, etc).\n\n" +
  "IMPORTANTE: esto NO es una carta formal. Los reclutadores ven este " +
  "texto en una cajita del formulario, NO como un email.\n\n" +
  "REGLAS DE FORMATO:\n" +
  "1. NUNCA empieces con \"Estimados\", \"A quien corresponda\", \"Con " +
  "gran interés me dirijo\", ni saludos formales tipo carta o email.\n" +
  "2. NUNCA cierres con \"Atentamente\", \"Saludos cordiales\", firma, " +
  "ni datos de contacto.\n" +
  "3. Tono: profesional pero conversacional, primera persona, español " +
  "MX. Como una entrevista corta, no un correo.\n" +
  "4. Longitud: 150-220 palabras.\n\n" +
  "REGLAS DE CONTENIDO — esto separa una respuesta BUENA de una GENÉRICA. " +
  "Síguelas o el texto sirve de nada:\n" +
  "5. Arranca DIRECTO con tu prueba más fuerte y CONCRETA, nunca con una " +
  "afirmación vacía.\n" +
  "   MAL: \"Soy la persona ideal porque soy proactivo y tengo sólida " +
  "experiencia.\"\n" +
  "   BIEN: \"En [empresa real del CV] lideré [logro/herramienta/métrica " +
  "real del CV], justo lo que pide esta vacante de [puesto].\"\n" +
  "6. Nombra a la empresa de la vacante al menos una vez y referencia UN " +
  "elemento concreto de la descripción (una responsabilidad, herramienta " +
  "o reto que menciona). Debe quedar OBVIO que no es una plantilla.\n" +
  "7. CADA afirmación de fit va respaldada por un dato real del CV: " +
  "nombre de empresa, herramienta, años o métrica. Si no hay dato que lo " +
  "respalde, no lo afirmes.\n" +
  "8. Refleja el lenguaje de la vacante: si pide \"Power BI\", " +
  "\"liderazgo de equipo\", \"e-commerce\", usa ESAS mismas palabras SI " +
  "el candidato las tiene en su CV.\n" +
  "9. PROHIBIDO usar muletillas genéricas vacías: \"equipo dinámico\", " +
  "\"me apasiona\", \"soy proactivo\", \"sólida/amplia experiencia\", " +
  "\"orientado a resultados\", \"valor agregado\", \"trabajo bajo " +
  "presión\", \"excelentes habilidades de comunicación\", \"diversas " +
  "tareas\". Si una frase podría servir para CUALQUIER candidato en " +
  "CUALQUIER puesto, bórrala y pon en su lugar un hecho específico del CV.\n" +
  "10. NUNCA inventes nada que no esté en el CV (experiencia, " +
  "herramientas, números). Optimista pero 100% verdadero.";

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
// Quiz answering system prompt.
// Used when the application form embeds a knowledge-quiz with multiple-choice
// items (LaPieza, OCC technical screens, etc). The candidate's profile is
// passed only as context — the right answer is the right answer regardless
// of who's filling the form, so we keep temperature low and frame Gemini as
// a factual QA grader, not a "best fit" matcher.
const ANSWER_QUIZ_SYSTEM =
  "Eres un experto que responde preguntas en formularios de aplicación a " +
  "empleos en México. Recibes una pregunta y un conjunto de opciones, más " +
  "el perfil del candidato y la vacante como contexto.\n\n" +
  "PRIMERO clasifica la pregunta en uno de estos dos tipos:\n\n" +
  "TIPO A — CONOCIMIENTO (knowledge / trivia / técnica):\n" +
  "  Ejemplos: \"¿Qué es Redshift?\", \"¿Cuál es el comando para X?\", " +
  "\"¿Cuánto es 2+2?\", \"Selecciona la mejor práctica de SQL\".\n" +
  "  La respuesta es la misma sin importar quién contesta. Responde con " +
  "  conocimiento factual / mejores prácticas / docs oficiales.\n\n" +
  "TIPO B — SOBRE EL CANDIDATO (personal / experiencia / fit):\n" +
  "  Ejemplos: \"¿Tienes 3+ años de experiencia con X?\", \"¿Hablas " +
  "inglés avanzado?\", \"¿Vives en CDMX?\", \"¿Estás dispuesto a viajar?\", " +
  "\"Do you have experience with...?\". Usualmente preguntas de SI/NO o " +
  "rangos.\n" +
  "  La respuesta DEPENDE del perfil del candidato. NO uses conocimiento " +
  "  general — busca en el perfil (experiencia, skills, ubicación, " +
  "  idiomas, sumary) si el candidato cumple. Sé OPTIMISTA pero VERAZ:\n" +
  "    - Si el perfil claramente cumple (3+ años de X) → SI.\n" +
  "    - Si el perfil claramente NO cumple (no menciona X y la pregunta " +
  "      pide expertise específica) → NO.\n" +
  "    - Si es ambiguo y la pregunta es de soft skill / disposición / " +
  "      modalidad (\"¿estás dispuesto a aprender?\", \"¿puedes trabajar " +
  "      híbrido?\") → SI.\n" +
  "    - NUNCA inventes experiencia que no esté en el perfil.\n\n" +
  "Reglas comunes:\n" +
  "1. Devuelve EXACTAMENTE una de las llaves de opción provistas (ej. " +
  "\"A\", \"B\", \"C\", \"D\", \"SI\", \"NO\").\n" +
  "2. Si la pregunta es ambigua o tiene más de una respuesta defendible, " +
  "escoge la MÁS comúnmente aceptada (Tipo A) o la que más beneficie al " +
  "candidato sin mentir (Tipo B).\n" +
  "3. NUNCA inventes opciones nuevas. Solo escoge entre las que recibiste.\n" +
  "4. Razón: 1-2 frases breves, español MX. Si es Tipo B, cita brevemente " +
  "el dato del perfil que respalda la respuesta (ej. \"el CV menciona 4 años " +
  "con AWS Redshift\").";

const ANSWER_QUESTIONS_SYSTEM =
  "Eres un experto en redacción de respuestas para formularios de aplicación " +
  "a vacantes en México.\n" +
  "Recibes una lista de preguntas (cada una literal del formulario que el " +
  "candidato está llenando) y debes responder cada una de forma ESPECÍFICA, " +
  "anclada en el perfil del candidato y la vacante.\n\n" +
  "Reglas:\n" +
  "1. NUNCA inventes experiencia, fechas, números o títulos que no estén en " +
  "el perfil.\n" +
  "2. Cada respuesta: 60-150 palabras, español MX, profesional pero humano, " +
  "primera persona.\n" +
  "3. CADA respuesta debe citar al menos UN dato concreto del perfil " +
  "(empresa, puesto, herramienta, años o métrica). Una respuesta que no " +
  "menciona ningún hecho real del CV está MAL hecha.\n" +
  "4. Nombra a la empresa de la vacante cuando la pregunta lo permita " +
  "(motivación, disponibilidad, \"por qué aquí\").\n" +
  "5. Refleja el lenguaje de la pregunta y las keywords de la vacante " +
  "cuando el CV lo respalde.\n" +
  "6. Tipos comunes:\n" +
  "   - \"fit/motivación/por qué eres ideal\" → conecta 2-3 puntos del " +
  "perfil con requisitos de la vacante.\n" +
  "   - \"disponibilidad\" → directa y breve (1-2 frases, mencionando la " +
  "empresa).\n" +
  "   - \"expectativa salarial\" → si la vacante muestra rango, alinea; si " +
  "no, lenguaje flexible (\"dentro del rango competitivo del mercado " +
  "para...\").\n" +
  "   - \"experiencia relevante\" → top 2-3 logros del perfil que matcheen " +
  "la vacante.\n" +
  "   - atípica (\"¿qué te apasiona?\", \"¿primeros 90 días?\") → respuesta " +
  "anclada en el perfil, sin clichés.\n" +
  "7. PROHIBIDO usar muletillas genéricas vacías: \"equipo dinámico\", " +
  "\"me apasiona\", \"soy proactivo\", \"sólida/amplia experiencia\", " +
  "\"orientado a resultados\", \"valor agregado\", \"trabajo bajo " +
  "presión\", \"excelentes habilidades de comunicación\". Si una frase " +
  "serviría para CUALQUIER candidato en CUALQUIER puesto, cámbiala por un " +
  "hecho específico del CV.\n" +
  "8. Devuelve un array de respuestas EN EL MISMO ORDEN que las preguntas. " +
  "Mismo length.";

const TAILORED_CV_SYSTEM =
  "Eres un experto en redacción de CVs optimizados para ATS (Applicant " +
  "Tracking Systems) con experiencia reclutando para empresas en México.\n\n" +
  "Tu tarea: tomar el CV del candidato y la descripción de la vacante, y " +
  "producir un CV reordenado y reescrito que maximice el match con esa " +
  "vacante específica — sin inventar nada que no esté en el CV original.\n\n" +
  "INTEGRIDAD (reglas absolutas — viola UNA y el output es inválido):\n" +
  "1. NUNCA inventes experiencia, títulos, empresas, fechas o tecnologías " +
  "que no estén en el CV original. Si la vacante pide React y el candidato " +
  "no tiene React, NO lo agregues.\n" +
  "2. NUNCA inventes métricas/números (\"incrementé 50%\", \"ahorré $2M\") " +
  "si no están en el original. Si el original dice \"optimicé reportes\", " +
  "puedes reescribir como \"automaticé generación de reportes ejecutivos\" " +
  "pero NO inventar \"reduciendo tiempo de 4h a 30min\".\n" +
  "3. NUNCA cambies fechas, títulos académicos, ni nombres de empresas.\n\n" +
  "TAILORING (reescribe agresivamente DENTRO de los límites de integridad):\n" +
  "4. Identifica primero las 5-10 keywords más críticas de la vacante (job " +
  "title, technical skills, soft skills, herramientas/stack, dominio de " +
  "negocio). Esas keywords deben aparecer naturalmente en: resumen " +
  "profesional, primer bullet de cada experiencia relevante, y sección de " +
  "skills.\n" +
  "5. Resumen profesional (3-4 frases): debe estar laser-focused en por " +
  "qué este candidato es ideal para ESTA vacante. Empieza con el job title " +
  "del candidato (o el más cercano a la vacante), seguido de años de " +
  "experiencia y los 2-3 verticales/skills más relevantes a la vacante. " +
  "NO uses frases genéricas como \"profesional con sólida experiencia\" — " +
  "sé específico.\n" +
  "6. Experiencia: ordena por RELEVANCIA a la vacante, no por fecha (el " +
  "puesto más relevante va arriba aunque sea más antiguo, pero respeta " +
  "orden cronológico inverso DENTRO de cada bloque de relevancia). " +
  "Reescribe bullets priorizando los que demuestran las keywords " +
  "identificadas. Si un bullet del original no aporta a la vacante, " +
  "OMÍTELO (no copies todo). Usa máximo 4-5 bullets por puesto.\n" +
  "7. Bullets: empieza con verbo de acción fuerte (Lideré, Diseñé, " +
  "Automaticé, Implementé, Optimicé, Escalé). Estructura: VERBO + QUÉ + " +
  "CÓMO/STACK + IMPACTO. Si el original tiene métrica concreta, " +
  "preservala. Incluye keywords de la vacante donde encajen sin forzar.\n" +
  "8. Skills: lista solo las skills/herramientas relevantes a la vacante, " +
  "agrupadas si es posible (ej. \"Data: SQL, Python, Power BI, Looker\"). " +
  "NO listes 30 skills random — ATS modernos penalizan keyword stuffing.\n" +
  "9. Educación: una línea por título. Si el candidato tiene maestría, " +
  "ponla primero.\n\n" +
  "OUTPUT TÉCNICO:\n" +
  "10. HTML completo: <!doctype html>, <html>, <head> con <style> inline, " +
  "<body>. Listo para imprimir como PDF A4.\n" +
  "11. Diseño: limpio, profesional, una página si es posible (dos máximo). " +
  "Secciones en este orden: Header (nombre grande + contacto en una línea), " +
  "Resumen Profesional, Experiencia, Educación, Skills, opcionalmente " +
  "Idiomas/Certificaciones si están en el original.\n" +
  "12. Tipografía: system-ui, sans-serif, 10-11pt body, 14-18pt headings. " +
  "Colores: navy #0f1d2c texto, cyan #137e7a accents (solo en headings y " +
  "líneas separadoras), blanco fondo.\n" +
  "13. ATS-friendly: NO tablas para layout, NO imágenes/iconos, NO " +
  "columnas múltiples (single column linear flow). Headings con <h2>, " +
  "experiencia con <h3>, bullets con <ul>/<li>.\n" +
  "14. CSS print: incluye @page { size: A4; margin: 16mm; } y @media print " +
  "con -webkit-print-color-adjust: exact y print-color-adjust: exact.\n" +
  "15. NO cargues recursos externos (sin Google Fonts, sin imágenes, sin " +
  "scripts). Todo autocontenido.\n" +
  "16. Idioma: español MX para texto narrativo. Términos técnicos en su " +
  "forma original (ej. \"Product Manager\" no \"Gerente de Producto\" " +
  "salvo que el original lo use así).\n\n" +
  "SUMMARY (campo separado del HTML, 1-2 frases):\n" +
  "17. Explica en español MX qué reordenaste y qué keywords destacaste. " +
  "Ej: \"Subí experiencia en marketing performance al inicio y reescribí " +
  "bullets con keywords SEM/ROAS/Google Ads que pide la vacante.\"";

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

const ANSWER_QUIZ_SCHEMA = {
  type: "object",
  properties: {
    answerKey: { type: "string" },
    reason: { type: "string" }
  },
  required: ["answerKey", "reason"]
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
    // Log the STATUS + model only (never the key or body) so an operator can
    // diagnose from the Dokploy logs. 401/403 = bad/unauthorized GEMINI_API_KEY
    // (or Generative Language API not enabled / key restricted); 404 = the
    // GEMINI_MODEL name is wrong or retired; 429 = rate/quota limit upstream.
    const hint =
      res.status === 401 || res.status === 403
        ? "check GEMINI_API_KEY (invalid/unauthorized, API not enabled, or key restricted)"
        : res.status === 404
          ? "check GEMINI_MODEL (unknown/retired model name)"
          : res.status === 429
            ? "Gemini rate/quota limit"
            : "upstream Gemini error";
    console.error(`[gemini] upstream ${res.status} model=${model} — ${hint}`);
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
      // A modest thinking budget is the single biggest lever against GENERIC
      // output: it lets 2.5 reason about WHICH concrete CV facts to pick and
      // how to tie them to this specific vacancy before writing. We cap it
      // (not dynamic -1) for predictable cost, and keep maxOutputTokens ~4x
      // above it so thinking can NEVER starve the JSON response (the old
      // empty-cover bug). Response itself is ~600-800 tokens.
      maxOutputTokens: 4000,
      thinkingConfig: { thinkingBudget: 1024 },
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
    `VACANTE (JSON):\n${JSON.stringify(job, null, 2)}\n\n` +
    `PERFIL DEL CANDIDATO (JSON):\n${JSON.stringify(profile, null, 2)}\n\n` +
    `Pasos a seguir (mentalmente, no los incluyas en el output):\n` +
    `1. Lee la vacante e identifica las 5-10 keywords críticas (job title, ` +
    `skills técnicas, herramientas, dominio de negocio, soft skills).\n` +
    `2. Lee el CV del candidato e identifica qué experiencias y bullets ` +
    `tienen overlap con esas keywords.\n` +
    `3. Reordena: lo más relevante arriba.\n` +
    `4. Reescribe bullets para que las keywords aparezcan naturalmente — ` +
    `sin inventar tecnologías que el candidato no usó.\n` +
    `5. Recorta: omite bullets/experiencias irrelevantes a esta vacante.\n` +
    `6. Resumen profesional: 3-4 frases laser-focused en por qué este ` +
    `candidato encaja en ESTA vacante específica (no genérico).\n` +
    `7. Renderea como HTML A4 ATS-friendly siguiendo las reglas técnicas.\n\n` +
    `Devuelve JSON con:\n` +
    `- "html": el documento HTML completo (auto-contenido, sin recursos ` +
    `externos).\n` +
    `- "summary": 1-2 frases en español MX explicando qué reordenaste y ` +
    `qué keywords destacaste de la vacante.`;

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
      // Thinking lets the model choose a concrete CV fact per answer instead
      // of defaulting to boilerplate. Budget capped; maxOutputTokens sized so
      // thinking + up to 12 answers (~200 tokens each) never collide.
      maxOutputTokens: 6000,
      thinkingConfig: { thinkingBudget: 1536 },
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

// ---------------------------------------------------------------------------
// Knowledge quiz answering (multiple-choice)
// ---------------------------------------------------------------------------

export interface AnswerQuizArgs {
  apiKey: string;
  model: string;
  question: string;
  options: Array<{ key: string; text: string }>;
  profile: UserProfile;
  job: JobPosting;
}

export interface AnswerQuizResult {
  /** One of the input option keys, verified against the original list. */
  answerKey: string;
  /** 1-2 sentence Spanish-MX rationale, used for telemetry/debug only. */
  reason: string;
}

/**
 * Picks the correct answer for a single multiple-choice knowledge question
 * shown inside an application form (e.g. LaPieza technical screens).
 *
 * The candidate's profile and the vacancy are passed in only as context —
 * the right answer is the right answer regardless of who is filling the
 * form, so we keep temperature low (0.1) and frame Gemini as a factual
 * QA grader, not a "best fit" matcher.
 *
 * Quota model: this endpoint is **not** charged. The user already paid 1
 * unit for the cover letter on the same application; quiz answering is
 * part of completing that same application. The route still gates on
 * `assertUnderLimit` to prevent free abuse.
 *
 * Output validation:
 * - `answerKey` must be a non-empty string AND must match one of the
 *   `options[i].key` values. If Gemini hallucinates a new key we throw
 *   502 UPSTREAM_ERROR (no fallback — picking a wrong answer in a quiz
 *   would actively hurt the user).
 * - `reason` defaults to a generic Spanish-MX string if missing.
 */
export async function answerQuiz(
  args: AnswerQuizArgs
): Promise<AnswerQuizResult> {
  const { apiKey, model, question, options, profile, job } = args;
  if (!apiKey) throw new HttpError(500, "INTERNAL_ERROR", "Configuración del servicio incompleta.");
  if (!profile) throw new HttpError(400, "VALIDATION_ERROR", "Falta el perfil del candidato.");
  if (!job) throw new HttpError(400, "VALIDATION_ERROR", "Falta la información de la vacante.");
  if (!question || !question.trim()) {
    throw new HttpError(400, "VALIDATION_ERROR", "Falta la pregunta del quiz.");
  }
  if (!Array.isArray(options) || options.length === 0) {
    throw new HttpError(400, "VALIDATION_ERROR", "Faltan las opciones del quiz.");
  }

  // Render options as a deterministic bullet list. Keep the keys verbatim so
  // Gemini's response can be matched 1:1 against the input.
  const optionsText = options
    .map((o) => `- ${o.key}) ${o.text}`)
    .join("\n");

  // Truncate the profile JSON to keep prompt size predictable. The full
  // profile is irrelevant for factual QA — we just want enough signal that
  // Gemini can disambiguate domain-specific phrasing if needed.
  const profileBlurb = JSON.stringify(profile, null, 2).slice(0, 800);

  const userText =
    `Pregunta: ${question}\n\n` +
    `Opciones:\n${optionsText}\n\n` +
    `Contexto (perfil del candidato, no determinante):\n${profileBlurb}\n\n` +
    `Vacante:\n${job.title} en ${job.company}\n\n` +
    `Devuelve la llave correcta y una razón de 1-2 frases.`;

  const body = {
    systemInstruction: { parts: [{ text: ANSWER_QUIZ_SYSTEM }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig: {
      // Factual QA — keep creativity to a minimum so the model picks the
      // canonically correct option instead of "an interesting one".
      temperature: 0.1,
      // For a quiz "good" means CORRECT. A small thinking budget lets the
      // model reason through tricky technical items (best-practice, "which
      // is NOT…", multi-step) before committing. Kept small because a quiz
      // can fire 20+ times and latency compounds; maxOutputTokens is bumped
      // well above it so the answerKey is never truncated.
      maxOutputTokens: 1400,
      thinkingConfig: { thinkingBudget: 512 },
      responseMimeType: "application/json",
      responseJsonSchema: ANSWER_QUIZ_SCHEMA
    }
  };

  const res = await callGenerate(apiKey, model, body);
  const out = extractJson<{ answerKey?: unknown; reason?: unknown }>(res);

  const rawKey = typeof out.answerKey === "string" ? out.answerKey.trim() : "";
  if (!rawKey) {
    throw new HttpError(502, "UPSTREAM_ERROR", "La IA no devolvió una opción válida.");
  }
  // Verify the key is one of the input options. Gemini occasionally returns
  // a letter the schema didn't include (e.g. "E" on a 4-option quiz); we
  // refuse to relay that to the user since selecting the wrong option in a
  // graded quiz is worse than failing fast.
  const match = options.find((o) => o.key === rawKey);
  if (!match) {
    throw new HttpError(502, "UPSTREAM_ERROR", "La IA respondió con una opción inválida.");
  }

  const reason =
    typeof out.reason === "string" && out.reason.trim()
      ? out.reason.trim()
      : "Respuesta seleccionada por la IA.";

  return { answerKey: match.key, reason };
}

// ---------------------------------------------------------------------------
// Match analysis ("Match real con IA") — accurate, semantic fit score + how
// to raise it. This is the premium-ish differentiator: not just "apply for
// you" but "maximize that you get picked".
// ---------------------------------------------------------------------------

const MATCH_ANALYSIS_SYSTEM =
  "Eres un reclutador técnico senior en México con 15 años evaluando " +
  "candidatos. Analizas qué tan bien encaja UN candidato en UNA vacante " +
  "específica, de forma SEMÁNTICA, honesta y accionable. Recibes la vacante " +
  "completa (con descripción y requisitos) y el perfil del candidato.\n\n" +
  "Devuelve SOLO el JSON solicitado, en español MX, con:\n" +
  "1. score (0-100): la afinidad REAL del candidato con ESTA vacante. NO lo " +
  "infles ni lo castigues de más. Pondera: experiencia/años relevantes, " +
  "skills y herramientas que pide la vacante, seniority, dominio de negocio, " +
  "modalidad/ubicación e idioma. Un fit fuerte real = 75-95; fit decente con " +
  "huecos = 50-74; fit débil = 20-49; casi nulo = 0-19.\n" +
  "2. level: 'high' si score>=75, 'mid' si 50-74, 'low' si <50. Debe ser " +
  "coherente con score.\n" +
  "3. matches (3-6): fortalezas REALES del CV que cubren requisitos de la " +
  "vacante. Cada una corta y CITANDO un dato del CV (empresa, herramienta, " +
  "años o métrica). Ej: 'Lideraste ventas B2B en [empresa] — justo lo que " +
  "piden'. NO inventes nada que no esté en el CV.\n" +
  "4. gaps (1-5): requisitos de la vacante que el CV NO demuestra o demuestra " +
  "débil. Honesto pero no cruel. Ej: 'Piden inglés avanzado; tu CV no lo " +
  "menciona'.\n" +
  "5. improveTips (2-4): acciones CONCRETAS para subir el match SIN mentir — " +
  "una keyword real a destacar, un logro a cuantificar, una sección a " +
  "reordenar, una certificación que sí tiene y no resaltó. Cada tip empieza " +
  "con un verbo. NUNCA sugieras inventar experiencia.\n\n" +
  "Refleja las keywords de la vacante. Nada genérico — si una frase serviría " +
  "para cualquier candidato/vacante, reescríbela con un hecho específico.";

const MATCH_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer" },
    level: { type: "string", enum: ["high", "mid", "low"] },
    matches: { type: "array", items: { type: "string" } },
    gaps: { type: "array", items: { type: "string" } },
    improveTips: { type: "array", items: { type: "string" } }
  },
  required: ["score", "level", "matches", "gaps", "improveTips"]
} as const;

export interface AnalyzeMatchArgs {
  apiKey: string;
  model: string;
  profile: UserProfile;
  job: JobPosting;
}

export interface AnalyzeMatchResult {
  score: number;
  level: "high" | "mid" | "low";
  matches: string[];
  gaps: string[];
  improveTips: string[];
}

const levelFromScore = (s: number): "high" | "mid" | "low" =>
  s >= 75 ? "high" : s >= 50 ? "mid" : "low";

const cleanList = (v: unknown, max: number): string[] =>
  (Array.isArray(v) ? v : [])
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim())
    .slice(0, max);

/**
 * Accurate, semantic match analysis of a candidate against ONE vacancy.
 * Reuses callGenerate/extractJson like the other AI helpers. Output is
 * defensively normalized: score clamped 0-100, level re-derived from score
 * (so it can never contradict the number the user sees), arrays cleaned/capped.
 */
export async function analyzeMatch(args: AnalyzeMatchArgs): Promise<AnalyzeMatchResult> {
  const { apiKey, model, profile, job } = args;
  if (!apiKey) throw new HttpError(500, "INTERNAL_ERROR", "Configuración del servicio incompleta.");
  if (!profile) throw new HttpError(400, "VALIDATION_ERROR", "Falta el perfil del candidato.");
  if (!job) throw new HttpError(400, "VALIDATION_ERROR", "Falta la información de la vacante.");

  const userText =
    `VACANTE (JSON):\n${JSON.stringify(job, null, 2)}\n\n` +
    `PERFIL DEL CANDIDATO (JSON):\n${JSON.stringify(profile, null, 2)}\n\n` +
    `Analiza el match real del candidato con ESTA vacante y devuelve el JSON ` +
    `con score, level, matches, gaps e improveTips siguiendo las reglas.`;

  const body = {
    systemInstruction: { parts: [{ text: MATCH_ANALYSIS_SYSTEM }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig: {
      // Low-ish temp for a consistent, defensible score; a modest thinking
      // budget lets it reason about WHICH facts match before scoring.
      temperature: 0.3,
      maxOutputTokens: 3000,
      thinkingConfig: { thinkingBudget: 1024 },
      responseMimeType: "application/json",
      responseJsonSchema: MATCH_ANALYSIS_SCHEMA
    }
  };

  const res = await callGenerate(apiKey, model, body);
  const out = extractJson<{
    score?: unknown;
    level?: unknown;
    matches?: unknown;
    gaps?: unknown;
    improveTips?: unknown;
  }>(res);

  let score = Number(out.score);
  if (!Number.isFinite(score)) score = 0;
  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    score,
    level: levelFromScore(score), // re-derive so level can't contradict score
    matches: cleanList(out.matches, 6),
    gaps: cleanList(out.gaps, 5),
    improveTips: cleanList(out.improveTips, 4)
  };
}
