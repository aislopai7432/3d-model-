// Turned-workpiece representation for the lathe simulator (pure JS, no DOM, no THREE).
//
// The workpiece is axisymmetric, so it is stored as two radius arrays sampled along Z every `dz`
// (default 0.02 mm): rOut[i] (outer surface) and rIn[i] (bore). Material exists at sample i while
// rOut[i] - rIn[i] > EMPTY. Z runs from zMin (deep inside the chuck) to zMax (free end); Z = 0 is the
// chuck jaw face. Cutting tools are 2D shapes in the (Z, radius) plane: shape.low(dz) is the lowest
// radius the tool occupies at an offset dz from its tip; removal clamps rOut under that curve.
//
// For threads the profile is an "effective" profile at the spindle reference angle: the thread tool
// cuts one groove per revolution (see LatheSim), so grooves appear every `pitch`. `threads` records the
// zones; the mesh builder shears the profile helically inside them (z' = z - hand * pitch * phi / 2pi).

export const EMPTY = 0.01; // mm: radial wall thinner than this counts as "no material"
export const DEFAULT_DZ = 0.02;

const D2R = Math.PI / 180;

// ---------------------------------------------------------------- tool shapes (XZ polygons)
function noseShape(rn, mTrail, extR, extra) {
  const sq = Math.sqrt(1 + mTrail * mTrail);
  const xt = (rn * mTrail) / sq, c = rn * (1 - sq);
  return {
    zl: -rn, zr: extR, rn,
    low(dz) {
      if (dz < -rn) return Infinity;
      if (dz <= xt) return rn - Math.sqrt(Math.max(0, rn * rn - dz * dz));
      if (dz <= extR) return mTrail * dz + c;
      return Infinity;
    },
    ...extra,
  };
}

// Tool tip reference = lowest point of the cutting edge. `overhang` = distance from the tip back to the
// tool-post face (for crash checks); fcMax = force the tool survives (N).
export const TOOL_SHAPES = {
  // 80 degree diamond insert, nose radius 0.4, 95 deg approach: vertical front edge, 15 deg trailing edge
  turn: noseShape(0.4, Math.tan(15 * D2R), 12, { type: 'turn', label: 'Turning tool 95° (R0.4)', overhang: 18, fcMax: 3200 }),
  // facing tool: vertical front edge, tiny nose radius, 5 deg trailing relief
  face: noseShape(0.2, Math.tan(5 * D2R), 12, { type: 'face', label: 'Facing tool 90° (R0.2)', overhang: 18, fcMax: 2600 }),
  // 90 degree V chamfer tool: plunge radially at the end face for a 45 deg chamfer
  chamfer: {
    type: 'chamfer', label: 'Chamfer tool 45°', zl: -6, zr: 6, rn: 0.1, overhang: 18, fcMax: 2200,
    low(dz) { const a = Math.abs(dz); return a > 6 ? Infinity : a; },
  },
  // 3 mm parting blade: reference = chuck-side (left) corner, blade occupies dz 0..3
  part: {
    type: 'part', label: 'Parting blade 3 mm', zl: 0, zr: 3, rn: 0.1, overhang: 24, fcMax: 900, width: 3,
    low(dz) {
      if (dz < 0 || dz > 3) return Infinity;
      const e = Math.min(dz, 3 - dz);
      return e >= 0.1 ? 0 : 0.1 - Math.sqrt(Math.max(0, 0.01 - (0.1 - e) * (0.1 - e)));
    },
  },
  // 60 degree thread tool, flat tip 0.08
  thread: {
    type: 'thread', label: 'Thread tool 60°', zl: -4, zr: 4, rn: 0.04, overhang: 18, fcMax: 1400,
    low(dz) { const a = Math.abs(dz) - 0.04; return Math.abs(dz) > 4 ? Infinity : a <= 0 ? 0 : a * 1.7320508; },
  },
};
export function toolShape(type) { return TOOL_SHAPES[type] || TOOL_SHAPES.turn; }

