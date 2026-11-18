// Workshop jobs: every reference program must compile, run without alarms on the default tools and
// pass inspection with grade A at the app's 'balanced' Z-map accuracy. Negative cases check that the
// inspection catches real mistakes.  Run: node tests/parts.test.mjs [partId]
const R = new URL('../src/', import.meta.url).href;
const { compileProgram } = await import(R + 'gcode/compile.js');
const { DEFAULT_TOOLS, VISE, MACHINE, ACCURACY } = await import(R + 'config.js');
const { Controller } = await import(R + 'sim/controller.js');
const { ZMap } = await import(R + 'sim/zmap.js');
const { makeCutter } = await import(R + 'sim/tooling.js');
const { PARTS, getPart, partDatum, targetDepthAt } = await import(R + 'game/parts.js');
const { inspectPart } = await import(R + 'game/inspect.js');

// stockPlacement() lives in workholding.js, which imports three; it is duplicated here (keep in sync).
function stockPlacement(stock) {
  const jawTop = VISE.floor + VISE.jawHeight;
  const W = Math.min(stock.y, VISE.maxOpening);
  const protrusion = Math.max(2, Math.min(stock.protrusion, stock.z - 3));
  const top = jawTop + protrusion;
  const bottom = Math.max(VISE.floor, top - stock.z);
  return { x0: -stock.x / 2, y0: -W / 2, lx: stock.x, ly: W, top: bottom + stock.z, bottom, jawTop, protrusion: bottom + stock.z - jawTop, width: W };
}
// Named collision boxes of buildVise() (table frame AABBs).
function viseBoxes(place) {
  const W = place.width, fl = VISE.floor, jt = place.jawTop, jw = VISE.jawWidth / 2, th = VISE.jawThickness;
  const b = (name, x0, y0, z0, x1, y1, z1) => ({ name, min: [x0, y0, z0], max: [x1, y1, z1] });
  return [
    b('vise base', -95, -255, 0, 95, 205, 20), b('vise body', -78, -240, 20, 78, 195, fl - 10),
    b('fixed jaw', -jw, W / 2 + 6, fl, jw, W / 2 + th, jt), b('fixed jaw plate', -jw, W / 2, fl + 4, jw, W / 2 + 6, jt),
    b('moving jaw', -jw, -W / 2 - th, fl, jw, -W / 2 - 6, jt), b('moving jaw plate', -jw, -W / 2 - 6, fl + 4, jw, -W / 2, jt),
    b('vise body', -78, W / 2 + th, fl - 10, 78, Math.min(195, W / 2 + th + 40), fl + 20), b('vise handle', -110, -350, 30, 110, -255, 60),
  ];
}

const TC = MACHINE.tableCenter, GZ = MACHINE.gaugeAtZ0;
const tools = new Map(DEFAULT_TOOLS.map((t) => [t.number, t]));
const cutters = new Map(DEFAULT_TOOLS.map((t) => [t.number, makeCutter(t)]));
const ACC = ACCURACY.balanced;

// Compiles and runs `code` on a fresh blank for `part` with the app's material removal and collision
// rules. Returns { zm, pl, res, state, alarm }.
function machine(part, code) {
  const pl = stockPlacement({ x: part.stock.x, y: part.stock.y, z: part.stock.z, protrusion: part.protrusion });
  const boxes = viseBoxes(pl);
  const offsets = [{ x: pl.x0 + TC.x, y: pl.y0 + TC.y, z: pl.top - GZ }, ...Array(5).fill(0).map(() => ({ x: 0, y: 0, z: 0 }))];
  const zm = new ZMap({ x0: pl.x0, y0: pl.y0, lx: pl.lx, ly: pl.ly, top: pl.top, bottom: pl.bottom, cell: ACC.cell, maxNodes: ACC.maxNodes });
  const res = compileProgram(code, { tools, offsets, requireG43: true, arcTol: ACC.arcTol, dialect: 'siemens' }, { pos: { x: 0, y: 0, z: 0 }, tool: 0, carousel: 1 });
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
  while (c.state !== 'complete' && c.state !== 'alarm' && frames < 200000) { c.update(1 / 30); frames++; }
  return { zm, pl, res, state: c.state, alarm: c.alarm };
}

