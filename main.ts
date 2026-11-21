// The Passport Page of a Country That Isn't There.
// A single self-contained Node program (standard library only) that draws an
// open passport spread for the invented Republic of Vessalia and writes it as
// entry.png into MAKEFUN_OUTPUT_DIR (default /output).
//
// Everything is rendered from code: a small rasterizer working on a 2x
// supersampled buffer, and an embedded single-stroke (Hershey-style) font
// that engraves every letter of the document.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Canvas / rasterizer
// ---------------------------------------------------------------------------

const SS = 2; // supersampling factor
const W = 1024;
const H = 768;
const BW = W * SS;
const BH = H * SS;
const buf = new Float32Array(BW * BH * 3);

type RGB = [number, number, number];
const C = (hex: string): RGB => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

// Deterministic RNG (mulberry32) so the entry is reproducible.
let seed = 0x5eed1234;
function rnd(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function blendPx(x: number, y: number, col: RGB, a: number): void {
  if (x < 0 || y < 0 || x >= BW || y >= BH || a <= 0) return;
  const i = (y * BW + x) * 3;
  const ia = 1 - a;
  buf[i] = buf[i] * ia + col[0] * a;
  buf[i + 1] = buf[i + 1] * ia + col[1] * a;
  buf[i + 2] = buf[i + 2] * ia + col[2] * a;
}

// All drawing helpers take final-image coordinates and scale internally.

function fillRect(x: number, y: number, w: number, h: number, col: RGB, a = 1): void {
  const x0 = Math.round(x * SS), y0 = Math.round(y * SS);
  const x1 = Math.round((x + w) * SS), y1 = Math.round((y + h) * SS);
  for (let yy = y0; yy < y1; yy++)
    for (let xx = x0; xx < x1; xx++) blendPx(xx, yy, col, a);
}

function disc(cx: number, cy: number, r: number, col: RGB, a = 1): void {
  const R = r * SS;
  const x0 = Math.floor((cx - r) * SS), x1 = Math.ceil((cx + r) * SS);
  const y0 = Math.floor((cy - r) * SS), y1 = Math.ceil((cy + r) * SS);
  const ccx = cx * SS, ccy = cy * SS;
  for (let yy = y0; yy <= y1; yy++)
    for (let xx = x0; xx <= x1; xx++) {
      const dx = xx - ccx, dy = yy - ccy;
      if (dx * dx + dy * dy <= R * R) blendPx(xx, yy, col, a);
    }
}

function line(x1: number, y1: number, x2: number, y2: number, w: number, col: RGB, a = 1): void {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(len * SS * 1.6));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    disc(x1 + dx * t, y1 + dy * t, w / 2, col, a);
  }
}

function polyline(pts: Array<[number, number]>, w: number, col: RGB, a = 1, close = false): void {
  for (let i = 0; i + 1 < pts.length; i++) line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], w, col, a);
  if (close && pts.length > 2) line(pts[pts.length - 1][0], pts[pts.length - 1][1], pts[0][0], pts[0][1], w, col, a);
}

function circleStroke(cx: number, cy: number, r: number, w: number, col: RGB, a = 1, a0 = 0, a1 = Math.PI * 2): void {
  const steps = Math.max(12, Math.ceil(r * SS * 2));
  let prev: [number, number] | null = null;
  for (let s = 0; s <= steps; s++) {
    const t = a0 + ((a1 - a0) * s) / steps;
    const p: [number, number] = [cx + r * Math.cos(t), cy + r * Math.sin(t)];
    if (prev) line(prev[0], prev[1], p[0], p[1], w, col, a);
    prev = p;
  }
}

function ellipseFill(cx: number, cy: number, rx: number, ry: number, col: RGB, a = 1): void {
  const y0 = Math.floor((cy - ry) * SS), y1 = Math.ceil((cy + ry) * SS);
  for (let yy = y0; yy <= y1; yy++) {
    const dy = (yy / SS - cy) / ry;
    if (Math.abs(dy) > 1) continue;
    const half = rx * Math.sqrt(1 - dy * dy);
    const x0 = Math.round((cx - half) * SS), x1 = Math.round((cx + half) * SS);
    for (let xx = x0; xx <= x1; xx++) blendPx(xx, yy, col, a);
  }
}

function ellipseStroke(cx: number, cy: number, rx: number, ry: number, w: number, col: RGB, a = 1): void {
  const steps = Math.max(24, Math.ceil(Math.max(rx, ry) * SS * 2));
  let prev: [number, number] | null = null;
  for (let s = 0; s <= steps; s++) {
    const t = (s / steps) * Math.PI * 2;
    const p: [number, number] = [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];
    if (prev) line(prev[0], prev[1], p[0], p[1], w, col, a);
    prev = p;
  }
}

function polyFill(pts: Array<[number, number]>, col: RGB, a = 1): void {
  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
  for (const [x, y] of pts) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  const y0 = Math.max(0, Math.floor(minY * SS)), y1 = Math.min(BH - 1, Math.ceil(maxY * SS));
  const x0 = Math.max(0, Math.floor(minX * SS)), x1 = Math.min(BW - 1, Math.ceil(maxX * SS));
  for (let yy = y0; yy <= y1; yy++) {
    const py = yy / SS;
    for (let xx = x0; xx <= x1; xx++) {
      const px = xx / SS;
      // even-odd point in polygon
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i];
        const [xj, yj] = pts[j];
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) blendPx(xx, yy, col, a);
    }
  }
}

