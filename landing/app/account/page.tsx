import Link from "next/link";
import { redirect } from "next/navigation";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";
import { CancelSubscriptionForm } from "@/components/cancel-subscription-form";
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

  const { user, usage, preferences } = data;
  const plan = PLANS[user.plan];
  const isFree = user.plan === "free";
  const { msg, error } = await searchParams;

  // Email verification: surfaced inside the launch checklist (step 2) and as
  // the hero CTA while pending. Until email delivery is wired up, the
  // verification URL travels via cookie from signup.
  const needsVerify = user.emailVerified === false;
  const verifyUrlFromCookie = needsVerify
    ? await getVerificationUrlCookie()
    : null;

  // ---- derived dashboard state -------------------------------------------

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

  // Quota — THE number a job seeker cares about: how many auto-applications
  // they have left this month. Premium is unlimited monthly (daily anti-ban
  // cap instead).
  const unlimited = plan.applicationsPerMonth === "unlimited" || usage.limit <= 0;
  const remaining = unlimited ? null : Math.max(0, usage.limit - usage.current);
  const usagePct = unlimited
    ? 100
    : usage.limit > 0
      ? Math.min(100, Math.round((usage.current / usage.limit) * 100))
      : 0;
  const quotaExhausted = !unlimited && remaining === 0;

  // Telemetry ring geometry (r=64 → circumference ≈ 402). Keep a tiny spark
  // visible at 0% so the ring reads as "ready", not "broken".
  const RING_C = 2 * Math.PI * 64;
  const ringOffset = unlimited
    ? 0
    : RING_C * (1 - Math.max(usagePct, 2.5) / 100);

  const monthLabel = (() => {
    try {
      return new Date((usage.periodStart || Date.now() / 1000) * 1000)
        .toLocaleDateString("es-MX", { month: "long" });
    } catch {
      return "este mes";
    }
  })();

  // First name, capitalized — "eduardo Serratos gutierrez" → "Eduardo".
  const rawFirst = (user.name?.trim().split(/\s+/)[0] || "").toLocaleLowerCase("es-MX");
  const firstName = rawFirst
    ? rawFirst.charAt(0).toLocaleUpperCase("es-MX") + rawFirst.slice(1)
    : null;

  // ---- launch checklist (Zeigarnik: open loops pull users forward) -------

  const salarySet = (preferences?.expectedSalary ?? "").trim().length > 0;
  const checklist = [
    {
      title: "Crea tu cuenta",
      sub: "Listo — bienvenido a bordo.",
      done: true,
      href: null as string | null,
      action: null as "verify" | null,
      cta: "",
    },
    {
      title: "Verifica tu correo",
      sub: needsVerify
        ? "Un clic para activar tu cuenta."
        : "Cuenta activada.",
      done: !needsVerify,
      href: verifyUrlFromCookie,
      action: needsVerify && !verifyUrlFromCookie ? ("verify" as const) : null,
      cta: "Verificar →",
    },
    {
      title: "Define tu salario esperado",
      sub: salarySet
        ? "La IA responde con tu número."
        : "Para que la IA responda con TU número, no inventado.",
      done: salarySet,
      href: "/account/preferences",
      action: null,
      cta: "Configurar →",
    },
    {
      title: "Lanza tu primera postulación",
      sub: stats.totalAll > 0
        ? "¡Despegaste! Sigue postulando."
        : "Abre un portal y deja que la IA haga el resto.",
      done: stats.totalAll > 0,
      href: "https://lapieza.io/vacantes",
      action: null,
      cta: "Empezar →",
    },
  ];
  const doneCount = checklist.filter((s) => s.done).length;
  const checklistComplete = doneCount === checklist.length;
  const currentStepIdx = checklist.findIndex((s) => !s.done);

  // Hero CTA adapts to the user's next best action.
  const heroCta = needsVerify && verifyUrlFromCookie
    ? { href: verifyUrlFromCookie, label: "Activar mi cuenta", external: false }
    : stats.totalAll === 0
      ? { href: "https://lapieza.io/vacantes", label: "Lanzar mi primera postulación", external: true }
      : { href: "https://lapieza.io/vacantes", label: "Lanzar más postulaciones", external: true };

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

  const recentActivityPanel = (
    <article className="rounded-[20px] border border-[color:var(--color-border)] bg-white p-6 shadow-[0_18px_40px_-28px_rgba(15,29,44,0.45)]">
      <header className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[color:var(--color-ink-muted)]">
            Actividad reciente
          </p>
          <h2 className="mt-1 text-lg font-extrabold tracking-tight text-[color:var(--color-ink)]">
            Últimas postulaciones
          </h2>
        </div>
        <Link
          href="/account/historial"
          className="text-sm font-bold text-[color:var(--color-brand-600)] hover:underline"
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
          Tu primera postulación aparecerá aquí en cuanto despegue. 🚀
        </p>
      )}
    </article>
  );

  return (
    <>
      <Nav authed />

      {/* ===== Hero: launch deck =============================================
          Dark navy-teal canvas (trust + premium feel) with the brand's launch
          metaphor: trajectory arc, star field, flame CTA. The telemetry ring
          answers the #1 question — "¿cuántas postulaciones me quedan?" */}
      <section className="relative overflow-hidden bg-[linear-gradient(160deg,#103b50_0%,#0c2f44_45%,#0a1c2b_100%)] text-white">
        {/* star field */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-10 [background-image:radial-gradient(rgba(255,255,255,0.35)_1px,transparent_1.4px)] [background-size:34px_34px]"
        />
        {/* soft glows */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_120%_at_85%_-10%,rgba(112,209,198,0.18),transparent_45%),radial-gradient(90%_90%_at_10%_120%,rgba(255,102,0,0.10),transparent_50%)]"
        />
        {/* trajectory arc */}
        <svg
          aria-hidden
          className="pointer-events-none absolute -right-10 -top-8 hidden h-[520px] w-[560px] lg:block"
          viewBox="0 0 560 520"
          fill="none"
        >
          <path
            d="M40 480 C 220 470, 430 360, 520 90"
            stroke="url(#traj)"
            strokeWidth="2.5"
            strokeDasharray="2 9"
            strokeLinecap="round"
          />
          <circle cx="520" cy="90" r="5" fill="#ff6600" />
          <circle cx="520" cy="90" r="13" fill="#ff6600" opacity="0.18" />
          <defs>
            <linearGradient id="traj" x1="40" y1="480" x2="520" y2="90" gradientUnits="userSpaceOnUse">
              <stop stopColor="#70d1c6" stopOpacity="0" />
              <stop offset="1" stopColor="#70d1c6" />
            </linearGradient>
          </defs>
        </svg>

        <div className="relative mx-auto grid max-w-6xl items-center gap-10 px-4 pb-16 pt-11 sm:px-6 lg:grid-cols-[1fr_350px]">
          <div>
            <span className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em] text-[#70d1c6]">
              <span
                aria-hidden
                className="h-1.5 w-1.5 rounded-full bg-[#ff6600] shadow-[0_0_12px_2px_rgba(255,102,0,0.7)]"
              />
              Panel de despegue
            </span>
            <h1 className="mt-3.5 text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-[42px]">
              Bienvenido a bordo{firstName ? "," : "."}
              {firstName && (
                <>
                  <br />
                  <span className="bg-gradient-to-r from-white to-[#70d1c6] bg-clip-text text-transparent">
                    {firstName}.
                  </span>
                </>
              )}
            </h1>
            <p className="mt-3.5 max-w-md text-base leading-relaxed text-[#bcd3da]">
              {stats.totalAll === 0
                ? "Tu próximo empleo está a unas cuantas postulaciones de despegar. Enciende motores y deja que la IA postule por ti."
                : `Llevas ${stats.totalMonth} ${stats.totalMonth === 1 ? "postulación" : "postulaciones"} este mes. Cada lanzamiento te acerca a la entrevista.`}
            </p>

            <div className="mt-6 flex flex-wrap gap-3">
              <a
                href={heroCta.href}
                {...(heroCta.external
                  ? { target: "_blank", rel: "noopener noreferrer" }
                  : {})}
                className="inline-flex items-center gap-2 rounded-[12px] bg-gradient-to-b from-[#ff7a1a] to-[#ff6600] px-5 py-3 text-sm font-bold text-white shadow-[0_10px_26px_-8px_rgba(255,102,0,0.65)] transition hover:brightness-110"
              >
                <svg aria-hidden width="15" height="15" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 2c3.5 1.8 5 5 5 8.5 0 2.2-.7 4-2 5.5l-3 .8-3-.8c-1.3-1.5-2-3.3-2-5.5C7 7 8.5 3.8 12 2Z"
                    fill="#fff"
                  />
                  <circle cx="12" cy="9.5" r="1.8" fill="#ff6600" />
                </svg>
                {heroCta.label}
              </a>
              <Link
                href={stats.totalAll === 0 ? "/#como-funciona" : "/account/historial"}
                className="inline-flex items-center rounded-[12px] border border-white/20 bg-white/[0.08] px-5 py-3 text-sm font-bold text-white transition hover:bg-white/[0.14]"
              >
                {stats.totalAll === 0 ? "Ver cómo funciona" : "Ver mi historial"}
              </Link>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12.5px] font-medium text-[#8fb0ba]">
              <span className="inline-flex items-center gap-1.5">
                <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#ffb066" strokeWidth="2.4">
                  <rect x="4" y="10" width="16" height="11" rx="2.5" />
                  <path d="M8 10V7a4 4 0 1 1 8 0v3" />
                </svg>
                Tú das el último clic
              </span>
              <span aria-hidden className="text-white/20">·</span>
              <span>
                <b className="text-[#cfe6ea]">6</b> portales conectados
              </span>
              <span aria-hidden className="text-white/20">·</span>
              <span>
                Cartas con IA <b className="text-[#cfe6ea]">personalizadas</b>
              </span>
            </div>
          </div>

          {/* Telemetry: remaining auto-applications, impossible to miss. */}
          <div className="rounded-[20px] border border-white/[0.14] bg-white/[0.06] p-6 backdrop-blur-sm">
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#9fc0c8]">
              Postulaciones · {monthLabel}
            </p>
            <div className="relative mx-auto mb-1.5 mt-3.5 h-40 w-40">
              <svg width="160" height="160" viewBox="0 0 160 160">
                <circle
                  cx="80" cy="80" r="64" fill="none"
                  stroke="rgba(255,255,255,0.12)" strokeWidth="12"
                />
                <circle
                  cx="80" cy="80" r="64" fill="none"
                  stroke={unlimited ? "#70d1c6" : quotaExhausted ? "#ef6f6f" : "#ff6600"}
                  strokeWidth="12" strokeLinecap="round"
                  strokeDasharray={RING_C}
                  strokeDashoffset={ringOffset}
                  transform="rotate(-90 80 80)"
                />
              </svg>
              <div className="absolute inset-0 grid place-content-center text-center">
                <div className="text-[34px] font-extrabold tracking-tight tabular-nums">
                  {usage.current}
                  <span className="text-[#6f939c]">
                    {unlimited ? "" : `/${usage.limit}`}
                  </span>
                  {unlimited && (
                    <span className="ml-1 align-middle text-2xl text-[#70d1c6]">∞</span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-[#9fc0c8]">
                  {unlimited ? "sin límite mensual" : "usadas este mes"}
                </div>
              </div>
            </div>
            <p className="text-center text-[13px] leading-snug text-[#cfe6ea]">
              {unlimited ? (
                <>
                  Plan {plan.name}: postulaciones ilimitadas, con cap responsable
                  de <b>30/día</b> para proteger tus cuentas.
                </>
              ) : quotaExhausted ? (
                <>
                  Límite del mes alcanzado.{" "}
                  <Link href="/account/billing" className="font-bold text-[#ffb066] underline">
                    Sube de plan
                  </Link>{" "}
                  para seguir postulando.
                </>
              ) : (
                <>
                  Te quedan <b>{remaining}</b>{" "}
                  {remaining === 1 ? "postulación" : "postulaciones"} este mes.
                  {stats.totalAll === 0 && " Despega hoy 🚀"}
                </>
              )}
            </p>
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/[0.12]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-[#70d1c6] to-[#ff6600]"
                style={{ width: `${Math.max(usagePct, 4)}%` }}
              />
            </div>
          </div>
        </div>
      </section>

      {/* ===== Body ========================================================= */}
      <div className="bg-[#f4f7f8]">
        <main id="main" className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">

          {/* metric tiles, overlapping the hero edge */}
          <section className="relative z-10 -mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricTile
              label="Total enviadas"
              hint="histórico"
              value={stats.totalAll}
              icon={
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 19V5m0 14h16M8 16l4-5 3 3 5-7" />
                </svg>
              }
              tone="teal"
            />
            <MetricTile
              label="Este mes"
              hint={monthLabel}
              value={stats.totalMonth}
              icon={
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="5" width="18" height="16" rx="2.5" />
                  <path d="M3 10h18M8 3v4M16 3v4" />
                </svg>
              }
              tone="flame"
            />
            <MetricTile
              label="Esta semana"
              hint="últimos 7 días"
              value={stats.total7d}
              icon={
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
                </svg>
              }
              tone="violet"
            />
            <MetricTile
              label="Top portal"
              hint={topSourceCount > 0 ? `${topSourceCount} aplicadas` : "aún sin datos"}
              value={topSourceLabel}
              isText
              icon={
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 21h8m-4-4v4M5 4h14v4a7 7 0 0 1-14 0V4Z" />
                  <path d="M5 6H3a3 3 0 0 0 3 5m13-5h2a3 3 0 0 1-3 5" />
                </svg>
              }
              tone="amber"
            />
          </section>

          {/* status banners */}
          {msg === "verify_pending" && !needsVerify && (
            <StatusBanner tone="ok">
              Cuenta creada. Revisa tu correo para confirmar tu dirección.
            </StatusBanner>
          )}
          {msg === "verify_resent" && (
            <StatusBanner tone="info">
              Te generamos un enlace de verificación nuevo — revisa el paso 2 de
              tu lista de despegue.
            </StatusBanner>
          )}
          {msg === "already_verified" && (
            <StatusBanner tone="ok">Tu correo ya estaba verificado.</StatusBanner>
          )}
          {msg === "cancel_scheduled" && (
            <StatusBanner tone="warn">
              Tu cancelación quedó programada. Mantendrás acceso hasta el final
              del período actual.
            </StatusBanner>
          )}
          {msg === "checkout_success" && (
            <StatusBanner tone="ok">
              Tu suscripción se activó. Bienvenido al plan {plan.name}. 🚀
            </StatusBanner>
          )}
          {error && (
            <StatusBanner tone="err">
              Algo salió mal. Intenta de nuevo o escríbenos a hola@skybrandmx.com.
            </StatusBanner>
          )}

          <section className="mt-6 grid items-start gap-5 lg:grid-cols-[1.4fr_1fr]">
            {/* ---- left column ---- */}
            <div className="space-y-5">
              {!checklistComplete ? (
                <article className="rounded-[20px] border border-[color:var(--color-border)] bg-white p-6 shadow-[0_18px_40px_-28px_rgba(15,29,44,0.45)]">
                  <header>
                    <h2 className="text-lg font-extrabold tracking-tight text-[color:var(--color-ink)]">
                      Lista de despegue
                    </h2>
                    <p className="mt-1 text-[13px] text-[color:var(--color-ink-muted)]">
                      Completa estos pasos para que tu primera postulación salga
                      perfecta.
                    </p>
                  </header>
                  <div className="mt-3 flex items-center gap-3">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#eef3f5]">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-[#2a9c91] to-[#105971] transition-all"
                        style={{ width: `${(doneCount / checklist.length) * 100}%` }}
                      />
                    </div>
                    <span className="text-xs font-bold tabular-nums text-[color:var(--color-ink-muted)]">
                      {doneCount}/{checklist.length}
                    </span>
                  </div>

                  <ol className="mt-3 flex flex-col">
                    {checklist.map((step, i) => (
                      <li
                        key={step.title}
                        className="flex items-center gap-3.5 rounded-[13px] px-3 py-3 transition hover:bg-[#f7fafb]"
                      >
                        <span
                          aria-hidden
                          className={`grid h-[30px] w-[30px] flex-none place-items-center rounded-full text-[13px] font-bold ${
                            step.done
                              ? "bg-[color:var(--color-brand-600)] text-white"
                              : i === currentStepIdx
                                ? "border-2 border-[#ff6600] bg-white text-[#ff6600] shadow-[0_0_0_4px_rgba(255,102,0,0.12)]"
                                : "bg-[#eef3f5] text-[color:var(--color-ink-muted)]"
                          }`}
                        >
                          {step.done ? "✓" : i + 1}
                        </span>
                        <div className="min-w-0">
                          <p
                            className={`text-[14.5px] font-semibold ${
                              step.done
                                ? "text-[color:var(--color-ink-muted)] line-through"
                                : "text-[color:var(--color-ink)]"
                            }`}
                          >
                            {step.title}
                          </p>
                          <p className="text-[12.5px] text-[color:var(--color-ink-muted)]">
                            {step.sub}
                          </p>
                        </div>
                        {!step.done && step.href && (
                          <a
                            href={step.href}
                            {...(step.href.startsWith("http")
                              ? { target: "_blank", rel: "noopener noreferrer" }
                              : {})}
                            className="ml-auto whitespace-nowrap text-[12.5px] font-bold text-[#ff6600] hover:underline"
                          >
                            {step.cta}
                          </a>
                        )}
                        {!step.done && step.action === "verify" && (
                          <form action={resendVerifyAction} className="ml-auto">
                            <button
                              type="submit"
                              className="whitespace-nowrap text-[12.5px] font-bold text-[#ff6600] hover:underline"
                            >
                              Reenviar enlace →
                            </button>
                          </form>
                        )}
                      </li>
                    ))}
                  </ol>
                </article>
              ) : (
                recentActivityPanel
              )}

              {/* recent activity below checklist while onboarding (only if any) */}
              {!checklistComplete && recentApplications.length > 0 && recentActivityPanel}

              {/* per-portal distribution */}
              {stats.totalAll > 0 && (
                <article className="rounded-[20px] border border-[color:var(--color-border)] bg-white p-6 shadow-[0_18px_40px_-28px_rgba(15,29,44,0.45)]">
                  <header>
                    <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[color:var(--color-ink-muted)]">
                      Por portal
                    </p>
                    <h2 className="mt-1 text-lg font-extrabold tracking-tight text-[color:var(--color-ink)]">
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
                            <span className="text-xs tabular-nums text-[color:var(--color-ink-muted)]">
                              {count} ({pct}%)
                            </span>
                          </div>
                          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[#f1f5f9]">
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
              )}
            </div>

            {/* ---- right column ---- */}
            <div className="space-y-5">
              {/* plan + quota card */}
              <article className="rounded-[20px] border border-[color:var(--color-border)] bg-white p-6 shadow-[0_18px_40px_-28px_rgba(15,29,44,0.45)]">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[color:var(--color-ink-muted)]">
                      Tu plan
                    </p>
                    <p className="mt-1.5 text-3xl font-extrabold tracking-tight text-[color:var(--color-ink)]">
                      {plan.name}{" "}
                      <span className="text-[13px] font-semibold text-[color:var(--color-ink-muted)]">
                        ·{" "}
                        {isFree
                          ? "sin tarjeta"
                          : `${formatMxn(plan.priceMonthlyMxn)} / mes`}
                      </span>
                    </p>
                  </div>
                  <span className="rounded-full bg-[#ecfaf7] px-3 py-1 text-[11px] font-bold text-[color:var(--color-brand-700)]">
                    Activo
                  </span>
                </div>

                <div className="mt-4 rounded-[14px] border border-[color:var(--color-border)] bg-[#f7fafb] p-4">
                  <p className="text-xs text-[color:var(--color-ink-muted)]">
                    Postulaciones este mes
                  </p>
                  <p className="mt-1 text-xl font-bold tabular-nums text-[color:var(--color-ink)]">
                    {usage.current}{" "}
                    <span className="text-[13px] font-semibold text-[color:var(--color-ink-muted)]">
                      / {limitLabel(plan)}
                    </span>
                  </p>
                  <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-[#e9eef1]">
                    <div
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={usagePct}
                      className={`h-full rounded-full transition-all ${
                        quotaExhausted
                          ? "bg-gradient-to-r from-[#ef6f6f] to-[#dc2626]"
                          : "bg-gradient-to-r from-[#4fb9ad] to-[#105971]"
                      }`}
                      style={{ width: `${Math.max(usagePct, unlimited ? 100 : 2)}%` }}
                    />
                  </div>
                  {!unlimited && (
                    <p className="mt-2 text-[12px] text-[color:var(--color-ink-muted)]">
                      {quotaExhausted
                        ? "Se acabaron — se reinician el próximo período."
                        : `${remaining} ${remaining === 1 ? "restante" : "restantes"} · se reinician cada mes`}
                    </p>
                  )}
                  {unlimited && (
                    <p className="mt-2 text-[12px] text-[color:var(--color-ink-muted)]">
                      Cap responsable: hasta 30 postulaciones al día para
                      proteger tus cuentas en los portales.
                    </p>
                  )}
                </div>

                {isFree ? (
                  <Link
                    href="/account/billing"
                    className="mt-4 flex w-full items-center justify-center rounded-[12px] bg-[#0f1d2c] px-5 py-3 text-sm font-bold text-white transition hover:bg-[#1f3447]"
                  >
                    Subir a Pro — 100 postulaciones/mes →
                  </Link>
                ) : (
                  <div className="mt-4 space-y-2.5">
                    <Link
                      href="/account/billing"
                      className="flex w-full items-center justify-center rounded-[12px] border border-[color:var(--color-border)] bg-white px-5 py-2.5 text-sm font-bold text-[color:var(--color-ink)] hover:border-[color:var(--color-brand-400)]"
                    >
                      Gestionar suscripción
                    </Link>
                    <CancelSubscriptionForm action={cancelAction}>
                      <button
                        type="submit"
                        className="w-full rounded-[12px] border border-red-200 bg-white px-5 py-2.5 text-sm font-semibold text-red-700 hover:border-red-300 hover:bg-red-50"
                      >
                        Cancelar suscripción
                      </button>
                    </CancelSubscriptionForm>
                  </div>
                )}

                <p className="mt-3.5 text-[11.5px] text-[color:var(--color-ink-muted)]">
                  {formatDate(usage.periodStart)} — {formatDate(usage.periodEnd)}
                  {user.planExpiresAt && !isFree && (
                    <> · Renovación: {formatDate(user.planExpiresAt)}</>
                  )}
                </p>
              </article>

              {/* quick links */}
              <article className="rounded-[20px] border border-[color:var(--color-border)] bg-white p-6 shadow-[0_18px_40px_-28px_rgba(15,29,44,0.45)]">
                <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[color:var(--color-ink-muted)]">
                  Accesos rápidos
                </p>
                <div className="mt-3 grid gap-2">
                  <Link
                    href="/account/cv"
                    className="flex items-center justify-between rounded-[12px] border border-[color:var(--color-border)] px-4 py-3 text-sm font-semibold text-[color:var(--color-ink)] transition hover:border-[color:var(--color-brand-400)] hover:bg-[#f7fafb]"
                  >
                    <span>📄 Mi CV (créalo con IA)</span>
                    <span aria-hidden className="text-[color:var(--color-ink-muted)]">→</span>
                  </Link>
                  <Link
                    href="/account/preferences"
                    className="flex items-center justify-between rounded-[12px] border border-[color:var(--color-border)] px-4 py-3 text-sm font-semibold text-[color:var(--color-ink)] transition hover:border-[color:var(--color-brand-400)] hover:bg-[#f7fafb]"
                  >
                    <span>🎯 Preferencias y salario esperado</span>
                    <span aria-hidden className="text-[color:var(--color-ink-muted)]">→</span>
                  </Link>
                  <Link
                    href="/account/historial"
                    className="flex items-center justify-between rounded-[12px] border border-[color:var(--color-border)] px-4 py-3 text-sm font-semibold text-[color:var(--color-ink)] transition hover:border-[color:var(--color-brand-400)] hover:bg-[#f7fafb]"
                  >
                    <span>📋 Historial de postulaciones</span>
                    <span aria-hidden className="text-[color:var(--color-ink-muted)]">→</span>
                  </Link>
                  <a
                    href={CHROME_STORE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between rounded-[12px] border border-[color:var(--color-border)] px-4 py-3 text-sm font-semibold text-[color:var(--color-ink)] transition hover:border-[color:var(--color-brand-400)] hover:bg-[#f7fafb]"
                  >
                    <span>🧩 Instalar extensión de Chrome</span>
                    <span aria-hidden className="text-[color:var(--color-ink-muted)]">↗</span>
                  </a>
                </div>
                <p className="mt-3 text-[11.5px] text-[color:var(--color-ink-muted)]">
                  La extensión usa esta misma cuenta. El listado en Chrome Web
                  Store llega después del beta cerrado.
                </p>
              </article>

              {/* session */}
              <form action={logoutAction}>
                <button
                  type="submit"
                  className="w-full rounded-[12px] border border-[color:var(--color-border)] bg-white px-4 py-2.5 text-sm font-medium text-[color:var(--color-ink-muted)] transition hover:border-[color:var(--color-brand-400)] hover:text-[color:var(--color-ink)]"
                >
                  Cerrar sesión
                </button>
              </form>
            </div>
          </section>
        </main>
      </div>
      <Footer />
    </>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusBanner({
  tone,
  children,
}: {
  tone: "ok" | "info" | "warn" | "err";
  children: React.ReactNode;
}) {
  const styles: Record<string, string> = {
    ok: "border-emerald-200 bg-emerald-50 text-emerald-900",
    info: "border-sky-200 bg-sky-50 text-sky-900",
    warn: "border-amber-200 bg-amber-50 text-amber-900",
    err: "border-red-200 bg-red-50 text-red-800",
  };
  return (
    <div
      role={tone === "err" ? "alert" : "status"}
      className={`mt-5 rounded-[14px] border px-4 py-3 text-sm ${styles[tone]}`}
    >
      {children}
    </div>
  );
}

/**
 * Metric tile with a color-coded icon chip. Numbers use Inter +
 * tabular-nums for a clean instrument-panel look (no slashed zeros).
 */
function MetricTile({
  label,
  hint,
  value,
  icon,
  tone,
  isText = false,
}: {
  label: string;
  hint?: string;
  value: number | string;
  icon: React.ReactNode;
  tone: "teal" | "flame" | "violet" | "amber";
  isText?: boolean;
}) {
  const chip: Record<string, string> = {
    teal: "bg-[#ecfaf7] text-[#105971]",
    flame: "bg-[#fff1e6] text-[#ff6600]",
    violet: "bg-[#f1ecfe] text-[#7c3aed]",
    amber: "bg-[#fef3c7] text-[#b45309]",
  };
  return (
    <div className="rounded-[18px] border border-[color:var(--color-border)] bg-white p-5 shadow-[0_18px_40px_-28px_rgba(15,29,44,0.45)] transition hover:-translate-y-0.5 hover:shadow-[0_22px_44px_-26px_rgba(15,29,44,0.5)]">
      <div className="flex items-center justify-between">
        <span
          aria-hidden
          className={`grid h-9 w-9 place-items-center rounded-[10px] ${chip[tone]}`}
        >
          {icon}
        </span>
        {hint && (
          <span className="text-[11px] font-semibold lowercase tracking-wide text-[color:var(--color-ink-muted)]">
            {hint}
          </span>
        )}
      </div>
      <div
        className={`mt-3 font-extrabold tracking-tight tabular-nums text-[color:var(--color-ink)] ${
          isText ? "text-xl" : "text-[32px] leading-none"
        }`}
      >
        {typeof value === "number" ? value.toLocaleString("es-MX") : value}
      </div>
      <div className="mt-1.5 text-[12.5px] text-[color:var(--color-ink-muted)]">
        {label}
      </div>
    </div>
  );
}
