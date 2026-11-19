// Tutorial job T01 "First part": the drawing, a reference program and the step-by-step description of
// the program the tutorial asks the player to build with the programGUIDE cycle forms of the control.
//
// Same schema and conventions as src/game/parts.js (part frame = drawing frame: origin at the
// front-left corner of the FINISHED top, depths positive below Z0). Programs use the 808D dialect and
// the default tool library, with G54 = TOP FRONT-LEFT corner of the RAW blank, Z0 = top of the raw blank,
// so the finished top face is at Z-1 and every feature floor at Z = -1 - depth.
//
// The cycle forms (src/ui/cycleforms.js) are generated from CYCLES[name].params in
// src/gcode/sinucycles.js: one input per parameter, in parameter order, DOM id `cf_<index>`, the label
// text is `params[i].label`, the default value `params[i].def`. The form's OK button inserts
// formatCall(name, values) (trailing empty values dropped, empty values in between kept as ",,") as a
// new line after the caret line; a form opened with modal = true (Re-compile on an MCALL line) prefixes
// "MCALL ".
import { CYCLES } from '../gcode/sinucycles.js';

const TOOL = {
  1: { T: 1, D: 1, name: 'FACE MILL D50' },
  2: { T: 2, D: 1, name: 'END MILL D10' },
  5: { T: 5, D: 1, name: 'TWIST DRILL D6.8 118 DEG' },
};

// 118° drill point below the full diameter of a Ø6.8 drill: 3.4 / tan(59°) = 2.04
const POINT = 2.04;

const SETUP = 'G54 on the top front-left corner of the RAW blank (X0 Y0 at the front-left corner, Z0 = top of the raw blank). '
  + 'The finished top face is 1 mm lower, at Z-1; feature floors are at Z-1 minus the drawing depth. '
  + 'Tools from the default library: T1 face mill Ø50, T2 end mill Ø10, T5 drill Ø6.8.';

export const TUTORIAL_PART = {
  id: 'T01', title: 'First part', drawingNo: 'ML-0001', rev: 'A', customer: 'MillLab Training',
  brief: 'Your first job: face a small aluminium blank to thickness, mill one rectangular pocket and drill two holes. '
    + 'The tutorial walks you through every step at the control.',
  difficulty: 1, material: 'aluminium',
  stock: { x: 80, y: 50, z: 16 }, size: { x: 80, y: 50, z: 15 }, protrusion: 10, tol: { general: 0.1 },
  features: [
    { id: 'A', type: 'pocketRect', x: 40, y: 25, w: 40, h: 24, r: 6, depth: 4, tol: 0.05, rot: 0 },
    { id: 'B', type: 'hole', x: 10, y: 10, d: 6.8, depth: 8 },
    { id: 'C', type: 'hole', x: 70, y: 40, d: 6.8, depth: 8 },
  ],
  // the drawing adds blank size, datums, drill point and general tolerance notes itself
  notes: [
    'Depths are measured from the finished (faced) top face',
    'Break all sharp edges',
  ],
  setupNote: SETUP,
  solution: '', // filled below from the tutorial steps
};

// ------------------------------------------------------------------------------- program steps
// Each step: what the player enters at the control for one operation.
//   cycle      programGUIDE form name (= CYCLES key); softkey path Program > `group` > cycle
//   modal      true: the cycle must be inserted as "MCALL <call>" (drilling at the positions after it)
//   tool       { T, D, name }; spindle { S, F? } used in `before`
//   fields     the form fields the player must look at / type, in form order: { key (= params[i].k),
//              index, id ('cf_<index>'), label (as shown), unit, default (the form's prefilled value),
//              value (what to type, string), edit (value differs from the default), why }
//   formValues every form input in order (strings) = what the form holds after the player's edits
//   formText   what the form's OK inserts when opened from the softkey (no MCALL prefix)
//   programLines the exact cycle line(s) the program must contain for this step
//   before / after  surrounding lines (tool change, spindle, positions, MCALL off) for a "fill for me"
//   features   drawing feature ids made by the step
const S = (k, value, why) => ({ k, value: String(value), why });

function step(def) {
  const cy = CYCLES[def.cycle];
  if (!cy) throw new Error(`tutorial-part: unknown cycle ${def.cycle}`);
  const given = new Map(def.set.map((f) => [f.k, f]));
  for (const k of given.keys()) if (!cy.params.some((p) => p.k === k)) throw new Error(`tutorial-part: ${def.cycle} has no field ${k}`);
  const fields = [];
  const formValues = cy.params.map((p, i) => {
    const dflt = String(p.def ?? '');
    const f = given.get(p.k);
    if (f) fields.push({ key: p.k, index: i, id: `cf_${i}`, label: p.label, unit: p.unit || '', default: dflt, value: f.value, edit: f.value !== dflt, why: f.why });
    return f ? f.value : dflt;
  });
  const { set, ...rest } = def;
  return { ...rest, noForm: false, fields, formValues };
}

