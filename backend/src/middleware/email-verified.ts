// Middleware: require the authenticated user's email to be verified before
// proceeding. Used on /applications/generate and /billing/checkout — we still
// allow /applications/parse-cv (onboarding) and /auth/* (login, resend).
//
// Must run AFTER authRequired() — reads c.get("user").

import type { MiddlewareHandler } from "hono";
import type { AppContext } from "../lib/env.js";
import { errorResponse } from "../lib/errors.js";
import { findUserById } from "../lib/db.js";

export function emailVerifiedRequired(): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const user = c.get("user");
    // Re-read from DB — the JWT's user snapshot might be stale if the user
    // verified in another tab but never refreshed their session.
    const row = findUserById(user.id);
    if (!row) {
      return errorResponse(c, 401, "UNAUTHORIZED", "Usuario no encontrado.");
    }
    if (row.email_verified !== 1) {
      return errorResponse(
        c,
        403,
        "EMAIL_NOT_VERIFIED",
        "Verifica tu correo electrónico antes de continuar."
      );
    }
    await next();
    return;
  };
}