function rectStroke(x: number, y: number, w: number, h: number, lw: number, col: RGB, a = 1): void {
  line(x, y, x + w, y, lw, col, a);
  line(x + w, y, x + w, y + h, lw, col, a);
  line(x + w, y + h, x, y + h, lw, col, a);
  line(x, y + h, x, y, lw, col, a);
}

// ---------------------------------------------------------------------------
// Stroke font. Glyph space: baseline y=0, cap height 10, x-height 7,
// descenders to -3. Each glyph: [advanceWidth, "stroke|stroke|..."] where a
// stroke is space-separated "x,y" points.
// ---------------------------------------------------------------------------

const F: Record<string, [number, string]> = {
  " ": [5, ""],
  A: [8, "0,0 4,10 8,0|2,3.4 6,3.4"],
  B: [7.5, "0,0 0,10|0,10 4.2,10 6.2,8.6 6.2,6.6 4.2,5.2 0,5.2|4.2,5.2 6.4,3.8 6.4,1.4 4.2,0 0,0"],
  C: [8, "7.6,7.8 5.6,9.8 3.2,10 1.2,8.6 0.5,5.2 1.2,1.8 3.2,0.2 5.6,0.2 7.6,2.2"],
  D: [7.5, "0,0 0,10|0,10 3.8,10 6,8.4 6.8,5 6,1.6 3.8,0 0,0"],
  E: [6.5, "6.5,10 0,10 0,0 6.5,0|0,5.2 4.8,5.2"],
  F: [6, "6,10 0,10 0,0|0,5.2 4.6,5.2"],
  G: [8.5, "7.9,7.8 5.9,9.8 3.4,10 1.3,8.6 0.6,5.2 1.3,1.8 3.4,0.2 5.9,0.2 7.9,1.9 7.9,4.4 5,4.4"],
  H: [7.5, "0,0 0,10|7.5,0 7.5,10|0,5 7.5,5"],
  I: [3, "1.5,0 1.5,10|0.2,10 2.8,10|0.2,0 2.8,0"],
  J: [6, "6,10 6,2.2 4.9,0.3 2.6,0 1.1,1.1 0.8,2.6"],
  K: [7, "0,0 0,10|7,10 0.9,4.4|2,5.4 7,0"],
  L: [6, "0,10 0,0 6,0"],
  M: [9, "0,0 0,10 4.5,3.2 9,10 9,0"],
  N: [7.5, "0,0 0,10 7.5,0 7.5,10"],
  O: [8.5, "3.1,10 1.2,8.7 0.5,5.2 1.2,1.7 3.1,0 5.4,0 7.3,1.7 8,5.2 7.3,8.7 5.4,10 3.1,10"],
  P: [7, "0,0 0,10|0,10 4.6,10 6.7,8.5 6.7,6.3 4.6,4.9 0,4.9"],
  Q: [8.5, "3.1,10 1.2,8.7 0.5,5.2 1.2,1.7 3.1,0 5.4,0 7.3,1.7 8,5.2 7.3,8.7 5.4,10 3.1,10|5.6,2.6 8.6,-0.6"],
  R: [7, "0,0 0,10|0,10 4.6,10 6.7,8.5 6.7,6.3 4.6,4.9 0,4.9|4.6,4.9 7.2,0"],
  S: [7.5, "7.1,8.4 5.3,10 2.9,10 1.1,8.9 1.1,6.9 3.1,5.5 5.4,4.7 6.9,3.3 6.9,1.5 5.1,0 2.6,0 0.9,1.4"],
  T: [7.5, "0,10 7.5,10|3.75,10 3.75,0"],
  U: [7.5, "0,10 0,2.2 1.2,0.4 3.75,0 6.3,0.4 7.5,2.2 7.5,10"],
  V: [8, "0,10 4,0 8,10"],
  W: [10.5, "0,10 2.2,0 5.25,6.8 8.3,0 10.5,10"],
  X: [7.5, "0,0 7.5,10|0,10 7.5,0"],
  Y: [7.5, "0,10 3.75,4.6 7.5,10|3.75,4.6 3.75,0"],
  Z: [7.5, "0,10 7.5,10 0,0 7.5,0"],
  "0": [7.5, "2.9,10 1.3,8.8 0.6,5 1.3,1.2 2.9,0 4.6,0 6.2,1.2 6.9,5 6.2,8.8 4.6,10 2.9,10"],
  "1": [6, "1.7,7.7 4.3,10 4.3,0|1.7,0 6.1,0"],
  "2": [7, "0.8,8.1 2.2,10 4.6,10 6.2,8.3 6,6.1 0.8,0 6.8,0"],
  "3": [7, "1,8.5 2.8,10 4.6,10 6,8.7 5.7,6.9 3.5,5.5|3.5,5.5 5.7,5.1 6.5,3.1 5.7,0.9 4.1,0 2.3,0 1,1.3"],
  "4": [7.5, "5.2,0 5.2,10 1,3.1 7.3,3.1"],
  "5": [6.8, "6.4,10 1.2,10 1,6.1 3.2,6.9 5.4,6.3 6.4,4.3 5.8,1.5 4.2,0 2.2,0 1,1.1"],
  "6": [7, "6.2,8.8 4.4,10 2.4,9.3 1.2,6.7 1,3.7 2.2,1.2 4.2,0.4 6,1.2 6.4,3.4 5.4,5.2 3.4,5.6 1.7,4.7"],
  "7": [7, "0.6,10 6.8,10 3.6,0"],
  "8": [7, "3.5,5.6 2.4,6.7 2.6,8.8 3.5,9.9 4.4,8.8 4.6,6.7 3.5,5.6 2.2,4.3 2.4,1.4 3.5,0.1 4.6,1.4 4.8,4.3 3.5,5.6"],
  "9": [7, "0.8,1.3 2.6,0.1 4.6,0.9 5.8,3.4 6,6.5 4.8,8.9 2.8,9.7 1,8.5 0.8,6.1 2,4.5 4,4.3 5.6,5.3"],
  a: [6.5, "6,7 6,0|4.7,7 2.3,7 0.9,5.5 0.9,1.6 2.3,0 4.7,0 6,1.7"],
  b: [6.5, "0,10 0,0|0,1.7 2.3,0 4.7,0 5.9,1.6 5.9,5.4 4.7,7 2.3,7 0,5.5"],
  c: [6, "5.7,5.5 4.1,7 2.1,7 0.8,5.3 0.8,1.7 2.1,0 4.1,0 5.7,1.5"],
  d: [6.5, "6,10 6,0|6,5.5 4.7,7 2.3,7 0.9,5.4 0.9,1.6 2.3,0 4.7,0 6,1.7"],
  e: [6.5, "0.9,3.9 6,3.9 5.8,5.7 4.3,7 2.2,7 0.9,5.3 0.9,1.7 2.2,0 4.3,0 5.9,1.3"],
  f: [4.2, "4.4,9.3 3.3,10 2.1,9.5 2,7 2,0|0.6,7 3.7,7"],
  g: [6.5, "6,7 6,-1.4 4.9,-2.9 2.7,-3 1.3,-2.1|4.7,7 2.3,7 0.9,5.4 0.9,1.6 2.3,0 4.7,0 6,1.7"],
  h: [6.5, "0,10 0,0|0,5.3 2.3,7 4.6,7 5.9,5.4 5.9,0"],
  i: [2.6, "1.3,7 1.3,0|1.3,9.6 1.3,9.6"],
  j: [3.6, "2.9,7 2.9,-1.5 1.9,-2.9 0.5,-2.5|2.9,9.6 2.9,9.6"],
  k: [6, "0,10 0,0|5.8,7 1,3.3|2.1,4.1 6,0"],
  l: [2.6, "1.3,10 1.3,0"],
  m: [10.5, "0,7 0,0|0,5.3 2.3,7 4.6,7 5.25,5.3 5.25,0|5.25,5.3 7.5,7 9.8,7 10.5,5.3 10.5,0"],
  n: [6.5, "0,7 0,0|0,5.3 2.3,7 4.6,7 5.9,5.4 5.9,0"],
  o: [6.5, "2.3,7 1,5.6 0.8,3.5 1,1.4 2.3,0 4.2,0 5.5,1.4 5.7,3.5 5.5,5.6 4.2,7 2.3,7"],
  p: [6.5, "0,7 0,-3|0,5.4 2.3,7 4.7,7 5.9,5.3 5.9,1.7 4.7,0 2.3,0 0,1.6"],
  q: [6.5, "6,7 6,-3|6,1.6 4.7,0 2.3,0 0.9,1.7 0.9,5.3 2.3,7 4.7,7 6,5.4"],
  r: [4.6, "0,7 0,0|0,5.5 2.1,7 4.5,6.9"],
  s: [5.6, "5.2,5.9 3.8,7 1.9,7 0.7,6.1 0.9,4.7 2.7,3.9 4.4,3.1 5,1.9 4.2,0.2 2.2,0 0.7,1.1"],
  t: [4.2, "2.1,9.6 2.1,1.5 3.1,0.1 4.3,0.3|0.5,7 3.9,7"],
  u: [6.5, "0,7 0,1.7 1.3,0.1 3.5,0 5.9,1.9|5.9,7 5.9,0"],
  v: [6.5, "0,7 3.25,0 6.5,7"],
  w: [9.5, "0,7 1.9,0 4.75,5.2 7.6,0 9.5,7"],
  x: [6, "0,0 6,7|0,7 6,0"],
  y: [6.5, "0,7 3.3,1.9|6.5,7 3.3,1.9 2.4,-2.5 0.9,-2.9"],
  z: [6, "0,7 6,7 0,0 6,0"],
  ".": [2.6, "1.3,0 1.3,0"],
  ",": [2.6, "1.45,0.4 1.1,-1.2"],
  ":": [2.6, "1.3,5 1.3,5|1.3,0 1.3,0"],
  ";": [2.6, "1.3,5 1.3,5|1.45,0.4 1.1,-1.2"],
  "·": [4, "2,3.5 2,3.5"],
  "-": [5, "0.4,3.5 4.6,3.5"],
  "—": [9.5, "0.4,3.5 9.1,3.5"],
  "<": [6, "5.2,6.8 0.8,3.4 5.2,0"],
  ">": [6, "0.8,6.8 5.2,3.4 0.8,0"],
  "/": [5, "0.2,0 4.8,10"],
  "'": [2.4, "1.3,10 1,7.6"],
  "(": [4.5, "4,9.8 1.8,7 1.2,5 1.8,3 4,0.2"],
  ")": [4.5, "0.5,9.8 2.7,7 3.3,5 2.7,3 0.5,0.2"],
  "!": [2.6, "1.3,10 1.3,3|1.3,0 1.3,0"],
  "?": [6.5, "0.9,8.3 2.2,10 4.3,10 5.6,8.5 5.4,6.7 3.4,5.4 3.3,3.4|3.3,0 3.3,0"],
};

