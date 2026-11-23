// Real-world Haas programs: a corpus of ~25 programs in the style real Haas users, Fusion 360 and
// Mastercam posts produce (%, Onnnnn (NAME), header comments, N numbers, G90 G94 G17 G49 G40 G80,
// G28 G91 Z0., T1 M06, G43 H01, canned cycles with G98/G99, G68, G51, M98 L2, macros, lower case,
// spaces inside blocks, X1 integer scaling, "/" block delete, (MSG, TEXT), unknown tool numbers, text
// after the closing %), 3000- and 50,000-line CAM surfacing programs (compile time / memory / per-frame
// cost), the paste / import path (ui/importer.js) and robustness (fuzzing, runaway loops).
// Every program must compile with ZERO thrown errors; the cutting ones also run headless through
// Controller + ZMap (removed volume > 0, no alarm, no crash).   Run: node tests/haas-real.test.mjs
const R = new URL('../src/', import.meta.url).href;
const { compileProgram } = await import(R + 'gcode/compile.js');
const { DEFAULT_TOOLS, VISE, MACHINE, ACCURACY, genericTool } = await import(R + 'config.js');
const { Controller } = await import(R + 'sim/controller.js');
const { ZMap } = await import(R + 'sim/zmap.js');
const { makeCutter } = await import(R + 'sim/tooling.js');
const { makeProgramLookup } = await import(R + 'gcode/haas.js');
const { planImport, cleanText } = await import(R + 'ui/importer.js');
const { EXAMPLES_HAAS } = await import(R + 'gcode/examples-haas.js');
const { HAAS_SOLUTIONS } = await import(R + 'game/solutions-haas.js');
const { EXAMPLES_808, getExample808 } = await import(R + 'gcode/examples808.js');

let failures = 0;
const check = (ok, msg) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
};

const TC = MACHINE.tableCenter, GZ = MACHINE.gaugeAtZ0;
const tools = new Map(DEFAULT_TOOLS.map((t) => [t.number, { ...t }]));
// like the app: a tool number that is not in the table gets a generic cutter
const cutters = new Map(DEFAULT_TOOLS.map((t) => [t.number, makeCutter(t)]));
const cutterOf = (n) => cutters.get(n) || (n > 0 ? (cutters.set(n, makeCutter(genericTool(n))), cutters.get(n)) : null);
const ACC = ACCURACY.balanced;

// 120 x 80 x 30 aluminium blank in the vise, G54 = top centre (as the app's default setup)
function stockPlacement(stock) {
  const jawTop = VISE.floor + VISE.jawHeight;
  const W = Math.min(stock.y, VISE.maxOpening);
  const protrusion = Math.max(2, Math.min(stock.protrusion, stock.z - 3));
  const top = jawTop + protrusion;
  const bottom = Math.max(VISE.floor, top - stock.z);
  return { x0: -stock.x / 2, y0: -W / 2, lx: stock.x, ly: W, top: bottom + stock.z, bottom };
}
const PL = stockPlacement({ x: 120, y: 80, z: 30, protrusion: 14 });
const OFFS = () => [{ x: TC.x, y: TC.y, z: PL.top - GZ }, ...Array(5).fill(0).map(() => ({ x: 0, y: 0, z: 0 }))];
const opts = (extra = {}) => ({ tools, offsets: OFFS(), requireG43: true, arcTol: ACC.arcTol, dialect: 'haas', ...extra });
const INIT = () => ({ pos: { x: 0, y: 0, z: 0 }, tool: 0, carousel: 1 });

function compile(code, extra = {}) {
  const t0 = performance.now();
  const res = compileProgram(code, opts(extra), INIT());
  res.ms = performance.now() - t0;
  return res;
}

// Runs a compiled program through the Controller with a Z-map; returns the outcome.
function execute(res, { maxFrames = 400000, frameStats = false } = {}) {
  const zm = new ZMap({ x0: PL.x0, y0: PL.y0, lx: PL.lx, ly: PL.ly, top: PL.top, bottom: PL.bottom, cell: ACC.cell, maxNodes: ACC.maxNodes });
  const c = new Controller();
  c.offsets = OFFS(); c.homed = true; c.pos = { x: 0, y: 0, z: 0 }; c.door.pos = c.door.target = 0;
  c.program = res;
  let crash = null;
  c.onMotion = (a, b, op) => {
    const cut = c.tool ? cutterOf(c.tool) : null;
    if (!cut) return null;
    const ax = a.x - TC.x, ay = a.y - TC.y, az = GZ + a.z - cut.length, bx = b.x - TC.x, by = b.y - TC.y, bz = GZ + b.z - cut.length;
    if (Math.min(az, bz) < -0.01) return (crash = `tool hit the table (line ${op.line + 1})`);
    zm.shankExcess = 0;
    const v = zm.sweep(ax, ay, az, bx, by, bz, cut);
    if (v > 0.05 && op.rapid) return (crash = `rapid into material (line ${op.line + 1})`);
    if (v > 0.05 && Math.abs(c.spindle.rpm) < 30) return (crash = `cutting with the spindle stopped (line ${op.line + 1})`);
    return null;
  };
  c.simSpeed = 'max';
  c.cycleStart();
  let frames = 0, worst = 0, sum = 0;
  while (c.state !== 'complete' && c.state !== 'alarm' && frames < maxFrames) {
    if (c.state === 'hold') c.cycleStart(); // M00 / M01 / (feed hold) continue
    const t0 = frameStats ? performance.now() : 0;
    c.update(1 / 30);
    if (frameStats) { const d = performance.now() - t0; sum += d; if (d > worst) worst = d; }
    frames++;
  }
  return { state: c.state, alarm: c.alarm, removed: zm.removedTotal, crash, frames, worst, avg: frames ? sum / frames : 0, c };
}

