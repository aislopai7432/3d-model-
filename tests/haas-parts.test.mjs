// Haas solutions (src/game/solutions-haas.js): every job P01..P10 and the tutorial part T01 written as a
// Haas NGC program must compile in the Haas dialect without alarms, run headless through the Controller
// with the app's crash rules (rapid into material, cutting with the spindle stopped, shank / holder,
// table and vise) and pass inspection with grade A at the 'balanced' Z-map accuracy.
// Also runs the tutorial's VPS route (src/ui/haas/haas-vps.js generator) and reports its grade.
// Run: node tests/haas-parts.test.mjs [partId]
const R = new URL('../src/', import.meta.url).href;
const { compileProgram } = await import(R + 'gcode/compile.js');
const { DEFAULT_TOOLS, VISE, MACHINE, ACCURACY } = await import(R + 'config.js');
const { Controller } = await import(R + 'sim/controller.js');
const { ZMap } = await import(R + 'sim/zmap.js');
const { makeCutter } = await import(R + 'sim/tooling.js');
const { PARTS } = await import(R + 'game/parts.js');
const { TUTORIAL_PART } = await import(R + 'game/tutorial-part.js');
const { inspectPart } = await import(R + 'game/inspect.js');
const { HAAS_SOLUTIONS, haasSolution, HAAS_TUTORIAL_STEPS, haasTutorialProgramFromSteps } = await import(R + 'game/solutions-haas.js');
const { getTemplate, defaults, generate } = await import(R + 'ui/haas/haas-vps.js');

// stockPlacement() lives in workholding.js, which imports three; duplicated here (as in parts.test.mjs).
function stockPlacement(stock) {
  const jawTop = VISE.floor + VISE.jawHeight;
  const W = Math.min(stock.y, VISE.maxOpening);
  const protrusion = Math.max(2, Math.min(stock.protrusion, stock.z - 3));
  const top = jawTop + protrusion;
  const bottom = Math.max(VISE.floor, top - stock.z);
  return { x0: -stock.x / 2, y0: -W / 2, lx: stock.x, ly: W, top: bottom + stock.z, bottom, jawTop, protrusion: bottom + stock.z - jawTop, width: W };
}
function viseBoxes(place) {
  const W = place.width, fl = VISE.floor, jt = place.jawTop, jw = VISE.jawWidth / 2, th = VISE.jawThickness;
  const b = (name, x0, y0, z0, x1, y1, z1) => ({ name, min: [x0, y0, z0], max: [x1, y1, z1] });
  return [
    b('vise base', -85, -150, 0, 85, 150, 20), b('vise body', -70, -140, 20, 70, 140, fl - 10),
    b('fixed jaw', -jw, W / 2 + 6, fl, jw, W / 2 + th, jt), b('fixed jaw plate', -jw, W / 2, fl + 4, jw, W / 2 + 6, jt),
    b('moving jaw', -jw, -W / 2 - th, fl, jw, -W / 2 - 6, jt), b('moving jaw plate', -jw, -W / 2 - 6, fl + 4, jw, -W / 2, jt),
    b('vise body', -70, W / 2 + th, fl - 10, 70, Math.min(140, W / 2 + th + 30), fl + 20), b('vise handle', -85, -270, 30, 85, -150, 60),
  ];
}

const TC = MACHINE.tableCenter, GZ = MACHINE.gaugeAtZ0;
const tools = new Map(DEFAULT_TOOLS.map((t) => [t.number, t]));
const cutters = new Map(DEFAULT_TOOLS.map((t) => [t.number, makeCutter(t)]));
const ACC = ACCURACY.balanced;

