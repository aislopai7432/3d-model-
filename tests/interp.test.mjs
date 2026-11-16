const R = new URL('../src/', import.meta.url).href;
const { Interpreter } = await import(R + 'gcode/interpreter.js');
const { EXAMPLES, getExample } = await import(R + 'gcode/examples.js');
const { DEFAULT_TOOLS, VISE, MACHINE } = await import(R + 'config.js');
const tools = new Map(DEFAULT_TOOLS.map((t) => [t.number, t]));
function offsetsFor(stock) {
  const top = VISE.floor + VISE.jawHeight + stock.protrusion;
  const g54 = { x: MACHINE.tableCenter.x, y: MACHINE.tableCenter.y, z: top - MACHINE.gaugeAtZ0 };
  return [g54, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }];
}
let fail = 0;
for (const e of EXAMPLES) {
  const ex = getExample(e.id);
  const it = new Interpreter({ tools, offsets: offsetsFor(ex.stock), requireG43: true, arcTol: 0.01 });
  const t0 = performance.now();
  const r = it.compile(ex.code, { pos: { x: 0, y: 0, z: 0 }, tool: 0 });
  const ms = performance.now() - t0;
  const lines = ex.code.split('\n').length;
  console.log(`${e.id.padEnd(12)} lines=${String(lines).padStart(5)} ops=${String(r.ops.length).padStart(6)} err=${r.errors.length} warn=${r.warnings.length} time=${(r.totalTime/60).toFixed(2)}min compile=${ms.toFixed(1)}ms tools=${[...r.toolsUsed]}`);
  if (r.workBounds) console.log('   work bounds', r.workBounds.min.map((v) => v.toFixed(2)).join(','), '|', r.workBounds.max.map((v) => v.toFixed(2)).join(','));
  for (const er of r.errors.slice(0, 5)) { console.log('   ERROR line', er.line + 1, er.msg, '|', ex.code.split('\n')[er.line]); fail++; }
  for (const w of r.warnings.slice(0, 5)) console.log('   warn line', w.line + 1, w.msg);
}
// unit checks
function compile(code, opts = {}) {
  const it = new Interpreter({ tools, offsets: [{ x: -280, y: -205, z: -368 }, {x:0,y:0,z:0},{x:0,y:0,z:0},{x:0,y:0,z:0},{x:0,y:0,z:0},{x:0,y:0,z:0}], requireG43: true, arcTol: 0.01, ...opts });
  return it.compile(code, { pos: { x: 0, y: 0, z: 0 }, tool: 2 });
}
function assert(c, m) { if (!c) { console.log('FAIL', m); fail++; } else console.log('ok  ', m); }
let r = compile('G90 G54 G0 X10 Y5\nG43 H2 Z10\nG1 Z-1 F100\nG2 X20 Y5 I5 J0\nG3 X10 Y5 R5\nG91 G1 X-5\nG90');
assert(r.errors.length === 0, 'basic program compiles');
const last = r.ops.filter((o) => o.t === 'move').pop();
const p = last.pts.slice(-3);
assert(Math.abs(p[0] - (-280 + 5)) < 1e-9 && Math.abs(p[1] - (-205 + 5)) < 1e-9, 'incremental move lands at X5 Y5 work');
const arc = r.ops.filter((o) => o.t === 'move')[3];
let maxy = -1e9; for (let i = 1; i < arc.pts.length; i += 3) maxy = Math.max(maxy, arc.pts[i]);
let miny = 1e9; for (let i = 1; i < arc.pts.length; i += 3) miny = Math.min(miny, arc.pts[i]);
assert(Math.abs(miny + 205 - 5) < 1e-6 && Math.abs(maxy + 205 - 10) < 0.02, 'G2 from X10 to X20 around X15 passes over the top' + ` miny=${miny + 205} maxy=${maxy+205}`);
r = compile('G0 X0 Y0\nG1 X10 F100\nG41 D2 X5');
assert(r.errors.length === 1 && /G41/.test(r.errors[0].msg), 'G41 rejected: ' + r.errors[0]?.msg);
r = compile('G0 X0 Y0\nG1 X10');
assert(r.errors.length === 1 && /feed/i.test(r.errors[0].msg), 'missing F rejected: ' + r.errors[0]?.msg);
r = compile('G0 X0 Y0\nG2 X10 Y0 I3 J0 F100');
assert(r.errors.length === 1 && /circle/.test(r.errors[0].msg), 'bad arc rejected: ' + r.errors[0]?.msg);
r = compile('G0 X400');
assert(r.errors.length === 1 && /Over-travel/.test(r.errors[0].msg), 'over-travel rejected: ' + r.errors[0]?.msg);
r = compile('G0 G1 X5');
assert(r.errors.length === 1 && /conflicts/.test(r.errors[0].msg), 'modal conflict rejected: ' + r.errors[0]?.msg);
r = compile('G0 A10');
assert(r.errors.length === 1 && /3-axis/.test(r.errors[0].msg), 'A axis rejected: ' + r.errors[0]?.msg);
r = compile('G0 X1 (unclosed');
assert(r.errors.length === 1 && /closing/.test(r.errors[0].msg), 'unclosed comment: ' + r.errors[0]?.msg);
r = compile('G20 G0 X1. Y1.\nG21');
const m = r.ops.find((o) => o.t === 'move');
assert(Math.abs(m.pts[3] - (-280 + 25.4)) < 1e-9, 'G20 converts inches');
r = compile('G43 H2 G0 Z50\nG0 X0 Y0\nG98 G81 X10 Y10 Z-5 R2 F100\nX20\nG80');
const moves = r.ops.filter((o) => o.t === 'move');
assert(r.errors.length === 0 && moves.length === 10, 'G81 generates moves: ' + moves.length);
r = compile('G43 H2 G0 Z50\nG0 X0 Y0\nG83 X10 Y10 Z-10 R2 Q3 F100\nG80');
assert(r.errors.length === 0, 'G83 compiles, moves=' + r.ops.filter((o) => o.t === 'move').length);
r = compile('G4 P1500\nG4 P1.5\nG4 X2');
assert(r.ops.filter((o) => o.t === 'dwell').map((o) => o.sec).join(',') === '1.5,1.5,2', 'dwell units');
r = compile('T3 M06\nG43 H3 Z20\nS9000 M3\nM8\nM30');
assert(r.errors.length === 0 && r.ops.some((o) => o.t === 'tool' && o.tool === 3), 'tool change op');
r = compile('G0 X0 Y0 Z0\nG2 X0 Y0 I-5 J0 Z-3 F100');
assert(r.errors.length === 0, 'helix full circle compiles');
r = compile('M98 P1000');
assert(r.errors.length === 1, 'M98 rejected: ' + r.errors[0]?.msg);
r = compile('G28');
assert(r.errors.length === 0, 'G28 all axes');
r = compile('G10 L2 P2 X-100 Y-100 Z-300\nG55 G0 X0 Y0');
const mv = r.ops.find((o) => o.t === 'move');
assert(Math.abs(mv.pts[3] + 100) < 1e-9, 'G10 L2 then G55 move');
console.log(fail ? `\n${fail} FAILURES` : '\nALL OK');