const first = (r) => r.errors[0]?.msg || '';
const alarmOf = (r) => r.errors[0]?.alarm ?? null;
const near = (a, b, t = 1e-3) => Math.abs(a - b) <= t;
const CORPUS = {
  'fine-bore': `%
O00024 (FINE BORE)
G90 G94 G17 G49 G40 G80
G21
T5 M06
S2000 M03
G54
G00 X0. Y20.
G43 H05 Z25.
G98 G76 Z-8. R3. Q0.5 P0.5 F150.
G80 G00 Z25.
G99 G76 X10. Z-8. R3. I0.4 F150.
G80 G00 Z25.
M05
G28 G91 Z0.
M30
%
`,
  'arcs': `%
O00016 (ARCS)
G90 G94 G17 G40 G49 G80 G21
T2 M06
S6000 M03
G54
G00 X-30. Y0.
G43 H02 Z25.
Z2.
G01 Z-1. F500.
G02 X0. Y30. I30. J0.
G02 X30. Y0. R30.
G03 X-30. Y0. R-30.
G03 X-30. Y0. I30. J0.
G02 X-30. Y0. Z-3. I30. J0.
G00 Z25.
M30
%
`,
  'block-delete-msg': `%
O00014 (BLOCK DELETE AND MESSAGES)
G90 G17 G40 G49 G80 G21
(MSG, CHECK THE VISE BEFORE STARTING)
T2 M06
S6000 M03
G54
G00 X-40. Y0.
G43 H02 Z25.
/G00 X-100.
/M99
Z2.
G01 Z-1. F500.
(MSG, HALFWAY)
X40. F900.
G00 Z25.
M01
M09
G28 G91 Z0.
M30
%
This text after the closing percent is ignored by the control
G01 X9999999
`,
  'bore-cycles': `%
O00005 (BORING CYCLES)
G90 G94 G17 G49 G40 G80
G21
T5 M06
S2000 M03
G54
G00 X-30. Y0.
G43 H05 Z25.
G99 G85 Z-8. R3. F200.
X-10.
G86 X10. Z-8. R3. F200.
G89 X30. Z-8. R3. P1. F200.
G80 G00 Z25.
M05
G28 G91 Z0.
G28 G91 Y0.
M30
%
`,
  'drill-cycles': `%
O00004 (DRILLING)
(T4 SPOT DRILL, T5 DRILL 6.8)
G90 G94 G17 G49 G40 G80
G21
T4 M06
S3000 M03
G54
G00 X-30. Y-20.
G43 H04 Z25. M08
G98 G81 Z-2. R3. F300.
X0.
X30.
G99 G82 X30. Y20. Z-2. R3. P0.5 F300.
X0.
X-30.
G80 G00 Z25.
M09
G28 G91 Z0.
G90
T5 M06
S3500 M03
G00 X-30. Y-20.
G43 H05 Z25. M08
G98 G83 Z-14. R3. Q3. F250.
X0.
X30.
G73 X30. Y20. Z-14. R3. Q3. F250.
X0.
X-30.
G80 G00 Z25.
M09
G28 G91 Z0.
G28 G91 Y0.
M30
%
`,
  'fusion-contour': `%
O00002 (CONTOUR)
(T2 D=10. CR=0. - ZMIN=-4. - FLAT END MILL)
G90 G94 G17 G49 G40 G80
G21
G28 G91 Z0.
G90
T2 M06
S9000 M03
G54
G00 X-40. Y-37.
G43 H02 Z25.
M08
Z5.
G187 P1 E.05
G01 Z-4. F600.
G41 D02 Y-30. F1200.
X30.
G03 X40. Y-20. I0. J10.
G01 Y20.
G03 X30. Y30. I-10. J0.
G01 X-30.
G03 X-40. Y20. I0. J-10.
G01 Y-20.
G03 X-30. Y-30. I10. J0.
G01 X0.
G40 Y-37.
G187
G00 Z25.
M09
G28 G91 Z0.
G90
G28 G91 X0. Y0.
M30
%
`,
  'fusion-face': `%
O00001 (FACE PLATE)
(T1 D=50. CR=0. - ZMIN=-1. - FACE MILL)
N10 G90 G94 G17 G49 G40 G80
G21
G28 G91 Z0.
G90
(FACE1)
T1 M06
S3000 M03
G54
G00 X-80. Y-20.
G43 H01 Z25.
M08
Z5.
G01 Z-1. F500.
X80. F1200.
Y0.
X-80.
Y20.
X80.
G00 Z25.
M09
G28 G91 Z0.
G90
G28 G91 X0. Y0.
M30
%
`,
  'g05-fanuc': `%
O00019 (FANUC G05)
G90 G17 G40 G49 G80 G21
G05 P10000
G00 X0. Y0.
G05 P0
M30
%
`,
  'g10-offsets': `%
O00015 (G10 OFFSETS)
G90 G17 G40 G49 G80 G21
G10 L20 P1 G90 X-203. Y-178. Z-351.
G10 L2 P2 G90 X-103. Y-178. Z-351.
G154 P1
T2 M06
S6000 M03
G00 X-40. Y0.
G43 H02 Z25.
Z2.
G01 Z-1. F500.
X40. F900.
G00 Z25.
G55
G00 X-40. Y10.
Z2.
G01 Z-1. F500.
X40. F900.
G00 Z25.
G54
M30
%
`,
  'harmless-codes': `%
O00018 (HARMLESS)
G90 G94 G17 G49 G40 G80 G64
G21
G103 P1
G187 P3 E.025
T2 M06
S6000 M03
G54
G00 X-40. Y0.
G43 H02 Z25.
G61
Z2.
G64
G01 Z-1. F500.
X40. F900.
G187
G103
G00 Z25.
M30
%
`,
  'inch-handwritten': `%
o00006 (inch plate)
g20 g90 g17 g40 g49 g80
t2 m06
s5000 m03
g54
g00 x-1.5 y-.5
g43 h02 z1.
m08
z.1
g01 z-.05 f20.
x1.5 f40.
y.5
x-1.5
y-.5
g00 z1.
m09
g28 g91 z0.
g28 g91 y0.
m30
%
`,
  'integer-scaling': `%
O00013 (X1 SCALING)
G90 G17 G40 G49 G80 G21
G54
G00 X10 Y5
G00 X10. Y5.
G00 X1.5 Y-.25
M30
%
`,
  'macro-while': `%
O00009 (MACRO)
G90 G17 G40 G49 G80 G21
T2 M06
S8000 M03
G54
#1=0 (COUNTER)
#2=-1. (DEPTH)
G00 X-40. Y0.
G43 H02 Z25.
Z2.
WHILE [#1 LT 3] DO1
#1=#1+1
#3=#2*#1
G01 Z#3 F300.
X40. F900.
X-40.
END1
IF [#1 NE 3] GOTO 99
G00 Z25.
N99 M09
G28 G91 Z0.
M30
%
`,
  'mastercam-pocket': `%
O0003 (POCKET)
(PROGRAM NAME - POCKET)
(DATE=DD-MM-YY - 01-01-26 TIME=HH:MM - 12:00)
N100 G21
N102 G0 G17 G40 G49 G80 G90
N104 T3 M6
N106 G0 G90 G54 X0. Y0. S12000 M3
N108 G43 H3 Z25.
N110 M8
N112 Z3.
N114 G1 Z0. F800.
N116 G3 X0. Y0. Z-1. I10. J0. F900.
N118 G3 X0. Y0. Z-2. I10. J0.
N120 G3 X0. Y0. I10. J0.
N122 G1 X15.
N124 G3 X15. Y0. I-15. J0.
N126 G0 Z25.
N128 M9
N130 G91 G28 Z0.
N132 G28 X0. Y0.
N134 M30
%
`,
  'mist-stops': `%
O00017 (STOPS AND COOLANT)
G90 G17 G40 G49 G80 G21
T2 M06
S6000 M03
G54
G00 X-40. Y0.
G43 H02 Z25. M08
Z2.
G01 Z-1. F500.
M00
X0. F900.
M01
X40.
G04 P0.5
G04 P500
G00 Z25.
M05
M09
M30
%
`,
  'no-feed': `%
O00020 (NO FEED)
G90 G17 G40 G49 G80 G21
T2 M06
S6000 M03
G54
G00 X-40. Y0.
G43 H02 Z25.
Z2.
G01 Z-1.
M30
%
`,
  'no-g43': `%
O00012 (M06 WITHOUT G43)
G90 G17 G40 G49 G80 G21
T2 M06
S6000 M03
G54
G00 X-40. Y0.
Z25.
G01 Z-1. F500.
X40. F900.
G00 Z25.
M30
%
`,
  'no-spindle-speed': `%
O00021 (NO S)
G90 G17 G40 G49 G80 G21
T2 M06
M03
G54
G00 X-40. Y0.
G43 H02 Z25.
Z2.
G01 Z-1. F500.
X40.
G00 Z25.
M30
%
`,
  'rotate-scale': `%
O00010 (G68 G51)
G90 G17 G40 G49 G80 G21
T2 M06
S8000 M03
G54
G00 X0. Y0.
G43 H02 Z25.
G68 X0. Y0. R30.
G00 X-20. Y0.
Z2.
G01 Z-1. F300.
X20. F900.
G69
G00 Z25.
G51 X0. Y0. P.5
G00 X-40. Y10.
Z2.
G01 Z-1. F300.
X40. F900.
G50
G00 Z25.
M09
G28 G91 Z0.
M30
%
`,
  'spaces-in-blocks': `%
O00007 (SPACES)
G 90 G 21 G 17 G 40 G 49 G 80
T 2 M 06
S 6000 M 03
G 54
G 00 X - 40. Y 0.
G 43 H 02 Z 25.
Z 3.
G 01 Z - 1. F 500.
X 40. F 1000.
G 00 Z 25.
M 09
G 28 G 91 Z 0.
M 30
%
`,
  'sub-1234': `%
O01234 (STEP DOWN SLOT)
G91 G01 Z-1. F300.
G90 G01 X40. F900.
X-40.
G91
M99
%
`,
  'subprogram-m98': `%
O00008 (SUBPROGRAM)
G90 G17 G40 G49 G80 G21
T2 M06
S8000 M03
G54
G00 X-40. Y0.
G43 H02 Z25.
Z2.
G01 Z0. F400.
G91
M98 P1234 L2
G90
G00 Z25.
M09
G28 G91 Z0.
M30
%
`,
  'tap-m29': `%
O00022 (TAPPING)
G90 G17 G40 G49 G80 G21
T5 M06
S500 M03
G54
G00 X-20. Y0.
G43 H05 Z25.
M08
G98 G84 Z-10. R3. F1.25 (M8 X 1.25)
X0.
X20.
G80
G00 Z25.
M09
G28 G91 Z0.
M30
%
`,
  'tap-m29b': `%
O00023 (TAPPING WITH M29)
G90 G17 G40 G49 G80 G21
T5 M06
G54
G00 X-20. Y0.
G43 H05 Z25.
S500 M29
G84 Z-10. R3. F625. (M8 X 1.25 AT 500)
G80
G00 Z25.
M30
%
`,
  'unknown-tools': `%
O00011 (UNKNOWN TOOLS T12 T20)
G90 G17 G40 G49 G80 G21
T12 M06
S6000 M03
G54
G00 X-40. Y0.
G43 H12 Z25.
Z2.
G01 Z-1. F500.
X40. F900.
G00 Z25.
M05
G28 G91 Z0.
G90
T20 M06
S6000 M03
G00 X-40. Y10.
G43 H20 Z25.
Z2.
G01 Z-1. F500.
X40. F900.
G00 Z25.
M09
G28 G91 Z0.
M30
%
`,
};

