import Link from "next/link";
import { PLAN_ORDER, PLANS, formatMxn, limitLabel } from "@/lib/plans";

interface PricingTableProps {
  // When rendered from a logged-in dashboard we want the CTAs to go to /account/billing
  // instead of /signup. Default is marketing mode (go to /signup).
  authed?: boolean;
}

export function PricingTable({ authed = false }: PricingTableProps) {
  return (
    <div className="grid gap-5 md:grid-cols-3">
      {PLAN_ORDER.map((id) => {
        const plan = PLANS[id];
        const isPopular = plan.popular;
        const href =
          plan.id === "free"
            ? authed
              ? "/account"
              : "/signup"
            : authed
              ? "/account/billing"
              : "/signup";

        return (
          <div
            key={plan.id}
            className={`relative flex flex-col rounded-[16px] border bg-white p-6 shadow-[var(--shadow-soft)] transition ${
              isPopular
                ? "border-[color:var(--color-brand-500)] ring-1 ring-[color:var(--color-brand-500)]"
                : "border-[color:var(--color-border)]"
            }`}
          >
            {isPopular && (
              <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-[color:var(--color-brand-600)] px-3 py-1 text-xs font-semibold text-white shadow-[var(--shadow-brand)]">
                Más popular
              </span>
            )}

            <header>
              <h3 className="text-base font-semibold text-[color:var(--color-ink)]">
                {plan.name}
              </h3>
              <p className="mt-1 text-sm text-[color:var(--color-ink-muted)]">
                {plan.tagline}
              </p>
              <div className="mt-5 flex items-baseline gap-1">
                <span className="text-4xl font-bold tracking-tight text-[color:var(--color-ink)]">
                  {plan.priceMonthlyMxn === 0
                    ? "$0"
                    : `$${plan.priceMonthlyMxn.toLocaleString("es-MX")}`}
                </span>
                <span className="text-sm text-[color:var(--color-ink-muted)]">
                  MXN / mes
                </span>
              </div>
              {plan.priceYearlyMxn > 0 && (
                <p className="mt-1 text-xs text-[color:var(--color-ink-muted)]">
                  o {formatMxn(plan.priceYearlyMxn)} al año (ahorra 2 meses)
                </p>
              )}
            </header>

            <dl className="mt-5 rounded-[12px] bg-[color:var(--color-surface-soft)] p-4 text-sm">
              <dt className="text-[color:var(--color-ink-muted)]">
                Postulaciones
              </dt>
              <dd className="mt-0.5 text-base font-semibold text-[color:var(--color-ink)]">
                {limitLabel(plan)}
              </dd>
            </dl>

            <ul className="mt-5 flex-1 space-y-2.5 text-sm text-[color:var(--color-ink-soft)]">
              {plan.features.map((feature) => (
                <li key={feature} className="flex items-start gap-2">
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
                  <span>{feature}</span>
                </li>
              ))}
            </ul>

            <Link
              href={href}
              className={`mt-6 inline-flex items-center justify-center rounded-[12px] px-4 py-2.5 text-sm font-semibold transition ${
                isPopular
                  ? "bg-[color:var(--color-brand-600)] text-white shadow-[var(--shadow-brand)] hover:bg-[color:var(--color-brand-700)]"
                  : "border border-[color:var(--color-border)] bg-white text-[color:var(--color-ink)] hover:border-[color:var(--color-brand-400)] hover:text-[color:var(--color-brand-700)]"
              }`}
            >
              {plan.cta}
            </Link>
          </div>
        );
      })}
    </div>
  );
}
