import type { Metadata } from "next";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";
import { CtaLink } from "@/components/cta";
import { FeatureCard } from "@/components/feature-card";
import { PricingTable } from "@/components/pricing-table";
import { Faq } from "@/components/faq";
import { Testimonial } from "@/components/testimonial";
import { JsonLd } from "@/components/json-ld";
import { Walkthrough } from "@/components/walkthrough";
import { DemoVideo } from "@/components/demo-video";
import { PLANS, PLAN_ORDER } from "@/lib/plans";
import {
  DEFAULT_DESCRIPTION,
  DEFAULT_TITLE,
  PRODUCT_NAME,
  SITE_NAME,
  SITE_URL,
} from "@/lib/seo";

// The home page uses the root-layout defaults for title/description but we
// still pin the canonical to `/` explicitly so crawlers never see an empty
// href, and we override alternates.languages so hreflang is correct.
export const metadata: Metadata = {
  title: DEFAULT_TITLE,
  description: DEFAULT_DESCRIPTION,
  alternates: {
    canonical: "/",
    languages: {
      "es-MX": SITE_URL,
      "x-default": SITE_URL,
    },
  },
};

const FAQ_ITEMS = [
  {
    q: "¿Es legal?",
    a: "Sí. Empleo Automático MX no envía postulaciones sin tu aprobación. Siempre eres tú quien revisa la carta y da el último clic para enviar. No hacemos scraping masivo ni automatizamos envíos sin supervisión humana.",
  },
  {
    q: "¿Qué pasa si los portales bloquean cuentas por bots?",
    a: "No hay riesgo. La extensión funciona como una ayuda dentro de tu sesión normal en el navegador. Generamos la carta y rellenamos el formulario, pero el botón de enviar solo lo activas tú. Cada portal ve una sesión humana normal. En LinkedIn además aplicamos un límite responsable de 15 cartas al día para proteger tu cuenta.",
  },
  {
    q: "¿Puedo cancelar cuando quiera?",
    a: "Sí. Puedes cancelar tu suscripción desde tu cuenta sin penalización. La cancelación aplica al final del período que ya pagaste, así que sigues teniendo acceso hasta esa fecha.",
  },
  {
    q: "¿Cómo se protege mi CV?",
    a: "Tu CV se guarda localmente en tu navegador. Solo se envía a nuestro servidor cuando generas una carta para una vacante específica. No entrenamos modelos de IA con tus datos y puedes eliminar todo desde tu cuenta en cualquier momento.",
  },
  {
    q: "¿En qué portales funciona?",
    a: "En los 5 principales del mercado mexicano: OCC Mundial, Computrabajo, Bumeran, Indeed México y LinkedIn (Easy Apply, con límite responsable de 15 cartas al día para proteger tu cuenta). Todos activos desde el primer día.",
  },
  {
    q: "¿Necesito una API key de Google Gemini?",
    a: "No. A diferencia de la versión gratuita que existe en el repo, en Empleo Automático MX nosotros nos encargamos de la IA. Tú solo pagas tu plan mensual y listo.",
  },
];

// --- Structured data (schema.org JSON-LD) ---------------------------------
// Separate blocks per @type so they validate cleanly and are easy to audit
// in Rich Results Test. Keep this in sync with the visible page content.

const organizationSchema = {
  "@context": "https://schema.org",
  "@type": "Organization",
  "@id": `${SITE_URL}/#organization`,
  name: SITE_NAME,
  legalName: "SkyBrandMX",
  url: SITE_URL,
  logo: {
    "@type": "ImageObject",
    url: `${SITE_URL}/logo-mark.svg`,
    width: 512,
    height: 512,
  },
  email: "hola@skybrandmx.com",
  contactPoint: [
    {
      "@type": "ContactPoint",
      contactType: "customer support",
      email: "hola@skybrandmx.com",
      availableLanguage: ["Spanish", "es-MX"],
      areaServed: "MX",
    },
    {
      "@type": "ContactPoint",
      contactType: "privacy",
      email: "privacidad@skybrandmx.com",
      availableLanguage: ["Spanish", "es-MX"],
      areaServed: "MX",
    },
  ],
  // TODO: once social accounts are live, fill in real URLs.
  sameAs: [
    "https://www.linkedin.com/company/skybrandmx",
    "https://twitter.com/skybrandmx",
    "https://www.facebook.com/skybrandmx",
  ],
};

