import Link from "next/link";
import { BrandLogo } from "./brand-logo";

export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="mt-24 border-t border-[color:var(--color-border)] bg-[color:var(--color-surface-soft)]">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-4">
        <div className="md:col-span-2">
          <Link href="/" className="inline-flex items-center" aria-label="SkyBrandMX">
            <BrandLogo />
          </Link>
          <p className="mt-3 max-w-sm text-sm text-[color:var(--color-ink-muted)]">
            Copiloto con IA para buscar empleo en México. Hecho en CDMX por
            SkyBrandMX.
          </p>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-[color:var(--color-ink)]">
            Producto
          </h3>
          <ul className="mt-3 space-y-2 text-sm text-[color:var(--color-ink-muted)]">
            <li>
              <a href="/#como-funciona" className="hover:text-[color:var(--color-ink)]">
                Cómo funciona
              </a>
            </li>
            <li>
              <a href="/#precios" className="hover:text-[color:var(--color-ink)]">
                Precios
              </a>
            </li>
            <li>
              <a href="/#faq" className="hover:text-[color:var(--color-ink)]">
                Preguntas frecuentes
              </a>
            </li>
          </ul>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-[color:var(--color-ink)]">
            Legal y contacto
          </h3>
          <ul className="mt-3 space-y-2 text-sm text-[color:var(--color-ink-muted)]">
            <li>
              <Link href="/privacy" className="hover:text-[color:var(--color-ink)]">
                Aviso de privacidad
              </Link>
            </li>
            <li>
              <Link href="/terms" className="hover:text-[color:var(--color-ink)]">
                Términos y condiciones
              </Link>
            </li>
            <li>
              <a
                href="mailto:hola@skybrandmx.com"
                className="hover:text-[color:var(--color-ink)]"
              >
                hola@skybrandmx.com
              </a>
            </li>
            <li>
              <a
                href="mailto:privacidad@skybrandmx.com"
                className="hover:text-[color:var(--color-ink)]"
              >
                privacidad@skybrandmx.com
              </a>
            </li>
          </ul>
        </div>
      </div>

      <div className="border-t border-[color:var(--color-border)]">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 py-6 text-xs text-[color:var(--color-ink-muted)] sm:flex-row sm:px-6">
          <p>&copy; {year} SkyBrandMX. Todos los derechos reservados.</p>
          <p>Hecho con cariño en CDMX.</p>
        </div>
      </div>
    </footer>
  );
}
