// Lathe jobs: turned parts with engineering drawings, the round-bar stock rack and the inspection of a
// parted-off piece against its drawing. Pure JS (no DOM, no THREE): runs in Node for the tests.
//
// Part frame: u = distance from the finished FACE end (the free end of the bar while it is in the chuck,
// datum A) toward the parted-off end, in mm. A job's outside is a list of cylindrical segments along u
// (a groove or an undercut is simply a short, smaller segment), plus an optional chamfer at the face end,
// a bore from the face (drilled from the tailstock) and an external thread on the first segment.
import { MATERIALS } from '../config.js';

export const LATHE_JOBS = [
  {
    id: 'L01', title: 'Guide pin', drawingNo: 'LT-1001', rev: 'A', customer: 'Fixture shop', difficulty: 1,
    material: 'aluminium', bar: { dia: 30, length: 100 }, stickout: 60, length: 40,
    brief: 'A locating pin for a drilling fixture: face the end, turn the Ø24 spigot to size with the cross-slide dial, turn the shoulder to Ø28, chamfer the end and part it off 40 mm long.',
    segs: [{ u0: 0, u1: 22, d: 24, tol: [-0.05, 0.05] }, { u0: 22, u1: 40, d: 28 }],
    chamfer: 1,
    setup: 'Ø30 aluminium bar, about 60 mm out of the jaws. T1 turning tool for facing and turning, T2 for the 45° chamfer, T3 parting blade. About 900–1000 rpm.',
  },
  {
    id: 'L02', title: 'Spacer bush', drawingNo: 'LT-1002', rev: 'B', customer: 'Conveyor rebuild', difficulty: 2,
    material: 'brass', bar: { dia: 25, length: 80 }, stickout: 45, length: 20,
    brief: 'A brass spacer: face, centre drill and drill Ø10 through from the tailstock, turn the outside to Ø22, chamfer the face end and part off 20 mm long.',
    segs: [{ u0: 0, u1: 20, d: 22, tol: [-0.05, 0.05] }],
    chamfer: 0.5,
    bore: { d: 10, tol: [0, 0.1], thru: true },
    setup: 'Ø25 brass bar, about 45 mm out. Slide the tailstock up, centre drill, then the Ø10 drill at least 25 mm deep. Turn Ø22, chamfer with T2, part off with T3. About 700 rpm.',
  },
  {
    id: 'L03', title: 'Stepped shaft', drawingNo: 'LT-1003', rev: 'A', customer: 'Gearbox repair', difficulty: 3,
    material: 'steel', bar: { dia: 30, length: 120 }, stickout: 75, length: 60,
    brief: 'A steel shaft with three diameters and a 3 mm circlip groove. Rough the steps, finish them to the dial, plunge the groove with the parting blade and part off 60 mm long.',
    segs: [
      { u0: 0, u1: 20, d: 18, tol: [-0.05, 0.05] },
      { u0: 20, u1: 30, d: 26, tol: [-0.05, 0.05] },
      { u0: 30, u1: 33, d: 22, groove: true },
      { u0: 33, u1: 45, d: 26, tol: [-0.05, 0.05] },
      { u0: 45, u1: 60, d: 28 },
    ],
    chamfer: 1,
    setup: 'Ø30 steel bar, about 75 mm out. Steel cuts slower: about 355–500 rpm and moderate depths (≤ 1 mm per side). Groove with T3 (3 mm blade).',
  },
  {
    id: 'L04', title: 'Threaded stud', drawingNo: 'LT-1004', rev: 'C', customer: 'Clamp kit', difficulty: 4,
    material: 'aluminium', bar: { dia: 25, length: 100 }, stickout: 60, length: 45,
    brief: 'A clamp stud with an M16×2 thread: turn Ø16 and Ø22, cut the 3 mm thread relief, chamfer the thread start, screw-cut the thread with the half nut in several passes and part off.',
    segs: [
      { u0: 0, u1: 20, d: 16, tol: [-0.25, 0] },
      { u0: 20, u1: 23, d: 13, groove: true },
      { u0: 23, u1: 45, d: 22, tol: [-0.05, 0.05] },
    ],
    chamfer: 1.5,
    thread: { u0: 0, u1: 20, d: 16, pitch: 2, minor: [13.35, 13.9], label: 'M16×2' },
    setup: 'Ø25 aluminium bar, about 60 mm out. Turn Ø16 for the thread. Threading: T4, pitch 2.0 on the gearbox, low speed (90–125 rpm), half nut in, cross-slide in 0.1–0.2 mm per pass until the root is Ø13.55.',
  },
];

