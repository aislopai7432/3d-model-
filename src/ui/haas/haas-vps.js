// VPS (Visual Programming System) style templates: a variables table with defaults, an illustration
// that highlights the selected variable, and a generator that writes idiomatic Haas-style G-code.
// The generated code only uses codes every ISO/Haas interpreter here understands (G00/G01/G02/G03,
// G43 H, G53, G54..G59, G81/G82/G83 with G98, G80, M03/M05/M06/M08/M09), so it always compiles; bolt
// circles, grids and pockets are written out as explicit positions and moves.

// value kinds: len (mm or inch), feed (per minute), rpm, int, deg, pct, bool (0/1), choice
const V = (k, desc, kind, mm, inch, extra = {}) => ({ k, desc, kind, def: [mm, inch ?? mm], ...extra });

const COMMON = [
  V('WORK_OFFSET', 'Work offset (54 to 59)', 'int', 54, 54, { min: 54, max: 59 }),
  V('T', 'Tool number', 'int', 1, 1, { min: 1, max: 99 }),
  V('S', 'Spindle speed (RPM)', 'rpm', 3000, 3000),
  V('F', 'Cutting feed rate', 'feed', 600, 24),
  V('M8', 'Coolant on (1) or off (0)', 'bool', 1, 1),
];

export const VPS_TEMPLATES = [
  {
    id: 'face', name: 'Face Milling', cat: 'Part Features',
    blurb: 'Faces a rectangular area in zig-zag passes along X. X/Y is the front-left corner of the area; the tool starts and ends clear of the part.',
    vars: [
      ...COMMON.map((v) => (v.k === 'T' ? { ...v, def: [1, 1] } : v.k === 'S' ? { ...v, def: [3200, 3200] } : v.k === 'F' ? { ...v, def: [1300, 50] } : v)),
      V('X', 'X of the front-left corner of the face', 'len', -60, -2.4),
      V('Y', 'Y of the front-left corner of the face', 'len', -40, -1.6),
      V('L', 'Length of the face along X', 'len', 120, 4.8, { min: 0.1 }),
      V('W', 'Width of the face along Y', 'len', 80, 3.2, { min: 0.1 }),
      V('D', 'Tool diameter (from the tool offsets if 0)', 'len', 0, 0),
      V('Q', 'Step-over in % of the tool diameter', 'pct', 70, 70, { min: 5, max: 95 }),
      V('Z', 'Final Z depth (work coordinates)', 'len', -1, -0.04),
      V('K', 'Depth of cut per pass', 'len', 0.5, 0.02, { min: 0.001 }),
      V('R', 'R plane / clearance above Z0', 'len', 2, 0.1),
    ],
  },
  {
    id: 'rpocket', name: 'Rectangular Pocket', cat: 'Part Features',
    blurb: 'Roughs a rectangular pocket from the centre outwards in rings (climb milling), ramping into each depth. Corner radius = tool radius.',
    vars: [
      ...COMMON.map((v) => (v.k === 'T' ? { ...v, def: [2, 2] } : v.k === 'S' ? { ...v, def: [9500, 9500] } : v.k === 'F' ? { ...v, def: [1400, 55] } : v)),
      V('X', 'X of the pocket centre', 'len', 0, 0),
      V('Y', 'Y of the pocket centre', 'len', 0, 0),
      V('I', 'Pocket size along X', 'len', 60, 2.4, { min: 0.1 }),
      V('J', 'Pocket size along Y', 'len', 40, 1.6, { min: 0.1 }),
      V('D', 'Tool diameter (from the tool offsets if 0)', 'len', 0, 0),
      V('Q', 'Step-over in % of the tool diameter', 'pct', 50, 50, { min: 5, max: 90 }),
      V('Z', 'Pocket depth (Z of the floor)', 'len', -6, -0.25),
      V('K', 'Depth of cut per pass', 'len', 2, 0.08, { min: 0.001 }),
      V('R', 'R plane / clearance above Z0', 'len', 2, 0.1),
    ],
  },
  {
    id: 'cpocket', name: 'Circular Pocket', cat: 'Part Features',
    blurb: 'Roughs a round pocket in concentric circles (G03, climb milling) after a ramp at the centre.',
    vars: [
      ...COMMON.map((v) => (v.k === 'T' ? { ...v, def: [2, 2] } : v.k === 'S' ? { ...v, def: [9500, 9500] } : v.k === 'F' ? { ...v, def: [1400, 55] } : v)),
      V('X', 'X of the pocket centre', 'len', 0, 0),
      V('Y', 'Y of the pocket centre', 'len', 0, 0),
      V('P', 'Pocket diameter', 'len', 40, 1.6, { min: 0.1 }),
      V('D', 'Tool diameter (from the tool offsets if 0)', 'len', 0, 0),
      V('Q', 'Step-over in % of the tool diameter', 'pct', 50, 50, { min: 5, max: 90 }),
      V('Z', 'Pocket depth (Z of the floor)', 'len', -5, -0.2),
      V('K', 'Depth of cut per pass', 'len', 2.5, 0.1, { min: 0.001 }),
      V('R', 'R plane / clearance above Z0', 'len', 2, 0.1),
    ],
  },
  {
    id: 'drill', name: 'Drilling', cat: 'Part Features',
    blurb: 'Spot (optional) and drill a hole pattern with canned cycles: G81 drill, G82 spot with dwell, G83 peck. Patterns: single hole, bolt circle or grid.',
    vars: [
      V('WORK_OFFSET', 'Work offset (54 to 59)', 'int', 54, 54, { min: 54, max: 59 }),
      V('A', 'Spot drill tool (0 = no spot drilling)', 'int', 4, 4, { min: 0, max: 99 }),
      V('B', 'Spot drill depth (Z)', 'len', -1.5, -0.06),
      V('T', 'Drill tool number', 'int', 5, 5, { min: 1, max: 99 }),
      V('S', 'Drill spindle speed (RPM)', 'rpm', 2300, 2300),
      V('F', 'Drill feed rate', 'feed', 250, 10),
      V('C', 'Cycle: 0 = G81 drill, 1 = G83 peck, 2 = G82 dwell', 'choice', 1, 1, { min: 0, max: 2 }),
      V('Z', 'Hole depth (Z of the drill point)', 'len', -10, -0.4),
      V('Q', 'Peck depth (G83)', 'len', 3, 0.1, { min: 0.001 }),
      V('R', 'R plane above Z0', 'len', 2, 0.1),
      V('M', 'Pattern: 1 = single, 2 = bolt circle, 3 = grid', 'choice', 2, 2, { min: 1, max: 3 }),
      V('X', 'X: hole, circle centre or first grid hole', 'len', 0, 0),
      V('Y', 'Y: hole, circle centre or first grid hole', 'len', 0, 0),
      V('I', 'Bolt circle radius / grid spacing X', 'len', 25, 1),
      V('J', 'Start angle (deg) / grid spacing Y', 'len', 0, 0),
      V('L', 'Number of holes / grid columns', 'int', 6, 6, { min: 1, max: 99 }),
      V('K', 'Grid rows', 'int', 2, 2, { min: 1, max: 99 }),
      V('M8', 'Coolant on (1) or off (0)', 'bool', 1, 1),
    ],
  },
];

