// Haas (NGC) dialect: parser, decimal point rule, modal behaviour, canned cycles, G12/G13, G150,
// G70-G72, macros, subprograms and alarms; every Haas example runs headless without alarms; a workshop
// job (P01) written as a Haas program machines a grade A part.   Run: node tests/haas.test.mjs
const R = new URL('../src/', import.meta.url).href;
const { compileProgram, detectDialect } = await import(R + 'gcode/compile.js');
const { makeProgramLookup, highlightHaas } = await import(R + 'gcode/haas.js');
const { EXAMPLES_HAAS } = await import(R + 'gcode/examples-haas.js');
const { DEFAULT_TOOLS, VISE, MACHINE, ACCURACY } = await import(R + 'config.js');
const { Controller } = await import(R + 'sim/controller.js');
const { ZMap } = await import(R + 'sim/zmap.js');
const { makeCutter } = await import(R + 'sim/tooling.js');
const { getPart } = await import(R + 'game/parts.js');
const { inspectPart } = await import(R + 'game/inspect.js');

const tools = new Map(DEFAULT_TOOLS.map((t) => [t.number, { ...t }]));
const cutters = new Map(DEFAULT_TOOLS.map((t) => [t.number, makeCutter(t)]));
const OFF = { x: -203, y: -178, z: -351 };
const offsets = [OFF, ...Array(5).fill(0).map(() => ({ x: 0, y: 0, z: 0 }))];
let fail = 0;
const ok = (c, m) => {
  if (!c) fail++;
  console.log((c ? 'ok   ' : 'FAIL ') + m);
};
const near = (a, b, t = 1e-6) => Math.abs(a - b) <= t;
const H = (body) => `%\nO01000 (TEST)\n${body}\n%\n`;
const comp = (code, extra = {}, init = {}) => compileProgram(code, { tools, offsets, requireG43: true, arcTol: 0.005, dialect: 'haas', ...extra }, { pos: { x: 0, y: 0, z: 0 }, tool: 2, ...init });
const moves = (r) => r.ops.filter((o) => o.t === 'move');
// work coordinates of a machine point (G54, tool length of the op)
const W = (op, i) => ({ x: op.pts[i * 3] - OFF.x, y: op.pts[i * 3 + 1] - OFF.y, z: op.pts[i * 3 + 2] - OFF.z - (op.st.tloLen || 0) });
const lastW = (r) => { const m = moves(r).pop(); return W(m, m.pts.length / 3 - 1); };
const allPts = (r, filter = () => true) => {
  const out = [];
  for (const m of moves(r)) if (filter(m)) for (let i = 0; i < m.pts.length / 3; i++) {
    const q = { ...W(m, i), rapid: m.rapid, line: m.line };
    const l = out[out.length - 1];
    if (l && near(l.x, q.x, 1e-9) && near(l.y, q.y, 1e-9) && near(l.z, q.z, 1e-9)) continue;
    out.push(q);
  }
  return out;
};
const errNum = (r) => r.errors[0]?.alarm;
const SAFE = 'G00 G90 G17 G40 G49 G80 G54 G21\nG43 H02 Z50.\n';

// ---------------------------------------------------------------- dialect selection
ok(detectDialect('%\nO01000 (X)\nG00 X0\n', 'siemens') === 'haas', 'detect: % + O line -> haas');
ok(detectDialect('G291 ; ISO\nG0 X0', 'siemens') === 'iso' && detectDialect('%\nO1000\nG291\nG0 X0', 'siemens') === 'iso', 'detect: G291 still selects ISO');
ok(detectDialect('N10 G17 G90\nM30', 'siemens') === 'siemens' && detectDialect('G0 X0\nM30', 'haas') === 'haas', 'detect: default dialect kept (siemens / haas setting)');
ok(comp('G00 X0\nM30').dialect === 'haas', 'opts.dialect haas selects the Haas interpreter');

