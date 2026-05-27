// Shared domain types. Ported from lib/schemas.js (extension) to TypeScript.

export type PlanId = "free" | "pro" | "premium";
export type BillingInterval = "monthly" | "yearly";
export type SubscriptionStatus =
  | "pending"
  | "active"
  | "paused"
  | "cancelled"
  | "expired";

export interface User {
  id: string;
  email: string;
  name: string | null;
  plan: PlanId;
  planExpiresAt: number | null;
  emailVerified: boolean;
  /** Google profile picture URL (null for non-Google users). */
  avatarUrl: string | null;
  /**
   * Derived flag — TRUE when the user's email is in ADMIN_USER_EMAILS env.
   * Not stored in the DB. Computed by `rowToUser(row, env)` so the response
   * shape stays the same whether or not the env is wired up.
   */
  isAdmin: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface UserRow {
  id: string;
  email: string;
  /**
   * Bcrypt hash for email/password users, or the sentinel string
   * "GOOGLE_ONLY" for accounts that only signed in via Google. The
   * sentinel is never a valid bcrypt hash so verifyPassword() will
   * always return false for it.
   */
  password_hash: string;
  name: string | null;
  plan: PlanId;
  plan_expires_at: number | null;
  conekta_customer_id: string | null;
  email_verified: number;
  google_id: string | null;
  avatar_url: string | null;
  created_at: number;
  updated_at: number;
}

export interface EmailVerificationRow {
  token: string;
  user_id: string;
  expires_at: number;
  consumed_at: number | null;
  created_at: number;
}

export interface SessionRow {
  jti: string;
  user_id: string;
  expires_at: number;
  revoked: number;
  created_at: number;
}

export interface SubscriptionRow {
  id: string;
  user_id: string;
  conekta_subscription_id: string | null;
  plan: PlanId;
  interval: BillingInterval;
  status: SubscriptionStatus;
  current_period_end: number | null;
  will_cancel_at_period_end: number;
  created_at: number;
  updated_at: number;
}

export interface UsageRow {
  user_id: string;
  year_month: string;
  count: number;
}

export type ApplicationSource =
  | "lapieza" | "occ" | "computrabajo" | "bumeran" | "indeed" | "linkedin";

export type ApplicationStatus = "applied" | "viewed" | "rejected" | "hired";

export interface ApplicationRow {
  id: number;
  user_id: string;
  source: ApplicationSource;
  vacancy_id: string;
  url: string;
  title: string;
  company: string;
  location: string;
  match_score: number;
  status: ApplicationStatus;
  applied_at: number;       // unix seconds, server-stamped on insert
  source_ts: number | null; // ms timestamp the extension reported
  reasons_json: string;     // JSON array of strings
}

export type Modality = "presencial" | "remoto" | "hibrido" | "any";

export interface PreferencesRow {
  user_id: string;
  city: string;
  city_synonyms: string;       // JSON array
  modality: Modality;
  salary_min: number | null;
  salary_max: number | null;
  updated_at: number;          // unix seconds
}

export interface UserPreferences {
  city: string;
  citySynonyms: string[];
  modality: Modality;
  salaryMin: number | null;
  salaryMax: number | null;
  updatedAt: number;           // unix seconds
}

/** Public/JSON shape — reasons_json is parsed, snake_case → camelCase. */
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
  appliedAt: number;        // unix seconds
  sourceTs: number | null;
  reasons: string[];
}

// Profile shape (mirrors lib/schemas.js JSDoc).

export interface PersonalInfo {
  fullName: string;
  email: string;
  phone: string;
  location: string;
  linkedin?: string;
  website?: string;
}

export interface ExperienceEntry {
  company: string;
  role: string;
  startDate: string;
  endDate: string | null;
  description: string;
  achievements: string[];
  location?: string;
}

export interface EducationEntry {
  institution: string;
  degree: string;
  field: string;
  startDate: string;
  endDate: string | null;
}

export type LanguageLevel = "básico" | "intermedio" | "avanzado" | "nativo";

export interface LanguageEntry {
  language: string;
  level: LanguageLevel;
}

export interface UserProfile {
  version?: 1;
  updatedAt?: string;
  personal: PersonalInfo;
  summary: string;
  experience: ExperienceEntry[];
  education: EducationEntry[];
  skills: string[];
  languages: LanguageEntry[];
  rawText?: string;
}

export interface JobPosting {
  source: "occ" | "computrabajo" | "linkedin" | "bumeran" | "indeed" | "lapieza";
  url: string;
  id: string;
  title: string;
  company: string;
  location: string;
  salary: string | null;
  modality: "presencial" | "remoto" | "híbrido" | null;
  description: string;
  requirements: string[];
  extractedAt: string;
}

// JWT payload.
export interface JwtPayload {
  sub: string;      // user id
  jti: string;      // session id
  iat: number;      // seconds
  exp: number;      // seconds
}

// API response envelopes.
export interface ApiSuccess<T> {
  ok: true;
  data?: T;
}

export interface ApiError {
  ok: false;
  error: { code: string; message: string };
}
