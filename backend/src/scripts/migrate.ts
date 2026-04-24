// Runs all `.sql` files in /migrations in lexicographic order.
// Records applied migrations in `schema_migrations` so re-running is idempotent.
//
// Resolves the migrations directory in a build-tolerant way:
//   - In dev (tsx) the source lives at backend/src/scripts/migrate.ts and the
//     migrations folder is two levels up.
//   - After `tsc` build, the compiled file lives at backend/dist/scripts/migrate.js
//     and we copy `migrations/` next to `dist/` (Dockerfile does this).
// We try a list of candidate paths and pick the first that exists.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, closeDb } from "../lib/db.js";

function findMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../../migrations"),   // dist/scripts -> project root /migrations
    resolve(here, "../../../migrations"), // src/scripts during tsx
    resolve(process.cwd(), "migrations")
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `Could not locate migrations directory. Tried: ${candidates.join(", ")}`
  );
}

export function runMigrations(): void {
  const db = getDb();
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name        TEXT PRIMARY KEY,
       applied_at  INTEGER NOT NULL
     )`
  );

  const dir = findMigrationsDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const already = new Set(
    db
      .prepare<[], { name: string }>("SELECT name FROM schema_migrations")
      .all()
      .map((r) => r.name)
  );

  const applyStmt = db.prepare(
    "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)"
  );

  for (const file of files) {
    if (already.has(file)) {
      console.log(`[migrate] skip ${file} (already applied)`);
      continue;
    }
    const sql = readFileSync(resolve(dir, file), "utf8");
    console.log(`[migrate] applying ${file}`);
    const tx = db.transaction(() => {
      db.exec(sql);
      applyStmt.run(file, Math.floor(Date.now() / 1000));
    });
    tx();
  }

  console.log("[migrate] done");
}

// Allow running as a CLI script: `node dist/scripts/migrate.js` or
// `tsx src/scripts/migrate.ts`. When imported (from server.ts) the runner
// is exposed via runMigrations().
const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  try {
    runMigrations();
    closeDb();
    process.exit(0);
  } catch (err) {
    console.error("[migrate] failed:", err);
    closeDb();
    process.exit(1);
  }
}
