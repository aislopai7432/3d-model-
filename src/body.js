// Procedural body shell.
//
// The body is one lofted surface. Every cross-section is a closed centripetal
// Catmull-Rom curve through 12 control points whose positions are driven by
// longitudinal profile curves (width, sill, beltline, roof...). The ends are
// closed by super-elliptic caps that shrink the section towards a point.
//
// Surface parameters:
//   u   – longitudinal coordinate in metres (front of car is +x). Inside the
//         caps u keeps running past the end stations, so a single number
//         addresses every point from the rear tip to the front tip.
//   i   – position around the section, 0..12. 0 = underside centre,
//         3 = widest point, 4 = beltline, 5 = roof edge, 6 = roof centre,
//         7..11 mirror the right side onto the left.
//
// Panel boundaries (doors, glass, lamps, intakes) are inserted into the grid
// as exact grid lines, so every panel can be cut out of the shell with clean
// edges and turned into its own mesh (separate door, recessed intakes...).
import * as THREE from 'three';

export const D = {
  xFm: 2.06, rF: 0.20, pF: 2.6, kF: 0.36,
  xRm: -2.11, rR: 0.12, pR: 4.2, kR: 0.22,
  axleF: 1.38, axleR: -1.30, wheelR: 0.345, archR: 0.392, zInner: 0.60,
  trackF: 0.80, trackR: 0.80, driverZ: 0.37,
};

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