interface Glyph {
  w: number;
  strokes: Array<Array<[number, number]>>;
}
const GLYPHS: Record<string, Glyph> = {};
for (const [ch, [w, data]] of Object.entries(F)) {
  GLYPHS[ch] = {
    w,
    strokes: data
      ? data.split("|").map((s) => s.split(" ").map((p) => p.split(",").map(Number) as [number, number]))
      : [],
  };
}

interface TextOpt {
  lw?: number; // stroke width as a fraction of cap size
  ls?: number; // extra letter spacing, px
  align?: "left" | "center" | "right";
  mono?: number; // fixed advance per char, px (0 = proportional)
  angle?: number; // rotation, radians, clockwise
  alpha?: number;
  bold?: boolean;
}

function charAdvance(ch: string, size: number, o: TextOpt): number {
  if (o.mono) return o.mono;
  const g = GLYPHS[ch] ?? GLYPHS[" "];
  return (g.w + 1.7) * (size / 10) + (o.ls ?? 0);
}

function textWidth(text: string, size: number, o: TextOpt): number {
  let w = 0;
  for (const ch of text) w += charAdvance(ch, size, o);
  return w - (o.ls ?? 0);
}

// Draw text with baseline starting at (x, y); glyph-local point (lx right,
// ly up) maps to screen (x + lx*cosA + ly*sinA, y + lx*sinA - ly*cosA).
function drawText(text: string, x: number, y: number, size: number, col: RGB, o: TextOpt = {}): void {
  const scale = size / 10;
  const lw = size * (o.lw ?? 0.115);
  const A = o.angle ?? 0;
  const cosA = Math.cos(A), sinA = Math.sin(A);
  const alpha = o.alpha ?? 1;
  let startX = x;
  if (o.align === "center") startX = x - textWidth(text, size, o) / 2;
  else if (o.align === "right") startX = x - textWidth(text, size, o);
  const passes: Array<[number, number]> = o.bold ? [[0, 0], [lw * 0.38, 0]] : [[0, 0]];
  for (const [ox, oy] of passes) {
    let pen = 0;
    for (const ch of text) {
      const g = GLYPHS[ch] ?? GLYPHS[" "];
      for (const stroke of g.strokes) {
        const pts: Array<[number, number]> = stroke.map(([gx, gy]) => {
          const lx = pen + gx * scale + ox;
          const ly = gy * scale + oy;
          return [startX + lx * cosA + ly * sinA, y + lx * sinA - ly * cosA];
        });
        polyline(pts, lw, col, alpha);
      }
      pen += charAdvance(ch, size, o);
    }
  }
}

