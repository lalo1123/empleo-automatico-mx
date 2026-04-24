// Server-side auth helpers. These run only on the server (server components,
// server actions, route handlers). The JWT lives in an httpOnly cookie so the
// browser JS code can never read it — all authenticated calls go through
// server actions or /app/api route handlers.

import { cookies } from "next/headers";

export const AUTH_COOKIE = "skybrand_session";
// Transient cookie carrying the latest email verification URL surfaced by the
// backend. Remove once Resend/SES is wired up and we rely on email delivery
// instead. 24h matches VERIFICATION_TTL_SECONDS on the server.
export const VERIFICATION_COOKIE = "skybrand_verify_url";
// 30 days — matches backend JWT expiry (see COMMERCIAL.md).
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
const VERIFICATION_MAX_AGE = 60 * 60 * 24;

function cookieDomain(): string | undefined {
  const dom = process.env.AUTH_COOKIE_DOMAIN;
  // `localhost` as a Domain attribute is rejected by browsers — leave unset.
  if (!dom || dom === "localhost") return undefined;
  return dom;
}

export async function setSessionCookie(token: string): Promise<void> {
  const jar = await cookies();
  jar.set({
    name: AUTH_COOKIE,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
    domain: cookieDomain(),
  });
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.set({
    name: AUTH_COOKIE,
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    domain: cookieDomain(),
  });
}

export async function getSessionToken(): Promise<string | null> {
  const jar = await cookies();
  const token = jar.get(AUTH_COOKIE)?.value;
  return token && token.length > 0 ? token : null;
}

export async function setVerificationUrlCookie(url: string): Promise<void> {
  const jar = await cookies();
  jar.set({
    name: VERIFICATION_COOKIE,
    value: url,
    // Not httpOnly — the account page shows a "click to verify" link built
    // from this. Readable from server components only (we never touch it
    // from client JS).
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: VERIFICATION_MAX_AGE,
    domain: cookieDomain(),
  });
}

export async function getVerificationUrlCookie(): Promise<string | null> {
  const jar = await cookies();
  const v = jar.get(VERIFICATION_COOKIE)?.value;
  return v && v.length > 0 ? v : null;
}

export async function clearVerificationUrlCookie(): Promise<void> {
  const jar = await cookies();
  jar.set({
    name: VERIFICATION_COOKIE,
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    domain: cookieDomain(),
  });
}
