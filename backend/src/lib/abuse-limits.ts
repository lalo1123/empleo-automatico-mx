// In-memory abuse counters for signup: per-email and per-/24-IP-block.
//
// These complement the IP-based rate limiter (which covers exact-IP brute
// force) by catching two common patterns:
//   1. One attacker cycling through IPs but reusing a disposable email.
//   2. One attacker bursting N signups from a shared subnet (NAT / VPN / CGNAT).
//
// Limits (documented here per Director instruction — NOT in COMMERCIAL.md):
//   - Per-email:    max 3 signups / hour
//   - Per-/24 block: max 5 signups / 10 minutes
//
// Single-process, in-memory store. Acceptable for the current single-container
// deploy; if we move to multiple replicas, push this into SQLite or Redis.

interface Bucket {
  count: number;
  resetAt: number;
}

const EMAIL_WINDOW_MS = 60 * 60 * 1000; // 1h
const EMAIL_MAX = 3;

const SUBNET_WINDOW_MS = 10 * 60 * 1000; // 10m
const SUBNET_MAX = 5;

const emailBuckets = new Map<string, Bucket>();
const subnetBuckets = new Map<string, Bucket>();

function gc(map: Map<string, Bucket>, now: number): void {
  if (map.size <= 1000) return;
  for (const [k, v] of map) {
    if (v.resetAt < now) map.delete(k);
  }
}

/**
 * Extract the /24 subnet from an IPv4, or a /64 prefix from an IPv6. For
 * "unknown" returns "unknown". Best-effort — not a strict CIDR parser.
 */
export function subnetKey(ip: string): string {
  if (!ip || ip === "unknown") return "unknown";
  if (ip.includes(".")) {
    // IPv4: keep first three octets. "1.2.3.4" -> "1.2.3.0/24"
    const parts = ip.split(".");
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
    return ip;
  }
  if (ip.includes(":")) {
    // IPv6: keep first 4 groups (~/64). "2001:db8:1:2:3:4:5:6" -> "2001:db8:1:2::/64"
    const groups = ip.split(":").filter((g) => g.length > 0);
    if (groups.length >= 4) return `${groups.slice(0, 4).join(":")}::/64`;
    return ip;
  }
  return ip;
}

export interface AbuseCheck {
  ok: boolean;
  /** Which limiter tripped, for logs. */
  reason?: "email" | "subnet";
  /** Seconds until the bucket resets. */
  retryAfter?: number;
}

/**
 * Atomically check + increment both counters for a signup attempt.
 *
 * Returns `ok: false` with a `retryAfter` when either limiter is over budget.
 * On a trip, we do NOT increment the non-tripping bucket — that way a genuine
 * user caught behind shared NAT isn't accidentally double-penalized.
 */
export function checkSignupAbuse(
  email: string,
  ip: string,
  nowMs: number = Date.now()
): AbuseCheck {
  const emailKey = email.trim().toLowerCase();
  const subKey = subnetKey(ip);

  gc(emailBuckets, nowMs);
  gc(subnetBuckets, nowMs);

  const eb = emailBuckets.get(emailKey);
  const currentEmailCount =
    eb && eb.resetAt >= nowMs ? eb.count + 1 : 1;
  if (currentEmailCount > EMAIL_MAX) {
    const retryAfter = Math.max(1, Math.ceil((eb!.resetAt - nowMs) / 1000));
    return { ok: false, reason: "email", retryAfter };
  }

  const sb = subnetBuckets.get(subKey);
  const currentSubnetCount =
    sb && sb.resetAt >= nowMs ? sb.count + 1 : 1;
  if (currentSubnetCount > SUBNET_MAX) {
    const retryAfter = Math.max(1, Math.ceil((sb!.resetAt - nowMs) / 1000));
    return { ok: false, reason: "subnet", retryAfter };
  }

  // Commit. Create new buckets or bump existing ones.
  if (!eb || eb.resetAt < nowMs) {
    emailBuckets.set(emailKey, { count: 1, resetAt: nowMs + EMAIL_WINDOW_MS });
  } else {
    eb.count = currentEmailCount;
  }
  if (!sb || sb.resetAt < nowMs) {
    subnetBuckets.set(subKey, { count: 1, resetAt: nowMs + SUBNET_WINDOW_MS });
  } else {
    sb.count = currentSubnetCount;
  }

  return { ok: true };
}

/** Test-only helper. Not exported from a public barrel. */
export function __resetAbuseStateForTests(): void {
  emailBuckets.clear();
  subnetBuckets.clear();
}
