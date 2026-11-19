// Measuring-instrument math on the machined Z-map. Pure functions: no DOM, no three.js, runs in Node.
//
// Everything public works in the PART frame (origin at the front-left corner of the finished top face,
// X along the length, Y to the back, Z up, Z0 = finished top, bottom = -size.z). The Z-map lives in the
// machine table frame; `partFrame()` maps between the two with the part datum of the shared spec:
//   datum (table frame) = { x: pl.x0, y: pl.y0, z: pl.top - (part.stock.z - part.size.z) }
// `placement` may be the stockPlacement() result ({x0, y0, top, ...}); anything else falls back to the
// Z-map's own footprint (x0, y0, top), which is identical because the Z-map is built from the placement.
//
// Wall finding: a line is scanned through the heightfield and the point where the surface crosses the
// measuring level is located by bisection on the bilinear surface. A Z-map can only say that a vertical
// wall lies somewhere between the last cut node and the first uncut node (one grid cell). Inside that
// bracket the reading takes the drawing's nominal wall when the drawing puts a wall there (the machined
// data cannot tell them apart), otherwise the bracket centre. Deviations larger than one cell are therefore
// always visible, smaller ones are below the simulation's resolution (0.15..0.6 mm depending on accuracy).
//
// Every measure* function returns an object: { ok: true, value, raw, ... } on success or
// { ok: false, value: null, reason } when the measurement is impossible (out of range, not a bore, ...).
// `value` is the instrument reading (rounded to its resolution, with repeatability noise); `raw` is the
// exact geometric value found on the Z-map.

export const INSTRUMENTS = [
  {
    id: 'caliper', key: '1', name: 'Digital caliper', short: 'Caliper', kind: 'digital',
    resolution: 0.01, sigma: 0.005, range: [0, 150],
    modes: ['outside', 'inside', 'depth'],
    desc: '0-150 mm, 0.01 mm. Outside jaws, inside jaws and depth rod.',
  },
  {
    id: 'micrometer', key: '2', name: 'Outside micrometer', short: 'Micrometer', kind: 'analog',
    resolution: 0.001, sigma: 0.0008, range: [0, 125],
    ranges: [[0, 25], [25, 50], [50, 75], [75, 100], [100, 125]],
    desc: '25 mm range frames 0-125 mm, 0.01 mm thimble + 0.001 mm vernier.',
  },
  {
    id: 'boreGauge', key: '3', name: 'Dial bore gauge', short: 'Bore gauge', kind: 'dial',
    resolution: 0.002, sigma: 0.001, range: [18, 160],
    ranges: [[18, 35], [35, 60], [50, 160]],
    desc: 'Two-point bore gauge with centralising bridge, 0.002 mm dial, set to zero on a setting ring.',
  },
  {
    id: 'depthMic', key: '4', name: 'Depth micrometer', short: 'Depth mic', kind: 'analog',
    resolution: 0.01, sigma: 0.004, range: [0, 100],
    ranges: [[0, 25], [25, 50], [50, 75], [75, 100]],
    desc: '0-100 mm with interchangeable 25 mm rods, 0.01 mm.',
  },
  {
    id: 'heightGauge', key: '5', name: 'Digital height gauge', short: 'Height gauge', kind: 'digital',
    resolution: 0.01, sigma: 0.005, range: [0, 300],
    desc: '0-300 mm, 0.01 mm. Height of a face above the surface plate.',
  },
  {
    id: 'dialIndicator', key: '6', name: 'Dial indicator on stand', short: 'Dial test', kind: 'dial',
    resolution: 0.01, sigma: 0.003, range: [0, 10],
    desc: '0.01 mm dial indicator on a magnetic stand. Sweep a face to read its flatness (TIR).',
  },
];
export const INSTRUMENT = Object.fromEntries(INSTRUMENTS.map((i) => [i.id, i]));

// ------------------------------------------------------------------ randomness / rounding
let rand = Math.random;
export function setRandom(fn) {
  rand = typeof fn === 'function' ? fn : Math.random;
}
// Small seeded PRNG for reproducible tests.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rng = rand) {
  let u = 0;
  while (u < 1e-12) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}
