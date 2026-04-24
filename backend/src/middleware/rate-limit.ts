// Simple in-memory rate limiter. Single-process only — fine for MVP on
// a single Docker container. For multi-instance deployments migrate to Redis.

import type { Context, MiddlewareHandler } from "hono";
import type { AppContext } from "../lib/env.js";
import { errorResponse } from "../lib/errors.js";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

function clientIp(c: Context): string {
  // Dokploy fronts us with Traefik, which sets X-Forwarded-For / X-Real-IP.
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

export interface RateLimitOptions {
  key: string;
  windowMs: number;
  max: number;
}

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const ip = clientIp(c);
    const bucketKey = `${opts.key}:${ip}`;
    const now = Date.now();

    // GC at most once per 1000 entries - keeps memory bounded.
    if (buckets.size > 1000) {
      for (const [k, v] of buckets) {
        if (v.resetAt < now) buckets.delete(k);
      }
    }

    const existing = buckets.get(bucketKey);
    if (!existing || existing.resetAt < now) {
      buckets.set(bucketKey, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }

    existing.count += 1;
    if (existing.count > opts.max) {
      const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      c.header("Retry-After", String(retryAfter));
      return errorResponse(
        c,
        429,
        "RATE_LIMITED",
        "Demasiadas peticiones. Espera un momento e intenta de nuevo."
      );
    }

    await next();
    return;
  };
}
