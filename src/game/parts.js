// Workshop jobs: engineering drawings (part definitions), the target model used by the inspection
// and a reference 808D program for every part.
//
// Part frame (= drawing frame): origin at the FRONT-LEFT corner of the FINISHED top face, X along the
// part length, Y to the back, Z up, Z0 = finished top. Feature depths are positive, measured down from
// Z0, and the deepest feature covering a point wins. Machining is 2.5D from the top (blank in a vise).
//
// Reference programs: Siemens 808D dialect, default tool library (src/config.js DEFAULT_TOOLS),
// G54 = TOP FRONT-LEFT corner of the RAW blank, Z0 = top of the raw blank, so the finished top face is
// at Z = -(stock.z - size.z) and every feature floor at Z = -(stock.z - size.z) - depth.

const D2R = Math.PI / 180;
// 118° twist drill: point length below the full diameter = (d/2) / tan(59°)
export const DRILL_POINT_K = 1 / Math.tan(59 * D2R);

const r3 = (v) => Math.round(v * 1000) / 1000;

// Hole positions on a pitch circle (rounded to 0.001 mm like a drawing table). Such holes also carry an
// optional `pattern: { type: 'pcd', cx, cy, d, n, start }` hint for the drawing (PCD dimensioning).
function pcd(cx, cy, rad, startDeg, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (startDeg + (360 * i) / n) * D2R;
    out.push([r3(cx + rad * Math.cos(a)), r3(cy + rad * Math.sin(a))]);
  }
  return out;
}

// Gives every feature a balloon letter (A, B, ...) unless it already has an id.
function lettered(features) {
  return features.map((f, i) => ({ id: String.fromCharCode(65 + i), ...f }));
}

// Adds N block numbers to every program line that is not a comment or a label.
function nc(lines) {
  let n = 10;
  return lines
    .map((l) => {
      if (!l || l.startsWith(';') || /^[A-Z_][A-Z0-9_]*:/.test(l)) return l;
      const s = `N${n} ${l}`;
      n += 10;
      return s;
    })
    .join('\n') + '\n';
}

// Cutting data per material: [rpm, feed, plunge feed]
const CUT = {
  aluminium: { T1: [3200, 1300], T2: [9500, 1400, 400], T3: [10000, 1000, 250], T4: [6000, 500], T5: [4500, 600] },
  plastic: { T1: [3000, 1500], T2: [9000, 1600, 500], T3: [10000, 1200, 300], T4: [5000, 500], T5: [4000, 500] },
  brass: { T1: [2200, 900], T2: [7000, 900, 300], T3: [9000, 700, 200], T4: [4000, 300], T5: [3500, 350] },
  steel: { T1: [1000, 400], T2: [3800, 600, 150], T3: [6000, 400, 120], T4: [2400, 240], T5: [1400, 150] },
};
const TOOLNAME = { 1: 'FACE MILL D50', 2: 'END MILL D10', 3: 'END MILL D6', 4: 'SPOT DRILL D10 90 DEG', 5: 'TWIST DRILL D6.8 118 DEG' };
const MATNAME = { aluminium: 'ALUMINIUM', steel: 'STEEL', brass: 'BRASS', plastic: 'ACETAL' };

const tc = (mat, t, x, y) => [
  `T${t} D1 M6 ; ${TOOLNAME[t]}`,
  `S${CUT[mat]['T' + t][0]} M3 M8`,
  `G0 X${x} Y${y}`,
  'Z10',
];

function header(p, ops) {
  const F = r3(p.size.z - p.stock.z);
  const S = p.stock, Z = p.size;
  return [
    `; JOB_${p.id} ${p.title.toUpperCase()}  DRG ${p.drawingNo} REV ${p.rev}`,
    `; BLANK ${S.x} x ${S.y} x ${S.z} ${MATNAME[p.material]} -> FINISHED ${Z.x} x ${Z.y} x ${Z.z}`,
    '; G54 = TOP FRONT-LEFT CORNER OF THE RAW BLANK, Z0 = TOP OF THE RAW BLANK',
    `; FINISHED TOP FACE AT Z${F} (FACE OFF ${r3(-F)} MM); FEATURE FLOOR Z = ${F} - DEPTH`,
    ...ops.map((o) => `; ${o}`),
    'G17 G90 G71 G94 G40',
    'G54',
  ];
}

const footer = ['G0 Z100 M9', 'M5', 'G74 Z1=0', 'M30'];

function face(p) {
  const F = r3(p.size.z - p.stock.z);
  const [s, f] = CUT[p.material].T1;
  return [
    `; ---- FACE THE TOP ${r3(-F)} MM DOWN TO Z${F}`,
    `T1 D1 M6 ; ${TOOLNAME[1]}`,
    `S${s} M3 M8`,
    'G0 X-40 Y0',
    'Z10',
    `CYCLE71(10,0,2,${F},0,0,${p.stock.x},${p.stock.y},0,${p.material === 'steel' ? 0.5 : 1},,5,0,${f},31,5)`,
  ];
}

const SETUP = 'G54 on the top front-left corner of the RAW blank (X0 Y0 at the front-left corner, Z0 = top of the raw blank). '
  + 'The finished top face is therefore at Z = -(blank height - finished height); feature floors at that minus the drawing depth. '
  + 'Load the tools of the default library (T1 face mill Ø50, T2 end mill Ø10, T3 end mill Ø6, T4 spot drill, T5 drill Ø6.8).';