export function decimalsFor(res) {
  return Math.max(0, Math.ceil(-Math.log10(res) - 1e-9));
}
export function quantize(v, res) {
  return Number((Math.round(v / res) * res).toFixed(decimalsFor(res)));
}
export function formatValue(v, res) {
  return v == null || !Number.isFinite(v) ? '-' : v.toFixed(decimalsFor(res));
}
// Instrument reading: raw geometric value + repeatability noise (about +-1 digit), rounded to resolution.
export function reading(instrumentId, raw, opts = {}) {
  const ins = INSTRUMENT[instrumentId] || INSTRUMENT.caliper;
  const res = opts.resolution ?? ins.resolution;
  let n = 0;
  if (opts.noise !== false) {
    const s = opts.sigma ?? ins.sigma;
    n = Math.max(-2.2 * s, Math.min(2.2 * s, gauss(opts.rng || rand) * s));
  }
  return quantize(raw + n, res);
}

// ------------------------------------------------------------------ frames
export function partDatumOf(zmap, placement, part) {
  const pl = placement || {};
  const x0 = Number.isFinite(pl.x0) ? pl.x0 : zmap.x0;
  const y0 = Number.isFinite(pl.y0) ? pl.y0 : zmap.y0;
  const top = Number.isFinite(pl.top) ? pl.top : zmap.top;
  const face = part && part.stock && part.size ? part.stock.z - part.size.z : 0;
  return { x: x0, y: y0, z: top - face };
}

// Everything the scanners need: the part-frame surface function H(x, y) (-Infinity off the part),
// the target (drawing) surface T(x, y) and grid metrics.
export function partFrame(zmap, placement, part) {
  const D = partDatumOf(zmap, placement, part);
  const bottom = zmap.bottom - D.z;
  const size = {
    x: part?.size?.x ?? zmap.lx,
    y: part?.size?.y ?? zmap.ly,
    z: part?.size?.z ?? -bottom,
  };
  const H = (x, y) => {
    const v = zmap.heightAt(x + D.x, y + D.y);
    return v == null ? -Infinity : v - D.z;
  };
  const T = part && part.features ? (x, y) => {
    const d = targetDepth(part, x, y);
    return d == null ? -Infinity : -d;
  } : null;
  return { zmap, part, D, bottom, size, H, T, dx: zmap.dx, dy: zmap.dy, cell: Math.max(zmap.dx, zmap.dy) };
}

// part frame <-> table frame
export function partToTable(zmap, placement, part, p) {
  const D = partDatumOf(zmap, placement, part);
  return { x: p.x + D.x, y: p.y + D.y, z: (p.z ?? 0) + D.z };
}
export function tableToPart(zmap, placement, part, p) {
  const D = partDatumOf(zmap, placement, part);
  return { x: p.x - D.x, y: p.y - D.y, z: p.z - D.z };
}

