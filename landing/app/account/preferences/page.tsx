// Preferences page — city, modality, salary range. Lives on the web so
// the extension can stay focused on "apply" — the user explicit ask:
// "que la extension sea mas para aplicar o autoaplicar y ya".
//
// Server-side fetches the current preferences, hands them to a client
// component that renders the editable form. PUT goes straight back to
// /v1/account/preferences. The extension polls /account on next open
// and overrides its local mirror.

import Link from "next/link";
import { redirect } from "next/navigation";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";
import {
  getAccount,
  getPreferences,
  ApiCallError,
} from "@/lib/api";
import { clearSessionCookie, getSessionToken } from "@/lib/auth";
import { pageMetadata } from "@/lib/seo";
import type { Metadata } from "next";
import { PreferencesForm } from "@/components/preferences-form";

export const metadata: Metadata = pageMetadata({
  title: "Preferencias de búsqueda",
  description: "Define ciudad, modalidad y rango salarial para que el ranking de vacantes esté afinado a ti.",
  path: "/account/preferences",
  noIndex: true,
});

export default async function PreferencesPage() {
  const token = await getSessionToken();
  if (!token) redirect("/login?next=/account/preferences");

  let prefs;
  try {
    // Validate the session via /account, then fetch preferences.
    await getAccount(token!);
    prefs = (await getPreferences(token!)).preferences;
  } catch (err) {
    if (err instanceof ApiCallError && (err.status === 401 || err.status === 403)) {
      await clearSessionCookie();
      redirect("/login?error=invalid&next=/account/preferences");
    }
    redirect("/account?error=prefs_load");
  }

  return (
    <>
      <Nav authed />

      {/* Mini launch-deck hero — same brand canvas as /account, shorter. */}
      <section className="relative overflow-hidden bg-[linear-gradient(160deg,#103b50_0%,#0c2f44_55%,#0a1c2b_100%)] text-white">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-10 [background-image:radial-gradient(rgba(255,255,255,0.35)_1px,transparent_1.4px)] [background-size:34px_34px]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(110%_120%_at_90%_-20%,rgba(112,209,198,0.18),transparent_45%)]"
        />
        <div className="relative mx-auto max-w-3xl px-4 pb-14 pt-9 sm:px-6">
          <nav aria-label="Ruta de navegación" className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#70d1c6]">
            <Link href="/account" className="hover:text-white">
              Mi cuenta
            </Link>
            <span aria-hidden className="mx-1.5 text-white/30">/</span>
            Preferencias
          </nav>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h1 className="text-3xl font-extrabold tracking-tight">
                Preferencias y respuestas automáticas
              </h1>
              <p className="mt-2 max-w-lg text-sm leading-relaxed text-[#bcd3da]">
                Configúralas <strong className="text-white">una sola vez</strong> — la
                extensión las sincroniza sola y responde por ti en cada postulación.
              </p>
            </div>
            <Link
              href="/account"
              className="inline-flex shrink-0 items-center rounded-xl border border-white/20 bg-white/[0.08] px-4 py-2 text-sm font-bold text-white transition hover:bg-white/[0.14]"
            >
              ← Mi cuenta
            </Link>
          </div>
        </div>
      </section>

      <div className="bg-[#f4f7f8]">
        <main id="main" className="relative mx-auto max-w-3xl px-4 pb-16 sm:px-6">
          <div className="relative z-10 -mt-7">
            <PreferencesForm initial={prefs!} />
          </div>

          <p className="mt-8 text-xs text-[color:var(--color-ink-muted)]">
            Tu CV ya cuenta automáticamente: ciudad detectada en datos personales,
            experiencia, skills, idiomas. Estas preferencias son extras opcionales.
          </p>
        </main>
      </div>
      <Footer />
    </>
  );
}
