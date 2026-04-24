import Link from "next/link";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";
import { verifyEmail, ApiCallError } from "@/lib/api";
import { clearVerificationUrlCookie } from "@/lib/auth";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Verifica tu correo",
  description: "Confirma tu cuenta de Empleo Automático MX.",
  robots: { index: false, follow: false },
};

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

type VerifyState =
  | { kind: "missing" }
  | { kind: "ok" }
  | { kind: "expired" }
  | { kind: "invalid" }
  | { kind: "error" };

async function runVerification(token: string): Promise<VerifyState> {
  try {
    await verifyEmail(token);
    // Clear the signup-time fallback cookie — the user is verified now.
    await clearVerificationUrlCookie();
    return { kind: "ok" };
  } catch (err) {
    if (err instanceof ApiCallError && err.code === "VERIFICATION_INVALID") {
      // Backend sends the same code for "unknown token", "already consumed",
      // and "expired". We distinguish expired by message substring — cheap
      // and keeps the code list small.
      if (err.message.toLowerCase().includes("expir")) {
        return { kind: "expired" };
      }
      return { kind: "invalid" };
    }
    return { kind: "error" };
  }
}

export default async function VerifyPage({ searchParams }: PageProps) {
  const { token } = await searchParams;
  const state: VerifyState = token
    ? await runVerification(token)
    : { kind: "missing" };

  return (
    <>
      <Nav />
      <main className="mx-auto flex min-h-[calc(100vh-16rem)] max-w-lg items-center justify-center px-4 py-16 sm:px-6">
        <div className="w-full rounded-[16px] border border-[color:var(--color-border)] bg-white p-8 shadow-[var(--shadow-soft)]">
          {state.kind === "ok" && (
            <>
              <h1 className="text-2xl font-bold tracking-tight text-[color:var(--color-ink)]">
                ¡Correo verificado!
              </h1>
              <p className="mt-2 text-sm text-[color:var(--color-ink-soft)]">
                Tu cuenta está lista. Ya puedes generar postulaciones y
                suscribirte a un plan.
              </p>
              <div className="mt-6">
                <Link
                  href="/account"
                  className="inline-flex items-center justify-center rounded-[12px] bg-[color:var(--color-brand-600)] px-5 py-2.5 text-sm font-semibold text-white shadow-[var(--shadow-brand)] transition hover:bg-[color:var(--color-brand-700)]"
                >
                  Ir a mi cuenta
                </Link>
              </div>
            </>
          )}

          {state.kind === "expired" && (
            <>
              <h1 className="text-2xl font-bold tracking-tight text-[color:var(--color-ink)]">
                El enlace expiró
              </h1>
              <p className="mt-2 text-sm text-[color:var(--color-ink-soft)]">
                Inicia sesión y solicita un enlace nuevo desde tu cuenta.
              </p>
              <div className="mt-6 flex gap-3">
                <Link
                  href="/login"
                  className="inline-flex items-center justify-center rounded-[12px] bg-[color:var(--color-brand-600)] px-5 py-2.5 text-sm font-semibold text-white shadow-[var(--shadow-brand)] transition hover:bg-[color:var(--color-brand-700)]"
                >
                  Iniciar sesión
                </Link>
              </div>
            </>
          )}

          {state.kind === "invalid" && (
            <>
              <h1 className="text-2xl font-bold tracking-tight text-[color:var(--color-ink)]">
                Enlace inválido
              </h1>
              <p className="mt-2 text-sm text-[color:var(--color-ink-soft)]">
                Este enlace ya fue usado o no es válido. Si ya verificaste tu
                correo puedes iniciar sesión directamente.
              </p>
              <div className="mt-6 flex gap-3">
                <Link
                  href="/login"
                  className="inline-flex items-center justify-center rounded-[12px] bg-[color:var(--color-brand-600)] px-5 py-2.5 text-sm font-semibold text-white shadow-[var(--shadow-brand)] transition hover:bg-[color:var(--color-brand-700)]"
                >
                  Iniciar sesión
                </Link>
              </div>
            </>
          )}

          {state.kind === "missing" && (
            <>
              <h1 className="text-2xl font-bold tracking-tight text-[color:var(--color-ink)]">
                Falta el enlace de verificación
              </h1>
              <p className="mt-2 text-sm text-[color:var(--color-ink-soft)]">
                Abre el enlace completo que te entregamos al registrarte. Si
                ya iniciaste sesión, puedes pedir uno nuevo desde tu cuenta.
              </p>
              <div className="mt-6">
                <Link
                  href="/account"
                  className="inline-flex items-center justify-center rounded-[12px] border border-[color:var(--color-border)] bg-white px-5 py-2.5 text-sm font-semibold text-[color:var(--color-ink)] hover:border-[color:var(--color-brand-400)]"
                >
                  Ir a mi cuenta
                </Link>
              </div>
            </>
          )}

          {state.kind === "error" && (
            <>
              <h1 className="text-2xl font-bold tracking-tight text-[color:var(--color-ink)]">
                No pudimos verificar tu correo
              </h1>
              <p className="mt-2 text-sm text-[color:var(--color-ink-soft)]">
                Intenta abrir el enlace de nuevo en unos minutos. Si el
                problema continúa, escríbenos a hola@skybrandmx.com.
              </p>
            </>
          )}
        </div>
      </main>
      <Footer />
    </>
  );
}
