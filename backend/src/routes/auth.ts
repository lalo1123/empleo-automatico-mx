// /v1/auth/* - signup, login, logout, verify-email, resend-verification.

import { Hono } from "hono";
import type { Context } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppContext } from "../lib/env.js";
import { loadEnv } from "../lib/env.js";
import { HttpError, sendError, errorResponse } from "../lib/errors.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { signToken } from "../lib/jwt.js";
import {
  consumeEmailVerification,
  countActiveEmailVerifications,
  createGoogleUser,
  createSession,
  createUser,
  findEmailVerification,
  findUserByEmail,
  findUserByGoogleId,
  findUserById,
  linkGoogleAccount,
  markUserEmailVerified,
  revokeSession,
  rowToUser
} from "../lib/db.js";
import { authRequired } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rate-limit.js";
import {
  buildDisposableSet,
  emailDomain,
  isDisposableEmail
} from "../lib/disposable-domains.js";
import { verifyTurnstile } from "../lib/turnstile.js";
import { issueVerificationToken } from "../lib/email-verification.js";
import { checkSignupAbuse } from "../lib/abuse-limits.js";
import { verifyGoogleIdToken } from "../lib/google-oauth.js";

const MIN_PASSWORD = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Turnstile token is optional in the schema — we treat missing-when-required
// as a CAPTCHA_FAILED response below, so we can return a dedicated code
// rather than a generic validation error.
const turnstileTokenSchema = z.string().min(1).max(2048).optional();

const signupSchema = z.object({
  email: z.string().trim().toLowerCase().regex(EMAIL_RE, "Correo invalido"),
  password: z.string().min(MIN_PASSWORD, `La contrasena debe tener al menos ${MIN_PASSWORD} caracteres`),
  name: z.string().trim().min(1).max(120).optional(),
  turnstileToken: turnstileTokenSchema
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().regex(EMAIL_RE, "Correo invalido"),
  password: z.string().min(1, "Contrasena requerida"),
  turnstileToken: turnstileTokenSchema
});

const verifyEmailSchema = z.object({
  token: z.string().trim().min(1).max(256)
});

// Google ID tokens are JWTs ~1.5KB on average. Cap at 4KB to bound work.
const googleSignInSchema = z.object({
  idToken: z.string().min(20).max(4096)
});

const authLimiter = rateLimit({ key: "auth", windowMs: 60_000, max: 10 });

// Limit resend-verification: 3 attempts per 10 min per IP on top of the
// per-user active-token cap in the handler.
const resendLimiter = rateLimit({ key: "auth-resend", windowMs: 10 * 60_000, max: 3 });

function clientIpFromRequest(c: Context): string {
  const xff = c.req.header("X-Forwarded-For");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xrip = c.req.header("X-Real-IP");
  if (xrip) return xrip.trim();
  const cf = c.req.header("CF-Connecting-IP");
  if (cf) return cf.trim();
  return "unknown";
}

export const authRoutes = new Hono<AppContext>();

