// /v1/auth/* - signup, login, logout.

import { Hono } from "hono";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { AppContext } from "../lib/env.js";
import { loadEnv } from "../lib/env.js";
import { HttpError, sendError } from "../lib/errors.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { signToken } from "../lib/jwt.js";
import {
  createSession,
  createUser,
  findUserByEmail,
  revokeSession,
  rowToUser
} from "../lib/db.js";
import { authRequired } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rate-limit.js";

const MIN_PASSWORD = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const signupSchema = z.object({
  email: z.string().trim().toLowerCase().regex(EMAIL_RE, "Correo invalido"),
  password: z.string().min(MIN_PASSWORD, `La contrasena debe tener al menos ${MIN_PASSWORD} caracteres`),
  name: z.string().trim().min(1).max(120).optional()
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().regex(EMAIL_RE, "Correo invalido"),
  password: z.string().min(1, "Contrasena requerida")
});

const authLimiter = rateLimit({ key: "auth", windowMs: 60_000, max: 10 });

export const authRoutes = new Hono<AppContext>();

authRoutes.post("/signup", authLimiter, async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    const parsed = signupSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Datos invalidos");
    }

    const { email, password, name } = parsed.data;
    const existing = findUserByEmail(email);
    if (existing) {
      throw new HttpError(409, "EMAIL_TAKEN", "Este correo ya esta registrado.");
    }

    const env = loadEnv();
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

    console.log(`[auth] signup ok user=${userId}`);
    return c.json({ ok: true, token, user: rowToUser(userRow) }, 201);
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

    const { email, password } = parsed.data;
    const userRow = findUserByEmail(email);
    // Same error for "no user" and "bad password" to prevent account enumeration.
    if (!userRow) {
      throw new HttpError(401, "INVALID_CREDENTIALS", "Correo o contrasena incorrectos.");
    }
    const ok = await verifyPassword(password, userRow.password_hash);
    if (!ok) {
      throw new HttpError(401, "INVALID_CREDENTIALS", "Correo o contrasena incorrectos.");
    }

    const env = loadEnv();
    const now = Math.floor(Date.now() / 1000);
    const { token, jti, exp } = signToken(env.JWT_SECRET, userRow.id);
    createSession({ jti, userId: userRow.id, expiresAt: exp, now });

    console.log(`[auth] login ok user=${userRow.id}`);
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