export const getLatheJob = (id) => LATHE_JOBS.find((j) => j.id === id) || null;

// Round bars on the stock rack: one per job plus near misses (right size wrong material and the reverse).
export const BARS = (() => {
  const out = [];
  const add = (b) => { const key = `${b.dia}x${b.length}-${b.material}`; if (!out.some((o) => o.key === key)) out.push({ ...b, key }); };
  for (const j of LATHE_JOBS) add({ dia: j.bar.dia, length: j.bar.length, material: j.material });
  add({ dia: 30, length: 100, material: 'steel' });
  add({ dia: 25, length: 80, material: 'aluminium' });
  add({ dia: 40, length: 100, material: 'aluminium' });
  add({ dia: 20, length: 120, material: 'brass' });
  add({ dia: 35, length: 90, material: 'plastic' });
  return out.map((b, i) => ({ ...b, id: `R${String(i + 1).padStart(2, '0')}` }));
})();
export const barLabel = (b) => `Ø${b.dia} × ${b.length} ${MATERIALS[b.material]?.short || b.material}`;
export const barFits = (b, j) => !!b && !!j && b.dia === j.bar.dia && b.length >= j.bar.length && b.material === j.material;
export const barMassG = (b) => +((Math.PI * (b.dia / 2) ** 2 * b.length) / 1000 * (MATERIALS[b.material]?.density || 7.85)).toFixed(0);

const GEN_TOL = 0.1;
const tolOf = (s) => s.tol || [-GEN_TOL, GEN_TOL];
const fmt = (v, d = 2) => (v == null || !isFinite(v) ? '—' : (+v).toFixed(d));
export function tolText(t, d = 2) {
  if (!t) return `±${GEN_TOL}`;
  if (Math.abs(t[0] + t[1]) < 1e-9) return `±${+t[1].toFixed(d)}`;
  const s = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + (v === 0 ? '0' : Math.abs(+v.toFixed(d)));
  return `${s(t[1])}/${s(t[0])}`;
}

/** Nominal outer radius at u (chamfer included). */
export function nominalRadius(job, u) {
  const s = job.segs.find((g) => u >= g.u0 - 1e-9 && u <= g.u1 + 1e-9) || job.segs[job.segs.length - 1];
  let r = s.d / 2;
  if (job.chamfer && u < job.chamfer && s === job.segs[0]) r = Math.min(r, s.d / 2 - job.chamfer + u);
  return r;
}

// ------------------------------------------------------------------ piece frame (measuring a profile)
/**
 * Frame of a turned piece: u from its face end (highest Z with material). Works on a parted-off piece's
 * profile and on the bar still in the chuck (then the "back" is deep in the jaws).
 */
export function pieceFrame(profile) {
  if (!profile) return null;
  const hi = profile.lastMat();
  if (hi < 0) return null;
  const lo = profile.firstMatFrom(0);
  const zFace = profile.z(hi) + profile.dz / 2, zBack = profile.z(lo) - profile.dz / 2;
  const at = (u) => { const i = Math.round(profile.idx(zFace - u - profile.dz / 2)); return profile.has(i) ? i : -1; };
  return {
    profile, zFace, zBack, length: zFace - zBack,
    z: (u) => zFace - u,
    rOut: (u) => { const i = at(u); return i < 0 ? 0 : profile.rOut[i]; },
    rIn: (u) => { const i = at(u); return i < 0 ? 0 : profile.rIn[i]; },
    has: (u) => at(u) >= 0,
  };
}

