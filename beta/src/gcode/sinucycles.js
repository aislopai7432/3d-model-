// Standard drilling and milling cycles of the 808D-style control. Each cycle generates its path in
// program coordinates through the interpreter's cycle API (cRapid / cFeed / cArc / cDwell), so frames,
// work offsets, tool length and limit checks all apply exactly as for hand-written blocks.
//
// The parameter lists follow the classic SINUMERIK "standard cycles" signatures (as on the 802D/808D).
// `CYCLES[name].params` also drives the programGUIDE-style input screens.
import { compensate, tangentAt } from './crc.js';

const D2R = Math.PI / 180;
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

function need(I, name, v, label) {
  if (typeof v !== 'number' || !isFinite(v)) I.cErr(`61001 ${name}: parameter ${label} missing`);
  return v;
}

function finalDepth(I, name, rfp, dp, dpr) {
  let z;
  if (typeof dpr === 'number' && dpr !== 0) z = rfp - Math.abs(dpr);
  else if (typeof dp === 'number') z = dp;
  else I.cErr(`61001 ${name}: final depth DP or DPR missing`);
  if (z >= rfp - 1e-9) I.cErr(`61101 ${name}: reference plane defined incorrectly (depth ${z} is not below the reference plane ${rfp})`);
  return z;
}

function levels(top, bottom, mid) {
  const depth = top - bottom;
  if (depth <= 1e-9) return [bottom];
  const n = mid > 0 ? Math.max(1, Math.ceil(depth / mid - 1e-9)) : 1;
  const out = [];
  for (let k = 1; k <= n; k++) out.push(top - (depth * k) / n);
  return out;
}

// Local frame (origin + rotation) on top of the program coordinates.
class Local {
  constructor(I, ox, oy, deg) {
    this.I = I;
    this.ox = ox;
    this.oy = oy;
    this.c = Math.cos(deg * D2R);
    this.s = Math.sin(deg * D2R);
  }
  p(x, y) {
    return { x: this.ox + this.c * x - this.s * y, y: this.oy + this.s * x + this.c * y };
  }
  rapid(x, y, z) {
    const q = x == null ? {} : this.p(x, y);
    if (z != null) q.z = z;
    this.I.cRapid(q);
  }
  feed(x, y, z, f) {
    const q = x == null ? {} : this.p(x, y);
    if (z != null) q.z = z;
    this.I.cFeed(q, f);
  }
  arc(x, y, cx, cy, cw, f, z) {
    const q = this.p(x, y);
    if (z != null) q.z = z;
    this.I.cArc(q, this.p(cx, cy), cw, f);
  }
  // path of segments from shape helpers
  run(segs, f) {
    for (const s of segs) {
      if (s.t === 'L') this.feed(s.x, s.y, s.z, f);
      else this.arc(s.x, s.y, s.cx, s.cy, s.cw, f, s.z);
    }
  }
}

// Rounded rectangle tool-centre path starting and ending at (a, 0).
function rrect(a, b, rc, ccw) {
  rc = Math.max(0, Math.min(rc, a, b));
  const L = (x, y) => ({ t: 'L', x, y });
  const A = (x, y, cx, cy, cw) => ({ t: 'A', x, y, cx, cy, cw });
  const s = [];
  if (ccw) {
    s.push(L(a, b - rc));
    if (rc > 0) s.push(A(a - rc, b, a - rc, b - rc, false));
    s.push(L(-a + rc, b));
    if (rc > 0) s.push(A(-a, b - rc, -a + rc, b - rc, false));
    s.push(L(-a, -b + rc));
    if (rc > 0) s.push(A(-a + rc, -b, -a + rc, -b + rc, false));
    s.push(L(a - rc, -b));
    if (rc > 0) s.push(A(a, -b + rc, a - rc, -b + rc, false));
    s.push(L(a, 0));
  } else {
    s.push(L(a, -b + rc));
    if (rc > 0) s.push(A(a - rc, -b, a - rc, -b + rc, true));
    s.push(L(-a + rc, -b));
    if (rc > 0) s.push(A(-a, -b + rc, -a + rc, -b + rc, true));
    s.push(L(-a, b - rc));
    if (rc > 0) s.push(A(-a + rc, b, -a + rc, b - rc, true));
    s.push(L(a - rc, b));
    if (rc > 0) s.push(A(a, b - rc, a - rc, b - rc, true));
    s.push(L(a, 0));
  }
  return s;
}

function circle(r, ccw) {
  return [{ t: 'A', x: -r, y: 0, cx: 0, cy: 0, cw: !ccw }, { t: 'A', x: r, y: 0, cx: 0, cy: 0, cw: !ccw }];
}

// Stadium (slot outline) around the centre line from (x0,0) to (x1,0) with half width h, start (x1, -h) or (x1, h).
function stadium(x0, x1, h, ccw) {
  if (ccw) {
    return [
      { t: 'A', x: x1, y: h, cx: x1, cy: 0, cw: false },
      { t: 'L', x: x0, y: h },
      { t: 'A', x: x0, y: -h, cx: x0, cy: 0, cw: false },
      { t: 'L', x: x1, y: -h },
    ];
  }
  return [
    { t: 'A', x: x1, y: -h, cx: x1, cy: 0, cw: true },
    { t: 'L', x: x0, y: -h },
    { t: 'A', x: x0, y: h, cx: x0, cy: 0, cw: true },
    { t: 'L', x: x1, y: h },
  ];
}

function climbDir(I, cdir, inside) {
  // returns true for counter-clockwise travel
  if (cdir === 2) return false;
  if (cdir === 3) return true;
  const ccwClimb = inside ? I.cClimbCCW() : !I.cClimbCCW();
  return cdir === 1 ? !ccwClimb : ccwClimb;
}

// ------------------------------------------------------------------------------------ drilling
function drill(I, name, a, dwell) {
  const [rtp, rfp, sdis0, dp, dpr, dtb] = a;
  need(I, name, rtp, 'RTP');
  need(I, name, rfp, 'RFP');
  const sdis = Math.abs(num(sdis0, 0));
  I.cNeedTool(name);
  const f = I.cFeedDefault();
  const z = finalDepth(I, name, rfp, dp, dpr);
  I.cRapid({ z: rfp + sdis });
  I.cFeed({ z }, f);
  if (dwell) I.cDwell(num(dtb, 0));
  I.cRapid({ z: rtp });
}

