// Typed wrapper around process.env. Validates required vars at boot with Zod
// so a misconfigured container fails fast instead of erroring at request time.

import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["production", "development", "test"]).default("development"),
  PORT: z
    .string()
    .default("8787")
    .transform((v) => {
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0 || n > 65535) {
        throw new Error(`PORT must be a valid port number (got "${v}")`);
      }
      return n;
    }),

  // Storage
  DATABASE_PATH: z.string().default("./data/empleo.db"),

  // Auth
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 chars"),

  // AI
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required"),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),

  // Payments (Conekta)
  CONEKTA_API_KEY: z.string().min(1, "CONEKTA_API_KEY is required"),
  CONEKTA_WEBHOOK_KEY: z.string().min(1, "CONEKTA_WEBHOOK_KEY is required"),
  CONEKTA_PLAN_PRO_MONTHLY: z.string().default(""),
  CONEKTA_PLAN_PRO_YEARLY: z.string().default(""),
  CONEKTA_PLAN_PREMIUM_MONTHLY: z.string().default(""),
  CONEKTA_PLAN_PREMIUM_YEARLY: z.string().default(""),

  // UI integration
  FRONTEND_BACK_URL: z
    .string()
    .url()
    .default("https://empleo.skybrandmx.com/account?sub=success"),
  // Public URL of the landing used in verification links surfaced to the
  // user. Only referenced by the signup response payload; not inlined anywhere.
  FRONTEND_URL: z
    .string()
    .url()
    .default("https://empleo.skybrandmx.com"),
  CORS_ORIGINS: z
    .string()
    .default(
      "https://empleo.skybrandmx.com,https://skybrandmx.com,chrome-extension://*,http://localhost:3000,http://localhost:5173"
    ),

  // ---- Anti-abuse --------------------------------------------------------
  // Cloudflare Turnstile — get keys at https://dash.cloudflare.com -> Turnstile.
  // Leave blank to skip CAPTCHA checks (dev / local tests).
  TURNSTILE_SECRET: z.string().default(""),
  // Comma-separated extra domains to block on signup (extends the bundled
  // list in src/lib/disposable-domains.ts).
  DISPOSABLE_DOMAINS_EXTRA: z.string().default(""),

  // ---- Google Sign-In ----------------------------------------------------
  // OAuth 2.0 Client ID for the "Web application" client created in
  // Google Cloud Console -> APIs & Services -> Credentials. Used as the
  // expected `aud` when verifying Google-issued ID tokens.
  // Leave blank to disable the /v1/auth/google endpoint (it returns
  // 503 GOOGLE_OAUTH_DISABLED in that case). Same value MUST be set as
  // NEXT_PUBLIC_GOOGLE_CLIENT_ID on the landing.
  GOOGLE_CLIENT_ID: z.string().default(""),

  // ---- Admin -------------------------------------------------------------
  // Comma-separated allowlist of emails that get admin powers (currently:
  // /v1/admin/me/plan to switch their own plan without paying). Used for
  // testing how the extension behaves under each plan tier. Leave blank to
  // fully disable admin endpoints in production.
  // Matched case-insensitively against `users.email`.
  // Example: ADMIN_USER_EMAILS=serratoslalo@hotmail.com,karla@skybrandmx.com
  ADMIN_USER_EMAILS: z.string().default("")
});

export type AppEnv = z.infer<typeof envSchema>;

let cached: AppEnv | null = null;

export function loadEnv(): AppEnv {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Environment validation failed:\n${details}`);
  }
  cached = parsed.data;
  return cached;
}

// Resets the cache — test helper.
export function resetEnvCache(): void {
  cached = null;
}

// Hono app context typing. `Variables` are the values set via c.set().
export interface AppContext {
  Variables: {
    user: import("../types.js").User;
    jti: string;
  };
}

// ---- Admin allowlist helpers ---------------------------------------------

let adminEmailsCache: { source: string; set: Set<string> } | null = null;

function getAdminEmailSet(env: AppEnv): Set<string> {
  const raw = env.ADMIN_USER_EMAILS || "";
  if (adminEmailsCache && adminEmailsCache.source === raw) {
    return adminEmailsCache.set;
  }
  const set = new Set<string>(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0)
  );
  adminEmailsCache = { source: raw, set };
  return set;
}

/**
 * True when the given email is on the admin allowlist (case-insensitive).
 * Returns false when the allowlist is empty — keeps prod safe by default.
 */
export function isAdminEmail(env: AppEnv, email: string | null | undefined): boolean {
  if (!email) return false;
  const set = getAdminEmailSet(env);
  if (set.size === 0) return false;
  return set.has(email.toLowerCase());
}