export const TUTORIAL_PROGRAM_STEPS = [
  step({
    id: 'face', title: 'Face the top', cycle: 'CYCLE71', group: 'Milling', modal: false, features: [],
    tool: TOOL[1], spindle: { S: 3200 },
    intro: 'The sawn blank is 16 thick and the drawing wants 15: the face mill takes 1 mm off the top so it is flat and clean.',
    before: [
      '; ---- OP1 FACE THE TOP 1 MM DOWN TO Z-1 (THICKNESS 15)',
      'T1 D1 M6 ; FACE MILL D50',
      'S3200 M3 M8',
      'G0 X-40 Y0',
      'Z10',
      '; CYCLE71 PARAMETERS: RTP RFP SDIS DP PA PO LENG WID STA MID MIDA FDP FALD FFP1 VARI FDP1',
    ],
    set: [
      S('RTP', 10, 'Retraction plane: after the cycle the tool goes back up to Z10, 10 mm above the blank.'),
      S('RFP', 0, 'Reference plane: the top of the raw blank is Z0 (that is where G54 was set).'),
      S('SDIS', 2, 'Safety distance: rapid down to 2 mm above the material, then feed.'),
      S('DP', -1, 'Final depth Z-1: blank 16, drawing thickness 15, so 1 mm comes off the top.'),
      S('PA', 0, 'Corner point X0: the front-left corner of the blank.'),
      S('PO', 0, 'Corner point Y0: the front-left corner of the blank.'),
      S('LENG', 80, 'Length of the face in X: the blank is 80 long.'),
      S('WID', 50, 'Width of the face in Y: the blank is 50 wide.'),
      S('MID', 1, 'Max. depth per cut 1 mm: the whole 1 mm comes off in one pass.'),
      S('FFP1', 1300, 'Feed 1300 mm/min for the Ø50 face mill in aluminium.'),
      S('VARI', 31, '31 = roughing, zig-zag paths along X.'),
    ],
    programLines: ['CYCLE71(10,0,2,-1,0,0,80,50,0,1,,5,0,1300,31,2)'],
    formText: 'CYCLE71(10,0,2,-1,0,0,80,50,0,1,,5,0,1300,31,2)',
    after: [],
  }),
  step({
    id: 'pocket', title: 'Mill pocket A', cycle: 'POCKET3', group: 'Milling', modal: false, features: ['A'],
    tool: TOOL[2], spindle: { S: 9500 },
    intro: 'Pocket A is 40 x 24 with R6 corners, 4 deep. POCKET3 roughs it from the centre outwards and then finishes floor and walls.',
    before: [
      '; ---- OP2 POCKET A 40 X 24 R6 DEPTH 4: CENTRE X40 Y25, FLOOR Z-5',
      'T2 D1 M6 ; END MILL D10',
      'S9500 M3 M8',
      'G0 X40 Y25',
      'Z10',
      '; POCKET3 PARAMETERS: RTP RFP SDIS DP LENG WID CRAD PA PO STA MID FAL FALD FFP1 FFD CDIR VARI ... RAD1 DP1',
      '; VARI 10 = HELICAL INSERTION + ROUGH AND FINISH (0.2 WALL / 0.1 FLOOR ALLOWANCE) IN ONE CALL',
    ],
    set: [
      S('RTP', 10, 'Retraction plane Z10, as for the facing.'),
      S('RFP', -1, 'Reference plane Z-1: the top was faced down 1 mm, so the material now starts at Z-1.'),
      S('SDIS', 2, 'Safety distance 2 mm above the reference plane.'),
      S('DP', -5, 'Pocket depth 4 from the drawing, measured from the finished top Z-1: DP = -1 - 4 = -5 (absolute).'),
      S('LENG', 40, 'Pocket length in X: 40 on the drawing.'),
      S('WID', 24, 'Pocket width in Y: 24 on the drawing.'),
      S('CRAD', 6, 'Corner radius R6 from the drawing (bigger than the R5 of the Ø10 cutter, good).'),
      S('PA', 40, 'Pocket centre X40: the drawing dimensions the centre 40 from the left edge.'),
      S('PO', 25, 'Pocket centre Y25: 25 from the front edge.'),
      S('MID', 2, 'Max. depth per cut 2 mm: the 4 mm deep pocket is roughed in two levels.'),
      S('FAL', 0.2, 'Leave 0.2 mm on the walls for the finishing cut (the pocket has a tight ±0.05 tolerance).'),
      S('FALD', 0.1, 'Leave 0.1 mm on the floor for the finishing cut.'),
      S('FFP1', 1400, 'Feed 1400 mm/min for the Ø10 end mill in aluminium.'),
      S('FFD', 400, 'Slower feed 400 mm/min going down into the material.'),
      S('VARI', 10, '10 = helical insertion (tens 1) and complete machining (units 0): rough, then finish to size in one cycle.'),
    ],
    programLines: ['POCKET3(10,-1,2,-5,40,24,6,40,25,0,2,0.2,0.1,1400,400,0,10,,,,,3,1)'],
    formText: 'POCKET3(10,-1,2,-5,40,24,6,40,25,0,2,0.2,0.1,1400,400,0,10,,,,,3,1)',
    after: [],
  }),
  step({
    id: 'drill', title: 'Drill holes B and C', cycle: 'CYCLE81', group: 'Drilling', modal: true, features: ['B', 'C'],
    tool: TOOL[5], spindle: { S: 4500, F: 600 },
    intro: 'Holes B and C are Ø6.8, 8 deep. MCALL CYCLE81 makes the drilling cycle modal: it then drills at every position you program until MCALL switches it off.',
    before: [
      `; ---- OP3 DRILL B AND C D6.8: DEPTH 8 + ${POINT} DRILL POINT = TIP AT Z-${(1 + 8 + POINT).toFixed(2)}`,
      'T5 D1 M6 ; TWIST DRILL D6.8 118 DEG',
      'S4500 M3 M8',
      'G0 X10 Y10',
      'Z10',
      'F600 ; DRILLING FEED (CYCLE81 USES THE ACTIVE F)',
      '; MCALL + CYCLE81 PARAMETERS RTP RFP SDIS DP: DRILLS AT EVERY POSITION BELOW UNTIL MCALL OFF',
    ],
    set: [
      S('RTP', 10, 'Retraction plane Z10: between the holes the drill lifts to Z10.'),
      S('RFP', -1, 'Reference plane Z-1: the holes start on the faced top.'),
      S('SDIS', 2, 'Safety distance 2 mm above the reference plane.'),
      S('DP', -11.04, `Hole depth 8 from the drawing is to the full Ø6.8, measured from Z-1; the 118° point adds ${POINT}: DP = -1 - 8 - ${POINT} = -11.04 (absolute).`),
      S('DPR', '', 'Leave empty: DPR (depth relative to RFP) would be used instead of DP.'),
    ],
    programLines: ['MCALL CYCLE81(10,-1,2,-11.04)'],
    formText: 'CYCLE81(10,-1,2,-11.04)',
    after: [
      'X10 Y10 ; HOLE B',
      'X70 Y40 ; HOLE C',
      'MCALL ; MODAL CALL OFF',
    ],
  }),
];

