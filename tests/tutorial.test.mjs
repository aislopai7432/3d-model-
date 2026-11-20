// Tutorial job T01: the part data, the reference program and the program assembled from the tutorial
// steps must machine a grade A part at the app's 'balanced' accuracy; the inspection must catch a wrong
// pocket depth; and every step's form fields must match the real programGUIDE forms (cycleforms.js),
// whose own call generation must reproduce the step's program lines.  Run: node tests/tutorial.test.mjs
const R = new URL('../src/', import.meta.url).href;
const { compileProgram } = await import(R + 'gcode/compile.js');
const { DEFAULT_TOOLS, VISE, MACHINE, ACCURACY } = await import(R + 'config.js');
const { Controller } = await import(R + 'sim/controller.js');
const { ZMap } = await import(R + 'sim/zmap.js');
const { makeCutter } = await import(R + 'sim/tooling.js');
const { targetDepthAt } = await import(R + 'game/parts.js');
const { inspectPart } = await import(R + 'game/inspect.js');
const { CYCLES } = await import(R + 'gcode/sinucycles.js');
const { buildForm, formatCall, findCall } = await import(R + 'ui/cycleforms.js');
const { TUTORIAL_PART, TUTORIAL_PROGRAM_STEPS, tutorialProgramFromSteps } = await import(R + 'game/tutorial-part.js');

// stockPlacement() lives in workholding.js, which imports three; duplicated here as in parts.test.mjs.
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
const T0 = performance.now();
const P = TUTORIAL_PART;
const STEPS = TUTORIAL_PROGRAM_STEPS;

// ---- part data
{
  const errs = [];
  if (P.id !== 'T01' || P.difficulty !== 1 || P.material !== 'aluminium') errs.push('id/difficulty/material');
  if (P.size.x !== P.stock.x || P.size.y !== P.stock.y || P.size.z > P.stock.z) errs.push('size/stock');
  if (P.stock.y > VISE.maxOpening) errs.push('too wide for the vise');
  if (P.protrusion > P.stock.z - 3) errs.push('protrusion > stock.z - 3');
  if (P.protrusion < (P.stock.z - P.size.z) + 2) errs.push('protrusion too small');
  const pl = stockPlacement({ ...P.stock, protrusion: P.protrusion });
  if (Math.abs(pl.protrusion - P.protrusion) > 1e-9) errs.push(`placement protrusion ${pl.protrusion}`);
  if (pl.bottom < VISE.floor - 1e-9) errs.push('blank below the vise floor');
  // the deepest drill point must stay above the jaw seat
  const deepest = Math.max(...P.features.map((f) => f.depth + (f.type === 'hole' ? (f.d / 2) / Math.tan(59 * Math.PI / 180) : 0)));
  if (P.stock.z - P.size.z + deepest > P.stock.z - 1) errs.push('feature through the blank');
  const ids = P.features.map((f) => f.id);
  if (ids.join() !== 'A,B,C' || new Set(ids).size !== ids.length) errs.push('feature ids');
  for (const f of P.features) {
    const bx = f.type === 'pocketRect' ? [f.x - f.w / 2, f.x + f.w / 2, f.y - f.h / 2, f.y + f.h / 2] : [f.x - f.d / 2, f.x + f.d / 2, f.y - f.d / 2, f.y + f.d / 2];
    if (bx[0] < 1 || bx[2] < 1 || bx[1] > P.size.x - 1 || bx[3] > P.size.y - 1) errs.push(`feature ${f.id} not inside the blank`);
    if (f.type === 'hole' && !DEFAULT_TOOLS.some((t) => t.type === 'drill' && Math.abs(t.diameter - f.d) < 1e-9)) errs.push(`no drill Ø${f.d}`);
    if (f.type === 'pocketRect' && f.r < 5) errs.push('pocket corner radius smaller than the Ø10 cutter');
  }
  const pk = P.features[0], hs = P.features.filter((f) => f.type === 'hole');
  for (const h of hs) {
    const gap = Math.max(Math.abs(h.x - pk.x) - pk.w / 2, Math.abs(h.y - pk.y) - pk.h / 2) - h.d / 2;
    if (gap < 2) errs.push(`hole ${h.id} too close to the pocket`);
  }
  for (const m of P.solution.matchAll(/\bT(\d+)/g)) if (!tools.has(+m[1])) errs.push('tool T' + m[1]);
  if (targetDepthAt(P, -1, 5) !== null || targetDepthAt(P, pk.x, pk.y) !== pk.depth || targetDepthAt(P, 1, 1) !== 0) errs.push('targetDepthAt');
  if (!P.setupNote || !P.notes.length || !P.customer || !P.brief) errs.push('texts');
  check(!errs.length, `T01 data ${P.stock.x}x${P.stock.y}x${P.stock.z} -> ${P.size.z}, protrusion ${P.protrusion} (jaws at ${pl.jawTop}, blank z ${pl.bottom}..${pl.top}) ${errs.join(', ')}`);
}