function cycle83(I, a) {
  const [rtp, rfp, sdis0, dp, dpr, fdep, fdpr, dam0, dtb, dts, frf0, vari0, , mdep0, vrt0, , dis10] = a;
  const name = 'CYCLE83';
  need(I, name, rtp, 'RTP');
  need(I, name, rfp, 'RFP');
  const sdis = Math.abs(num(sdis0, 0));
  I.cNeedTool(name);
  const f = I.cFeedDefault();
  const z = finalDepth(I, name, rfp, dp, dpr);
  let first;
  if (typeof fdpr === 'number' && fdpr !== 0) first = rfp - Math.abs(fdpr);
  else if (typeof fdep === 'number') first = fdep;
  else I.cErr('61001 CYCLE83: first drilling depth FDEP or FDPR missing');
  if (first >= rfp) I.cErr('61107 CYCLE83: first drilling depth defined incorrectly');
  const dam = Math.abs(num(dam0, 0));
  const frf = Math.min(1, Math.max(0.001, num(frf0, 1)));
  const vari = num(vari0, 0);
  const mdep = Math.abs(num(mdep0, 0)) || 0.5;
  const vrt = Math.abs(num(vrt0, 0)) || 1;
  const dis1 = Math.abs(num(dis10, 0)) || 1;
  I.cRapid({ z: rfp + sdis });
  let stroke = rfp - first;
  let cur = Math.max(first, z);
  I.cFeed({ z: cur }, f * frf);
  while (cur > z + 1e-9) {
    I.cDwell(num(dtb, 0));
    if (vari === 1) {
      I.cRapid({ z: rfp + sdis });
      I.cDwell(num(dts, 0));
      I.cRapid({ z: cur + dis1 });
    } else {
      I.cRapid({ z: cur + vrt });
    }
    if (dam > 0) stroke = Math.max(stroke - dam, Math.max(dam, mdep));
    const next = Math.max(cur - stroke, z);
    I.cFeed({ z: next }, f);
    cur = next;
  }
  I.cDwell(num(dtb, 0));
  I.cRapid({ z: rtp });
}

function runModal(I) {
  const m = I.S.mcall;
  if (m) CYCLES[m.name].run(I, m.args);
}

function holes1(I, a) {
  const [spca, spco, sta1, fdis, dbh, n0] = a;
  const name = 'HOLES1';
  need(I, name, spca, 'SPCA');
  need(I, name, spco, 'SPCO');
  const n = num(n0, 0);
  if (!(n >= 1) || n % 1) I.cErr('61601 HOLES1: number of holes NUM must be a whole number >= 1');
  for (let i = 0; i < n; i++) {
    const d = num(fdis, 0) + i * num(dbh, 0);
    I.cRapid({ x: spca + d * Math.cos(num(sta1, 0) * D2R), y: spco + d * Math.sin(num(sta1, 0) * D2R) });
    runModal(I);
  }
}

function holes2(I, a) {
  const [cpa, cpo, rad, sta1, inda0, n0] = a;
  const name = 'HOLES2';
  need(I, name, cpa, 'CPA');
  need(I, name, cpo, 'CPO');
  const n = num(n0, 0);
  if (!(n >= 1) || n % 1) I.cErr('61601 HOLES2: number of holes NUM must be a whole number >= 1');
  const r = need(I, name, rad, 'RAD');
  if (r <= 0) I.cErr('61601 HOLES2: radius RAD must be greater than zero');
  const inda = num(inda0, 0) || 360 / n;
  for (let i = 0; i < n; i++) {
    const ang = (num(sta1, 0) + i * inda) * D2R;
    I.cRapid({ x: cpa + r * Math.cos(ang), y: cpo + r * Math.sin(ang) });
    runModal(I);
  }
}

// ------------------------------------------------------------------------------------ face milling
function cycle71(I, a) {
  const [rtp, rfp, sdis0, dp, pa, po, leng, wid, sta, mid, mida0, fdp0, fald0, ffp1, vari0, fdp10] = a;
  const name = 'CYCLE71';
  for (const [v, l] of [[rtp, 'RTP'], [rfp, 'RFP'], [dp, 'DP'], [pa, 'PA'], [po, 'PO'], [leng, 'LENG'], [wid, 'WID'], [ffp1, 'FFP1']]) need(I, name, v, l);
  I.cNeedTool(name);
  const R = I.cToolR();
  const sdis = Math.abs(num(sdis0, 0));
  const vari = num(vari0, 11);
  const u = vari % 10, dir = Math.floor(vari / 10) % 10;
  if (![1, 2].includes(u) || ![1, 2, 3, 4].includes(dir)) I.cErr('61002 CYCLE71: machining type VARI must be 11..14 (roughing) or 21..24 (finishing)');
  if (dp >= rfp) I.cErr('61101 CYCLE71: reference plane defined incorrectly (DP is not below RFP)');
  const mida = Math.min(num(mida0, 0) || 1.6 * R, 2 * R);
  const fdp = Math.abs(num(fdp0, 0)) || 2;
  const fdp1 = num(fdp10, 0);
  const fald = Math.abs(num(fald0, 0));
  const L = new Local(I, pa, po, num(sta, 0));
  // rectangle in local coordinates (signs of LENG/WID give the direction from the corner)
  const along = dir === 1 || dir === 3; // paths parallel to the abscissa
  const x0 = Math.min(0, leng), x1 = Math.max(0, leng), y0 = Math.min(0, wid), y1 = Math.max(0, wid);
  const [u0, u1, v0, v1] = along ? [x0, x1, y0, y1] : [y0, y1, x0, x1];
  const vs = v0 + R - Math.min(0.5, R * 0.2), ve = v1 - R + fdp1;
  const paths = [];
  if (ve <= vs) paths.push((v0 + v1) / 2);
  else {
    const n = Math.ceil((ve - vs) / mida - 1e-9);
    for (let i = 0; i <= n; i++) paths.push(vs + ((ve - vs) * i) / Math.max(1, n));
  }
  const us = u0 - R - fdp, ue = u1 + R + fdp;
  const P = (uu, vv) => (along ? [uu, vv] : [vv, uu]);
  const zs = u === 1 ? levels(rfp, dp + fald, num(mid, 0)) : [dp];
  const zig = dir === 3 || dir === 4;
  L.rapid(null, null, Math.max(rtp, I.cPos().z));
  L.rapid(...P(us, paths[0]));
  zs.forEach((z, li) => {
    let fwd = true;
    L.rapid(null, null, (li === 0 ? rfp : zs[li - 1]) + sdis);
    paths.forEach((v, i) => {
      const a0 = fwd ? us : ue, a1 = fwd ? ue : us;
      if (i === 0) {
        L.rapid(...P(a0, v));
        L.feed(null, null, z, ffp1);
      } else if (zig) {
        L.feed(...P(a0, v), null, ffp1);
      } else {
        L.rapid(null, null, z + sdis);
        L.rapid(...P(a0, v));
        L.feed(null, null, z, ffp1);
      }
      L.feed(...P(a1, v), null, ffp1);
      if (zig) fwd = !fwd;
    });
    L.rapid(null, null, z + sdis);
    if (li < zs.length - 1) L.rapid(...P(us, paths[0]));
  });
  L.rapid(null, null, rtp);
}

