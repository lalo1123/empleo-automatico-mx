import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/seo";

// Keep this list small and curated. Private routes (/account*) and API
// routes (/api/*) must never appear here — they are also disallowed in
// robots.ts as a defence-in-depth measure.
interface Route {
  path: string;
  changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"];
  priority: number;
}

const ROUTES: Route[] = [
  { path: "/", changeFrequency: "weekly", priority: 1.0 },
  { path: "/signup", changeFrequency: "monthly", priority: 0.9 },
  { path: "/login", changeFrequency: "monthly", priority: 0.5 },
  { path: "/privacy", changeFrequency: "yearly", priority: 0.3 },
  { path: "/terms", changeFrequency: "yearly", priority: 0.3 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return ROUTES.map((r) => ({
    url: `${SITE_URL}${r.path === "/" ? "" : r.path}`,
    lastModified: now,
    changeFrequency: r.changeFrequency,
    priority: r.priority,
    // hreflang hint for bilingual or localised future versions. Currently
    // only es-MX, but declaring it helps Google confirm the target market.
    alternates: {
      languages: {
        "es-MX": `${SITE_URL}${r.path === "/" ? "" : r.path}`,
      },
    },
  }));
}