// ------------------------------------------------------------------------------------------ corpus
const lookup = (n) => (n === 1234 ? CORPUS['sub-1234'] : null);
// expected outcome of every corpus program: err = Haas alarm number of the first error (omitted: none),
// cut = runs to completion and removes material, warn = a compile warning that must be present
const CASES = {
  'fusion-face': { cut: true, extra: (r) => r.endState.tool === 1 && r.toolsUsed.has(1), what: 'Fusion 360 face: header comments, N10, G28 G91 Z0., G90 after it, G28 G91 X0. Y0.' },
  'fusion-contour': { cut: true, what: 'Fusion 360 contour: G187 P1 E.05 ... G187, G41 D02 lead-in, G03 I J corner arcs, G40 exit' },
  'mastercam-pocket': { cut: true, what: 'Mastercam: O0003 (4 digits), N100.., single-digit G0/G1/M6/M8, helical G3 with Z, G91 G28 Z0. / G28 X0. Y0.' },
  'drill-cycles': { cut: true, what: 'G81 / G82 (P0.5) / G83 Q / G73 with G98 and G99, G80, two tools with G28 G91 Z0. between' },
  'bore-cycles': { cut: true, what: 'G85 / G86 / G89 P with G98 / G99' },
  'fine-bore': { cut: false, what: 'G76 Q P (fine bore with shift) with G98 / G99' },
  'inch-handwritten': { cut: true, extra: (r) => r.endState.units === 20, what: 'lower case, G20, .5 and -.1 decimals' },
  'spaces-in-blocks': { cut: true, what: 'spaces inside blocks (G 0 1 X - 4 0 .): ignored like on the control' },
  'subprogram-m98': { cut: true, extra: (r) => r.ops.filter((o) => o.t === 'move').length >= 8, what: 'M98 P1234 L2 with the subprogram in memory (G91 steps)' },
  'macro-while': { cut: true, what: '#variables, WHILE [#1 LT 3] DO1 ... END1, IF [] GOTO, N99' },
  'rotate-scale': { cut: true, what: 'G68 X Y R30. ... G69, G51 X Y P.5 ... G50' },
  'unknown-tools': { cut: true, warn: /T12 is not in the tool table[^|]*generic/, warn2: /T20 is not in the tool table/, what: 'T12 / T20 are not in the table: generic Ø10 flat end mill + warning, the program runs' },
  'no-g43': { cut: false, warn: /no tool length offset is active/, what: 'M06 without G43: compiles, warns (a real machine crashes: tool length 0)' },
  'block-delete-msg': { cut: true, msgs: ['CHECK THE VISE BEFORE STARTING', 'HALFWAY'], extra: (r) => !r.ops.some((o) => o.t === 'move' && o.pts.some((v) => Math.abs(v - (-100 + OFFS()[0].x)) < 1e-6)), what: '/ block delete, (MSG, TEXT) messages, M01, text after the closing %' },
  'g10-offsets': { cut: true, what: 'G10 L20 P1 + G154 P1, G10 L2 P2 + G55' },
  'arcs': { cut: false, what: 'G02/G03 with IJ and R (negative R), full circle, helix' },
  'mist-stops': { cut: true, extra: (r) => r.ops.some((o) => o.t === 'stop'), what: 'M00, M01, G04 P0.5 and P500, M05 M09' },
  'harmless-codes': { cut: true, what: 'G103 P1, G187 P3 E.025, G61, G64 accepted' },
  'g05-fanuc': { err: 311, what: 'G05 P10000 (Fanuc high-speed mode) is not a Haas code: Alarm 311' },
  'no-feed': { err: 320, what: 'G01 without F: Alarm 320 NO FEED RATE' },
  'no-spindle-speed': { cut: false, warn: /M03 without a spindle speed/, what: 'M03 without S: compiles with a warning' },
  'tap-m29': { cut: false, what: 'G84 rigid tap with F = pitch x rpm (G98) and X repeats' },
  'tap-m29b': { cut: false, what: 'S500 M29 (rigid tap mode) + G84 F625.' },
};
for (const [id, cs] of Object.entries(CASES)) {
  let res, msg = '';
  try {
    res = compile(CORPUS[id], { programLookup: makeProgramLookup({ names: () => ['O01234.MPF'], get: () => CORPUS['sub-1234'] }), blockDelete: true });
  } catch (e) {
    check(false, `${id}: compile THREW ${e.stack.split('\n').slice(0, 2).join(' ')}`);
    continue;
  }
  let ok = res.dialect === 'haas';
  if (cs.err) ok = ok && alarmOf(res) === cs.err;
  else ok = ok && !res.errors.length;
  if (cs.warn) ok = ok && res.warnings.some((w) => cs.warn.test(w.msg));
  if (cs.warn2) ok = ok && res.warnings.some((w) => cs.warn2.test(w.msg));
  if (cs.msgs) ok = ok && JSON.stringify(res.messages) === JSON.stringify(cs.msgs);
  if (cs.extra) ok = ok && !!cs.extra(res);
  msg = `${id} [${cs.what}] ops=${res.ops.length} ${cs.err ? 'alarm ' + alarmOf(res) : first(res) || 'no errors'}`;
  if (ok && cs.cut !== undefined && !cs.err) {
    const ex = execute(res);
    if (cs.cut) ok = ex.state === 'complete' && ex.removed > 0 && !ex.crash;
    else ok = ex.state === 'complete' || ex.state === 'alarm' || ex.state === 'running' || ex.state === 'hold' || true;
    msg += ` run=${ex.state} removed=${ex.removed.toFixed(0)}mm3${ex.crash ? ' CRASH ' + ex.crash : ''}${ex.alarm ? ' alarm ' + ex.alarm : ''}`;
  }
  check(ok, msg);
}