// ------------------------------------------------------------------------------------ pockets
function insertion(I, L, ins, z0, z1, rad1, dp1, ffd, ffp1, ccw, lineLen, rmax) {
  if (ins === 1) {
    // helical insertion around the pocket centre
    const r = Math.min(rad1 > 0 ? rad1 : 0.5 * I.cToolR(), rmax);
    if (r <= 0.05) return insertion(I, L, 0, z0, z1, 0, 0, ffd, ffp1, ccw, lineLen, rmax);
    const pitch = dp1 > 0 ? dp1 : 1;
    L.feed(r, 0, null, ffp1);
    let z = z0;
    while (z > z1 + 1e-9) {
      const zn = Math.max(z1, z - pitch);
      L.arc(-r, 0, 0, 0, !ccw, ffp1, z - (z - zn) / 2);
      L.arc(r, 0, 0, 0, !ccw, ffp1, zn);
      z = zn;
    }
    L.arc(-r, 0, 0, 0, !ccw, ffp1);
    L.arc(r, 0, 0, 0, !ccw, ffp1);
    L.feed(0, 0, null, ffp1);
  } else if (ins === 2 && lineLen > 0.5) {
    // reciprocating (oscillating) insertion along the centre line, max angle rad1 degrees
    const ang = Math.min(Math.max(num(rad1, 5), 1), 30);
    const dzPass = lineLen * 2 * Math.tan(ang * D2R);
    let z = z0;
    let x = 0;
    L.feed(-lineLen, 0, null, ffp1);
    x = -lineLen;
    while (z > z1 + 1e-9) {
      const zn = Math.max(z1, z - dzPass);
      x = -x;
      L.feed(x, 0, zn, ffp1);
      z = zn;
    }
    L.feed(-x, 0, null, ffp1);
    L.feed(0, 0, null, ffp1);
  } else {
    L.feed(null, null, z1, ffd);
  }
}

function pocket(I, kind, a) {
  const name = kind === 'rect' ? 'POCKET3' : 'POCKET4';
  let rtp, rfp, sdis0, dp, leng, wid, crad, pa, po, sta, mid, fal0, fald0, ffp1, ffd, cdir, vari0, mida0, rad1, dp1, prad;
  if (kind === 'rect') [rtp, rfp, sdis0, dp, leng, wid, crad, pa, po, sta, mid, fal0, fald0, ffp1, ffd, cdir, vari0, mida0, , , , rad1, dp1] = a;
  else [rtp, rfp, sdis0, dp, prad, pa, po, mid, fal0, fald0, ffp1, ffd, cdir, vari0, mida0, , , rad1, dp1] = a;
  const req = kind === 'rect' ? [[rtp, 'RTP'], [rfp, 'RFP'], [dp, 'DP'], [leng, 'LENG'], [wid, 'WID'], [pa, 'PA'], [po, 'PO'], [ffp1, 'FFP1'], [ffd, 'FFD']]
    : [[rtp, 'RTP'], [rfp, 'RFP'], [dp, 'DP'], [prad, 'PRAD'], [pa, 'PA'], [po, 'PO'], [ffp1, 'FFP1'], [ffd, 'FFD']];
  for (const [v, l] of req) need(I, name, v, l);
  I.cNeedTool(name);
  if (dp >= rfp) I.cErr(`61101 ${name}: reference plane defined incorrectly (DP is not below RFP)`);
  const R = I.cToolR();
  const sdis = Math.abs(num(sdis0, 0));
  const vari = num(vari0, 1);
  const u = vari % 10, ins = Math.floor(vari / 10) % 10;
  if (![0, 1, 2].includes(u)) I.cErr(`61002 ${name}: machining type VARI units digit must be 0 (complete), 1 (roughing) or 2 (finishing)`);
  const fal = u === 2 ? 0 : Math.abs(num(fal0, 0));
  const fald = u === 2 ? 0 : Math.abs(num(fald0, 0));
  const step = Math.min(num(mida0, 0) || 1.6 * R, 2 * R * 0.95);
  const ccw = climbDir(I, num(cdir, 0), true);
  const L = new Local(I, pa, po, kind === 'rect' ? num(sta, 0) : 0);
  let ringsFor;
  let rmax;
  if (kind === 'rect') {
    const A = leng / 2 - R, B = wid / 2 - R;
    if (A <= 0 || B <= 0) I.cErr(`61105 ${name}: tool radius ${R.toFixed(2)} too large for the pocket ${leng} x ${wid}`);
    if (num(crad, 0) < R - 1e-9) I.warn(`${name}: corner radius ${num(crad, 0)} smaller than the tool radius; the corners will have radius ${R.toFixed(2)}`);
    const rc = Math.max(0, num(crad, 0) - R);
    rmax = Math.max(0.05, Math.min(A, B) - fal);
    ringsFor = (off) => {
      const out = [];
      const Ar = A - off, Br = B - off, rcr = Math.max(0, rc - off);
      for (let k = 0; ; k++) {
        const aa = Ar - k * step, bb = Br - k * step;
        if (bb <= 1e-6 || aa <= 1e-6) break;
        out.push({ a: aa, segs: rrect(aa, bb, Math.max(0, rcr - k * step), ccw) });
      }
      // centre line along the long axis clears the core left inside the innermost ring
      const line = Ar >= Br ? [Ar - Br, 0] : [0, Br - Ar];
      return { rings: out.reverse(), line };
    };
  } else {
    const Rp = prad - R;
    if (Rp <= 0) I.cErr(`61105 ${name}: tool radius ${R.toFixed(2)} too large for pocket radius ${prad}`);
    rmax = Math.max(0.05, Rp - fal);
    ringsFor = (off) => {
      const out = [];
      for (let k = 0; ; k++) {
        const r = Rp - off - k * step;
        if (r <= 1e-6) break;
        out.push({ a: r, segs: circle(r, ccw) });
      }
      return { rings: out.reverse(), line: [0, 0] };
    };
  }
  L.rapid(null, null, Math.max(rtp, I.cPos().z));
  L.rapid(0, 0);
  // full clearing of one level: insertion at the centre, centre line, rings from the inside out
  const clear = (off, z, zFrom) => {
    const { rings, line } = ringsFor(off);
    L.rapid(0, 0, zFrom + sdis);
    insertion(I, L, ins, zFrom + sdis, z, num(rad1, 0), num(dp1, 0), ffd, ffp1, ccw, line[1] === 0 ? line[0] : 0, rmax);
    if (line[0] > 1e-6 || line[1] > 1e-6) {
      L.feed(-line[0], -line[1], null, ffp1);
      L.feed(line[0], line[1], null, ffp1);
    }
    for (const r of rings) {
      L.feed(r.a, 0, null, ffp1);
      L.run(r.segs, ffp1);
    }
    L.rapid(null, null, z + sdis);
  };
  // wall only (finishing): final contour at one level
  const wall = (z) => {
    const { rings } = ringsFor(0);
    const last = rings[rings.length - 1];
    L.rapid(0, 0, z + sdis);
    L.feed(null, null, z, ffd);
    L.feed(last.a, 0, null, ffp1);
    L.run(last.segs, ffp1);
    L.rapid(null, null, z + sdis);
  };
  if (u === 1 || u === 0) {
    const zs = levels(rfp, dp + fald, num(mid, 0));
    zs.forEach((z, i) => clear(fal, z, i === 0 ? rfp : zs[i - 1]));
  }
  if (u === 2 || (u === 0 && (fal > 0 || fald > 0))) {
    // finishing: base at the final depth without allowance, then the wall in MID steps
    clear(0, dp, u === 2 ? rfp : dp + fald);
    for (const z of levels(rfp, dp, num(mid, 0))) wall(z);
  }
  L.rapid(null, null, rtp);
}