function part(p, build) {
  p.features = lettered(p.features);
  p.setupNote = SETUP;
  p.solution = build(p);
  return p;
}

// ------------------------------------------------------------------------------------------ parts
const P01 = part({
  id: 'P01', title: 'Locating plate', drawingNo: 'ML-1001', rev: 'A', customer: 'Northbridge Fixtures',
  brief: 'A fixture plate with one rectangular locating pocket. Face the sawn blank to thickness, then mill the pocket to depth.',
  difficulty: 1, material: 'aluminium',
  stock: { x: 100, y: 60, z: 21 }, size: { x: 100, y: 60, z: 20 }, protrusion: 12, tol: { general: 0.1 },
  features: [
    { type: 'pocketRect', x: 50, y: 30, w: 50, h: 30, r: 6, depth: 5, tol: 0.05 },
  ],
  notes: ['Face the top to thickness 20', 'Break all sharp edges 0.2 x 45°', 'Surface Ra 3.2 unless stated'],
}, (p) => {
  const m = p.material, [s2, f2, fd2] = CUT[m].T2;
  return nc([
    ...header(p, ['OP1 FACE MILL (CYCLE71)', 'OP2 POCKET A 50 x 30 R6 DEPTH 5 (POCKET3 ROUGH + FINISH)']),
    ...face(p),
    '; ---- POCKET A: CENTRE X50 Y30, FLOOR Z-6',
    ...tc(m, 2, 50, 30),
    `POCKET3(10,-1,2,-6,50,30,6,50,30,0,2.5,0.2,0.1,${f2},${fd2},0,11,,,,,3,1)`,
    `POCKET3(10,-1,2,-6,50,30,6,50,30,0,5,0,0,${Math.round(f2 * 0.7)},${fd2},0,12)`,
    ...footer,
  ]);
});

const P02 = part({
  id: 'P02', title: 'Cover plate', drawingNo: 'ML-1002', rev: 'A', customer: 'Harrow & Lyle Pumps',
  brief: 'A pump cover with seven Ø6.8 tapping holes. Spot drill every hole, then peck drill them with a hole pattern cycle.',
  difficulty: 1, material: 'aluminium',
  stock: { x: 120, y: 70, z: 16 }, size: { x: 120, y: 70, z: 15 }, protrusion: 10, tol: { general: 0.1 },
  features: [
    { type: 'hole', x: 10, y: 10, d: 6.8, depth: 10 },
    { type: 'hole', x: 110, y: 10, d: 6.8, depth: 10 },
    { type: 'hole', x: 10, y: 60, d: 6.8, depth: 10 },
    { type: 'hole', x: 110, y: 60, d: 6.8, depth: 10 },
    { type: 'hole', x: 30, y: 35, d: 6.8, depth: 10 },
    { type: 'hole', x: 60, y: 35, d: 6.8, depth: 10 },
    { type: 'hole', x: 90, y: 35, d: 6.8, depth: 10 },
  ],
  notes: ['Ø6.8 holes are M8 tapping holes (tapped by hand on the bench)', 'Hole depth is to the full diameter; the drill point is extra', 'Break all sharp edges'],
}, (p) => {
  const m = p.material;
  return nc([
    ...header(p, ['OP1 FACE MILL', 'OP2 SPOT DRILL 7 HOLES (CYCLE81 + HOLES1)', 'OP3 PECK DRILL D6.8 DEPTH 10 (CYCLE83 + HOLES1)']),
    ...face(p),
    '; ---- SPOT DRILL: TIP 2.5 BELOW THE FINISHED TOP (D5 CENTRE)',
    ...tc(m, 4, 10, 10),
    `F${CUT[m].T4[1]}`,
    'MCALL CYCLE81(10,-1,2,-3.5)',
    'HOLES1(10,10,0,0,100,2) ; FRONT ROW',
    'HOLES1(10,60,0,0,100,2) ; BACK ROW',
    'HOLES1(30,35,0,0,30,3) ; MIDDLE ROW',
    'MCALL',
    '; ---- DRILL D6.8: DEPTH 10 FULL DIAMETER + 2.04 DRILL POINT = TIP AT Z-13.04',
    ...tc(m, 5, 10, 10),
    `F${CUT[m].T5[1]}`,
    'MCALL CYCLE83(10,-1,2,-13.04,,,4,1,0,0,1,0)',
    'HOLES1(10,10,0,0,100,2)',
    'HOLES1(10,60,0,0,100,2)',
    'HOLES1(30,35,0,0,30,3)',
    'MCALL',
    ...footer,
  ]);
});