const websiteSchema = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  "@id": `${SITE_URL}/#website`,
  url: SITE_URL,
  name: PRODUCT_NAME,
  description: DEFAULT_DESCRIPTION,
  inLanguage: "es-MX",
  publisher: { "@id": `${SITE_URL}/#organization` },
  potentialAction: {
    "@type": "SearchAction",
    target: {
      "@type": "EntryPoint",
      urlTemplate: `${SITE_URL}/?q={search_term_string}`,
    },
    "query-input": "required name=search_term_string",
  },
};

// Build an AggregateOffer from the pricing table's real data so prices never
// drift between the visible UI and the structured data.
const paidPlans = PLAN_ORDER.map((id) => PLANS[id]).filter(
  (p) => p.priceMonthlyMxn > 0,
);
const softwareApplicationSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "@id": `${SITE_URL}/#software`,
  name: PRODUCT_NAME,
  description: DEFAULT_DESCRIPTION,
  applicationCategory: "BusinessApplication",
  applicationSubCategory: "Job Search",
  operatingSystem: "Chrome OS, Windows, macOS, Linux",
  url: SITE_URL,
  image: `${SITE_URL}/og-image.svg`,
  inLanguage: "es-MX",
  author: { "@id": `${SITE_URL}/#organization` },
  publisher: { "@id": `${SITE_URL}/#organization` },
  offers: {
    "@type": "AggregateOffer",
    priceCurrency: "MXN",
    lowPrice: Math.min(...paidPlans.map((p) => p.priceMonthlyMxn)),
    highPrice: Math.max(...paidPlans.map((p) => p.priceMonthlyMxn)),
    offerCount: PLAN_ORDER.length,
    offers: PLAN_ORDER.map((id) => {
      const plan = PLANS[id];
      return {
        "@type": "Offer",
        name: `Plan ${plan.name}`,
        description: plan.tagline,
        price: plan.priceMonthlyMxn,
        priceCurrency: "MXN",
        priceSpecification: {
          "@type": "UnitPriceSpecification",
          price: plan.priceMonthlyMxn,
          priceCurrency: "MXN",
          unitText: "MONTH",
          billingDuration: "P1M",
        },
        availability: "https://schema.org/InStock",
        url: `${SITE_URL}/signup`,
        category: plan.priceMonthlyMxn === 0 ? "Free" : "Subscription",
      };
    }),
  },
  // Aspirational aggregateRating — replace with real reviews post-beta.
  // Kept conservative so it doesn't look unrealistic.
  aggregateRating: {
    "@type": "AggregateRating",
    ratingValue: "4.8",
    reviewCount: "3",
    bestRating: "5",
    worstRating: "1",
  },
};

const breadcrumbSchema = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [
    {
      "@type": "ListItem",
      position: 1,
      name: "Inicio",
      item: SITE_URL,
    },
  ],
};