// ------------------------------------------------------------------------------------ spigots
function spigot(I, kind, a) {
  const name = kind === 'rect' ? 'CYCLE76' : 'CYCLE77';
  let rtp, rfp, sdis0, dp, dpr, leng, wid, crad, pa, po, sta, mid, fal0, fald0, ffp1, ffd, cdir, vari0, ap1, ap2, prad;
  if (kind === 'rect') [rtp, rfp, sdis0, dp, dpr, leng, wid, crad, pa, po, sta, mid, fal0, fald0, ffp1, ffd, cdir, vari0, ap1, ap2] = a;
  else [rtp, rfp, sdis0, dp, dpr, prad, pa, po, mid, fal0, fald0, ffp1, ffd, cdir, vari0, ap1] = a;
  for (const [v, l] of [[rtp, 'RTP'], [rfp, 'RFP'], [pa, 'PA'], [po, 'PO'], [ffp1, 'FFP1'], [ffd, 'FFD']]) need(I, name, v, l);
  I.cNeedTool(name);
  const z = finalDepth(I, name, rfp, dp, dpr);
  const R = I.cToolR();
  const sdis = Math.abs(num(sdis0, 0));
  const vari = num(vari0, 1);
  const u = vari % 10;
  const fal = u === 2 ? 0 : Math.abs(num(fal0, 0));
  const fald = u === 2 ? 0 : Math.abs(num(fald0, 0));
  const step = 1.6 * R;
  const ccw = climbDir(I, num(cdir, 0), false);
  const L = new Local(I, pa, po, kind === 'rect' ? num(sta, 0) : 0);
  const rings = [];
  let outerA;
  if (kind === 'rect') {
    need(I, name, leng, 'LENG');
    need(I, name, wid, 'WID');
    const A = leng / 2 + R + fal, B = wid / 2 + R + fal, rc = num(crad, 0) + R + fal;
    const bx = num(ap1, 0) / 2, by = num(ap2, 0) / 2;
    const extra = Math.max(0, bx - (A - R), by - (B - R));
    const n = extra > 0 ? Math.ceil(extra / step) : 0;
    for (let k = n; k >= 0; k--) rings.push({ a: A + k * step, segs: rrect(A + k * step, B + k * step, rc + k * step, ccw) });
    outerA = A + n * step;
  } else {
    need(I, name, prad, 'PRAD');
    const r0 = prad / 2 + R + fal;
    const extra = Math.max(0, num(ap1, 0) / 2 - (r0 - R));
    const n = extra > 0 ? Math.ceil(extra / step) : 0;
    for (let k = n; k >= 0; k--) rings.push({ a: r0 + k * step, segs: circle(r0 + k * step, ccw) });
    outerA = r0 + n * step;
  }
  const startX = outerA + R + Math.max(sdis, 2);
  const zs = levels(rfp, z + fald, num(mid, 0));
  L.rapid(null, null, Math.max(rtp, I.cPos().z));
  L.rapid(startX, 0);
  zs.forEach((zz, i) => {
    L.rapid(null, null, (i === 0 ? rfp : zs[i - 1]) + sdis);
    L.feed(null, null, zz, ffd);
    for (const r of rings) {
      L.feed(r.a, 0, null, ffp1);
      L.run(r.segs, ffp1);
    }
    L.feed(startX, 0, null, ffp1);
    L.rapid(null, null, zz + sdis);
  });
  L.rapid(null, null, rtp);
}

// ------------------------------------------------------------------------------------ slots
function longhole(I, a) {
  const [rtp, rfp, sdis0, dp, dpr, n0, leng, cpa, cpo, rad, sta1, inda0, ffd, ffp1, mid] = a;
  const name = 'LONGHOLE';
  for (const [v, l] of [[rtp, 'RTP'], [rfp, 'RFP'], [leng, 'LENG'], [cpa, 'CPA'], [cpo, 'CPO'], [rad, 'RAD'], [ffd, 'FFD'], [ffp1, 'FFP1']]) need(I, name, v, l);
  I.cNeedTool(name);
  const z = finalDepth(I, name, rfp, dp, dpr);
  const R = I.cToolR();
  if (leng < 2 * R) I.cErr(`61105 ${name}: elongated hole length ${leng} is shorter than the tool diameter`);
  const sdis = Math.abs(num(sdis0, 0));
  const n = num(n0, 1);
  if (!(n >= 1) || n % 1) I.cErr(`61601 ${name}: NUM must be a whole number >= 1`);
  const inda = num(inda0, 0) || 360 / n;
  const zs = levels(rfp, z, num(mid, 0) || rfp - z);
  for (let i = 0; i < n; i++) {
    const L = new Local(I, cpa, cpo, num(sta1, 0) + i * inda);
    const x0 = rad + R, x1 = rad + leng - R;
    L.rapid(null, null, Math.max(rtp, I.cPos().z));
    L.rapid(x0, 0);
    L.rapid(null, null, rfp + sdis);
    L.feed(null, null, rfp, ffd);
    let at = x0;
    for (const zz of zs) {
      at = at === x0 ? x1 : x0;
      L.feed(at, 0, zz, ffp1);
    }
    L.feed(at === x0 ? x1 : x0, 0, null, ffp1);
    L.rapid(null, null, rtp);
  }
}

