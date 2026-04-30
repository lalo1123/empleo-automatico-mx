import Link from "next/link";
import { redirect } from "next/navigation";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";
import { Turnstile } from "@/components/turnstile";
import { GoogleSignIn } from "@/components/google-sign-in";
import { login, ApiCallError } from "@/lib/api";
import { setSessionCookie, getSessionToken } from "@/lib/auth";
import { pageMetadata } from "@/lib/seo";
import type { Metadata } from "next";

export const metadata: Metadata = pageMetadata({
  title: "Inicia sesión",
  description:
    "Entra a tu cuenta de Empleo Automático MX para revisar tu plan, tu uso y tus postulaciones en los 6 portales soportados. Acceso seguro, rápido y sin fricción.",
  path: "/login",
});

interface PageProps {
  searchParams: Promise<{ error?: string; next?: string }>;
}

async function loginAction(formData: FormData) {
  "use server";

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/account");
  const rawTurnstile = String(formData.get("cf-turnstile-response") ?? "");
  const turnstileToken = rawTurnstile.length > 0 ? rawTurnstile : undefined;

  if (!email || !password) {
    redirect("/login?error=missing");
  }

  try {
    const { token } = await login({ email, password, turnstileToken });
    await setSessionCookie(token);
  } catch (err) {
    if (err instanceof ApiCallError) {
      if (err.code === "INVALID_CREDENTIALS")
        redirect("/login?error=invalid");
      if (err.code === "CAPTCHA_FAILED")
        redirect("/login?error=captcha");
      redirect(`/login?error=${encodeURIComponent(err.code)}`);
    }
    redirect("/login?error=unknown");
  }
  // Basic open-redirect guard: only allow same-origin paths.
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/account";
  redirect(safeNext);
}

const ERROR_MESSAGES: Record<string, string> = {
  missing: "Completa email y contraseña.",
  invalid: "Email o contraseña incorrectos.",
  captcha:
    "No pudimos verificar que no eres un bot. Recarga la página e intenta de nuevo.",
  NETWORK_ERROR:
    "No pudimos conectar con el servidor. Verifica tu internet o intenta de nuevo.",
  unknown: "No pudimos iniciar sesión. Intenta de nuevo.",
};

export default async function LoginPage({ searchParams }: PageProps) {
  const token = await getSessionToken();
  if (token) redirect("/account");

  const { error, next } = await searchParams;
  const errorMessage =
    error && (ERROR_MESSAGES[error] ?? ERROR_MESSAGES.unknown);

  return (
    <>
      <Nav />
      <main className="mx-auto flex min-h-[calc(100vh-16rem)] max-w-md items-center justify-center px-4 py-16 sm:px-6">
        <div className="w-full">
          <div className="text-center">
            <h1 className="text-3xl font-bold tracking-tight text-[color:var(--color-ink)]">
              Inicia sesión
            </h1>
            <p className="mt-2 text-sm text-[color:var(--color-ink-soft)]">
              Entra a tu cuenta para ver tu plan y uso.
            </p>
          </div>

          <div className="mt-8 space-y-4 rounded-[16px] border border-[color:var(--color-border)] bg-white p-6 shadow-[var(--shadow-soft)]">
            <GoogleSignIn redirectTo={next && next.startsWith("/") && !next.startsWith("//") ? next : "/account"} />

            <div className="relative">
              <div
                aria-hidden="true"
                className="absolute inset-0 flex items-center"
              >
                <div className="w-full border-t border-[color:var(--color-border)]" />
              </div>
              <div className="relative flex justify-center">
                <span className="bg-white px-3 text-xs uppercase tracking-wide text-[color:var(--color-ink-muted)]">
                  o entra con email
                </span>
              </div>
            </div>

          <form
            action={loginAction}
            className="space-y-4"
          >
            {errorMessage && (
              <div
                role="alert"
                className="rounded-[10px] border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
              >
                {errorMessage}
              </div>
            )}

            <input type="hidden" name="next" value={next ?? "/account"} />

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
                maxLength={200}
                autoComplete="current-password"
                className="mt-1 w-full rounded-[10px] border border-[color:var(--color-border)] bg-white px-3 py-2 text-sm shadow-[var(--shadow-soft)] placeholder:text-[color:var(--color-ink-muted)]"
              />
            </div>

            {/* Turnstile widget (renders only when sitekey env is set). */}
            <Turnstile action="login" />

            <button
              type="submit"
              className="w-full rounded-[12px] bg-[color:var(--color-brand-600)] px-4 py-2.5 text-sm font-semibold text-white shadow-[var(--shadow-brand)] transition hover:bg-[color:var(--color-brand-700)]"
            >
              Entrar
            </button>
          </form>
          </div>

          <p className="mt-5 text-center text-sm text-[color:var(--color-ink-soft)]">
            ¿Nuevo por aquí?{" "}
            <Link
              href="/signup"
              className="font-semibold text-[color:var(--color-brand-700)] hover:text-[color:var(--color-brand-800)]"
            >
              Crea tu cuenta gratis
            </Link>
          </p>
        </div>
      </main>
      <Footer />
    </>
  );
}