authRoutes.post("/signup", authLimiter, async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    const parsed = signupSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Datos invalidos");
    }

    const { email, password, name, turnstileToken } = parsed.data;
    const env = loadEnv();
    const ip = clientIpFromRequest(c);

    // 1) CAPTCHA. When TURNSTILE_SECRET is unset, verifyTurnstile() short-circuits
    //    to ok:true — keeps local dev working without Cloudflare keys.
    const captcha = await verifyTurnstile(env.TURNSTILE_SECRET, turnstileToken, ip);
    if (!captcha.ok) {
      console.warn(
        `[auth] signup captcha failed ip=${ip} codes=${(captcha.errorCodes ?? []).join(",")}`
      );
      throw new HttpError(
        400,
        "CAPTCHA_FAILED",
        "No pudimos verificar que no eres un bot. Intenta de nuevo."
      );
    }

    // 2) Disposable-email blocklist. Cheap check before DB work.
    const disposableSet = buildDisposableSet(env.DISPOSABLE_DOMAINS_EXTRA);
    if (isDisposableEmail(email, disposableSet)) {
      const domain = emailDomain(email) ?? "";
      console.warn(`[auth] signup disposable-email blocked ip=${ip} domain=${domain}`);
      throw new HttpError(
        400,
        "EMAIL_NOT_ALLOWED",
        "Por favor usa un correo electrónico permanente."
      );
    }

    // 3) Per-email + per-/24-subnet abuse counters. Complement the IP rate
    //    limit above; see abuse-limits.ts for the thresholds.
    const abuse = checkSignupAbuse(email, ip);
    if (!abuse.ok) {
      if (abuse.retryAfter) c.header("Retry-After", String(abuse.retryAfter));
      console.warn(`[auth] signup abuse-limit trip reason=${abuse.reason} ip=${ip}`);
      throw new HttpError(
        429,
        "RATE_LIMITED",
        "Demasiados intentos de registro. Intenta de nuevo más tarde."
      );
    }

    const existing = findUserByEmail(email);
    if (existing) {
      throw new HttpError(409, "EMAIL_TAKEN", "Este correo ya esta registrado.");
    }

    const now = Math.floor(Date.now() / 1000);
    const userId = randomUUID();
    const passwordHash = await hashPassword(password);
    const userRow = createUser({
      id: userId,
      email,
      passwordHash,
      name: name ?? null,
      now
    });

    const { token, jti, exp } = signToken(env.JWT_SECRET, userId);
    createSession({ jti, userId, expiresAt: exp, now });

    // Issue the verification token. In MVP we surface it to the user in the
    // response — once a mailer is wired up this stays the same; we just also
    // send the email.
    const verification = issueVerificationToken(userId, now);

    console.log(`[auth] signup ok user=${userId} verify-pending=true`);
    return c.json(
      {
        ok: true,
        token,
        user: rowToUser(userRow),
        requiresVerification: true,
        verification: {
          verificationUrl: verification.verificationUrl,
          expiresAt: verification.expiresAt,
          // `token` is included so the landing can show a copy-paste fallback
          // while the mailer is still a TODO. Remove once email sending lands.
          token: verification.token
        }
      },
      201
    );
  } catch (err) {
    return sendError(c, err);
  }
});

authRoutes.post("/login", authLimiter, async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Datos invalidos");
    }

    const { email, password, turnstileToken } = parsed.data;
    const env = loadEnv();
    const ip = clientIpFromRequest(c);

    // CAPTCHA on login too — protects against credential stuffing.
    const captcha = await verifyTurnstile(env.TURNSTILE_SECRET, turnstileToken, ip);
    if (!captcha.ok) {
      console.warn(
        `[auth] login captcha failed ip=${ip} codes=${(captcha.errorCodes ?? []).join(",")}`
      );
      throw new HttpError(
        400,
        "CAPTCHA_FAILED",
        "No pudimos verificar que no eres un bot. Intenta de nuevo."
      );
    }

    const userRow = findUserByEmail(email);
    // Same error for "no user" and "bad password" to prevent account enumeration.
    if (!userRow) {
      throw new HttpError(401, "INVALID_CREDENTIALS", "Correo o contrasena incorrectos.");
    }
    const ok = await verifyPassword(password, userRow.password_hash);
    if (!ok) {
      throw new HttpError(401, "INVALID_CREDENTIALS", "Correo o contrasena incorrectos.");
    }

    const now = Math.floor(Date.now() / 1000);
    const { token, jti, exp } = signToken(env.JWT_SECRET, userRow.id);
    createSession({ jti, userId: userRow.id, expiresAt: exp, now });

    console.log(`[auth] login ok user=${userRow.id}`);
    return c.json({ ok: true, token, user: rowToUser(userRow) });
  } catch (err) {
    return sendError(c, err);
  }
});

