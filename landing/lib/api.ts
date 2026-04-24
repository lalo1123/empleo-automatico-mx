// Thin fetch wrapper for the SkyBrandMX backend.
// Base URL is read from NEXT_PUBLIC_API_URL (see .env.example).
//
// Contract: every response is `{ ok: true, ... }` or `{ ok: false, error: { code, message } }`.
// See COMMERCIAL.md for the authoritative contract.

import type { PlanId, BillingInterval } from "./plans";

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  plan: PlanId;
  planExpiresAt?: number;
  emailVerified?: boolean;
}

export interface VerificationPayload {
  verificationUrl: string;
  expiresAt: number;
  token: string;
}

export interface Usage {
  current: number;
  limit: number;
  periodStart: number;
  periodEnd: number;
}

export interface AccountResponse {
  user: AuthUser;
  usage: Usage;
}

export interface ApiError {
  code: string;
  message: string;
}

export class ApiCallError extends Error {
  code: string;
  status: number;
  constructor(err: ApiError, status: number) {
    super(err.message);
    this.code = err.code;
    this.status = status;
  }
}

const DEFAULT_ERROR: ApiError = {
  code: "NETWORK_ERROR",
  message: "No pudimos conectar con el servidor. Intenta de nuevo en unos segundos.",
};

function baseUrl(): string {
  const url = process.env.NEXT_PUBLIC_API_URL;
  if (!url) {
    // Don't throw at import time — let callers fail gracefully in dev when env missing.
    return "http://localhost:8787/v1";
  }
  return url.replace(/\/+$/, "");
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  token?: string;
  // AbortSignal passed through to fetch (e.g. for server action timeouts).
  signal?: AbortSignal;
}

export async function apiRequest<T>(
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const { method = "GET", body, token, signal } = opts;
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal,
    });
  } catch {
    throw new ApiCallError(DEFAULT_ERROR, 0);
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    // Empty 204 responses are OK — caller should not rely on body in that case.
    if (res.status === 204) return undefined as unknown as T;
    throw new ApiCallError(
      {
        code: "INVALID_RESPONSE",
        message: "Respuesta inesperada del servidor.",
      },
      res.status,
    );
  }

  if (!res.ok || (payload && typeof payload === "object" && "ok" in payload && (payload as { ok: boolean }).ok === false)) {
    const err =
      (payload as { error?: ApiError } | undefined)?.error ?? DEFAULT_ERROR;
    throw new ApiCallError(err, res.status);
  }

  // Strip the envelope — callers want the inner data.
  if (payload && typeof payload === "object" && "ok" in payload) {
    const { ok: _ok, ...rest } = payload as Record<string, unknown>;
    return rest as T;
  }
  return payload as T;
}

// Convenience wrappers for specific endpoints.

export function signup(input: {
  email: string;
  password: string;
  name?: string;
  turnstileToken?: string;
}) {
  return apiRequest<{
    token: string;
    user: AuthUser;
    requiresVerification?: boolean;
    verification?: VerificationPayload;
  }>("/auth/signup", {
    method: "POST",
    body: input,
  });
}

export function login(input: {
  email: string;
  password: string;
  turnstileToken?: string;
}) {
  return apiRequest<{ token: string; user: AuthUser }>("/auth/login", {
    method: "POST",
    body: input,
  });
}

export function verifyEmail(token: string) {
  return apiRequest<{ userId: string }>("/auth/verify-email", {
    method: "POST",
    body: { token },
  });
}

export function resendVerification(token: string) {
  return apiRequest<{
    alreadyVerified?: boolean;
    verification?: VerificationPayload;
  }>("/auth/resend-verification", {
    method: "POST",
    token,
  });
}

export function logout(token: string) {
  return apiRequest<void>("/auth/logout", { method: "POST", token });
}

export function getAccount(token: string) {
  return apiRequest<AccountResponse>("/account", { token });
}

export function createCheckout(
  token: string,
  plan: Exclude<PlanId, "free">,
  interval: BillingInterval = "monthly",
) {
  return apiRequest<{ checkoutUrl: string }>("/billing/checkout", {
    method: "POST",
    token,
    body: { plan, interval },
  });
}

export function cancelSubscription(token: string) {
  return apiRequest<{ status: string; effectiveAt: number }>("/billing/cancel", {
    method: "POST",
    token,
  });
}
