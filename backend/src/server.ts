// Node entry point. Loads env, runs migrations in dev, wires @hono/node-server,
// and handles graceful shutdown on SIGTERM/SIGINT.

import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { loadEnv } from "./lib/env.js";
import { closeDb } from "./lib/db.js";
import { runMigrations } from "./scripts/migrate.js";

async function main(): Promise<void> {
  const env = loadEnv();

  // In development / one-shot containers we run migrations at boot so the
  // DB is always up to date. In production the Dockerfile also runs
  // `node dist/scripts/migrate.js` before starting the server, but running
  // it here too is safe (schema_migrations makes it idempotent).
  try {
    runMigrations();
  } catch (err) {
    console.error("[boot] migration failed:", err);
    process.exit(1);
  }

  const server = serve(
    {
      fetch: app.fetch,
      port: env.PORT,
      hostname: "0.0.0.0"
    },
    (info) => {
      console.log(
        `[boot] empleo-api listening on http://0.0.0.0:${info.port} (env=${env.NODE_ENV})`
      );
    }
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] received ${signal}, closing server...`);
    server.close((err?: Error) => {
      if (err) console.error("[shutdown] server.close error:", err);
      try {
        closeDb();
      } catch (dbErr) {
        console.error("[shutdown] db.close error:", dbErr);
      }
      console.log("[shutdown] bye");
      process.exit(err ? 1 : 0);
    });

    // Hard timeout safeguard (10s).
    setTimeout(() => {
      console.error("[shutdown] timed out, force exiting");
      process.exit(1);
    }, 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    console.error("[unhandledRejection]", reason instanceof Error ? reason.message : reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[uncaughtException]", err.message);
  });
}

main().catch((err) => {
  console.error("[boot] fatal:", err);
  process.exit(1);
});
