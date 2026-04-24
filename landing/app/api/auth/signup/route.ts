import { NextResponse } from "next/server";
import { signup, ApiCallError } from "@/lib/api";
import { setSessionCookie, setVerificationUrlCookie } from "@/lib/auth";

export async function POST(req: Request): Promise<Response> {
  let body: {
    email?: unknown;
    password?: unknown;
    name?: unknown;
    turnstileToken?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_REQUEST", message: "Invalid JSON." } },
      { status: 400 },
    );
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const name =
    typeof body.name === "string" && body.name.trim().length > 0
      ? body.name.trim()
      : undefined;
  const turnstileToken =
    typeof body.turnstileToken === "string" && body.turnstileToken.length > 0
      ? body.turnstileToken
      : undefined;

  if (!email || !password) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "BAD_REQUEST", message: "Email y contraseña requeridos." },
      },
      { status: 400 },
    );
  }
  if (password.length < 8) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "WEAK_PASSWORD",
          message: "La contraseña debe tener al menos 8 caracteres.",
        },
      },
      { status: 400 },
    );
  }

  try {
    const { token, user, verification, requiresVerification } = await signup({
      email,
      password,
      name,
      turnstileToken,
    });
    await setSessionCookie(token);
    if (verification?.verificationUrl) {
      await setVerificationUrlCookie(verification.verificationUrl);
    }
    return NextResponse.json(
      { ok: true, user, requiresVerification, verification },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof ApiCallError) {
      return NextResponse.json(
        { ok: false, error: { code: err.code, message: err.message } },
        { status: err.status || 500 },
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: { code: "UNKNOWN", message: "Error inesperado." },
      },
      { status: 500 },
    );
  }
}