const P03 = part({
  id: 'P03', title: 'Guide block', drawingNo: 'ML-1003', rev: 'B', customer: 'Fenwick Conveyor Systems',
  brief: 'An acetal wear block for a conveyor guide: a rectangular pocket and two slots, one as wide as the Ø10 cutter and one wider than the Ø6.',
  difficulty: 2, material: 'plastic',
  stock: { x: 110, y: 70, z: 26 }, size: { x: 110, y: 70, z: 25 }, protrusion: 14, tol: { general: 0.1 },
  features: [
    { type: 'pocketRect', x: 28, y: 35, w: 40, h: 50, r: 6, depth: 6 },
    { type: 'slot', x1: 60, y1: 50, x2: 95, y2: 50, w: 10, depth: 4 },
    { type: 'slot', x1: 60, y1: 18, x2: 95, y2: 18, w: 8, depth: 3 },
  ],
  notes: ['Material acetal (POM): sharp cutters, high feed, avoid rubbing', 'Remove all burrs'],
}, (p) => {
  const m = p.material, [, f2, fd2] = CUT[m].T2, [, f3, fd3] = CUT[m].T3;
  return nc([
    ...header(p, ['OP1 FACE MILL', 'OP2 POCKET A (POCKET3)', 'OP3 SLOT B 10 WIDE WITH THE D10 (LONGHOLE)', 'OP4 SLOT C 8 WIDE WITH THE D6 (SLOT1)']),
    ...face(p),
    '; ---- POCKET A 40 x 50 R6, FLOOR Z-7',
    ...tc(m, 2, 28, 35),
    `POCKET3(10,-1,2,-7,40,50,6,28,35,0,2.5,0,0,${f2},${fd2},0,11,,,,,3,1)`,
    '; ---- SLOT B: X60..95 AT Y50, 10 WIDE = CUTTER, FLOOR Z-5',
    '; LONGHOLE STARTS AT CPA (THE LEFT END OF THE SLOT) AND RUNS LENG ALONG STA1',
    `LONGHOLE(10,-1,2,-5,,1,45,55,50,0,0,0,${fd2},${f2},1)`,
    '; ---- SLOT C: X60..95 AT Y18, 8 WIDE, FLOOR Z-4',
    ...tc(m, 3, 56, 18),
    `SLOT1(10,-1,2,-4,,1,43,8,56,18,0,0,0,${fd3},${f3},1.5,0,0,0)`,
    ...footer,
  ]);
});

const P04HOLES = pcd(45, 45, 33, 0, 6);
const P04 = part({
  id: 'P04', title: 'Bearing cap', drawingNo: 'ML-1004', rev: 'A', customer: 'Aldmoor Gearworks',
  brief: 'A bearing cap with a Ø40 seat for the bearing and six fixing holes on a Ø66 pitch circle.',
  difficulty: 2, material: 'aluminium',
  stock: { x: 90, y: 90, z: 21 }, size: { x: 90, y: 90, z: 20 }, protrusion: 12, tol: { general: 0.1 },
  features: [
    { type: 'pocketCirc', x: 45, y: 45, d: 40, depth: 8, tol: 0.05 },
    ...P04HOLES.map(([x, y]) => ({ type: 'hole', x, y, d: 6.8, depth: 12, pattern: { type: 'pcd', cx: 45, cy: 45, d: 66, n: 6, start: 0 } })),
  ],
  notes: ['6 holes Ø6.8 equally spaced on PCD 66, first hole on the X axis of the bore', 'Bearing seat Ø40 ±0.05', 'Break all sharp edges'],
}, (p) => {
  const m = p.material, [, f2, fd2] = CUT[m].T2;
  return nc([
    ...header(p, ['OP1 FACE MILL', 'OP2 BEARING SEAT D40 (POCKET4 ROUGH + FINISH)', 'OP3 SPOT + DRILL 6 HOLES ON PCD 66 (HOLES2)']),
    ...face(p),
    '; ---- BEARING SEAT D40, FLOOR Z-9',
    ...tc(m, 2, 45, 45),
    `POCKET4(10,-1,2,-9,20,45,45,3,0.2,0.1,${f2},${fd2},0,11,,,,3,1)`,
    `POCKET4(10,-1,2,-9,20,45,45,9,0,0,${Math.round(f2 * 0.7)},${fd2},0,12)`,
    '; ---- SPOT DRILL',
    ...tc(m, 4, 78, 45),
    `F${CUT[m].T4[1]}`,
    'MCALL CYCLE81(10,-1,2,-3.5)',
    'HOLES2(45,45,33,0,0,6)',
    'MCALL',
    '; ---- DRILL D6.8 DEPTH 12 (+2.04 POINT): TIP Z-15.04',
    ...tc(m, 5, 78, 45),
    `F${CUT[m].T5[1]}`,
    'MCALL CYCLE83(10,-1,2,-15.04,,,4,1,0,0,1,0)',
    'HOLES2(45,45,33,0,0,6)',
    'MCALL',
    ...footer,
  ]);
});

