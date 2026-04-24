import Link from "next/link";

interface NavProps {
  authed?: boolean;
}

export function Nav({ authed = false }: NavProps) {
  return (
    <header className="sticky top-0 z-40 w-full border-b border-[color:var(--color-border)] bg-white/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link
          href="/"
          className="flex items-center gap-2 text-lg font-semibold tracking-tight"
          aria-label="Inicio de Empleo Automático MX"
        >
          <span
            aria-hidden
            className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-gradient-to-br from-[#7c3aed] to-[#0ea5e9] text-white shadow-[var(--shadow-soft)]"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 12l4 4L19 6" />
            </svg>
          </span>
          <span>
            SkyBrand<span className="text-[#0ea5e9]">MX</span>
          </span>
        </Link>

        <nav className="hidden items-center gap-7 text-sm text-[color:var(--color-ink-soft)] md:flex">
          <a href="/#como-funciona" className="hover:text-[color:var(--color-ink)]">
            Cómo funciona
          </a>
          <a href="/#precios" className="hover:text-[color:var(--color-ink)]">
            Precios
          </a>
          <a href="/#faq" className="hover:text-[color:var(--color-ink)]">
            FAQ
          </a>
        </nav>

        <div className="flex items-center gap-2">
          {authed ? (
            <Link
              href="/account"
              className="rounded-[10px] bg-[color:var(--color-brand-600)] px-4 py-2 text-sm font-semibold text-white shadow-[var(--shadow-soft)] transition hover:bg-[color:var(--color-brand-700)]"
            >
              Mi cuenta
            </Link>
          ) : (
            <>
              <Link
                href="/login"
                className="hidden rounded-[10px] px-3 py-2 text-sm font-medium text-[color:var(--color-ink-soft)] hover:text-[color:var(--color-ink)] sm:inline-flex"
              >
                Entrar
              </Link>
              <Link
                href="/signup"
                className="rounded-[10px] bg-[color:var(--color-brand-600)] px-4 py-2 text-sm font-semibold text-white shadow-[var(--shadow-soft)] transition hover:bg-[color:var(--color-brand-700)]"
              >
                Empieza gratis
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
