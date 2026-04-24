import Link from "next/link";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";

export default function NotFound() {
  return (
    <>
      <Nav />
      <main className="mx-auto flex min-h-[60vh] max-w-xl items-center px-4 py-16 sm:px-6">
        <div className="text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-[color:var(--color-brand-600)]">
            Error 404
          </p>
          <h1 className="mt-2 text-4xl font-bold tracking-tight text-[color:var(--color-ink)]">
            Página no encontrada
          </h1>
          <p className="mt-3 text-sm text-[color:var(--color-ink-soft)]">
            La página que buscas no existe o la movimos de lugar.
          </p>
          <div className="mt-6 flex justify-center gap-3">
            <Link
              href="/"
              className="inline-flex items-center justify-center rounded-[12px] bg-[color:var(--color-brand-600)] px-5 py-2.5 text-sm font-semibold text-white shadow-[var(--shadow-brand)] hover:bg-[color:var(--color-brand-700)]"
            >
              Volver al inicio
            </Link>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
