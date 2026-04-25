"use client";

// Google Sign-In button + One Tap.
//
// Loads Google Identity Services lazily and renders the official
// "Sign in with Google" button. When the user accepts, GIS calls a
// global callback with a short-lived ID token; we POST it to our own
// /api/auth/google route, which exchanges it for our session cookie.
//
// If NEXT_PUBLIC_GOOGLE_CLIENT_ID is unset:
//   - In dev: render a small muted "disabled" hint.
//   - In prod: render NOTHING (graceful fallback).
//
// Implementation notes:
//   - The button is rendered by GIS itself by attaching to a div
//     marked .g_id_signin (data-* attributes drive the look).
//   - We set the global window.onGoogleCredential per the GIS contract,
//     using data-callback="onGoogleCredential" on the .g_id_onload div.
//   - We do NOT cache the ID token anywhere; only our session cookie
//     persists, and it's httpOnly.

import Script from "next/script";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

type GoogleCredentialResponse = {
  credential?: string;
  select_by?: string;
};

declare global {
  interface Window {
    onGoogleCredential?: (response: GoogleCredentialResponse) => void;
  }
}

interface GoogleSignInProps {
  /** Where to redirect after a successful login. Defaults to /account. */
  redirectTo?: string;
  /**
   * Optional className to add to the wrapper. The component still keeps
   * its default vertical-stacking layout for the button + error.
   */
  className?: string;
}

const SCRIPT_SRC = "https://accounts.google.com/gsi/client";

export function GoogleSignIn({
  redirectTo = "/account",
  className,
}: GoogleSignInProps) {
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<boolean>(false);
  // Stable id per render so multiple instances on a page don't clash.
  const onloadId = useId();

  // Mark whether we've attached the callback at least once. We attach it
  // synchronously so it's available the moment the GIS script runs the
  // data-callback lookup.
  const attachedRef = useRef<boolean>(false);

  useEffect(() => {
    if (!clientId) return;
    if (attachedRef.current) return;
    attachedRef.current = true;

    window.onGoogleCredential = async (response: GoogleCredentialResponse) => {
      const idToken = response?.credential;
      if (!idToken) {
        setError(
          "No recibimos credenciales de Google. Intenta de nuevo o usa email."
        );
        return;
      }
      setError(null);
      setPending(true);
      try {
        const res = await fetch("/api/auth/google", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken }),
        });
        const payload = (await res.json().catch(() => null)) as
          | { ok: boolean; error?: { message?: string } }
          | null;
        if (!res.ok || !payload?.ok) {
          const msg =
            payload?.error?.message ??
            "No pudimos iniciar sesión con Google. Intenta de nuevo.";
          setError(msg);
          setPending(false);
          return;
        }
        // Success: hard navigate so the new httpOnly cookie is read by
        // the destination route's server components.
        window.location.href = redirectTo;
      } catch {
        setError(
          "No pudimos conectar con el servidor. Verifica tu internet e intenta de nuevo."
        );
        setPending(false);
      }
    };

    return () => {
      // Best-effort cleanup. If the user navigates away mid-flow we
      // simply ignore subsequent callbacks.
      if (window.onGoogleCredential) {
        delete window.onGoogleCredential;
      }
    };
    // router intentionally omitted — we use window.location for a hard nav.
  }, [clientId, redirectTo]);

  if (!clientId || clientId.length === 0) {
    if (process.env.NODE_ENV === "development") {
      return (
        <p className="text-xs text-[color:var(--color-ink-muted)]">
          Google Sign-In deshabilitado (NEXT_PUBLIC_GOOGLE_CLIENT_ID no
          configurado).
        </p>
      );
    }
    return null;
  }

  return (
    <div className={className}>
      <Script src={SCRIPT_SRC} strategy="afterInteractive" async defer />
      {/* GIS renders the button into the .g_id_signin div on script load. */}
      <div
        id={onloadId}
        className="g_id_onload"
        data-client_id={clientId}
        data-callback="onGoogleCredential"
        data-locale="es"
        data-auto_select="false"
        data-itp_support="true"
      />
      <div
        className="g_id_signin flex justify-center"
        data-type="standard"
        data-shape="rectangular"
        data-theme="outline"
        data-text="signin_with"
        data-size="large"
        data-locale="es"
        data-logo_alignment="left"
      />
      {pending && (
        <p
          className="mt-2 text-center text-xs text-[color:var(--color-ink-muted)]"
          aria-live="polite"
        >
          Iniciando sesión…
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="mt-2 rounded-[10px] border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {error}
        </p>
      )}
    </div>
  );
}