// Text along a circular arc (for the round stamp). side "top": letters sit
// on the circle reading left-to-right over the top; "bottom": under the
// bottom, tops of letters pointing to the centre.
function drawArcText(
  text: string,
  cx: number,
  cy: number,
  r: number,
  size: number,
  col: RGB,
  side: "top" | "bottom",
  o: TextOpt = {},
): void {
  const chars = [...text];
  const advs = chars.map((ch) => charAdvance(ch, size, o));
  const total = advs.reduce((s, v) => s + v, 0);
  let cum = -total / 2;
  chars.forEach((ch, i) => {
    const adv = advs[i];
    const mid = cum + adv / 2;
    cum += adv;
    let theta: number, ang: number;
    if (side === "top") {
      theta = -Math.PI / 2 + mid / r;
      ang = theta + Math.PI / 2;
    } else {
      theta = Math.PI / 2 - mid / r;
      ang = theta - Math.PI / 2;
    }
    const px = cx + r * Math.cos(theta);
    const py = cy + r * Math.sin(theta);
    // shift origin back along the baseline direction by half the advance
    const ox = px - Math.cos(ang) * (adv / 2);
    const oy = py - Math.sin(ang) * (adv / 2);
    drawText(ch, ox, oy, size, col, { ...o, angle: ang });
  });
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

const DESK = C("#454f4c");
const PAPER_L = C("#f8f2e0");
const PAPER_R = C("#f6efdb");
const NAVY = C("#1d2a4a");
const LABEL = C("#5a6a86");
const RULE = C("#b9ac8d");
const FRAME = C("#a4956f");
const GUIL = C("#6e82a0");
const VALUE = C("#1d2a4a");
const DARKTXT = C("#333a44");

// ---------------------------------------------------------------------------
// Background: desk, shadow, pages
// ---------------------------------------------------------------------------

fillRect(0, 0, W, H, DESK);
// sparse desk speckle
for (let i = 0; i < 2600; i++) {
  const x = rnd() * W, y = rnd() * H;
  blendPx(Math.round(x * SS), Math.round(y * SS), rnd() > 0.5 ? C("#59635f") : C("#39413f"), 0.25);
}
// soft shadow under the spread
for (let i = 0; i < 3; i++) fillRect(14 + i * 3, 20 + i * 3, 1004, 748, C("#14181a"), 0.13);

const PAGE_Y = 10, PAGE_H = 748;
const PL = { x: 8, w: 496 }; // left page:  8..504
const PR = { x: 520, w: 496 }; // right page: 520..1016
fillRect(PL.x, PAGE_Y, PL.w, PAGE_H, PAPER_L);
fillRect(PR.x, PAGE_Y, PR.w, PAGE_H, PAPER_R);

// gentle paper mottling
for (let i = 0; i < 90; i++) {
  const onLeft = rnd() > 0.5;
  const cx = (onLeft ? PL.x : PR.x) + rnd() * PL.w;
  const cy = PAGE_Y + rnd() * PAGE_H;
  disc(cx, cy, 30 + rnd() * 120, rnd() > 0.5 ? C("#efe6cc") : C("#fdfaf0"), 0.05);
}

// faint wavy guilloche field printed across each page
function waveField(px: number): void {
  for (let yy = PAGE_Y + 30; yy < PAGE_Y + PAGE_H - 24; yy += 13) {
    const pts: Array<[number, number]> = [];
    for (let xx = px + 18; xx <= px + PL.w - 18; xx += 8) {
      pts.push([xx, yy + Math.sin(xx * 0.045 + yy * 0.7) * 1.7]);
    }
    polyline(pts, 0.8, GUIL, 0.05);
  }
}
waveField(PL.x);
waveField(PR.x);

// guilloche border: two wavy nested perimeters + a straight printed frame
function guillocheBorder(px: number): void {
  for (const [inset, amp, freq, phase, alpha] of [
    [13, 2.1, 0.11, 0, 0.30],
    [19, 1.5, 0.13, 2.2, 0.22],
  ] as Array<[number, number, number, number, number]>) {
    const x0 = px + inset, x1 = px + PL.w - inset;
    const y0 = PAGE_Y + inset, y1 = PAGE_Y + PAGE_H - inset;
    const pts: Array<[number, number]> = [];
    const per = 2 * (x1 - x0 + (y1 - y0));
    const steps = 340;
    for (let s = 0; s <= steps; s++) {
      let d = (s / steps) * per;
      let x: number, y: number, nx = 0, ny = 0;
      if (d < x1 - x0) { x = x0 + d; y = y0; ny = -1; }
      else if ((d -= x1 - x0) < y1 - y0) { x = x1; y = y0 + d; nx = 1; }
      else if ((d -= y1 - y0) < x1 - x0) { x = x1 - d; y = y1; ny = 1; }
      else { d -= x1 - x0; x = x0; y = y1 - d; nx = -1; }
      const off = amp * Math.sin((s / steps) * per * freq + phase);
      pts.push([x + nx * off, y + ny * off]);
    }
    polyline(pts, 0.9, GUIL, alpha);
  }
  rectStroke(px + 24, PAGE_Y + 24, PL.w - 48, PAGE_H - 48, 0.8, FRAME, 0.55);
  // corner rosettes
  for (const [cx, cy] of [
    [px + 38, PAGE_Y + 38],
    [px + PL.w - 38, PAGE_Y + 38],
    [px + 38, PAGE_Y + PAGE_H - 38],
    [px + PL.w - 38, PAGE_Y + PAGE_H - 38],
  ] as Array<[number, number]>) {
    const pts: Array<[number, number]> = [];
    for (let s = 0; s <= 90; s++) {
      const t = (s / 90) * Math.PI * 2;
      const r = 7 + 3.2 * Math.sin(5 * t);
      pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
    }
    polyline(pts, 0.8, GUIL, 0.30);
  }
}
guillocheBorder(PL.x);
guillocheBorder(PR.x);

// spine shadow down the centre fold
for (let xx = 470; xx <= 554; xx++) {
  const t = Math.sin(((xx - 470) / 84) * Math.PI); // 0..1..0
  fillRect(xx, PAGE_Y, 1, PAGE_H, C("#6b5f45"), 0.16 * t);
}

// ---------------------------------------------------------------------------
// Emblem: lighthouse over three wave lines, inside a double circle
// ---------------------------------------------------------------------------

function drawEmblem(cx: number, cy: number, r: number, col: RGB, alpha: number, lwMul = 1): void {
  circleStroke(cx, cy, r, 1.6 * lwMul, col, alpha);
  circleStroke(cx, cy, r * 0.86, 0.7 * lwMul, col, alpha);
  const s = r / 33; // design was made for r=33
  // lamp room + dome
  polyFill([[cx - 5 * s, cy - 16 * s], [cx + 5 * s, cy - 16 * s], [cx + 5 * s, cy - 24 * s], [cx - 5 * s, cy - 24 * s]], C("#c9a227"), alpha);
  polyFill([[cx - 6.5 * s, cy - 24 * s], [cx + 6.5 * s, cy - 24 * s], [cx, cy - 31 * s]], col, alpha);
  // tower
  polyFill([[cx - 7.5 * s, cy + 12 * s], [cx - 4.5 * s, cy - 16 * s], [cx + 4.5 * s, cy - 16 * s], [cx + 7.5 * s, cy + 12 * s]], col, alpha);
  // door
  polyFill([[cx - 2 * s, cy + 12 * s], [cx - 2 * s, cy + 4 * s], [cx + 2 * s, cy + 4 * s], [cx + 2 * s, cy + 12 * s]], C("#f8f2e0"), alpha);
  // waves
  for (let k = 0; k < 3; k++) {
    const wy = cy + (17 + k * 5.5) * s;
    const pts: Array<[number, number]> = [];
    for (let xx = -20; xx <= 20; xx += 2) pts.push([cx + xx * s, wy + Math.sin(xx * 0.32 + k * 1.7) * 1.6 * s]);
    polyline(pts, 1.6 * lwMul, col, alpha);
  }
}

// ---------------------------------------------------------------------------
// LEFT PAGE — data page
// ---------------------------------------------------------------------------

drawEmblem(256, 74, 33, NAVY, 0.92);
drawText("REPUBLIC OF VESSALIA", 256, 148, 20, NAVY, { align: "center", ls: 2, bold: true });
drawText("PASSPORT · PASAPORT", 256, 171, 10.5, LABEL, { align: "center", ls: 3 });
line(36, 186, 476, 186, 0.9, RULE, 0.9);

// --- portrait ---
const PB = { x: 36, y: 208, w: 140, h: 180 }; // portrait box
// backdrop gradient
for (let yy = 0; yy < PB.h; yy++) {
  const t = yy / PB.h;
  const col: RGB = [
    195 + (157 - 195) * t,
    210 + (178 - 210) * t,
    221 + (194 - 221) * t,
  ];
  fillRect(PB.x, PB.y + yy, PB.w, 1, col);
}
const PCX = PB.x + PB.w / 2; // 106
// hair (back mass + bun)
ellipseFill(PCX + 20, 244, 13, 13, C("#38291d")); // bun
ellipseFill(PCX, 282, 40, 50, C("#38291d"));
// neck + shoulders / jacket
fillRect(PCX - 9, 326, 18, 24, C("#e3b28a"));
polyFill([[PB.x + 6, 388], [PB.x + 26, 348], [PCX - 14, 336], [PCX + 14, 336], [PB.x + 114, 348], [PB.x + 134, 388]], C("#22355c"));
// blouse V
polyFill([[PCX - 14, 336], [PCX + 14, 336], [PCX, 368]], C("#f4efe4"));
// face
ellipseFill(PCX, 296, 31, 40, C("#eec39b"));
// hair cap over the forehead + side strands
ellipseFill(PCX, 268, 34, 25, C("#38291d"));
ellipseFill(PCX, 300, 30, 38, C("#eec39b"));
polyFill([[PCX - 36, 268], [PCX - 29, 268], [PCX - 30, 330], [PCX - 37, 330]], C("#38291d"));
polyFill([[PCX + 29, 268], [PCX + 36, 268], [PCX + 37, 330], [PCX + 30, 330]], C("#38291d"));
// features
line(PCX - 19, 292, PCX - 7, 290, 2, C("#4a3826"), 0.9); // brow
line(PCX + 7, 290, PCX + 19, 292, 2, C("#4a3826"), 0.9);
polyline([[PCX - 18, 302], [PCX - 12, 299], [PCX - 6, 302]], 1.7, C("#2c2620"), 0.95); // eye
polyline([[PCX + 6, 302], [PCX + 12, 299], [PCX + 18, 302]], 1.7, C("#2c2620"), 0.95);
disc(PCX - 12, 302.5, 1.6, C("#2c2620"), 0.95);
disc(PCX + 12, 302.5, 1.6, C("#2c2620"), 0.95);
polyline([[PCX, 304], [PCX - 2, 313], [PCX + 2, 314]], 1.3, C("#c98f66"), 0.9); // nose
polyline([[PCX - 9, 326], [PCX, 329], [PCX + 9, 326]], 2, C("#b96a5e"), 0.95); // mouth
// portrait frame + photo corners
rectStroke(PB.x, PB.y, PB.w, PB.h, 1.1, C("#7a7a72"), 0.9);
for (const [cx, cy, dx, dy] of [
  [PB.x, PB.y, 1, 1],
  [PB.x + PB.w, PB.y, -1, 1],
  [PB.x, PB.y + PB.h, 1, -1],
  [PB.x + PB.w, PB.y + PB.h, -1, -1],
] as Array<[number, number, number, number]>) {
  polyFill([[cx, cy], [cx + 13 * dx, cy], [cx, cy + 13 * dy]], C("#3f3d36"), 0.85);
}
// hologram ring overlapping the bottom-right corner
{
  const hx = PB.x + PB.w - 28, hy = PB.y + PB.h - 28;
  circleStroke(hx, hy, 24, 2.2, C("#37b6c9"), 0.45, 0.3, 3.6);
  circleStroke(hx, hy, 24, 2.2, C("#d35fa0"), 0.45, 3.4, 6.4);
  circleStroke(hx, hy, 18.5, 1.4, C("#c9a227"), 0.5, 1.2, 5.2);
  const star: Array<[number, number]> = [];
  for (let i = 0; i < 10; i++) {
    const t = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 === 0 ? 8 : 3.4;
    star.push([hx + rr * Math.cos(t), hy + rr * Math.sin(t)]);
  }
  polyFill(star, C("#ffffff"), 0.55);
}

// --- data fields ---
function field(x: number, yLabel: number, label: string, value: string, w = 282): void {
  drawText(label, x, yLabel, 8, LABEL, { ls: 0.8 });
  drawText(value, x, yLabel + 17, 14.5, VALUE, { ls: 0.4 });
  line(x, yLabel + 24, x + w, yLabel + 24, 0.7, RULE, 0.65);
}
const RX = 196; // right column x
field(RX, 216, "TYPE / TIP", "P", 120);
field(RX + 150, 216, "CODE / COD", "VES", 132);
field(RX, 256, "PASSPORT NO. / PASAPORT NR.", "V4829107");
field(RX, 296, "SURNAME / NUME", "MARLOWE");
field(RX, 336, "GIVEN NAMES / PRENUME", "JUNE AURELIA");
field(RX, 376, "NATIONALITY / CETATENIE", "VESSALIAN");
const FX = 36; // full-width column x
field(FX, 428, "DATE OF BIRTH / DATA NASTERII", "14 MAR 1991", 214);
field(FX + 244, 428, "SEX / SEX", "F", 200);
field(FX, 468, "PLACE OF BIRTH / LOCUL NASTERII", "PORT ANSELM", 444);
field(FX, 508, "DATE OF ISSUE / DATA EMITERII", "02 MAY 2022", 214);
field(FX + 244, 508, "EXPIRY / EXPIRARII", "02 MAY 2032", 200);
field(FX, 548, "AUTHORITY / AUTORITATE", "MINISTRY OF THE INTERIOR", 444);
// observations
drawText("OBSERVATIONS / OBSERVATII", FX, 590, 8, LABEL, { ls: 0.8 });
drawText("The holder may not photograph the Royal Lighthouse.", FX, 608, 10, DARKTXT, { lw: 0.1 });

// --- machine-readable zone ---
fillRect(24, 642, 464, 100, C("#fbf7ea"), 1);
line(24, 642, 488, 642, 0.9, RULE, 0.9);
const MRZ1 = "P<VESMARLOWE<<JUNE<AURELIA" + "<".repeat(18);
const MRZ2 = "V4829107<4VES9103145F3205028" + "<".repeat(12) + "06";
const mrzAdv = 456 / Math.max(MRZ1.length, MRZ2.length);
drawText(MRZ1, 28, 692, 13.5, C("#20242a"), { mono: mrzAdv, lw: 0.13 });
drawText(MRZ2, 28, 724, 13.5, C("#20242a"), { mono: mrzAdv, lw: 0.13 });

drawText("3", 30, 750, 10, FRAME, {});

// ---------------------------------------------------------------------------
// RIGHT PAGE — visas / stamps
// ---------------------------------------------------------------------------

drawText("VISAS", 768, 66, 15, NAVY, { align: "center", ls: 4, bold: true });
line(566, 60, 692, 60, 0.9, RULE, 0.9);
line(844, 60, 970, 60, 0.9, RULE, 0.9);


interface StampLine {
  text: string;
  size: number;
  ls?: number;
  bold?: boolean;
}

// local-to-global transform for a rotated stamp centred at (cx, cy)
function rotator(cx: number, cy: number, ang: number) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return (lx: number, ly: number): [number, number] => [cx + lx * c - ly * s, cy + lx * s + ly * c];
}

