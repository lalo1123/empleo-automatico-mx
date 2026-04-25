import Link from "next/link";
import { redirect } from "next/navigation";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";
import {
  getAccount,
  cancelSubscription,
  resendVerification,
  ApiCallError,
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
  try {
    data = await getAccount(token!);
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

  return (
    <>
      <Nav authed />
      <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
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
      </main>
      <Footer />
    </>
  );
}
