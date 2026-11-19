// Haas mill (NGC) dialect. Compiles a Haas program into the same timed ops as the ISO and 808D
// interpreters, so the controller, Z-map, toolpath and collision checks are shared.
//
// Execution model: like the 808D dialect this is a program-counter executor (macros, GOTO, WHILE/DO,
// M97/M98/G65 calls and M99 returns are executed at compile time). Path buffering for cutter
// compensation (G41/G42) reuses the 808D machinery (siemens.js + crc.js).
//
// Coordinate pipeline (all internal values in mm):
//   P = program coordinates as written (G90/G91, G20/G21 converted to mm)
//   Q = mirror (G101) then scaling (G51) of P            <- cutter compensation works here (this.pp)
//   M = rotation (G68 about its centre) of Q + G52/G92 shift + work offset (+ tool length on Z)
//
// Alarm numbers: the ones verified in the dialect research are 304, 306, 314, 332, 370 and 1000+n
// (#3000). The others come from the Haas alarm list 96-0284 (classic wording) and are marked in
// HAAS_ALARMS; correct them in one place if a newer list differs.
import { GError, PLANES } from './interpreter.js';
import { SiemensInterpreter } from './siemens.js';
import { CompError } from './crc.js';
import { cannedHole, cycleNeeds, boltPattern, circPocket, generalPocket } from './haascycles.js';
import { MACHINE, INCH, atcTime, trapTime } from '../config.js';

const D2R = Math.PI / 180;

// ------------------------------------------------------------------------------------------ alarms
export const HAAS_ALARMS = {
  302: 'INVALID R IN G02 OR G03', 303: 'INVALID X, Y OR Z IN G02 OR G03', 304: 'INVALID I, J, OR K IN G02 OR G03',
  305: 'INVALID Q IN CANNED CYCLE', 306: 'INVALID I, J, K, OR Q IN CANNED CYCLE', 307: 'SUBROUTINE NESTING TOO DEEP',
  311: 'UNKNOWN CODE', 312: 'PROGRAM END', 314: 'SUBPROGRAM NOT IN MEMORY', 315: 'INVALID P CODE IN M98, M97, M96, G47 OR G65',
  316: 'X OVER TRAVEL RANGE', 317: 'Y OVER TRAVEL RANGE', 318: 'Z OVER TRAVEL RANGE', 320: 'NO FEED RATE',
  322: 'SUB PROG WITHOUT M99', 324: 'DELAY TIME RANGE ERROR', 326: 'G04 WITHOUT P CODE', 329: 'UNDEFINED M CODE',
  331: 'RANGE ERROR', 332: 'H AND T NOT MATCHED', 336: 'A AXIS DISABLED', 337: 'GOTO OR P LINE NOT FOUND',
  339: 'MULTIPLE CODES', 340: 'CUTTER COMP BEGIN WITH G02 OR G03', 341: 'CUTTER COMP END WITH G02 OR G03',
  342: 'CUTTER COMP PATH TOO SMALL', 349: 'PROG STOP WITHOUT CANCELING CUTTER COMP', 350: 'CUTTER COMP LOOK AHEAD ERROR',
  367: 'CUTTER COMP INTERFERENCE', 370: 'POCKET DEFINITION ERROR', 372: 'TOOL CHANGE IN CANNED CYCLE',
  385: 'INVALID L, P, OR R CODE IN G10', 386: 'INVALID ADDRESS FORMAT', 391: 'FEATURE DISABLED',
  393: 'INVALID MOTION IN G74 OR G84',
  508: 'DIVISION BY ZERO', 509: 'ILLEGAL MACRO VARIABLE USE', 510: 'ILLEGAL OPERATOR OR FUNCTION USE',
  516: 'ILLEGAL CONDITIONAL OR NO THEN', 521: 'ILLEGAL FUNCTIONAL PARAMETER', 524: 'END FOUND WITH NO MATCHING DO',
  529: 'ILLEGAL G65 PARAMETER', 531: 'MACRO NESTING TOO DEEP', 532: 'UNKNOWN CODE IN POCKET PATTERN',
  538: 'MATCHING END NOT FOUND', 539: 'ILLEGAL GOTO',
};
export const HAAS_ALARMS_VERIFIED = new Set([304, 306, 314, 332, 370]);

export class HaasAlarm extends GError {
  constructor(num, detail, word, text) {
    const t = text || HAAS_ALARMS[num] || '';
    super(`Alarm ${num} ${t}${detail ? ' - ' + detail : ''}`, word);
    this.alarm = num;
  }
}
const A = (num, detail, word) => new HaasAlarm(num, detail, word);

class PErr extends Error {
  constructor(col, len, msg) {
    super(msg);
    this.col = col;
    this.len = len;
  }
}

// ------------------------------------------------------------------------------------------ settings
// Subset of the Haas settings used by the dialect. Lengths (22, 52) are in inches like on the control.
export const HAAS_SETTINGS = {
  9: null, // Dimensioning: 'INCH' | 'MM' | null (null = the app's default units)
  15: false, // H & T code agreement (alarm 332)
  22: 0.05, // Can cycle delta Z (G73 chip-break retract, G83 re-entry clearance), inch
  27: 'X+', // G76/G77 shift direction
  28: true, // Can cycle act without X/Y
  52: 0, // G83 retract above R, inch
  71: 1, // Default G51 scaling
  72: 0, // Default G68 rotation
  73: false, // G68 incremental angle
  77: false, // Scale integer F (OFF: F12 = 0.0012)
};

// ------------------------------------------------------------------------------------------ reference
// [group, name, description]. Group 'opt' = option not installed (alarm 391 with the reason).
export const HAAS_G = {
  0: ['motion', 'Rapid motion', 'Positions at rapid. Cancels a canned cycle.'],
  1: ['motion', 'Linear interpolation', 'Straight cut at feed F. Cancels a canned cycle.'],
  2: ['motion', 'Circular interpolation CW', 'Arc in the active plane: end point + I/J/K (incremental from the start) or R (negative R = more than 180°). I/J alone = full circle. A third axis makes a helix.'],
  3: ['motion', 'Circular interpolation CCW', 'Same words as G02.'],
  4: ['nm', 'Dwell', 'G04 P: with a decimal point seconds (P1.5), without milliseconds (P1500).'],
  9: ['nm', 'Exact stop', 'Exact stop for this block (accepted; the path is always followed exactly).'],
  10: ['nm', 'Set offsets', 'G10 L2 P0-P6 (G52, G54-G59), L20 P1-P99 (G154), L10/L11 length geometry/wear, L12/L13 diameter geometry/wear (value in R). G90 sets, G91 adds.'],
  12: ['nm', 'Circular pocket CW', 'G12 X Y Z I K Q L D F: spiral circular pocket, climb with M04 / conventional with M03 (comp G42).'],
  13: ['nm', 'Circular pocket CCW', 'G13 X Y Z I K Q L D F: I first radius, K finish radius, Q step, D cutter comp register, L passes with G91 Z.'],
  17: ['plane', 'XY plane', 'Arcs with I/J. Default.'], 18: ['plane', 'ZX plane', 'Arcs with I/K.'], 19: ['plane', 'YZ plane', 'Arcs with J/K.'],
  20: ['units', 'Inch', 'Inch programming (4 decimals; X1 = 0.0001 in without a decimal point).'],
  21: ['units', 'Metric', 'Metric programming (3 decimals; X1 = 0.001 mm without a decimal point).'],
  28: ['nm', 'Return to machine zero', 'Rapid through the X/Y/Z intermediate point to machine zero of those axes (all axes if none). G91 G28 Z0 sends Z straight home.'],
  29: ['nm', 'Return from reference', 'From machine zero through the G28 intermediate point to X/Y/Z.'],
  31: ['opt', 'Feed until skip', 'Needs a probe (WIPS) option.'],
  35: ['opt', 'Tool diameter measurement', 'Needs a probe option.'], 36: ['opt', 'Work offset measurement', 'Needs a probe option.'],
  37: ['opt', 'Tool length measurement', 'Needs a probe option.'],
  40: ['crc', 'Cutter comp cancel', 'The G40 block move is the exit move.'],
  41: ['crc', 'Cutter comp left', 'G41 D: tool left of the path (climb milling with M03). Turn on with a G00/G01 X/Y move.'],
  42: ['crc', 'Cutter comp right', 'G42 D: tool right of the path.'],
  43: ['tlo', 'Tool length comp +', 'G43 H: adds the length geometry + wear of offset H. After M06 the H follows the new tool.'],
  44: ['tlo', 'Tool length comp -', 'Subtracts offset H.'], 49: ['tlo', 'Tool length comp cancel', 'Also H00.'],
  47: ['opt', 'Text engraving', 'G47 engraving is not available in this simulator.'],
  50: ['scale', 'Scaling cancel', ''], 51: ['scale', 'Scaling', 'G51 X Y Z P: scale by P about X/Y/Z (default part zero, P default Setting 71).'],
  52: ['nm', 'Set local (G52) shift', 'Adds X/Y/Z to every work offset. G52 X0 Y0 Z0 or M30 clears it.'],
  53: ['nm', 'Machine coordinates', 'One block in machine coordinates without work or tool length offset: G53 G49 Z0, G53 Y0.'],
  54: ['wcs', 'Work offset 1', ''], 55: ['wcs', 'Work offset 2', ''], 56: ['wcs', 'Work offset 3', ''],
  57: ['wcs', 'Work offset 4', ''], 58: ['wcs', 'Work offset 5', ''], 59: ['wcs', 'Work offset 6', ''],
  60: ['nm', 'Unidirectional positioning', 'Accepted; positioning is simulated without backlash.'],
  61: ['path', 'Exact stop modal', 'Accepted.'], 64: ['path', 'Exact stop cancel', 'Default. Accepted.'],
  65: ['nm', 'Macro call', 'G65 P<prog> L<n> A.. Z..: calls O<prog> with arguments in local variables #1-#33.'],
  68: ['rot', 'Rotation', 'G68 X Y R: rotate the coordinate system by R degrees (CCW) about X/Y (default: current position). G17 only in this simulator.'],
  69: ['rot', 'Rotation cancel', ''],
  70: ['nm', 'Bolt hole circle', 'G70 I<radius> J<start angle> L<holes> around the current position, using the active canned cycle.'],
  71: ['nm', 'Bolt hole arc', 'G71 I<radius> J<start angle> K<angle step> L<holes>.'],
  72: ['nm', 'Holes along an angle', 'G72 I<spacing> J<angle> L<holes>, first hole at the current position.'],
  73: ['cycle', 'High-speed peck drilling', 'Z R Q (or I J K) F P: pecks with a Setting 22 chip-break retract.'],
  74: ['cycle', 'Reverse tapping', 'Z R F (J retract multiple): spindle CCW in, CW out.'],
  76: ['cycle', 'Fine boring', 'Z R F P Q (or I J): bore, dwell, orient, shift, rapid out.'],
  77: ['cycle', 'Back boring', 'Z R F P Q (or I J): orient, shift, rapid below, bore up to Z.'],
  80: ['cycle', 'Canned cycle cancel', ''],
  81: ['cycle', 'Drilling', 'Z R F: rapid to R, feed to Z, rapid out.'], 82: ['cycle', 'Spot drilling', 'G81 with a dwell P at the bottom.'],
  83: ['cycle', 'Peck drilling', 'Z R Q (or I J K) F P: full retract to R after every peck.'],
  84: ['cycle', 'Tapping', 'Z R F (J retract multiple): spindle CW in, CCW out. F = rpm x pitch.'],
  85: ['cycle', 'Boring in / out', 'Feed in, feed out.'], 86: ['cycle', 'Bore and stop', 'Feed in, spindle stop, rapid out.'],
  87: ['opt', 'Bore in, manual retract', 'Not supported on the NGC control.'], 88: ['opt', 'Bore, dwell, manual retract', 'Not supported on the NGC control.'],
  89: ['cycle', 'Bore in, dwell, bore out', 'Feed in, dwell P, feed out.'],
  90: ['dist', 'Absolute', ''], 91: ['dist', 'Incremental', ''],
  92: ['nm', 'Set work coordinate shift', 'G92 X Y Z: the current position becomes X/Y/Z (no motion).'],
  93: ['feedmode', 'Inverse time feed', 'F = 1 / time in minutes for each G01/G02/G03 block.'],
  94: ['feedmode', 'Feed per minute', 'Default.'], 95: ['feedmode', 'Feed per revolution', 'F in units per spindle revolution.'],
  98: ['retract', 'Canned cycle initial point return', 'Default.'], 99: ['retract', 'Canned cycle R plane return', ''],
  100: ['nm', 'Mirror image cancel', ''], 101: ['nm', 'Mirror image', 'G101 X<pivot> Y<pivot>: mirrors the named axes (reverses arcs and cutter comp).'],
  102: ['nm', 'Programmable output to RS-232', 'Accepted, no effect.'],
  103: ['nm', 'Limit block buffering', 'G103 P<n>. Accepted (no effect on the path).'],
  107: ['opt', 'Cylindrical mapping', 'Needs a rotary axis.'],
  136: ['opt', 'Automatic work offset center', 'Needs a probe option.'],
  141: ['opt', '3D+ cutter comp', '5-axis option.'], 143: ['opt', '5-axis tool length comp', '5-axis option.'],
  150: ['nm', 'General purpose pocket', 'G150 P<sub> I|J K G41|G42 D Z R Q F (X Y): zig-zag roughing at I/J step-over, finish pass at full depth along the subprogram outline.'],
  154: ['wcs', 'Additional work offsets', 'G154 P1-P99.'],
  156: ['opt', 'Broaching cycle', 'Not available.'], 167: ['nm', 'Modify setting', 'Accepted, no effect.'],
  174: ['opt', 'Non-vertical rigid tap CCW', 'Not available.'], 184: ['opt', 'Non-vertical rigid tap CW', 'Not available.'],
  187: ['nm', 'Smoothness / accuracy', 'G187 P1-P3 E: accepted (affects only the corner rounding on a real machine).'],
  234: ['opt', 'TCPC', '5-axis option.'], 253: ['opt', 'Orient spindle normal to feature', '5-axis option.'],
  254: ['opt', 'Dynamic work offset', '5-axis option.'], 255: ['opt', 'Dynamic work offset cancel', '5-axis option.'],
  266: ['opt', 'Visible axes linear rapid', 'Not available.'], 268: ['opt', 'Feature coordinate system', 'Not available.'],
  269: ['opt', 'Feature coordinate system cancel', 'Not available.'],
};
for (let g = 110; g <= 129; g++) HAAS_G[g] = ['wcs', `Work offset ${g - 103}`, `Same as G154 P${g - 109}.`];