let failures = 0;
const check = (ok, msg) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
};
const only = process.argv[2];
const T0 = performance.now();

// ---- static checks on the part data
{
  const toolsOk = new Set(DEFAULT_TOOLS.map((t) => t.number));
  for (const p of PARTS) {
    const errs = [];
    if (p.size.x !== p.stock.x || p.size.y !== p.stock.y || p.size.z > p.stock.z) errs.push('size/stock');
    if (p.stock.y > VISE.maxOpening) errs.push('too wide for the vise');
    if (p.protrusion > p.stock.z - 3) errs.push('protrusion > stock.z - 3');
    let outside = 0;
    for (const f of p.features) if (f.type === 'step' || f.type === 'boss') outside = Math.max(outside, f.depth);
    if (p.protrusion < outside + (p.stock.z - p.size.z) + 2) errs.push('protrusion too small for the outside features');
    if (!(p.difficulty >= 1 && p.difficulty <= 5)) errs.push('difficulty');
    for (const m of p.solution.matchAll(/\bT(\d+)/g)) if (!toolsOk.has(+m[1])) errs.push('tool T' + m[1]);
    if (targetDepthAt(p, -1, 5) !== null || targetDepthAt(p, p.size.x / 2, p.size.y / 2) === null) errs.push('targetDepthAt bounds');
    if (getPart(p.id) !== p) errs.push('getPart');
    check(!errs.length, `${p.id} data ${errs.join(', ')}`);
  }
  check(PARTS.length >= 8 && new Set(PARTS.map((p) => p.difficulty)).size === 5, `${PARTS.length} parts, difficulties ${[...new Set(PARTS.map((p) => p.difficulty))].join(',')}`);
}

// ---- every reference program machines a grade A part
const runs = new Map();
for (const p of PARTS) {
  if (only && p.id !== only) continue;
  const t0 = performance.now();
  const m = machine(p, p.solution);
  const ms = performance.now() - t0;
  runs.set(p.id, m);
  const t1 = performance.now();
  const rep = inspectPart(p, m.zm, m.pl);
  const ims = performance.now() - t1;
  const ok = !m.res.errors.length && m.state === 'complete' && rep.grade === 'A' && rep.pass;
  check(ok, `${p.id} ${p.title.padEnd(18)} d${p.difficulty} ${p.material.padEnd(9)} err=${m.res.errors.length} warn=${m.res.warnings.length} state=${m.state} est=${(m.res.totalTime / 60).toFixed(1)}min grade=${rep.grade} score=${rep.score.toFixed(1)} items=${rep.items.length} within=${(rep.summary.withinTol * 100).toFixed(0)}% excess=${rep.summary.excessArea.toFixed(1)}mm2 gouge=${rep.summary.gougeArea.toFixed(1)}mm2 sim=${(ms / 1000).toFixed(1)}s inspect=${ims.toFixed(0)}ms`);
  if (!ok || process.env.VERBOSE) {
    for (const er of m.res.errors.slice(0, 3)) console.log('   ERROR line', er.line + 1, er.msg);
    for (const w of m.res.warnings.slice(0, 3)) console.log('   warn line', w.line + 1, w.msg);
    if (m.alarm) console.log('   ALARM', m.alarm);
    for (const n of rep.notes) console.log('   note:', n);
    for (const it of rep.items) if (!it.pass || process.env.VERBOSE) console.log(`   ${it.pass ? 'pass' : 'out '} ${it.label}: nominal ${it.nominal} measured ${it.measured} tol ${it.tol}`);
  }
}