// ------------------------------------------------------------------ drawing model (nominal geometry)
function inRoundRect(lx, ly, w, h, r) {
  const ax = Math.abs(lx), ay = Math.abs(ly);
  if (ax > w / 2 || ay > h / 2) return false;
  const rr = Math.max(0, Math.min(r || 0, w / 2, h / 2));
  const qx = ax - (w / 2 - rr), qy = ay - (h / 2 - rr);
  if (qx > 0 && qy > 0) return qx * qx + qy * qy <= rr * rr;
  return true;
}
function segDist(px, py, x1, y1, x2, y2) {
  const vx = x2 - x1, vy = y2 - y1;
  const L2 = vx * vx + vy * vy;
  let t = L2 > 0 ? ((px - x1) * vx + (py - y1) * vy) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - x1 - t * vx, py - y1 - t * vy);
}
// Depth below Z0 that feature f prescribes at (x, y), or 0 when it does not cover the point.
export function featureDepthAt(part, f, x, y) {
  switch (f.type) {
    case 'pocketRect': {
      const a = (-(f.rot || 0) * Math.PI) / 180;
      const ux = x - f.x, uy = y - f.y;
      const lx = ux * Math.cos(a) - uy * Math.sin(a), ly = ux * Math.sin(a) + uy * Math.cos(a);
      return inRoundRect(lx, ly, f.w, f.h, f.r) ? f.depth : 0;
    }
    case 'pocketCirc':
      return Math.hypot(x - f.x, y - f.y) <= f.d / 2 ? f.depth : 0;
    case 'hole': {
      const r = Math.hypot(x - f.x, y - f.y);
      if (r <= f.d / 2) return f.depth;
      if (f.cbore && r <= f.cbore.d / 2) return f.cbore.depth;
      return 0;
    }
    case 'slot':
      return segDist(x, y, f.x1, f.y1, f.x2, f.y2) <= f.w / 2 ? f.depth : 0;
    case 'step': {
      const S = part.size;
      const hit = f.side === 'front' ? y <= f.width : f.side === 'back' ? y >= S.y - f.width : f.side === 'left' ? x <= f.width : x >= S.x - f.width;
      return hit ? f.depth : 0;
    }
    case 'boss': {
      const inside = f.shape === 'circle' ? Math.hypot(x - f.x, y - f.y) <= f.d / 2 : inRoundRect(x - f.x, y - f.y, f.w, f.h, f.r);
      return inside ? 0 : f.depth;
    }
    default:
      return 0;
  }
}
// Deepest feature wins. null outside the part outline.
export function targetDepth(part, x, y) {
  const S = part.size;
  if (x < 0 || y < 0 || x > S.x || y > S.y) return null;
  let d = 0;
  for (const f of part.features || []) {
    const fd = featureDepthAt(part, f, x, y);
    if (fd > d) d = fd;
  }
  return d;
}
const TYPE_NAMES = { pocketRect: 'Pocket', pocketCirc: 'Circular pocket', hole: 'Hole', slot: 'Slot', step: 'Step', boss: 'Boss' };
export function featureLabel(part, f) {
  const i = (part.features || []).indexOf(f);
  return `${TYPE_NAMES[f.type] || f.type} ${f.id || i + 1}`;
}
// Feature that defines the surface at (x, y) (deepest covering feature), or null on the top face.
export function featureAt(part, x, y) {
  if (!part || !part.features) return null;
  let best = null, d = 0;
  for (const f of part.features) {
    const fd = featureDepthAt(part, f, x, y);
    if (fd > d + 1e-9) {
      d = fd;
      best = f;
    }
  }
  if (!best) return null;
  return { feature: best, id: best.id || String(part.features.indexOf(best) + 1), label: featureLabel(part, best), depth: d };
}

// ------------------------------------------------------------------ scanning primitives
function bisect(pred, a, b, want, it = 34) {
  // pred(a) !== want, pred(b) === want
  for (let k = 0; k < it; k++) {
    const m = (a + b) / 2;
    if (pred(m) === want) b = m;
    else a = m;
  }
  return (a + b) / 2;
}
// First t (marching from t0 to t1) where pred(t) === want, refined by bisection. null if never.
function march(pred, t0, t1, want, step) {
  if (pred(t0) === want) return { t: t0, start: true };
  const L = Math.abs(t1 - t0), s = t1 >= t0 ? 1 : -1;
  const n = Math.max(1, Math.ceil(L / step));
  let prev = t0;
  for (let k = 1; k <= n; k++) {
    const t = t0 + s * Math.min(L, k * step);
    if (pred(t) === want) return { t: bisect(pred, prev, t, want), start: false };
    prev = t;
  }
  return null;
}