// ---------------------------------------------------------------- program format and decimals
let r = comp(H(SAFE + 'G00 X1 Y1000 Z10.\nM30'));
let p = lastW(r);
ok(!r.errors.length && near(p.x, 0.001) && near(p.y, 1) && near(p.z, 10), `metric: X1 = 0.001 mm, Y1000 = 1 mm (X${p.x} Y${p.y})`);
r = comp(H('G00 G90 G54 G20 G43 H02 Z2.\nX1 Y1.\nM30'));
p = lastW(r);
ok(!r.errors.length && near(p.x, 0.0001 * 25.4) && near(p.y, 25.4), `inch: X1 = 0.0001 in, Y1. = 1 in (X${p.x.toFixed(5)} Y${p.y})`);
r = comp(H(SAFE + 'G01 X10. F1200\nM30'));
ok(near(moves(r).pop().feed, 1.2), `F1200 without decimal = 1.2 mm/min (Setting 77 off): ${moves(r).pop().feed}`);
r = comp(H(SAFE + 'G01 X10. F1200\nM30'), { haasSettings: { 77: true } });
ok(near(moves(r).pop().feed, 1200), 'Setting 77 on: F1200 = 1200 mm/min');
r = comp(H(SAFE + 'G00 X1. ; Y2. ;\nM30'));
p = lastW(r);
ok(!r.errors.length && near(p.x, 1) && near(p.y, 2), '";" is an end-of-block: two blocks on one line');
r = comp(H(SAFE + 'G00 X5.\n/G00 X9.\nM30'), { blockDelete: true });
ok(near(lastW(r).x, 5), 'block delete "/" skipped when BLOCK DELETE is on');
r = comp(H(SAFE + 'G00 X5.\n/G00 X9.\nM30'));
ok(near(lastW(r).x, 9), 'block delete line runs when BLOCK DELETE is off');
r = comp(H(SAFE + 'G00 X5. (MOVE TO X5)\nM30'));
ok(!r.errors.length, 'comments in parentheses (no nesting)');
r = comp(H(SAFE + 'M03 M08\nM30'));
ok(errNum(r) === 339, `two M codes in one block -> ${r.errors[0]?.msg}`);
r = comp(H(SAFE + 'G00 G01 X5.\nM30'));
ok(errNum(r) === 339, `two group 01 codes -> ${r.errors[0]?.msg}`);
r = comp(H(SAFE + 'G00 A10.\nM30'));
ok(errNum(r) === 336, `A axis -> ${r.errors[0]?.msg}`);
r = comp(H(SAFE + 'G05 X1.\nM30'));
ok(errNum(r) === 311, `unknown G -> ${r.errors[0]?.msg}`);
r = comp(H(SAFE + 'M57\nM30'));
ok(errNum(r) === 329, `unknown M -> ${r.errors[0]?.msg}`);
r = comp(H(SAFE + 'G47 P0 (ABC)\nM30'));
ok(errNum(r) === 391, `option code -> ${r.errors[0]?.msg}`);
r = comp(H(SAFE + 'G01 X10. F200.\nG00 Y5.\nM31\nM33\nM41\nG187 P2\nG103 P1\nM30'));
ok(!r.errors.length, 'accepted no-op codes (M31 M33 M41 G187 G103)');
// one M per block executes at the END of the block: spindle op after the move
r = comp(H(SAFE + 'S1000\nG00 X10. M03\nM30'));
const iMove = r.ops.findIndex((o) => o.t === 'move' && o.line === 5), iSp = r.ops.findIndex((o) => o.t === 'spindle');
ok(iMove >= 0 && iSp > iMove, 'M03 executes after the motion of its block');
r = comp(H(SAFE + 'S99999 M03\nM30'));
ok(!r.errors.length && r.ops.find((o) => o.t === 'spindle').rpm === MACHINE.maxRpm, 'S above the maximum is clamped to max rpm');
r = comp(H(SAFE + 'M00\nM30'), {}, { rpm: 0 });
ok(r.ops.some((o) => o.t === 'stop' && !o.optional), 'M00 program stop');

// ---------------------------------------------------------------- modal defaults / G91 / G28 / G53
r = comp(H('G43 H02 Z50.\nG01 X10. F500.\nG91 X5.\nM30'));
ok(near(lastW(r).x, 15) && r.endState.cycle === 80 && r.endState.wcs === 54 && r.endState.retract === 98, 'defaults G00 G90 G54 G80 G98; G91 incremental');
r = comp(H(SAFE + 'G00 X10.\nG91 G28 Z0\nM30'));
ok(near(moves(r).pop().pts.slice(-1)[0], 0), 'G91 G28 Z0: Z to machine zero');
r = comp(H(SAFE + 'G00 X10.\nG53 G49 Z0\nG53 X-100. Y-50.\nM30'));
const mm = moves(r).pop();
ok(!r.errors.length && near(mm.pts.at(-3), -100) && near(mm.pts.at(-2), -50) && near(moves(r).at(-2).pts.at(-1), 0), 'G53 machine coordinates (no work / tool offset)');
r = comp(H(SAFE + 'G91 G53 Z0\nM30'));
ok(r.errors.length > 0, 'G53 in G91 -> alarm');
r = comp(H(SAFE + 'G00 X10.\nG04 P1.5\nG04 P250\nM30'));
const dw = r.ops.filter((o) => o.t === 'dwell').map((o) => o.sec);
ok(dw.length === 2 && near(dw[0], 1.5) && near(dw[1], 0.25), `G04 P1.5 = 1.5 s, P250 = 250 ms (${dw})`);
r = comp(H(SAFE + 'G04\nM30'));
ok(errNum(r) === 326, `G04 without P -> ${r.errors[0]?.msg}`);
r = comp(H(SAFE + 'G00 X-200. Y0 Z-400.\nM30'));
ok(errNum(r) === 318, `over travel -> ${r.errors[0]?.msg?.slice(0, 50)}`);
r = comp(H(SAFE + 'G01 X10.\nM30'));
ok(errNum(r) === 320, `G01 without F -> ${r.errors[0]?.msg}`);