export function getTemplate(id) {
  return VPS_TEMPLATES.find((t) => t.id === id);
}

export function defaults(tpl, inch) {
  return Object.fromEntries(tpl.vars.map((v) => [v.k, v.def[inch ? 1 : 0]]));
}

// ---------------------------------------------------------------------------------- code generation
export function fmt(v, inch) {
  const dp = inch ? 4 : 3;
  let s = (Math.round(v * 10 ** dp) / 10 ** dp).toFixed(dp).replace(/0+$/, '');
  if (s === '-0.') s = '0.';
  return s;
}

function header(name, vals, tool, inch) {
  const L = [];
  L.push(`(VPS ${name.toUpperCase()})`);
  if (tool) L.push(`(T${tool.number} ${tool.desc})`);
  L.push(`G00 G17 G40 G49 G80 G90 ${inch ? 'G20' : 'G21'}`);
  return L;
}

const ff = (v) => String(Math.round(v * 10) / 10).replace(/\.0$/, '') + '.';

// ctx: { inch, toolDia(n) -> diameter in display units, toolDesc(n) }
export function generate(tpl, vals, ctx) {
  const inch = ctx.inch;
  const f = (v) => fmt(v, inch);
  const wo = Math.max(54, Math.min(59, Math.round(vals.WORK_OFFSET || 54)));
  const cool = (vals.M8 ?? 1) ? ' M08' : '';
  const out = [];
  const err = (m) => ({ error: m });
  const toolStart = (T, S, x, y, r) => {
    out.push(`T${T} M06 (${ctx.toolDesc(T)})`);
    out.push(`G00 G90 G${wo} X${f(x)} Y${f(y)} S${Math.round(S)} M03`);
    out.push(`G43 H${String(T).padStart(2, '0')} Z${f(r + (inch ? 0.4 : 10))}${cool}`);
    out.push(`Z${f(r)}`);
  };
  const toolEnd = () => {
    out.push('G00 G90 G53 Z0. M09');
    out.push('M05');
  };
  if (tpl.id === 'face') {
    const T = Math.round(vals.T);
    const D = vals.D > 0 ? vals.D : ctx.toolDia(T);
    if (!(D > 0)) return err(`Tool T${T} has no diameter: enter D`);
    if (!(vals.K > 0)) return err('K (depth per pass) must be greater than 0');
    if (vals.Z > 0) return err('Z must be at or below Z0');
    const ae = D * Math.min(95, Math.max(5, vals.Q)) / 100;
    const ov = D * 0.1, clr = inch ? 0.08 : 2;
    const span = vals.W - D + 2 * ov;
    const rows = [];
    if (span <= 0) rows.push(vals.Y + vals.W / 2);
    else {
      const n = Math.max(2, Math.ceil(span / ae) + 1);
      for (let i = 0; i < n; i++) rows.push(vals.Y + D / 2 - ov + (span * i) / (n - 1));
    }
    const xa = vals.X - D / 2 - clr, xb = vals.X + vals.L + D / 2 + clr;
    out.push(...header('Face Milling', vals, null, inch));
    toolStart(T, vals.S, xa, rows[0], vals.R);
    const levels = depthLevels(0, vals.Z, vals.K);
    levels.forEach((z, li) => {
      out.push(`(PASS ${li + 1} OF ${levels.length} Z${f(z)})`);
      if (li) out.push(`G00 X${f(xa)} Y${f(rows[0])}`);
      out.push(`G01 Z${f(z)} F${ff(vals.F / 2)}`);
      let atA = true;
      rows.forEach((y, i) => {
        if (i) out.push(`Y${f(y)}`);
        out.push(`X${f(atA ? xb : xa)}${i === 0 ? ` F${ff(vals.F)}` : ''}`);
        atA = !atA;
      });
      out.push(`G00 Z${f(vals.R)}`);
    });
    toolEnd();
  } else if (tpl.id === 'rpocket' || tpl.id === 'cpocket') {
    const T = Math.round(vals.T);
    const D = vals.D > 0 ? vals.D : ctx.toolDia(T);
    if (!(D > 0)) return err(`Tool T${T} has no diameter: enter D`);
    const r = D / 2;
    const ae = D * Math.min(90, Math.max(5, vals.Q)) / 100;
    if (!(vals.K > 0)) return err('K (depth per pass) must be greater than 0');
    if (vals.Z >= 0) return err('Z (pocket floor) must be below Z0');
    const xc = vals.X, yc = vals.Y;
    const levels = depthLevels(0, vals.Z, vals.K);
    const fr = ff(vals.F), fz = ff(vals.F / 3);
    if (tpl.id === 'rpocket') {
      const hx = vals.I / 2 - r, hy = vals.J / 2 - r;
      if (hx < 0 || hy < 0) return err(`The pocket is smaller than the tool (Ø${f(D)})`);
      out.push(...header('Rectangular Pocket', vals, null, inch));
      toolStart(T, vals.S, xc, yc, vals.R);
      const m = Math.min(hx, hy);
      const ramp = Math.max(Math.min(hx, D * 0.6), 0);
      levels.forEach((z, li) => {
        const zPrev = li ? levels[li - 1] : 0;
        out.push(`(LEVEL ${li + 1} OF ${levels.length} Z${f(z)})`);
        out.push(`G00 X${f(xc)} Y${f(yc)}`);
        out.push(`G01 Z${f(zPrev + (inch ? 0.02 : 0.5))} F${fz}`);
        if (ramp > (inch ? 0.01 : 0.2)) {
          // zig ramp along X down to the level
          out.push(`G01 X${f(xc + ramp)} Z${f((zPrev + z) / 2)} F${fz}`);
          out.push(`X${f(xc - ramp)} Z${f(z)}`);
          out.push(`X${f(xc)}`);
        } else out.push(`G01 Z${f(z)} F${fz}`);
        // rings from the inside out, counter-clockwise (climb milling inside a pocket)
        const ds = [];
        for (let d = m; d > 1e-9; d -= ae) ds.push(d);
        ds.push(0);
        let first = true;
        for (const d of ds) {
          const ax = hx - d, ay = hy - d;
          if (ax < 1e-9 && ay < 1e-9) continue;
          out.push(`G01 X${f(xc + ax)} Y${f(yc - ay)}${first ? ` F${fr}` : ''}`);
          first = false;
          out.push(`Y${f(yc + ay)}`);
          out.push(`X${f(xc - ax)}`);
          out.push(`Y${f(yc - ay)}`);
          out.push(`X${f(xc + ax)}`);
        }
        out.push(`G01 X${f(xc)} Y${f(yc)}`);
        out.push(`G00 Z${f(vals.R)}`);
      });
      toolEnd();
    } else {
      const Rf = vals.P / 2 - r;
      if (Rf < 0) return err(`The pocket is smaller than the tool (Ø${f(D)})`);
      out.push(...header('Circular Pocket', vals, null, inch));
      toolStart(T, vals.S, xc, yc, vals.R);
      const ramp = Math.min(Rf, D * 0.4);
      levels.forEach((z, li) => {
        const zPrev = li ? levels[li - 1] : 0;
        out.push(`(LEVEL ${li + 1} OF ${levels.length} Z${f(z)})`);
        out.push(`G00 X${f(xc)} Y${f(yc)}`);
        out.push(`G01 Z${f(zPrev + (inch ? 0.02 : 0.5))} F${fz}`);
        if (ramp > (inch ? 0.01 : 0.2)) {
          out.push(`G01 X${f(xc + ramp)} Z${f((zPrev + z) / 2)} F${fz}`);
          out.push(`X${f(xc - ramp)} Z${f(z)}`);
          out.push(`X${f(xc)}`);
        } else out.push(`G01 Z${f(z)} F${fz}`);
        const radii = [];
        for (let q = Math.min(ae, Rf); q < Rf - 1e-9; q += ae) radii.push(q);
        if (Rf > 1e-9) radii.push(Rf);
        radii.forEach((q, i) => {
          out.push(`G01 X${f(xc + q)} Y${f(yc)}${i === 0 ? ` F${fr}` : ''}`);
          out.push(`G03 X${f(xc - q)} Y${f(yc)} I${f(-q)} J0.`);
          out.push(`G03 X${f(xc + q)} Y${f(yc)} I${f(q)} J0.`);
        });
        out.push(`G01 X${f(xc)} Y${f(yc)}`);
        out.push(`G00 Z${f(vals.R)}`);
      });
      toolEnd();
    }
  } else if (tpl.id === 'drill') {
    const pts = holePattern(vals);
    if (!pts.length) return err('The hole pattern has no holes');
    if (vals.Z >= vals.R) return err('Z (hole depth) must be below the R plane');
    out.push(...header('Drilling', vals, null, inch));
    const A = Math.round(vals.A || 0);
    const holes = (cyc) => {
      out.push(`${cyc} X${f(pts[0][0])} Y${f(pts[0][1])}`.replace(/^/, ''));
      for (let i = 1; i < pts.length; i++) out.push(`X${f(pts[i][0])} Y${f(pts[i][1])}`);
      out.push('G80');
    };
    if (A > 0) {
      out.push('(SPOT DRILL)');
      toolStart(A, Math.round(vals.S * 1.3), pts[0][0], pts[0][1], vals.R);
      holes(`G82 G98 Z${f(vals.B)} R${f(vals.R)} P0.3 F${ff(vals.F * 1.2)}`);
      toolEnd();
      out.push('M01');
    }
    const T = Math.round(vals.T);
    out.push('(DRILL)');
    toolStart(T, vals.S, pts[0][0], pts[0][1], vals.R);
    const cyc = Math.round(vals.C) === 1 ? `G83 G98 Z${f(vals.Z)} R${f(vals.R)} Q${f(Math.max(vals.Q, inch ? 0.001 : 0.01))} F${ff(vals.F)}`
      : Math.round(vals.C) === 2 ? `G82 G98 Z${f(vals.Z)} R${f(vals.R)} P0.5 F${ff(vals.F)}`
        : `G81 G98 Z${f(vals.Z)} R${f(vals.R)} F${ff(vals.F)}`;
    holes(cyc);
    toolEnd();
  } else return err('Unknown template');
  return { lines: out };
}

