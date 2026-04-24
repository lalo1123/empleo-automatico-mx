import { NextResponse } from "next/server";
import { logout } from "@/lib/api";
import { clearSessionCookie, getSessionToken } from "@/lib/auth";

export async function POST(): Promise<Response> {
  const token = await getSessionToken();
  if (token) {
    // Best-effort: if the backend is down, we still clear our cookie.
    try {
      await logout(token);
    } catch {
      /* ignore */
    }
  }
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}