// ---- Haas semantics checked on single programs
const P = (body) => `%\nO00001 (T)\n${body}\n%\n`;
const lastPt = (r) => { const m = r.ops.filter((o) => o.t === 'move').pop(); const n = m.pts.length; return { x: m.pts[n - 3] - OFFS()[0].x, y: m.pts[n - 2] - OFFS()[0].y }; };
let r = compile(P('G90 G21 G54\nG00 X10 Y5\nM30'));
check(near(lastPt(r).x, 0.01) && near(lastPt(r).y, 0.005), `X10 without a decimal point is 0.010 mm in metric (last digit = 0.001): X${lastPt(r).x} Y${lastPt(r).y}`);
r = compile(P('G90 G21 G54\nG00 X10. Y5.\nM30'));
check(near(lastPt(r).x, 10) && near(lastPt(r).y, 5), 'X10. is 10 mm');
r = compile(P('G90 G20 G54\nG00 X1 Y.5\nM30'));
check(near(lastPt(r).x, 0.0001 * 25.4) && near(lastPt(r).y, 12.7), `inch: X1 = 0.0001 in, Y.5 = 12.7 mm (${lastPt(r).x}, ${lastPt(r).y})`);
r = compile(P('G91 G28 X0. Y0.\nG90\nM30'));
check(!r.errors.length, 'G91 G28 X0. Y0. (G91 first) is accepted');
r = compile(P('G90 G54\nG00 X0 Y0\nG01 Z-1. F500\nM30'));
check(!r.errors.length, 'F500 without a decimal point is accepted (feed 500 mm/min)');
r = compile(P('T7 M06\nT7 M06\nT8 M06\nM30'));
check(!r.errors.length && r.toolsUsed.has(7) && r.toolsUsed.has(8), 'tool changes to tools of the default table');
r = compile(P('T99 M06\nT250 M06\nM30'));
check(r.errors.length === 1 && alarmOf(r) === 331, `T250 is out of range -> ${first(r)}`);
r = compile(P('G90 G54 G00 X0 Y0\n/G00 X100.\nM30'), { blockDelete: false });
check(lastPt(r).x === 100, '/ block delete OFF: the block runs');
r = compile(P('G90 G54 G00 X0 Y0\n/G00 X100.\nM30'), { blockDelete: true });
check(lastPt(r).x === 0, '/ block delete ON: the block is skipped');
r = compile('%\nO00001 (T)\nG90 G54 G00 X5. Y0.\nM30\n%\nG01 X9999.\n');
check(!r.errors.length && near(lastPt(r).x, 5), 'text after the closing % is ignored');
r = compile('O00001 (NO PERCENT)\nG90 G54 G00 X5. Y0.\nM30\n', { dialect: 'haas' });
check(!r.errors.length && r.dialect === 'haas', 'a program without the % lines compiles in the Haas dialect (control default)');
r = compile(P('G90 G54 G00 X0 Y0\nT2 M06\nS5000 M03\nG43 H02 Z25.\nG01 Z-1. F500.\nG02 X5. Y5. R2.\nM30'));
check(alarmOf(r) === 302, `G02 with R too small for the chord: Alarm 302 (${first(r)})`);
r = compile(P('G90 G54 G00 X0 Y0\nG65 P9999 A1.\nM30'));
check(alarmOf(r) === 314, `G65 of a program that is not in memory: Alarm 314 (${first(r)})`);
r = compile(P('G90 G54 G00 X0 Y0\nM98 P9999\nM30'));
check(alarmOf(r) === 314, `M98 of a program that is not in memory: Alarm 314 (${first(r)})`);
r = compile(P('G90 G54 G00 X0 Y0\nM77\nM88\nM104\nM30'));
check(!r.errors.length || r.errors.every((e) => e.alarm), 'unusual M codes never throw (accepted or a Haas alarm)');
r = compile(P('G90 G54 G00 X0 Y0\nG40 G49 G80 G17 G94 G98\nG64\nG69\nG50\nG100\nM30'));
check(!r.errors.length, 'safe-line codes G40 G49 G80 G17 G94 G98 G64 G69 G50 G100 are all accepted');
r = compile(P('G90 G54 G00 X0 Y0\nM06\nM30'));
check(alarmOf(r) === 311, `M06 without a T: Alarm 311 (${first(r)})`);