// POST /v1/auth/google — Google Sign-In (One Tap + button).
//
// Body: { idToken: string }
// 1. Verify the ID token against Google's JWKS.
// 2. Look up by google_id; fall back to email-based lookup (link path).
// 3. Auto-create a passwordless user if neither exists.
// 4. Issue our own session JWT — same shape as /login.
//
// Disposable-domain check is NOT applied: Google has already verified the
// email address, and Gmail/Workspace addresses can't be disposable. The
// per-IP rate limit matches /login to keep credential-stuffing surface small.
authRoutes.post("/google", authLimiter, async (c) => {
  try {
    const env = loadEnv();
    if (!env.GOOGLE_CLIENT_ID) {
      throw new HttpError(
        503,
        "GOOGLE_OAUTH_DISABLED",
        "El inicio de sesión con Google no está habilitado."
      );
    }

    const body = await c.req.json().catch(() => null);
    const parsed = googleSignInSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        "VALIDATION_ERROR",
        parsed.error.issues[0]?.message ?? "Datos invalidos"
      );
    }

    const { idToken } = parsed.data;
    const ip = clientIpFromRequest(c);

    let verified;
    try {
      verified = await verifyGoogleIdToken(idToken, env.GOOGLE_CLIENT_ID);
    } catch (err) {
      console.warn(
        `[auth] google token rejected ip=${ip} reason=${err instanceof Error ? err.message : String(err)}`
      );
      throw new HttpError(
        401,
        "GOOGLE_TOKEN_INVALID",
        "No pudimos verificar tu cuenta de Google. Intenta de nuevo."
      );
    }

    const now = Math.floor(Date.now() / 1000);

    // 1) Match by google_id first (fast path, returning Google user).
    let userRow = findUserByGoogleId(verified.sub);

    // 2) Match by email — link the Google account to an existing
    //    email/password user. We trust the email because Google's
    //    `email_verified` was true (validated above).
    if (!userRow) {
      const byEmail = findUserByEmail(verified.email);
      if (byEmail) {
        linkGoogleAccount(byEmail.id, verified.sub, verified.picture);
        const refreshed = findUserById(byEmail.id);
        if (!refreshed) {
          throw new HttpError(
            500,
            "INTERNAL_ERROR",
            "Error al vincular tu cuenta. Intenta de nuevo."
          );
        }
        userRow = refreshed;
        console.log(`[auth] google link ok user=${userRow.id}`);
      }
    }

    // 3) Brand-new user — create passwordless account.
    if (!userRow) {
      const userId = randomUUID();
      userRow = createGoogleUser({
        id: userId,
        email: verified.email,
        name: verified.name,
        googleId: verified.sub,
        avatarUrl: verified.picture,
        now
      });
      console.log(`[auth] google signup ok user=${userRow.id}`);
    }

    const { token, jti, exp } = signToken(env.JWT_SECRET, userRow.id);
    createSession({ jti, userId: userRow.id, expiresAt: exp, now });

    console.log(`[auth] google login ok user=${userRow.id}`);
    return c.json({ ok: true, token, user: rowToUser(userRow) });
  } catch (err) {
    return sendError(c, err);
  }
});

authRoutes.post("/logout", authRequired(), async (c) => {
  try {
    const jti = c.get("jti");
    revokeSession(jti);
    console.log(`[auth] logout ok user=${c.get("user").id}`);
    return c.body(null, 204);
  } catch (err) {
    return sendError(c, err);
  }
});

// POST /v1/auth/verify-email — public (token is the credential).
authRoutes.post("/verify-email", authLimiter, async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    const parsed = verifyEmailSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        "VALIDATION_ERROR",
        parsed.error.issues[0]?.message ?? "Token invalido"
      );
    }

    const { token } = parsed.data;
    const row = findEmailVerification(token);
    const now = Math.floor(Date.now() / 1000);

    if (!row) {
      throw new HttpError(400, "VERIFICATION_INVALID", "Enlace de verificación inválido.");
    }
    if (row.consumed_at !== null) {
      throw new HttpError(400, "VERIFICATION_INVALID", "Este enlace ya fue usado.");
    }
    if (row.expires_at < now) {
      throw new HttpError(400, "VERIFICATION_INVALID", "Este enlace expiró. Solicita uno nuevo.");
    }

    markUserEmailVerified(row.user_id);
    consumeEmailVerification(token, now);
    console.log(`[auth] verify-email ok user=${row.user_id}`);

    return c.json({ ok: true, userId: row.user_id });
  } catch (err) {
    return sendError(c, err);
  }
});

// POST /v1/auth/resend-verification — authed. Returns a fresh token.
authRoutes.post(
  "/resend-verification",
  resendLimiter,
  authRequired(),
  async (c) => {
    try {
      const user = c.get("user");
      const userRow = findUserById(user.id);
      if (!userRow) {
        return errorResponse(c, 401, "UNAUTHORIZED", "Usuario no encontrado.");
      }
      if (userRow.email_verified === 1) {
        // Idempotent — already verified, no need to issue a new token.
        return c.json({ ok: true, alreadyVerified: true });
      }

      const now = Math.floor(Date.now() / 1000);

      // Per-user cap on outstanding tokens — issueVerificationToken()
      // invalidates previous ones, so we only need to rate-limit how often
      // the user can request a new one. Baseline: 5 resends per day.
      const active = countActiveEmailVerifications(user.id, now);
      if (active >= 5) {
        throw new HttpError(
          429,
          "RATE_LIMITED",
          "Has solicitado demasiados enlaces. Intenta mañana."
        );
      }

      const verification = issueVerificationToken(user.id, now);
      console.log(`[auth] resend-verification ok user=${user.id}`);

      return c.json({
        ok: true,
        verification: {
          verificationUrl: verification.verificationUrl,
          expiresAt: verification.expiresAt,
          token: verification.token
        }
      });
    } catch (err) {
      return sendError(c, err);
    }
  }
);
