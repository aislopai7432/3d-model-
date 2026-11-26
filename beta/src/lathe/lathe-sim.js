// Manual engine-lathe simulator (pure JS, no DOM / THREE; runs in Node).
//
// Axes: Z along the bed, +Z towards the tailstock, Z = 0 at the chuck jaw face. X = cross-slide:
// the tool-tip RADIUS from the spindle axis (displays show diameter, as real cross-slide dials do).
// Handwheel deltas are in dial DIVISIONS; positive = clockwise = "advance":
//   carriage  +  -> carriage moves towards the chuck (Z decreases),      0.1 mm / div, 250 div = 25 mm / rev
//   cross     +  -> tool moves in (radius decreases), 0.02 mm DIA / div (0.01 radius), 200 div = 4 mm dia / rev
//   compound  +  -> tool advances along the slide,     0.02 mm / div, 100 div = 2 mm / rev
//   quill     +  -> quill extends (tailstock tool tip moves towards the chuck), 0.05 mm / div, 100 div = 5 mm / rev
// Compound angle: 0 = slide parallel to the cross-slide (moves the tool radially), 90 = slide parallel to
// the bed; advancing a positive angle also moves the tool towards the headstock (dz = -s sin a, dr = -s cos a).
// Spindle: dir +1 = FWD (normal cutting rotation), -1 = REV, 0 = stop. spindle.angle (rad) grows with FWD.
// Feed direction feed.dir +1 = carriage towards the chuck / cross-slide in (reverses with spindle reverse).
import { MATERIALS } from '../config.js';
import { TurnProfile, toolShape, drillShape, EMPTY } from './turn-profile.js';

export const SPEEDS = [40, 63, 90, 125, 180, 250, 355, 500, 710, 1000, 1400, 2000]; // rpm, gearbox table (12)
export const FEEDS = [0.04, 0.06, 0.08, 0.10, 0.14, 0.20, 0.28, 0.40]; // mm / rev (quick-change box)
export const PITCHES = [0.5, 0.7, 0.75, 0.8, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0]; // mm, thread pitches
export const GRAD = {
  carriage: { sign: -1, unit: 0.1, div: 250, label: 'Carriage 0.1 mm/div, 25 mm/rev' },
  cross: { sign: -1, unit: 0.01, div: 200, label: 'Cross-slide 0.02 mm/div on DIA (0.01 radius), 4 mm dia/rev' },
  compound: { sign: 1, unit: 0.02, div: 100, label: 'Compound 0.02 mm/div, 2 mm/rev' },
  quill: { sign: 1, unit: 0.05, div: 100, label: 'Tailstock quill 0.05 mm/div, 5 mm/rev' },
};
export const CHUCK = { outerDia: 160, jawLen: 45, minGrip: 15, maxDia: 80, minDia: 3 };
export const LIMITS = { z: [-20, 620], x: [-12, 110], s: [-30, 50], q: [0, 100], tail: [60, 700] };
// Leadscrew pitch (mm). The half nut can only drop into the leadscrew thread once per leadscrew pitch of
// relative travel: the thread dial (threadDial()) shows those moments as numbered marks.
export const LEADSCREW_PITCH = 6;
export const MACHINE = { powerKW: 2.2, maxTorque: 250, handSpeed: { carriage: 3, cross: 1, compound: 0.5, quill: 2 } };
const E_MOD = { aluminium: 0.69e5, steel: 2.1e5, brass: 1.0e5, plastic: 3e3 }; // N/mm2
const STEP = 0.02; // mm, sweep substep
const AXIS_VAR = { carriage: 'z', cross: 'x', compound: 's', quill: 'q' };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const D2R = Math.PI / 180;

export class LatheSim {
  constructor(opts = {}) {
    this.opts = { dz: 0.02, deflection: true, backlash: { carriage: 0.15, cross: 0.04, compound: 0.04, quill: 0.1 }, ...opts };
    this.backlash = { ...this.opts.backlash };
    this.time = 0;
    this.events = [];
    this._listeners = [];
    this.profile = null;
    this.parts = [];
    this.reset();
  }

  reset() {
    const mkAx = (pos, lo, hi, b) => ({ pos, hw: pos, zero: pos, lo, hi, b });
    this.ax = {
      carriage: mkAx(120, ...LIMITS.z, this.backlash.carriage),
      cross: mkAx(60, ...LIMITS.x, this.backlash.cross),
      compound: mkAx(0, ...LIMITS.s, this.backlash.compound),
      quill: mkAx(0, ...LIMITS.q, this.backlash.quill),
    };
    this.profile = null;
    this.parts = [];
    this.events.length = 0;
    this.dro0 = { x: 0, z: 0 };
    this.lead = 0; // leadscrew travel (mm): advances -pitch per spindle rev * feed dir, always geared to the spindle
    this.nutOff = 0; // carriage Z - leadscrew travel while the half nut is closed (a multiple of LEADSCREW_PITCH)
    this._helix = null; // { pitch, phase } of the first thread pass on this bar
    this._defl = 0;
    this._rubT = 0; this._warnT = 0; this._chipT = 0; this._pkT = 0; this._noCutT = 0;
    this.state = {
      spindle: { dir: 0, rpmSet: SPEEDS[7], rpm: 0, w: 0, angle: 0, brake: false },
      gear: 7, speeds: SPEEDS,
      carriageZ: 120, crossX: 60,
      compound: { angle: 0, slide: 0 },
      toolIndex: 0,
      tools: [
        { type: 'turn', broken: false }, { type: 'face', broken: false },
        { type: 'part', broken: false }, { type: 'thread', broken: false },
      ],
      feed: { rate: FEEDS[3], index: 3, engaged: 'off', dir: 1 },
      halfNut: false, halfNutPending: false, threadPitch: PITCHES[6], threadIndex: 6,
      tailstock: { z: 400, quill: 0, tool: null, locked: true },
      chuck: { dia: 0, outerDia: CHUCK.outerDia, clamped: false },
      stock: null,
      coolant: false, estop: false, guardOpen: false,
      alarm: null, message: '',
      hw: { carriage: 0, cross: 0, compound: 0, quill: 0 }, // handwheel angle, turns (cumulative)
      cut: { active: false, ap: 0, f: 0, vc: 0, fc: 0, power: 0, torque: 0, load: 0, mrr: 0, chipRate: 0 },
      deflection: 0, lastPart: null, supported: false,
    };
    this._sync();
  }