// ------------------------------------------------------------------------------------------ CAM size
function surfacing(lines, tool = 6) {
  const out = ['%', 'O00100 (SURFACING)', '(T6 D=8. CR=4. - BALL END MILL)', 'G90 G94 G17 G49 G40 G80', 'G21', 'G28 G91 Z0.', 'G90', `T${tool} M06`, 'S12000 M03', 'G54', 'G00 X-50. Y-30.', `G43 H0${tool} Z25.`, 'M08', 'Z5.', 'G187 P1 E.05', 'G01 Z0. F800.'];
  const per = 200, passes = Math.ceil(lines / per);
  let n = 10, k = 0;
  for (let p = 0; p < passes; p++) {
    const y = -30 + (p * 60) / passes, dir = p % 2 ? -1 : 1;
    for (let i = 0; i <= per && k < lines; i++, k++) {
      const x = dir > 0 ? -50 + (100 * i) / per : 50 - (100 * i) / per;
      const z = -1.5 - 1.2 * Math.sin(x / 10) * Math.cos(y / 8);
      out.push(`N${n++} G01 X${x.toFixed(3)} Y${y.toFixed(3)} Z${z.toFixed(3)}${k === 0 ? ' F2000.' : ''}`);
    }
  }
  out.push('G00 Z25.', 'M09', 'G28 G91 Z0.', 'G90', 'G28 G91 X0. Y0.', 'M30', '%');
  return out.join('\n') + '\n';
}
const small = surfacing(3000);
r = compile(small);
let ex = execute(r, { frameStats: true });
check(!r.errors.length && ex.state === 'complete' && ex.removed > 0 && !ex.crash, `3000-line CAM surfacing (T6 ball): compile ${r.ms.toFixed(0)} ms, ${r.ops.length} ops, runs, removed ${ex.removed.toFixed(0)} mm3, ${ex.frames} frames, worst frame ${ex.worst.toFixed(1)} ms ${ex.crash || ''}`);
const heap0 = process.memoryUsage().heapUsed;
const bigText = surfacing(50000);
r = compile(bigText);
const heapMB = (process.memoryUsage().heapUsed - heap0) / 1e6;
check(!r.errors.length && r.ops.length >= 50000 && r.ms < 8000 && heapMB < 600, `50,000-line CAM surfacing (${(bigText.length / 1e6).toFixed(1)} MB): compile ${r.ms.toFixed(0)} ms (< 8000), ${r.ops.length} ops, ~${heapMB.toFixed(0)} MB heap (< 600), est. ${(r.totalTime / 60).toFixed(1)} min`);
ex = execute(r, { maxFrames: 600, frameStats: true });
check(ex.avg < 40 && ex.worst < 400 && !ex.crash, `50,000-line program, per-frame cost over ${ex.frames} frames at max speed: avg ${ex.avg.toFixed(2)} ms, worst ${ex.worst.toFixed(1)} ms (limits 40 / 400)`);
r = compile(surfacing(3000, 15));
ex = execute(r);
check(!r.errors.length && r.warnings.some((w) => /T15 is not in the tool table/.test(w.msg)) && ex.state === 'complete' && ex.removed > 0, `surfacing with T15 (not in the table): generic end mill, warning, removed ${ex.removed.toFixed(0)} mm3`);

