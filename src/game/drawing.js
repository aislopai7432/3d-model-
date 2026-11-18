// Engineering drawing renderer for the Workshop game mode.
//
// drawingSVG(part, opts)      -> full ISO-style A3 landscape sheet (SVG string, 420 x 297 mm viewBox)
// drawingThumbSVG(part)       -> simplified job-board thumbnail (SVG string, 300 x 212 viewBox)
// drawingCanvas(part, px, o)  -> Promise<HTMLCanvasElement> rendered from the SVG (o.thumb for the thumbnail)
//
// Drawing conventions (ISO 128 / ISO 129 / ISO 5456-2 first-angle / ISO 7200 title block):
//  * Part frame: origin at the front-left corner of the finished top face, X right, Y back, Z up,
//    depths positive downward from Z0. Datums A/B/C = left face / front face / top face.
//  * First-angle arrangement: FRONT view (full section A-A) top-left, PLAN (view from above) below it,
//    view from the LEFT (full section B-B) to the right of the front view. Pictorial (isometric) top right.
//  * Ordinate dimensions in the plan from datums A (X) and B (Y); feature sizes as leader callouts with
//    balloons; depths with the depth symbol; overall sizes and open depths as linear dimensions.
//  * Text uses system sans-serif families only (no web fonts); every text run carries textLength so the
//    layout does not depend on which font the browser picks. Special symbols (depth, counterbore) are
//    drawn as geometry, so missing glyphs can never break the sheet.

import { MATERIALS } from '../config.js';

// ---------------------------------------------------------------------------------------------
// constants
const SHEET_W = 420, SHEET_H = 297;
const FR = { x0: 20, y0: 10, x1: 410, y1: 287 };          // drawing frame (ISO 5457: 20 mm filing margin)
const TB = { x: 230, y: 235, w: 180, h: 52 };              // title block (ISO 7200: max. 180 wide)
const RC = { x0: 302, x1: 408 };                           // right column: revisions, pictorial, notes
const VIEW_MAX_X = 298;                                    // views must stay left of this
const FONT = "'Arial Narrow','Liberation Sans Narrow','Nimbus Sans Narrow',Arial,'Liberation Sans',Helvetica,sans-serif";
const TXT = 3.2;                                           // dimension text height (mm)
const ARW = 2.6, ARW_W = 0.45;                             // filled arrowhead length / half width
const CONE = 1 / Math.tan((59 * Math.PI) / 180);           // 118 deg drill point: depth per unit radius
const EPS = 1e-7;

// Helvetica / Arial advance widths (1/1000 em) for ASCII 32..126 (+ a few symbols)
const CW = {};
(() => {
  const s = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
  const w = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015,
    667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
    278, 278, 278, 469, 556, 333,
    556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500,
    334, 260, 334, 584];
  for (let i = 0; i < s.length; i++) CW[s[i]] = w[i];
  Object.assign(CW, { '×': 584, 'Ø': 778, '±': 584, '°': 400, '–': 556, '—': 1000, '·': 278, '…': 1000, '≈': 584, '★': 900 });
})();
const CONDENSE = 0.86;
const SYM = { '↧': 'depth', '⌴': 'cbore', '⌵': 'csink' };

let UID = 0;

