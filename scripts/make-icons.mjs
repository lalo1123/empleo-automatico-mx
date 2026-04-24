// Generates icons/icon{16,48,128}.png — zero-dependency PNG writer.
// Purple background (#7c3aed) with a white stylized "E" glyph in the middle.
// Run with: node scripts/make-icons.mjs

import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = resolve(__dirname, "..", "icons");
mkdirSync(ICONS_DIR, { recursive: true });

// Palette
const PURPLE = [0x7c, 0x3a, 0xed]; // accent
const WHITE = [0xff, 0xff, 0xff];

/**
 * Build a raw RGBA pixel buffer for an icon of the given size.
 * Draws a rounded-corner purple tile and a blocky "E" in white.
 */
function buildPixels(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = Math.max(1, Math.floor(size * 0.15));
  const innerPad = Math.floor(size * 0.2);
  const innerSize = size - innerPad * 2;

  // Stroke thickness for the E strokes — scale with size.
  const stroke = Math.max(1, Math.floor(size * 0.13));
  // The E occupies a centered bounding box inside the tile.
  const ex = innerPad;
  const ey = innerPad;
  const ew = innerSize;
  const eh = innerSize;

  const inRoundedRect = (x, y) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return false;
    // corner circles
    if (x < radius && y < radius) {
      const dx = radius - x;
      const dy = radius - y;
      return dx * dx + dy * dy <= radius * radius;
    }
    if (x >= size - radius && y < radius) {
      const dx = x - (size - radius - 1);
      const dy = radius - y;
      return dx * dx + dy * dy <= radius * radius;
    }
    if (x < radius && y >= size - radius) {
      const dx = radius - x;
      const dy = y - (size - radius - 1);
      return dx * dx + dy * dy <= radius * radius;
    }
    if (x >= size - radius && y >= size - radius) {
      const dx = x - (size - radius - 1);
      const dy = y - (size - radius - 1);
      return dx * dx + dy * dy <= radius * radius;
    }
    return true;
  };

  // E strokes: left vertical, top horizontal, middle horizontal, bottom horizontal.
  const inE = (x, y) => {
    // left vertical bar
    if (x >= ex && x < ex + stroke && y >= ey && y < ey + eh) return true;
    // top bar
    if (y >= ey && y < ey + stroke && x >= ex && x < ex + ew) return true;
    // bottom bar
    if (y >= ey + eh - stroke && y < ey + eh && x >= ex && x < ex + ew) return true;
    // middle bar (a bit shorter than full width)
    const midY0 = ey + Math.floor(eh / 2) - Math.floor(stroke / 2);
    const midW = Math.floor(ew * 0.72);
    if (y >= midY0 && y < midY0 + stroke && x >= ex && x < ex + midW) return true;
    return false;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inRoundedRect(x, y)) {
        // transparent outside rounded rect
        pixels[i] = 0;
        pixels[i + 1] = 0;
        pixels[i + 2] = 0;
        pixels[i + 3] = 0;
        continue;
      }
      const isLetter = inE(x, y);
      const c = isLetter ? WHITE : PURPLE;
      pixels[i] = c[0];
      pixels[i + 1] = c[1];
      pixels[i + 2] = c[2];
      pixels[i + 3] = 0xff;
    }
  }
  return pixels;
}

// PNG encoder ----------------------------------------------------------------
// Minimal RGBA PNG writer. Uses deflate + CRC32 from zlib + manual table.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(pixels, size) {
  // Add PNG filter byte (0 = None) at the start of each scanline.
  const stride = size * 4;
  const filtered = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    filtered[y * (stride + 1)] = 0;
    pixels.copy(filtered, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const compressed = deflateSync(filtered, { level: 9 });

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// ---------------------------------------------------------------------------

for (const size of [16, 48, 128]) {
  const pixels = buildPixels(size);
  const png = encodePng(pixels, size);
  const out = resolve(ICONS_DIR, `icon${size}.png`);
  writeFileSync(out, png);
  console.log(`wrote ${out} (${png.length} bytes)`);
}
