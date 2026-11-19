// G-code interpreter. Compiles a program into a flat list of timed operations ("ops") that the
// controller executes. Compiling ahead of time (like the graphics/verify mode on a real control) gives
// us exact over-travel checks, the toolpath preview, cycle time estimates and progress tracking, while
// execution still happens block by block with the source line of every op preserved.
//
// Op types
//   move    { rapid, pts (Float64Array xyz...), cum, len, feed, vmax, tool, tlen }
//   spindle { rpm, dir }          coolant { flood, mist }       tool { tool, prev }
//   dwell   { sec }               stop { optional }             end { rewind }
//   offset  { index, x, y, z }    state {}  (modal-only blocks, so the DRO updates at the right time)
// Every op has { t, line, st (modal snapshot), time (estimated seconds) }.

import { G_CODES, M_CODES, UNSUPPORTED_G, UNSUPPORTED_M, ALLOWED_LETTERS, gKey, gName, mName } from './codes.js';
import { parseLine } from './parser.js';
import { MACHINE, INCH, atcTime, trapTime } from '../config.js';

export class GError extends Error {
  constructor(msg, word) {
    super(msg);
    this.col = word ? word.col : 0;
    this.len = word ? word.len : 0;
  }
}

const AXES = ['x', 'y', 'z'];
export const PLANES = {
  17: { a: 'x', b: 'y', c: 'z', ia: 'I', ib: 'J' },
  18: { a: 'z', b: 'x', c: 'y', ia: 'K', ib: 'I' },
  19: { a: 'y', b: 'z', c: 'x', ia: 'J', ib: 'K' },
};

export function defaultModal(units = 21) {
  return {
    dialect: 'iso', units, dist: 90, arcDist: 91.1, plane: 17, motion: 0, cycle: 80, wcs: 54, tlo: 49, tloH: 0,
    retract: 98, path: 64, feed: 0, rpm: 0, spindleDir: 0, flood: false, mist: false, tool: 0, selT: null,
    cycZ: null, cycR: null, cycQ: null, cycP: 0, cycInit: null,
  };
}

const MODAL_KEYS = ['dialect', 'units', 'dist', 'arcDist', 'plane', 'motion', 'cycle', 'wcs', 'tlo', 'tloH', 'retract', 'path',
  'feed', 'rpm', 'spindleDir', 'flood', 'mist', 'tool', 'selT', 'cycZ', 'cycR', 'cycQ', 'cycP', 'cycInit'];

export function modalCodes(st) {
  const m = st.cycle !== 80 ? st.cycle : st.motion;
  return [gName(m), gName(st.plane), gName(st.units), gName(st.dist), gName(st.wcs), 'G40', gName(st.tlo), gName(st.cycle), 'G94', gName(st.retract)].join(' ');
}

export class Interpreter {
  // opts: { tools: Map<number, tool>, offsets: [{x,y,z} x6], requireG43, arcTol, blockDelete }
  constructor(opts) {
    this.opts = opts;
  }

  // physical length (where the tip really is)
  toolLength(n) {
    const t = n ? this.opts.tools.get(n) : null;
    return t ? t.length : 0;
  }

  // length used for compensation: geometry + wear (delta L)
  compLength(n) {
    const t = n ? this.opts.tools.get(n) : null;
    return t ? t.length + (t.dLength || 0) : 0;
  }

