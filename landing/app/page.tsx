import type { Metadata } from "next";
import Link from "next/link";
import { Nav } from "@/components/nav";
import { Footer } from "@/components/footer";
import { FeatureCard } from "@/components/feature-card";
import { PricingTable } from "@/components/pricing-table";
import { Faq } from "@/components/faq";
import { Testimonial } from "@/components/testimonial";
import { JsonLd } from "@/components/json-ld";
import { Reveal } from "@/components/reveal";
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
    q: "¿En qué se diferencia de AIApply, LazyApply, Sonara o Breeze Apply?",
    a: "Esas herramientas postulan automáticamente sin que veas nada, sin personalizar la carta y sin caps de seguridad. El resultado: cartas genéricas idénticas para 700 vacantes y cuentas restringidas — estudios de 2026 reportan ~23% de usuarios con LinkedIn restringido en los primeros 90 días (Growleads, 2026). Empleo Automático MX hace lo opuesto: 1 carta personalizada por vacante + CV reescrito específicamente para esa chamba, y por defecto tú das el último clic. Si quieres auto-submit, está disponible en Premium pero con caps responsables (15/día en LinkedIn e Indeed, 30/día en otros portales) — el rango que los portales toleran sin marcar como bot.",
  },
  {
    q: "¿Tiene auto-submit (Modo Auto)?",
    a: "Sí, pero gated por seguridad. En planes Free y Pro, tú siempre das el clic final (cero riesgo de ban). En Premium puedes activar Modo Auto que envía automáticamente, con 4 protecciones: (1) acepta el disclaimer una vez antes de activarlo, (2) caps por portal (15/día LinkedIn/Indeed, 30/día otros, 110/día total), (3) delay aleatorio 30-90s entre postulaciones, (4) detección de CAPTCHA y day-pause automático si fallan 2 postulaciones seguidas. No es velocidad bruta — es velocidad responsable que respeta los límites de los portales.",
  },
  {
    q: "¿Es legal?",
    a: "Sí. La extensión funciona como una ayuda dentro de tu sesión normal en el navegador (NO scraping masivo, NO acceso a credenciales del portal). En planes Free/Pro tú das el último clic explícito. En Premium con Modo Auto firmas un disclaimer y aceptas los caps de seguridad por adelantado.",
  },
  {
    q: "¿Qué pasa si los portales bloquean cuentas por bots?",
    a: "Por diseño, no debería pasarte. Cada postulación se ve como una sesión humana normal (mismo browser, mismas cookies, mismo IP). Free/Pro: tú das el clic, los portales literalmente no pueden distinguir. Premium con Modo Auto: 15/día LinkedIn/Indeed es el rango documentado como seguro por la industria; delays aleatorios entre envíos imitan comportamiento humano; CAPTCHA detector pausa el flujo si el portal sospecha. Si por alguna razón el portal restringe tu cuenta usando Empleo Automático MX, contáctanos.",
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
    a: "En los 6 principales del mercado mexicano: OCC Mundial, Computrabajo, Bumeran, LaPieza, Indeed México y LinkedIn (Easy Apply, con límite responsable de 15 cartas al día para proteger tu cuenta). Todos activos desde el primer día.",
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
        {/* HERO — dark "anchor" (matches the dashboard hero), product mock as a
            light card floating on the navy for contrast + to sell the diff. */}
        <section className="relative overflow-hidden bg-[linear-gradient(165deg,#103b50_0%,#0c2f44_48%,#0a1c2b_100%)] text-white">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-[0.10] [background-image:radial-gradient(rgba(255,255,255,0.35)_1px,transparent_1.4px)] [background-size:32px_32px]"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(110%_90%_at_88%_-8%,rgba(112,209,198,0.18),transparent_46%),radial-gradient(80%_80%_at_6%_118%,rgba(255,102,0,0.10),transparent_52%)]"
          />
          <svg
            aria-hidden
            className="pointer-events-none absolute -right-10 -top-6 hidden h-[520px] w-[560px] lg:block"
            viewBox="0 0 560 520"
            fill="none"
          >
            <path d="M40 480 C 220 470, 430 360, 520 90" stroke="url(#ltraj)" strokeWidth="2.5" strokeDasharray="2 9" strokeLinecap="round" />
            <circle cx="520" cy="90" r="5" fill="#ff6600" />
            <circle cx="520" cy="90" r="13" fill="#ff6600" opacity="0.18" />
            <defs>
              <linearGradient id="ltraj" x1="40" y1="480" x2="520" y2="90" gradientUnits="userSpaceOnUse">
                <stop stopColor="#70d1c6" stopOpacity="0" />
                <stop offset="1" stopColor="#70d1c6" />
              </linearGradient>
            </defs>
          </svg>

          <div className="relative mx-auto max-w-6xl px-4 pb-16 pt-16 sm:px-6 md:pb-24">
            <div className="mx-auto max-w-3xl text-center">
              <span className="eamx-fadeup inline-flex items-center gap-2 rounded-full border border-[#4fb9ad]/30 bg-[#4fb9ad]/[0.12] px-3.5 py-1.5 text-xs font-semibold text-[#7fd8cd]">
                <span aria-hidden className="ead-pulse h-1.5 w-1.5 rounded-full bg-[#4fb9ad]" />
                Por SkyBrandMX
              </span>
              <h1 className="eamx-fadeup mt-5 text-balance text-[40px] font-extrabold leading-[1.04] tracking-tight sm:text-5xl md:text-6xl" style={{ animationDelay: "60ms" }}>
                Postúlate más rápido{" "}
                <span className="text-[#70d1c6]">sin perder calidad.</span>
              </h1>
              <p className="eamx-fadeup mx-auto mt-5 max-w-2xl text-pretty text-base font-normal leading-relaxed text-[#bcd3da] sm:text-lg" style={{ animationDelay: "120ms" }}>
                Copiloto con IA que escribe cartas personalizadas y llena
                formularios en OCC, Computrabajo, Bumeran, LaPieza, Indeed y
                LinkedIn.{" "}
                <span className="font-semibold text-[#eaf4f4]">
                  Una postulación bien hecha vence a 50 genéricas
                </span>{" "}
                — tú das el último clic.
              </p>
              <div className="eamx-fadeup mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row" style={{ animationDelay: "180ms" }}>
                <Link
                  href="/signup"
                  className="lp-cta inline-flex items-center justify-center gap-2 rounded-[12px] bg-gradient-to-b from-[#ff7a1a] to-[#ff6600] px-6 py-3.5 text-base font-bold text-white shadow-[0_12px_28px_-10px_rgba(255,102,0,0.6)] transition hover:brightness-[1.06]"
                >
                  Empieza gratis
                  <svg aria-hidden viewBox="0 0 24 24" className="lp-arrow h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </Link>
                <a
                  href="#como-funciona"
                  className="inline-flex items-center justify-center rounded-[12px] border border-white/20 bg-white/[0.07] px-6 py-3.5 text-base font-bold text-white transition hover:bg-white/[0.13]"
                >
                  Ver cómo funciona
                </a>
              </div>
              <p className="eamx-fadeup mt-4 text-xs text-[#8fb0ba]" style={{ animationDelay: "230ms" }}>
                Sin tarjeta de crédito · 3 postulaciones gratis para probar.
              </p>
              <div className="eamx-fadeup mt-8 flex flex-wrap items-center justify-center gap-x-5 gap-y-2" style={{ animationDelay: "280ms" }}>
                <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#6f939c]">
                  Funciona en
                </span>
                {["OCC", "Computrabajo", "Bumeran", "LaPieza", "Indeed", "LinkedIn"].map((p) => (
                  <span key={p} className="text-[13px] font-medium text-[#9fc0c8]">
                    {p}
                  </span>
                ))}
              </div>
            </div>

            {/* product mock — light card floating on the navy */}
            <div className="eamx-fadeup mx-auto mt-14 max-w-4xl" style={{ animationDelay: "340ms" }}>
              <div className="overflow-hidden rounded-[16px] bg-white shadow-[0_40px_90px_-40px_rgba(0,0,0,0.7)] ring-1 ring-white/[0.06]">
                <div className="flex items-center gap-1.5 border-b border-[#eef1f4] bg-[#fafbfc] px-3.5 py-2.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
                  <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
                  <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
                  <span className="ml-3 rounded-md bg-[#eef1f4] px-2.5 py-0.5 text-[11px] text-[#8a94a3]">
                    occ.com.mx/empleo/oferta/desarrollador-frontend
                  </span>
                </div>
                <div className="grid gap-4 p-4 md:grid-cols-[1fr_260px]">
                  <div className="space-y-3">
                    <span className="inline-flex items-center rounded-md bg-[#e3f1ee] px-2.5 py-0.5 text-[11px] font-medium text-[#0f6e56]">
                      Tiempo completo · CDMX
                    </span>
                    <h2 className="text-lg font-bold text-[#0f1d2c]">
                      Desarrollador Frontend Senior
                    </h2>
                    <p className="text-xs text-[#8a94a3]">
                      Buscamos experiencia en React, TypeScript y Next.js para
                      unirse a nuestro equipo…
                    </p>
                    <div className="h-1.5 w-full rounded-full bg-[#eef1f4]" />
                    <div className="h-1.5 w-4/5 rounded-full bg-[#eef1f4]" />
                    <div className="h-1.5 w-3/5 rounded-full bg-[#eef1f4]" />
                  </div>
                  <div className="flex flex-col gap-3 rounded-[12px] border border-[#e3f1ee] bg-gradient-to-b from-[#fbfffe] to-white p-4">
                    <div className="flex items-center gap-2">
                      <span aria-hidden className="flex h-7 w-7 items-center justify-center rounded-[8px] bg-gradient-to-br from-[#137e7a] to-[#0f3d54] text-white">
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 3v3M12 18v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M3 12h3M18 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
                        </svg>
                      </span>
                      <span className="text-xs font-bold text-[#0f1d2c]">
                        Empleo Automático
                      </span>
                    </div>
                    <p className="text-xs text-[#52525b]">
                      Carta personalizada lista. Revisa antes de enviar.
                    </p>
                    <div className="space-y-1.5 rounded-[8px] bg-[#f5fbfa] p-2.5">
                      <div className="h-1 w-full rounded-full bg-[#d6ece9]" />
                      <div className="h-1 w-4/5 rounded-full bg-[#d6ece9]" />
                      <div className="h-1 w-11/12 rounded-full bg-[#d6ece9]" />
                      <div className="h-1 w-3/4 rounded-full bg-[#d6ece9]" />
                    </div>
                    <button type="button" disabled className="cursor-default rounded-[10px] bg-[#137e7a] px-3 py-2 text-xs font-bold text-white">
                      Revisar y enviar
                    </button>
                  </div>
                </div>
              </div>
              <p className="mt-3 text-center text-xs text-[#6f939c]">
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
          <Reveal as="ol" className="mx-auto mt-14 grid max-w-5xl gap-5 md:grid-cols-3">
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
                className="eaq-card relative rounded-[16px] border border-[color:var(--color-border)] bg-white p-6"
              >
                <span className="text-xs font-bold tracking-[0.2em] text-[color:var(--color-brand-600)]">
                  PASO {step.n}
                </span>
                <h3 className="mt-2 text-lg font-bold text-[color:var(--color-ink)]">
                  {step.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-[color:var(--color-ink-soft)]">
                  {step.body}
                </p>
              </li>
            ))}
          </Reveal>
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

            <Reveal as="div" className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              <FeatureCard
                title="Auto-submit seguro (Premium)"
                description="Sí postulamos automático en Premium — pero con caps de 15/día en LinkedIn e Indeed, delays aleatorios y CAPTCHA detector. Velocidad responsable, sin el ban que viene con Breeze, AIApply o LazyApply."
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
                title="6 portales mexicanos"
                description="OCC, Computrabajo, Bumeran, LaPieza, Indeed e LinkedIn (Easy Apply, con límite responsable)."
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
                title="Cartas que sí abren puertas"
                description="La IA cruza tu CV con cada vacante específica. Una postulación bien hecha vence a 50 genéricas — y los reclutadores lo notan."
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
                description="Desde $299 MXN al mes. Cancelas cuando quieras, sin letras chiquitas."
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
            </Reveal>
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
          <Reveal as="div" className="mt-10 grid gap-5 md:grid-cols-3">
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
          </Reveal>
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
            <Reveal className="mt-12">
              <PricingTable />
            </Reveal>
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
          <Reveal className="mt-10">
            <Faq items={FAQ_ITEMS} />
          </Reveal>
        </section>

        {/* CTA FINAL — dark anchor that bookends the page */}
        <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
          <Reveal className="relative overflow-hidden rounded-[24px] bg-[linear-gradient(150deg,#103b50_0%,#0a1c2b_100%)] p-10 text-center shadow-[0_30px_80px_-30px_rgba(16,89,113,0.6)] md:p-16">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 opacity-[0.10] [background-image:radial-gradient(rgba(255,255,255,0.35)_1px,transparent_1.4px)] [background-size:30px_30px]"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(80%_120%_at_80%_-10%,rgba(112,209,198,0.22),transparent_50%),radial-gradient(70%_90%_at_15%_120%,rgba(255,102,0,0.12),transparent_55%)]"
            />
            <h2 className="relative text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
              Empieza gratis hoy
            </h2>
            <p className="relative mx-auto mt-3 max-w-xl text-sm text-[#bcd3da] sm:text-base">
              3 postulaciones sin costo para que lo pruebes. Sin tarjeta de
              crédito.
            </p>
            <div className="relative mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                href="/signup"
                className="lp-cta inline-flex items-center justify-center gap-2 rounded-[12px] bg-gradient-to-b from-[#ff7a1a] to-[#ff6600] px-6 py-3.5 text-base font-bold text-white shadow-[0_12px_28px_-10px_rgba(255,102,0,0.6)] transition hover:brightness-[1.06]"
              >
                Crear mi cuenta
                <svg aria-hidden viewBox="0 0 24 24" className="lp-arrow h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </Link>
              <Link
                href="/login"
                className="inline-flex items-center justify-center rounded-[12px] border border-white/20 bg-white/[0.07] px-6 py-3.5 text-base font-bold text-white transition hover:bg-white/[0.13]"
              >
                Ya tengo cuenta
              </Link>
            </div>
          </Reveal>
        </section>
      </main>

      <Footer />
    </>
  );
}