// Drill / centre drill radius as a function of distance s behind the tip.
export function drillShape(d, type = 'drill') {
  const R = d / 2;
  if (type === 'centre') {
    // combined drill and countersink: 0.2 tip chamfer, pilot ~ d/3.9, 60 deg countersink
    const pr = Math.max(0.4, R * 0.26), pl = R * 0.95, t30 = Math.tan(30 * D2R);
    return {
      R, fullLen: pl + (R - pr) / t30 + 0.5,
      rAt(s) {
        if (s <= 0) return 0;
        if (s < pl) return Math.min(pr, s * 3); // pointed pilot
        return Math.min(R, pr + (s - pl) * t30);
      },
    };
  }
  const k = Math.tan(59 * D2R); // 118 degree point
  return { R, fullLen: R / k + 0.02, rAt(s) { return s <= 0 ? 0 : Math.min(R, s * k); } };
}

// ---------------------------------------------------------------- profile
export class TurnProfile {
  constructor({ zMin, zMax, radius, dz = DEFAULT_DZ, chunkMm = 10, bore = 0 }) {
    this.dz = dz;
    this.zMin = zMin;
    this.zMax = zMax;
    const n = this.n = Math.round((zMax - zMin) / dz) + 1;
    this.rOut = new Float64Array(n).fill(radius);
    this.rIn = new Float64Array(n).fill(bore);
    this.mach = new Uint8Array(n); // outer surface machined?
    this.machIn = new Uint8Array(n);
    this.fe = new Float32Array(n); // feed per rev (mm) of the last cut on the outer surface
    this.thr = new Float32Array(n); // thread pitch where the thread tool cut
    this.chunk = Math.max(8, Math.round(chunkMm / dz));
    this.nChunks = Math.ceil(n / this.chunk);
    this.chunkVer = new Uint32Array(this.nChunks).fill(1);
    this.chunkMax = new Float64Array(this.nChunks).fill(radius);
    this.threads = []; // {z0,z1,pitch,hand}
    this.rBound = radius; // upper bound of rOut (fast reject)
    this.hi = n - 1;
    this.version = 1;
    this.radius0 = radius;
    this.acc = { area: 0, vol: 0, depth: 0, emptied: false, i0: n, i1: -1 };
  }

  z(i) { return this.zMin + i * this.dz; }
  idx(z) { return (z - this.zMin) / this.dz; }
  has(i) { return i >= 0 && i < this.n && this.rOut[i] - this.rIn[i] > EMPTY; }

  lastMat() { while (this.hi >= 0 && !this.has(this.hi)) this.hi--; return this.hi; }
  firstMatFrom(i) { while (i < this.n && !this.has(i)) i++; return i < this.n ? i : -1; }

  /** Z of the free end face (sample boundary), or null when no material is left. */
  endZ() { const h = this.lastMat(); return h < 0 ? null : this.z(h) + this.dz / 2; }

  resetAcc() { const a = this.acc; a.area = 0; a.vol = 0; a.depth = 0; a.emptied = false; a.i0 = this.n; a.i1 = -1; return a; }

