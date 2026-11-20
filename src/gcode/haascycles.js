// Haas canned cycles (G73-G89), bolt patterns (G70-G72), circular pockets (G12/G13) and the general
// purpose pocket (G150). Everything is generated in program coordinates (P space) through the
// interpreter's motion API (pMove / pArc / dwell / spindleOp), so mirror, scaling, rotation, work
// offsets, tool length offsets and travel limits apply exactly as for hand-written blocks.
import { compensate } from './crc.js';

const D2R = Math.PI / 180;
const g2 = (k) => 'G' + String(k).padStart(2, '0');

// ------------------------------------------------------------------------------------------ canned cycles
// Parameter checks done once per cycle block (ctx built by HaasInterpreter.cycleCtx).
export function cycleNeeds(I, c) {
  const k = c.k;
  if (k === 87 || k === 88) I.alarm(391, `${g2(k)} is not supported on the NGC control`);
  if (k === 77) {
    if (c.zZ <= c.rZ + 1e-9) I.alarm(306, 'G77 back bore: Z (top of the counterbore) must be above R (start below the part)');
  } else if (c.zZ > c.rZ + 1e-9) I.alarm(306, `${g2(k)}: Z depth ${fmt(I, c.zZ)} is above the R plane ${fmt(I, c.rZ)}`);
  if (k === 73 || k === 83) {
    const ijk = c.i !== undefined || c.j !== undefined || (c.kk !== undefined && k === 83);
    if (c.q !== undefined && c.q <= 0) I.alarm(306, `${g2(k)}: Q must be a positive peck depth`);
    if (k === 83 && c.q !== undefined && ijk) I.alarm(306, 'G83: program either Q or I, J, K, not both');
    if (c.q === undefined) {
      if (!(c.i > 0)) I.alarm(306, `${g2(k)} needs a peck depth Q (or I first peck, J reduction, K minimum)`);
      if (c.j !== undefined && c.j < 0) I.alarm(306, 'J must be positive');
      if (c.kk !== undefined && !(c.kk > 0)) I.alarm(306, 'K must be positive');
    }
    if (k === 73 && c.kk !== undefined && !(c.kk > 0)) I.alarm(306, 'G73 K must be positive');
  }
  if (k === 76 || k === 77) {
    if (c.q !== undefined && c.q < 0) I.alarm(306, `${g2(k)} Q (shift) must be positive`);
  }
  if ((k === 84 || k === 74) && !(I.S.rpm > 0)) I.alarm(393, `${g2(k)} needs a spindle speed S`);
}

function fmt(I, v) {
  return (v / I.uScale()).toFixed(I.S.units === 20 ? 4 : 3);
}

// Peck end depths from the R plane down to Z: constant Q, or I first, reduced by J, minimum K.
function pecks(c) {
  const out = [];
  let d = c.rZ;
  let n = 0;
  while (d > c.zZ + 1e-9 && out.length < 10000) {
    let step;
    if (c.q !== undefined) step = c.q;
    else step = Math.max(c.i - n * (c.j || 0), c.kk || 1e-3, 1e-3);
    if (c.q === undefined && c.kk !== undefined && c.k === 83) step = Math.max(step, c.kk);
    d = Math.max(d - step, c.zZ);
    out.push(d);
    n++;
  }
  return out;
}

function shiftVec(I, c) {
  if (c.q !== undefined && c.q > 0) {
    const s = c.q;
    return { 'X+': [s, 0], 'X-': [-s, 0], 'Y+': [0, s], 'Y-': [0, -s] }[c.shiftDir] || [s, 0];
  }
  return [c.i || 0, c.j || 0];
}

