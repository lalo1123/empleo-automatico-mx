// HTML → PDF rendering via puppeteer-core + Alpine chromium.
//
// Used by the /v1/applications/generate-cv-pdf endpoint to convert the
// tailored-CV HTML (produced by generateTailoredCv) into an A4 PDF blob
// suitable for programmatic upload to LaPieza's file input — the killer
// feature that justifies the Pro/Premium plans.
//
// Architecture notes:
//   - We use puppeteer-core (no bundled chromium) and rely on the Alpine
//     chromium binary installed in the Dockerfile (PUPPETEER_EXECUTABLE_PATH).
//   - Single shared browser instance, re-launched on death. Pages are
//     created per request and closed after the PDF is rendered.
//   - 12s timeout per render — well above the typical 2-4s observed.
//   - `printBackground: true` so the CV's brand colors render in the PDF
//     (matches the @media print rules in TAILORED_CV_SYSTEM).

import puppeteer from "puppeteer-core";
import type { Browser, LaunchOptions } from "puppeteer-core";
import { HttpError } from "./errors.js";

const EXECUTABLE_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser";

// Module-level cached browser so we don't pay the ~500ms launch cost on
// every request. If puppeteer crashes mid-flight, we lazily re-launch.
let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      if (b.connected) return b;
    } catch {
      // fall through to relaunch
    }
  }
  const launchOpts: LaunchOptions = {
    executablePath: EXECUTABLE_PATH,
    headless: true,
    args: [
      "--no-sandbox",                 // Alpine + node user, no namespace permissions
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",       // Avoid /dev/shm out-of-memory in small containers
      "--disable-gpu",
      "--font-render-hinting=none"
    ]
  };
  browserPromise = puppeteer.launch(launchOpts);
  return browserPromise;
}

/**
 * Convert a self-contained HTML document to an A4 PDF buffer.
 *
 * The input HTML must be fully self-contained (no external resources) —
 * the tailored-CV system prompt enforces this. We don't navigate to any
 * URL; we set the page content directly via setContent so there's no
 * network round-trip during rendering.
 *
 * @param html Full <!doctype html>...<html>...</html> string
 * @returns Buffer containing the PDF binary
 */
export async function htmlToPdf(html: string): Promise<Buffer> {
  if (!html || typeof html !== "string") {
    throw new HttpError(400, "VALIDATION_ERROR", "El HTML del CV está vacío.");
  }

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    // domcontentloaded is enough — no external CSS/fonts to wait for.
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 12_000 });
    const pdfData = await page.pdf({
      format: "A4",
      printBackground: true,    // Honor @media print color rules
      margin: { top: "16mm", right: "16mm", bottom: "16mm", left: "16mm" },
      preferCSSPageSize: true   // Lets @page { size: A4 } in the CV CSS win
    });
    // puppeteer 23+ returns Uint8Array; Buffer.from is the safe coercion
    // for the Node/Hono response surface.
    return Buffer.from(pdfData);
  } finally {
    try { await page.close(); } catch { /* ignore */ }
  }
}

/**
 * Gracefully close the shared browser. Called on SIGTERM / SIGINT by the
 * server entrypoint (server.ts) so docker stop is clean.
 */
export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  try {
    const b = await browserPromise;
    await b.close();
  } catch {
    // ignore — best-effort cleanup
  } finally {
    browserPromise = null;
  }
}
