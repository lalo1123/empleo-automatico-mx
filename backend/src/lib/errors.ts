// User-facing errors. Messages are in Spanish MX per spec.
// Never surface secrets or internal state through `.message`.

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "INVALID_CREDENTIALS"
  | "EMAIL_TAKEN"
  | "EMAIL_NOT_ALLOWED"
  | "EMAIL_NOT_VERIFIED"
  | "VERIFICATION_INVALID"
  | "CAPTCHA_FAILED"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "PLAN_LIMIT_EXCEEDED"
  | "UPSTREAM_ERROR"
  | "WEBHOOK_SIGNATURE_INVALID"
  | "PAYMENT_ERROR"
  | "GOOGLE_OAUTH_DISABLED"
  | "GOOGLE_TOKEN_INVALID"
  | "INTERNAL_ERROR";

export class HttpError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: ErrorCode;

  constructor(status: ContentfulStatusCode, code: ErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "HttpError";
  }
}

export function errorResponse(
  c: Context,
  status: ContentfulStatusCode,
  code: ErrorCode,
  message: string
) {
  return c.json({ ok: false, error: { code, message } }, status);
}

export function sendError(c: Context, err: unknown) {
  if (err instanceof HttpError) {
    return errorResponse(c, err.status, err.code, err.message);
  }
  // Log internal id, never echo raw error to client.
  console.error("[unhandled]", err instanceof Error ? err.message : String(err));
  return errorResponse(
    c,
    500,
    "INTERNAL_ERROR",
    "Ocurrió un error inesperado. Intenta de nuevo en un momento."
  );
}