// ---------------------------------------------------------------- tool length / tool change
r = comp(H('G00 G90 G54\nG43 H02 Z10.\nM30'));
ok(near(moves(r).pop().pts.at(-1), OFF.z + 100 + 10), 'G43 H02: Z + work offset + tool length (geometry + wear)');
r = comp(H('G00 G90 G54\nG43 H03 Z10.\nM30'), { haasSettings: { 15: true } });
ok(errNum(r) === 332, `Setting 15 H/T mismatch -> ${r.errors[0]?.msg}`);
r = comp(H('G00 G90 G54\nG43 H02 Z10.\nT3 M06\nG00 Z10.\nM30'));
ok(near(moves(r).pop().pts.at(-1), OFF.z + 90 + 10) && r.endState.tloH === 3, 'M06: the H offset follows the new tool (NGC)');
r = comp(H('G00 G90 G54\nT3 M06\nM08\nT4 M06\nM30'));
const cool = r.ops.filter((o) => o.t === 'coolant');
ok(cool.length === 2 && !cool[1].flood && r.ops.filter((o) => o.t === 'tool').length === 2, 'M06 turns the coolant off');
r = comp(H('G00 G90 G54\nT9 M06\nM30'));
ok(errNum(r) === 331, `T not in the tool table -> ${r.errors[0]?.msg}`);
r = comp(H('G00 G90 G54\nG81 Z-5. R2. F100. L0\nT3 M06\nM30'));
ok(errNum(r) === 372, `tool change in canned cycle -> ${r.errors[0]?.msg}`);

// ---------------------------------------------------------------- arcs
r = comp(H(SAFE + 'G00 X0 Y0\nG01 Z0 F500.\nG02 X20. Y0 I10. J0\nM30'));
ok(!r.errors.length && near(lastW(r).x, 20), 'G02 with I/J');
r = comp(H(SAFE + 'G00 X10. Y0\nG01 Z0 F500.\nG03 I-10.\nM30'));
const circ = allPts(r).filter((q) => q.line === 6);
ok(!r.errors.length && Math.min(...circ.map((q) => q.x)) < -9.99, 'full circle with I only');
r = comp(H(SAFE + 'G00 X0 Y0\nG01 Z0 F500.\nG02 X20. Y0 I9. J0\nM30'));
ok(errNum(r) === 304, `end point not on circle -> ${r.errors[0]?.msg}`);
r = comp(H(SAFE + 'G00 X0 Y0\nG01 Z0 F500.\nG02 X50. Y0 R10.\nM30'));
ok(errNum(r) === 302, `R too small -> ${r.errors[0]?.msg}`);
r = comp(H(SAFE + 'G00 X0 Y0\nG01 Z0 F500.\nG03 X10. Y10. R-10.\nM30'));
ok(!r.errors.length && Math.min(...allPts(r).filter((q) => q.line === 6).map((q) => q.y)) < -5, 'negative R = arc over 180 degrees');

// ---------------------------------------------------------------- canned cycles
const holesOf = (r) => allPts(r).filter((q, i, a) => i > 0 && !q.rapid && q.z < -0.5 && a[i - 1].z >= q.z).length;
r = comp(H(SAFE + 'G00 X0 Y0 Z20.\nG81 G99 X10. Y5. Z-5. R2. F300.\nX20.\nG98 X30.\nG80\nM30'));
let pts = allPts(r);
const bottoms = pts.filter((q) => near(q.z, -5));
ok(!r.errors.length && bottoms.length === 3 && near(bottoms[0].x, 10) && near(bottoms[2].x, 30), 'G81 drills at every X/Y block');
ok(near(pts.filter((q) => q.line === 6).at(-1).z, 2) && near(pts.at(-1).z, 20), 'G99 returns to R, G98 to the initial Z');
r = comp(H(SAFE + 'G00 X0 Y0 Z20.\nG83 Z-10. R2. Q3. F300.\nG80\nM30'));
pts = allPts(r);
const feedsDown = moves(r).filter((m) => !m.rapid).length;
ok(!r.errors.length && feedsDown === 4 && near(Math.min(...pts.map((q) => q.z)), -10), `G83 Q3 to 12 mm: 4 pecks (${feedsDown}) with full retract`);
ok(pts.filter((q) => near(q.z, 2)).length >= 4, 'G83 retracts to R between pecks');
r = comp(H(SAFE + 'G00 X0 Y0 Z20.\nG73 Z-10. R2. Q3. F300.\nG80\nM30'));
const ups = moves(r).filter((m) => m.rapid && m.pts.at(-1) > m.pts[2] && m.pts.at(-1) - m.pts[2] < 2);
ok(!r.errors.length && ups.length === 3 && near(ups[0].pts.at(-1) - ups[0].pts[2], 1.27), `G73 chip-break retract = Setting 22 (0.05 in): ${ups.map((m) => (m.pts.at(-1) - m.pts[2]).toFixed(2))}`);
r = comp(H(SAFE + 'G00 X0 Y0 Z20.\nG83 Z-10. R2. I4. J1. K2. F300.\nG80\nM30'));
const depths = moves(r).filter((m) => !m.rapid).map((m) => +(m.pts.at(-1) - OFF.z - 100).toFixed(3));
ok(!r.errors.length && depths.join() === '-2,-5,-7,-9,-10', `G83 I4 J1 K2 peck depths ${depths}`);
r = comp(H(SAFE + 'G00 X0 Y0 Z20.\nG83 Z-10. R2. Q3. I2. F300.\nM30'));
ok(errNum(r) === 306, `G83 with Q and I -> ${r.errors[0]?.msg}`);
r = comp(H(SAFE + 'G00 X0 Y0 Z20.\nG81 Z-10. F300.\nM30'));
ok(errNum(r) === 306, `canned cycle without R -> ${r.errors[0]?.msg}`);
r = comp(H(SAFE + 'G00 X0 Y0 Z20.\nG91 G81 X10. Z-5. R-18. F300. L3\nG90 G80\nM30'));
pts = allPts(r).filter((q) => near(q.z, -3));
ok(!r.errors.length && pts.length === 3 && near(pts[2].x, 30), `G91 L3: R incremental from the initial Z, Z from R; three holes 10 mm apart (${pts.map((q) => q.x)})`);
r = comp(H(SAFE + 'G00 X0 Y0 Z20.\nG82 Z-3. R2. P500 F300.\nG80\nM30'));
ok(near(r.ops.find((o) => o.t === 'dwell')?.sec, 0.5), 'G82 dwell P500 = 0.5 s');
r = comp(H(SAFE + 'S1000 M03\nG00 X0 Y0 Z20.\nG84 Z-8. R2. F1000.\nG80\nM30'));
const spd = r.ops.filter((o) => o.t === 'spindle').map((o) => o.dir);
ok(!r.errors.length && spd.slice(0, 3).join() === '1,-1,1', `G84 reverses the spindle at the bottom (${spd})`);
r = comp(H(SAFE + 'S1000 M03\nG00 X0 Y0 Z20.\nG85 Z-8. R2. F300.\nG80\nM30'));
ok(moves(r).filter((m) => !m.rapid).length === 2, 'G85 feeds in and out');
r = comp(H(SAFE + 'S1000 M03\nG00 X0 Y0 Z20.\nG86 Z-8. R2. F300.\nG80\nM30'));
ok(r.ops.filter((o) => o.t === 'spindle').map((o) => o.dir).slice(0, 3).join() === '1,0,1', 'G86 stops the spindle at the bottom and restarts it');
r = comp(H(SAFE + 'S1000 M03\nG00 X0 Y0 Z20.\nG76 Z-8. R2. Q0.2 P100 F300.\nG80\nM30'));
const shift = allPts(r).find((q) => near(q.x, 0.2) && near(q.z, -8));
ok(!r.errors.length && shift, 'G76 shifts by Q (Setting 27 X+) at the bottom');
r = comp(H(SAFE + 'G00 X0 Y0 Z20.\nG87 Z-8. R2. F300.\nM30'));
ok(errNum(r) === 391, 'G87 not supported on NGC');

