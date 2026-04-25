// Central SEO configuration for Empleo Automático MX.
// Single source of truth for titles, descriptions, keywords and OG defaults.
// All page-level metadata should use `pageMetadata()` so we stay DRY and
// avoid keyword/description drift across pages.

import type { Metadata } from "next";

export const SITE_NAME = "SkyBrandMX";
export const PRODUCT_NAME = "Empleo Automático MX";
export const TWITTER_HANDLE = "@skybrandmx";
export const SITE_LOCALE = "es_MX";

export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://empleo.skybrandmx.com";

// Default title used on the home page. Includes a primary keyword
// ("postúlate a más empleos") without stuffing. Kept under 60 chars so
// Google doesn't truncate it in the SERP (typical limit ~580px).
export const DEFAULT_TITLE =
  "Empleo Automático MX: Postúlate a más empleos con IA";

// Default meta description. Kept under 160 chars and naturally includes:
// "buscar empleo", "postularte", the 5 portals, "IA", price anchor.
export const DEFAULT_DESCRIPTION =
  "Copiloto con IA para buscar empleo en México. Postúlate en OCC, Computrabajo, Bumeran, Indeed y LinkedIn con cartas IA. Desde $199 MXN al mes.";

// Target keyword set, high-intent for the Mexican job market. Google ignores
// the meta keywords tag but Next's Metadata type accepts it and some crawlers
// plus certain SEO tools still read it for context.
export const KEYWORDS: string[] = [
  // Primary high-intent
  "postularse a empleos",
  "buscar trabajo méxico",
  "buscar empleo cdmx",
  "postularme a varios empleos a la vez",
  "auto apply méxico",
  // Secondary
  "carta de presentación con IA",
  "automatizar búsqueda de empleo",
  "extensión chrome empleo méxico",
  "OCC Mundial",
  "Computrabajo",
  "Bumeran México",
  "Indeed México",
  "LinkedIn Easy Apply",
  "IA para conseguir trabajo",
  "cover letter automática",
  "búsqueda de empleo automática",
  // Brand
  "Empleo Automático MX",
  "SkyBrandMX",
];

export const OG_IMAGE = "/og-image.svg";
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;
export const OG_IMAGE_ALT =
  "Empleo Automático MX — copiloto con IA para postularte en los principales portales de empleo de México. Por SkyBrandMX.";

interface PageMetadataArgs {
  /** Page-specific title. Rendered as `${title} | SkyBrandMX` via layout template. */
  title: string;
  /** Page-specific meta description. Aim for 140–160 chars, Spanish MX. */
  description: string;
  /** Path relative to site root, e.g. "/signup". Leading slash required. */
  path: string;
  /** Set to true for private pages (account, billing, success). */
  noIndex?: boolean;
  /** Override OG/Twitter image for this page. Defaults to the shared OG image. */
  image?: string;
}

/**
 * Build a Next.js Metadata object for a page with sensible defaults.
 * Extends the root layout metadata: you only need to supply the bits that
 * change per page.
 */
export function pageMetadata({
  title,
  description,
  path,
  noIndex = false,
  image = OG_IMAGE,
}: PageMetadataArgs): Metadata {
  const url = `${SITE_URL}${path}`;
  return {
    title,
    description,
    alternates: { canonical: path },
    robots: noIndex
      ? { index: false, follow: false, nocache: true }
      : undefined,
    openGraph: {
      type: "website",
      locale: SITE_LOCALE,
      siteName: PRODUCT_NAME,
      url,
      title,
      description,
      images: [
        {
          url: image,
          width: OG_IMAGE_WIDTH,
          height: OG_IMAGE_HEIGHT,
          alt: OG_IMAGE_ALT,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      site: TWITTER_HANDLE,
      creator: TWITTER_HANDLE,
      title,
      description,
      images: [image],
    },
  };
}