const P05 = part({
  id: 'P05', title: 'Shoulder block', drawingNo: 'ML-1005', rev: 'A', customer: 'Corrigan Rail Components',
  brief: 'A clamp block with two shoulders (steps) and drilled holes on two levels. Watch the reference plane when drilling on the lower step.',
  difficulty: 3, material: 'aluminium',
  stock: { x: 100, y: 60, z: 31 }, size: { x: 100, y: 60, z: 30 }, protrusion: 15, tol: { general: 0.1 },
  features: [
    { type: 'step', side: 'left', width: 20, depth: 10 },
    { type: 'step', side: 'back', width: 15, depth: 6 },
    { type: 'hole', x: 10, y: 15, d: 6.8, depth: 18 },
    { type: 'hole', x: 10, y: 32, d: 6.8, depth: 18 },
    { type: 'hole', x: 45, y: 22, d: 6.8, depth: 12 },
    { type: 'hole', x: 80, y: 22, d: 6.8, depth: 12 },
  ],
  notes: ['Holes C and D start on the lower shoulder (10 below the top)', 'Shoulder walls square to the top face', 'Break all sharp edges'],
}, (p) => {
  const m = p.material, [, f2] = CUT[m].T2;
  return nc([
    ...header(p, ['OP1 FACE MILL', 'OP2 LEFT STEP 20 WIDE, BACK STEP 15 WIDE (CYCLE71 WITH THE D10 END MILL)', 'OP3 SPOT + DRILL ON TWO LEVELS']),
    ...face(p),
    '; ---- LEFT STEP X0..20, FLOOR Z-11. CYCLE71 OVERLAPS THE START EDGE BY 0.5 MM AND',
    '; ---- STOPS EXACTLY ON THE FAR EDGE (FDP1=0), SO THE WALL MUST BE THE FAR EDGE',
    ...tc(m, 2, 10, -15),
    `CYCLE71(10,-1,2,-11,0,0,20,60,0,2.5,,5,0,${f2},41,0)`,
    '; ---- BACK STEP Y45..60, FLOOR Z-7: CORNER AT THE BACK RIGHT, ANGLE 180, SO THE WALL Y45 IS THE FAR EDGE',
    `CYCLE71(10,-1,2,-7,100,60,100,15,180,2,,5,0,${f2},31,0)`,
    '; ---- SPOT DRILL: HOLES C/D ON THE STEP (RFP -11), E/F ON TOP (RFP -1)',
    ...tc(m, 4, 10, 15),
    `F${CUT[m].T4[1]}`,
    'MCALL CYCLE81(10,-11,2,-13.5)',
    'X10 Y15',
    'X10 Y32',
    'MCALL CYCLE81(10,-1,2,-3.5)',
    'X45 Y22',
    'X80 Y22',
    'MCALL',
    '; ---- DRILL: C/D DEPTH 18 FROM THE TOP -> TIP Z-21.04, E/F DEPTH 12 -> TIP Z-15.04',
    ...tc(m, 5, 10, 15),
    `F${CUT[m].T5[1]}`,
    'MCALL CYCLE83(10,-11,2,-21.04,,,4,1,0,0,1,0)',
    'X10 Y15',
    'X10 Y32',
    'MCALL CYCLE83(10,-1,2,-15.04,,,4,1,0,0,1,0)',
    'X45 Y22',
    'X80 Y22',
    'MCALL',
    ...footer,
  ]);
});

const P06 = part({
  id: 'P06', title: 'Cam follower base', drawingNo: 'ML-1006', rev: 'C', customer: 'Penhallow Packaging Machines',
  brief: 'A base with a raised rectangular island (boss) carrying a round recess, and four mounting holes in the lowered flange.',
  difficulty: 3, material: 'aluminium',
  stock: { x: 100, y: 80, z: 26 }, size: { x: 100, y: 80, z: 25 }, protrusion: 14, tol: { general: 0.1 },
  features: [
    { type: 'boss', shape: 'rect', x: 50, y: 40, w: 70, h: 50, r: 8, depth: 6, tol: 0.05 },
    { type: 'pocketCirc', x: 50, y: 40, d: 24, depth: 5 },
    { type: 'hole', x: 7.5, y: 7.5, d: 6.8, depth: 14 },
    { type: 'hole', x: 92.5, y: 7.5, d: 6.8, depth: 14 },
    { type: 'hole', x: 7.5, y: 72.5, d: 6.8, depth: 14 },
    { type: 'hole', x: 92.5, y: 72.5, d: 6.8, depth: 14 },
  ],
  notes: ['Island 70 x 50 R8 ±0.05, flange 6 below the top', 'Mounting holes start on the flange', 'Break all sharp edges'],
}, (p) => {
  const m = p.material, [, f2, fd2] = CUT[m].T2;
  return nc([
    ...header(p, ['OP1 FACE MILL', 'OP2 ISLAND 70 x 50 R8 (CYCLE76 RECTANGULAR SPIGOT)', 'OP3 RECESS D24 (POCKET4)', 'OP4 SPOT + DRILL 4 HOLES ON THE FLANGE']),
    ...face(p),
    '; ---- ISLAND: FLANGE FLOOR Z-7, BLANK 100 x 80 AROUND THE CENTRE X50 Y40',
    ...tc(m, 2, 115, 40),
    `CYCLE76(10,-1,2,-7,,70,50,8,50,40,0,2,0,0,${f2},${fd2},0,1,100,80)`,
    '; ---- RECESS D24, FLOOR Z-6',
    'G0 X50 Y40',
    `POCKET4(10,-1,2,-6,12,50,40,2.5,0,0,${f2},${fd2},0,11,,,,3,1)`,
    '; ---- SPOT DRILL ON THE FLANGE (RFP -7)',
    ...tc(m, 4, 7.5, 7.5),
    `F${CUT[m].T4[1]}`,
    'MCALL CYCLE81(10,-7,2,-9.5)',
    'HOLES1(7.5,7.5,0,0,85,2)',
    'HOLES1(7.5,72.5,0,0,85,2)',
    'MCALL',
    '; ---- DRILL DEPTH 14 FROM THE TOP -> TIP Z-17.04',
    ...tc(m, 5, 7.5, 7.5),
    `F${CUT[m].T5[1]}`,
    'MCALL CYCLE83(10,-7,2,-17.04,,,4,1,0,0,1,0)',
    'HOLES1(7.5,7.5,0,0,85,2)',
    'HOLES1(7.5,72.5,0,0,85,2)',
    'MCALL',
    ...footer,
  ]);
});

