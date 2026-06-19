import Link from "next/link";
import { PLAN_ORDER, PLANS, formatMxn, limitLabel } from "@/lib/plans";

interface PricingTableProps {
  // When rendered from a logged-in dashboard we want the CTAs to go to /account/billing
  // instead of /signup. Default is marketing mode (go to /signup).
  authed?: boolean;
}

export function PricingTable({ authed = false }: PricingTableProps) {
  return (
    <div className="grid items-stretch gap-5 md:grid-cols-3">
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

        // Recommended plan inverts to the dark navy "anchor" card with a teal
        // halo — the same focal gesture as the dashboard plan card.
        if (isPopular) {
          return (
            <div
              key={plan.id}
              className="relative flex flex-col overflow-hidden rounded-[18px] bg-[#0f1d2c] p-6 text-white shadow-[0_28px_60px_-30px_rgba(15,29,44,0.9)] md:-my-2"
            >
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_90%_at_100%_0%,rgba(19,126,122,0.4),transparent_56%)]"
              />
              <div className="relative flex flex-1 flex-col">
                <span className="mb-4 inline-flex w-fit items-center gap-1.5 rounded-full bg-[#ff6600] px-3 py-1 text-[11px] font-bold text-white">
                  Más popular
                </span>
                <h3 className="text-base font-bold text-white">{plan.name}</h3>
                <p className="mt-1 text-sm text-white/55">{plan.tagline}</p>
                <div className="mt-5 flex items-baseline gap-1">
                  <span className="text-[40px] font-bold leading-none tracking-tight tabular-nums">
                    ${plan.priceMonthlyMxn.toLocaleString("es-MX")}
                  </span>
                  <span className="text-sm text-white/55">MXN / mes</span>
                </div>
                {plan.priceYearlyMxn > 0 && (
                  <p className="mt-1 text-xs text-white/45">
                    o {formatMxn(plan.priceYearlyMxn)} al año (ahorra 2 meses)
                  </p>
                )}

                <div className="mt-5 rounded-[12px] border border-white/10 bg-white/[0.05] p-4 text-sm">
                  <dt className="text-white/55">Postulaciones</dt>
                  <dd className="mt-0.5 text-base font-bold text-white">
                    {limitLabel(plan)}
                  </dd>
                </div>

                <ul className="mt-5 flex-1 space-y-2.5 text-sm text-white/80">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2">
                      <svg
                        aria-hidden
                        viewBox="0 0 24 24"
                        className="mt-0.5 h-4 w-4 flex-none text-[#7fd8cd]"
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
                  className="mt-6 inline-flex items-center justify-center rounded-[12px] bg-white px-4 py-3 text-sm font-bold text-[#0f1d2c] transition hover:-translate-y-0.5 hover:shadow-[0_12px_26px_-10px_rgba(0,0,0,0.5)]"
                >
                  {plan.cta}
                </Link>
              </div>
            </div>
          );
        }

        return (
          <div
            key={plan.id}
            className="ead-card flex flex-col rounded-[18px] border border-[color:var(--color-border)] bg-white p-6"
          >
            <h3 className="text-base font-bold text-[color:var(--color-ink)]">
              {plan.name}
            </h3>
            <p className="mt-1 text-sm text-[color:var(--color-ink-muted)]">
              {plan.tagline}
            </p>
            <div className="mt-5 flex items-baseline gap-1">
              <span className="text-[40px] font-bold leading-none tracking-tight tabular-nums text-[color:var(--color-ink)]">
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

            <div className="mt-5 rounded-[12px] border border-[color:var(--color-border)] bg-[color:var(--color-surface-soft)] p-4 text-sm">
              <dt className="text-[color:var(--color-ink-muted)]">Postulaciones</dt>
              <dd className="mt-0.5 text-base font-bold text-[color:var(--color-ink)]">
                {limitLabel(plan)}
              </dd>
            </div>

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
              className="mt-6 inline-flex items-center justify-center rounded-[12px] border border-[color:var(--color-border)] bg-white px-4 py-3 text-sm font-bold text-[color:var(--color-ink)] transition hover:border-[color:var(--color-brand-400)] hover:text-[color:var(--color-brand-700)]"
            >
              {plan.cta}
            </Link>
          </div>
        );
      })}
    </div>
  );
}
