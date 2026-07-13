#!/usr/bin/env node
/**
 * Generate the ReRouted menu bar template icon (pure Node, no deps).
 *
 * Glyph: a "detour" arrow — traffic leaves the straight route (faded dots)
 * and steps up onto a new path ending in an arrowhead. Rendered as a macOS
 * template image (black + alpha only) at 16px and 32px (@2x).
 *
 * Usage: node scripts/gen-tray-icon.js
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

// ---------- PNG encoder ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encode an RGBA pixel buffer as a PNG. */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- Signed-distance rasterizer ----------

function distSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const len2 = abx * abx + aby * aby;
  const t = len2 ? Math.max(0, Math.min(1, (apx * abx + apy * aby) / len2)) : 0;
  const dx = apx - t * abx;
  const dy = apy - t * aby;
  return Math.hypot(dx, dy);
}

function sdTriangle(px, py, tri) {
  const [[ax, ay], [bx, by], [cx, cy]] = tri;
  const d = Math.min(
    distSegment(px, py, ax, ay, bx, by),
    distSegment(px, py, bx, by, cx, cy),
    distSegment(px, py, cx, cy, ax, ay)
  );
  const s1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const s2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
  const s3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  const inside = (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
  return inside ? -d : d;
}

/** Coverage in [0,1] from a signed distance, with a soft half-pixel edge. */
function cov(sd, edge) {
  return Math.max(0, Math.min(1, 0.5 - sd / edge));
}

/**
 * Shape coverage at a point (glyph coordinates are in a 16x16 box).
 * Returns max alpha across shapes so overlaps stay clean.
 */
function sampleGlyph(x, y, edge) {
  // New route: left → step up → right, round caps, stroke width 1.9
  const HALF_W = 0.95;
  const route = [
    [2.4, 11.6],
    [6.6, 11.6],
    [6.6, 4.6],
    [10.9, 4.6],
  ];
  let a = 0;
  for (let i = 0; i < route.length - 1; i++) {
    const d = distSegment(x, y, route[i][0], route[i][1], route[i + 1][0], route[i + 1][1]);
    a = Math.max(a, cov(d - HALF_W, edge));
  }
  // Arrowhead at the end of the new route
  const head = [
    [10.5, 1.9],
    [10.5, 7.3],
    [14.1, 4.6],
  ];
  a = Math.max(a, cov(sdTriangle(x, y, head), edge));
  // Old route: faded dots continuing straight — the road not taken
  for (const [cx2, cy2] of [
    [9.8, 11.6],
    [12.6, 11.6],
  ]) {
    const d = Math.hypot(x - cx2, y - cy2);
    a = Math.max(a, 0.38 * cov(d - 0.85, edge));
  }
  return a;
}

/**
 * Render glyph at `size` px with 4x4 supersampling.
 * @param {{r:number,g:number,b:number}|null} color — null = template (black+alpha)
 */
function render(size, color = null) {
  const rgba = Buffer.alloc(size * size * 4);
  const s = size / 16;
  const SS = 4;
  const edge = 0.6 / s;
  const cr = color ? color.r : 0;
  const cg = color ? color.g : 0;
  const cb = color ? color.b : 0;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let acc = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const gx = (px + (sx + 0.5) / SS) / s;
          const gy = (py + (sy + 0.5) / SS) / s;
          acc += sampleGlyph(gx, gy, edge);
        }
      }
      const alpha = Math.round((acc / (SS * SS)) * 255);
      const o = (py * size + px) * 4;
      rgba[o] = cr;
      rgba[o + 1] = cg;
      rgba[o + 2] = cb;
      rgba[o + 3] = alpha;
    }
  }
  return encodePng(size, size, rgba);
}

const outDir = path.join(__dirname, "..", "resources");
const rendererAssets = path.join(__dirname, "..", "src", "renderer", "assets");
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(rendererAssets, { recursive: true });

// Menu bar template (black + alpha)
for (const [file, size] of [
  ["trayTemplate.png", 16],
  ["trayTemplate@2x.png", 32],
]) {
  const png = render(size, null);
  fs.writeFileSync(path.join(outDir, file), png);
  console.log(`${file}: ${size}x${size}, ${png.length} bytes`);
}

// Panel brand mark — accent blue detour glyph
const accent = { r: 0, g: 113, b: 227 }; // #0071e3
for (const [file, size] of [
  ["brandMark.png", 32],
  ["brandMark@2x.png", 64],
]) {
  const png = render(size, accent);
  fs.writeFileSync(path.join(outDir, file), png);
  fs.writeFileSync(path.join(rendererAssets, file), png);
  console.log(`${file}: ${size}x${size}, ${png.length} bytes`);
}
