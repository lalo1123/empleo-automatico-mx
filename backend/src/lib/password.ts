// bcryptjs wrapper. bcryptjs is a pure-JS port of bcrypt; works in Workers runtime.

import bcrypt from "bcryptjs";

const COST = 10;

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, COST);
}

export async function verifyPassword(
  plaintext: string,
  hash: string
): Promise<boolean> {
  try {
    return await bcrypt.compare(plaintext, hash);
  } catch {
    return false;
  }
}