function stampSpeckle(cx: number, cy: number, w: number, h: number, ang: number): void {
  const T = rotator(cx, cy, ang);
  for (let i = 0; i < 130; i++) {
    const [sx, sy] = T((rnd() - 0.5) * w, (rnd() - 0.5) * h);
    disc(sx, sy, 0.8 + rnd() * 0.9, PAPER_R, 0.16 + rnd() * 0.14);
  }
}

function rectStamp(
  cx: number, cy: number, w: number, h: number, angDeg: number,
  ink: RGB, lines: StampLine[], double = true,
): void {
  const ang = (angDeg * Math.PI) / 180;
  const T = rotator(cx, cy, ang);
  const corner = (lx: number, ly: number) => T(lx, ly);
  for (const pass of [0.5, 0.32] as const) {
    const off = pass === 0.5 ? 0 : 0.7;
    const rect: Array<[number, number]> = [
      corner(-w / 2 + off, -h / 2 + off), corner(w / 2 + off, -h / 2 + off),
      corner(w / 2 + off, h / 2 + off), corner(-w / 2 + off, h / 2 + off),
    ];
    polyline(rect, 2.3, ink, pass, true);
    if (double) {
      const r2: Array<[number, number]> = [
        corner(-w / 2 + 5 + off, -h / 2 + 5 + off), corner(w / 2 - 5 + off, -h / 2 + 5 + off),
        corner(w / 2 - 5 + off, h / 2 - 5 + off), corner(-w / 2 + 5 + off, h / 2 - 5 + off),
      ];
      polyline(r2, 0.9, ink, pass, true);
    }
  }
  // stack the lines, centred
  const heights = lines.map((l) => l.size * 1.52);
  const total = heights.reduce((s, v) => s + v, 0);
  let ly = -total / 2;
  lines.forEach((l, i) => {
    ly += heights[i];
    const [tx, ty] = T(0, ly - l.size * 0.35);
    drawText(l.text, tx, ty, l.size, ink, {
      align: "center", angle: ang, alpha: 0.82, ls: l.ls ?? 0, bold: l.bold, lw: 0.13,
    });
  });
  stampSpeckle(cx, cy, w, h, ang);
}

