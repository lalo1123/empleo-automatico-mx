// Empleo Automatico MX - Hono app definition.
// Used by server.ts (node) as the request handler.

import { Hono } from "hono";
import type { AppContext } from "./lib/env.js";
import { loadEnv } from "./lib/env.js";
import { cors } from "./middleware/cors.js";
import { sendError } from "./lib/errors.js";
import { authRoutes } from "./routes/auth.js";
import { accountRoutes } from "./routes/account.js";
import { applicationsRoutes } from "./routes/applications.js";
import { billingRoutes } from "./routes/billing.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { adminRoutes } from "./routes/admin.js";

const VERSION = "0.2.1";

export function createApp(): Hono<AppContext> {
  // Ensure env is loaded / validated at app construction time.
  const env = loadEnv();

  const app = new Hono<AppContext>();

  // Global CORS + OPTIONS short-circuit.
  app.use("*", cors());

  // Root: service banner.
  app.get("/", (c) =>
    c.json({ ok: true, service: "skybrandmx-empleo-api", env: env.NODE_ENV, version: VERSION })
  );

  // Health check - Dokploy uses this for container health probes.
  app.get("/healthz", (c) =>
    c.json({ ok: true, version: VERSION, now: Math.floor(Date.now() / 1000) })
  );

  // API routes under /v1 per spec.
  const v1 = new Hono<AppContext>();
  v1.route("/auth", authRoutes);
  v1.route("/account", accountRoutes);
  v1.route("/applications", applicationsRoutes);
  v1.route("/billing", billingRoutes);
  v1.route("/webhooks", webhookRoutes);
  v1.route("/admin", adminRoutes);

  app.route("/v1", v1);

  // 404 fallback with consistent envelope.
  app.notFound((c) =>
    c.json(
      { ok: false, error: { code: "NOT_FOUND", message: "Ruta no encontrada." } },
      404
    )
  );

  // Unhandled errors -> consistent envelope, no stack trace leaked.
  app.onError((err, c) => sendError(c, err));

  return app;
}

export const app = createApp();
export default app;
