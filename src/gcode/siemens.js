// SINUMERIK 808D-style interpreter (Siemens mode, G290). Compiles a part program into the same timed
// ops as the ISO interpreter, so the controller, Z-map and collision checks are shared.
//
// Supported language (see SIE_REFERENCE for the full list shown in the Reference screen):
//   G0 G1 G2 G3 (I/J/K incremental or =AC(), CR=, TURN=), G4 F/S, G9, G17-G19, G25/G26 S, G40-G42,
//   G53 / SUPA, G54-G59 / G500, G60 G64, G70 G71 G700 G710, G74, G90 G91 (+ AC()/IC() per word),
//   G94 G95, G450 G451; T D M6, S M3 M4 M5, M7 M8 M9, M0 M1 M2 M17 M30; F; RND= CHR=;
//   R0..R299 with arithmetic and functions; TRANS ATRANS ROT AROT (RPL=); MSG(); labels with
//   GOTOF/GOTOB/GOTO/GOTOC and IF <cond> GOTOx; MCALL; drilling and milling cycles (sinucycles.js).
import { Interpreter, GError, PLANES } from './interpreter.js';
import { evaluate, ExprError } from './expr.js';
import { compensate, roundCorner, CompError } from './crc.js';
import { runCycle, CYCLES } from './sinucycles.js';
import { MACHINE, INCH, atcTime, trapTime } from '../config.js';

export const SIE_G = {
  0: ['motion', 'Rapid traverse'], 1: ['motion', 'Linear interpolation with feed'], 2: ['motion', 'Circular interpolation clockwise (I/J/K or CR=, TURN= for helices)'],
  3: ['motion', 'Circular interpolation counter-clockwise'], 4: ['nonmodal', 'Dwell: G4 F<seconds> or G4 S<spindle revolutions>, in its own block'],
  9: ['nonmodal', 'Exact stop, non-modal (accepted; the path is always followed exactly)'],
  17: ['plane', 'Working plane XY'], 18: ['plane', 'Working plane ZX'], 19: ['plane', 'Working plane YZ'],
  25: ['nonmodal', 'Minimum spindle speed limit: G25 S_'], 26: ['nonmodal', 'Maximum spindle speed limit: G26 S_'],
  40: ['crc', 'Tool radius compensation off'], 41: ['crc', 'Tool radius compensation left of the contour'], 42: ['crc', 'Tool radius compensation right of the contour'],
  53: ['nonmodal', 'Suppress work offsets and frames for this block (tool offset stays active)'],
  54: ['wcs', 'Settable work offset 1'], 55: ['wcs', 'Settable work offset 2'], 56: ['wcs', 'Settable work offset 3'],
  57: ['wcs', 'Settable work offset 4'], 58: ['wcs', 'Settable work offset 5'], 59: ['wcs', 'Settable work offset 6'],
  500: ['wcs', 'Deselect settable work offset'],
  60: ['path', 'Exact stop, modal (accepted)'], 64: ['path', 'Continuous-path mode (accepted; no corner blending is simulated)'],
  70: ['units', 'Inch dimensions (geometry)'], 71: ['units', 'Metric dimensions (geometry)'], 700: ['units', 'Inch dimensions and feed'], 710: ['units', 'Metric dimensions and feed'],
  74: ['nonmodal', 'Reference point approach: G74 X1=0 Y1=0 Z1=0'],
  90: ['dist', 'Absolute dimensions'], 91: ['dist', 'Incremental dimensions'],
  94: ['feedmode', 'Feed in mm/min'], 95: ['feedmode', 'Feed in mm/revolution'],
  450: ['corner', 'Transition circle at outside corners with G41/G42 (default)'], 451: ['corner', 'Intersection at outside corners (accepted; the simulator always uses transition circles)'],
};
export const SIE_M = {
  0: 'Programmed stop', 1: 'Conditional (optional) stop, only with M01 active', 2: 'End of program', 3: 'Spindle clockwise', 4: 'Spindle counter-clockwise',
  5: 'Spindle stop', 6: 'Tool change to the preselected T (activates D1)', 7: 'Mist coolant on', 8: 'Coolant on', 9: 'Coolant off', 17: 'End of subprogram (ends the program here)', 30: 'End of program',
  40: 'Automatic gear stage (accepted, no effect)', 41: 'Gear stage 1 (accepted)', 42: 'Gear stage 2 (accepted)',
};
export const SIE_WORDS = {
  'X Y Z': 'Axis positions. Constant (X10.5) or expression (X=R1*2). X=AC(..) absolute, X=IC(..) incremental for one block.',
  'I J K': 'Circle centre, incremental from the start point by default; I=AC(..) for an absolute centre.',
  'CR=': 'Circle radius; negative for arcs greater than 180°.', 'TURN=': 'Number of additional full turns for a helix.',
  'RND=': 'Round the corner to the next straight line with this radius.', 'CHR=': 'Chamfer the corner to the next straight line (leg length).',
  F: 'Feed (mm/min with G94, mm/rev with G95). In a G4 block: dwell in seconds.', S: 'Spindle speed (rpm). In a G4 block: dwell in revolutions.',
  T: 'Tool preselection (T1..T16).', D: 'Tool offset number: D1 activates length and radius of the tool in the spindle, D0 cancels.',
  'R0..R299': 'Arithmetic parameters: R1=10, R2=R1*SIN(30)+5. Functions SIN COS TAN ASIN ACOS ATAN2 SQRT ABS POT TRUNC ROUND EXP LN MINVAL MAXVAL; operators + - * / DIV MOD == <> < > <= >= AND OR XOR NOT.',
  'LABEL:': 'Jump label at the start of a block (two letters or underscore first).',
  'GOTOF/GOTOB/GOTO/GOTOC': 'Jump forwards / backwards / both / both without alarm to a label or block number.',
  'IF cond GOTOF lbl': 'Conditional jump.', 'MSG("text")': 'Show a message in the message line; MSG() clears it.',
  'TRANS/ATRANS': 'Programmable offset (absolute / additive): TRANS X10 Y5.', 'ROT/AROT': 'Programmable rotation in the plane: ROT RPL=30 (or ROT Z30).',
  MCALL: 'Modal call of a drilling cycle at every following position (MCALL CYCLE81(...)); MCALL alone cancels.',
  'SUPA': 'Same as G53 for this simulator.',
};
const NOOP_NAMES = new Set(['SOFT', 'BRISK', 'FFWON', 'FFWOF', 'CFC', 'CFTCP', 'G601', 'G602', 'G603', 'SPATH', 'UPATH']);
const KEYWORDS = new Set(['GOTOF', 'GOTOB', 'GOTO', 'GOTOC', 'IF', 'MCALL', 'TRANS', 'ATRANS', 'ROT', 'AROT', 'SUPA', 'SCALE', 'ASCALE', 'MIRROR', 'AMIRROR', 'RET', 'DIAMON', 'DIAMOF', 'CIP']);
const ADDR = new Set(['G', 'M', 'X', 'Y', 'Z', 'I', 'J', 'K', 'F', 'S', 'T', 'D', 'H', 'L', 'P']);
const ASSIGNABLE = new Set(['X', 'Y', 'Z', 'I', 'J', 'K', 'F', 'S', 'T', 'D', 'CR', 'AR', 'TURN', 'RND', 'CHR', 'RPL', 'X1', 'Y1', 'Z1']);

const E = (code, text) => (code ? `${code} ${text}` : text);

