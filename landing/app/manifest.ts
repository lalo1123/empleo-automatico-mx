import type { MetadataRoute } from "next";

// PWA manifest. Next.js serves this at /manifest.webmanifest and injects the
// <link rel="manifest"> tag automatically when referenced from metadata.
// Keeping this minimal — we are a web app, not an installable PWA with full
// offline support, but a valid manifest improves Lighthouse PWA score and
// gives mobile browsers a nicer "Add to Home Screen" experience.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Empleo Automático MX",
    short_name: "EmpleoAuto",
    description:
      "Copiloto con IA para postularte a más empleos en OCC Mundial y acelerar tu búsqueda de trabajo en México.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    lang: "es-MX",
    dir: "ltr",
    background_color: "#ffffff",
    theme_color: "#70d1c6",
    categories: ["business", "productivity", "jobs"],
    icons: [
      {
        src: "/logo-mark.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/favicon.ico",
        sizes: "64x64",
        type: "image/x-icon",
        purpose: "any",
      },
    ],
  };
}
