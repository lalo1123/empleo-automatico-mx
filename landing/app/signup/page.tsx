import Link from "next/link";
import { redirect } from "next/navigation";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";
import { Turnstile } from "@/components/turnstile";
import { signup, ApiCallError } from "@/lib/api";
import {
  setSessionCookie,
  getSessionToken,
  setVerificationUrlCookie,
} from "@/lib/auth";
import { pageMetadata } from "@/lib/seo";
import type { Metadata } from "next";

export const metadata: Metadata = pageMetadata({
  title: "Crea tu cuenta gratis",
  description:
    "Regístrate gratis en Empleo Automático MX y postúlate en OCC, Computrabajo, Bumeran, Indeed y LinkedIn con cartas de presentación generadas por IA. Sin tarjeta de crédito.",
  path: "/signup",
});

interface PageProps {
  searchParams: Promise<{ error?: string }>;
}

async function createAccountAction(formData: FormData) {
  "use server";

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  // Turnstile injects this hidden input once the user solves the challenge.
  // When the widget is disabled (dev / no sitekey) the field is empty; we
  // pass undefined and the backend short-circuits too.
  const rawTurnstile = String(formData.get("cf-turnstile-response") ?? "");
  const turnstileToken = rawTurnstile.length > 0 ? rawTurnstile : undefined;

  if (!email || !password) {
    redirect("/signup?error=missing");
  }
  if (password.length < 8) {
    redirect("/signup?error=weak");
  }

  try {
    const res = await signup({
      email,
      password,
      name: name || undefined,
      turnstileToken,
    });
    await setSessionCookie(res.token);
    // Surface the verification URL via cookie so /account can show the
    // "verify your email" banner. TODO: remove once email delivery lands.
    if (res.verification?.verificationUrl) {
      await setVerificationUrlCookie(res.verification.verificationUrl);
    }
  } catch (err) {
    if (err instanceof ApiCallError) {
      if (err.code === "EMAIL_TAKEN") redirect("/signup?error=taken");
      if (err.code === "EMAIL_NOT_ALLOWED") redirect("/signup?error=disposable");
      if (err.code === "CAPTCHA_FAILED") redirect("/signup?error=captcha");
      if (err.code === "RATE_LIMITED") redirect("/signup?error=rate");
      redirect(`/signup?error=${encodeURIComponent(err.code)}`);
    }
    redirect("/signup?error=unknown");
  }
  redirect("/account?msg=verify_pending");
}

const ERROR_MESSAGES: Record<string, string> = {
  missing: "Completa email y contraseña.",
  weak: "La contraseña debe tener al menos 8 caracteres.",
  taken: "Ya existe una cuenta con ese email. Intenta iniciar sesión.",
  disposable:
    "Por favor usa un correo electrónico permanente (no temporales / desechables).",
  captcha:
    "No pudimos verificar que no eres un bot. Recarga la página e intenta de nuevo.",
  rate:
    "Demasiados intentos de registro. Intenta más tarde.",
  NETWORK_ERROR:
    "No pudimos conectar con el servidor. Verifica tu internet o intenta de nuevo.",
  unknown: "No pudimos crear tu cuenta. Intenta de nuevo.",
};

export default async function SignupPage({ searchParams }: PageProps) {
  // If already logged in, send them to their dashboard.
  const token = await getSessionToken();
  if (token) redirect("/account");

  const { error } = await searchParams;
  const errorMessage =
    error && (ERROR_MESSAGES[error] ?? ERROR_MESSAGES.unknown);

  return (
    <>
      <Nav />
      <main className="mx-auto flex min-h-[calc(100vh-16rem)] max-w-md items-center justify-center px-4 py-16 sm:px-6">
        <div className="w-full">
          <div className="text-center">
            <h1 className="text-3xl font-bold tracking-tight text-[color:var(--color-ink)]">
              Crea tu cuenta
            </h1>
            <p className="mt-2 text-sm text-[color:var(--color-ink-soft)]">
              Gratis, sin tarjeta. 3 postulaciones al mes para que lo pruebes.
            </p>
          </div>

          <form
            action={createAccountAction}
            className="mt-8 space-y-4 rounded-[16px] border border-[color:var(--color-border)] bg-white p-6 shadow-[var(--shadow-soft)]"
          >
            {errorMessage && (
              <div
                role="alert"
                className="rounded-[10px] border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
              >
                {errorMessage}
              </div>
            )}

            <div>
              <label
                htmlFor="name"
                className="block text-sm font-medium text-[color:var(--color-ink)]"
              >
                Nombre (opcional)
              </label>
              <input
                id="name"
                name="name"
                type="text"
                autoComplete="name"
                maxLength={80}
                className="mt-1 w-full rounded-[10px] border border-[color:var(--color-border)] bg-white px-3 py-2 text-sm shadow-[var(--shadow-soft)] placeholder:text-[color:var(--color-ink-muted)]"
                placeholder="Juan Pérez"
              />
            </div>

            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-[color:var(--color-ink)]"
              >
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                maxLength={200}
                className="mt-1 w-full rounded-[10px] border border-[color:var(--color-border)] bg-white px-3 py-2 text-sm shadow-[var(--shadow-soft)] placeholder:text-[color:var(--color-ink-muted)]"
                placeholder="tu@correo.com"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-[color:var(--color-ink)]"
              >
                Contraseña
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                minLength={8}
                maxLength={200}
                autoComplete="new-password"
                className="mt-1 w-full rounded-[10px] border border-[color:var(--color-border)] bg-white px-3 py-2 text-sm shadow-[var(--shadow-soft)] placeholder:text-[color:var(--color-ink-muted)]"
                placeholder="Mínimo 8 caracteres"
                aria-describedby="password-help"
              />
              <p
                id="password-help"
                className="mt-1 text-xs text-[color:var(--color-ink-muted)]"
              >
                Mínimo 8 caracteres.
              </p>
            </div>

            {/* Cloudflare Turnstile widget. Renders nothing when
                NEXT_PUBLIC_TURNSTILE_SITEKEY is unset (dev mode). */}
            <Turnstile action="signup" />

            <button
              type="submit"
              className="w-full rounded-[12px] bg-[color:var(--color-brand-600)] px-4 py-2.5 text-sm font-semibold text-white shadow-[var(--shadow-brand)] transition hover:bg-[color:var(--color-brand-700)]"
            >
              Crear cuenta gratis
            </button>

            <p className="text-center text-xs text-[color:var(--color-ink-muted)]">
              Al registrarte aceptas los{" "}
              <Link href="/terms" className="underline hover:text-[color:var(--color-ink)]">
                términos
              </Link>{" "}
              y el{" "}
              <Link href="/privacy" className="underline hover:text-[color:var(--color-ink)]">
                aviso de privacidad
              </Link>
              .
            </p>
          </form>

          <p className="mt-5 text-center text-sm text-[color:var(--color-ink-soft)]">
            ¿Ya tienes cuenta?{" "}
            <Link
              href="/login"
              className="font-semibold text-[color:var(--color-brand-700)] hover:text-[color:var(--color-brand-800)]"
            >
              Inicia sesión
            </Link>
          </p>
        </div>
      </main>
      <Footer />
    </>
  );
}