  // Apply (or just probe, apply=false) a turning tool with its tip at (tz, tr). Returns max radial depth.
  cutAt(tz, tr, shape, apply = true, feed = 0, thr = 0) {
    if (tr >= this.rBound) return 0;
    const { dz, zMin, rOut, rIn } = this;
    let iA = Math.ceil((tz + shape.zl - zMin) / dz - 1e-9), iB = Math.floor((tz + shape.zr - zMin) / dz + 1e-9);
    if (iA < 0) iA = 0;
    if (iB > this.n - 1) iB = this.n - 1;
    const acc = this.acc;
    let maxD = 0;
    for (let i = iA; i <= iB; i++) {
      const ro = rOut[i];
      const lo = tr + shape.low(zMin + i * dz - tz);
      if (lo >= ro) continue;
      const ri = rIn[i];
      if (ro - ri <= EMPTY) continue;
      const nl = lo > ri ? lo : ri;
      const d = ro - nl;
      if (d > maxD) maxD = d;
      if (!apply) continue;
      acc.area += d * dz;
      acc.vol += Math.PI * (ro * ro - nl * nl) * dz;
      if (nl - ri <= EMPTY) { rOut[i] = ri; acc.emptied = true; } else rOut[i] = nl;
      this.mach[i] = 1;
      if (feed > 0) this.fe[i] = feed;
      if (thr > 0) this.thr[i] = thr;
      if (i < acc.i0) acc.i0 = i;
      if (i > acc.i1) acc.i1 = i;
    }
    if (apply && maxD > acc.depth) acc.depth = maxD;
    return maxD;
  }

  // Drill/bore: tip at zTip moving towards -Z from zOld. Hole exists from zTip up to the end face.
  boreTo(zTip, zOld, shape, apply = true) {
    const { dz, zMin, rOut, rIn } = this;
    const top = this.lastMat();
    if (top < 0) return 0;
    let iA = Math.ceil((zTip - zMin) / dz - 1e-9);
    let iB = Math.floor((Math.max(zOld, zTip) + shape.fullLen - zMin) / dz);
    if (iA < 0) iA = 0;
    if (iB > top) iB = top;
    const acc = this.acc;
    let maxR = 0;
    for (let i = iA; i <= iB; i++) {
      if (rOut[i] - rIn[i] <= EMPTY) continue;
      const r = shape.rAt(zMin + i * dz - zTip);
      if (r <= rIn[i]) continue;
      if (r > maxR) maxR = r;
      if (!apply) continue;
      const ri = rIn[i];
      acc.vol += Math.PI * (Math.min(r, rOut[i]) ** 2 - ri * ri) * dz;
      if (r >= rOut[i] - EMPTY) { rIn[i] = rOut[i]; acc.emptied = true; } else rIn[i] = r;
      this.machIn[i] = 1;
      if (i < acc.i0) acc.i0 = i;
      if (i > acc.i1) acc.i1 = i;
    }
    return maxR;
  }

  // Record that samples i0..i1 changed (dirty chunks + local radius bound).
  endEdit() {
    const a = this.acc;
    if (a.i1 < a.i0) return;
    const c0 = Math.floor(a.i0 / this.chunk), c1 = Math.floor(a.i1 / this.chunk);
    for (let c = c0; c <= c1; c++) {
      this.chunkVer[c]++;
      const s = c * this.chunk, e = Math.min(this.n - 1, s + this.chunk);
      let m = 0;
      for (let i = s; i <= e; i++) if (this.rOut[i] > m) m = this.rOut[i];
      this.chunkMax[c] = m;
    }
    let b = 0;
    for (let c = 0; c < this.nChunks; c++) if (this.chunkMax[c] > b) b = this.chunkMax[c];
    this.rBound = b + 1e-9;
    this.version++;
  }

  markThread(zc, pitch, hand) {
    const lo = zc - pitch * 1.2, hi = zc + pitch * 1.2;
    for (const t of this.threads) {
      if (Math.abs(t.pitch - pitch) < 1e-6 && t.hand === hand && lo <= t.z1 + pitch && hi >= t.z0 - pitch) {
        if (lo < t.z0) t.z0 = lo;
        if (hi > t.z1) t.z1 = hi;
        return;
      }
    }
    this.threads.push({ z0: lo, z1: hi, pitch, hand });
  }