// Fritsch–Carlson monotone cubic: smooth profiles without overshoot.
function mono(keys) {
  const n = keys.length, xs = keys.map((k) => k[0]), ys = keys.map((k) => k[1]);
  const d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

// ---- Longitudinal profiles (x from rear to front, metres) -----------------
const W = mono([[-2.11, 0.875], [-1.92, 0.935], [-1.62, 0.975], [-1.3, 0.985], [-0.95, 0.975], [-0.5, 0.932], [0.1, 0.922], [0.7, 0.934], [1.38, 0.956], [1.8, 0.928], [2.06, 0.845]]);
const YB = mono([[-2.11, 0.28], [-1.75, 0.17], [-1.45, 0.125], [1.55, 0.12], [1.85, 0.13], [2.06, 0.17]]);
const YBELT = mono([[-2.11, 0.95], [-1.75, 0.962], [-1.35, 0.962], [-0.7, 0.93], [0, 0.9], [0.6, 0.872], [1.1, 0.838], [1.4, 0.818], [1.75, 0.758], [2.06, 0.668]]);
const YTOP = mono([[-2.11, 0.985], [-1.98, 0.975], [-1.7, 0.985], [-1.4, 1.02], [-1.0, 1.085], [-0.65, 1.17], [-0.3, 1.222], [-0.02, 1.232], [0.18, 1.215], [0.35, 1.17], [0.6, 1.075], [0.86, 0.94], [1.0, 0.885], [1.25, 0.84], [1.5, 0.8], [1.75, 0.745], [2.06, 0.655]]);
const CAB = mono([[-2.11, 0], [-1.6, 0.05], [-1.25, 0.45], [-0.8, 0.92], [-0.4, 1], [0.35, 1], [0.65, 0.75], [0.92, 0.1], [1.1, 0], [2.06, 0]]);
const ROOFW = mono([[-1.3, 0.5], [-0.7, 0.585], [0.0, 0.62], [0.6, 0.64], [0.9, 0.66]]);
// Sculpted lower-door scallop that flows back into the side intake.
const SCALLOP = mono([[-1.0, 0], [-0.82, 0.028], [-0.5, 0.05], [0.2, 0.046], [0.65, 0.022], [0.95, 0]]);

export const PROFILE = { W, YB, YBELT, YTOP };
const YCF = (YB(D.xFm) + YTOP(D.xFm)) / 2;
const YCR = (YB(D.xRm) + YTOP(D.xRm)) / 2;

const SEC = new Float64Array(24);
let secX = NaN;
function section(xb) {
  if (xb === secX) return SEC;
  secX = xb;
  const w = W(xb), yb = YB(xb), ybelt = YBELT(xb), ytop = YTOP(xb), cab = CAB(xb);
  const ys = yb + 0.58 * (ybelt - yb);
  const wb = w - 0.095;
  const wr = lerp(0.62 * wb, ROOFW(xb), cab);
  const y5 = ybelt + 0.9 * (ytop - ybelt);
  const half = [[0, yb], [w - 0.16, yb], [w - 0.04, yb + 0.075], [w, ys], [wb, ybelt], [wr, y5], [0, ytop]];
  for (let k = 0; k <= 6; k++) { SEC[k * 2] = half[k][0]; SEC[k * 2 + 1] = half[k][1]; }
  for (let k = 7; k < 12; k++) { SEC[k * 2] = -half[12 - k][0]; SEC[k * 2 + 1] = half[12 - k][1]; }
  return SEC;
}

// Centripetal Catmull-Rom on the closed 12-point section.
function crEval(P, t, out) {
  t = ((t % 12) + 12) % 12;
  const i = Math.floor(t), f = t - i;
  const a = (i + 11) % 12, b = i, c = (i + 1) % 12, d = (i + 2) % 12;
  const x0 = P[a * 2], y0 = P[a * 2 + 1], x1 = P[b * 2], y1 = P[b * 2 + 1];
  const x2 = P[c * 2], y2 = P[c * 2 + 1], x3 = P[d * 2], y3 = P[d * 2 + 1];
  const t1 = Math.pow(Math.hypot(x1 - x0, y1 - y0), 0.5) || 1e-4;
  const t2 = t1 + (Math.pow(Math.hypot(x2 - x1, y2 - y1), 0.5) || 1e-4);
  const t3 = t2 + (Math.pow(Math.hypot(x3 - x2, y3 - y2), 0.5) || 1e-4);
  const tt = t1 + f * (t2 - t1);
  const A1x = ((t1 - tt) * x0 + tt * x1) / t1, A1y = ((t1 - tt) * y0 + tt * y1) / t1;
  const A2x = ((t2 - tt) * x1 + (tt - t1) * x2) / (t2 - t1), A2y = ((t2 - tt) * y1 + (tt - t1) * y2) / (t2 - t1);
  const A3x = ((t3 - tt) * x2 + (tt - t2) * x3) / (t3 - t2), A3y = ((t3 - tt) * y2 + (tt - t2) * y3) / (t3 - t2);
  const B1x = ((t2 - tt) * A1x + tt * A2x) / t2, B1y = ((t2 - tt) * A1y + tt * A2y) / t2;
  const B2x = ((t3 - tt) * A2x + (tt - t1) * A3x) / (t3 - t1), B2y = ((t3 - tt) * A2y + (tt - t1) * A3y) / (t3 - t1);
  out[0] = ((t2 - tt) * B1x + (tt - t1) * B2x) / (t2 - t1);
  out[1] = ((t2 - tt) * B1y + (tt - t1) * B2y) / (t2 - t1);
  return out;
}

const uFrontTip = D.xFm + D.rF, uRearTip = D.xRm - D.rR;
// Cap parameter conversions (front: s = section scale, 1 at the cap start, 0 at the tip).
export const capSF = (u) => Math.pow(Math.cos(clamp01((u - D.xFm) / D.rF) * Math.PI / 2), 2 / D.pF);
export const capSR = (u) => Math.pow(Math.cos(clamp01((D.xRm - u) / D.rR) * Math.PI / 2), 2 / D.pR);
export const uFromSF = (s) => D.xFm + D.rF * Math.acos(Math.pow(s, D.pF / 2)) / (Math.PI / 2);
export const uFromSR = (s) => D.xRm - D.rR * Math.acos(Math.pow(s, D.pR / 2)) / (Math.PI / 2);

const tmp2 = [0, 0];
// Raw surface point (before wheel-arch trimming).
export function surfacePoint(u, i, out = new THREE.Vector3()) {
  let xb, s = 1, dx = 0, cap = 0;
  if (u > D.xFm) {
    const ph = Math.min(1, (u - D.xFm) / D.rF) * Math.PI / 2;
    s = Math.pow(Math.max(0, Math.cos(ph)), 2 / D.pF);
    dx = D.rF * Math.pow(Math.sin(ph), 2 / D.pF);
    xb = D.xFm; cap = 1;
  } else if (u < D.xRm) {
    const ph = Math.min(1, (D.xRm - u) / D.rR) * Math.PI / 2;
    s = Math.pow(Math.max(0, Math.cos(ph)), 2 / D.pR);
    dx = -D.rR * Math.pow(Math.sin(ph), 2 / D.pR);
    xb = D.xRm; cap = -1;
  } else xb = u;
  const P = section(xb);
  crEval(P, i, tmp2);
  let z = tmp2[0], y = tmp2[1], x = xb;
  if (cap) {
    const yc = cap > 0 ? YCF : YCR;
    // Blend the ring from the true section (at the cap edge) towards a smooth
    // super-ellipse (towards the tip), so section corners don't converge into ridges.
    const w = s * s * s;
    if (w < 1) {
      const a = P[6], bTop = P[13] - yc, bBot = yc - P[1];
      const th = (i - 3) * Math.PI / 6, c = Math.cos(th), sn = Math.sin(th), n = 3.2;
      const ez = a * Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
      const ey = yc + (sn >= 0 ? bTop : bBot) * Math.sign(sn) * Math.pow(Math.abs(sn), 2 / n);
      z = ez + (z - ez) * w;
      y = ey + (y - ey) * w;
    }
    y = yc + (y - yc) * s;
    z *= s;
    if (cap > 0) x = xb + dx - D.kF * (y - yc) * (dx / D.rF);
    else x = xb + dx + D.kR * (yc - y) * (-dx / D.rR);
  } else {
    const sc = SCALLOP(xb);
    if (sc > 0) {
      const az = Math.abs(z);
      const fy = Math.exp(-Math.pow((y - 0.43) / 0.13, 2));
      const fz = clamp01((az - 0.55) / 0.2);
      z -= Math.sign(z) * sc * fy * fz;
    }
  }
  return out.set(x, y, z);
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
// Point + outward normal, for placing parts on the skin.
export function surfaceFrame(u, i) {
  const p = surfacePoint(u, i);
  const du = 0.004, di = 0.01;
  surfacePoint(u + du, i, _a);
  surfacePoint(u - du, i, _b);
  surfacePoint(u, i + di, _c);
  surfacePoint(u, i - di, _d);
  const tu = _a.sub(_b), ti = _c.sub(_d);
  const n = new THREE.Vector3().crossVectors(tu, ti).normalize();
  return { p, n, tu: tu.clone().normalize(), ti: ti.clone().normalize() };
}

// ---- Wheel arches -----------------------------------------------------------
function insideArch(x, y, z) {
  if (Math.abs(z) <= D.zInner) return false;
  for (const xc of [D.axleF, D.axleR]) {
    const dx = x - xc, dy = y - D.wheelR;
    if (dy <= 0 ? Math.abs(dx) < D.archR : dx * dx + dy * dy < D.archR * D.archR) return true;
  }
  return false;
}
function snapArch(p) {
  for (const xc of [D.axleF, D.axleR]) {
    const dx = p.x - xc, dy = p.y - D.wheelR;
    const inside = dy <= 0 ? Math.abs(dx) < D.archR : dx * dx + dy * dy < D.archR * D.archR;
    if (!inside || Math.abs(p.z) <= D.zInner) continue;
    if (dy <= 0) p.x = xc + Math.sign(dx || 1) * D.archR;
    else { const l = Math.hypot(dx, dy); p.x = xc + dx / l * D.archR; p.y = D.wheelR + dy / l * D.archR; }
  }
}

// ---- Panel layout -------------------------------------------------------------
const mirrorJ = (i) => (i <= 6 ? i : 12 - i);
const vWin = (j) => clamp01((j - 4.12) / 0.76);
const bDoor = (j) => clamp01((j - 2.1) / 2.02);
export const xDF = (j) => (j < 4.12 ? lerp(0.95, 0.9, bDoor(j)) : 0.9);
export const xA = (j) => (j < 4.12 ? 0.8 : lerp(0.8, 0.2, vWin(j)));
export const xDR = (j) => (j < 4.12 ? lerp(-0.28, -0.4, bDoor(j)) : lerp(-0.4, -0.26, vWin(j)));
export const xC = (j) => (j < 4.12 ? -0.98 : lerp(-0.98, -0.6, vWin(j)));
// Side intake: leading edge follows the door shut line, trailing edge rakes forward.
const kInt = (j) => clamp01((j - 3.0) / 0.95);
export const xIF = (j) => xDR(j) - 0.1;
export const xIR = (j) => lerp(-0.9, -0.77, kInt(j));
const CONST_BREAKS = [-1.3, -0.74, 0.1, 0.86, 1.9];
const ROW_BREAKS = [1.0, 1.35, 1.5, 2.1, 2.75, 3.0, 3.5, 3.95, 4.12, 4.3, 4.7, 4.88, 5.12, 5.3];
const CAPF_BREAKS = [0.25, 0.86, 0.45, 0.88, 0.62];
const CAPR_BREAKS = [0.66, 0.78, 0.25, 0.86];
export const LAYOUT = { CAPF_BREAKS, CAPR_BREAKS };

function midBreaks(i) {
  const j = mirrorJ(i);
  const b = [xDF(j), xA(j), xDR(j), xC(j), xIF(j), xIR(j), ...CONST_BREAKS];
  b.sort((p, q) => p - q);
  return [D.xRm, ...b, D.xFm];
}

export function classify(u, i) {
  const j = mirrorJ(i), side = i < 6 ? 'R' : 'L';
  if (u > D.xFm) {
    const s = capSF(u);
    if (j <= 1.0 && s >= 0.25 && s <= 0.86) return 'grille';
    if (j >= 1.35 && j <= 2.75 && s >= 0.45 && s <= 0.88) return 'intakeF' + side;
    if (j >= 3.5 && j <= 4.7 && s >= 0.62) return 'head' + side;
    return 'body';
  }
  if (u < D.xRm) {
    const s = capSR(u);
    if (j >= 4.3 && s >= 0.66 && s <= 0.78) return 'tail';
    if (j <= 1.5 && s >= 0.25 && s <= 0.86) return 'diffuser';
    return 'body';
  }
  if (j >= 3.5 && j <= 4.7 && u >= 1.9) return 'head' + side;
  if (j <= 1.0) return 'under';
  if (j >= 2.1 && j <= 4.88) {
    const f = j < 4.12 ? xDF(j) : xA(j);
    if (u >= xDR(j) && u <= f) return (j >= 4.12 ? 'dglass' : 'door') + side;
  }
  if (j >= 4.12 && j <= 4.88 && u >= xC(j) && u <= xDR(j)) return 'qglass' + side;
  if (j >= 3.0 && j <= 3.95 && u >= xIR(j) && u <= xIF(j)) return 'sideIntake' + side;
  if (j >= 5.12 && u >= 0.1 && u <= 0.86) return 'windshield';
  if (j >= 5.3 && u >= -1.3 && u <= -0.74) return 'rearGlass';
  return 'body';
}

// ---- Grid construction ------------------------------------------------------
export function buildShell() {
  // Rows (around the section)
  const rowSet = new Set();
  const NI = 264;
  for (let k = 0; k < NI; k++) rowSet.add(+(k * 12 / NI).toFixed(5));
  for (const b of ROW_BREAKS) { rowSet.add(b); rowSet.add(+(12 - b).toFixed(5)); }
  rowSet.add(6);
  let rows = [...rowSet].sort((a, b) => a - b);
  // merge rows that are closer than 0.012 unless one is a break line
  const isBreak = (v) => ROW_BREAKS.some((b) => Math.abs(b - v) < 1e-6 || Math.abs(12 - b - v) < 1e-6) || v === 6 || v === 0;
  const merged = [];
  for (const r of rows) {
    const last = merged[merged.length - 1];
    if (last !== undefined && r - last < 0.012) {
      if (isBreak(r) && !isBreak(last)) merged[merged.length - 1] = r;
      continue;
    }
    merged.push(r);
  }
  rows = merged;
  const NR = rows.length;

  // Cap stations (shared by all rows)
  const capCols = (tipU, startU, breaksS, toU, n) => {
    const set = new Set();
    for (let k = 0; k <= n; k++) set.add(+(lerp(tipU, startU, k / n)).toFixed(6));
    for (const s of breaksS) set.add(+toU(s).toFixed(6));
    return [...set].sort((a, b) => a - b);
  };
  const rearCols = capCols(uRearTip, D.xRm, CAPR_BREAKS, uFromSR, 30); // ascending, ends at xRm
  const frontCols = capCols(D.xFm, uFrontTip, CAPF_BREAKS, uFromSF, 36); // ascending, starts at xFm

  // Middle segment counts: max length of each sorted segment over all rows.
  const nSeg = midBreaks(0).length - 1;
  const segLen = new Array(nSeg).fill(0);
  for (const r of rows) {
    const b = midBreaks(r);
    for (let k = 0; k < nSeg; k++) segLen[k] = Math.max(segLen[k], b[k + 1] - b[k]);
  }
  const STEP = 0.021;
  const segN = segLen.map((l) => Math.max(1, Math.ceil(l / STEP)));
  const nMid = segN.reduce((a, b) => a + b, 0); // without the final xFm column
  const NC = rearCols.length - 1 + nMid + frontCols.length; // rear (excl. xRm), mid (incl. xRm, excl. xFm), front (incl. xFm)

  const U = new Float64Array(NR * NC);
  for (let r = 0; r < NR; r++) {
    let c = 0;
    for (let k = 0; k < rearCols.length - 1; k++) U[r * NC + c++] = rearCols[k];
    const b = midBreaks(rows[r]);
    for (let k = 0; k < nSeg; k++) for (let q = 0; q < segN[k]; q++) U[r * NC + c++] = lerp(b[k], b[k + 1], q / segN[k]);
    for (let k = 0; k < frontCols.length; k++) U[r * NC + c++] = frontCols[k];
  }

  const pos = new Float32Array(NR * NC * 3);
  const uv = new Float32Array(NR * NC * 2);
  const p = new THREE.Vector3();
  for (let r = 0; r < NR; r++) {
    for (let c = 0; c < NC; c++) {
      const k = r * NC + c;
      surfacePoint(U[k], rows[r], p);
      snapArch(p);
      pos[k * 3] = p.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = p.z;
      uv[k * 2] = U[k];
      uv[k * 2 + 1] = rows[r] * 0.34;
    }
  }

  const vid = (r, c) => ((r + NR) % NR) * NC + c;
  // Determine winding so that faces point outwards (check at the roof centre).
  const rTop = rows.findIndex((v) => v >= 6);
  const cTop = Math.floor(NC / 2);
  const P = (k) => new THREE.Vector3(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]);
  const a0 = P(vid(rTop, cTop)), b0 = P(vid(rTop, cTop + 1)), c0 = P(vid(rTop + 1, cTop + 1));
  const nTest = new THREE.Vector3().crossVectors(b0.clone().sub(a0), c0.clone().sub(a0));
  const FLIP = nTest.y < 0;

  // Classify cells
  const label = new Array(NR * NC);
  const cellCenter = (r, c) => {
    const k00 = vid(r, c), k01 = vid(r, c + 1), k11 = vid(r + 1, c + 1), k10 = vid(r + 1, c);
    const u = (U[k00] + U[k01] + U[k11] + U[k10]) / 4;
    const i0 = rows[r], i1 = r + 1 < NR ? rows[r + 1] : 12;
    return [u, (i0 + i1) / 2, k00, k01, k11, k10];
  };
  for (let r = 0; r < NR; r++) {
    for (let c = 0; c < NC - 1; c++) {
      const [u, i, k00, k01, k11, k10] = cellCenter(r, c);
      let cx = 0, cy = 0, cz = 0;
      for (const k of [k00, k01, k11, k10]) { cx += pos[k * 3]; cy += pos[k * 3 + 1]; cz += pos[k * 3 + 2]; }
      cx /= 4; cy /= 4; cz /= 4;
      // A cell is trimmed by an arch if its unsnapped centre is inside the opening.
      surfacePoint(u, i, p);
      label[r * NC + c] = insideArch(p.x, p.y, p.z) ? 'arch' : classify(u, i);
    }
  }

  // Full index for normals
  const quadTris = (r, c, out) => {
    const a = vid(r, c), b = vid(r, c + 1), cc = vid(r + 1, c + 1), d = vid(r + 1, c);
    if (FLIP) out.push(a, cc, b, a, d, cc); else out.push(a, b, cc, a, cc, d);
  };
  const all = [];
  for (let r = 0; r < NR; r++) for (let c = 0; c < NC - 1; c++) if (label[r * NC + c] !== 'arch') quadTris(r, c, all);
  const full = new THREE.BufferGeometry();
  full.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  full.setIndex(all);
  full.computeVertexNormals();
  const nrm = full.getAttribute('normal').array;
  // Degenerate cells (where two panel lines cross) leave some vertices without a
  // usable normal; fall back to the analytic surface normal there.
  for (let r = 0; r < NR; r++) {
    for (let c = 1; c < NC - 1; c++) {
      const k = r * NC + c;
      const l = Math.hypot(nrm[k * 3], nrm[k * 3 + 1], nrm[k * 3 + 2]);
      if (l > 0.5 && Number.isFinite(l)) continue;
      const f = surfaceFrame(U[k], rows[r]);
      nrm[k * 3] = f.n.x; nrm[k * 3 + 1] = f.n.y; nrm[k * 3 + 2] = f.n.z;
    }
  }
  // Poles: every row shares the tip point, so give them one averaged normal.
  for (const c of [0, NC - 1]) {
    const n = new THREE.Vector3();
    for (let r = 0; r < NR; r++) { const k = vid(r, c); n.x += nrm[k * 3]; n.y += nrm[k * 3 + 1]; n.z += nrm[k * 3 + 2]; }
    n.normalize();
    for (let r = 0; r < NR; r++) { const k = vid(r, c); nrm[k * 3] = n.x; nrm[k * 3 + 1] = n.y; nrm[k * 3 + 2] = n.z; }
  }
  full.dispose();

  // ---- helpers to turn cell sets into meshes ----
  const cellsOf = (pred) => {
    const out = [];
    for (let r = 0; r < NR; r++) for (let c = 0; c < NC - 1; c++) if (pred(label[r * NC + c], r, c)) out.push([r, c]);
    return out;
  };

  function geometryFromCells(cells, { offset = 0, flip = false } = {}) {
    const map = new Map();
    const P2 = [], N2 = [], UV2 = [], idx = [];
    const v = (k) => {
      let m = map.get(k);
      if (m === undefined) {
        m = P2.length / 3;
        map.set(k, m);
        const nx = nrm[k * 3], ny = nrm[k * 3 + 1], nz = nrm[k * 3 + 2];
        P2.push(pos[k * 3] + nx * offset, pos[k * 3 + 1] + ny * offset, pos[k * 3 + 2] + nz * offset);
        N2.push(flip ? -nx : nx, flip ? -ny : ny, flip ? -nz : nz);
        UV2.push(uv[k * 2], uv[k * 2 + 1]);
      }
      return m;
    };
    for (const [r, c] of cells) {
      const a = v(vid(r, c)), b = v(vid(r, c + 1)), cc = v(vid(r + 1, c + 1)), d = v(vid(r + 1, c));
      const f = FLIP !== flip;
      if (f) idx.push(a, cc, b, a, d, cc); else idx.push(a, b, cc, a, cc, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P2, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(N2, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(UV2, 2));
    g.setIndex(idx);
    return g;
  }

  // Boundary edges of a cell set, oriented so the set lies on the left when seen from outside.
  function boundaryEdges(cells) {
    const set = new Set(cells.map(([r, c]) => ((r + NR) % NR) * NC + c));
    const has = (r, c) => c >= 0 && c < NC - 1 && set.has(((r + NR) % NR) * NC + c);
    const edges = [];
    for (const [r, c] of cells) {
      const a = vid(r, c), b = vid(r, c + 1), cc = vid(r + 1, c + 1), d = vid(r + 1, c);
      const loop = [[a, b, r - 1, c], [b, cc, r, c + 1], [cc, d, r + 1, c], [d, a, r, c - 1]];
      for (const [p0, p1, nr, nc] of loop) if (!has(nr, nc)) edges.push(FLIP ? [p1, p0] : [p0, p1]);
    }
    return edges;
  }

  // Walls dropping from boundary edges along -normal. facing 'in' = towards the region.
  function wallGeometry(edges, depth, facing = 'in', outerOffset = 0) {
    const P2 = [], idx = [];
    const pt = (k, d) => [pos[k * 3] + nrm[k * 3] * d, pos[k * 3 + 1] + nrm[k * 3 + 1] * d, pos[k * 3 + 2] + nrm[k * 3 + 2] * d];
    for (const [a, b] of edges) {
      const base = P2.length / 3;
      P2.push(...pt(a, outerOffset), ...pt(b, outerOffset), ...pt(b, -depth), ...pt(a, -depth));
      if (facing === 'in') idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else idx.push(base + 1, base, base + 3, base + 1, base + 3, base + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P2, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  // Ring of cells within `width` grid steps of a different label (window frit / seals).
  function splitBorder(cells, width, sameGroup) {
    const border = [], inner = [];
    for (const [r, c] of cells) {
      let edge = false;
      for (let dr = -width; dr <= width && !edge; dr++) {
        for (let dc = -width; dc <= width && !edge; dc++) {
          const cc = c + dc;
          if (cc < 0 || cc >= NC - 1) { edge = true; break; }
          if (!sameGroup(label[((r + dr + NR) % NR) * NC + cc])) edge = true;
        }
      }
      (edge ? border : inner).push([r, c]);
    }
    return { border, inner };
  }

  return { NR, NC, rows, U, pos, nrm, label, cellsOf, geometryFromCells, boundaryEdges, wallGeometry, splitBorder, vid };
}

// Arch rim curve: where the trimmed opening meets the outer skin.
export function archRim(xc, side = 1, n = 72) {
  const pts = [];
  const R = D.archR, yc = D.wheelR;
  const p = new THREE.Vector3();
  const zAt = (x, y) => {
    // find i in [0.9, 4.3] with surface y == y (monotonic there)
    let lo = 0.9, hi = 4.3;
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      surfacePoint(x, mid, p);
      if (p.y < y) lo = mid; else hi = mid;
    }
    surfacePoint(x, (lo + hi) / 2, p);
    return p.z;
  };
  const yb = (x) => surfacePoint(x, 1.0, p).y;
  const add = (x, y) => pts.push(new THREE.Vector3(x, y, zAt(x, y) * side));
  const yb0 = yb(xc + R) + 0.004;
  for (let k = 0; k <= 6; k++) add(xc + R, lerp(yb0, yc, k / 6));
  for (let k = 1; k < n; k++) { const a = (k / n) * Math.PI; add(xc + R * Math.cos(a), yc + R * Math.sin(a)); }
  const yb1 = yb(xc - R) + 0.004;
  for (let k = 0; k <= 6; k++) add(xc - R, lerp(yc, yb1, k / 6));
  return pts;
}