// ---- negative cases
const neg = (label, fn) => {
  if (only) return;
  try { fn(); } catch (e) { check(false, `${label}: ${e.stack}`); }
};
neg('unmachined blank', () => {
  const p = getPart('P01');
  const pl = stockPlacement({ ...p.stock, protrusion: p.protrusion });
  const zm = new ZMap({ x0: pl.x0, y0: pl.y0, lx: pl.lx, ly: pl.ly, top: pl.top, bottom: pl.bottom, cell: ACC.cell, maxNodes: ACC.maxNodes });
  const rep = inspectPart(p, zm, pl);
  check(rep.summary.notMachined && rep.grade === 'FAIL' && !rep.pass, `unmachined blank -> notMachined=${rep.summary.notMachined} grade=${rep.grade.toLowerCase()} pass=${rep.pass} (${rep.notes[0]})`);
});
neg('pocket 0.3 too deep', () => {
  const p = getPart('P01');
  const code = p.solution.replace(/POCKET3\(10,-1,2,-6,/g, 'POCKET3(10,-1,2,-6.3,');
  const m = machine(p, code);
  const rep = inspectPart(p, m.zm, m.pl);
  const it = rep.items.find((i) => i.featureId === 'A' && i.kind === 'depth');
  const ok = m.state === 'complete' && it && !it.pass && Math.abs(it.measured - 5.3) < 0.02 && rep.grade !== 'A' && !rep.pass;
  check(ok, `pocket 0.3 too deep -> depth item ${it?.measured} pass=${it?.pass} grade=${rep.grade.toLowerCase()} score=${rep.score.toFixed(1)} (${rep.notes.find((n) => /depth/.test(n))})`);
});
neg('missing hole', () => {
  const p = getPart('P02');
  // drop the middle row (holes E, F, G) from both the spot and the drill operation
  const code = p.solution.split('\n').filter((l) => !/HOLES1\(30,35/.test(l)).join('\n');
  const m = machine(p, code);
  const rep = inspectPart(p, m.zm, m.pl);
  const named = rep.notes.some((n) => /Hole E/.test(n) && /missing/i.test(n));
  check(m.state === 'complete' && rep.grade === 'FAIL' && named, `missing holes -> grade=${rep.grade.toLowerCase()} note: ${rep.notes.find((n) => /Hole E/.test(n))}`);
});
neg('pocket shifted 0.5 in X', () => {
  const p = getPart('P01');
  const code = p.solution.replace(/,50,30,6,50,30,/g, ',50,30,6,50.5,30,');
  const m = machine(p, code);
  const rep = inspectPart(p, m.zm, m.pl);
  const it = rep.items.find((i) => i.featureId === 'A' && i.kind === 'position');
  check(it && !it.pass && !rep.pass, `pocket shifted 0.5 -> position ${it?.measured} pass=${it?.pass} grade=${rep.grade.toLowerCase()}`);
});
neg('pocket 1 mm too small', () => {
  const p = getPart('P01');
  const code = p.solution.replace(/,50,30,6,50,30,/g, ',49,30,6,50,30,');
  const m = machine(p, code);
  const rep = inspectPart(p, m.zm, m.pl);
  const it = rep.items.find((i) => i.featureId === 'A' && i.kind === 'size' && Math.abs(i.nominal - 50) < 1e-6);
  check(it && !it.pass && !rep.pass, `pocket 1 mm short -> length ${it?.measured} pass=${it?.pass} grade=${rep.grade.toLowerCase()}`);
});
neg('top not faced', () => {
  const p = getPart('P01');
  const code = p.solution.replace(/CYCLE71\([^\n]*\n/, '\n');
  const m = machine(p, code);
  const rep = inspectPart(p, m.zm, m.pl);
  const it = rep.items.find((i) => i.kind === 'top');
  check(it && !it.pass && !rep.pass && rep.grade !== 'A', `top not faced -> thickness ${it?.measured} grade=${rep.grade.toLowerCase()}`);
});
neg('extra cut', () => {
  const p = getPart('P01');
  const code = p.solution.replace('G0 Z100 M9', 'G0 X85 Y10 Z5\nG1 Z-3 F300\nG1 X95 F800\nG0 Z100 M9');
  const m = machine(p, code);
  const rep = inspectPart(p, m.zm, m.pl);
  check(m.state === 'complete' && rep.grade === 'FAIL' && rep.summary.gougeArea > 50, `extra 2 mm deep cut -> grade=${rep.grade.toLowerCase()} gouge=${rep.summary.gougeArea.toFixed(0)}mm2 (${rep.notes.find((n) => /deeper/.test(n))})`);
});
neg('wrong hole depth', () => {
  const p = getPart('P02');
  // programmed the drill tip at the drawing depth (forgot the drill point)
  const code = p.solution.replace('CYCLE83(10,-1,2,-13.04,', 'CYCLE83(10,-1,2,-11,');
  const m = machine(p, code);
  const rep = inspectPart(p, m.zm, m.pl);
  const bad = rep.items.filter((i) => i.kind === 'depth' && !i.pass).length;
  check(bad === 7 && !rep.pass, `holes 2.04 too shallow -> ${bad} depth items out, grade=${rep.grade.toLowerCase()}`);
});

neg('counterbores missing', () => {
  const p = getPart('P07');
  const code = p.solution.split('\n').filter((l) => !/POCKET4\(10,-1,2,-7\.5/.test(l)).join('\n');
  const m = machine(p, code);
  const rep = inspectPart(p, m.zm, m.pl);
  const n = rep.notes.filter((x) => /Counterbore [A-D] .*missing/.test(x)).length;
  check(m.state === 'complete' && rep.grade === 'FAIL' && n === 4, `counterbores missing -> grade=${rep.grade.toLowerCase()}, ${n} counterbores named missing`);
});
neg('step 1 mm too narrow', () => {
  const p = getPart('P05');
  const code = p.solution.replace('CYCLE71(10,-1,2,-11,0,0,20,60,', 'CYCLE71(10,-1,2,-11,0,0,19,60,');
  const m = machine(p, code);
  const rep = inspectPart(p, m.zm, m.pl);
  const it = rep.items.find((i) => i.featureId === 'A' && i.kind === 'size');
  check(m.state === 'complete' && it && !it.pass && Math.abs(it.measured - 19) < 0.4 && !rep.pass, `step 1 mm narrow -> width ${it?.measured} pass=${it?.pass} grade=${rep.grade.toLowerCase()}`);
});
neg('boss 1 mm too long', () => {
  const p = getPart('P06');
  const code = p.solution.replace('CYCLE76(10,-1,2,-7,,70,', 'CYCLE76(10,-1,2,-7,,71,');
  const m = machine(p, code);
  const rep = inspectPart(p, m.zm, m.pl);
  const it = rep.items.find((i) => i.featureId === 'A' && i.kind === 'size' && i.nominal === 70);
  check(m.state === 'complete' && it && !it.pass && it.measured > 70.5 && !rep.pass, `boss 1 mm long -> length ${it?.measured} pass=${it?.pass} grade=${rep.grade.toLowerCase()}`);
});
neg('slot 3 mm off', () => {
  const p = getPart('P03');
  const code = p.solution.replace('SLOT1(10,-1,2,-4,,1,43,8,56,18,', 'SLOT1(10,-1,2,-4,,1,43,8,56,21,');
  const m = machine(p, code);
  const rep = inspectPart(p, m.zm, m.pl);
  check(m.state === 'complete' && !rep.pass && ['D', 'FAIL'].includes(rep.grade), `slot 3 mm off -> grade=${rep.grade.toLowerCase()} (${rep.notes.slice(1, 3).join(' | ')})`);
});

const secs = (performance.now() - T0) / 1000;
console.log(failures ? `${failures} FAILURES (${secs.toFixed(0)}s)` : `ALL OK (${secs.toFixed(0)}s)`);
if (failures) process.exitCode = 1;