// M codes: description; opt = alarm 391 text.
export const HAAS_M = {
  0: 'Program stop (Cycle Start continues)', 1: 'Optional stop (only with OPTION STOP on)', 2: 'Program end', 3: 'Spindle CW at S', 4: 'Spindle CCW at S',
  5: 'Spindle stop', 6: 'Tool change to the T selected (spindle and coolant stop, Z to tool change position)', 7: 'Shower coolant on', 8: 'Coolant on', 9: 'Coolant off',
  10: 'Engage 4th axis brake (no rotary: no effect)', 11: 'Release 4th axis brake (no rotary: no effect)', 12: 'Engage 5th axis brake', 13: 'Release 5th axis brake',
  16: 'Tool change (same as M06)', 19: 'Orient spindle (P angle / R angle); stops the spindle', 21: 'Optional user M function with M-Fin', 22: 'Optional user M', 23: 'Optional user M', 24: 'Optional user M', 25: 'Optional user M',
  29: 'Set output relay with M-Fin', 30: 'Program end and reset', 31: 'Chip conveyor forward', 33: 'Chip conveyor stop', 34: 'Coolant spigot increment', 35: 'Coolant spigot decrement',
  36: 'Pallet part ready', 39: 'Rotate tool turret', 41: 'Low gear override (no gearbox: no effect)', 42: 'High gear override (no gearbox: no effect)',
  46: 'Jump if pallet loaded (no pallet changer: no effect)', 48: 'Check validity of program for pallet', 50: 'Execute pallet change',
  51: 'Set optional user M relay', 52: 'Set user relay', 53: 'Set user relay', 54: 'Set user relay', 55: 'Set user relay', 59: 'Set output relay P',
  61: 'Clear optional user M relay', 62: 'Clear user relay', 63: 'Clear user relay', 64: 'Clear user relay', 65: 'Clear user relay', 69: 'Clear output relay P',
  70: 'Workholding clamp', 71: 'Workholding unclamp', 73: 'Tool air blast on', 74: 'Tool air blast off', 75: 'Set G35/G136 reference point',
  76: 'Control display inactive', 77: 'Control display active', 78: 'Alarm if skip signal found', 79: 'Alarm if skip signal not found',
  80: 'Auto door open', 81: 'Auto door close', 82: 'Tool unclamp', 83: 'Auto air gun on', 84: 'Auto air gun off', 86: 'Tool clamp',
  88: 'Through-spindle coolant on', 89: 'Through-spindle coolant off', 90: 'Fixture clamp input on', 91: 'Fixture clamp input off', 95: 'Sleep mode',
  96: 'Jump if no input: M96 P<N line> Q<input> (inputs read 0 in the simulator)', 97: 'Local subprogram call: M97 P<N line> L<repeats>',
  98: 'Subprogram call: M98 P<program> L<repeats>', 99: 'Subprogram return or loop (M99 P<N line> returns to that line)',
  104: 'Probe arm extend', 105: 'Probe arm retract', 109: 'Interactive user input (not available in the simulator)', 116: 'Pallet', 117: 'Pallet',
  130: 'Display media', 131: 'Cancel display media', 138: 'Spindle speed variation on', 139: 'Spindle speed variation off',
  158: 'Mist condenser on', 159: 'Mist condenser off', 160: 'Optional', 161: 'Optional', 162: 'Optional', 163: 'Optional',
  180: 'Auto window open', 181: 'Auto window close', 199: 'Pallet/part load', 300: 'APL/robot custom sequence',
};

export const HAAS_WORDS = {
  'O': 'Program number O00000-O99999 with the name in parentheses on the same line.',
  'N': 'Sequence number; jump target for M97, M99 P, GOTO.',
  'X Y Z': 'Axis positions. Without a decimal point the last digit is 0.0001 in / 0.001 mm (X1. = 1 unit, X1 = 0.001 mm).',
  'I J K': 'Arc centre offsets from the start point; canned cycle peck values; G12/G13/G150/G70-G72 parameters.',
  'R': 'Arc radius, canned cycle R plane, G68 angle, G10 offset value.',
  'F': 'Feed. Without a decimal point scaled like an axis value unless Setting 77 is on.',
  'S': 'Spindle rpm (clamped to the machine maximum).', 'T': 'Tool select (Tnn M06).',
  'H': 'Tool length offset register (G43/G44).', 'D': 'Cutter comp register (G41/G42, G12/G13, G150).',
  'P': 'Dwell, program / line number, offset number.', 'Q': 'Peck depth, G150 depth per pass, G12/G13 step.', 'L': 'Repeat count, G10 offset type, holes in G70-G72.',
  'E': 'Chip-clean rpm / G187 corner rounding (accepted).',
  '#n': 'Macro variables: #1-#33 local (G65 arguments), #100-#199 and #500-#999 global, system variables (#2001.. offsets, #3000 alarm, #3006 stop, #4001.. modal, #5021.. position, #5221.. work offsets).',
  '[ ]': 'Expressions: + - * / MOD AND OR XOR, EQ NE GT LT GE LE, SIN COS TAN ASIN ACOS ATAN ATAN[a]/[b] SQRT ABS ROUND FIX FUP LN EXP.',
  'IF [ ] GOTO n / THEN': 'Conditional jump or assignment.', 'WHILE [ ] DOn ... ENDn': 'Loop (n = 1..3).', 'GOTO n': 'Jump to block N n.',
};

const FUNCS = {
  SIN: (a) => Math.sin(a * D2R), COS: (a) => Math.cos(a * D2R), TAN: (a) => Math.tan(a * D2R),
  ASIN: (a) => Math.asin(a) / D2R, ACOS: (a) => Math.acos(a) / D2R, ATAN: (a) => Math.atan(a) / D2R,
  SQRT: (a) => {
    if (a < 0) throw A(521, `SQRT[${a}]`);
    return Math.sqrt(a);
  },
  ABS: Math.abs, ROUND: (a) => Math.sign(a) * Math.round(Math.abs(a)), FIX: Math.floor, FUP: Math.ceil,
  LN: (a) => {
    if (a <= 0) throw A(521, `LN[${a}]`);
    return Math.log(a);
  },
  EXP: Math.exp,
  BIN: (a) => {
    let s = 0, m = 1;
    for (let v = Math.trunc(a); v > 0; v >>= 4) { s += (v & 15) * m; m *= 10; }
    return s;
  },
  BCD: (a) => {
    let s = 0, sh = 0;
    for (let v = Math.trunc(a); v > 0; v = Math.trunc(v / 10)) { s += (v % 10) << sh; sh += 4; }
    return s;
  },
};
const FUNC_NAMES = Object.keys(FUNCS).sort((a, b) => b.length - a.length);

