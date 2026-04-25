import { NextResponse } from "next/server";
import { loginWithGoogle, ApiCallError } from "@/lib/api";
import { setSessionCookie } from "@/lib/auth";

// Proxy Google Sign-In through our own server so we can set the
// httpOnly skybrand_session cookie. The Google ID token is single-use:
// once we exchange it with our backend, the client doesn't need it again.
export async function POST(req: Request): Promise<Response> {
  let body: { idToken?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_REQUEST", message: "Invalid JSON." } },
      { status: 400 },
    );
  }

  const idToken =
    typeof body.idToken === "string" && body.idToken.length > 0
      ? body.idToken
      : "";
  if (!idToken) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "BAD_REQUEST",
          message: "Falta el token de Google.",
        },
      },
      { status: 400 },
    );
  }

  try {
    const { token, user } = await loginWithGoogle(idToken);
    await setSessionCookie(token);
    return NextResponse.json({ ok: true, user });
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
