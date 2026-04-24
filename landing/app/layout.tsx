import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://empleo.skybrandmx.com";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Empleo Automático MX — Postúlate a más empleos, en menos tiempo",
    template: "%s · Empleo Automático MX",
  },
  description:
    "Copiloto con IA que escribe cartas de presentación personalizadas y llena formularios en OCC Mundial. Tú solo das el último clic. Desde $199 MXN al mes.",
  keywords: [
    "empleo México",
    "OCC Mundial",
    "postular empleos",
    "IA",
    "carta de presentación",
    "buscar trabajo",
    "SkyBrandMX",
  ],
  authors: [{ name: "SkyBrandMX" }],
  creator: "SkyBrandMX",
  publisher: "SkyBrandMX",
  openGraph: {
    type: "website",
    locale: "es_MX",
    url: siteUrl,
    siteName: "Empleo Automático MX",
    title: "Empleo Automático MX — Postúlate a más empleos, en menos tiempo",
    description:
      "Copiloto con IA que escribe cartas personalizadas y llena formularios en OCC Mundial.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Empleo Automático MX",
    description:
      "Copiloto con IA para buscar empleo en México. Desde $199 MXN/mes.",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  themeColor: "#7c3aed",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es-MX" className={inter.variable}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
