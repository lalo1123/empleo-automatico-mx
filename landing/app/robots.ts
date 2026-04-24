import type { MetadataRoute } from "next";

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://empleo.skybrandmx.com";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/account", "/account/*", "/api/*"],
      },
    ],
    sitemap: `${SITE}/sitemap.xml`,
  };
}