// ---------------------------------------------------------------------------------------------
// small helpers
const num = (v, d = 0) => { v = +v; return Number.isFinite(v) ? v : d; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const n2 = (v) => { const r = Math.round(v * 100) / 100; return Object.is(r, -0) ? 0 : r; };
function fmt(v, dp = 2) {
  if (!Number.isFinite(v)) return '?';
  let r = Math.round(v * 10 ** dp) / 10 ** dp;
  if (Object.is(r, -0)) r = 0;
  return String(r);
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function textW(str, size, bold = false) {
  let w = 0;
  for (const ch of String(str)) w += CW[ch] ?? 600;
  return (w / 1000) * size * CONDENSE * (bold ? 1.07 : 1);
}
const symW = (size) => size * 0.95;
function splitRich(str) {
  const out = []; let cur = '';
  for (const ch of String(str)) {
    if (SYM[ch]) { if (cur) out.push({ t: cur }); out.push({ sym: SYM[ch] }); cur = ''; } else cur += ch;
  }
  if (cur) out.push({ t: cur });
  return out;
}
function richW(str, size = TXT, bold = false) {
  let w = 0;
  for (const s of splitRich(str)) w += s.sym ? symW(size) : textW(s.t, size, bold);
  return w;
}
function symPath(kind, x, y, size) {
  const w = symW(size), h = size * 0.72, cx = x + w / 2;
  const sw = n2(Math.max(0.16, size * 0.075));
  let d;
  if (kind === 'depth') {
    d = `M${n2(cx)} ${n2(y - h)}V${n2(y)}M${n2(cx - size * 0.2)} ${n2(y - size * 0.3)}L${n2(cx)} ${n2(y)}L${n2(cx + size * 0.2)} ${n2(y - size * 0.3)}M${n2(cx - size * 0.3)} ${n2(y)}H${n2(cx + size * 0.3)}`;
  } else if (kind === 'cbore') {
    d = `M${n2(x + w * 0.14)} ${n2(y - h)}V${n2(y - size * 0.05)}H${n2(x + w * 0.86)}V${n2(y - h)}`;
  } else {
    d = `M${n2(x + w * 0.12)} ${n2(y - h)}L${n2(cx)} ${n2(y)}L${n2(x + w * 0.88)} ${n2(y - h)}`;
  }
  return `<path d="${d}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
}
// Rich text: string with symbol chars (depth / counterbore) drawn as geometry. Anchor start|middle|end.
function rich(x, y, str, o = {}) {
  const size = o.size ?? TXT, bold = !!o.bold, fill = o.fill ?? '#000';
  const W = richW(str, size, bold);
  let sx = o.anchor === 'middle' ? -W / 2 : o.anchor === 'end' ? -W : 0;
  const parts = [];
  for (const s of splitRich(str)) {
    if (s.sym) { parts.push(symPath(s.sym, sx, 0, size)); sx += symW(size); continue; }
    const lead = s.t.match(/^ */)[0], trimmed = s.t.trim();
    if (trimmed) {
      const lw = textW(lead, size, bold), tw = textW(trimmed, size, bold);
      parts.push(`<text x="${n2(sx + lw)}" y="0" textLength="${n2(tw)}" lengthAdjust="spacingAndGlyphs">${esc(trimmed)}</text>`);
    }
    sx += textW(s.t, size, bold);
  }
  const tr = `translate(${n2(x)} ${n2(y)})${o.rot ? ` rotate(${o.rot})` : ''}`;
  return `<g transform="${tr}" font-size="${size}"${bold ? ' font-weight="bold"' : ''} fill="${fill}" color="${fill}">${parts.join('')}</g>`;
}
function wrapText(str, width, size) {
  const words = String(str).split(/\s+/).filter(Boolean);
  const lines = []; let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (cur && richW(t, size) > width) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}
function hashStr(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

// 1D label spreading: items {ideal (preferred start), size}; returns starts (same order), kept inside [lo, hi].
function spread(items, lo, hi) {
  const order = items.map((it, i) => i).sort((a, b) => items[a].ideal - items[b].ideal);
  let blocks = order.map((i) => ({ idx: [i], start: items[i].ideal, size: items[i].size }));
  const fit = (b) => {
    let off = 0, acc = 0;
    for (const i of b.idx) { acc += items[i].ideal - off; off += items[i].size; }
    b.start = acc / b.idx.length;
    b.start = Math.min(Math.max(b.start, lo), Math.max(lo, hi - b.size));
  };
  blocks.forEach(fit);
  for (let guard = 0; guard < 500; guard++) {
    let merged = false;
    for (let k = 1; k < blocks.length; k++) {
      const a = blocks[k - 1], b = blocks[k];
      if (a.start + a.size > b.start + 1e-9) {
        const m = { idx: a.idx.concat(b.idx), size: a.size + b.size, start: 0 };
        fit(m); blocks.splice(k - 1, 2, m); merged = true; break;
      }
    }
    if (!merged) break;
  }
  const out = new Array(items.length);
  for (const b of blocks) { let s = b.start; for (const i of b.idx) { out[i] = s; s += items[i].size; } }
  return out;
}

// ---------------------------------------------------------------------------------------------
// geometry: loops (CCW in part frame, y up)
function circlePts(cx, cy, r, n = 96) {
  const p = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return p;
}
function roundRectPts(cx, cy, w, h, r, ang) {
  const hx = w / 2, hy = h / 2, p = [];
  const corners = [[hx - r, -hy + r, -90], [hx - r, hy - r, 0], [-hx + r, hy - r, 90], [-hx + r, -hy + r, 180]];
  const seg = r > 1e-9 ? 12 : 0;
  for (const [ux, uy, a0] of corners) {
    if (!seg) { p.push([ux, uy]); continue; }
    for (let i = 0; i <= seg; i++) {
      const a = ((a0 + (90 * i) / seg) * Math.PI) / 180;
      p.push([ux + r * Math.cos(a), uy + r * Math.sin(a)]);
    }
  }
  const ca = Math.cos(ang), sa = Math.sin(ang);
  return p.map(([x, y]) => [cx + x * ca - y * sa, cy + x * sa + y * ca]);
}
function capsulePts(x1, y1, x2, y2, w) {
  const len = Math.hypot(x2 - x1, y2 - y1), r = w / 2;
  if (len < 1e-9) return circlePts(x1, y1, r);
  const a = Math.atan2(y2 - y1, x2 - x1), p = [], n = 24;
  for (let i = 0; i <= n; i++) { const t = a - Math.PI / 2 + (Math.PI * i) / n; p.push([x2 + r * Math.cos(t), y2 + r * Math.sin(t)]); }
  for (let i = 0; i <= n; i++) { const t = a + Math.PI / 2 + (Math.PI * i) / n; p.push([x1 + r * Math.cos(t), y1 + r * Math.sin(t)]); }
  return p;
}
const rectPts = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
function sdRoundRect(px, py, hx, hy, r) {
  const qx = Math.abs(px) - (hx - r), qy = Math.abs(py) - (hy - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? clamp(((px - x1) * dx + (py - y1) * dy) / l2, 0, 1) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// ---------------------------------------------------------------------------------------------
// part normalisation
function buildFeature(f, index, L, W, H) {
  if (!f || typeof f !== 'object') return null;
  const id = f.id != null && f.id !== '' ? String(f.id) : String(index + 1);
  const tol = Number.isFinite(+f.tol) && +f.tol > 0 ? +f.tol : null;
  const cl = (d) => Math.min(Math.max(num(d), 0), H);
  const F = { type: f.type, id, tol, index, src: f };
  switch (f.type) {
    case 'pocketRect': {
      const cx = num(f.x), cy = num(f.y), w = num(f.w), h = num(f.h), depth = cl(f.depth);
      if (!(w > 0 && h > 0 && depth > 0)) return null;
      const r = clamp(num(f.r), 0, Math.min(w, h) / 2), rot = num(f.rot), a = (rot * Math.PI) / 180;
      const ca = Math.cos(a), sa = Math.sin(a);
      Object.assign(F, {
        cx, cy, w, h, r, rot, ang: a, depth,
        contrib: (x, y) => { const dx = x - cx, dy = y - cy; return sdRoundRect(dx * ca + dy * sa, -dx * sa + dy * ca, w / 2, h / 2, r) <= 1e-9 ? depth : 0; },
        loops: [{ pts: roundRectPts(cx, cy, w, h, r, a), inside: true, depth }],
        refX: [cx], refY: [cy],
      });
      break;
    }
    case 'pocketCirc': {
      const cx = num(f.x), cy = num(f.y), d = num(f.d), depth = cl(f.depth);
      if (!(d > 0 && depth > 0)) return null;
      const r = d / 2;
      Object.assign(F, {
        cx, cy, d, r, depth, round: true,
        contrib: (x, y) => (Math.hypot(x - cx, y - cy) <= r + 1e-9 ? depth : 0),
        loops: [{ pts: circlePts(cx, cy, r), inside: true, depth, circle: { cx, cy, r } }],
        refX: [cx], refY: [cy],
      });
      break;
    }
    case 'hole': {
      const cx = num(f.x), cy = num(f.y), d = num(f.d), depth = cl(f.depth);
      if (!(d > 0 && depth > 0)) return null;
      const r = d / 2;
      let cb = null;
      if (f.cbore && num(f.cbore.d) > d && num(f.cbore.depth) > 0) cb = { d: num(f.cbore.d), r: num(f.cbore.d) / 2, depth: cl(f.cbore.depth) };
      const through = depth >= H - 1e-6;
      Object.assign(F, {
        cx, cy, d, r, depth, cb, through, round: true, drilled: true,
        contrib: (x, y) => {
          const q = Math.hypot(x - cx, y - cy);
          if (q <= r + 1e-9) return cb ? Math.max(depth, cb.depth) : depth;
          if (cb && q <= cb.r + 1e-9) return cb.depth;
          return 0;
        },
        loops: [{ pts: circlePts(cx, cy, r), inside: true, depth, circle: { cx, cy, r } }]
          .concat(cb ? [{ pts: circlePts(cx, cy, cb.r), inside: true, depth: cb.depth, circle: { cx, cy, r: cb.r } }] : []),
        refX: [cx], refY: [cy],
      });
      break;
    }
    case 'slot': {
      const x1 = num(f.x1), y1 = num(f.y1), x2 = num(f.x2), y2 = num(f.y2), w = num(f.w), depth = cl(f.depth);
      if (!(w > 0 && depth > 0)) return null;
      Object.assign(F, {
        x1, y1, x2, y2, w, depth, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, len: Math.hypot(x2 - x1, y2 - y1),
        contrib: (x, y) => (segDist(x, y, x1, y1, x2, y2) <= w / 2 + 1e-9 ? depth : 0),
        loops: [{ pts: capsulePts(x1, y1, x2, y2, w), inside: true, depth }],
        refX: [x1, x2], refY: [y1, y2],
      });
      break;
    }
    case 'step': {
      const side = ['left', 'right', 'front', 'back'].includes(f.side) ? f.side : null;
      const depth = cl(f.depth);
      if (!side || !(depth > 0)) return null;
      const width = clamp(num(f.width), 0, side === 'left' || side === 'right' ? L : W);
      if (!(width > 0)) return null;
      const box = side === 'left' ? [0, 0, width, W] : side === 'right' ? [L - width, 0, L, W] : side === 'front' ? [0, 0, L, width] : [0, W - width, L, W];
      Object.assign(F, {
        side, width, depth, box, cx: (box[0] + box[2]) / 2, cy: (box[1] + box[3]) / 2,
        contrib: (x, y) => (x >= box[0] - 1e-9 && x <= box[2] + 1e-9 && y >= box[1] - 1e-9 && y <= box[3] + 1e-9 ? depth : 0),
        loops: [{ pts: rectPts(...box), inside: true, depth }],
        refX: side === 'left' ? [width] : side === 'right' ? [L - width] : [],
        refY: side === 'front' ? [width] : side === 'back' ? [W - width] : [],
      });
      break;
    }
    case 'boss': {
      const cx = num(f.x), cy = num(f.y), depth = cl(f.depth);
      if (!(depth > 0)) return null;
      if (f.shape === 'circle') {
        const d = num(f.d); if (!(d > 0)) return null;
        const r = d / 2;
        Object.assign(F, {
          shape: 'circle', cx, cy, d, r, depth, round: true,
          contrib: (x, y) => (Math.hypot(x - cx, y - cy) > r + 1e-9 ? depth : 0),
          loops: [{ pts: circlePts(cx, cy, r), inside: false, depth, circle: { cx, cy, r } }],
          refX: [cx], refY: [cy],
        });
      } else {
        const w = num(f.w), h = num(f.h); if (!(w > 0 && h > 0)) return null;
        const r = clamp(num(f.r), 0, Math.min(w, h) / 2), rot = num(f.rot), a = (rot * Math.PI) / 180;
        const ca = Math.cos(a), sa = Math.sin(a);
        Object.assign(F, {
          shape: 'rect', cx, cy, w, h, r, rot, ang: a, depth,
          contrib: (x, y) => { const dx = x - cx, dy = y - cy; return sdRoundRect(dx * ca + dy * sa, -dx * sa + dy * ca, w / 2, h / 2, r) > 1e-9 ? depth : 0; },
          loops: [{ pts: roundRectPts(cx, cy, w, h, r, a), inside: false, depth }],
          refX: [cx], refY: [cy],
        });
      }
      break;
    }
    default:
      return null;
  }
  // bounding box (removed region for normal features, island for bosses)
  const pts = F.loops.flatMap((l) => l.pts);
  F.bbox = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
  return F;
}

function makePieces(loop, maxSeg) {
  const pts = loop.pts, out = [], n = pts.length;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % n];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-9) continue;
    const k = Math.max(1, Math.ceil(len / maxSeg));
    const ux = (bx - ax) / len, uy = (by - ay) / len;
    // CCW loop: left normal (-uy, ux) points inside the loop
    const nx = loop.inside ? -uy : uy, ny = loop.inside ? ux : -ux;   // towards the removed side
    for (let j = 0; j < k; j++) {
      const x0 = ax + ((bx - ax) * j) / k, y0 = ay + ((by - ay) * j) / k;
      const x1 = ax + ((bx - ax) * (j + 1)) / k, y1 = ay + ((by - ay) * (j + 1)) / k;
      out.push({ ax: x0, ay: y0, bx: x1, by: y1, mx: (x0 + x1) / 2, my: (y0 + y1) / 2, nx, ny });
    }
  }
  return out;
}

function normPart(part) {
  const p = part || {};
  const size = p.size || p.stock || { x: 100, y: 60, z: 20 };
  const L = Math.max(1, num(size.x, 100)), W = Math.max(1, num(size.y, 60)), H = Math.max(0.5, num(size.z, 20));
  const st = p.stock || size;
  const stock = { x: num(st.x, L), y: num(st.y, W), z: num(st.z, H) };
  const feats = [];
  (Array.isArray(p.features) ? p.features : []).forEach((f, i) => {
    try { const F = buildFeature(f, i, L, W, H); if (F) feats.push(F); } catch { /* ignore malformed */ }
  });
  const matKey = MATERIALS[p.material] ? p.material : 'aluminium';
  const P = {
    raw: p, L, W, H, stock, feats,
    id: String(p.id ?? ''), title: String(p.title ?? 'Part'), drawingNo: String(p.drawingNo ?? (p.id ? `ML-${p.id}` : 'ML-0000')),
    rev: String(p.rev ?? 'A'), customer: String(p.customer ?? ''), difficulty: clamp(Math.round(num(p.difficulty, 1)), 1, 5),
    matKey, mat: MATERIALS[matKey], tolG: num(p.tol?.general, 0.1) || 0.1,
    notes: Array.isArray(p.notes) ? p.notes.map(String) : [],
  };
  P.inside = (x, y) => x >= -1e-9 && x <= L + 1e-9 && y >= -1e-9 && y <= W + 1e-9;
  P.depthInfo = (x, y, skip) => {
    if (!P.inside(x, y)) return null;
    let d = 0, f = null;
    for (const F of feats) { if (F === skip) continue; const c = F.contrib(x, y); if (c > d + 1e-12) { d = c; f = F; } }
    return { d: Math.min(d, H), f };
  };
  P.depthAt = (x, y) => { const i = P.depthInfo(x, y); return i ? i.d : null; };
  const maxSeg = Math.max(L, W) / 60;
  P.blockLoop = { pts: rectPts(0, 0, L, W), inside: false, depth: H, block: true };
  for (const F of feats) for (const l of F.loops) { l.pieces = makePieces(l, maxSeg); l.feat = F; }
  P.blockLoop.pieces = makePieces(P.blockLoop, maxSeg);
  return P;
}

// ---------------------------------------------------------------------------------------------
// SVG sheet builder
class Sheet {
  constructor() { this.uid = `dw${(UID++).toString(36)}`; this.defs = []; this.out = []; this.occ = []; }
  add(s) { this.out.push(s); }
  line(x1, y1, x2, y2, cls = 'n') { this.out.push(`<line class="${cls}" x1="${n2(x1)}" y1="${n2(y1)}" x2="${n2(x2)}" y2="${n2(y2)}"/>`); }
  poly(pts, cls = 'k', closed = false, extra = '') {
    if (pts.length < 2) return;
    this.out.push(`<${closed ? 'polygon' : 'polyline'} class="${cls}" points="${pts.map((p) => `${n2(p[0])},${n2(p[1])}`).join(' ')}"${extra}/>`);
  }
  rect(x, y, w, h, cls = 'n', extra = '') { this.out.push(`<rect class="${cls}" x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="${n2(h)}"${extra}/>`); }
  text(x, y, str, o) { this.out.push(rich(x, y, str, o)); }
  reserve(x0, y0, x1, y1) { this.occ.push([Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]); }
  hits(r, pad = 0.4) { return this.occ.some((o) => r[0] < o[2] + pad && r[2] > o[0] - pad && r[1] < o[3] + pad && r[3] > o[1] - pad); }
}
const STYLE = `.k{fill:none;stroke:#000;stroke-width:.5;stroke-linecap:round;stroke-linejoin:round}`
  + `.n{fill:none;stroke:#000;stroke-width:.25;stroke-linecap:round;stroke-linejoin:round}`
  + `.f{fill:none;stroke:#000;stroke-width:.18}`
  + `.ce{fill:none;stroke:#000;stroke-width:.25;stroke-dasharray:7 1 1 1}`
  + `.hi{fill:none;stroke:#000;stroke-width:.3;stroke-dasharray:2.2 1}`
  + `.cp{fill:none;stroke:#000;stroke-width:.25;stroke-dasharray:9 1.2 1.2 1.2}`
  + `.cpk{fill:none;stroke:#000;stroke-width:.7;stroke-linecap:butt}`
  + `.ph{fill:none;stroke:#000;stroke-width:.25;stroke-dasharray:7 1 1 1 1 1}`
  + `.b{fill:#000;stroke:none}`
  + `.w{fill:#fff;stroke:none}`
  + `.zone{fill:none;stroke:#000;stroke-width:.35}`
  + `.tb{fill:none;stroke:#000;stroke-width:.35}`
  + `.tbk{fill:none;stroke:#000;stroke-width:.7}`;

function arrow(tx, ty, dx, dy, len = ARW, hw = ARW_W) {
  const l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l;
  const bx = tx - ux * len, by = ty - uy * len, nx = -uy * hw, ny = ux * hw;
  return `<path class="b" d="M${n2(tx)} ${n2(ty)}L${n2(bx + nx)} ${n2(by + ny)}L${n2(bx - nx)} ${n2(by - ny)}Z"/>`;
}

// Horizontal linear dimension between paper points a and b; dimension line at y = yd.
function dimH(S, ax, ay, bx, by, yd, text, o = {}) {
  if (ax > bx) { [ax, bx] = [bx, ax]; [ay, by] = [by, ay]; }
  const ext = (x, y) => {
    const s = Math.sign(yd - y) || 1;
    if (Math.abs(yd - y) > 1.2) S.line(x, y + s * 1, x, yd + s * 2);
  };
  if (!o.noExtA) ext(ax, ay);
  if (!o.noExtB) ext(bx, by);
  const span = bx - ax, tw = richW(text);
  const inside = span >= 2 * ARW + 1.2;
  let tx = (ax + bx) / 2, anchor = 'middle';
  const textInside = tw + 1.5 <= span;
  if (!textInside) { tx = bx + (inside ? 1.5 : ARW + 2); anchor = 'start'; }
  if (inside) {
    S.line(ax, yd, textInside ? bx : Math.max(bx, tx + tw + 0.5), yd);
    S.add(arrow(ax, yd, -1, 0) + arrow(bx, yd, 1, 0));
  } else {
    S.line(ax - ARW - 2.5, yd, textInside ? bx + ARW + 2.5 : tx + tw + 0.5, yd);
    S.add(arrow(ax, yd, 1, 0) + arrow(bx, yd, -1, 0));
  }
  S.text(tx, yd - 1, text, { anchor });
  const x0 = anchor === 'middle' ? tx - tw / 2 : tx;
  S.reserve(x0, yd - 1 - TXT * 0.8, x0 + tw, yd + 0.2);
}
// Vertical linear dimension; dimension line at x = xd; text rotated, reading from the right, left of the line.
function dimV(S, ax, ay, bx, by, xd, text, o = {}) {
  if (ay > by) { [ax, bx] = [bx, ax]; [ay, by] = [by, ay]; }
  const ext = (x, y) => {
    const s = Math.sign(xd - x) || 1;
    if (Math.abs(xd - x) > 1.2) S.line(x + s * 1, y, xd + s * 2, y);
  };
  if (!o.noExtA) ext(ax, ay);
  if (!o.noExtB) ext(bx, by);
  const span = by - ay, tw = richW(text);
  const inside = span >= 2 * ARW + 1.2;
  const textInside = tw + 1.5 <= span;
  let ty = (ay + by) / 2, anchor = 'middle';
  if (!textInside) { ty = ay - (inside ? 1.5 : ARW + 2); anchor = 'start'; }   // above the upper end, reading upward
  if (inside) {
    S.line(xd, textInside ? ay : Math.min(ay, ty - tw - 0.5), xd, by);
    S.add(arrow(xd, ay, 0, -1) + arrow(xd, by, 0, 1));
  } else {
    S.line(xd, textInside ? ay - ARW - 2.5 : ty - tw - 0.5, xd, by + ARW + 2.5);
    S.add(arrow(xd, ay, 0, 1) + arrow(xd, by, 0, -1));
  }
  S.text(xd - 1, ty, text, { anchor, rot: -90 });
  const y0 = anchor === 'middle' ? ty - tw / 2 : ty - tw;
  S.reserve(xd - 1 - TXT * 0.8, y0, xd + 0.2, y0 + tw);
}
// Datum feature symbol: filled triangle on the feature at (x, y), leader in direction (dx, dy), framed letter.
function datum(S, x, y, dx, dy, letter) {
  const l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l, nx = -uy, ny = ux;
  const tri = `M${n2(x + nx * 1.6)} ${n2(y + ny * 1.6)}L${n2(x - nx * 1.6)} ${n2(y - ny * 1.6)}L${n2(x + ux * 2.6)} ${n2(y + uy * 2.6)}Z`;
  S.add(`<path class="b" d="${tri}"/>`);
  const ex = x + ux * 5, ey = y + uy * 5;
  S.line(x + ux * 2.6, y + uy * 2.6, ex, ey);
  const bs = 5.2, bcx = ex + ux * bs / 2, bcy = ey + uy * bs / 2;
  S.add(`<rect class="n" x="${n2(bcx - bs / 2)}" y="${n2(bcy - bs / 2)}" width="${bs}" height="${bs}" fill="#fff"/>`);
  S.text(bcx, bcy + TXT * 0.36, letter, { anchor: 'middle', size: 3.5 });
  S.reserve(bcx - bs / 2, bcy - bs / 2, bcx + bs / 2, bcy + bs / 2);
}
// Balloon / tag with feature ids. Returns width.
function idsText(ids) {
  if (ids.length <= 3) return ids.join(',');
  const code = (id) => (/^\d+$/.test(id) ? +id : id.length === 1 ? id.charCodeAt(0) : NaN);
  const consecutive = ids.every((id, i) => i === 0 || code(id) === code(ids[i - 1]) + 1);
  return consecutive ? `${ids[0]}–${ids[ids.length - 1]}` : ids.join(',');
}
function tagWidth(ids, size = 3) {
  const t = idsText(ids);
  return Math.max(size * 1.75, richW(t, size) + size * 0.9);
}
function tag(S, x, yc, ids, size = 3) {
  const t = idsText(ids);
  const w = tagWidth(ids, size), h = size * 1.75;
  S.add(`<rect class="n" x="${n2(x)}" y="${n2(yc - h / 2)}" width="${n2(w)}" height="${n2(h)}" rx="${n2(h / 2)}" fill="#fff"/>`);
  S.text(x + w / 2, yc + size * 0.36, t, { anchor: 'middle', size });
  return w;
}

// ---------------------------------------------------------------------------------------------
// analysis: sections, profiles, callouts

// Does the line (axis 'x': y = c, 'y': x = c) pass through feature f's region?
function cutsFeature(P, f, axis, c) {
  const T = axis === 'x' ? P.L : P.W, n = Math.max(50, Math.ceil(T / 0.2));
  for (let i = 0; i <= n; i++) {
    const t = (i * T) / n;
    if ((axis === 'x' ? f.contrib(t, c) : f.contrib(c, t)) > 0) return true;
  }
  return false;
}
function chooseSections(P) {
  // Score a cutting line by the features whose own depth shows up in the section profile
  // (deepest-wins), with a bonus for cutting round features through their axis and for keeping
  // some of the top face (datum C) in the section.
  const W8 = { hole: 1, pocketCirc: 1.3, pocketRect: 1.3, slot: 1, step: 0.8, boss: 1.5 };
  const cands = (axis) => {
    const T = axis === 'x' ? P.W : P.L, s = new Set();
    for (const f of P.feats) {
      for (const v of axis === 'x' ? f.refY : f.refX) s.add(n2(v));
      if (f.type === 'step') {
        if (axis === 'x' && (f.side === 'front' || f.side === 'back')) s.add(n2(f.cy));
        if (axis === 'y' && (f.side === 'left' || f.side === 'right')) s.add(n2(f.cx));
      }
      if (f.type === 'slot') s.add(n2(axis === 'x' ? f.cy : f.cx));
    }
    s.add(n2(T / 2));
    return [...s].filter((v) => v > 0.05 && v < T - 0.05);
  };
  const evalLine = (axis, c, already) => {
    const iv = profile(P, axis, c);
    const shown = new Set(), cut = new Set();
    for (const v of iv) if (v.f) shown.add(v.f);
    for (const f of P.feats) if (shown.has(f) || cutsFeature(P, f, axis, c)) cut.add(f);
    let sc = 0;
    for (const f of shown) {
      const perp = axis === 'x' ? f.cy : f.cx;
      const centred = f.round && Math.abs(perp - c) < 1e-6;
      let w = (W8[f.type] ?? 1) * (centred ? 1.3 : 1) * (f.cb ? 1.25 : 1);
      if (already && already.has(f)) w *= 0.25;
      sc += w;
    }
    const s = P.L / 120;
    if (iv.some((v) => v.d < 1e-6 && v.t1 - v.t0 > 3 * s)) sc += 1.5;
    return { sc, cut };
  };
  const pick = (axis, already) => {
    const T = axis === 'x' ? P.W : P.L;
    let best = null;
    for (const c of cands(axis)) {
      const r = evalLine(axis, c, already);
      const tie = (-Math.abs(c - T / 2) / T) * 0.01;
      if (!best || r.sc + tie > best.sc + best.tie) best = { c, ...r, tie };
    }
    return best;
  };
  const A = pick('x');
  const B = pick('y', A.cut);
  return { A: { axis: 'x', c: A.c, cut: A.cut }, B: { axis: 'y', c: B.c, cut: B.cut } };
}

// Profile of the finished part along a section line: intervals [t0, t1] with constant depth and winner.
function profile(P, axis, c) {
  const T = axis === 'x' ? P.L : P.W;
  const at = (t) => (axis === 'x' ? P.depthInfo(t, c) : P.depthInfo(c, t));
  const key = (i) => `${i.d.toFixed(6)}|${i.f ? i.f.index : -1}`;
  const n = Math.max(400, Math.ceil(T / 0.1));
  const iv = [];
  let t0 = 0, i0 = at(0), k0 = key(i0);
  for (let s = 1; s <= n; s++) {
    const t = (s * T) / n, i = at(t), k = key(i);
    if (k !== k0) {
      let a = (s - 1) * T / n, b = t;
      for (let it = 0; it < 40; it++) { const m = (a + b) / 2; if (key(at(m)) === k0) a = m; else b = m; }
      const tb = (a + b) / 2;
      iv.push({ t0, t1: tb, d: i0.d, f: i0.f });
      t0 = tb; i0 = at(Math.min(T, tb + 1e-6)); k0 = key(i0);
      if (k0 !== k) { i0 = i; k0 = k; }
    }
  }
  iv.push({ t0, t1: T, d: i0.d, f: i0.f });
  // classify drilled intervals (the full-diameter part of a hole, not the counterbore)
  for (const v of iv) {
    v.drill = false;
    if (v.f && v.f.type === 'hole' && Math.abs(v.d - Math.min(v.f.depth, P.H)) < 1e-6) {
      const tm = (v.t0 + v.t1) / 2, px = axis === 'x' ? tm : c, py = axis === 'x' ? c : tm;
      if (Math.hypot(px - v.f.cx, py - v.f.cy) <= v.f.r + 1e-6) v.drill = !v.f.through;
    }
  }
  // merge slivers (tangent touches) into their neighbours
  const out = [];
  for (const v of iv) {
    if (v.t1 - v.t0 < 0.02 && out.length) { out[out.length - 1].t1 = v.t1; continue; }
    if (out.length && out[out.length - 1].t1 - out[out.length - 1].t0 < 0.02) { v.t0 = out[out.length - 1].t0; out.pop(); }
    const prev = out[out.length - 1];
    if (prev && prev.f === v.f && Math.abs(prev.d - v.d) < 1e-9 && prev.drill === v.drill) { prev.t1 = v.t1; continue; }
    out.push(v);
  }
  return out;
}
// z (negative down) of the material top along an interval, including the 118 deg drill point
function intervalTop(P, v, axis, c) {
  if (!v.drill) return [[v.t0, -v.d], [v.t1, -v.d]];
  const f = v.f, n = 18, pts = [];
  const e = axis === 'x' ? c - f.cy : c - f.cx;           // offset of section plane from the hole axis
  const tc = axis === 'x' ? f.cx : f.cy;
  for (let i = 0; i <= n; i++) {
    const t = v.t0 + ((v.t1 - v.t0) * i) / n;
    const rho = Math.min(f.r, Math.hypot(e, t - tc));
    pts.push([t, Math.max(-P.H, -v.d - (f.r - rho) * CONE)]);
  }
  return pts;
}

function calloutLines(f, n, pcd) {
  const t = (v) => fmt(v) + (f.tol ? `±${fmt(f.tol, 3)}` : '');
  const cnt = n > 1 ? `${n}× ` : '';
  switch (f.type) {
    case 'hole': {
      const l = [`${cnt}Ø${t(f.d)} ${f.through ? 'THRU' : '↧' + t(f.depth)}`];
      if (f.cb) l.push(`⌴Ø${t(f.cb.d)} ↧${t(f.cb.depth)}`);
      if (pcd) l.push(`EQ. SP. ON PCD Ø${fmt(pcd.R * 2)}`);
      return l;
    }
    case 'pocketCirc': return [`${cnt}Ø${t(f.d)} ↧${t(f.depth)}`];
    case 'pocketRect': {
      const l = [`${cnt}POCKET ${t(f.w)} × ${t(f.h)}`, `${f.r > 0 ? `R${fmt(f.r)} ` : ''}↧${t(f.depth)}`];
      if (Math.abs(f.rot) > 1e-6) l[1] += ` ROT ${fmt(f.rot)}°`;
      return l;
    }
    case 'slot': {
      const ang = (Math.atan2(f.y2 - f.y1, f.x2 - f.x1) * 180) / Math.PI;
      const l = [`${cnt}SLOT ${t(f.w)} WIDE`, `↧${t(f.depth)} · ${fmt(f.len)} C/C`];
      if (Math.abs(ang) > 1e-6 && Math.abs(Math.abs(ang) - 180) > 1e-6 && Math.abs(Math.abs(ang) - 90) > 1e-6) l[1] += ` ${fmt(Math.abs(ang) > 90 ? 180 - Math.abs(ang) : Math.abs(ang), 1)}°`;
      return l;
    }
    case 'step': return [`STEP ${t(f.width)} WIDE`, `↧${t(f.depth)} (${f.side.toUpperCase()})`];
    case 'boss':
      return f.shape === 'circle'
        ? [`BOSS Ø${t(f.d)}`, `SURROUND ↧${t(f.depth)}`]
        : [`BOSS ${t(f.w)} × ${t(f.h)}${f.r > 0 ? ` R${fmt(f.r)}` : ''}`, `SURROUND ↧${t(f.depth)}${Math.abs(f.rot) > 1e-6 ? ` ROT ${fmt(f.rot)}°` : ''}`];
    default: return [];
  }
}
function groupKey(f) {
  const k = [f.type, f.tol];
  if (f.type === 'hole') k.push(f.d, f.depth, f.cb ? `${f.cb.d}/${f.cb.depth}` : '');
  else if (f.type === 'pocketCirc') k.push(f.d, f.depth);
  else if (f.type === 'pocketRect') k.push(f.w, f.h, f.r, f.depth, f.rot);
  else if (f.type === 'slot') k.push(f.w, f.depth, n2(f.len), f.index);
  else k.push(f.index);
  return k.join('|');
}
function findPCD(fs) {
  if (fs.length < 3) return null;
  const [a, b, c] = fs;
  const d = 2 * (a.cx * (b.cy - c.cy) + b.cx * (c.cy - a.cy) + c.cx * (a.cy - b.cy));
  if (Math.abs(d) < 1e-9) return null;
  const sa = a.cx ** 2 + a.cy ** 2, sb = b.cx ** 2 + b.cy ** 2, sc = c.cx ** 2 + c.cy ** 2;
  const ux = (sa * (b.cy - c.cy) + sb * (c.cy - a.cy) + sc * (a.cy - b.cy)) / d;
  const uy = (sa * (c.cx - b.cx) + sb * (a.cx - c.cx) + sc * (b.cx - a.cx)) / d;
  const R = Math.hypot(a.cx - ux, a.cy - uy);
  if (!(R > 0) || fs.some((f) => Math.abs(Math.hypot(f.cx - ux, f.cy - uy) - R) > 0.02)) return null;
  // equally spaced only (four corner holes of a rectangle are concyclic too)
  const ang = fs.map((f) => Math.atan2(f.cy - uy, f.cx - ux)).sort((a, b) => a - b);
  const step = (2 * Math.PI) / fs.length;
  for (let i = 0; i < ang.length; i++) {
    const d = (i + 1 < ang.length ? ang[i + 1] : ang[0] + 2 * Math.PI) - ang[i];
    if (Math.abs(d - step) > 0.01) return null;
  }
  return { cx: ux, cy: uy, R };
}
function buildGroups(P) {
  const map = new Map();
  for (const f of P.feats) { const k = groupKey(f); if (!map.has(k)) map.set(k, []); map.get(k).push(f); }
  return [...map.values()].map((fs) => {
    let pcd = fs[0].type === 'hole' ? findPCD(fs) : null;
    if (pcd && (pcd.cx - pcd.R < -1e-6 || pcd.cx + pcd.R > P.L + 1e-6 || pcd.cy - pcd.R < -1e-6 || pcd.cy + pcd.R > P.W + 1e-6)) pcd = null;
    return { feats: fs, ids: fs.map((f) => f.id), pcd, lines: calloutLines(fs[0], fs.length, pcd) };
  });
}

// ---------------------------------------------------------------------------------------------
// layout
function scaleText(s) {
  if (s >= 1) return `${fmt(s)}:1`;
  return `1:${fmt(1 / s)}`;
}
function computeLayout(P, groups, env) {
  const { L, W, H } = P;
  const ordTxt = (vals) => Math.max(...vals.map((v) => textW(fmt(v), TXT)), 2);
  const xs = ordValues(P, 'x'), ys = ordValues(P, 'y');
  const LM = Math.max(10.5 + ordTxt(ys) + 1.5 + 6, 20);
  const BM = 9 + 4 + 1.5 + ordTxt(xs) + 1;
  const lblW = groups.length ? Math.max(30, ...groups.map((g) => tagWidth(g.ids) + 1.5 + Math.max(...g.lines.map((l) => richW(l, 3))))) : 0;
  const lblH = groups.reduce((a, g) => a + g.lines.length * 4.1 + 2.6, 0);
  const XMAX = FR.x1 - 2;
  const build = (s, dx = 0, dy = 0, extraG = 0) => {
    const lay = { s, LM, BM, lblW, lblH, GS: 30 };
    lay.x0 = FR.x0 + 3 + LM + dx;
    lay.planR = lay.x0 + L * s;
    lay.colX = lay.planR + 18;
    lay.colR = lay.colX + lblW;
    lay.sideX0 = lay.planR + lay.GS;
    lay.sideR = lay.sideX0 + W * s;
    lay.right = Math.max(lay.sideR + 12, groups.length ? lay.colR : 0);
    // the front band must clear the revision table when it reaches into the right column
    const topMin = lay.sideR + 12 > RC.x0 - 2 ? env.revBottom + 15 : FR.y0 + 15;
    lay.frontTop = topMin + dy;
    lay.frontB = lay.frontTop + H * s;
    lay.G = 24 + extraG;
    lay.planTop = lay.frontB + lay.G;
    lay.planB = lay.planTop + W * s;
    lay.ordB = lay.planB + BM;
    lay.bottomLim = lay.planR + 8 > env.notesLeft ? env.notesTop - 3 : lay.planR + 8 > TB.x ? TB.y - 3 : FR.y1 - 2;
    lay.lblLo = lay.frontB + 15;
    lay.lblHi = lay.colR > env.notesLeft - 2 ? env.notesTop - 3 : lay.colR > TB.x - 2 ? TB.y - 3 : FR.y1 - 3;
    lay.ok = lay.right <= XMAX && lay.ordB <= lay.bottomLim && (!groups.length || lay.lblHi - lay.lblLo >= lblH);
    return lay;
  };
  let lay = null;
  for (const s of [10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05]) { lay = build(s); if (lay.ok) break; }
  // centre the arrangement in the free space
  const target = lay.right <= RC.x0 - 4 ? RC.x0 - 4 : XMAX;
  const dx = Math.max(0, (target - lay.right) / 2);
  const freeY = Math.max(0, lay.bottomLim - lay.ordB);
  const extraG = Math.min(12, freeY * 0.25);
  const dy = Math.max(0, (freeY - extraG) * 0.45);
  const moved = build(lay.s, dx, dy, extraG);
  return moved.ok || !lay.ok ? moved : lay;
}
function ordValues(P, axis) {
  const set = new Map();
  set.set(0, 0);
  for (const f of P.feats) for (const v of axis === 'x' ? f.refX : f.refY) {
    const lim = axis === 'x' ? P.L : P.W;
    if (v > 1e-6 && v < lim - 1e-6) set.set(n2(v), v);
  }
  return [...set.keys()].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------------------------
// sheet furniture: border, zones, title block, revision table, notes
function drawFrame(S) {
  S.add(`<rect class="w" x="0" y="0" width="${SHEET_W}" height="${SHEET_H}"/>`);
  S.rect(FR.x0, FR.y0, FR.x1 - FR.x0, FR.y1 - FR.y0, 'k', ' style="stroke-width:.7"');
  // zone grid: 8 columns (1..8), 4 rows (A..D)
  const zx = (FR.x1 - FR.x0) / 8, zy = (FR.y1 - FR.y0) / 4;
  S.rect(FR.x0 - 5, FR.y0 - 5, FR.x1 - FR.x0 + 10, FR.y1 - FR.y0 + 10, 'zone');
  for (let i = 0; i <= 8; i++) {
    const x = FR.x0 + i * zx;
    if (i > 0 && i < 8) { S.line(x, FR.y0 - 5, x, FR.y0, 'zone'); S.line(x, FR.y1, x, FR.y1 + 5, 'zone'); }
    if (i < 8) {
      S.text(x + zx / 2, FR.y0 - 1.3, String(i + 1), { anchor: 'middle', size: 3 });
      S.text(x + zx / 2, FR.y1 + 3.9, String(i + 1), { anchor: 'middle', size: 3 });
    }
  }
  for (let j = 0; j <= 4; j++) {
    const y = FR.y0 + j * zy;
    if (j > 0 && j < 4) { S.line(FR.x0 - 5, y, FR.x0, y, 'zone'); S.line(FR.x1, y, FR.x1 + 5, y, 'zone'); }
    if (j < 4) {
      const L = 'ABCD'[j];
      S.text(FR.x0 - 2.5, y + zy / 2 + 1.1, L, { anchor: 'middle', size: 3 });
      S.text(FR.x1 + 2.5, y + zy / 2 + 1.1, L, { anchor: 'middle', size: 3 });
    }
  }
  // centring marks
  S.add(`<path class="k" style="stroke-width:.7" d="M${SHEET_W / 2} 0V${FR.y0 + 5}M${SHEET_W / 2} ${SHEET_H}V${FR.y1 - 5}M0 ${SHEET_H / 2}H${FR.x0 + 5}M${SHEET_W} ${SHEET_H / 2}H${FR.x1 - 5}"/>`);
  // trimming corner marks
  S.add(`<path class="b" d="M0 0h7v2H2v5H0zM${SHEET_W} 0h-7v2h5v5h2zM0 ${SHEET_H}h7v-2H2v-5H0zM${SHEET_W} ${SHEET_H}h-7v-2h5v-5h2z" opacity=".85"/>`);
}

function projectionSymbol(S, cx, cy, k = 1) {
  // ISO 5456-2 first angle (method E): end view (two circles) LEFT of the truncated cone elevation,
  // the cone's large end facing the circles.
  const d1 = 3.2 * k, d2 = 6.4 * k, len = 6.4 * k;
  const ccx = cx - 6.2 * k;
  S.add(`<circle class="n" cx="${n2(ccx)}" cy="${n2(cy)}" r="${n2(d2 / 2)}" style="stroke-width:.35"/><circle class="n" cx="${n2(ccx)}" cy="${n2(cy)}" r="${n2(d1 / 2)}" style="stroke-width:.35"/>`);
  const x0 = cx + 0.8 * k, x1 = x0 + len;
  S.poly([[x0, cy - d2 / 2], [x1, cy - d1 / 2], [x1, cy + d1 / 2], [x0, cy + d2 / 2]], 'n', true, ' style="stroke-width:.35"');
  S.line(ccx - d2 / 2 - 1.2, cy, x1 + 1.2, cy, 'ce');
  S.line(ccx, cy - d2 / 2 - 1.2, ccx, cy + d2 / 2 + 1.2, 'ce');
}
function raSymbol(S, x, y, value, h = 3) {
  // ISO 1302 / ISO 21920: material removal required, value under the extended long leg
  const t30 = Math.tan(Math.PI / 6), H1 = 1.4 * h, H2 = 2.9 * h;
  const pL = [x - H1 * t30, y - H1], pR = [x + H2 * t30, y - H2];
  const tw = richW(value, 2.8);
  S.add(`<path class="n" d="M${n2(pL[0])} ${n2(pL[1])}L${n2(x)} ${n2(y)}L${n2(pR[0])} ${n2(pR[1])}H${n2(pR[0] + tw + 1.5)}M${n2(pL[0])} ${n2(pL[1])}H${n2(x + H1 * t30)}" style="stroke-width:.3"/>`);
  S.text(pR[0] + 0.6, pR[1] + 3.0, value, { size: 2.8 });
}

function sheetMeta(P) {
  const h = hashStr(P.drawingNo + P.id);
  const people = ['J. Okafor', 'R. Meyer', 'S. Tanaka', 'L. Novak', 'A. Varga', 'M. Haddad', 'K. Lindqvist', 'D. Brennan'];
  const ini = (n) => n.split(' ').map((w) => w[0]).join('');
  const drawn = people[h % people.length], checked = people[(h >>> 3) % people.length === h % people.length ? ((h >>> 3) + 1) % people.length : (h >>> 3) % people.length];
  const approved = people[(h >>> 7) % people.length];
  const month = 1 + (h % 9), day = 1 + ((h >>> 4) % 27);
  const date = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const revs = [];
  const rc = Math.max(0, P.rev.toUpperCase().charCodeAt(0) - 65);
  const descs = ['Initial release', 'Tolerances revised per ECN-', 'Corner radii added per ECN-', 'Depths revised per ECN-', 'Material changed per ECN-'];
  for (let i = 0; i <= Math.min(rc, 4); i++) {
    const m = clamp(month - (rc - i) * 2, 1, 12), dd = clamp(day - i, 1, 28);
    revs.push({ rev: String.fromCharCode(65 + i), desc: i === 0 ? descs[0] : descs[i] + String(210 + (h % 600) + i * 7), date: `2026-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`, by: ini(people[(h >>> (2 + i)) % people.length]) });
  }
  return { drawn, checked, approved, date, revs, ini };
}
function partMass(P) {
  const nx = 120, ny = Math.max(20, Math.round((120 * P.W) / P.L));
  let rem = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) rem += P.depthAt(((i + 0.5) * P.L) / nx, ((j + 0.5) * P.W) / ny);
  const vol = P.L * P.W * P.H - (rem * P.L * P.W) / (nx * ny);         // mm^3
  return (vol / 1000) * (P.mat.density ?? 2.7);                         // g
}

function drawTitleBlock(S, P, lay, meta) {
  const x = TB.x, y = TB.y, w = TB.w, h = TB.h;
  S.add(`<rect class="w" x="${x}" y="${y}" width="${w}" height="${h}"/>`);
  S.rect(x, y, w, h, 'tbk');
  const cell = (cx, cy, cw, chh, label, value, o = {}) => {
    S.rect(cx, cy, cw, chh, 'tb');
    if (label) S.text(cx + 1, cy + 2.3, label, { size: 1.8, fill: '#333' });
    if (value != null && value !== '') {
      const size = o.size ?? 3;
      let v = String(value);
      const maxW = cw - 2;
      let sz = size;
      while (richW(v, sz, o.bold) > maxW && sz > 1.8) sz -= 0.1;
      S.text(o.anchor === 'middle' ? cx + cw / 2 : cx + 1.2, cy + chh - (o.dy ?? 1.6), v, { size: sz, bold: o.bold, anchor: o.anchor });
    }
  };
  const rH = 9;
  // row 1: tolerances | surface | edges | projection
  cell(x, y, 66, rH, 'General tolerances', '', {});
  S.text(x + 1.2, y + 5.3, 'ISO 2768-m unless stated', { size: 2.6 });
  S.text(x + 1.2, y + 8.2, `Linear ±${fmt(P.tolG, 3)} unless stated`, { size: 2.6 });
  cell(x + 66, y, 34, rH, 'Surface texture', '');
  const raNote = P.notes.find((n) => /Ra\s*[\d.]+/i.test(n));
  const raVal = raNote ? raNote.match(/Ra\s*([\d.]+)/i)[1] : '3.2';
  raSymbol(S, x + 73, y + 8.3, `Ra ${raVal}`, 1.6);
  cell(x + 100, y, 40, rH, 'Edges ISO 13715', '');
  S.text(x + 101.2, y + 5.3, 'Break all sharp edges', { size: 2.5 });
  S.text(x + 101.2, y + 8.2, '0.2 × 45° max., deburr', { size: 2.5 });
  cell(x + 140, y, 40, rH, 'Projection', '');
  projectionSymbol(S, x + 163, y + 5.2, 0.85);
  S.text(x + 141, y + 8.2, 'ISO E', { size: 1.8 });
  // row 2: material | blank | scale | sheet | mass
  const y2 = y + rH;
  cell(x, y2, 66, rH, 'Material', P.mat.name, { size: 3.2 });
  cell(x + 66, y2, 34, rH, 'Blank size (sawn)', `${fmt(P.stock.x)} × ${fmt(P.stock.y)} × ${fmt(P.stock.z)}`, { size: 2.9 });
  cell(x + 100, y2, 20, rH, 'Scale', scaleText(lay.s), { size: 3.4 });
  cell(x + 120, y2, 20, rH, 'Units', 'mm', { size: 3.2 });
  cell(x + 140, y2, 40, rH, 'Mass (calc.)', (() => { const g = partMass(P); return g >= 1000 ? `${fmt(g / 1000, 2)} kg` : `${fmt(g, 0)} g`; })(), { size: 3.2 });
  // row 3: drawn | checked | approved | date | sheet size
  const y3 = y2 + rH;
  cell(x, y3, 33, rH, 'Drawn', meta.drawn, { size: 2.9 });
  cell(x + 33, y3, 33, rH, 'Checked', meta.checked, { size: 2.9 });
  cell(x + 66, y3, 34, rH, 'Approved', meta.approved, { size: 2.9 });
  cell(x + 100, y3, 22, rH, 'Date', meta.date, { size: 2.5 });
  cell(x + 122, y3, 18, rH, 'Size', 'A3', { size: 3.2 });
  cell(x + 140, y3, 40, rH, 'Sheet', '1 / 1', { size: 3.2 });
  // row 4: owner | title | identification
  const y4 = y3 + rH, h4 = h - 3 * rH;
  S.rect(x, y4, 52, h4, 'tb');
  // owner logo: stylised end mill in a circle
  const lx = x + 8, ly = y4 + h4 / 2 - 1.2;
  S.add(`<circle cx="${lx}" cy="${n2(ly)}" r="5.2" fill="#000"/><path d="M${lx - 1.6} ${n2(ly - 3.4)}h3.2v4.2l-1.6 2.4l-1.6-2.4z" fill="#fff"/><path d="M${lx - 1.6} ${n2(ly - 1.6)}l3.2 -1M${lx - 1.6} ${n2(ly + 0.2)}l3.2 -1" stroke="#000" stroke-width=".35"/>`);
  S.text(x + 15, y4 + 8.4, 'MILLLAB', { size: 4.6, bold: true });
  S.text(x + 15, y4 + 12.6, 'TOOLROOM', { size: 3.4, bold: true });
  S.text(x + 2, y4 + h4 - 4.6, 'Precision machining training shop', { size: 1.9 });
  S.text(x + 2, y4 + h4 - 1.8, 'Workshop 3 · Bay 2', { size: 1.9 });
  S.rect(x + 52, y4, 88, h4, 'tb');
  S.text(x + 53, y4 + 2.3, 'Title', { size: 1.8, fill: '#333' });
  let ts = 6;
  const title = P.title.toUpperCase();
  while (richW(title, ts, true) > 84 && ts > 3) ts -= 0.2;
  S.text(x + 96, y4 + 10.5, title, { size: ts, bold: true, anchor: 'middle' });
  if (P.customer) S.text(x + 96, y4 + 15.8, `Customer: ${P.customer}`, { size: 2.6, anchor: 'middle' });
  S.text(x + 96, y4 + 20.3, `Part ${P.id || '—'} · Difficulty ${P.difficulty}/5`, { size: 2.4, anchor: 'middle' });
  S.rect(x + 140, y4, 40, h4, 'tb');
  S.text(x + 141, y4 + 2.3, 'Drawing number', { size: 1.8, fill: '#333' });
  let ds = 5.4;
  while (richW(P.drawingNo, ds, true) > 37 && ds > 3) ds -= 0.2;
  S.text(x + 160, y4 + 9.6, P.drawingNo, { size: ds, bold: true, anchor: 'middle' });
  S.line(x + 140, y4 + 13, x + 180, y4 + 13, 'tb');
  S.text(x + 141, y4 + 15.3, 'Revision', { size: 1.8, fill: '#333' });
  S.text(x + 160, y4 + 21.5, P.rev, { size: 5, bold: true, anchor: 'middle' });
}

function drawRevTable(S, P, meta) {
  const x = RC.x0, w = RC.x1 - RC.x0, rh = 4.6, y = FR.y0;
  const cols = [[0, 9, 'REV'], [9, 55, 'DESCRIPTION'], [64, 24, 'DATE'], [88, w - 88, 'APPR.']];
  const rows = meta.revs;
  S.add(`<rect class="w" x="${x}" y="${y}" width="${w}" height="${n2(rh * (rows.length + 1))}"/>`);
  for (const [cx, cw, lab] of cols) { S.rect(x + cx, y, cw, rh, 'tb'); S.text(x + cx + cw / 2, y + 3.3, lab, { size: 2.2, anchor: 'middle', bold: true }); }
  rows.forEach((r, i) => {
    const yy = y + rh * (i + 1);
    const vals = [r.rev, r.desc, r.date, r.by];
    cols.forEach(([cx, cw], k) => {
      S.rect(x + cx, yy, cw, rh, 'tb');
      let sz = 2.4; while (richW(vals[k], sz) > cw - 1.5 && sz > 1.6) sz -= 0.1;
      S.text(k === 1 ? x + cx + 1 : x + cx + cw / 2, yy + 3.3, vals[k], { size: sz, anchor: k === 1 ? 'start' : 'middle' });
    });
  });
  return y + rh * (rows.length + 1);
}

function noteList(P) {
  const L = [];
  for (const n of P.notes) L.push(n);
  L.push(`Blank: ${fmt(P.stock.x)} × ${fmt(P.stock.y)} × ${fmt(P.stock.z)} (sawn). Face top to Z finished thickness ${fmt(P.H)}${P.stock.z > P.H + 1e-6 ? ` (remove ${fmt(P.stock.z - P.H)})` : ''}.`);
  L.push('Datums A / B / C: left face / front face / top face. Ordinate dimensions from datums A and B; depths (↧) from finished top face C.');
  L.push(`General tolerances ISO 2768-m; linear ±${fmt(P.tolG, 3)} unless stated.`);
  if (P.feats.some((f) => f.drilled && !f.through)) L.push('Drill point 118° below stated full-diameter hole depth.');
  L.push('All dimensions in mm. Do not scale drawing.');
  return L;
}
function drawNotes(S, P, yBottom) {
  const x = TB.x, w = RC.x1 - x, size = 2.7, lh = 3.6;
  const items = noteList(P).map((n, i) => ({ n: i + 1, lines: wrapText(n, w - 7, size) }));
  const total = 6 + items.reduce((a, it) => a + it.lines.length * lh + 0.8, 0);
  const y0 = yBottom - total;
  S.text(x, y0 + 3.6, 'NOTES', { size: 3.4, bold: true });
  let yy = y0 + 8.4;
  for (const it of items) {
    S.text(x, yy, `${it.n}.`, { size });
    for (const l of it.lines) { S.text(x + 4.5, yy, l, { size }); yy += lh; }
    yy += 0.8;
  }
  S.reserve(x, y0, RC.x1, yBottom);
  return { top: y0, left: x };
}

// ---------------------------------------------------------------------------------------------
// views
function drawPlan(S, P, lay, sec, groups) {
  const s = lay.s, X = (x) => lay.x0 + x * s, Y = (y) => lay.planB - y * s;
  const T = (p) => [X(p[0]), Y(p[1])];
  const e = 0.02;
  // visible edges: a piece is an edge when the depth on its two sides differs
  const drawLoop = (loop) => {
    const vis = loop.pieces.map((pc) => {
      const a = P.depthAt(pc.mx - pc.nx * e, pc.my - pc.ny * e), b = P.depthAt(pc.mx + pc.nx * e, pc.my + pc.ny * e);
      return a != null && b != null && Math.abs(a - b) > 1e-6;
    });
    if (vis.every(Boolean) && loop.circle) {
      S.add(`<circle class="k" cx="${n2(X(loop.circle.cx))}" cy="${n2(Y(loop.circle.cy))}" r="${n2(loop.circle.r * s)}"/>`);
      return;
    }
    if (vis.every(Boolean)) { S.poly(loop.pts.map(T), 'k', true); return; }
    // runs
    const n = vis.length; let start = vis.indexOf(false);
    if (start < 0) start = 0;
    let run = [];
    for (let k = 1; k <= n; k++) {
      const i = (start + k) % n, pc = loop.pieces[i];
      if (vis[i]) { if (!run.length) run.push(T([pc.ax, pc.ay])); run.push(T([pc.bx, pc.by])); }
      else if (run.length) { S.poly(run, 'k'); run = []; }
    }
    if (run.length) S.poly(run, 'k');
  };
  for (const f of P.feats) for (const l of f.loops) drawLoop(l);
  S.rect(X(0), Y(P.W), P.L * s, P.W * s, 'k');

  // centre lines
  const ext = 2.5;
  const cross = (cx, cy, r) => {
    const R = r * s + ext;
    S.line(X(cx) - R, Y(cy), X(cx) + R, Y(cy), 'ce');
    S.line(X(cx), Y(cy) - R, X(cx), Y(cy) + R, 'ce');
  };
  for (const f of P.feats) {
    if (f.type === 'hole') cross(f.cx, f.cy, f.cb ? f.cb.r : f.r);
    else if (f.type === 'pocketCirc' || (f.type === 'boss' && f.shape === 'circle')) cross(f.cx, f.cy, f.r);
    else if (f.type === 'pocketRect' || (f.type === 'boss' && f.shape === 'rect')) {
      const ca = Math.cos(f.ang), sa = Math.sin(f.ang);
      const a = f.w / 2 * s + ext, b = f.h / 2 * s + ext, c = [X(f.cx), Y(f.cy)];
      S.line(c[0] - a * ca, c[1] + a * sa, c[0] + a * ca, c[1] - a * sa, 'ce');
      S.line(c[0] + b * sa, c[1] + b * ca, c[0] - b * sa, c[1] - b * ca, 'ce');
    } else if (f.type === 'slot') {
      const len = f.len * s, ux = len > 0 ? (f.x2 - f.x1) / f.len : 1, uy = len > 0 ? (f.y2 - f.y1) / f.len : 0;
      const ex = f.w / 2 * s + ext;
      const p1 = [X(f.x1), Y(f.y1)], p2 = [X(f.x2), Y(f.y2)];
      S.line(p1[0] - ux * ex, p1[1] + uy * ex, p2[0] + ux * ex, p2[1] - uy * ex, 'ce');
      for (const p of [p1, p2]) S.line(p[0] - uy * ex, p[1] - ux * ex, p[0] + uy * ex, p[1] + ux * ex, 'ce');
    }
  }
  for (const g of groups) if (g.pcd) {
    S.add(`<circle class="ce" cx="${n2(X(g.pcd.cx))}" cy="${n2(Y(g.pcd.cy))}" r="${n2(g.pcd.R * s)}"/>`);
  }

  // cutting planes A-A (y = c, viewing +Y = up) and B-B (x = c, viewing +X = right)
  const cutA = sec.A.c, cutB = sec.B.c;
  {
    const y = Y(cutA), xl = X(0), xr = X(P.L);
    S.line(xl - 1, y, xr + 1, y, 'cp');
    for (const [xa, xb] of [[xl - 5.5, xl + 2], [xr - 2, xr + 5.5]]) S.line(xa, y, xb, y, 'cpk');
    for (const xa of [xl - 5.5, xr + 5.5]) {
      S.line(xa, y, xa, y - 5.5, 'n'); S.add(arrow(xa, y - 6.2, 0, -1, 2.8, 0.55));
      S.text(xa + (xa < xl ? 1.3 : -1.3), y - 2.4, 'A', { size: 4.2, anchor: xa < xl ? 'start' : 'end', bold: true });
    }
  }
  {
    const x = X(cutB), yt = Y(P.W), yb = Y(0);
    S.line(x, yt - 1, x, yb + 1, 'cp');
    for (const [ya, yb2] of [[yt - 5.5, yt + 2], [yb - 2, yb + 5.5]]) S.line(x, ya, x, yb2, 'cpk');
    for (const ya of [yt - 5.5, yb + 5.5]) {
      S.line(x, ya, x + 5.5, ya, 'n'); S.add(arrow(x + 6.2, ya, 1, 0, 2.8, 0.55));
      S.text(ya < yt ? x + 4.2 : x - 1.3, ya < yt ? ya - 1.4 : ya + 1.5, 'B', { size: 4.2, anchor: ya < yt ? 'middle' : 'end', bold: true });
    }
  }

  // ordinate dimensions: X below the plan, Y left of the plan
  const xs = ordValues(P, 'x'), ys = ordValues(P, 'y');
  {
    const base = Y(0), bx = X(cutB);
    const items = xs.map((v) => ({ v, pos: X(v) }));
    const pos = spread(items.map((it) => ({ ideal: it.pos - 1.95, size: 3.9 })), X(0) - 8, X(P.L) + 8).map((p) => p + 1.95);
    const j1 = base + 9, j2 = j1 + 3.5, te = j2 + 1.5;
    items.forEach((it, i) => {
      const near = it.pos > bx - 6.5 && it.pos < bx + 9;
      const g0 = near ? 8.6 : 1.5;
      const p = pos[i];
      if (Math.abs(p - it.pos) < 0.05) S.line(it.pos, base + g0, it.pos, te, 'n');
      else S.poly([[it.pos, base + g0], [it.pos, j1], [p, j2], [p, te]], 'n');
      S.text(p + 1.15, te + 0.8, fmt(it.v), { anchor: 'end', rot: -90 });
    });
  }
  {
    const base = X(0), ay = Y(cutA);
    const items = ys.map((v) => ({ v, pos: Y(v) }));
    const pos = spread(items.map((it) => ({ ideal: it.pos - 1.95, size: 3.9 })), Y(P.W) - 8, Y(0) + 8).map((p) => p + 1.95);
    const j1 = base - 9, j2 = j1 - 3.5, te = j2 - 1.5;
    items.forEach((it, i) => {
      const near = it.pos < ay + 2 && it.pos > ay - 10;
      const g0 = near ? 8.6 : 1.5;
      const p = pos[i];
      if (Math.abs(p - it.pos) < 0.05) S.line(base - g0, it.pos, te, it.pos, 'n');
      else S.poly([[base - g0, it.pos], [j1, it.pos], [j2, p], [te, p]], 'n');
      S.text(te - 0.8, p + 1.15, fmt(it.v), { anchor: 'end' });
    });
  }

  // callouts with leaders, labels in a column right of the plan
  drawCallouts(S, P, lay, groups, X, Y);
}

function nearestOnLoop(pts, qx, qy) {
  let best = null, bd = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? clamp(((qx - ax) * dx + (qy - ay) * dy) / l2, 0, 1) : 0;
    const px = ax + t * dx, py = ay + t * dy, d = Math.hypot(qx - px, qy - py);
    if (d < bd) { bd = d; best = [px, py]; }
  }
  return best;
}
function drawCallouts(S, P, lay, groups, X, Y) {
  if (!groups.length) return;
  const s = lay.s, colX = lay.colX, size = 3, lh = 4.1;
  const toPart = (px, py) => [(px - lay.x0) / s, (lay.planB - py) / s];
  // pick the instance each label leads to: the one nearest to the label column
  const items = groups.map((g) => {
    let lead = g.feats[0], best = -Infinity;
    for (const f of g.feats) {
      const fx = f.type === 'step' ? f.cx : f.type === 'slot' ? Math.max(f.x1, f.x2) : f.cx;
      if (fx > best + 1e-6) { best = fx; lead = f; }
    }
    const ref = lead.type === 'slot' ? (lead.x2 >= lead.x1 ? [lead.x2, lead.y2] : [lead.x1, lead.y1]) : [lead.cx, lead.cy];
    const h = g.lines.length * lh;
    const rr = (lead.cb ? lead.cb.r : lead.r ?? (lead.type === 'pocketRect' ? Math.min(lead.w, lead.h) / 2 : 0)) * s;
    const rise = Math.min(14, 3 + rr * 0.8 + (colX - X(ref[0])) * 0.12);
    return { g, lead, ideal: Y(ref[1]) - rise - size * 0.6, size: h + 2.6, h };
  });
  const tops = spread(items, lay.lblLo, lay.lblHi);
  items.forEach((it, i) => {
    const top = tops[i], yc = top + size * 0.9 - size * 0.36 + 0.2;   // centre of first line
    const tw = tagWidth(it.g.ids, size);
    tag(S, colX, yc, it.g.ids, size);
    it.g.lines.forEach((l, k) => S.text(colX + tw + 1.5, top + size * 0.9 + k * lh + 0.2, l, { size }));
    // leader
    const sh = [colX - 0.5, yc], shoulder = [colX - 4, yc];
    const f = it.lead;
    let tip, dot = false;
    const [qx, qy] = toPart(shoulder[0], shoulder[1]);
    if (f.type === 'step') {
      const b = f.box; tip = [clamp(qx, b[0], b[2]), clamp(qy, b[1], b[3])];
      tip = [(b[0] + b[2]) / 2 + (f.side === 'left' || f.side === 'right' ? 0 : ((b[2] - b[0]) * 0.3)), (b[1] + b[3]) / 2 + (f.side === 'front' || f.side === 'back' ? 0 : (b[3] - b[1]) * 0.25)];
      dot = true;
    } else if (f.round) {
      const r = f.type === 'hole' ? f.r : f.r, a = Math.atan2(qy - f.cy, qx - f.cx);
      tip = [f.cx + r * Math.cos(a), f.cy + r * Math.sin(a)];
    } else {
      tip = nearestOnLoop(f.loops[0].pts, qx, qy);
    }
    let tp = [X(tip[0]), Y(tip[1])];
    const knee = [];
    const cy0 = f.cy != null ? Y(f.cy) : null;
    if (!dot && cy0 != null && Math.abs(yc - cy0) < 2.2 && Math.abs(tp[1] - cy0) < 2.2) {
      // the leader would run along the horizontal centre line: attach at 40 deg instead with a radial knee
      const up = yc <= cy0 ? -1 : 1;
      if (f.round) {
        const a = (40 * Math.PI) / 180, r = f.r * s;
        tp = [X(f.cx) + r * Math.cos(a), cy0 + up * r * Math.sin(a)];
        knee.push([tp[0] + 4 * Math.cos(a), tp[1] + up * 4 * Math.sin(a)]);
      } else {
        const q = nearestOnLoop(f.loops[0].pts, (shoulder[0] - lay.x0) / s, f.cy - (up * (f.h ?? 10)) / 4);
        tp = [X(q[0]), Y(q[1])];
        knee.push([tp[0] + 3, tp[1] + up * 3]);
      }
    }
    S.poly([tp, ...knee, shoulder, sh], 'n');
    const nxt = knee[0] || shoulder;
    if (dot) S.add(`<circle class="b" cx="${n2(tp[0])}" cy="${n2(tp[1])}" r="0.55"/>`);
    else S.add(arrow(tp[0], tp[1], tp[0] - nxt[0], tp[1] - nxt[1]));
    // small balloons next to the other instances of the group
    for (const g2 of it.g.feats) {
      if (g2 === f) continue;
      const r = g2.cb ? g2.cb.r : (g2.r ?? 0);
      const bx = X(g2.cx) + r * s * 0.72 + 2.6, by = Y(g2.cy) - r * s * 0.72 - 2.6;
      S.line(X(g2.cx) + r * s * 0.71, Y(g2.cy) - r * s * 0.71, bx - 1.3, by + 1.3, 'n');
      S.add(`<circle class="n" cx="${n2(bx)}" cy="${n2(by)}" r="2.1" fill="#fff"/>`);
      S.text(bx, by + 1.0, g2.id, { size: 2.7, anchor: 'middle' });
    }
  });
}

// Generic section view. sec: { axis, c, letter }, map(t, z) -> paper point.
function drawSection(S, P, lay, sec, map, opt) {
  const { H } = P, s = lay.s;
  const T = sec.axis === 'x' ? P.L : P.W;
  const iv = profile(P, sec.axis, sec.c);
  const M = (t, z) => map(t, z);
  // top profile with drill points
  const top = [];
  for (const v of iv) for (const p of intervalTop(P, v, sec.axis, sec.c)) top.push(p);
  const fillPts = [[0, -H], ...top, [T, -H]].map(([t, z]) => M(t, z));
  const hid = `${S.uid}${sec.letter}`;
  S.defs.push(`<clipPath id="${hid}c"><polygon points="${fillPts.map((p) => `${n2(p[0])},${n2(p[1])}`).join(' ')}"/></clipPath>`);
  S.add(`<polygon points="${fillPts.map((p) => `${n2(p[0])},${n2(p[1])}`).join(' ')}" fill="url(#${S.uid}h)" stroke="none"/>`);
  // outline
  const segs = [];
  for (const v of iv) if (v.d < H - 1e-6) segs.push(intervalTop(P, v, sec.axis, sec.c));
  for (let i = 1; i < iv.length; i++) {
    const a = iv[i - 1], b = iv[i];
    const za = a.drill ? -a.d : -a.d, zb = -b.d;
    if (Math.abs(za - zb) > 1e-6) segs.push([[b.t0, za], [b.t0, zb]]);
  }
  if (iv[0].d < H - 1e-6) segs.push([[0, -iv[0].d], [0, -H]]);
  const last = iv[iv.length - 1];
  if (last.d < H - 1e-6) segs.push([[T, -last.d], [T, -H]]);
  let bot = null;
  for (const v of iv) {
    if (v.d < H - 1e-6) { if (bot && Math.abs(bot[1][0] - v.t0) < 1e-6) bot[1] = [v.t1, -H]; else { bot = [[v.t0, -H], [v.t1, -H]]; segs.push(bot); } }
    else bot = null;
  }
  for (const sg of segs) S.poly(sg.map(([t, z]) => M(t, z)), 'k');

  // centre lines of round features cut through their axis
  const axisT = (f) => (sec.axis === 'x' ? f.cx : f.cy), perp = (f) => (sec.axis === 'x' ? f.cy : f.cx);
  for (const f of P.feats) {
    if (!f.round && f.type !== 'pocketRect' && !(f.type === 'boss')) continue;
    if (f.cx == null || Math.abs(perp(f) - sec.c) > 1e-6) continue;
    if (!sec.cut.has(f)) continue;
    const t = axisT(f);
    let zb = f.type === 'boss' ? -H : -Math.min(H, f.depth + (f.drilled && !f.through ? f.r * CONE : 0));
    if (f.type === 'boss' || (f.drilled && f.through)) zb = -H;
    const p0 = M(t, 0), p1 = M(t, zb);
    S.line(p0[0], p0[1] - 2.5, p1[0], p1[1] + 2.5, 'ce');
  }
  // slot cut lengthwise: centre lines at the end centres
  for (const f of P.feats) {
    if (f.type !== 'slot' || !sec.cut.has(f)) continue;
    const along = sec.axis === 'x' ? Math.abs(f.y1 - sec.c) < 1e-6 && Math.abs(f.y2 - sec.c) < 1e-6 : Math.abs(f.x1 - sec.c) < 1e-6 && Math.abs(f.x2 - sec.c) < 1e-6;
    if (!along) continue;
    for (const t of sec.axis === 'x' ? [f.x1, f.x2] : [f.y1, f.y2]) {
      const p0 = M(t, 0), p1 = M(t, -f.depth);
      S.line(p0[0], p0[1] - 2.5, p1[0], p1[1] + 2.5, 'ce');
    }
  }

  // hidden lines for features that no section cuts and that lie behind this cutting plane
  const hiddenOut = [];
  for (const f of opt.hiddenFeats) {
    if (f.type === 'boss' || f.type === 'step') continue;
    const [bx0, by0, bx1, by1] = f.bbox;
    const ta = sec.axis === 'x' ? bx0 : by0, tb = sec.axis === 'x' ? bx1 : by1;
    const zt = -(P.depthInfo(f.cx ?? (bx0 + bx1) / 2, f.cy ?? (by0 + by1) / 2, f)?.d ?? 0);
    const out = [];
    if (f.type === 'hole') {
      const tc = sec.axis === 'x' ? f.cx : f.cy;
      if (f.cb) {
        const zc = -f.cb.depth;
        out.push([[tc - f.cb.r, zt], [tc - f.cb.r, zc], [tc + f.cb.r, zc], [tc + f.cb.r, zt]]);
        out.push([[tc - f.r, zc], [tc - f.r, -f.depth]], [[tc + f.r, zc], [tc + f.r, -f.depth]]);
      } else out.push([[tc - f.r, zt], [tc - f.r, -f.depth]], [[tc + f.r, zt], [tc + f.r, -f.depth]]);
      if (!f.through) out.push([[tc - f.r, -f.depth], [tc, Math.max(-H, -f.depth - f.r * CONE)], [tc + f.r, -f.depth]]);
    } else {
      out.push([[ta, zt], [ta, -f.depth], [tb, -f.depth], [tb, zt]]);
    }
    for (const o of out) hiddenOut.push(o.map(([t, z]) => M(t, z)));
  }
  if (hiddenOut.length) {
    S.add(`<g clip-path="url(#${hid}c)">${hiddenOut.map((pts) => `<polyline class="hi" points="${pts.map((p) => `${n2(p[0])},${n2(p[1])}`).join(' ')}"/>`).join('')}</g>`);
  }
  return iv;
}

// depth dimensions in a section view: inside wide openings + outside dims for open ends (steps / boss surround)
function sectionDims(S, P, lay, sec, iv, map, o) {
  const s = lay.s, H = P.H, T = sec.axis === 'x' ? P.L : P.W;
  const tolOf = (f) => (f && f.tol ? `±${fmt(f.tol, 3)}` : '');
  // outside dims (open ends)
  const outward = Math.sign(map(0, 0)[0] - map(T, 0)[0]);    // paper direction of t = 0 end
  const ends = [];
  const first = iv[0], last = iv[iv.length - 1];
  if (first.d > 1e-6 && first.d < H - 1e-6) ends.push({ v: first, t: 0, dir: outward, side: 'start' });
  if (last.d > 1e-6 && last.d < H - 1e-6 && !(ends.length && ends[0].v.f === last.f && Math.abs(ends[0].v.d - last.d) < 1e-6 && o.prefer === 'start')) {
    if (ends.length && ends[0].v.f === last.f && Math.abs(ends[0].v.d - last.d) < 1e-6) ends.length = 0;
    ends.push({ v: last, t: T, dir: -outward, side: 'end' });
  }
  const used = { left: 0, right: 0 };
  for (const e of ends) {
    // nearest point with material at the top face scanning inward
    const list = e.side === 'start' ? iv : [...iv].reverse();
    const topIv = list.find((v) => v.d < 1e-6);
    if (!topIv) continue;
    const tTop = e.side === 'start' ? topIv.t0 : topIv.t1;
    const pTop = map(tTop, 0), pFloor = map(e.t, -e.v.d), pEdge = map(e.t, 0);
    const dk = `${e.v.f ? e.v.f.index : -1}|${fmt(e.v.d)}`;
    if (o.done.has(dk)) continue;
    o.done.add(dk);
    const side = e.dir < 0 ? 'left' : 'right';
    const off = 7 + used[side] * 8; used[side]++;
    const xd = pEdge[0] + e.dir * off;
    // extension lines drawn by dimV (from pTop and pFloor horizontally)
    dimV(S, pTop[0], pTop[1], pFloor[0], pFloor[1], xd, `${fmt(e.v.d)}${tolOf(e.v.f)}`);
    o.sideUse[side] = Math.max(o.sideUse[side] || 0, off + 5);
  }
  // inside depth dims for wide openings
  const byF = new Map();
  for (const v of iv) {
    if (!v.f || v.d < 1e-6 || v.d >= H - 1e-6) continue;
    if (v.f.type === 'step' || v.f.type === 'boss') continue;
    if (v === first || v === last) { if (v.t0 < 1e-6 || v.t1 > T - 1e-6) continue; }
    const k = `${v.f.index}|${v.d}`;
    if (!byF.has(k)) byF.set(k, { f: v.f, d: v.d, t0: v.t0, t1: v.t1 }); else { const b = byF.get(k); b.t0 = Math.min(b.t0, v.t0); b.t1 = Math.max(b.t1, v.t1); }
  }
  const placed = [];
  for (const b of byF.values()) {
    const p0 = map(b.t0, 0), p1 = map(b.t1, 0);
    const xa = Math.min(p0[0], p1[0]), xb = Math.max(p0[0], p1[0]), span = xb - xa;
    const hasAxis = b.f.round && Math.abs((sec.axis === 'x' ? b.f.cy : b.f.cx) - sec.c) < 1e-6;
    if (span < (hasAxis ? 15 : 9) || b.d * s < 4) continue;
    const dk = `${b.f.index}|${fmt(b.d)}`;
    if (o.done.has(dk)) continue;
    const xd = xa + 5.4;
    if (placed.some((x) => Math.abs(x - xd) < 6)) continue;
    placed.push(xd);
    o.done.add(dk);
    const yTop = p0[1], yF = map(b.t0, -b.d)[1];
    // thin extension of the top surface across the opening
    S.line(xa + 1, yTop, xd + 2, yTop, 'n');
    dimV(S, xd, yTop, xd, yF, xd, `${fmt(b.d)}${tolOf(b.f)}`, { noExtA: true, noExtB: true });
  }
}

function drawViews(S, P, lay, sec, groups) {
  const s = lay.s, H = P.H;
  const fyT = lay.frontTop;
  const mapA = (t, z) => [lay.x0 + t * s, fyT - z * s];
  const mapB = (t, z) => [lay.sideX0 + (P.W - t) * s, fyT - z * s];
  // hatch pattern
  const hs = n2(clamp(H * s / 7, 1.4, 2.6));
  S.defs.push(`<pattern id="${S.uid}h" patternUnits="userSpaceOnUse" width="${hs}" height="${hs}" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="${hs}" stroke="#000" stroke-width=".18"/></pattern>`);
  const notCut = P.feats.filter((f) => !sec.A.cut.has(f) && !sec.B.cut.has(f));
  const hidA = notCut.filter((f) => f.bbox[1] > sec.A.c);
  const hidB = notCut.filter((f) => !hidA.includes(f) && f.bbox[0] > sec.B.c);
  const ivA = drawSection(S, P, lay, { ...sec.A, letter: 'A' }, mapA, { hiddenFeats: hidA });
  const ivB = drawSection(S, P, lay, { ...sec.B, letter: 'B' }, mapB, { hiddenFeats: hidB });
  const sideUse = {};
  const done = new Set();
  sectionDims(S, P, lay, { ...sec.A }, ivA, mapA, { prefer: 'end', sideUse, done });
  sectionDims(S, P, lay, { ...sec.B }, ivB, mapB, { prefer: 'start', sideUse: {}, done });

  // view labels
  S.text(lay.x0 + P.L * s / 2, fyT - 8.5, 'A–A', { anchor: 'middle', size: 5, bold: true });
  S.text(lay.sideX0 + P.W * s / 2, fyT - 8.5, 'B–B', { anchor: 'middle', size: 5, bold: true });
  // overall dimensions
  const yb = fyT + H * s;
  dimH(S, lay.x0, yb, lay.x0 + P.L * s, yb, yb + 8, fmt(P.L));
  dimH(S, lay.sideX0, yb, lay.sideX0 + P.W * s, yb, yb + 8, fmt(P.W));
  // height dim left of A-A; first wall below any step decides the datum A position
  const leftUsed = sideUse.left || 0;
  const topA = ivA.find((v) => v.d < 1e-6);
  dimV(S, lay.x0 + (topA ? topA.t0 * s : 0), fyT, lay.x0, yb, lay.x0 - Math.max(14, leftUsed + 7), fmt(H));

  // datum A on the left face (section A-A), datum C on the top face, datum B on the front face (section B-B)
  const d0 = ivA[0].d;
  if (d0 < H - 1e-6) datum(S, lay.x0, fyT + (d0 + (H - d0) * 0.55) * s, -1, 0, 'A');
  const tops = ivA.filter((v) => v.d < 1e-6 && (v.t1 - v.t0) * s > 5);
  if (tops.length) {
    const mid = P.L / 2;
    tops.sort((a, b) => b.t1 - a.t1);
    const v = tops[0];
    const t = clamp((v.t0 + v.t1) / 2, v.t0 + 3 / s, v.t1 - 3 / s);
    const tt = (v.t0 + v.t1) / 2 > mid ? Math.min(v.t1 - 3.5 / s, Math.max(t, v.t1 - 8 / s)) : Math.max(v.t0 + 3.5 / s, Math.min(t, v.t0 + 8 / s));
    datum(S, lay.x0 + tt * s, fyT, 0, -1, 'C');
  }
  const b0 = ivB[0].d;
  if (b0 < H - 1e-6) datum(S, lay.sideX0 + P.W * s, fyT + (b0 + (H - b0) * 0.55) * s, 1, 0, 'B');
}

// ---------------------------------------------------------------------------------------------
// isometric pictorial (painter's algorithm over horizontal depth bands)
function isoSVG(P, box, uid, o = {}) {
  const { L, W, H } = P;
  const c30 = Math.cos(Math.PI / 6);
  const pr = (x, y, z) => [(x + y) * c30, (x - y) * 0.5 - z];
  const cs = [[0, 0, 0], [L, 0, 0], [0, W, 0], [L, W, 0], [0, 0, -H], [L, 0, -H], [0, W, -H], [L, W, -H]].map((p) => pr(...p));
  const mnx = Math.min(...cs.map((p) => p[0])), mxx = Math.max(...cs.map((p) => p[0]));
  const mny = Math.min(...cs.map((p) => p[1])), mxy = Math.max(...cs.map((p) => p[1]));
  const k = Math.min(box.w / (mxx - mnx), box.h / (mxy - mny));
  const ox = box.x + (box.w - k * (mxx - mnx)) / 2 - k * mnx, oy = box.y + (box.h - k * (mxy - mny)) / 2 - k * mny;
  const Tp = (x, y, z) => { const p = pr(x, y, z); return `${n2(ox + k * p[0])},${n2(oy + k * p[1])}`; };
  const lw = o.lw ?? 0.2;
  const levels = [0, H];
  for (const f of P.feats) { levels.push(f.depth); if (f.cb) levels.push(f.cb.depth); }
  const lv = [...new Set(levels.map((v) => Math.round(Math.min(v, H) * 1e6) / 1e6))].sort((a, b) => a - b);
  const loops = [P.blockLoop, ...P.feats.flatMap((f) => f.loops)];
  const e = 0.03, out = [], defs = [];
  const shade = (nx, ny) => { const I = 0.6 + 0.26 * nx - 0.06 * ny; const g = Math.round(clamp(I, 0.3, 0.95) * 255); return `rgb(${g},${g + 2},${g + 6})`; };
  for (let j = lv.length - 2; j >= 0; j--) {
    const dT = lv[j], dB = lv[j + 1];
    const recs = [];
    for (const loop of loops) {
      const pcs = loop.pieces, rs = new Array(pcs.length).fill(null);
      pcs.forEach((pc, i) => {
        const pin = P.depthAt(pc.mx - pc.nx * e, pc.my - pc.ny * e), pout = P.depthAt(pc.mx + pc.nx * e, pc.my + pc.ny * e);
        const sIn = pin != null && pin <= dT + EPS, sOut = pout != null && pout <= dT + EPS;
        if (!sIn || sOut) return;
        rs[i] = {
          pc, topReal: pin >= dT - EPS,
          botReal: pout == null ? j + 1 === lv.length - 1 : pout <= dB + EPS,
          vis: pc.nx - pc.ny > 1e-6, key: pc.mx - pc.my,
        };
      });
      rs.forEach((r, i) => {
        if (!r) return;
        const prev = rs[(i - 1 + rs.length) % rs.length], next = rs[(i + 1) % rs.length];
        const ang = (a, b) => a.pc.nx * b.pc.nx + a.pc.ny * b.pc.ny < 0.94;
        r.vStart = r.vis && (!prev || !prev.vis || ang(prev, r));
        r.vEnd = r.vis && (!next || !next.vis || ang(next, r));
      });
      // merge collinear runs (straight walls) into single quads
      let cur = null;
      for (const r of rs) {
        if (!r) { cur = null; continue; }
        if (cur && cur.vis === r.vis && cur.topReal === r.topReal && cur.botReal === r.botReal
          && Math.abs(cur.pc.nx - r.pc.nx) < 1e-9 && Math.abs(cur.pc.ny - r.pc.ny) < 1e-9
          && Math.abs(cur.pc.bx - r.pc.ax) < 1e-9 && Math.abs(cur.pc.by - r.pc.ay) < 1e-9) {
          cur.pc.bx = r.pc.bx; cur.pc.by = r.pc.by;
          cur.pc.mx = (cur.pc.ax + cur.pc.bx) / 2; cur.pc.my = (cur.pc.ay + cur.pc.by) / 2;
          cur.key = cur.pc.mx - cur.pc.my; cur.vEnd = r.vEnd;
        } else { cur = { ...r, pc: { ...r.pc } }; recs.push(cur); }
      }
    }
    // walls back to front
    recs.filter((r) => r.vis).sort((a, b) => a.key - b.key).forEach((r) => {
      const { ax, ay, bx, by } = r.pc, col = shade(r.pc.nx, r.pc.ny);
      const zb = -dB - (r.botReal ? 0 : 0.35 / k);
      out.push(`<polygon points="${Tp(ax, ay, -dT)} ${Tp(bx, by, -dT)} ${Tp(bx, by, zb)} ${Tp(ax, ay, zb)}" fill="${col}" stroke="${col}" stroke-width="${n2(lw)}" stroke-linejoin="round"/>`);
      let d = '';
      if (r.botReal) d += `M${Tp(ax, ay, -dB)}L${Tp(bx, by, -dB)}`;
      if (r.vStart) d += `M${Tp(ax, ay, -dT)}L${Tp(ax, ay, -dB)}`;
      if (r.vEnd) d += `M${Tp(bx, by, -dT)}L${Tp(bx, by, -dB)}`;
      if (d) out.push(`<path d="${d}" stroke="#111" stroke-width="${lw}" fill="none" stroke-linecap="round"/>`);
    });
    // top face of the band (solid region at depth dT)
    const mid = `${uid}m${j}`;
    let m = `<mask id="${mid}" maskUnits="userSpaceOnUse" x="${n2(box.x - 5)}" y="${n2(box.y - 5)}" width="${n2(box.w + 10)}" height="${n2(box.h + 10)}">`;
    const blockPts = `${Tp(0, 0, -dT)} ${Tp(L, 0, -dT)} ${Tp(L, W, -dT)} ${Tp(0, W, -dT)}`;
    m += `<polygon points="${blockPts}" fill="#fff"/>`;
    for (const f of P.feats) for (const l of f.loops) {
      if (!(l.depth > dT + EPS)) continue;
      const pts = l.pts.map((p) => Tp(p[0], p[1], -dT)).join(' ');
      if (l.inside) m += `<polygon points="${pts}" fill="#000"/>`;
      else m += `<path d="M${blockPts.split(' ').join('L')}Z M${pts.split(' ').join('L')}Z" fill="#000" fill-rule="evenodd"/>`;
    }
    m += '</mask>';
    defs.push(m);
    out.push(`<polygon points="${blockPts}" fill="${o.topFill ?? '#eef0f3'}" mask="url(#${mid})"/>`);
    let d = '';
    for (const r of recs) if (r.topReal) d += `M${Tp(r.pc.ax, r.pc.ay, -dT)}L${Tp(r.pc.bx, r.pc.by, -dT)}`;
    if (d) out.push(`<path d="${d}" stroke="#111" stroke-width="${lw}" fill="none" stroke-linecap="round"/>`);
  }
  return { defs: defs.join(''), body: out.join(''), bottom: oy + k * mxy };
}

// ---------------------------------------------------------------------------------------------
// public API
export function drawingSVG(part, opts = {}) {
  const P = normPart(part);
  const S = new Sheet();
  const groups = buildGroups(P);
  const sec = chooseSections(P);
  const meta = sheetMeta(P);
  drawFrame(S);
  const revBottom = drawRevTable(S, P, meta);
  const notes = drawNotes(S, P, TB.y - 3);
  const lay = computeLayout(P, groups, { revBottom, notesTop: notes.top, notesLeft: notes.left });
  drawTitleBlock(S, P, lay, meta);
  drawViews(S, P, lay, sec, groups);
  drawPlan(S, P, lay, sec, groups);
  // pictorial: right of the callout column, below the revision table / side view, above the notes
  if (opts.iso !== false) {
    const x0 = Math.max(RC.x0 - 22, (groups.length ? lay.colR : lay.planR) + 8);
    const y0 = lay.sideR + 12 > x0 ? lay.frontB + 18 : revBottom + 8;
    const box = { x: x0, y: y0, w: FR.x1 - 4 - x0, h: notes.top - 12 - y0 };
    if (box.w > 40 && box.h > 30) {
      const iso = isoSVG(P, box, `${S.uid}i`);
      S.defs.push(iso.defs);
      S.add(`<g>${iso.body}</g>`);
      S.text(box.x + box.w / 2, iso.bottom + 6, 'ISOMETRIC VIEW (NOT TO SCALE)', { anchor: 'middle', size: 2.6 });
    }
  }
  const w = opts.width ?? `${SHEET_W}mm`, h = opts.height ?? `${SHEET_H}mm`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${SHEET_W} ${SHEET_H}" font-family="${FONT}">`
    + `<title>${esc(`${P.drawingNo} ${P.title}`)}</title><defs><style>${STYLE}</style>${S.defs.join('')}</defs>${S.out.join('')}</svg>`;
}

export function drawingThumbSVG(part) {
  const P = normPart(part);
  const VW = 300, VH = 212;
  const out = [];
  out.push(`<rect x="0" y="0" width="${VW}" height="${VH}" fill="#fff"/>`);
  out.push(`<rect x="5" y="5" width="${VW - 10}" height="${VH - 10}" fill="none" stroke="#000" stroke-width="1.4"/>`);
  // title strip
  const ty = VH - 52;
  out.push(`<line x1="5" y1="${ty}" x2="${VW - 5}" y2="${ty}" stroke="#000" stroke-width="1.1"/>`);
  out.push(`<line x1="${VW - 92}" y1="${ty}" x2="${VW - 92}" y2="${VH - 5}" stroke="#000" stroke-width=".8"/>`);
  let ts = 19;
  const title = P.title.toUpperCase();
  while (richW(title, ts, true) > VW - 112 && ts > 10) ts -= 0.5;
  out.push(rich(12, ty + 22, title, { size: ts, bold: true }));
  out.push(rich(12, ty + 40, `${P.mat.short ?? P.mat.name} · ${fmt(P.stock.x)}×${fmt(P.stock.y)}×${fmt(P.stock.z)}`, { size: 12, fill: '#333' }));
  let ds = 15;
  while (richW(P.drawingNo, ds, true) > 80 && ds > 9) ds -= 0.5;
  out.push(rich(VW - 49, ty + 19, P.drawingNo, { size: ds, bold: true, anchor: 'middle' }));
  out.push(rich(VW - 49, ty + 30, `REV ${P.rev}${P.id ? ` · ${P.id}` : ''}`, { size: 9.5, anchor: 'middle', fill: '#333' }));
  // difficulty stars
  const star = (cx, cy, r, filled) => {
    const pts = [];
    for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r; pts.push(`${n2(cx + rr * Math.cos(a))},${n2(cy + rr * Math.sin(a))}`); }
    return `<polygon points="${pts.join(' ')}" fill="${filled ? '#111' : '#fff'}" stroke="#111" stroke-width="1"/>`;
  };
  for (let i = 0; i < 5; i++) out.push(star(VW - 49 - 30 + i * 15, ty + 40, 6.2, i < P.difficulty));
  // plan view, shaded by depth
  const box = { x: 16, y: 16, w: VW - 32, h: ty - 26 };
  const s = Math.min(box.w / P.L, box.h / P.W);
  const x0 = box.x + (box.w - P.L * s) / 2, yB = box.y + (box.h + P.W * s) / 2;
  const T = (p) => `${n2(x0 + p[0] * s)},${n2(yB - p[1] * s)}`;
  const shade = (d) => { const g = Math.round(245 - 120 * clamp(d / P.H, 0, 1)); return `rgb(${g - 8},${g - 2},${g + 4 > 255 ? 255 : g + 4})`; };
  out.push(`<rect x="${n2(x0)}" y="${n2(yB - P.W * s)}" width="${n2(P.L * s)}" height="${n2(P.W * s)}" fill="#fff"/>`);
  const regions = [];
  for (const f of P.feats) for (const l of f.loops) regions.push(l);
  regions.sort((a, b) => a.depth - b.depth);
  const blk = `M${T([0, 0])}L${T([P.L, 0])}L${T([P.L, P.W])}L${T([0, P.W])}Z`;
  for (const l of regions) {
    const pts = l.pts.map(T);
    if (l.inside) out.push(`<polygon points="${pts.join(' ')}" fill="${shade(l.depth)}"/>`);
    else out.push(`<path d="${blk}M${pts.join('L')}Z" fill="${shade(l.depth)}" fill-rule="evenodd"/>`);
  }
  // edges
  const e = 0.02;
  for (const l of regions) {
    let d = '', pen = false;
    for (const pc of l.pieces) {
      const a = P.depthAt(pc.mx - pc.nx * e, pc.my - pc.ny * e), b = P.depthAt(pc.mx + pc.nx * e, pc.my + pc.ny * e);
      const v = a != null && b != null && Math.abs(a - b) > 1e-6;
      if (v) { d += `${pen ? 'L' : 'M'}${T([pc.ax, pc.ay])}L${T([pc.bx, pc.by])}`; pen = true; } else pen = false;
    }
    if (d) out.push(`<path d="${d}" fill="none" stroke="#000" stroke-width="1.3" stroke-linejoin="round"/>`);
  }
  for (const f of P.feats) {
    if (!f.round) continue;
    const r = (f.cb ? f.cb.r : f.r) * s + 4, cx = x0 + f.cx * s, cy = yB - f.cy * s;
    out.push(`<path d="M${n2(cx - r)} ${n2(cy)}H${n2(cx + r)}M${n2(cx)} ${n2(cy - r)}V${n2(cy + r)}" stroke="#000" stroke-width=".6" stroke-dasharray="6 1.5 1.5 1.5"/>`);
  }
  out.push(`<rect x="${n2(x0)}" y="${n2(yB - P.W * s)}" width="${n2(P.L * s)}" height="${n2(P.W * s)}" fill="none" stroke="#000" stroke-width="2"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${VW * 2}" height="${VH * 2}" viewBox="0 0 ${VW} ${VH}" font-family="${FONT}"><title>${esc(P.drawingNo)}</title>${out.join('')}</svg>`;
}

function loadSVGImage(svg) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('drawing: SVG image failed to load'));
    // data URL (not a blob URL) keeps the canvas origin-clean for WebGL texture uploads
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

// Render the sheet (or with opts.thumb the job-board thumbnail) into a canvas of `px` pixels width.
export async function drawingCanvas(part, px = 2048, opts = {}) {
  const thumb = !!opts.thumb;
  const aspect = thumb ? 212 / 300 : SHEET_H / SHEET_W;
  const w = Math.max(16, Math.round(px)), h = Math.round(w * aspect);
  let svg;
  if (thumb) svg = drawingThumbSVG(part).replace(/width="\d+" height="\d+"/, `width="${w}" height="${h}"`);
  else svg = drawingSVG(part, { ...opts, width: w, height: h });
  const img = await loadSVGImage(svg);
  const canvas = opts.canvas || document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, w, h);
  g.drawImage(img, 0, 0, w, h);
  return canvas;
}