// bolt patterns
r = comp(H(SAFE + 'G00 X10. Y5. Z20.\nG81 G99 Z-2. R2. F300. L0\nG70 I25. J30. L6\nG80\nM30'));
let b = allPts(r).filter((q) => near(q.z, -2));
ok(!r.errors.length && b.length === 6 && b.every((q) => near(Math.hypot(q.x - 10, q.y - 5), 25, 1e-6)) && near(b[0].x, 10 + 25 * Math.cos(Math.PI / 6)), 'G70 bolt circle: 6 holes R25 from 30 degrees, none at the centre (L0)');
r = comp(H(SAFE + 'G00 X0 Y0 Z20.\nG81 G99 Z-2. R2. F300. L0\nG71 I20. J0 K30. L3\nG80\nM30'));
b = allPts(r).filter((q) => near(q.z, -2));
ok(b.length === 3 && near(b[2].x, 20 * Math.cos(Math.PI / 3)) && near(b[2].y, 20 * Math.sin(Math.PI / 3)), 'G71 bolt arc');
r = comp(H(SAFE + 'G00 X0 Y0 Z20.\nG81 G99 Z-2. R2. F300. L0\nG72 I10. J90. L4\nG80\nM30'));
b = allPts(r).filter((q) => near(q.z, -2));
ok(b.length === 4 && near(b[0].y, 0) && near(b[3].y, 30) && near(b[3].x, 0), 'G72 holes along an angle, first at the current position');
r = comp(H(SAFE + 'G70 I25. J0 L6\nM30'));
ok(r.errors.length > 0, 'G70 without a canned cycle -> alarm');

// ---------------------------------------------------------------- G12 / G13
r = comp(H(SAFE + 'G00 X0 Y0 Z2.\nG13 Z-3. I8. K15. Q4. D02 F600.\nM30'));
pts = allPts(r).filter((q) => near(q.z, -3));
let rmax = Math.max(...pts.map((q) => Math.hypot(q.x, q.y)));
ok(!r.errors.length && near(rmax, 10, 1e-3) && near(lastW(r).x, 0) && near(lastW(r).y, 0), `G13 I8 K15 with D02 (r5): outer tool path radius ${rmax.toFixed(4)} = K - r, ends at the centre`);
// CCW check: signed area of the last full circle
const sa = (arr) => arr.reduce((s, q, i) => s + (i ? arr[i - 1].x * q.y - q.x * arr[i - 1].y : 0), 0);
const fullCirc = pts.filter((q) => near(Math.hypot(q.x, q.y), 10, 1e-3));
ok(sa(fullCirc) > 0, 'G13 cuts counter-clockwise');
r = comp(H(SAFE + 'G00 X0 Y0 Z2.\nG12 Z-3. I8. K15. Q4. D02 F600.\nM30'));
ok(sa(allPts(r).filter((q) => near(q.z, -3) && near(Math.hypot(q.x, q.y), 10, 1e-3))) < 0, 'G12 cuts clockwise');
r = comp(H(SAFE + 'G00 X0 Y0 Z0\nG13 G91 Z-2. I8. D02 L3 F600.\nG90\nM30'));
ok(!r.errors.length && near(Math.min(...allPts(r).map((q) => q.z)), -6) && near(Math.max(...allPts(r).filter((q) => q.z < -5).map((q) => Math.hypot(q.x, q.y))), 3, 1e-3), 'G13 G91 L3: three 2 mm passes, I only = one circle (radius I - r)');
r = comp(H(SAFE + 'G00 X0 Y0 Z2.\nG13 Z-3. I4. D02 F600.\nM30'));
ok(errNum(r) === 331, `G13 I smaller than the tool radius -> ${r.errors[0]?.msg}`);
r = comp(H(SAFE + 'G00 X0 Y0 Z2.\nG13 Z-3. I8. K15. D02 F600.\nM30'));
ok(r.errors.length > 0, 'G13 K without Q -> alarm');