const P07CB = [[12, 12], [98, 12], [12, 58], [98, 58]];
const P07 = part({
  id: 'P07', title: 'Manifold cover', drawingNo: 'ML-1007', rev: 'A', customer: 'Brightwater Hydraulics',
  brief: 'A brass manifold cover for four M6 socket head screws (counterbored), with a gasket recess and a central port.',
  difficulty: 4, material: 'brass',
  stock: { x: 110, y: 70, z: 21 }, size: { x: 110, y: 70, z: 20 }, protrusion: 12, tol: { general: 0.1 },
  features: [
    ...P07CB.map(([x, y]) => ({ type: 'hole', x, y, d: 6.8, depth: 15, cbore: { d: 11, depth: 6.5 } })),
    { type: 'pocketRect', x: 55, y: 35, w: 44, h: 26, r: 6, depth: 5, tol: 0.05 },
    { type: 'hole', x: 55, y: 35, d: 6.8, depth: 15 },
  ],
  notes: ['Counterbores Ø11 x 6.5 deep for M6 socket head cap screws', 'Gasket recess 44 x 26 R6, floor Ra 1.6', 'Deburr all edges, brass: no sharp burrs'],
}, (p) => {
  const m = p.material, [, f2, fd2] = CUT[m].T2, [, f3, fd3] = CUT[m].T3;
  return nc([
    ...header(p, ['OP1 FACE MILL', 'OP2 RECESS E 44 x 26 R6 (POCKET3)', 'OP3 SPOT + DRILL 5 HOLES', 'OP4 COUNTERBORES D11 x 6.5 WITH THE D6 (POCKET4)']),
    ...face(p),
    '; ---- RECESS E, FLOOR Z-6',
    ...tc(m, 2, 55, 35),
    `POCKET3(10,-1,2,-6,44,26,6,55,35,0,2.5,0.2,0.1,${f2},${fd2},0,11,,,,,3,1)`,
    `POCKET3(10,-1,2,-6,44,26,6,55,35,0,5,0,0,${Math.round(f2 * 0.7)},${fd2},0,12)`,
    '; ---- SPOT DRILL: CORNER HOLES FROM THE TOP, PORT F FROM THE RECESS FLOOR (RFP -6)',
    ...tc(m, 4, 12, 12),
    `F${CUT[m].T4[1]}`,
    'MCALL CYCLE81(10,-1,2,-3.5)',
    'HOLES1(12,12,0,0,86,2)',
    'HOLES1(12,58,0,0,86,2)',
    'MCALL CYCLE81(10,-6,2,-8.5)',
    'X55 Y35',
    'MCALL',
    '; ---- DRILL DEPTH 15 FROM THE TOP -> TIP Z-18.04',
    ...tc(m, 5, 12, 12),
    `F${CUT[m].T5[1]}`,
    'MCALL CYCLE83(10,-1,2,-18.04,,,4,1,0,0,1,0)',
    'HOLES1(12,12,0,0,86,2)',
    'HOLES1(12,58,0,0,86,2)',
    'MCALL CYCLE83(10,-6,2,-18.04,,,4,1,0,0,1,0)',
    'X55 Y35',
    'MCALL',
    '; ---- COUNTERBORES D11 x 6.5: FLOOR Z-7.5',
    ...tc(m, 3, 12, 12),
    ...P07CB.flatMap(([x, y]) => [`POCKET4(10,-1,2,-7.5,5.5,${x},${y},2,0,0,${f3},${fd3},0,11,,,,1.5,1)`]),
    ...footer,
  ]);
});

const P08HOLES = pcd(90, 45, 22, 45, 4);
const P08 = part({
  id: 'P08', title: 'Index plate', drawingNo: 'ML-1008', rev: 'A', customer: 'Larkspur Optics',
  brief: 'An indexing plate with a pocket turned 30°, a Ø24 locating bore with four holes around it, and a cable slot.',
  difficulty: 4, material: 'aluminium',
  stock: { x: 120, y: 90, z: 21 }, size: { x: 120, y: 90, z: 20 }, protrusion: 12, tol: { general: 0.1 },
  features: [
    { type: 'pocketRect', x: 38, y: 45, w: 50, h: 20, r: 6, depth: 5, rot: 30 },
    { type: 'pocketCirc', x: 90, y: 45, d: 24, depth: 6, tol: 0.05 },
    ...P08HOLES.map(([x, y]) => ({ type: 'hole', x, y, d: 6.8, depth: 10, pattern: { type: 'pcd', cx: 90, cy: 45, d: 44, n: 4, start: 45 } })),
    { type: 'slot', x1: 20, y1: 80, x2: 60, y2: 80, w: 8, depth: 3 },
  ],
  notes: ['Pocket A is rotated 30° counter-clockwise about its centre', '4 holes Ø6.8 on PCD 44 at 45°', 'Break all sharp edges'],
}, (p) => {
  const m = p.material, [, f2, fd2] = CUT[m].T2, [, f3, fd3] = CUT[m].T3;
  return nc([
    ...header(p, ['OP1 FACE MILL', 'OP2 POCKET A AT 30 DEG (POCKET3 STA=30)', 'OP3 BORE B D24 (POCKET4)', 'OP4 SPOT + DRILL 4 HOLES ON PCD 44 (HOLES2)', 'OP5 SLOT G 8 WIDE (SLOT1)']),
    ...face(p),
    '; ---- POCKET A 50 x 20 R6 AT 30 DEG, FLOOR Z-6',
    ...tc(m, 2, 38, 45),
    `POCKET3(10,-1,2,-6,50,20,6,38,45,30,2.5,0.2,0.1,${f2},${fd2},0,11,,,,,3,1)`,
    `POCKET3(10,-1,2,-6,50,20,6,38,45,30,5,0,0,${Math.round(f2 * 0.7)},${fd2},0,12)`,
    '; ---- BORE B D24, FLOOR Z-7',
    'G0 X90 Y45',
    `POCKET4(10,-1,2,-7,12,90,45,3,0.2,0.1,${f2},${fd2},0,11,,,,3,1)`,
    `POCKET4(10,-1,2,-7,12,90,45,6,0,0,${Math.round(f2 * 0.7)},${fd2},0,12)`,
    '; ---- SPOT DRILL',
    ...tc(m, 4, 105, 60),
    `F${CUT[m].T4[1]}`,
    'MCALL CYCLE81(10,-1,2,-3.5)',
    'HOLES2(90,45,22,45,0,4)',
    'MCALL',
    '; ---- DRILL DEPTH 10 -> TIP Z-13.04',
    ...tc(m, 5, 105, 60),
    `F${CUT[m].T5[1]}`,
    'MCALL CYCLE83(10,-1,2,-13.04,,,4,1,0,0,1,0)',
    'HOLES2(90,45,22,45,0,4)',
    'MCALL',
    '; ---- SLOT G: X20..60 AT Y80, 8 WIDE, FLOOR Z-4',
    ...tc(m, 3, 16, 80),
    `SLOT1(10,-1,2,-4,,1,48,8,16,80,0,0,0,${fd3},${f3},1.5,0,0,0)`,
    ...footer,
  ]);
});