function machine(part, code) {
  const pl = stockPlacement({ x: part.stock.x, y: part.stock.y, z: part.stock.z, protrusion: part.protrusion });
  const boxes = viseBoxes(pl);
  const offsets = [{ x: pl.x0 + TC.x, y: pl.y0 + TC.y, z: pl.top - GZ }, ...Array(5).fill(0).map(() => ({ x: 0, y: 0, z: 0 }))];
  const zm = new ZMap({ x0: pl.x0, y0: pl.y0, lx: pl.lx, ly: pl.ly, top: pl.top, bottom: pl.bottom, cell: ACC.cell, maxNodes: ACC.maxNodes });
  const res = compileProgram(code, { tools, offsets, requireG43: true, arcTol: ACC.arcTol, dialect: 'haas' }, { pos: { x: 0, y: 0, z: 0 }, tool: 0, carousel: 1 });
  const c = new Controller();
  c.offsets = offsets; c.homed = true; c.pos = { x: 0, y: 0, z: 0 }; c.door.pos = c.door.target = 0;
  c.program = res;
  const fixtureHit = (x, y, tip, cut) => {
    const parts = [['cutter', cut.r, tip, tip + cut.flute], ['tool shank', cut.bodyR, tip + cut.flute, tip + cut.stickout], ['tool holder', cut.holderR, tip + cut.stickout, tip + cut.length], ['spindle nose', 86, tip + cut.length, tip + cut.length + 200]];
    for (const b of boxes) {
      const dx = Math.max(b.min[0] - x, 0, x - b.max[0]), dy = Math.max(b.min[1] - y, 0, y - b.max[1]);
      for (const [name, r, z0, z1] of parts) if (dx * dx + dy * dy < r * r && z0 < b.max[2] - 0.01 && z1 > b.min[2]) return `${name} hit the ${b.name}`;
    }
    return null;
  };
  c.onMotion = (a, b, op) => {
    const cut = c.tool ? cutters.get(c.tool) : null;
    const ln = ` line ${op.line + 1}`;
    if (!cut) return null;
    const L = cut.length;
    const ax = a.x - TC.x, ay = a.y - TC.y, az = GZ + a.z - L, bx = b.x - TC.x, by = b.y - TC.y, bz = GZ + b.z - L;
    if (Math.min(az, bz) < -0.01) return 'table' + ln;
    const n = Math.min(40, Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay, bz - az) / 5)));
    for (let k = 1; k <= n; k++) {
      const f = k / n;
      const hit = fixtureHit(ax + (bx - ax) * f, ay + (by - ay) * f, az + (bz - az) * f, cut);
      if (hit) return hit + ln;
    }
    zm.shankExcess = 0;
    const v = zm.sweep(ax, ay, az, bx, by, bz, cut);
    if (v > 0.05 && op.rapid) return 'rapid into material' + ln;
    if (v > 0.05 && Math.abs(c.spindle.rpm) < 30) return 'spindle stopped' + ln;
    if (zm.shankExcess > 0.3) return `shank excess ${zm.shankExcess.toFixed(2)}` + ln;
    const holderZ = bz + cut.stickout;
    if (holderZ < zm.top + 0.01 && zm.maxInDisc(bx, by, cut.holderR) > holderZ + 0.2) return 'holder hit the part' + ln;
    return null;
  };
  c.simSpeed = 'max';
  c.cycleStart();
  let frames = 0;
  while (c.state !== 'complete' && c.state !== 'alarm' && frames < 300000) { c.update(1 / 30); frames++; }
  return { zm, pl, res, state: c.state, alarm: c.alarm };
}

let failures = 0;
const check = (ok, msg) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
};
const only = process.argv[2];
const T0 = performance.now();

// ---- static checks: style rules every program follows
const JOBS = [...PARTS, TUTORIAL_PART];
check(JOBS.every((p) => typeof HAAS_SOLUTIONS[p.id] === 'string' && haasSolution(p.id) === HAAS_SOLUTIONS[p.id]) && haasSolution('X99') === null, `HAAS_SOLUTIONS has ${Object.keys(HAAS_SOLUTIONS).length} programs (${Object.keys(HAAS_SOLUTIONS).join(' ')})`);
for (const p of JOBS) {
  if (only && p.id !== only) continue;
  const code = HAAS_SOLUTIONS[p.id];
  const errs = [];
  const lines = code.split('\n');
  if (lines[0] !== '%' || lines[lines.length - 2] !== '%') errs.push('% lines');
  if (!/^O\d{5} \(/.test(lines[1])) errs.push('O line');
  if (!/G21/.test(code) || !/G00 G17 G40 G49 G80 G90/.test(code)) errs.push('G21 / safety line');
  if (!/G28 G91 Y0\./.test(code) || !/\nM30\n/.test(code)) errs.push('end');
  for (const l of lines) {
    const s = l.replace(/\([^)]*\)/g, '');
    if (/;/.test(l)) errs.push(`';' in "${l}"`);
    if ((s.match(/M\d+/g) || []).length > 1) errs.push(`two M codes: ${l}`);
    // decimal point on every coordinate and feed (G28 G91 Z0. included)
    for (const m of s.matchAll(/\b([XYZIJKRQF])(-?[\d.]+)/g)) if (!m[2].includes('.')) errs.push(`no decimal point: ${m[0]} in "${l}"`);
  }
  for (const m of code.matchAll(/T(\d+) M06/g)) {
    if (!tools.has(+m[1])) errs.push('tool T' + m[1]);
    if (!new RegExp(`G43 H${m[1].padStart(2, '0')} `).test(code)) errs.push(`no G43 H for T${m[1]}`);
  }
  check(!errs.length, `${p.id} Haas style ${errs.slice(0, 4).join(' | ')}`);
}
check(haasTutorialProgramFromSteps() === HAAS_SOLUTIONS.T01 && HAAS_TUTORIAL_STEPS.map((s) => s.id).join() === 'face,pocket,drill'
  && HAAS_TUTORIAL_STEPS.every((s) => s.blocks.length && s.explain.length && s.tool.H === s.tool.T && getTemplate(s.vps.template)
    && Object.keys(s.vps.fields).every((k) => getTemplate(s.vps.template).vars.some((v) => v.k === k))),
'HAAS_TUTORIAL_STEPS: face, pocket, drill; T01 = program from the steps; VPS templates and field ids exist in haas-vps.js');

