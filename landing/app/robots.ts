import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/seo";

// Robots policy. We want Googlebot (and friends) to index everything
// public and stay out of:
//   - /account* : authenticated area, noindex-worthy private data
//   - /api/*    : server endpoints, not useful to crawl
//   - Next.js internals (/_next/*) are auto-disallowed by convention but
//     we spell it out for clarity and for crawlers that don't follow it.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/"],
        disallow: ["/account", "/account/", "/api/", "/_next/"],
      },
      // Explicit allow for Googlebot so no regex/userAgent mismatch ever
      // blocks us accidentally. Same policy, just more discoverable.
      {
        userAgent: "Googlebot",
        allow: ["/"],
        disallow: ["/account", "/account/", "/api/"],
      },
      {
        userAgent: "Googlebot-Image",
        allow: ["/"],
      },
      // Block the most aggressive LLM scrapers from training on our content.
      // Adjust if your strategy changes — some teams *want* AI visibility.
      {
        userAgent: ["GPTBot", "ClaudeBot", "CCBot", "anthropic-ai", "Google-Extended"],
        disallow: ["/"],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
