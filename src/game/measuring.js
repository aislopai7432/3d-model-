// In-game measuring instruments for the inspection bench: detailed articulated 3D instrument models,
// readout panels drawn like the real instruments, and the interactive MeasuringStation.
//
// The measurement math lives in ./gauges.js (pure, Node-testable) and is re-exported from here.
//
// Frames used here
//   part frame  : origin front-left corner of the finished top face, X length, Y to the back, Z up (mm).
//   table frame : machine table frame (Z-map coordinates). part = table - datum (see gauges.partFrame).
//   partGroup   : the THREE.Object3D the caller shows on the surface plate. ASSUMPTION: its local frame is
//                 the machine work group's convention, i.e. table (x, y, z) -> Three local (x, z, -y), so a
//                 StockMesh.group can be put into it unchanged; the caller only positions/rotates it so the
//                 part sits on the plate (no scaling). Hit points are converted world -> partGroup local ->
//                 table -> part frame.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import {
  INSTRUMENTS, INSTRUMENT, partFrame, measureOutside, measureInside, measureBore, measureDepth, measureHeight,
  measureFlatness, featureAt, formatValue, decimalsFor,
} from './gauges.js';

export {
  INSTRUMENTS, INSTRUMENT, measureOutside, measureInside, measureBore, measureDepth, measureHeight, measureFlatness,
  partFrame, featureAt, setRandom, reading, quantize, targetDepth,
} from './gauges.js';

const TAU = Math.PI * 2;
const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// =================================================================== 2D drawing (LCD, scales, dials)
const SEG = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', '-': 'g', ' ': '' };
function seg7(ctx, ch, x, y, h, on, off) {
  const w = h * 0.52, t = h * 0.13, sl = h * 0.1, g = t * 0.18;
  const hs = (x1, x2, yy) => [[x1 + g, yy], [x1 + t / 2 + g, yy - t / 2], [x2 - t / 2 - g, yy - t / 2], [x2 - g, yy], [x2 - t / 2 - g, yy + t / 2], [x1 + t / 2 + g, yy + t / 2]];
  const vs = (xx, y1, y2) => [[xx, y1 + g], [xx + t / 2, y1 + t / 2 + g], [xx + t / 2, y2 - t / 2 - g], [xx, y2 - g], [xx - t / 2, y2 - t / 2 - g], [xx - t / 2, y1 + t / 2 + g]];
  const P = {
    a: hs(0, w, 0), g: hs(0, w, h / 2), d: hs(0, w, h),
    f: vs(0, 0, h / 2), b: vs(w, 0, h / 2), e: vs(0, h / 2, h), c: vs(w, h / 2, h),
  };
  const lit = SEG[ch] ?? '';
  for (const k of 'abcdefg') {
    const col = lit.includes(k) ? on : off;
    if (!col) continue;
    ctx.fillStyle = col;
    ctx.beginPath();
    P[k].forEach(([px, py], i) => {
      const X = x + px + (h - py) * (sl / h), Y = y + py;
      if (i) ctx.lineTo(X, Y);
      else ctx.moveTo(X, Y);
    });
    ctx.closePath();
    ctx.fill();
  }
  return w + t * 1.6;
}
// Right-aligned seven-segment text with ghost segments. Returns nothing.
export function draw7Seg(ctx, text, right, y, h, on, off, digits = 6) {
  const cw = h * 0.52 + h * 0.13 * 1.6;
  const chars = [];
  for (const c of String(text)) {
    if (c === '.') { if (chars.length) chars[chars.length - 1].dp = true; } else chars.push({ c, dp: false });
  }
  while (chars.length < digits) chars.unshift({ c: ' ', dp: false });
  let x = right - chars.length * cw;
  for (const ch of chars) {
    seg7(ctx, ch.c, x, y, h, on, off);
    // decimal point
    ctx.fillStyle = ch.dp ? on : off;
    if (ch.dp || off) {
      const s = h * 0.13;
      ctx.fillRect(x + h * 0.52 + s * 0.35, y + h - s / 2, s, s);
    }
    x += cw;
  }
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Instrument LCD (caliper, height gauge). text: e.g. '50.00' or '-----'.
export function drawLCD(ctx, x, y, w, h, text, { unit = 'mm', note = '', err = false } = {}) {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, '#c5ceb4');
  g.addColorStop(1, '#aeb89c');
  ctx.fillStyle = g;
  rr(ctx, x, y, w, h, h * 0.06);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.45)';
  ctx.lineWidth = Math.max(1, h * 0.03);
  ctx.stroke();
  const dh = h * 0.6;
  draw7Seg(ctx, text, x + w - w * 0.2, y + h * 0.2, dh, err ? '#5a1c14' : '#1b2116', 'rgba(30,40,20,.07)', 6);
  ctx.fillStyle = '#1b2116';
  ctx.font = `700 ${Math.round(h * 0.17)}px Arial, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(unit, x + w - w * 0.17, y + h * 0.78);
  if (note) {
    ctx.font = `700 ${Math.round(h * 0.13)}px Arial, sans-serif`;
    ctx.fillText(note, x + w * 0.05, y + h * 0.24);
  }
}

// Analogue micrometer sleeve + thimble, flattened (what the eye sees from the front).
// value: reading; min: range start; res 0.001 draws the vernier on the sleeve.
export function drawMicrometerScale(ctx, W, H, value, { min = 0, vernier = true, title = '' } = {}) {
  const r = clamp(value - min, 0, 25.5);
  const refY = Math.round(H * 0.66), ppm = 30, pd = 8.2;
  const xe = Math.round(W * 0.6);
  ctx.save();
  ctx.fillStyle = '#121518';
  ctx.fillRect(0, 0, W, H);
  // sleeve
  const sTop = refY - 128, sBot = refY + 46;
  let g = ctx.createLinearGradient(0, sTop, 0, sBot);
  g.addColorStop(0, '#7d858d'); g.addColorStop(0.18, '#d9dee3'); g.addColorStop(0.55, '#f2f4f6'); g.addColorStop(0.85, '#c3c9cf'); g.addColorStop(1, '#868e96');
  ctx.fillStyle = g;
  ctx.fillRect(0, sTop, xe + 4, sBot - sTop);
  ctx.strokeStyle = '#1a1d20';
  ctx.fillStyle = '#1a1d20';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(0, refY + 0.5);
  ctx.lineTo(xe, refY + 0.5);
  ctx.stroke();
  ctx.font = '600 15px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (let k = 0; k <= 50; k++) {
    const mm = k / 2;
    const x = Math.round(xe - (r - mm) * ppm) + 0.5;
    if (x > xe - 1 || x < -10) continue;
    ctx.beginPath();
    if (k % 2 === 0) {
      const big = k % 10 === 0;
      ctx.moveTo(x, refY);
      ctx.lineTo(x, refY - (big ? 22 : 15));
      ctx.stroke();
      if (big) ctx.fillText(String(min + mm), x, refY - 27);
    } else {
      ctx.moveTo(x, refY);
      ctx.lineTo(x, refY + 15);
      ctx.stroke();
    }
  }
  // thimble divisions: count of 0.01 divisions
  const div = (r % 0.5) / 0.01;
  // vernier (0.001): 10 lines over 9 thimble divisions, on the sleeve above the scale
  const m = 6;
  if (vernier) {
    ctx.lineWidth = 1.3;
    ctx.font = '600 12px Arial, sans-serif';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 10; i++) {
      const y = Math.round(refY - (m + 0.9 * i) * pd) + 0.5;
      ctx.beginPath();
      ctx.moveTo(xe - 64, y);
      ctx.lineTo(xe, y);
      ctx.stroke();
      if (i % 2 === 0) ctx.fillText(String(i % 10), xe - 69, y + 4);
    }
    ctx.lineWidth = 1.6;
  }
  // thimble body
  const tTop = refY - 168, tBot = refY + 80;
  g = ctx.createLinearGradient(0, tTop, 0, tBot);
  g.addColorStop(0, '#5f666d'); g.addColorStop(0.2, '#c9cfd5'); g.addColorStop(0.55, '#eef1f4'); g.addColorStop(0.85, '#b9c0c7'); g.addColorStop(1, '#5f666d');
  ctx.fillStyle = g;
  ctx.fillRect(xe, tTop, W - xe, tBot - tTop);
  // bevel
  ctx.fillStyle = 'rgba(255,255,255,.35)';
  ctx.fillRect(xe, tTop, 16, tBot - tTop);
  ctx.fillStyle = 'rgba(0,0,0,.25)';
  ctx.fillRect(xe, tTop, 1.5, tBot - tTop);
  // knurl band
  ctx.save();
  ctx.beginPath();
  ctx.rect(xe + 120, tTop, W - xe - 120, tBot - tTop);
  ctx.clip();
  ctx.fillStyle = '#3d4247';
  ctx.fillRect(xe + 120, tTop, W - xe - 120, tBot - tTop);
  ctx.strokeStyle = 'rgba(255,255,255,.18)';
  ctx.lineWidth = 2;
  for (let k = -40; k < 60; k++) {
    const y0 = tTop + k * 7 - (div * pd) % 7;
    ctx.beginPath(); ctx.moveTo(xe + 120, y0); ctx.lineTo(W, y0 + (W - xe - 120) * 0.6); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(xe + 120, y0); ctx.lineTo(W, y0 - (W - xe - 120) * 0.6); ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = '#15181b';
  ctx.fillStyle = '#15181b';
  ctx.lineWidth = 1.5;
  ctx.font = '600 15px Arial, sans-serif';
  ctx.textAlign = 'left';
  const k0 = Math.floor(div) - 25, k1 = Math.ceil(div) + 25;
  for (let k = k0; k <= k1; k++) {
    const y = refY - (k - div) * pd;
    if (y < tTop + 4 || y > tBot - 4) continue;
    const j = ((k % 50) + 50) % 50;
    const len = j % 5 === 0 ? 30 : 19;
    ctx.beginPath();
    ctx.moveTo(xe, Math.round(y) + 0.5);
    ctx.lineTo(xe + len, Math.round(y) + 0.5);
    ctx.stroke();
    if (j % 5 === 0) {
      ctx.textBaseline = 'middle';
      ctx.fillText(String(j), xe + 36, y);
    }
  }
  // shadows at the thimble edges (cylinder)
  g = ctx.createLinearGradient(0, tTop, 0, tTop + 50);
  g.addColorStop(0, 'rgba(0,0,0,.5)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(xe, tTop, W - xe, 50);
  g = ctx.createLinearGradient(0, tBot - 40, 0, tBot);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.5)');
  ctx.fillStyle = g;
  ctx.fillRect(xe, tBot - 40, W - xe, 40);
  if (title) {
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.font = '600 11px Arial, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(title, 8, 6);
  }
  ctx.restore();
}

// Dial face (bore gauge 0.002 mm, dial indicator 0.01 mm). dev = deviation in mm (needle angle).
export function drawDial(ctx, S, dev, { perDiv = 0.01, divs = 100, labelEvery = 10, label = (k) => String(k), title = '0.01 mm', needle = true, counter = true, x = 0, y = 0, face = '#f4f2ea', tol = null } = {}) {
  const cx = x + S / 2, cy = y + S / 2, R = S * 0.46;
  ctx.save();
  // bezel
  let g = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.3, R * 0.2, cx, cy, R * 1.05);
  g.addColorStop(0, '#f4f6f8'); g.addColorStop(0.7, '#aeb5bc'); g.addColorStop(1, '#5c636a');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, R * 1.06, 0, TAU); ctx.fill();
  ctx.fillStyle = face;
  ctx.beginPath(); ctx.arc(cx, cy, R * 0.92, 0, TAU); ctx.fill();
  // tolerance band
  if (tol) {
    const rev = divs * perDiv;
    for (const [v, col] of [[tol[0], '#d33'], [tol[1], '#2a2']]) {
      const a = -Math.PI / 2 + (v / rev) * TAU;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(cx + Math.cos(a) * R * 0.99, cy + Math.sin(a) * R * 0.99, R * 0.05, 0, TAU); ctx.fill();
    }
  }
  ctx.strokeStyle = '#111';
  ctx.fillStyle = '#111';
  for (let k = 0; k < divs; k++) {
    const a = -Math.PI / 2 + (k / divs) * TAU;
    const L = k % labelEvery === 0 ? 0.15 : k % (labelEvery / 2) === 0 ? 0.11 : 0.07;
    ctx.lineWidth = k % labelEvery === 0 ? S * 0.008 : S * 0.0045;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * R * 0.9, cy + Math.sin(a) * R * 0.9);
    ctx.lineTo(cx + Math.cos(a) * R * (0.9 - L), cy + Math.sin(a) * R * (0.9 - L));
    ctx.stroke();
    if (k % labelEvery === 0) {
      ctx.font = `600 ${Math.round(S * 0.062)}px Arial, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label(k), cx + Math.cos(a) * R * 0.63, cy + Math.sin(a) * R * 0.63);
    }
  }
  ctx.font = `600 ${Math.round(S * 0.045)}px Arial, sans-serif`;
  ctx.fillStyle = '#333';
  ctx.fillText(title, cx, cy + R * 0.33);
  // revolution counter
  const rev = divs * perDiv;
  if (counter) {
    const ccx = cx, ccy = cy - R * 0.34, cr = R * 0.15;
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(ccx, ccy, cr, 0, TAU); ctx.stroke();
    for (let k = 0; k < 10; k++) {
      const a = -Math.PI / 2 + (k / 10) * TAU;
      ctx.beginPath(); ctx.moveTo(ccx + Math.cos(a) * cr, ccy + Math.sin(a) * cr); ctx.lineTo(ccx + Math.cos(a) * cr * 0.75, ccy + Math.sin(a) * cr * 0.75); ctx.stroke();
    }
    if (needle) {
      const a = -Math.PI / 2 + (dev / (rev * 10)) * TAU;
      ctx.strokeStyle = '#222'; ctx.lineWidth = S * 0.008;
      ctx.beginPath(); ctx.moveTo(ccx, ccy); ctx.lineTo(ccx + Math.cos(a) * cr * 0.85, ccy + Math.sin(a) * cr * 0.85); ctx.stroke();
    }
  }
  if (needle) {
    const a = -Math.PI / 2 + (dev / rev) * TAU;
    ctx.strokeStyle = '#c4161c';
    ctx.lineCap = 'round';
    ctx.lineWidth = S * 0.012;
    ctx.beginPath();
    ctx.moveTo(cx - Math.cos(a) * R * 0.18, cy - Math.sin(a) * R * 0.18);
    ctx.lineTo(cx + Math.cos(a) * R * 0.86, cy + Math.sin(a) * R * 0.86);
    ctx.stroke();
    ctx.fillStyle = '#2b2b2b';
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.06, 0, TAU); ctx.fill();
    ctx.fillStyle = '#c4161c';
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.03, 0, TAU); ctx.fill();
  }
  // glass highlight
  g = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
  g.addColorStop(0, 'rgba(255,255,255,.18)'); g.addColorStop(0.45, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, R * 0.92, 0, TAU); ctx.fill();
  ctx.restore();
}
const DIAL_BORE = { perDiv: 0.002, divs: 100, labelEvery: 10, label: (k) => String((k <= 50 ? k : 100 - k) / 5), title: '0.002 mm' };
const DIAL_IND = { perDiv: 0.01, divs: 100, labelEvery: 10, label: (k) => String(k <= 50 ? k : 100 - k), title: '0.01 mm' };

