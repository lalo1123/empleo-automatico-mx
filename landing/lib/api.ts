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
  /** Google profile picture URL (when the user signed in with Google). */
  avatarUrl?: string | null;
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
  // The backend bundles preferences into /v1/account to save a round-trip;
  // the dashboard uses it for the launch-checklist state (salario esperado).
  preferences?: UserPreferences;
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

/**
 * Exchange a Google-issued ID token for our session JWT. The backend
 * verifies the token against Google's JWKS, links/creates the local user,
 * and returns our standard {token, user} envelope.
 */
export function loginWithGoogle(idToken: string) {
  return apiRequest<{ token: string; user: AuthUser }>("/auth/google", {
    method: "POST",
    body: { idToken },
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

// Application history (synced from the Chrome extension on Finalizar).

export type ApplicationSource =
  | "lapieza" | "occ" | "computrabajo" | "bumeran" | "indeed" | "linkedin";
export type ApplicationStatus = "applied" | "viewed" | "rejected" | "hired";

export type ApplicationStep =
  | "starting" | "cv" | "cv_personalized" | "cover" | "questions" | "quiz"
  | "ready" | "submitted" | "error" | "plan_limit" | "closed" | "no_form"
  | "already_applied";

export interface ApplicationEvent {
  step: ApplicationStep;
  at: number;
  label?: string;
  meta?: Record<string, string | number | boolean>;
}

export interface Application {
  id: number;
  source: ApplicationSource;
  vacancyId: string;
  url: string;
  title: string;
  company: string;
  location: string;
  matchScore: number;
  status: ApplicationStatus;
  appliedAt: number;
  sourceTs: number | null;
  reasons: string[];
  events: ApplicationEvent[];
}

export interface ApplicationsHistoryResponse {
  page: number;
  pageSize: number;
  total: number;
  applications: Application[];
}

export interface ApplicationsStats {
  totalAll: number;
  totalMonth: number;
  totalWeek: number;
  total7d: number;
  bySource: Record<ApplicationSource, number>;
}

export function getApplicationsHistory(
  token: string,
  opts: {
    source?: ApplicationSource;
    status?: ApplicationStatus;
    page?: number;
    pageSize?: number;
    fromTs?: number;
    toTs?: number;
  } = {}
) {
  const qs = new URLSearchParams();
  if (opts.source) qs.set("source", opts.source);
  if (opts.status) qs.set("status", opts.status);
  if (opts.page) qs.set("page", String(opts.page));
  if (opts.pageSize) qs.set("pageSize", String(opts.pageSize));
  if (opts.fromTs != null) qs.set("fromTs", String(opts.fromTs));
  if (opts.toTs != null) qs.set("toTs", String(opts.toTs));
  const suffix = qs.toString() ? `?${qs}` : "";
  return apiRequest<ApplicationsHistoryResponse>(`/applications/history${suffix}`, { token });
}

export function getApplicationsStats(token: string) {
  return apiRequest<{ stats: ApplicationsStats }>("/applications/stats", { token });
}

// Preferences (city / modality / salary range / auto-answers)
export type Modality = "presencial" | "remoto" | "hibrido" | "any";

/** Whitelisted personal auto-answer keys — keep in sync with
 *  backend/src/types.ts PERSONAL_ANSWER_KEYS. */
export const PERSONAL_ANSWER_KEYS = [
  "vehiculo",
  "licencia",
  "viajar",
  "reubicarse",
  "ingles",
  "inicio",
  "portafolio",
  "linkedin",
] as const;
export type PersonalAnswerKey = (typeof PERSONAL_ANSWER_KEYS)[number];
export type PersonalAnswers = Partial<Record<PersonalAnswerKey, string>>;

export interface UserPreferences {
  city: string;
  citySynonyms: string[];
  modality: Modality;
  salaryMin: number | null;
  salaryMax: number | null;
  expectedSalary: string;
  autoSubmit: boolean;
  personalAnswers: PersonalAnswers;
  updatedAt: number;
}

export function getPreferences(token: string) {
  return apiRequest<{ preferences: UserPreferences }>("/account/preferences", { token });
}

export function putPreferences(
  token: string,
  body: {
    city?: string;
    citySynonyms?: string[];
    modality?: Modality;
    salaryMin?: number | null;
    salaryMax?: number | null;
    expectedSalary?: string;
    autoSubmit?: boolean;
    personalAnswers?: PersonalAnswers;
  }
) {
  return apiRequest<{ preferences: UserPreferences }>("/account/preferences", {
    method: "PUT",
    token,
    body
  });
}

// CV / Profile — the account is the canonical CV store.
export interface ProfileExperience {
  company: string;
  role: string;
  startDate?: string;
  endDate?: string | null;
  description?: string;
  achievements?: string[];
  location?: string;
}
export interface ProfileEducation {
  institution: string;
  degree: string;
  field?: string;
  startDate?: string;
  endDate?: string | null;
}
export interface ProfileLanguage {
  language: string;
  level: string;
}
export interface UserProfile {
  version?: number;
  updatedAt?: string;
  personal: {
    fullName: string;
    email?: string;
    phone?: string;
    location?: string;
    linkedin?: string;
    website?: string;
  };
  summary: string;
  experience: ProfileExperience[];
  education: ProfileEducation[];
  skills: string[];
  languages: ProfileLanguage[];
  rawText?: string;
}

export function getProfile(token: string) {
  return apiRequest<{ profile: UserProfile | null }>("/account/profile", { token });
}
export function putProfile(token: string, profile: UserProfile) {
  return apiRequest<{ profile: UserProfile }>("/account/profile", {
    method: "PUT",
    token,
    body: { profile }
  });
}
export function parseCv(token: string, text: string) {
  return apiRequest<{ profile: UserProfile }>("/applications/parse-cv", {
    method: "POST",
    token,
    body: { text }
  });
}
export function buildProfileFromQa(token: string, qa: Array<{ question: string; answer: string }>) {
  return apiRequest<{ profile: UserProfile }>("/applications/build-profile", {
    method: "POST",
    token,
    body: { qa }
  });
}