// Locate the wall crossed when going along o + t*u (direction of increasing t when sgn = 1, else
// decreasing) from air into material at level z. te is the bilinear crossing found by march().
function refineWall(F, ox, oy, ux, uy, te, z, sgn) {
  const w0 = F.cell;
  const P = (t) => [ox + ux * t, oy + uy * t];
  const Ht = (t) => F.H(...P(t));
  const tA = te - sgn * w0 * 1.05, tM = te + sgn * w0 * 1.05;
  const hA = Ht(tA), hM = Ht(tM);
  let t = te, kind = 'slope', half = 0;
  if (!Number.isFinite(hA)) {
    kind = 'edge'; // outer face of the blank: exact
  } else if (hM - hA > 2.5 * w0 && hA < z && hM > z) {
    kind = 'vertical';
    const zm = (hA + hM) / 2;
    t = bisect((tt) => Ht(tt) > zm, tA, tM, true);
    // wall normal from the surface gradient -> width of the "between two nodes" bracket along the ray
    const [px, py] = P(t);
    const e = w0 * 0.75;
    let gx = F.H(px + e, py) - F.H(px - e, py), gy = F.H(px, py + e) - F.H(px, py - e);
    if (!Number.isFinite(gx)) gx = 0;
    if (!Number.isFinite(gy)) gy = 0;
    const gl = Math.hypot(gx, gy) || 1;
    const nx = gx / gl, ny = gy / gl;
    const wn = Math.max(Math.abs(nx) * F.dx, Math.abs(ny) * F.dy, 0.5 * w0);
    const cosang = Math.max(0.35, Math.abs(nx * ux + ny * uy));
    half = (0.5 * wn) / cosang;
  }
  if (F.T && kind !== 'edge') {
    // nominal wall from the drawing near the found wall
    const R = Math.max(half * 3, w0 * 2.5);
    const predT = (tt) => F.T(...P(tt)) > z;
    const a0 = t - sgn * R, a1 = t + sgn * R;
    const hit = march(predT, a0, a1, true, w0 / 12);
    if (hit && !hit.start) {
      const tn = hit.t;
      if (kind === 'vertical') {
        if (Math.abs(tn - t) <= half * 1.0001) t = tn;
        else if (Math.abs(tn - t) <= half * 2.2) t = Math.max(t - half, Math.min(t + half, tn));
      } else if (Math.abs(tn - t) <= w0 * 0.6) {
        t = tn;
      }
    }
  } else if (kind === 'edge' && F.T) {
    // outer edge: the blank face is exact
  }
  return { t, kind, half };
}

// Air -> material wall along the ray from t0 to t1 at level z. null if the ray stays in air.
function wallAlong(F, ox, oy, ux, uy, t0, t1, z) {
  const pred = (t) => F.H(ox + ux * t, oy + uy * t) > z;
  const step = Math.min(F.dx, F.dy) / 3;
  const m = march(pred, t0, t1, true, step);
  if (!m) return null;
  if (m.start) return { t: t0, kind: 'start', blocked: true };
  return refineWall(F, ox, oy, ux, uy, m.t, z, t1 >= t0 ? 1 : -1);
}

function snapDir(dx, dy, snapDeg = 10) {
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return [1, 0];
  let ux = dx / L, uy = dy / L;
  const lim = Math.cos((snapDeg * Math.PI) / 180);
  if (Math.abs(ux) >= lim) return [Math.sign(ux), 0];
  if (Math.abs(uy) >= lim) return [0, Math.sign(uy)];
  return [ux, uy];
}
function axisName(ux, uy) {
  if (Math.abs(uy) < 1e-6) return 'X';
  if (Math.abs(ux) < 1e-6) return 'Y';
  return `${((Math.atan2(uy, ux) * 180) / Math.PI).toFixed(0)}°`;
}
const fail = (reason, extra = {}) => ({ ok: false, value: null, reason, ...extra });
function rangeCheck(id, v, range, what = 'Reading') {
  if (!range) return null;
  const [a, b] = range;
  const e = 0.02; // the ends of a range are usable
  if (v < a - e || v > b + e) {
    const ins = INSTRUMENT[id];
    let hint = '';
    if (ins?.ranges) {
      const r = ins.ranges.find(([lo, hi]) => v >= lo - e && v <= hi + e);
      hint = r ? ` Use the ${r[0]}-${r[1]} mm ${id === 'boreGauge' ? 'head' : id === 'depthMic' ? 'rod' : 'frame'}.` : ` No ${ins.short.toLowerCase()} covers ${v.toFixed(1)} mm.`;
    }
    return `${what} ≈ ${v.toFixed(2)} mm is outside the ${a}-${b} mm range.${hint}`;
  }
  return null;
}