  // init: { pos: {x,y,z}, tool, carousel, modal (partial), rpm (actual spindle) }
  compile(text, init = {}) {
    const lines = text.split(/\r?\n/);
    const res = {
      ops: [], errors: [], warnings: [], lineCount: lines.length, totalTime: 0, ended: false,
      toolsUsed: new Set(), lineFirstOp: new Int32Array(lines.length).fill(-1),
      tipBounds: null, workBounds: null, feedLength: 0, rapidLength: 0, endState: null,
    };
    const S = Object.assign(defaultModal(init.units || 21), init.modal || {});
    S.pos = { ...(init.pos || { x: 0, y: 0, z: 0 }) };
    S.tool = init.tool || 0;
    S.carousel = init.carousel || 1;
    S.rpmActual = init.rpm || 0;
    if (S.cycle !== 80 && init.modal == null) S.cycle = 80;
    const offsets = (this.opts.offsets || []).map((o) => ({ ...o }));
    while (offsets.length < 6) offsets.push({ x: 0, y: 0, z: 0 });
    this.S = S;
    this.res = res;
    this.offsets = offsets;
    this.stKey = '';
    this.st = null;
    this.snap();

    let fatal = false;
    let warnedAfterEnd = false;
    for (let li = 0; li < lines.length; li++) {
      const p = parseLine(lines[li]);
      if (p.errors.length) {
        for (const e of p.errors) res.errors.push({ line: li, col: e.col, len: e.len, msg: e.msg });
        fatal = true;
        continue;
      }
      if (!p.words.length) continue;
      if (res.ended) {
        if (!warnedAfterEnd) {
          res.warnings.push({ line: li, msg: 'Blocks after M30/M02 are never executed' });
          warnedAfterEnd = true;
        }
        continue;
      }
      if (fatal) continue;
      if (p.blockDelete && this.opts.blockDelete) continue;
      try {
        this.line = li;
        this.block(p);
      } catch (e) {
        if (!(e instanceof GError)) throw e;
        res.errors.push({ line: li, col: e.col, len: e.len, msg: e.message });
        fatal = true;
      }
    }
    res.endState = this.exportModal();
    res.endPos = { ...S.pos };
    res.endTool = S.tool;
    res.endCarousel = S.carousel;
    res.offsets = offsets;
    res.errors.sort((a, b) => a.line - b.line);
    return res;
  }

  exportModal() {
    const o = {};
    for (const k of MODAL_KEYS) o[k] = this.S[k];
    return o;
  }

  snap() {
    const S = this.S;
    const tl = this.activeTLO();
    const key = MODAL_KEYS.map((k) => S[k]).join('|') + '|' + tl;
    if (key !== this.stKey) {
      this.stKey = key;
      const st = this.exportModal();
      st.tloLen = tl;
      st.codes = modalCodes(st);
      this.st = Object.freeze(st);
    }
    return this.st;
  }

  activeTLO() {
    const S = this.S;
    if (!this.opts.requireG43) return this.compLength(S.tool);
    return S.tlo === 43 ? this.compLength(S.tloH) : 0;
  }

  emit(op) {
    if (op.line == null) op.line = this.line;
    if (!op.st) op.st = this.snap();
    if (op.time == null) op.time = 0;
    op.tStart = this.res.totalTime;
    this.res.totalTime += op.time;
    if (op.line >= 0 && this.res.lineFirstOp[op.line] < 0) this.res.lineFirstOp[op.line] = this.res.ops.length;
    this.res.ops.push(op);
    this.blockOps++;
    return op;
  }

  warn(msg) {
    this.res.warnings.push({ line: this.line, msg });
  }

  checkLimits(x, y, z) {
    const tr = this.opts.limits || MACHINE.travel;
    const v = { x, y, z };
    for (const a of AXES) {
      const [lo, hi] = tr[a];
      if (v[a] < lo - 1e-6 || v[a] > hi + 1e-6) {
        throw new GError(`Over-travel: machine ${a.toUpperCase()}${v[a].toFixed(3)} is outside the ${a.toUpperCase()} travel (${lo} to ${hi}). Check the work offset${a === 'z' ? ', tool length' : ''} and the programmed position.`);
      }
    }
  }

