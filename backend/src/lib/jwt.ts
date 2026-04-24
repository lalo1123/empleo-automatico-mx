// JWT HS256 — sign/verify using the `jsonwebtoken` Node package.

import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import type { JwtPayload } from "../types.js";

const DEFAULT_EXPIRY_SECONDS = 60 * 60 * 24 * 30; // 30 days

export function newJti(): string {
  return randomUUID();
}

export interface SignedToken {
  token: string;
  jti: string;
  iat: number;
  exp: number;
}

export function signToken(
  secret: string,
  userId: string,
  options: { jti?: string; expiresInSeconds?: number } = {}
): SignedToken {
  const jti = options.jti ?? newJti();
  const expiresIn = options.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS;
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + expiresIn;
  const payload: JwtPayload = { sub: userId, jti, iat, exp };
  // We pass iat/exp inside the payload so we stay in control and don't let
  // jsonwebtoken re-derive them.
  const token = jwt.sign(payload, secret, { algorithm: "HS256", noTimestamp: true });
  return { token, jti, iat, exp };
}

export function verifyToken(secret: string, token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ["HS256"] });
    if (typeof decoded === "string" || decoded === null) return null;
    const { sub, jti, iat, exp } = decoded as Partial<JwtPayload>;
    if (
      typeof sub !== "string" ||
      typeof jti !== "string" ||
      typeof iat !== "number" ||
      typeof exp !== "number"
    ) {
      return null;
    }
    return { sub, jti, iat, exp };
  } catch {
    return null;
  }
}