// Instrument readings on a piece frame. kind: 'od' | 'id' | 'length' | 'step' | 'pitch'
export function readInstrument(frame, kind, u, { res = 0.01 } = {}) {
  const q = (v) => (v == null ? null : Math.round(v / res + 1e-9) * res);
  if (!frame) return null;
  if (kind === 'length') return { value: q(frame.length), what: 'Overall length' };
  if (u < 0 || u > frame.length) return null;
  if (kind === 'od') {
    // the anvils span ~1 mm: the largest diameter under them
    let m = 0;
    for (let k = -0.5; k <= 0.5; k += 0.05) m = Math.max(m, frame.rOut(Math.min(frame.length - 0.01, Math.max(0.01, u + k))));
    return m > 0 ? { value: q(2 * m), what: `OD at ${u.toFixed(1)} from the face` } : null;
  }
  if (kind === 'id') {
    let m = Infinity;
    for (let k = -0.5; k <= 0.5; k += 0.05) { const r = frame.rIn(Math.min(frame.length - 0.01, Math.max(0.01, u + k))); if (r > 0) m = Math.min(m, r); }
    return m < Infinity && m > 0.05 ? { value: q(2 * m), what: `Bore at ${u.toFixed(1)} from the face` } : null;
  }
  if (kind === 'step') {
    // depth rod from the face to the nearest shoulder at or beyond u (diameter change > 0.3 mm)
    const d0 = 2 * frame.rOut(Math.max(0.05, u));
    for (let x = Math.max(0.05, u); x < frame.length - 0.05; x += 0.02) {
      const d = 2 * frame.rOut(x);
      if (Math.abs(d - d0) > 0.3) {
        // the rod stops on the shoulder face: where the diameter is half-way to the next one
        const d1 = 2 * frame.rOut(Math.min(frame.length - 0.05, x + 1.2)), mid = (d0 + d1) / 2;
        let xs = x;
        while (xs < x + 1.2 && (d1 > d0 ? 2 * frame.rOut(xs) < mid : 2 * frame.rOut(xs) > mid)) xs += 0.02;
        return { value: q(xs), what: `Face to shoulder (Ø${fmt(d0, 1)} → Ø${fmt(d1, 1)})` };
      }
    }
    return { value: q(frame.length), what: 'Face to back (no shoulder)' };
  }
  if (kind === 'pitch') {
    const p = frame.profile.threads || [];
    const z = frame.z(u);
    const t = p.find((t) => z >= t.z0 - 0.5 && z <= t.z1 + 0.5);
    return t ? { value: +t.pitch.toFixed(2), what: `Thread pitch at ${u.toFixed(1)}` } : { value: null, what: 'No thread here (the gauge does not fit)' };
  }
  return null;
}

// ------------------------------------------------------------------ characteristics of a drawing
export function jobChecks(job) {
  const C = [];
  C.push({ id: 'len', kind: 'length', label: 'Overall length', nominal: job.length, tol: [-GEN_TOL, GEN_TOL] });
  job.segs.forEach((s, k) => {
    if (job.thread && k === 0) return; // the thread segment is checked as a thread
    C.push({ id: 'od' + k, kind: 'od', seg: k, label: s.groove ? `Groove Ø${s.d} (${s.u0}–${s.u1})` : `Ø${s.d} (${s.u0}–${s.u1} from face)`, nominal: s.d, tol: tolOf(s), u0: s.u0, u1: s.u1 });
  });
  for (let k = 0; k < job.segs.length - 1; k++) {
    const a = job.segs[k], b = job.segs[k + 1];
    if (Math.abs(a.d - b.d) < 0.3) continue;
    if (job.thread && k === 0) continue; // the thread runs out into its relief: no measurable shoulder face
    C.push({ id: 'sh' + k, kind: 'shoulder', label: `Shoulder at ${a.u1} from face (Ø${a.d} | Ø${b.d})`, nominal: a.u1, tol: [-GEN_TOL, GEN_TOL], da: a.d, db: b.d });
  }
  if (job.chamfer) C.push({ id: 'ch', kind: 'chamfer', label: `Chamfer ${job.chamfer}×45° at the face`, nominal: job.chamfer, tol: job.thread ? [-0.3, job.thread.pitch] : [-0.3, 0.3], d: job.segs[0].d });
  if (job.bore) {
    C.push({ id: 'bore', kind: 'bore', label: `Bore Ø${job.bore.d}${job.bore.thru ? ' through' : ''}`, nominal: job.bore.d, tol: job.bore.tol || [-GEN_TOL, GEN_TOL] });
    if (job.bore.thru) C.push({ id: 'thru', kind: 'thru', label: 'Bore goes right through', nominal: 1, tol: [0, 0] });
  }
  if (job.thread) {
    const t = job.thread;
    C.push({ id: 'tp', kind: 'pitch', label: `${t.label} pitch`, nominal: t.pitch, tol: [-0.01, 0.01] });
    C.push({ id: 'tmaj', kind: 'major', label: `${t.label} major Ø`, nominal: t.d, tol: tolOf(job.segs[0]) });
    const mid = (t.minor[0] + t.minor[1]) / 2;
    C.push({ id: 'tmin', kind: 'minor', label: `${t.label} root (minor) Ø`, nominal: +mid.toFixed(3), tol: [t.minor[0] - mid, t.minor[1] - mid] });
  }
  return C;
}

