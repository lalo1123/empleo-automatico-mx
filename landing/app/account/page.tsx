import Link from "next/link";
import { redirect } from "next/navigation";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";
import {
  getAccount,
  cancelSubscription,
  resendVerification,
  getApplicationsStats,
  getApplicationsHistory,
  ApiCallError,
  type ApplicationSource,
  type ApplicationsStats,
  type Application,
} from "@/lib/api";
import {
  clearSessionCookie,
  getSessionToken,
  getVerificationUrlCookie,
  setVerificationUrlCookie,
} from "@/lib/auth";
import { PLANS, formatMxn, limitLabel } from "@/lib/plans";
import { pageMetadata } from "@/lib/seo";
import type { Metadata } from "next";

// Private page — kept out of Google via noindex. Still set a nice title for
// tab legibility, but no structured metadata / OG since it isn't shareable.
export const metadata: Metadata = pageMetadata({
  title: "Mi cuenta",
  description: "Administra tu plan y uso de Empleo Automático MX.",
  path: "/account",
  noIndex: true,
});

// Placeholder — reemplazar con el ID real cuando la extensión esté publicada en
// Chrome Web Store (se define en COMMERCIAL.md fase 2).
const CHROME_STORE_URL =
  "https://chromewebstore.google.com/detail/PLACEHOLDER_EXTENSION_ID";

interface PageProps {
  searchParams: Promise<{ msg?: string; error?: string }>;
}

async function logoutAction() {
  "use server";
  await clearSessionCookie();
  redirect("/");
}

async function resendVerifyAction() {
  "use server";
  const token = await getSessionToken();
  if (!token) redirect("/login?next=/account");
  try {
    const res = await resendVerification(token!);
    if (res.alreadyVerified) {
      redirect("/account?msg=already_verified");
    }
    if (res.verification?.verificationUrl) {
      await setVerificationUrlCookie(res.verification.verificationUrl);
    }
    redirect("/account?msg=verify_resent");
  } catch (err) {
    if (err instanceof ApiCallError) {
      if (err.code === "RATE_LIMITED") redirect("/account?error=rate");
      redirect(`/account?error=${encodeURIComponent(err.code)}`);
    }
    redirect("/account?error=unknown");
  }
}

async function cancelAction() {
  "use server";
  const token = await getSessionToken();
  if (!token) redirect("/login");
  try {
    await cancelSubscription(token);
  } catch (err) {
    if (err instanceof ApiCallError) {
      redirect(`/account?error=${encodeURIComponent(err.code)}`);
    }
    redirect("/account?error=unknown");
  }
  redirect("/account?msg=cancel_scheduled");
}

