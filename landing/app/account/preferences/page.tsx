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
      <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        <nav
          aria-label="Ruta de navegación"
          className="text-xs text-[color:var(--color-ink-muted)]"
        >
          <Link href="/account" className="hover:text-[color:var(--color-ink)]">
            Mi cuenta
          </Link>{" "}
          / Preferencias
        </nav>

        <header className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-[color:var(--color-ink)]">
              Preferencias de búsqueda
            </h1>
            <p className="mt-2 text-sm text-[color:var(--color-ink-soft)]">
              Estos valores afinan el ranking de vacantes en la extensión.
              Pueden estar vacíos — entonces sólo cuenta tu CV.
            </p>
          </div>
          <Link
            href="/account"
            className="text-sm font-medium text-[color:var(--color-brand-600)] hover:underline"
          >
            ← Volver a Mi cuenta
          </Link>
        </header>

        <div className="mt-8">
          <PreferencesForm initial={prefs!} />
        </div>

        <p className="mt-8 text-xs text-[color:var(--color-ink-muted)]">
          Tu CV ya cuenta automáticamente: ciudad detectada en datos personales,
          experiencia, skills, idiomas. Estas preferencias son extras opcionales.
        </p>
      </main>
      <Footer />
    </>
  );
}