// ------------------------------------------------------------------ inspection
const GRADES = [[88, 'A'], [76, 'B'], [64, 'C'], [0, 'D']];

/**
 * Inspect a turned piece against its drawing.
 * @param job   one of LATHE_JOBS
 * @param piece { profile: TurnProfile, material }
 * @returns {{items, pass, grade, score, notes, summary}}
 */
export function inspectTurned(job, piece) {
  const notes = [];
  const fr = pieceFrame(piece?.profile);
  const items = [];
  if (!fr) return { items, pass: false, grade: 'FAIL', score: 0, notes: ['There is no part to inspect.'], summary: {} };
  const L = fr.length;
  const thrZone = job.thread ? [job.thread.u0, job.thread.u1] : null;
  const scan = (u0, u1, fn, step = 0.05) => { for (let u = u0; u <= u1 + 1e-9; u += step) fn(u); };
  for (const c of jobChecks(job)) {
    let measured = null, extra = '', missing = false;
    if (c.kind === 'length') measured = L;
    else if (c.kind === 'od') {
      let lo = c.u0 + 0.6, hi = c.u1 - 0.6;
      if (c.seg === 0 && job.chamfer) lo = Math.max(lo, job.chamfer + 0.4);
      if (hi > L - 0.3) hi = L - 0.3;
      if (hi < lo) { lo = hi = (c.u0 + c.u1) / 2; }
      let mx = -1, mn = Infinity;
      scan(lo, hi, (u) => { const d = 2 * fr.rOut(u); if (d > mx) mx = d; if (d < mn) mn = d; });
      if (mx <= 0 || c.u0 >= L - 0.2) missing = true;
      else {
        // report the reading furthest from nominal (taper / steps inside the span show up)
        measured = Math.abs(mx - c.nominal) >= Math.abs(mn - c.nominal) ? mx : mn;
        if (mx - mn > 0.02) extra = `range Ø${fmt(mn, 3)}–${fmt(mx, 3)}`;
      }
    } else if (c.kind === 'shoulder') {
      const mid = (c.da + c.db) / 2;
      let found = null;
      scan(Math.max(0.02, c.nominal - 4), Math.min(L - 0.02, c.nominal + 4), (u) => {
        if (found != null) return;
        const d = 2 * fr.rOut(u);
        if (c.db > c.da ? d >= mid : d <= mid) found = u;
      }, 0.02);
      if (found == null) missing = true; else measured = found;
    } else if (c.kind === 'chamfer') {
      const full = c.d - (job.thread ? 0.3 : 0.03);
      let found = null;
      scan(0.01, Math.min(L, 8), (u) => { if (found == null && 2 * fr.rOut(u) >= full) found = u; }, 0.02);
      measured = found == null ? null : found;
      if (measured != null && measured < 0.12) { measured = 0; extra = 'no chamfer (sharp edge)'; }
      if (found == null) missing = true;
    } else if (c.kind === 'bore') {
      let mn = Infinity, mx = 0;
      scan(L * 0.15, L * 0.85, (u) => { const r = fr.rIn(u); if (r > 0.05) { mn = Math.min(mn, 2 * r); mx = Math.max(mx, 2 * r); } });
      if (mx <= 0) { missing = true; extra = 'not drilled'; } else measured = Math.abs(mx - c.nominal) > Math.abs(mn - c.nominal) ? mx : mn;
    } else if (c.kind === 'thru') {
      let ok = true;
      scan(0.05, L - 0.05, (u) => { if (fr.rIn(u) < 0.05) ok = false; });
      measured = ok ? 1 : 0;
      extra = ok ? 'open at both ends' : 'blind: the bore does not break through';
    } else if (c.kind === 'pitch') {
      const z0 = fr.z(thrZone[1]), z1 = fr.z(thrZone[0]);
      const t = (piece.profile.threads || []).find((t) => t.z1 > z0 + 1 && t.z0 < z1 - 1);
      if (!t) { missing = true; extra = 'no thread cut'; } else measured = t.pitch;
    } else if (c.kind === 'major' || c.kind === 'minor') {
      let mx = -1, mn = Infinity;
      scan(thrZone[0] + (job.chamfer || 0) + 0.5, Math.min(thrZone[1] - 0.6, L - 0.3), (u) => { const d = 2 * fr.rOut(u); if (d > 0) { mx = Math.max(mx, d); mn = Math.min(mn, d); } }, 0.02);
      if (mx < 0) missing = true; else measured = c.kind === 'major' ? mx : mn;
    }
    const dev = measured == null ? null : measured - c.nominal;
    const pass = !missing && dev != null && dev >= c.tol[0] - 1e-6 && dev <= c.tol[1] + 1e-6;
    // quality 0..1: 1 at the middle of the tolerance band, 0.5 at its limits
    let q = 0;
    if (pass) {
      const mid = (c.tol[0] + c.tol[1]) / 2, half = Math.max(1e-6, (c.tol[1] - c.tol[0]) / 2);
      q = half < 1e-5 ? 1 : 1 - 0.5 * Math.min(1, Math.abs(dev - mid) / half);
    }
    items.push({ ...c, measured: measured == null ? null : +(+measured).toFixed(3), dev: dev == null ? null : +dev.toFixed(3), pass, missing, q, extra });
  }
  let pass = items.every((i) => i.pass);
  if (piece.material && piece.material !== job.material) {
    pass = false;
    notes.push(`Wrong material: the drawing calls for ${MATERIALS[job.material].short.toLowerCase()} but the part is ${MATERIALS[piece.material]?.short.toLowerCase() || piece.material}.`);
  }
  const nFail = items.filter((i) => !i.pass).length;
  const score = items.length ? (100 * items.reduce((a, i) => a + i.q, 0)) / items.length : 0;
  const grade = pass ? GRADES.find(([s]) => score >= s)[1] : 'FAIL';
  if (nFail) notes.push(`${nFail} characteristic${nFail > 1 ? 's' : ''} out of tolerance.`);
  const big = items.filter((i) => !i.pass && i.dev != null && i.dev > 0 && ['od', 'major', 'length'].includes(i.kind));
  if (big.length) notes.push('Material left on: take another (finishing) pass to bring it to size.');
  const small = items.filter((i) => !i.pass && i.dev != null && i.dev < 0 && ['od', 'length', 'minor'].includes(i.kind));
  if (small.length) notes.push('Undersize: the dial went too far. Remember the cross-slide reads on DIAMETER (0.02 mm/div).');
  return { items, pass, grade, score: Math.round(score * 10) / 10, notes, summary: { length: L, nFail, nItems: items.length } };
}