export function holePattern(v) {
  const M = Math.round(v.M);
  const pts = [];
  if (M === 1) pts.push([v.X, v.Y]);
  else if (M === 2) {
    const n = Math.max(1, Math.round(v.L));
    for (let i = 0; i < n; i++) {
      const a = ((v.J + (360 * i) / n) * Math.PI) / 180;
      pts.push([v.X + v.I * Math.cos(a), v.Y + v.I * Math.sin(a)]);
    }
  } else if (M === 3) {
    const nx = Math.max(1, Math.round(v.L)), ny = Math.max(1, Math.round(v.K));
    for (let j = 0; j < ny; j++) {
      const row = [];
      for (let i = 0; i < nx; i++) row.push([v.X + i * v.I, v.Y + j * v.J]);
      if (j % 2) row.reverse();
      pts.push(...row);
    }
  }
  return pts;
}

function depthLevels(top, bottom, step) {
  const out = [];
  const total = top - bottom;
  if (total <= 1e-9) return [bottom];
  const n = Math.max(1, Math.ceil(total / step - 1e-9));
  for (let i = 1; i <= n; i++) out.push(top - (total * i) / n);
  return out;
}

// ---------------------------------------------------------------------------------- illustrations
// Top view (plus a small side view for depths); the highlighted variable is drawn in orange.
export function illustration(tpl, vals, hi) {
  const O = '#f08c00', B = '#1a3d8a', G = '#7c8590';
  const c = (k) => (k === hi ? O : B);
  const w = (k) => (k === hi ? 2.4 : 1.2);
  const txt = (x, y, k, s = k) => `<text x="${x}" y="${y}" fill="${c(k)}" font-weight="${k === hi ? 700 : 600}">${s}</text>`;
  const dimH = (x1, x2, y, k) => `<path d="M${x1} ${y}H${x2}M${x1 + 6} ${y - 4}L${x1} ${y}l6 4M${x2 - 6} ${y - 4}L${x2} ${y}l-6 4" stroke="${c(k)}" stroke-width="${w(k)}" fill="none"/>`;
  const dimV = (y1, y2, x, k) => `<path d="M${x} ${y1}V${y2}M${x - 4} ${y1 + 6}L${x} ${y1}l4 6M${x - 4} ${y2 - 6}L${x} ${y2}l4 -6" stroke="${c(k)}" stroke-width="${w(k)}" fill="none"/>`;
  const side = (depthK, stepK, extra = '') => `<g transform="translate(212 20)"><rect x="0" y="20" width="88" height="56" fill="#dfe3e8" stroke="${G}"/>
      <rect x="22" y="20" width="44" height="${depthK === hi ? 26 : 24}" fill="#fff" stroke="${c(depthK)}" stroke-width="${w(depthK)}"/>
      ${txt(70, 40, depthK, depthK)}<path d="M0 20H88" stroke="${G}" stroke-dasharray="3 2"/><text x="-2" y="16" fill="${G}">Z0</text>
      <path d="M8 8H80" stroke="${c('R')}" stroke-width="${w('R')}" stroke-dasharray="4 3"/>${txt(82, 11, 'R')}
      ${stepK ? `<path d="M30 32H58" stroke="${c(stepK)}" stroke-width="${w(stepK)}"/>${txt(30, 30, stepK)}` : ''}${extra}</g>`;
  let body = '';
  if (tpl.id === 'face') {
    body = `<rect x="30" y="30" width="160" height="104" fill="#e9edf1" stroke="${G}"/>
      <path d="M22 44H198M198 44V60M198 60H22M22 60V76M22 76H198M198 76V92M198 92H22M22 92V108M22 108H198M198 108V124M198 124H22" stroke="#3a7d44" stroke-width="1.4" fill="none" stroke-dasharray="${hi === 'Q' ? '0' : '5 3'}"/>
      <circle cx="30" cy="134" r="4" fill="${c('X') === O || c('Y') === O ? O : B}"/>${txt(36, 148, 'X', 'X,Y')}
      ${dimH(30, 190, 20, 'L')}${txt(104, 16, 'L')}${dimV(30, 134, 206, 'W')}${txt(196, 86, 'W')}
      ${hi === 'Q' || hi === 'D' ? `<circle cx="22" cy="44" r="14" fill="none" stroke="${O}" stroke-width="2"/>${txt(4, 30, hi)}` : ''}` + side('Z', 'K');
  } else if (tpl.id === 'rpocket') {
    body = `<rect x="20" y="20" width="180" height="124" fill="#e9edf1" stroke="${G}"/>
      <rect x="50" y="44" width="120" height="76" rx="8" fill="#fff" stroke="${B}" stroke-width="1.2"/>
      <path d="M110 82m-40 0h80M110 82m0-26v52" stroke="${G}" stroke-dasharray="3 2"/>
      <circle cx="110" cy="82" r="4" fill="${hi === 'X' || hi === 'Y' ? O : B}"/>${txt(116, 78, 'X', 'X,Y')}
      ${dimH(50, 170, 34, 'I')}${txt(106, 30, 'I')}${dimV(44, 120, 186, 'J')}${txt(176, 86, 'J')}
      ${hi === 'Q' || hi === 'D' ? `<rect x="64" y="58" width="92" height="48" rx="6" fill="none" stroke="${O}" stroke-width="1.6" stroke-dasharray="4 2"/>${txt(60, 56, hi)}` : ''}` + side('Z', 'K');
  } else if (tpl.id === 'cpocket') {
    body = `<rect x="20" y="20" width="180" height="124" fill="#e9edf1" stroke="${G}"/>
      <circle cx="110" cy="82" r="48" fill="#fff" stroke="${B}" stroke-width="1.2"/>
      <circle cx="110" cy="82" r="4" fill="${hi === 'X' || hi === 'Y' ? O : B}"/>${txt(116, 78, 'X', 'X,Y')}
      ${dimH(62, 158, 140, 'P')}${txt(104, 136, 'P')}
      ${hi === 'Q' || hi === 'D' ? `<circle cx="110" cy="82" r="30" fill="none" stroke="${O}" stroke-width="1.6" stroke-dasharray="4 2"/>${txt(132, 60, hi)}` : ''}` + side('Z', 'K');
  } else if (tpl.id === 'drill') {
    const M = Math.round(vals.M);
    let holes = '';
    if (M === 1) holes = `<circle cx="110" cy="82" r="6" fill="#fff" stroke="${B}"/>`;
    else if (M === 2) {
      const n = Math.max(1, Math.min(24, Math.round(vals.L)));
      holes = `<circle cx="110" cy="82" r="42" fill="none" stroke="${hi === 'I' ? O : G}" stroke-dasharray="3 2" stroke-width="${hi === 'I' ? 2 : 1}"/>`;
      for (let i = 0; i < n; i++) {
        const a = ((vals.J + (360 * i) / n) * Math.PI) / 180;
        holes += `<circle cx="${(110 + 42 * Math.cos(a)).toFixed(1)}" cy="${(82 - 42 * Math.sin(a)).toFixed(1)}" r="5" fill="#fff" stroke="${hi === 'L' ? O : B}" stroke-width="${hi === 'L' ? 2 : 1.2}"/>`;
      }
      const a0 = (vals.J * Math.PI) / 180;
      holes += `<path d="M110 82L${(110 + 42 * Math.cos(a0)).toFixed(1)} ${(82 - 42 * Math.sin(a0)).toFixed(1)}" stroke="${hi === 'J' ? O : G}" stroke-width="${hi === 'J' ? 2 : 1}"/>${txt(150, 92, 'I')}${txt(124, 66, 'J')}${txt(60, 40, 'L', 'L holes')}`;
    } else {
      const nx = Math.max(1, Math.min(8, Math.round(vals.L))), ny = Math.max(1, Math.min(6, Math.round(vals.K)));
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) holes += `<circle cx="${50 + i * 20}" cy="${124 - j * 20}" r="5" fill="#fff" stroke="${B}"/>`;
      holes += `${dimH(50, 70, 140, 'I')}${txt(56, 138, 'I')}${dimV(104, 124, 36, 'J')}${txt(24, 118, 'J')}${txt(140, 40, 'L', 'L × K')}`;
    }
    body = `<rect x="20" y="20" width="180" height="124" fill="#e9edf1" stroke="${G}"/>${holes}
      <circle cx="${M === 3 ? 50 : 110}" cy="${M === 3 ? 124 : 82}" r="3" fill="${hi === 'X' || hi === 'Y' ? O : B}"/>${txt(M === 3 ? 56 : 116, M === 3 ? 116 : 86, 'X', 'X,Y')}`
      + side('Z', 'Q', `<path d="M44 20v26l-4-6h8l-4 6" stroke="#333" fill="none"/>${txt(0, 92, 'B', 'B spot')}`);
  }
  return `<svg viewBox="0 0 310 160" class="vps-svg" font-family="DejaVu Sans, Verdana, sans-serif" font-size="11">${body}</svg>`;
}