// =================================================================== materials / geometry kit
const M = {};
function std(color, metalness, roughness, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness, ...extra });
}
function mats() {
  if (M.satin) return M;
  M.satin = std(0xc4cad0, 1, 0.3);
  M.chrome = std(0xeef1f4, 1, 0.12);
  M.steel = std(0xa9b0b7, 1, 0.38);
  M.dark = std(0x34383d, 0.75, 0.42);
  M.black = std(0x18191c, 0.05, 0.5);
  M.grip = std(0x0f1012, 0, 0.82);
  M.enamel = std(0x41505e, 0.35, 0.48);
  M.carbide = std(0x7d8389, 0.9, 0.28);
  M.castIron = std(0x4f565e, 0.35, 0.6);
  M.red = std(0xc81e25, 0.1, 0.4);
  M.green = std(0x2aa64f, 0.1, 0.4);
  M.mag = std(0x202326, 0.25, 0.5);
  M.white = std(0xe9e7df, 0, 0.6);
  return M;
}
function canvasTex(c, aniso = 8) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  return t;
}
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
function prep(geo) {
  let g = geo.index ? geo.toNonIndexed() : geo;
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  g.clearGroups();
  return g;
}
const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
class Kit {
  constructor() { this.items = new Map(); }
  add(geo, mat, p = [0, 0, 0], r = [0, 0, 0], s = 1) {
    const m = new THREE.Matrix4().compose(_v.set(p[0], p[1], p[2]), _q.setFromEuler(_e.set(r[0], r[1], r[2])), Array.isArray(s) ? _s.set(s[0], s[1], s[2]) : _s.set(s, s, s));
    geo.applyMatrix4(m);
    if (!this.items.has(mat)) this.items.set(mat, []);
    this.items.get(mat).push(prep(geo));
    return this;
  }
  build(group = new THREE.Group(), name = '') {
    for (const [mat, list] of this.items) {
      const geo = list.length === 1 ? list[0] : mergeGeometries(list, false);
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (name) mesh.name = name;
      group.add(mesh);
    }
    return group;
  }
}
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const rbox = (w, h, d, r) => new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2 - 0.01, h / 2 - 0.01, d / 2 - 0.01));
// box from min/max corners
function bx(kit, mat, x0, y0, z0, x1, y1, z1, round = 0) {
  kit.add(round ? rbox(x1 - x0, y1 - y0, z1 - z0, round) : box(x1 - x0, y1 - y0, z1 - z0), mat, [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]);
}
function cyl(r, len, axis = 'y', seg = 24, r2 = r) {
  const g = new THREE.CylinderGeometry(r2, r, len, seg);
  if (axis === 'x') g.rotateZ(-Math.PI / 2);
  else if (axis === 'z') g.rotateX(Math.PI / 2);
  return g;
}
function shape(pts) {
  const s = new THREE.Shape();
  pts.forEach((p, i) => {
    if (p.length === 4) s.quadraticCurveTo(p[0], p[1], p[2], p[3]);
    else if (i) s.lineTo(p[0], p[1]);
    else s.moveTo(p[0], p[1]);
  });
  s.closePath();
  return s;
}
function ext(pts, depth, bevel = 0, curve = 10) {
  const g = new THREE.ExtrudeGeometry(pts instanceof THREE.Shape ? pts : shape(pts), {
    depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: curve,
  });
  g.translate(0, 0, -depth / 2);
  return g;
}
function lathe(pts, seg = 40, axis = 'y') {
  const g = new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg, -Math.PI);
  if (axis === 'x') g.rotateZ(-Math.PI / 2);
  else if (axis === 'z') g.rotateX(Math.PI / 2);
  return g;
}
function texMesh(geo, tex, opts = {}) {
  const m = new THREE.Mesh(geo, std(0xffffff, opts.metalness ?? 0.2, opts.roughness ?? 0.5, { map: tex, ...(opts.extra || {}) }));
  m.castShadow = opts.shadow ?? false;
  m.receiveShadow = true;
  return m;
}

