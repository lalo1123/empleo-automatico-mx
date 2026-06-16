// Next.js API proxy for CV/profile. The client component can't read the
// httpOnly session cookie, so this bridges it to the backend with the bearer
// token. GET → load CV, PUT → save edits, POST {action:"parse"|"build"} →
// generate from pasted text or the AI chat interview.

import { NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import {
  getProfile,
  putProfile,
  parseCv,
  buildProfileFromQa,
  ApiCallError,
  type UserProfile,
} from "@/lib/api";

export const dynamic = "force-dynamic";

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function handleErr(err: unknown) {
  if (err instanceof ApiCallError) {
    return NextResponse.json(
      { ok: false, error: { code: err.code, message: err.message } },
      { status: err.status || 500 }
    );
  }
  return fail("UNKNOWN", "Error inesperado.", 500);
}

export async function GET() {
  const token = await getSessionToken();
  if (!token) return fail("UNAUTHORIZED", "Sesión expirada.", 401);
  try {
    const data = await getProfile(token);
    return NextResponse.json({ ok: true, ...data });
  } catch (err) {
    return handleErr(err);
  }
}

export async function PUT(req: Request) {
  const token = await getSessionToken();
  if (!token) return fail("UNAUTHORIZED", "Sesión expirada.", 401);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("INVALID_INPUT", "Body inválido.", 400);
  }
  const profile = (body as { profile?: UserProfile })?.profile;
  if (!profile) return fail("INVALID_INPUT", "Falta el perfil.", 400);
  try {
    const data = await putProfile(token, profile);
    return NextResponse.json({ ok: true, ...data });
  } catch (err) {
    return handleErr(err);
  }
}

export async function POST(req: Request) {
  const token = await getSessionToken();
  if (!token) return fail("UNAUTHORIZED", "Sesión expirada.", 401);
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail("INVALID_INPUT", "Body inválido.", 400);
  }
  const action = body.action;
  try {
    if (action === "parse") {
      const text = typeof body.text === "string" ? body.text : "";
      if (text.trim().length < 20) return fail("INVALID_INPUT", "Pega más texto de tu CV.", 400);
      const data = await parseCv(token, text);
      return NextResponse.json({ ok: true, ...data });
    }
    if (action === "build") {
      const qa = Array.isArray(body.qa) ? (body.qa as Array<{ question: string; answer: string }>) : [];
      if (!qa.length) return fail("INVALID_INPUT", "Faltan tus respuestas.", 400);
      const data = await buildProfileFromQa(token, qa);
      return NextResponse.json({ ok: true, ...data });
    }
    return fail("INVALID_INPUT", "Acción inválida.", 400);
  } catch (err) {
    return handleErr(err);
  }
}