// ---- solution and the program built from the steps are the same program
{
  const strip = (t) => t.split('\n').map((l) => l.replace(/^N\d+\s+/, '').trim()).filter(Boolean).join('\n');
  const built = tutorialProgramFromSteps();
  check(strip(P.solution) === strip(built), 'solution = tutorialProgramFromSteps() apart from block numbers');
  const lines = built.split('\n');
  const missing = STEPS.flatMap((s) => s.programLines).filter((l) => !lines.includes(l));
  check(!missing.length, `every step's programLines is a line of the assembled program ${missing.join(' | ')}`);
  const covered = new Set(STEPS.flatMap((s) => s.features));
  check(P.features.every((f) => covered.has(f.id)), `steps make every feature (${[...covered].join(',')})`);
}

// ---- forms: every field key / label / default matches the real form, and the form's own call
// generation (formatCall, as used by the OK softkey) produces the step's lines
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
function parseForm(html) {
  const out = [];
  const re = /<span class="pk">([^<]*)<\/span><label for="cf_(\d+)"[^>]*>([^<]*)<\/label><span class="cf-in"><input id="cf_(\d+)" data-i="(\d+)" value="([^"]*)"/g;
  for (const m of html.matchAll(re)) out.push({ key: unesc(m[1]), id: `cf_${m[2]}`, index: +m[5], label: unesc(m[3]), value: unesc(m[6]) });
  return out;
}
for (const s of STEPS) {
  const errs = [];
  if (s.noForm) { check(false, `${s.id}: no form`); continue; }
  if (!CYCLES[s.cycle]) { check(false, `${s.id}: ${s.cycle} is not a form`); continue; }
  const form = parseForm(buildForm(s.cycle).html);
  if (form.length !== CYCLES[s.cycle].params.length) errs.push(`parsed ${form.length} inputs`);
  const vals = form.map((f) => f.value); // the form as it opens (defaults)
  for (const f of s.fields) {
    const inp = form.find((x) => x.key === f.key);
    if (!inp) { errs.push(`no field ${f.key}`); continue; }
    if (inp.id !== f.id || inp.index !== f.index) errs.push(`${f.key} is ${inp.id}, step says ${f.id}`);
    if (inp.label !== f.label) errs.push(`${f.key} label "${inp.label}"`);
    if (inp.value !== f.default) errs.push(`${f.key} default "${inp.value}" vs "${f.default}"`);
    if (f.edit !== (f.value !== f.default)) errs.push(`${f.key} edit flag`);
    if (!f.why) errs.push(`${f.key} why`);
    vals[inp.index] = f.value; // the player types the value
  }
  if (vals.join('|') !== s.formValues.join('|')) errs.push('formValues differ from the filled form');
  const text = formatCall(s.cycle, vals);
  if (text !== s.formText) errs.push(`form gives ${text}, step formText ${s.formText}`);
  const line = (s.modal ? 'MCALL ' : '') + text; // what OK inserts when the form is modal (Re-compile on an MCALL line)
  if (!s.programLines.includes(line)) errs.push(`form line ${line} not in programLines`);
  // Re-compile round trip: the inserted line parsed back into the form gives the same inputs
  const hit = findCall(line);
  const back = parseForm(buildForm(s.cycle, hit?.args).html).map((f) => f.value);
  if (!hit || hit.name !== s.cycle || hit.modal !== !!s.modal || back.join('|') !== vals.join('|')) errs.push('Re-compile round trip');
  if (!s.tool || !tools.has(s.tool.T) || !s.intro || !Array.isArray(s.before) || !Array.isArray(s.after)) errs.push('step data');
  if (!s.before.some((l) => new RegExp(`^T${s.tool.T} D${s.tool.D} M6\\b`).test(l))) errs.push('before has no tool change');
  check(!errs.length, `form ${s.id.padEnd(6)} ${s.cycle.padEnd(7)} ${s.fields.length} fields (${s.fields.filter((f) => f.edit).length} to change) -> ${line} ${errs.join(', ')}`);
}

