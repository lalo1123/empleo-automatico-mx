"use client";

// Cloudflare Turnstile widget wrapper.
//
// Usage: drop <Turnstile /> inside a <form>. When Cloudflare calls back with
// a token, it populates a hidden `cf-turnstile-response` field that gets
// posted with the form. The server then validates it against siteverify.
//
// If `NEXT_PUBLIC_TURNSTILE_SITEKEY` is unset, the widget is not rendered —
// keeps dev/local work unblocked. Backend's verifyTurnstile() also skips
// validation when its secret is unset, so the two switches stay in sync.

import Script from "next/script";

interface TurnstileProps {
  /** Called once the user solves the challenge (optional — hidden input is always set). */
  action?: string;
  /** Optional theme override — Turnstile default is "auto". */
  theme?: "light" | "dark" | "auto";
  /** Extra class names on the widget wrapper. */
  className?: string;
}

export function Turnstile({
  action,
  theme = "light",
  className
}: TurnstileProps) {
  const sitekey = process.env.NEXT_PUBLIC_TURNSTILE_SITEKEY;

  if (!sitekey || sitekey.length === 0) {
    // Dev mode: skip widget. Backend skips verification too when its secret
    // is unset, so the form still submits successfully.
    return null;
  }

  return (
    <>
      <Script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js"
        async
        defer
        strategy="afterInteractive"
      />
      <div
        className={`cf-turnstile ${className ?? ""}`}
        data-sitekey={sitekey}
        data-theme={theme}
        data-action={action}
      />
    </>
  );
}