// One hole of the active canned cycle at program position x, y.
export function cannedHole(I, c, x, y) {
  const S = I.S;
  const k = c.k;
  const f = c.feed;
  const ret = () => (S.retract === 98 ? Math.max(c.init, c.rZ) : c.rZ);
  const P0 = I.curP();
  if (Math.abs(P0.x - x) > 1e-9 || Math.abs(P0.y - y) > 1e-9) I.pMove(true, { x, y });
  if (k === 77) return backBore(I, c, x, y);
  I.pMove(true, { z: c.rZ });
  const dir0 = S.spindleDir, rpm0 = S.rpm;
  switch (k) {
    case 81: case 82:
      I.pMove(false, { z: c.zZ }, f);
      if (k === 82) I.dwell(c.p);
      I.pMove(true, { z: ret() });
      break;
    case 83: {
      const list = pecks(c);
      list.forEach((d, n) => {
        if (n > 0) I.pMove(true, { z: Math.min(c.rZ, list[n - 1] + c.delta) });
        I.pMove(false, { z: d }, f);
        if (n < list.length - 1) I.pMove(true, { z: c.rZ + c.above });
      });
      I.dwell(c.p);
      I.pMove(true, { z: ret() });
      break;
    }
    case 73: {
      const list = pecks(c);
      let since = 0, prev = c.rZ;
      list.forEach((d, n) => {
        I.pMove(false, { z: d }, f);
        since += prev - d;
        prev = d;
        if (n < list.length - 1) {
          if (c.q !== undefined && c.kk !== undefined && since >= c.kk - 1e-9) {
            I.pMove(true, { z: c.rZ });
            I.pMove(true, { z: d + c.delta });
            since = 0;
          } else I.pMove(true, { z: d + c.delta });
        }
      });
      I.dwell(c.p);
      I.pMove(true, { z: ret() });
      break;
    }
    case 84: case 74: {
      const inDir = k === 84 ? 1 : -1;
      if (S.spindleDir !== inDir) I.spindleOp(S.rpm, inDir);
      I.pMove(false, { z: c.zZ }, f);
      I.dwell(c.p);
      I.spindleOp(S.rpm, -inDir);
      const mult = c.jRaw > 0 ? c.jRaw : 1;
      I.pMove(false, { z: c.rZ }, f * mult);
      I.spindleOp(S.rpm, inDir);
      if (S.retract === 98 && c.init > c.rZ) I.pMove(true, { z: c.init });
      break;
    }
    case 85: case 89:
      I.pMove(false, { z: c.zZ }, f);
      if (k === 89) I.dwell(c.p);
      I.pMove(false, { z: c.rZ }, f);
      if (S.retract === 98 && c.init > c.rZ) I.pMove(true, { z: c.init });
      break;
    case 86:
      I.pMove(false, { z: c.zZ }, f);
      I.spindleOp(0, 0);
      I.pMove(true, { z: ret() });
      if (dir0) I.spindleOp(rpm0, dir0);
      break;
    case 76: {
      const [sx, sy] = shiftVec(I, c);
      I.pMove(false, { z: c.zZ }, f);
      I.dwell(c.p);
      I.spindleOp(0, 0); // spindle orient
      I.pMove(true, { x: x + sx, y: y + sy });
      I.pMove(true, { z: ret() });
      I.pMove(true, { x, y });
      if (dir0) I.spindleOp(rpm0, dir0);
      break;
    }
    default:
      I.alarm(311, `${g2(k)} is not a canned cycle`);
  }
}

function backBore(I, c, x, y) {
  const S = I.S;
  const [sx, sy] = shiftVec(I, c);
  const dir0 = S.spindleDir || 1, rpm0 = S.rpm;
  I.spindleOp(0, 0);
  I.pMove(true, { x: x + sx, y: y + sy });
  I.pMove(true, { z: c.rZ });
  I.pMove(true, { x, y });
  I.spindleOp(rpm0, dir0);
  I.pMove(false, { z: c.zZ }, c.feed);
  I.dwell(c.p);
  I.spindleOp(0, 0);
  I.pMove(true, { x: x + sx, y: y + sy });
  I.pMove(true, { z: c.init });
  I.pMove(true, { x, y });
  I.spindleOp(rpm0, dir0);
}