// ---------------------------------------------------------------- G150
const G150 = (extra = '', sub = 'N41 G01 Y-15.\nX45.\nY15.\nX5.\nY-15.\nX25.\nM99') => H(SAFE + `G00 X25. Y0 Z2.\nG01 Z0 F300.\nG150 P41 J4. K0.2 G41 D02 Z-5. Q2.5 R1. F1000. ${extra}\nG40 G01 X25. Y0\nG00 Z25.\nM30\n${sub}`);
r = comp(G150());
pts = allPts(r).filter((q) => near(q.z, -5));
const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
ok(!r.errors.length && near(Math.min(...xs), 10, 1e-6) && near(Math.max(...xs), 40, 1e-6) && near(Math.min(...ys), -10, 1e-6) && near(Math.max(...ys), 10, 1e-6), `G150 finish pass = outline - tool radius: X${Math.min(...xs).toFixed(3)}..${Math.max(...xs).toFixed(3)} Y${Math.min(...ys).toFixed(3)}..${Math.max(...ys).toFixed(3)}`);
ok(near(Math.min(...allPts(r).filter((q) => near(q.z, -1.5)).map((q) => q.x)), 10.2, 1e-6) && allPts(r).some((q) => near(q.z, -4)), 'G150 levels by Q from the R plane (-1.5, -4, -5); roughing leaves K = 0.2');
ok(near(lastW(r).z, 25), 'G150 ends at the R plane, program continues');
r = comp(G150('', 'N41 G01 Y-15.\nX45.\nY15.\nX5.\nY-14.\nM99'));
ok(errNum(r) === 370, `G150 open outline -> ${r.errors[0]?.msg}`);
r = comp(H(SAFE + 'G00 X25. Y0 Z2.\nG150 P77 J4. Z-5. Q2.5 R1. F1000.\nM30'));
ok(errNum(r) === 314, `G150 outline not found -> ${r.errors[0]?.msg}`);
r = comp(G150('', 'N41 G01 Y-15.\nX#1\nM99'));
ok(errNum(r) === 532, `macro variable in the G150 outline -> ${r.errors[0]?.msg}`);

// ---------------------------------------------------------------- cutter compensation
r = comp(H(SAFE + 'G00 X-30. Y-30. Z2.\nG01 Z-2. F300.\nG41 D02 X-20. Y-20. F800.\nY20.\nX20.\nY-20.\nX-20.\nG40 X-30. Y-30.\nM30'));
pts = allPts(r).filter((q) => near(q.z, -2) && q.line >= 7 && q.line <= 10);
ok(!r.errors.length && near(Math.min(...pts.map((q) => q.x)), -25, 1e-6) && near(Math.max(...pts.map((q) => q.y)), 25, 1e-6), 'G41 D02 outside a CW square: tool centre 5 mm outside');
r = comp(H(SAFE + 'G00 X0 Y0 Z2.\nG41 D02 G02 X10. Y0 I5. F300.\nM30'));
ok(errNum(r) === 340, `comp start on G02 -> ${r.errors[0]?.msg}`);
r = comp(H(SAFE + 'G00 X0 Y0 Z2.\nG41 D02 G01 X10. F300.\nM30'));
ok(errNum(r) === 349, `M30 with comp active -> ${r.errors[0]?.msg}`);