const P09CB = pcd(50, 50, 28, 45, 4);
const P09 = part({
  id: 'P09', title: 'Sensor flange', drawingNo: 'ML-1009', rev: 'B', customer: 'Kestrel Instruments',
  brief: 'A steel sensor flange: a round Ø80 spigot with a Ø32 bore, four counterbored screw holes on PCD 56 and four holes in the corners of the flange.',
  difficulty: 5, material: 'steel',
  stock: { x: 100, y: 100, z: 26 }, size: { x: 100, y: 100, z: 25 }, protrusion: 16, tol: { general: 0.1 },
  features: [
    { type: 'boss', shape: 'circle', x: 50, y: 50, d: 80, depth: 6, tol: 0.05 },
    { type: 'pocketCirc', x: 50, y: 50, d: 32, depth: 12, tol: 0.05 },
    ...P09CB.map(([x, y]) => ({ type: 'hole', x, y, d: 6.8, depth: 16, cbore: { d: 11, depth: 4 }, pattern: { type: 'pcd', cx: 50, cy: 50, d: 56, n: 4, start: 45 } })),
    { type: 'hole', x: 8, y: 8, d: 6.8, depth: 14 },
    { type: 'hole', x: 92, y: 8, d: 6.8, depth: 14 },
    { type: 'hole', x: 8, y: 92, d: 6.8, depth: 14 },
    { type: 'hole', x: 92, y: 92, d: 6.8, depth: 14 },
  ],
  notes: ['Steel 1045: use coolant and reduced cutting data', 'Spigot Ø80 and bore Ø32 ±0.05, concentric', 'Counterbores Ø11 x 4 on PCD 56 at 45°', 'Break all sharp edges'],
}, (p) => {
  const m = p.material, [, f2, fd2] = CUT[m].T2, [, f3, fd3] = CUT[m].T3;
  return nc([
    ...header(p, ['OP1 FACE MILL (2 CUTS)', 'OP2 SPIGOT D80 (CYCLE77)', 'OP3 BORE D32 (POCKET4)', 'OP4 SPOT + DRILL 8 HOLES', 'OP5 COUNTERBORES D11 x 4 (POCKET4 WITH THE D6)']),
    ...face(p),
    '; ---- SPIGOT D80: FLANGE FLOOR Z-7, BLANK DIAGONAL 142',
    ...tc(m, 2, 125, 50),
    `CYCLE77(10,-1,2,-7,,80,50,50,3,0,0,${f2},${fd2},0,1,142)`,
    '; ---- BORE D32, FLOOR Z-13',
    'G0 X50 Y50',
    `POCKET4(10,-1,2,-13,16,50,50,2,0.2,0.1,${f2},${fd2},0,11,,,,3,0.5)`,
    `POCKET4(10,-1,2,-13,16,50,50,12,0,0,${Math.round(f2 * 0.7)},${fd2},0,12,,,,3,0.5)`,
    '; ---- SPOT DRILL: PCD HOLES FROM THE TOP, CORNER HOLES FROM THE FLANGE (RFP -7)',
    ...tc(m, 4, 69.799, 69.799),
    `F${CUT[m].T4[1]}`,
    'MCALL CYCLE81(10,-1,2,-3.5)',
    'HOLES2(50,50,28,45,0,4)',
    'MCALL CYCLE81(10,-7,2,-9.5)',
    'HOLES1(8,8,0,0,84,2)',
    'HOLES1(8,92,0,0,84,2)',
    'MCALL',
    '; ---- DRILL: PCD HOLES DEPTH 16 -> TIP Z-19.04, CORNER HOLES DEPTH 14 -> TIP Z-17.04',
    ...tc(m, 5, 69.799, 69.799),
    `F${CUT[m].T5[1]}`,
    'MCALL CYCLE83(10,-1,2,-19.04,,,3,0.5,0,0,1,0)',
    'HOLES2(50,50,28,45,0,4)',
    'MCALL CYCLE83(10,-7,2,-17.04,,,3,0.5,0,0,1,0)',
    'HOLES1(8,8,0,0,84,2)',
    'HOLES1(8,92,0,0,84,2)',
    'MCALL',
    '; ---- COUNTERBORES D11 x 4: FLOOR Z-5',
    ...tc(m, 3, P09CB[0][0], P09CB[0][1]),
    ...P09CB.map(([x, y]) => `POCKET4(10,-1,2,-5,5.5,${x},${y},2,0,0,${f3},${fd3},0,11,,,,1.5,0.5)`),
    ...footer,
  ]);
});