function ovalStamp(
  cx: number, cy: number, rx: number, ry: number, angDeg: number,
  ink: RGB, lines: StampLine[],
): void {
  const ang = (angDeg * Math.PI) / 180;
  const T = rotator(cx, cy, ang);
  for (const pass of [0.5, 0.32] as const) {
    const off = pass === 0.5 ? 0 : 0.7;
    for (const [rrx, rry, lw] of [[rx, ry, 2.3], [rx - 6, ry - 5, 0.9]] as Array<[number, number, number]>) {
      const pts: Array<[number, number]> = [];
      for (let s = 0; s <= 72; s++) {
        const t = (s / 72) * Math.PI * 2;
        pts.push(T(rrx * Math.cos(t) + off, rry * Math.sin(t) + off));
      }
      polyline(pts, lw, ink, pass);
    }
  }
  const heights = lines.map((l) => l.size * 1.52);
  const total = heights.reduce((s, v) => s + v, 0);
  let ly = -total / 2;
  lines.forEach((l, i) => {
    ly += heights[i];
    const [tx, ty] = T(0, ly - l.size * 0.35);
    drawText(l.text, tx, ty, l.size, ink, {
      align: "center", angle: ang, alpha: 0.82, ls: l.ls ?? 0, bold: l.bold, lw: 0.13,
    });
  });
  stampSpeckle(cx, cy, rx * 2, ry * 2, ang);
}