// ------------------------------------------------------------------ measurements
// Outside size between two outer walls (caliper outside jaws / micrometer anvils).
// p1, p2: points on (or near) the two opposite faces, part frame {x, y}. zLevel: measuring height
// (part Z, negative below the top). opts: { instrument, range, jawHalf (contact half-width, mm),
// reach (how far below the highest material between the walls the jaws can reach), noise, rng, snap }.
export function measureOutside(zmap, placement, part, p1, p2, zLevel, opts = {}) {
  const F = opts.frame || partFrame(zmap, placement, part);
  const id = opts.instrument || 'caliper';
  const [ux, uy] = opts.snap === false ? snapDir(p2.x - p1.x, p2.y - p1.y, 0) : snapDir(p2.x - p1.x, p2.y - p1.y, opts.snapDeg ?? 10);
  const vx = -uy, vy = ux;
  let z = zLevel ?? -0.5;
  if (z <= F.bottom + 0.05) z = F.bottom + 0.2;
  const cx = (p1.x + p2.x) / 2, cy = (p1.y + p2.y) / 2;
  const L = Math.hypot(F.size.x, F.size.y) + 20;
  const jh = opts.jawHalf ?? 3;
  const offs = jh > 0 ? [-jh, -jh / 2, 0, jh / 2, jh] : [0];
  let tMin = Infinity, tMax = -Infinity, best = null, maxH = -Infinity;
  for (const o of offs) {
    const ox = cx + vx * o, oy = cy + vy * o;
    const a = wallAlong(F, ox, oy, ux, uy, -L, L, z);
    if (!a) continue;
    const b = wallAlong(F, ox, oy, ux, uy, L, -L, z);
    if (!b) continue;
    for (let t = a.t; t <= b.t; t += Math.max(0.5, F.cell)) maxH = Math.max(maxH, F.H(ox + ux * t, oy + uy * t));
    if (a.t < tMin) { tMin = a.t; best = best || {}; best.a = [ox + ux * a.t, oy + uy * a.t]; }
    if (b.t > tMax) { tMax = b.t; best = best || {}; best.b = [ox + ux * b.t, oy + uy * b.t]; }
  }
  if (!best || !best.a || !best.b) return fail(z >= 0 ? 'The jaws are above the part: measure lower on the faces.' : 'No material between the jaws at this height.');
  const raw = tMax - tMin;
  const reach = opts.reach ?? (id === 'micrometer' ? 60 : 38);
  if (maxH - z > reach) return fail(`The jaws can't reach ${(maxH - z).toFixed(1)} mm below the top of the material (max ${reach} mm).`);
  const range = opts.range || INSTRUMENT[id]?.range;
  const err = rangeCheck(id, raw, range);
  if (err) return fail(err, { raw });
  const value = reading(id, raw, opts);
  return {
    ok: true, value, raw, unit: 'mm', instrument: id, axis: axisName(ux, uy), dir: [ux, uy], zLevel: z,
    wall1: { x: best.a[0], y: best.a[1], z }, wall2: { x: best.b[0], y: best.b[1], z }, maxH,
  };
}

// Highest material z of a small disc (contact of a rod, scriber or base).
function discMax(F, x, y, r) {
  let m = F.H(x, y);
  if (r <= 0) return m;
  const n = 12;
  for (const rr of [r * 0.5, r]) for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const v = F.H(x + rr * Math.cos(a), y + rr * Math.sin(a));
    if (v > m) m = v;
  }
  return m;
}

// Cavity analysis around p: floor height and rim (lowest of the wall tops around).
function cavityAt(F, p) {
  const floor = F.H(p.x, p.y);
  if (!Number.isFinite(floor)) return { error: 'That point is not on the part.' };
  if (floor > -0.05) return { error: 'Not inside a pocket or bore: click on the floor of the feature.' };
  const zf = Math.max(floor, F.bottom) + 0.25;
  const L = Math.hypot(F.size.x, F.size.y) + 10;
  let rim = Infinity, open = 0, minD = Infinity, minDir = null;
  const N = 36;
  for (let k = 0; k < N; k++) {
    const a = (k / N) * Math.PI * 2;
    const ux = Math.cos(a), uy = Math.sin(a);
    const w = wallAlong(F, p.x, p.y, ux, uy, 0, L, zf);
    if (!w || w.blocked) { open++; continue; }
    let top = -Infinity;
    for (let t = w.t + 0.3; t <= w.t + 4.5; t += 0.3) top = Math.max(top, F.H(p.x + ux * t, p.y + uy * t));
    if (top < rim) rim = top;
    if (w.t < minD) { minD = w.t; minDir = [ux, uy]; }
  }
  return { floor, zf, rim, open, N, minD, minDir };
}