// ------------------------------------------------------------------ drawing (A3 sheet, 420 x 297 viewBox)
const FONT = "'Arial Narrow','Liberation Sans Narrow',Arial,'Liberation Sans',Helvetica,sans-serif";
const n2 = (v) => (Math.round(v * 100) / 100).toString();
const escX = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function arrowHead(x, y, dx, dy) {
  const L = 2.6, W = 0.5;
  const ux = dx, uy = dy, px = -uy, py = ux;
  return `<path d="M${n2(x)} ${n2(y)}L${n2(x - ux * L + px * W)} ${n2(y - uy * L + py * W)}L${n2(x - ux * L - px * W)} ${n2(y - uy * L - py * W)}Z" fill="#000"/>`;
}
function text(x, y, s, { size = 3.2, anchor = 'middle', rot = 0, weight = 400, fill = '#000' } = {}) {
  return `<text x="${n2(x)}" y="${n2(y)}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" fill="${fill}"${rot ? ` transform="rotate(${rot} ${n2(x)} ${n2(y)})"` : ''}>${escX(s)}</text>`;
}
// linear dimension between two points along x (horizontal) or y (vertical), with extension lines
function hDim(xa, xb, y, yRef, label) {
  const out = [];
  const x0 = Math.min(xa, xb), x1 = Math.max(xa, xb);
  out.push(`<path class="n" d="M${n2(xa)} ${n2(yRef + 1)}V${n2(y + 1.5)}M${n2(xb)} ${n2(yRef + 1)}V${n2(y + 1.5)}M${n2(x0)} ${n2(y)}H${n2(x1)}"/>`);
  out.push(arrowHead(x0, y, -1, 0), arrowHead(x1, y, 1, 0));
  out.push(text((x0 + x1) / 2, y - 1, label));
  return out.join('');
}
function vDim(x, ya, yb, label, side = 1) {
  const y0 = Math.min(ya, yb), y1 = Math.max(ya, yb);
  return `<path class="n" d="M${n2(x)} ${n2(y0)}V${n2(y1)}"/>` + arrowHead(x, y0, 0, -1) + arrowHead(x, y1, 0, 1) + text(x - 1.2 * side, (y0 + y1) / 2, label, { rot: -90 });
}