  // ------------------------------------------------------------ events / messages
  on(fn) { this._listeners.push(fn); return () => { this._listeners = this._listeners.filter((f) => f !== fn); }; }
  _ev(type, data = {}) {
    const e = { type, t: this.time, ...data };
    if (type !== 'chip' && type !== 'drilling') { this.events.push(e); if (this.events.length > 400) this.events.shift(); } // chips / drilling: listeners only
    for (const f of this._listeners) f(e);
    return e;
  }
  drainEvents() { const e = this.events.slice(); this.events.length = 0; return e; }
  hasEvent(type) { return this.events.some((e) => e.type === type); }
  _msg(m) { this.state.message = m; }

  // ------------------------------------------------------------ geometry helpers
  get tool() { return this.state.tools[this.state.toolIndex]; }
  get toolShape() { return toolShape(this.tool.type); }
  _tipOf(z, x, s) {
    const a = this.state.compound.angle * D2R;
    return { z: z - s * Math.sin(a), r: x - s * Math.cos(a) };
  }
  /** Tool tip position {z, r} (r = radius from the spindle axis). */
  toolTip() { const A = this.ax; return this._tipOf(A.carriage.pos, A.cross.pos, A.compound.pos); }
  tailTipZ() { return this.state.tailstock.z - this.ax.quill.pos; }
  /** Free-end Z of the workpiece (null without stock). */
  endZ() { return this.profile ? this.profile.endZ() : null; }

  _sync() {
    const A = this.ax, s = this.state;
    s.carriageZ = A.carriage.pos; s.crossX = A.cross.pos;
    s.compound.slide = A.compound.pos; s.tailstock.quill = A.quill.pos;
    for (const k of Object.keys(GRAD)) { const g = GRAD[k]; s.hw[k] = (g.sign * (A[k].hw - A[k].zero)) / (g.unit * g.div); }
    s.spindle.rpm = Math.abs(s.spindle.w);
    if (this.profile) {
      const e = this.profile.endZ();
      if (e != null && s.stock) { s.stock.endZ = e; s.stock.stickout = Math.max(0, e); s.stock.length = s.stock.stickout + (s.stock.grip || 0); }
    }
  }

  /** Dial reading of a handwheel: div (cumulative since zeroing), face (0..divPerRev), turns, mm (cross: diameter). */
  dial(axis) {
    const g = GRAD[axis], a = this.ax[axis];
    const div = (g.sign * (a.hw - a.zero)) / g.unit;
    const face = ((Math.round(div) % g.div) + g.div) % g.div;
    return { div, face, turns: div / g.div, mm: axis === 'cross' ? div * 0.02 : div * g.unit, divPerRev: g.div };
  }
  zeroDial(axis) { this.ax[axis].zero = this.ax[axis].hw; this._ev('dialZero', { axis }); this._sync(); }
  /** Digital readout (cross in diameter). */
  dro() {
    const t = this.toolTip();
    return { xDia: 2 * t.r, z: t.z, xRel: 2 * t.r - this.dro0.x, zRel: t.z - this.dro0.z };
  }
  zeroDro(axis) { const t = this.toolTip(); if (axis === 'x') this.dro0.x = 2 * t.r; else this.dro0.z = t.z; }