// Width between two inner walls through p (caliper inside jaws). dir: [ux, uy] or null = across the
// nearest wall (snapped to X/Y). The chord is maximised over parallel offsets like rocking the jaws.
export function measureInside(zmap, placement, part, p, dir, zLevel, opts = {}) {
  const F = opts.frame || partFrame(zmap, placement, part);
  const id = opts.instrument || 'caliper';
  const cav = cavityAt(F, p);
  if (cav.error) return fail(cav.error);
  if (cav.open > cav.N / 3) return fail('This feature is open to the side: there is no opposite wall for the inside jaws.');
  const jawLen = opts.reach ?? 14;
  let z = zLevel;
  if (z == null) z = (Math.max(cav.floor, F.bottom) + cav.rim) / 2;
  z = Math.max(z, cav.rim - jawLen, Math.max(cav.floor, F.bottom) + 0.2);
  if (z >= cav.rim) return fail('Measuring level is above the walls.');
  let ux, uy;
  if (dir) [ux, uy] = snapDir(dir[0], dir[1], opts.snapDeg ?? 10);
  else [ux, uy] = snapDir(cav.minDir[0], cav.minDir[1], 12);
  const vx = -uy, vy = ux;
  const L = Math.hypot(F.size.x, F.size.y) + 10;
  const chord = (o) => {
    const ox = p.x + vx * o, oy = p.y + vy * o;
    if (F.H(ox, oy) > z) return null;
    const a = wallAlong(F, ox, oy, ux, uy, 0, -L, z);
    const b = wallAlong(F, ox, oy, ux, uy, 0, L, z);
    if (!a || !b || a.blocked || b.blocked) return null;
    return { w: b.t - a.t, a: [ox + ux * a.t, oy + uy * a.t], b: [ox + ux * b.t, oy + uy * b.t], o };
  };
  const c0 = chord(0);
  if (!c0) return fail('No opposite wall in that direction.');
  // rock the jaws: search the max chord over contiguous parallel offsets
  let best = c0;
  const step = Math.max(F.cell, c0.w / 60);
  for (const s of [-1, 1]) {
    for (let o = step; o < c0.w * 0.75 + 2; o += step) {
      const c = chord(s * o);
      if (!c) break;
      if (c.w > best.w) best = c;
    }
  }
  for (let k = 0; k < 2; k++) {
    const st = step / (k === 0 ? 4 : 16);
    for (let o = best.o - 4 * st; o <= best.o + 4 * st; o += st) {
      const c = chord(o);
      if (c && c.w > best.w) best = c;
    }
  }
  const raw = best.w;
  const minW = opts.minWidth ?? 2;
  if (raw < minW) return fail(`Too narrow (${raw.toFixed(2)} mm) for the inside jaws.`);
  const err = rangeCheck(id, raw, opts.range || INSTRUMENT[id]?.range);
  if (err) return fail(err, { raw });
  const value = reading(id, raw, opts);
  return {
    ok: true, value, raw, unit: 'mm', instrument: id, axis: axisName(ux, uy), dir: [ux, uy], zLevel: z,
    wall1: { x: best.a[0], y: best.a[1], z }, wall2: { x: best.b[0], y: best.b[1], z },
    floor: cav.floor, rim: cav.rim,
  };
}

function fitCircle(pts) {
  // Kasa algebraic fit: x^2 + y^2 + D x + E y + F = 0
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  const n = pts.length;
  for (const [x, y] of pts) {
    const zz = x * x + y * y;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * zz; syz += y * zz; sz += zz;
  }
  // [sxx sxy sx][D]   [-sxz]
  // [sxy syy sy][E] = [-syz]
  // [sx  sy  n ][F]   [-sz ]
  const A = [[sxx, sxy, sx, -sxz], [sxy, syy, sy, -syz], [sx, sy, n, -sz]];
  for (let i = 0; i < 3; i++) {
    let piv = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
    [A[i], A[piv]] = [A[piv], A[i]];
    for (let r = 0; r < 3; r++) {
      if (r === i) continue;
      const f = A[r][i] / A[i][i];
      for (let c = i; c < 4; c++) A[r][c] -= f * A[i][c];
    }
  }
  const D = A[0][3] / A[0][0], E = A[1][3] / A[1][1], Fv = A[2][3] / A[2][2];
  const cx = -D / 2, cy = -E / 2;
  return { cx, cy, r: Math.sqrt(Math.max(0, cx * cx + cy * cy - Fv)) };
}