/** Full drawing sheet (SVG string). */
export function latheDrawingSVG(job, { width = '100%', height = '100%' } = {}) {
  const L = job.length;
  const D = Math.max(...job.segs.map((s) => s.d));
  const scales = [5, 4, 3, 2.5, 2, 1.5, 1];
  const S = scales.find((s) => L * s <= 230 && D * s <= 120) || 1;
  const cy = 112, xR = 40 + 230 / 2 + (L * S) / 2; // part centred in the main view area (x 40..270)
  const X = (u) => xR - u * S, Yt = (r) => cy - r * S, Yb = (r) => cy + r * S;
  const o = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 297" width="${width}" height="${height}">`);
  o.push(`<style>.k{fill:none;stroke:#000;stroke-width:.5;stroke-linejoin:round}.n{fill:none;stroke:#000;stroke-width:.25}.ce{fill:none;stroke:#000;stroke-width:.25;stroke-dasharray:7 1 1 1}.hi{fill:none;stroke:#000;stroke-width:.3;stroke-dasharray:2.2 1}.th{fill:none;stroke:#000;stroke-width:.25}</style>`);
  o.push('<rect x="0" y="0" width="420" height="297" fill="#fff"/>');
  o.push('<rect x="20" y="10" width="390" height="277" class="k" style="stroke-width:.7"/>');
  // ---- outline (upper and lower halves)
  const pts = [];
  const c = job.chamfer || 0;
  job.segs.forEach((s, k) => {
    const r = s.d / 2;
    if (k === 0) { pts.push([0, r - c]); if (c) pts.push([c, r]); } else pts.push([s.u0, r]);
    pts.push([s.u1, r]);
  });
  const up = pts.map(([u, r]) => `${n2(X(u))} ${n2(Yt(r))}`), dn = pts.map(([u, r]) => `${n2(X(u))} ${n2(Yb(r))}`);
  o.push(`<path class="k" d="M${n2(X(0))} ${n2(cy)}L${up.join('L')}L${n2(X(L))} ${n2(cy)}M${n2(X(0))} ${n2(cy)}L${dn.join('L')}L${n2(X(L))} ${n2(cy)}"/>`);
  // shoulder edges and chamfer edge (visible lines across the part)
  const edges = [];
  if (c) edges.push([c, job.segs[0].d / 2]);
  job.segs.forEach((s, k) => { if (k > 0) edges.push([s.u0, Math.min(s.d, job.segs[k - 1].d) / 2]); });
  for (const [u, r] of edges) o.push(`<path class="k" d="M${n2(X(u))} ${n2(Yt(r))}V${n2(Yb(r))}"/>`);
  // centre line
  o.push(`<path class="ce" d="M${n2(X(0) + 8)} ${cy}H${n2(X(L) - 8)}"/>`);
  // thread: root lines (thin, continuous) over the thread length
  if (job.thread) {
    const t = job.thread, rm = ((t.minor[0] + t.minor[1]) / 2) / 2;
    o.push(`<path class="th" d="M${n2(X(t.u0 + (c ? 0 : 0)))} ${n2(Yt(rm))}H${n2(X(t.u1))}M${n2(X(t.u0))} ${n2(Yb(rm))}H${n2(X(t.u1))}"/>`);
    o.push(`<path class="k" d="M${n2(X(t.u1))} ${n2(Yt(t.d / 2))}V${n2(Yb(t.d / 2))}"/>`);
  }
  // bore: hidden lines
  if (job.bore) {
    const rb = job.bore.d / 2, uEnd = job.bore.thru ? L : job.bore.depth;
    o.push(`<path class="hi" d="M${n2(X(0))} ${n2(Yt(rb))}H${n2(X(uEnd))}M${n2(X(0))} ${n2(Yb(rb))}H${n2(X(uEnd))}"/>`);
  }
  // ---- diameter dimensions (vertical, at each segment's middle)
  job.segs.forEach((s, k) => {
    if (job.thread && k === 0) return;
    const um = s.groove ? (s.u0 + s.u1) / 2 : s.u0 + (s.u1 - s.u0) * 0.55;
    const x = X(um);
    const lab = `Ø${s.d}${s.tol ? ' ' + tolText(s.tol) : ''}`;
    if (s.groove) {
      // groove: dimension from outside with a leader
      o.push(`<path class="n" d="M${n2(x)} ${n2(Yb(s.d / 2))}L${n2(x + 8)} ${n2(Yb(D / 2) + 14)}H${n2(x + 26)}"/>` + arrowHead(x, Yb(s.d / 2), -0.37, -0.93) + text(x + 9, Yb(D / 2) + 13, `${lab} groove ×${+(s.u1 - s.u0).toFixed(1)} wide`, { anchor: 'start', size: 3 }));
    } else o.push(vDim(x, Yt(s.d / 2), Yb(s.d / 2), lab));
  });
  // ---- length dimensions from the face (datum A), stacked above the part
  const shoulders = [];
  job.segs.forEach((s, k) => { if (k < job.segs.length - 1) shoulders.push(s.u1); });
  let row = 0;
  const yTop = Yt(D / 2);
  for (const u of shoulders) {
    const y = yTop - 9 - row * 7;
    o.push(hDim(X(0), X(u), y, yTop, `${u}`));
    row++;
  }
  o.push(hDim(X(0), X(L), yTop - 9 - row * 7, yTop, `${L} ±0.1`));
  // datum A at the face
  o.push(`<path class="n" d="M${n2(X(0) + 3)} ${n2(Yb(job.segs[0].d / 2) + 2)}l5 5"/><rect x="${n2(X(0) + 7)}" y="${n2(Yb(job.segs[0].d / 2) + 6)}" width="6" height="6" class="n"/>` + text(X(0) + 10, Yb(job.segs[0].d / 2) + 10.6, 'A', { size: 3.6 }));
  // chamfer callout
  if (c) {
    const x = X(c / 2), y = Yt(job.segs[0].d / 2 - c / 2);
    o.push(`<path class="n" d="M${n2(x)} ${n2(y)}L${n2(x + 10)} ${n2(y - 10)}H${n2(x + 26)}"/>` + arrowHead(x, y, -0.707, 0.707) + text(x + 11, y - 11, `${c}×45°`, { anchor: 'start' }));
  }
  // thread callout
  if (job.thread) {
    const t = job.thread, x = X((t.u0 + t.u1) / 2), y = Yb(t.d / 2);
    o.push(`<path class="n" d="M${n2(x)} ${n2(y)}L${n2(x - 8)} ${n2(y + 14)}H${n2(x - 46)}"/>` + arrowHead(x, y, 0.5, -0.86) + text(x - 9, y + 13, `${t.label} × ${t.u1 - t.u0} long, major Ø${t.d} ${tolText(job.segs[0].tol)}`, { anchor: 'end', size: 3 }));
  }
  // bore callout
  if (job.bore) {
    const x = X(L * 0.75), y = Yb(job.bore.d / 2);
    o.push(`<path class="n" d="M${n2(x)} ${n2(y)}L${n2(x - 10)} ${n2(Yb(D / 2) + 20)}H${n2(x - 50)}"/>` + arrowHead(x, y, 0.45, -0.89) + text(x - 11, Yb(D / 2) + 19, `Ø${job.bore.d} ${tolText(job.bore.tol)} ${job.bore.thru ? 'THROUGH (drill)' : 'deep ' + job.bore.depth}`, { anchor: 'end', size: 3 }));
  }
  // ---- end view (from the face end), right of the main view
  {
    const ex = 330, ey = cy, sc = Math.min(S, 60 / D);
    o.push(text(ex, ey - (D / 2) * sc - 6, 'VIEW FROM A', { size: 3, weight: 700 }));
    const rings = [...new Set(job.segs.map((s) => s.d))].sort((a, b) => b - a);
    rings.forEach((d, i) => o.push(`<circle cx="${ex}" cy="${ey}" r="${n2((d / 2) * sc)}" class="${i === 0 ? 'k' : 'n'}"/>`));
    if (job.bore) o.push(`<circle cx="${ex}" cy="${ey}" r="${n2((job.bore.d / 2) * sc)}" class="k"/>`);
    if (c) o.push(`<circle cx="${ex}" cy="${ey}" r="${n2((job.segs[0].d / 2 - c) * sc)}" class="n"/>`);
    o.push(`<path class="ce" d="M${n2(ex - (D / 2) * sc - 5)} ${ey}H${n2(ex + (D / 2) * sc + 5)}M${ex} ${n2(ey - (D / 2) * sc - 5)}V${n2(ey + (D / 2) * sc + 5)}"/>`);
  }
  // ---- notes
  const notes = [
    'NOTES',
    `1. General tolerance ±${GEN_TOL} mm unless stated.`,
    '2. Face end = datum A; lengths measured from A.',
    '3. Turned surfaces Ra 3.2. Break sharp edges 0.2.',
    `4. Parting-off end may be left as parted.`,
    `5. Make from ${MATERIALS[job.material].short.toLowerCase()} bar Ø${job.bar.dia}.`,
  ];
  notes.forEach((s, i) => o.push(text(26, 212 + i * 5, s, { anchor: 'start', size: i ? 3 : 3.4, weight: i ? 400 : 700 })));
  // ---- title block
  const tb = { x: 230, y: 235, w: 180, h: 52 };
  o.push(`<rect x="${tb.x}" y="${tb.y}" width="${tb.w}" height="${tb.h}" class="k" style="stroke-width:.7"/>`);
  const rowsY = [tb.y + 13, tb.y + 26, tb.y + 39];
  o.push(`<path class="n" d="M${tb.x} ${rowsY[0]}H${tb.x + tb.w}M${tb.x} ${rowsY[1]}H${tb.x + tb.w}M${tb.x} ${rowsY[2]}H${tb.x + tb.w}M${tb.x + 90} ${rowsY[0]}V${tb.y + tb.h}M${tb.x + 135} ${rowsY[0]}V${tb.y + tb.h}"/>`);
  const cell = (x, y, lab, val, big = false) => text(x + 2, y + 3.6, lab, { anchor: 'start', size: 2.2, fill: '#555' }) + text(x + 2, y + (big ? 10.5 : 10), val, { anchor: 'start', size: big ? 5 : 3.6, weight: big ? 700 : 400 });
  o.push(cell(tb.x, tb.y, 'TITLE', `${job.title}`, true));
  o.push(text(tb.x + tb.w - 3, tb.y + 10, `${job.id}`, { anchor: 'end', size: 6, weight: 700 }));
  o.push(cell(tb.x, rowsY[0], 'MATERIAL', MATERIALS[job.material].name));
  o.push(cell(tb.x + 90, rowsY[0], 'STOCK', `Bar Ø${job.bar.dia} × ${job.bar.length}`));
  o.push(cell(tb.x + 135, rowsY[0], 'SCALE', `${S}:1`));
  o.push(cell(tb.x, rowsY[1], 'CUSTOMER', job.customer));
  o.push(cell(tb.x + 90, rowsY[1], 'DRAWING NO.', job.drawingNo));
  o.push(cell(tb.x + 135, rowsY[1], 'REV', job.rev));
  o.push(cell(tb.x, rowsY[2], 'GENERAL TOLERANCE', `±${GEN_TOL} mm · dimensions in mm`));
  o.push(cell(tb.x + 90, rowsY[2], 'PROJECTION', 'First angle'));
  o.push(cell(tb.x + 135, rowsY[2], 'SHEET', '1 / 1'));
  o.push(text(26, 20, `TURNED PART · ${job.id} · ${job.title.toUpperCase()}`, { anchor: 'start', size: 4, weight: 700 }));
  o.push('</svg>');
  return o.join('');
}
