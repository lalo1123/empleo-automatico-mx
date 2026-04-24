import Image from "next/image";
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
          className="flex items-center"
          aria-label="Inicio de Empleo Automático MX"
        >
          <Image
            src="/logo.svg"
            alt="SkyBrandMX"
            width={160}
            height={32}
            priority
            className="h-8 w-auto"
          />
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
