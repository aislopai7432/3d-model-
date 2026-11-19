// The CNC control: executes compiled ops in simulated machine time and owns the physical state of the
// machine (axis positions, spindle, coolant, doors, tool changer). Material removal and collision checks
// are delegated to `onMotion(a, b, op)`, called for every motion sub-segment; returning a string raises
// an alarm and stops the machine at that point.
import { MACHINE, ATC, pocketSteps, trapTime } from '../config.js';
import { defaultModal, modalCodes } from '../gcode/interpreter.js';
import { Emitter, clamp, smooth } from '../util/events.js';

const P = MACHINE.atcPockets;
export const pocketAngle = (k) => -((k - 1) / P) * Math.PI * 2;

function trapPos(t, L, v, a) {
  // distance travelled after time t on a trapezoidal profile
  const tAcc = v / a;
  const sAcc = 0.5 * a * tAcc * tAcc;
  if (L < 2 * sAcc) {
    const tp = Math.sqrt(L / a);
    if (t <= tp) return 0.5 * a * t * t;
    const td = Math.min(t, 2 * tp) - tp;
    return L / 2 + a * tp * td - 0.5 * a * td * td;
  }
  const tCruise = (L - 2 * sAcc) / v;
  if (t <= tAcc) return 0.5 * a * t * t;
  if (t <= tAcc + tCruise) return sAcc + v * (t - tAcc);
  const td = Math.min(t, 2 * tAcc + tCruise) - tAcc - tCruise;
  return L - sAcc + v * td - 0.5 * a * td * td;
}

function trapVel(t, L, v, a) {
  const tAcc = v / a;
  const sAcc = 0.5 * a * tAcc * tAcc;
  if (L < 2 * sAcc) {
    const tp = Math.sqrt(L / a);
    return t <= tp ? a * t : Math.max(0, a * (2 * tp - t));
  }
  const tCruise = (L - 2 * sAcc) / v;
  if (t <= tAcc) return a * t;
  if (t <= tAcc + tCruise) return v;
  return Math.max(0, v - a * (t - tAcc - tCruise));
}

export class Controller extends Emitter {
  constructor() {
    super();
    this.pos = { x: -312.4, y: -168.9, z: -96.5 }; // parked somewhere until homed
    this.homed = false;
    this.state = 'idle';
    this.holdReason = '';
    this.alarm = null;
    this.estop = false;
    this.spindle = { rpm: 0, cmd: 0, dir: 0, angle: 0 };
    this.coolant = { flood: false, mist: false };
    this.tool = 0;
    this.carousel = 1;
    this.atc = { slide: 0, angle: pocketAngle(1), lift: 0, busy: false, phase: '' };
    this.door = { pos: 1, target: 1 };
    this.doorInterlock = true;
    this.overrides = { feed: 100, rapid: 100, spindle: 100 };
    this.simSpeed = 1;
    this.singleBlock = false;
    this.optionalStop = true;
    this.stepOnce = false;
    this.program = null;
    this.exec = null;
    this.chain = []; // queued executions (e.g. homing before a program)
    this.modal = Object.freeze({ ...defaultModal(), tloLen: 0, codes: modalCodes(defaultModal()) });
    this.offsets = [];
    this.line = -1;
    this.speed = 0; // current path speed, mm/s machine time
    this.rapidMove = false;
    this.cutting = false;
    this.elapsed = 0;
    this.progress = 0;
    this.onMotion = null;
    this.pendingStart = null;
    this.dtg = { x: 0, y: 0, z: 0 };
    this._tmpA = { x: 0, y: 0, z: 0 };
    // 808D-style operating mode and program control
    this.mode = 'JOG'; // JOG | REF | MDA | AUTO
    this.ref = { x: false, y: false, z: false };
    this.dryRun = false;
    this.dryFeed = 2000;
    this.rov = true; // feed override knob also scales rapid traverse
    this.limits = null; // working area limitation (machine coordinates)
    this.message = '';
  }