// ---- every program machines a grade A part
const summary = [];
for (const p of JOBS) {
  if (only && p.id !== only) continue;
  const t0 = performance.now();
  const m = machine(p, HAAS_SOLUTIONS[p.id]);
  const ms = performance.now() - t0;
  const rep = inspectPart(p, m.zm, m.pl);
  const ok = m.res.dialect === 'haas' && !m.res.errors.length && m.state === 'complete' && rep.grade === 'A' && rep.pass;
  const est = m.res.totalTime / 60;
  summary.push({ id: p.id, est });
  check(ok, `${p.id} ${p.title.padEnd(18)} ${p.material.padEnd(9)} dialect=${m.res.dialect} err=${m.res.errors.length} warn=${m.res.warnings.length} state=${m.state} est=${est.toFixed(1)}min grade=${rep.grade} score=${rep.score.toFixed(1)} items=${rep.items.length} excess=${rep.summary.excessArea.toFixed(1)}mm2 gouge=${rep.summary.gougeArea.toFixed(1)}mm2 sim=${(ms / 1000).toFixed(1)}s`);
  if (!ok || process.env.VERBOSE) {
    for (const er of m.res.errors.slice(0, 3)) console.log('   ERROR line', er.line + 1, er.msg);
    for (const w of m.res.warnings.slice(0, 3)) console.log('   warn line', w.line + 1, w.msg);
    if (m.alarm) console.log('   ALARM', m.alarm);
    for (const n of rep.notes) console.log('   note:', n);
    for (const it of rep.items) if (!it.pass || process.env.VERBOSE) console.log(`   ${it.pass ? 'pass' : 'out '} ${it.label}: nominal ${it.nominal} measured ${it.measured} tol ${it.tol}`);
  }
}

// ---- T01 through the VPS generator (face + rectangular pocket + drilling templates)
if (!only || only === 'VPS') {
  const ctx = { inch: false, toolDia: (n) => tools.get(n)?.diameter ?? 0, toolDesc: (n) => (tools.get(n)?.name ?? `T${n}`).toUpperCase().replace(/[()]/g, '') };
  const body = [];
  let genErr = null;
  for (const s of HAAS_TUTORIAL_STEPS) {
    const tpl = getTemplate(s.vps.template);
    const out = generate(tpl, { ...defaults(tpl, false), ...s.vps.fields }, ctx);
    if (out.error) genErr = `${s.id}: ${out.error}`;
    else body.push(...out.lines);
  }
  const code = ['%', 'O00002 (T01 FROM VPS)', 'G21', ...body, 'G28 G91 Y0.', 'M30', '%', ''].join('\n');
  const m = machine(TUTORIAL_PART, code);
  const rep = inspectPart(TUTORIAL_PART, m.zm, m.pl);
  const ok = !genErr && !m.res.errors.length && m.state === 'complete' && !rep.summary.notMachined;
  const outItems = rep.items.filter((i) => !i.pass).map((i) => i.label);
  check(ok, `T01 via VPS templates: err=${m.res.errors.length} state=${m.state} est=${(m.res.totalTime / 60).toFixed(1)}min grade=${rep.grade.toLowerCase()} score=${rep.score.toFixed(1)}${outItems.length ? ` (out of tolerance: ${outItems.join(', ')})` : ''}${genErr ? ' ' + genErr : ''}`);
  if (!ok) {
    for (const er of m.res.errors.slice(0, 3)) console.log('   ERROR line', er.line + 1, er.msg);
    if (m.alarm) console.log('   ALARM', m.alarm);
  }
}

const secs = (performance.now() - T0) / 1000;
if (summary.length) console.log('est. run times: ' + summary.map((s) => `${s.id} ${s.est.toFixed(1)}`).join(', ') + ' min');
console.log(failures ? `${failures} FAILURES (${secs.toFixed(0)}s)` : `ALL OK (${secs.toFixed(0)}s)`);
if (failures) process.exitCode = 1;
