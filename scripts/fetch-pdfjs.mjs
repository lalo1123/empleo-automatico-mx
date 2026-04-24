#!/usr/bin/env node
// Download pdf.js runtime + worker into /vendor. Idempotent.
//
// Usage:
//   node scripts/fetch-pdfjs.mjs           # uses default UMD version below
//   PDFJS_VERSION=3.11.174 node scripts/fetch-pdfjs.mjs
//
// We use the 3.11.174 UMD build because it loads as a classic <script src=...>
// in the options page and exposes globalThis.pdfjsLib — which lib/cv-parser.js
// depends on. pdf.js 4.x ships ESM only and would require <script type="module">
// plus import rewiring; keep the setup boring until we need the newer features.

import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = resolve(__dirname, "..", "vendor");
const VERSION = process.env.PDFJS_VERSION || "3.11.174";

const FILES = [
  {
    localName: "pdf.min.js",
    sources: [
      `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${VERSION}/pdf.min.js`,
      `https://cdn.jsdelivr.net/npm/pdfjs-dist@${VERSION}/build/pdf.min.js`,
      `https://unpkg.com/pdfjs-dist@${VERSION}/build/pdf.min.js`
    ]
  },
  {
    localName: "pdf.worker.min.js",
    sources: [
      `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${VERSION}/pdf.worker.min.js`,
      `https://cdn.jsdelivr.net/npm/pdfjs-dist@${VERSION}/build/pdf.worker.min.js`,
      `https://unpkg.com/pdfjs-dist@${VERSION}/build/pdf.worker.min.js`
    ]
  }
];

async function fileExistsNonEmpty(path) {
  try {
    const s = await stat(path);
    return s.isFile() && s.size > 0;
  } catch (_) {
    return false;
  }
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error("empty body");
  return buf;
}

async function fetchAnySource(file) {
  const errors = [];
  for (const url of file.sources) {
    process.stdout.write(`  GET ${url} ... `);
    try {
      const buf = await download(url);
      process.stdout.write(`OK (${buf.length} bytes)\n`);
      return buf;
    } catch (e) {
      process.stdout.write(`FAIL (${e.message})\n`);
      errors.push(`${url}: ${e.message}`);
    }
  }
  throw new Error(`No source worked for ${file.localName}:\n  ${errors.join("\n  ")}`);
}

async function main() {
  console.log(`pdf.js fetcher — version ${VERSION}`);
  console.log(`Vendor dir: ${VENDOR_DIR}`);
  await mkdir(VENDOR_DIR, { recursive: true });

  let downloaded = 0;
  let skipped = 0;
  for (const file of FILES) {
    const localPath = resolve(VENDOR_DIR, file.localName);
    console.log(`\n• ${file.localName}`);
    if (await fileExistsNonEmpty(localPath)) {
      console.log(`  already exists, skipping`);
      skipped += 1;
      continue;
    }
    const buf = await fetchAnySource(file);
    await writeFile(localPath, buf);
    console.log(`  wrote ${localPath}`);
    downloaded += 1;
  }
  console.log(`\nDone. ${downloaded} downloaded, ${skipped} skipped.`);
}

main().catch((e) => {
  console.error("\nfetch-pdfjs failed:", e.message);
  process.exit(1);
});