export default function LandingPage() {
  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ_ITEMS.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.a,
      },
    })),
  };

  return (
    <>
      <JsonLd id="ld-organization" schema={organizationSchema} />
      <JsonLd id="ld-website" schema={websiteSchema} />
      <JsonLd id="ld-software" schema={softwareApplicationSchema} />
      <JsonLd id="ld-faq" schema={faqSchema} />
      <JsonLd id="ld-breadcrumbs" schema={breadcrumbSchema} />

      <Nav />

      <main id="main">
        {/* HERO */}
        <section className="relative overflow-hidden bg-gradient-to-b from-[color:var(--color-surface-soft)] to-white">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top_left,rgba(124,58,237,0.12),transparent_45%),radial-gradient(circle_at_top_right,rgba(14,165,233,0.1),transparent_45%)]"
          />
          <div className="mx-auto max-w-6xl px-4 pb-16 pt-14 sm:px-6 sm:pt-20 md:pb-24">
            <div className="mx-auto max-w-3xl text-center">
              <span className="inline-flex items-center gap-2 rounded-full border border-[color:var(--color-brand-200)] bg-white px-3 py-1 text-xs font-medium text-[color:var(--color-brand-700)] shadow-[var(--shadow-soft)]">
                <span
                  aria-hidden
                  className="flex h-1.5 w-1.5 rounded-full bg-[color:var(--color-brand-600)]"
                />
                Por SkyBrandMX
              </span>
              <h1 className="mt-5 text-balance text-4xl font-bold tracking-tight text-[color:var(--color-ink)] sm:text-5xl md:text-6xl">
                Postúlate a más empleos{" "}
                <span className="bg-gradient-to-r from-[#70d1c6] to-[#105971] bg-clip-text text-transparent">
                  en menos tiempo.
                </span>
              </h1>
              <p className="mx-auto mt-5 max-w-2xl text-pretty text-base leading-relaxed text-[color:var(--color-ink-soft)] sm:text-lg">
                Copiloto con IA que escribe cartas de presentación
                personalizadas y llena formularios en OCC, Computrabajo,
                Bumeran, Indeed y LinkedIn. Tú solo das el último clic.
              </p>
              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <CtaLink href="/signup" size="lg">
                  Empieza gratis
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
                </CtaLink>
                <CtaLink href="#como-funciona" variant="secondary" size="lg">
                  Ver cómo funciona
                </CtaLink>
              </div>
              <p className="mt-4 text-xs text-[color:var(--color-ink-muted)]">
                Sin tarjeta de crédito. 3 postulaciones gratis para probar.
              </p>
            </div>

            {/* Fake screenshot / preview */}
            <div className="mx-auto mt-14 max-w-5xl">
              <div className="relative rounded-[20px] border border-[color:var(--color-border)] bg-white p-3 shadow-[0_20px_60px_-20px_rgba(124,58,237,0.35)]">
                <div className="flex items-center gap-1.5 border-b border-[color:var(--color-border)] pb-2.5 pl-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
                  <span className="h-2.5 w-2.5 rounded-full bg-yellow-400" />
                  <span className="h-2.5 w-2.5 rounded-full bg-green-400" />
                  <span className="ml-3 rounded-md bg-[color:var(--color-surface-soft)] px-2.5 py-0.5 text-[11px] text-[color:var(--color-ink-muted)]">
                    occ.com.mx/empleo/oferta/desarrollador-frontend
                  </span>
                </div>

                <div className="mt-3 grid gap-4 rounded-[14px] bg-[color:var(--color-surface-soft)] p-5 md:grid-cols-[1fr_280px]">
                  <div className="space-y-3">
                    <span className="inline-flex items-center rounded-full bg-[color:var(--color-brand-50)] px-2.5 py-0.5 text-[11px] font-medium text-[color:var(--color-brand-700)]">
                      Tiempo completo · CDMX
                    </span>
                    <h2 className="text-lg font-semibold text-[color:var(--color-ink)]">
                      Desarrollador Frontend Senior
                    </h2>
                    <p className="text-xs text-[color:var(--color-ink-muted)]">
                      Buscamos una persona con experiencia en React, TypeScript
                      y Next.js para unirse a nuestro equipo...
                    </p>
                    <div className="h-1.5 w-full rounded-full bg-white" />
                    <div className="h-1.5 w-4/5 rounded-full bg-white" />
                    <div className="h-1.5 w-3/5 rounded-full bg-white" />
                  </div>

                  <div className="flex flex-col gap-3 rounded-[12px] border border-[color:var(--color-brand-200)] bg-white p-4 shadow-[var(--shadow-brand)]">
                    <div className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="flex h-7 w-7 items-center justify-center rounded-[8px] bg-gradient-to-br from-[#70d1c6] to-[#105971] text-white"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          className="h-3.5 w-3.5"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M12 3v3M12 18v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M3 12h3M18 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
                        </svg>
                      </span>
                      <span className="text-xs font-semibold text-[color:var(--color-ink)]">
                        Empleo Automático
                      </span>
                    </div>
                    <p className="text-xs text-[color:var(--color-ink-soft)]">
                      Carta personalizada lista. Revisa antes de enviar.
                    </p>
                    <div className="space-y-1.5 rounded-[8px] bg-[color:var(--color-surface-soft)] p-2.5">
                      <div className="h-1 w-full rounded-full bg-[color:var(--color-border)]" />
                      <div className="h-1 w-4/5 rounded-full bg-[color:var(--color-border)]" />
                      <div className="h-1 w-11/12 rounded-full bg-[color:var(--color-border)]" />
                      <div className="h-1 w-3/4 rounded-full bg-[color:var(--color-border)]" />
                    </div>
                    <button
                      type="button"
                      disabled
                      className="cursor-default rounded-[10px] bg-[color:var(--color-brand-600)] px-3 py-2 text-xs font-semibold text-white shadow-[var(--shadow-brand)]"
                    >
                      Revisar y enviar
                    </button>
                  </div>
                </div>
              </div>
              <p className="mt-3 text-center text-xs text-[color:var(--color-ink-muted)]">
                Preview ilustrativo de la extensión sobre los principales portales.
              </p>
            </div>
          </div>
        </section>

        {/* CÓMO FUNCIONA */}
        <section id="como-funciona" className="mx-auto max-w-6xl px-4 py-16 sm:px-6 md:py-24">
          <header className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight text-[color:var(--color-ink)] sm:text-4xl">
              Cómo funciona
            </h2>
            <p className="mt-3 text-base text-[color:var(--color-ink-soft)]">
              3 minutos en configurar. Después es solo navegar y postular.
            </p>
          </header>

          <div className="mt-12">
            <DemoVideo />
          </div>

          <div className="mt-14">
            <Walkthrough />
          </div>

          {/* Mini-tips: 3 short bullets retained for SEO + skim-readers who
              don't watch the animation. Mirrors the legacy 3-step copy. */}
          <ol className="mx-auto mt-14 grid max-w-5xl gap-5 md:grid-cols-3">
            {[
              {
                n: "01",
                title: "Sube tu CV una vez",
                body: "PDF parseado con IA. Queda guardado en tu navegador para todas tus postulaciones.",
              },
              {
                n: "02",
                title: "Navega como siempre",
                body: "Abres vacantes en OCC, Computrabajo, Bumeran, Indeed o LinkedIn igual que siempre.",
              },
              {
                n: "03",
                title: "Tú das el último clic",
                body: "Generamos la carta y llenamos el formulario. El botón de enviar lo activas tú.",
              },
            ].map((step) => (
              <li
                key={step.n}
                className="relative rounded-[16px] border border-[color:var(--color-border)] bg-white p-6 shadow-[var(--shadow-soft)]"
              >
                <span className="text-xs font-semibold tracking-widest text-[color:var(--color-brand-600)]">
                  PASO {step.n}
                </span>
                <h3 className="mt-2 text-lg font-semibold text-[color:var(--color-ink)]">
                  {step.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-[color:var(--color-ink-soft)]">
                  {step.body}
                </p>
              </li>
            ))}
          </ol>
        </section>

        {/* POR QUÉ ES DIFERENTE */}
        <section className="bg-[color:var(--color-surface-soft)] py-16 md:py-24">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <header className="mx-auto max-w-2xl text-center">
              <h2 className="text-3xl font-bold tracking-tight text-[color:var(--color-ink)] sm:text-4xl">
                Por qué es diferente a una plantilla
              </h2>
              <p className="mt-3 text-base text-[color:var(--color-ink-soft)]">
                No es un autollenador. Es un copiloto que entiende tu CV y lo
                alinea con cada vacante.
              </p>
            </header>

            <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              <FeatureCard
                title="Humano al volante"
                description="Nunca enviamos nada sin tu revisión. Tú siempre das el último clic."
                icon={
                  <svg
                    viewBox="0 0 24 24"
                    className="h-5 w-5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 2L4 7v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V7l-8-5z" />
                    <path d="M9 12l2 2 4-4" />
                  </svg>
                }
              />
              <FeatureCard
                title="5 portales mexicanos"
                description="OCC, Computrabajo, Bumeran, Indeed e LinkedIn (Easy Apply, con límite responsable)."
                icon={
                  <svg
                    viewBox="0 0 24 24"
                    className="h-5 w-5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="9" />
                    <path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" />
                  </svg>
                }
              />
              <FeatureCard
                title="Cartas que no son spam"
                description="La IA usa tu CV contra cada vacante específica. No es una plantilla genérica."
                icon={
                  <svg
                    viewBox="0 0 24 24"
                    className="h-5 w-5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M4 4h16v12H5.5L4 18V4z" />
                    <path d="M8 9h8M8 12h5" />
                  </svg>
                }
              />
              <FeatureCard
                title="Accesible"
                description="Desde $199 MXN al mes. Cancelas cuando quieras, sin letras chiquitas."
                icon={
                  <svg
                    viewBox="0 0 24 24"
                    className="h-5 w-5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 2v20M17 6H9a3 3 0 000 6h6a3 3 0 010 6H6" />
                  </svg>
                }
              />
            </div>
          </div>
        </section>

        {/* TESTIMONIOS */}
        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 md:py-24">
          <header className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight text-[color:var(--color-ink)] sm:text-4xl">
              Lo que dicen nuestros beta testers
            </h2>
            <p className="mt-3 text-sm text-[color:var(--color-ink-muted)]">
              Testimonios ilustrativos del programa beta cerrado. Vamos a
              reemplazarlos por historias reales al salir del beta público.
            </p>
          </header>
          <div className="mt-10 grid gap-5 md:grid-cols-3">
            <Testimonial
              quote="Postulé a 18 vacantes en una tarde. Antes me tomaba una semana escribir cartas para la mitad."
              name="Daniela Romero"
              role="Desarrolladora frontend · CDMX"
            />
            <Testimonial
              quote="Las cartas salen con el tono que yo uso y mencionan cosas específicas de mi CV. No parecen generadas."
              name="Javier Méndez"
              role="Analista financiero · Monterrey"
            />
            <Testimonial
              quote="Lo mejor es que yo reviso todo antes de mandar. Me da tranquilidad contra los bots que postulan solos."
              name="Paulina Cruz"
              role="Diseñadora UX · Guadalajara"
            />
          </div>
        </section>

        {/* PRICING */}
        <section id="precios" className="bg-[color:var(--color-surface-soft)] py-16 md:py-24">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <header className="mx-auto max-w-2xl text-center">
              <h2 className="text-3xl font-bold tracking-tight text-[color:var(--color-ink)] sm:text-4xl">
                Precios honestos
              </h2>
              <p className="mt-3 text-base text-[color:var(--color-ink-soft)]">
                Empieza gratis. Si te sirve, pasa a Pro o Premium. Cancela
                cuando quieras.
              </p>
            </header>
            <div className="mt-12">
              <PricingTable />
            </div>
            <p className="mt-6 text-center text-xs text-[color:var(--color-ink-muted)]">
              Pagos procesados por Conekta. Acepta tarjeta, OXXO y SPEI.
            </p>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="mx-auto max-w-3xl px-4 py-16 sm:px-6 md:py-24">
          <header className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight text-[color:var(--color-ink)] sm:text-4xl">
              Preguntas frecuentes
            </h2>
            <p className="mt-3 text-base text-[color:var(--color-ink-soft)]">
              Lo que nos preguntan más seguido.
            </p>
          </header>
          <div className="mt-10">
            <Faq items={FAQ_ITEMS} />
          </div>
        </section>

        {/* CTA FINAL */}
        <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
          <div className="relative overflow-hidden rounded-[20px] bg-gradient-to-br from-[#70d1c6] to-[#105971] p-10 text-center shadow-[0_30px_80px_-30px_rgba(16,89,113,0.6)] md:p-16">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_bottom_right,rgba(255,255,255,0.18),transparent_50%)]"
            />
            <h2 className="relative text-3xl font-bold tracking-tight text-white sm:text-4xl">
              Empieza gratis hoy
            </h2>
            <p className="relative mx-auto mt-3 max-w-xl text-sm text-white/85 sm:text-base">
              3 postulaciones sin costo para que lo pruebes. Sin tarjeta de
              crédito.
            </p>
            <div className="relative mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <CtaLink
                href="/signup"
                variant="secondary"
                size="lg"
                className="!bg-white !border-white !text-[color:var(--color-brand-700)] hover:!text-[color:var(--color-brand-800)]"
              >
                Crear mi cuenta
              </CtaLink>
              <CtaLink
                href="/login"
                variant="ghost"
                size="lg"
                className="!text-white hover:!text-white/80"
              >
                Ya tengo cuenta
              </CtaLink>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </>
  );
}
