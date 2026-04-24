import { NextResponse } from "next/server";
import { login, ApiCallError } from "@/lib/api";
import { setSessionCookie } from "@/lib/auth";

// Proxy login from the browser. The reason we expose this at all is so the
// server can set an httpOnly cookie on success. The JWT never touches client JS.
export async function POST(req: Request): Promise<Response> {
  let body: { email?: unknown; password?: unknown };
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
  if (!email || !password) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "BAD_REQUEST", message: "Email y contraseña requeridos." },
      },
      { status: 400 },
    );
  }

  try {
    const { token, user } = await login({ email, password });
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
