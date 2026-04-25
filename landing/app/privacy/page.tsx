import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";
import { pageMetadata } from "@/lib/seo";
import type { Metadata } from "next";

export const metadata: Metadata = pageMetadata({
  title: "Aviso de privacidad",
  description:
    "Aviso de privacidad integral de Empleo Automático MX (SkyBrandMX). Cumple con la LFPDPPP, su Reglamento y los lineamientos vigentes del INAI en México.",
  path: "/privacy",
});

// DIRECTOR: Este aviso se construyó con base en LFPDPPP (2025) + lineamientos del INAI.
// Antes de lanzamiento público debes completar:
//   - RFC de SkyBrandMX
//   - Domicilio fiscal completo
//   - Nombre y titular del aviso
// Los placeholders están marcados con `[...]`.
export default function PrivacyPage() {
  return (
    <>
      <Nav />
      <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        <nav aria-label="Ruta" className="text-xs text-[color:var(--color-ink-muted)]">
          Legal / Aviso de privacidad
        </nav>
        <header className="mt-2">
          <h1 className="text-3xl font-bold tracking-tight text-[color:var(--color-ink)] sm:text-4xl">
            Aviso de privacidad integral
          </h1>
          <p className="mt-2 text-sm text-[color:var(--color-ink-muted)]">
            Última actualización: 23 de abril de 2026.
          </p>
        </header>

        <article className="prose prose-slate mt-10 max-w-none space-y-8 text-sm leading-relaxed text-[color:var(--color-ink-soft)]">
          <section>
            <h2 className="text-xl font-semibold text-[color:var(--color-ink)]">
              1. Identidad y domicilio del responsable
            </h2>
            <p className="mt-3">
              <strong>SkyBrandMX</strong> (en adelante, &ldquo;SkyBrandMX&rdquo; o
              &ldquo;nosotros&rdquo;), con RFC{" "}
              <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-900">
                [RFC pendiente]
              </span>{" "}
              y domicilio en{" "}
              <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-900">
                [Dirección pendiente]
              </span>
              , es el responsable del tratamiento de tus datos personales en el
              servicio <strong>Empleo Automático MX</strong>, conforme a la{" "}
              <em>Ley Federal de Protección de Datos Personales en Posesión de
              los Particulares</em> (LFPDPPP), su Reglamento, los Lineamientos
              del Aviso de Privacidad del INAI y demás normativa mexicana
              aplicable.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[color:var(--color-ink)]">
              2. Datos personales que recabamos
            </h2>
            <p className="mt-3">
              Para operar el servicio recabamos, de manera directa (cuando tú
              los proporcionas) o personal (cuando usas la extensión), los
              siguientes datos:
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-6">
              <li>
                <strong>Datos de identificación y contacto</strong>: nombre,
                correo electrónico.
              </li>
              <li>
                <strong>Datos de autenticación</strong>: contraseña (guardada
                como hash con bcrypt; nadie puede leerla, ni nosotros).
              </li>
              <li>
                <strong>Si inicias sesión con Google</strong>: tu identificador
                único de Google (sub), correo electrónico, nombre y foto de
                perfil. Nunca vemos ni almacenamos tu contraseña de Google;
                Google sólo nos comparte los datos del perfil que tú apruebas
                durante el inicio de sesión.
              </li>
              <li>
                <strong>Datos profesionales</strong>: contenido del currículum
                vitae (CV) que subes, incluyendo experiencia, educación,
                habilidades.
              </li>
              <li>
                <strong>Datos de uso</strong>: títulos de vacantes consultadas,
                cartas de presentación generadas, número de postulaciones del
                mes.
              </li>
              <li>
                <strong>Datos de pago</strong>: los procesa directamente
                Conekta (procesador de pagos mexicano). SkyBrandMX nunca
                recibe ni almacena números de tarjeta, CVV ni datos
                bancarios.
              </li>
              <li>
                <strong>Datos técnicos</strong>: dirección IP, user-agent del
                navegador, identificador de sesión, timestamps. Estos datos se
                usan para seguridad y para detectar abusos.
              </li>
            </ul>
            <p className="mt-3">
              <strong>No recabamos datos personales sensibles</strong> (origen
              racial, salud, creencias religiosas, orientación sexual,
              preferencia política, etc.). Te pedimos no incluir información
              sensible en tu CV o en cartas generadas.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[color:var(--color-ink)]">
              3. Finalidades del tratamiento
            </h2>
            <h3 className="mt-3 text-base font-semibold text-[color:var(--color-ink)]">
              Finalidades primarias (necesarias para el servicio)
            </h3>
            <ul className="mt-2 list-disc space-y-1 pl-6">
              <li>
                Crear y mantener tu cuenta; autenticarte al iniciar sesión.
              </li>
              <li>
                Generar cartas de presentación personalizadas con IA, a partir
                de tu CV y la vacante que consultas.
              </li>
              <li>
                Cobrar la suscripción y gestionar altas, renovaciones,
                cancelaciones y reembolsos.
              </li>
              <li>
                Mostrarte tu uso, plan y facturación.
              </li>
              <li>
                Prevenir fraudes, abusos y uso no autorizado.
              </li>
              <li>Cumplir obligaciones legales, fiscales y contables.</li>
            </ul>
            <h3 className="mt-5 text-base font-semibold text-[color:var(--color-ink)]">
              Finalidades secundarias (requieren tu consentimiento)
            </h3>
            <ul className="mt-2 list-disc space-y-1 pl-6">
              <li>
                Generar métricas y análisis agregados y anonimizados para
                mejorar el producto.
              </li>
              <li>
                Enviarte comunicaciones de producto, nuevas funciones y
                novedades del servicio.
              </li>
            </ul>
            <p className="mt-3">
              Puedes oponerte o revocar tu consentimiento a las finalidades
              secundarias en cualquier momento escribiendo a{" "}
              <a
                className="font-semibold text-[color:var(--color-brand-700)] hover:text-[color:var(--color-brand-800)]"
                href="mailto:privacidad@skybrandmx.com"
              >
                privacidad@skybrandmx.com
              </a>
              . Negarte a las secundarias no afecta el servicio.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[color:var(--color-ink)]">
              4. Transferencias de datos a terceros
            </h2>
            <p className="mt-3">
              Para operar el servicio compartimos ciertos datos con los
              siguientes encargados y terceros, siempre bajo contrato y con
              medidas de seguridad equivalentes:
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-6">
              <li>
                <strong>Google (Gemini API)</strong>: el texto de tu CV y el
                texto de la vacante se envían al modelo para generar la carta.
                Google procesa estos datos conforme a sus políticas de privacidad
                y no los utiliza para entrenamiento de modelos cuando usamos sus
                APIs empresariales.
              </li>
              <li>
                <strong>Conekta</strong> (procesador de pagos mexicano):
                procesa pagos y suscripciones. Recibe datos de pago
                directamente de ti; SkyBrandMX solo recibe el estado del
                cobro.
              </li>
              <li>
                <strong>Google LLC</strong> (autenticación con Google
                Sign-In): sólo recibimos los datos del perfil de Google que
                tú apruebas (identificador, correo, nombre, foto). No
                compartimos información tuya con Google: el flujo es de
                Google hacia nosotros, no al revés.
              </li>
              <li>
                <strong>Hostinger</strong>: provee el servidor (VPS) donde
                se ejecutan la infraestructura y la base de datos de
                empleo.skybrandmx.com, con cifrado en tránsito y en reposo.
              </li>
              <li>
                <strong>Google Fonts</strong>: sirve la tipografía Inter al
                navegador del visitante. Ver sus políticas de privacidad.
              </li>
              <li>
                <strong>Autoridades competentes</strong>: cuando una autoridad
                mexicana lo requiera mediante orden fundada y motivada.
              </li>
            </ul>
            <p className="mt-3">
              Estas transferencias son necesarias para el servicio y no
              requieren tu consentimiento adicional (artículo 37 LFPDPPP). Al
              usar el servicio, reconoces que estas transferencias ocurren.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[color:var(--color-ink)]">
              5. Derechos ARCO y revocación del consentimiento
            </h2>
            <p className="mt-3">
              Tienes derecho a <strong>Acceder</strong> a tus datos,{" "}
              <strong>Rectificarlos</strong> si son inexactos,{" "}
              <strong>Cancelarlos</strong> cuando consideres que no se están
              tratando conforme a la ley y a <strong>Oponerte</strong> a usos
              específicos. También puedes revocar el consentimiento otorgado
              para finalidades secundarias.
            </p>
            <p className="mt-3">
              Para ejercer cualquiera de estos derechos, envía una solicitud al
              correo{" "}
              <a
                className="font-semibold text-[color:var(--color-brand-700)] hover:text-[color:var(--color-brand-800)]"
                href="mailto:privacidad@skybrandmx.com"
              >
                privacidad@skybrandmx.com
              </a>{" "}
              con:
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-6">
              <li>Tu nombre y correo con el que te registraste.</li>
              <li>Descripción clara y precisa del derecho que ejerces.</li>
              <li>
                Documento que acredite tu identidad (INE, pasaporte) o la
                representación legal, si aplica.
              </li>
              <li>
                Cualquier otro elemento que facilite atender tu solicitud.
              </li>
            </ul>
            <p className="mt-3">
              Responderemos en un plazo máximo de 20 días hábiles (art. 32
              LFPDPPP). La resolución será efectiva dentro de los 15 días
              siguientes. Si consideras que tu derecho no se atendió, puedes
              acudir ante el INAI.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[color:var(--color-ink)]">
              6. Medidas de seguridad
            </h2>
            <p className="mt-3">
              Aplicamos medidas administrativas, técnicas y físicas razonables:
              cifrado en tránsito (HTTPS/TLS), hashing de contraseñas con
              bcrypt, control de acceso por rol, registros de auditoría, y
              políticas de retención. Ningún sistema es infalible; en caso de
              vulneración material, te notificaremos conforme al art. 20 LFPDPPP.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[color:var(--color-ink)]">
              7. Conservación y eliminación
            </h2>
            <p className="mt-3">
              Conservamos tus datos mientras tu cuenta esté activa. Al cancelar
              la cuenta, eliminamos tu CV y cartas generadas en un plazo máximo
              de 30 días. Mantenemos los registros contables y fiscales por el
              plazo que exige la legislación mexicana (hasta 5 años).
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[color:var(--color-ink)]">
              8. Uso de cookies y tecnologías similares
            </h2>
            <p className="mt-3">
              Usamos cookies esenciales para mantener tu sesión iniciada
              (cookie <code>skybrand_session</code>, httpOnly, SameSite=Lax).
              Sin esta cookie no podrías usar el servicio. No usamos cookies de
              publicidad de terceros. Si en el futuro habilitamos analíticas
              (por ejemplo, PostHog), te pediremos consentimiento explícito
              antes de activarlas.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[color:var(--color-ink)]">
              9. Cambios al aviso de privacidad
            </h2>
            <p className="mt-3">
              Podemos actualizar este aviso. Publicaremos la nueva versión en
              esta misma dirección y, si el cambio es sustancial, te notificaremos
              por correo con al menos 15 días de anticipación. La fecha arriba
              indica la última actualización.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[color:var(--color-ink)]">
              10. Contacto
            </h2>
            <p className="mt-3">
              Dudas, aclaraciones o solicitudes ARCO:{" "}
              <a
                className="font-semibold text-[color:var(--color-brand-700)] hover:text-[color:var(--color-brand-800)]"
                href="mailto:privacidad@skybrandmx.com"
              >
                privacidad@skybrandmx.com
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