const P10 = part({
  id: 'P10', title: 'Gearbox bracket', drawingNo: 'ML-1010', rev: 'A', customer: 'Ostrander Motion',
  brief: 'A brass bracket with a shoulder carrying an adjustment slot, a deep rectangular pocket, a small bore and three drilled holes. Every cycle in one job.',
  difficulty: 5, material: 'brass',
  stock: { x: 130, y: 80, z: 31 }, size: { x: 130, y: 80, z: 30 }, protrusion: 16, tol: { general: 0.1 },
  features: [
    { type: 'step', side: 'right', width: 25, depth: 8 },
    { type: 'pocketRect', x: 40, y: 40, w: 50, h: 36, r: 8, depth: 10, tol: 0.05 },
    { type: 'slot', x1: 117.5, y1: 15, x2: 117.5, y2: 65, w: 8, depth: 12 },
    { type: 'hole', x: 80, y: 15, d: 6.8, depth: 20 },
    { type: 'hole', x: 80, y: 65, d: 6.8, depth: 20 },
    { type: 'hole', x: 40, y: 40, d: 6.8, depth: 20 },
    { type: 'pocketCirc', x: 80, y: 40, d: 16, depth: 6 },
  ],
  notes: ['Slot C is on the shoulder (8 below the top), 4 deep from the shoulder', 'Pocket B 50 x 36 R8 ±0.05', 'Deburr all edges'],
}, (p) => {
  const m = p.material, [, f2, fd2] = CUT[m].T2, [, f3, fd3] = CUT[m].T3;
  return nc([
    ...header(p, ['OP1 FACE MILL', 'OP2 RIGHT SHOULDER 25 WIDE (CYCLE71, D10)', 'OP3 POCKET B (POCKET3)', 'OP4 SPOT + DRILL 3 HOLES', 'OP5 BORE G D16 AND SLOT C (D6)']),
    ...face(p),
    '; ---- RIGHT SHOULDER X105..130, FLOOR Z-9: CORNER AT THE BACK RIGHT, ANGLE 180 (WALL X105 = FAR EDGE)',
    ...tc(m, 2, 115, 95),
    `CYCLE71(10,-1,2,-9,130,80,25,80,180,2,,5,0,${f2},41,0)`,
    '; ---- POCKET B 50 x 36 R8, FLOOR Z-11',
    'G0 X40 Y40',
    `POCKET3(10,-1,2,-11,50,36,8,40,40,0,2.5,0.2,0.1,${f2},${fd2},0,11,,,,,3,1)`,
    `POCKET3(10,-1,2,-11,50,36,8,40,40,0,10,0,0,${Math.round(f2 * 0.7)},${fd2},0,12)`,
    '; ---- SPOT DRILL: D/E FROM THE TOP, F FROM THE POCKET FLOOR (RFP -11)',
    ...tc(m, 4, 80, 15),
    `F${CUT[m].T4[1]}`,
    'MCALL CYCLE81(10,-1,2,-3.5)',
    'X80 Y15',
    'X80 Y65',
    'MCALL CYCLE81(10,-11,2,-13.5)',
    'X40 Y40',
    'MCALL',
    '; ---- DRILL DEPTH 20 FROM THE TOP -> TIP Z-23.04',
    ...tc(m, 5, 80, 15),
    `F${CUT[m].T5[1]}`,
    'MCALL CYCLE83(10,-1,2,-23.04,,,4,1,0,0,1,0)',
    'X80 Y15',
    'X80 Y65',
    'MCALL CYCLE83(10,-11,2,-23.04,,,4,1,0,0,1,0)',
    'X40 Y40',
    'MCALL',
    '; ---- BORE G D16, FLOOR Z-7',
    ...tc(m, 3, 80, 40),
    `POCKET4(10,-1,2,-7,8,80,40,2,0,0,${f3},${fd3},0,11,,,,2,1)`,
    '; ---- SLOT C ON THE SHOULDER: Y15..65 AT X117.5, 8 WIDE, FLOOR Z-13 (RFP -9)',
    `SLOT1(10,-9,2,-13,,1,58,8,117.5,11,0,90,0,${fd3},${f3},1.5,0,0,0)`,
    ...footer,
  ]);
});

export const PARTS = [P01, P02, P03, P04, P05, P06, P07, P08, P09, P10];

export function getPart(id) {
  return PARTS.find((p) => p.id === id) || null;
}

// Table-frame position of the part datum (front-left corner of the FINISHED top face) for a stock
// placement from stockPlacement({ x: stock.x, y: stock.y, z: stock.z, protrusion }).
export function partDatum(placement, part) {
  return { x: placement.x0, y: placement.y0, z: placement.top - (part.stock.z - part.size.z) };
}