// ------------------------------------------------------------------------------------------ G70 G71 G72
export function boltPattern(I, nm, c, a) {
  const P0 = I.curP();
  const L = a.L;
  if (L === undefined || L < 1) I.alarm(331, `${g2(nm)} needs L (number of holes)`);
  if (a.I === undefined) I.alarm(331, `${g2(nm)} needs I (${nm === 72 ? 'spacing' : 'radius'})`);
  const J = a.J || 0;
  const holes = [];
  if (nm === 70 || nm === 71) {
    let r = a.I, start = J;
    if (r < 0) { r = -r; start += 180; }
    if (nm === 71 && a.K === undefined) I.alarm(331, 'G71 needs K (angle between holes)');
    const step = nm === 70 ? 360 / L : a.K;
    for (let n = 0; n < L; n++) {
      const t = (start + n * step) * D2R;
      holes.push([P0.x + r * Math.cos(t), P0.y + r * Math.sin(t)]);
    }
  } else {
    const t = J * D2R;
    for (let n = 0; n < L; n++) holes.push([P0.x + n * a.I * Math.cos(t), P0.y + n * a.I * Math.sin(t)]);
  }
  for (const [x, y] of holes) cannedHole(I, c, x, y);
}

// ------------------------------------------------------------------------------------------ G12 G13
export function circPocket(I, nm, { w1, dim, intW }) {
  const S = I.S;
  const cw = nm === 12;
  if (w1.I === undefined) I.alarm(331, `${g2(nm)} needs I (radius of the first circle, or the finish radius without K)`);
  if (!w1.Z) I.alarm(331, `${g2(nm)} needs Z (depth, or the depth per pass with G91)`);
  const d = intW('D', 331, 0, 200) ?? 0;
  const r = d ? I.dRadius(d) : 0;
  if (d && !I.toolData(d)) I.warn(`D${String(d).padStart(2, '0')} has no tool in the tool table; the pocket is cut at the tool centre`);
  const Ir = dim('I');
  const K = w1.K ? dim('K') : undefined;
  const Q = w1.Q ? dim('Q') : undefined;
  if (!(Ir > 0)) I.alarm(331, `${g2(nm)}: I must be positive`);
  if (Ir <= r + 1e-9) I.alarm(331, `${g2(nm)}: I ${fmt(I, Ir)} must be larger than the tool radius ${fmt(I, r)} (D${d})`);
  if (K !== undefined) {
    if (K < Ir - 1e-9) I.alarm(331, `${g2(nm)}: K (finish radius) must not be smaller than I`);
    if (!(Q > 0)) I.alarm(331, `${g2(nm)}: K needs a step-over Q`);
    if (Q > 2 * r + 1e-9 && r > 0) I.warn(`${g2(nm)}: step-over Q ${fmt(I, Q)} is larger than the cutter diameter; material is left between the circles`);
  }
  const f = I.feedNow(I.curWord);
  // centre
  let P = I.curP();
  if (w1.X || w1.Y) {
    const x = w1.X ? (S.dist === 90 ? dim('X') : P.x + dim('X')) : P.x;
    const y = w1.Y ? (S.dist === 90 ? dim('Y') : P.y + dim('Y')) : P.y;
    I.pMove(true, { x, y });
    P = I.curP();
  }
  const cx = P.x, cy = P.y;
  const radii = [];
  if (K === undefined) radii.push(Ir);
  else {
    for (let rr = Ir; rr < K - 1e-9; rr += Q) radii.push(rr);
    radii.push(K);
  }
  const path = radii.map((rr) => rr - r);
  const passes = S.dist === 91 ? intW('L', 331, 1, 32767) ?? 1 : 1;
  for (let p = 0; p < passes; p++) {
    const z = S.dist === 91 ? I.curP().z + dim('Z') : dim('Z');
    I.pMove(false, { z }, f);
    let side = 1; // +1: at angle 0 (3 o'clock), -1: at angle 180
    let prev = 0;
    path.forEach((rc) => {
      // semicircle from the previous radius (or the centre) to rc on the other side, then a full circle
      const from = prev * (prev ? side : 1);
      const toSide = prev ? -side : 1;
      const ex = cx + rc * toSide;
      const mid = cx + (from + rc * toSide) / 2;
      I.pArc({ x: ex, y: cy }, { x: mid, y: cy }, cw, f);
      I.pArc({ x: ex, y: cy }, { x: cx, y: cy }, cw, f);
      side = toSide;
      prev = rc;
    });
    // lead out to the centre
    const ex = cx + prev * side;
    I.pArc({ x: cx, y: cy }, { x: (ex + cx) / 2, y: cy }, cw, f);
  }
}

