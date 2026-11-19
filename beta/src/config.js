// Machine, material and tooling data. Everything here is in millimetres, mm/min, rpm and seconds.
//
// Coordinate frames used throughout the simulator
// ------------------------------------------------
// Machine (MCS): what the control's "MACHINE" DRO shows. Home is X0 Y0 Z0 and all travel is negative,
//   like most Fanuc/Haas style VMCs. The Z value is the position of the spindle gauge line.
// Work (WCS):    machine minus the active work offset (G54..G59) and, for Z, minus the active tool
//   length offset (G43 H_).
// Table frame:   origin at the centre of the table top, +X right, +Y away from the operator, +Z up.
//   The stock, vise, Z-map and toolpath are all expressed in this frame because they ride on the table.
// Three.js world: +X right, +Y up, +Z towards the operator. Table frame (x, y, z) -> local (x, z, -y).

export const MACHINE = {
  model: 'VMC-560',
  travel: { x: [-560, 0], y: [-410, 0], z: [-410, 0] },
  // Machine X/Y that place the spindle centreline over the centre of the table.
  tableCenter: { x: -280, y: -205 },
  // Height of the spindle gauge line above the table top when Z is at machine zero.
  gaugeAtZ0: 500,
  tableTopY: 930, // world height of the table top
  rapidXY: 24000, // mm/min
  rapidZ: 18000,
  maxFeed: 12000,
  accel: 2600, // mm/s^2 used for rapids, homing and jogs
  homingFeed: 6000,
  maxRpm: 12000,
  spindleAccel: 7000, // rpm per second
  spindlePowerKw: 11,
  atcPockets: 16,
  atcLift: 135, // how far the head rises above Z0 to release a tool in the carousel
  table: { length: 800, width: 380, thickness: 60, slots: 3, slotPitch: 110, slotWidth: 16 },
};

export const INCH = 25.4;

// Converts a machine position (gauge line) to the table frame tool-tip position.
export function machineToTable(x, y, z, toolLength, out) {
  out.x = x - MACHINE.tableCenter.x;
  out.y = y - MACHINE.tableCenter.y;
  out.z = MACHINE.gaugeAtZ0 + z - toolLength;
  return out;
}

// Inverse of machineToTable for X/Y and for the gauge line height (tool length 0).
export function tableToMachine(x, y, z) {
  return { x: x + MACHINE.tableCenter.x, y: y + MACHINE.tableCenter.y, z: z - MACHINE.gaugeAtZ0 };
}

// Workpiece materials. kc = specific cutting force (N/mm^2) used for spindle load,
// vc = recommended cutting speed range (m/min) for carbide, fz = recommended chip load per tooth (mm)
// for a 10 mm cutter, wear = relative abrasiveness used by the tool wear model.
export const MATERIALS = {
  aluminium: {
    name: 'Aluminium 6061-T6', short: 'Aluminium', density: 2.70, kc: 750, vc: [250, 700], fz: 0.06, wear: 1,
    raw: 0xa9afb6, cut: 0xe2e6ea, metalness: 0.92, roughness: 0.34, chip: 0xd7dce1, chipSize: 1.0, ferrous: false,
  },
  steel: {
    name: 'Steel 1045 (hot rolled)', short: 'Steel', density: 7.85, kc: 2100, vc: [90, 220], fz: 0.05, wear: 4.5,
    raw: 0x3b3d40, cut: 0xc5cacf, metalness: 0.95, roughness: 0.3, chip: 0x9aa3ad, chipSize: 0.8, ferrous: true,
  },
  brass: {
    name: 'Brass C360 (free machining)', short: 'Brass', density: 8.5, kc: 780, vc: [150, 400], fz: 0.05, wear: 0.8,
    raw: 0x9c7a35, cut: 0xe3c06c, metalness: 0.95, roughness: 0.3, chip: 0xd9b25c, chipSize: 0.55, ferrous: false,
  },
  plastic: {
    name: 'Acetal / POM (Delrin-type)', short: 'Plastic', density: 1.41, kc: 260, vc: [150, 500], fz: 0.1, wear: 0.15,
    raw: 0xcfcbc0, cut: 0xdcd8ce, metalness: 0.0, roughness: 0.58, chip: 0xeeebe2, chipSize: 1.4, ferrous: false,
  },
};

export const TOOL_TYPES = {
  flat: { label: 'Flat end mill', short: 'FEM' },
  ball: { label: 'Ball end mill', short: 'BEM' },
  bull: { label: 'Bull nose end mill', short: 'BULL' },
  face: { label: 'Face mill', short: 'FACE' },
  drill: { label: 'Twist drill', short: 'DRL' },
  spot: { label: 'Spot drill', short: 'SPOT' },
  chamfer: { label: 'Chamfer mill', short: 'CHAM' },
};

// Holder geometry, measured down from the gauge line. Face mills sit on a shell-mill arbor;
// everything else is held in an ER32 collet chuck.
export const HOLDERS = {
  er32: { label: 'BT40 ER32 collet chuck', length: 62, radius: 25 },
  shell: { label: 'BT40 shell-mill arbor', length: 45, radius: 22 },
};