function slot1(I, a) {
  const [rtp, rfp, sdis0, dp, dpr, n0, leng, wid, cpa, cpo, rad, sta1, inda0, ffd, ffp1, mid, cdir, fal0, vari0] = a;
  const name = 'SLOT1';
  for (const [v, l] of [[rtp, 'RTP'], [rfp, 'RFP'], [leng, 'LENG'], [wid, 'WID'], [cpa, 'CPA'], [cpo, 'CPO'], [rad, 'RAD'], [ffd, 'FFD'], [ffp1, 'FFP1']]) need(I, name, v, l);
  I.cNeedTool(name);
  const z = finalDepth(I, name, rfp, dp, dpr);
  const R = I.cToolR();
  const vari = num(vari0, 0);
  const u = vari % 10;
  const fal = u === 2 ? 0 : Math.abs(num(fal0, 0));
  if (wid < 2 * R) I.cErr(`61105 ${name}: slot width ${wid} smaller than the tool diameter`);
  if (leng < wid) I.cErr(`61105 ${name}: slot length must be at least the slot width`);
  const sdis = Math.abs(num(sdis0, 0));
  const n = num(n0, 1);
  const inda = num(inda0, 0) || 360 / n;
  const ccw = climbDir(I, num(cdir, 0), true);
  const H = wid / 2 - R - fal;
  const step = 1.6 * R;
  const hs = [];
  for (let h = H; h > 1e-6; h -= step) hs.push(h);
  hs.reverse();
  const zs = levels(rfp, z, num(mid, 0));
  for (let i = 0; i < n; i++) {
    const L = new Local(I, cpa, cpo, num(sta1, 0) + i * inda);
    const x0 = rad + wid / 2, x1 = rad + leng - wid / 2;
    L.rapid(null, null, Math.max(rtp, I.cPos().z));
    L.rapid(x0, 0);
    zs.forEach((zz, li) => {
      L.rapid(x0, 0, (li === 0 ? rfp : zs[li - 1]) + sdis);
      L.feed(null, null, zz, ffd);
      L.feed(x1, 0, null, ffp1);
      for (const h of hs) {
        L.feed(x1, ccw ? -h : h, null, ffp1);
        L.run(stadium(x0, x1, h, ccw), ffp1);
      }
      L.rapid(null, null, zz + sdis);
    });
    if (fal > 0 && u === 0) {
      zs.forEach((zz) => {
        L.rapid(x1, 0, zz + sdis);
        L.feed(null, null, zz, ffd);
        const hf = wid / 2 - R;
        L.feed(x1, ccw ? -hf : hf, null, ffp1);
        L.run(stadium(x0, x1, hf, ccw), ffp1);
        L.rapid(null, null, zz + sdis);
      });
    }
    L.rapid(null, null, rtp);
  }
}

function slot2(I, a) {
  const [rtp, rfp, sdis0, dp, dpr, n0, afsl, wid, cpa, cpo, rad, sta1, inda0, ffd, ffp1, mid, cdir, fal0, vari0] = a;
  const name = 'SLOT2';
  for (const [v, l] of [[rtp, 'RTP'], [rfp, 'RFP'], [afsl, 'AFSL'], [wid, 'WID'], [cpa, 'CPA'], [cpo, 'CPO'], [rad, 'RAD'], [ffd, 'FFD'], [ffp1, 'FFP1']]) need(I, name, v, l);
  I.cNeedTool(name);
  const z = finalDepth(I, name, rfp, dp, dpr);
  const R = I.cToolR();
  const u = num(vari0, 0) % 10;
  const fal = u === 2 ? 0 : Math.abs(num(fal0, 0));
  if (wid < 2 * R) I.cErr(`61105 ${name}: slot width ${wid} smaller than the tool diameter`);
  if (rad - wid / 2 <= 0) I.cErr(`61105 ${name}: slot radius too small for the slot width`);
  const sdis = Math.abs(num(sdis0, 0));
  const n = num(n0, 1);
  const inda = num(inda0, 0) || 360 / n;
  const ccw = climbDir(I, num(cdir, 0), true);
  const H = wid / 2 - R - fal;
  const step = 1.6 * R;
  const hs = [];
  for (let h = H; h > 1e-6; h -= step) hs.push(h);
  hs.reverse();
  const zs = levels(rfp, z, num(mid, 0));
  const P = (r, deg) => ({ x: cpa + r * Math.cos(deg * D2R), y: cpo + r * Math.sin(deg * D2R) });
  const C = { x: cpa, y: cpo };
  for (let i = 0; i < n; i++) {
    const a0 = num(sta1, 0) + i * inda, a1 = a0 + afsl;
    const s = P(rad, a0), e = P(rad, a1);
    I.cRapid({ z: Math.max(rtp, I.cPos().z) });
    I.cRapid(s);
    zs.forEach((zz, li) => {
      I.cRapid({ ...s, z: (li === 0 ? rfp : zs[li - 1]) + sdis });
      I.cFeed({ z: zz }, ffd);
      I.cArc(e, C, afsl < 0, ffp1);
      for (const h of hs) {
        // curved stadium: outer arc forward, end cap, inner arc back, start cap
        I.cFeed(P(rad + h, a1), ffp1);
        I.cArc(P(rad + h, a0), C, afsl > 0, ffp1);
        I.cArc(P(rad - h, a0), s, afsl > 0, ffp1);
        I.cArc(P(rad - h, a1), C, afsl < 0, ffp1);
        I.cArc(P(rad + h, a1), e, afsl > 0, ffp1);
        I.cFeed(e, ffp1);
      }
      I.cRapid({ z: zz + sdis });
    });
    void ccw;
    I.cRapid({ z: rtp });
  }
}