  // ------------------------------------------------------------ operator controls
  loadStock({ dia, length, stickout, material = 'steel', bore = 0, clamp = true }) {
    if (Math.abs(this.state.spindle.w) > 1) { this._msg('Stop the spindle first'); return false; }
    dia = clamp_(dia, CHUCK.minDia, CHUCK.maxDia);
    stickout = Math.min(stickout, length);
    const grip = length - stickout;
    this.profile = new TurnProfile({ zMin: -grip, zMax: stickout, radius: dia / 2, dz: this.opts.dz, bore: bore / 2 });
    this.parts = [];
    this.state.stock = { dia, length, stickout, grip, material, endZ: stickout };
    this.state.chuck.dia = dia;
    this.state.chuck.clamped = !!clamp;
    this.state.lastPart = null;
    this._defl = 0;
    this._helix = null;
    this._ev('stockLoaded', { dia, length, stickout, material });
    this._sync();
    return true;
  }
  removeStock() {
    if (Math.abs(this.state.spindle.w) > 1) return false;
    this.profile = null; this.state.stock = null; this.state.chuck.clamped = false; this.state.chuck.dia = 0; this._helix = null;
    this._sync(); return true;
  }
  clampChuck(on) {
    if (Math.abs(this.state.spindle.w) > 1) { this._msg('Cannot open the chuck while turning'); return false; }
    this.state.chuck.clamped = !!on;
    this._ev(on ? 'chuckClamp' : 'chuckOpen');
    return true;
  }
  setGear(i) {
    const s = this.state;
    if (Math.abs(s.spindle.w) > 8) { this._msg('Stop the spindle before shifting gears'); this._ev('gearGrind'); return false; }
    s.gear = clamp(Math.round(i), 0, SPEEDS.length - 1);
    s.spindle.rpmSet = SPEEDS[s.gear];
    this._ev('gear', { gear: s.gear, rpm: s.spindle.rpmSet });
    return true;
  }
  setSpeed(rpm) { let b = 0; SPEEDS.forEach((v, i) => { if (Math.abs(v - rpm) < Math.abs(SPEEDS[b] - rpm)) b = i; }); return this.setGear(b); }
  setSpindle(dir) {
    const s = this.state, sp = s.spindle;
    dir = dir > 0 ? 1 : dir < 0 ? -1 : 0;
    if (dir !== 0) {
      let why = null;
      if (s.estop) why = 'Emergency stop is pressed';
      else if (s.guardOpen) why = 'Close the chuck guard first';
      else if (s.alarm === 'CRASH') why = 'Crash - reset the alarm and inspect the tool';
      else if (s.stock && !s.chuck.clamped) why = 'Tighten the chuck on the workpiece first';
      else if (s.stock && s.stock.grip < CHUCK.minGrip) why = 'Workpiece is not gripped deeply enough in the chuck';
      if (why) { this._msg(why); this._ev('startRefused', { why }); return false; }
      if (s.alarm) s.alarm = null;
    }
    if (dir !== sp.dir) this._ev(dir === 0 ? 'spindleStop' : 'spindleStart', { dir });
    sp.dir = dir;
    if (dir !== 0) sp.brake = false;
    return true;
  }
  setBrake(on) { this.state.spindle.brake = !!on; if (on) this.state.spindle.dir = 0; }
  setGuard(open) {
    this.state.guardOpen = !!open;
    if (open && Math.abs(this.state.spindle.w) > 1) { this.state.spindle.dir = 0; this.state.spindle.brake = true; this._msg('Guard opened - spindle stopped'); this._ev('interlock'); }
  }
  setEstop(on) {
    const s = this.state;
    s.estop = !!on;
    if (on) { s.spindle.dir = 0; s.spindle.brake = true; s.feed.engaged = 'off'; s.halfNut = false; s.halfNutPending = false; s.alarm = 'ESTOP'; this._ev('estop'); } else { s.spindle.brake = false; if (s.alarm === 'ESTOP') s.alarm = null; }
  }
  resetAlarm() {
    const s = this.state;
    if (s.estop) { this._msg('Release the emergency stop first'); return false; }
    s.alarm = null; s.message = '';
    for (const t of s.tools) t.broken = false; // fresh insert
    if (s.tailstock.tool) s.tailstock.tool.broken = false;
    return true;
  }
  setCoolant(on) { this.state.coolant = !!on; this._ev('coolant', { on: !!on }); }
  setFeedIndex(i) {
    const f = this.state.feed;
    f.index = clamp(Math.round(i), 0, FEEDS.length - 1); f.rate = FEEDS[f.index];
    this._ev('lever', { what: 'feed', value: f.rate });
  }
  setFeedDir(d) { this.state.feed.dir = d < 0 ? -1 : 1; this._ev('lever', { what: 'feedDir', value: this.state.feed.dir }); }
  setThreadIndex(i) {
    const s = this.state;
    s.threadIndex = clamp(Math.round(i), 0, PITCHES.length - 1); s.threadPitch = PITCHES[s.threadIndex];
    this._ev('lever', { what: 'pitch', value: s.threadPitch });
  }
  engageFeed(mode) {
    const s = this.state;
    if (mode !== 'off') {
      if (s.halfNut || s.halfNutPending) { this._msg('Interlock: open the half nut before engaging power feed'); this._ev('interlock'); return false; }
      if (s.estop || s.alarm === 'CRASH') return false;
    }
    s.feed.engaged = mode;
    this._ev('lever', { what: 'powerFeed', value: mode });
    return true;
  }
  setHalfNut(on) {
    const s = this.state;
    if (on && s.feed.engaged !== 'off') { this._msg('Interlock: disengage power feed before closing the half nut'); this._ev('interlock'); return false; }
    if (on && (s.estop || s.alarm === 'CRASH')) return false;
    this._ev('lever', { what: 'halfNut', value: !!on });
    if (!on) { s.halfNut = false; s.halfNutPending = false; return true; }
    if (s.halfNut) return true;
    // the nut only drops in where the leadscrew thread lines up with it (a mark on the thread dial)
    const u = (this.ax.carriage.pos - this.lead) / LEADSCREW_PITCH;
    if (Math.abs(u - Math.round(u)) < 0.01) this._closeNut(Math.round(u));
    else s.halfNutPending = true;
    return true;
  }
  _closeNut(k) {
    const s = this.state, P = s.threadPitch;
    s.halfNut = true; s.halfNutPending = false;
    this.nutOff = k * LEADSCREW_PITCH;
    // the helix this pass will cut: groove Z (mod pitch) at whole spindle revolutions
    const T = this.state.spindle.angle / (2 * Math.PI);
    const C = this.lead + P * s.feed.dir * T + this.nutOff;
    const phase = ((C % P) + P) % P;
    const td = this.threadDial();
    const mark = td.mark;
    if (this.profile) {
      const h = this._helix;
      if (!h || Math.abs(h.pitch - P) > 1e-9) this._helix = { pitch: P, phase, mark };
      else {
        let d = Math.abs(phase - h.phase) % P;
        d = Math.min(d, P - d);
        if (d > 0.02) {
          this._msg(`Half nut in on mark ${mark}: NOT the helix of the first pass (mark ${h.mark}) - the tool will cut a new groove!`);
          this._ev('crossThread', { mark, first: h.mark, offset: d });
          this._ev('halfNutIn', { mark, ok: false });
          return;
        }
      }
    }
    this._ev('halfNutIn', { mark, ok: true });
  }
  /** Thread dial: N numbered marks per dial turn; the half nut drops in only on a mark. pos = dial turn
   *  fraction (0..1, mark m at (m-1)/N), mark = nearest mark, step = marks between equivalent marks (1 = any
   *  mark cuts the same helix, 2 = odd or even marks, N = the same mark every pass). */
  threadDial() {
    const P = this.state.threadPitch;
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    const p100 = Math.round(P * 100), l100 = LEADSCREW_PITCH * 100;
    const L = (p100 * l100) / gcd(p100, l100) / 100; // shortest travel after which nut and helix line up again
    const Ld = L * Math.max(1, Math.ceil(24 / L));
    const N = Math.round(Ld / LEADSCREW_PITCH);
    const rel = this.state.halfNut ? this.nutOff : this.ax.carriage.pos - this.lead;
    const pos = (((rel / Ld) % 1) + 1) % 1;
    const m = Math.round(pos * N) % N;
    return { N, pos, mark: m + 1, near: Math.abs(pos * N - Math.round(pos * N)), step: Math.round(L / LEADSCREW_PITCH), travel: Ld };
  }
  setCompoundAngle(deg) { this.state.compound.angle = clamp(deg, -90, 90); this._ev('lever', { what: 'compoundAngle', value: this.state.compound.angle }); }
  setTool(i, type) { this.state.tools[i] = { type, broken: false }; }
  indexTool(i) {
    const s = this.state;
    i = ((Math.round(i) % 4) + 4) % 4;
    if (i === s.toolIndex) return true;
    const t = this.toolTip();
    if (this.profile && t.r < this.profile.rBound + 6 && t.z < (this.profile.endZ() ?? 0) + 20) {
      this._msg('Retract the cross-slide before indexing the tool post'); this._ev('indexRefused'); return false;
    }
    s.toolIndex = i;
    this._ev('toolIndex', { index: i, type: s.tools[i].type });
    return true;
  }
  setTailTool(tool) { this.state.tailstock.tool = tool ? { type: tool.type, d: tool.d, broken: false } : null; this._ev('tailTool', { tool: this.state.tailstock.tool }); }
  lockTailstock(on) { this.state.tailstock.locked = !!on; this._ev('lever', { what: 'tailLock', value: !!on }); }
  slideTailstock(dz) {
    const ts = this.state.tailstock;
    if (ts.locked) { this._msg('Unlock the tailstock first'); return false; }
    this._moveTail(clamp(ts.z + dz, LIMITS.tail[0], LIMITS.tail[1]), this.ax.quill.pos);
    return true;
  }

