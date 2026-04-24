// Email verification token service.
//
// For MVP we do NOT send emails — the token is surfaced directly to the
// user (in the signup response and via the resend endpoint). Once Resend
// or SES is wired up the only change is replacing `surfaceToken()` with a
// mailer call. The DB schema and endpoints don't change.
//
// Token format: UUID v4 (from node:crypto). 128 bits of entropy, plenty for
// a single-use link valid for 24h.

import { randomUUID } from "node:crypto";
import {
  createEmailVerification,
  expireEmailVerifications
} from "./db.js";
import { loadEnv } from "./env.js";

// 24h TTL. Long enough for a user to finish signup on a different device,
// short enough that a leaked token is low-risk.
export const VERIFICATION_TTL_SECONDS = 60 * 60 * 24;

export interface IssuedVerification {
  token: string;
  expiresAt: number;
  verificationUrl: string;
}

/**
 * Issue a fresh verification token for `userId`. Invalidates any previous
 * outstanding tokens for the same user (so resend always produces exactly
 * one live link).
 *
 * @returns The token, its expiry, and the user-facing URL on the landing.
 */
export function issueVerificationToken(
  userId: string,
  now: number
): IssuedVerification {
  const env = loadEnv();

  // Invalidate previous outstanding tokens so only the newest works.
  expireEmailVerifications(userId, now);

  // TODO: integrate Resend/SES to actually email this token. For MVP we
  // surface it to the user via the verification flow (signup response +
  // /auth/resend-verification).
  const token = randomUUID();
  const expiresAt = now + VERIFICATION_TTL_SECONDS;

  createEmailVerification({
    token,
    userId,
    expiresAt,
    now
  });

  const base = env.FRONTEND_URL.replace(/\/+$/, "");
  const verificationUrl = `${base}/verify?token=${encodeURIComponent(token)}`;

  return { token, expiresAt, verificationUrl };
}