// ------------------------------------------------------------------------------------------ lexer
function lexLine(raw) {
  const blocks = [];
  const nb = () => ({ chars: [], cols: [], comment: '', errors: [], dprnt: [] });
  let cur = nb();
  const n = raw.length;
  for (let i = 0; i < n; i++) {
    const ch = raw[i];
    if (ch === '(') {
      const e = raw.indexOf(')', i + 1);
      if (e < 0) {
        cur.errors.push({ col: i, len: n - i, msg: 'Alarm 386 INVALID ADDRESS FORMAT - comment is missing its closing ")"' });
        cur.comment += (cur.comment ? ' ' : '') + raw.slice(i + 1).trim();
        break;
      }
      cur.comment += (cur.comment ? ' ' : '') + raw.slice(i + 1, e).trim();
      i = e;
      continue;
    }
    if (ch === ';') {
      blocks.push(cur);
      cur = nb();
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') continue;
    if ((ch === 'D' || ch === 'd') && /^DPRNT\s*\[/i.test(raw.slice(i, i + 12))) {
      const b = raw.indexOf('[', i);
      let d = 0, j = b;
      for (; j < n; j++) {
        if (raw[j] === '[') d++;
        else if (raw[j] === ']' && --d === 0) break;
      }
      if (j >= n) {
        cur.errors.push({ col: i, len: n - i, msg: 'Alarm 386 INVALID ADDRESS FORMAT - DPRNT[ is missing its "]"' });
        break;
      }
      cur.chars.push('\u0001');
      cur.cols.push(i);
      cur.dprnt.push(raw.slice(b + 1, j));
      i = j;
      continue;
    }
    cur.chars.push(ch.toUpperCase());
    cur.cols.push(i);
  }
  blocks.push(cur);
  return blocks;
}

// ------------------------------------------------------------------------------------------ parser
class BlockParser {
  constructor(lb) {
    this.s = lb.chars.join('');
    this.cols = lb.cols;
    this.dprnt = lb.dprnt;
    this.i = 0;
  }
  col(i) {
    if (!this.cols.length) return 0;
    return this.cols[Math.max(0, Math.min(i, this.cols.length - 1))];
  }
  err(msg, s = this.i, e = s + 1) {
    const c0 = this.col(s);
    throw new PErr(c0, Math.max(1, this.col(Math.max(s, e - 1)) - c0 + 1), msg);
  }
  at(w) {
    return this.s.startsWith(w, this.i);
  }
  expect(c, what) {
    if (this.s[this.i] !== c) this.err(`Alarm 386 INVALID ADDRESS FORMAT - "${c}" expected${what ? ' ' + what : ''}`);
    this.i++;
  }
  isDigit(c) {
    return c >= '0' && c <= '9';
  }
  number() {
    const m = /^(\d+\.?\d*|\.\d+)/.exec(this.s.slice(this.i));
    if (!m) return null;
    this.i += m[0].length;
    return { v: parseFloat(m[0]), dec: m[0].includes('.') };
  }
  varRef() {
    const s0 = this.i;
    this.expect('#');
    if (this.s[this.i] === '[') {
      this.i++;
      const e = this.expr();
      this.expect(']', 'to close the variable number');
      return { k: 'var', e };
    }
    if (this.s[this.i] === '#') return { k: 'var', e: this.varRef() };
    const m = /^\d+/.exec(this.s.slice(this.i));
    if (!m) this.err('Alarm 509 ILLEGAL MACRO VARIABLE USE - # needs a variable number', s0);
    this.i += m[0].length;
    return { k: 'var', n: +m[0] };
  }
  expr() {
    let a = this.add();
    for (const op of ['EQ', 'NE', 'GT', 'LT', 'GE', 'LE']) {
      if (this.at(op)) {
        this.i += 2;
        const b = this.add();
        a = { k: 'bin', op, a, b };
        break;
      }
    }
    return a;
  }
  add() {
    let a = this.mul();
    for (;;) {
      const c = this.s[this.i];
      let op = null;
      if (c === '+' || c === '-') { op = c; this.i++; }
      else if (this.at('XOR')) { op = 'XOR'; this.i += 3; }
      else if (this.at('OR')) { op = 'OR'; this.i += 2; }
      else break;
      a = { k: 'bin', op, a, b: this.mul() };
    }
    return a;
  }
  mul() {
    let a = this.unary();
    for (;;) {
      const c = this.s[this.i];
      let op = null;
      if (c === '*' || c === '/') { op = c; this.i++; }
      else if (this.at('AND')) { op = 'AND'; this.i += 3; }
      else if (this.at('MOD')) { op = 'MOD'; this.i += 3; }
      else break;
      a = { k: 'bin', op, a, b: this.unary() };
    }
    return a;
  }
  unary() {
    const c = this.s[this.i];
    if (c === '-') { this.i++; return { k: 'neg', a: this.unary() }; }
    if (c === '+') { this.i++; return this.unary(); }
    return this.primary();
  }
  primary() {
    const c = this.s[this.i];
    if (c === undefined) this.err('Alarm 386 INVALID ADDRESS FORMAT - expression is incomplete', this.i - 1);
    if (this.isDigit(c) || c === '.') {
      const nm = this.number();
      if (!nm) this.err('Alarm 386 INVALID ADDRESS FORMAT - bad number');
      return { k: 'num', v: nm.v };
    }
    if (c === '#') return this.varRef();
    if (c === '[') {
      this.i++;
      const e = this.expr();
      this.expect(']', 'to close the bracket');
      return e;
    }
    for (const f of FUNC_NAMES) {
      if (this.at(f + '[')) {
        this.i += f.length + 1;
        const a = this.expr();
        this.expect(']', `to close ${f}[`);
        if (f === 'ATAN' && this.s[this.i] === '/' && this.s[this.i + 1] === '[') {
          this.i += 2;
          const b = this.expr();
          this.expect(']', 'to close ATAN[..]/[..]');
          return { k: 'fn', f: 'ATAN2', a, b };
        }
        return { k: 'fn', f, a };
      }
    }
    this.err(`Alarm 510 ILLEGAL OPERATOR OR FUNCTION USE - unexpected "${c}" in expression`);
  }
  // Address value: number, #var, [expr], optionally signed.
  value(letter, s0) {
    let neg = false;
    const c0 = this.s[this.i];
    if (c0 === '-' || c0 === '+') { neg = c0 === '-'; this.i++; }
    const c = this.s[this.i];
    if (c !== undefined && (this.isDigit(c) || c === '.')) {
      const nm = this.number();
      if (!nm) this.err(`Alarm 386 INVALID ADDRESS FORMAT - bad number after ${letter}`, s0);
      return { kind: 'num', v: neg ? -nm.v : nm.v, dec: nm.dec };
    }
    if (c === '#' || c === '[') {
      let node = c === '#' ? this.varRef() : (this.i++, (() => { const e = this.expr(); this.expect(']', 'to close the bracket'); return e; })());
      if (neg) node = { k: 'neg', a: node };
      return { kind: 'expr', node };
    }
    this.err(`Alarm 386 INVALID ADDRESS FORMAT - address ${letter} has no value`, s0, this.i);
  }
  assign() {
    const s0 = this.i;
    const lhs = this.varRef();
    if (this.s[this.i] !== '=') this.err('Alarm 386 INVALID ADDRESS FORMAT - "=" expected after the macro variable', s0, this.i);
    this.i++;
    const rhs = this.expr();
    return { t: 'assign', lhs, rhs, col: this.col(s0), len: Math.max(1, this.col(this.i - 1) - this.col(s0) + 1) };
  }
  parse() {
    const items = [];
    const s = this.s;
    while (this.i < s.length) {
      const s0 = this.i;
      const c = s[this.i];
      const mk = (o) => ({ ...o, col: this.col(s0), len: Math.max(1, this.col(this.i - 1) - this.col(s0) + 1) });
      if (c === '\u0001') {
        this.i++;
        items.push(mk({ t: 'dprnt', text: this.dprnt.shift() }));
        continue;
      }
      if (c === '#') {
        items.push(this.assign());
        continue;
      }
      if (c >= 'A' && c <= 'Z') {
        if (this.at('IF[')) {
          this.i += 3;
          const cond = this.expr();
          this.expect(']', 'to close IF [');
          if (this.at('GOTO')) {
            this.i += 4;
            const target = this.value('GOTO', s0);
            items.push(mk({ t: 'if', cond, target }));
          } else if (this.at('THEN')) {
            this.i += 4;
            if (s[this.i] !== '#') this.err('Alarm 516 ILLEGAL CONDITIONAL OR NO THEN - THEN must be followed by an assignment #n = ...');
            const then = this.assign();
            items.push(mk({ t: 'if', cond, then }));
          } else this.err('Alarm 516 ILLEGAL CONDITIONAL OR NO THEN - IF [..] needs GOTO n or THEN #n=..', s0, this.i);
          continue;
        }
        if (this.at('GOTO')) {
          this.i += 4;
          items.push(mk({ t: 'goto', target: this.value('GOTO', s0) }));
          continue;
        }
        if (this.at('WHILE[')) {
          this.i += 6;
          const cond = this.expr();
          this.expect(']', 'to close WHILE [');
          if (!this.at('DO')) this.err('Alarm 386 INVALID ADDRESS FORMAT - WHILE [..] needs DOn');
          this.i += 2;
          const m = /^\d+/.exec(s.slice(this.i));
          if (!m) this.err('Alarm 386 INVALID ADDRESS FORMAT - DO needs a loop number 1..3');
          this.i += m[0].length;
          items.push(mk({ t: 'while', cond, d: +m[0] }));
          continue;
        }
        if ((this.at('END') && this.isDigit(s[this.i + 3] || '')) || (this.at('DO') && this.isDigit(s[this.i + 2] || ''))) {
          const end = this.at('END');
          this.i += end ? 3 : 2;
          const m = /^\d+/.exec(s.slice(this.i));
          this.i += m[0].length;
          items.push(mk({ t: end ? 'end' : 'do', d: +m[0] }));
          continue;
        }
        if (this.at('POPEN') || this.at('PCLOS')) {
          this.i += 5;
          items.push(mk({ t: 'kw' }));
          continue;
        }
        this.i++;
        const v = this.value(c, s0);
        items.push(mk({ t: 'word', a: c, ...v }));
        continue;
      }
      this.err(`Alarm 386 INVALID ADDRESS FORMAT - unexpected "${c}"`);
    }
    return items;
  }
}

function parseBlock(lb, line) {
  const blk = { line, items: [], n: null, o: null, oName: '', percent: false, blockDelete: false, comment: lb.comment, errors: [...lb.errors], empty: true };
  if (lb.chars[0] === '/') {
    blk.blockDelete = true;
    lb.chars.shift();
    lb.cols.shift();
  }
  if (lb.chars.length === 1 && lb.chars[0] === '%') {
    blk.percent = true;
    return blk;
  }
  const pi = lb.chars.indexOf('%');
  if (pi >= 0) {
    blk.errors.push({ col: lb.cols[pi], len: 1, msg: 'Alarm 386 INVALID ADDRESS FORMAT - "%" must be on a line of its own' });
    return blk;
  }
  if (!lb.chars.length) return blk;
  try {
    blk.items = new BlockParser(lb).parse();
  } catch (e) {
    if (!(e instanceof PErr)) throw e;
    blk.errors.push({ col: e.col, len: e.len, msg: e.message });
    return blk;
  }
  for (const it of blk.items) {
    if (it.t !== 'word') continue;
    if (it.a === 'N' || it.a === 'O') {
      if (it.kind !== 'num' || it.v % 1 || it.v < 0 || it.v > 99999) {
        blk.errors.push({ col: it.col, len: it.len, msg: `Alarm 386 INVALID ADDRESS FORMAT - ${it.a} must be a whole number 0-99999 (no variables)` });
        continue;
      }
      if (it.a === 'N' && blk.n == null) blk.n = it.v;
      if (it.a === 'O') {
        blk.o = it.v;
        blk.oName = lb.comment;
      }
    }
  }
  blk.empty = !blk.items.some((it) => !(it.t === 'word' && (it.a === 'N' || it.a === 'O')));
  return blk;
}

// Parses a whole program text into blocks plus N / O indexes and WHILE/END pairs.
export function parseHaasProgram(text, label = '') {
  const lines = String(text).split(/\r?\n/);
  const blocks = [];
  let started = false, closed = false;
  for (let li = 0; li < lines.length && !closed; li++) {
    for (const lb of lexLine(lines[li])) {
      const b = parseBlock(lb, li);
      if (b.percent) {
        if (started) { closed = true; break; }
        started = true;
        continue;
      }
      if (b.empty && !b.errors.length && b.o == null && b.n == null) continue;
      started = true;
      blocks.push(b);
    }
  }
  const nMap = new Map();
  const oMap = new Map();
  blocks.forEach((b, i) => {
    if (b.n != null && !nMap.has(b.n)) nMap.set(b.n, i);
    if (b.o != null && !oMap.has(b.o)) oMap.set(b.o, i);
  });
  // WHILE / DO / END pairing
  const loopEnd = new Map(), loopStart = new Map(), loopErr = new Map();
  const st = [];
  blocks.forEach((b, i) => {
    for (const it of b.items) {
      if (it.t === 'while' || it.t === 'do') {
        if (it.d < 1 || it.d > 3) loopErr.set(i, `DO${it.d}: loop numbers are 1, 2 and 3`);
        st.push({ d: it.d, i });
      } else if (it.t === 'end') {
        const top = st[st.length - 1];
        if (!top || top.d !== it.d) loopErr.set(i, `END${it.d} has no matching DO${it.d}`);
        else {
          st.pop();
          loopEnd.set(top.i, i);
          loopStart.set(i, top.i);
        }
      }
    }
  });
  const firstO = blocks.findIndex((b) => !b.empty || b.o != null);
  const oName = firstO >= 0 && blocks[firstO].o != null ? blocks[firstO].oName : '';
  return { blocks, nMap, oMap, loopEnd, loopStart, loopErr, lineCount: lines.length, label, oNum: firstO >= 0 ? blocks[firstO].o : null, oName };
}

// Builds a programLookup for compileProgram from a store with names()/get(name), e.g. the app's
// ProgramStore: matches file names like O01000.NC / O1000 / 1000.NC and, failing that, the O number on
// the first line of a program text.
export function makeProgramLookup(store) {
  return (num) => {
    const n = Number(num);
    const names = store.names ? store.names() : Object.keys(store);
    const get = (k) => (store.get ? store.get(k) : store[k]);
    for (const k of names) {
      const m = /^O?0*(\d+)(\.\w+)?$/i.exec(k.trim());
      if (m && +m[1] === n) return get(k);
    }
    for (const k of names) {
      const t = get(k);
      if (typeof t !== 'string') continue;
      const m = /^\s*%?\s*\n?\s*O0*(\d+)\b/i.exec(t.replace(/^\s*%\s*\r?\n/, ''));
      if (m && +m[1] === n) return t;
    }
    return null;
  };
}

// ------------------------------------------------------------------------------------------ modal state
export function haasDefault(units = 21) {
  return {
    dialect: 'haas', units, dist: 90, plane: 17, motion: 0, cycle: 80, retract: 98, wcs: 54, wcsName: 'G54',
    tlo: 49, tloH: 0, crc: 40, D: 0, path: 64, feedMode: 94, feed: 0, rpm: 0, spindleDir: 0, flood: false, mist: false,
    tool: 0, selT: null, scale: null, mirror: { x: null, y: null }, rot: null, g52: { x: 0, y: 0, z: 0 }, g92: { x: 0, y: 0, z: 0 },
    cyc: {}, cycInit: null,
  };
}
const H_KEYS = ['dialect', 'units', 'dist', 'plane', 'motion', 'cycle', 'retract', 'wcs', 'wcsName', 'tlo', 'tloH', 'crc', 'D', 'path', 'feedMode', 'feed', 'rpm', 'spindleDir', 'flood', 'mist', 'tool', 'selT', 'cycInit'];
const H_OBJ = ['scale', 'mirror', 'rot', 'g52', 'g92', 'cyc'];
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const g2 = (k) => 'G' + String(k).padStart(2, '0');
const m2 = (k) => 'M' + String(k).padStart(2, '0');

// ------------------------------------------------------------------------------------------ interpreter
export class HaasInterpreter extends SiemensInterpreter {
  set(n) {
    const o = this.opts.haasSettings;
    return o && o[n] !== undefined ? o[n] : HAAS_SETTINGS[n];
  }

  compile(text, init = {}) {
    const main = (this.main = parseHaasProgram(text, 'main'));
    main.isMain = true;
    const res = (this.res = {
      ops: [], errors: [], warnings: [], lineCount: main.lineCount, totalTime: 0, ended: false, dialect: 'haas',
      toolsUsed: new Set(), lineFirstOp: new Int32Array(main.lineCount).fill(-1), tipBounds: null, workBounds: null,
      feedLength: 0, rapidLength: 0, endState: null, messages: [], dprnt: [], toolOffsetWrites: [],
      programNumber: main.oNum, programName: main.oName,
    });
    const s9 = this.set(9);
    const units = s9 === 'INCH' ? 20 : s9 === 'MM' ? 21 : init.units || 21;
    const S = (this.S = haasDefault(units));
    if (init.modal && init.modal.dialect === 'haas') {
      for (const k of H_KEYS) if (init.modal[k] !== undefined) S[k] = init.modal[k];
      for (const k of H_OBJ) if (init.modal[k] !== undefined) S[k] = clone(init.modal[k]);
    }
    S.pos = { ...(init.pos || { x: 0, y: 0, z: 0 }) };
    S.tool = init.tool || 0;
    S.carousel = init.carousel || 1;
    S.rpmActual = init.rpm || 0;
    const offsets = (this.opts.offsets || []).map((o) => ({ ...o }));
    while (offsets.length < 6) offsets.push({ x: 0, y: 0, z: 0 });
    this.offsets = offsets;
    if (S.wcs - 54 >= offsets.length) { S.wcs = 54; S.wcsName = 'G54'; }
    this.vars = new Map();
    const iv = init.vars || this.opts.macroVars;
    if (iv) for (const [k, v] of iv instanceof Map ? iv : Object.entries(iv)) if (v != null && isFinite(v)) this.vars.set(+k, +v);
    this.locals = [new Array(34).fill(null)];
    this.toolOv = new Map();
    this.stack = [];
    this.progCache = new Map();
    this.ver = 0;
    this.stKey = '';
    this.st = null;
    this.buf = null;
    this.capture = null;
    this.g28Mid = null;
    this.feedWarned = false;
    for (const b of main.blocks) for (const e of b.errors) res.errors.push({ line: b.line, col: e.col, len: e.len, msg: e.msg, alarm: alarmOf(e.msg) });
    for (const [i, msg] of main.loopErr) {
      const b = main.blocks[i];
      res.errors.push({ line: b.line, col: 0, len: 0, msg: `Alarm 524 END FOUND WITH NO MATCHING DO - ${msg}`, alarm: 524 });
    }
    this.syncPP();
    this.snap();
    this.prog = main;
    this.seg = main.blocks.length && main.blocks[0].o != null ? 0 : -1;
    this.extLine = 0;
    this.line = 0;
    if (!res.errors.length) this.run();
    if (!res.errors.length && this.buf) {
      try {
        res.warnings.push({ line: this.line, msg: 'Cutter compensation still active at the end of the program (G40 missing)' });
        this.flush(false);
      } catch (e) {
        if (!(e instanceof CompError || e instanceof GError)) throw e;
        res.errors.push({ line: e.line ?? this.line, col: 0, len: 0, msg: this.compMsg(e), alarm: e.alarm ?? null });
      }
    }
    if (!res.ended && !res.errors.length && res.ops.length) res.warnings.push({ line: Math.max(0, this.line), msg: 'Program has no M30 / M02 end' });
    res.endState = this.exportModal();
    res.endPos = { ...S.pos };
    res.endTool = S.tool;
    res.endCarousel = S.carousel;
    res.offsets = offsets;
    const endVars = {};
    for (const [k, v] of this.vars) if (v != null && ((k >= 100 && k <= 199) || (k >= 500 && k <= 999))) endVars[k] = v;
    res.endVars = endVars;
    res.errors.sort((a, b) => a.line - b.line);
    return res;
  }

  run() {
    const res = this.res;
    let pc = 0;
    let executed = 0;
    const MAX = 400000;
    for (;;) {
      const prog = this.prog;
      if (pc >= prog.blocks.length) {
        if (this.stack.length) {
          this.line = this.dispLine(prog.blocks[prog.blocks.length - 1] || { line: 0 });
          this.pushErr(A(322, `${this.progLabel(prog)} ends without M99`), prog.blocks[prog.blocks.length - 1]);
        }
        return;
      }
      const blk = prog.blocks[pc];
      this.line = this.dispLine(blk);
      if (blk.errors.length) {
        if (!prog.isMain) this.pushErr(new GError(blk.errors[0].msg), blk);
        return;
      }
      if (blk.o != null && pc !== this.seg) {
        // the next program of the file starts here: this program has ended
        if (this.stack.length) this.pushErr(A(322, `${this.progLabel(prog)} reached O${blk.o} without M99`), blk);
        return;
      }
      if (blk.empty || (blk.blockDelete && this.opts.blockDelete)) { pc++; continue; }
      if (++executed > MAX) {
        res.errors.push({ line: this.line, col: 0, len: 0, msg: `Program loop: more than ${MAX} blocks executed. Check the GOTO / WHILE / M99 logic.`, alarm: null });
        return;
      }
      try {
        this.pc = pc;
        const next = this.hblock(blk, pc);
        if (res.ended) return;
        pc = next ?? pc + 1;
      } catch (e) {
        if (!(e instanceof GError || e instanceof CompError)) throw e;
        this.pushErr(e, blk);
        return;
      }
    }
  }

  progLabel(prog) {
    return prog.oNum != null ? `O${String(prog.oNum).padStart(5, '0')}` : prog.label || 'program';
  }

  dispLine(blk) {
    return this.prog.isMain ? blk.line : this.extLine;
  }

  compMsg(e) {
    if (!(e instanceof CompError)) return e.message;
    return /too large for the inside arc|too narrow/.test(e.message) ? `Alarm 342 CUTTER COMP PATH TOO SMALL - ${e.message}` : `Alarm 367 CUTTER COMP INTERFERENCE - ${e.message}`;
  }

  pushErr(e, blk) {
    let msg = this.compMsg(e);
    const ext = !this.prog.isMain;
    if (ext && blk) msg = `${this.progLabel(this.prog)} line ${blk.line + 1}: ${msg}`;
    const line = e instanceof CompError && e.line != null ? e.line : this.line;
    this.res.errors.push({ line, col: ext || e instanceof CompError ? 0 : e.col || 0, len: ext || e instanceof CompError ? 0 : e.len || 0, msg, alarm: e.alarm ?? alarmOf(msg) });
  }

  // ---------------------------------------------------------------- modal snapshot
  exportModal() {
    const S = this.S;
    const o = {};
    for (const k of H_KEYS) o[k] = S[k];
    for (const k of H_OBJ) o[k] = clone(S[k]);
    o.frame = this.frame();
    return o;
  }

  frame() {
    const S = this.S;
    const sx = S.g52.x + S.g92.x, sy = S.g52.y + S.g92.y, sz = S.g52.z + S.g92.z;
    if (!S.rot) return { tx: sx, ty: sy, tz: sz, rot: 0 };
    const a = S.rot.a * D2R, c = Math.cos(a), s = Math.sin(a);
    const { cx, cy } = S.rot;
    return { tx: sx + cx - (c * cx - s * cy), ty: sy + cy - (s * cx + c * cy), tz: sz, rot: S.rot.a };
  }

  bump() {
    this.ver++;
  }

  codes() {
    const S = this.S;
    return [g2(S.cycle !== 80 ? S.cycle : S.motion), g2(S.plane), g2(S.dist), g2(S.feedMode), g2(S.units), g2(S.crc), g2(S.tlo), g2(S.cycle), g2(S.retract),
      S.scale ? 'G51' : 'G50', S.wcsName, g2(S.path), S.rot ? 'G68' : 'G69', S.mirror.x != null || S.mirror.y != null ? 'G101' : 'G100'].join(' ');
  }

  snap() {
    const S = this.S;
    const tl = this.activeTLO();
    const key = H_KEYS.map((k) => S[k]).join('|') + `|${this.ver}|${tl}`;
    if (key !== this.stKey) {
      this.stKey = key;
      const st = this.exportModal();
      st.tloLen = tl;
      st.codes = this.codes();
      this.st = Object.freeze(st);
    }
    return this.st;
  }

  // ---------------------------------------------------------------- tool data (with G10 / #2001.. overrides)
  toolData(n) {
    const t = n ? this.opts.tools.get(n) : null;
    const ov = this.toolOv.get(n);
    if (!t && !ov) return null;
    return {
      length: ov?.length ?? t?.length ?? 0, dLength: ov?.dLength ?? t?.dLength ?? 0,
      diameter: ov?.diameter ?? t?.diameter ?? 0, dRadius: ov?.dRadius ?? t?.dRadius ?? 0,
    };
  }

  compLength(n) {
    const t = this.toolData(n);
    return t ? t.length + t.dLength : 0;
  }

  activeTLO() {
    const S = this.S;
    if (!this.opts.requireG43) return this.compLength(S.tool);
    if (S.tlo === 43) return this.compLength(S.tloH);
    if (S.tlo === 44) return -this.compLength(S.tloH);
    return 0;
  }

  dRadius(d) {
    const t = this.toolData(d);
    return t ? t.diameter / 2 + t.dRadius : 0;
  }

  compRadius() {
    return this.dRadius(this.S.D);
  }

  // ---------------------------------------------------------------- coordinates
  wcsOffset() {
    return this.offsets[this.S.wcs - 54] || { x: 0, y: 0, z: 0 };
  }

  toMachine(p) {
    const S = this.S;
    let x = p.x, y = p.y;
    if (S.rot) {
      const a = S.rot.a * D2R, c = Math.cos(a), s = Math.sin(a);
      const dx = x - S.rot.cx, dy = y - S.rot.cy;
      x = S.rot.cx + c * dx - s * dy;
      y = S.rot.cy + s * dx + c * dy;
    }
    const o = this.wcsOffset();
    return { x: x + S.g52.x + S.g92.x + o.x, y: y + S.g52.y + S.g92.y + o.y, z: p.z + S.g52.z + S.g92.z + o.z + this.activeTLO() };
  }

  toProgram(m) {
    const S = this.S;
    const o = this.wcsOffset();
    let x = m.x - o.x - S.g52.x - S.g92.x, y = m.y - o.y - S.g52.y - S.g92.y;
    if (S.rot) {
      const a = -S.rot.a * D2R, c = Math.cos(a), s = Math.sin(a);
      const dx = x - S.rot.cx, dy = y - S.rot.cy;
      x = S.rot.cx + c * dx - s * dy;
      y = S.rot.cy + s * dx + c * dy;
    }
    return { x, y, z: m.z - o.z - S.g52.z - S.g92.z - this.activeTLO() };
  }

  // P (program) -> Q (mirrored, scaled)
  toQ(p) {
    const S = this.S;
    let { x, y, z } = p;
    if (S.mirror.x != null) x = 2 * S.mirror.x - x;
    if (S.mirror.y != null) y = 2 * S.mirror.y - y;
    if (S.scale) {
      const { cx, cy, cz, k } = S.scale;
      x = cx + k * (x - cx);
      y = cy + k * (y - cy);
      z = cz + k * (z - cz);
    }
    return { x, y, z };
  }

  toP(q) {
    const S = this.S;
    let { x, y, z } = q;
    if (S.scale) {
      const { cx, cy, cz, k } = S.scale;
      x = cx + (x - cx) / k;
      y = cy + (y - cy) / k;
      z = cz + (z - cz) / k;
    }
    if (S.mirror.x != null) x = 2 * S.mirror.x - x;
    if (S.mirror.y != null) y = 2 * S.mirror.y - y;
    return { x, y, z };
  }

  curP() {
    return this.toP(this.pp);
  }

  mirrorFlip(plane = this.S.plane) {
    const pl = PLANES[plane];
    const m = this.S.mirror;
    let n = 0;
    if (m.x != null && (pl.a === 'x' || pl.b === 'x')) n++;
    if (m.y != null && (pl.a === 'y' || pl.b === 'y')) n++;
    return n % 2 === 1;
  }

  // ---------------------------------------------------------------- motion API (P space), used by the cycles
  pMove(rapid, p, feed = 0) {
    const P = { ...this.curP(), ...p };
    const Q = this.toQ(P);
    const c = this.pp;
    if (Math.hypot(Q.x - c.x, Q.y - c.y, Q.z - c.z) < 1e-9) return;
    this.progLine(rapid, Q, rapid ? 0 : Math.min(feed, MACHINE.maxFeed));
  }

  pArc(p, c, cw, feed) {
    const P = { ...this.curP(), ...p };
    const Q = this.toQ(P);
    const C = this.toQ({ x: c.x, y: c.y, z: P.z });
    this.progArc(Q, { x: C.x, y: C.y }, this.mirrorFlip(17) ? !cw : cw, 0, Math.min(feed, MACHINE.maxFeed));
  }

  dwell(sec) {
    if (sec > 0) this.emit({ t: 'dwell', sec, time: sec });
  }

  alarm(num, detail, word) {
    throw A(num, detail, word || this.curWord);
  }

  // Feed in mm/min for G94/G95 blocks.
  feedNow(word) {
    const S = this.S;
    if (!(S.feed > 0)) throw A(320, 'program F before the first G01/G02/G03 or canned cycle', word);
    if (S.feedMode === 95) {
      const rpm = Math.abs(S.rpmActual || 0);
      if (!(rpm > 0)) throw A(320, 'G95 feed per revolution needs a running spindle', word);
      return S.feed * rpm;
    }
    if (S.feedMode === 93) throw A(320, 'G93 inverse time feed needs F in every G01/G02/G03 block', word);
    return S.feed;
  }

  checkLimits(x, y, z) {
    const tr = this.opts.limits || MACHINE.travel;
    const v = { x, y, z };
    for (const [a, num] of [['x', 316], ['y', 317], ['z', 318]]) {
      const [lo, hi] = tr[a];
      if (v[a] < lo - 1e-6 || v[a] > hi + 1e-6) {
        throw A(num, `machine ${a.toUpperCase()}${v[a].toFixed(3)} mm is outside the ${a.toUpperCase()} travel (${lo} to ${hi}). Check the work offset${a === 'z' ? ', the tool length offset (G43 H)' : ''} and the programmed position.`);
      }
    }
  }

  // ---------------------------------------------------------------- macro variables
  evalE(n) {
    switch (n.k) {
      case 'num': return n.v;
      case 'var': return this.getVar(this.varNum(n));
      case 'neg': {
        const v = this.evalE(n.a);
        return v == null ? 0 : -v;
      }
      case 'fn': {
        const a = this.evalE(n.a) ?? 0;
        if (n.f === 'ATAN2') {
          const b = this.evalE(n.b) ?? 0;
          let d = Math.atan2(a, b) / D2R;
          if (d < 0) d += 360;
          return d;
        }
        if ((n.f === 'ASIN' || n.f === 'ACOS') && Math.abs(a) > 1) throw A(521, `${n.f}[${a}]`);
        return FUNCS[n.f](a);
      }
      case 'bin': {
        const a = this.evalE(n.a), b = this.evalE(n.b);
        const x = a ?? 0, y = b ?? 0;
        switch (n.op) {
          case '+': return x + y;
          case '-': return x - y;
          case '*': return x * y;
          case '/':
            if (y === 0) throw A(508);
            return x / y;
          case 'MOD':
            if (y === 0) throw A(508);
            return x - y * Math.trunc(x / y);
          case 'AND': return Math.trunc(x) & Math.trunc(y);
          case 'OR': return Math.trunc(x) | Math.trunc(y);
          case 'XOR': return Math.trunc(x) ^ Math.trunc(y);
          case 'EQ': return a == null || b == null ? (a == null && b == null ? 1 : 0) : x === y ? 1 : 0;
          case 'NE': return a == null || b == null ? (a == null && b == null ? 0 : 1) : x !== y ? 1 : 0;
          case 'GT': return x > y ? 1 : 0;
          case 'LT': return x < y ? 1 : 0;
          case 'GE': return x >= y ? 1 : 0;
          case 'LE': return x <= y ? 1 : 0;
          default: throw A(510, n.op);
        }
      }
      default: throw A(510);
    }
  }

  varNum(n) {
    if (n.n != null) return n.n;
    const v = this.evalE(n.e);
    if (v == null || v < 0) throw A(509, `#[${v}] is not a variable number`);
    return Math.round(v);
  }

  uScale() {
    return this.S.units === 20 ? INCH : 1;
  }

  getVar(n) {
    const S = this.S;
    const u = this.uScale();
    if (n === 0) return null;
    if (n >= 1 && n <= 33) return this.locals[this.locals.length - 1][n];
    if ((n >= 100 && n <= 199) || (n >= 500 && n <= 999)) return this.vars.has(n) ? this.vars.get(n) : null;
    if (n >= 1000 && n <= 1099) return 0; // discrete / analog inputs
    if (n >= 2001 && n <= 2800) {
      const grp = Math.floor((n - 2001) / 200), t = this.toolData(((n - 2001) % 200) + 1);
      if (!t) return 0;
      return [t.length, t.dLength, t.diameter, t.dRadius * 2][grp] / u;
    }
    switch (n) {
      case 3000: case 3006: return null;
      case 3001: return Math.round((this.res.totalTime || 0) * 1000);
      case 3002: return (this.res.totalTime || 0) / 3600;
      case 3011: { const d = new Date(); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }
      case 3012: { const d = new Date(); return d.getHours() * 10000 + d.getMinutes() * 100 + d.getSeconds(); }
      case 3026: return S.tool;
      case 3027: return Math.abs(S.rpmActual || 0);
      case 3032: return this.opts.blockDelete ? 1 : 0;
      case 3033: return 1;
      case 4001: return S.motion;
      case 4002: return S.plane;
      case 4003: return S.dist;
      case 4005: return S.feedMode;
      case 4006: return S.units;
      case 4007: return S.crc;
      case 4008: return S.tlo;
      case 4009: return S.cycle;
      case 4010: return S.retract;
      case 4011: return S.scale ? 51 : 50;
      case 4012: return S.wcs <= 59 ? S.wcs : S.wcs - 60 + 110;
      case 4013: return S.path;
      case 4016: return S.rot ? 68 : 69;
      case 4107: return S.D;
      case 4109: return S.feedMode === 93 ? S.feed : S.feed / u;
      case 4111: return S.tloH;
      case 4119: return S.rpm;
      case 4120: return S.selT ?? S.tool;
      default: break;
    }
    if (n >= 5001 && n <= 5003) return this.curP()['xyz'[n - 5001]] / u;
    if (n >= 5021 && n <= 5023) return S.pos['xyz'[n - 5021]] / u;
    if (n >= 5041 && n <= 5043) return this.curP()['xyz'[n - 5041]] / u;
    if (n >= 5081 && n <= 5083) return n === 5083 ? this.activeTLO() / u : 0;
    if (n >= 5004 && n <= 5006 || n >= 5024 && n <= 5026 || n >= 5044 && n <= 5046) return 0;
    const wo = this.workVar(n);
    if (wo) return wo.get() / u;
    if (n >= 6001 && n <= 6999) {
      const v = this.set(n - 6000);
      return typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : 0;
    }
    if (n >= 8550 && n <= 8599) {
      const t = this.toolData(S.tool);
      if (n === 8550) return S.tool;
      if (!t) return 0;
      if (n === 8554) return t.length / u;
      if (n === 8555) return t.diameter / u;
      return 0;
    }
    throw A(509, `#${n} cannot be read`);
  }

  // Work offset system variables: #5201.. (G52), #5221.. G54-G59, #7001.. G110-G129, #14001.. G154 P1-P99
  workVar(n) {
    const S = this.S;
    let target = null, axis = -1;
    if (n >= 5201 && n <= 5206) { target = 'g52'; axis = n - 5201; }
    else if (n >= 5221 && n <= 5346) { const r = n - 5221; if (r % 20 < 6) { target = Math.floor(r / 20); axis = r % 20; } }
    else if (n >= 7001 && n <= 7386) { const r = n - 7001; if (r % 20 < 6) { target = 6 + Math.floor(r / 20); axis = r % 20; } }
    else if (n >= 14001 && n <= 15986) { const r = n - 14001; if (r % 20 < 6) { target = 6 + Math.floor(r / 20); axis = r % 20; } }
    if (target === null) return null;
    if (axis > 2) return { get: () => 0, set: () => {} };
    const k = 'xyz'[axis];
    if (target === 'g52') return { get: () => S.g52[k], set: (v) => { S.g52[k] = v; this.bump(); this.syncPP(); } };
    return {
      get: () => (this.offsets[target] ? this.offsets[target][k] : 0),
      set: (v) => {
        const o = this.offsets[target];
        if (!o) throw A(331, `work offset ${target < 6 ? g2(54 + target) : 'G154 P' + (target - 5)} is not available (this machine has ${this.offsets.length} work offsets)`);
        o[k] = v;
        this.emit({ t: 'offset', index: target, x: o.x, y: o.y, z: o.z });
        this.syncPP();
      },
    };
  }

  setVar(n, v, item, blk) {
    const S = this.S;
    const u = this.uScale();
    if (n >= 1 && n <= 33) { this.locals[this.locals.length - 1][n] = v; return; }
    if ((n >= 100 && n <= 199) || (n >= 500 && n <= 999)) {
      if (v == null) this.vars.delete(n);
      else this.vars.set(n, v);
      return;
    }
    if (n === 3000) {
      const num = Math.max(0, Math.round(v ?? 0));
      const text = (blk && blk.comment) || '';
      throw new HaasAlarm(1000 + num, '', item, `${text.toUpperCase()}`.trim() || 'PROGRAMMABLE ALARM');
    }
    if (n === 3006) {
      const text = (blk && blk.comment) || `#3006=${v}`;
      this.emit({ t: 'msg', text });
      this.res.messages.push(text);
      if (this.buf) throw A(349, '#3006 stop with cutter comp active', item);
      this.emit({ t: 'stop', optional: false });
      return;
    }
    if (n === 3001 || n === 3002 || n === 3003 || n === 3004 || n === 3901 || n === 3902) return;
    if (n >= 1100 && n <= 1199) return; // discrete outputs
    if (n >= 2001 && n <= 2800) {
      const grp = Math.floor((n - 2001) / 200), t = ((n - 2001) % 200) + 1;
      if (!this.toolData(t)) throw A(331, `#${n}: there is no tool / offset ${t} in the tool table`, item);
      const val = (v ?? 0) * u;
      this.writeTool(t, ['length', 'dLength', 'diameter', 'dRadius'][grp], grp === 3 ? val / 2 : val);
      return;
    }
    const wo = this.workVar(n);
    if (wo) {
      if (this.buf) throw A(509, 'work offsets cannot change with cutter comp active', item);
      wo.set((v ?? 0) * u);
      return;
    }
    throw A(509, `#${n} cannot be written`, item);
  }

  writeTool(t, field, value) {
    const ov = { ...(this.toolOv.get(t) || {}) };
    ov[field] = value;
    this.toolOv.set(t, ov);
    const d = this.toolData(t);
    const w = { tool: t, length: d.length, dLength: d.dLength, diameter: d.diameter, dRadius: d.dRadius };
    this.res.toolOffsetWrites.push(w);
    this.emit({ t: 'tooloffset', ...w });
    if (!this.buf) this.syncPP();
    this.bump();
  }

  truth(v) {
    return v != null && v !== 0;
  }

  assign(it, blk) {
    const n = this.varNum(it.lhs);
    this.setVar(n, this.evalE(it.rhs), it, blk);
  }

  gotoN(target, word) {
    const v = target.kind === 'num' ? target.v : this.evalE(target.node);
    if (v == null || v % 1 || v < 0) throw A(539, `GOTO ${v}`, word);
    return this.findN(this.prog, v, word, 337);
  }

  findN(prog, n, word, num = 337) {
    const blocks = prog.blocks;
    for (let i = (this.pc || 0) + 1; i < blocks.length; i++) if (blocks[i].n === n) return i;
    const i0 = prog.nMap.get(n);
    if (i0 == null) throw A(num, `N${n} not found in ${prog.isMain ? 'this program' : this.progLabel(prog)}`, word);
    return i0;
  }

  // ---------------------------------------------------------------- block execution
  hblock(blk, pc) {
    this.blockOps = 0;
    this.curWord = blk.items[0];
    const words = [];
    let next = null;
    const prog = this.prog;
    for (const it of blk.items) {
      if (it.t === 'word') { words.push(it); continue; }
      this.curWord = it;
      switch (it.t) {
        case 'assign': this.assign(it, blk); break;
        case 'if':
          if (this.truth(this.evalE(it.cond))) {
            if (it.then) this.assign(it.then, blk);
            else next = this.gotoN(it.target, it);
          }
          break;
        case 'goto': next = this.gotoN(it.target, it); break;
        case 'while':
          if (!this.truth(this.evalE(it.cond))) {
            const e = prog.loopEnd.get(pc);
            if (e == null) throw A(538, `no END${it.d} for this WHILE`, it);
            next = e + 1;
          }
          break;
        case 'do': break;
        case 'end': {
          const s = prog.loopStart.get(pc);
          if (s == null) throw A(524, `END${it.d}`, it);
          next = s;
          break;
        }
        case 'dprnt': {
          const text = this.dprnt(it.text);
          this.res.dprnt.push(text);
          this.res.messages.push(`DPRNT: ${text}`);
          break;
        }
        default: break;
      }
    }
    if (words.length) {
      const r = this.ncBlock(blk, words, pc);
      if (r != null) next = r;
    } else if (!this.blockOps) {
      const before = this.stKey;
      this.snap();
      if (this.stKey !== before) this.emit({ t: 'state' });
    }
    return next;
  }

  dprnt(text) {
    let out = '';
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '*') { out += ' '; continue; }
      if (c === '#') {
        const m = /^#(\d+)\[(\d)(\d)\]/.exec(text.slice(i));
        if (m) {
          const v = this.getVar(+m[1]);
          out += v == null ? '' : (v < 0 ? '-' : '+') + Math.abs(v).toFixed(+m[3]).padStart(+m[2] + (+m[3] ? +m[3] + 1 : 0), '0');
          i += m[0].length - 1;
          continue;
        }
      }
      if (c !== ' ') out += c;
    }
    return out;
  }

  wordVal(w) {
    if (w.kind === 'num') return { v: w.v, dec: w.dec };
    const v = this.evalE(w.node);
    return v == null ? null : { v, dec: true };
  }

  ncBlock(blk, words, pc) {
    const S = this.S;
    const gs = [], ms = [], W = {};
    for (const w of words) {
      if (w.a === 'N' || w.a === 'O') continue;
      this.curWord = w;
      const v = this.wordVal(w);
      if (v == null) continue; // vacant variable: the address is ignored
      const o = { a: w.a, v: v.v, dec: v.dec, col: w.col, len: w.len };
      if (w.a === 'G') gs.push(o);
      else if (w.a === 'M') ms.push(o);
      else (W[w.a] || (W[w.a] = [])).push(o);
    }
    if (!gs.length && !ms.length && !Object.keys(W).length) return null;
    this.curWord = gs[0] || ms[0] || words[0];
    // ---- G codes and groups
    const G = {}, gw = {};
    for (const g of gs) {
      if (g.v % 1) throw A(311, `G${g.v}: Haas has no G codes with a decimal point`, g);
      const def = HAAS_G[g.v];
      if (!def) throw A(311, `${g2(g.v)} is not a Haas mill G code`, g);
      if (def[0] === 'opt') throw A(391, `${g2(g.v)} ${def[1]}: ${def[2]}`, g);
      const grp = def[0];
      if (G[grp] !== undefined) throw A(339, `${g2(g.v)} and ${g2(G[grp])} are in the same group`, g);
      G[grp] = g.v;
      gw[grp] = g;
    }
    const nm = G.nm;
    const isG65 = nm === 65;
    for (const L of Object.keys(W)) {
      if (W[L].length > 1 && !(isG65 && 'IJK'.includes(L))) throw A(339, `address ${L} is programmed twice`, W[L][1]);
      if (!isG65) {
        if (L === 'A') throw A(336, 'this mill has no 4th (A) axis installed', W[L][0]);
        if ('BCUVW'.includes(L)) throw A(311, `address ${L} has no meaning on this 3-axis mill`, W[L][0]);
      }
    }
    const w1 = {};
    for (const L of Object.keys(W)) w1[L] = W[L][0];
    let M = null, mw = null;
    if (ms.length > 1) throw A(339, 'only one M code is allowed in a block', ms[1]);
    if (ms.length) {
      mw = ms[0];
      if (mw.v % 1 || mw.v < 0 || HAAS_M[mw.v] === undefined) throw A(329, `M${mw.v} is not a Haas mill M code`, mw);
      M = mw.v;
    }
    if (G.motion !== undefined && G.cycle !== undefined && G.cycle !== 80) throw A(339, `${g2(G.motion)} and ${g2(G.cycle)} cannot be in the same block`, gw.cycle);

    // ---- units first, so every value of the block is scaled consistently
    if (G.units !== undefined && G.units !== S.units) {
      S.units = G.units;
      this.bump();
    }
    const u = S.units === 20 ? INCH : 1;
    const inc = S.units === 20 ? 1e-4 : 1e-3;
    const dimW = (w) => (w ? (w.dec ? w.v : w.v * inc) * u : undefined);
    const dim = (L) => dimW(w1[L]);
    const angle = (L) => (w1[L] ? (w1[L].dec ? w1[L].v : w1[L].v * 1e-3) : undefined);
    const intW = (L, num = 331, lo = 0, hi = 99999) => {
      const w = w1[L];
      if (!w) return undefined;
      if (w.v % 1 || w.v < lo || w.v > hi) throw A(num, `${L}${w.v} must be a whole number ${lo}..${hi}`, w);
      return w.v;
    };
    this.cur = { w1, W, dim, dimW, angle, intW, u, inc, G, gw, mw };
    if (isG65) return this.callG65(blk, W, w1, intW, pc, gw.nm);

    // ---- F, S, T
    if (w1.F) {
      const w = w1.F;
      const f = w.dec || this.set(77) ? w.v : w.v * inc;
      if (!(f > 0)) throw A(331, `F${w.v}: the feed must be greater than zero`, w);
      S.feed = S.feedMode === 93 && G.feedmode === undefined ? f : (G.feedmode ?? S.feedMode) === 93 ? f : f * u;
      if ((G.feedmode ?? S.feedMode) === 94 && S.feed > MACHINE.maxFeed && !this.feedWarned) {
        this.feedWarned = true;
        this.warn(`F${w.v} is above the ${MACHINE.maxFeed} mm/min maximum cutting feed; moves run at the maximum`);
      }
    }
    if (w1.S) {
      const s = w1.S.v;
      if (s < 0) throw A(331, 'negative spindle speed', w1.S);
      S.rpm = Math.min(s, MACHINE.maxRpm);
      if (s > MACHINE.maxRpm) this.warn(`S${s} is above the ${MACHINE.maxRpm} rpm spindle maximum; the spindle runs at ${MACHINE.maxRpm} rpm`);
      if (S.spindleDir && M !== 3 && M !== 4 && M !== 5) this.spindleOp(S.rpm, S.spindleDir);
    }
    if (w1.T) {
      const t = intW('T', 331, 0, 200);
      if (t !== 0 && !this.opts.tools.get(t)) throw A(331, `T${t} is not in the tool table (empty pocket)`, w1.T);
      S.selT = t;
    }

    // ---- modal codes
    const buffered = () => !!this.buf;
    let xform = false;
    if (G.plane !== undefined && G.plane !== S.plane) {
      if (S.crc !== 40) throw A(350, 'the plane cannot change with cutter comp active', gw.plane);
      S.plane = G.plane;
    }
    if (G.dist !== undefined) S.dist = G.dist;
    if (G.feedmode !== undefined) S.feedMode = G.feedmode;
    if (G.path !== undefined) S.path = G.path;
    if (G.retract !== undefined) S.retract = G.retract;
    if (G.wcs !== undefined) {
      if (buffered()) throw A(350, 'the work offset cannot change with cutter comp active', gw.wcs);
      let idx, name;
      if (G.wcs <= 59) { idx = G.wcs - 54; name = g2(G.wcs); }
      else if (G.wcs <= 129) { idx = 6 + G.wcs - 110; name = `G${G.wcs}`; }
      else {
        const p = intW('P', 331, 1, 99);
        if (p === undefined) throw A(331, 'G154 needs P1..P99', gw.wcs);
        idx = 6 + p - 1;
        name = `G154 P${p}`;
      }
      if (idx >= this.offsets.length) throw A(331, `${name} is not available: the offset table of this machine has ${this.offsets.length} work offsets (G54-G59)`, gw.wcs);
      if (S.wcs !== 54 + idx) xform = true;
      S.wcs = 54 + idx;
      S.wcsName = name;
    }
    // tool length
    const tloBefore = this.activeTLO();
    if (G.tlo === 43 || G.tlo === 44) {
      let h = intW('H', 331, 0, 200);
      if (h === undefined) {
        if (!S.tloH) throw A(331, `${g2(G.tlo)} needs a non-zero H offset number (e.g. ${g2(G.tlo)} H${String(S.tool || 1).padStart(2, '0')})`, gw.tlo);
        h = S.tloH;
      }
      if (h === 0) { S.tlo = 49; S.tloH = 0; }
      else {
        if (this.set(15) && h !== S.tool) throw A(332, `H${h} with T${S.tool} in the spindle (Setting 15 is on)`, w1.H || gw.tlo);
        if (!this.toolData(h)) this.warn(`H${String(h).padStart(2, '0')} has no tool length in the tool table; the length offset is 0`);
        else if (h !== S.tool && this.opts.requireG43) this.warn(`G43 H${h} is active but T${S.tool} is in the spindle; the wrong tool length will be used`);
        S.tlo = G.tlo;
        S.tloH = h;
      }
    } else if (G.tlo === 49) {
      S.tlo = 49;
      S.tloH = 0;
    } else if (w1.H && S.tlo !== 49) {
      const h = intW('H', 331, 0, 200);
      if (h === 0) { S.tlo = 49; S.tloH = 0; } else S.tloH = h;
    }
    if (this.activeTLO() !== tloBefore) {
      if (buffered()) throw A(350, 'the tool length offset cannot change with cutter comp active', gw.tlo || w1.H);
      xform = true;
    }
    // scaling
    const posWordsUsed = nm === 10 || nm === 52 || nm === 92 || nm === 101 || nm === 100 || G.scale === 51 || G.rot === 68;
    if (G.scale !== undefined) {
      if (buffered()) throw A(350, 'scaling cannot change with cutter comp active', gw.scale);
      if (G.scale === 50) S.scale = null;
      else {
        const k = w1.P ? w1.P.v : this.set(71);
        if (!(k > 0)) throw A(331, `G51 scale factor P${k}`, w1.P || gw.scale);
        S.scale = { cx: dim('X') ?? 0, cy: dim('Y') ?? 0, cz: dim('Z') ?? 0, k };
      }
      this.bump();
      xform = true;
    }
    if (G.rot !== undefined) {
      if (buffered()) throw A(350, 'rotation cannot change with cutter comp active', gw.rot);
      if (G.rot === 69) S.rot = null;
      else {
        if (S.plane !== 17) throw A(391, 'G68 rotation is only simulated in the G17 plane', gw.rot);
        const cq = this.pp;
        const cp = this.toQ({ x: dim('X') ?? this.curP().x, y: dim('Y') ?? this.curP().y, z: 0 });
        let a = w1.R ? angle('R') : this.set(72);
        if ((S.dist === 91 || this.set(73)) && S.rot) a += S.rot.a;
        S.rot = { cx: w1.X ? cp.x : cq.x, cy: w1.Y ? cp.y : cq.y, a };
      }
      this.bump();
      xform = true;
    }
    if (nm === 100 || nm === 101) {
      if (buffered()) throw A(350, 'mirror image cannot change with cutter comp active', gw.nm);
      if (w1.Z) throw A(391, 'Z axis mirror image is not supported', w1.Z);
      if (nm === 100) {
        if (w1.X || w1.Y) { if (w1.X) S.mirror.x = null; if (w1.Y) S.mirror.y = null; }
        else S.mirror = { x: null, y: null };
      } else {
        if (!w1.X && !w1.Y) throw A(331, 'G101 needs the axis to mirror: G101 X0 (pivot)', gw.nm);
        if (w1.X) S.mirror.x = dim('X');
        if (w1.Y) S.mirror.y = dim('Y');
      }
      this.bump();
      xform = true;
    }
    if (xform && !buffered()) this.syncPP();

    // ---- D word and cutter comp
    if (w1.D && nm !== 12 && nm !== 13 && nm !== 150) {
      const d = intW('D', 331, 0, 200);
      if (buffered() && d !== S.D) throw A(350, 'D cannot change with cutter comp active', w1.D);
      S.D = d;
    }
    const crcBefore = S.crc;
    if (G.crc !== undefined && nm !== 150 && G.crc !== S.crc) {
      if (G.crc !== 40) {
        if (S.crc !== 40) throw A(350, `switch from ${g2(S.crc)} to ${g2(G.crc)} through G40`, gw.crc);
        if (S.plane !== 17) throw A(350, 'cutter compensation works only in G17', gw.crc);
        if (!w1.D && !S.D) throw A(331, `${g2(G.crc)} needs a D cutter comp register (e.g. ${g2(G.crc)} D${String(S.tool || 1).padStart(2, '0')})`, gw.crc);
        const motionNow = G.motion ?? S.motion;
        if (motionNow === 2 || motionNow === 3) throw A(340, '', gw.crc);
        const r = this.compRadius();
        if (!this.toolData(S.D)) this.warn(`D${String(S.D).padStart(2, '0')} has no tool in the tool table; the cutter comp offset is 0`);
        let side = G.crc === 41 ? 1 : -1;
        if (this.mirrorFlip(17)) side = -side;
        if (r < 0) { side = -side; }
        this.flush(false);
        this.crcSession = { side, r: Math.abs(r) };
        this.ensureBuffer();
      } else {
        const motionNow = G.motion ?? S.motion;
        if (motionNow === 2 || motionNow === 3) throw A(341, '', gw.crc);
      }
      S.crc = G.crc;
    }

    // ---- motion mode / canned cycle mode
    let cycStart = false;
    if (G.cycle === 80) S.cycle = 80;
    if (G.motion !== undefined) {
      S.motion = G.motion;
      if (S.cycle !== 80) S.cycle = 80;
    }
    if (G.cycle !== undefined && G.cycle !== 80) {
      if (buffered() || S.crc !== 40) throw A(350, 'canned cycles cannot run with cutter comp active (G40 first)', gw.cycle);
      if (S.cycle === 80) {
        S.cycInit = this.curP().z;
        S.cyc = {};
      }
      S.cycle = G.cycle;
      cycStart = true;
      this.bump();
    }
    const patt = nm === 70 || nm === 71 || nm === 72;
    if (S.cycle !== 80 && !posWordsUsed && nm !== 12 && nm !== 13 && nm !== 150) {
      for (const L of patt ? ['Z', 'R', 'P', 'E'] : ['Z', 'R', 'Q', 'I', 'J', 'K', 'P', 'E']) {
        if (w1[L]) { S.cyc[L] = { v: w1[L].v, dec: w1[L].dec }; this.bump(); }
      }
      if (cycStart) for (const L of ['Q', 'I', 'J', 'K']) if (!w1[L] && G.cycle !== S.cycle) delete S.cyc[L];
    }

    // ---- dwell
    if (nm === 4) {
      if (!w1.P) throw A(326, 'program the time with P (P1.5 = 1.5 s, P1500 = 1500 ms)', gw.nm);
      const sec = w1.P.dec ? w1.P.v : w1.P.v / 1000;
      if (sec < 0) throw A(324, 'negative dwell time', w1.P);
      this.dwell(sec);
    }

    // ---- non-modal functions and motion
    let moved = false;
    const hasXY = !!(w1.X || w1.Y), hasAx = hasXY || !!w1.Z;
    if (nm === 10) this.g10(w1, dim, intW, gw.nm);
    else if (nm === 28) this.g28(w1, dim, gw.nm);
    else if (nm === 29) this.g29(w1, dim, gw.nm);
    else if (nm === 52) this.g52(w1, dim, gw.nm);
    else if (nm === 53) moved = this.g53(w1, dim, gw.nm);
    else if (nm === 92) this.g92(w1, dim, gw.nm);
    else if (nm === 12 || nm === 13) {
      if (buffered() || S.crc !== 40) throw A(350, `${g2(nm)} cannot be used with cutter comp active`, gw.nm);
      this.curWord = gw.nm;
      circPocket(this, nm, { w1, dim, intW });
    } else if (nm === 150) {
      if (buffered() || S.crc !== 40) throw A(350, 'G150 cannot be used with cutter comp active', gw.nm);
      this.curWord = gw.nm;
      generalPocket(this, { w1, dim, intW, side: G.crc, pc });
    } else if (patt) {
      if (S.cycle === 80) throw A(311, `${g2(nm)} bolt pattern needs an active canned cycle (G81, G83, ...)`, gw.nm);
      this.curWord = gw.nm;
      const ctx = this.cycleCtx(gw.nm);
      boltPattern(this, nm, ctx, { I: dim('I'), J: angle('J'), K: angle('K'), L: intW('L', 331, 0, 32767), Iraw: w1.I });
    } else if (S.cycle !== 80 && !posWordsUsed) {
      if (M === 6 || M === 16) throw A(372, '', mw);
      const L = intW('L', 331, 0, 32767);
      const runHere = cycStart ? this.set(28) || hasXY : hasXY;
      if (runHere && L !== 0) {
        this.curWord = gw.cycle || words[0];
        const ctx = this.cycleCtx(gw.cycle || words[0]);
        const reps = L ?? 1;
        for (let r = 0; r < reps; r++) {
          const P = this.curP();
          let x = P.x, y = P.y;
          if (S.dist === 90) { if (w1.X) x = dim('X'); if (w1.Y) y = dim('Y'); }
          else { if (w1.X) x += dim('X'); if (w1.Y) y += dim('Y'); }
          cannedHole(this, ctx, x, y);
        }
      }
    } else if (!posWordsUsed && nm !== 4) {
      if (S.motion === 2 || S.motion === 3) {
        if (hasAx || w1.I || w1.J || w1.K || w1.R) {
          this.haasArc(w1, dim, gw.motion || words[0]);
          moved = true;
        }
      } else if (hasAx) {
        const t = this.targetP(w1, dim);
        if (S.motion === 1) {
          const f = this.motionFeed(w1, gw.motion || words[0], () => Math.hypot(...['x', 'y', 'z'].map((k) => this.toQ(t)[k] - this.pp[k])));
          this.pMove(false, t, f);
        } else this.pMove(true, t);
        moved = true;
      }
    }
    if (crcBefore !== 40 && S.crc === 40) this.flush(moved);

    // ---- M code (end of block)
    let next = null;
    if (M !== null) next = this.mcode(M, mw, w1, intW, blk, pc);
    if (!this.blockOps) {
      const before = this.stKey;
      this.snap();
      if (this.stKey !== before || G.wcs !== undefined || G.tlo !== undefined || G.units !== undefined) this.emit({ t: 'state' });
    }
    return next;
  }

  // Inverse time (G93) or per-minute / per-rev feed for one G01/G02/G03 block.
  motionFeed(w1, word, lenFn) {
    const S = this.S;
    if (S.feedMode === 93) {
      if (!w1.F) throw A(320, 'G93 inverse time feed needs F in every G01/G02/G03 block', word);
      return lenFn() * S.feed;
    }
    return this.feedNow(word);
  }

  targetP(w1, dim) {
    const S = this.S;
    const t = this.curP();
    for (const a of ['X', 'Y', 'Z']) {
      if (!w1[a]) continue;
      const k = a.toLowerCase();
      t[k] = S.dist === 90 ? dim(a) : t[k] + dim(a);
    }
    return t;
  }

  haasArc(w1, dim, word) {
    const S = this.S;
    const pl = PLANES[S.plane];
    const sP = this.curP();
    const tP = this.targetP(w1, dim);
    const cw = S.motion === 2;
    const sa = sP[pl.a], sb = sP[pl.b], ea = tP[pl.a], eb = tP[pl.b];
    const ia = w1[pl.ia], ib = w1[pl.ib];
    const c = {};
    let sweepEst;
    if (w1.R && !ia && !ib) {
      const R = dim('R');
      const da = ea - sa, db = eb - sb, d = Math.hypot(da, db);
      if (Math.abs(R) < 1e-9) throw A(302, 'R0', w1.R);
      if (d < 1e-7) throw A(302, 'R cannot describe a full circle; use I/J/K', w1.R);
      if (d > 2 * Math.abs(R) + 1e-4) throw A(302, `radius ${(Math.abs(R) / this.uScale()).toFixed(4)} is too small for the chord ${(d / this.uScale()).toFixed(4)}`, w1.R);
      const h = Math.sqrt(Math.max(0, R * R - (d / 2) ** 2));
      const sgn = (cw ? 1 : -1) * (R > 0 ? 1 : -1);
      c[pl.a] = (sa + ea) / 2 + (sgn * h * db) / d;
      c[pl.b] = (sb + eb) / 2 - (sgn * h * da) / d;
      sweepEst = Math.abs(R) * Math.PI;
    } else {
      if (!ia && !ib) throw A(304, `${g2(S.motion)} needs ${pl.ia}/${pl.ib} (centre from the start point) or R in ${g2(S.plane)}`, word);
      for (const k of 'IJK') if (w1[k] && k !== pl.ia && k !== pl.ib) throw A(304, `${k} is not valid in ${g2(S.plane)}`, w1[k]);
      c[pl.a] = sa + (ia ? dim(pl.ia) : 0);
      c[pl.b] = sb + (ib ? dim(pl.ib) : 0);
      const rs = Math.hypot(sa - c[pl.a], sb - c[pl.b]), re = Math.hypot(ea - c[pl.a], eb - c[pl.b]);
      if (rs < 1e-6) throw A(304, 'the centre is on the start point', word);
      if (Math.abs(rs - re) > Math.max(0.02, rs * 0.001)) throw A(304, `start radius ${(rs / this.uScale()).toFixed(4)}, end radius ${(re / this.uScale()).toFixed(4)}`, word);
      sweepEst = rs * 2 * Math.PI;
    }
    const f = this.motionFeed(w1, word, () => Math.hypot(sweepEst, tP[pl.c] - sP[pl.c]));
    const Q = this.toQ(tP);
    const cP = { ...sP, ...c };
    const cQ = this.toQ(cP);
    const center = S.plane === 17 ? { x: cQ.x, y: cQ.y } : { [pl.a]: cQ[pl.a], [pl.b]: cQ[pl.b] };
    if (S.crc !== 40 && S.plane !== 17) throw A(350, 'arcs with cutter comp only in G17', word);
    this.progArc(Q, center, this.mirrorFlip() ? !cw : cw, 0, Math.min(f, MACHINE.maxFeed));
  }

  // ---------------------------------------------------------------- canned cycle context
  cycleCtx(word) {
    const S = this.S;
    const c = S.cyc;
    const u = this.uScale(), inc = S.units === 20 ? 1e-4 : 1e-3;
    const dimW = (w) => (w ? (w.dec ? w.v : w.v * inc) * u : undefined);
    const k = S.cycle;
    if (!c.Z) throw A(306, `${g2(k)} has no Z depth`, word);
    if (!c.R) throw A(306, `${g2(k)} has no R plane`, word);
    const init = S.cycInit ?? this.curP().z;
    let rZ, zZ;
    if (S.dist === 90) { rZ = dimW(c.R); zZ = dimW(c.Z); }
    else { rZ = init + dimW(c.R); zZ = rZ + dimW(c.Z); }
    const ctx = {
      k, init, rZ, zZ, q: c.Q ? dimW(c.Q) : undefined, i: c.I ? dimW(c.I) : undefined, j: c.J ? dimW(c.J) : undefined, kk: c.K ? dimW(c.K) : undefined,
      jRaw: c.J ? c.J.v : undefined, p: c.P ? (c.P.dec ? c.P.v : c.P.v / 1000) : 0, word,
      delta: this.set(22) * INCH, above: this.set(52) * INCH, shiftDir: this.set(27),
    };
    cycleNeeds(this, ctx);
    ctx.feed = this.feedNow(word);
    return ctx;
  }

  // ---------------------------------------------------------------- group 00 functions
  g10(w1, dim, intW, gword) {
    const S = this.S;
    const L = intW('L', 385, 0, 99);
    const P = intW('P', 385, 0, 200);
    if (L === undefined) throw A(385, 'G10 needs L (L2, L20, L10-L13)', gword);
    if (P === undefined) throw A(385, `G10 L${L} needs P`, gword);
    const add = S.dist === 91;
    if (L === 2 || L === 20) {
      if (this.buf) throw A(350, 'work offsets cannot change with cutter comp active', gword);
      if (L === 2 && P === 0) {
        for (const a of ['X', 'Y', 'Z']) if (w1[a]) { const k = a.toLowerCase(); S.g52[k] = (add ? S.g52[k] : 0) + dim(a); }
        this.bump();
        this.syncPP();
        return;
      }
      const idx = L === 2 ? P - 1 : 6 + P - 1;
      if ((L === 2 && P > 6) || (L === 20 && (P < 1 || P > 99))) throw A(385, `G10 L${L} P${P}`, w1.P);
      const o = this.offsets[idx];
      if (!o) throw A(331, `G154 P${P} is not available: the offset table of this machine has ${this.offsets.length} work offsets`, w1.P);
      for (const a of ['X', 'Y', 'Z']) if (w1[a]) { const k = a.toLowerCase(); o[k] = (add ? o[k] : 0) + dim(a); }
      this.emit({ t: 'offset', index: idx, x: o.x, y: o.y, z: o.z });
      this.syncPP();
      return;
    }
    const field = { 1: 'length', 10: 'length', 11: 'dLength', 12: 'diameter', 13: 'dRadius' }[L];
    if (!field) throw A(385, `G10 L${L} is not a Haas offset type (L2, L20, L10, L11, L12, L13)`, w1.L);
    const vw = w1.R || w1.Q;
    if (!vw) throw A(385, `G10 L${L} needs the value in R`, gword);
    if (!this.toolData(P)) throw A(385, `G10 L${L} P${P}: no tool ${P} in the tool table`, w1.P);
    let v = dim(vw.a);
    if (field === 'dRadius') v /= 2;
    if (add) v += this.toolData(P)[field];
    this.writeTool(P, field, v);
  }

  g28(w1, dim, gword) {
    const S = this.S;
    if (this.buf) throw A(350, 'G28 with cutter comp active: cancel it with G40 first', gword);
    const axes = ['X', 'Y', 'Z'].filter((a) => w1[a]);
    if (axes.length) this.pMove(true, this.targetP(w1, dim));
    this.g28Mid = { ...S.pos, axes };
    const h = { ...S.pos };
    for (const a of axes.length ? axes : ['X', 'Y', 'Z']) h[a.toLowerCase()] = 0;
    this.line3(true, h.x, h.y, h.z);
    this.syncPP();
  }

  g29(w1, dim, gword) {
    const S = this.S;
    if (!this.g28Mid) throw A(311, 'G29 without a preceding G28', gword);
    if (this.buf) throw A(350, 'G29 with cutter comp active', gword);
    const axes = ['X', 'Y', 'Z'].filter((a) => w1[a]);
    const m = { ...S.pos };
    for (const a of axes) m[a.toLowerCase()] = this.g28Mid[a.toLowerCase()];
    this.line3(true, m.x, m.y, m.z);
    this.syncPP();
    this.pMove(true, this.targetP(w1, dim));
  }

  g52(w1, dim, gword) {
    const S = this.S;
    if (this.buf) throw A(350, 'G52 with cutter comp active', gword);
    for (const a of ['X', 'Y', 'Z']) if (w1[a]) S.g52[a.toLowerCase()] = dim(a);
    this.bump();
    this.syncPP();
  }

  g92(w1, dim, gword) {
    const S = this.S;
    if (this.buf) throw A(350, 'G92 with cutter comp active', gword);
    const q = this.pp;
    for (const a of ['X', 'Y', 'Z']) {
      if (!w1[a]) continue;
      const k = a.toLowerCase();
      const want = this.toQ({ ...this.curP(), [k]: dim(a) })[k];
      S.g92[k] += q[k] - want;
    }
    this.bump();
    this.syncPP();
  }

  g53(w1, dim, gword) {
    const S = this.S;
    if (this.buf) throw A(350, 'G53 with cutter comp active', gword);
    if (S.dist === 91) throw A(311, 'G53 is not allowed in G91 incremental mode', gword);
    if (S.motion !== 0 && S.motion !== 1) throw A(311, 'G53 needs G00 or G01', gword);
    const p = S.pos;
    const t = { x: w1.X ? dim('X') : p.x, y: w1.Y ? dim('Y') : p.y, z: w1.Z ? dim('Z') : p.z };
    const rapid = S.motion === 0;
    this.move(rapid, [p.x, p.y, p.z, t.x, t.y, t.z], rapid ? 0 : Math.min(this.feedNow(gword), MACHINE.maxFeed));
    this.syncPP();
    return !!(w1.X || w1.Y || w1.Z);
  }

  // ---------------------------------------------------------------- subprograms and macros
  findProgram(num, word, alarmNum = 314) {
    if (this.prog.oMap.has(num)) return { prog: this.prog, start: this.prog.oMap.get(num) };
    if (this.main.oMap.has(num)) return { prog: this.main, start: this.main.oMap.get(num) };
    let p = this.progCache.get(num);
    if (!p) {
      const look = this.opts.programLookup;
      const text = look ? look(num) : null;
      if (typeof text !== 'string') throw A(alarmNum, `O${String(num).padStart(5, '0')} is not in memory`, word);
      p = parseHaasProgram(text, `O${String(num).padStart(5, '0')}`);
      if (p.oNum == null) p.oNum = num;
      this.progCache.set(num, p);
    }
    const start = p.oMap.has(num) ? p.oMap.get(num) : 0;
    const bad = p.blocks.find((b) => b.errors.length);
    if (bad) throw A(386, `${this.progLabel(p)} line ${bad.line + 1}: ${bad.errors[0].msg}`, word);
    return { prog: p, start };
  }

  enter(kind, target, reps, retPc, blk, locals) {
    if (this.stack.length >= 9) throw A(kind === 'g65' ? 531 : 307, 'more than 9 nested calls', this.curWord);
    this.stack.push({ kind, prog: this.prog, seg: this.seg, ret: retPc, reps, start: target.start, sub: target.prog, subSeg: target.seg, extLine: this.extLine });
    if (this.prog.isMain) this.extLine = blk.line;
    if (locals) this.locals.push(locals);
    this.prog = target.prog;
    this.seg = target.seg;
    return target.start;
  }

  callG65(blk, W, w1, intW, pc, gword) {
    const P = intW('P', 315, 1, 99999);
    if (P === undefined) throw A(315, 'G65 needs P<program number>', gword);
    const L = intW('L', 331, 0, 32767) ?? 1;
    if (this.cur.mw) throw A(339, 'G65 cannot be combined with an M code', this.cur.mw);
    const map = { A: 1, B: 2, C: 3, D: 7, E: 8, F: 9, H: 11, M: 13, Q: 17, R: 18, S: 19, T: 20, U: 21, V: 22, W: 23, X: 24, Y: 25, Z: 26 };
    const loc = new Array(34).fill(null);
    for (const L2 of Object.keys(W)) {
      if (L2 === 'P' || L2 === 'L') continue;
      if (L2 === 'G') throw A(529, 'G cannot be a G65 argument', W[L2][0]);
      if ('IJK'.includes(L2)) continue;
      if (map[L2] === undefined) throw A(529, `${L2} cannot be a G65 argument`, W[L2][0]);
      loc[map[L2]] = W[L2][0].v;
    }
    // I/J/K: first set -> #4 #5 #6, further sets -> #7.. (argument specification II)
    for (const [k, base] of [['I', 4], ['J', 5], ['K', 6]]) (W[k] || []).forEach((w, n) => {
      const idx = base + 3 * n;
      if (idx > 33) throw A(529, 'too many I/J/K argument sets', w);
      loc[idx] = w.v;
    });
    if (L === 0) return null;
    const { prog, start } = this.findProgram(P, w1.P || gword, 314);
    const target = { prog, start: start + (prog.blocks[start]?.o === P ? 1 : 0), seg: prog.blocks[start]?.o === P ? start : -1 };
    return this.enter('g65', target, L, pc + 1, blk, loc);
  }

  mcode(M, mw, w1, intW, blk, pc) {
    const S = this.S;
    switch (M) {
      case 0: case 1:
        if (this.buf) throw A(349, '', mw);
        this.emit({ t: 'stop', optional: M === 1 });
        return null;
      case 2: case 30:
        if (this.buf || S.crc !== 40) throw A(349, '', mw);
        if (S.spindleDir) this.spindleOp(0, 0);
        if (S.flood || S.mist) {
          S.flood = S.mist = false;
          this.emit({ t: 'coolant', flood: false, mist: false });
        }
        if (M === 30) {
          S.g52 = { x: 0, y: 0, z: 0 };
          this.bump();
        }
        this.emit({ t: 'end', rewind: M === 30 });
        this.res.ended = true;
        return null;
      case 3: case 4:
        if (!(S.rpm > 0)) this.warn(`${m2(M)} without a spindle speed: the spindle does not turn until S is programmed`);
        if (!S.tool) this.warn('Spindle started with no tool in the spindle');
        this.spindleOp(S.rpm, M === 3 ? 1 : -1);
        return null;
      case 5:
        this.spindleOp(0, 0);
        return null;
      case 19:
        if (S.spindleDir) this.spindleOp(0, 0);
        return null;
      case 6: case 16:
        this.toolChange(mw);
        return null;
      case 7:
        S.mist = true;
        this.emit({ t: 'coolant', flood: S.flood, mist: true });
        return null;
      case 8: case 88:
        S.flood = true;
        this.emit({ t: 'coolant', flood: true, mist: S.mist });
        return null;
      case 9:
        S.flood = S.mist = false;
        this.emit({ t: 'coolant', flood: false, mist: false });
        return null;
      case 89:
        return null;
      case 96: {
        const p = intW('P', 315, 0, 99999);
        if (p === undefined) throw A(315, 'M96 needs P<N line>', mw);
        return this.findN(this.prog, p, w1.P, 337); // simulated inputs are always 0: the jump is taken
      }
      case 97: case 98: {
        const p = intW('P', 315, 0, 99999);
        if (p === undefined) throw A(315, `${m2(M)} needs P`, mw);
        const L = intW('L', 331, 0, 32767) ?? 1;
        if (L === 0) return null;
        let target;
        if (M === 97) {
          const i = this.prog.nMap.get(p);
          if (i == null) throw A(337, `M97 P${p}: N${p} not found in ${this.prog.isMain ? 'this program' : this.progLabel(this.prog)}`, w1.P);
          target = { prog: this.prog, start: i, seg: this.seg };
        } else {
          const f = this.findProgram(p, w1.P, 314);
          const isO = f.prog.blocks[f.start]?.o === p;
          target = { prog: f.prog, start: f.start + (isO ? 1 : 0), seg: isO ? f.start : -1 };
        }
        return this.enter(M === 97 ? 'm97' : 'm98', target, L, pc + 1, blk, null);
      }
      case 99: {
        if (!this.stack.length) {
          this.warn('M99 in the main program repeats it from the start for ever; the simulation stops here (use M30 to end)');
          if (this.buf) this.flush(false);
          this.emit({ t: 'end', rewind: true });
          this.res.ended = true;
          return null;
        }
        if (this.buf) throw A(349, 'M99 with cutter comp active', mw);
        const fr = this.stack[this.stack.length - 1];
        if (--fr.reps > 0) return fr.start;
        this.stack.pop();
        if (fr.kind === 'g65') this.locals.pop();
        this.prog = fr.prog;
        this.seg = fr.seg;
        this.extLine = fr.extLine;
        const p = intW('P', 315, 0, 99999);
        if (p !== undefined) {
          const i = this.prog.nMap.get(p);
          if (i == null) throw A(337, `M99 P${p}: N${p} not found in the calling program`, w1.P);
          return i;
        }
        return fr.ret;
      }
      case 109:
        this.warn('M109 interactive input is not available in the simulator; the variable keeps its value');
        return null;
      default:
        return null;
    }
  }

  toolChange(mw) {
    const S = this.S;
    if (S.cycle !== 80) throw A(372, '', mw);
    if (this.buf || S.crc !== 40) throw A(349, 'tool change with cutter comp active (G40 first)', mw);
    const to = S.selT ?? null;
    if (to == null) throw A(311, 'M06 needs a tool: Tnn M06', mw);
    if (to === 0) throw A(331, 'T0: there is no tool to change to', mw);
    if (to !== S.tool) {
      if (S.spindleDir) this.spindleOp(0, 0);
      if (S.flood || S.mist) {
        S.flood = S.mist = false;
        this.emit({ t: 'coolant', flood: false, mist: false });
      }
      const p0 = S.pos;
      const zTime = trapTime(Math.abs(p0.z), MACHINE.rapidZ / 60, MACHINE.accel);
      const time = zTime + atcTime(S.tool, to, S.carousel);
      const prev = S.tool;
      S.pos = { x: p0.x, y: p0.y, z: 0 };
      S.tool = to;
      S.carousel = to || prev || S.carousel;
      this.res.toolsUsed.add(to);
      if (S.tlo !== 49) S.tloH = to; // NGC: the length offset follows the new tool
      this.emit({ t: 'tool', tool: to, prev, from: { ...p0 }, time });
    } else this.emit({ t: 'state' });
    this.syncPP();
  }
}

