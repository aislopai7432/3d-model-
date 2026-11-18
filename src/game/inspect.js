// Inspection of a machined part: compares the Z-map (heightfield) with the drawing and produces a
// report with per-feature measurements, a score and a grade.
//
// Method
// - Every Z-map node is mapped into the part frame (partDatum). The target height comes from the
//   drawing (deepest feature wins); deviation = actual - target. Inside a drilled hole the material may
//   be deeper than the hole depth by the 118° drill point.
// - Nodes within a boundary band (max(1.5 cells, 0.15 mm)) of a drawn edge are ignored for the area
//   statistics: the grid cannot place a vertical wall more precisely than one cell.
// - Depths are robust medians of the measured floor away from the walls (holes: drill point removed),
//   measured from the machined top face when that is within tolerance (the area statistics too; the
//   top face itself is always compared with the nominal thickness).
// - Walls are measured from the band of nodes within +-m (2 mm) of each nominal wall that no other
//   feature decides: a node is "inside" when it was cut below the mid level (bosses: when it was not).
//   Per wall (or narrow +-22.5° sector of a circle) the range of outward offsets consistent with the
//   data (inside <=> signed distance <= offset, allowing 1% misread nodes for arc chords) is found;
//   sizes and positions combine opposite walls and are judged on the explanation closest to the
//   drawing (fewest items out, then smallest error). A correctly machined part reads exactly nominal
//   at any grid phase; a reading is only out of tolerance when the grid data proves it (real errors
//   larger than tol + 1 cell are always caught).
// - Deep gouges within 1 mm of a drawn edge count as wall errors (size/position items), not scrap.
//
// Tolerances: depth and size use feature.tol ?? part.tol.general (counterbores: cbore.tol ?? that);
// positions use the same value, doubled for holes and counterbores (drilled holes are located by the
// spot drill, not finish milled); top thickness and flatness use part.tol.general.
// Score: weighted fraction of passing items (depth 2, size 2, position 1.5, thickness 1.5, flatness 1)
// minus up to 20 points for out-of-tolerance area (excess + gouge, as a fraction of the part area).
// Grades: FAIL if nothing was cut, a feature is missing, the blank is wrong, a gouge > 0.5 mm deeper
// than the drawing covers >= 1 mm², or the score is < 50. Otherwise A (everything within tolerance,
// no out-of-tolerance area and score >= 95), B (>= 85), C (>= 70), D (>= 50).
import { featureElements, targetInfo, partDatum, DRILL_POINT_K } from './parts.js';
import { VISE } from '../config.js';

const W = { depth: 2, size: 2, position: 1.5, top: 1.5, flatness: 1 };
const NAMES = { pocketRect: 'Pocket', pocketCirc: 'Pocket', hole: 'Hole', slot: 'Slot', step: 'Step', boss: 'Boss' };
const NARROW_COS = Math.sin(Math.PI / 8) / (Math.PI / 8); // mean of cos over +-22.5° (narrow wall sectors)

const f2 = (v) => (Math.abs(v) < 0.005 ? '0.00' : v.toFixed(2));
const sgn = (v) => (v >= 0 ? '+' : '-') + Math.abs(v).toFixed(2);
const r3 = (v) => Math.round(v * 1000) / 1000;