// ------------------------------------------------------------------------------------------ G150
// Reads the pocket outline subprogram: local N<P> first, then program O<P>. Returns elements in P space:
// first element = start hole -> pocket edge, last element ends at the edge point again.
function readContour(I, P, S0) {
  let prog, start;
  const local = I.prog.nMap.get(P);
  if (local != null) { prog = I.prog; start = local; }
  else {
    const f = I.findProgram(P, I.curWord, 314);
    prog = f.prog;
    start = f.start + (prog.blocks[f.start]?.o === P ? 1 : 0);
  }
  const S = I.S;
  const u = I.uScale(), inc = S.units === 20 ? 1e-4 : 1e-3;
  let dist = S.dist, motion = 1;
  let cur = { x: S0.x, y: S0.y };
  const els = [];
  for (let i = start; i < prog.blocks.length; i++) {
    const b = prog.blocks[i];
    if (i > start && b.o != null) break;
    if (b.errors.length) I.alarm(532, `pocket outline line ${b.line + 1}: ${b.errors[0].msg}`);
    const W = {};
    let end = false;
    for (const it of b.items) {
      if (it.t !== 'word') I.alarm(532, `the G150 outline (line ${b.line + 1}) cannot contain macro statements`);
      if (it.kind !== 'num') I.alarm(532, `the G150 outline (line ${b.line + 1}) cannot contain macro variables`);
      if (it.a === 'M' && it.v === 99) end = true;
      if (it.a === 'G') {
        if (it.v === 90 || it.v === 91) dist = it.v;
        else if (it.v >= 1 && it.v <= 3) motion = it.v;
        else if (it.v === 0) I.alarm(532, `G00 is not allowed in the G150 outline (line ${b.line + 1})`);
      } else if ('XYIJR'.includes(it.a)) W[it.a] = (it.dec ? it.v : it.v * inc) * u;
    }
    if (W.X !== undefined || W.Y !== undefined) {
      const e = { x: cur.x, y: cur.y };
      if (W.X !== undefined) e.x = dist === 90 ? W.X : cur.x + W.X;
      if (W.Y !== undefined) e.y = dist === 90 ? W.Y : cur.y + W.Y;
      if (motion === 1) els.push({ kind: 'line', s: [cur.x, cur.y], e: [e.x, e.y], line: b.line });
      else {
        const cw = motion === 2;
        let c;
        if (W.I !== undefined || W.J !== undefined) c = [cur.x + (W.I || 0), cur.y + (W.J || 0)];
        else if (W.R !== undefined) {
          const R = W.R, dx = e.x - cur.x, dy = e.y - cur.y, d = Math.hypot(dx, dy);
          if (d < 1e-9 || d > 2 * Math.abs(R) + 1e-4) I.alarm(370, `invalid R arc in the outline (line ${b.line + 1})`);
          const h = Math.sqrt(Math.max(0, R * R - (d / 2) ** 2));
          const sg = (cw ? 1 : -1) * (R > 0 ? 1 : -1);
          c = [(cur.x + e.x) / 2 + (sg * h * dy) / d, (cur.y + e.y) / 2 - (sg * h * dx) / d];
        } else I.alarm(370, `arc without I/J or R in the outline (line ${b.line + 1})`);
        const rs = Math.hypot(cur.x - c[0], cur.y - c[1]), re = Math.hypot(e.x - c[0], e.y - c[1]);
        if (Math.abs(rs - re) > Math.max(0.02, rs * 0.001)) I.alarm(370, `arc end point not on the circle (line ${b.line + 1})`);
        els.push({ kind: 'arc', s: [cur.x, cur.y], e: [e.x, e.y], c, cw, line: b.line });
      }
      cur = e;
    }
    if (end) return els;
  }
  I.alarm(322, `G150 outline P${P} ends without M99`);
}

