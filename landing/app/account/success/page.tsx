import Link from "next/link";
import { redirect } from "next/navigation";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";
import { getSessionToken } from "@/lib/auth";
import { pageMetadata } from "@/lib/seo";
import type { Metadata } from "next";

export const metadata: Metadata = pageMetadata({
  title: "Suscripción activada",
  description: "Confirmación de suscripción en Empleo Automático MX.",
  path: "/account/success",
  noIndex: true,
});

interface PageProps {
  searchParams: Promise<{ sub?: string }>;
}

// Post-checkout landing page. Conekta redirects here with `?sub=success` or
// `?sub=pending`. The real plan update happens via webhook, so this page is
// just a confirmation and a link back into the app.
export default async function CheckoutSuccessPage({ searchParams }: PageProps) {
  const token = await getSessionToken();
  if (!token) redirect("/login");

  const { sub } = await searchParams;
  const state =
    sub === "success"
      ? "success"
      : sub === "pending"
        ? "pending"
        : sub === "failure"
          ? "failure"
          : "unknown";

  return (
    <>
      <Nav authed />
      <main className="mx-auto flex min-h-[calc(100vh-16rem)] max-w-xl items-center justify-center px-4 py-16 sm:px-6">
        <div className="w-full text-center">
          <div
            aria-hidden
            className={`mx-auto flex h-14 w-14 items-center justify-center rounded-full ${
              state === "success"
                ? "bg-emerald-100 text-emerald-700"
                : state === "failure"
                  ? "bg-red-100 text-red-700"
                  : "bg-amber-100 text-amber-700"
            }`}
          >
            {state === "success" ? (
              <svg
                viewBox="0 0 24 24"
                className="h-6 w-6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 12l5 5L20 7" />
              </svg>
            ) : state === "failure" ? (
              <svg
                viewBox="0 0 24 24"
                className="h-6 w-6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 6l12 12M6 18L18 6" />
              </svg>
            ) : (
              <svg
                viewBox="0 0 24 24"
                className="h-6 w-6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 7v5l3 3" />
                <circle cx="12" cy="12" r="9" />
              </svg>
            )}
          </div>

          <h1 className="mt-5 text-3xl font-bold tracking-tight text-[color:var(--color-ink)]">
            {state === "success" && "¡Bienvenido!"}
            {state === "pending" && "Pago pendiente"}
            {state === "failure" && "No se pudo completar el pago"}
            {state === "unknown" && "Volviste del checkout"}
          </h1>

          <p className="mx-auto mt-3 max-w-md text-sm text-[color:var(--color-ink-soft)]">
            {state === "success" &&
              "Tu suscripción quedó activada. Puede tardar uno o dos minutos en reflejarse en tu cuenta mientras Conekta confirma el pago."}
            {state === "pending" &&
              "Conekta está procesando tu pago (por ejemplo, OXXO o SPEI). Cuando se acredite, tu plan se activará automáticamente."}
            {state === "failure" &&
              "Parece que el pago no pudo procesarse. Intenta de nuevo o usa otro método. Si ya se descontó, no te preocupes: se refleja en unos minutos."}
            {state === "unknown" &&
              "Regresa a tu cuenta para ver el estado de tu plan."}
          </p>

          <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/account"
              className="inline-flex items-center justify-center rounded-[12px] bg-[color:var(--color-brand-600)] px-5 py-2.5 text-sm font-semibold text-white shadow-[var(--shadow-brand)] hover:bg-[color:var(--color-brand-700)]"
            >
              Ir a mi cuenta
            </Link>
            {state === "failure" && (
              <Link
                href="/account/billing"
                className="inline-flex items-center justify-center rounded-[12px] border border-[color:var(--color-border)] bg-white px-5 py-2.5 text-sm font-semibold text-[color:var(--color-ink)] hover:border-[color:var(--color-brand-400)]"
              >
                Intentar otra vez
              </Link>
            )}
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