// Bore: circle fitted to wall points of many rays at zLevel from c (iterated from the fitted centre).
// Returns { d (gauge reading), raw, roundness (radial peak-to-valley), centre, minTwoPoint, maxTwoPoint }.
export function measureBore(zmap, placement, part, c, zLevel, opts = {}) {
  const F = opts.frame || partFrame(zmap, placement, part);
  const id = opts.instrument || 'boreGauge';
  const cav = cavityAt(F, c);
  if (cav.error) return fail(cav.error.replace('pocket or bore', 'bore'));
  if (cav.open > 0) return fail('Not an enclosed bore here: the bore gauge needs a closed round hole.');
  let z = zLevel;
  if (z == null) z = (Math.max(cav.floor, F.bottom) + cav.rim) / 2;
  z = Math.min(z, cav.rim - 0.3);
  z = Math.max(z, Math.max(cav.floor, F.bottom) + 0.3);
  if (cav.rim - Math.max(cav.floor, F.bottom) < 1.2) return fail('Too shallow for the bore gauge head (needs > 1.2 mm of wall).');
  const N = opts.rays ?? 72;
  const L = Math.hypot(F.size.x, F.size.y) + 10;
  let cx = c.x, cy = c.y, fit = null, rs = null, pts = null;
  for (let it = 0; it < 3; it++) {
    if (F.H(cx, cy) > z) return fail('Not a round bore here.');
    pts = [];
    rs = [];
    for (let k = 0; k < N; k++) {
      const a = (k / N) * Math.PI * 2;
      const ux = Math.cos(a), uy = Math.sin(a);
      const w = wallAlong(F, cx, cy, ux, uy, 0, L, z);
      if (!w || w.blocked) return fail('Not an enclosed bore at this depth.');
      pts.push([cx + ux * w.t, cy + uy * w.t]);
      rs.push(w.t);
    }
    fit = fitCircle(pts);
    const moved = Math.hypot(fit.cx - cx, fit.cy - cy);
    cx = fit.cx;
    cy = fit.cy;
    if (moved < 1e-4) break;
  }
  // radial deviations about the fitted centre
  let rmin = Infinity, rmax = -Infinity, rsum = 0;
  for (const [x, y] of pts) {
    const r = Math.hypot(x - cx, y - cy);
    rmin = Math.min(rmin, r); rmax = Math.max(rmax, r); rsum += r;
  }
  const rmean = rsum / pts.length;
  const roundness = rmax - rmin;
  // two-point diameters (what a bore gauge actually reads when rocked: the minimum over the sweep)
  let d2min = Infinity, d2max = -Infinity;
  for (let k = 0; k < N / 2; k++) {
    const d2 = rs[k] + rs[k + N / 2];
    d2min = Math.min(d2min, d2); d2max = Math.max(d2max, d2);
  }
  const d = 2 * rmean;
  if (roundness > Math.max(0.35, 0.06 * d)) {
    return fail(`Not a round bore (form deviation ${roundness.toFixed(2)} mm). Use the caliper inside jaws for pockets and slots.`, { raw: d, roundness });
  }
  const range = opts.range || INSTRUMENT[id]?.range;
  const err = rangeCheck(id, d, range, 'Bore Ø');
  if (err) return fail(err, { raw: d });
  const value = reading(id, d, opts);
  return {
    ok: true, value, d: value, raw: d, unit: 'mm', instrument: id, roundness, centre: { x: cx, y: cy, z },
    zLevel: z, minTwoPoint: d2min, maxTwoPoint: d2max, floor: cav.floor, rim: cav.rim,
  };
}