// ------------------------------------------------------------------------------------------ geometry
// Each feature is split into primitive "elements" with a signed distance function in the part frame
// (negative inside the shape). Material is removed inside the shape (removeInside) or, for bosses,
// outside it, down to `depth`. Holes carry a cone allowance (drill point) below their depth.
function rrectSdf(u, v, a, b, r) {
  r = Math.max(0, Math.min(r, a, b));
  const qx = Math.abs(u) - (a - r), qy = Math.abs(v) - (b - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

function makeElements(part) {
  const els = [];
  const { x: SX, y: SY } = part.size;
  part.features.forEach((f, k) => {
    const id = f.id ?? String(k + 1);
    const tol = f.tol ?? part.tol?.general ?? 0.1;
    const base = { k, id, f, tol, depth: f.depth, removeInside: true, cone: 0 };
    switch (f.type) {
      case 'pocketRect':
      case 'boss': {
        if (f.type === 'boss' && f.shape === 'circle') {
          const R = f.d / 2;
          els.push({ ...base, sub: 'boss', shape: 'circle', removeInside: false, cx: f.x, cy: f.y, R, sdf: (x, y) => Math.hypot(x - f.x, y - f.y) - R });
          break;
        }
        const rot = (f.rot || 0) * D2R, c = Math.cos(rot), s = Math.sin(rot);
        const a = f.w / 2, b = f.h / 2, r = f.r || 0;
        els.push({
          ...base, sub: f.type === 'boss' ? 'boss' : 'pocket', shape: 'rect', removeInside: f.type !== 'boss',
          cx: f.x, cy: f.y, c, s, a, b, r,
          sdf: (x, y) => {
            const dx = x - f.x, dy = y - f.y;
            return rrectSdf(c * dx + s * dy, -s * dx + c * dy, a, b, r);
          },
        });
        break;
      }
      case 'pocketCirc': {
        const R = f.d / 2;
        els.push({ ...base, sub: 'pocket', shape: 'circle', cx: f.x, cy: f.y, R, sdf: (x, y) => Math.hypot(x - f.x, y - f.y) - R });
        break;
      }
      case 'hole': {
        const R = f.d / 2;
        els.push({ ...base, sub: 'hole', shape: 'circle', cx: f.x, cy: f.y, R, cone: DRILL_POINT_K, sdf: (x, y) => Math.hypot(x - f.x, y - f.y) - R });
        if (f.cbore) {
          const Rc = f.cbore.d / 2;
          els.push({ ...base, sub: 'cbore', shape: 'circle', cx: f.x, cy: f.y, R: Rc, depth: f.cbore.depth, tol: f.cbore.tol ?? tol, sdf: (x, y) => Math.hypot(x - f.x, y - f.y) - Rc });
        }
        break;
      }
      case 'slot': {
        const dx = f.x2 - f.x1, dy = f.y2 - f.y1, L = Math.hypot(dx, dy);
        const c = L > 1e-9 ? dx / L : 1, s = L > 1e-9 ? dy / L : 0;
        const cx = (f.x1 + f.x2) / 2, cy = (f.y1 + f.y2) / 2, hw = f.w / 2, hl = L / 2;
        els.push({
          ...base, sub: 'slot', shape: 'capsule', cx, cy, c, s, hl, hw,
          sdf: (x, y) => {
            const ex = x - cx, ey = y - cy;
            const u = c * ex + s * ey, v = -s * ex + c * ey;
            const uu = Math.max(Math.abs(u) - hl, 0);
            return Math.hypot(uu, v) - hw;
          },
        });
        break;
      }
      case 'step': {
        const w = f.width;
        // the shape (removed region) is a half plane bounded by the step wall
        let sdf, nx = 0, ny = 0, wall;
        if (f.side === 'left') { sdf = (x) => x - w; nx = 1; wall = w; }
        else if (f.side === 'right') { sdf = (x) => SX - w - x; nx = -1; wall = SX - w; }
        else if (f.side === 'front') { sdf = (x, y) => y - w; ny = 1; wall = w; }
        else { sdf = (x, y) => SY - w - y; ny = -1; wall = SY - w; }
        els.push({ ...base, sub: 'step', shape: 'half', nx, ny, wall, sdf });
        break;
      }
      default:
        break;
    }
  });
  return els;
}

const elCache = new WeakMap();
export function featureElements(part) {
  let e = elCache.get(part);
  if (!e) {
    e = makeElements(part);
    elCache.set(part, e);
  }
  return e;
}

// Target at a part-frame point: { depth, el (governing element index, -1 = top face), cone (allowed
// extra depth for a drill point) }. `skip` leaves one element out (used by the inspection).
export function targetInfo(part, px, py, skip = -1, out = {}) {
  const els = featureElements(part);
  let depth = 0, el = -1, cone = 0;
  for (let i = 0; i < els.length; i++) {
    if (i === skip) continue;
    const e = els[i];
    const d = e.sdf(px, py);
    if (e.removeInside ? d > 0 : d <= 0) continue;
    if (e.depth > depth + 1e-9) {
      depth = e.depth;
      el = i;
      cone = e.cone ? -d * e.cone : 0;
    }
  }
  out.depth = depth;
  out.el = el;
  out.cone = cone;
  return out;
}

// Depth below the finished top Z0 at a part-frame point (0 = top face), null outside the part.
export function targetDepthAt(part, px, py) {
  if (px < -1e-9 || py < -1e-9 || px > part.size.x + 1e-9 || py > part.size.y + 1e-9) return null;
  return targetInfo(part, px, py).depth;
}