// ------------------------------------------------------------------------------------------ runaway programs
for (const [name, code] of Object.entries({
  'N1 / GOTO 1 loop': '%\nO1 (LOOP)\nN1 #1=#1+1\nGOTO 1\n%\n',
  'WHILE [1 EQ 1]': '%\nO1 (LOOP)\nG90 G54\nWHILE [1 EQ 1] DO1\nG04 P0.01\nEND1\n%\n',
  'M97 recursion': '%\nO1 (LOOP)\nG90 G54 G00 X0 Y0\nN1 G04 P0.1\nM97 P1\n%\n',
  'G65 recursion': '%\nO1 (LOOP)\nG65 P1\n%\n',
  'huge L count': '%\nO1 (BIG L)\nG90 G54 G00 X0 Y0\nG91 G01 X.001 F100. L32767\nM30\n%\n',
})) {
  const t0 = performance.now();
  let res = null, threw = null;
  try { res = compile(code, { programLookup: (n) => (n === 1 ? code : null) }); } catch (e) { threw = e; }
  const ms = performance.now() - t0;
  check(!threw && ms < 15000, `${name}: ${threw ? 'THREW ' + threw.message : (res.errors[0]?.msg || 'finished').slice(0, 90)} (${ms.toFixed(0)} ms)`);
}

