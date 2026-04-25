// Google ID Token verification — pure Node, no external libraries.
//
// Verifies an ID Token issued by Google Identity Services. Process:
//   1. Decode the JWT header to read `kid`.
//   2. Fetch Google's JWKS (https://www.googleapis.com/oauth2/v3/certs),
//      cached for 1h. Refetch on miss.
//   3. Match the `kid` to a JWK and import it as an RSA public key
//      (crypto.createPublicKey({ key, format: 'jwk' })).
//   4. Verify the RS256 signature over `header.payload` against
//      `signature` using crypto.createVerify('RSA-SHA256').
//   5. Validate the standard claims:
//        - aud === expectedClientId
//        - iss in {accounts.google.com, https://accounts.google.com}
//        - exp > now
//        - email_verified === true
//
// Throws on any failure. Callers map thrown errors to GOOGLE_TOKEN_INVALID.

import { createPublicKey, createVerify } from "node:crypto";

const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const JWKS_TTL_MS = 60 * 60 * 1000; // 1h
const VALID_ISSUERS = new Set([
  "accounts.google.com",
  "https://accounts.google.com"
]);

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  use?: string;
  n: string;
  e: string;
}

interface JwksResponse {
  keys: Jwk[];
}

interface JwtHeader {
  alg: string;
  kid: string;
  typ?: string;
}

interface GoogleIdTokenPayload {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  iat?: number;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

export interface VerifiedGoogleIdToken {
  sub: string;
  email: string;
  emailVerified: true;
  name: string | null;
  picture: string | null;
}

interface JwksCacheEntry {
  fetchedAt: number;
  keys: Map<string, Jwk>;
}

let jwksCache: JwksCacheEntry | null = null;

function decodeBase64Url(input: string): Buffer {
  // base64url -> base64
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64");
}

function decodeJsonSegment<T>(segment: string): T {
  const buf = decodeBase64Url(segment);
  return JSON.parse(buf.toString("utf8")) as T;
}

async function fetchJwks(): Promise<JwksCacheEntry> {
  const res = await fetch(JWKS_URL, {
    method: "GET",
    // We rely on the in-memory JWKS cache below for the 1h TTL; the
    // explicit no-cache header keeps any transparent HTTP cache between
    // us and Google from serving stale keys after a rotation.
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-cache"
    }
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch Google JWKS: HTTP ${res.status}`);
  }
  const body = (await res.json()) as JwksResponse;
  if (!body || !Array.isArray(body.keys) || body.keys.length === 0) {
    throw new Error("Google JWKS response missing keys");
  }
  const keys = new Map<string, Jwk>();
  for (const k of body.keys) {
    if (typeof k.kid === "string" && k.kid.length > 0) {
      keys.set(k.kid, k);
    }
  }
  return { fetchedAt: Date.now(), keys };
}

/**
 * Get a Google JWK by kid. Hits in-memory cache first, refetches on miss
 * or when the cache is expired (1h TTL).
 */
async function getJwk(kid: string): Promise<Jwk> {
  const now = Date.now();
  if (
    jwksCache &&
    now - jwksCache.fetchedAt < JWKS_TTL_MS &&
    jwksCache.keys.has(kid)
  ) {
    return jwksCache.keys.get(kid) as Jwk;
  }
  // Refresh — either expired, or kid not in current cache (key rotation).
  jwksCache = await fetchJwks();
  const found = jwksCache.keys.get(kid);
  if (!found) {
    throw new Error(`No Google JWK matches kid=${kid}`);
  }
  return found;
}

/**
 * Verify a Google-issued ID token. Returns the validated subset of the
 * payload on success, throws on any failure.
 *
 * Security checks:
 *   - alg === "RS256"
 *   - signature verifies against Google's JWKS (constant-time via crypto.verify)
 *   - aud === expectedClientId
 *   - iss in {accounts.google.com, https://accounts.google.com}
 *   - exp > now (with no clock skew tolerance — Google's tokens are short-lived)
 *   - email_verified === true
 */
export async function verifyGoogleIdToken(
  idToken: string,
  expectedClientId: string
): Promise<VerifiedGoogleIdToken> {
  if (!expectedClientId) {
    throw new Error("expectedClientId is empty");
  }

  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed JWT: expected 3 segments");
  }
  const [headerSeg, payloadSeg, signatureSeg] = parts as [string, string, string];

  let header: JwtHeader;
  let payload: GoogleIdTokenPayload;
  try {
    header = decodeJsonSegment<JwtHeader>(headerSeg);
    payload = decodeJsonSegment<GoogleIdTokenPayload>(payloadSeg);
  } catch {
    throw new Error("Malformed JWT: header or payload not valid JSON");
  }

  if (header.alg !== "RS256") {
    throw new Error(`Unexpected alg=${header.alg} (only RS256 is accepted)`);
  }
  if (typeof header.kid !== "string" || header.kid.length === 0) {
    throw new Error("Missing kid in JWT header");
  }

  // Resolve the JWK and convert to a Node KeyObject.
  const jwk = await getJwk(header.kid);
  const publicKey = createPublicKey({
    key: { kty: jwk.kty, n: jwk.n, e: jwk.e },
    format: "jwk"
  });

  // Verify the signature. crypto.verify uses constant-time comparison
  // internally for the actual signature check.
  const signingInput = `${headerSeg}.${payloadSeg}`;
  const verifier = createVerify("RSA-SHA256");
  verifier.update(signingInput);
  verifier.end();
  const signature = decodeBase64Url(signatureSeg);
  const sigOk = verifier.verify(publicKey, signature);
  if (!sigOk) {
    throw new Error("Invalid signature");
  }

  // Standard-claim validation. Reject strictly.
  if (payload.aud !== expectedClientId) {
    throw new Error(`aud mismatch: got ${String(payload.aud)}`);
  }
  if (typeof payload.iss !== "string" || !VALID_ISSUERS.has(payload.iss)) {
    throw new Error(`iss invalid: got ${String(payload.iss)}`);
  }
  if (typeof payload.exp !== "number") {
    throw new Error("exp missing");
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.exp <= nowSec) {
    throw new Error("Token expired");
  }
  if (payload.email_verified !== true) {
    throw new Error("Google email not verified");
  }
  if (typeof payload.email !== "string" || payload.email.length === 0) {
    throw new Error("Missing email in payload");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("Missing sub in payload");
  }

  return {
    sub: payload.sub,
    email: payload.email.toLowerCase(),
    emailVerified: true,
    name: typeof payload.name === "string" && payload.name.length > 0
      ? payload.name
      : null,
    picture:
      typeof payload.picture === "string" && payload.picture.length > 0
        ? payload.picture
        : null
  };
}

/** Test helper — clears the in-memory JWKS cache. */
export function _resetJwksCache(): void {
  jwksCache = null;
}