// ------------------------------------------------------------------------------------ contour milling
function cycle72(I, a) {
  const [kname, rtp, rfp, sdis0, dp, mid, fal0, fald0, ffp1, ffd, vari0, rl0, as10, lp10, ff3, as20, lp20] = a;
  const name = 'CYCLE72';
  for (const [v, l] of [[rtp, 'RTP'], [rfp, 'RFP'], [dp, 'DP'], [ffp1, 'FFP1'], [ffd, 'FFD']]) need(I, name, v, l);
  I.cNeedTool(name);
  if (dp >= rfp) I.cErr(`61101 ${name}: reference plane defined incorrectly`);
  const { start, els } = I.cContour(kname);
  const R = I.cToolR();
  const sdis = Math.abs(num(sdis0, 0));
  const vari = num(vari0, 111);
  const u = vari % 10, g1between = Math.floor(vari / 10) % 10 === 1;
  const rl = num(rl0, 41);
  if (![40, 41, 42].includes(rl)) I.cErr(`61002 ${name}: RL must be 40, 41 or 42`);
  const fal = u === 2 ? 0 : Math.abs(num(fal0, 0));
  const fald = u === 2 ? 0 : Math.abs(num(fald0, 0));
  const offR = rl === 40 ? 0 : R + fal;
  const side = rl === 41 ? 1 : -1;
  let path = els.map((e) => ({ ...e }));
  path[0] = { ...path[0], s: [start.x, start.y] };
  if (offR > 0) path = compensate(path, side, offR, { approach: false, retract: false });
  path = path.filter((e) => e.kind === 'line' || e.kind === 'arc');
  const t0 = tangentAt(path[0], false), t1 = tangentAt(path[path.length - 1], true);
  const S0 = path[0].s, E0 = path[path.length - 1].e;
  const nOut = (t) => (rl === 42 ? [t[1], -t[0]] : [-t[1], t[0]]);
  const as1 = num(as10, 1) % 10, as2 = num(as20, 1) % 10;
  const lp1 = Math.abs(num(lp10, 0)) || R + 2, lp2 = Math.abs(num(lp20, 0)) || R + 2;
  const arcPoint = (P, t, n, rad, quarter, forward) => {
    const C = [P[0] + n[0] * rad, P[1] + n[1] * rad];
    const v = [P[0] - C[0], P[1] - C[1]];
    const crs = v[0] * t[1] - v[1] * t[0];
    const ccw = crs > 0;
    const ang = (quarter ? Math.PI / 2 : Math.PI) * (forward ? 1 : -1) * (ccw ? 1 : -1);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    return { C, Q: [C[0] + v[0] * ca - v[1] * sa, C[1] + v[0] * sa + v[1] * ca], ccw };
  };
  // approach start
  let A0, approach;
  if (as1 === 1) {
    A0 = [S0[0] - t0[0] * lp1, S0[1] - t0[1] * lp1];
    approach = () => I.cFeed({ x: S0[0], y: S0[1] }, ffp1);
  } else {
    const r = arcPoint(S0, t0, nOut(t0), lp1, as1 === 2, false);
    A0 = r.Q;
    approach = () => I.cArc({ x: S0[0], y: S0[1] }, { x: r.C[0], y: r.C[1] }, !r.ccw, ffp1);
  }
  let retract;
  if (as2 === 1) retract = () => I.cFeed({ x: E0[0] + t1[0] * lp2, y: E0[1] + t1[1] * lp2 }, num(ff3, ffp1));
  else {
    const r = arcPoint(E0, t1, nOut(t1), lp2, as2 === 2, true);
    retract = () => I.cArc({ x: r.Q[0], y: r.Q[1] }, { x: r.C[0], y: r.C[1] }, !r.ccw, num(ff3, ffp1));
  }
  const zs = levels(rfp, dp + fald, num(mid, 0));
  I.cRapid({ z: Math.max(rtp, I.cPos().z) });
  I.cRapid({ x: A0[0], y: A0[1] });
  zs.forEach((z, i) => {
    if (i === 0) I.cRapid({ z: rfp + sdis });
    I.cFeed({ z }, ffd);
    approach();
    for (const e of path) {
      if (e.kind === 'line') I.cFeed({ x: e.e[0], y: e.e[1] }, ffp1);
      else I.cArc({ x: e.e[0], y: e.e[1] }, { x: e.c[0], y: e.c[1] }, e.cw, ffp1);
    }
    retract();
    I.cRapid({ z: z + sdis });
    if (i < zs.length - 1) {
      if (g1between) I.cFeed({ x: A0[0], y: A0[1] }, ffp1);
      else I.cRapid({ x: A0[0], y: A0[1] });
    }
  });
  I.cRapid({ z: rtp });
}

// ------------------------------------------------------------------------------------ registry
// p: [name, label, unit, default, hint]
const P = (k, label, unit = 'mm', def = '', hint = '') => ({ k, label, unit, def, hint });
const RTP = P('RTP', 'Retraction plane (absolute)', 'mm', 25, 'Z the cycle returns to at the end');
const RFP = P('RFP', 'Reference plane (absolute)', 'mm', 0, 'Top of the material');
const SDIS = P('SDIS', 'Safety distance (no sign)', 'mm', 2, 'Clearance above the reference plane');
const DP = P('DP', 'Final depth (absolute)', 'mm', -5);
const DPR = P('DPR', 'Final depth relative to RFP (no sign)', 'mm', '', 'Used instead of DP when entered');