function median(arr) {
  if (!arr.length) return NaN;
  const a = Float64Array.from(arr).sort();
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

export function inspectPart(part, zmap, placement) {
  const els = featureElements(part);
  const D = partDatum(placement, part);
  const { nx, ny, x0, y0, dx, dy, h } = zmap;
  const N = nx * ny;
  const cell = Math.max(dx, dy);
  const cellArea = dx * dy;
  const band = Math.max(1.5 * cell, 0.15);
  const M = Math.max(2, 4 * cell); // half width of the wall measuring band
  const SX = part.size.x, SY = part.size.y;
  const gtol = part.tol?.general ?? 0.1;
  const partArea = SX * SY;
  const items = [];
  const notes = [];
  let fatal = false;

  const deviation = { nx, ny, x0, y0, dx, dy, data: new Float32Array(N).fill(NaN) };
  const report = (o) => ({
    partId: part.id, score: 0, grade: 'FAIL', pass: false,
    summary: { checked: 0, withinTol: 0, maxExcess: 0, maxGouge: 0, excessArea: 0, gougeArea: 0, notMachined: false },
    items, deviation, notes, ...o,
  });

  // ---- blank checks
  const blankZ = zmap.top - zmap.bottom;
  if (Math.abs(placement.lx - part.stock.x) > 0.5 || Math.abs(placement.ly - Math.min(part.stock.y, VISE.maxOpening)) > 0.5 || Math.abs(blankZ - part.stock.z) > 0.5) {
    notes.push(`Wrong blank: the part was machined from ${r3(placement.lx)} x ${r3(placement.ly)} x ${r3(blankZ)} but the drawing calls for ${part.stock.x} x ${part.stock.y} x ${part.stock.z}.`);
    return report({ summary: { checked: 0, withinTol: 0, maxExcess: 0, maxGouge: 0, excessArea: 0, gougeArea: 0, notMachined: false, wrongBlank: true } });
  }
  let cutNodes = 0;
  for (let k = 0; k < N; k++) if (h[k] < zmap.top - 0.005) cutNodes++;
  if (cutNodes * cellArea < 0.5) {
    notes.push('Not machined: the blank has not been cut at all.');
    return report({ summary: { checked: 0, withinTol: 0, maxExcess: 0, maxGouge: 0, excessArea: 0, gougeArea: 0, notMachined: true } });
  }

  // ---- per node target, governing element, drill point allowance and boundary band
  const tgt = new Float32Array(N); // target height in the part frame (0 = finished top)
  const gov = new Int16Array(N); // governing element, -1 = top face, -2 = outside the part
  const cone = new Float32Array(N);
  const ign = new Uint8Array(N);
  const act = new Float32Array(N); // actual height in the part frame
  const ti = {}, tn = {};
  const OFF = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071]];
  const eps = 1e-6;
  for (let j = 0; j < ny; j++) {
    const py = y0 + j * dy - D.y;
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const px = x0 + i * dx - D.x;
      act[k] = h[k] - D.z;
      if (px < -eps || py < -eps || px > SX + eps || py > SY + eps) {
        gov[k] = -2;
        ign[k] = 1;
        continue;
      }
      targetInfo(part, px, py, -1, ti);
      tgt[k] = -ti.depth;
      gov[k] = ti.el;
      cone[k] = ti.cone;
      for (const [ox, oy] of OFF) {
        const qx = px + ox * band, qy = py + oy * band;
        if (qx < 0 || qy < 0 || qx > SX || qy > SY) continue;
        targetInfo(part, qx, qy, -1, tn);
        if (Math.abs(tn.depth - ti.depth) > 1e-6) {
          ign[k] = 1;
          break;
        }
      }
    }
  }

  // Deep gouges right next to a drawn wall are wall position/size errors and are judged by the size and
  // position checks; only those more than WALL_ZONE from every edge make the part scrap on their own.
  const WALL_ZONE = 1.0;
  const farFromEdges = (k) => {
    const i = k % nx, j = (k / nx) | 0;
    const px = x0 + i * dx - D.x, py = y0 + j * dy - D.y;
    for (const rr of [WALL_ZONE / 2, WALL_ZONE]) {
      for (const [ox, oy] of OFF) {
        const qx = px + ox * rr, qy = py + oy * rr;
        if (qx < 0 || qy < 0 || qx > SX || qy > SY) continue;
        if (Math.abs(targetInfo(part, qx, qy, -1, tn).depth + tgt[k]) > 1e-6) return false;
      }
    }
    return true;
  };

  // Reference height for the shape: the machined top face (median of the top nodes away from edges)
  // when it is within tolerance of the drawing, otherwise the nominal top.
  let ref = 0;
  {
    const v = [];
    for (let k = 0; k < N; k++) if (gov[k] === -1 && !ign[k]) v.push(act[k]);
    const med = median(v);
    if (Math.abs(med) <= gtol) ref = med;
  }

  // ---- area statistics
  const exMask = new Uint8Array(N), goMask = new Uint8Array(N);
  let maxExcess = 0, maxGouge = 0, exN = 0, goN = 0, deepN = 0;
  const devAdj = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    if (gov[k] === -2) continue;
    let d = act[k] - (gov[k] === -1 ? 0 : ref) - tgt[k];
    if (d < 0 && cone[k] > 0) d = Math.min(0, d + cone[k]);
    devAdj[k] = d;
    if (ign[k]) continue;
    deviation.data[k] = d;
    const tz = (gov[k] >= 0 ? els[gov[k]].tol : gtol) + 0.002;
    if (d > maxExcess) maxExcess = d;
    if (-d > maxGouge) maxGouge = -d;
    if (d > tz) { exMask[k] = 1; exN++; }
    else if (d < -tz) {
      goMask[k] = 1;
      goN++;
      if (d < -0.5 && farFromEdges(k)) deepN++;
    }
  }
  const excessArea = exN * cellArea, gougeArea = goN * cellArea;

  // ---- top face: thickness and flatness
  {
    const v = [];
    for (let k = 0; k < N; k++) if (gov[k] === -1 && !ign[k]) v.push(act[k]);
    if (v.length) {
      const s = Float64Array.from(v).sort();
      const med = quantile(s, 0.5);
      const thick = part.size.z + med;
      const okT = Math.abs(med) <= gtol + 1e-6;
      items.push({ label: 'Part thickness (top face)', kind: 'top', featureId: null, nominal: part.size.z, measured: r3(thick), tol: gtol, pass: okT });
      if (!okT) notes.push(`Part thickness ${f2(thick)}: ${f2(Math.abs(med))} ${med > 0 ? 'too thick, face the top down to size' : 'too thin'} (tol ±${gtol}).`);
      const flat = quantile(s, 0.995) - quantile(s, 0.005);
      const okF = flat <= gtol + 1e-6;
      items.push({ label: 'Top face flatness', kind: 'flatness', featureId: null, nominal: 0, measured: r3(flat), tol: gtol, pass: okF });
      if (!okF) notes.push(`Top face not flat: ${f2(flat)} mm variation (tol ${gtol}). Part of the top was not faced or was cut too deep.`);
    }
  }

  // ---- features
  const iOf = (px) => Math.round((px + D.x - x0) / dx);
  const jOf = (py) => Math.round((py + D.y - y0) / dy);
  const missing = new Set();
  els.forEach((e, ei) => {
    const f = e.f;
    const typeName = e.sub === 'cbore' ? 'Counterbore' : f.type === 'pocketCirc' ? 'Circular pocket' : NAMES[f.type] || 'Feature';
    const name = `${typeName} ${e.id}`;
    const dia = e.shape === 'circle' ? ` (Ø${r3(2 * e.R)})` : '';
    // window in the part frame
    let bx0 = 0, bx1 = SX, by0 = 0, by1 = SY;
    if (e.removeInside && e.shape !== 'half') {
      const ext = (e.shape === 'circle' ? e.R : e.shape === 'rect' ? Math.hypot(e.a, e.b) : e.hl + e.hw) + M + cell;
      bx0 = e.cx - ext; bx1 = e.cx + ext; by0 = e.cy - ext; by1 = e.cy + ext;
    }
    const i0 = Math.max(0, iOf(bx0)), i1 = Math.min(nx - 1, iOf(bx1)), j0 = Math.max(0, jOf(by0)), j1 = Math.min(ny - 1, jOf(by1));
    let m = M;
    if (e.shape === 'circle') m = Math.min(M, 0.8 * e.R);
    else if (e.shape === 'rect') m = Math.min(M, 0.8 * Math.min(e.a, e.b));
    else if (e.shape === 'capsule') m = Math.min(M, 0.8 * e.hw);
    const floor = -e.depth;
    // accumulators
    const deps = [], rhos = [];
    let interior = 0, interiorCut = 0;
    const S = {}; // sector -> { sd: [], inn: [] } of the band nodes this feature alone decides
    const T22 = Math.tan(Math.PI / 8);
    // sectors of a band node: 'all' plus one wall (rectangle strips may give two)
    const sectors = (px, py, fn) => {
      fn('all');
      const ex = px - e.cx, ey = py - e.cy;
      if (e.shape === 'circle') {
        if (Math.abs(ey) <= T22 * Math.abs(ex)) fn(ex >= 0 ? 'E' : 'W');
        else if (Math.abs(ex) <= T22 * Math.abs(ey)) fn(ey >= 0 ? 'N' : 'S');
      } else if (e.shape === 'rect') {
        const u = e.c * ex + e.s * ey, v = -e.s * ex + e.c * ey;
        if (Math.abs(v) <= su && Math.abs(u) >= e.a - m) fn(u > 0 ? '+u' : '-u');
        if (Math.abs(u) <= sv && Math.abs(v) >= e.b - m) fn(v > 0 ? '+v' : '-v');
      } else if (e.shape === 'capsule') {
        const u = e.c * ex + e.s * ey, v = -e.s * ex + e.c * ey;
        if (Math.abs(u) <= e.hl) fn(v > 0 ? '+v' : '-v');
        else if (Math.abs(v) <= T22 * (Math.abs(u) - e.hl)) fn(u > 0 ? 'c2' : 'c1');
      }
    };
    const su = e.shape === 'rect' ? Math.min(e.b - e.r, e.b - m) : 0, sv = e.shape === 'rect' ? Math.min(e.a - e.r, e.a - m) : 0;
    for (let j = j0; j <= j1; j++) {
      const py = y0 + j * dy - D.y;
      for (let i = i0; i <= i1; i++) {
        const k = j * nx + i;
        if (gov[k] === -2) continue;
        const px = x0 + i * dx - D.x;
        const sd = e.sdf(px, py);
        const isInterior = gov[k] === ei && !ign[k];
        const inBand = Math.abs(sd) <= m;
        if (!isInterior && !inBand) continue;
        targetInfo(part, px, py, ei, tn);
        const without = -tn.depth;
        if (without - floor < 0.3) continue; // another, deeper feature decides this node
        const level = (without + floor) / 2;
        const cut = act[k] < level;
        if (isInterior) {
          interior++;
          if (cut) interiorCut++;
          deps.push(ref - act[k]);
          if (e.sub === 'hole') rhos.push(Math.hypot(px - e.cx, py - e.cy));
        }
        if (!inBand) continue;
        const measIn = e.removeInside ? cut : !cut;
        sectors(px, py, (key) => {
          const a = S[key] || (S[key] = { sd: [], inn: [] });
          a.sd.push(sd);
          a.inn.push(measIn ? 1 : 0);
        });
      }
    }
    // Outward offset of a wall: the range [lo, hi] of offsets d that best explains which band nodes
    // are inside the machined shape (inside <=> sd <= d), and the value in it closest to 0.
    const fit = (key, minN = 6) => {
      const a = S[key];
      if (!a || a.sd.length < minN) return null;
      const n = a.sd.length;
      const idx = Array.from({ length: n }, (_, q) => q).sort((p, q) => a.sd[p] - a.sd[q]);
      let cost = 0;
      for (let q = 0; q < n; q++) cost += a.inn[q];
      // d below every node: all measured-inside nodes are misclassified
      let best = cost, ranges = [[-m, a.sd[idx[0]]]];
      for (let q = 0; q < n; q++) {
        const p = idx[q];
        cost += a.inn[p] ? -1 : 1;
        const sdq = a.sd[p], next = q + 1 < n ? a.sd[idx[q + 1]] : m;
        if (next - sdq < 1e-9 && q + 1 < n) continue;
        if (cost < best) { best = cost; ranges = [[sdq, next]]; } else if (cost === best) ranges.push([sdq, next]);
      }
      // accept a few misclassified nodes (arc chords of the cutter path, float noise): every offset
      // whose cost is within the slack of the minimum explains the data
      const slack = Math.max(1, Math.round(0.01 * n));
      if (slack > 0) {
        ranges = [];
        let c2 = 0;
        for (let q = 0; q < n; q++) c2 += a.inn[q];
        if (c2 <= best + slack) ranges.push([-m, a.sd[idx[0]]]);
        for (let q = 0; q < n; q++) {
          const p = idx[q];
          c2 += a.inn[p] ? -1 : 1;
          const sdq = a.sd[p], next = q + 1 < n ? a.sd[idx[q + 1]] : m;
          if (next - sdq < 1e-9 && q + 1 < n) continue;
          if (c2 <= best + slack) {
            const last = ranges[ranges.length - 1];
            if (last && Math.abs(last[1] - sdq) < 1e-9) last[1] = next;
            else ranges.push([sdq, next]);
          }
        }
      }
      let pick = ranges[0], bestDist = Infinity;
      for (const r of ranges) {
        const d = r[0] > 0 ? r[0] : r[1] < 0 ? -r[1] : 0;
        if (d < bestDist) { bestDist = d; pick = r; }
      }
      const est = pick[0] > 0 ? pick[0] : pick[1] < 0 ? pick[1] : 0;
      return { lo: pick[0], hi: pick[1], est };
    };
    // value of an interval [lo, hi] closest to 0
    const near0 = (lo, hi) => (lo > 0 ? lo : hi < 0 ? hi : 0);

    // missing feature
    if (interior >= 3 && interiorCut / interior < 0.5) {
      missing.add(ei);
      fatal = true;
      notes.push(`${name}${dia} is missing${interiorCut ? ' (hardly cut)' : ''}.`);
      items.push({ label: `${name} depth`, kind: 'depth', featureId: e.id, nominal: e.depth, measured: r3(median(deps)), tol: e.tol, pass: false, missing: true });
      return;
    }

    // depth
    if (deps.length >= 3) {
      let dep = median(deps);
      let drillPoint = false;
      if (e.sub === 'hole' && rhos.length >= 6) {
        // conical bottom (drill point) or flat bottom (milled)?
        const R = e.R;
        let si = 0, ni = 0, so = 0, no = 0, ri = 0, ro = 0;
        const rmax = Math.max(...rhos);
        for (let q = 0; q < rhos.length; q++) {
          if (rhos[q] < 0.45 * rmax) { si += deps[q]; ri += rhos[q]; ni++; } else if (rhos[q] > 0.7 * rmax) { so += deps[q]; ro += rhos[q]; no++; }
        }
        if (ni && no) {
          const slope = (si / ni - so / no) / (ro / no - ri / ni);
          if (slope > 0.3) {
            drillPoint = true;
            dep = median(deps.map((d, q) => d - (R - rhos[q]) * DRILL_POINT_K));
          }
        }
      }
      const dd = dep - e.depth;
      const ok = Math.abs(dd) <= e.tol + 1e-6;
      items.push({ label: `${name} depth`, kind: 'depth', featureId: e.id, nominal: e.depth, measured: r3(dep), tol: e.tol, pass: ok });
      if (!ok) {
        let n = `${name} depth ${f2(dep)}: ${f2(Math.abs(dd))} too ${dd > 0 ? 'deep' : 'shallow'} (tol ±${e.tol}).`;
        if (e.sub === 'hole' && drillPoint && dd < 0 && Math.abs(-dd - e.R * DRILL_POINT_K) < 0.35) {
          n += ` The hole depth is to the full diameter: add the drill point (${f2(e.R * DRILL_POINT_K)} mm for Ø${r3(2 * e.R)}) to the tip depth.`;
        }
        notes.push(n);
      }
    }

    // size and position (judged on the value closest to nominal that the grid data allows)
    const sizeItem = (label, nominal, lo, hi, tol) => {
      if (lo == null || !isFinite(lo) || !isFinite(hi)) return;
      const d = near0(lo, hi);
      const ok = Math.abs(d) <= tol + 1e-6;
      items.push({ label: `${name} ${label}`, kind: 'size', featureId: e.id, nominal: r3(nominal), measured: r3(nominal + d), range: [r3(nominal + lo), r3(nominal + hi)], tol, pass: ok });
      if (!ok) notes.push(`${name} ${label} ${f2(nominal + d)}: ${f2(Math.abs(d))} too ${d > 0 ? 'large' : 'small'} (nominal ${r3(nominal)}, tol ±${tol}).`);
    };
    // du/dv: [lo, hi] intervals along the local axes (c, s = direction of the local u axis)
    const posItem = (du, dv, c, sn, tol) => {
      if (!du || !dv) return;
      const u = near0(du[0], du[1]), v = near0(dv[0], dv[1]);
      const ddx = c * u - sn * v, ddy = sn * u + c * v;
      const dist = Math.hypot(ddx, ddy);
      const ok = dist <= tol + 1e-6;
      items.push({ label: `${name} position`, kind: 'position', featureId: e.id, nominal: 0, measured: r3(dist), dx: r3(ddx), dy: r3(ddy), tol, pass: ok });
      if (!ok) notes.push(`${name} is ${f2(dist)} mm off position (X ${sgn(ddx)}, Y ${sgn(ddy)}; tol ${tol}).`);
    };
    // Two opposite walls with offset intervals p (positive side) and q: size change s = dp + dq and
    // shift t = (dp - dq) / 2 / k. Pick the explanation consistent with the data that is closest to
    // the drawing (fewest items out of tolerance, then smallest normalised error), judged jointly.
    const pair = (p, q, tolS, tolT, k = 1) => {
      if (!p || !q) return null;
      let best = null;
      // fewest failing items first, then the smallest worst violation, then the smallest sum
      const better = (cur, sz, t) => {
        const a = Math.abs(sz) / tolS, b = Math.abs(t) / tolT;
        const c = { nf: (a > 1 + 1e-9 ? 1 : 0) + (b > 1 + 1e-9 ? 1 : 0), v: Math.max(a, b), w: a + b, s: sz, t };
        if (!cur) return c;
        if (c.nf !== cur.nf) return c.nf < cur.nf ? c : cur;
        if (Math.abs(c.v - cur.v) > 1e-9) return c.v < cur.v ? c : cur;
        return c.w < cur.w - 1e-9 ? c : cur;
      };
      const N = 40;
      for (let a = 0; a <= N; a++) {
        const dp = p.lo + ((p.hi - p.lo) * a) / N;
        for (let b = 0; b <= N; b++) {
          const dq = q.lo + ((q.hi - q.lo) * b) / N;
          const sz = dp + dq, t = (dp - dq) / (2 * k);
          best = better(best, sz, t);
        }
      }
      // exact zero-size and zero-shift candidates
      for (const dp of [p.lo, p.hi, -q.lo, -q.hi, q.lo, q.hi]) {
        for (const dq of [-dp, dp]) {
          if (dp < p.lo || dp > p.hi || dq < q.lo || dq > q.hi) continue;
          const sz = dp + dq, t = (dp - dq) / (2 * k);
          best = better(best, sz, t);
        }
      }
      return best;
    };
    const sizeVal = (label, nominal, d, tol) => sizeItem(label, nominal, d, d, tol);
    const posVal = (u, v, c, sn, tol) => posItem(u == null ? null : [u, u], v == null ? null : [v, v], c, sn, tol);
    const ptol = e.sub === 'hole' || e.sub === 'cbore' ? 2 * e.tol : e.tol;
    if (e.shape === 'circle') {
      const all = fit('all');
      if (all) sizeItem('Ø', 2 * e.R, 2 * all.lo, 2 * all.hi, e.tol);
      const pe = fit('E'), pw = fit('W'), pn = fit('N'), ps = fit('S');
      const sh = (p, q) => (p && q ? [(p.lo - q.hi) / (2 * NARROW_COS), (p.hi - q.lo) / (2 * NARROW_COS)] : null);
      posItem(sh(pe, pw), sh(pn, ps), 1, 0, ptol);
    } else if (e.shape === 'rect') {
      const all = fit('all');
      const U = pair(fit('+u'), fit('-u'), e.tol, ptol), V = pair(fit('+v'), fit('-v'), e.tol, ptol);
      const rot = f.rot ? ` (along ${f.rot}°)` : '';
      if (U) sizeVal(`length${rot}`, 2 * e.a, U.s, e.tol);
      else if (all) sizeItem(`length${rot}`, 2 * e.a, 2 * all.lo, 2 * all.hi, e.tol);
      if (V) sizeVal('width', 2 * e.b, V.s, e.tol);
      else if (all) sizeItem('width', 2 * e.b, 2 * all.lo, 2 * all.hi, e.tol);
      if (U && V) posVal(U.t, V.t, e.c, e.s, ptol);
    } else if (e.shape === 'capsule') {
      const V = pair(fit('+v'), fit('-v'), e.tol, ptol);
      const U = pair(fit('c2'), fit('c1'), e.tol, ptol, NARROW_COS);
      if (V) sizeVal('width', 2 * e.hw, V.s, e.tol);
      if (U) sizeVal('length', 2 * e.hl + 2 * e.hw, U.s / NARROW_COS, e.tol);
      if (U && V) posVal(U.t, V.t, e.c, e.s, ptol);
    } else if (e.shape === 'half') {
      const all = fit('all');
      if (all) sizeItem('width', f.width, all.lo, all.hi, e.tol);
    }
  });

  // ---- out of tolerance areas (connected regions, largest first)
  const regions = (mask) => {
    const seen = new Uint8Array(N);
    const out = [];
    const stack = [];
    for (let s = 0; s < N; s++) {
      if (!mask[s] || seen[s]) continue;
      let n = 0, sx = 0, sy = 0, worst = 0;
      stack.push(s);
      seen[s] = 1;
      while (stack.length) {
        const k = stack.pop();
        n++;
        const i = k % nx, j = (k / nx) | 0;
        sx += i; sy += j;
        if (Math.abs(devAdj[k]) > worst) worst = Math.abs(devAdj[k]);
        const nb = [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, j > 0 ? k - nx : -1, j < ny - 1 ? k + nx : -1];
        for (const q of nb) if (q >= 0 && mask[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
      out.push({ area: n * cellArea, x: x0 + (sx / n) * dx - D.x, y: y0 + (sy / n) * dy - D.y, worst });
    }
    return out.sort((a, b) => b.area - a.area);
  };
  const MIN_AREA = 1.0;
  for (const r of regions(exMask).filter((r) => r.area >= MIN_AREA).slice(0, 3)) {
    notes.push(`Material left: ${r.area.toFixed(1)} mm² up to ${f2(r.worst)} mm higher than the drawing near X${r.x.toFixed(0)} Y${r.y.toFixed(0)}.`);
  }
  for (const r of regions(goMask).filter((r) => r.area >= MIN_AREA).slice(0, 3)) {
    notes.push(`Gouge: ${r.area.toFixed(1)} mm² up to ${f2(r.worst)} mm deeper than the drawing near X${r.x.toFixed(0)} Y${r.y.toFixed(0)}.`);
  }
  if (deepN * cellArea >= 1.0) fatal = true;

  // ---- score and grade
  let wSum = 0, wPass = 0, nPass = 0;
  for (const it of items) {
    const w = W[it.kind] || 1;
    wSum += w;
    if (it.pass) { wPass += w; nPass++; }
  }
  const itemScore = wSum ? (100 * wPass) / wSum : 0;
  const penalty = Math.min(20, (50 * (excessArea + gougeArea)) / partArea);
  let score = Math.max(0, itemScore - penalty);
  const allPass = items.length > 0 && nPass === items.length;
  const pass = !fatal && allPass && excessArea < MIN_AREA && gougeArea < MIN_AREA;
  let grade;
  if (fatal || score < 50) grade = 'FAIL';
  else if (pass && score >= 95) grade = 'A';
  else if (score >= 85) grade = 'B';
  else if (score >= 70) grade = 'C';
  else grade = 'D';
  if (fatal) score = Math.min(score, 49);
  if (deepN * cellArea >= 1.0) notes.unshift(`Scrap: ${(deepN * cellArea).toFixed(1)} mm² cut more than 0.5 mm deeper than the drawing allows.`);
  if (missing.size) notes.unshift(`Scrap: ${missing.size} feature${missing.size > 1 ? 's are' : ' is'} missing.`);
  if (pass) notes.unshift(`All ${items.length} checks within tolerance.`);
  else if (!fatal) notes.unshift(`${items.length - nPass} of ${items.length} checks out of tolerance.`);

  return report({
    score: Math.round(score * 10) / 10, grade, pass,
    summary: { checked: items.length, withinTol: items.length ? nPass / items.length : 0, maxExcess: r3(maxExcess), maxGouge: r3(maxGouge), excessArea, gougeArea, notMachined: false },
  });
}