  // ------------------------------------------------------------ handwheels
  _hand(axis, deltaDiv) {
    const g = GRAD[axis], a = this.ax[axis], v = AXIS_VAR[axis];
    if (axis === 'carriage' && this.state.halfNut) { this._msg('Half nut closed: the carriage is locked to the leadscrew'); return false; }
    a.hw += g.sign * deltaDiv * g.unit;
    // backlash: slide only follows once the lost motion is taken up
    let p = a.pos;
    const d = a.hw - p;
    if (d > a.b / 2) p = a.hw - a.b / 2; else if (d < -a.b / 2) p = a.hw + a.b / 2;
    if (p === a.pos) { this._sync(); return false; }
    if (axis === 'quill') this._moveTail(this.state.tailstock.z, p);
    else this._move({ [v]: p }, MACHINE.handSpeed[axis], 'hand');
    a.hw = a.pos + clamp(a.hw - a.pos, -a.b / 2, a.b / 2);
    this._sync();
    return true;
  }
  turnCarriage(deltaDiv) { return this._hand('carriage', deltaDiv); }
  turnCross(deltaDiv) { return this._hand('cross', deltaDiv); }
  turnCompound(deltaDiv) { return this._hand('compound', deltaDiv); }
  turnTailQuill(deltaDiv) { return this._hand('quill', deltaDiv); }

  // ------------------------------------------------------------ collisions
  _collide(z, x, s) {
    const sh = this.toolShape, tip = this._tipOf(z, x, s), R = CHUCK.outerDia / 2;
    // tool vs chuck face / jaws (jaws are at Z < 0 out to the chuck radius)
    if (tip.z + sh.zl < -0.001) {
      const dzc = tip.z < 0 ? 0 : -tip.z;
      if (tip.r + sh.low(Math.max(dzc, sh.zl)) < R) return 'tool';
    }
    if (tip.z + sh.overhang < 0 && tip.r + 10 < R) return 'toolpost';
    if (z + 5 < 0 && x + 25 < R) return 'carriage';
    // tool post / tool vs tailstock drill chuck
    const tt = this.tailTipZ();
    if (tip.r + 10 < 30 && tip.z + 95 > tt + 50) return 'tailstock';
    const td = this.state.tailstock.tool;
    if (td && tip.z + sh.zr > tt && tip.r < td.d / 2 + 1) return 'tool';
    return null;
  }

  _crash(what, z, x, s) {
    const st = this.state, sp = st.spindle;
    const hard = Math.abs(sp.w) > 5 || st.feed.engaged !== 'off' || st.halfNut;
    const label = { tool: 'The tool hit the chuck', toolpost: 'The tool post hit the chuck jaws', carriage: 'The carriage hit the chuck', tailstock: 'The carriage hit the tailstock' }[what];
    this._ev('crash', { what, hard, z, x });
    if (hard) {
      sp.dir = 0; sp.brake = true;
      st.feed.engaged = 'off'; st.halfNut = false; st.halfNutPending = false;
      st.alarm = 'CRASH';
      if (what === 'tool') this.tool.broken = true;
      this._msg(label + ' - CRASH! Spindle stopped');
    } else this._msg(label + ' (spindle stopped, no damage)');
  }

  // ------------------------------------------------------------ cutting
  _cutMode() {
    if (!this.profile) return 'none';
    const w = this.state.spindle.w;
    if (this.state.halfNut && Math.abs(w) >= 5) return 'lead';
    if (this.tool.broken || Math.abs(w) < 5 || w < 0) return 'rub';
    return 'cut';
  }