// Depth of p below the face at refP (depth micrometer base / caliper depth rod).
// opts: { instrument: 'depthMic'|'caliper', rodR (contact radius), baseR }
export function measureDepth(zmap, placement, part, refP, p, opts = {}) {
  const F = opts.frame || partFrame(zmap, placement, part);
  const id = opts.instrument || 'depthMic';
  const href = discMax(F, refP.x, refP.y, opts.baseR ?? 2);
  if (!Number.isFinite(href) || !Number.isFinite(F.H(refP.x, refP.y))) return fail('The reference point is not on the part.');
  const hp0 = F.H(p.x, p.y);
  if (!Number.isFinite(hp0)) return fail('The measuring point is not on the part.');
  if (hp0 <= F.bottom + 1e-3) return fail('That is a through hole: no floor for the rod to touch.');
  const hp = discMax(F, p.x, p.y, opts.rodR ?? (id === 'caliper' ? 0.8 : 2));
  const raw = href - hp;
  if (raw < 0.005) return fail('The second point must be lower than the reference face (click the top face first, then the floor).');
  let range = opts.range || INSTRUMENT[id]?.range;
  let rod = null;
  if (id === 'depthMic') {
    rod = INSTRUMENT.depthMic.ranges.find(([a, b]) => raw >= a && raw <= b) || null;
    if (!rod) return fail(rangeCheck(id, raw, INSTRUMENT.depthMic.range) || 'Out of range.');
  }
  const err = rangeCheck(id, raw, range, 'Depth');
  if (err) return fail(err, { raw });
  const value = reading(id, raw, opts);
  return { ok: true, value, raw, unit: 'mm', instrument: id, ref: { x: refP.x, y: refP.y, z: href }, at: { x: p.x, y: p.y, z: hp }, rod };
}

// Height of the surface at p above the surface plate (= part bottom).
export function measureHeight(zmap, placement, part, p, opts = {}) {
  const F = opts.frame || partFrame(zmap, placement, part);
  const id = opts.instrument || 'heightGauge';
  const h0 = F.H(p.x, p.y);
  if (!Number.isFinite(h0)) return fail('That point is not on the part.');
  if (h0 <= F.bottom + 1e-3) return fail('That is a through hole: nothing for the scriber to touch.');
  const h = discMax(F, p.x, p.y, opts.tipR ?? 0.6);
  const raw = h - F.bottom;
  const err = rangeCheck(id, raw, opts.range || INSTRUMENT[id]?.range, 'Height');
  if (err) return fail(err, { raw });
  const value = reading(id, raw, opts);
  return { ok: true, value, raw, unit: 'mm', instrument: id, at: { x: p.x, y: p.y, z: h } };
}

// Flatness (TIR) of the face containing p: sweep a dial indicator along X and Y through p while the
// surface stays on the same face (within 0.3 mm of the start height, away from the edges).
export function measureFlatness(zmap, placement, part, p, opts = {}) {
  const F = opts.frame || partFrame(zmap, placement, part);
  const id = opts.instrument || 'dialIndicator';
  const h0 = F.H(p.x, p.y);
  if (!Number.isFinite(h0)) return fail('That point is not on the part.');
  if (h0 <= F.bottom + 1e-3) return fail('Nothing to sweep inside a through hole.');
  const span = opts.span ?? 40;
  const step = Math.max(0.25, F.cell * 0.75);
  const tol = opts.faceTol ?? 0.3;
  const margin = F.cell * 2.5;
  const path = [];
  let lo = Infinity, hi = -Infinity;
  for (const [ux, uy] of [[1, 0], [0, 1]]) {
    const seg = [];
    for (const s of [-1, 1]) {
      const run = [];
      for (let t = 0; t <= span; t += step) {
        const x = p.x + s * ux * t, y = p.y + s * uy * t;
        const v = F.H(x, y);
        if (!Number.isFinite(v) || Math.abs(v - h0) > tol) break;
        run.push([x, y, v]);
      }
      // stay clear of the wall at the end of the run
      const keep = Math.max(1, run.length - Math.ceil(margin / step));
      const r = run.slice(0, keep);
      if (s < 0) seg.unshift(...r.reverse().slice(0, -1));
      else seg.push(...r);
    }
    for (const q of seg) { lo = Math.min(lo, q[2]); hi = Math.max(hi, q[2]); }
    path.push(seg);
  }
  const n = path[0].length + path[1].length;
  if (n < 6) return fail('That face is too small to sweep.');
  const raw = hi - lo;
  const value = Math.abs(reading(id, raw, opts));
  return { ok: true, value, raw, unit: 'mm', instrument: id, at: { x: p.x, y: p.y, z: h0 }, min: lo, max: hi, path, h0 };
}

// Convenience: is the part-frame point (x, y, z) on the top of the surface (true) or on a wall (false)?
export function onSurface(zmap, placement, part, p, tol = 0.3) {
  const F = partFrame(zmap, placement, part);
  const h = F.H(p.x, p.y);
  return Number.isFinite(h) && Math.abs(h - p.z) <= tol;
}