  // pts: flat array of xyz in machine coordinates, starting at the current position.
  move(rapid, pts, feed = this.S.feed) {
    const n = pts.length / 3;
    if (n < 2) return;
    const cum = new Float64Array(n);
    let len = 0;
    for (let i = 1; i < n; i++) {
      const dx = pts[i * 3] - pts[i * 3 - 3], dy = pts[i * 3 + 1] - pts[i * 3 - 2], dz = pts[i * 3 + 2] - pts[i * 3 - 1];
      len += Math.hypot(dx, dy, dz);
      cum[i] = len;
    }
    for (let i = 1; i < n; i++) this.checkLimits(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
    const S = this.S;
    const last = n * 3 - 3;
    S.pos = { x: pts[last], y: pts[last + 1], z: pts[last + 2] };
    if (len < 1e-7) return;
    let time, vmax = 0;
    if (rapid) {
      // Linear-interpolated rapid: the speed is limited so no axis exceeds its own rapid rate.
      const ux = Math.abs(pts[last] - pts[0]) / len, uy = Math.abs(pts[last + 1] - pts[1]) / len, uz = Math.abs(pts[last + 2] - pts[2]) / len;
      vmax = Infinity;
      if (ux > 1e-9) vmax = Math.min(vmax, MACHINE.rapidXY / 60 / ux);
      if (uy > 1e-9) vmax = Math.min(vmax, MACHINE.rapidXY / 60 / uy);
      if (uz > 1e-9) vmax = Math.min(vmax, MACHINE.rapidZ / 60 / uz);
      if (!isFinite(vmax)) vmax = MACHINE.rapidXY / 60;
      time = trapTime(len, vmax, MACHINE.accel);
      this.res.rapidLength += len;
    } else {
      time = len / (Math.min(feed, MACHINE.maxFeed) / 60);
      this.res.feedLength += len;
    }
    const tlen = this.toolLength(S.tool);
    const op = this.emit({ t: 'move', rapid, pts: Float64Array.from(pts), cum, len, feed, vmax, tool: S.tool, tlen, time });
    if (!rapid) this.trackBounds(op);
  }

  trackBounds(op) {
    const r = this.res;
    const off = this.offsets[this.S.wcs - 54];
    const tc = MACHINE.tableCenter;
    const p = op.pts;
    if (!r.tipBounds) {
      r.tipBounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      r.workBounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    }
    for (let i = 0; i < p.length; i += 3) {
      const tx = p[i] - tc.x, ty = p[i + 1] - tc.y, tz = MACHINE.gaugeAtZ0 + p[i + 2] - op.tlen;
      const wx = p[i] - off.x, wy = p[i + 1] - off.y, wz = p[i + 2] - off.z - op.tlen;
      const tb = r.tipBounds, wb = r.workBounds;
      if (tx < tb.min[0]) tb.min[0] = tx; if (tx > tb.max[0]) tb.max[0] = tx;
      if (ty < tb.min[1]) tb.min[1] = ty; if (ty > tb.max[1]) tb.max[1] = ty;
      if (tz < tb.min[2]) tb.min[2] = tz; if (tz > tb.max[2]) tb.max[2] = tz;
      if (wx < wb.min[0]) wb.min[0] = wx; if (wx > wb.max[0]) wb.max[0] = wx;
      if (wy < wb.min[1]) wb.min[1] = wy; if (wy > wb.max[1]) wb.max[1] = wy;
      if (wz < wb.min[2]) wb.min[2] = wz; if (wz > wb.max[2]) wb.max[2] = wz;
    }
  }

  line3(rapid, x, y, z) {
    const p = this.S.pos;
    this.move(rapid, [p.x, p.y, p.z, x, y, z]);
  }

  spindleOp(rpm, dir) {
    const S = this.S;
    const from = S.rpmActual * (S.spindleDir || 1);
    const to = rpm * dir;
    const time = Math.abs(to - from) / MACHINE.spindleAccel;
    S.rpmActual = dir ? rpm : 0;
    S.spindleDir = dir;
    this.emit({ t: 'spindle', rpm, dir, time });
  }

  requireFeed(word) {
    if (!(this.S.feed > 0)) throw new GError('No feed rate: program an F word before the first G01/G02/G03 or drilling cycle', word);
  }

  block(p) {
    const S = this.S;
    this.blockOps = 0;
    const gs = [];
    const ms = [];
    const W = {};
    for (const w of p.words) {
      if (!ALLOWED_LETTERS.has(w.letter)) {
        if ('ABCUVWE'.includes(w.letter)) throw new GError(`Axis word ${w.letter} is not available on this 3-axis machine`, w);
        throw new GError(`Unknown word "${w.letter}"`, w);
      }
      if (w.letter === 'G') gs.push(w);
      else if (w.letter === 'M') ms.push(w);
      else {
        if (W[w.letter]) throw new GError(`Word ${w.letter} appears twice in one block`, w);
        W[w.letter] = w;
      }
    }

    // ---- validate G codes and modal groups
    const G = {};
    const gw = {};
    for (const g of gs) {
      const k = gKey(g.value);
      if (UNSUPPORTED_G[k]) throw new GError(`${gName(k)} is not supported. ${UNSUPPORTED_G[k]}`, g);
      const def = G_CODES[k];
      if (!def) throw new GError(`${gName(k)} is not a recognised G-code (see the Reference tab)`, g);
      let grp = def.group;
      if (G[grp] !== undefined) throw new GError(`${gName(k)} conflicts with ${gName(G[grp])} in the same block (same modal group)`, g);
      G[grp] = k;
      gw[grp] = g;
    }
    if (G.motion !== undefined && G.cycle !== undefined && G.cycle !== 80) {
      throw new GError(`${gName(G.motion)} and ${gName(G.cycle)} cannot be in the same block`, gw.cycle);
    }
    const M = {};
    const mw = {};
    for (const m of ms) {
      if (m.value % 1) throw new GError(`M${m.value} is not a valid M-code`, m);
      const k = Math.trunc(m.value);
      if (UNSUPPORTED_M[k]) throw new GError(`${mName(k)} is not supported. ${UNSUPPORTED_M[k]}`, m);
      const def = M_CODES[k];
      if (!def) throw new GError(`${mName(k)} is not a recognised M-code (see the Reference tab)`, m);
      if (M[def.group] !== undefined) throw new GError(`${mName(k)} conflicts with ${mName(M[def.group])} in the same block`, m);
      M[def.group] = k;
      mw[def.group] = m;
    }

    // ---- 1. units first, so every value in this block is scaled consistently
    if (G.units !== undefined) S.units = G.units;
    const sc = S.units === 20 ? INCH : 1;
    const val = (L) => (W[L] ? W[L].value * sc : undefined);
    const dwell = G.nonmodal === 4;

    // ---- 2. feed, speed, tool select
    if (W.F) {
      const f = W.F.value * sc;
      if (!(f > 0)) throw new GError('Feed rate F must be greater than zero', W.F);
      if (f > MACHINE.maxFeed) this.warn(`F${W.F.value} is above the ${MACHINE.maxFeed} mm/min feed limit; cutting moves are clamped`);
      S.feed = f;
    }
    if (W.S) {
      const s = W.S.value;
      if (s < 0) throw new GError('Spindle speed S cannot be negative', W.S);
      if (s > MACHINE.maxRpm) throw new GError(`S${s} exceeds the ${MACHINE.maxRpm} rpm spindle maximum`, W.S);
      S.rpm = s;
    }
    if (W.T) {
      const t = W.T.value;
      if (t % 1 || t < 0) throw new GError(`T${t} is not a valid tool number`, W.T);
      if (t !== 0 && !this.opts.tools.get(t)) throw new GError(`T${t} is not in the tool library (Tools tab)`, W.T);
      S.selT = t;
    }

    // ---- 3. tool change
    if (M.toolchange === 6) {
      if (S.selT == null) throw new GError('M06 needs a tool selected with T (e.g. T2 M06)', mw.toolchange);
      const to = S.selT;
      if (to === S.tool) {
        this.emit({ t: 'state' });
      } else {
        if (S.spindleDir) this.spindleOp(0, 0);
        const p0 = S.pos;
        const zTime = trapTime(Math.abs(p0.z), MACHINE.rapidZ / 60, MACHINE.accel);
        const time = zTime + atcTime(S.tool, to, S.carousel);
        const prev = S.tool;
        S.pos = { x: p0.x, y: p0.y, z: 0 };
        S.tool = to;
        S.carousel = to || prev || S.carousel;
        if (to) this.res.toolsUsed.add(to);
        this.emit({ t: 'tool', tool: to, prev, from: { ...p0 }, time });
      }
    }

    // ---- 4. spindle and coolant on (before motion)
    if (M.spindle === 3 || M.spindle === 4) {
      if (!(S.rpm > 0)) throw new GError(`${mName(M.spindle)} needs a spindle speed: add S (e.g. S8000 ${mName(M.spindle)})`, mw.spindle);
      if (!S.tool) this.warn('Spindle started with no tool in the spindle');
      this.spindleOp(S.rpm, M.spindle === 3 ? 1 : -1);
    } else if (W.S && S.spindleDir && M.spindle === undefined) {
      this.spindleOp(S.rpm, S.spindleDir);
    }
    if (M.coolant === 7 || M.coolant === 8) {
      if (M.coolant === 7) S.mist = true; else S.flood = true;
      this.emit({ t: 'coolant', flood: S.flood, mist: S.mist });
    }

    // ---- 5. dwell
    if (dwell) {
      let sec;
      if (W.P) sec = W.P.dec ? W.P.value : W.P.value / 1000;
      else if (W.X) sec = W.X.value;
      else throw new GError('G04 needs a dwell time P (P1.5 = 1.5 s, P1500 = 1500 ms)', gw.nonmodal);
      if (sec < 0) throw new GError('Dwell time cannot be negative', W.P || W.X);
      this.emit({ t: 'dwell', sec, time: sec });
    }

    // ---- 6. modal settings
    if (G.plane !== undefined) S.plane = G.plane;
    if (G.tlo === 43) {
      if (!W.H) throw new GError('G43 needs an H word: the tool length offset number (e.g. G43 H2)', gw.tlo);
      const h = W.H.value;
      if (h % 1 || h < 0) throw new GError(`H${h} is not a valid offset number`, W.H);
      if (h === 0) { S.tlo = 49; S.tloH = 0; }
      else {
        if (!this.opts.tools.get(h)) throw new GError(`H${h}: there is no tool ${h} in the tool library`, W.H);
        S.tlo = 43;
        S.tloH = h;
        if (h !== S.tool && this.opts.requireG43) this.warn(`G43 H${h} is active but T${S.tool} is in the spindle; the wrong tool length will be used`);
      }
    } else if (G.tlo === 49) {
      S.tlo = 49;
      S.tloH = 0;
    }
    if (G.wcs !== undefined) S.wcs = G.wcs;
    if (G.path !== undefined) S.path = G.path;
    if (G.distance !== undefined) S.dist = G.distance;
    if (G.arcdist !== undefined) S.arcDist = G.arcdist;
    if (G.retract !== undefined) S.retract = G.retract;

    // ---- 7. motion mode / canned cycle mode
    let cycleStarted = false;
    if (G.cycle === 80) S.cycle = 80;
    if (G.motion !== undefined) {
      S.motion = G.motion;
      if (S.cycle !== 80) S.cycle = 80; // a group-01 code cancels the canned cycle (Fanuc)
    }
    if (G.cycle !== undefined && G.cycle !== 80) {
      if (S.cycle === 80) S.cycInit = S.pos.z; // initial level is latched when a cycle starts from G80
      S.cycle = G.cycle;
      cycleStarted = true;
    }

    const off = this.offsets[S.wcs - 54];
    const tlo = this.activeTLO();
    const hasXYZ = !!(W.X && !dwell) || !!W.Y || !!W.Z;

    if (G.nonmodal === 10) {
      this.g10(W, off, sc, gw.nonmodal);
    } else if (G.nonmodal === 28) {
      const t = this.target(W, off, tlo, sc, dwell);
      const p = S.pos;
      if (t.x !== p.x || t.y !== p.y || t.z !== p.z) this.line3(true, t.x, t.y, t.z);
      const all = !W.X && !W.Y && !W.Z;
      const h = { ...S.pos };
      if (all || W.X) h.x = 0;
      if (all || W.Y) h.y = 0;
      if (all || W.Z) h.z = 0;
      this.line3(true, h.x, h.y, h.z);
    } else if (G.nonmodal === 53) {
      if (S.motion !== 0 && S.motion !== 1) throw new GError('G53 can only be used with G00 or G01', gw.nonmodal);
      if (S.motion === 1) this.requireFeed(gw.nonmodal);
      const p = S.pos;
      this.line3(S.motion === 0, W.X ? val('X') : p.x, W.Y ? val('Y') : p.y, W.Z ? val('Z') : p.z);
    } else if (S.cycle !== 80 && (cycleStarted || hasXYZ || W.R)) {
      this.cannedCycle(W, off, tlo, sc, gw.cycle || p.words[0]);
    } else if (S.motion === 2 || S.motion === 3) {
      const pl = PLANES[S.plane];
      if (hasXYZ || W[pl.ia] || W[pl.ib] || W.R) this.arc(W, off, tlo, sc, gw.motion || p.words[0]);
    } else if (hasXYZ) {
      if (S.motion === 1) this.requireFeed(gw.motion || W.X || W.Y || W.Z);
      const t = this.target(W, off, tlo, sc, dwell);
      this.line3(S.motion === 0, t.x, t.y, t.z);
    } else if (W.I || W.J || W.K) {
      this.warn('I/J/K words ignored: no arc is active in this block');
    }
    if (W.D) this.warn('D word ignored: cutter radius compensation is not simulated');

    // ---- 8. spindle stop / coolant off after motion, then program stops
    if (M.spindle === 5) this.spindleOp(0, 0);
    if (M.coolant === 9) {
      S.flood = false;
      S.mist = false;
      this.emit({ t: 'coolant', flood: false, mist: false });
    }
    if (M.stop === 0 || M.stop === 1) this.emit({ t: 'stop', optional: M.stop === 1 });
    if (M.stop === 2 || M.stop === 30) {
      if (S.spindleDir) this.spindleOp(0, 0);
      if (S.flood || S.mist) {
        S.flood = false;
        S.mist = false;
        this.emit({ t: 'coolant', flood: false, mist: false });
      }
      this.emit({ t: 'end', rewind: M.stop === 30 });
      this.res.ended = true;
    }
    if (!this.blockOps) {
      const before = this.stKey;
      this.snap();
      if (this.stKey !== before || G.wcs !== undefined || G.tlo !== undefined || G.units !== undefined) this.emit({ t: 'state' });
    }
  }

  // Resolve X/Y/Z words into a machine-coordinate target.
  target(W, off, tlo, sc, dwell) {
    const S = this.S;
    const t = { ...S.pos };
    const xw = dwell ? null : W.X;
    if (S.dist === 90) {
      if (xw) t.x = xw.value * sc + off.x;
      if (W.Y) t.y = W.Y.value * sc + off.y;
      if (W.Z) t.z = W.Z.value * sc + off.z + tlo;
    } else {
      if (xw) t.x += xw.value * sc;
      if (W.Y) t.y += W.Y.value * sc;
      if (W.Z) t.z += W.Z.value * sc;
    }
    return t;
  }

  g10(W, off, sc, gword) {
    if (!W.L || W.L.value !== 2) throw new GError('Only G10 L2 (set work offset) is supported', W.L || gword);
    if (!W.P) throw new GError('G10 L2 needs P1..P6 to select G54..G59', gword);
    const pn = W.P.value;
    if (pn % 1 || pn < 1 || pn > 6) throw new GError(`G10 L2 P${pn}: P must be 1..6 (G54..G59)`, W.P);
    const o = this.offsets[pn - 1];
    const inc = this.S.dist === 91;
    if (W.X) o.x = (inc ? o.x : 0) + W.X.value * sc;
    if (W.Y) o.y = (inc ? o.y : 0) + W.Y.value * sc;
    if (W.Z) o.z = (inc ? o.z : 0) + W.Z.value * sc;
    this.emit({ t: 'offset', index: pn - 1, x: o.x, y: o.y, z: o.z });
  }

  arc(W, off, tlo, sc, gword) {
    const S = this.S;
    this.requireFeed(gword);
    const pl = PLANES[S.plane];
    const t = this.target(W, off, tlo, sc, false);
    const s = S.pos;
    const sa = s[pl.a], sb = s[pl.b], ea = t[pl.a], eb = t[pl.b];
    const cw = S.motion === 2;
    let ca, cb;
    if (W.R) {
      const R = W.R.value * sc;
      if (Math.abs(R) < 1e-6) throw new GError('Arc radius R cannot be zero', W.R);
      const da = ea - sa, db = eb - sb;
      const d = Math.hypot(da, db);
      if (d < 1e-7) throw new GError('An R-format arc cannot describe a full circle; use I/J/K centre offsets', W.R);
      if (d > 2 * Math.abs(R) + 1e-4) throw new GError(`Arc radius ${Math.abs(R).toFixed(3)} is too small to reach the end point (chord ${d.toFixed(3)})`, W.R);
      const h = Math.sqrt(Math.max(0, R * R - (d / 2) * (d / 2)));
      const sgn = (cw ? 1 : -1) * (R > 0 ? 1 : -1);
      ca = (sa + ea) / 2 + (sgn * h * db) / d;
      cb = (sb + eb) / 2 - (sgn * h * da) / d;
    } else {
      const wa = W[pl.ia], wb = W[pl.ib];
      if (!wa && !wb) throw new GError(`${gName(S.motion)} needs ${pl.ia}/${pl.ib} centre offsets or R in plane ${gName(S.plane)}`, gword);
      if (S.arcDist === 91.1) {
        ca = sa + (wa ? wa.value * sc : 0);
        cb = sb + (wb ? wb.value * sc : 0);
      } else {
        const offA = off[pl.a] + (pl.a === 'z' ? tlo : 0), offB = off[pl.b] + (pl.b === 'z' ? tlo : 0);
        ca = wa ? wa.value * sc + offA : sa;
        cb = wb ? wb.value * sc + offB : sb;
      }
      const rs = Math.hypot(sa - ca, sb - cb), re = Math.hypot(ea - ca, eb - cb);
      if (rs < 1e-6) throw new GError('Arc centre is on the start point (radius 0)', gword);
      const tol = Math.max(0.02, rs * 0.001);
      if (Math.abs(rs - re) > tol) throw new GError(`Arc end point is not on the circle: start radius ${rs.toFixed(4)}, end radius ${re.toFixed(4)}`, gword);
    }
    const rs = Math.hypot(sa - ca, sb - cb), re = Math.hypot(ea - ca, eb - cb);
    const as = Math.atan2(sb - cb, sa - ca), ae = Math.atan2(eb - cb, ea - ca);
    let sweep = cw ? as - ae : ae - as;
    const TAU = Math.PI * 2;
    while (sweep <= 1e-9) sweep += TAU;
    while (sweep > TAU + 1e-9) sweep -= TAU;
    if (W.R && sweep > TAU - 1e-6) sweep = TAU; // not reachable: guarded above
    const r = Math.max(rs, re);
    const tol = this.opts.arcTol || 0.01;
    const stepAng = tol < r ? 2 * Math.acos(1 - tol / r) : Math.PI / 4;
    let n = Math.ceil(sweep / Math.min(stepAng, Math.PI / 8));
    n = Math.max(2, Math.min(n, 4000));
    const dir = cw ? -1 : 1;
    const sc0 = s[pl.c], ec = t[pl.c];
    const pts = [s.x, s.y, s.z];
    const q = { x: 0, y: 0, z: 0 };
    for (let k = 1; k <= n; k++) {
      if (k === n) { pts.push(t.x, t.y, t.z); break; }
      const f = k / n;
      const th = as + dir * sweep * f;
      const rr = rs + (re - rs) * f;
      q[pl.a] = ca + rr * Math.cos(th);
      q[pl.b] = cb + rr * Math.sin(th);
      q[pl.c] = sc0 + (ec - sc0) * f;
      pts.push(q.x, q.y, q.z);
    }
    this.move(false, pts);
  }

  cannedCycle(W, off, tlo, sc, gword) {
    const S = this.S;
    const k = S.cycle;
    if (W.Z) S.cycZ = W.Z.value * sc;
    if (W.R) S.cycR = W.R.value * sc;
    if (W.Q) S.cycQ = Math.abs(W.Q.value * sc);
    if (W.P) S.cycP = W.P.dec ? W.P.value : W.P.value / 1000;
    if (S.cycZ == null) throw new GError(`${gName(k)} needs a Z depth`, gword);
    if (S.cycR == null) throw new GError(`${gName(k)} needs an R plane (retract height)`, gword);
    if ((k === 83 || k === 73) && !(S.cycQ > 0)) throw new GError(`${gName(k)} needs a positive peck depth Q`, gword);
    this.requireFeed(gword);
    if (S.cycInit == null) S.cycInit = S.pos.z;
    let reps = 1;
    if (W.L) {
      reps = W.L.value;
      if (reps % 1 || reps < 0) throw new GError('L (repeat count) must be a whole number', W.L);
    }
    const init = S.cycInit;
    for (let rep = 0; rep < reps; rep++) {
      let x = S.pos.x, y = S.pos.y;
      let rM, zM;
      if (S.dist === 90) {
        if (W.X) x = W.X.value * sc + off.x;
        if (W.Y) y = W.Y.value * sc + off.y;
        rM = S.cycR + off.z + tlo;
        zM = S.cycZ + off.z + tlo;
      } else {
        if (W.X) x += W.X.value * sc;
        if (W.Y) y += W.Y.value * sc;
        rM = init + S.cycR;
        zM = rM + S.cycZ;
      }
      if (zM > rM + 1e-9) throw new GError(`${gName(k)} depth Z is above the R plane`, W.Z || gword);
      if (rM > init + 1e-6 && S.retract === 98) this.warn('R plane is above the initial level');
      if (x !== S.pos.x || y !== S.pos.y) this.line3(true, x, y, S.pos.z);
      if (S.pos.z !== rM) this.line3(true, x, y, rM);
      if (k === 81 || k === 82) {
        this.line3(false, x, y, zM);
        if (k === 82 && S.cycP > 0) this.emit({ t: 'dwell', sec: S.cycP, time: S.cycP });
      } else if (k === 83) {
        let depth = rM;
        let first = true;
        while (depth > zM + 1e-9) {
          const next = Math.max(depth - S.cycQ, zM);
          if (!first) this.line3(true, x, y, Math.min(rM, depth + 1.0));
          this.line3(false, x, y, next);
          if (next > zM + 1e-9) this.line3(true, x, y, rM);
          depth = next;
          first = false;
        }
      } else if (k === 73) {
        let depth = rM;
        while (depth > zM + 1e-9) {
          const next = Math.max(depth - S.cycQ, zM);
          this.line3(false, x, y, next);
          if (next > zM + 1e-9) this.line3(true, x, y, next + 0.5);
          depth = next;
        }
      }
      const back = S.retract === 98 ? Math.max(init, rM) : rM;
      this.line3(true, x, y, back);
    }
  }
}