// ---------------------------------------------------------------- offsets and coordinate systems
r = comp(H('G10 L2 P2 G90 X-100. Y-50. Z-300.\nG00 G55 G43 H02 X1. Y2. Z3.\nM30'));
let mv = moves(r).pop();
ok(!r.errors.length && r.ops.some((o) => o.t === 'offset' && o.index === 1) && near(mv.pts.at(-3), -99) && near(mv.pts.at(-1), -300 + 100 + 3), 'G10 L2 P2 writes G55 (offset op) and G55 uses it');
r = comp(H('G10 L10 P2 R110.\nG00 G90 G54 G43 H02 Z0\nM30'));
ok(near(moves(r).pop().pts.at(-1), OFF.z + 110) && r.res === undefined && r.toolOffsetWrites[0].length === 110, 'G10 L10 sets the length geometry used by G43');
r = comp(H(SAFE + 'G154 P1\nM30'));
ok(errNum(r) === 331, `G154 P1 with 6 offsets -> ${r.errors[0]?.msg}`);
r = comp(H('G154 P1 G00 G43 H02 X0 Y0 Z0\nM30'), { offsets: [...offsets, { x: -10, y: -20, z: -300 }] });
ok(!r.errors.length && near(moves(r).pop().pts[3], -10) && r.endState.wcsName === 'G154 P1', 'G154 P1 uses offset 7 when the table has it');
r = comp(H(SAFE + 'G52 X10. Y5.\nG00 X0 Y0\nM30'));
p = moves(r).pop();
ok(near(p.pts.at(-3) - OFF.x, 10) && near(p.pts.at(-2) - OFF.y, 5), 'G52 shift');
r = comp(H(SAFE + 'G00 X10. Y10.\nG92 X0 Y0\nG00 X5.\nM30'));
ok(near(moves(r).pop().pts.at(-3) - OFF.x, 15), 'G92 sets the current position');
r = comp(H(SAFE + 'G51 X0 Y0 P2.\nG00 X10. Y5.\nG50\nM30'));
p = lastW(r);
ok(near(p.x, 20) && near(p.y, 10), `G51 P2 scaling (X${p.x} Y${p.y})`);
r = comp(H(SAFE + 'G00 X0 Y0\nG68 X0 Y0 R90.\nG00 X10. Y0\nG69\nM30'));
p = lastW(r);
ok(near(p.x, 0, 1e-9) && near(p.y, 10, 1e-9), `G68 R90 rotation (X${p.x.toFixed(6)} Y${p.y.toFixed(6)})`);
r = comp(H(SAFE + 'G101 X0\nG00 X10. Y3.\nG100\nM30'));
p = lastW(r);
ok(near(p.x, -10) && near(p.y, 3), 'G101 X0 mirror');
r = comp(H(SAFE + 'G101 X0\nG00 X10. Y0\nG01 Z0 F300.\nG02 X0 Y10. R10.\nG100\nM30'));
ok(!r.errors.length && allPts(r).filter((q) => q.line === 7).every((q) => q.x <= 1e-9), 'mirrored arc stays on the mirrored side (direction reversed)');

// ---------------------------------------------------------------- macros
r = comp(H(SAFE + '#1=2*3+1\n#2=[#1+1]/4\n#3=SQRT[16]+ABS[-1]+ROUND[2.5]+FIX[2.7]+FUP[2.1]\n#4=ATAN[1]/[1]\nG00 X#1 Y#2 Z#3\nG01 X[#4/9] F500.\nM30'));
p = lastW(r);
ok(!r.errors.length && near(p.x, 5) && near(p.y, 2) && near(p.z, 4 + 1 + 3 + 2 + 3), `expressions and functions (X${p.x} Y${p.y} Z${p.z})`);
r = comp(H(SAFE + '#1=0\nWHILE [#1 LT 5] DO1\n#1=#1+1\nEND1\nG00 X#1\nM30'));
ok(near(lastW(r).x, 5), 'WHILE [..] DO1 / END1');
r = comp(H(SAFE + '#1=3\nN10 #1=#1-1\nIF [#1 GT 0] GOTO10\nIF [#1 EQ 0] THEN #2=7\nG00 X#2 Y#1\nM30'));
p = lastW(r);
ok(near(p.x, 7) && near(p.y, 0), 'IF [..] GOTO n / IF [..] THEN');
r = comp(H(SAFE + 'G00 X0 Y0\nG00 X5. Y#0\nM30'));
ok(!r.errors.length && near(lastW(r).y, 0), 'a vacant variable (#0) omits the address');
r = comp(H(SAFE + 'IF [#1 EQ #0] THEN #3000=7 (VALUE MISSING)\nM30'));
ok(errNum(r) === 1007 && /VALUE MISSING/.test(r.errors[0].msg), `#3000 programmable alarm -> ${r.errors[0]?.msg}`);
r = comp(H(SAFE + '#3006=1 (TURN THE PART)\nM30'));
ok(r.ops.some((o) => o.t === 'msg' && o.text === 'TURN THE PART') && r.ops.some((o) => o.t === 'stop'), '#3006 stop with message');
r = comp(H(SAFE + '#1=1/0\nM30'));
ok(errNum(r) === 508, `division by zero -> ${r.errors[0]?.msg}`);
r = comp(H(SAFE + '#5=#5021\n#6=#2001\n#7=#4003\n#8=#5221\nG00 X#6 Y#7\nM30'));
ok(!r.errors.length && near(lastW(r).x, 95) && near(lastW(r).y, 90), 'system variables (#2001 tool length, #4003 modal G90)');
r = comp(H(SAFE + '#5221=-100.\nG00 X0\nM30'));
ok(r.ops.some((o) => o.t === 'offset' && o.index === 0 && o.x === -100) && near(moves(r).pop().pts.at(-3), -100), 'writing #5221 sets G54 X');
r = comp(H(SAFE + 'GOTO99\nM30'));
ok(errNum(r) === 337, `GOTO to a missing N -> ${r.errors[0]?.msg}`);
r = comp(H(SAFE + 'N1 GOTO1\nM30'));
ok(r.errors.length && /loop/i.test(r.errors[0].msg), 'endless GOTO loop is detected');
r = comp(H(SAFE + 'G00 X[1+\nM30'));
ok(r.errors.length && r.errors[0].line === 4, `syntax error reported on its line: ${r.errors[0]?.msg}`);

