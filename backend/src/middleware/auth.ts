// JWT auth middleware. Verifies signature, expiry, and that the JTI has not
// been revoked. On success, attaches the User and jti to the Hono context.

import type { MiddlewareHandler } from "hono";
import type { AppContext } from "../lib/env.js";
import { loadEnv } from "../lib/env.js";
import { errorResponse } from "../lib/errors.js";
import { verifyToken } from "../lib/jwt.js";
import { findSession, findUserById, rowToUser } from "../lib/db.js";

function extractBearer(h: string | undefined): string | null {
  if (!h) return null;
  const [scheme, token] = h.split(" ");
  if (!scheme || scheme.toLowerCase() !== "bearer" || !token) return null;
  return token.trim();
}

export function authRequired(): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const token = extractBearer(c.req.header("Authorization"));
    if (!token) {
      return errorResponse(c, 401, "UNAUTHORIZED", "Inicia sesion para continuar.");
    }

    const env = loadEnv();
    const payload = verifyToken(env.JWT_SECRET, token);
    if (!payload) {
      return errorResponse(c, 401, "UNAUTHORIZED", "Sesion invalida o expirada.");
    }

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) {
      return errorResponse(c, 401, "UNAUTHORIZED", "Sesion expirada. Inicia sesion de nuevo.");
    }

    const session = findSession(payload.jti);
    if (!session || session.revoked === 1) {
      return errorResponse(c, 401, "UNAUTHORIZED", "Sesion revocada. Inicia sesion de nuevo.");
    }

    const userRow = findUserById(payload.sub);
    if (!userRow) {
      return errorResponse(c, 401, "UNAUTHORIZED", "Usuario no encontrado.");
    }

    c.set("user", rowToUser(userRow));
    c.set("jti", payload.jti);
    await next();
    return;
  };
}