  /** Detach everything right of the first gap that separates material from the chuck-side stock.
   *  Returns a new TurnProfile for the separated piece (or null). `from` = first sample to check. */
  separate(from) {
    const n = this.n;
    // find an empty sample with material both before and after it
    let g = -1;
    for (let i = Math.max(1, from); i < n; i++) {
      if (!this.has(i)) { if (this.has(i - 1)) { g = i; break; } }
    }
    if (g < 0) return null;
    const a = this.firstMatFrom(g);
    if (a < 0) return null;
    const b = this.lastMat();
    const p = new TurnProfile({ zMin: this.z(a), zMax: this.z(b), radius: 0, dz: this.dz, chunkMm: this.chunk * this.dz });
    for (let i = a; i <= b; i++) {
      const k = i - a;
      p.rOut[k] = this.rOut[i]; p.rIn[k] = this.rIn[i]; p.mach[k] = this.mach[i];
      p.machIn[k] = this.machIn[i]; p.fe[k] = this.fe[i]; p.thr[k] = this.thr[i];
      this.rOut[i] = 0; this.rIn[i] = 0;
    }
    for (let i = g; i < a; i++) { this.rOut[i] = 0; this.rIn[i] = 0; }
    p.rBound = p.rOut.reduce((m, v) => (v > m ? v : m), 0) + 1e-9;
    p.threads = this.threads.filter((t) => t.z1 > p.zMin && t.z0 < p.zMax).map((t) => ({ ...t }));
    p.chunkVer.fill(1);
    for (let c = 0; c < p.nChunks; c++) {
      let m = 0;
      for (let i = c * p.chunk; i <= Math.min(p.n - 1, (c + 1) * p.chunk); i++) if (p.rOut[i] > m) m = p.rOut[i];
      p.chunkMax[c] = m;
    }
    this.hi = Math.min(this.hi, g - 1);
    this.acc.i0 = Math.min(this.acc.i0, g); this.acc.i1 = Math.max(this.acc.i1, b);
    this.endEdit();
    this.resetAcc();
    return p;
  }

  // ------------------------------------------------------------ measurement (instrument-like)
  _round(v, res) { return res > 0 ? Math.round(v / res + 1e-9) * res : v; }

  /** Largest outside diameter within +-width/2 of z (micrometer / caliper). null when no material. */
  measureOD(z, { width = 1.0, res = 0.01 } = {}) {
    const i0 = Math.max(0, Math.round(this.idx(z - width / 2))), i1 = Math.min(this.n - 1, Math.round(this.idx(z + width / 2)));
    let m = -1;
    for (let i = i0; i <= i1; i++) if (this.has(i) && this.rOut[i] > m) m = this.rOut[i];
    return m < 0 ? null : +this._round(2 * m, res).toFixed(4);
  }

  /** Smallest bore diameter within +-width/2 of z; null when there is no bore there. */
  measureID(z, { width = 1.0, res = 0.01 } = {}) {
    const i0 = Math.max(0, Math.round(this.idx(z - width / 2))), i1 = Math.min(this.n - 1, Math.round(this.idx(z + width / 2)));
    let m = Infinity;
    for (let i = i0; i <= i1; i++) {
      if (!this.has(i) || this.rIn[i] <= EMPTY) return null;
      if (this.rIn[i] < m) m = this.rIn[i];
    }
    return m === Infinity ? null : +this._round(2 * m, res).toFixed(4);
  }

  /** Material length between z1 and z2 (counts samples that still hold material), rounded to `res`. */
  lengthBetween(z1, z2, { res = 0.01 } = {}) {
    const a = Math.max(0, Math.round(this.idx(Math.min(z1, z2)))), b = Math.min(this.n - 1, Math.round(this.idx(Math.max(z1, z2))));
    let c = 0;
    for (let i = a; i < b; i++) if (this.has(i)) c++;
    return +this._round(c * this.dz, res).toFixed(4);
  }

  /** Length of the end section whose diameter is <= dia + tol, measured from the free end face. */
  stepLength(dia, tol = 0.05, { res = 0.01 } = {}) {
    let i = this.lastMat();
    if (i < 0) return 0;
    let c = 0;
    while (i >= 0 && this.has(i) && 2 * this.rOut[i] <= dia + tol) { c++; i--; }
    return +this._round(c * this.dz, res).toFixed(4);
  }