  // Move the carriage-borne axes to the target pose (partial {z,x,s}). span = time the motion takes (s),
  // or a hand speed (mm/s) when kind === 'hand' (the time is then derived from the distance).
  // Returns {area, vol, depth, revs, rubDepth, crashed}.
  _move(target, span, kind) {
    const A = this.ax, st = this.state;
    const cur = { z: A.carriage.pos, x: A.cross.pos, s: A.compound.pos };
    const dst = { z: target.z ?? cur.z, x: target.x ?? cur.x, s: target.s ?? cur.s };
    const res = { area: 0, vol: 0, depth: 0, revs: 0, rubDepth: 0, crashed: null, limited: false, feedMark: 0 };
    const lim = [[LIMITS.z, 'z'], [LIMITS.x, 'x'], [LIMITS.s, 's']];
    for (const [l, k] of lim) { const c = clamp(dst[k], l[0], l[1]); if (c !== dst[k]) { res.limited = k; dst[k] = c; } }
    const t0 = this._tipOf(cur.z, cur.x, cur.s), t1 = this._tipOf(dst.z, dst.x, dst.s);
    const dist = Math.max(Math.abs(dst.z - cur.z), Math.abs(dst.x - cur.x), Math.abs(dst.s - cur.s), Math.abs(t1.z - t0.z), Math.abs(t1.r - t0.r));
    const path = Math.hypot(t1.z - t0.z, t1.r - t0.r);
    const time = kind === 'hand' ? Math.max(0.02, path / span) : span;
    const mode = this._cutMode();
    const rpm = Math.abs(st.spindle.w);
    res.revs = (rpm / 60) * time;
    res.feedMark = res.revs > 0 ? clamp(path / res.revs, 0.01, 2) : 0;
    res.time = time;
    const sh = this.toolShape, prof = this.profile;
    const N = clamp(Math.ceil(dist / STEP), 1, 40000);
    let last = { ...cur };
    res.turning = Math.abs(t1.z - t0.z) >= Math.abs(t1.r - t0.r); // axial feed: the workpiece springs away radially
    const defl = this.opts.deflection && res.turning ? this._defl : 0;
    if (prof) prof.resetAcc();
    for (let k = 1; k <= N; k++) {
      const f = k / N;
      const p = { z: cur.z + (dst.z - cur.z) * f, x: cur.x + (dst.x - cur.x) * f, s: cur.s + (dst.s - cur.s) * f };
      const hit = this._collide(p.z, p.x, p.s);
      if (hit) { res.crashed = hit; break; }
      last = p;
      if (!prof || mode === 'none' || mode === 'lead') continue;
      const tip = this._tipOf(p.z, p.x, p.s);
      if (mode === 'cut') prof.cutAt(tip.z, tip.r + defl, sh, true, res.feedMark, 0);
      else { const d = prof.cutAt(tip.z, tip.r, sh, false); if (d > res.rubDepth) res.rubDepth = d; }
    }
    A.carriage.pos = last.z; A.cross.pos = last.x; A.compound.pos = last.s;
    if (res.crashed) {
      // slide stopped at the contact point: the handwheel/leadscrew position follows
      A.carriage.hw = A.carriage.pos; A.cross.hw = A.cross.pos; A.compound.hw = A.compound.pos;
    }
    if (prof) {
      res.area = prof.acc.area; res.vol = prof.acc.vol; res.depth = prof.acc.depth;
      this._after(prof, mode);
    }
    if (res.limited && kind !== 'hand') { st.feed.engaged = 'off'; st.halfNut = false; st.halfNutPending = false; this._msg('Travel limit reached - feed disengaged'); }
    if (res.limited) this._ev('limit', { axis: res.limited });
    if (res.crashed) this._crash(res.crashed, last.z, last.x, last.s);
    if (kind === 'hand') this._evalCut(res, mode);
    return res;
  }

  // post-processing after material was removed: refresh chunk versions, necks, parting
  _after(prof, mode) {
    const a = prof.acc;
    if (a.i1 < a.i0) return;
    const i0 = a.i0, i1 = a.i1, emptied = a.emptied;
    // thin necks of a groove >= 1 mm wide snap (parting off leaves flat faces)
    let neck = false;
    if (mode === 'cut' || mode === 'lead') {
      const lo = Math.max(1, i0 - 5), hi = Math.min(prof.n - 2, i1 + 5);
      const minRun = Math.round(1.0 / prof.dz);
      let i = lo;
      while (i <= hi) {
        if (prof.has(i) && prof.rOut[i] - prof.rIn[i] < 0.4) {
          let j = i;
          while (j + 1 <= hi + 3 && prof.has(j + 1) && prof.rOut[j + 1] - prof.rIn[j + 1] < 0.4) j++;
          if (j - i + 1 >= minRun && prof.has(i - 1) && prof.has(j + 1)) {
            for (let k = i; k <= j; k++) { prof.rOut[k] = prof.rIn[k]; }
            neck = true; a.i0 = Math.min(a.i0, i); a.i1 = Math.max(a.i1, j);
          }
          i = j + 1;
        } else i++;
      }
    }
    const from = Math.max(1, i0 - 6);
    prof.endEdit();
    if (emptied || neck) {
      const piece = prof.separate(from);
      if (piece) this._parted(piece);
    }
    prof.resetAcc();
    prof.acc.i0 = prof.n; prof.acc.i1 = -1;
  }

  _parted(profile) {
    const st = this.state, mat = MATERIALS[st.stock.material] || MATERIALS.steel;
    const len = profile.lengthBetween(profile.zMin, profile.zMax + profile.dz);
    const piece = {
      profile, z0: profile.zMin, z1: profile.zMax, length: len, material: st.stock.material,
    };
    piece.massG = +(profile.volume() / 1000 * mat.density).toFixed(1);
    this.parts.push(piece);
    st.lastPart = piece;
    this._ev('partedOff', { piece });
    this._msg(`Part off: ${len.toFixed(2)} mm long`);
  }

