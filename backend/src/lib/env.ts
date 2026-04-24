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
  CORS_ORIGINS: z
    .string()
    .default(
      "https://empleo.skybrandmx.com,https://skybrandmx.com,chrome-extension://*,http://localhost:3000,http://localhost:5173"
    )
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