  /** Turned-surface roughness estimate Ra in micrometres from the feed marks (nose radius rn). */
  measureRa(z, rn = 0.4) {
    const i = Math.round(this.idx(z));
    if (!this.has(i)) return null;
    if (!this.mach[i]) return 6.3;
    const f = this.fe[i] || 0.1;
    return +(32.1 * f * f / rn).toFixed(2);
  }

  // Interpolated outer radius at an arbitrary z (0 outside).
  rOutAt(z) {
    const t = this.idx(z), i = Math.floor(t);
    if (i < 0 || i >= this.n - 1) return i === this.n - 1 && t === i ? this.rOut[i] : 0;
    const f = t - i;
    const a = this.has(i) ? this.rOut[i] : 0, b = this.has(i + 1) ? this.rOut[i + 1] : 0;
    return a * (1 - f) + b * f;
  }

  volume() {
    let v = 0;
    for (let i = 0; i < this.n; i++) if (this.has(i)) v += Math.PI * (this.rOut[i] ** 2 - this.rIn[i] ** 2) * this.dz;
    return v;
  }
}

// ---------------------------------------------------------------- mesh arrays (pure, testable)
// Builds a revolved surface for one chunk. Axis = +X in the output (x = z along the bar, y/z = radial).
// Vertex info attribute (vec4): machined(0/1), feed pitch (mm), thread pitch (0 = none), angle phi.
const SEGS = 56;

function simplify(prof, a, b, tol, keep, arr) {
  // Douglas-Peucker on arr[a..b] (vertical deviation); marks keep[i]
  keep[a] = 1; keep[b] = 1;
  const stack = [a, b];
  const dz = prof.dz;
  while (stack.length) {
    const e = stack.pop(), s = stack.pop();
    if (e - s < 2) continue;
    const r0 = arr[s], r1 = arr[e];
    let md = 0, mi = -1;
    for (let i = s + 1; i < e; i++) {
      const dev = Math.abs(arr[i] - (r0 + ((r1 - r0) * (i - s)) / (e - s)));
      if (dev > md) { md = dev; mi = i; }
    }
    if (md > tol) { keep[mi] = 1; stack.push(s, mi, mi, e); }
  }
  void dz;
}

/**
 * @returns {null | {pos:Float32Array, nor:Float32Array, info:Float32Array, idx:Uint16Array|Uint32Array, verts:number, tris:number}}
 */