export const CYCLES = {
  CYCLE81: { group: 'drill', title: 'Drilling, centering', modal: true, run: (I, a) => drill(I, 'CYCLE81', a, false), params: [RTP, RFP, SDIS, DP, DPR],
    desc: 'G0 to the reference plane + safety distance, G1 to the final depth with the active F, G0 back to the retraction plane.' },
  CYCLE82: { group: 'drill', title: 'Drilling, counterboring', modal: true, run: (I, a) => drill(I, 'CYCLE82', a, true), params: [RTP, RFP, SDIS, DP, DPR, P('DTB', 'Dwell at final depth', 's', 0.5)],
    desc: 'Like CYCLE81 with a dwell at the bottom for a clean counterbore floor.' },
  CYCLE83: { group: 'drill', title: 'Deep hole drilling', modal: true, run: cycle83,
    params: [RTP, RFP, SDIS, DP, DPR, P('FDEP', 'First drilling depth (absolute)', 'mm', ''), P('FDPR', 'First drilling depth relative to RFP', 'mm', 4), P('DAM', 'Degression amount', 'mm', 0.5),
      P('DTB', 'Dwell at drilling depth', 's', 0), P('DTS', 'Dwell at start (chip removal)', 's', 0), P('FRF', 'Feed factor for first depth', '', 1), P('VARI', 'Machining type', '', 1, '0 = chip breaking, 1 = chip removal'),
      P('_AXN', 'Tool axis', '', '', 'Ignored (always Z)'), P('_MDEP', 'Minimum drilling depth', 'mm', ''), P('_VRT', 'Retraction for chip breaking', 'mm', ''), P('_DTD', 'Dwell at final depth', 's', '', 'Ignored'), P('_DIS1', 'Anticipation distance', 'mm', '')],
    desc: 'Pecks to depth. Chip breaking retracts a little after each stroke; chip removal returns to the reference plane.' },
  HOLES1: { group: 'drill', title: 'Row of holes', run: holes1, params: [P('SPCA', 'Reference point X', 'mm', -40), P('SPCO', 'Reference point Y', 'mm', 0), P('STA1', 'Angle to X axis', '°', 0), P('FDIS', 'Distance of first hole', 'mm', 0), P('DBH', 'Distance between holes', 'mm', 20), P('NUM', 'Number of holes', '', 5)],
    desc: 'Positions along a line. With MCALL active the modal drilling cycle runs at every position.' },
  HOLES2: { group: 'drill', title: 'Circle of holes', run: holes2, params: [P('CPA', 'Centre X', 'mm', 0), P('CPO', 'Centre Y', 'mm', 0), P('RAD', 'Radius', 'mm', 25), P('STA1', 'Start angle', '°', 0), P('INDA', 'Indexing angle (0 = evenly)', '°', 0), P('NUM', 'Number of holes', '', 6)],
    desc: 'Positions on a circle. With MCALL active the modal drilling cycle runs at every position.' },
  CYCLE71: { group: 'mill', title: 'Face milling', run: cycle71,
    params: [RTP, RFP, SDIS, P('DP', 'Final depth (absolute)', 'mm', -1), P('PA', 'Corner point X', 'mm', -60), P('PO', 'Corner point Y', 'mm', -40), P('LENG', 'Length in X (sign = direction)', 'mm', 120), P('WID', 'Width in Y (sign = direction)', 'mm', 80),
      P('STA', 'Angle', '°', 0), P('MID', 'Max. depth infeed', 'mm', 0.5), P('MIDA', 'Max. width infeed', 'mm', '', 'Default 80% of the tool diameter'), P('FDP', 'Overtravel at path ends', 'mm', 5),
      P('FALD', 'Finishing allowance in depth', 'mm', 0), P('FFP1', 'Feed', 'mm/min', 1300), P('VARI', 'Machining type', '', 31, '11-14 roughing / 21-24 finishing; tens: 1 X one way, 2 Y one way, 3 X zigzag, 4 Y zigzag'), P('FDP1', 'Overrun in infeed direction', 'mm', 2)],
    desc: 'Faces a rectangular area in depth steps with parallel paths, one-way or zig-zag.' },
  POCKET3: { group: 'mill', title: 'Rectangular pocket', run: (I, a) => pocket(I, 'rect', a),
    params: [RTP, RFP, SDIS, DP, P('LENG', 'Pocket length (X)', 'mm', 60), P('WID', 'Pocket width (Y)', 'mm', 40), P('CRAD', 'Corner radius', 'mm', 6), P('PA', 'Centre X', 'mm', 0), P('PO', 'Centre Y', 'mm', 0),
      P('STA', 'Angle', '°', 0), P('MID', 'Max. depth infeed', 'mm', 2), P('FAL', 'Finishing allowance edge', 'mm', 0.2), P('FALD', 'Finishing allowance base', 'mm', 0.1), P('FFP1', 'Feed in the plane', 'mm/min', 1400),
      P('FFD', 'Feed for depth infeed', 'mm/min', 400), P('CDIR', 'Milling direction', '', 0, '0 climb, 1 conventional, 2 G2, 3 G3'), P('VARI', 'Machining type', '', 11, 'Units: 0 complete, 1 roughing, 2 finishing. Tens: 0 vertical, 1 helical, 2 oscillating insertion'),
      P('MIDA', 'Max. width infeed', 'mm', ''), P('AP1', 'Blank length', 'mm', '', 'Ignored'), P('AP2', 'Blank width', 'mm', '', 'Ignored'), P('AD', 'Blank depth', 'mm', '', 'Ignored'),
      P('RAD1', 'Helix radius / max. oscillation angle', 'mm', 3), P('DP1', 'Depth per helix revolution', 'mm', 1)],
    desc: 'Clears a rectangular pocket from the centre outwards in depth steps, leaving the finishing allowances; finishing cleans base and wall.' },
  POCKET4: { group: 'mill', title: 'Circular pocket', run: (I, a) => pocket(I, 'circ', a),
    params: [RTP, RFP, SDIS, DP, P('PRAD', 'Pocket radius', 'mm', 25), P('PA', 'Centre X', 'mm', 0), P('PO', 'Centre Y', 'mm', 0), P('MID', 'Max. depth infeed', 'mm', 2), P('FAL', 'Finishing allowance edge', 'mm', 0.2),
      P('FALD', 'Finishing allowance base', 'mm', 0.1), P('FFP1', 'Feed in the plane', 'mm/min', 1200), P('FFD', 'Feed for depth infeed', 'mm/min', 400), P('CDIR', 'Milling direction', '', 0, '0 climb, 1 conventional, 2 G2, 3 G3'),
      P('VARI', 'Machining type', '', 11, 'Units: 0 complete, 1 roughing, 2 finishing. Tens: 0 vertical, 1 helical insertion'), P('MIDA', 'Max. width infeed', 'mm', ''), P('AP1', 'Blank radius', 'mm', '', 'Ignored'), P('AD', 'Blank depth', 'mm', '', 'Ignored'),
      P('RAD1', 'Helix radius', 'mm', 3), P('DP1', 'Depth per helix revolution', 'mm', 1)],
    desc: 'Clears a circular pocket with concentric circles, with vertical or helical insertion.' },
  CYCLE76: { group: 'mill', title: 'Rectangular spigot', run: (I, a) => spigot(I, 'rect', a),
    params: [RTP, RFP, SDIS, DP, DPR, P('LENG', 'Spigot length (X)', 'mm', 50), P('WID', 'Spigot width (Y)', 'mm', 30), P('CRAD', 'Corner radius', 'mm', 5), P('PA', 'Centre X', 'mm', 0), P('PO', 'Centre Y', 'mm', 0),
      P('STA', 'Angle', '°', 0), P('MID', 'Max. depth infeed', 'mm', 2), P('FAL', 'Finishing allowance edge', 'mm', 0), P('FALD', 'Finishing allowance base', 'mm', 0), P('FFP1', 'Feed', 'mm/min', 1400), P('FFD', 'Feed for depth infeed', 'mm/min', 500),
      P('CDIR', 'Milling direction', '', 0, '0 climb, 1 conventional, 2 G2, 3 G3'), P('VARI', 'Machining type', '', 1, '1 roughing, 2 finishing'), P('AP1', 'Blank length', 'mm', 80), P('AP2', 'Blank width', 'mm', 60)],
    desc: 'Machines the material around a rectangular boss, from the blank size down to the final contour.' },
  CYCLE77: { group: 'mill', title: 'Circular spigot', run: (I, a) => spigot(I, 'circ', a),
    params: [RTP, RFP, SDIS, DP, DPR, P('PRAD', 'Spigot diameter', 'mm', 40), P('PA', 'Centre X', 'mm', 0), P('PO', 'Centre Y', 'mm', 0), P('MID', 'Max. depth infeed', 'mm', 2), P('FAL', 'Finishing allowance edge', 'mm', 0),
      P('FALD', 'Finishing allowance base', 'mm', 0), P('FFP1', 'Feed', 'mm/min', 1400), P('FFD', 'Feed for depth infeed', 'mm/min', 500), P('CDIR', 'Milling direction', '', 0, '0 climb, 1 conventional, 2 G2, 3 G3'),
      P('VARI', 'Machining type', '', 1, '1 roughing, 2 finishing'), P('AP1', 'Blank diameter', 'mm', 70)],
    desc: 'Machines the material around a round boss.' },
  LONGHOLE: { group: 'mill', title: 'Elongated holes on a circle', run: longhole,
    params: [RTP, RFP, SDIS, DP, DPR, P('NUM', 'Number of holes', '', 4), P('LENG', 'Hole length', 'mm', 20), P('CPA', 'Circle centre X', 'mm', 0), P('CPO', 'Circle centre Y', 'mm', 0), P('RAD', 'Circle radius (inner end)', 'mm', 15),
      P('STA1', 'Start angle', '°', 45), P('INDA', 'Indexing angle (0 = evenly)', '°', 0), P('FFD', 'Feed for depth infeed', 'mm/min', 300), P('FFP1', 'Feed', 'mm/min', 900), P('MID', 'Max. depth per oscillation', 'mm', 1.5)],
    desc: 'Radial elongated holes as wide as the tool, milled with an oscillating infeed.' },
  SLOT1: { group: 'mill', title: 'Slots on a circle', run: slot1,
    params: [RTP, RFP, SDIS, DP, DPR, P('NUM', 'Number of slots', '', 4), P('LENG', 'Slot length', 'mm', 20), P('WID', 'Slot width', 'mm', 10), P('CPA', 'Circle centre X', 'mm', 0), P('CPO', 'Circle centre Y', 'mm', 0),
      P('RAD', 'Circle radius (inner end)', 'mm', 12), P('STA1', 'Start angle', '°', 0), P('INDA', 'Indexing angle (0 = evenly)', '°', 0), P('FFD', 'Feed for depth infeed', 'mm/min', 300), P('FFP1', 'Feed', 'mm/min', 1000),
      P('MID', 'Max. depth infeed', 'mm', 2), P('CDIR', 'Milling direction', '', 0, '0 climb, 1 conventional, 2 G2, 3 G3'), P('FAL', 'Finishing allowance', 'mm', 0), P('VARI', 'Machining type', '', 0, '0 complete, 1 roughing, 2 finishing')],
    desc: 'Radial slots wider than the tool, arranged on a circle.' },
  SLOT2: { group: 'mill', title: 'Circumferential slots', run: slot2,
    params: [RTP, RFP, SDIS, DP, DPR, P('NUM', 'Number of slots', '', 3), P('AFSL', 'Angular length of slot', '°', 60), P('WID', 'Slot width', 'mm', 8), P('CPA', 'Circle centre X', 'mm', 0), P('CPO', 'Circle centre Y', 'mm', 0),
      P('RAD', 'Radius of the slot centre line', 'mm', 25), P('STA1', 'Start angle', '°', 0), P('INDA', 'Indexing angle (0 = evenly)', '°', 0), P('FFD', 'Feed for depth infeed', 'mm/min', 300), P('FFP1', 'Feed', 'mm/min', 1000),
      P('MID', 'Max. depth infeed', 'mm', 2), P('CDIR', 'Milling direction', '', 0, 'Not used'), P('FAL', 'Finishing allowance', 'mm', 0), P('VARI', 'Machining type', '', 0, '0 complete, 1 roughing, 2 finishing')],
    desc: 'Arc-shaped slots on a circle.' },
  CYCLE72: { group: 'contour', title: 'Contour milling', run: cycle72,
    params: [P('KNAME', 'Contour: "START:END" labels', '', '"CONT_S:CONT_E"', 'Label range in this program holding the contour (G0/G1/G2/G3 blocks)'), RTP, RFP, SDIS, DP, P('MID', 'Max. depth infeed', 'mm', 2.5),
      P('FAL', 'Finishing allowance edge', 'mm', 0.3), P('FALD', 'Finishing allowance base', 'mm', 0), P('FFP1', 'Feed', 'mm/min', 1200), P('FFD', 'Feed for depth infeed', 'mm/min', 400),
      P('VARI', 'Machining type', '', 111, 'Units 1 roughing, 2 finishing; tens 0 G0 / 1 G1 between levels'), P('RL', 'Compensation', '', 41, '40 centre, 41 left, 42 right'), P('AS1', 'Approach', '', 2, '1 straight, 2 quarter circle, 3 semicircle'),
      P('LP1', 'Approach length / radius', 'mm', 8), P('FF3', 'Retract feed', 'mm/min', ''), P('AS2', 'Retract', '', 2, '1 straight, 2 quarter circle, 3 semicircle'), P('LP2', 'Retract length / radius', 'mm', 8)],
    desc: 'Mills along a contour defined between two labels, with tool radius compensation, tangential approach/retract and depth steps.' },
};

export function runCycle(name, I, args) {
  CYCLES[name].run(I, args);
}
