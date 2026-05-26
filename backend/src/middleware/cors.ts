// CORS middleware with whitelist support for `*.skybrandmx.com`,
// `chrome-extension://<id>` and localhost origins. Preflight is handled inline.

import type { MiddlewareHandler } from "hono";
import type { AppContext } from "../lib/env.js";
import { loadEnv } from "../lib/env.js";

const ALLOWED_HEADERS = "Authorization, Content-Type";
const ALLOWED_METHODS = "GET, POST, OPTIONS";
const MAX_AGE = "86400";

function patternMatches(pattern: string, origin: string): boolean {
  if (pattern === origin) return true;
  if (pattern.startsWith("chrome-extension://")) {
    if (pattern === "chrome-extension://*") return origin.startsWith("chrome-extension://");
    return pattern === origin;
  }
  if (pattern.includes("*")) {
    // Convert `https://*.skybrandmx.com` into a regex.
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^.]+");
    return new RegExp(`^${escaped}$`).test(origin);
  }
  return false;
}

function isOriginAllowed(origin: string, patterns: string[]): boolean {
  // chrome-extension origins: rather than the previous blanket
  // "always allow", consult the patterns list. The CORS_ORIGINS env
  // can include explicit IDs (e.g. "chrome-extension://abcd...") or
  // the dev wildcard "chrome-extension://*". In prod we expect the
  // pinned store ID. Wildcard remains supported but should ONLY be
  // set in dev / staging envs.
  if (origin.startsWith("chrome-extension://")) {
    return patterns.some((p) => patternMatches(p.trim(), origin));
  }
  return patterns.some((p) => patternMatches(p.trim(), origin));
}

export function cors(): MiddlewareHandler<AppContext> {
  const env = loadEnv();
  const patterns = env.CORS_ORIGINS.split(",").filter(Boolean);

  return async (c, next) => {
    const origin = c.req.header("Origin") ?? "";
    const allow = Boolean(origin) && isOriginAllowed(origin, patterns);

    if (allow) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
      c.header("Access-Control-Allow-Credentials", "true");
    }

    if (c.req.method === "OPTIONS") {
      if (allow) {
        c.header("Access-Control-Allow-Headers", ALLOWED_HEADERS);
        c.header("Access-Control-Allow-Methods", ALLOWED_METHODS);
        c.header("Access-Control-Max-Age", MAX_AGE);
      }
      return c.body(null, 204);
    }

    await next();
    return;
  };
}