  // Convert accumulated removal into forces / load / events. kind: result of _move()
  _evalCut(res, mode) {
    const st = this.state, c = st.cut;
    const rpm = Math.abs(st.spindle.w);
    const mat = MATERIALS[st.stock ? st.stock.material : 'steel'];
    const tip = this.toolTip();
    if (mode === 'rub' || mode === 'none') {
      if (mode === 'rub' && res.rubDepth > 0.003) this._rub(res.rubDepth);
      return;
    }
    if (res.area <= 0 || res.revs <= 0) return;
    const A = mode === 'lead' ? res.area : res.area / res.revs;
    const Fc = mat.kc * A;
    const D = Math.max(2, 2 * tip.r);
    const vc = (Math.PI * D * rpm) / 1000;
    const P = (Fc * vc) / 60000;
    const T = (Fc * D) / 2000;
    const Tmax = Math.min(MACHINE.maxTorque, (MACHINE.powerKW * 9549) / Math.max(rpm, 1));
    const load = Math.max(Fc / this.toolShape.fcMax, P / MACHINE.powerKW, T / Tmax);
    if (!c.active) this._ev('cutStart', { tool: this.tool.type });
    c.active = true; c.f = mode === 'lead' ? st.threadPitch : res.feedMark; c.ap = mode === 'lead' ? res.depth : A / Math.max(c.f, 0.005); c.vc = vc; c.fc = Fc; c.power = P; c.torque = T; c.load = load;
    c.mrr = res.vol / res.time; c.chipRate = c.mrr;
    this._noCutT = 0.25;
    if (this.opts.deflection && st.stock && this.tool.type !== 'part' && res.turning !== false) {
      // cantilever stiffness of the bar between the cut and the chuck (thinnest section governs)
      const prof = this.profile;
      let dmin = Infinity;
      const stepZ = Math.max(0.5, tip.z / 20);
      for (let z = 0.5; z < tip.z - 0.5; z += stepZ) { const i = Math.round(prof.idx(z)); if (prof.has(i)) dmin = Math.min(dmin, 2 * prof.rOut[i]); }
      if (!Number.isFinite(dmin)) dmin = st.stock.dia;
      const L = Math.max(tip.z, 4), E = E_MOD[st.stock.material] || 2e5;
      const k = (3 * E * Math.PI * dmin ** 4 / 64) / (L ** 3);
      this._defl = Math.min(0.3, (0.4 * Fc) / k);
    }
    st.deflection = this._defl;
    if (this._chipT <= 0) { this._chipT = 0.05; this._ev('chip', { rate: c.mrr, material: st.stock && st.stock.material, tool: this.tool.type }); }
    if (load > 1.6 && !this.tool.broken) { this.tool.broken = true; this._ev('toolBroken', { tool: this.tool.type, load }); this._msg('Tool broke - way too heavy a cut'); }
    if (load > 1.15) {
      if (st.alarm !== 'OVERLOAD') {
        st.alarm = 'OVERLOAD'; st.spindle.dir = 0; st.spindle.brake = true; st.feed.engaged = 'off'; st.halfNut = false; st.halfNutPending = false;
        this._ev('stall', { load }); this._msg('Spindle stalled - cut too deep or too fast a feed');
      }
    } else if (load > 0.85 && this._warnT <= 0) {
      this._warnT = 1; this._ev('overload', { load }); this._msg('Heavy cut: reduce depth or feed');
    }
    const sl = this.profile && st.stock ? st.stock.stickout / st.stock.dia : 0;
    if (sl > 5 && load > 0.45 && this._warnT <= 0) { this._warnT = 1; this._ev('chatter', { ratio: sl }); this._msg('Workpiece is chattering - slender, use the tailstock or take a lighter cut'); }
  }

  _rub(depth) {
    const st = this.state;
    if (this._rubT > 0) return;
    this._rubT = 0.4;
    const spinning = Math.abs(st.spindle.w) >= 5;
    this._ev('rub', { depth, stopped: !spinning, reverse: spinning && st.spindle.w < 0 });
    this._msg(spinning ? 'The tool is rubbing: wrong spindle direction or tool is damaged' : 'Tool pushed against a stopped workpiece - start the spindle first!');
    if (depth > 0.25 && !this.tool.broken) { this.tool.broken = true; this._ev('toolBroken', { tool: this.tool.type, depth }); this._msg('Tool chipped: forced into a stopped workpiece'); }
  }

  // Tailstock: tool tip at Z = ts.z - quill. Moves to (zTs, q); a drill / centre drill cuts the end of the bar.
  _moveTail(zTs, q) {
    const st = this.state, ts = st.tailstock, prof = this.profile, A = this.ax;
    const q0 = A.quill.pos, z0 = ts.z;
    q = clamp(q, LIMITS.q[0], LIMITS.q[1]);
    const tip0 = z0 - q0, tip1 = zTs - q;
    const tool = ts.tool;
    const dist = Math.abs(tip1 - tip0);
    const N = clamp(Math.ceil(dist / STEP), 1, 40000);
    const w = st.spindle.w, rpm = Math.abs(w);
    const mode = !prof || !tool || tool.broken ? 'none' : rpm >= 5 && w > 0 ? 'cut' : 'rub';
    const sh = tool ? drillShape(tool.d, tool.type) : null;
    const time = Math.max(0.02, dist / MACHINE.handSpeed.quill);
    const revs = (rpm / 60) * time;
    if (prof) prof.resetAcc();
    const t = this.toolTip(), tsh = this.toolShape;
    let prev = tip0, crash = null, rubR = 0, f = 1;
    for (let k = 1; k <= N; k++) {
      const tipK = tip0 + (tip1 - tip0) * (k / N);
      if (t.r + 10 < 30 && t.z + 95 > tipK + 50) { crash = 'tailstock'; break; }
      if (tool && t.z + tsh.zr > tipK && t.r < tool.d / 2 + 1) { crash = 'tool'; break; }
      if (tool && tipK < -0.5 && !(prof && prof.has(Math.round(prof.idx(tipK))))) { crash = 'drill'; break; }
      if (tipK < prev) {
        if (mode === 'cut') prof.boreTo(tipK, prev, sh, true);
        else if (mode === 'rub') { const r = prof.boreTo(tipK, prev, sh, false); if (r > rubR) rubR = r; }
      }
      prev = tipK; f = k / N;
    }
    ts.z = z0 + (zTs - z0) * f;
    A.quill.pos = clamp(q0 + (q - q0) * f, LIMITS.q[0], LIMITS.q[1]);
    if (crash) { A.quill.hw = A.quill.pos; this._tailCrash(crash); }
    if (prof) {
      const a = prof.acc, vol = a.vol;
      if (a.i1 >= a.i0) {
        const emptied = a.emptied, i0 = a.i0;
        prof.endEdit();
        if (emptied) { const piece = prof.separate(Math.max(1, i0 - 6)); if (piece) this._parted(piece); }
        prof.resetAcc();
      }
      if (mode === 'rub' && rubR > 0.05) this._rub(rubR);
      if (mode === 'cut' && vol > 0) this._evalDrill(vol, dist, revs, time, tool, tip1);
    }
    this._sync();
  }

