// Thin Next.js API proxy that reads the session cookie and forwards
// PUT /api/preferences → /v1/account/preferences with the bearer token.
// The PreferencesForm client component can't read httpOnly cookies
// directly, so this proxy bridges that gap without exposing the JWT
// to the browser.

import { NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { putPreferences, ApiCallError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function PUT(req: Request) {
  const token = await getSessionToken();
  if (!token) {
    return NextResponse.json(
      { ok: false, error: { code: "UNAUTHORIZED", message: "Sesión expirada." } },
      { status: 401 }
    );
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "INVALID_INPUT", message: "Body inválido." } },
      { status: 400 }
    );
  }
  const b = (body ?? {}) as Record<string, unknown>;
  try {
    const data = await putPreferences(token, {
      city: typeof b.city === "string" ? b.city : undefined,
      citySynonyms: Array.isArray(b.citySynonyms) ? (b.citySynonyms as string[]) : undefined,
      modality:
        b.modality === "presencial" ||
        b.modality === "remoto" ||
        b.modality === "hibrido" ||
        b.modality === "any"
          ? b.modality
          : undefined,
      salaryMin:
        b.salaryMin === null || typeof b.salaryMin === "number" ? b.salaryMin : undefined,
      salaryMax:
        b.salaryMax === null || typeof b.salaryMax === "number" ? b.salaryMax : undefined,
      expectedSalary: typeof b.expectedSalary === "string" ? b.expectedSalary : undefined,
      autoSubmit: typeof b.autoSubmit === "boolean" ? b.autoSubmit : undefined,
      personalAnswers:
        b.personalAnswers && typeof b.personalAnswers === "object" && !Array.isArray(b.personalAnswers)
          ? (b.personalAnswers as Record<string, string>)
          : undefined,
    });
    return NextResponse.json({ ok: true, ...data });
  } catch (err) {
    if (err instanceof ApiCallError) {
      return NextResponse.json(
        { ok: false, error: { code: err.code, message: err.message } },
        { status: err.status || 500 }
      );
    }
    return NextResponse.json(
      { ok: false, error: { code: "UNKNOWN", message: "Error al guardar." } },
      { status: 500 }
    );
  }
}
