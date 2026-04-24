import { NextResponse } from "next/server";
import { getAccount, ApiCallError } from "@/lib/api";
import { clearSessionCookie, getSessionToken } from "@/lib/auth";

export async function GET(): Promise<Response> {
  const token = await getSessionToken();
  if (!token) {
    return NextResponse.json(
      { ok: false, error: { code: "UNAUTHENTICATED", message: "Sin sesión." } },
      { status: 401 },
    );
  }

  try {
    const data = await getAccount(token);
    return NextResponse.json({ ok: true, ...data });
  } catch (err) {
    if (err instanceof ApiCallError) {
      if (err.status === 401 || err.status === 403) {
        await clearSessionCookie();
      }
      return NextResponse.json(
        { ok: false, error: { code: err.code, message: err.message } },
        { status: err.status || 500 },
      );
    }
    return NextResponse.json(
      { ok: false, error: { code: "UNKNOWN", message: "Error inesperado." } },
      { status: 500 },
    );
  }
}