// ---- machining: reference solution and assembled program both make a grade A part
const run = (label, code, expectA = true) => {
  const t0 = performance.now();
  const m = machine(P, code);
  const rep = inspectPart(P, m.zm, m.pl);
  const ok = !m.res.errors.length && !m.res.warnings.length && m.state === 'complete' && !m.alarm && rep.grade === 'A' && rep.pass;
  if (expectA) {
    check(ok, `${label}: err=${m.res.errors.length} warn=${m.res.warnings.length} state=${m.state} est=${(m.res.totalTime / 60).toFixed(1)}min grade=${rep.grade.toLowerCase()} score=${rep.score.toFixed(1)} items=${rep.items.length} within=${(rep.summary.withinTol * 100).toFixed(0)}% sim=${((performance.now() - t0) / 1000).toFixed(1)}s`);
    if (!ok || process.env.VERBOSE) {
      for (const er of m.res.errors.slice(0, 3)) console.log('   error line', er.line + 1, er.msg);
      for (const w of m.res.warnings.slice(0, 3)) console.log('   warn line', w.line + 1, w.msg);
      if (m.alarm) console.log('   alarm', m.alarm);
      for (const n of rep.notes) console.log('   note:', n);
      for (const it of rep.items) console.log(`   ${it.pass ? 'pass' : 'out '} ${it.label}: nominal ${it.nominal} measured ${it.measured} tol ${it.tol}`);
    }
  }
  return { m, rep };
};
run('T01 solution', P.solution);
run('T01 tutorialProgramFromSteps()', tutorialProgramFromSteps());

// ---- negative: the player typed depth 5 instead of 4 in the pocket form (DP -6 instead of -5)
{
  const code = tutorialProgramFromSteps().replace('POCKET3(10,-1,2,-5,', 'POCKET3(10,-1,2,-6,');
  const { m, rep } = run('', code, false);
  const it = rep.items.find((i) => i.featureId === 'A' && i.kind === 'depth');
  const ok = code !== tutorialProgramFromSteps() && m.state === 'complete' && it && !it.pass && Math.abs(it.measured - 5) < 0.05 && rep.grade !== 'A' && !rep.pass;
  check(ok, `pocket depth typed 5 instead of 4 -> depth item measured ${it?.measured} pass=${it?.pass} grade=${rep.grade.toLowerCase()} (${rep.notes.find((n) => /depth|deep/i.test(n))})`);
}
// ---- negative: drilling depth typed 1 mm too deep (DP -12.04)
{
  const code = tutorialProgramFromSteps().replace('MCALL CYCLE81(10,-1,2,-11.04)', 'MCALL CYCLE81(10,-1,2,-12.04)');
  const { m, rep } = run('', code, false);
  const bad = rep.items.filter((i) => (i.featureId === 'B' || i.featureId === 'C') && i.kind === 'depth' && !i.pass).length;
  check(m.state === 'complete' && bad === 2 && !rep.pass, `holes 1 mm too deep -> ${bad} hole depth items out, grade=${rep.grade.toLowerCase()}`);
}

const secs = (performance.now() - T0) / 1000;
console.log(failures ? `${failures} FAILURES (${secs.toFixed(0)}s)` : `ALL OK (${secs.toFixed(0)}s)`);
if (failures) process.exitCode = 1;