export const DEFAULT_TOOLS = [
  { number: 1, name: 'Face mill Ø50, 5 inserts', type: 'face', diameter: 50, fluteLength: 6, length: 95, cornerRadius: 0.8, tipAngle: 0, flutes: 5, wear: 0 },
  { number: 2, name: 'Flat end mill Ø10, 3 flute carbide', type: 'flat', diameter: 10, fluteLength: 25, length: 100, cornerRadius: 0, tipAngle: 0, flutes: 3, wear: 0 },
  { number: 3, name: 'Flat end mill Ø6, 3 flute carbide', type: 'flat', diameter: 6, fluteLength: 18, length: 90, cornerRadius: 0, tipAngle: 0, flutes: 3, wear: 0 },
  { number: 4, name: 'Spot drill Ø10 × 90°', type: 'spot', diameter: 10, fluteLength: 14, length: 92, cornerRadius: 0, tipAngle: 90, flutes: 2, wear: 0 },
  { number: 5, name: 'Twist drill Ø6.8 × 118°', type: 'drill', diameter: 6.8, fluteLength: 45, length: 120, cornerRadius: 0, tipAngle: 118, flutes: 2, wear: 0 },
  { number: 6, name: 'Ball end mill Ø8, 2 flute', type: 'ball', diameter: 8, fluteLength: 20, length: 95, cornerRadius: 0, tipAngle: 0, flutes: 2, wear: 0 },
  { number: 7, name: 'Bull nose Ø12 R1, 4 flute', type: 'bull', diameter: 12, fluteLength: 26, length: 105, cornerRadius: 1, tipAngle: 0, flutes: 4, wear: 0 },
  { number: 8, name: 'Chamfer mill Ø12 × 90°', type: 'chamfer', diameter: 12, fluteLength: 8, length: 88, cornerRadius: 0, tipAngle: 90, flutes: 4, wear: 0 },
];

export const DEFAULT_STOCK = { x: 120, y: 80, z: 30, material: 'aluminium', protrusion: 14, zero: 'top-center' };

// Z-map resolution presets (target cell size in mm, capped by node count) and arc chord tolerances.
export const ACCURACY = {
  fast: { label: 'Fast', cell: 0.6, maxNodes: 90000, arcTol: 0.03 },
  balanced: { label: 'Balanced', cell: 0.35, maxNodes: 200000, arcTol: 0.01 },
  fine: { label: 'Fine', cell: 0.22, maxNodes: 420000, arcTol: 0.005 },
  ultra: { label: 'Ultra', cell: 0.15, maxNodes: 800000, arcTol: 0.002 },
};

export const DEFAULT_SETTINGS = {
  requireG43: true, // Fanuc/Haas behaviour: tool length offset only applies after G43 H_
  optionalStop: true,
  blockDelete: false,
  doorInterlock: true,
  accuracy: 'balanced',
  volume: 0.7,
  muted: false,
  showToolpath: true,
  showChips: true,
  showCoolant: true,
  defaultUnits: 21,
  dialect: 'siemens', // default program dialect of the 808D-style control
  jogFeed: 1500,
  jogRpm: 1000,
  dryFeed: 2000,
  spLimit: 12000,
  freshBlank: true,
  wal: { on: false, x: [-560, 0], y: [-410, 0], z: [-410, 0] },
};

// Vise used to hold the stock. Positions are in the table frame.
export const VISE = {
  bodyWidth: 170, // along X
  bodyLength: 420, // along Y
  floor: 72, // height of the jaw seat / slide above the table
  jawHeight: 46,
  jawThickness: 42,
  jawWidth: 170,
  maxOpening: 210,
};

// Umbrella tool changer timing (seconds). Shared by the interpreter (cycle time estimate) and the
// controller (the actual animation), so the estimate matches what you see.
export const ATC = {
  orient: 0.35, slideIn: 0.85, unclamp: 0.25, lift: 0.6, perPocket: 0.11, indexSettle: 0.2,
  lower: 0.6, clamp: 0.25, slideOut: 0.85,
};

export function pocketSteps(a, b, pockets = MACHINE.atcPockets) {
  const d = Math.abs(a - b) % pockets;
  return Math.min(d, pockets - d);
}

// Time for the carousel part of a tool change (excludes spindle stop and the Z retract, which are
// simulated as a normal spindle ramp and rapid). `carousel` is the pocket currently facing the spindle.
export function atcTime(from, to, carousel) {
  const per = ATC.perPocket;
  let t = ATC.orient;
  let at = carousel;
  if (from) {
    const s = pocketSteps(at, from);
    t += s * per + (s ? ATC.indexSettle : 0) + ATC.slideIn + ATC.unclamp + ATC.lift;
    at = from;
  } else {
    t += ATC.lift + ATC.slideIn;
  }
  if (to) {
    const s = pocketSteps(at, to);
    t += s * per + (s ? ATC.indexSettle : 0) + ATC.lower + ATC.clamp;
  }
  t += ATC.slideOut;
  if (!to) t += ATC.lower;
  return t;
}

// Trapezoidal-velocity move time (s) for length L (mm), max speed v (mm/s) and acceleration a (mm/s^2).
export function trapTime(L, v, a) {
  if (L <= 0) return 0;
  const sAcc = (v * v) / (2 * a);
  if (L < 2 * sAcc) return 2 * Math.sqrt(L / a);
  return L / v + v / a;
}