// ------------------------------------------------------------------------------- whole program
function header(p, steps) {
  const S0 = p.stock, Z = p.size;
  return [
    `; JOB_${p.id} ${p.title.toUpperCase()}  DRG ${p.drawingNo} REV ${p.rev}`,
    `; BLANK ${S0.x} x ${S0.y} x ${S0.z} ALUMINIUM -> FINISHED ${Z.x} x ${Z.y} x ${Z.z}`,
    '; G54 = TOP FRONT-LEFT CORNER OF THE RAW BLANK, Z0 = TOP OF THE RAW BLANK',
    '; FINISHED TOP FACE AT Z-1 (FACE OFF 1 MM); FEATURE FLOOR Z = -1 - DEPTH',
    ...steps.map((s, i) => `; OP${i + 1} ${s.title.toUpperCase()} (${s.modal ? 'MCALL ' : ''}${s.cycle}, T${s.tool.T} ${s.tool.name})`),
    'G17 G90 G71 G94 G40 ; XY PLANE, ABSOLUTE, MM, FEED PER MINUTE, NO RADIUS COMP.',
    'G54 ; WORK OFFSET',
  ];
}

const FOOTER = [
  '; ---- END: TOOL UP, COOLANT AND SPINDLE OFF, Z HOME, PROGRAM END',
  'G0 Z100 M9',
  'M5',
  'G74 Z1=0',
  'M30',
];

// Full program assembled from the steps (header + every step's before / cycle lines / after + end).
export function tutorialProgramFromSteps(steps = TUTORIAL_PROGRAM_STEPS, part = TUTORIAL_PART) {
  const lines = [...header(part, steps)];
  for (const s of steps) lines.push(...(s.before || []), ...s.programLines, ...(s.after || []));
  lines.push(...FOOTER);
  return lines.join('\n') + '\n';
}

// Reference solution in the style of PARTS: the same program with block numbers.
function nc(text) {
  let n = 10;
  return text.split('\n').map((l) => {
    if (!l || l.startsWith(';')) return l;
    const s = `N${n} ${l}`;
    n += 10;
    return s;
  }).join('\n');
}

TUTORIAL_PART.solution = nc(tutorialProgramFromSteps());