// ---------------------------------------------------------------------------------- line parser
function findComment(s) {
  let q = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"') q = !q;
    else if (s[i] === ';' && !q) return i;
  }
  return -1;
}

function matchParen(s, i) {
  let d = 0, q = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '"') q = !q;
    if (q) continue;
    if (c === '(') d++;
    else if (c === ')') {
      d--;
      if (d === 0) return j;
    }
  }
  return -1;
}

export function splitArgs(inner) {
  const out = [];
  let d = 0, q = false, cur = '';
  for (const c of inner) {
    if (c === '"') q = !q;
    if (!q && c === '(') d++;
    if (!q && c === ')') d--;
    if (!q && d === 0 && c === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function readExpr(s, i) {
  let depth = 0, q = false, j = i, last = '';
  while (j < s.length) {
    const c = s[j];
    if (q) { if (c === '"') q = false; j++; continue; }
    if (c === '"') { q = true; j++; continue; }
    if (c === '(') depth++;
    else if (c === ')') { if (depth === 0) break; depth--; }
    else if ((c === ' ' || c === '\t') && depth === 0) {
      let k = j;
      while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
      if (k >= s.length) return k;
      const prevOp = last === '' || /[+\-*/<>=(,]/.test(last);
      const nextOp = /[+\-*/<>=]/.test(s[k]) || /^(AND|OR|XOR|DIV|MOD)\b/i.test(s.slice(k));
      if (prevOp || nextOp) { j = k; continue; }
      return j;
    }
    if (c !== ' ') last = c;
    j++;
  }
  return j;
}

export function parseSiemens(text) {
  const out = { items: [], label: null, n: null, blockDelete: false, errors: [], comment: '', empty: true };
  let s = text.replace(/\r/g, '');
  const ci = findComment(s);
  if (ci >= 0) {
    out.comment = s.slice(ci + 1).trim();
    s = s.slice(0, ci) + ' '.repeat(s.length - ci);
  }
  let i = 0;
  const n = s.length;
  const skip = () => { while (i < n && (s[i] === ' ' || s[i] === '\t')) i++; };
  const err = (col, len, msg) => out.errors.push({ col, len: Math.max(1, len), msg });
  skip();
  if (s[i] === '%') return out; // file header line, e.g. %_N_PART_MPF
  if (s[i] === '/') { out.blockDelete = true; i++; skip(); }
  let m = /^[N:](\d+)/i.exec(s.slice(i));
  if (m) { out.n = +m[1]; i += m[0].length; skip(); }
  m = /^([A-Za-z_][A-Za-z_][A-Za-z0-9_]*):(?!=)/.exec(s.slice(i));
  if (m) { out.label = m[1].toUpperCase(); i += m[0].length; skip(); }
  while (i < n) {
    skip();
    if (i >= n) break;
    const start = i;
    const c = s[i];
    if (/[A-Za-z_]/.test(c)) {
      // plain address word: one letter followed by a number (X10.5, G1, M30, R1=...)
      const am = /^([A-Za-z])\s*([+-]?(?:\d+\.?\d*|\.\d+))/.exec(s.slice(i));
      if (am && !/[A-Za-z_]/.test(s[i + 1] || '')) {
        const letter = am[1].toUpperCase();
        let j = i + am[0].length;
        let k = j;
        while (k < n && s[k] === ' ') k++;
        if (s[k] === '=' && s[k + 1] !== '=' && /^\d+$/.test(am[2])) {
          // R1=..., X1=0 (G74)
          const e1 = readExpr(s, k + 1);
          const expr = s.slice(k + 1, e1).trim();
          if (!expr) err(start, e1 - start, `Missing value after "${letter}${am[2]}="`);
          out.items.push({ t: 'assign', name: letter + am[2], expr, col: start, len: e1 - start });
          i = e1;
          continue;
        }
        if (letter === 'R') { err(start, j - start, 'R parameters are assigned with R1=value'); i = j; continue; }
        if (!ADDR.has(letter)) { err(start, j - start, `12550 Name "${letter}" not defined (no ${letter} axis or address on this machine)`); i = j; continue; }
        out.items.push({ t: 'word', a: letter, v: parseFloat(am[2]), dec: am[2].includes('.'), col: start, len: j - start });
        i = j;
        continue;
      }
      const im = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
      const id = im[0].toUpperCase();
      let j = i + im[0].length;
      let k = j;
      while (k < n && s[k] === ' ') k++;
      if (s[k] === '(' && !KEYWORDS.has(id)) {
        const end = matchParen(s, k);
        if (end < 0) { err(start, n - start, `Missing ")" after ${id}(`); break; }
        const inner = s.slice(k + 1, end);
        out.items.push({ t: 'call', name: id, args: inner.trim() === '' ? [] : splitArgs(inner), raw: inner, col: start, len: end + 1 - start });
        i = end + 1;
        continue;
      }
      if (s[k] === '=' && s[k + 1] !== '=') {
        const e1 = readExpr(s, k + 1);
        const expr = s.slice(k + 1, e1).trim();
        if (!expr) err(start, e1 - start, `Missing value after "${id}="`);
        out.items.push({ t: 'assign', name: id, expr, col: start, len: e1 - start });
        i = e1;
        continue;
      }
      if (id === 'IF') {
        const rest = s.slice(j);
        const g = /\b(GOTOF|GOTOB|GOTOC|GOTO)\s+([A-Za-z0-9_]+)/i.exec(rest);
        if (!g) { err(start, n - start, 'IF needs a jump: IF <condition> GOTOF <label>'); break; }
        out.items.push({ t: 'if', cond: rest.slice(0, g.index).trim(), jump: g[1].toUpperCase(), target: g[2].toUpperCase(), col: start, len: j + g.index + g[0].length - start });
        i = j + g.index + g[0].length;
        continue;
      }
      if (id === 'GOTOF' || id === 'GOTOB' || id === 'GOTO' || id === 'GOTOC') {
        const g = /^\s+([A-Za-z0-9_]+)/.exec(s.slice(j));
        if (!g) { err(start, j - start, `${id} needs a label`); i = j; continue; }
        out.items.push({ t: 'jump', jump: id, target: g[1].toUpperCase(), col: start, len: j + g[0].length - start });
        i = j + g[0].length;
        continue;
      }
      if (KEYWORDS.has(id) || NOOP_NAMES.has(id)) {
        out.items.push({ t: 'kw', name: id, col: start, len: j - start });
        i = j;
        continue;
      }
      err(start, j - start, `12550 Name "${id}" not defined`);
      i = j;
      continue;
    }
    // junk
    const st = i;
    while (i < n && !/[A-Za-z_\s]/.test(s[i])) i++;
    if (i === st) i++;
    err(st, i - st, `12080 Syntax error: unexpected "${s.slice(st, i)}"`);
  }
  out.empty = !out.items.length;
  return out;
}

// Splits an assignment value into { mode: 'AC'|'IC'|null, expr }.
function acic(expr) {
  const m = /^\s*(AC|IC)\s*\(([\s\S]*)\)\s*$/i.exec(expr);
  return m ? { mode: m[1].toUpperCase(), expr: m[2] } : { mode: null, expr };
}

export function siemensDefault(units = 21) {
  return {
    dialect: 'siemens', units, unitsCode: units === 20 ? 70 : 71, feedInch: false, dist: 90, plane: 17, motion: 0, wcs: 500, feedMode: 94, crc: 40,
    path: 64, corner: 450, tool: 0, selT: null, D: 0, feed: 0, rpm: 0, spindleDir: 0, flood: false, mist: false,
    frame: { tx: 0, ty: 0, tz: 0, rot: 0 }, mcall: null, spMin: 0, spMax: MACHINE.maxRpm, tlo: 49, tloH: 0,
  };
}
const S_KEYS = ['dialect', 'units', 'unitsCode', 'feedInch', 'dist', 'plane', 'motion', 'wcs', 'feedMode', 'crc', 'path', 'corner', 'tool', 'selT', 'D', 'feed', 'rpm', 'spindleDir', 'flood', 'mist', 'spMin', 'spMax'];

// ---------------------------------------------------------------------------------- interpreter
export class SiemensInterpreter extends Interpreter {
  compile(text, init = {}) {
    const lines = text.split(/\r?\n/);
    const res = (this.res = {
      ops: [], errors: [], warnings: [], lineCount: lines.length, totalTime: 0, ended: false, dialect: 'siemens',
      toolsUsed: new Set(), lineFirstOp: new Int32Array(lines.length).fill(-1), tipBounds: null, workBounds: null,
      feedLength: 0, rapidLength: 0, endState: null, messages: [],
    });
    const S = (this.S = Object.assign(siemensDefault(init.units || 21), init.modal && init.modal.dialect === 'siemens' ? init.modal : {}));
    S.frame = { ...(S.frame || { tx: 0, ty: 0, tz: 0, rot: 0 }) };
    S.pos = { ...(init.pos || { x: 0, y: 0, z: 0 }) };
    S.tool = init.tool || 0;
    if (init.modal?.dialect !== 'siemens' && S.tool) S.D = 1;
    S.carousel = init.carousel || 1;
    S.rpmActual = init.rpm || 0;
    S.R = Float64Array.from(init.R || new Float64Array(300));
    const offsets = (this.opts.offsets || []).map((o) => ({ ...o }));
    while (offsets.length < 6) offsets.push({ x: 0, y: 0, z: 0 });
    this.offsets = offsets;
    this.stKey = '';
    this.st = null;
    this.buf = null;
    this.capture = null;
    this.blocks = lines.map((l) => parseSiemens(l));
    this.labels = new Map();
    this.nums = new Map();
    this.blocks.forEach((b, i) => {
      if (b.label) {
        if (this.labels.has(b.label)) res.warnings.push({ line: i, msg: `Label ${b.label} is defined twice; the first one is used` });
        else this.labels.set(b.label, i);
      }
      if (b.n != null && !this.nums.has(b.n)) this.nums.set(b.n, i);
      for (const e of b.errors) res.errors.push({ line: i, col: e.col, len: e.len, msg: e.msg });
    });
    this.syncPP();
    this.snap();
    let pc = 0;
    let executed = 0;
    const MAX = 400000;
    while (pc < lines.length) {
      const blk = this.blocks[pc];
      this.line = pc;
      if (blk.errors.length) break;
      if (blk.empty || (blk.blockDelete && this.opts.blockDelete)) { pc++; continue; }
      if (++executed > MAX) {
        res.errors.push({ line: pc, col: 0, len: 0, msg: `Program loop: more than ${MAX} blocks executed. Check your jump conditions.` });
        break;
      }
      try {
        const next = this.sblock(blk, pc);
        if (res.ended) break;
        pc = next ?? pc + 1;
      } catch (e) {
        if (!(e instanceof GError || e instanceof ExprError || e instanceof CompError)) throw e;
        const line = e instanceof CompError && e.line != null ? e.line : pc;
        res.errors.push({ line, col: e.col || 0, len: e.len || 0, msg: e instanceof ExprError ? `12080 ${e.message}` : e.message });
        break;
      }
    }
    if (!res.errors.length && this.buf) {
      try {
        if (S.crc !== 40) res.warnings.push({ line: this.line, msg: 'Tool radius compensation still active at the end of the program (G40 missing)' });
        this.flush(false);
      } catch (e) {
        if (!(e instanceof CompError)) throw e;
        res.errors.push({ line: e.line ?? this.line, col: 0, len: 0, msg: e.message });
      }
    }
    if (!res.ended && !res.errors.length && res.ops.length) res.warnings.push({ line: lines.length - 1, msg: 'Program has no M30/M2 end' });
    res.endState = this.exportModal();
    res.endPos = { ...S.pos };
    res.endTool = S.tool;
    res.endCarousel = S.carousel;
    res.offsets = offsets;
    res.endR = S.R;
    res.errors.sort((a, b) => a.line - b.line);
    return res;
  }

  // ---------------------------------------------------------------- modal snapshot
  exportModal() {
    const o = {};
    for (const k of S_KEYS) o[k] = this.S[k];
    o.frame = { ...this.S.frame };
    o.mcall = this.S.mcall ? this.S.mcall.name : null;
    o.tlo = this.S.D ? 43 : 49;
    o.tloH = this.S.D;
    return o;
  }

  snap() {
    const S = this.S;
    const tl = this.activeTLO();
    const f = S.frame;
    const key = S_KEYS.map((k) => S[k]).join('|') + `|${f.tx}|${f.ty}|${f.tz}|${f.rot}|${tl}|${S.mcall?.name}`;
    if (key !== this.stKey) {
      this.stKey = key;
      const st = this.exportModal();
      st.tloLen = tl;
      st.codes = [`G${S.motion}`, `G${S.plane}`, `G${S.dist}`, `G${S.unitsCode}`, S.wcs === 500 ? 'G500' : `G${S.wcs}`, `G${S.crc}`, `G${S.path}`, `G${S.feedMode}`, `D${S.D}`].join(' ');
      this.st = Object.freeze(st);
    }
    return this.st;
  }

  activeTLO() {
    const S = this.S;
    return S.D > 0 && S.tool ? this.compLength(S.tool) : 0;
  }

  compRadius() {
    const S = this.S;
    if (!(S.D > 0) || !S.tool) return 0;
    const t = this.opts.tools.get(S.tool);
    return t ? t.diameter / 2 + (t.dRadius || 0) : 0;
  }

  // ---------------------------------------------------------------- coordinates
  wcsOffset() {
    const w = this.S.wcs;
    return w >= 54 && w <= 59 ? this.offsets[w - 54] : { x: 0, y: 0, z: 0 };
  }

  toMachine(p, suppress = false) {
    const S = this.S;
    if (suppress) return { x: p.x, y: p.y, z: p.z + this.activeTLO() };
    const f = S.frame;
    const a = (f.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const o = this.wcsOffset();
    return { x: c * p.x - s * p.y + f.tx + o.x, y: s * p.x + c * p.y + f.ty + o.y, z: p.z + f.tz + o.z + this.activeTLO() };
  }

  toProgram(m) {
    const S = this.S;
    const f = S.frame;
    const o = this.wcsOffset();
    const bx = m.x - o.x - f.tx, by = m.y - o.y - f.ty;
    const a = (-f.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    return { x: c * bx - s * by, y: s * bx + c * by, z: m.z - o.z - f.tz - this.activeTLO() };
  }

  syncPP() {
    if (this.buf) return;
    this.pp = this.toProgram(this.S.pos);
  }

  // ---------------------------------------------------------------- emission (with CRC / RND buffering)
  emit(op) {
    if (this.capture) return op;
    if (this.buf && !this.flushing) {
      op.line = this.line;
      op.st = this.snap();
      this.buf.items.push({ kind: 'other', op, line: this.line });
      this.blockOps++;
      return op;
    }
    return super.emit(op);
  }

  ensureBuffer() {
    if (!this.buf) this.buf = { items: [] };
  }

  pushGeom(item) {
    this.ensureBuffer();
    const items = this.buf.items;
    // RND / CHR pending on the previous geometry element?
    let pi = items.length - 1;
    while (pi >= 0 && items[pi].kind === 'other') pi--;
    const prev = pi >= 0 ? items[pi] : null;
    if (prev && (prev.rnd || prev.chr) && !prev.cornerDone) {
      if (prev.kind !== 'line' || item.kind !== 'line' || prev.rapid || item.rapid) throw new GError(`RND/CHR is only supported between two G1 straight lines in this simulator`);
      const r = roundCorner(prev, item, prev.rnd, prev.chr);
      if (r) {
        const [a, mid, b] = r;
        items[pi] = { ...a, cornerDone: true };
        items.splice(pi + 1, 0, mid);
        Object.assign(item, { s: b.s });
      }
      prev.cornerDone = true;
    }
    items.push(item);
  }

  // Emit buffered geometry. When `final` is true the last element is a G40 retract move.
  flush(withRetract) {
    if (!this.buf) return;
    let items = this.buf.items;
    this.buf = null;
    const crc = this.crcSession;
    if (crc) {
      items = compensate(items, crc.side, crc.r, { approach: true, retract: withRetract });
      this.crcSession = null;
    }
    this.flushing = true;
    try {
      for (const it of items) {
        const keep = this.line;
        this.line = it.line ?? keep;
        if (it.kind === 'other') {
          if (it.op) super.emit(it.op);
          else if (it.fn) it.fn();
        } else this.emitGeomNow(it);
        this.line = keep;
      }
    } finally {
      this.flushing = false;
    }
    this.syncPP();
  }

  emitGeomNow(it) {
    const p0 = this.S.pos;
    if (it.kind === 'line') {
      const m1 = this.toMachine({ x: it.e[0], y: it.e[1], z: it.z1 });
      this.move(it.rapid, [p0.x, p0.y, p0.z, m1.x, m1.y, m1.z], it.feed);
    } else {
      const pts = this.arcPoints({ x: it.s[0], y: it.s[1], z: it.z0 }, { x: it.e[0], y: it.e[1], z: it.z1 }, { x: it.c[0], y: it.c[1] }, it.cw, it.turns || 0, 17);
      const flat = [p0.x, p0.y, p0.z];
      for (let i = 1; i < pts.length; i++) {
        const m = this.toMachine(pts[i]);
        flat.push(m.x, m.y, m.z);
      }
      this.move(false, flat, it.feed);
    }
  }

  // Program-coordinate arc linearisation in the given plane.
  arcPoints(s, e, c, cw, turns, plane) {
    const pl = PLANES[plane];
    const sa = s[pl.a], sb = s[pl.b], ea = e[pl.a], eb = e[pl.b];
    const ca = c[pl.a] ?? c.x, cb = c[pl.b] ?? c.y;
    const rs = Math.hypot(sa - ca, sb - cb), re = Math.hypot(ea - ca, eb - cb);
    const as = Math.atan2(sb - cb, sa - ca), ae = Math.atan2(eb - cb, ea - ca);
    const TAU = Math.PI * 2;
    let sweep = cw ? as - ae : ae - as;
    while (sweep <= 1e-9) sweep += TAU;
    while (sweep > TAU + 1e-9) sweep -= TAU;
    sweep += TAU * (turns || 0);
    const r = Math.max(rs, re, 1e-6);
    const tol = this.opts.arcTol || 0.01;
    const stepAng = tol < r ? 2 * Math.acos(1 - tol / r) : Math.PI / 4;
    const n = Math.max(2, Math.min(20000, Math.ceil(sweep / Math.min(stepAng, Math.PI / 8))));
    const dir = cw ? -1 : 1;
    const out = [{ ...s }];
    const sc = s[pl.c], ec = e[pl.c];
    for (let k = 1; k <= n; k++) {
      if (k === n) { out.push({ ...e }); break; }
      const f = k / n;
      const th = as + dir * sweep * f;
      const rr = rs + (re - rs) * f;
      const q = { x: 0, y: 0, z: 0 };
      q[pl.a] = ca + rr * Math.cos(th);
      q[pl.b] = cb + rr * Math.sin(th);
      q[pl.c] = sc + (ec - sc) * f;
      out.push(q);
    }
    return out;
  }

  // Straight move in program coordinates (respects CRC/RND buffering).
  progLine(rapid, to, feed, extra = {}) {
    const from = this.pp;
    const xy = Math.abs(to.x - from.x) > 1e-9 || Math.abs(to.y - from.y) > 1e-9;
    if (this.capture) {
      this.capture.push({ kind: 'line', s: [from.x, from.y], e: [to.x, to.y], z0: from.z, z1: to.z, rapid, feed, line: this.line });
      this.pp = { ...to };
      return;
    }
    if (this.buf || extra.rnd || extra.chr || this.S.crc !== 40) {
      if (this.S.crc !== 40 && this.S.plane !== 17) throw new GError('Tool radius compensation is only supported in G17 (XY plane) in this simulator');
      if (!xy && this.buf) {
        // Z-only move inside a compensated / rounded section
        const zTo = to.z;
        const r = rapid, f = feed;
        this.buf.items.push({ kind: 'other', line: this.line, fn: () => {
          const p = this.S.pos;
          const m = this.toMachine({ x: 0, y: 0, z: zTo });
          this.move(r, [p.x, p.y, p.z, p.x, p.y, m.z], f);
        } });
      } else if (xy || this.S.crc !== 40) {
        this.pushGeom({ kind: 'line', s: [from.x, from.y], e: [to.x, to.y], z0: from.z, z1: to.z, rapid, feed, line: this.line, rnd: extra.rnd, chr: extra.chr });
      }
      this.pp = { ...to };
      if (!this.crcSession && this.buf && !this.pendingCorner()) this.flush(false);
      return;
    }
    const p0 = this.S.pos;
    const m1 = this.toMachine(to);
    this.move(rapid, [p0.x, p0.y, p0.z, m1.x, m1.y, m1.z], feed);
    this.pp = { ...to };
  }

  pendingCorner() {
    const items = this.buf?.items || [];
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].kind === 'other') continue;
      return !!(items[i].rnd || items[i].chr) && !items[i].cornerDone;
    }
    return false;
  }

  progArc(to, center, cw, turns, feed) {
    const S = this.S;
    const from = this.pp;
    if (this.capture) {
      this.capture.push({ kind: 'arc', s: [from.x, from.y], e: [to.x, to.y], c: [center.x, center.y], cw, turns, z0: from.z, z1: to.z, feed, line: this.line });
      this.pp = { ...to };
      return;
    }
    if (this.buf || S.crc !== 40) {
      if (S.plane !== 17) throw new GError('Arcs with tool radius compensation or RND are only supported in G17 in this simulator');
      if (turns) throw new GError('TURN= helices are not supported with tool radius compensation in this simulator');
      this.pushGeom({ kind: 'arc', s: [from.x, from.y], e: [to.x, to.y], c: [center.x, center.y], cw, z0: from.z, z1: to.z, feed, line: this.line });
      this.pp = { ...to };
      if (!this.crcSession && !this.pendingCorner()) this.flush(false);
      return;
    }
    const pts = this.arcPoints(from, to, center, cw, turns, S.plane);
    const p0 = S.pos;
    const flat = [p0.x, p0.y, p0.z];
    for (let i = 1; i < pts.length; i++) {
      const m = this.toMachine(pts[i]);
      flat.push(m.x, m.y, m.z);
    }
    this.move(false, flat, feed);
    this.pp = { ...to };
  }

  // ---------------------------------------------------------------- evaluation helpers
  ev(expr) {
    return evaluate(expr, { R: this.S.R });
  }

  feedNow(word) {
    const S = this.S;
    if (this.capture) return S.feed || 1;
    if (!(S.feed > 0)) throw new GError('10860 No feedrate programmed: add F before the first G1/G2/G3', word);
    if (S.feedMode === 95) {
      const rpm = Math.abs(S.rpmActual || 0);
      if (!(rpm > 0)) throw new GError('G95 feed per revolution needs a running spindle', word);
      return S.feed * rpm;
    }
    return S.feed;
  }

  // ---------------------------------------------------------------- block execution
  sblock(blk, pc) {
    const S = this.S;
    this.blockOps = 0;
    const W = {};
    const A = {};
    const gs = [];
    const ms = [];
    const calls = [];
    const kws = [];
    let jump = null;
    const sc = () => (S.units === 20 ? INCH : 1);
    // 1. collect, evaluating R assignments in order
    for (const it of blk.items) {
      if (it.t === 'word') {
        if (it.a === 'G') gs.push(it);
        else if (it.a === 'M') ms.push(it);
        else {
          if (W[it.a] || A[it.a]) throw new GError(`12080 Address ${it.a} programmed twice in one block`, it);
          W[it.a] = it;
        }
      } else if (it.t === 'assign') {
        if (/^R\d+$/.test(it.name)) {
          const n = +it.name.slice(1);
          if (n > 299) throw new GError(`12550 ${it.name} does not exist (R0..R299)`, it);
          S.R[n] = this.ev(it.expr);
        } else {
          if (W[it.name] || A[it.name]) throw new GError(`12080 Address ${it.name} programmed twice in one block`, it);
          A[it.name] = it;
        }
      } else if (it.t === 'call') calls.push(it);
      else if (it.t === 'kw') kws.push(it);
      else if (it.t === 'jump' || it.t === 'if') jump = it;
    }
    for (const name of Object.keys(A)) {
      if (name === 'AR') throw new GError('AR= (opening angle) is not supported; program the arc with CR= or I/J', A[name]);
      if (!ASSIGNABLE.has(name)) throw new GError(`12550 Name "${name}" not defined`, A[name]);
    }
    const kw = new Set(kws.map((k) => k.name));
    for (const k of ['SCALE', 'ASCALE', 'MIRROR', 'AMIRROR']) if (kw.has(k)) throw new GError(`${k} is not supported in this simulator`, kws.find((x) => x.name === k));
    if (kw.has('CIP')) throw new GError('CIP (circle through intermediate point) is not supported; use G2/G3', kws.find((x) => x.name === 'CIP'));
    if (kw.has('DIAMON') || kw.has('DIAMOF')) throw new GError('DIAMON/DIAMOF are turning functions', kws[0]);
    if (kw.has('RET')) throw new GError('Subprograms (RET) are not supported; use labels and jumps', kws[0]);
    if (W.L) throw new GError('Subprogram calls (L...) are not supported in this simulator', W.L);
    if (W.P) throw new GError('P (program repetitions) is not supported', W.P);
    if (W.H) this.warn(`H${W.H.v} auxiliary function ignored`);
    const val = (name) => {
      if (W[name]) return { v: W[name].v, mode: null, src: W[name] };
      if (A[name]) {
        const { mode, expr } = acic(A[name].expr);
        return { v: this.ev(expr), mode, src: A[name] };
      }
      return null;
    };
    // 2. G codes
    const G = {};
    for (const g of gs) {
      const k = g.v;
      const def = SIE_G[k];
      if (k === 290 && !this.res.ops.length) continue; // Siemens mode is already active
      if (k === 290 || k === 291) throw new GError('G290/G291 must be the first command of the program (switching dialect mid-program is not supported)', g);
      if (k === 96 || k === 97) throw new GError(`G${k} constant cutting speed is a turning function`, g);
      if (k === 110 || k === 111 || k === 112) throw new GError('Polar coordinates (G110-G112) are not supported in this simulator', g);
      if (k === 28) throw new GError('G28 is an ISO code; in Siemens mode use G74 Z1=0 (or switch the program to ISO with G291)', g);
      if (k === 43 || k === 49) throw new GError(`G${k} is an ISO code; in Siemens mode tool length is activated with D1 (D0 cancels)`, g);
      if (!def) throw new GError(`12470 G${k} is not a known G function`, g);
      if (G[def[0]] !== undefined && def[0] !== 'nonmodal') throw new GError(`12080 G${k} conflicts with G${G[def[0]]} (same group)`, g);
      if (def[0] === 'nonmodal' && G.nonmodal !== undefined) throw new GError(`12080 G${k} and G${G.nonmodal} in one block`, g);
      G[def[0]] = k;
    }
    const supa = kw.has('SUPA') || G.nonmodal === 53;
    const M = {};
    for (const m of ms) {
      const k = m.v;
      if (!(k in SIE_M)) {
        if (k === 98 || k === 99) throw new GError(`M${k} is an ISO subprogram code; not supported`, m);
        if (k === 19) throw new GError('M19 / SPOS spindle positioning is handled by the tool changer', m);
        throw new GError(`M${k} is not a known M function`, m);
      }
      const grp = [3, 4, 5].includes(k) ? 'sp' : [7, 8, 9].includes(k) ? 'cool' : [0, 1, 2, 17, 30].includes(k) ? 'stop' : k === 6 ? 'tc' : 'gear';
      if (M[grp] !== undefined && grp !== 'gear') throw new GError(`12080 M${k} conflicts with M${M[grp]} in one block`, m);
      M[grp] = k;
    }
    // 3. units
    if (G.units !== undefined) {
      S.units = G.units === 70 || G.units === 700 ? 20 : 21;
      S.unitsCode = G.units === 700 ? 70 : G.units === 710 ? 71 : G.units;
      S.feedInch = G.units === 700;
    }
    const k = sc();
    const dwell = G.nonmodal === 4;
    const spLimit = G.nonmodal === 25 || G.nonmodal === 26;
    // 4. feed and speed (not in G4/G25/G26 blocks where F/S have other meanings)
    const fv = val('F');
    if (fv && !dwell) {
      if (!(fv.v > 0)) throw new GError('Feed F must be greater than zero', fv.src);
      S.feed = fv.v * (S.feedInch ? INCH : 1);
      if (S.feedMode === 94 && S.feed > MACHINE.maxFeed) this.warn(`F${fv.v} exceeds the maximum feed of ${MACHINE.maxFeed} mm/min; it is limited`);
    }
    const sv = val('S');
    if (sv && spLimit) {
      if (G.nonmodal === 26) S.spMax = Math.min(MACHINE.maxRpm, sv.v);
      else S.spMin = sv.v;
    } else if (sv && !dwell) {
      if (sv.v < 0) throw new GError('Spindle speed cannot be negative', sv.src);
      if (sv.v > MACHINE.maxRpm) throw new GError(`S${sv.v} exceeds the ${MACHINE.maxRpm} rpm maximum spindle speed`, sv.src);
      S.rpm = Math.min(sv.v, S.spMax);
      if (sv.v > S.spMax) this.warn(`S${sv.v} limited to the G26 maximum of ${S.spMax} rpm`);
    }
    // 5. tool selection and change
    const tv = val('T');
    if (tv) {
      if (tv.v % 1 || tv.v < 0) throw new GError(`T${tv.v} is not a valid tool number`, tv.src);
      if (tv.v !== 0 && !this.opts.tools.get(tv.v)) throw new GError(`17190 T${tv.v} is not in the tool list (OFFSET > Tool list)`, tv.src);
      S.selT = tv.v;
    }
    const dv = val('D');
    if (M.tc === 6) {
      if (this.buf) throw new GError('Tool change is not allowed with active tool radius compensation (program G40 first)', ms.find((m) => m.v === 6));
      if (S.selT == null) throw new GError('M6 needs a preselected tool: T1 M6', ms.find((m) => m.v === 6));
      const to = S.selT;
      if (to !== S.tool) {
        if (S.spindleDir) this.spindleOp(0, 0);
        const p0 = S.pos;
        const zTime = trapTime(Math.abs(p0.z), MACHINE.rapidZ / 60, MACHINE.accel);
        const time = zTime + atcTime(S.tool, to, S.carousel);
        const prev = S.tool;
        S.pos = { x: p0.x, y: p0.y, z: 0 };
        S.tool = to;
        S.carousel = to || prev || S.carousel;
        if (to) this.res.toolsUsed.add(to);
        S.D = to ? 1 : 0;
        this.emit({ t: 'tool', tool: to, prev, from: { ...p0 }, time });
      } else if (!dv) S.D = S.tool ? 1 : 0;
      this.syncPP();
    }
    if (dv) {
      if (dv.v % 1 || dv.v < 0) throw new GError(`D${dv.v} is not a valid offset number`, dv.src);
      if (dv.v > 1) throw new GError(`17020 D${dv.v}: each tool in this simulator has one cutting edge (D1)`, dv.src);
      if (dv.v === 1 && !S.tool) throw new GError('D1 needs a tool in the spindle (T.. M6 first)', dv.src);
      if (this.buf && dv.v !== S.D) throw new GError('Changing D with active tool radius compensation is not allowed', dv.src);
      S.D = dv.v;
      this.syncPP();
    }
    // 6. spindle and coolant on
    if (M.sp === 3 || M.sp === 4) {
      if (!(S.rpm > 0)) throw new GError(`M${M.sp} needs a spindle speed S`, ms.find((m) => m.v === M.sp));
      this.spindleOp(S.rpm, M.sp === 3 ? 1 : -1);
    } else if (sv && !dwell && !spLimit && S.spindleDir && M.sp === undefined) this.spindleOp(S.rpm, S.spindleDir);
    if (M.cool === 7 || M.cool === 8) {
      if (M.cool === 7) S.mist = true; else S.flood = true;
      this.emit({ t: 'coolant', flood: S.flood, mist: S.mist });
    }
    // 7. dwell
    if (dwell) {
      let sec;
      if (fv) sec = fv.v;
      else if (sv) {
        const rpm = Math.abs(S.rpmActual || 0);
        if (!(rpm > 0)) throw new GError('G4 S.. (revolutions) needs a running spindle', sv.src);
        sec = (sv.v / rpm) * 60;
      } else throw new GError('G4 needs F (seconds) or S (spindle revolutions)', gs.find((g) => g.v === 4));
      this.emit({ t: 'dwell', sec, time: sec });
    }
    // 8. modal settings
    if (G.plane !== undefined) {
      if (S.crc !== 40 && G.plane !== S.plane) throw new GError('Changing the plane with active tool radius compensation is not allowed');
      S.plane = G.plane;
    }
    if (G.wcs !== undefined) {
      if (this.buf) throw new GError('Changing the work offset with active tool radius compensation is not allowed');
      S.wcs = G.wcs;
      this.syncPP();
    }
    if (G.dist !== undefined) S.dist = G.dist;
    if (G.feedmode !== undefined) S.feedMode = G.feedmode;
    if (G.path !== undefined) S.path = G.path;
    if (G.corner !== undefined) S.corner = G.corner;
    // 9. frames (blocks of their own)
    const frameKw = ['TRANS', 'ATRANS', 'ROT', 'AROT'].find((x) => kw.has(x));
    if (frameKw) {
      if (this.buf) throw new GError('Frames cannot change with active tool radius compensation');
      const f = S.frame;
      const a = (f.rot * Math.PI) / 180;
      if (frameKw === 'TRANS' || frameKw === 'ATRANS') {
        const d = { x: (val('X')?.v || 0) * k, y: (val('Y')?.v || 0) * k, z: (val('Z')?.v || 0) * k };
        if (frameKw === 'TRANS') S.frame = { tx: d.x, ty: d.y, tz: d.z, rot: 0 };
        else S.frame = { tx: f.tx + Math.cos(a) * d.x - Math.sin(a) * d.y, ty: f.ty + Math.sin(a) * d.x + Math.cos(a) * d.y, tz: f.tz + d.z, rot: f.rot };
      } else {
        if (val('X') || val('Y')) throw new GError('Only rotation in the XY plane (RPL= or Z) is supported');
        const ang = val('RPL')?.v ?? val('Z')?.v ?? 0;
        if (frameKw === 'ROT') S.frame = { tx: 0, ty: 0, tz: 0, rot: ang };
        else S.frame = { ...f, rot: f.rot + ang };
      }
      this.syncPP();
      this.emit({ t: 'state' });
      return this.doJump(jump, pc);
    }
    // 10. MSG
    for (const c of calls.filter((x) => x.name === 'MSG')) {
      const m = /^\s*"([^"]*)"\s*$/.exec(c.raw);
      const text = m ? m[1] : c.raw.trim() === '' ? '' : String(this.ev(c.raw));
      this.emit({ t: 'msg', text });
      this.res.messages.push(text);
    }
    // 11. cutter radius compensation selection
    const crcBefore = S.crc;
    if (G.crc !== undefined && G.crc !== S.crc) {
      if (G.crc !== 40) {
        if (S.crc !== 40) throw new GError(`Switch G41/G42 via G40 first`);
        const r = this.compRadius();
        if (!(r > 0)) throw new GError('10750 Tool radius compensation activated without a tool offset (program T.. M6 and D1)');
        this.flush(false);
        this.crcSession = { side: G.crc === 41 ? 1 : -1, r };
        this.ensureBuffer();
      }
      S.crc = G.crc;
    }
    // 12. motion
    const motionG = G.motion;
    if (motionG !== undefined) S.motion = motionG;
    const ax = { X: val('X'), Y: val('Y'), Z: val('Z') };
    const hasAxis = !!(ax.X || ax.Y || ax.Z);
    let moved = false;
    if (G.nonmodal === 74) {
      if (this.buf) throw new GError('G74 is not allowed with active tool radius compensation');
      const h = { ...S.pos };
      let any = false;
      for (const a of ['X', 'Y', 'Z']) if (A[a + '1'] || W[a + '1']) { h[a.toLowerCase()] = 0; any = true; }
      if (!any) throw new GError('G74 needs the axes to reference: G74 Z1=0 or G74 X1=0 Y1=0 Z1=0');
      this.line3(true, h.x, h.y, h.z);
      this.syncPP();
    } else if (supa) {
      if (this.buf) throw new GError('G53/SUPA is not allowed with active tool radius compensation');
      if (S.motion !== 0 && S.motion !== 1) throw new GError('G53/SUPA needs G0 or G1');
      const p = S.pos;
      const tl = this.activeTLO();
      const t = { x: ax.X ? ax.X.v * k : p.x, y: ax.Y ? ax.Y.v * k : p.y, z: ax.Z ? ax.Z.v * k + tl : p.z };
      if (S.motion === 1) this.feedNow();
      this.line3(S.motion === 0, t.x, t.y, t.z);
      this.syncPP();
      moved = hasAxis;
    } else {
      const arcWords = val('I') || val('J') || val('K') || val('CR') || val('TURN');
      if ((S.motion === 2 || S.motion === 3) && (hasAxis || arcWords)) {
        this.doArc(ax, val, k, gs.find((g) => g.v === 2 || g.v === 3) || blk.items[0]);
        moved = true;
      } else if (hasAxis) {
        const t = this.targetOf(ax, k);
        if (S.motion === 1) {
          const f = this.feedNow(gs.find((g) => g.v === 1) || ax.X?.src || ax.Y?.src || ax.Z?.src);
          this.progLine(false, t, f, { rnd: val('RND')?.v, chr: val('CHR')?.v });
        } else {
          if (val('RND') || val('CHR')) throw new GError('RND/CHR need G1');
          this.progLine(true, t, 0);
        }
        moved = true;
      } else if (val('RND') || val('CHR')) {
        throw new GError('RND/CHR must be in a block with a G1 move');
      }
    }
    // switching compensation off: the G40 block's move is the retract
    if (crcBefore !== 40 && S.crc === 40) this.flush(moved);
    // 13. spindle stop / coolant off after motion
    if (M.sp === 5) this.spindleOp(0, 0);
    if (M.cool === 9) {
      S.flood = false;
      S.mist = false;
      this.emit({ t: 'coolant', flood: false, mist: false });
    }
    // 14. cycles
    if (kw.has('MCALL')) {
      const c = calls.find((x) => CYCLES[x.name]);
      if (c) {
        if (!CYCLES[c.name].modal) throw new GError(`${c.name} cannot be called modally (MCALL is for drilling cycles)`, c);
        S.mcall = { name: c.name, args: c.args.map((a) => this.argVal(a)) };
      } else S.mcall = null;
      this.emit({ t: 'state' });
    } else {
      for (const c of calls) {
        if (c.name === 'MSG') continue;
        if (!CYCLES[c.name]) throw new GError(`12550 ${c.name} is not a known cycle (see Reference)`, c);
        if (this.buf) throw new GError('Cycles must be called with G40 (no active tool radius compensation)', c);
        this.callCycle(c.name, c.args.map((a) => this.argVal(a)), c);
        moved = false;
      }
      if (S.mcall && moved && (ax.X || ax.Y)) {
        if (this.buf) throw new GError('MCALL positions cannot use tool radius compensation');
        this.callCycle(S.mcall.name, S.mcall.args, blk.items[0]);
      }
    }
    // 15. program stops
    if (M.stop === 0 || M.stop === 1) {
      if (this.buf) this.flush(false);
      this.emit({ t: 'stop', optional: M.stop === 1 });
    }
    if (M.stop === 2 || M.stop === 30 || M.stop === 17) {
      if (this.buf) {
        this.warn('Program ended with tool radius compensation active');
        this.flush(false);
      }
      if (S.spindleDir) this.spindleOp(0, 0);
      if (S.flood || S.mist) {
        S.flood = false;
        S.mist = false;
        this.emit({ t: 'coolant', flood: false, mist: false });
      }
      this.emit({ t: 'end', rewind: M.stop === 30 });
      this.res.ended = true;
      return null;
    }
    if (!this.blockOps) {
      const before = this.stKey;
      this.snap();
      if (this.stKey !== before) this.emit({ t: 'state' });
    }
    return this.doJump(jump, pc);
  }

  argVal(a) {
    if (a === '' || a == null) return undefined;
    const m = /^\s*"([^"]*)"\s*$/.exec(a);
    if (m) return m[1];
    return this.ev(a);
  }

  doJump(jump, pc) {
    if (!jump) return null;
    if (jump.t === 'if' && !this.ev(jump.cond)) return null;
    const target = jump.target;
    let line = this.labels.get(target);
    if (line == null && /^N\d+$/.test(target)) line = this.nums.get(+target.slice(1));
    if (line == null) {
      if (jump.jump === 'GOTOC') return null;
      throw new GError(`14080 Jump destination ${target} not found`, jump);
    }
    if (jump.jump === 'GOTOF' && line <= pc) throw new GError(`14080 Jump destination ${target} not found forwards (GOTOF searches towards the end)`, jump);
    if (jump.jump === 'GOTOB' && line >= pc) throw new GError(`14080 Jump destination ${target} not found backwards (GOTOB searches towards the start)`, jump);
    return line;
  }

  targetOf(ax, k) {
    const S = this.S;
    const t = { ...this.pp };
    for (const a of ['X', 'Y', 'Z']) {
      const v = ax[a];
      if (!v) continue;
      const abs = v.mode ? v.mode === 'AC' : S.dist === 90;
      const key = a.toLowerCase();
      t[key] = abs ? v.v * k : t[key] + v.v * k;
    }
    return t;
  }

  doArc(ax, val, k, word) {
    const S = this.S;
    const f = this.feedNow(word);
    const pl = PLANES[S.plane];
    const t = this.targetOf(ax, k);
    const s = this.pp;
    const cw = S.motion === 2;
    const turns = val('TURN')?.v || 0;
    if (turns % 1 || turns < 0) throw new GError('TURN= must be a whole number >= 0', word);
    const cr = val('CR');
    let c = {};
    const sa = s[pl.a], sb = s[pl.b], ea = t[pl.a], eb = t[pl.b];
    if (cr) {
      const R = cr.v * k;
      const da = ea - sa, db = eb - sb, d = Math.hypot(da, db);
      if (d < 1e-7) throw new GError('14040 Error in end point of circle: CR= cannot describe a full circle (use I/J)', cr.src);
      if (d > 2 * Math.abs(R) + 1e-4) throw new GError(`14040 Error in end point of circle: radius ${Math.abs(R).toFixed(3)} too small for the chord ${d.toFixed(3)}`, cr.src);
      const h = Math.sqrt(Math.max(0, R * R - (d / 2) ** 2));
      const sgn = (cw ? 1 : -1) * (R > 0 ? 1 : -1);
      c[pl.a] = (sa + ea) / 2 + (sgn * h * db) / d;
      c[pl.b] = (sb + eb) / 2 - (sgn * h * da) / d;
    } else {
      const ia = val(pl.ia), ib = val(pl.ib);
      if (!ia && !ib) throw new GError(`14040 G${S.motion} needs ${pl.ia}/${pl.ib} (centre) or CR= (radius)`, word);
      const o = { x: 0, y: 0, z: 0 };
      c[pl.a] = ia ? (ia.mode === 'AC' ? ia.v * k : sa + ia.v * k) : sa;
      c[pl.b] = ib ? (ib.mode === 'AC' ? ib.v * k : sb + ib.v * k) : sb;
      void o;
      const rs = Math.hypot(sa - c[pl.a], sb - c[pl.b]), re = Math.hypot(ea - c[pl.a], eb - c[pl.b]);
      if (rs < 1e-6) throw new GError('14040 Error in end point of circle: the centre is on the start point', word);
      if (Math.abs(rs - re) > Math.max(0.02, rs * 0.001)) throw new GError(`14040 Error in end point of circle: start radius ${rs.toFixed(4)}, end radius ${re.toFixed(4)}`, word);
    }
    if (S.crc !== 40 && turns) throw new GError('TURN= helices are not supported with tool radius compensation');
    const center = S.plane === 17 ? { x: c.x, y: c.y } : c;
    this.progArc(t, center, cw, turns, f);
  }

  // ---------------------------------------------------------------- cycle support API
  callCycle(name, args, word) {
    const S = this.S;
    if (S.plane !== 17) throw new GError(`${name}: cycles are only supported in G17 in this simulator`, word);
    this.cycleWord = word;
    runCycle(name, this, args);
    this.syncPP();
  }

  cErr(msg) {
    throw new GError(msg, this.cycleWord);
  }

  cNeedTool(name, spindle = true) {
    const S = this.S;
    if (!S.tool || !S.D) this.cErr(`61000 ${name}: no tool offset active (T.. M6 and D1)`);
    if (spindle && !S.spindleDir) this.cErr(`61102 ${name}: no spindle direction programmed (M3/M4)`);
  }

  cFeedDefault() {
    return this.feedNow(this.cycleWord);
  }

  cPos() {
    return { ...this.pp };
  }

  cRapid(p) {
    const q = { ...this.pp, ...p };
    if (Math.hypot(q.x - this.pp.x, q.y - this.pp.y, q.z - this.pp.z) < 1e-9) return;
    this.progLine(true, q, 0);
  }

  cFeed(p, f) {
    const q = { ...this.pp, ...p };
    if (Math.hypot(q.x - this.pp.x, q.y - this.pp.y, q.z - this.pp.z) < 1e-9) return;
    this.progLine(false, q, Math.min(f, MACHINE.maxFeed));
  }

  // arc in XY to `p` (x, y and optional z) around centre c
  cArc(p, c, cw, f, turns = 0) {
    const q = { ...this.pp, ...p };
    this.progArc(q, { x: c.x, y: c.y }, cw, turns, Math.min(f, MACHINE.maxFeed));
  }

  cDwell(sec) {
    if (sec > 0) this.emit({ t: 'dwell', sec, time: sec });
  }

  cToolR() {
    return this.compRadius();
  }

  // Spindle direction aware climb milling: for M3 a pocket wall is climb-milled counter-clockwise.
  cClimbCCW() {
    return this.S.spindleDir >= 0;
  }

  // Contour elements between two labels, captured without executing them.
  cContour(kname) {
    if (typeof kname !== 'string') this.cErr('CYCLE72 needs a contour name like "START:END"');
    const [a, b] = kname.split(':').map((s) => s.trim().toUpperCase());
    const la = this.labels.get(a), lb = this.labels.get(b || a);
    if (la == null || lb == null || lb < la) this.cErr(`14080 Contour labels "${kname}" not found in this program`);
    const saved = { pp: { ...this.pp }, S: { ...this.S, frame: { ...this.S.frame } }, line: this.line, buf: this.buf, crc: this.crcSession };
    this.capture = [];
    this.buf = null;
    try {
      for (let i = la; i <= lb; i++) {
        const blk = this.blocks[i];
        if (blk.empty) continue;
        this.line = i;
        for (const it of blk.items) {
          if (it.t === 'call' || it.t === 'jump' || it.t === 'if') this.cErr(`Contour ${kname}: only G0/G1/G2/G3 moves are allowed inside the contour definition (line ${i + 1})`);
        }
        this.sblock(blk, i);
      }
    } finally {
      const geo = this.capture;
      this.capture = null;
      Object.assign(this.S, saved.S);
      this.pp = saved.pp;
      this.line = saved.line;
      this.buf = saved.buf;
      this.crcSession = saved.crc;
      this._contour = geo;
    }
    const geo = this._contour;
    if (geo.length < 2) this.cErr(`Contour ${kname} needs a start position and at least one element`);
    const start = { x: geo[0].e[0], y: geo[0].e[1] };
    const els = geo.slice(1);
    return { start, els };
  }
}

