import Link from "next/link";
import { redirect } from "next/navigation";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";
import {
  getAccount,
  createCheckout,
  ApiCallError,
} from "@/lib/api";
import { clearSessionCookie, getSessionToken } from "@/lib/auth";
import { PLANS, formatMxn, limitLabel, type PlanId } from "@/lib/plans";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Gestionar suscripción",
  description: "Cambia o contrata un plan de Empleo Automático MX.",
  robots: { index: false, follow: false },
};

interface PageProps {
  searchParams: Promise<{ error?: string }>;
}

async function checkoutAction(formData: FormData) {
  "use server";
  const token = await getSessionToken();
  if (!token) redirect("/login?next=/account/billing");

  const plan = String(formData.get("plan") ?? "") as PlanId;
  const interval = (String(formData.get("interval") ?? "monthly")) as
    | "monthly"
    | "yearly";
  if (plan !== "pro" && plan !== "premium") {
    redirect("/account/billing?error=invalid_plan");
  }

  try {
    const { checkoutUrl } = await createCheckout(token!, plan, interval);
    // External redirect to Conekta hosted checkout.
    redirect(checkoutUrl);
  } catch (err) {
    // Next.js uses a thrown redirect internally — let it bubble.
    if (err && typeof err === "object" && "digest" in err) throw err;
    if (err instanceof ApiCallError) {
      redirect(`/account/billing?error=${encodeURIComponent(err.code)}`);
    }
    redirect("/account/billing?error=unknown");
  }
}

export default async function BillingPage({ searchParams }: PageProps) {
  const token = await getSessionToken();
  if (!token) redirect("/login?next=/account/billing");

  let data;
  try {
    data = await getAccount(token!);
  } catch (err) {
    if (err instanceof ApiCallError && (err.status === 401 || err.status === 403)) {
      await clearSessionCookie();
      redirect("/login?error=invalid");
    }
    redirect("/account?error=billing_load");
  }

  const { user } = data;
  const { error } = await searchParams;

  return (
    <>
      <Nav authed />
      <main className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
        <nav aria-label="Ruta de navegación" className="text-xs text-[color:var(--color-ink-muted)]">
          <Link href="/account" className="hover:text-[color:var(--color-ink)]">
            Mi cuenta
          </Link>{" "}
          / Suscripción
        </nav>

        <header className="mt-2">
          <h1 className="text-3xl font-bold tracking-tight text-[color:var(--color-ink)]">
            Gestionar suscripción
          </h1>
          <p className="mt-2 text-sm text-[color:var(--color-ink-soft)]">
            Plan actual: <strong>{PLANS[user.plan].name}</strong>. Los pagos se
            procesan por Conekta.
          </p>
        </header>

        {error && (
          <div
            role="alert"
            className="mt-6 rounded-[12px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
          >
            No pudimos iniciar el checkout. Intenta de nuevo o escríbenos a
            hola@skybrandmx.com.
          </div>
        )}

        <section className="mt-8 grid gap-5 md:grid-cols-2">
          {(["pro", "premium"] as const).map((id) => {
            const plan = PLANS[id];
            const isCurrent = user.plan === id;
            return (
              <article
                key={id}
                className={`flex flex-col rounded-[16px] border bg-white p-6 shadow-[var(--shadow-soft)] ${
                  plan.popular
                    ? "border-[color:var(--color-brand-500)] ring-1 ring-[color:var(--color-brand-500)]"
                    : "border-[color:var(--color-border)]"
                }`}
              >
                <header className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-xl font-bold text-[color:var(--color-ink)]">
                      {plan.name}
                    </h2>
                    <p className="mt-1 text-sm text-[color:var(--color-ink-muted)]">
                      {plan.tagline}
                    </p>
                  </div>
                  {isCurrent && (
                    <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                      Tu plan actual
                    </span>
                  )}
                </header>

                <div className="mt-5 flex items-baseline gap-1">
                  <span className="text-3xl font-bold text-[color:var(--color-ink)]">
                    {formatMxn(plan.priceMonthlyMxn)}
                  </span>
                  <span className="text-sm text-[color:var(--color-ink-muted)]">
                    / mes
                  </span>
                </div>
                <p className="text-xs text-[color:var(--color-ink-muted)]">
                  o {formatMxn(plan.priceYearlyMxn)} al año (ahorra 2 meses)
                </p>

                <p className="mt-3 text-sm text-[color:var(--color-ink)]">
                  {limitLabel(plan)} postulaciones
                </p>

                <ul className="mt-4 flex-1 space-y-2 text-sm text-[color:var(--color-ink-soft)]">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2">
                      <svg
                        aria-hidden
                        viewBox="0 0 24 24"
                        className="mt-0.5 h-4 w-4 flex-none text-[color:var(--color-brand-600)]"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M5 12l4 4L19 6" />
                      </svg>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>

                {!isCurrent && (
                  <form
                    action={checkoutAction}
                    className="mt-6 flex flex-col gap-3"
                  >
                    <input type="hidden" name="plan" value={id} />
                    <div className="flex items-center gap-4 text-sm text-[color:var(--color-ink-soft)]">
                      <label className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="interval"
                          value="monthly"
                          defaultChecked
                          className="accent-[color:var(--color-brand-600)]"
                        />
                        Mensual
                      </label>
                      <label className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="interval"
                          value="yearly"
                          className="accent-[color:var(--color-brand-600)]"
                        />
                        Anual (-17%)
                      </label>
                    </div>
                    <button
                      type="submit"
                      className={`rounded-[12px] px-4 py-2.5 text-sm font-semibold transition ${
                        plan.popular
                          ? "bg-[color:var(--color-brand-600)] text-white shadow-[var(--shadow-brand)] hover:bg-[color:var(--color-brand-700)]"
                          : "border border-[color:var(--color-border)] bg-white text-[color:var(--color-ink)] hover:border-[color:var(--color-brand-400)]"
                      }`}
                    >
                      {plan.cta}
                    </button>
                  </form>
                )}
              </article>
            );
          })}
        </section>

        <p className="mt-8 text-xs text-[color:var(--color-ink-muted)]">
          Conekta te redirigirá de vuelta al final del checkout. Tu plan se
          activa cuando se confirma el primer pago. Renovación automática; puedes
          cancelar en cualquier momento desde tu cuenta.
        </p>
      </main>
      <Footer />
    </>
  );
}
