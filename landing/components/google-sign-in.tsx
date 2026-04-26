"use client";

// Google Sign-In button using the JS API directly.
// HTML data-attribute integration is unreliable with React (GIS only scans
// the DOM at script load; React-mounted divs that arrive later are missed).
// We instead call google.accounts.id.initialize + renderButton imperatively.

import Script from "next/script";
import { useEffect, useRef, useState } from "react";

type GoogleCredentialResponse = { credential?: string; select_by?: string };

interface GISApi {
  accounts: {
    id: {
      initialize: (config: {
        client_id: string;
        callback: (resp: GoogleCredentialResponse) => void;
        auto_select?: boolean;
        itp_support?: boolean;
        ux_mode?: "popup" | "redirect";
      }) => void;
      renderButton: (
        parent: HTMLElement,
        options: Record<string, unknown>
      ) => void;
    };
  };
}

declare global {
  interface Window {
    google?: GISApi;
  }
}

interface GoogleSignInProps {
  redirectTo?: string;
  className?: string;
}

const SCRIPT_SRC = "https://accounts.google.com/gsi/client";

export function GoogleSignIn({
  redirectTo = "/account",
  className,
}: GoogleSignInProps) {
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  const buttonRef = useRef<HTMLDivElement | null>(null);
  const renderedRef = useRef<boolean>(false);
  const [scriptReady, setScriptReady] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<boolean>(false);

  const handleCredential = (response: GoogleCredentialResponse) => {
    const idToken = response?.credential;
    if (!idToken) {
      setError("No recibimos credenciales de Google. Intenta de nuevo.");
      return;
    }
    setError(null);
    setPending(true);
    fetch("/api/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    })
      .then(async (res) => {
        const payload = (await res.json().catch(() => null)) as
          | { ok: boolean; error?: { message?: string } }
          | null;
        if (!res.ok || !payload?.ok) {
          setError(
            payload?.error?.message ??
              "No pudimos iniciar sesión con Google. Intenta de nuevo."
          );
          setPending(false);
          return;
        }
        window.location.href = redirectTo;
      })
      .catch(() => {
        setError(
          "No pudimos conectar con el servidor. Verifica tu internet e intenta de nuevo."
        );
        setPending(false);
      });
  };

  useEffect(() => {
    if (!clientId || !scriptReady) return;
    if (renderedRef.current) return;
    if (!buttonRef.current) return;
    if (!window.google?.accounts?.id) return;

    renderedRef.current = true;
    try {
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: handleCredential,
        auto_select: false,
        itp_support: true,
        ux_mode: "popup",
      });
      window.google.accounts.id.renderButton(buttonRef.current, {
        type: "standard",
        shape: "rectangular",
        theme: "outline",
        text: "signin_with",
        size: "large",
        locale: "es",
        logo_alignment: "left",
        width: 320,
      });
    } catch (err) {
      console.error("[google-sign-in] init failed", err);
      setError("No se pudo cargar el botón de Google. Recarga la página.");
    }
    // handleCredential is a stable closure; safe to omit from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, scriptReady]);

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
      <Script
        src={SCRIPT_SRC}
        strategy="afterInteractive"
        onLoad={() => setScriptReady(true)}
        onReady={() => setScriptReady(true)}
      />
      <div ref={buttonRef} className="flex justify-center" />
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