// ---------------------------------------------------------------- subprograms
r = comp(H(SAFE + '#100=0\nM97 P100 L3\nG00 X#100\nM30\nN100 #100=#100+2.\nM99'));
ok(!r.errors.length && near(lastW(r).x, 6) && r.endVars[100] === 6, 'M97 local subprogram with L3; #100 kept in endVars');
r = comp(H(SAFE + 'M98 P2000\nG00 Y#101\nM30\n%\n'), { programLookup: (n) => (n === 2000 ? '%\nO02000 (SUB)\n#101=4.\nG00 X3.\nM99\n%' : null) });
ok(!r.errors.length && near(lastW(r).x, 3) && near(lastW(r).y, 4) && r.ops.every((o) => o.line < 8), 'M98 external program via programLookup (ops on the calling line)');
const store = { names: () => ['O02000.NC', 'JOB.MPF'], get: (k) => (k === 'O02000.NC' ? 'O02000\nG00 X7.\nM99' : 'X') };
r = comp(H(SAFE + 'M98 P2000\nM30'), { programLookup: makeProgramLookup(store) });
ok(!r.errors.length && near(lastW(r).x, 7), 'makeProgramLookup matches O02000.NC');
r = comp(H(SAFE + 'M98 P3000\nM30'));
ok(errNum(r) === 314, `M98 program missing -> ${r.errors[0]?.msg}`);
r = comp(H(SAFE + 'G65 P9001 A2. B3. I1. I4.\nG00 X#100 Y#101\nM30\nO09001 (MAC)\n#100=#1*#2\n#101=#4+#7\nM99'));
ok(!r.errors.length && near(lastW(r).x, 6) && near(lastW(r).y, 5), 'G65 arguments A->#1 B->#2, I sets -> #4, #7');
r = comp(H(SAFE + '#1=9\nG65 P9002 A1.\nG00 X#1\nM30\nO09002\n#1=#1+5\nM99'));
ok(near(lastW(r).x, 9), 'G65 has its own local variables');
r = comp(H(SAFE + 'M97 P10\nM30\nN10 G00 X1.\nM99 P20\nN20 G00 Y2.\nM30'));
ok(!r.errors.length, 'M99 P returns to a line');
r = comp(H(SAFE + 'M97 P10\nM30\nN10 M97 P10\nM99'));
ok(errNum(r) === 307, `subprogram nesting -> ${r.errors[0]?.msg}`);

// ---------------------------------------------------------------- MDI continuation of the modal state
r = comp(H(SAFE + 'G00 X0 Y0\nG91 G01 X1. F500.\nM30'));
const r2 = comp('X1.', { forceDialect: 'haas' }, { modal: r.endState, pos: r.endPos });
ok(!r2.errors.length && r2.dialect === 'haas' && near(lastW(r2).x, 2), 'modal state (G91, F) continues into an MDI block');
ok(highlightHaas('G01 X#1 (C) IF [#1 GT 2] GOTO10').some((s) => s.cls === 'kw'), 'syntax highlighting');

// ---------------------------------------------------------------- examples, headless
for (const ex of EXAMPLES_HAAS) {
  const st = ex.stock;
  const prot = Math.max(2, Math.min(st.protrusion, st.z - 3));
  const top = VISE.floor + VISE.jawHeight + prot;
  const offs = [{ x: -203, y: -178, z: top - MACHINE.gaugeAtZ0 }, ...Array(5).fill(0).map(() => ({ x: 0, y: 0, z: 0 }))];
  const res = compileProgram(ex.code, { tools, offsets: offs, requireG43: true, arcTol: 0.01, dialect: 'siemens' }, { pos: { x: 0, y: 0, z: 0 }, tool: 0, carousel: 1 });
  const zm = new ZMap({ x0: -st.x / 2, y0: -st.y / 2, lx: st.x, ly: st.y, top, bottom: top - st.z, cell: 0.5, maxNodes: 200000 });
  const c = new Controller();
  c.offsets = offs; c.homed = true; c.pos = { x: 0, y: 0, z: 0 }; c.door.pos = c.door.target = 0;
  c.program = res;
  c.onMotion = (a, b2, op) => {
    const cut = c.tool ? cutters.get(c.tool) : null;
    if (!cut) return null;
    const L = cut.length;
    const ax = a.x + 203, ay = a.y + 178, az = 483 + a.z - L, bx = b2.x + 203, by = b2.y + 178, bz = 483 + b2.z - L;
    zm.shankExcess = 0;
    const v = zm.sweep(ax, ay, az, bx, by, bz, cut);
    if (v > 0.05 && op.rapid) return `rapid into material line ${op.line + 1}`;
    if (v > 0.05 && Math.abs(c.spindle.rpm) < 30) return `spindle stopped line ${op.line + 1}`;
    if (zm.shankExcess > 0.3) return `shank line ${op.line + 1}`;
    if (bz < -0.01) return 'table';
    return null;
  };
  c.simSpeed = 'max';
  c.cycleStart();
  let frames = 0;
  while (c.state !== 'complete' && c.state !== 'alarm' && frames < 400000) { c.update(1 / 30); frames++; }
  const good = res.dialect === 'haas' && !res.errors.length && !res.warnings.length && c.state === 'complete' && zm.removedTotal > 1000;
  ok(good, `example ${ex.id.padEnd(13)} ${ex.file} ops=${res.ops.length} err=${res.errors.length} warn=${res.warnings.length} state=${c.state} removed=${zm.removedTotal.toFixed(0)}mm3 est=${(res.totalTime / 60).toFixed(2)}min`);
  if (!good) {
    for (const e of res.errors.slice(0, 3)) console.log('   error line', e.line + 1, e.msg);
    for (const w of res.warnings.slice(0, 3)) console.log('   warn line', w.line + 1, w.msg);
    if (c.alarm) console.log('   alarm', c.alarm);
  }
}