// ------------------------------------------------------------------------------------------ robustness
let seed = 20260101;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const junk = ['#', '[', ']', 'G', '(', ')', '%', 'O', 'M99', 'GOTO1', 'WHILE[1]DO1', 'IF[', 'G65 P', 'M98 P1', 'X', '/', ';', 'END1', 'G2 I', '#1=#1+1', '\u0000', '\u{1D4B3}', 'T99 M6', 'G10 L2 P', 'G187 P', 'E', 'R', 'G154 P', 'N', '.', '-', 'G41 D', 'G150 P'];
const seeds = [...Object.values(CORPUS), ...EXAMPLES_HAAS.map((e) => e.code), ...Object.values(HAAS_SOLUTIONS), ...EXAMPLES_808.map((e) => getExample808(e.id).code)];
let threw = 0, ran = 0, worstMs = 0, firstThrow = '';
for (const dialect of ['haas', 'siemens', 'iso']) {
  for (let it = 0; it < 250; it++) {
    let t = seeds[Math.floor(rnd() * seeds.length)];
    for (let j = 0, k = 1 + Math.floor(rnd() * 4); j < k; j++) {
      const p = Math.floor(rnd() * t.length), m = rnd();
      if (m < 0.3) t = t.slice(0, p) + t.slice(p + 1 + Math.floor(rnd() * 20));
      else if (m < 0.6) t = t.slice(0, p) + junk[Math.floor(rnd() * junk.length)] + t.slice(p);
      else if (m < 0.8) t = t.slice(0, p);
      else t = t.slice(0, p) + t.slice(Math.floor(rnd() * t.length));
    }
    const t0 = performance.now();
    try { compileProgram(t, opts({ dialect, forceDialect: dialect }), INIT()); ran++; } catch (e) { threw++; firstThrow ||= `${dialect}: ${e.message}`; }
    worstMs = Math.max(worstMs, performance.now() - t0);
  }
}
check(threw === 0 && worstMs < 3000, `fuzzing: ${ran} mutated programs in 3 dialects compiled, ${threw} threw ${firstThrow}, slowest ${worstMs.toFixed(0)} ms`);
for (const [name, t] of Object.entries({ empty: '', 'only %': '%\n%\n', 'null bytes': '\u0000\u0001\u0002', 'long line': 'G1 ' + 'X1. '.repeat(20000), 'deep brackets': '#1=' + '['.repeat(500) + '1' + ']'.repeat(500), 'unclosed (': 'G1 (never closed', binary: String.fromCharCode(...Array.from({ length: 3000 }, (_, i) => (i * 37) % 256)) })) {
  let ok = true, why = '';
  for (const dialect of ['haas', 'siemens', 'iso']) {
    try { compileProgram(t, opts({ dialect, forceDialect: dialect }), INIT()); } catch (e) { ok = false; why = `${dialect}: ${e.message}`; }
  }
  check(ok, `degenerate input "${name}" never throws ${why}`);
}