export const SIE_CYCLES = CYCLES;

// ---------------------------------------------------------------------------------- syntax highlight
const HL_KW = new Set([...KEYWORDS, 'MSG', 'AC', 'IC', 'AND', 'OR', 'XOR', 'NOT', 'DIV', 'MOD']);
export function highlightSiemens(text) {
  const spans = [];
  const ci = findComment(text);
  const code = ci >= 0 ? text.slice(0, ci) : text;
  let i = 0;
  const n = code.length;
  const lm = /^(\s*(?:\/\s*)?(?:N\d+\s*)?)([A-Za-z_][A-Za-z_][A-Za-z0-9_]*:)(?!=)/.exec(code);
  if (lm) {
    const pre = lm[1];
    const nm = /N\d+/i.exec(pre);
    if (nm) {
      spans.push({ cls: '', text: pre.slice(0, nm.index) });
      spans.push({ cls: 'n', text: nm[0] });
      spans.push({ cls: '', text: pre.slice(nm.index + nm[0].length) });
    } else spans.push({ cls: '', text: pre });
    spans.push({ cls: 'lb', text: lm[2] });
    i = lm[0].length;
  }
  while (i < n) {
    const c = code[i];
    if (c === '"') {
      const e = code.indexOf('"', i + 1);
      const stop = e < 0 ? n : e + 1;
      spans.push({ cls: 'c', text: code.slice(i, stop) });
      i = stop;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const am = /^([A-Za-z])(\s*[+-]?(?:\d+\.?\d*|\.\d+))/.exec(code.slice(i));
      if (am && !/[A-Za-z_]/.test(code[i + 1] || '')) {
        const L = am[1].toUpperCase();
        let cls = 'w';
        if (L === 'G') cls = 'g';
        else if (L === 'M') cls = 'm';
        else if (L === 'X' || L === 'Y' || L === 'Z') cls = 'a' + L.toLowerCase();
        else if (L === 'I' || L === 'J' || L === 'K') cls = 'r';
        else if (L === 'F' || L === 'S') cls = 'f';
        else if (L === 'T' || L === 'D') cls = 't';
        else if (L === 'N') cls = 'n';
        else if (L === 'R') cls = 'rp';
        spans.push({ cls, text: am[0] });
        i += am[0].length;
        continue;
      }
      const im = /^[A-Za-z_][A-Za-z0-9_]*/.exec(code.slice(i));
      const id = im[0].toUpperCase();
      let cls = '';
      if (CYCLES[id]) cls = 'cy';
      else if (HL_KW.has(id) || id.startsWith('GOTO') || id === 'IF') cls = 'kw';
      else if (/^R\d+$/.test(id)) cls = 'rp';
      else if (['CR', 'TURN', 'RND', 'CHR', 'RPL', 'AR'].includes(id)) cls = 'r';
      else if (/^[XYZ]1?$/.test(id)) cls = 'a' + id[0].toLowerCase();
      else if (['F', 'S'].includes(id)) cls = 'f';
      else if (['T', 'D'].includes(id)) cls = 't';
      else if (/^(SIN|COS|TAN|ASIN|ACOS|ATAN2|SQRT|ABS|POT|TRUNC|ROUND|ROUNDUP|EXP|LN|MINVAL|MAXVAL)$/.test(id)) cls = 'q';
      spans.push({ cls, text: im[0] });
      i += im[0].length;
      continue;
    }
    const st = i;
    while (i < n && !/[A-Za-z_"]/.test(code[i])) i++;
    if (i === st) i++;
    spans.push({ cls: '', text: code.slice(st, i) });
  }
  if (ci >= 0) spans.push({ cls: 'c', text: text.slice(ci) });
  return spans;
}