// ---------------------------------------------------------------- workshop job P01 as a Haas program
// G54 = top front-left corner of the raw blank (as for the reference 808D programs).
const P01_HAAS = `%
O01001 (JOB P01 LOCATING PLATE)
(BLANK 100 X 60 X 21 ALUMINIUM, G54 = TOP FRONT-LEFT OF THE RAW BLANK)
(OP1 FACE TO Z-1, OP2 POCKET 50 X 30 R6 TO Z-6 WITH G150)
T1 M06 (FACE MILL D50)
G00 G90 G17 G40 G49 G80 G54 G21
S3200 M03
X-30. Y10.
G43 H01 Z25. M08
Z2.
G01 Z-1. F600.
X130. F1300.
Y30.
X-30.
Y50.
X130.
G00 Z25. M09
G53 G49 Z0 M05
T2 M06 (END MILL D10)
G00 G90 G54 X50. Y30.
S9500 M03
G43 H02 Z25. M08
Z2.
G01 Z-1. F400.
G150 P100 J4. K0.2 G41 D02 Z-6. Q2.5 R-1. F1400.
G40 G01 X50. Y30.
G00 Z25. M09
G53 G49 Z0 M05
G53 Y0
M30
N100 (POCKET OUTLINE, CCW FROM THE START HOLE)
G01 Y15.
X69.
G03 X75. Y21. R6.
G01 Y39.
G03 X69. Y45. R6.
G01 X31.
G03 X25. Y39. R6.
G01 Y21.
G03 X31. Y15. R6.
G01 X50.
M99
%
`;
{
  const part = getPart('P01');
  const ACC = ACCURACY.balanced;
  const TC = MACHINE.tableCenter, GZ = MACHINE.gaugeAtZ0;
  const jawTop = VISE.floor + VISE.jawHeight;
  const Wd = Math.min(part.stock.y, VISE.maxOpening);
  const protrusion = Math.max(2, Math.min(part.protrusion, part.stock.z - 3));
  const topZ = jawTop + protrusion;
  const bottom = Math.max(VISE.floor, topZ - part.stock.z);
  const pl = { x0: -part.stock.x / 2, y0: -Wd / 2, lx: part.stock.x, ly: Wd, top: bottom + part.stock.z, bottom, jawTop, protrusion: bottom + part.stock.z - jawTop, width: Wd };
  const offs = [{ x: pl.x0 + TC.x, y: pl.y0 + TC.y, z: pl.top - GZ }, ...Array(5).fill(0).map(() => ({ x: 0, y: 0, z: 0 }))];
  const zm = new ZMap({ x0: pl.x0, y0: pl.y0, lx: pl.lx, ly: pl.ly, top: pl.top, bottom: pl.bottom, cell: ACC.cell, maxNodes: ACC.maxNodes });
  const res = compileProgram(P01_HAAS, { tools, offsets: offs, requireG43: true, arcTol: ACC.arcTol, dialect: 'siemens' }, { pos: { x: 0, y: 0, z: 0 }, tool: 0, carousel: 1 });
  const c = new Controller();
  c.offsets = offs; c.homed = true; c.pos = { x: 0, y: 0, z: 0 }; c.door.pos = c.door.target = 0;
  c.program = res;
  c.onMotion = (a, b2, op) => {
    const cut = c.tool ? cutters.get(c.tool) : null;
    if (!cut) return null;
    const L = cut.length;
    const ax = a.x - TC.x, ay = a.y - TC.y, az = GZ + a.z - L, bx = b2.x - TC.x, by = b2.y - TC.y, bz = GZ + b2.z - L;
    if (Math.min(az, bz) < -0.01) return 'table';
    zm.shankExcess = 0;
    const v = zm.sweep(ax, ay, az, bx, by, bz, cut);
    if (v > 0.05 && op.rapid) return `rapid into material line ${op.line + 1}`;
    if (v > 0.05 && Math.abs(c.spindle.rpm) < 30) return `spindle stopped line ${op.line + 1}`;
    if (zm.shankExcess > 0.3) return `shank line ${op.line + 1}`;
    return null;
  };
  c.simSpeed = 'max';
  c.cycleStart();
  let frames = 0;
  while (c.state !== 'complete' && c.state !== 'alarm' && frames < 400000) { c.update(1 / 30); frames++; }
  const rep = inspectPart(part, zm, pl);
  const good = res.dialect === 'haas' && !res.errors.length && c.state === 'complete' && rep.grade === 'A' && rep.pass;
  ok(good, `P01 as a Haas program (G150 pocket): err=${res.errors.length} state=${c.state} grade=${rep.grade} score=${rep.score.toFixed(1)}`);
  if (!good) {
    for (const e of res.errors.slice(0, 3)) console.log('   error line', e.line + 1, e.msg);
    if (c.alarm) console.log('   alarm', c.alarm);
    for (const n of rep.notes) console.log('   note:', n);
    for (const it of rep.items) if (!it.pass) console.log(`   out ${it.label}: nominal ${it.nominal} measured ${it.measured} tol ${it.tol}`);
  }
}

console.log(fail ? `${fail} FAILURES` : 'ALL OK');
if (fail) process.exitCode = 1;