function linearize(els, tol = 0.01) {
  const pts = [];
  for (const el of els) {
    if (el.kind === 'line') { pts.push(el.e); continue; }
    const [cx, cy] = el.c;
    const r = Math.hypot(el.s[0] - cx, el.s[1] - cy);
    const as = Math.atan2(el.s[1] - cy, el.s[0] - cx), ae = Math.atan2(el.e[1] - cy, el.e[0] - cx);
    let sw = el.cw ? as - ae : ae - as;
    while (sw <= 1e-9) sw += 2 * Math.PI;
    const step = r > tol ? 2 * Math.acos(1 - tol / r) : Math.PI / 8;
    const n = Math.max(2, Math.ceil(sw / Math.min(step, Math.PI / 16)));
    for (let k = 1; k <= n; k++) {
      const t = as + (el.cw ? -1 : 1) * (sw * k) / n;
      pts.push(k === n ? el.e : [cx + r * Math.cos(t), cy + r * Math.sin(t)]);
    }
  }
  return pts;
}

function inside(poly, x, y) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function distPoly(poly, x, y) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j], [bx, by] = poly[i];
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(ax + t * dx - x, ay + t * dy - y);
    if (d < best) best = d;
  }
  return best;
}

// Zig-zag strokes inside the region { inside poly, distance to the outline >= d }.
// along = 'x': strokes along X, lines stepped in Y by `step` (and the reverse for 'y').
function strokes(poly, d, step, along) {
  const sw = along === 'x' ? (p) => p : (p) => [p[1], p[0]];
  const P = poly.map(sw);
  let vmin = Infinity, vmax = -Infinity;
  for (const p of P) { vmin = Math.min(vmin, p[1]); vmax = Math.max(vmax, p[1]); }
  const lo = vmin + d, hi = vmax - d;
  if (hi < lo - 1e-9) return [];
  const n = hi - lo < 1e-9 ? 0 : Math.max(1, Math.ceil((hi - lo) / step - 1e-9));
  const valid = (u, v) => inside(P, u, v) && distPoly(P, u, v) >= d - 1e-7;
  const out = [];
  for (let li = 0; li <= n; li++) {
    const v = n ? lo + ((hi - lo) * li) / n : (lo + hi) / 2;
    const xs = [];
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const [xi, yi] = P[i], [xj, yj] = P[j];
      if (yi > v !== yj > v) xs.push(xi + ((v - yi) * (xj - xi)) / (yj - yi));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = xs[k], b = xs[k + 1];
      const h = Math.max(0.02, Math.min(0.25, d / 3));
      const ns = Math.max(2, Math.ceil((b - a) / h));
      let runStart = null;
      const refine = (u0, u1) => {
        // u0 valid state differs from u1; find the boundary
        const s0 = valid(u0, v);
        for (let it = 0; it < 30; it++) {
          const m = (u0 + u1) / 2;
          if (valid(m, v) === s0) u0 = m; else u1 = m;
        }
        return s0 ? u0 : u1;
      };
      let prevU = a, prevOk = false;
      for (let s = 0; s <= ns; s++) {
        const uu = a + ((b - a) * s) / ns;
        const ok = valid(uu, v);
        if (ok && !prevOk) runStart = s === 0 ? uu : refine(prevU, uu);
        if (!ok && prevOk) {
          const end = refine(prevU, uu);
          if (end - runStart > 1e-3) out.push({ line: li, a: runStart, b: end, v });
          runStart = null;
        }
        prevU = uu;
        prevOk = ok;
      }
      if (prevOk && runStart != null && b - runStart > 1e-3) out.push({ line: li, a: runStart, b: prevU, v });
    }
  }
  const back = along === 'x' ? (u, v) => [u, v] : (u, v) => [v, u];
  return out.map((s) => ({ line: s.line, p0: back(s.a, s.v), p1: back(s.b, s.v) }));
}

function segOk(poly, r, a, b) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(1, Math.ceil(L / 0.2));
  for (let k = 0; k <= n; k++) {
    const x = a[0] + ((b[0] - a[0]) * k) / n, y = a[1] + ((b[1] - a[1]) * k) / n;
    if (!inside(poly, x, y) || distPoly(poly, x, y) < r - 1e-6) return false;
  }
  return true;
}