  _tailCrash(what) {
    const st = this.state, hard = Math.abs(st.spindle.w) > 5;
    this._ev('crash', { what: what === 'drill' ? 'drill' : what, hard });
    if (hard) { st.spindle.dir = 0; st.spindle.brake = true; st.alarm = 'CRASH'; if (st.tailstock.tool) st.tailstock.tool.broken = true; }
    this._msg(what === 'drill' ? 'The drill ran into the chuck jaws' : what === 'tailstock' ? 'The carriage hit the tailstock' : 'The tool hit the drill');
  }

  _evalDrill(vol, dist, revs, time, tool, tipZ) {
    const st = this.state, c = st.cut, mat = MATERIALS[st.stock.material];
    const rpm = Math.abs(st.spindle.w);
    if (revs <= 0) return;
    const f = dist / revs; // mm / rev
    let Fc = (mat.kc * f * tool.d) / 2;
    const depth = (this.profile.endZ() ?? 0) - tipZ;
    if (depth > 3 * tool.d) Fc *= 1 + Math.min(1.5, (depth / tool.d - 3) * 0.3); // chips packing in the flutes
    const vc = (Math.PI * tool.d * rpm) / 1000;
    const P = (Fc * vc) / 60000, T = (Fc * tool.d) / 4000;
    const Tmax = Math.min(MACHINE.maxTorque, (MACHINE.powerKW * 9549) / Math.max(rpm, 1));
    const load = Math.max(Fc / (400 * tool.d), P / MACHINE.powerKW, T / Tmax);
    if (!c.active) this._ev('cutStart', { tool: tool.type });
    c.active = true; c.ap = tool.d / 2; c.f = f; c.vc = vc; c.fc = Fc; c.power = P; c.torque = T; c.load = load; c.mrr = vol / time; c.chipRate = c.mrr;
    this._noCutT = 0.25;
    this._ev('drilling', { depth, load });
    if (depth > 4 * tool.d && this._pkT <= 0) { this._pkT = 1.5; this._ev('drillPeck', { depth }); this._msg('Deep hole - peck: retract the drill to clear the chips'); }
    if (load > 1.5 && !tool.broken) { tool.broken = true; this._ev('toolBroken', { tool: tool.type, load }); this._msg('Drill snapped - too much feed'); } else if (load > 0.85 && this._warnT <= 0) { this._warnT = 1; this._ev('overload', { load }); this._msg('Drilling hard: ease the quill feed'); }
  }

  // ------------------------------------------------------------ time stepping
  step(dt) {
    if (!(dt > 0)) return;
    const n = Math.ceil(dt / 0.05);
    for (let i = 0; i < n; i++) this._tick(dt / n);
    this._sync();
  }
  /** Convenience for tests: advance `sec` seconds in fixed steps. */
  runFor(sec, dt = 1 / 60) { const n = Math.round(sec / dt); for (let i = 0; i < n; i++) this.step(dt); }

  _tick(h) {
    const st = this.state, sp = st.spindle;
    this.time += h;
    this._rubT -= h; this._warnT -= h; this._chipT -= h; this._pkT -= h;
    // ---- spindle: motor ramp / coasting / brake
    const w0 = sp.w;
    if (sp.dir !== 0 && !st.estop && st.alarm !== 'OVERLOAD') {
      const wt = sp.dir * sp.rpmSet;
      sp.w += clamp((wt - sp.w) * (1 - Math.exp(-h / 0.45)), -1800 * h, 1800 * h);
    } else {
      const tau = sp.brake ? 0.35 : 2.6;
      sp.w *= Math.exp(-h / tau);
      if (sp.brake) sp.w -= Math.sign(sp.w) * Math.min(Math.abs(sp.w), 600 * h);
      if (Math.abs(sp.w) < 0.6) sp.w = 0;
    }
    const wm = (w0 + sp.w) / 2;
    const revs = (wm / 60) * h; // signed revolutions this tick
    sp.angle += revs * 2 * Math.PI;
    this._noCutT -= h;
    if (this._noCutT <= 0) {
      const c = st.cut;
      if (c.active) this._ev('cutEnd');
      c.active = false; c.load = Math.max(0, c.load - 3 * h); c.mrr = 0; c.chipRate = 0; c.fc = 0; c.power = 0; c.torque = 0;
      this._defl *= Math.exp(-h / 0.08); st.deflection = this._defl;
    }
    if (Math.abs(revs) < 1e-12) return;
    // ---- leadscrew (always geared to the spindle) and the half nut dropping in on a thread-dial mark
    const A = this.ax, dir = st.feed.dir;
    const lead0 = this.lead;
    this.lead += -st.threadPitch * revs * dir;
    let revsLead = revs, tFrac = 0;
    if (st.halfNutPending) {
      if (st.estop || st.alarm === 'CRASH') st.halfNutPending = false;
      else {
        const u0 = (A.carriage.pos - lead0) / LEADSCREW_PITCH, u1 = (A.carriage.pos - this.lead) / LEADSCREW_PITCH;
        const k = u1 > u0 ? Math.floor(u0) + 1 : Math.ceil(u0) - 1;
        if (u1 !== u0 && (u1 > u0 ? k <= u1 : k >= u1)) {
          tFrac = (k - u0) / (u1 - u0);
          this._closeNut(k);
          revsLead = revs * (1 - tFrac);
        }
      }
    }
    let mode = null;
    if (st.halfNut) mode = 'lead'; else if (st.feed.engaged === 'long') mode = 'long'; else if (st.feed.engaged === 'cross') mode = 'cross';
    if (!mode) return;
    const was = st.cut.active;
    let res;
    if (mode === 'cross') {
      const dx = -st.feed.rate * revs * dir;
      res = this._move({ x: A.cross.pos + dx }, h, 'power');
      A.cross.hw = A.cross.pos + (dx > 0 ? 1 : -1) * A.cross.b / 2;
    } else {
      const r = mode === 'lead' ? revsLead : revs;
      const dz = mode === 'lead' ? this.lead + this.nutOff - A.carriage.pos : -st.feed.rate * revs * dir;
      const T0 = (sp.angle - r * 2 * Math.PI) / (2 * Math.PI), T1 = sp.angle / (2 * Math.PI);
      const zOld = A.carriage.pos;
      res = this._move({ z: A.carriage.pos + dz }, h, 'power');
      A.carriage.hw = A.carriage.pos + (dz > 0 ? 1 : -1) * A.carriage.b / 2;
      if (mode === 'lead' && this.profile && !res.crashed) this._leadCuts(T0, T1, zOld, A.carriage.pos);
    }
    if (mode !== 'lead') this._evalCut(res, this._cutMode());
    void was;
  }

