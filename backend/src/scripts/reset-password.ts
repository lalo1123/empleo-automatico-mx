// One-shot password reset for an existing user. Bypasses the (non-existent)
// forgot-password flow by directly writing a fresh bcrypt hash into the DB.
//
// Usage (inside the running backend container, after a redeploy that
// includes this script):
//
//   node dist/scripts/reset-password.js <newPassword> <email>
//
// Example:
//   node dist/scripts/reset-password.js EmpleoMX2026! karla+test@skybrandmx.com
//
// Safety: requires the email to already exist (no implicit user creation).
// Exit codes: 0 success, 1 usage error / user not found.

import { hashPassword } from "../lib/password.js";
import { getDb, closeDb } from "../lib/db.js";

async function main() {
  const newPassword = process.argv[2];
  const email = process.argv[3];

  if (!newPassword || !email) {
    console.error("Usage: node dist/scripts/reset-password.js <newPassword> <email>");
    console.error("Example: node dist/scripts/reset-password.js EmpleoMX2026! karla+test@skybrandmx.com");
    process.exit(1);
  }
  if (newPassword.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  const hash = await hashPassword(newPassword);
  const db = getDb();
  const result = db
    .prepare("UPDATE users SET password_hash = ? WHERE LOWER(email) = LOWER(?)")
    .run(hash, email);

  if (result.changes === 0) {
    console.error(`✗ No user found with email: ${email}`);
    closeDb();
    process.exit(1);
  }

  console.log(`✓ Password reset for ${email} (${result.changes} row updated)`);
  closeDb();
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