// Orders strokes into a zig-zag starting near `from`. Returns [{p0, p1}] (p0 = entry).
function orderStrokes(list, from) {
  const left = list.slice();
  const out = [];
  let cur = from;
  let lastLine = null, dir = 1;
  const d2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
  if (left.length) {
    const minLine = Math.min(...left.map((s) => s.line));
    const maxLine = Math.max(...left.map((s) => s.line));
    // start on the extreme line nearest to the start hole
    const cand = left.filter((s) => s.line === minLine || s.line === maxLine);
    cand.sort((a, b) => Math.min(d2(a.p0, from), d2(a.p1, from)) - Math.min(d2(b.p0, from), d2(b.p1, from)));
    const s = cand[0];
    dir = s.line === minLine ? 1 : -1;
    left.splice(left.indexOf(s), 1);
    const flip = d2(s.p1, from) < d2(s.p0, from);
    out.push(flip ? { p0: s.p1, p1: s.p0 } : { p0: s.p0, p1: s.p1 });
    cur = out[0].p1;
    lastLine = s.line;
  }
  while (left.length) {
    let pick = left.filter((s) => s.line === lastLine + dir);
    if (!pick.length) pick = left.filter((s) => s.line === lastLine - dir);
    if (!pick.length) pick = left;
    pick.sort((a, b) => Math.min(d2(a.p0, cur), d2(a.p1, cur)) - Math.min(d2(b.p0, cur), d2(b.p1, cur)));
    const s = pick[0];
    if (s.line !== lastLine + dir && Math.abs(s.line - lastLine) === 1) dir = -dir;
    left.splice(left.indexOf(s), 1);
    const flip = d2(s.p1, cur) < d2(s.p0, cur);
    const o = flip ? { p0: s.p1, p1: s.p0 } : { p0: s.p0, p1: s.p1 };
    out.push(o);
    cur = o.p1;
    lastLine = s.line;
  }
  return out;
}

function signedArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return a / 2;
}