function alarmOf(msg) {
  const m = /Alarm (\d+)/.exec(msg || '');
  return m ? +m[1] : null;
}

// ---------------------------------------------------------------------------------- dialect detection
// True when the text looks like a Haas program: a leading "%" line followed by an "Onnnnn" line, or
// Haas-only constructs (#variables, G65, M97/M98 with P) before the first motion.
export function looksHaas(text) {
  const lines = String(text).split('\n', 80);
  let pct = false;
  for (const raw of lines) {
    const l = raw.replace(/\([^)]*\)/g, '').trim().toUpperCase();
    if (!l) continue;
    if (l === '%') { pct = true; continue; }
    if (/^O\d{1,5}\b/.test(l)) return pct || /^O\d{4,5}\s*$/.test(l) && /\(/.test(raw);
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------------- syntax highlight
const HL_KW = /^(IF|GOTO|WHILE|DO\d*|END\d*|THEN|EQ|NE|GT|LT|GE|LE|AND|OR|XOR|MOD|POPEN|PCLOS|DPRNT)/;
export function highlightHaas(text) {
  const spans = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '(') {
      const e = text.indexOf(')', i + 1);
      const stop = e < 0 ? n : e + 1;
      spans.push({ cls: 'c', text: text.slice(i, stop) });
      i = stop;
      continue;
    }
    if (ch === '%' || ch === '/' || ch === ';') { spans.push({ cls: 'p', text: ch }); i++; continue; }
    if (ch === '#') {
      const m = /^#\d+/.exec(text.slice(i));
      const t = m ? m[0] : '#';
      spans.push({ cls: 'rp', text: t });
      i += t.length;
      continue;
    }
    const code = text.charCodeAt(i) & ~32;
    if (code >= 65 && code <= 90) {
      const rest = text.slice(i).toUpperCase();
      const kw = HL_KW.exec(rest);
      const fn = FUNC_NAMES.find((f) => rest.startsWith(f + '['));
      if (fn) { spans.push({ cls: 'q', text: text.slice(i, i + fn.length) }); i += fn.length; continue; }
      if (kw && !/^(DO|END)$/.test(kw[0]) || (kw && /\d/.test(rest[kw[0].length] || ''))) {
        spans.push({ cls: 'kw', text: text.slice(i, i + kw[0].length) });
        i += kw[0].length;
        continue;
      }
      const start = i;
      i++;
      while (i < n && /[0-9.+\-]/.test(text[i])) i++;
      const L = String.fromCharCode(code);
      let cls = 'w';
      if (L === 'G') cls = 'g';
      else if (L === 'M') cls = 'm';
      else if (L === 'X' || L === 'Y' || L === 'Z') cls = 'a' + L.toLowerCase();
      else if (L === 'I' || L === 'J' || L === 'K' || L === 'R') cls = 'r';
      else if (L === 'F' || L === 'S') cls = 'f';
      else if (L === 'T' || L === 'H' || L === 'D') cls = 't';
      else if (L === 'N' || L === 'O') cls = 'n';
      else if (L === 'P' || L === 'Q' || L === 'L') cls = 'q';
      spans.push({ cls, text: text.slice(start, i) });
      continue;
    }
    const start = i;
    while (i < n && !/[A-Za-z(;%/#]/.test(text[i])) i++;
    if (i === start) i++;
    spans.push({ cls: '', text: text.slice(start, i) });
  }
  return spans;
}
