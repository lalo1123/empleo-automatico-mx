// Cloudflare Turnstile server-side verification.
//
// Turnstile is a privacy-friendly, free CAPTCHA from Cloudflare (no PII,
// no tracking cookies). The widget issues a one-shot token on the client,
// which we validate here against the siteverify endpoint.
//
// Docs: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
//
// Test mode:
//   - When `TURNSTILE_SECRET` is unset, `verifyTurnstile()` returns `ok: true`
//     without calling Cloudflare. This keeps local dev and tests working
//     without needing real keys. Director must set the secret in Dokploy
//     before prod launch.

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface TurnstileResult {
  ok: boolean;
  /** Cloudflare error codes when !ok, useful for logs (never shown to user). */
  errorCodes?: string[];
  /** True iff verification was skipped because no secret is configured. */
  skipped: boolean;
}

/**
 * Verify a Turnstile token.
 *
 * @param secret    Server-side `TURNSTILE_SECRET` (skip verification when empty).
 * @param token     Client-submitted `cf-turnstile-response` field.
 * @param remoteIp  Optional client IP — Cloudflare uses it for additional signals.
 */
export async function verifyTurnstile(
  secret: string | undefined | null,
  token: string | undefined | null,
  remoteIp?: string
): Promise<TurnstileResult> {
  if (!secret || secret.length === 0) {
    // Dev / test mode: skip verification so the app runs without keys.
    return { ok: true, skipped: true };
  }

  if (!token || token.length === 0) {
    return { ok: false, skipped: false, errorCodes: ["missing-input-response"] };
  }

  // URL-encoded body per Cloudflare's reference; keeps the request tiny.
  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);
  if (remoteIp && remoteIp !== "unknown") form.set("remoteip", remoteIp);

  // AbortController to avoid hanging signup calls when Cloudflare is slow.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: controller.signal
    });

    if (!res.ok) {
      return {
        ok: false,
        skipped: false,
        errorCodes: [`http-${res.status}`]
      };
    }

    const raw = (await res.json()) as {
      success?: boolean;
      "error-codes"?: string[];
    };

    if (raw.success === true) return { ok: true, skipped: false };
    return {
      ok: false,
      skipped: false,
      errorCodes: raw["error-codes"] ?? ["unknown"]
    };
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      errorCodes: [
        err instanceof Error && err.name === "AbortError"
          ? "timeout"
          : "network-error"
      ]
    };
  } finally {
    clearTimeout(timeout);
  }
}
