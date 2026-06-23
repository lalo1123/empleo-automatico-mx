// Mi CV page — the CV lives in the account (source of truth). Create it with AI
// (chat) or paste your CV text; it persists server-side and syncs to the
// extension automatically.

import Link from "next/link";
import { redirect } from "next/navigation";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";
import { getAccount, getProfile, ApiCallError } from "@/lib/api";
import { clearSessionCookie, getSessionToken } from "@/lib/auth";
import { pageMetadata } from "@/lib/seo";
import type { Metadata } from "next";
import { CvForm } from "@/components/cv-form";

export const metadata: Metadata = pageMetadata({
  title: "Mi CV",
  description: "Crea o actualiza tu CV con IA. Se guarda en tu cuenta y la extensión lo usa para postular por ti.",
  path: "/account/cv",
  noIndex: true,
});

export default async function CvPage() {
  const token = await getSessionToken();
  if (!token) redirect("/login?next=/account/cv");

  let profile = null;
  try {
    await getAccount(token!);
    profile = (await getProfile(token!)).profile;
  } catch (err) {
    if (err instanceof ApiCallError && (err.status === 401 || err.status === 403)) {
      await clearSessionCookie();
      redirect("/login?error=invalid&next=/account/cv");
    }
    redirect("/account?error=cv_load");
  }

  return (
    <>
      <Nav authed />

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
            Mi CV
          </nav>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h1 className="text-3xl font-extrabold tracking-tight">Tu CV, en tu cuenta</h1>
              <p className="mt-2 max-w-lg text-sm leading-relaxed text-[#bcd3da]">
                Sube tu PDF, pégalo o créalo con IA — se guarda aquí y la{" "}
                <strong className="text-white">extensión lo usa</strong> para postular por ti.
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
            <CvForm initial={profile} />
          </div>
        </main>
      </div>
      <Footer />
    </>
  );
}