  setMode(m) {
    if (m === this.mode) return true;
    if (this.exec || this.state === 'hold') {
      this.log('Mode change not possible while a program or block is active. Press RESET first.', 'warn');
      return false;
    }
    this.mode = m;
    this.emit('mode', m);
    return true;
  }

  // Run fn once the doors are closed (door interlock), or straight away.
  startWithDoor(fn) {
    if (this.doorInterlock && this.door.pos > 0.02) {
      this.door.target = 0;
      this.pendingStart = fn;
      this.log('Door interlock: closing the doors first');
      return;
    }
    fn();
  }

  // ------------------------------------------------------------ status helpers
  get busy() {
    return !!this.exec || this.state === 'running';
  }

  get running() {
    return this.state === 'running';
  }

  get kind() {
    return this.exec ? this.exec.kind : null;
  }

  setState(s, reason = '') {
    if (this.state === s && this.holdReason === reason) return;
    this.state = s;
    this.holdReason = reason;
    this.emit('state', s, reason);
  }

  log(msg, level = 'info') {
    this.emit('message', msg, level);
  }

  workPos(out = {}) {
    const o = this.offsets[this.modal.wcs - 54] || { x: 0, y: 0, z: 0 };
    const f = this.modal.frame;
    let bx = this.pos.x - o.x, by = this.pos.y - o.y;
    let bz = this.pos.z - o.z - (this.modal.tloLen || 0);
    if (f) {
      bx -= f.tx;
      by -= f.ty;
      bz -= f.tz;
      if (f.rot) {
        const a = (-f.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
        const x = c * bx - s * by;
        by = s * bx + c * by;
        bx = x;
      }
    }
    out.x = bx;
    out.y = by;
    out.z = bz;
    return out;
  }

  // ------------------------------------------------------------ operator actions
  cycleStart() {
    if (this.estop) return this.log('E-STOP is engaged. Release it with RESET first.', 'error');
    if (this.state === 'alarm') return this.log(`Alarm active: ${this.alarm}. Press RESET.`, 'error');
    if (this.state === 'hold') {
      if (this.doorInterlock && this.door.pos > 0.02) {
        this.door.target = 0;
        this.pendingStart = 'resume';
        this.log('Closing the doors before resuming');
        return;
      }
      this.setState('running');
      this.emit('cycle', 'resume');
      return;
    }
    if (this.exec) return;
    if (!this.program) return this.log('No program loaded', 'error');
    if (this.program.errors.length) {
      const e = this.program.errors[0];
      return this.log(`Program has ${this.program.errors.length} error(s). Line ${e.line + 1}: ${e.msg}`, 'error');
    }
    if (!this.program.ops.length) return this.log('Program has no executable blocks', 'warn');
    if (this.doorInterlock && this.door.pos > 0.02) {
      this.door.target = 0;
      this.pendingStart = 'start';
      this.log('Door interlock: closing the doors before cycle start');
      return;
    }
    this.startProgram();
  }

  startProgram() {
    this.emit('beforeStart');
    const prog = this.program;
    if (!prog || prog.errors.length) return;
    this.elapsed = 0;
    if (!this.homed) {
      this.log('Machine not homed: running the homing sequence first');
      // compile again once homed, so the program starts from the real position
      this.chain = [{ fn: () => this.startProgram() }];
      this.home();
      return;
    }
    this.begin(prog.ops, 'program');
    this.emit('cycle', 'start');
  }

  begin(ops, kind) {
    this.exec = { ops, i: 0, kind, started: false, sub: null };
    this.setState('running');
  }

  feedHold(reason = 'Feed hold') {
    if (this.state === 'running') {
      this.setState('hold', reason);
      this.emit('cycle', 'hold');
    }
  }

  step() {
    if (this.estop || this.state === 'alarm') return this.cycleStart();
    this.stepOnce = true;
    if (this.state === 'hold') {
      this.cycleStart();
      return;
    }
    if (!this.exec) this.cycleStart();
  }

  stop(msg = 'Program stopped') {
    const wasBusy = !!this.exec;
    if (this.atc.busy) this.finishAtcInstant();
    this.exec = null;
    this.chain = [];
    this.stepOnce = false;
    this.pendingStart = null;
    this.spindle.cmd = 0;
    this.spindle.dir = 0;
    this.setCoolant(false, false);
    this.speed = 0;
    this.line = -1;
    this.emit('line', -1);
    if (this.message) {
      this.message = '';
      this.emit('msg', '');
    }
    if (this.state !== 'alarm' && this.state !== 'estop') this.setState('idle');
    if (wasBusy) this.log(msg);
  }

  reset() {
    this.stop('Reset');
    this.estop = false;
    this.alarm = null;
    this.setState('idle');
    this.emit('reset');
  }

  emergencyStop() {
    if (this.estop) return;
    this.exec = null;
    this.chain = [];
    this.pendingStart = null;
    this.estop = true;
    this.spindle.cmd = 0;
    this.spindle.dir = 0;
    this.setCoolant(false, false);
    this.speed = 0;
    this.setState('estop', 'EMERGENCY STOP');
    this.log('EMERGENCY STOP pressed: all motion stopped. Press RESET to release.', 'error');
    this.emit('estop');
  }

  raiseAlarm(msg) {
    if (this.state === 'alarm') return;
    this.exec = null;
    this.chain = [];
    this.pendingStart = null;
    this.alarm = msg;
    this.spindle.cmd = 0;
    this.spindle.dir = 0;
    this.setCoolant(false, false);
    this.speed = 0;
    this.setState('alarm', msg);
    this.log(`ALARM: ${msg}`, 'error');
    this.emit('alarm', msg);
  }

  canManual() {
    return !this.estop && this.state !== 'alarm' && !this.exec;
  }

  // REF POINT mode: reference one axis (moves to its machine zero)
  refAxis(axis) {
    if (!this.canManual()) return this.log(this.exec ? 'Machine is busy' : 'Clear the alarm first', 'warn');
    const p = this.pos;
    const t = { ...p, [axis]: 0 };
    const op = this.manualMove({ ...p }, t, MACHINE.homingFeed);
    const ops = op ? [op] : [];
    ops.push({ t: 'homed', axis, time: 0 });
    this.begin(ops, 'homing');
  }

  home() {
    if (this.estop || this.state === 'alarm') return this.log('Clear the alarm / E-stop with RESET before homing', 'error');
    if (this.exec && this.exec.kind !== 'homing') return this.log('Stop the program before homing', 'warn');
    const f = MACHINE.homingFeed;
    const p = this.pos;
    const ops = [];
    const mv = (a, b, line = -1) => ops.push(this.manualMove(a, b, f));
    mv({ ...p }, { x: p.x, y: p.y, z: 0 });
    mv({ x: p.x, y: p.y, z: 0 }, { x: 0, y: 0, z: 0 });
    ops.push({ t: 'homed', time: 0 });
    this.log('Homing: Z first, then X and Y');
    this.begin(ops.filter(Boolean), 'homing');
  }

  manualMove(a, b, feed, rapid = false) {
    const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    if (len < 1e-6) return null;
    return {
      t: 'move', rapid, pts: Float64Array.from([a.x, a.y, a.z, b.x, b.y, b.z]), cum: Float64Array.from([0, len]), len,
      feed, vmax: feed / 60, tool: this.tool, tlen: 0, time: len / (feed / 60), line: -1, manual: true,
    };
  }

  clampTravel(p) {
    const t = this.limits || MACHINE.travel;
    return { x: clamp(p.x, t.x[0], t.x[1]), y: clamp(p.y, t.y[0], t.y[1]), z: clamp(p.z, t.z[0], t.z[1]) };
  }

  jog(axis, dist, feed) {
    if (!this.canManual()) return this.log(this.exec ? 'Stop the program before jogging' : 'Clear the alarm first', 'warn');
    const tgt = { ...this.pos };
    tgt[axis] += dist;
    const c = this.clampTravel(tgt);
    if (Math.abs(c[axis] - tgt[axis]) > 1e-9) this.log(`Soft limit: ${axis.toUpperCase()} travel ends at ${c[axis].toFixed(3)}`, 'warn');
    const op = this.manualMove({ ...this.pos }, c, feed);
    if (op) this.begin([op], 'jog');
  }

  jogStart(axis, dir, feed) {
    if (!this.canManual()) return;
    const tgt = { ...this.pos };
    tgt[axis] = (this.limits || MACHINE.travel)[axis][dir > 0 ? 1 : 0];
    const op = this.manualMove({ ...this.pos }, tgt, feed);
    if (op) this.begin([op], 'jog');
  }

  jogStop() {
    if (this.exec && this.exec.kind === 'jog') {
      this.exec = null;
      this.speed = 0;
      this.setState('idle');
    }
  }

  runOps(ops, kind) {
    if (!this.canManual()) {
      this.log(this.exec ? 'Machine is busy' : 'Clear the alarm first', 'warn');
      return false;
    }
    if (!ops.length) return false;
    this.begin(ops, kind);
    return true;
  }

  setDoor(open) {
    this.door.target = open ? 1 : 0;
    if (open && this.state === 'running' && this.doorInterlock && this.exec?.kind === 'program') {
      this.feedHold('Door opened');
      this.log('Door opened during the cycle: feed hold (door interlock)', 'warn');
    }
    this.emit('door', open);
  }

  setCoolant(flood, mist) {
    if (this.coolant.flood === flood && this.coolant.mist === mist) return;
    this.coolant.flood = flood;
    this.coolant.mist = mist;
    this.emit('coolant', this.coolant);
  }

  setSpindle(rpm, dir) {
    this.spindle.cmd = clamp(rpm, 0, MACHINE.maxRpm);
    this.spindle.dir = dir;
  }

  get spindleTarget() {
    const v = this.spindle.dir * this.spindle.cmd * (this.overrides.spindle / 100);
    return clamp(v, -MACHINE.maxRpm, MACHINE.maxRpm);
  }

  // ------------------------------------------------------------ main update
  update(dtReal) {
    const realDt = Math.min(dtReal, 0.1);
    // doors move in real time (they are an operator action)
    const d = this.door;
    if (d.pos !== d.target) {
      const before = d.pos;
      d.pos = d.target > d.pos ? Math.min(d.target, d.pos + realDt / 1.1) : Math.max(d.target, d.pos - realDt / 1.1);
      if (before > 0.02 && d.pos <= 0.02) this.emit('doorClosed');
      if (d.pos === 0 && this.pendingStart) {
        const ps = this.pendingStart;
        this.pendingStart = null;
        if (ps === 'resume') {
          this.setState('running');
        } else if (typeof ps === 'function') ps();
        else this.startProgram();
      }
    }
    const max = this.simSpeed === 'max';
    const dt = max ? 30 : realDt * this.simSpeed;
    const deadline = max ? performance.now() + 14 : 0;
    this.frameDist = 0;
    this.frameTime = 0;
    let remaining = dt;
    if (this.state === 'running' && this.exec) {
      remaining = this.runOps2(dt, deadline);
    }
    if (remaining > 0) this.physics(max ? realDt : remaining);
    if (!this.exec || this.state !== 'running') {
      this.speed = 0;
      this.cutting = false;
    }
    if (this.exec?.kind === 'program' && this.program && this.program.totalTime > 0) {
      const op = this.exec.ops[this.exec.i];
      const frac = this.exec.sub?.frac || 0;
      this.progress = op ? clamp((op.tStart + frac * (op.time || 0)) / this.program.totalTime, 0, 1) : 1;
    }
  }

  // Spindle ramp and other continuous physics over sim time t.
  physics(t) {
    const s = this.spindle;
    const tgt = this.spindleTarget;
    if (s.rpm !== tgt) {
      const acc = (this.estop ? 2.2 : 1) * MACHINE.spindleAccel * t;
      s.rpm = tgt > s.rpm ? Math.min(tgt, s.rpm + acc) : Math.max(tgt, s.rpm - acc);
    }
    s.angle += (s.rpm / 60) * Math.PI * 2 * t;
    if (s.angle > 1e6 || s.angle < -1e6) s.angle %= Math.PI * 2;
  }

  runOps2(dt, deadline) {
    let remaining = dt;
    let guard = 0;
    while (remaining > 1e-9 && this.exec && this.state === 'running') {
      if (deadline && (guard & 7) === 0 && performance.now() > deadline) return 0;
      guard++;
      const ex = this.exec;
      const op = ex.ops[ex.i];
      if (!op) {
        this.finishExec();
        break;
      }
      if (!ex.started) {
        ex.started = true;
        ex.sub = { frac: 0 };
        this.beginOp(op);
        if (!this.exec || this.state !== 'running') break;
      }
      const used = this.stepOp(op, remaining);
      if (this.exec !== ex) break;
      remaining -= used;
      this.physics(used);
      if (ex.kind === 'program') this.elapsed += used;
      if (ex.sub.done) {
        this.endOp(op);
        if (this.exec !== ex) break;
        ex.i++;
        ex.started = false;
        const next = ex.ops[ex.i];
        if (ex.kind === 'program' && (this.singleBlock || this.stepOnce) && op.line >= 0 && (!next || next.line !== op.line) && this.state === 'running') {
          if (next) {
            this.stepOnce = false;
            this.setState('hold', this.singleBlock ? 'Single block' : 'Step');
          }
        }
        if (!next) {
          this.finishExec();
          break;
        }
      } else if (used <= 1e-12) {
        break; // waiting on something external (should not happen)
      }
    }
    return Math.max(0, remaining);
  }

  finishExec() {
    const ex = this.exec;
    this.exec = null;
    this.speed = 0;
    if (!ex) return;
    if (ex.kind === 'program') {
      this.setState('complete');
      this.progress = 1;
      this.line = -1;
      this.emit('line', -1);
      this.emit('programEnd');
      this.log(`Program complete. Machine time ${fmtTime(this.elapsed)}`);
    } else {
      this.setState('idle');
      if (ex.kind === 'mdi') this.emit('mdiDone');
    }
    if (this.chain.length && this.state !== 'alarm' && this.state !== 'estop') {
      const next = this.chain.shift();
      if (next.fn) next.fn();
      else {
        this.begin(next.ops, next.kind);
        if (next.kind === 'program') this.emit('cycle', 'start');
      }
    }
  }

  beginOp(op) {
    if (op.st) this.modal = op.st;
    if (this.exec.kind === 'program' && op.line !== this.line) {
      this.line = op.line;
      this.emit('line', op.line);
    }
    switch (op.t) {
      case 'spindle':
        if (op.dir === 0) this.setSpindle(this.spindle.cmd, 0);
        else this.setSpindle(op.rpm, op.dir);
        this.emit('spindleCmd', op.rpm, op.dir);
        break;
      case 'coolant':
        this.setCoolant(op.flood, op.mist);
        break;
      case 'tool':
        this.beginToolChange(op);
        break;
      case 'offset':
        this.emit('offset', op.index, { x: op.x, y: op.y, z: op.z });
        break;
      case 'stop':
        break;
      case 'homed':
        if (op.axis) {
          this.ref[op.axis] = true;
          this.log(`Axis ${op.axis.toUpperCase()} referenced`);
        } else {
          this.ref = { x: true, y: true, z: true };
          this.log('All axes referenced (X0 Y0 Z0)');
        }
        this.homed = this.ref.x && this.ref.y && this.ref.z;
        this.emit('homed');
        break;
      case 'msg':
        this.message = op.text;
        this.emit('msg', op.text);
        break;
      default:
        break;
    }
  }

  endOp(op) {
    if (op.t === 'stop') {
      if (!op.optional || this.optionalStop) {
        this.setState('hold', op.optional ? 'M01 optional stop' : 'M00 program stop');
        this.log(`${op.optional ? 'M01 optional' : 'M00 program'} stop. Press Cycle Start to continue.`);
      }
    } else if (op.t === 'end') {
      // M30 / M02: the remaining ops are none; finishExec handles state.
    } else if (op.t === 'move') {
      this.dtg.x = this.dtg.y = this.dtg.z = 0;
    }
  }

  stepOp(op, avail) {
    const sub = this.exec.sub;
    switch (op.t) {
      case 'move': return this.stepMove(op, avail, sub);
      case 'spindle': {
        const diff = Math.abs(this.spindle.rpm - this.spindleTarget);
        const need = diff / MACHINE.spindleAccel;
        if (need <= avail) {
          sub.done = true;
          return need;
        }
        sub.frac = 0.5;
        return avail;
      }
      case 'dwell': {
        sub.t = (sub.t || 0) + avail;
        if (sub.t >= op.sec) {
          sub.done = true;
          return avail - (sub.t - op.sec);
        }
        sub.frac = sub.t / Math.max(1e-6, op.sec);
        return avail;
      }
      case 'tool': return this.stepToolChange(op, avail, sub);
      default:
        sub.done = true;
        return 0;
    }
  }

  stepMove(op, avail, sub) {
    if (sub.s == null) {
      sub.s = 0;
      sub.seg = 1;
      sub.t = 0;
      if (op.rapid) {
        const rov = this.rov && !op.manual ? Math.min(this.overrides.feed, 100) / 100 : 1;
        sub.v = Math.max(1, op.vmax * (this.overrides.rapid / 100) * Math.max(rov, 0.01));
        sub.T = trapTime(op.len, sub.v, MACHINE.accel);
      }
    }
    let s1, used;
    if (op.rapid) {
      const t1 = Math.min(sub.T, sub.t + avail);
      used = t1 - sub.t;
      sub.t = t1;
      s1 = t1 >= sub.T ? op.len : Math.min(op.len, trapPos(t1, op.len, sub.v, MACHINE.accel));
      this.speed = trapVel(t1, op.len, sub.v, MACHINE.accel);
    } else {
      const ov = op.manual ? 1 : this.overrides.feed / 100;
      const base = this.dryRun && !op.manual && this.exec?.kind === 'program' ? this.dryFeed : op.feed;
      const v = (Math.min(base, MACHINE.maxFeed) / 60) * ov;
      if (v <= 1e-6) {
        this.speed = 0;
        return avail; // 0% feed override: hold position, keep running
      }
      s1 = Math.min(op.len, sub.s + v * avail);
      used = (s1 - sub.s) / v;
      if (s1 >= op.len) used = Math.min(avail, (op.len - sub.s) / v);
      this.speed = v;
    }
    this.rapidMove = !!op.rapid;
    // walk the polyline from sub.s to s1, reporting each sub-segment to the motion handler
    const pts = op.pts, cum = op.cum;
    const n = cum.length;
    const a = this._tmpA;
    let alarm = null;
    while (sub.seg < n) {
      const segStart = cum[sub.seg - 1], segEnd = cum[sub.seg];
      const target = Math.min(s1, segEnd);
      if (target > sub.s + 1e-12) {
        const f = segEnd > segStart ? (target - segStart) / (segEnd - segStart) : 1;
        const i0 = (sub.seg - 1) * 3, i1 = sub.seg * 3;
        a.x = this.pos.x; a.y = this.pos.y; a.z = this.pos.z;
        this.pos.x = pts[i0] + (pts[i1] - pts[i0]) * f;
        this.pos.y = pts[i0 + 1] + (pts[i1 + 1] - pts[i0 + 1]) * f;
        this.pos.z = pts[i0 + 2] + (pts[i1 + 2] - pts[i0 + 2]) * f;
        this.frameDist += Math.hypot(this.pos.x - a.x, this.pos.y - a.y, this.pos.z - a.z);
        sub.s = target;
        if (this.onMotion) {
          alarm = this.onMotion(a, this.pos, op);
          if (alarm) break;
        }
      }
      if (s1 >= segEnd - 1e-9) sub.seg++;
      else break;
    }
    sub.s = s1;
    sub.frac = op.len > 0 ? s1 / op.len : 1;
    const e = pts.length - 3;
    this.dtg.x = pts[e] - this.pos.x;
    this.dtg.y = pts[e + 1] - this.pos.y;
    this.dtg.z = pts[e + 2] - this.pos.z;
    this.frameTime += used;
    if (alarm) {
      this.raiseAlarm(alarm);
      return used;
    }
    if (s1 >= op.len - 1e-9) {
      this.pos.x = pts[e]; this.pos.y = pts[e + 1]; this.pos.z = pts[e + 2];
      sub.done = true;
    }
    return Math.max(used, 0);
  }

  // ------------------------------------------------------------ tool changer
  beginToolChange(op) {
    const from = this.tool;
    const to = op.tool;
    const phases = [];
    this.atc.busy = true;
    if (this.spindle.rpm !== 0 || this.spindle.dir !== 0) {
      this.setSpindle(this.spindle.cmd, 0);
      phases.push({ name: 'spindle stop', wait: 'spindle' });
    }
    phases.push({ name: 'orient spindle', dur: ATC.orient });
    if (this.pos.z < 0) phases.push({ name: 'Z to tool change position', zHome: true });
    if (from) {
      const s = pocketSteps(this.carousel, from);
      if (s) phases.push({ name: `index to pocket ${from}`, dur: s * ATC.perPocket + ATC.indexSettle, angle: [this.carousel, from] });
      phases.push({ name: 'carousel in', dur: ATC.slideIn, slide: [0, 1] });
      phases.push({ name: 'unclamp tool', dur: ATC.unclamp, release: true, sound: 'air' });
      phases.push({ name: 'spindle up', dur: ATC.lift, lift: [0, 1] });
    } else {
      phases.push({ name: 'spindle up', dur: ATC.lift, lift: [0, 1] });
      phases.push({ name: 'carousel in', dur: ATC.slideIn, slide: [0, 1] });
    }
    if (to) {
      const s = pocketSteps(from || this.carousel, to);
      if (s) phases.push({ name: `index to pocket ${to}`, dur: s * ATC.perPocket + ATC.indexSettle, angle: [from || this.carousel, to] });
      phases.push({ name: 'spindle down', dur: ATC.lower, lift: [1, 0] });
      phases.push({ name: 'clamp tool', dur: ATC.clamp, grab: to, sound: 'clamp' });
    }
    phases.push({ name: 'carousel out', dur: ATC.slideOut, slide: [1, 0] });
    if (!to) phases.push({ name: 'spindle down', dur: ATC.lower, lift: [1, 0] });
    this.exec.sub.phases = phases;
    this.exec.sub.pi = 0;
    this.exec.sub.pt = 0;
    this.emit('toolchange', 'start', from, to);
    this.log(`Tool change T${from || 0} -> T${to}`);
  }

  stepToolChange(op, avail, sub) {
    let used = 0;
    const atc = this.atc;
    while (avail - used > 1e-12 && sub.pi < sub.phases.length) {
      const ph = sub.phases[sub.pi];
      atc.phase = ph.name;
      if (!ph.started) {
        ph.started = true;
        this.emit('toolchange', 'phase', ph);
        if (ph.zHome) {
          ph.z0 = this.pos.z;
          ph.L = Math.abs(ph.z0);
          ph.v = MACHINE.rapidZ / 60;
          ph.dur = trapTime(ph.L, ph.v, MACHINE.accel);
        }
      }
      if (ph.wait === 'spindle') {
        const need = Math.abs(this.spindle.rpm) / MACHINE.spindleAccel;
        const dt = Math.min(need, avail - used);
        this.physics(dt);
        used += dt;
        if (Math.abs(this.spindle.rpm) < 1e-6) { sub.pi++; continue; }
        break;
      }
      const left = ph.dur - sub.pt;
      const dt = Math.min(left, avail - used);
      sub.pt += dt;
      used += dt;
      const f = ph.dur > 0 ? clamp(sub.pt / ph.dur, 0, 1) : 1;
      const e = smooth(f);
      if (ph.zHome) {
        const a = { ...this.pos };
        this.pos.z = ph.z0 + Math.sign(-ph.z0) * trapPos(sub.pt, ph.L, ph.v, MACHINE.accel);
        if (f >= 1) this.pos.z = 0;
        this.speed = trapVel(sub.pt, ph.L, ph.v, MACHINE.accel);
        this.rapidMove = true;
        if (this.onMotion) {
          const alarm = this.onMotion(a, this.pos, op);
          if (alarm) { this.raiseAlarm(alarm); return used; }
        }
      }
      if (ph.slide) atc.slide = ph.slide[0] + (ph.slide[1] - ph.slide[0]) * e;
      if (ph.lift) atc.lift = (ph.lift[0] + (ph.lift[1] - ph.lift[0]) * e) * MACHINE.atcLift;
      if (ph.angle) {
        const a0 = pocketAngle(ph.angle[0]);
        let d = pocketAngle(ph.angle[1]) - a0;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        atc.angle = a0 + d * e;
      }
      if (f >= 1) {
        if (ph.release) {
          this.tool = 0;
          this.emit('toolInSpindle', 0);
        }
        if (ph.grab) {
          this.tool = ph.grab;
          this.emit('toolInSpindle', ph.grab);
        }
        if (ph.angle) this.carousel = ph.angle[1];
        if (ph.sound) this.emit('toolchange', 'sound', ph.sound);
        sub.pi++;
        sub.pt = 0;
      }
    }
    sub.frac = sub.pi / sub.phases.length;
    if (sub.pi >= sub.phases.length) {
      sub.done = true;
      atc.busy = false;
      atc.phase = '';
      this.speed = 0;
      const to = op.tool;
      this.tool = to;
      if (to) this.carousel = to;
      this.emit('toolchange', 'end', to);
    }
    return used;
  }

  finishAtcInstant() {
    const sub = this.exec?.sub;
    if (!sub?.phases) return;
    const op = this.exec.ops[this.exec.i];
    // complete the remaining phases without animation so the carousel stays consistent
    for (let i = sub.pi; i < sub.phases.length; i++) {
      const ph = sub.phases[i];
      if (ph.zHome) this.pos.z = 0;
      if (ph.slide) this.atc.slide = ph.slide[1];
      if (ph.lift) this.atc.lift = ph.lift[1] * MACHINE.atcLift;
      if (ph.angle) {
        this.atc.angle = pocketAngle(ph.angle[1]);
        this.carousel = ph.angle[1];
      }
      if (ph.release) this.tool = 0;
      if (ph.grab) this.tool = ph.grab;
    }
    this.atc.busy = false;
    this.atc.phase = '';
    if (op?.tool != null) this.tool = op.tool;
    this.emit('toolInSpindle', this.tool);
  }
}

export function fmtTime(sec) {
  if (!isFinite(sec)) return '--:--';
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(r).padStart(2, '0');
}