// =================================================================== textures for the models
let _scaleTex = null;
function caliperScaleTexture() {
  if (_scaleTex) return _scaleTex;
  // beam front 234 x 16 mm (x -12..222), 8 px/mm
  const k = 8, W = 234 * k, H = 16 * k;
  const c = makeCanvas(W, H), ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#b9c0c6'); g.addColorStop(0.5, '#dfe3e7'); g.addColorStop(1, '#aab1b8');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // brushed texture
  ctx.globalAlpha = 0.12;
  for (let i = 0; i < 160; i++) {
    ctx.fillStyle = i % 2 ? '#fff' : '#000';
    ctx.fillRect(0, Math.random() * H, W, 1);
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#16191c';
  ctx.font = `700 ${4.2 * k}px Arial, sans-serif`;
  ctx.textAlign = 'center';
  for (let mm = 0; mm <= 150; mm++) {
    const x = (mm + 12) * k;
    const L = mm % 10 === 0 ? 5 : mm % 5 === 0 ? 3.8 : 2.6;
    ctx.fillRect(x - 0.9, 0, 1.8, L * k);
    if (mm % 10 === 0) ctx.fillText(String(mm / 10), x, 10.2 * k);
  }
  ctx.font = `600 ${2.4 * k}px Arial, sans-serif`;
  ctx.textAlign = 'left';
  ctx.fillText('0-150 mm   HARDENED STAINLESS', 166 * k, 10 * k);
  _scaleTex = canvasTex(c);
  return _scaleTex;
}
function sleeveTexture({ vernier = true, depth = false, len = 46, zeroAt = 4, min = 0 } = {}) {
  // CylinderGeometry with thetaStart = -PI: u = 0.5 is the front (theta = 0). Rows: top of canvas = +axis end.
  const W = 2048, H = 1024;
  const c = makeCanvas(W, H), ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, '#9aa2aa'); g.addColorStop(0.5, '#e3e7eb'); g.addColorStop(1, '#9aa2aa');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const col = (theta) => W * (0.5 + theta / TAU); // theta in radians, + = downwards on the model (or right for depth)
  const row = (x) => H * (1 - x / len); // x along the axis from the sleeve start (mm)
  ctx.fillStyle = '#1b1e21';
  const cx = col(0);
  const pxmm = H / len;
  // reference line along the axis
  ctx.fillRect(cx - 2, row(len), 4, H);
  ctx.font = `700 ${Math.round(pxmm * 2.2)}px Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const dTick = (7.2 * Math.PI) / 180;
  for (let k = 0; k <= 50; k++) {
    const mm = k / 2;
    const x = depth ? zeroAt + 25 - mm : zeroAt + mm;
    const y = row(x);
    if (k % 2 === 0) {
      const long = k % 10 === 0;
      ctx.fillRect(col(-dTick * (long ? 2.4 : 1.6)), y - 2, col(0) - col(-dTick * (long ? 2.4 : 1.6)), 4);
      if (long) {
        ctx.save();
        ctx.translate(col(-dTick * 3.6), y);
        ctx.rotate(depth ? 0 : -Math.PI / 2);
        ctx.fillText(String(min + mm), 0, 0);
        ctx.restore();
      }
    } else {
      ctx.fillRect(col(0), y - 2, col(dTick * 1.6) - col(0), 4);
    }
  }
  if (vernier) {
    for (let i = 0; i <= 10; i++) {
      const th = -(6 + 0.9 * i) * dTick;
      ctx.fillRect(col(th) - 1.5, row(len), 3, H);
    }
    ctx.font = `700 ${Math.round(pxmm * 1.4)}px Arial, sans-serif`;
    for (let i = 0; i <= 10; i += 2) {
      ctx.save();
      ctx.translate(col(-(6 + 0.9 * i) * dTick), row(1.2));
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(String(i % 10), 0, 0);
      ctx.restore();
    }
  }
  return canvasTex(c);
}
let _thimbleTex = null;
function thimbleTexture() {
  if (_thimbleTex) return _thimbleTex;
  // lathe profile points: v = j/(n-1). Graduations on v in [0, 2/7]; knurl band v in [3/7, 4/7] (see buildMicrometer)
  const W = 2048, H = 1024;
  const c = makeCanvas(W, H), ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, '#a3abb3'); g.addColorStop(0.5, '#eceff2'); g.addColorStop(1, '#a3abb3');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const rowV = (v) => H * (1 - v);
  // knurl
  ctx.fillStyle = '#3a3f44';
  ctx.fillRect(0, rowV(4 / 7), W, rowV(3 / 7) - rowV(4 / 7));
  ctx.strokeStyle = 'rgba(255,255,255,.25)';
  ctx.lineWidth = 3;
  for (let k = 0; k < 160; k++) {
    const x = (k / 160) * W;
    ctx.beginPath(); ctx.moveTo(x, rowV(4 / 7)); ctx.lineTo(x, rowV(3 / 7)); ctx.stroke();
  }
  // graduations: line j at theta = -j * 2PI/50 (higher numbers above the reference line)
  ctx.fillStyle = '#16191c';
  ctx.font = '700 46px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let j = 0; j < 50; j++) {
    let th = -(j * TAU) / 50;
    const x = W * (0.5 + th / TAU);
    const xx = ((x % W) + W) % W;
    const long = j % 5 === 0;
    const v1 = long ? 2 / 7 * 0.98 : 2 / 7 * 0.7;
    ctx.fillRect(xx - 3, rowV(v1), 6, rowV(0) - rowV(v1));
    if (long) {
      ctx.save();
      ctx.translate(xx + 34 > W ? xx - W + 34 : xx + 34, rowV(2 / 7 * 1.25));
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(String(j), 0, 0);
      ctx.restore();
    }
  }
  _thimbleTex = canvasTex(c);
  return _thimbleTex;
}
let _dialTex = {};
function dialTexture(kind) {
  if (_dialTex[kind]) return _dialTex[kind];
  const S = 512;
  const c = makeCanvas(S, S), ctx = c.getContext('2d');
  ctx.fillStyle = '#eceae2';
  ctx.fillRect(0, 0, S, S);
  drawDial(ctx, S, 0, { ...(kind === 'bore' ? DIAL_BORE : DIAL_IND), needle: false, counter: true });
  _dialTex[kind] = canvasTex(c);
  return _dialTex[kind];
}
function labelTexture(lines, { w = 512, h = 96, bg = '#1c1e21', fg = '#d7dade', font = 'Arial' } = {}) {
  const c = makeCanvas(w, h), ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => {
    ctx.font = `${l.weight || 700} ${l.size || 30}px ${font}, sans-serif`;
    ctx.fillText(l.text, w / 2, (h * (i + 0.5)) / lines.length);
  });
  return canvasTex(c);
}

// =================================================================== instrument models
// Every model: THREE.Group, mm units, userData = { id, setValue(mm), value, ... }.
// Model frames (documented for placing them as bench props):
//   caliper      : X = measuring axis (fixed jaw face at x=0, moving jaw at x=value), +Y = beam up
//                  (outside jaws hang to -Y, inside jaws stick up +Y), +Z = LCD side. Beam end x=222 (depth rod).
//   micrometer   : X = spindle axis, anvil face at x=0, spindle face at x=value, C-frame below (-Y), +Z front.
//   boreGauge    : +Y = shaft up, measuring head at the origin, contacts at x = -value/2 and +value/2, dial on top facing +Z.
//   depthMic     : base bottom at y=0 (centred), rod tip at y=-value, +Z front.
//   heightGauge  : base on y=0, scriber edge at (110, value, 0), LCD facing +Z.
//   dialIndicator: magnetic base on y=0, contact point at (140, userData.tipY, 0); setHeight(y) moves the arm.
function buildCaliper() {
  const m = mats();
  const root = new THREE.Group();
  root.name = 'caliper';
  const F = new Kit();
  // beam
  bx(F, m.satin, -12, 0, -1.75, 222, 16, 1.75, 0.4);
  // fixed outside jaw (measuring face x = 0, facing +X)
  F.add(ext([[-14, 2], [0, 2], [0, -38.5], [-1.2, -40.8], [-4.5, -38], [-12, -16], [-14, -6]], 3.5, 0.15), m.satin);
  // fixed inside jaw (measuring face x = 0, facing -X), offset behind
  F.add(ext([[1.2, 16], [-13, 16], [-13, 18.5], [-0.3, 24.5], [0, 32.5], [1.3, 32.5], [2.7, 30], [2.7, 19]], 1.5, 0.1), m.satin, [0, 0, -0.95]);
  // beam end cap
  bx(F, m.dark, 220.5, 0.5, -2.2, 222.6, 15.5, 2.2, 0.3);
  F.build(root, 'caliper-body');
  const scale = texMesh(new THREE.PlaneGeometry(234, 16), caliperScaleTexture(), { metalness: 0.75, roughness: 0.3 });
  scale.position.set(105, 8, 1.78);
  root.add(scale);

  // slider (moves to x = value)
  const slider = new THREE.Group();
  slider.name = 'slider';
  const S = new Kit();
  // moving outside jaw (face at x = 0 facing -X)
  S.add(ext([[0, 2], [14, 2], [14, -6], [12, -16], [4.5, -38], [1.2, -40.8], [0, -38.5]], 3.5, 0.15), m.satin);
  // moving inside jaw (face at x = 0 facing +X), in front
  S.add(ext([[-1.2, 16], [13, 16], [13, 18.5], [0.3, 24.5], [0, 32.5], [-1.3, 32.5], [-2.7, 30], [-2.7, 19]], 1.5, 0.1), m.satin, [0, 0, 0.95]);
  // slider frame around the beam
  bx(S, m.satin, 0, -3, 1.75, 16, 18.6, 3.2, 0.5);
  bx(S, m.satin, 0, -3, -3.4, 82, 18.6, -1.75, 0.6);
  bx(S, m.satin, 0, 16, -3.4, 82, 18.6, 3.2, 0.5);
  bx(S, m.satin, 0, -3, -3.4, 82, 0, 3.2, 0.5);
  // electronics housing
  bx(S, m.black, 15, -16, 1.6, 84, 24, 9.5, 3.2);
  // buttons
  for (const [x, mat] of [[30, m.dark], [47, m.dark], [64, m.dark]]) S.add(cyl(3.4, 2.2, 'z', 20), mat, [x, -8.2, 10.3]);
  // thumb roller under the beam
  S.add(cyl(5, 4.5, 'z', 28), m.dark, [74, -9.5, 0]);
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * TAU;
    S.add(box(1, 1, 4.6), m.steel, [74 + Math.cos(a) * 5, -9.5 + Math.sin(a) * 5, 0], [0, 0, a]);
  }
  bx(S, m.satin, 68, -5.5, -2.5, 80, -2.5, 2.5, 0.5);
  // lock screw on top
  S.add(cyl(1.6, 4, 'y', 12), m.steel, [10, 20.5, 0]);
  S.add(cyl(3.2, 3, 'y', 18), m.dark, [10, 23.5, 0]);
  // depth rod (behind the beam, in its groove): slider-local 60..222 so it protrudes 'value' past the beam end
  bx(S, m.satin, 60, 7.2, -2.9, 222, 8.8, -1.8);
  S.build(slider, 'caliper-slider');
  // faceplate with LCD
  const face = makeCanvas(552, 320);
  const faceTex = canvasTex(face);
  const fp = texMesh(new THREE.PlaneGeometry(64, 37), faceTex, { metalness: 0.1, roughness: 0.4 });
  fp.position.set(49.5, 4, 9.56);
  slider.add(fp);
  root.add(slider);
  const ud = root.userData;
  ud.id = 'caliper';
  ud.parts = { slider };
  ud.lcd = { canvas: face, tex: faceTex };
  ud.mode = 'outside';
  ud.display = null;
  const drawFace = (txt) => {
    const ctx = face.getContext('2d');
    const k = 552 / 64;
    ctx.fillStyle = '#17181b';
    ctx.fillRect(0, 0, 552, 320);
    ctx.fillStyle = '#9aa0a6';
    ctx.font = '700 22px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('DIGITAL CALIPER', 276, 22);
    drawLCD(ctx, 40, 44, 472, 150, txt, { unit: 'mm' });
    ctx.font = '700 17px Arial, sans-serif';
    ctx.fillStyle = '#c9cdd1';
    const by = 216;
    [['ON/OFF', 30], ['ZERO', 47], ['mm/in', 64]].forEach(([t, x]) => ctx.fillText(t, (x - 17.5) * k, by));
    ctx.font = '600 15px Arial, sans-serif';
    ctx.fillStyle = '#7d848b';
    ctx.fillText('0.01 mm   150 mm', 276, 305);
    faceTex.needsUpdate = true;
  };
  ud.setValue = (v) => {
    ud.value = v;
    slider.position.x = clamp(v, 0, 150);
    drawFace(ud.display ?? formatValue(v, 0.01));
  };
  ud.setDisplay = (txt) => { ud.display = txt; drawFace(txt ?? formatValue(ud.value, 0.01)); };
  ud.setValue(0);
  return root;
}

function buildMicrometer(range = [0, 25]) {
  const m = mats();
  const [a, b] = range;
  const G = b;
  const T = 22 + 0.32 * G; // throat depth
  const root = new THREE.Group();
  root.name = 'micrometer';
  const K = new Kit();
  // C-frame
  const ro = Math.min(26, T * 0.75), ri = Math.min(12, T * 0.35);
  const frame = [
    [-25, 9], [-6, 9], [-6, -T + ri], [-6, -T, -6 + ri, -T], [G + 4 - ri, -T], [G + 4, -T, G + 4, -T + ri], [G + 4, 9], [G + 23, 9],
    [G + 23, -T - 16 + ro], [G + 23, -T - 16, G + 23 - ro, -T - 16], [-25 + ro, -T - 16], [-25, -T - 16, -25, -T - 16 + ro],
  ];
  K.add(ext(frame, 9, 1.0, 16), m.enamel);
  // anvil boss + anvil with carbide face
  K.add(cyl(4.6, 3, 'x', 28), m.satin, [-4.5, 0, 0]);
  K.add(cyl(3.175, 6, 'x', 24), m.satin, [-3.5, 0, 0]);
  K.add(cyl(3.18, 0.9, 'x', 24), m.carbide, [-0.45, 0, 0]);
  // spindle bearing boss + lock lever housing on the right arm
  K.add(cyl(4.6, 3, 'x', 28), m.satin, [G + 2.5, 0, 0]);
  K.add(cyl(7.2, 6, 'x', 28), m.satin, [G + 25, 0, 0]);
  K.add(cyl(3.2, 5, 'y', 16), m.satin, [G + 13, 9.5, 0]);
  K.add(box(16, 2.4, 4.5), m.dark, [G + 19, 13, 0], [0, 0, 0.18]);
  K.add(cyl(2.4, 2.6, 'y', 12), m.dark, [G + 13, 12.5, 0]);
  K.build(root, 'mic-frame');
  // insulating pads (both faces) with a printed label on the front
  const P = new Kit();
  const pad = [[-15, -T - 3.5], [G + 13, -T - 3.5], [G + 13, -T - 12.5], [-15, -T - 12.5]];
  P.add(ext(pad, 1.4, 0.4), m.grip, [0, 0, 5.4]);
  P.add(ext(pad, 1.4, 0.4), m.grip, [0, 0, -5.4]);
  P.build(root, 'mic-pads');
  const lab = texMesh(new THREE.PlaneGeometry(G + 22, 7.4), labelTexture([{ text: `${a}-${b} mm    0.001 mm`, size: 40 }], { w: 1024, h: 96, bg: '#151618', fg: '#c8ccd0' }), { metalness: 0, roughness: 0.7 });
  lab.position.set((G - 2) / 2, -T - 8, 6.55);
  root.add(lab);
  // sleeve (fixed): from G+28 to G+28+46, zero line at G+32
  const sLen = 46, s0 = G + 28;
  const sleeveGeo = new THREE.CylinderGeometry(6.4, 6.4, sLen, 64, 1, true, -Math.PI, TAU);
  sleeveGeo.rotateZ(-Math.PI / 2);
  const sleeve = texMesh(sleeveGeo, sleeveTexture({ vernier: true, len: sLen, zeroAt: 4, min: a }), { metalness: 0.75, roughness: 0.3, shadow: true });
  sleeve.position.set(s0 + sLen / 2, 0, 0);
  root.add(sleeve);
  // moving: spindle + thimble + ratchet
  const mov = new THREE.Group();
  mov.name = 'spindle';
  const SP = new Kit();
  SP.add(cyl(3.175, G - a + 44, 'x', 24), m.chrome, [(G - a + 44) / 2, 0, 0]);
  SP.add(cyl(3.18, 0.9, 'x', 24), m.carbide, [0.45, 0, 0]);
  SP.build(mov);
  const thimble = new THREE.Group();
  // lathe profile (radius, x): edge at x = 0 of the thimble group
  const prof = [[6.5, 0], [8.4, 2.6], [8.4, 14], [8.9, 15], [8.9, 33], [8.4, 34], [5, 35.5], [4.4, 36]];
  const th = texMesh(lathe(prof, 64, 'x'), thimbleTexture(), { metalness: 0.75, roughness: 0.3, shadow: true });
  thimble.add(th);
  mov.add(thimble);
  const R = new Kit();
  R.add(cyl(4.8, 14, 'x', 20), m.dark, [43, 0, 0]);
  for (let k = 0; k < 20; k++) {
    const ang = (k / 20) * TAU;
    R.add(box(14, 0.8, 0.8), m.steel, [43, Math.cos(ang) * 4.8, Math.sin(ang) * 4.8]);
  }
  R.add(cyl(3.6, 3, 'x', 20), m.satin, [51.5, 0, 0]);
  R.build(thimble);
  root.add(mov);
  const ud = root.userData;
  ud.id = 'micrometer';
  ud.range = range;
  ud.parts = { spindle: mov, thimble };
  ud.setValue = (v) => {
    v = clamp(v, a, b);
    ud.value = v;
    mov.position.x = v;
    // thimble edge sits at the sleeve zero line (G+32) when v = a
    thimble.position.x = G + 32 - v + (v - a);
    thimble.rotation.x = ((v - a) / 0.5) * TAU;
  };
  ud.setValue(a + 2.5);
  return root;
}

function buildBoreGauge(range = [18, 35]) {
  const m = mats();
  const root = new THREE.Group();
  root.name = 'boreGauge';
  const [lo] = range;
  const bh = Math.max(5.5, lo * 0.28); // half length of the head body
  const K = new Kit();
  // measuring head body
  K.add(cyl(5.2, bh * 2, 'x', 28), m.satin, [0, 0, 0]);
  K.add(rbox(bh * 1.4, 13, 11, 2), m.satin, [0, 5, 0]);
  // centralising bridge: yoke with two guide pads on the movable side
  K.add(new THREE.TorusGeometry(6.2, 1.1, 10, 24, Math.PI), m.steel, [bh * 0.55, 0, 0], [0, Math.PI / 2, 0]);
  for (const s of [-1, 1]) K.add(cyl(1.3, bh * 0.6, 'x', 12), m.steel, [bh * 0.75, -0.5, s * 6.2]);
  // neck, shaft and grip
  K.add(cyl(5, 22, 'y', 24), m.satin, [0, 21, 0]);
  K.add(cyl(8, 6, 'y', 28), m.satin, [0, 34, 0]);
  K.add(cyl(7.8, 160, 'y', 28), m.chrome, [0, 115, 0]);
  K.add(lathe([[0, 125], [11, 125], [11.5, 128], [11, 131], [11.5, 134], [11, 137], [11.5, 140], [11, 143], [11.5, 146], [11, 149], [11.5, 152], [11, 155], [11.5, 158], [11, 161], [11.5, 164], [11, 167], [11, 172], [0, 172]], 32), m.grip);
  K.add(cyl(8.5, 10, 'y', 28), m.satin, [0, 198, 0]);
  K.add(cyl(4, 14, 'y', 16), m.chrome, [0, 209, 0]);
  // dial indicator body (face +Z), centre at y = 245
  const dy = 245;
  K.add(lathe([[0, -9], [27, -9], [29, -7], [29, 7], [0, 7]], 48, 'z'), m.satin, [0, dy, 0]);
  K.add(new THREE.TorusGeometry(27.6, 2.4, 12, 48), m.chrome, [0, dy, 7.6]);
  K.add(cyl(5.5, 8, 'y', 20), m.satin, [0, dy - 30, 0]);
  K.add(cyl(3, 6, 'y', 16), m.satin, [0, dy + 31, 0]);
  K.add(cyl(4.5, 3, 'y', 16), m.dark, [0, dy + 35, 0]);
  // tolerance markers on the bezel
  K.add(box(2, 4, 1.6), m.green, [Math.sin(0.5) * 27.6, dy + Math.cos(0.5) * 27.6, 9.6], [0, 0, -0.5]);
  K.add(box(2, 4, 1.6), m.red, [Math.sin(-0.5) * 27.6, dy + Math.cos(-0.5) * 27.6, 9.6], [0, 0, 0.5]);
  K.build(root, 'bore-body');
  const face = texMesh(new THREE.CircleGeometry(26.2, 64), dialTexture('bore'), { metalness: 0, roughness: 0.55 });
  face.position.set(0, dy, 7.4);
  root.add(face);
  const needle = new THREE.Group();
  needle.position.set(0, dy, 8.2);
  const N = new Kit();
  N.add(box(0.9, 26, 0.5), m.red, [0, 8.5, 0]);
  N.add(cyl(2.2, 1.4, 'z', 16), m.dark, [0, 0, 0.3]);
  N.build(needle);
  root.add(needle);
  // anvils: fixed (left) and movable plunger (right); unit length scaled along X
  const anvL = new THREE.Group(), anvR = new THREE.Group();
  const AK = new Kit();
  AK.add(cyl(1.6, 1, 'x', 14), m.satin, [0.5, 0, 0]);
  AK.build(anvL);
  const BK = new Kit();
  BK.add(cyl(1.6, 1, 'x', 14), m.chrome, [0.5, 0, 0]);
  BK.build(anvR);
  const tipL = new THREE.Mesh(new THREE.SphereGeometry(1.9, 14, 10), m.carbide);
  const tipR = new THREE.Mesh(new THREE.SphereGeometry(1.9, 14, 10), m.carbide);
  // anvil nut on the fixed side
  const nut = new THREE.Mesh(cyl(3.2, 3, 'x', 6), m.dark);
  root.add(anvL, anvR, tipL, tipR, nut);
  const ud = root.userData;
  ud.id = 'boreGauge';
  ud.range = range;
  ud.zero = null;
  ud.parts = { needle, anvL, anvR };
  ud.setValue = (v, zero = ud.zero) => {
    ud.value = v;
    const h = Math.max(bh + 1, v / 2 - 1.9);
    anvL.scale.x = h - bh;
    anvL.position.x = -h;
    anvR.scale.x = h - bh;
    anvR.position.x = bh;
    tipL.position.x = -h - 0.0;
    tipR.position.x = h;
    nut.position.x = -bh - 2;
    const dev = zero == null ? 0 : v - zero;
    needle.rotation.z = -(dev / 0.2) * TAU;
  };
  ud.setZero = (z) => { ud.zero = z; ud.setValue(ud.value ?? z); };
  ud.setValue((range[0] + range[1]) / 2);
  return root;
}

function buildDepthMic() {
  const m = mats();
  const root = new THREE.Group();
  root.name = 'depthMic';
  const K = new Kit();
  K.add(rbox(63, 12, 16, 1.2), m.satin, [0, 6, 0]);
  bx(K, m.carbide, -31.4, -0.05, -7.9, 31.4, 0.4, 7.9);
  K.add(cyl(9, 4, 'y', 28), m.satin, [0, 14, 0]);
  K.build(root, 'depth-base');
  const sLen = 34;
  const sg = new THREE.CylinderGeometry(6.4, 6.4, sLen, 64, 1, true, -Math.PI, TAU);
  const sleeve = texMesh(sg, sleeveTexture({ vernier: false, depth: true, len: sLen, zeroAt: 4.5 }), { metalness: 0.75, roughness: 0.3, shadow: true });
  sleeve.position.set(0, 16 + sLen / 2, 0);
  root.add(sleeve);
  // thimble (edge at the bottom), moves down as the rod extends
  const thimble = new THREE.Group();
  const prof = [[6.5, 0], [8.4, 2.6], [8.4, 14], [8.9, 15], [8.9, 33], [8.4, 34], [5, 35.5], [4.4, 36]];
  thimble.add(texMesh(lathe(prof, 64, 'y'), thimbleTexture(), { metalness: 0.75, roughness: 0.3, shadow: true }));
  const R = new Kit();
  R.add(cyl(4.8, 14, 'y', 20), m.dark, [0, 43, 0]);
  R.add(cyl(3.6, 3, 'y', 20), m.satin, [0, 51.5, 0]);
  R.build(thimble);
  root.add(thimble);
  const rod = new THREE.Mesh(cyl(2, 1, 'y', 16), m.chrome);
  root.add(rod);
  const ud = root.userData;
  ud.id = 'depthMic';
  ud.range = [0, 25];
  ud.parts = { rod, thimble };
  ud.setValue = (v) => {
    ud.value = v;
    const r = INSTRUMENT.depthMic.ranges.find(([a, b]) => v >= a && v <= b) || [0, 25];
    const s = clamp(v - r[0], 0, 25);
    // sleeve: zero at the top (sleeve row y = 16 + sLen - 4.5), increasing downwards
    thimble.position.y = 16 + sLen - 4.5 - s;
    thimble.rotation.y = -(s / 0.5) * TAU;
    rod.scale.y = v + 30;
    rod.position.y = -v + (v + 30) / 2;
  };
  ud.setValue(5);
  return root;
}

function buildHeightGauge() {
  const m = mats();
  const root = new THREE.Group();
  root.name = 'heightGauge';
  const K = new Kit();
  // base with ground bottom, column at the back
  K.add(rbox(105, 26, 76, 4), m.castIron, [-7.5, 13, 0]);
  bx(K, m.satin, -59, -0.05, -37, 44, 1.2, 37, 0.6);
  bx(K, m.satin, -44, 26, -16, -16, 34, 16, 1);
  bx(K, m.satin, -37, 26, -6, -23, 375, 6, 0.8);
  // rack on the column front
  bx(K, m.dark, -37.2, 34, 6, -31, 370, 7.2);
  bx(K, m.dark, -40, 375, -9, -20, 382, 9, 1.5);
  K.build(root, 'hg-frame');
  const slider = new THREE.Group();
  const S = new Kit();
  // slider housing
  S.add(rbox(36, 70, 30, 3), m.black, [-30, 70, 0]);
  bx(S, m.satin, -40, 35, -14, -20, 40, 14, 1);
  // handwheel for the fine feed (left side)
  S.add(cyl(11, 6, 'x', 32), m.dark, [-51, 58, 0]);
  S.add(cyl(4, 4, 'x', 16), m.satin, [-56, 58, 0]);
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * TAU;
    S.add(box(6.4, 1, 1), m.steel, [-51, 58 + Math.cos(a) * 11, Math.sin(a) * 11]);
  }
  // scriber holder arm + clamp + scriber (measuring edge at y = 0)
  bx(S, m.satin, -12, 35, -6, 60, 46, 6, 1);
  bx(S, m.satin, 48, 0, -8, 64, 46, 8, 1.2);
  S.add(cyl(3, 6, 'z', 14), m.dark, [56, 30, 11]);
  S.add(ext([[44, 0], [104, 0], [111, 2.6], [104, 5.2], [44, 5.2]], 5, 0.2), m.satin);
  bx(S, m.carbide, 100, 0.0, -2.4, 108, 3.6, 2.4, 0.2);
  S.build(slider, 'hg-slider');
  const face = makeCanvas(384, 384);
  const faceTex = canvasTex(face);
  const fp = texMesh(new THREE.PlaneGeometry(32, 32), faceTex, { metalness: 0.1, roughness: 0.4 });
  fp.position.set(-30, 80, 15.05);
  slider.add(fp);
  root.add(slider);
  const ud = root.userData;
  ud.id = 'heightGauge';
  ud.parts = { slider };
  const drawFace = (txt) => {
    const ctx = face.getContext('2d');
    ctx.fillStyle = '#17181b';
    ctx.fillRect(0, 0, 384, 384);
    ctx.fillStyle = '#9aa0a6';
    ctx.font = '700 26px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('HEIGHT GAUGE', 192, 38);
    drawLCD(ctx, 22, 62, 340, 130, txt, { unit: 'mm' });
    ctx.font = '700 22px Arial, sans-serif';
    ctx.fillStyle = '#c9cdd1';
    [['ON', 70], ['ZERO', 192], ['HOLD', 314]].forEach(([t, x]) => {
      ctx.fillStyle = '#3a3e43';
      ctx.beginPath(); ctx.arc(x, 270, 30, 0, TAU); ctx.fill();
      ctx.fillStyle = '#c9cdd1';
      ctx.fillText(t, x, 278);
    });
    ctx.font = '600 18px Arial, sans-serif';
    ctx.fillStyle = '#7d848b';
    ctx.fillText('0-300 mm   0.01 mm', 192, 350);
    faceTex.needsUpdate = true;
  };
  ud.setValue = (v) => {
    ud.value = v;
    slider.position.y = clamp(v, 0, 300);
    drawFace(formatValue(v, 0.01));
  };
  ud.setValue(40);
  return root;
}

function buildDialIndicator() {
  const m = mats();
  const root = new THREE.Group();
  root.name = 'dialIndicator';
  const K = new Kit();
  // magnetic base with on/off knob
  K.add(rbox(50, 55, 60, 3), m.mag, [0, 27.5, 0]);
  bx(K, m.satin, -25.05, 0, -30.05, 25.05, 8, 30.05, 0.5);
  K.add(cyl(9, 8, 'z', 24), m.dark, [0, 30, 33]);
  K.add(box(4, 22, 4), m.red, [0, 36, 38]);
  K.add(cyl(12, 10, 'y', 28), m.satin, [0, 60, 0]);
  // post
  K.add(cyl(6, 200, 'y', 24), m.chrome, [0, 165, 0]);
  K.add(cyl(7, 4, 'y', 24), m.satin, [0, 266, 0]);
  K.build(root, 'stand-base');
  const arm = new THREE.Group();
  const A = new Kit();
  // clamp on the post
  A.add(rbox(22, 22, 22, 3), m.satin, [0, 0, 0]);
  A.add(cyl(3, 10, 'z', 12), m.steel, [0, 0, 15]);
  A.add(cyl(6, 5, 'z', 18), m.dark, [0, 0, 21]);
  // horizontal arm
  A.add(cyl(5, 150, 'x', 18), m.chrome, [80, 0, 0]);
  // swivel clamp at the arm end + vertical rod to the indicator lug
  A.add(rbox(16, 16, 16, 2.5), m.satin, [140, 0, 0]);
  A.add(cyl(4, 24, 'y', 14), m.chrome, [140, -12, -12]);
  A.add(box(10, 10, 8), m.satin, [140, -24, -12]);
  // indicator (face +Z), centre at y = -40
  A.add(lathe([[0, -8], [26.5, -8], [28.5, -6], [28.5, 7], [0, 7]], 48, 'z'), m.satin, [140, -52, 0]);
  A.add(new THREE.TorusGeometry(27, 2.4, 12, 48), m.chrome, [140, -52, 7.6]);
  A.add(cyl(4.5, 6, 'y', 16), m.satin, [140, -52 + 32, 0]);
  A.add(cyl(5.2, 6, 'y', 16), m.dark, [140, -52 + 37, 0]);
  A.add(cyl(4, 18, 'y', 16), m.chrome, [140, -52 - 37, 0]);
  A.add(cyl(2.35, 9, 'y', 12), m.steel, [140, -52 - 50, 0]);
  A.add(cyl(1, 3, 'y', 10), m.carbide, [140, -52 - 55.5, 0]);
  A.add(new THREE.SphereGeometry(1.5, 12, 8), m.carbide, [140, -52 - 57.5, 0]);
  A.build(arm, 'stand-arm');
  const face = texMesh(new THREE.CircleGeometry(25.6, 64), dialTexture('ind'), { metalness: 0, roughness: 0.55 });
  face.position.set(140, -52, 7.4);
  arm.add(face);
  const needle = new THREE.Group();
  needle.position.set(140, -52, 8.2);
  const N = new Kit();
  N.add(box(0.9, 25, 0.5), m.red, [0, 8, 0]);
  N.add(cyl(2.2, 1.4, 'z', 16), m.dark, [0, 0, 0.3]);
  N.build(needle);
  arm.add(needle);
  root.add(arm);
  const TIP = 52 + 59; // contact point below the arm axis
  const ud = root.userData;
  ud.id = 'dialIndicator';
  ud.parts = { arm, needle };
  ud.setHeight = (yTip) => {
    const hc = clamp(yTip + TIP, 75, 255);
    arm.position.y = hc;
    ud.tipY = hc - TIP;
  };
  ud.setValue = (dev) => {
    ud.value = dev;
    needle.rotation.z = -(dev / 1) * TAU;
  };
  ud.setHeight(30);
  ud.setValue(0);
  ud.tipX = 140;
  return root;
}

// Builds the 3D model of an instrument. opts.range for micrometer / boreGauge ([min, max]).
export function buildInstrumentModel(id, opts = {}) {
  let g;
  switch (id) {
    case 'caliper': g = buildCaliper(); break;
    case 'micrometer': g = buildMicrometer(opts.range || [0, 25]); break;
    case 'boreGauge': g = buildBoreGauge(opts.range || [18, 35]); break;
    case 'depthMic': g = buildDepthMic(); break;
    case 'heightGauge': g = buildHeightGauge(); break;
    case 'dialIndicator': g = buildDialIndicator(); break;
    default: throw new Error('unknown instrument ' + id);
  }
  g.userData.instrument = INSTRUMENT[id];
  g.traverse((o) => { o.userData.noMeasure = true; });
  return g;
}

// Bench prop: the instrument laid out in the workshop's instrument-slot frame (+X along the tray,
// +Y up, +Z toward the user), origin at the resting point (bottom centre of its bounding box).
// caliper / micrometer / boreGauge / depthMic / dialIndicator lie flat (readout facing up, jaws / frame
// toward the user); heightGauge stands upright on its base. Just copy the slot position/quaternion
// onto the returned group. The articulated model is group.userData.model.
export function buildInstrumentProp(id, opts = {}) {
  const model = opts.model || buildInstrumentModel(id, opts);
  const wrap = new THREE.Group();
  wrap.name = `prop-${id}`;
  const inner = new THREE.Group();
  inner.add(model);
  if (id === 'boreGauge') inner.quaternion.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, -Math.PI / 2, 'XYZ')); // shaft along +X, dial up
  else if (id !== 'heightGauge') inner.rotation.x = -Math.PI / 2; // model +Z (readout) up, model -Y toward the user
  if (id === 'heightGauge') model.userData.setValue?.(60);
  if (id === 'dialIndicator') model.userData.setHeight?.(60);
  wrap.add(inner);
  inner.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(inner);
  const c = b.getCenter(new THREE.Vector3());
  inner.position.set(-c.x, -b.min.y, -c.z);
  wrap.userData = { id, model, size: b.getSize(new THREE.Vector3()) };
  model.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return wrap;
}

// =================================================================== UI
const ICONS = {
  caliper: '<path d="M3 6h18v3H3zM4 9v9l2.5 2V9M10 9v8l-2 3V9M4 6V3l2 0v3M10 6V3.5L8.5 3V6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><rect x="10" y="9.5" width="7" height="4" rx="1" fill="currentColor" opacity=".55"/>',
  micrometer: '<path d="M4 7v6a6 6 0 0 0 6 6h3a6 6 0 0 0 6-6V7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4 7h3M13 7h8M7 6.2v1.6" stroke="currentColor" stroke-width="1.6"/><rect x="14" y="5" width="8" height="4" rx="1" fill="currentColor" opacity=".6"/>',
  boreGauge: '<circle cx="12" cy="6" r="4.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 6l2-2" stroke="currentColor" stroke-width="1.3"/><path d="M12 10.2V19M8 20h8" stroke="currentColor" stroke-width="2"/><path d="M6.5 20h-2M17.5 20h2" stroke="currentColor" stroke-width="1.3"/>',
  depthMic: '<rect x="3" y="12" width="18" height="3" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 15v6" stroke="currentColor" stroke-width="1.6"/><rect x="9.5" y="3" width="5" height="9" rx="1" fill="currentColor" opacity=".55"/>',
  heightGauge: '<path d="M4 20h12v-3H4zM7 17V3" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="5" y="8" width="5" height="5" rx="1" fill="currentColor" opacity=".55"/><path d="M10 11h10l1 1" stroke="currentColor" stroke-width="1.5" fill="none"/>',
  dialIndicator: '<path d="M3 20h7v-5H3zM6.5 15V4h11" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="17.5" cy="10" r="3.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M17.5 13.6V18" stroke="currentColor" stroke-width="1.5"/>',
};

const CSS = `
.ms-root{position:absolute;inset:0;pointer-events:none;z-index:40;font:13px/1.4 var(--f-ui,"IBM Plex Sans","Segoe UI",system-ui,sans-serif);color:var(--text,#d8dee5);-webkit-user-select:none;user-select:none}
.ms-root *{box-sizing:border-box}
.ms-root [hidden]{display:none!important}
.ms-card{background:rgba(22,25,28,.94);border:1px solid var(--line-2,#363d45);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.45);pointer-events:auto;backdrop-filter:blur(6px)}
.ms-top{position:absolute;left:12px;top:12px;padding:8px 12px;display:flex;gap:12px;align-items:center;max-width:calc(100% - 140px)}
.ms-top b{font:700 13px var(--f-cond,"IBM Plex Sans Condensed","Arial Narrow",sans-serif);letter-spacing:.12em;text-transform:uppercase;color:var(--accent-2,#74aeff)}
.ms-top span{color:var(--muted,#86919d);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ms-close{position:absolute;right:12px;top:12px;height:34px;padding:0 12px;display:flex;align-items:center;gap:8px;border-radius:8px;border:1px solid var(--line-2,#363d45);background:var(--panel-3,#22272c);color:var(--text,#d8dee5);cursor:pointer;pointer-events:auto;font-weight:600}
.ms-close:hover{background:#2a3037}
.ms-close kbd,.ms-tool kbd{font:600 10px var(--f-mono,ui-monospace,monospace);background:#0f1113;border:1px solid #3a424b;border-bottom-width:2px;border-radius:4px;padding:0 5px;color:var(--text-2,#b4bdc6)}
.ms-bottom{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:8px;width:min(760px,calc(100% - 24px))}
.ms-hintbar{display:flex;align-items:center;gap:10px;padding:7px 12px;flex-wrap:wrap;justify-content:center;width:100%}
.ms-hint{color:var(--text-2,#b4bdc6);text-align:center}
.ms-hint i{font-style:normal;color:var(--warn,#f0b429);font-weight:600}
.ms-chips{display:flex;gap:4px;flex-wrap:wrap;justify-content:center}
.ms-chip{height:26px;padding:0 10px;border-radius:13px;border:1px solid var(--line-2,#363d45);background:var(--panel-2,#1b1f23);color:var(--text-2,#b4bdc6);cursor:pointer;font:600 12px var(--f-ui,system-ui)}
.ms-chip:hover{border-color:#4b5560}
.ms-chip.on{background:var(--accent-bg,rgba(61,139,253,.13));border-color:var(--accent,#3d8bfd);color:var(--accent-2,#74aeff)}
.ms-tray{display:flex;gap:4px;padding:6px;width:100%;justify-content:center}
.ms-tool{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;gap:3px;padding:7px 4px 6px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--text-2,#b4bdc6);cursor:pointer;position:relative}
.ms-tool svg{width:28px;height:28px}
.ms-tool span{font:600 11px var(--f-cond,"Arial Narrow",sans-serif);letter-spacing:.03em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.ms-tool kbd{position:absolute;top:4px;left:5px}
.ms-tool:hover{background:var(--panel-3,#22272c)}
.ms-tool.on{background:var(--accent-bg,rgba(61,139,253,.13));border-color:var(--accent,#3d8bfd);color:#fff}
.ms-read{position:absolute;right:12px;top:58px;width:min(380px,calc(100% - 24px));padding:12px}
.ms-read h3{margin:0;font:700 12px var(--f-cond,"Arial Narrow",sans-serif);letter-spacing:.14em;text-transform:uppercase;color:var(--muted,#86919d);display:flex;justify-content:space-between;gap:8px}
.ms-read h3 em{font-style:normal;color:var(--text-2,#b4bdc6);letter-spacing:.04em;text-transform:none}
.ms-read canvas{display:block;width:100%;height:auto;margin:8px 0 6px;border-radius:6px;background:#0d0f11}
.ms-what{font-weight:600;color:var(--text,#d8dee5);min-height:18px}
.ms-big{font:600 26px var(--f-mono,ui-monospace,monospace);color:#fff;letter-spacing:.02em}
.ms-big small{font-size:13px;color:var(--muted,#86919d);margin-left:4px}
.ms-sub{color:var(--muted,#86919d);font-size:12px;min-height:16px}
.ms-err{color:#ffb4a8;background:rgba(255,92,92,.1);border:1px solid rgba(255,92,92,.35);border-radius:6px;padding:6px 8px;margin-top:6px}
.ms-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px}
.ms-row label{display:flex;align-items:center;gap:6px;color:var(--text-2,#b4bdc6);cursor:pointer}
.ms-in{width:84px;height:26px;border-radius:6px;border:1px solid var(--line-2,#363d45);background:#0f1113;color:var(--text,#d8dee5);padding:0 7px;font:500 12px var(--f-mono,ui-monospace,monospace);-webkit-user-select:text;user-select:text}
.ms-in:focus{outline:none;border-color:var(--accent,#3d8bfd)}
.ms-btn{height:26px;padding:0 10px;border-radius:6px;border:1px solid var(--line-2,#363d45);background:var(--panel-3,#22272c);color:var(--text,#d8dee5);cursor:pointer;font:600 12px var(--f-ui,system-ui)}
.ms-btn:hover{background:#2a3037}
.ms-log{position:absolute;left:12px;top:58px;width:min(470px,calc(100% - 24px));max-height:calc(100% - 250px);display:flex;flex-direction:column;padding:10px 10px 8px}
.ms-log header{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.ms-log header b{font:700 12px var(--f-cond,"Arial Narrow",sans-serif);letter-spacing:.14em;text-transform:uppercase;color:var(--muted,#86919d);flex:1}
.ms-log .ms-scroll{overflow:auto;min-height:0}
.ms-log table{width:100%;border-collapse:collapse;font-size:12px}
.ms-log th{font:600 10px var(--f-cond,"Arial Narrow",sans-serif);letter-spacing:.08em;text-transform:uppercase;color:var(--dim,#5d6772);text-align:left;padding:3px 4px;border-bottom:1px solid var(--line,#2a3036);position:sticky;top:0;background:#16191c}
.ms-log td{padding:3px 4px;border-bottom:1px solid rgba(255,255,255,.04);vertical-align:middle;white-space:nowrap}
.ms-log td.w{white-space:normal;color:var(--text-2,#b4bdc6);max-width:150px}
.ms-log td.v{font-family:var(--f-mono,ui-monospace,monospace);color:#fff}
.ms-log td.d{font-family:var(--f-mono,ui-monospace,monospace)}
.ms-log .ms-in{width:62px;height:22px;font-size:11px;padding:0 4px}
.ms-log .ms-in.t{width:48px}
.ms-ok{color:var(--ok,#34c77b);font-weight:700}
.ms-ng{color:var(--err,#ff5c5c);font-weight:700}
.ms-empty{color:var(--dim,#5d6772);padding:10px 4px;text-align:center}
.ms-log.min .ms-scroll{display:none}
.ms-flash{animation:ms-flash .9s ease-out}
@keyframes ms-flash{from{background:rgba(61,139,253,.35)}to{background:transparent}}
.ms-zoom{position:absolute;right:12px;bottom:12px;display:flex;flex-direction:column;gap:4px;pointer-events:auto}
.ms-zoom button{width:34px;height:34px;border-radius:8px;border:1px solid var(--line-2,#363d45);background:rgba(22,25,28,.94);color:var(--text,#d8dee5);font:600 16px var(--f-ui,system-ui);cursor:pointer}
@media (max-width:900px){
  .ms-log{top:auto;bottom:178px;max-height:34%;width:calc(100% - 24px)}
  .ms-read{top:56px;width:calc(100% - 24px);max-width:420px}
  .ms-read canvas{max-height:150px;object-fit:contain}
  .ms-tool span{display:none}
  .ms-zoom{bottom:auto;top:12px;right:150px;flex-direction:row}
}
@media (max-width:900px) and (max-height:700px){ .ms-log{display:none} }
`;
let cssDone = false;
function injectCSS() {
  if (cssDone || typeof document === 'undefined') return;
  cssDone = true;
  const s = document.createElement('style');
  s.id = 'ms-style';
  s.textContent = CSS;
  document.head.appendChild(s);
}
const h = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const HINTS = {
  caliper: {
    outside: ['Click two <i>opposite outside faces</i> (or the top edges next to them). The jaws close at the lower click height.', 'Now click the <i>opposite face</i>.'],
    inside: ['Click the <i>floor of a pocket, slot or bore</i>, near the wall you want to measure across.'],
    depth: ['Click the <i>top face</i> for the beam end, then the <i>floor</i> for the depth rod.', 'Now click the <i>floor</i> of the pocket or hole.'],
  },
  micrometer: ['Pick the frame range, then click two <i>opposite outside faces</i>.', 'Now click the <i>opposite face</i>.'],
  boreGauge: ['Pick the head, then click <i>inside a round bore</i> (on its floor).'],
  depthMic: ['Click the <i>reference face</i> for the base, then the <i>floor</i> for the rod.', 'Now click the <i>floor</i> to measure.'],
  heightGauge: ['Click <i>any face</i>: the scriber reads its height above the surface plate.'],
  dialIndicator: ['Click a <i>face</i> to sweep the indicator across it (flatness, TIR).'],
};

// =================================================================== MeasuringStation
export class MeasuringStation {
  constructor({ scene, camera, dom, container, manageCamera = true } = {}) {
    this.scene = scene;
    this.camera = camera;
    this.dom = dom;
    this.container = container || dom?.parentElement || document.body;
    this.manageCamera = manageCamera;
    this.onClose = () => {};
    this.onMeasure = () => {};
    this.onSelect = () => {}; // (instrumentId) => {}: e.g. hide that instrument's bench prop while in use
    this.log = [];
    this._active = false;
    this.sel = 'caliper';
    this.mode = { caliper: 'outside' };
    this.rangeIdx = { micrometer: 3, boreGauge: 0 };
    this.showValue = { micrometer: false, depthMic: true };
    this.ringSize = null;
    this.clicks = [];
    this.models = new Map();
    this.model = null;
    this.anim = null;
    this.pose = null;
    this.lastResult = null;
    this.raycaster = new THREE.Raycaster();
    this.holder = new THREE.Group();
    this.holder.name = 'ms-instrument';
    this.markers = new THREE.Group();
    this.markers.name = 'ms-markers';
    this._seq = 0;
    injectCSS();
    this._buildUI();
    this._bind();
  }

  get active() { return this._active; }

  // ------------------------------------------------------------------ open / close
  open({ zmap, placement, part, partGroup, instrument } = {}) {
    if (!zmap || !partGroup) throw new Error('MeasuringStation.open needs zmap and partGroup');
    if (this.part && part && this.part.id !== part.id) this.log = [];
    this.zmap = zmap;
    this.placement = placement;
    this.part = part || null;
    this.partGroup = partGroup;
    this.frame = partFrame(zmap, placement, part);
    this._active = true;
    this.clicks = [];
    this.lastResult = null;
    this.scene.add(this.holder);
    this.scene.add(this.markers);
    this._clearMarkers();
    if (this.container && getComputedStyle(this.container).position === 'static') this.container.style.position = 'relative';
    this.container.appendChild(this.root);
    this.root.hidden = false;
    this.ui.title.textContent = part ? `${part.id} · ${part.title}${part.drawingNo ? ' · ' + part.drawingNo : ''}` : 'Part';
    if (this.manageCamera && this.camera) {
      this._savedCam = { pos: this.camera.position.clone(), quat: this.camera.quaternion.clone(), up: this.camera.up.clone() };
      const S = this.frame.size;
      this.orbit = { yaw: -0.42, pitch: 0.62, dist: Math.max(S.x, S.y) * 1.9 + 230 };
      this._applyCamera();
    }
    this.select(instrument || this.sel, true);
    this._renderLog();
    return this;
  }

  close() {
    if (!this._active) return;
    this._active = false;
    this.root.hidden = true;
    this.scene.remove(this.holder);
    this.scene.remove(this.markers);
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
    if (this.manageCamera && this._savedCam && this.camera) {
      this.camera.position.copy(this._savedCam.pos);
      this.camera.quaternion.copy(this._savedCam.quat);
      this.camera.up.copy(this._savedCam.up);
      this.camera.updateMatrixWorld();
    }
    this._pointers?.clear();
  }

  dispose() {
    this.close();
    this._unbind?.();
  }

  clearLog() {
    this.log = [];
    this._renderLog();
  }

  // ------------------------------------------------------------------ frames
  _pg() {
    this.partGroup.updateWorldMatrix(true, false);
    return this.partGroup.matrixWorld;
  }
  worldToPart(v) {
    const inv = this._pg().clone().invert();
    const l = v.clone().applyMatrix4(inv);
    const D = this.frame.D;
    return { x: l.x - D.x, y: -l.z - D.y, z: l.y - D.z };
  }
  partToLocal(p) {
    const D = this.frame.D;
    return new THREE.Vector3(p.x + D.x, (p.z ?? 0) + D.z, -(p.y + D.y));
  }
  partToWorld(p) {
    return this.partToLocal(p).applyMatrix4(this._pg());
  }
  static dirToLocal(d) {
    return new THREE.Vector3(d[0], d[2], -d[1]);
  }
  // pose in the part frame: { p: {x,y,z}, x: [..], y: [..] } -> local position + quaternion
  _poseLocal(pose) {
    const X = MeasuringStation.dirToLocal(pose.x).normalize();
    const Y = MeasuringStation.dirToLocal(pose.y).normalize();
    const Z = new THREE.Vector3().crossVectors(X, Y).normalize();
    Y.crossVectors(Z, X).normalize();
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
    return { pos: this.partToLocal(pose.p), quat: q };
  }
  _camPart() {
    return this.camera ? this.worldToPart(this.camera.getWorldPosition(new THREE.Vector3())) : { x: 0, y: -500, z: 300 };
  }

  // ------------------------------------------------------------------ camera orbit (optional)
  _center() {
    const S = this.frame.size;
    return this.partToWorld({ x: S.x / 2, y: S.y / 2, z: -S.z * 0.6 });
  }
  _applyCamera() {
    if (!this.orbit || !this.camera) return;
    const o = this.orbit;
    o.pitch = clamp(o.pitch, 0.08, 1.45);
    o.dist = clamp(o.dist, 90, 1600);
    const c = this._center();
    const local = new THREE.Vector3(Math.sin(o.yaw) * Math.cos(o.pitch), Math.sin(o.pitch), Math.cos(o.yaw) * Math.cos(o.pitch)).multiplyScalar(o.dist);
    const q = new THREE.Quaternion();
    this._pg().decompose(new THREE.Vector3(), q, new THREE.Vector3());
    local.applyQuaternion(q);
    this.camera.up.set(0, 1, 0);
    this.camera.position.copy(c).add(local);
    this.camera.lookAt(c);
    this.camera.updateMatrixWorld();
  }
  // Suggested camera framing for callers that manage the camera themselves.
  suggestView() {
    const S = this.frame.size;
    const target = this._center();
    const eye = this.partToWorld({ x: S.x * 0.5 + (Math.max(S.x, S.y) * 1.9 + 230) * 0.33, y: -(Math.max(S.x, S.y) * 1.9 + 230) * 0.73, z: (Math.max(S.x, S.y) * 1.9 + 230) * 0.58 });
    return { eye, target };
  }

  // ------------------------------------------------------------------ UI
  _buildUI() {
    const root = (this.root = h('div', 'ms-root'));
    root.hidden = true;
    const top = h('div', 'ms-card ms-top', '<b>Inspection</b><span></span>');
    const close = h('button', 'ms-close', 'Close <kbd>Esc</kbd>');
    close.type = 'button';
    close.addEventListener('click', () => this._requestClose());
    // reading panel
    const read = h('div', 'ms-card ms-read');
    read.innerHTML = `<h3><span class="ms-rt">Reading</span><em class="ms-rm"></em></h3>
      <canvas class="ms-cv" width="760" height="300"></canvas>
      <div class="ms-what"></div><div class="ms-big"></div><div class="ms-sub"></div>
      <div class="ms-row ms-opt"></div><div class="ms-err" hidden></div>`;
    // log
    const log = h('div', 'ms-card ms-log');
    log.innerHTML = `<header><b>Measurement sheet</b><button class="ms-btn ms-min" type="button">Hide</button><button class="ms-btn ms-clr" type="button">Clear</button></header>
      <div class="ms-scroll"><table><thead><tr><th>#</th><th>Instrument</th><th>Feature</th><th>Value</th><th>Nominal</th><th>± Tol</th><th>Dev</th><th></th></tr></thead><tbody></tbody></table></div>`;
    // bottom: hint + chips + tray
    const bottom = h('div', 'ms-bottom');
    const hintbar = h('div', 'ms-card ms-hintbar', '<div class="ms-chips"></div><div class="ms-hint"></div>');
    const tray = h('div', 'ms-card ms-tray');
    for (const ins of INSTRUMENTS) {
      const b = h('button', 'ms-tool', `<kbd>${ins.key}</kbd><svg viewBox="0 0 24 24">${ICONS[ins.id]}</svg><span>${esc(ins.short)}</span>`);
      b.type = 'button';
      b.title = `${ins.name} (${ins.key}): ${ins.desc}`;
      b.dataset.id = ins.id;
      b.addEventListener('click', () => this.select(ins.id));
      tray.appendChild(b);
    }
    bottom.append(hintbar, tray);
    const zoom = h('div', 'ms-zoom', '<button type="button" data-z="-1" title="Zoom in">+</button><button type="button" data-z="1" title="Zoom out">−</button><button type="button" data-z="0" title="Reset view">⟲</button>');
    zoom.addEventListener('click', (e) => {
      const z = e.target.closest('button')?.dataset.z;
      if (z == null || !this.orbit) return;
      if (z === '0') Object.assign(this.orbit, { yaw: -0.42, pitch: 0.62, dist: Math.max(this.frame.size.x, this.frame.size.y) * 1.9 + 230 });
      else this.orbit.dist *= z === '1' ? 1.2 : 1 / 1.2;
      this._applyCamera();
    });
    if (!this.manageCamera) zoom.hidden = true;
    root.append(top, close, log, read, bottom, zoom);
    for (const el of [top, close, log, read, bottom, zoom]) {
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
      el.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    }
    this.ui = {
      title: top.querySelector('span'), read, cv: read.querySelector('.ms-cv'), rt: read.querySelector('.ms-rt'), rm: read.querySelector('.ms-rm'),
      what: read.querySelector('.ms-what'), big: read.querySelector('.ms-big'), sub: read.querySelector('.ms-sub'), opt: read.querySelector('.ms-opt'),
      err: read.querySelector('.ms-err'), log, tbody: log.querySelector('tbody'), chips: hintbar.querySelector('.ms-chips'),
      hint: hintbar.querySelector('.ms-hint'), tray,
    };
    log.querySelector('.ms-clr').addEventListener('click', () => this.clearLog());
    log.querySelector('.ms-min').addEventListener('click', (e) => {
      log.classList.toggle('min');
      e.target.textContent = log.classList.contains('min') ? 'Show' : 'Hide';
    });
    this.ui.tbody.addEventListener('input', (e) => {
      const t = e.target;
      const rec = this.log.find((r) => String(r.id) === t.dataset.rec);
      if (!rec) return;
      const v = t.value.trim().replace(',', '.');
      const n = v === '' ? undefined : Number(v);
      if (t.dataset.k === 'nominal') rec.nominal = Number.isFinite(n) ? n : undefined;
      else rec.tol = Number.isFinite(n) ? Math.abs(n) : undefined;
      this._updateRow(rec);
    });
  }

  _requestClose() {
    this.close();
    this.onClose();
  }

  select(id, force = false) {
    if (!INSTRUMENT[id]) return;
    const changed = id !== this.sel;
    this.sel = id;
    this.clicks = [];
    this._clearMarkers();
    for (const b of this.ui.tray.children) b.classList.toggle('on', b.dataset.id === id);
    if (changed || force) {
      this.lastResult = null;
      this._showModel(true);
    }
    this._renderChips();
    this._renderHint();
    this._renderReading();
    try { this.onSelect(id); } catch (e) { console.error(e); }
  }

  _range(id = this.sel) {
    const ins = INSTRUMENT[id];
    if (id === 'micrometer' || id === 'boreGauge') return ins.ranges[this.rangeIdx[id]];
    return ins.range;
  }

  _renderChips() {
    const c = this.ui.chips;
    c.innerHTML = '';
    const add = (label, on, fn, title) => {
      const b = h('button', 'ms-chip' + (on ? ' on' : ''), esc(label));
      b.type = 'button';
      if (title) b.title = title;
      b.addEventListener('click', fn);
      c.appendChild(b);
    };
    const id = this.sel;
    if (id === 'caliper') {
      for (const m of ['outside', 'inside', 'depth']) add(m[0].toUpperCase() + m.slice(1), this.mode.caliper === m, () => { this.mode.caliper = m; this.select('caliper', true); });
    } else if (id === 'micrometer' || id === 'boreGauge') {
      INSTRUMENT[id].ranges.forEach(([a, b], i) => add(`${a}-${b}`, this.rangeIdx[id] === i, () => { this.rangeIdx[id] = i; this.select(id, true); }, id === 'micrometer' ? 'Micrometer frame' : 'Measuring head'));
    }
    c.hidden = !c.children.length;
  }

  _renderHint() {
    const id = this.sel;
    let H = HINTS[id];
    if (id === 'caliper') H = H[this.mode.caliper];
    this.ui.hint.innerHTML = H[Math.min(this.clicks.length, H.length - 1)];
  }

  _renderReading() {
    const id = this.sel, ins = INSTRUMENT[id], r = this.lastResult;
    const U = this.ui;
    U.rt.textContent = ins.name;
    const rng = this._range();
    U.rm.textContent = id === 'caliper' ? this.mode.caliper + ' · 0.01 mm' : id === 'micrometer' ? `${rng[0]}-${rng[1]} mm · 0.001` : id === 'boreGauge' ? `head ${rng[0]}-${rng[1]} · 0.002` : `${ins.resolution} mm`;
    U.err.hidden = true;
    U.opt.innerHTML = '';
    const cv = U.cv, ctx = cv.getContext('2d');
    const ok = r && r.ok;
    const val = ok ? r.value : null;
    const res = ins.resolution;
    U.what.textContent = r ? r.what || '' : 'No reading yet';
    U.sub.textContent = ok ? r.sub || '' : '';
    let showBig = true;
    if (id === 'caliper' || id === 'heightGauge') {
      cv.width = 760; cv.height = 250;
      ctx.fillStyle = '#17181b';
      ctx.fillRect(0, 0, 760, 250);
      ctx.fillStyle = '#7d848b';
      ctx.font = '700 22px Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(id === 'caliper' ? 'DIGITAL CALIPER  ·  0.01 mm' : 'DIGITAL HEIGHT GAUGE  ·  0.01 mm', 380, 32);
      drawLCD(ctx, 30, 50, 700, 180, ok ? formatValue(val, res) : r ? '-E-' : '0.00', { unit: 'mm', note: id === 'caliper' ? this.mode.caliper.toUpperCase() : 'ABS', err: !!(r && !ok) });
      showBig = false;
    } else if (id === 'micrometer' || id === 'depthMic') {
      cv.width = 760; cv.height = 330;
      const rg = id === 'micrometer' ? rng : (ok && r.rod) || [0, 25];
      const v = ok ? val : rg[0];
      drawMicrometerScale(ctx, 760, 330, v, { min: rg[0], vernier: id === 'micrometer', title: id === 'micrometer' ? `SLEEVE ${rg[0]}-${rg[1]} mm  ·  THIMBLE 0.01  ·  VERNIER 0.001` : `DEPTH MICROMETER  ·  ROD ${rg[0]}-${rg[1]} mm  ·  0.01` });
      const lab = h('label', '', `<input type="checkbox" ${this.showValue[id] ? 'checked' : ''}> Show value`);
      lab.querySelector('input').addEventListener('change', (e) => { this.showValue[id] = e.target.checked; this._renderReading(); });
      U.opt.appendChild(lab);
      if (!this.showValue[id] && ok) {
        U.big.innerHTML = '<span style="color:#86919d;font-size:15px">Read the scale (sleeve + thimble' + (id === 'micrometer' ? ' + vernier' : '') + ')</span>';
        showBig = null;
      }
    } else if (id === 'boreGauge' || id === 'dialIndicator') {
      cv.width = 760; cv.height = 380;
      ctx.fillStyle = '#0d0f11';
      ctx.fillRect(0, 0, 760, 380);
      if (id === 'boreGauge') {
        const ring = this.ringSize ?? (ok ? Math.round(r.raw) : null);
        const dev = ok && ring != null ? val - ring : 0;
        drawDial(ctx, 360, dev, { ...DIAL_BORE, x: 200, y: 10 });
        ctx.fillStyle = '#86919d';
        ctx.font = '600 20px Arial, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('SET ON RING', 18, 40);
        ctx.fillStyle = '#fff';
        ctx.font = '600 30px monospace';
        ctx.fillText(ring != null ? `Ø${ring.toFixed(3)}` : '-', 18, 78);
        ctx.fillStyle = '#86919d';
        ctx.font = '600 20px Arial, sans-serif';
        ctx.fillText('DIAL', 580, 40);
        ctx.fillStyle = dev >= 0 ? '#9fe0b7' : '#ffc3a8';
        ctx.font = '600 30px monospace';
        if (ok) ctx.fillText(`${dev >= 0 ? '+' : ''}${dev.toFixed(3)}`, 580, 78);
        const inp = h('label', '', `Setting ring Ø <input class="ms-in" type="text" inputmode="decimal" value="${ring != null ? ring : ''}" placeholder="auto">`);
        inp.querySelector('input').addEventListener('change', (e) => {
          const n = Number(e.target.value.replace(',', '.'));
          this.ringSize = e.target.value.trim() && Number.isFinite(n) ? n : null;
          this._renderReading();
        });
        U.opt.appendChild(inp);
        if (ok) U.sub.textContent = `Ø = ring ${ring} ${dev >= 0 ? '+' : '−'} ${Math.abs(dev).toFixed(3)} · roundness ${r.roundness.toFixed(3)} mm`;
      } else {
        const dev = this.anim?.needle ?? (ok ? val : 0);
        drawDial(ctx, 360, dev, { ...DIAL_IND, x: 200, y: 10 });
        ctx.fillStyle = '#86919d';
        ctx.font = '600 20px Arial, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('TIR', 18, 40);
        ctx.fillStyle = '#fff';
        ctx.font = '600 30px monospace';
        if (ok) ctx.fillText(val.toFixed(2), 18, 78);
      }
    }
    if (showBig === true) U.big.innerHTML = ok ? `${formatValue(val, res)}<small>mm</small>` : '';
    else if (showBig === false) U.big.innerHTML = '';
    if (r && !ok) {
      U.err.hidden = false;
      U.err.textContent = r.reason;
    }
  }

  _renderLog() {
    const tb = this.ui.tbody;
    tb.innerHTML = '';
    if (!this.log.length) {
      tb.innerHTML = '<tr><td colspan="8" class="ms-empty">No measurements yet. Pick an instrument and click the part.</td></tr>';
      return;
    }
    for (const rec of this.log) tb.appendChild(this._row(rec));
    const sc = this.ui.log.querySelector('.ms-scroll');
    sc.scrollTop = sc.scrollHeight;
  }
  _row(rec) {
    const tr = h('tr');
    tr.dataset.rec = rec.id;
    const ph = rec.tolDefault != null ? rec.tolDefault : '';
    tr.innerHTML = `<td>${rec.id}</td><td>${esc(INSTRUMENT[rec.instrument].short)}</td><td class="w">${esc(rec.what)}</td>
      <td class="v">${formatValue(rec.value, rec.resolution)}</td>
      <td><input class="ms-in" data-rec="${rec.id}" data-k="nominal" inputmode="decimal" value="${rec.nominal ?? ''}" placeholder="nom."></td>
      <td><input class="ms-in t" data-rec="${rec.id}" data-k="tol" inputmode="decimal" value="${rec.tol ?? ''}" placeholder="${ph}"></td>
      <td class="d"></td><td class="r"></td>`;
    this._updateRow(rec, tr);
    return tr;
  }
  _updateRow(rec, tr = this.ui.tbody.querySelector(`tr[data-rec="${rec.id}"]`)) {
    if (!tr) return;
    const d = tr.querySelector('.d'), r = tr.querySelector('.r');
    if (rec.nominal == null) {
      d.textContent = '';
      r.textContent = '';
      rec.deviation = undefined;
      rec.pass = undefined;
      return;
    }
    const dev = rec.value - rec.nominal;
    const tol = rec.tol ?? rec.tolDefault;
    rec.deviation = dev;
    d.textContent = (dev >= 0 ? '+' : '') + dev.toFixed(decimalsFor(rec.resolution));
    if (tol != null) {
      rec.pass = Math.abs(dev) <= tol + 1e-9;
      r.innerHTML = rec.pass ? '<span class="ms-ok">OK</span>' : '<span class="ms-ng">NG</span>';
      d.className = 'd ' + (rec.pass ? 'ms-ok' : 'ms-ng');
    } else {
      rec.pass = undefined;
      r.textContent = '';
    }
  }

  // ------------------------------------------------------------------ input
  _bind() {
    const dom = this.dom;
    this._pointers = new Map();
    const down = (e) => {
      if (!this._active) return;
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t: performance.now(), moved: false });
      if (this._pointers.size === 2) this._pinch = this._pinchDist();
      try { dom.setPointerCapture(e.pointerId); } catch {}
    };
    const move = (e) => {
      if (!this._active) return;
      const p = this._pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (Math.hypot(p.x - p.x0, p.y - p.y0) > 6) p.moved = true;
      if (!this.orbit || !p.moved) return;
      if (this._pointers.size === 2) {
        const d = this._pinchDist();
        if (this._pinch) this.orbit.dist *= this._pinch / d;
        this._pinch = d;
      } else {
        this.orbit.yaw -= dx * 0.006;
        this.orbit.pitch += dy * 0.005;
      }
      this._applyCamera();
    };
    const up = (e) => {
      if (!this._active) return;
      const p = this._pointers.get(e.pointerId);
      this._pointers.delete(e.pointerId);
      if (!p) return;
      if (!p.moved && performance.now() - p.t < 700 && this._pointers.size === 0 && (e.button === 0 || e.pointerType !== 'mouse')) this._clickScreen(e.clientX, e.clientY);
    };
    const cancel = (e) => this._pointers.delete(e.pointerId);
    const wheel = (e) => {
      if (!this._active || !this.orbit) return;
      e.preventDefault();
      this.orbit.dist *= Math.exp(e.deltaY * 0.001);
      this._applyCamera();
    };
    const key = (e) => {
      if (!this._active) return;
      const t = e.target;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (e.key === 'Escape') {
        if (typing) { t.blur(); e.preventDefault(); return; }
        e.preventDefault();
        e.stopPropagation();
        this._requestClose();
        return;
      }
      if (typing) return;
      const ins = INSTRUMENTS.find((i) => i.key === e.key);
      if (ins) {
        e.preventDefault();
        e.stopPropagation();
        this.select(ins.id);
      }
    };
    if (dom) {
      dom.addEventListener('pointerdown', down);
      dom.addEventListener('pointermove', move);
      dom.addEventListener('pointerup', up);
      dom.addEventListener('pointercancel', cancel);
      dom.addEventListener('wheel', wheel, { passive: false });
    }
    window.addEventListener('keydown', key, true);
    this._unbind = () => {
      if (dom) {
        dom.removeEventListener('pointerdown', down);
        dom.removeEventListener('pointermove', move);
        dom.removeEventListener('pointerup', up);
        dom.removeEventListener('pointercancel', cancel);
        dom.removeEventListener('wheel', wheel);
      }
      window.removeEventListener('keydown', key, true);
    };
  }
  _pinchDist() {
    const a = [...this._pointers.values()];
    return a.length < 2 ? 0 : Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1;
  }

  _clickScreen(cx, cy) {
    const r = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObject(this.partGroup, true).filter((h) => h.object.visible !== false && !h.object.userData.noMeasure);
    if (!hits.length) {
      this._flashHint('Click on the part.');
      return;
    }
    this.clickPart(this.worldToPart(hits[0].point));
  }
  _flashHint(msg) {
    this.ui.hint.innerHTML = `<i>${esc(msg)}</i>`;
    clearTimeout(this._hintT);
    this._hintT = setTimeout(() => this._renderHint(), 1600);
  }

  // A click on the part at part-frame point p (also usable programmatically / in tests).
  clickPart(p) {
    if (!this._active) return null;
    const F = this.frame;
    const hgt = F.H(p.x, p.y);
    const onTop = Number.isFinite(hgt) && Math.abs(hgt - p.z) <= 0.35;
    const c = { x: p.x, y: p.y, z: p.z, onTop, h: hgt };
    const id = this.sel;
    const twoClick = id === 'micrometer' || id === 'depthMic' || (id === 'caliper' && this.mode.caliper !== 'inside');
    if (this.clicks.length >= (twoClick ? 2 : 1)) {
      this.clicks = [];
      this._clearMarkers();
    }
    this.clicks.push(c);
    this._addMarker(c);
    if (twoClick && this.clicks.length < 2) {
      this._renderHint();
      return null;
    }
    const res = this._measure();
    this._renderHint();
    return res;
  }

  // snap a click on a wall/top into the cavity next to it (for inside / bore)
  _intoCavity(c) {
    const F = this.frame;
    if (!c.onTop || c.h > -0.05) {
      let best = null;
      for (const r of [0.8, 1.6, 3]) {
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * TAU;
          const x = c.x + Math.cos(a) * r, y = c.y + Math.sin(a) * r;
          const v = F.H(x, y);
          if (Number.isFinite(v) && v < c.z - 0.3 && (!best || v < best.v)) best = { x, y, v };
        }
        if (best) break;
      }
      if (best) return { x: best.x, y: best.y };
    }
    return { x: c.x, y: c.y };
  }
  _levelOf(c) {
    const F = this.frame;
    const z = c.onTop ? c.z - 1 : c.z;
    return Math.max(F.bottom + 0.3, Math.min(z, -0.3));
  }
  _faceRef(c) {
    // reference face for depth: on a wall click use the material top next to it
    const F = this.frame;
    if (c.onTop) return { x: c.x, y: c.y };
    let best = { x: c.x, y: c.y, v: c.h };
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * TAU;
      const x = c.x + Math.cos(a) * 1.2, y = c.y + Math.sin(a) * 1.2;
      const v = F.H(x, y);
      if (Number.isFinite(v) && v > best.v) best = { x, y, v };
    }
    return best;
  }

  _measure() {
    const id = this.sel, F = this.frame, part = this.part;
    const zm = this.zmap, pl = this.placement;
    const cl = this.clicks;
    const range = this._range();
    const o = { frame: F, instrument: id, range };
    let r, what = '', feat = null, kind = '';
    const fa = (x, y) => (part ? featureAt(part, x, y) : null);
    const axisWord = (ax) => (ax === 'X' ? 'length X' : ax === 'Y' ? 'width Y' : `at ${ax}`);
    if ((id === 'caliper' && this.mode.caliper === 'outside') || id === 'micrometer') {
      const z = Math.min(this._levelOf(cl[0]), this._levelOf(cl[1]));
      r = measureOutside(zm, pl, part, cl[0], cl[1], z, { ...o, jawHalf: id === 'micrometer' ? 3.1 : 3, reach: id === 'micrometer' ? 22 + 0.32 * range[1] : 38 });
      kind = 'outside';
      if (r.ok) what = `Outside ${axisWord(r.axis)} @ Z${r.zLevel.toFixed(1)}`;
    } else if (id === 'caliper' && this.mode.caliper === 'inside') {
      const p = this._intoCavity(cl[0]);
      r = measureInside(zm, pl, part, p, null, null, o);
      kind = 'inside';
      feat = fa(p.x, p.y);
      if (r.ok) what = `${feat ? feat.label : 'Inside'} ${axisWord(r.axis)}`;
    } else if (id === 'boreGauge') {
      const p = this._intoCavity(cl[0]);
      r = measureBore(zm, pl, part, p, null, o);
      kind = 'bore';
      feat = fa(p.x, p.y);
      if (r.ok) what = `${feat ? feat.label : 'Bore'} Ø @ Z${r.zLevel.toFixed(1)}`;
    } else if ((id === 'caliper' && this.mode.caliper === 'depth') || id === 'depthMic') {
      const ref = this._faceRef(cl[0]);
      const p = this._intoCavity({ ...cl[1], onTop: true });
      r = measureDepth(zm, pl, part, ref, p, o);
      kind = 'depth';
      feat = fa(p.x, p.y);
      if (r.ok) what = `Depth ${feat ? feat.label : 'floor'}`;
    } else if (id === 'heightGauge') {
      r = measureHeight(zm, pl, part, cl[0], o);
      kind = 'height';
      feat = fa(cl[0].x, cl[0].y);
      if (r.ok) what = `Height ${feat ? feat.label + ' floor' : 'top face'}`;
    } else if (id === 'dialIndicator') {
      r = measureFlatness(zm, pl, part, cl[0], o);
      kind = 'flatness';
      feat = fa(cl[0].x, cl[0].y);
      if (r.ok) what = `Flatness ${feat ? feat.label + ' floor' : 'top face'}`;
    }
    r.what = what;
    r.kind = kind;
    if (r.ok && kind === 'bore') r.sub = `roundness ${r.roundness.toFixed(3)} · centre X${r.centre.x.toFixed(2)} Y${r.centre.y.toFixed(2)}`;
    if (r.ok && kind === 'depth' && r.rod) r.sub = `rod ${r.rod[0]}-${r.rod[1]} mm`;
    if (r.ok && kind === 'flatness') r.sub = `swept ${r.path[0].length + r.path[1].length} points along X and Y`;
    if (r.ok && kind === 'outside') r.sub = `walls at ${r.axis === 'X' ? 'X' : 'Y'} ${(r.axis === 'X' ? [r.wall1.x, r.wall2.x] : [r.wall1.y, r.wall2.y]).map((v) => v.toFixed(2)).join(' / ')}`;
    this.lastResult = r;
    if (r.ok) {
      const ins = INSTRUMENT[id];
      const at = r.centre || r.at || (r.wall1 ? { x: (r.wall1.x + r.wall2.x) / 2, y: (r.wall1.y + r.wall2.y) / 2, z: r.zLevel } : { ...cl[0] });
      const f = feat?.feature;
      const rec = {
        id: ++this._seq, instrument: id, instrumentName: ins.name, what, value: r.value, unit: 'mm', resolution: ins.resolution,
        at: { x: +at.x.toFixed(3), y: +at.y.toFixed(3), z: +(at.z ?? 0).toFixed(3) }, featureId: feat ? feat.id : undefined,
        nominal: undefined, tol: undefined, tolDefault: f?.tol ?? part?.tol?.general, time: new Date(), kind,
        extra: kind === 'bore' ? { roundness: r.roundness } : undefined,
      };
      this.log.push(rec);
      this._renderLog();
      const tr = this.ui.tbody.querySelector(`tr[data-rec="${rec.id}"]`);
      tr?.classList.add('ms-flash');
      this._showMeasureLines(r);
      this._startAnim(r);
      try { this.onMeasure(rec); } catch (e) { console.error(e); }
    }
    this._renderReading();
    return r;
  }

  // ------------------------------------------------------------------ 3D: markers, models, animation
  _clearMarkers() {
    for (const c of [...this.markers.children]) {
      this.markers.remove(c);
      c.geometry?.dispose();
    }
  }
  _markerMat() {
    if (!this._mm) {
      this._mm = new THREE.MeshBasicMaterial({ color: 0xffc94a, depthTest: false, transparent: true, opacity: 0.95 });
      this._lm = new THREE.LineBasicMaterial({ color: 0x74aeff, depthTest: false, transparent: true });
    }
    return this._mm;
  }
  _addMarker(c) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1.4, 12, 8), this._markerMat());
    m.position.copy(this.partToWorld(c));
    m.renderOrder = 20;
    this.markers.add(m);
  }
  _showMeasureLines(r) {
    this._markerMat();
    const pts = [];
    if (r.wall1) pts.push(r.wall1, r.wall2);
    else if (r.kind === 'bore') {
      const R = r.raw / 2;
      for (let k = 0; k <= 64; k++) pts.push({ x: r.centre.x + Math.cos((k / 64) * TAU) * R, y: r.centre.y + Math.sin((k / 64) * TAU) * R, z: r.zLevel });
    } else if (r.kind === 'depth') pts.push(r.ref, { ...r.ref, x: r.at.x, y: r.at.y }, r.at);
    else if (r.kind === 'flatness') for (const q of r.path[0]) pts.push({ x: q[0], y: q[1], z: q[2] + 0.05 });
    if (pts.length < 2) return;
    const g = new THREE.BufferGeometry().setFromPoints(pts.map((p) => this.partToWorld(p)));
    const line = new THREE.Line(g, this._lm);
    line.renderOrder = 19;
    this.markers.add(line);
    if (r.kind === 'flatness' && r.path[1].length > 1) {
      const g2 = new THREE.BufferGeometry().setFromPoints(r.path[1].map((q) => this.partToWorld({ x: q[0], y: q[1], z: q[2] + 0.05 })));
      const l2 = new THREE.Line(g2, this._lm);
      l2.renderOrder = 19;
      this.markers.add(l2);
    }
  }
  _getModel(id) {
    const rng = id === 'micrometer' || id === 'boreGauge' ? this._range(id) : null;
    const key = id + (rng ? rng.join('-') : '');
    if (!this.models.has(key)) this.models.set(key, buildInstrumentModel(id, rng ? { range: rng } : {}));
    return this.models.get(key);
  }
  _showModel(rest = false) {
    const m = this._getModel(this.sel);
    if (this.model !== m) {
      if (this.model) this.holder.remove(this.model);
      this.model = m;
      this.holder.add(m);
      this.pose = null;
    }
    const ud = m.userData;
    if (rest) {
      const p = this._restPose(this.sel);
      this.anim = null;
      this.pose = this._poseLocal(p.pose);
      if (p.value != null) ud.setValue(p.value);
      if (p.height != null) ud.setHeight?.(p.height);
      if (this.sel === 'caliper') ud.setDisplay?.(null);
    }
    this._applyPose();
  }
  _restPose(id) {
    const S = this.frame.size, b = this.frame.bottom;
    const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
    switch (id) {
      case 'caliper': return { pose: { p: { x: S.x / 2 - 105, y: -48, z: b + 3.45 }, x: X, y: Y }, value: 22 };
      case 'micrometer': { const G = this._range('micrometer')[1]; return { pose: { p: { x: S.x / 2 - G / 2, y: -26, z: b + 7 }, x: X, y: Y }, value: this._range('micrometer')[0] + 3 }; }
      case 'boreGauge': return { pose: { p: { x: S.x + 230, y: -30, z: b + 9.4 }, x: [0, 1, 0], y: [-1, 0, 0] }, value: (this._range('boreGauge')[0] + this._range('boreGauge')[1]) / 2 };
      case 'depthMic': return { pose: { p: { x: S.x + 45, y: S.y * 0.35, z: b }, x: X, y: Z }, value: 6 };
      case 'heightGauge': return { pose: { p: { x: S.x + 70, y: S.y * 0.3, z: b }, x: X, y: Z }, value: S.z + 15 };
      case 'dialIndicator': return { pose: { p: { x: -175, y: S.y * 0.3, z: b }, x: X, y: Z }, value: 0, height: S.z + 12 };
      default: return { pose: { p: { x: 0, y: -60, z: b }, x: X, y: Z } };
    }
  }
  _applyPose() {
    if (!this.pose || !this.partGroup) return;
    const P = new THREE.Vector3(), Q = new THREE.Quaternion(), Sc = new THREE.Vector3();
    this._pg().decompose(P, Q, Sc);
    const pos = this.pose.pos.clone().applyMatrix4(this._pg());
    this.holder.position.copy(pos);
    this.holder.quaternion.copy(Q).multiply(this.pose.quat);
    this.holder.scale.copy(Sc);
  }
  // the pose + value the instrument takes for a measurement result
  _measurePose(r) {
    const id = this.sel, F = this.frame, b = F.bottom;
    const cam = this._camPart();
    const facing = (xv, yv, p) => {
      const X = new THREE.Vector3(...xv), Y = new THREE.Vector3(...yv), Zv = new THREE.Vector3().crossVectors(X, Y);
      return Zv.x * (cam.x - p.x) + Zv.y * (cam.y - p.y) + Zv.z * (cam.z - (p.z ?? 0)) >= 0;
    };
    const up = [0, 0, 1], down = [0, 0, -1];
    if (r.kind === 'outside') {
      let w1 = r.wall1, w2 = r.wall2, d = [r.dir[0], r.dir[1], 0];
      const yv = id === 'micrometer' ? down : up;
      if (!facing(d, yv, w1)) { [w1, w2] = [w2, w1]; d = [-d[0], -d[1], 0]; }
      if (id === 'micrometer') return { pose: { p: { x: w1.x, y: w1.y, z: r.zLevel }, x: d, y: yv }, value: r.raw, open: 4 };
      const c = clamp(Math.max(r.maxH - r.zLevel + 2.5, 40.5 - (r.zLevel - b) + 0.5, 8), 8, 39);
      return { pose: { p: { x: w1.x, y: w1.y, z: r.zLevel + c }, x: d, y: yv }, value: r.raw, open: 8 };
    }
    if (r.kind === 'inside') {
      let w1 = r.wall1, w2 = r.wall2, d = [r.dir[0], r.dir[1], 0];
      if (!facing(d, down, w1)) { [w1, w2] = [w2, w1]; d = [-d[0], -d[1], 0]; }
      const z = Math.max(r.zLevel + 29, r.floor + 0.4 + 32.5);
      return { pose: { p: { x: w1.x, y: w1.y, z }, x: d, y: down }, value: r.raw, open: -Math.min(6, r.raw * 0.3) };
    }
    if (r.kind === 'bore') {
      let d = [1, 0, 0];
      if (!facing(d, up, r.centre)) d = [-1, 0, 0];
      return { pose: { p: { ...r.centre }, x: d, y: up }, value: r.value, open: -Math.min(1.5, r.raw * 0.05), zero: this.ringSize ?? Math.round(r.raw) };
    }
    if (r.kind === 'depth') {
      if (id === 'depthMic') {
        let d = [1, 0, 0];
        if (!facing(d, up, r.at)) d = [-1, 0, 0];
        return { pose: { p: { x: r.at.x, y: r.at.y, z: r.ref.z }, x: d, y: up }, value: r.raw, open: -Math.min(3, r.raw) };
      }
      // caliper depth rod: model X points down, beam end (x = 222) on the reference face
      let hv = [1, 0, 0];
      const X = [0, 0, -1];
      if (!facing(X, hv, r.at)) hv = [-1, 0, 0];
      const Zv = [X[1] * hv[2] - X[2] * hv[1], X[2] * hv[0] - X[0] * hv[2], X[0] * hv[1] - X[1] * hv[0]];
      const p = { x: r.at.x - 8 * hv[0] + 2.35 * Zv[0], y: r.at.y - 8 * hv[1] + 2.35 * Zv[1], z: r.ref.z + 222 };
      return { pose: { p, x: X, y: hv }, value: r.raw, open: -Math.min(4, r.raw) };
    }
    if (r.kind === 'height' || r.kind === 'flatness') {
      const reach = r.kind === 'height' ? 110 : 140;
      const p = r.at;
      const S = F.size;
      const cands = [[1, 0, 0, p.x], [-1, 0, 0, S.x - p.x], [0, 1, 0, p.y], [0, -1, 0, S.y - p.y]];
      let best = null;
      for (const c of cands) {
        const d = [c[0], c[1], 0];
        const o = { x: p.x - reach * d[0], y: p.y - reach * d[1], z: b };
        const sc = (facing(d, up, o) ? 1 : 0) * 50 - c[3];
        if (!best || sc > best.sc) best = { sc, d, o };
      }
      if (r.kind === 'height') return { pose: { p: best.o, x: best.d, y: up }, value: r.raw, open: 12 };
      return { pose: { p: best.o, x: best.d, y: up }, value: 0, height: p.z - b, sweep: r };
    }
    return null;
  }
  _startAnim(r) {
    this._showModel(false);
    const mp = this._measurePose(r);
    if (!mp) return;
    const ud = this.model.userData;
    const to = this._poseLocal(mp.pose);
    const from = this.pose || to;
    const v0 = ud.value ?? mp.value;
    if (this.sel === 'caliper') ud.setDisplay?.(null);
    if (this.sel === 'boreGauge') ud.zero = mp.zero;
    if (mp.height != null) ud.setHeight?.(mp.height);
    this.anim = { t: 0, dur: 1.15, from, to, v0, v1: mp.value, open: mp.open || 0, sweep: mp.sweep, final: r.value, needle: null };
  }

  update(dt = 0.016) {
    if (!this._active) return;
    const a = this.anim;
    if (a && this.model) {
      a.t += Math.min(dt, 0.05);
      const ud = this.model.userData;
      const u = clamp(a.t / a.dur, 0, 1);
      const k = ease(clamp(u / 0.65, 0, 1));
      const pos = a.from.pos.clone().lerp(a.to.pos, k);
      pos.y += Math.sin(k * Math.PI) * 35;
      const quat = a.from.quat.clone().slerp(a.to.quat, k);
      this.pose = { pos, quat };
      if (!a.sweep) {
        let v;
        if (u < 0.65) v = a.v0 + (a.v1 + a.open - a.v0) * ease(u / 0.65);
        else v = a.v1 + a.open * (1 - ease((u - 0.65) / 0.35));
        ud.setValue(u >= 1 ? a.v1 : v);
        if (u >= 1 && this.sel === 'caliper') ud.setDisplay?.(formatValue(a.final, 0.01));
        if (u >= 1 && this.sel === 'heightGauge') ud.setValue(a.final);
      } else {
        // dial indicator sweep along the path after arriving
        const sw = a.sweep;
        const pts = [...sw.path[0], ...sw.path[1]];
        if (u >= 0.65 && pts.length) {
          if (!a.sweepT) a.sweepT = 0;
          a.sweepT += Math.min(dt, 0.05);
          const f = clamp(a.sweepT / 2.2, 0, 1);
          const q = pts[Math.min(pts.length - 1, Math.floor(f * pts.length))];
          const dev = q[2] - sw.h0;
          ud.setValue(dev);
          a.needle = dev;
          const pp = this._measurePose(this.lastResult);
          pp.pose.p.x += q[0] - sw.at.x;
          pp.pose.p.y += q[1] - sw.at.y;
          const lp = this._poseLocal(pp.pose);
          this.pose = { pos: lp.pos, quat: lp.quat };
          if (f >= 1) { a.done = true; a.needle = null; ud.setValue(0); this._renderReading(); }
          else if ((this._dialFrame = (this._dialFrame || 0) + 1) % 3 === 0) this._renderReading();
        }
      }
      if (u >= 1 && (!a.sweep || a.done)) this.anim = null;
    }
    this._applyPose();
  }
}
