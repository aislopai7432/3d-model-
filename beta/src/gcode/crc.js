// Cutter radius compensation (G41 / G42) in the XY plane, plus corner rounding/chamfering (RND/CHR).
//
// Works on a buffered list of path items in program coordinates:
//   { kind: 'line', s:[x,y], e:[x,y], z0, z1, rapid, feed, line }
//   { kind: 'arc',  s, e, c:[cx,cy], cw, z0, z1, feed, line }
//   { kind: 'other', ... }   (Z-only moves, dwells, M functions: passed through in order)
// Convex corners get a transition circle around the programmed corner (Siemens G450 behaviour),
// concave corners are trimmed to the intersection of the offset elements. The approach element
// (the block that switched compensation on) ends perpendicular to the first contour element, and the
// retract element (the G40 block) starts from the last offset point.

export class CompError extends Error {
  constructor(msg, line) {
    super(msg);
    this.line = line;
  }
}

const EPS = 1e-9;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const len = (a) => Math.hypot(a[0], a[1]);
const unit = (a) => {
  const l = len(a);
  return l < EPS ? [0, 0] : [a[0] / l, a[1] / l];
};
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const leftN = (d) => [-d[1], d[0]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function tangentAt(el, atEnd) {
  if (el.kind === 'line') return unit(sub(el.e, el.s));
  const p = atEnd ? el.e : el.s;
  const r = sub(p, el.c);
  const t = el.cw ? [r[1], -r[0]] : [-r[1], r[0]];
  return unit(t);
}

function arcRadius(el) {
  return dist(el.s, el.c);
}

// Offset a single element by r to `side` (+1 left, -1 right). Returns a geometric copy.
function offsetEl(el, side, r) {
  if (el.kind === 'line') {
    const n = mul(leftN(unit(sub(el.e, el.s))), side * r);
    return { ...el, s: add(el.s, n), e: add(el.e, n) };
  }
  const R = arcRadius(el);
  const R2 = R + r * side * (el.cw ? 1 : -1);
  if (R2 <= 1e-6) throw new CompError(`Tool radius ${r.toFixed(3)} is too large for the inside arc of radius ${R.toFixed(3)}`, el.line);
  const k = R2 / R;
  return { ...el, s: add(el.c, mul(sub(el.s, el.c), k)), e: add(el.c, mul(sub(el.e, el.c), k)), R: R2 };
}

// Intersections of two offset elements (infinite lines / full circles), nearest to `near`.
function intersect(a, b, near) {
  const pts = [];
  const lineLine = (p1, d1, p2, d2) => {
    const den = cross(d1, d2);
    if (Math.abs(den) < 1e-12) return;
    const t = cross(sub(p2, p1), d2) / den;
    pts.push(add(p1, mul(d1, t)));
  };
  const lineCircle = (p, d, c, R) => {
    const f = sub(p, c);
    const A = dot(d, d), B = 2 * dot(f, d), C = dot(f, f) - R * R;
    const disc = B * B - 4 * A * C;
    if (disc < -1e-9) return;
    const s = Math.sqrt(Math.max(0, disc));
    pts.push(add(p, mul(d, (-B - s) / (2 * A))), add(p, mul(d, (-B + s) / (2 * A))));
  };
  const circleCircle = (c1, r1, c2, r2) => {
    const d = dist(c1, c2);
    if (d < 1e-12 || d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return;
    const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
    const u = unit(sub(c2, c1));
    const m = add(c1, mul(u, a));
    const n = leftN(u);
    pts.push(add(m, mul(n, h)), add(m, mul(n, -h)));
  };
  const R = (e) => e.R ?? dist(e.s, e.c);
  if (a.kind === 'line' && b.kind === 'line') lineLine(a.s, sub(a.e, a.s), b.s, sub(b.e, b.s));
  else if (a.kind === 'line') lineCircle(a.s, sub(a.e, a.s), b.c, R(b));
  else if (b.kind === 'line') lineCircle(b.s, sub(b.e, b.s), a.c, R(a));
  else circleCircle(a.c, R(a), b.c, R(b));
  let best = null, bd = Infinity;
  for (const p of pts) {
    const d = dist(p, near);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

// Main entry. items[0..] in order; `approach` marks items[0] as the approach move (if it is a line),
// `retract` marks the last item as the G40 retract move.
export function compensate(items, side, r, { approach = true, retract = true } = {}) {
  if (r <= 1e-9) return items;
  const geo = items.filter((it) => it.kind === 'line' || it.kind === 'arc');
  if (!geo.length) return items;
  const out = [];
  // indices of geometry items
  const idx = items.map((it, i) => (it.kind === 'line' || it.kind === 'arc' ? i : -1)).filter((i) => i >= 0);
  const first = approach ? 1 : 0;
  const last = retract && idx.length > 1 ? idx.length - 2 : idx.length - 1;
  if (first > last) {
    // only approach and retract, nothing to offset
    return items;
  }
  const offs = [];
  for (let k = first; k <= last; k++) offs[k] = offsetEl(items[idx[k]], side, r);
  let cur = null; // current compensated tool position
  const emitPassthrough = (from, to) => {
    for (let i = from; i < to; i++) if (items[i].kind === 'other') out.push(items[i]);
  };
  // approach
  if (approach) {
    const ap = items[idx[0]];
    emitPassthrough(0, idx[0]);
    out.push({ ...ap, e: offs[first].s });
    cur = offs[first].s;
    emitPassthrough(idx[0] + 1, idx[first]);
  } else {
    emitPassthrough(0, idx[first]);
    cur = offs[first].s;
  }
  for (let k = first; k <= last; k++) {
    const el = items[idx[k]];
    const o = offs[k];
    if (k === last) {
      out.push(trimmed(o, cur, o.e));
      cur = o.e;
      break;
    }
    const nx = items[idx[k + 1]];
    const on = offs[k + 1];
    const tA = tangentAt(el, true), tB = tangentAt(nx, false);
    const cr = cross(tA, tB), dt = dot(tA, tB);
    const J = el.e;
    if (Math.abs(cr) < 1e-7 && dt > 0 && dist(o.e, on.s) < 1e-6) {
      out.push(trimmed(o, cur, o.e));
      cur = o.e;
    } else if (cr * side < 0 || (Math.abs(cr) < 1e-7 && dt < 0)) {
      // convex corner: go to the end of this element, then round the corner
      out.push(trimmed(o, cur, o.e));
      emitPassthrough(idx[k] + 1, idx[k + 1]);
      out.push({ kind: 'arc', s: o.e, e: on.s, c: [J[0], J[1]], cw: side > 0, z0: el.z1, z1: el.z1, feed: nx.feed, rapid: nx.rapid, line: nx.line, transition: true });
      cur = on.s;
      continue;
    } else {
      // concave corner: trim both elements to their intersection
      const X = intersect(o, on, add(J, mul(unit(add(leftN(tA), leftN(tB))), side * r)));
      if (!X || dist(X, J) > 50 * r + 50) throw new CompError(`Tool radius compensation: no intersection at the corner (contour too narrow for a ${(2 * r).toFixed(2)} mm tool)`, nx.line);
      checkGouge(el, o, cur, X);
      out.push(trimmed(o, cur, X));
      cur = X;
      offs[k + 1] = { ...on, s: X };
    }
    emitPassthrough(idx[k] + 1, idx[k + 1]);
  }
  // retract
  if (retract && idx.length > 1 && last < idx.length - 1) {
    emitPassthrough(idx[last] + 1, idx[idx.length - 1]);
    const rt = items[idx[idx.length - 1]];
    out.push({ ...rt, kind: 'line', s: cur });
    emitPassthrough(idx[idx.length - 1] + 1, items.length);
  } else emitPassthrough(idx[last] + 1, items.length);
  return out;
}

function trimmed(o, s, e) {
  return { ...o, s, e };
}

function checkGouge(el, o, s, e) {
  if (el.kind !== 'line') return;
  const d0 = sub(el.e, el.s), d1 = sub(e, s);
  if (dot(d0, d1) < -1e-9) throw new CompError('Tool radius compensation: contour element shorter than the tool radius allows (the tool would gouge the contour)', el.line);
}

// RND / CHR between two straight lines meeting at J. Returns [line1', corner, line2'].
export function roundCorner(l1, l2, rnd, chr) {
  const u1 = unit(sub(l1.e, l1.s)), u2 = unit(sub(l2.e, l2.s));
  const L1 = dist(l1.s, l1.e), L2 = dist(l2.s, l2.e);
  const J = l1.e;
  const cr = cross(u1, u2);
  if (Math.abs(cr) < 1e-9) return null; // collinear: nothing to round
  if (chr) {
    if (chr > L1 || chr > L2) throw new CompError(`CHR=${chr} is longer than the adjacent element`, l1.line);
    const T1 = sub(J, mul(u1, chr)), T2 = add(J, mul(u2, chr));
    return [{ ...l1, e: T1 }, { kind: 'line', s: T1, e: T2, z0: l1.z1, z1: l1.z1, feed: l2.feed, rapid: false, line: l1.line }, { ...l2, s: T2 }];
  }
  const phi = Math.acos(Math.max(-1, Math.min(1, dot(mul(u1, -1), u2))));
  const d = rnd / Math.tan(phi / 2);
  if (d > L1 + 1e-9 || d > L2 + 1e-9) throw new CompError(`RND=${rnd} does not fit between the adjacent elements`, l1.line);
  const T1 = sub(J, mul(u1, d)), T2 = add(J, mul(u2, d));
  const n = cr > 0 ? leftN(u1) : mul(leftN(u1), -1);
  const C = add(T1, mul(n, rnd));
  return [{ ...l1, e: T1 }, { kind: 'arc', s: T1, e: T2, c: C, cw: cr < 0, z0: l1.z1, z1: l1.z1, feed: l2.feed, line: l1.line }, { ...l2, s: T2 }];
}