export function buildChunkArrays(prof, c, { segs = SEGS, zVisMin = -1.5, tol = 0.004 } = {}) {
  const { dz, n } = prof;
  let a = c * prof.chunk, b = Math.min(n - 1, (c + 1) * prof.chunk);
  const aVis = Math.max(0, Math.ceil(prof.idx(zVisMin)));
  if (a < aVis) a = aVis;
  if (b < a) return null;
  const len = b - a + 1;
  const S1 = segs + 1;
  // thread pitch per sample in this chunk
  const tp = new Float32Array(len), th = new Int8Array(len);
  for (const t of prof.threads) {
    const i0 = Math.max(a, Math.ceil(prof.idx(t.z0))), i1 = Math.min(b, Math.floor(prof.idx(t.z1)));
    for (let i = i0; i <= i1; i++) { tp[i - a] = t.pitch; th[i - a] = t.hand; }
  }
  const rings = []; // {z, r, nz, nr, mach, fe, tp, hand, type}
  const strips = []; // [startRing, endRing, flip]
  const caps = []; // {z, rIn, rOut, dir, mach, kind}
  const verts = [];
  const rOut = prof.rOut, rIn = prof.rIn;

  // outer surface rings for a run: kept indices
  const mkRings = (rs, re, arr, isInner) => {
    // returns array of sample indices in order (with thread-zone stride)
    const keep = new Uint8Array(len);
    let i = rs;
    while (i <= re) {
      const inT = tp[i - a] > 0;
      let j = i;
      while (j + 1 <= re && (tp[j + 1 - a] > 0) === inT) j++;
      if (inT && !isInner) {
        const stride = Math.max(1, Math.floor(tp[i - a] / 12 / dz));
        for (let k = i; k <= j; k += stride) keep[k - a] = 1;
        keep[j - a] = 1; keep[i - a] = 1;
      } else simplify(prof, i - a, j - a, tol, keep, arr.subarray ? arr.subarray(a, b + 1) : arr.slice(a, b + 1));
      i = j + 1;
    }
    const out = [];
    for (let k = rs; k <= re; k++) if (keep[k - a]) out.push(k);
    return out;
  };

  let i = a;
  while (i <= b) {
    if (!prof.has(i)) { i++; continue; }
    let rs = i;
    while (i + 1 <= b && prof.has(i + 1)) i++;
    const re = i;
    i++;
    // ---- outer surface
    const ids = mkRings(rs, re, rOut, false);
    const first = rings.length;
    const segN = []; // per-segment normals (z, r)
    for (let k = 0; k + 1 < ids.length; k++) {
      const dzs = (ids[k + 1] - ids[k]) * dz, drs = rOut[ids[k + 1]] - rOut[ids[k]];
      const l = Math.hypot(dzs, drs) || 1;
      segN.push([-drs / l, dzs / l]);
    }
    for (let k = 0; k < ids.length; k++) {
      const s = ids[k], inT = tp[s - a] > 0;
      const base = { z: prof.z(s), r: rOut[s], mach: prof.mach[s], fe: prof.fe[s], tp: inT ? tp[s - a] : 0, hand: th[s - a], s };
      if (inT) {
        // normal from the local slope (thread flanks)
        const w = Math.max(2, Math.round(tp[s - a] / 24 / dz));
        const s0 = Math.max(rs, s - w), s1 = Math.min(re, s + w);
        const ds = (s1 - s0) * dz || 1, dr = rOut[s1] - rOut[s0];
        const l = Math.hypot(ds, dr);
        rings.push({ ...base, nz: -dr / l, nr: ds / l });
      } else {
        const pn = k > 0 ? segN[k - 1] : null, nn = k < segN.length ? segN[k] : null;
        if (pn && nn && pn[0] * nn[0] + pn[1] * nn[1] < 0.75) {
          rings.push({ ...base, nz: pn[0], nr: pn[1] });
          rings.push({ ...base, nz: nn[0], nr: nn[1] });
        } else {
          let nz = 0, nr = 1;
          if (pn && nn) { nz = pn[0] + nn[0]; nr = pn[1] + nn[1]; } else if (pn || nn) { [nz, nr] = pn || nn; } else nr = 1;
          const l = Math.hypot(nz, nr) || 1;
          rings.push({ ...base, nz: nz / l, nr: nr / l });
        }
      }
    }
    strips.push([first, rings.length - 1, false, 'out']);
    // ---- bore surface (sub-runs where rIn > 0)
    let j = rs;
    while (j <= re) {
      if (rIn[j] <= EMPTY) { j++; continue; }
      const js = j;
      while (j + 1 <= re && rIn[j + 1] > EMPTY) j++;
      const je = j;
      j++;
      const bids = mkRings(js, je, rIn, true);
      const f0 = rings.length;
      for (let k = 0; k < bids.length; k++) {
        const s = bids[k];
        const s0 = k > 0 ? bids[k - 1] : s, s1 = k + 1 < bids.length ? bids[k + 1] : s;
        const ds = (s1 - s0) * dz || 1, dr = rIn[s1] - rIn[s0];
        const l = Math.hypot(ds, dr);
        // inward-pointing normal
        rings.push({ z: prof.z(s), r: rIn[s], nz: dr / l, nr: -ds / l, mach: prof.machIn[s], fe: 0, tp: 0, hand: 0, s });
      }
      strips.push([f0, rings.length - 1, true, 'in']);
    }
    // ---- end caps
    const startGap = rs - 1 >= 0 && !prof.has(rs - 1) && rs > aVis;
    if (startGap) caps.push({ z: prof.z(rs) - dz / 2, ri: rIn[rs], ro: rOut[rs], dir: -1, mach: prof.mach[rs] });
    const endGap = re === n - 1 || (re + 1 < n && !prof.has(re + 1));
    if (endGap) caps.push({ z: prof.z(re) + dz / 2, ri: rIn[re], ro: rOut[re], dir: 1, mach: prof.mach[re] });
  }
  if (!rings.length) return null;

  // ---- emit vertices
  const nv = rings.length * S1 + caps.length * 2 * S1;
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), info = new Float32Array(nv * 4);
  let v = 0;
  const put = (x, r, phi, nx, nrad, m, fe, tpv) => {
    const cp = Math.cos(phi), sp = Math.sin(phi);
    pos[v * 3] = x; pos[v * 3 + 1] = r * cp; pos[v * 3 + 2] = r * sp;
    nor[v * 3] = nx; nor[v * 3 + 1] = nrad * cp; nor[v * 3 + 2] = nrad * sp;
    info[v * 4] = m; info[v * 4 + 1] = fe; info[v * 4 + 2] = tpv; info[v * 4 + 3] = phi;
    v++;
  };
  for (const g of rings) {
    for (let s = 0; s <= segs; s++) {
      const phi = (2 * Math.PI * s) / segs;
      let r = g.r, m = g.mach, fe = g.fe;
      if (g.tp > 0 && g.nr > 0) {
        // helical shear: groove at reference z_k appears at z_k + hand*pitch*phi/2pi
        const zq = g.z - g.hand * g.tp * (phi / (2 * Math.PI));
        const rr = prof.rOutAt(zq);
        r = rr > 0 ? rr : g.r;
        const si = Math.round(prof.idx(zq));
        m = si >= 0 && si < n ? Math.max(prof.mach[si], 0) : m;
        fe = 0;
      }
      put(g.z, r, phi, g.nz, g.nr, m, fe, g.tp);
    }
  }
  const capBase = [];
  for (const cp of caps) {
    capBase.push(v / S1);
    const nx = cp.dir;
    for (let s = 0; s <= segs; s++) put(cp.z, cp.ri, (2 * Math.PI * s) / segs, nx, 0, cp.mach, 0, 0);
    for (let s = 0; s <= segs; s++) put(cp.z, cp.ro, (2 * Math.PI * s) / segs, nx, 0, cp.mach, 0, 0);
  }
  // ---- indices
  let tri = 0;
  for (const [f, l] of strips) tri += (l - f) * segs * 2;
  tri += caps.length * segs * 2;
  const Idx = nv > 65535 ? Uint32Array : Uint16Array;
  const idx = new Idx(tri * 3);
  let q = 0;
  const quad = (A, B, flip) => {
    for (let s = 0; s < segs; s++) {
      const a0 = A * S1 + s, a1 = a0 + 1, b0 = B * S1 + s, b1 = b0 + 1;
      if (!flip) { idx[q++] = a0; idx[q++] = a1; idx[q++] = b0; idx[q++] = a1; idx[q++] = b1; idx[q++] = b0; } else { idx[q++] = a0; idx[q++] = b0; idx[q++] = a1; idx[q++] = a1; idx[q++] = b0; idx[q++] = b1; }
    }
  };
  for (const [f, l, flip] of strips) for (let k = f; k < l; k++) quad(k, k + 1, flip);
  caps.forEach((cp, k) => quad(capBase[k], capBase[k] + 1, cp.dir > 0));
  return { pos, nor, info, idx, verts: nv, tris: tri };
}