function formatDate(seconds: number | undefined): string {
  if (!seconds) return "—";
  try {
    return new Date(seconds * 1000).toLocaleDateString("es-MX", {
      day: "2-digit",
      month: "long",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

export default async function AccountPage({ searchParams }: PageProps) {
  const token = await getSessionToken();
  if (!token) redirect("/login?next=/account");

  let data;
  // Stats + recent history fire in parallel with getAccount. They're
  // best-effort — if either fails (extension never installed yet, or
  // backend hiccup) we just render the dashboard with empty defaults
  // instead of failing the whole page.
  let statsData: { stats: ApplicationsStats } | null = null;
  let recentData: { applications: Application[]; total: number } | null = null;
  try {
    const [account, stats, recent] = await Promise.all([
      getAccount(token!),
      getApplicationsStats(token!).catch(() => null),
      getApplicationsHistory(token!, { pageSize: 5 }).catch(() => null),
    ]);
    data = account;
    statsData = stats;
    recentData = recent;
  } catch (err) {
    if (err instanceof ApiCallError && (err.status === 401 || err.status === 403)) {
      await clearSessionCookie();
      redirect("/login?error=invalid");
    }
    // Any other error: show a lightweight error state inline.
    return (
      <>
        <Nav authed />
        <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
          <h1 className="text-2xl font-bold text-[color:var(--color-ink)]">
            No pudimos cargar tu cuenta
          </h1>
          <p className="mt-2 text-sm text-[color:var(--color-ink-soft)]">
            Intenta recargar la página. Si el problema sigue, escríbenos a
            hola@skybrandmx.com.
          </p>
          <form action={logoutAction} className="mt-6">
            <button
              type="submit"
              className="rounded-[10px] border border-[color:var(--color-border)] bg-white px-4 py-2 text-sm font-medium text-[color:var(--color-ink)] hover:border-[color:var(--color-brand-400)]"
            >
              Cerrar sesión
            </button>
          </form>
        </main>
        <Footer />
      </>
    );
  }

  const { user, usage } = data;
  const plan = PLANS[user.plan];
  const isFree = user.plan === "free";
  const { msg, error } = await searchParams;

  // Email verification banner: show if the backend reports unverified. Until
  // email delivery is wired up, we also surface the verification URL from the
  // signup cookie so the user can click straight through (dev workflow).
  const needsVerify = user.emailVerified === false;
  const verifyUrlFromCookie = needsVerify
    ? await getVerificationUrlCookie()
    : null;

  const usagePct =
    usage.limit > 0
      ? Math.min(100, Math.round((usage.current / usage.limit) * 100))
      : 0;

  // Derive dashboard hero stats. When stats endpoint failed we fall back
  // to zero — the empty-state copy in the card handles the messaging.
  const stats = statsData?.stats ?? {
    totalAll: 0,
    totalMonth: 0,
    totalWeek: 0,
    total7d: 0,
    bySource: {
      lapieza: 0, occ: 0, computrabajo: 0,
      bumeran: 0, indeed: 0, linkedin: 0
    } as Record<ApplicationSource, number>,
  };
  const recentApplications = recentData?.applications ?? [];

  // Top portal — defaults to "—" when nothing applied yet.
  const sourceLabels: Record<ApplicationSource, string> = {
    lapieza: "LaPieza",
    occ: "OCC",
    computrabajo: "Computrabajo",
    bumeran: "Bumeran",
    indeed: "Indeed",
    linkedin: "LinkedIn",
  };
  const sourceEntries = (Object.entries(stats.bySource) as [ApplicationSource, number][]).
    sort(([, a], [, b]) => b - a);
  const topSourceId = sourceEntries[0]?.[1] ? sourceEntries[0][0] : null;
  const topSourceLabel = topSourceId ? sourceLabels[topSourceId] : "—";
  const topSourceCount = topSourceId ? sourceEntries[0][1] : 0;

  function formatRelativeTime(unixSec: number): string {
    const diffMs = Date.now() - unixSec * 1000;
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) return "Ahora";
    if (minutes < 60) return `Hace ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `Hace ${hours} h`;
    const days = Math.floor(hours / 24);
    if (days === 1) return "Ayer";
    if (days < 7) return `Hace ${days} días`;
    const d = new Date(unixSec * 1000);
    return d.toLocaleDateString("es-MX", { day: "numeric", month: "short" });
  }

  return (
    <>
      <Nav authed />
      <main className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <header className="flex flex-col gap-1">
          <p className="text-xs font-semibold uppercase tracking-widest text-[color:var(--color-brand-600)]">
            Mi cuenta
          </p>
          <h1 className="text-3xl font-bold tracking-tight text-[color:var(--color-ink)]">
            Hola{user.name ? `, ${user.name}` : ""}
          </h1>
          <p className="text-sm text-[color:var(--color-ink-soft)]">
            {user.email}
          </p>
        </header>

        {/* Stats hero — 4 cards showing application activity at a glance.
            Renders even when stats failed (counts default to 0) so the
            visual hierarchy stays consistent for new users. */}
        <section className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatHero
            label="Total"
            value={stats.totalAll}
            sub="postulaciones"
            tone="brand"
            icon="📋"
          />
          <StatHero
            label="Este mes"
            value={stats.totalMonth}
            sub={stats.totalMonth > 0 ? "postulaciones" : "Empieza hoy"}
            tone="sky"
            icon="🗓️"
          />
          <StatHero
            label="Esta semana"
            value={stats.totalWeek}
            sub={stats.totalWeek > 0 ? "postulaciones" : "—"}
            tone="emerald"
            icon="⚡"
          />
          <StatHero
            label="Top portal"
            value={topSourceLabel}
            sub={topSourceCount > 0 ? `${topSourceCount} aplicadas` : "Aún sin datos"}
            tone="amber"
            icon="🏆"
            isText
          />
        </section>

        {needsVerify && (
          <div
            role="status"
            className="mt-6 rounded-[12px] border border-amber-300 bg-amber-50 px-4 py-4 text-sm text-amber-900"
          >
            <p className="font-semibold">Verifica tu correo electrónico</p>
            <p className="mt-1">
              Para generar postulaciones o contratar un plan, confirma tu
              correo. Te enviamos un enlace al registrarte.
            </p>
            {verifyUrlFromCookie && (
              <p className="mt-2 break-all text-xs">
                Enlace de verificación:{" "}
                <a
                  href={verifyUrlFromCookie}
                  className="font-medium underline"
                >
                  {verifyUrlFromCookie}
                </a>
              </p>
            )}
            <form action={resendVerifyAction} className="mt-3">
              <button
                type="submit"
                className="rounded-[10px] border border-amber-400 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100"
              >
                Reenviar enlace
              </button>
            </form>
          </div>
        )}

        {msg === "verify_pending" && !needsVerify && (
          <div
            role="status"
            className="mt-6 rounded-[12px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
          >
            Cuenta creada. Revisa tu correo para confirmar tu dirección.
          </div>
        )}
        {msg === "verify_resent" && (
          <div
            role="status"
            className="mt-6 rounded-[12px] border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900"
          >
            Te generamos un enlace de verificación nuevo. Revisa abajo.
          </div>
        )}
        {msg === "already_verified" && (
          <div
            role="status"
            className="mt-6 rounded-[12px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
          >
            Tu correo ya estaba verificado.
          </div>
        )}

        {msg === "cancel_scheduled" && (
          <div
            role="status"
            className="mt-6 rounded-[12px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          >
            Tu cancelación quedó programada. Mantendrás acceso hasta el final
            del período actual.
          </div>
        )}
        {msg === "checkout_success" && (
          <div
            role="status"
            className="mt-6 rounded-[12px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
          >
            Tu suscripción se activó. Bienvenido al plan {plan.name}.
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="mt-6 rounded-[12px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
          >
            Algo salió mal. Intenta de nuevo o escríbenos a hola@skybrandmx.com.
          </div>
        )}

        <section className="mt-8 grid gap-5 lg:grid-cols-3">
          {/* Plan card */}
          <article className="lg:col-span-2 rounded-[16px] border border-[color:var(--color-border)] bg-white p-6 shadow-[var(--shadow-soft)]">
            <header className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-[color:var(--color-ink-muted)]">
                  Plan actual
                </p>
                <h2 className="mt-1 text-2xl font-bold text-[color:var(--color-ink)]">
                  {plan.name}
                </h2>
                <p className="mt-1 text-sm text-[color:var(--color-ink-soft)]">
                  {plan.tagline}
                </p>
              </div>
              <span
                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  isFree
                    ? "bg-[color:var(--color-surface-sunken)] text-[color:var(--color-ink-soft)]"
                    : "bg-[color:var(--color-brand-50)] text-[color:var(--color-brand-700)]"
                }`}
              >
                {isFree ? "Gratis" : formatMxn(plan.priceMonthlyMxn) + " / mes"}
              </span>
            </header>

            <dl className="mt-6 grid gap-4 sm:grid-cols-2">
              <div className="rounded-[12px] bg-[color:var(--color-surface-soft)] p-4">
                <dt className="text-xs text-[color:var(--color-ink-muted)]">
                  Postulaciones este mes
                </dt>
                <dd className="mt-1 text-xl font-semibold text-[color:var(--color-ink)]">
                  {usage.current}{" "}
                  <span className="text-sm font-normal text-[color:var(--color-ink-muted)]">
                    / {limitLabel(plan)}
                  </span>
                </dd>
                <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-white">
                  <div
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={usagePct}
                    className="h-full rounded-full bg-gradient-to-r from-[#70d1c6] to-[#105971] transition-all"
                    style={{ width: `${usagePct}%` }}
                  />
                </div>
              </div>
              <div className="rounded-[12px] bg-[color:var(--color-surface-soft)] p-4">
                <dt className="text-xs text-[color:var(--color-ink-muted)]">
                  Período actual
                </dt>
                <dd className="mt-1 text-sm text-[color:var(--color-ink)]">
                  {formatDate(usage.periodStart)} —{" "}
                  {formatDate(usage.periodEnd)}
                </dd>
                {user.planExpiresAt && !isFree && (
                  <p className="mt-2 text-xs text-[color:var(--color-ink-muted)]">
                    Renovación: {formatDate(user.planExpiresAt)}
                  </p>
                )}
              </div>
            </dl>

            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                href="/account/historial"
                className="inline-flex items-center justify-center gap-2 rounded-[12px] border border-[color:var(--color-border)] bg-white px-5 py-2.5 text-sm font-semibold text-[color:var(--color-ink)] hover:border-[color:var(--color-brand-400)]"
              >
                <span aria-hidden>📋</span>
                Ver historial
              </Link>
              {isFree ? (
                <Link
                  href="/account/billing"
                  className="inline-flex items-center justify-center gap-2 rounded-[12px] bg-[color:var(--color-brand-600)] px-5 py-2.5 text-sm font-semibold text-white shadow-[var(--shadow-brand)] transition hover:bg-[color:var(--color-brand-700)]"
                >
                  Hacer upgrade
                  <svg
                    aria-hidden
                    viewBox="0 0 24 24"
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </Link>
              ) : (
                <>
                  <Link
                    href="/account/billing"
                    className="inline-flex items-center justify-center rounded-[12px] border border-[color:var(--color-border)] bg-white px-5 py-2.5 text-sm font-semibold text-[color:var(--color-ink)] hover:border-[color:var(--color-brand-400)]"
                  >
                    Gestionar suscripción
                  </Link>
                  <form action={cancelAction}>
                    <button
                      type="submit"
                      className="inline-flex items-center justify-center rounded-[12px] border border-red-200 bg-white px-5 py-2.5 text-sm font-semibold text-red-700 hover:border-red-300 hover:bg-red-50"
                    >
                      Cancelar suscripción
                    </button>
                  </form>
                </>
              )}
            </div>
          </article>

          {/* Sidebar card */}
          <aside className="space-y-5">
            <div className="rounded-[16px] border border-[color:var(--color-border)] bg-white p-6 shadow-[var(--shadow-soft)]">
              <h3 className="text-sm font-semibold text-[color:var(--color-ink)]">
                Instala la extensión
              </h3>
              <p className="mt-2 text-xs text-[color:var(--color-ink-soft)]">
                Para postular, instala la extensión de Chrome y entra con la
                misma cuenta.
              </p>
              <a
                href={CHROME_STORE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-[10px] border border-[color:var(--color-border)] bg-white px-4 py-2 text-sm font-semibold text-[color:var(--color-ink)] hover:border-[color:var(--color-brand-400)]"
              >
                Abrir Chrome Web Store
                <svg
                  aria-hidden
                  viewBox="0 0 24 24"
                  className="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M7 17L17 7M9 7h8v8" />
                </svg>
              </a>
              <p className="mt-2 text-[11px] text-[color:var(--color-ink-muted)]">
                El listado en Chrome Web Store llega después del beta cerrado.
              </p>
            </div>

            <div className="rounded-[16px] border border-[color:var(--color-border)] bg-white p-6 shadow-[var(--shadow-soft)]">
              <h3 className="text-sm font-semibold text-[color:var(--color-ink)]">
                Sesión
              </h3>
              <form action={logoutAction} className="mt-4">
                <button
                  type="submit"
                  className="w-full rounded-[10px] border border-[color:var(--color-border)] bg-white px-4 py-2 text-sm font-medium text-[color:var(--color-ink)] hover:border-[color:var(--color-brand-400)]"
                >
                  Cerrar sesión
                </button>
              </form>
            </div>
          </aside>
        </section>

        {/* Actividad reciente — preview of the last 5 applications, with a
            CTA to the full history page. Hidden when the user hasn't
            applied to anything yet. */}
        {(stats.totalAll > 0 || recentApplications.length > 0) && (
          <section className="mt-8 grid gap-5 lg:grid-cols-3">
            <article className="lg:col-span-2 rounded-[16px] border border-[color:var(--color-border)] bg-white p-6 shadow-[var(--shadow-soft)]">
              <header className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-widest text-[color:var(--color-ink-muted)]">
                    Actividad reciente
                  </p>
                  <h2 className="mt-1 text-lg font-bold text-[color:var(--color-ink)]">
                    Últimas postulaciones
                  </h2>
                </div>
                <Link
                  href="/account/historial"
                  className="text-sm font-semibold text-[color:var(--color-brand-600)] hover:underline"
                >
                  Ver todo →
                </Link>
              </header>
              {recentApplications.length > 0 ? (
                <ul className="mt-4 divide-y divide-[color:var(--color-border)]">
                  {recentApplications.map((app) => (
                    <li key={app.id} className="flex items-start justify-between gap-4 py-3">
                      <div className="min-w-0 flex-1">
                        {app.url ? (
                          <a
                            href={app.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block truncate text-sm font-semibold text-[color:var(--color-ink)] hover:text-[color:var(--color-brand-600)] hover:underline"
                          >
                            {app.title || "(sin título)"}
                          </a>
                        ) : (
                          <span className="block truncate text-sm font-semibold text-[color:var(--color-ink)]">
                            {app.title || "(sin título)"}
                          </span>
                        )}
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[color:var(--color-ink-muted)]">
                          <span>{app.company || "—"}</span>
                          <span aria-hidden>·</span>
                          <span>{sourceLabels[app.source]}</span>
                          {app.matchScore > 0 && (
                            <>
                              <span aria-hidden>·</span>
                              <span className="font-medium text-[color:var(--color-ink-soft)]">
                                {app.matchScore}% match
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            app.status === "hired"
                              ? "bg-emerald-50 text-emerald-800"
                              : app.status === "viewed"
                                ? "bg-sky-50 text-sky-800"
                                : app.status === "rejected"
                                  ? "bg-rose-50 text-rose-800"
                                  : "bg-slate-100 text-slate-700"
                          }`}
                        >
                          {app.status === "applied"
                            ? "Postulado"
                            : app.status === "viewed"
                              ? "Visto"
                              : app.status === "rejected"
                                ? "Rechazado"
                                : "Contratado"}
                        </span>
                        <span className="text-xs text-[color:var(--color-ink-muted)]">
                          {formatRelativeTime(app.appliedAt)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-4 text-sm text-[color:var(--color-ink-soft)]">
                  Tu primera postulación aparecerá aquí.
                </p>
              )}
            </article>

            {/* Distribución por portal */}
            <article className="rounded-[16px] border border-[color:var(--color-border)] bg-white p-6 shadow-[var(--shadow-soft)]">
              <header>
                <p className="text-xs font-semibold uppercase tracking-widest text-[color:var(--color-ink-muted)]">
                  Por portal
                </p>
                <h2 className="mt-1 text-lg font-bold text-[color:var(--color-ink)]">
                  Distribución
                </h2>
              </header>
              <ul className="mt-4 space-y-3">
                {sourceEntries.map(([sourceId, count]) => {
                  const pct = stats.totalAll > 0
                    ? Math.round((count / stats.totalAll) * 100)
                    : 0;
                  return (
                    <li key={sourceId}>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-sm font-medium text-[color:var(--color-ink)]">
                          {sourceLabels[sourceId]}
                        </span>
                        <span className="text-xs text-[color:var(--color-ink-muted)] font-variant-numeric tabular-nums">
                          {count} ({pct}%)
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--color-surface-soft)]">
                        <div
                          className={`h-full rounded-full ${
                            count === 0
                              ? "bg-slate-200"
                              : "bg-gradient-to-r from-[#70d1c6] to-[#105971]"
                          }`}
                          style={{ width: `${Math.max(2, pct)}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </article>
          </section>
        )}

        {/* Empty-state CTA for fresh users — shown when no applications yet */}
        {stats.totalAll === 0 && (
          <section className="mt-8 rounded-[16px] border border-[color:var(--color-brand-200)] bg-gradient-to-br from-[color:var(--color-brand-50)] to-white p-6 shadow-[var(--shadow-soft)]">
            <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-base font-bold text-[color:var(--color-ink)]">
                  Lista para tu primera postulación
                </h3>
                <p className="mt-1 text-sm text-[color:var(--color-ink-soft)]">
                  Abre LaPieza, dale clic al botón <strong>⚡ Postular con IA</strong> en cualquier vacante y termina con <strong>Finalizar</strong>. Aparecerá aquí en segundos.
                </p>
              </div>
              <a
                href="https://lapieza.io/vacantes"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-2 rounded-[12px] bg-[color:var(--color-brand-600)] px-5 py-2.5 text-sm font-semibold text-white shadow-[var(--shadow-brand)] hover:bg-[color:var(--color-brand-700)]"
              >
                Abrir LaPieza →
              </a>
            </div>
          </section>
        )}
      </main>
      <Footer />
    </>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * Hero stat card. Each tone has its own border/glow accent so the four
 * cards read as a set without looking monotone.
 */
function StatHero({
  label,
  value,
  sub,
  tone,
  icon,
  isText = false,
}: {
  label: string;
  value: number | string;
  sub?: string;
  tone: "brand" | "sky" | "emerald" | "amber";
  icon: string;
  isText?: boolean;
}) {
  const toneClasses: Record<string, string> = {
    brand:
      "border-[color:var(--color-brand-200)] bg-gradient-to-br from-[color:var(--color-brand-50)] to-white",
    sky: "border-sky-200 bg-gradient-to-br from-sky-50 to-white",
    emerald:
      "border-emerald-200 bg-gradient-to-br from-emerald-50 to-white",
    amber: "border-amber-200 bg-gradient-to-br from-amber-50 to-white",
  };
  const valueColor: Record<string, string> = {
    brand: "text-[color:var(--color-brand-700)]",
    sky: "text-sky-700",
    emerald: "text-emerald-700",
    amber: "text-amber-700",
  };
  return (
    <div
      className={`rounded-[14px] border p-4 shadow-[var(--shadow-soft)] ${toneClasses[tone]}`}
    >
      <div className="flex items-start justify-between">
        <p className="text-xs font-semibold uppercase tracking-widest text-[color:var(--color-ink-muted)]">
          {label}
        </p>
        <span aria-hidden className="text-lg leading-none">
          {icon}
        </span>
      </div>
      <div
        className={`mt-2 ${isText ? "text-xl" : "text-3xl"} font-bold tracking-tight ${valueColor[tone]}`}
      >
        {typeof value === "number" ? value.toLocaleString("es-MX") : value}
      </div>
      {sub && (
        <div className="mt-0.5 text-xs text-[color:var(--color-ink-muted)]">
          {sub}
        </div>
      )}
    </div>
  );
}