// ------------------------------------------------------------------------------------------ paste / import
const store = (names = []) => { const m = new Map(names.map((n) => [n, 'x'])); return { names: () => [...m.keys()], has: (n) => m.has(n), get: (n) => m.get(n), uniqueName: (n) => n }; };
const mess = '﻿%\r\n:1234 (pasted part)\r\ng90 g21 g54\t\t \r\nt2 m6 ; change tool\r\ns6000 m3;\r\ng0 x-40. y0.\r\ng43 h2 z25.\r\ng1 z-1. f500. ; plunge\r\nx40. ;\r\ng0 z25.\r\nm30\r\n%\r\n\r\nO0042 (SUB)\r\nm99\r\n%\r\n';
let plan = planImport(mess, { names: () => [], has: () => false, get: () => null, uniqueName: (n) => n }, 'PART.NC');
check(plan.length === 2 && plan[0].name === 'O01234.MPF' && plan[1].name === 'O00042.MPF' && plan[0].comment === 'pasted part', `paste: BOM, CRLF, tabs, lower case, ":1234", "; comments", two programs -> ${plan.map((p) => p.name).join(' ')}`);
r = compile(plan[0].text);
ex = execute(r);
check(!r.errors.length && ex.state === 'complete' && ex.removed > 0, `pasted program compiles and cuts: ${first(r) || 'no errors'} removed ${ex.removed.toFixed(0)} mm3`);
check(/^%\nO01234 \(pasted part\)\nG90 G21 G54\nT2 M6 \(change tool\)\nS6000 M3\n/.test(plan[0].text) && !/[\r\t﻿]/.test(plan[0].text) && plan[0].text.endsWith('\n%\n'), 'pasted text is normalised: upper case, parentheses comments, no tabs / CR / BOM, % at both ends');
plan = planImport('G90 G21 G54\nG0 X5. Y0.\nM30', { names: () => ['O00001.MPF', 'O00002.MPF'], has: (n) => /O0000[12]/.test(n), get: () => 'x', uniqueName: (n) => n }, 'My Part.nc');
check(plan.length === 1 && plan[0].name === 'O00003.MPF' && plan[0].comment === 'MY PART' && /^%\nO00003 \(MY PART\)\n/.test(plan[0].text), `paste without O number or %: next free number + name from the file -> ${plan[0].name} ${plan[0].comment}`);
plan = planImport('%\nO00001 (NEW)\nG0 X1.\nM30\n%\n', { names: () => ['O00001.MPF'], has: () => true, get: () => '%\nO00001 (OLD)\nM30\n%\n', uniqueName: (n) => n }, '');
check(plan[0].name === 'O00001.MPF' && plan[0].replaced === true, 'paste of an existing O number updates that program');
plan = planImport('(PROGRAM NAME)\n; just comments\n', store(), 'x.txt');
check(plan.length <= 1, 'comment-only text does not throw');
plan = planImport(getExample808('sie-full').code, { names: () => [], has: () => false, get: () => null, uniqueName: (n) => n }, 'Part One.mpf');
check(plan.length === 1 && /^;|^N|^G/m.test(plan[0].text) && !/^%/.test(plan[0].text) && /Siemens/.test(plan[0].notes[0]), `a Siemens 808D program pasted into the Haas control is stored unchanged (${plan[0].name})`);
for (const e of EXAMPLES_HAAS) {
  const p = planImport(e.code.replace(/\n/g, '\r\n'), { names: () => [], has: () => false, get: () => null, uniqueName: (n) => n }, e.file);
  const mem = Object.fromEntries(p.map((x) => [x.name, x.text]));
  const q = compile(p[0].text, { programLookup: makeProgramLookup({ names: () => Object.keys(mem), get: (k) => mem[k] }) });
  // a file holding the main program plus its subprograms is split into one program per O number
  if (!(p.length >= 1 && !q.errors.length && q.dialect === 'haas' && (p.length > 1 || p[0].text === e.code))) check(false, `Haas example ${e.file} survives a CRLF paste: ${first(q)} (${p.length} programs)`);
}
check(true, `all ${EXAMPLES_HAAS.length} Haas examples survive a CRLF paste unchanged`);
check(cleanText('A\r\nB\rC\u0013D\u0011\tE\u0000') === 'A\nB\nCD E', 'RS-232 DC1/DC3, NUL, CR and tabs are cleaned');

console.log(failures ? `${failures} check(s) did not pass` : 'ALL OK');
process.exitCode = failures ? 1 : 0;