const INK_BLUE = C("#2456a8");
const INK_VIOLET = C("#6a3fa0");
const INK_RED = C("#b03030");
const INK_BLACK = C("#1e1e22");
const INK_DARKBLUE = C("#203050");
const INK_GREEN = C("#1e7a46");

rectStamp(672, 168, 236, 84, -6, INK_BLUE, [
  { text: "KORDAVIA", size: 15, bold: true },
  { text: "ARRIVAL", size: 11, ls: 2 },
  { text: "17 JUN 2023", size: 13 },
]);
rectStamp(838, 318, 236, 84, 4, INK_VIOLET, [
  { text: "KORDAVIA", size: 15, bold: true },
  { text: "DEPARTURE", size: 11, ls: 2 },
  { text: "29 JUN 2023", size: 13 },
]);
ovalStamp(700, 452, 138, 54, -3, INK_RED, [
  { text: "SARENNE FEDERATION", size: 12.5, bold: true },
  { text: "ARRIVAL", size: 10.5, ls: 2 },
  { text: "03 OCT 2023", size: 12.5 },
]);
// round Ostravia ferry stamp
{
  const cx = 884, cy = 566, ink = INK_BLACK;
  for (const pass of [0.5, 0.32] as const) {
    const off = pass === 0.5 ? 0 : 0.6;
    circleStroke(cx + off, cy + off, 60, 2.3, ink, pass);
    circleStroke(cx + off, cy + off, 43, 0.9, ink, pass);
  }
  drawArcText("OSTRAVIA", cx, cy, 51.5, 11, ink, "top", { alpha: 0.82, lw: 0.13, bold: true });
  drawArcText("PORT ANSELM FERRY", cx, cy, 51.5, 8, ink, "bottom", { alpha: 0.82, lw: 0.13 });
  // little ferry in the middle
  polyline([[cx - 16, cy + 2], [cx + 16, cy + 2], [cx + 11, cy + 9], [cx - 11, cy + 9]], 1.8, ink, 0.82, true);
  line(cx, cy + 2, cx, cy - 8, 1.8, ink, 0.82);
  polyline([[cx, cy - 8], [cx + 8, cy - 2], [cx, cy - 2]], 1.4, ink, 0.82, true);
  drawText("12 JAN 2024", cx, cy + 26, 11.5, ink, { align: "center", alpha: 0.85, lw: 0.13 });
  stampSpeckle(cx, cy, 118, 118, 0.14);
}
rectStamp(678, 606, 240, 84, -8, INK_DARKBLUE, [
  { text: "MERIDIA", size: 15, bold: true },
  { text: "DEPARTURE", size: 11, ls: 2 },
  { text: "08 SEP 2024", size: 13 },
]);
rectStamp(700, 706, 216, 40, 2, INK_GREEN, [
  { text: "VISA FEE PAID · 40 VESSALS", size: 10.5 },
], false);

drawText("4", 994, 750, 10, FRAME, { align: "right" });

// ---------------------------------------------------------------------------
// Downscale + PNG encode
// ---------------------------------------------------------------------------

const out = new Uint8Array(W * H * 3);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < SS; dy++) {
      for (let dx = 0; dx < SS; dx++) {
        const i = ((y * SS + dy) * BW + (x * SS + dx)) * 3;
        r += buf[i];
        g += buf[i + 1];
        b += buf[i + 2];
      }
    }
    const n = SS * SS;
    const o = (y * W + x) * 3;
    out[o] = Math.max(0, Math.min(255, Math.round(r / n)));
    out[o + 1] = Math.max(0, Math.min(255, Math.round(g / n)));
    out[o + 2] = Math.max(0, Math.min(255, Math.round(b / n)));
  }
}

const crcTable: number[] = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w: number, h: number, rgb: Uint8Array): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter: none
    raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

const png = encodePNG(W, H, out);
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "entry.png");
writeFileSync(outPath, png);
console.log(`wrote ${outPath} (${png.length} bytes, ${W}x${H})`);