export function generalPocket(I, { w1, dim, intW, side }) {
  const S = I.S;
  const Pn = intW('P', 315, 0, 99999);
  if (Pn === undefined) I.alarm(315, 'G150 needs P (outline subprogram)');
  if (w1.I && w1.J) I.alarm(331, 'G150: program I (step in X) or J (step in Y), not both');
  if (!w1.I && !w1.J) I.alarm(331, 'G150 needs I or J (roughing step-over)');
  const step = w1.I ? dim('I') : dim('J');
  if (!(step > 0)) I.alarm(331, 'G150: I / J must be positive');
  const K = w1.K ? dim('K') : 0;
  if (K < 0) I.alarm(331, 'G150: K (finish allowance) must be positive');
  if (!w1.Q) I.alarm(331, 'G150 needs Q (depth per pass from the R plane), even for one pass');
  const Q = dim('Q');
  if (!(Q > 0)) I.alarm(331, 'G150: Q must be positive');
  if (!w1.Z) I.alarm(331, 'G150 needs Z (final depth)');
  // R: required, else the last R
  let Rw = w1.R ? { v: w1.R.v, dec: w1.R.dec } : S.cyc.R;
  if (!Rw) I.alarm(331, 'G150 needs R (R plane), even R0');
  if (w1.R) S.cyc.R = Rw;
  const u = I.uScale(), inc = S.units === 20 ? 1e-4 : 1e-3;
  const rIn = (Rw.dec ? Rw.v : Rw.v * inc) * u;
  const d = intW('D', 331, 0, 200);
  const r = d !== undefined ? (d ? I.dRadius(d) : 0) : I.dRadius(S.tool);
  const f = I.feedNow(I.curWord);
  const reps = S.dist === 91 ? intW('L', 331, 1, 32767) ?? 1 : 1;
  const init = I.curP().z;
  for (let rep = 0; rep < reps; rep++) {
    const P0 = I.curP();
    const x0 = w1.X ? (S.dist === 90 ? dim('X') : P0.x + dim('X')) : P0.x;
    const y0 = w1.Y ? (S.dist === 90 ? dim('Y') : P0.y + dim('Y')) : P0.y;
    const rZ = S.dist === 90 ? rIn : init + rIn;
    const zZ = S.dist === 90 ? dim('Z') : rZ + dim('Z');
    if (zZ > rZ - 1e-9) I.alarm(331, 'G150: Z must be below the R plane');
    const els = readContour(I, Pn, { x: x0, y: y0 });
    if (els.length < 3) I.alarm(370, 'the outline needs a move to the pocket edge and a closed contour');
    if (els.length - 1 > 40) I.alarm(370, `the outline has ${els.length - 1} moves (40 at most)`);
    const lead = els[0];
    const contour = els.slice(1);
    const E0 = lead.e;
    const last = contour[contour.length - 1].e;
    if (Math.hypot(last[0] - E0[0], last[1] - E0[1]) > 0.01) I.alarm(370, `the outline is not closed: it ends at X${fmt(I, last[0])} Y${fmt(I, last[1])} instead of X${fmt(I, E0[0])} Y${fmt(I, E0[1])}`);
    const poly = linearize(contour);
    if (!inside(poly, x0, y0) || distPoly(poly, x0, y0) < r - 1e-6) I.alarm(370, `the start point X${fmt(I, x0)} Y${fmt(I, y0)} is not inside the pocket (by at least the tool radius)`);
    // compensation side: G41/G42 from the block, else the side that keeps the tool inside
    const ccw = signedArea(poly) > 0;
    let cside = side === 41 ? 1 : side === 42 ? -1 : ccw ? 1 : -1;
    if (I.mirrorFlip(17)) { /* the outline is mirrored with the program: the material side is unchanged */ }
    const list = strokes(poly, r + K, step, w1.I ? 'y' : 'x');
    const levels = [];
    for (let z = rZ - Q; z > zZ + 1e-9; z -= Q) levels.push(z);
    levels.push(zZ);
    const contourPass = (rad, z) => {
      const items = [{ kind: 'line', s: [x0, y0], e: E0, z0: z, z1: z, feed: f, line: I.line }];
      for (const el of contour) items.push({ ...el, z0: z, z1: z, feed: f, line: I.line });
      items.push({ kind: 'line', s: E0, e: [x0, y0], z0: z, z1: z, feed: f, line: I.line });
      const out = rad > 1e-9 ? compensate(items, cside, rad, { approach: true, retract: true }) : items;
      for (const it of out) {
        if (it.kind === 'line') I.pMove(false, { x: it.e[0], y: it.e[1] }, f);
        else if (it.kind === 'arc') I.pArc({ x: it.e[0], y: it.e[1] }, { x: it.c[0], y: it.c[1] }, it.cw, f);
      }
    };
    I.pMove(true, { x: x0, y: y0 });
    I.pMove(true, { z: rZ });
    const ordered = orderStrokes(list, [x0, y0]);
    for (const z of levels) {
      const here = I.curP();
      if (Math.hypot(here.x - x0, here.y - y0) > 1e-6) {
        if (segOk(poly, r, [here.x, here.y], [x0, y0])) I.pMove(false, { x: x0, y: y0 }, f);
        else { I.pMove(true, { z: rZ }); I.pMove(true, { x: x0, y: y0 }); }
      }
      I.pMove(false, { z }, f);
      contourPass(r + K, z);
      let cur = [x0, y0];
      for (const s of ordered) {
        if (segOk(poly, r, cur, s.p0)) I.pMove(false, { x: s.p0[0], y: s.p0[1] }, f);
        else {
          I.pMove(true, { z: rZ });
          I.pMove(true, { x: s.p0[0], y: s.p0[1] });
          I.pMove(false, { z }, f);
        }
        I.pMove(false, { x: s.p1[0], y: s.p1[1] }, f);
        cur = s.p1;
      }
    }
    // finish pass at full depth along the outline
    if (K > 1e-9) {
      const here = I.curP();
      if (Math.hypot(here.x - x0, here.y - y0) > 1e-6) {
        if (segOk(poly, r, [here.x, here.y], [x0, y0])) I.pMove(false, { x: x0, y: y0 }, f);
        else { I.pMove(true, { z: rZ }); I.pMove(true, { x: x0, y: y0 }); I.pMove(false, { z: zZ }, f); }
      }
      contourPass(r, zZ);
    }
    I.pMove(true, { z: rZ });
  }
}