  // Threading: one cut per spindle revolution (effective profile at the reference angle).
  _leadCuts(T0, T1, z0, z1) {
    const st = this.state, prof = this.profile, A = this.ax;
    if (T1 === T0 || st.spindle.w <= 0 || this.tool.broken) return;
    const lo = Math.min(T0, T1), hi = Math.max(T0, T1);
    const tool = this.tool, sh = this.toolShape;
    for (let k = Math.floor(lo) + 1; k <= Math.floor(hi); k++) {
      const f = (k - T0) / (T1 - T0);
      const z = z0 + (z1 - z0) * f;
      const tip = this._tipOf(z, A.cross.pos, A.compound.pos);
      prof.resetAcc();
      prof.cutAt(tip.z, tip.r + (this.opts.deflection ? this._defl : 0), sh, true, 0, st.threadPitch);
      const a = prof.acc;
      if (a.i1 >= a.i0 && tool.type === 'thread') prof.markThread(tip.z, st.threadPitch, st.feed.dir);
      const res = { area: a.area, vol: a.vol, depth: a.depth, revs: 1, time: 1 / (Math.abs(st.spindle.w) / 60), feedMark: st.threadPitch };
      this._after(prof, 'lead');
      this._evalCut(res, 'lead');
    }
  }

  // ------------------------------------------------------------ save / restore (page reload)
  /** Plain-JSON snapshot of the machine set-up and the bar in the chuck (the spindle is saved stopped). */
  saveState() {
    const st = this.state, ax = {};
    for (const k of Object.keys(this.ax)) { const a = this.ax[k]; ax[k] = { pos: a.pos, hw: a.hw, zero: a.zero }; }
    return {
      v: 1, ax, dro0: { ...this.dro0 }, lead: this.lead, nutOff: this.nutOff,
      gear: st.gear, toolIndex: st.toolIndex, tools: st.tools.map((t) => ({ type: t.type, broken: !!t.broken })),
      feed: { index: st.feed.index, dir: st.feed.dir }, threadIndex: st.threadIndex, compoundAngle: st.compound.angle,
      tailstock: { z: st.tailstock.z, tool: st.tailstock.tool ? { type: st.tailstock.tool.type, d: st.tailstock.tool.d } : null, locked: st.tailstock.locked },
      coolant: st.coolant, guardOpen: st.guardOpen,
      stock: st.stock && this.profile ? { dia: st.stock.dia, grip: st.stock.grip, material: st.stock.material, clamped: st.chuck.clamped, profile: this.profile.serialize() } : null,
      helix: this._helix,
    };
  }
  /** Restore saveState() output; returns false (and leaves a clean machine) when it does not fit. */
  restoreState(o) {
    if (!o || o.v !== 1) return false;
    try {
      const st = this.state;
      for (const k of Object.keys(this.ax)) {
        const a = this.ax[k], v = o.ax?.[k];
        if (!v || ![v.pos, v.hw, v.zero].every(Number.isFinite)) continue;
        a.pos = clamp(v.pos, a.lo, a.hi); a.hw = v.hw; a.zero = v.zero;
      }
      if (o.dro0) this.dro0 = { x: +o.dro0.x || 0, z: +o.dro0.z || 0 };
      this.lead = +o.lead || 0; this.nutOff = +o.nutOff || 0;
      this.setGear(o.gear ?? st.gear);
      if (Array.isArray(o.tools)) o.tools.forEach((t, i) => { if (st.tools[i] && t?.type) st.tools[i] = { type: t.type, broken: !!t.broken }; });
      st.toolIndex = ((Math.round(o.toolIndex) || 0) % 4 + 4) % 4;
      if (o.feed) { this.setFeedIndex(o.feed.index ?? st.feed.index); this.setFeedDir(o.feed.dir ?? 1); }
      this.setThreadIndex(o.threadIndex ?? st.threadIndex);
      this.setCompoundAngle(+o.compoundAngle || 0);
      if (o.tailstock) {
        st.tailstock.z = clamp(+o.tailstock.z || 400, LIMITS.tail[0], LIMITS.tail[1]);
        st.tailstock.locked = o.tailstock.locked !== false;
        this.setTailTool(o.tailstock.tool || null);
      }
      st.coolant = !!o.coolant; st.guardOpen = !!o.guardOpen;
      if (o.stock) {
        const p = TurnProfile.deserialize(o.stock.profile);
        if (p && p.endZ() != null) {
          this.profile = p;
          this.parts = [];
          st.stock = { dia: o.stock.dia, length: 0, stickout: 0, grip: o.stock.grip, material: MATERIALS[o.stock.material] ? o.stock.material : 'steel', endZ: p.endZ() };
          st.chuck.dia = o.stock.dia; st.chuck.clamped = !!o.stock.clamped;
          this._helix = o.helix || null;
        }
      }
      this.events.length = 0;
      this._sync();
      return true;
    } catch {
      this.reset();
      return false;
    }
  }

  // ------------------------------------------------------------ measuring
  measureOD(z, o) { return this.profile ? this.profile.measureOD(z, o) : null; }
  measureID(z, o) { return this.profile ? this.profile.measureID(z, o) : null; }
  lengthBetween(z1, z2, o) { return this.profile ? this.profile.lengthBetween(z1, z2, o) : 0; }
  /** Length from the chuck face to the free end (what a depth gauge / caliper reads). */
  stockLength() { const e = this.endZ(); return e == null ? 0 : +e.toFixed(2); }
}

function clamp_(v, a, b) { return v < a ? a : v > b ? b : v; }
void EMPTY;
