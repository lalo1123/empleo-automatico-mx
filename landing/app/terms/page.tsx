import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";
import { pageMetadata } from "@/lib/seo";
import type { Metadata } from "next";

export const metadata: Metadata = pageMetadata({
  title: "Términos y condiciones",
  description:
    "Términos y condiciones de uso del servicio Empleo Automático MX (SkyBrandMX). Planes, facturación, cancelación, reembolsos y uso aceptable en México.",
  path: "/terms",
});

// DIRECTOR: Antes de lanzamiento, confirmar con un abogado mexicano:
// - Límites de responsabilidad (sección 8)
// - Política de reembolso y su compatibilidad con Profeco
// - Cláusula de arbitraje / jurisdicción (actualmente CDMX)
export default function TermsPage() {
  return (
    <>
      <Nav />
      <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        <nav aria-label="Ruta" className="text-xs text-[color:var(--color-ink-muted)]">
          Legal / Términos y condiciones
        </nav>
        <header className="mt-2">
          <h1 className="text-3xl font-bold tracking-tight text-[color:var(--color-ink)] sm:text-4xl">
            Términos y condiciones
          </h1>
          <p className="mt-2 text-sm text-[color:var(--color-ink-muted)]">
            Última actualización: 23 de abril de 2026.
          </p>
        </header>

        <article className="prose prose-slate mt-10 max-w-none space-y-8 text-sm leading-relaxed text-[color:var(--color-ink-soft)]">
          <section>
            <h2 className="text-xl font-semibold text-[color:var(--color-ink)]">
              1. Sobre SkyBrandMX
            </h2>
            <p className="mt-3">
              Empleo Automático MX (&ldquo;el Servicio&rdquo;) es un producto de{" "}
              <strong>SkyBrandMX</strong> (&ldquo;SkyBrandMX&rdquo;,
              &ldquo;nosotros&rdquo;). Al crear una cuenta o usar el Servicio
              aceptas estos Términos y Condiciones (&ldquo;Términos&rdquo;) y
              el{" "}
              <a
                href="/privacy"
                className="font-semibold text-[color:var(--color-brand-700)] hover:text-[color:var(--color-brand-800)]"
              >
                Aviso de Privacidad
              </a>
              . Si no estás de acuerdo, no uses el Servicio.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[color:var(--color-ink)]">
              2. Qué ofrecemos
            </h2>
            <p className="mt-3">
              El Servicio es una <strong>herramienta</strong> que, mediante una
              extensión de navegador y un copiloto con inteligencia artificial,
              te ayuda a redactar cartas de presentación personalizadas y a
              completar formularios de postulación en portales de empleo como
              OCC Mundial.
            </p>
            <p className="mt-3">
              El Servicio <strong>no es un reclutador</strong>, no garantiza
              que obtengas entrevistas ni un empleo, y no sustituye tu
              revisión. Tú siempre eres responsable del contenido final que
              envías y de dar el último clic para postular.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[color:var(--color-ink)]">
              3. Cuenta de usuario
            </h2>
            <p className="mt-3">
              Para usar el Servicio debes crear una cuenta con un correo
              electrónico válido y una contraseña. Eres responsable de:
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-6">
              <li>Mantener la confidencialidad de tu contraseña.</li>
              <li>
                Toda actividad realizada bajo tu cuenta, incluyendo las
                postulaciones que envíes.
              </li>
              <li>
                Notificarnos inmediatamente a{" "}
                <a
                  href="mailto:hola@skybrandmx.com"
                  className="font-semibold text-[color:var(--color-brand-700)] hover:text-[color:var(--color-brand-800)]"
                >
                  hola@skybrandmx.com
                </a>{" "}
                si sospechas acceso no autorizado.
              </li>
              <li>
                Mantener tus datos de contacto y CV actualizados y veraces.
              </li>
            </ul>
            <p className="mt-3">
              Debes tener al menos 18 años o la edad de mayoría en tu
              jurisdicción. Puedes cancelar tu cuenta en cualquier momento.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[color:var(--color-ink)]">
              4. Uso aceptable
            </h2>
            <p className="mt-3">
              Al usar el Servicio te comprometes a NO:
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-6">
              <li>
                Enviar postulaciones masivas a vacantes que no correspondan a
                tu perfil (spam a reclutadores).
              </li>
              <li>
                Usar el Servicio para hacer scraping o minería de datos contra
                portales de empleo.
              </li>
              <li>
                Intentar eludir límites de plan (por ejemplo, creando múltiples
                cuentas gratuitas).
              </li>
              <li>
                Suplantar la identidad de otra persona, incluir información
                falsa en tu CV, o generar cartas con declaraciones engañosas.
              </li>
              <li>
                Ingresar ingeniería inversa, descompilar o intentar acceder al
                código fuente del backend.
              </li>
              <li>
                Usar el Servicio para fines ilegales o contrarios a los
                términos de los portales de empleo.
              </li>
            </ul>
            <p className="mt-3">
              Nos reservamos el derecho de suspender o cancelar cuentas que
              incumplan estas reglas, sin reembolso.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[color:var(--color-ink)]">
              5. Planes, precios y facturación
            </h2>
            <p className="mt-3">
              El Servicio ofrece un plan <strong>Gratis</strong> (3 postulaciones
              al mes) y planes de pago <strong>Pro</strong> ($199 MXN/mes) y{" "}
              <strong>Premium</strong> ($399 MXN/mes). Hay también opciones
              anuales con descuento. Los precios están expresados en pesos
              mexicanos (MXN) e incluyen el IVA aplicable.
            </p>
            <p className="mt-3">
              La suscripción <strong>se renueva automáticamente</strong> al
              final de cada período, salvo que la canceles. Los cobros se
              procesan a través de <strong>Conekta</strong> (procesador de
              pagos mexicano), que acepta tarjeta de crédito/débito, OXXO y
              SPEI.
            </p>
            <p className="mt-3">
              Nos reservamos el derecho de modificar los precios con aviso
              previo de al menos 30 días antes de la renovación. Si no aceptas
              el nuevo precio, puedes cancelar antes de la renovación.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[color:var(--color-ink)]">
              6. Cancelación y reembolsos
            </h2>
            <p className="mt-3">
              Puedes cancelar tu suscripción en cualquier momento desde tu
              cuenta en{" "}
              <a
                href="/account"
                className="font-semibold text-[color:var(--color-brand-700)] hover:text-[color:var(--color-brand-800)]"
              >
                /account
              </a>
              . La cancelación <strong>aplica al final del período ya
              pagado</strong>; sigues teniendo acceso hasta esa fecha.
            </p>
            <p className="mt-3">
              <strong>Política de reembolso de 7 días</strong>: si cancelas
              dentro de los primeros 7 días desde tu primer cobro y no has
              generado ninguna carta durante ese período, puedes solicitar
              reembolso completo escribiendo a{" "}
              <a
                href="mailto:hola@skybrandmx.com"
                className="font-semibold text-[color:var(--color-brand-700)] hover:text-[color:var(--color-brand-800)]"
              >
                hola@skybrandmx.com
              </a>
              . Una vez que has generado al menos una carta, el cobro se
              considera consumido.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[color:var(--color-ink)]">
              7. Propiedad intelectual
            </h2>
            <p className="mt-3">
              <strong>Tu contenido</strong>: tu CV y las cartas generadas son
              tuyos. Nos otorgas una licencia limitada y revocable para
              procesarlos con el único fin de operar el Servicio.
            </p>
            <p className="mt-3">
              <strong>Nuestro contenido</strong>: el Servicio, la marca
              SkyBrandMX, la extensión, los diseños, logotipos y demás son
              propiedad de SkyBrandMX o se usan con licencia. No se te
              conceden derechos sobre ellos salvo el uso personal del Servicio.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[color:var(--color-ink)]">
              8. Limitación de responsabilidad
            </h2>
            <p className="mt-3">
              El Servicio se ofrece &ldquo;tal cual&rdquo; y
              &ldquo;según disponibilidad&rdquo;. En la máxima medida permitida
              por la ley, SkyBrandMX no se responsabiliza por:
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-6">
              <li>
                Que una postulación sea aceptada, contestada o resulte en
                entrevista u oferta.
              </li>
              <li>
                Errores, omisiones o contenido generado por la inteligencia
                artificial. Tú debes revisar cada carta antes de enviarla.
              </li>
              <li>
                Cambios en portales de empleo que impidan temporalmente que la
                extensión funcione.
              </li>
              <li>
                Daños indirectos, incidentales o consecuenciales (lucro cesante,
                oportunidades perdidas).
              </li>
            </ul>
            <p className="mt-3">
              Nuestra responsabilidad agregada por cualquier reclamo no
              excederá el monto que hayas pagado a SkyBrandMX en los 6 meses
              anteriores al hecho que dé origen al reclamo.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[color:var(--color-ink)]">
              9. Modificaciones a estos Términos
            </h2>
            <p className="mt-3">
              Podemos actualizar estos Términos. Te avisaremos por correo con
              al menos 15 días de anticipación si el cambio afecta tus
              derechos. Si sigues usando el Servicio después de la fecha de
              entrada en vigor, aceptas los nuevos Términos. Si no estás de
              acuerdo, puedes cancelar tu cuenta.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[color:var(--color-ink)]">
              10. Legislación aplicable y jurisdicción
            </h2>
            <p className="mt-3">
              Estos Términos se rigen por las leyes de los Estados Unidos
              Mexicanos. Para cualquier controversia, las partes se someten
              expresamente a la jurisdicción de los tribunales competentes
              en <strong>Ciudad de México</strong>, renunciando a cualquier
              otro fuero que pudiera corresponderles. Como consumidor, conservas
              los derechos que te otorga la Ley Federal de Protección al
              Consumidor (Profeco).
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[color:var(--color-ink)]">
              11. Contacto
            </h2>
            <p className="mt-3">
              ¿Dudas? Escríbenos a{" "}
              <a
                href="mailto:hola@skybrandmx.com"
                className="font-semibold text-[color:var(--color-brand-700)] hover:text-[color:var(--color-brand-800)]"
              >
                hola@skybrandmx.com
              </a>
              .
            </p>
          </section>
        </article>
      </main>
      <Footer />
    </>
  );
}
