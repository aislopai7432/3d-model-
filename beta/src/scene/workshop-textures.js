// Canvas-generated textures for the workshop environment (no image assets). Everything here is drawn
// with cheap 2D canvas operations (patterns, gradients, text) plus a few small per-pixel noise tiles so
// the whole set builds in a few tens of milliseconds.
import * as THREE from 'three';

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// deterministic PRNG so the shop looks the same on every load
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(x, y, s) {
  let n = (x * 374761393 + y * 668265263 + s * 2246822519) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function vnoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const p = (a) => ((a % period) + period) % period;
  const a = hash(p(xi), p(yi), seed), b = hash(p(xi + 1), p(yi), seed);
  const c = hash(p(xi), p(yi + 1), seed), d = hash(p(xi + 1), p(yi + 1), seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

// Grey-scale tileable noise tile (fbm), values mapped to lo..hi.
export function noiseCanvas(size, cells, seed, lo, hi, oct = 3, grain = 0) {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const sc = cells / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0, a = 0.5, f = 1, n = 0;
      for (let o = 0; o < oct; o++) {
        s += a * vnoise(x * sc * f, y * sc * f, cells * f, seed + o * 17);
        n += a; a *= 0.5; f *= 2;
      }
      let v = lo + (s / n) * (hi - lo);
      if (grain) v += (hash(x, y, seed + 99) - 0.5) * grain;
      const i = (y * size + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function canvasTex(c, { srgb = true, repeat = true, aniso = 8, rotation = 0 } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (rotation) { t.center.set(0.5, 0.5); t.rotation = rotation; }
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------- surfaces

// Sealed concrete floor tile (covers 4 x 4 m in world): mottled, fine aggregate, a saw-cut joint
// on two edges so the tiling produces a 4 m joint grid.
export function concreteCanvas() {
  const S = 1024;
  const c = makeCanvas(S, S);
  const ctx = c.getContext('2d');
  const big = noiseCanvas(128, 4, 41, 0, 255, 4);
  ctx.fillStyle = '#8c8e8c';
  ctx.fillRect(0, 0, S, S);
  ctx.globalAlpha = 0.32;
  ctx.globalCompositeOperation = 'overlay';
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(big, 0, 0, S, S);
  ctx.globalCompositeOperation = 'source-over';
  const fine = noiseCanvas(128, 16, 43, 0, 255, 2, 120);
  ctx.globalAlpha = 0.13;
  ctx.fillStyle = ctx.createPattern(fine, 'repeat');
  ctx.fillRect(0, 0, S, S);
  ctx.globalAlpha = 1;
  const r = rng(7);
  // aggregate speckles
  for (let i = 0; i < 2600; i++) {
    const v = r() < 0.5 ? 70 + r() * 30 : 150 + r() * 40;
    ctx.fillStyle = `rgba(${v},${v},${v - 4},${0.25 + r() * 0.3})`;
    ctx.fillRect(r() * S, r() * S, 1 + r() * 2, 1 + r() * 2);
  }
  // soft scuffs / tyre marks
  ctx.lineCap = 'round';
  for (let i = 0; i < 14; i++) {
    ctx.strokeStyle = `rgba(40,40,38,${0.035 + r() * 0.04})`;
    ctx.lineWidth = 8 + r() * 30;
    ctx.beginPath();
    const x = r() * S, y = r() * S, a = r() * Math.PI;
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + Math.cos(a) * 160, y + Math.sin(a) * 160 + 40, x + Math.cos(a) * 320, y + Math.sin(a) * 320);
    ctx.stroke();
  }
  // saw-cut joints along two edges (the tile repeats every 4 m)
  ctx.fillStyle = 'rgba(30,30,30,0.75)';
  ctx.fillRect(0, 0, S, 2);
  ctx.fillRect(0, 0, 2, S);
  ctx.fillStyle = 'rgba(200,200,196,0.25)';
  ctx.fillRect(0, 2, S, 1);
  ctx.fillRect(2, 0, 1, S);
  return c;
}

// Oil stains / tyre marks atlas (2 x 2 variants), drawn as alpha decals.
export function stainCanvas() {
  const S = 512, h = S / 2;
  const c = makeCanvas(S, S);
  const ctx = c.getContext('2d');
  const r = rng(19);
  for (let k = 0; k < 4; k++) {
    const ox = (k % 2) * h, oy = Math.floor(k / 2) * h;
    const blobs = 5 + Math.floor(r() * 6);
    for (let i = 0; i < blobs; i++) {
      const x = ox + h * (0.3 + r() * 0.4), y = oy + h * (0.3 + r() * 0.4), rad = h * (0.08 + r() * 0.2);
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      const a = k === 3 ? 0.25 : 0.45;
      g.addColorStop(0, `rgba(22,20,16,${a})`);
      g.addColorStop(0.6, `rgba(28,26,20,${a * 0.6})`);
      g.addColorStop(1, 'rgba(30,28,22,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return c;
}

// Painted blockwork: 4 blocks x 8 courses of 440 x 215 mm (1760 x 1720 mm).
export function blockCanvas() {
  const W = 512, H = 500;
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#d4d4d0';
  ctx.fillRect(0, 0, W, H);
  const r = rng(3);
  const bw = W / 4, bh = H / 8;
  for (let row = 0; row < 8; row++) {
    const off = row % 2 ? bw / 2 : 0;
    for (let col = -1; col < 5; col++) {
      const x = col * bw + off;
      const v = 205 + r() * 16;
      ctx.fillStyle = `rgb(${v},${v},${v - 3})`;
      ctx.fillRect(x + 2, row * bh + 2, bw - 3, bh - 3);
    }
  }
  const fine = noiseCanvas(64, 8, 5, 0, 255, 2, 160);
  ctx.globalAlpha = 0.12;
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = ctx.createPattern(fine, 'repeat');
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  // mortar joints (painted over, slightly recessed -> darker)
  ctx.fillStyle = 'rgba(120,120,116,0.55)';
  for (let row = 0; row <= 8; row++) ctx.fillRect(0, row * bh - 1, W, 2.5);
  for (let row = 0; row < 8; row++) {
    const off = row % 2 ? bw / 2 : 0;
    for (let col = -1; col < 5; col++) ctx.fillRect(col * bw + off - 1, row * bh, 2.5, bh);
  }
  return c;
}

// Trapezoidal profiled sheet (ribs vary along U): 4 ribs per tile.
export function corrugatedCanvas(vertical = false) {
  const N = 256;
  const c = vertical ? makeCanvas(8, N) : makeCanvas(N, 8);
  const ctx = c.getContext('2d');
  const prof = (t) => {
    // t in 0..1 over one rib: flat pan, slope, crown, slope
    const p = t % 1;
    if (p < 0.5) return 0.78;
    if (p < 0.6) return 0.95;
    if (p < 0.8) return 1.0;
    if (p < 0.9) return 0.55;
    return 0.72;
  };
  for (let i = 0; i < N; i++) {
    const v = Math.round(255 * prof((i / N) * 4));
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    if (vertical) ctx.fillRect(0, i, 8, 1);
    else ctx.fillRect(i, 0, 1, 8);
  }
  return c;
}

// Roller shutter slats (vary along V).
export function slatCanvas() {
  const c = makeCanvas(8, 128);
  const ctx = c.getContext('2d');
  for (let i = 0; i < 128; i++) {
    const p = (i % 32) / 32;
    const v = p < 0.08 ? 120 : p < 0.5 ? 235 - p * 60 : 205 - (p - 0.5) * 80;
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(0, i, 8, 1);
  }
  return c;
}

export function woodCanvas() {
  const S = 256;
  const c = makeCanvas(S, S);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#b48a58';
  ctx.fillRect(0, 0, S, S);
  const r = rng(11);
  for (let i = 0; i < 90; i++) {
    const y = r() * S;
    const v = r() < 0.5 ? 'rgba(110,72,38,' : 'rgba(214,176,124,';
    ctx.strokeStyle = v + (0.08 + r() * 0.18) + ')';
    ctx.lineWidth = 0.6 + r() * 2.2;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= S; x += 32) ctx.lineTo(x, y + Math.sin(x * 0.03 + i) * (1 + r() * 2));
    ctx.stroke();
  }
  return c;
}

export function graniteCanvas() {
  const S = 256;
  const c = makeCanvas(S, S);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#2b2c2f';
  ctx.fillRect(0, 0, S, S);
  const r = rng(23);
  for (let i = 0; i < 6000; i++) {
    const v = r() < 0.75 ? 18 + r() * 18 : 70 + r() * 60;
    ctx.fillStyle = `rgba(${v},${v},${v + 3},${0.35 + r() * 0.4})`;
    const s = 0.6 + r() * 1.4;
    ctx.fillRect(r() * S, r() * S, s, s);
  }
  return c;
}

export function rubberMatCanvas() {
  const c = makeCanvas(64, 64);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#1f2022';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = '#323437';
  for (const [x, y] of [[16, 16], [48, 48]]) {
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

export function corkCanvas() {
  const S = 256;
  const c = makeCanvas(S, S);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#a77a4a';
  ctx.fillRect(0, 0, S, S);
  const r = rng(29);
  for (let i = 0; i < 5000; i++) {
    const k = r();
    const col = k < 0.4 ? [120, 82, 46] : k < 0.75 ? [190, 146, 96] : [150, 108, 64];
    ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${0.4 + r() * 0.5})`;
    ctx.fillRect(r() * S, r() * S, 1 + r() * 2.5, 1 + r() * 2.5);
  }
  return c;
}

// ---------------------------------------------------------------- decal atlas (signs, posters, labels)

const FONT = 'Arial, Helvetica, sans-serif';

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function textFit(ctx, str, x, y, maxW, size, weight = 700) {
  let s = size;
  ctx.font = `${weight} ${s}px ${FONT}`;
  while (ctx.measureText(str).width > maxW && s > 8) {
    s -= 1;
    ctx.font = `${weight} ${s}px ${FONT}`;
  }
  ctx.fillText(str, x, y);
}

// pictograms (white on coloured background), drawn in a 100 x 100 box centred at (cx, cy) scaled by k
function pictoGlasses(ctx, cx, cy, k) {
  ctx.save();
  ctx.translate(cx, cy); ctx.scale(k, k);
  ctx.fillStyle = '#fff';
  // head
  ctx.beginPath(); ctx.ellipse(0, -2, 30, 36, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#1c5aa6';
  rr(ctx, -30, -12, 28, 16, 5); ctx.fill();
  rr(ctx, 2, -12, 28, 16, 5); ctx.fill();
  ctx.fillRect(-34, -8, 68, 4);
  ctx.restore();
}
function pictoEars(ctx, cx, cy, k) {
  ctx.save();
  ctx.translate(cx, cy); ctx.scale(k, k);
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.ellipse(0, 4, 26, 32, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 8;
  ctx.beginPath(); ctx.arc(0, 0, 40, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
  ctx.fillRect(-46, -8, 16, 30); ctx.fillRect(30, -8, 16, 30);
  ctx.restore();
}
function pictoBoot(ctx, cx, cy, k) {
  ctx.save();
  ctx.translate(cx, cy); ctx.scale(k, k);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(-28, -40); ctx.lineTo(4, -40); ctx.lineTo(6, 4); ctx.lineTo(38, 14);
  ctx.quadraticCurveTo(44, 18, 42, 30); ctx.lineTo(-30, 30); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#1c5aa6'; ctx.fillRect(-30, 22, 72, 3);
  ctx.restore();
}
function pictoGloves(ctx, cx, cy, k) {
  ctx.save();
  ctx.translate(cx, cy); ctx.scale(k, k);
  ctx.fillStyle = '#fff';
  rr(ctx, -20, -6, 40, 44, 8); ctx.fill();
  for (let i = 0; i < 4; i++) { rr(ctx, -20 + i * 10.5, -40, 8.5, 40, 4); ctx.fill(); }
  ctx.save(); ctx.translate(-20, 6); ctx.rotate(-0.7); rr(ctx, -6, -26, 10, 30, 5); ctx.fill(); ctx.restore();
  ctx.restore();
}
function pictoRotating(ctx, cx, cy, k) {
  ctx.save();
  ctx.translate(cx, cy); ctx.scale(k, k);
  ctx.strokeStyle = '#111'; ctx.lineWidth = 7;
  ctx.beginPath(); ctx.arc(0, 0, 22, 0.3, Math.PI * 1.7); ctx.stroke();
  ctx.fillStyle = '#111';
  ctx.beginPath(); ctx.moveTo(24, -18); ctx.lineTo(30, 4); ctx.lineTo(10, -2); ctx.fill();
  // hand
  rr(ctx, -6, 6, 12, 30, 5); ctx.fill();
  ctx.restore();
}
function pictoCross(ctx, cx, cy, k) {
  ctx.fillStyle = '#fff';
  ctx.fillRect(cx - 12 * k, cy - 36 * k, 24 * k, 72 * k);
  ctx.fillRect(cx - 36 * k, cy - 12 * k, 72 * k, 24 * k);
}
function pictoExtinguisher(ctx, cx, cy, k) {
  ctx.save();
  ctx.translate(cx, cy); ctx.scale(k, k);
  ctx.fillStyle = '#fff';
  rr(ctx, -14, -26, 28, 66, 10); ctx.fill();
  ctx.fillRect(-6, -36, 12, 12);
  ctx.fillRect(6, -36, 22, 6);
  ctx.lineWidth = 5; ctx.strokeStyle = '#fff';
  ctx.beginPath(); ctx.moveTo(-6, -32); ctx.quadraticCurveTo(-34, -30, -30, 10); ctx.stroke();
  ctx.restore();
}
function pictoRunner(ctx, cx, cy, k) {
  ctx.save();
  ctx.translate(cx, cy); ctx.scale(k, k);
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 9; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(6, -34, 9, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.moveTo(2, -20); ctx.lineTo(-6, 8); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-6, 8); ctx.lineTo(10, 22); ctx.lineTo(4, 38); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-6, 8); ctx.lineTo(-22, 26); ctx.lineTo(-34, 24); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-18, -8); ctx.lineTo(0, -18); ctx.lineTo(18, -6); ctx.stroke();
  ctx.restore();
}

function mandatorySign(ctx, x, y, w, h, picto, lines) {
  ctx.fillStyle = '#f2f2ee';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#c9c9c4'; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  const cx = x + w / 2, cy = y + h * 0.36, R = Math.min(w, h) * 0.3;
  ctx.fillStyle = '#1c5aa6';
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
  picto(ctx, cx, cy, R / 52);
  ctx.fillStyle = '#1c5aa6';
  ctx.fillRect(x + 8, y + h * 0.66, w - 16, h * 0.3);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  lines.forEach((l, i) => textFit(ctx, l, cx, y + h * 0.66 + (h * 0.3) * ((i + 0.5) / lines.length), w - 28, Math.round(h * 0.085)));
}

function warningSign(ctx, x, y, w, h, picto, lines) {
  ctx.fillStyle = '#f2f2ee';
  ctx.fillRect(x, y, w, h);
  const cx = x + w / 2, cy = y + h * 0.38, R = Math.min(w, h) * 0.34;
  ctx.fillStyle = '#e9b10e'; ctx.strokeStyle = '#111'; ctx.lineWidth = R * 0.12; ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(cx, cy - R); ctx.lineTo(cx + R * 0.95, cy + R * 0.68); ctx.lineTo(cx - R * 0.95, cy + R * 0.68); ctx.closePath();
  ctx.fill(); ctx.stroke();
  picto(ctx, cx, cy + R * 0.12, R / 70);
  ctx.fillStyle = '#e9b10e';
  ctx.fillRect(x + 8, y + h * 0.68, w - 16, h * 0.28);
  ctx.fillStyle = '#111';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  lines.forEach((l, i) => textFit(ctx, l, cx, y + h * 0.68 + (h * 0.28) * ((i + 0.5) / lines.length), w - 28, Math.round(h * 0.08)));
}

function safeSign(ctx, x, y, w, h, bg, picto, text) {
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 4; ctx.strokeRect(x + 6, y + 6, w - 12, h - 12);
  const s = h * 0.62;
  picto(ctx, x + 14 + s / 2, y + h / 2, s / 100);
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  textFit(ctx, text, x + 14 + s + (w - s - 28) / 2, y + h / 2, w - s - 36, Math.round(h * 0.34));
}

function tablePoster(ctx, x, y, w, h, title, head, rows, accent) {
  ctx.fillStyle = '#ecebe5';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = accent;
  ctx.fillRect(x, y, w, h * 0.13);
  ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  textFit(ctx, title, x + 12, y + h * 0.065, w - 24, Math.round(h * 0.07));
  const top = y + h * 0.17, rh = (h * 0.8) / (rows.length + 1), cw = (w - 20) / head.length;
  ctx.font = `700 ${Math.round(rh * 0.5)}px ${FONT}`;
  ctx.fillStyle = '#222';
  head.forEach((t, i) => ctx.fillText(t, x + 12 + i * cw, top + rh / 2));
  ctx.font = `400 ${Math.round(rh * 0.48)}px ${FONT}`;
  rows.forEach((row, j) => {
    if (j % 2 === 0) { ctx.fillStyle = 'rgba(0,0,0,0.06)'; ctx.fillRect(x + 6, top + rh * (j + 1), w - 12, rh); }
    ctx.fillStyle = '#333';
    row.forEach((t, i) => ctx.fillText(String(t), x + 12 + i * cw, top + rh * (j + 1.5)));
  });
}

// Packs named cells into one 2048 x 2560 canvas; returns { canvas, uv: { name: [u0, v0, u1, v1] } }.
export function decalAtlas() {
  const S = 2048, AH = 2560;
  const c = makeCanvas(S, AH);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#888';
  ctx.fillRect(0, 0, S, AH);
  const uv = {};
  let cx = 0, cy = 0, rowH = 0;
  const cell = (name, w, h, draw) => {
    if (cx + w > S) { cx = 0; cy += rowH + 4; rowH = 0; }
    const x = cx, y = cy;
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    draw(ctx, x, y, w, h);
    ctx.restore();
    uv[name] = [(x + 1) / S, 1 - (y + h - 1) / AH, (x + w - 1) / S, 1 - (y + 1) / AH];
    cx += w + 4;
    rowH = Math.max(rowH, h);
  };
  const SW = 240, SH = 330;
  cell('signGlasses', SW, SH, (k, x, y, w, h) => mandatorySign(k, x, y, w, h, pictoGlasses, ['SAFETY GLASSES', 'MUST BE WORN']));
  cell('signEars', SW, SH, (k, x, y, w, h) => mandatorySign(k, x, y, w, h, pictoEars, ['HEARING PROTECTION', 'MUST BE WORN']));
  cell('signBoots', SW, SH, (k, x, y, w, h) => mandatorySign(k, x, y, w, h, pictoBoot, ['SAFETY FOOTWEAR', 'MUST BE WORN']));
  cell('signGloves', SW, SH, (k, x, y, w, h) => mandatorySign(k, x, y, w, h, pictoGloves, ['NO GLOVES NEAR', 'ROTATING PARTS']));
  cell('signRotating', SW, SH, (k, x, y, w, h) => warningSign(k, x, y, w, h, pictoRotating, ['ROTATING', 'MACHINERY']));
  cell('signSwarf', SW, SH, (k, x, y, w, h) => warningSign(k, x, y, w, h, (q, a, b, s) => {
    q.save(); q.translate(a, b); q.scale(s, s); q.strokeStyle = '#111'; q.lineWidth = 6;
    for (let i = 0; i < 3; i++) { q.beginPath(); q.arc(-14 + i * 14, 4, 10, 0.2, Math.PI * 1.6); q.stroke(); }
    q.restore();
  }, ['SHARP SWARF', 'USE A BRUSH']));
  cell('signFirstAid', 420, 150, (k, x, y, w, h) => safeSign(k, x, y, w, h, '#1d8a4a', pictoCross, 'FIRST AID'));
  cell('signFire', 420, 150, (k, x, y, w, h) => safeSign(k, x, y, w, h, '#c4161c', pictoExtinguisher, 'FIRE POINT'));
  cell('signExit', 420, 150, (k, x, y, w, h) => safeSign(k, x, y, w, h, '#1d8a4a', pictoRunner, 'EXIT'));
  cell('clock', 300, 300, (k, x, y, w) => {
    const cxx = x + w / 2, cyy = y + w / 2, R = w / 2 - 4;
    k.fillStyle = '#e8e8e2'; k.fillRect(x, y, w, w);
    k.fillStyle = '#f4f4ee'; k.beginPath(); k.arc(cxx, cyy, R, 0, Math.PI * 2); k.fill();
    k.lineWidth = 12; k.strokeStyle = '#26292d'; k.stroke();
    k.fillStyle = '#222';
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * Math.PI * 2, l = i % 5 ? 8 : 22, wd = i % 5 ? 2 : 6;
      k.save(); k.translate(cxx, cyy); k.rotate(a); k.fillRect(-wd / 2, -R + 12, wd, l); k.restore();
    }
    k.font = `700 30px ${FONT}`; k.textAlign = 'center'; k.textBaseline = 'middle';
    for (let i = 1; i <= 12; i++) { const a = (i / 12) * Math.PI * 2; k.fillText(String(i), cxx + Math.sin(a) * (R - 52), cyy - Math.cos(a) * (R - 52)); }
  });
  cell('posterSpeeds', 300, 420, (k, x, y, w, h) => tablePoster(k, x, y, w, h, 'CUTTING SPEEDS  Vc m/min', ['MAT.', 'HSS', 'CARB.'],
    [['Alu', '150', '600'], ['Brass', '90', '300'], ['Steel', '30', '180'], ['St. steel', '15', '110'], ['Cast iron', '25', '140'], ['POM', '120', '400']], '#1c5aa6'));
  cell('posterTap', 300, 420, (k, x, y, w, h) => tablePoster(k, x, y, w, h, 'TAPPING DRILL SIZES', ['THREAD', 'PITCH', 'DRILL'],
    [['M3', '0.5', '2.5'], ['M4', '0.7', '3.3'], ['M5', '0.8', '4.2'], ['M6', '1.0', '5.0'], ['M8', '1.25', '6.8'], ['M10', '1.5', '8.5'], ['M12', '1.75', '10.2']], '#b3261e'));
  cell('posterFits', 300, 420, (k, x, y, w, h) => tablePoster(k, x, y, w, h, 'ISO FITS  H7 / g6', ['SIZE', 'H7 um', 'g6 um'],
    [['3-6', '+12/0', '-4/-12'], ['6-10', '+15/0', '-5/-14'], ['10-18', '+18/0', '-6/-17'], ['18-30', '+21/0', '-7/-20'], ['30-50', '+25/0', '-9/-25'], ['50-80', '+30/0', '-10/-29']], '#2d6b3c'));
  cell('posterLean', 300, 420, (k, x, y, w, h) => {
    k.fillStyle = '#ecebe5'; k.fillRect(x, y, w, h);
    k.fillStyle = '#d0811c'; k.fillRect(x, y, w, h * 0.13);
    k.fillStyle = '#fff'; k.textAlign = 'left'; k.textBaseline = 'middle';
    textFit(k, '5S  WORKPLACE', x + 12, y + h * 0.065, w - 24, 28);
    const items = ['SORT', 'SET IN ORDER', 'SHINE', 'STANDARDISE', 'SUSTAIN'];
    items.forEach((t, i) => {
      const yy = y + h * 0.2 + i * h * 0.155;
      k.fillStyle = '#d0811c'; k.beginPath(); k.arc(x + 34, yy + 22, 20, 0, Math.PI * 2); k.fill();
      k.fillStyle = '#fff'; k.font = `700 22px ${FONT}`; k.textAlign = 'center'; k.fillText(String(i + 1), x + 34, yy + 23);
      k.fillStyle = '#222'; k.textAlign = 'left'; k.font = `700 24px ${FONT}`; k.fillText(t, x + 66, yy + 16);
      k.fillStyle = '#777'; k.fillRect(x + 66, yy + 34, w - 90, 3); k.fillRect(x + 66, yy + 42, w - 130, 3);
    });
  });
  cell('calendar', 260, 360, (k, x, y, w, h) => {
    k.fillStyle = '#f0efe9'; k.fillRect(x, y, w, h);
    k.fillStyle = '#5e6670'; k.fillRect(x, y, w, h * 0.45);
    k.fillStyle = '#8fa4b8'; k.beginPath(); k.moveTo(x, y + h * 0.45); k.lineTo(x + w * 0.4, y + h * 0.18); k.lineTo(x + w * 0.7, y + h * 0.36); k.lineTo(x + w, y + h * 0.12); k.lineTo(x + w, y + h * 0.45); k.fill();
    k.fillStyle = '#222'; k.font = `700 26px ${FONT}`; k.textAlign = 'center'; k.textBaseline = 'middle';
    k.fillText('NOVEMBER', x + w / 2, y + h * 0.51);
    k.font = `400 15px ${FONT}`;
    for (let i = 0; i < 30; i++) k.fillText(String(i + 1), x + 22 + (i % 7) * 35, y + h * 0.6 + Math.floor(i / 7) * 30);
  });
  cell('noticeBoard', 520, 380, (k, x, y, w, h) => {
    const cork = corkCanvas();
    k.fillStyle = k.createPattern(cork, 'repeat'); k.fillRect(x, y, w, h);
    k.strokeStyle = '#7d8388'; k.lineWidth = 14; k.strokeRect(x + 7, y + 7, w - 14, h - 14);
    const r = rng(31);
    const papers = [[40, 40, 120, 160, '#f2f1ea'], [180, 30, 140, 100, '#f7e37a'], [340, 50, 130, 170, '#f2f1ea'], [190, 150, 120, 150, '#bfe0f2'], [50, 220, 110, 120, '#f2f1ea'], [340, 240, 140, 100, '#f5c6c6']];
    for (const [px, py, pw, ph, col] of papers) {
      k.save(); k.translate(x + px + pw / 2, y + py + ph / 2); k.rotate((r() - 0.5) * 0.12);
      k.fillStyle = 'rgba(0,0,0,0.25)'; k.fillRect(-pw / 2 + 4, -ph / 2 + 5, pw, ph);
      k.fillStyle = col; k.fillRect(-pw / 2, -ph / 2, pw, ph);
      k.fillStyle = '#555'; k.fillRect(-pw / 2 + 10, -ph / 2 + 12, pw * 0.6, 6);
      for (let l = 0; l < Math.floor(ph / 16) - 2; l++) { k.fillStyle = '#9a9a96'; k.fillRect(-pw / 2 + 10, -ph / 2 + 30 + l * 14, (pw - 20) * (0.5 + r() * 0.5), 3); }
      k.fillStyle = '#c4161c'; k.beginPath(); k.arc(0, -ph / 2 + 6, 6, 0, Math.PI * 2); k.fill();
      k.restore();
    }
  });
  const banner = (name, text, bg, fg = '#fff') => cell(name, 640, 110, (k, x, y, w, h) => {
    k.fillStyle = bg; k.fillRect(x, y, w, h);
    k.fillStyle = fg; k.textAlign = 'center'; k.textBaseline = 'middle';
    textFit(k, text, x + w / 2, y + h / 2 + 2, w - 40, 62);
  });
  banner('bannerQC', 'QUALITY CONTROL', '#2b3e57');
  banner('bannerTools', 'TOOL CRIB', '#8e1c18');
  banner('bannerStock', 'RAW MATERIAL', '#2b5ea8');
  banner('bannerCam', 'CAM / PROGRAMMING', '#2b3e57');
  banner('bannerJobs', 'JOB BOARD  -  WORK ORDERS', '#22272d');
  banner('bannerShop', 'MILLLAB TOOLROOM', '#22272d', '#e9b10e');
  banner('bannerSaw', 'SAWING', '#5a6168');
  cell('pegboard', 1000, 520, (k, x, y, w, h) => {
    k.fillStyle = '#c9c0a8'; k.fillRect(x, y, w, h);
    k.fillStyle = 'rgba(60,50,40,0.55)';
    for (let yy = y + 12; yy < y + h; yy += 25) for (let xx = x + 12; xx < x + w; xx += 25) k.fillRect(xx, yy, 4, 4);
    const sil = (fn) => { k.save(); k.fillStyle = '#2b2e33'; k.strokeStyle = '#2b2e33'; fn(); k.restore(); };
    // spanners
    for (let i = 0; i < 7; i++) sil(() => {
      const xx = x + 40 + i * 42, l = 160 + i * 18;
      k.fillStyle = '#9aa1a8'; k.fillRect(xx - 6, y + 60, 12, l);
      k.beginPath(); k.arc(xx, y + 60, 16 + i, 0, Math.PI * 2); k.fill();
      k.beginPath(); k.arc(xx, y + 60 + l, 14 + i, 0, Math.PI * 2); k.fill();
      k.fillStyle = '#c9c0a8'; k.fillRect(xx - 5, y + 40 - i, 10, 16);
    });
    // hammers
    for (let i = 0; i < 3; i++) sil(() => {
      const xx = x + 360 + i * 70;
      k.fillStyle = i === 1 ? '#c4161c' : '#3b3e44'; k.fillRect(xx - 25, y + 50, 50, 26);
      k.fillStyle = '#8b6a43'; k.fillRect(xx - 6, y + 76, 12, 220);
    });
    // screwdrivers
    for (let i = 0; i < 8; i++) sil(() => {
      const xx = x + 600 + i * 30;
      k.fillStyle = ['#e9b10e', '#c4161c', '#1c5aa6'][i % 3]; rr(k, xx - 9, y + 50, 18, 90, 6); k.fill();
      k.fillStyle = '#b8bec4'; k.fillRect(xx - 3, y + 140, 6, 90 + (i % 4) * 25);
    });
    // pliers + files
    for (let i = 0; i < 4; i++) sil(() => {
      const xx = x + 860 + (i % 2) * 70, yy = y + 50 + Math.floor(i / 2) * 210;
      k.fillStyle = '#c4161c'; k.fillRect(xx - 16, yy + 70, 9, 110); k.fillRect(xx + 7, yy + 70, 9, 110);
      k.fillStyle = '#4c5056'; k.beginPath(); k.moveTo(xx - 10, yy + 80); k.lineTo(xx, yy); k.lineTo(xx + 10, yy + 80); k.fill();
    });
    for (let i = 0; i < 5; i++) sil(() => {
      const xx = x + 380 + i * 46;
      k.fillStyle = '#5c6066'; k.fillRect(xx - 7, y + 330, 14, 160);
      k.fillStyle = '#8b6a43'; k.fillRect(xx - 9, y + 300, 18, 34);
    });
    // tape measure / square
    sil(() => { k.fillStyle = '#e9b10e'; rr(k, x + 70, y + 300, 90, 90, 12); k.fill(); k.fillStyle = '#9aa1a8'; k.fillRect(x + 180, y + 300, 20, 190); k.fillRect(x + 180, y + 470, 120, 20); });
  });
  cell('drawing1', 420, 300, (k, x, y, w, h) => drawingSheet(k, x, y, w, h, 1));
  cell('drawing2', 420, 300, (k, x, y, w, h) => drawingSheet(k, x, y, w, h, 2));
  cell('drawing3', 420, 300, (k, x, y, w, h) => drawingSheet(k, x, y, w, h, 3));
  cell('keyboard', 360, 120, (k, x, y, w, h) => {
    k.fillStyle = '#1b1d20'; k.fillRect(x, y, w, h);
    k.fillStyle = '#34373c';
    for (let r = 0; r < 5; r++) for (let i = 0; i < 15; i++) k.fillRect(x + 6 + i * 23, y + 8 + r * 22, 19, 18);
    k.fillRect(x + 80, y + 8 + 4 * 22, 160, 18);
  });
  cell('panelLathe', 300, 200, (k, x, y, w, h) => {
    k.fillStyle = '#d9d6c8'; k.fillRect(x, y, w, h);
    k.fillStyle = '#222'; k.font = `700 16px ${FONT}`; k.textAlign = 'left'; k.textBaseline = 'top';
    k.fillText('SPINDLE SPEED  rpm', x + 12, y + 10);
    const sp = [[45, 70, 110, 180], [280, 450, 710, 1120], [1400, 1800, 2200, 2500]];
    k.font = `400 15px ${FONT}`;
    sp.forEach((row, j) => row.forEach((v, i) => k.fillText(String(v), x + 14 + i * 70, y + 40 + j * 26)));
    k.fillStyle = '#222'; k.fillText('FEEDS  mm/rev  0.04 - 0.8', x + 12, y + 130);
    k.fillText('THREADS  0.5 - 6 mm', x + 12, y + 158);
  });
  cell('panelGrinder', 260, 160, (k, x, y, w, h) => {
    k.fillStyle = '#2b2f34'; k.fillRect(x, y, w, h);
    const btn = (bx, by, col) => { k.fillStyle = col; k.beginPath(); k.arc(x + bx, y + by, 16, 0, Math.PI * 2); k.fill(); };
    btn(40, 50, '#1f9a4a'); btn(90, 50, '#c8191e'); btn(140, 50, '#e8b21a'); btn(190, 50, '#f2f2f2');
    k.fillStyle = '#7fd36b'; k.fillRect(x + 30, y + 90, 200, 44);
    k.fillStyle = '#123'; k.font = `700 26px monospace`; k.textBaseline = 'middle'; k.fillText('Z 12.345', x + 46, y + 113);
  });
  cell('boxLabel', 200, 120, (k, x, y, w, h) => {
    k.fillStyle = '#b08758'; k.fillRect(x, y, w, h);
    k.fillStyle = '#f2f1ea'; k.fillRect(x + 30, y + 30, 140, 60);
    k.fillStyle = '#333'; k.font = `700 18px ${FONT}`; k.textAlign = 'center'; k.textBaseline = 'middle';
    k.fillText('M8 x 25', x + 100, y + 50); k.font = `400 13px ${FONT}`; k.fillText('DIN 912  x 200', x + 100, y + 72);
  });
  cell('drumLabel', 220, 160, (k, x, y, w, h) => {
    k.fillStyle = '#f2f1ea'; k.fillRect(x, y, w, h);
    k.fillStyle = '#1c5aa6'; k.fillRect(x, y, w, 40);
    k.fillStyle = '#fff'; k.font = `700 24px ${FONT}`; k.textAlign = 'center'; k.textBaseline = 'middle'; k.fillText('COOLANT', x + w / 2, y + 21);
    k.fillStyle = '#333'; k.font = `400 15px ${FONT}`; k.fillText('Semi-synthetic', x + w / 2, y + 66); k.fillText('Mix 6 - 8 %', x + w / 2, y + 90); k.fillText('205 L', x + w / 2, y + 120);
  });
  cell('cabinetLabel', 260, 60, (k, x, y, w, h) => {
    k.fillStyle = '#f2f1ea'; k.fillRect(x, y, w, h);
    k.fillStyle = '#333'; k.font = `700 26px ${FONT}`; k.textAlign = 'center'; k.textBaseline = 'middle'; k.fillText('BT40 HOLDERS', x + w / 2, y + h / 2 + 1);
  });
  cell('firstAidBox', 200, 200, (k, x, y, w, h) => {
    k.fillStyle = '#1d8a4a'; k.fillRect(x, y, w, h);
    k.fillStyle = '#fff'; pictoCross(k, x + w / 2, y + h / 2, 1.3);
  });
  return { canvas: c, uv };
}

function drawingSheet(k, x, y, w, h, v) {
  k.fillStyle = '#ecebe3'; k.fillRect(x, y, w, h);
  k.strokeStyle = '#333'; k.lineWidth = 2; k.strokeRect(x + 8, y + 8, w - 16, h - 16);
  k.lineWidth = 1; k.strokeRect(x + w - 150, y + h - 50, 142, 42);
  k.beginPath(); k.moveTo(x + w - 150, y + h - 30); k.lineTo(x + w - 8, y + h - 30); k.stroke();
  k.lineWidth = 2;
  if (v === 1) {
    k.strokeRect(x + 40, y + 50, 180, 110);
    k.strokeRect(x + 80, y + 80, 100, 50);
    k.beginPath(); k.arc(x + 60, y + 70, 8, 0, Math.PI * 2); k.stroke();
    k.beginPath(); k.arc(x + 200, y + 140, 8, 0, Math.PI * 2); k.stroke();
    k.strokeRect(x + 260, y + 50, 40, 110);
    k.strokeRect(x + 40, y + 190, 180, 40);
  } else if (v === 2) {
    k.beginPath(); k.arc(x + 130, y + 120, 70, 0, Math.PI * 2); k.stroke();
    k.beginPath(); k.arc(x + 130, y + 120, 30, 0, Math.PI * 2); k.stroke();
    for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + 0.78; k.beginPath(); k.arc(x + 130 + Math.cos(a) * 52, y + 120 + Math.sin(a) * 52, 6, 0, Math.PI * 2); k.stroke(); }
    k.strokeRect(x + 250, y + 50, 120, 140);
    k.strokeRect(x + 250, y + 100, 120, 40);
  } else {
    k.beginPath(); k.moveTo(x + 40, y + 200); k.lineTo(x + 40, y + 60); k.lineTo(x + 160, y + 60); k.lineTo(x + 200, y + 100); k.lineTo(x + 340, y + 100); k.lineTo(x + 340, y + 200); k.closePath(); k.stroke();
    k.strokeRect(x + 220, y + 130, 80, 40);
  }
  k.lineWidth = 1; k.strokeStyle = '#4a6a9a';
  for (let i = 0; i < 5; i++) { k.beginPath(); k.moveTo(x + 40 + i * 60, y + 30); k.lineTo(x + 80 + i * 60, y + 30); k.stroke(); }
  k.fillStyle = '#333'; k.font = `700 11px ${FONT}`; k.fillText('ML-10' + (v + 10), x + w - 140, y + h - 16);
}

// CAM software look-alike for the PC monitor (generic, invented UI).
export function camScreenCanvas() {
  const W = 1024, H = 640;
  const c = makeCanvas(W, H);
  const k = c.getContext('2d');
  k.fillStyle = '#1e2329'; k.fillRect(0, 0, W, H);
  k.fillStyle = '#2b323a'; k.fillRect(0, 0, W, 34);
  k.fillStyle = '#c9d1d9'; k.font = `600 18px ${FONT}`; k.textBaseline = 'middle';
  ['File', 'Edit', 'View', 'Setup', 'Toolpaths', 'Simulate', 'Post'].forEach((t, i) => k.fillText(t, 14 + i * 92, 17));
  k.fillStyle = '#262c33'; k.fillRect(0, 34, 230, H - 34);
  k.fillStyle = '#9fb0c2'; k.font = `500 16px ${FONT}`;
  ['Setup 1 - G54', '  Face 0.5', '  Adaptive clear', '  Pocket A', '  Contour 2D', '  Drill 6.8', '  Chamfer', 'Setup 2'].forEach((t, i) => {
    if (i === 3) { k.fillStyle = '#2f7de1'; k.fillRect(0, 50 + i * 30, 230, 28); k.fillStyle = '#fff'; } else k.fillStyle = '#9fb0c2';
    k.fillText(t, 14, 64 + i * 30);
  });
  // viewport with a part + toolpath
  const g = k.createLinearGradient(0, 34, 0, H);
  g.addColorStop(0, '#46505c'); g.addColorStop(1, '#20252b');
  k.fillStyle = g; k.fillRect(230, 34, W - 230, H - 34);
  k.save(); k.translate(620, 360);
  const iso = (x, y, z) => [(x - y) * 0.87, (x + y) * 0.5 - z];
  const poly = (pts, fill) => { k.beginPath(); pts.forEach((p, i) => { const q = iso(...p); i ? k.lineTo(q[0], q[1]) : k.moveTo(q[0], q[1]); }); k.closePath(); k.fillStyle = fill; k.fill(); };
  poly([[-160, -100, 0], [160, -100, 0], [160, 100, 0], [-160, 100, 0]], '#9aa3ad');
  poly([[160, -100, 0], [160, 100, 0], [160, 100, -60], [160, -100, -60]], '#6e7781');
  poly([[-160, 100, 0], [160, 100, 0], [160, 100, -60], [-160, 100, -60]], '#808a94');
  k.strokeStyle = '#3fd07a'; k.lineWidth = 2;
  for (let i = 0; i < 6; i++) {
    const a = 20 + i * 9, b = 40 + i * 9;
    k.beginPath(); [[-b * 1.6, -a, 6], [b * 1.6, -a, 6], [b * 1.6, a, 6], [-b * 1.6, a, 6], [-b * 1.6, -a, 6]].forEach((p, j) => { const q = iso(...p); j ? k.lineTo(q[0], q[1]) : k.moveTo(q[0], q[1]); }); k.stroke();
  }
  k.strokeStyle = '#e8b21a'; k.setLineDash([6, 6]);
  k.beginPath(); const q0 = iso(-160, -100, 80), q1 = iso(-64, -20, 6); k.moveTo(q0[0], q0[1]); k.lineTo(q1[0], q1[1]); k.stroke();
  k.restore();
  k.fillStyle = '#c9d1d9'; k.font = `500 15px ${FONT}`;
  k.fillText('Pocket A   T2 D10 FEM   S9500 F1200   stepover 40%   est. 2:42', 246, H - 18);
  return c;
}
