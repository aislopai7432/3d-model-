// NGC-style control for the simulator: pendant keyboard, jog handle, key switches and the screen
// software (modes, displays, tabs, input line, offsets, editor, device manager, VPS, alarms, settings).
// It drives the same Controller / App as the 808D-style control; `app.settings.control` picks which
// one is shown ('haas' | '808d').
import { MACHINE, MATERIALS } from '../../config.js';
import { compileProgram, detectDialect } from '../../gcode/compile.js';
import { defaultModal, modalCodes } from '../../gcode/interpreter.js';
import { siemensDefault } from '../../gcode/siemens.js';
import { EXAMPLES_808 } from '../../gcode/examples808.js';
import { pocketAngle } from '../../sim/controller.js';
import { normName, validName } from '../programs.js';
import { buildPendant, CHARS, PHYS, CHAR_KEY } from './haas-keys.js';
import { VPS_TEMPLATES, defaults as vpsDefaults, generate as vpsGenerate } from './haas-vps.js';
import { paintScreen, drawPendantTexture, ALARM_TEXT, SETTINGS_GROUPS, settingDefs, haasCodes } from './haas-screen.js';
import { haasDefault } from '../../gcode/haas.js';
import { EXAMPLES_HAAS } from '../../gcode/examples-haas.js';

const $ = (s, r = document) => r.querySelector(s);
const STORE = 'milllab.haas';
const MODES = { EDIT: 'EDIT', MEMORY: 'MEM', MDI: 'MDI', HANDLE_JOG: 'JOG', ZERO_RETURN: 'ZERO', LIST_PROGRAM: 'LIST' };
const CTRL_MODE = { MEM: 'AUTO', MDI: 'MDA', JOG: 'JOG', ZERO: 'REF' };
const INC_MM = [0.001, 0.01, 0.1, 1];
const INC_IN = [0.0001, 0.001, 0.01, 0.1];
const JOGF_IN = [0.1, 1, 10, 100]; // in/min (bottom legend of the increment keys)
const JOGF_MM = [2.5, 25, 250, 2500]; // mm/min
export const DISPLAY_TABS = {
  position: ['Operator', 'Work', 'Machine', 'Dist To Go', 'All'],
  offset: ['Tool', 'Work'],
  commands: ['Devices', 'Timers', 'Macro Vars', 'Active Codes', 'Tool Table'],
  alarms: ['Active Alarm', 'Messages', 'Alarm History', 'Alarm Viewer', 'Key History'],
  diag: ['Features', 'Compensation', 'Diagnostics', 'Maintenance'],
  setting: ['Settings'],
  help: ['Help', 'Calculator'],
  list: ['Memory', 'USB'],
  edit: ['Editor', 'VPS'],
};
const TOOL_COLS = ['Tool Offset', 'Length Geometry (H)', 'Length Wear (H)', 'Diameter Geometry (D)', 'Diameter Wear (D)', 'Flutes', 'Actual Diameter', 'Tool Type', 'Approximate Length'];
export const HAAS_TYPES = [['flat', 'End Mill'], ['ball', 'Ball Nose'], ['bull', 'Bull Nose'], ['face', 'Shell Mill'], ['drill', 'Drill'], ['spot', 'Spot Drill'], ['chamfer', 'Chamfer']];
export { TOOL_COLS };

// Words of a block for the editor cursor: comments stay one word.
export function lineWords(line) {
  const out = [];
  const re = /\([^)]*\)?|;.*|[^\s(;]+/g;
  let m;
  while ((m = re.exec(line))) out.push({ s: m[0], a: m.index, b: m.index + m[0].length });
  return out;
}

let haasDialectCache = null;
// 'haas' when the Haas dialect is available in the G-code pipeline, otherwise ISO (which runs the same
// G-codes for everything this control generates).
export function haasDialect() {
  if (haasDialectCache) return haasDialectCache;
  try {
    const probe = '%\nO00001 (PROBE)\nG00 G90 G54 X0. Y0.\nG43 H01 Z10.\nG81 G98 Z-1. R1. F100.\nG80\nM30\n%';
    const r = compileProgram(probe, { tools: new Map([[1, { number: 1, length: 100, diameter: 6, type: 'flat', fluteLength: 20, flutes: 2 }]]), offsets: [], requireG43: true, arcTol: 0.01, forceDialect: 'haas' }, { pos: { x: 0, y: 0, z: 0 }, tool: 1, units: 21 });
    haasDialectCache = !r.errors.length && r.ops.length ? 'haas' : 'iso';
  } catch {
    haasDialectCache = 'iso';
  }
  return haasDialectCache;
}

// A Haas-format program starts with % or an O number.
export function looksHaas(text) {
  for (const raw of String(text || '').split('\n', 12)) {
    const l = raw.trim();
    if (!l) continue;
    return l === '%' || /^O\d{1,5}\b/i.test(l);
  }
  return false;
}

export class HaasControl {
  constructor(app) {
    this.app = app;
    this.power = true;
    this.boot = 0;
    this.mode = 'JOG';
    this.disp = 'position';
    this.tab = { position: 1, offset: 0, commands: 3, alarms: 0, diag: 2, setting: 0, help: 0, list: 0, edit: 0 };
    this.cur = {};
    this.view = {};
    this.input = '';
    this.shift = false;
    this.incIdx = 2;
    this.rapidSel = 100;
    this.handleAxis = 'x';
    this.handleMode = null; // null | 'scroll' | 'feed' | 'spindle'
    this.handleAcc = 0;
    this.handleAngle = 0;
    this.jogLock = false;
    this.jogHeld = null;
    this.estopLatched = false;
    this.alarms = [];
    this.alarmHist = [];
    this.keyHist = [];
    this.status = { text: '', lvl: 'info', t: 0 };
    this.popup = null;
    this.chip = 0;
    this.editCur = { line: 0, word: 0 };
    this.mdiCur = { line: 0, word: 0 };
    this.memPtr = 0;
    this.undo = [];
    this.mdiUndo = [];
    this.clip = '';
    this.sel = null; // { a, b, open } block selection in the editor
    this.lp = { row: 0, marked: new Set(), hist: [0], hpos: 0, search: '' };
    this.vps = { tpl: null, row: 0, dirRow: 0, vals: null, changed: new Set(), recent: [] };
    this.calc = { lines: [], res: null };
    this.graphics = { plane: 17, run: false, t: 0, speed: 1, zoom: 1 };
    this.timers = { thisCycle: 0, lastCycle: 0, session: 0 };
    this.st = this.load();
    this.lastStatusLog = '';
  }

  get c() {
    return this.app.controller;
  }

  get ui() {
    return this.app.ui;
  }

  get active() {
    return this.app.settings.control !== '808d';
  }

  get inch() {
    return this.app.settings.defaultUnits === 20;
  }

  // ------------------------------------------------------------------ persistence
  load() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(STORE) || 'null') || {}; } catch { /* ignore */ }
    const d = { setup: false, memLock: false, set: {}, messages: [], m30: [0, 0], powerOn: 0, cycleTotal: 0, feedTotal: 0, toolChanges: 0, opOrigin: { x: 0, y: 0, z: 0 }, hist: [] };
    const st = { ...d, ...s, set: { ...(s.set || {}) }, opOrigin: { ...d.opOrigin, ...(s.opOrigin || {}) } };
    this.alarmHist = (st.hist || []).map((a) => ({ ...a, t: new Date(a.t) }));
    return st;
  }

  save() {
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => {
      try {
        this.st.hist = this.alarmHist.slice(0, 100).map((a) => ({ ...a, t: a.t.getTime() }));
        localStorage.setItem(STORE, JSON.stringify(this.st));
      } catch { /* storage unavailable */ }
    }, 400);
  }

  // Haas setting value (number -> value) with the defaults of settingDefs
  set(n) {
    const def = settingDefs(this).find((s) => s.n === n);
    if (n in this.st.set) return this.st.set[n];
    return def ? def.def : undefined;
  }

  // ------------------------------------------------------------------ init / activation
  init() {
    const app = this.app, ui = this.ui;
    const root = document.getElementById('haas');
    this.root = root;
    const els = buildPendant(root);
    this.scr = els.screen;
    this.dialEl = els.dial;
    this.beaconEl = els.beacon;
    this.keyEls = new Map();
    for (const el of els.keys) {
      const id = el.dataset.k;
      if (!this.keyEls.has(id)) this.keyEls.set(id, []);
      this.keyEls.get(id).push(el);
    }
    this.scr.innerHTML = '<div class="hs-boot" hidden></div>' + ['modebar', 'mtitle', 'prog', 'main', 'bot', 'icons', 'inbar', 'popup'].map((p) => `<div class="hs-${p}" data-p="${p}"></div>`).join('');
    this.parts = {};
    for (const el of this.scr.querySelectorAll('[data-p]')) this.parts[el.dataset.p] = { el, html: null };
    this.bootEl = this.scr.querySelector('.hs-boot');
    this.bindKeys(root);
    this.bindHandle(els.handle);
    this.bindScreen();
    // hooks into the shared UI: actions used by the 3D pendant buttons, the workshop and the top bar
    const A = ui.actions;
    const wrap = (name, fn) => {
      const orig = A[name];
      A[name] = () => (this.active ? fn(orig) : orig());
    };
    wrap('cycleStart', () => this.cycleStart());
    wrap('feedHold', () => this.feedHold());
    wrap('estop', () => this.estop());
    wrap('reset', () => this.reset());
    wrap('door', (orig) => this.door(orig));
    wrap('help', (orig) => { orig(); this.helpModal(true); });
    const origHelpClose = A.helpClose;
    A.helpClose = () => { origHelpClose(); this.helpModal(false); };
    const origLog = ui.log.bind(ui);
    ui.log = (msg, lvl = 'info') => { origLog(msg, lvl); this.onLog(msg, lvl); };
    const c = this.c;
    c.on('alarm', (msg) => { if (this.active) this.addAlarm(alarmFromMessage(msg)); });
    c.on('mode', (m) => this.syncMode(m));
    c.on('programEnd', () => {
      this.st.m30[0]++; this.st.m30[1]++;
      this.timers.lastCycle = c.elapsed;
      if (this.set(83)) this.overridesDefault();
      this.save();
    });
    c.on('toolchange', (k) => { if (k === 'end') { this.st.toolChanges++; this.save(); } });
    c.on('estop', () => { if (this.active && !this.estopLatched) { this.estopLatched = true; this.addAlarm({ num: 107, text: ALARM_TEXT[107] }); } });
    // the spindle limit with the door open in SETUP mode (Setting 292)
    const proto = Object.getPrototypeOf(c);
    const desc = Object.getOwnPropertyDescriptor(proto, 'spindleTarget');
    Object.defineProperty(c, 'spindleTarget', {
      configurable: true,
      get: () => {
        const v = desc.get.call(c);
        const lim = this.spindleLimit();
        return lim != null ? Math.max(-lim, Math.min(lim, v)) : v;
      },
    });
    if (window.ResizeObserver) new ResizeObserver(() => { this.layout(); this.paint(); }).observe(root);
    window.addEventListener('keyup', (e) => this.handleKeyUp(e));
    // start-up: informative alarm 102 like the real control after power on
    this.addAlarm({ num: 102, text: ALARM_TEXT[102] }, true);
    this.say('Press RESET to clear alarm 102 SERVOS OFF, then POWER UP to zero return the machine.');
    this.applyActive();
  }

  applyActive() {
    const on = this.active;
    const app = this.app, c = this.c;
    document.body.classList.toggle('ctl-haas', on);
    const brand = document.querySelector('.brand-text span');
    if (brand) brand.textContent = on ? 'VMC-MINI · NGC-style control' : 'VMC-560 · 808D-style control';
    if (on) {
      c.doorInterlock = false;
      c.rov = !!this.set(101);
      c.overrides.rapid = this.rapidSel;
      if (!c.exec && c.state !== 'hold' && c.modal.dialect === 'siemens') this.isoModal();
      this.syncMode(c.mode);
    } else {
      app.applyControllerSettings();
      c.rov = true;
      c.overrides.rapid = 100;
      if (!c.exec && c.state !== 'hold' && c.modal.dialect !== 'siemens') {
        c.modal = Object.freeze({ ...siemensDefault(), tloLen: 0, tlo: 49, tloH: 0, codes: 'G0 G17 G90 G71 G500 G40 G64 G94 D0' });
      }
    }
    this.layout();
    setTimeout(() => app.viewer?.resize?.(), 30);
    if (app.game?.op) app.game.ui.layoutOp();
    this.paint(true);
  }

  isoModal() {
    const u = this.app.settings.defaultUnits || 21;
    const m = haasDialect() === 'haas' ? { ...haasDefault(u), tloLen: 0 } : { ...defaultModal(u), tloLen: 0 };
    m.codes = m.dialect === 'haas' ? haasCodes(m).join(' ') : modalCodes(m);
    this.c.modal = Object.freeze(m);
  }

  setControl(kind) {
    if (this.c.exec) return this.say('Stop the program before changing the control', 'warn');
    this.app.settings.control = kind;
    this.app.save();
    this.applyActive();
    if (kind === '808d') {
      this.ui.hmi.showArea(this.ui.hmi.area);
      this.ui.log('Control style: 808D. Switch back under SYSTEM > Settings.');
    } else this.say('Control style: NGC. Switch back with SETTING > Simulator.');
  }

  // Keyboard size: one CSS variable (--k = key pitch) from the space the pendant has.
  layout() {
    const root = this.root;
    if (!root || !this.active) return;
    const W = root.clientWidth, H = root.clientHeight;
    if (!W || !H) return;
    const phone = window.innerWidth <= 900;
    root.classList.toggle('phone', phone);
    let k;
    if (phone) k = Math.max(30, Math.min(42, (W - 20) / 10.6));
    else {
      const leftW = Math.max(70, Math.min(110, W * 0.11));
      root.style.setProperty('--lw', leftW + 'px');
      const sideW = 44;
      k = Math.min((W - leftW - sideW - 50) / 14.75, (H * 0.52 - 30) / 9.8);
      k = Math.max(22, Math.min(60, k));
    }
    root.style.setProperty('--k', k.toFixed(2) + 'px');
  }

  helpModal(open) {
    const body = $('#helpModal .modal-b');
    if (!body) return;
    if (open) {
      if (!this._help808) this._help808 = { html: body.innerHTML, title: $('#helpTitle').textContent };
      $('#helpTitle').textContent = 'Using the NGC-style control';
      body.innerHTML = `<ol>
        <li><b>Start up.</b> Press <b>RESET</b> to clear <i>102 SERVOS OFF</i>, then <b>POWER UP</b>: Z homes first, then X and Y.</li>
        <li><b>Set up.</b> <b>HANDLE JOG</b>, pick an increment (<b>.0001/.1</b> … <b>.1/100.</b>), press an axis key to select it and turn the handle (drag or scroll). <b>OFFSET</b> › Tool: jog the tool to the part top and press <b>TOOL OFFSET MEASURE</b>. OFFSET › Work: cursor to G54 X and press <b>PART ZERO SET</b> (X, then Y). F3 offers probing actions.</li>
        <li><b>Programs.</b> <b>LIST PROGRAM</b> shows the memory and the USB stick: <b>SELECT PROGRAM</b> makes one active, <b>INSERT</b> creates one, <b>ALTER</b> edits, <b>ERASE PROGRAM</b> deletes. <b>EDIT</b> opens the editor (INSERT / ALTER / DELETE / UNDO with the input line) and VPS templates (F4 generates G-code).</li>
        <li><b>Run.</b> <b>MEMORY</b> then <b>CYCLE START</b>. <b>SINGLE BLOCK</b>, <b>OPTION STOP</b>, <b>BLOCK DELETE</b>, <b>FEED HOLD</b>, the feed / spindle / rapid override keys. <b>MDI</b>: type a block (e.g. <code>T1 M06 ;</code>), INSERT, CYCLE START.</li>
        <li><b>Doors.</b> The SETUP MODE key switch (side panel) is locked = RUN mode: CYCLE START needs the door closed and the door stays locked while the machine moves. Unlocked = SETUP mode: jogging with the door open, rapids limited to 25 %, spindle to Setting 292, and CYCLE START must be held down.</li>
      </ol>
      <table class="keys-t">
        <tr><td><kbd>A</kbd>–<kbd>Z</kbd> <kbd>0</kbd>–<kbd>9</kbd> <kbd>.</kbd> <kbd>-</kbd> <kbd>;</kbd></td><td>Type on the input line</td></tr>
        <tr><td><kbd>Enter</kbd> <kbd>Backspace</kbd> <kbd>Space</kbd></td><td>ENTER, CANCEL, SPACE</td></tr>
        <tr><td><kbd>← → ↑ ↓</kbd> <kbd>PgUp</kbd> <kbd>PgDn</kbd> <kbd>Home</kbd> <kbd>End</kbd></td><td>Cursor keys</td></tr>
        <tr><td><kbd>Insert</kbd> <kbd>Delete</kbd> <kbd>Ctrl</kbd>+<kbd>Z</kbd></td><td>INSERT, DELETE, UNDO</td></tr>
        <tr><td><kbd>F1</kbd>–<kbd>F4</kbd></td><td>Function keys</td></tr>
        <tr><td><kbd>Ctrl</kbd>+<kbd>Enter</kbd> / <kbd>Pause</kbd></td><td>CYCLE START / FEED HOLD</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>RESET (simulator view) or step back (workshop)</td></tr>
      </table>
      <p class="muted">An independent training simulator with an NGC-style operating concept; it is not affiliated with or endorsed by any machine tool builder. Key legends follow the published operator's manual for learning purposes.</p>`;
    } else if (this._help808) {
      body.innerHTML = this._help808.html;
      $('#helpTitle').textContent = this._help808.title;
    }
  }

  // ------------------------------------------------------------------ messages / alarms
  say(text, lvl = 'info') {
    this.status = { text, lvl, t: performance.now() };
    this.paintSoon();
  }

  onLog(msg, lvl) {
    if (!this.active) return;
    if (/^(Mode |MDA: |Control ready)/.test(msg)) return;
    this.status = { text: msg, lvl, t: performance.now() };
    this.paintSoon();
  }

  addAlarm(a, quiet = false) {
    if (this.alarms.some((x) => x.num === a.num && x.text === a.text)) return;
    const al = { num: a.num, text: a.text, t: new Date() };
    this.alarms.push(al);
    this.alarmHist.unshift(al);
    this.alarmHist = this.alarmHist.slice(0, 200);
    if (!quiet && this.disp !== 'alarms' && this.mode !== 'EDIT') { /* the active codes pane shows it */ }
    this.save();
    this.paintSoon();
  }

  hasAlarm(n) {
    return this.alarms.some((a) => a.num === n);
  }

  // ------------------------------------------------------------------ key binding
  bindKeys(root) {
    const down = (e) => {
      const b = e.target.closest('[data-k]');
      if (!b || !root.contains(b)) return;
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      this.app.sound.init();
      const id = b.dataset.k;
      b.classList.add('down');
      try { b.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
      this.pressed = { id, el: b };
      this.press(id, {});
    };
    const up = (e) => {
      const p = this.pressed;
      if (!p) return;
      p.el.classList.remove('down');
      this.pressed = null;
      this.release(p.id);
    };
    root.addEventListener('pointerdown', down);
    root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', up);
    root.addEventListener('lostpointercapture', up);
    root.addEventListener('contextmenu', (e) => { if (e.target.closest('[data-k]')) e.preventDefault(); });
  }

  bindScreen() {
    this.scr.addEventListener('click', (e) => {
      if (!this.power) return;
      const t = e.target.closest('[data-tab],[data-row],[data-pick],[data-fk]');
      if (!t) return;
      if (t.dataset.tab != null) {
        const d = t.dataset.disp || this.disp;
        this.tab[d] = +t.dataset.tab;
        this.onTab(d);
      } else if (t.dataset.fk) this.press(t.dataset.fk, {});
      else if (t.dataset.row != null) {
        const key = t.dataset.cur;
        const cur = this.cursor(key);
        cur.row = +t.dataset.row;
        if (t.dataset.col != null) cur.col = +t.dataset.col;
        if (key === 'edit') { this.editCur = { line: +t.dataset.row, word: +(t.dataset.col || 0) }; }
        if (key === 'mdi') { this.mdiCur = { line: +t.dataset.row, word: +(t.dataset.col || 0) }; }
        if (key === 'vpsdir') this.vps.dirRow = +t.dataset.row;
        if (key === 'vps') this.vps.row = +t.dataset.row;
      }
      this.paint();
    });
  }

  cursor(key, def = {}) {
    if (!this.cur[key]) this.cur[key] = { row: 0, col: 0, ...def };
    return this.cur[key];
  }

  bindHandle(el) {
    let drag = null;
    const center = () => {
      const r = el.querySelector('svg').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.app.sound.init();
      const c = center();
      drag = { a: Math.atan2(e.clientY - c.y, e.clientX - c.x), acc: 0 };
      el.setPointerCapture(e.pointerId);
      el.classList.add('grab');
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const c = center();
      const a = Math.atan2(e.clientY - c.y, e.clientX - c.x);
      let d = a - drag.a;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      drag.a = a;
      drag.acc += d;
      const det = (Math.PI * 2) / 100;
      while (drag.acc >= det) { drag.acc -= det; this.handleClick(1); }
      while (drag.acc <= -det) { drag.acc += det; this.handleClick(-1); }
    });
    const end = () => { drag = null; el.classList.remove('grab'); };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const n = Math.max(1, Math.min(10, Math.round(Math.abs(e.deltaY) / 40) || 1));
      for (let i = 0; i < n; i++) this.handleClick(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
  }

  // One detent of the jog handle: jogs the selected axis, or scrolls, or changes an override.
  handleClick(dir) {
    this.handleAngle += dir * 3.6;
    if (this.dialEl) this.dialEl.setAttribute('transform', `rotate(${this.handleAngle} 50 50)`);
    if (!this.power) return;
    if (Math.random() < 0.5) this.app.sound.tone?.(2400, 0.002, 0.012, 0.02);
    if (this.handleMode === 'feed') return this.setFeedOv(this.c.overrides.feed + dir, true);
    if (this.handleMode === 'spindle') return this.setSpinOv(this.c.overrides.spindle + dir, true);
    if (this.handleMode === 'scroll') return this.press(dir > 0 ? 'UP' : 'DOWN', { handle: true });
    if (this.mode !== 'JOG') {
      if (!this._hwWarn || performance.now() - this._hwWarn > 2500) { this._hwWarn = performance.now(); this.say('The jog handle jogs in HANDLE JOG mode (or select HANDLE SCROLL / HANDLE FEED / HANDLE SPINDLE)', 'warn'); }
      return;
    }
    if (!this.motionOk('jog')) return;
    const inc = (this.inch ? INC_IN[this.incIdx] * 25.4 : INC_MM[this.incIdx]);
    this.handleAcc += dir * inc;
    this.flushHandle();
  }

  flushHandle() {
    const c = this.c;
    if (Math.abs(this.handleAcc) < 1e-7) return;
    if (c.exec) { if (c.exec.kind !== 'jog') this.handleAcc = 0; return; }
    if (!c.canManual()) { this.handleAcc = 0; return; }
    const d = this.handleAcc;
    this.handleAcc = 0;
    const feed = Math.max(60, Math.min(this.rapidLimit() * MACHINE.rapidXY / 100, Math.abs(d) * 1200));
    c.jog(this.handleAxis, d, feed);
  }

  // ------------------------------------------------------------------ physical keyboard
  handleKey(e) {
    if (!this.active) return false;
    const g = this.app.game;
    if (g && g.mode === 'workshop' && (!g.op || g.ui.topModal() || g.measuring)) return false;
    const t = e.target;
    if (t && (t.isContentEditable || /^(TEXTAREA|SELECT)$/.test(t.tagName) || (t.tagName === 'INPUT' && !/^(button|checkbox|radio|range)$/i.test(t.type)))) return false;
    if (!$('#wizard').hidden || !$('#helpModal').hidden) return false;
    if (e.altKey || e.metaKey) return false;
    let id = null, shift = false;
    if (e.ctrlKey) {
      if (e.key === 'z' || e.key === 'Z') id = 'UNDO';
      else if (e.key === 'Enter') id = 'CYCLE_START';
      else return false;
    } else if (PHYS[e.key]) id = PHYS[e.key];
    else if (e.key === 'Escape') {
      if (g && g.mode === 'workshop') return false;
      id = 'RESET';
    } else if (e.key.length === 1) {
      const ch = /[a-z]/.test(e.key) ? e.key.toUpperCase() : e.key;
      const m = CHAR_KEY[ch];
      if (m) { id = m[0]; shift = m[1]; }
    }
    if (!id) return false;
    e.preventDefault();
    e.stopImmediatePropagation();
    const repeatable = /^(UP|DOWN|LEFT|RIGHT|PAGE_UP|PAGE_DOWN|CANCEL|SPACE|A_|N_)/.test(id);
    if (e.repeat && !repeatable) return true;
    for (const el of this.keyEls.get(id) || []) {
      el.classList.add('down');
      setTimeout(() => el.classList.remove('down'), 110);
    }
    this.press(id, { shift, phys: true });
    if (/^F[34]$/.test(id)) this._physHeld = id;
    return true;
  }

  handleKeyUp(e) {
    if (this._physHeld && PHYS[e.key] === this._physHeld) {
      this.release(this._physHeld);
      this._physHeld = null;
    }
  }

  // ------------------------------------------------------------------ key dispatch
  press(id, o = {}) {
    if (!this.active) return;
    const app = this.app;
    if (id !== 'POWER_ON' && !this.power) return;
    if (this.boot > 0 && id !== 'POWER_OFF') return;
    if (!o.handle) {
      this.keyHist.unshift({ id, t: new Date() });
      if (this.keyHist.length > 2000) this.keyHist.length = 2000;
      app.sound.click?.();
    }
    // a popup takes the keys first
    if (this.popup && this.popupKey(id, o)) { this.paint(); return; }
    const ch = CHARS[id];
    if (ch) {
      const sh = this.shift || o.shift;
      this.shift = false;
      this.typeChar(sh ? ch[1] : ch[0]);
      this.paint();
      return;
    }
    const fn = this['k_' + id];
    if (fn) fn.call(this, o);
    else if (MODES[id]) this.selectMode(MODES[id]);
    else if (id.startsWith('INC_')) this.selectInc(+id.slice(4) - 1);
    else if (id.startsWith('JOG_')) this.jogKey(id.slice(4), o);
    this.paint();
  }

  release(id) {
    if (id.startsWith('JOG_') && this.jogHeld === id) {
      this.jogHeld = null;
      if (!this.jogLock) this.c.jogStop();
    }
    if (id === 'CYCLE_START' && this._holdToRun) {
      this._holdToRun = false;
      if (this.c.state === 'running') this.c.feedHold('Cycle start released (SETUP mode, door open)');
    }
    if ((id === 'F3' || id === 'F4') && this._devSpin) {
      this._devSpin = false;
      this.c.setSpindle(this.c.spindle.cmd, 0);
      this.say('Spindle stopped (key released)');
    }
    this.paint();
  }

  typeChar(ch) {
    // the jog handle axis letters in ZERO RETURN SINGLE, the editor and every field use the input line
    if (this.input.length >= 80) return this.say('Input line is full', 'warn');
    this.input += ch;
  }

  paintSoon() {
    if (this._paintQ) return;
    this._paintQ = requestAnimationFrame(() => { this._paintQ = 0; this.paint(); });
  }

  paint(force = false) {
    if (!this.active || !this.scr) return;
    paintScreen(this, force);
    this.paintKeys();
  }

  paintKeys() {
    const c = this.c, s = this.app.settings;
    const sd = c.spindle.dir, still = Math.abs(c.spindle.rpm) < 1 && sd === 0;
    const lit = {
      EDIT: this.mode === 'EDIT', MEMORY: this.mode === 'MEM', MDI: this.mode === 'MDI', HANDLE_JOG: this.mode === 'JOG', ZERO_RETURN: this.mode === 'ZERO', LIST_PROGRAM: this.mode === 'LIST',
      SINGLE_BLOCK: c.singleBlock, OPTION_STOP: c.optionalStop, BLOCK_DELETE: !!s.blockDelete, GRAPHICS: this.disp === 'graphics',
      COOLANT: c.coolant.flood, HANDLE_SCROLL: this.handleMode === 'scroll', HANDLE_FEED: this.handleMode === 'feed', HANDLE_SPINDLE: this.handleMode === 'spindle',
      INC_1: this.incIdx === 0, INC_2: this.incIdx === 1, INC_3: this.incIdx === 2, INC_4: this.incIdx === 3, JOG_LOCK: this.jogLock,
      SP_FWD: sd > 0, SP_REV: sd < 0, SP_STOP: still, RAPID_5: this.rapidSel === 5, RAPID_25: this.rapidSel === 25, RAPID_50: this.rapidSel === 50, RAPID_100: this.rapidSel === 100,
      CHIP_FWD: this.chip > 0, CHIP_REV: this.chip < 0, SHIFT: this.shift,
      CYCLE_START: c.state === 'running' && !!c.exec && c.exec.kind !== 'jog', FEED_HOLD: c.state === 'hold',
      MEMORY_LOCK: this.st.memLock, SETUP_MODE: this.st.setup, WORK_LIGHT: this.app.settings.lights !== false,
      POWER_ON: this.power, ESTOP: this.estopLatched,
    };
    const key = Object.entries(lit).map(([k, v]) => (v ? k : '')).join(',') + '|' + this.power + this.handleAxis + this.incIdx + this.handleMode;
    if (key === this._litKey) return;
    this._litKey = key;
    for (const [id, els] of this.keyEls) for (const el of els) el.classList.toggle('lit', !!lit[id] && (this.power || id === 'POWER_ON'));
    this.root.classList.toggle('pwr-off', !this.power);
    const hc = $('#hpHandleCap');
    if (hc) hc.textContent = this.handleMode ? { scroll: 'SCROLL', feed: 'FEED %', spindle: 'SPINDLE %' }[this.handleMode] : `${this.handleAxis.toUpperCase()}  ${this.inch ? INC_IN[this.incIdx] : INC_MM[this.incIdx]}`;
    const ml = $('#hpMemLbl'), sl = $('#hpSetupLbl');
    if (ml) ml.textContent = this.st.memLock ? 'LOCKED' : 'UNLOCKED';
    if (sl) sl.textContent = this.st.setup ? 'SETUP' : 'RUN';
  }

  // ------------------------------------------------------------------ periodic update (ui.update, ~15 Hz)
  tick() {
    if (!this.active) return;
    const now = performance.now();
    const dt = this._lastTick ? Math.min(0.5, (now - this._lastTick) / 1000) : 0;
    this._lastTick = now;
    const c = this.c;
    if (this.boot > 0) {
      this.boot -= dt;
      if (this.boot <= 0) {
        this.boot = 0;
        this.addAlarm({ num: 102, text: ALARM_TEXT[102] });
        this.say('Control ready. Close the door, press RESET, then POWER UP.');
      }
    }
    if (this.power) {
      this.st.powerOn += dt;
      this.timers.session += dt;
      if (c.exec?.kind === 'program' && c.state === 'running') {
        this.timers.thisCycle = c.elapsed;
        this.st.cycleTotal += dt;
        if (c.speed > 0 && !c.rapidMove) this.st.feedTotal += dt;
      }
      if (now - (this._stSave || 0) > 10000) { this._stSave = now; this.save(); }
    }
    this.flushHandle();
    // rapid limit with the door open in SETUP mode
    const want = Math.min(this.rapidSel, this.rapidLimit());
    if (c.overrides.rapid !== want) c.overrides.rapid = want;
    // run mode: the door is locked while the machine moves; opening it while running = door hold
    if (this.st.setup && c.door.target > 0.5 && c.state === 'running' && c.exec && c.exec.kind !== 'jog' && c.exec.kind !== 'homing' && !this._holdToRun) {
      c.feedHold('Door Hold');
    }
    if (this.disp === 'graphics') this.graphicsTick(dt);
    this.beacon(now);
    this.paint();
  }

  beaconState() {
    const c = this.c;
    if (!this.power) return 'off';
    if (c.estop || this.alarms.some((a) => a.num !== 102) || c.state === 'alarm') return 'red';
    if (c.state === 'running' && c.exec) return 'green';
    if (c.state === 'hold') return 'green-flash';
    if (this.app.tools.some((t) => (t.wear || 0) >= 100)) return 'yellow';
    return 'off';
  }

  beacon(now) {
    const b = this.beaconState();
    const on = Math.floor(now / 420) % 2 === 0;
    const col = b === 'green' ? 'green' : b === 'green-flash' ? (on ? 'green' : '') : b === 'red' ? (on ? 'red' : '') : b === 'yellow' ? (on ? 'yellow' : '') : '';
    if (this.beaconEl && this.beaconEl.dataset.c !== col) this.beaconEl.dataset.c = col;
    this.beaconNow = b;
  }

  // ------------------------------------------------------------------ safety helpers
  doorOpen() {
    return this.c.door.target > 0.5 || this.c.door.pos > 0.02;
  }

  rapidLimit() {
    return this.st.setup && this.doorOpen() ? 25 : 100;
  }

  spindleLimit() {
    if (!this.active || !this.st.setup || !this.doorOpen()) return null;
    return this.set(292);
  }

  // Can the machine move? kind: 'jog' | 'cycle' | 'home' | 'spindle' | 'atc'
  motionOk(kind) {
    const c = this.c;
    if (!this.power) return false;
    if (c.estop || this.estopLatched) { this.say('107 EMERGENCY STOP: release the E-STOP and press RESET', 'error'); return false; }
    if (this.hasAlarm(102)) { this.say('102 SERVOS OFF: press RESET', 'error'); return false; }
    if (this.alarms.length || c.state === 'alarm') { this.say('Alarm active: press RESET (ALARMS shows the list)', 'error'); return false; }
    const door = this.doorOpen();
    if (door && (kind === 'spindle' || kind === 'atc')) { this.say(`Door open: ${kind === 'atc' ? 'the tool changer' : 'the spindle'} cannot run with the door open`, 'warn'); return false; }
    if (door && !this.st.setup) {
      this.say(`Door open (RUN mode): close the door${kind === 'jog' ? ', or turn the SETUP MODE key to jog with the door open' : ''}`, 'warn');
      return false;
    }
    if (kind === 'jog' && !c.homed && !this.set(53)) {
      this.say('Zero return required: press POWER UP (or ZERO RETURN, ALL) before jogging (Setting 53)', 'warn');
      return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ modes
  selectMode(m) {
    const c = this.c;
    // pressing the mode key of a tabbed display again selects the next tab
    if (m === this.mode && (m === 'LIST' || m === 'EDIT')) {
      const d = m === 'LIST' ? 'list' : 'edit';
      if (this.disp === d) { this.tab[d] = (this.tab[d] + 1) % DISPLAY_TABS[d].length; this.onTab(d); return; }
    }
    const target = CTRL_MODE[m];
    if (target && target !== c.mode) {
      if (!c.setMode(target)) {
        this.say('Mode change is not possible while a program or MDI is active: FEED HOLD, then RESET', 'warn');
        return;
      }
    }
    this.mode = m;
    this.input = this.input && m !== 'MDI' && m !== 'EDIT' ? this.input : this.input;
    if (m === 'EDIT') this.disp = 'edit';
    else if (m === 'LIST') { this.disp = 'list'; this.lpClamp(); }
    else if (m === 'MEM' || m === 'MDI') { if (this.disp !== 'graphics') this.disp = 'program'; }
    else if (m === 'JOG' || m === 'ZERO') this.disp = 'position';
    if (m === 'JOG' && this.tab.position === 1 && this.disp === 'position') this.tab.position = 0;
    this.ui.renderMCP?.();
    this.jogLock = false;
  }

  syncMode(cm) {
    if (!this.active) return;
    const want = { AUTO: 'MEM', MDA: 'MDI', JOG: 'JOG', REF: 'ZERO' }[cm];
    if (!want) return;
    if (CTRL_MODE[this.mode] === cm) return;
    if ((this.mode === 'EDIT' || this.mode === 'LIST') && cm === 'JOG') return;
    this.mode = want;
    if (want === 'MEM' || want === 'MDI') { if (this.disp !== 'graphics') this.disp = 'program'; }
    this.paintSoon();
  }

  // ------------------------------------------------------------------ function keys
  k_RESET() {
    const c = this.c, app = this.app;
    this.input = '';
    this.shift = false;
    if (this.popup) this.popup = null;
    if (this.estopLatched) {
      this.say('107 EMERGENCY STOP: release (twist) the E-STOP button first, then RESET', 'error');
      return;
    }
    const was = c.exec?.kind === 'program' || c.state === 'hold' || c.state === 'alarm';
    if (this.hasAlarm(107)) {
      this.alarms = this.alarms.filter((a) => a.num === 102);
      this.addAlarm({ num: 102, text: ALARM_TEXT[102] });
      this.say('Alarm 107 cleared. Press RESET again to switch the servos on (102)');
      return;
    }
    this.alarms = [];
    this.graphics.run = false;
    this._holdToRun = false;
    this.jogLock = false;
    c.reset();
    app.toolpath.setProgress(-1);
    this.ui.editor.setExecLine(-1);
    this.ui.hmi.clearAlarms();
    if (this.set(31)) this.memPtr = 0;
    if (this.set(88)) this.overridesDefault();
    if (c.modal.dialect === 'siemens' && !c.exec) this.isoModal();
    app.compile();
    this.say(was ? 'RESET: program stopped, alarms cleared' : 'RESET');
  }

  reset() {
    if (!this.power) return;
    this.press('RESET');
  }

  overridesDefault() {
    const c = this.c;
    c.overrides.feed = 100;
    c.overrides.spindle = 100;
    this.rapidSel = 100;
    this.ui.renderMCP?.();
  }

  k_POWER_UP() {
    const c = this.c;
    if (c.exec) return this.say('POWER UP: the machine is busy', 'warn');
    if (!this.motionOk('home')) return;
    if (this.doorOpen()) return this.say('Close the door before POWER UP', 'warn');
    this.say('POWER UP: zero return, Z first, then X and Y');
    const tool = this.set(81);
    c.home();
    if (tool > 0 && tool !== c.tool && this.app.tools.some((t) => t.number === tool)) c.chain = [{ fn: () => this.runMDI(`T${tool} M06`) }];
  }

  k_RECOVER() {
    const c = this.c, atc = c.atc;
    if (c.exec) return this.say('Tool changer recovery: the machine is busy', 'warn');
    if (atc.busy || atc.slide > 0.001 || atc.lift > 0.01) {
      atc.slide = 0;
      atc.lift = 0;
      atc.busy = false;
      atc.phase = '';
      atc.angle = pocketAngle(c.carousel);
      c.emit('toolInSpindle', c.tool);
      this.say(`Tool changer recovery complete: carousel retracted, T${c.tool} in the spindle`);
    } else this.say('Tool changer recovery: the tool changer is in position, no recovery needed');
  }

  k_TOOL_OFS_MEAS() {
    const c = this.c, app = this.app;
    if (!c.homed) return this.say('Zero return required before TOOL OFFSET MEASURE', 'warn');
    if (this.locked('offsets')) return;
    if (!(this.disp === 'offset' && this.tab.offset === 0)) {
      this.disp = 'offset';
      this.tab.offset = 0;
      const cur = this.cursor('tool', { col: 1 });
      const i = this.toolRows().indexOf(c.tool);
      if (i >= 0) cur.row = i;
      cur.col = 1;
    }
    const cur = this.cursor('tool', { col: 1 });
    const n = this.toolRows()[cur.row];
    const t = app.tools.find((x) => x.number === n);
    if (!t) return this.say(`Tool offset ${n}: no tool in pocket ${n}`, 'warn');
    if (!c.tool) return this.say('TOOL OFFSET MEASURE: no tool in the spindle', 'warn');
    const wo = app.offsets[(c.modal.wcs >= 54 && c.modal.wcs <= 59 ? c.modal.wcs : 54) - 54];
    const H = c.pos.z - (this.set(64) ? wo.z : 0);
    cur.col = 1;
    const apply = () => {
      this.setToolOffset(t, 1, H);
      this.say(`T${n} length geometry (H) = ${this.fmtNum(H)}${n !== c.tool ? ` (CAUTION: T${c.tool} is in the spindle)` : ''}. Press NEXT TOOL for the next tool.`);
    };
    this.guardChange(this.toolGeom(t).h, H, apply);
  }

  k_NEXT_TOOL() {
    const n = this.nextTool(1);
    if (n == null) return this.say('No other tool in the magazine', 'warn');
    if (!this.toolChangeOk()) return;
    this.runMDI(`T${n} M06`);
    if (this.disp === 'offset' && this.tab.offset === 0) {
      const i = this.toolRows().indexOf(n);
      if (i >= 0) this.cursor('tool').row = i;
    }
  }

  k_TOOL_RELEASE() {
    const c = this.c;
    if (!['MDI', 'ZERO', 'JOG'].includes(this.mode)) return this.say('TOOL RELEASE works in MDI, ZERO RETURN and HANDLE JOG', 'warn');
    if (!c.canManual()) return this.say('TOOL RELEASE: the machine is busy', 'warn');
    if (Math.abs(c.spindle.rpm) > 1) return this.say('TOOL RELEASE: stop the spindle first', 'warn');
    if (!c.tool) return this.say('TOOL RELEASE: the spindle is empty. Load a tool with ATC FWD or T_ M06 in MDI', 'warn');
    const n = c.tool;
    c.tool = 0;
    c.emit('toolInSpindle', 0);
    this.app.sound.air?.();
    this.say(`Tool released: T${n} taken out of the spindle and put back in pocket ${n}`);
  }

  k_PART_ZERO_SET() {
    const c = this.c, app = this.app;
    if (!c.homed) return this.say('Zero return required before PART ZERO SET', 'warn');
    if (this.locked('offsets')) return;
    if (!(this.disp === 'offset' && this.tab.offset === 1)) {
      this.disp = 'offset';
      this.tab.offset = 1;
      const cur = this.cursor('work', { row: 1, col: 1 });
      const w = c.modal.wcs >= 54 && c.modal.wcs <= 59 ? c.modal.wcs : 54;
      cur.row = w - 53;
      cur.col = 1;
      this.say(`Work offsets: cursor on G${w} X. Press PART ZERO SET to load X, again for Y`);
      return;
    }
    const cur = this.cursor('work', { row: 1, col: 1 });
    if (cur.row === 0) return this.say('G52 is set by the program; select G54..G59', 'warn');
    const i = cur.row - 1;
    const col = Math.max(1, Math.min(3, cur.col || 1));
    const axis = 'xyz'[col - 1];
    const o = app.offsets[i];
    let v;
    if (axis === 'z') {
      const t = app.tools.find((x) => x.number === c.tool);
      v = c.pos.z - (t ? t.length + (t.dLength || 0) : 0);
    } else v = c.pos[axis];
    o[axis] = Math.round(v * 1000) / 1000;
    app.offsetsChanged();
    this.say(`G${54 + i} ${axis.toUpperCase()} = ${this.fmtNum(o[axis])}${axis === 'z' ? ' (WARNING: Z work offset loaded from the tool tip; check before running)' : ''}`, axis === 'z' ? 'warn' : 'info');
    if (col < 3) cur.col = col + 1;
  }

  k_F1() { this.fkey(1); }
  k_F2() { this.fkey(2); }
  k_F3() { this.fkey(3); }
  k_F4() { this.fkey(4); }

  // ------------------------------------------------------------------ display keys
  showDisp(d) {
    if (this.disp === d && DISPLAY_TABS[d]) {
      this.tab[d] = (this.tab[d] + 1) % DISPLAY_TABS[d].length;
      this.onTab(d);
    } else {
      this.disp = d;
      this.onTab(d);
    }
  }

  onTab(d) {
    if (d === 'list') this.lpClamp();
    // the tool offsets open on the tool in the spindle, the work offsets on the active work offset
    if (d === 'offset' && this.tab.offset === 0) {
      const i = this.toolRows().indexOf(this.c.tool);
      if (i >= 0) this.cursor('tool', { col: 1 }).row = i;
    }
    if (d === 'offset' && this.tab.offset === 1) {
      const w = this.c.modal.wcs >= 54 && this.c.modal.wcs <= 59 ? this.c.modal.wcs : 54;
      this.cursor('work', { row: 1, col: 1 }).row = w - 53;
    }
  }

  k_PROGRAM() {
    if (this.mode === 'EDIT') { this.disp = 'edit'; this.tab.edit = 0; return; }
    if (this.mode === 'LIST') { this.selectMode(CTRL_MODE_INV[this.c.mode] || 'MEM'); return; }
    this.disp = 'program';
  }
  k_POSITION() { this.showDisp('position'); }
  k_OFFSET() { this.showDisp('offset'); }
  k_CURRENT_COMMANDS() { this.showDisp('commands'); }
  k_ALARMS() { this.showDisp('alarms'); }
  k_DIAGNOSTIC() { this.showDisp('diag'); }
  k_SETTING() { this.showDisp('setting'); }
  k_HELP() { this.showDisp('help'); }

  // ------------------------------------------------------------------ cursor keys
  k_UP(o) { this.move(0, -1, o); }
  k_DOWN(o) { this.move(0, 1, o); }
  k_LEFT() { this.move(-1, 0); }
  k_RIGHT() { this.move(1, 0); }
  k_PAGE_UP() { this.move(0, -12); }
  k_PAGE_DOWN() { this.move(0, 12); }
  k_HOME() { this.move(0, -1e6, { home: true }); }
  k_END() { this.move(0, 1e6, { end: true }); }

  move(dx, dy, o = {}) {
    const d = this.disp;
    if (d === 'graphics') {
      if (o.home) this.graphics.zoom = 1;
      else if (dy === -12) this.graphics.zoom = Math.min(20, this.graphics.zoom * 1.4);
      else if (dy === 12) this.graphics.zoom = Math.max(0.3, this.graphics.zoom / 1.4);
      return;
    }
    if (d === 'edit' && this.tab.edit === 0) return this.moveText('edit', dx, dy);
    if (d === 'edit' && this.tab.edit === 1) return this.vpsMove(dx, dy);
    if (this.mode === 'MDI' && d === 'program') return this.moveText('mdi', dx, dy);
    if (d === 'program') {
      const n = this.ui.editor.lines.length;
      this.memPtr = clampI(this.memPtr + dy, 0, n - 1);
      return;
    }
    if (d === 'position') {
      if (dx) { this.tab.position = clampI(this.tab.position + dx, 0, 4); }
      return;
    }
    if (d === 'offset') {
      const key = this.tab.offset === 0 ? 'tool' : 'work';
      const cur = this.cursor(key, { col: 1, row: key === 'work' ? 1 : 0 });
      const rows = key === 'tool' ? this.toolRows().length : 7;
      const cols = key === 'tool' ? TOOL_COLS.length : 5;
      cur.row = clampI(cur.row + dy, 0, rows - 1);
      cur.col = clampI(cur.col + dx, 1, cols - 1);
      return;
    }
    if (d === 'list') {
      if (dx) return this.lpNav(dx);
      this.lp.row = clampI(this.lp.row + dy, 0, Math.max(0, this.lpFiles().length - 1));
      return;
    }
    if (d === 'setting') return this.settingMove(dx, dy);
    if (d === 'commands') {
      if (dx && this.tab.commands !== 1) { this.tab.commands = clampI(this.tab.commands + dx, 0, 4); return; }
      const cur = this.cursor('cmd' + this.tab.commands);
      const max = this.tab.commands === 2 ? MACRO_ROWS.length - 1 : this.tab.commands === 4 ? MACHINE.atcPockets - 1 : this.tab.commands === 1 ? 5 : 7;
      cur.row = clampI(cur.row + dy, 0, max);
      return;
    }
    if (d === 'alarms') {
      if (dx) { this.tab.alarms = clampI(this.tab.alarms + dx, 0, 4); return; }
      const cur = this.cursor('al' + this.tab.alarms);
      const max = this.tab.alarms === 1 ? Math.max(0, this.st.messages.length) : this.tab.alarms === 2 ? this.alarmHist.length - 1 : this.tab.alarms === 3 ? Object.keys(ALARM_TEXT).length - 1 : this.tab.alarms === 4 ? this.keyHist.length - 1 : this.alarms.length - 1;
      cur.row = clampI(cur.row + dy, 0, Math.max(0, max));
      return;
    }
    if (d === 'diag' || d === 'help') {
      if (dx) { this.tab[d] = clampI(this.tab[d] + dx, 0, DISPLAY_TABS[d].length - 1); return; }
      const cur = this.cursor(d + this.tab[d]);
      cur.row = clampI(cur.row + dy, 0, 40);
    }
  }

  moveText(key, dx, dy) {
    const lines = key === 'edit' ? this.ui.editor.lines : this.mdiLines();
    const cur = key === 'edit' ? this.editCur : this.mdiCur;
    if (key === 'edit' && this.sel?.open) this.sel.b = cur.line;
    if (dy) {
      cur.line = clampI(cur.line + dy, 0, Math.max(0, lines.length - 1));
      cur.word = Math.min(cur.word, Math.max(0, lineWords(lines[cur.line] || '').length - 1));
    } else if (dx) {
      const n = lineWords(lines[cur.line] || '').length;
      cur.word += dx;
      if (cur.word < 0) {
        if (cur.line > 0) { cur.line--; cur.word = Math.max(0, lineWords(lines[cur.line] || '').length - 1); } else cur.word = 0;
      } else if (cur.word >= n) {
        if (cur.line < lines.length - 1) { cur.line++; cur.word = 0; } else cur.word = Math.max(0, n - 1);
      }
    }
    if (key === 'edit' && this.sel?.open) this.sel.b = cur.line;
  }

  // ------------------------------------------------------------------ editing (EDIT and MDI)
  mdiLines() {
    return this.ui.mdaText.replace(/\n+$/, '').split('\n');
  }

  textCtx() {
    if (this.disp === 'edit' && this.tab.edit === 0) {
      return { key: 'edit', get: () => this.ui.editor.getValue(), set: (t, line) => this.ui.editor.applyText(t, line), cur: this.editCur, undo: this.undo };
    }
    if (this.mode === 'MDI' && (this.disp === 'program' || this.disp === 'position')) {
      return { key: 'mdi', get: () => this.ui.mdaText, set: (t) => this.ui.setMda(t), cur: this.mdiCur, undo: this.mdiUndo };
    }
    return null;
  }

  textEditable(ctx) {
    if (ctx.key === 'edit') {
      if (this.locked('programs')) return false;
      if (this.c.exec?.kind === 'program') { this.say('The active program is running: edit it after the cycle (or RESET)', 'warn'); return false; }
      if (!this.app.programName) { this.say('No program in the editor: LIST PROGRAM, then ALTER or INSERT', 'warn'); return false; }
    } else if (this.c.exec?.kind === 'mdi') { this.say('MDI is running', 'warn'); return false; }
    return true;
  }

  pushUndo(ctx) {
    ctx.undo.push({ text: ctx.get(), cur: { ...ctx.cur } });
    if (ctx.undo.length > 40) ctx.undo.shift();
  }

  editInsert(ctx) {
    if (!this.textEditable(ctx)) return;
    let inp = this.input.trim();
    if (!inp) {
      if (ctx.key === 'edit' && this.clip) inp = this.clip.replace(/\n$/, '') + ';';
      else return this.say('INSERT: type the code on the input line first (";" = end of block)', 'warn');
    }
    this.pushUndo(ctx);
    const lines = ctx.get().replace(/\n$/, '').split('\n');
    if (lines.length === 1 && lines[0] === '') lines.length = 0;
    const cur = ctx.cur;
    if (inp.includes(';') || !lines.length) {
      const blocks = inp.split(';').map((s) => s.trim()).filter((s, i, a) => s || i < a.length - 1);
      const add = blocks.length ? blocks : [inp];
      const at = lines.length ? cur.line + 1 : 0;
      lines.splice(at, 0, ...add);
      cur.line = at + add.length - 1;
      cur.word = 0;
    } else {
      const l = lines[cur.line] ?? '';
      const ws = lineWords(l);
      const w = ws[cur.word];
      const pos = w ? w.b : l.length;
      lines[cur.line] = (l.slice(0, pos) + (pos > 0 ? ' ' : '') + inp + ' ' + l.slice(pos).replace(/^\s+/, '')).replace(/\s+$/, '');
      cur.word = Math.min(lineWords(lines[cur.line]).length - 1, (w ? cur.word + 1 : 0) + lineWords(inp).length - 1);
    }
    ctx.set(lines.join('\n') + '\n', cur.line);
    this.input = '';
  }

  editAlter(ctx) {
    if (!this.textEditable(ctx)) return;
    const lines = ctx.get().replace(/\n$/, '').split('\n');
    const cur = ctx.cur;
    if (ctx.key === 'edit' && this.sel && !this.sel.open) {
      // move the selected blocks to after the cursor line
      this.pushUndo(ctx);
      const [a, b] = [Math.min(this.sel.a, this.sel.b), Math.max(this.sel.a, this.sel.b)];
      if (cur.line >= a && cur.line <= b) return this.say('Move the cursor outside the selection first', 'warn');
      const blk = lines.splice(a, b - a + 1);
      const at = cur.line > b ? cur.line - blk.length + 1 : cur.line + 1;
      lines.splice(at, 0, ...blk);
      this.sel = null;
      ctx.set(lines.join('\n') + '\n', at);
      cur.line = at;
      return;
    }
    const inp = this.input.replace(/;+\s*$/, '').trim();
    if (!inp) return this.say('ALTER: type the replacement on the input line', 'warn');
    const l = lines[cur.line] ?? '';
    const ws = lineWords(l);
    const w = ws[cur.word];
    if (!w) return this.say('ALTER: nothing highlighted', 'warn');
    if (ctx.key === 'edit' && cur.line === 0 && /^O\d/.test(w.s)) return this.say('GUARDED CODE: the program number cannot be altered here', 'warn');
    this.pushUndo(ctx);
    lines[cur.line] = l.slice(0, w.a) + inp + l.slice(w.b);
    ctx.set(lines.join('\n') + '\n', cur.line);
    this.input = '';
  }

  editDelete(ctx) {
    if (!this.textEditable(ctx)) return;
    const lines = ctx.get().replace(/\n$/, '').split('\n');
    const cur = ctx.cur;
    this.pushUndo(ctx);
    if (ctx.key === 'edit' && this.sel && !this.sel.open) {
      const [a, b] = [Math.min(this.sel.a, this.sel.b), Math.max(this.sel.a, this.sel.b)];
      lines.splice(a, b - a + 1);
      this.sel = null;
      cur.line = Math.min(a, Math.max(0, lines.length - 1));
      cur.word = 0;
      ctx.set(lines.join('\n') + '\n', cur.line);
      return;
    }
    const l = lines[cur.line] ?? '';
    const ws = lineWords(l);
    const w = ws[cur.word];
    if (ctx.key === 'edit' && w && cur.line <= 1 && /^O\d/.test(w.s)) { ctx.undo.pop(); return this.say('GUARDED CODE: the program number block cannot be deleted', 'warn'); }
    if (!w || ws.length <= 1) {
      lines.splice(cur.line, 1);
      cur.line = Math.min(cur.line, Math.max(0, lines.length - 1));
      cur.word = 0;
    } else {
      lines[cur.line] = (l.slice(0, w.a) + l.slice(w.b)).replace(/\s{2,}/g, ' ').trim();
      cur.word = Math.min(cur.word, lineWords(lines[cur.line]).length - 1);
    }
    ctx.set(lines.join('\n') + (lines.length ? '\n' : ''), cur.line);
  }

  editUndo(ctx) {
    const u = ctx.undo.pop();
    if (!u) return this.say('Nothing to undo', 'warn');
    if (ctx.key === 'edit' && this.c.exec?.kind === 'program') return this.say('The program is running', 'warn');
    ctx.set(u.text, u.cur.line);
    Object.assign(ctx.cur, u.cur);
    this.sel = null;
    this.say('UNDO');
  }

  k_INSERT() {
    const ctx = this.textCtx();
    if (ctx) return this.editInsert(ctx);
    if (this.disp === 'list') return this.lpNew();
    if (this.disp === 'alarms' && this.tab.alarms === 1) return this.msgInsert();
    if (this.disp === 'commands' && this.tab.commands === 4) return this.ui.addTool();
    this.say(this.mode === 'EDIT' ? 'INSERT works on the EDITOR tab' : 'INSERT: select EDIT or MDI to edit a program', 'warn');
  }

  k_ALTER() {
    const ctx = this.textCtx();
    if (ctx) return this.editAlter(ctx);
    if (this.disp === 'list') return this.lpEdit();
    if (this.disp === 'offset') return this.say('ALTER does not work for offsets: type a value and press F1 (set) or ENTER (add)', 'warn');
    if (this.disp === 'position') return this.say('Axis display selection: this machine shows X, Y and Z', 'info');
    this.say('ALTER: select EDIT or MDI to edit a program', 'warn');
  }

  k_DELETE() {
    const ctx = this.textCtx();
    if (ctx) return this.editDelete(ctx);
    if (this.disp === 'alarms' && this.tab.alarms === 1) {
      const cur = this.cursor('al1');
      this.st.messages.splice(cur.row, 1);
      this.save();
      return;
    }
    if (this.disp === 'list') return this.lpErase();
    if (this.disp === 'commands' && this.tab.commands === 4) {
      const n = this.cursor('cmd4').row + 1;
      return this.ui.deleteTool(n);
    }
    this.say('DELETE: select EDIT or MDI to edit a program', 'warn');
  }

  k_UNDO() {
    const ctx = this.textCtx();
    if (ctx) return this.editUndo(ctx);
    this.say('UNDO works in the editor and in MDI', 'warn');
  }

  // ------------------------------------------------------------------ MEMORY row
  k_SINGLE_BLOCK() {
    const c = this.c;
    c.singleBlock = !c.singleBlock;
    this.say(`Single block ${c.singleBlock ? 'on' : 'off'}`);
    this.ui.renderMCP?.();
  }

  k_GRAPHICS() {
    if (this.disp === 'graphics') { this.disp = 'program'; this.graphics.run = false; return; }
    if (this.mode !== 'MEM' && this.mode !== 'MDI') this.selectMode('MEM');
    if (this.mode !== 'MEM' && this.mode !== 'MDI') return;
    this.disp = 'graphics';
    this.graphics.run = false;
    this.graphics.t = 0;
    this.say('Graphics: CYCLE START runs the program as a simulation (no machine motion). F3/F4 slower/faster, PAGE UP/DOWN zoom');
  }

  k_OPTION_STOP() {
    if (this.set(17)) return this.say('Option stop is locked out (Setting 17)', 'warn');
    const c = this.c;
    c.optionalStop = !c.optionalStop;
    this.app.settings.optionalStop = c.optionalStop;
    this.app.save();
    this.say(`Option stop ${c.optionalStop ? 'on (M01 stops)' : 'off'}`);
  }

  k_BLOCK_DELETE() {
    if (this.set(18)) return this.say('Block delete is locked out (Setting 18)', 'warn');
    const s = this.app.settings;
    s.blockDelete = !s.blockDelete;
    this.app.compile();
    this.app.save();
    this.say(`Block delete ${s.blockDelete ? 'on: blocks starting with "/" are skipped' : 'off'}`);
  }

  // ------------------------------------------------------------------ MDI row
  k_COOLANT(o) {
    const c = this.c;
    if (this.shift || o.shift) { this.shift = false; return this.say('Auto air gun / MQL is an option that is not installed', 'warn'); }
    if (c.estop || !this.power) return;
    c.setCoolant(!c.coolant.flood, c.coolant.mist);
    this.say(`Coolant ${c.coolant.flood ? 'on' : 'off'}`);
  }

  k_HANDLE_SCROLL() { this.handleMode = this.handleMode === 'scroll' ? null : 'scroll'; }
  k_HANDLE_FEED() { this.handleMode = this.handleMode === 'feed' ? null : 'feed'; this.say(this.handleMode ? 'Jog handle controls the feed rate override (1 % per click)' : 'Jog handle: jogging'); }
  k_HANDLE_SPINDLE() { this.handleMode = this.handleMode === 'spindle' ? null : 'spindle'; this.say(this.handleMode ? 'Jog handle controls the spindle override (1 % per click)' : 'Jog handle: jogging'); }

  toolChangeOk() {
    const c = this.c;
    if (!['MDI', 'JOG', 'ZERO'].includes(this.mode)) { this.say('Tool changes from the keyboard work in MDI, HANDLE JOG or ZERO RETURN', 'warn'); return false; }
    if (c.exec) { this.say('The machine is busy', 'warn'); return false; }
    if (!this.motionOk('atc')) return false;
    if (!c.homed) { this.say('Zero return required before a tool change (POWER UP)', 'warn'); return false; }
    return true;
  }

  nextTool(dir) {
    const nums = this.app.tools.map((t) => t.number).sort((a, b) => a - b);
    if (!nums.length) return null;
    const cur = this.c.tool || this.c.carousel || 0;
    if (dir > 0) return nums.find((n) => n > cur) ?? nums[0];
    return [...nums].reverse().find((n) => n < cur) ?? nums[nums.length - 1];
  }

  k_ATC_FWD() {
    if (!this.toolChangeOk()) return;
    const n = this.nextTool(1);
    if (n == null) return this.say('No tools in the magazine', 'warn');
    this.runMDI(`T${n} M06`);
  }

  k_ATC_REV() {
    if (!this.toolChangeOk()) return;
    const n = this.nextTool(-1);
    if (n == null) return this.say('No tools in the magazine', 'warn');
    this.runMDI(`T${n} M06`);
  }

  runMDI(text) {
    this.ui.runMDI(text);
  }

  // ------------------------------------------------------------------ HANDLE JOG row and jog keys
  selectInc(i) {
    if (i === 3 && this.set(163)) return this.say('The .1 / 100. jog rate is disabled (Setting 163)', 'warn');
    this.incIdx = i;
    const v = this.inch ? INC_IN[i] : INC_MM[i];
    this.say(`Handle increment ${v} ${this.inch ? 'in' : 'mm'} per click, jog keys ${this.inch ? JOGF_IN[i] + ' in/min' : JOGF_MM[i] + ' mm/min'}`);
  }

  jogKey(k, o) {
    const c = this.c;
    if (k === '+A' || k === '-A') {
      if (this.shift || o.shift) { this.shift = false; return this.say('B axis: no rotary axis is installed on this machine', 'warn'); }
      return this.say('A/C axis: no rotary axis is installed on this machine', 'warn');
    }
    const axis = k[1].toLowerCase(), dir = k[0] === '+' ? 1 : -1;
    this.handleAxis = axis;
    if (this.mode !== 'JOG') return this.say(`${axis.toUpperCase()} selected. Jog keys work in HANDLE JOG mode`, 'warn');
    if (!this.motionOk('jog')) return;
    if (this.jogLock && c.exec?.kind === 'jog') { c.jogStop(); return; }
    if (c.exec) return this.say('The machine is busy', 'warn');
    const f = this.inch ? JOGF_IN[this.incIdx] * 25.4 : JOGF_MM[this.incIdx];
    c.jogStart(axis, dir, Math.min(f, MACHINE.rapidXY * this.rapidLimit() / 100));
    this.jogHeld = o.phys ? null : 'JOG_' + k;
    if (o.phys && !this.jogLock) setTimeout(() => this.c.jogStop(), 150);
  }

  k_JOG_LOCK() {
    this.jogLock = !this.jogLock;
    if (!this.jogLock) this.c.jogStop();
    this.say(this.jogLock ? 'Jog lock: press an axis key to jog continuously, JOG LOCK again to stop' : 'Jog lock off');
  }

  k_CHIP_FWD() { this.chip = 1; this.say('Chip auger forward'); }
  k_CHIP_STOP() { this.chip = 0; this.say('Chip auger stopped'); }
  k_CHIP_REV() { this.chip = -1; this.say('Chip auger reverse'); }
  k_CLNT_UP() { this.say('Programmable coolant (P-Cool) is an option that is not installed', 'warn'); }
  k_CLNT_DOWN() { this.say('Programmable coolant (P-Cool) is an option that is not installed', 'warn'); }
  k_AUX_CLNT(o) { this.say(this.shift || o.shift ? 'Tool air blast (TAB) is an option that is not installed' : 'Through-spindle coolant (TSC) is an option that is not installed', 'warn'); this.shift = false; }

  // ------------------------------------------------------------------ ZERO RETURN row
  k_ALL() {
    if (this.mode !== 'ZERO') return this.say('ALL: select ZERO RETURN mode first', 'warn');
    if (this.c.exec) return this.say('The machine is busy', 'warn');
    if (!this.motionOk('home')) return;
    if (this.doorOpen() && !this.st.setup) return;
    this.c.home();
  }

  k_ORIGIN() {
    const d = this.disp;
    if (d === 'position' || (this.mode === 'ZERO' && d !== 'commands' && d !== 'setting')) {
      const c = this.c;
      this.st.opOrigin = { x: c.pos.x, y: c.pos.y, z: c.pos.z };
      this.save();
      return this.say('Operator position zeroed');
    }
    if (d === 'commands' && this.tab.commands === 1) {
      const r = this.cursor('cmd1').row;
      if (r === 3) this.st.m30[0] = 0;
      else if (r === 4) this.st.m30[1] = 0;
      else if (r === 1) this.st.cycleTotal = 0;
      else if (r === 2) this.st.feedTotal = 0;
      else if (r === 5) this.timers.thisCycle = 0;
      this.save();
      return this.say('Timer / counter reset');
    }
    if (d === 'edit' && this.tab.edit === 1 && this.vps.tpl) {
      const tpl = VPS_TEMPLATES.find((t) => t.id === this.vps.tpl);
      const v = tpl.vars[this.vps.row];
      this.vps.vals[v.k] = v.def[this.inch ? 1 : 0];
      this.vps.changed.delete(v.k);
      return this.say(`${v.k} reset to its default`);
    }
    if (d === 'setting') return this.settingOrigin();
    this.say('ORIGIN: nothing to reset on this screen', 'warn');
  }

  k_SINGLE() {
    if (this.mode !== 'ZERO') return this.say('SINGLE: select ZERO RETURN mode, type the axis letter (X, Y or Z), then SINGLE', 'warn');
    const m = /^([XYZ])$/.exec(this.input.trim());
    if (!m) return this.say('SINGLE: type the axis letter (X, Y or Z) on the input line first', 'warn');
    if (this.c.exec) return this.say('The machine is busy', 'warn');
    if (!this.motionOk('home')) return;
    this.input = '';
    this.c.refAxis(m[1].toLowerCase());
  }

  k_HOME_G28() {
    const c = this.c;
    if (this.mode !== 'ZERO' && this.mode !== 'MDI') return this.say('HOME G28: select ZERO RETURN mode', 'warn');
    if (c.exec) return this.say('The machine is busy', 'warn');
    if (!this.motionOk('home')) return;
    if (!c.homed) return c.home();
    const p = { ...c.pos };
    const ops = [];
    const r = this.rapidLimit() / 100;
    const a = c.manualMove(p, { ...p, z: 0 }, MACHINE.rapidZ * r, true);
    if (a) ops.push(a);
    const b = c.manualMove({ ...p, z: 0 }, { x: 0, y: 0, z: 0 }, MACHINE.rapidXY * r, true);
    if (b) ops.push(b);
    if (ops.length) c.runOps(ops, 'homing');
    this.say('HOME G28: rapid to machine zero, Z first');
  }

  // ------------------------------------------------------------------ LIST PROGRAM row and device manager
  lpFiles() {
    const app = this.app;
    if (this.tab.list === 1) {
      return [...EXAMPLES_HAAS.map((e) => ({ name: e.file.replace(/\.NC$/i, '.MPF'), onum: progHead(e.code).onum, comment: progHead(e.code).comment || e.name, size: e.code.length, usb: 'haas', id: e.id })),
        ...VPS_SAMPLES().map((s) => ({ name: s.file, onum: s.onum, comment: s.comment, size: s.code().length, usb: 'vps', id: s.id })),
        ...EXAMPLES_808.map((e) => ({ name: e.file, onum: '', comment: e.name, size: (e.code || '').length, usb: 'ex', id: e.id }))]
        .filter((f) => !this.lp.search || (f.name + ' ' + f.comment).toUpperCase().includes(this.lp.search));
    }
    return app.programs.names().map((n) => {
      const inf = app.programs.info(n);
      const head = progHead(inf.text);
      return { name: n, onum: head.onum, comment: head.comment, size: inf.text.length, modified: inf.modified };
    }).filter((f) => !this.lp.search || (f.name + ' ' + f.comment + ' ' + f.onum).toUpperCase().includes(this.lp.search));
  }

  lpClamp() {
    this.lp.row = clampI(this.lp.row, 0, Math.max(0, this.lpFiles().length - 1));
  }

  lpSel() {
    return this.lpFiles()[this.lp.row];
  }

  lpNav(dir) {
    // back / forward like a browser, between the device tabs
    const lp = this.lp;
    if (dir < 0 && lp.hpos > 0) lp.hpos--;
    else if (dir > 0 && lp.hpos < lp.hist.length - 1) lp.hpos++;
    else {
      const t = clampI(this.tab.list + dir, 0, 1);
      if (t === this.tab.list) return;
      lp.hist = lp.hist.slice(0, lp.hpos + 1);
      lp.hist.push(t);
      lp.hpos = lp.hist.length - 1;
    }
    this.tab.list = lp.hist[lp.hpos];
    this.lp.row = 0;
  }

  k_BACK() { if (this.disp === 'list') this.lpNav(-1); else this.say('Back: used in LIST PROGRAM', 'warn'); }
  k_FORWARD() { if (this.disp === 'list') this.lpNav(1); else this.say('Forward: used in LIST PROGRAM', 'warn'); }

  k_SELECT_PROGRAM() {
    if (this.disp !== 'list') return this.say('SELECT PROGRAM: highlight a program in LIST PROGRAM first', 'warn');
    const f = this.lpSel();
    if (!f) return;
    this.selectFile(f);
  }

  selectFile(f) {
    const app = this.app;
    if (this.c.exec?.kind === 'program') return this.say('The active program is running', 'warn');
    if (f.usb === 'ex') {
      app.loadExample808(f.id);
    } else if (f.usb === 'haas') {
      app.loadExampleHaas(f.id);
    } else if (f.usb === 'vps') {
      const s = VPS_SAMPLES().find((x) => x.id === f.id);
      const name = app.programs.has(s.file) ? s.file : s.file;
      app.programs.put(name, s.code());
      app.openProgram(name);
    } else app.openProgram(f.name);
    this.memPtr = 0;
    this.editCur = { line: 0, word: 0 };
    this.undo = [];
    this.say(`${app.programName} is the active program (*). Select MEMORY and press CYCLE START`);
  }

  lpNew() {
    if (this.tab.list !== 0) return this.say('New programs are created in Memory', 'warn');
    if (this.locked('programs')) return;
    const store = this.app.programs;
    let n = 1;
    const used = new Set(this.lpFiles().map((f) => +f.onum).filter(Boolean));
    while (used.has(n) || store.has(`O${String(n).padStart(5, '0')}.MPF`)) n++;
    this.popup = {
      kind: 'form', title: 'New Program', row: 0,
      fields: [{ k: 'onum', label: 'O Number', v: String(n).padStart(5, '0') }, { k: 'file', label: 'File Name (optional)', v: '' }, { k: 'comment', label: 'File Comment', v: '' }],
      hint: 'Type a value and press ENTER for each field. ENTER on the last field creates the program. CANCEL closes.',
      done: (vals) => this.createProgram(vals),
    };
  }

  createProgram(vals) {
    const store = this.app.programs;
    const on = String(vals.onum).replace(/^O/i, '');
    if (!/^\d{1,5}$/.test(on)) return this.say('O number must be 1 to 5 digits', 'error');
    const onum = 'O' + on.padStart(5, '0');
    const name = vals.file ? normName(vals.file) : `${onum}.MPF`;
    if (!validName(name)) return this.say(`"${name}" is not a valid file name`, 'error');
    if (store.has(name)) return this.say(`File with O Number ${onum} already exists`, 'error');
    const comment = (vals.comment || '').toUpperCase().replace(/[()]/g, '');
    const unit = this.inch ? 'G20' : 'G21';
    store.put(name, `%\n${onum}${comment ? ` (${comment})` : ''}\nG00 G17 G40 G49 G80 G90 ${unit}\n\nM30\n%\n`);
    this.app.openProgram(name);
    this.lp.row = Math.max(0, this.lpFiles().findIndex((f) => f.name === name));
    this.editCur = { line: 2, word: 0 };
    this.undo = [];
    this.say(`${onum} created and selected. ALTER (or EDIT) to write it`);
  }

  lpEdit() {
    const f = this.lpSel();
    if (!f) return;
    if (f.usb) this.selectFile(f);
    else if (f.name !== this.app.programName) this.selectFile(f);
    this.selectMode('EDIT');
    this.tab.edit = 0;
  }

  lpErase() {
    if (this.tab.list !== 0) return this.say('The USB stick is read-only here', 'warn');
    if (this.locked('programs')) return;
    const marked = [...this.lp.marked].filter((n) => this.app.programs.has(n));
    const f = this.lpSel();
    const names = marked.length ? marked : f ? [f.name] : [];
    if (!names.length) return;
    if (names.includes(this.app.programName) && this.c.exec) return this.say('The active program is running', 'warn');
    this.popup = {
      kind: 'yn', title: 'Erase Program', text: `Delete ${names.length > 1 ? names.length + ' programs' : names[0]}? (Y/N)`,
      yes: () => {
        for (const n of names) this.app.programs.remove(n);
        this.lp.marked.clear();
        this.lpClamp();
        this.say(`${names.join(', ')} deleted`);
      },
    };
  }

  k_ERASE_PROGRAM() {
    if (this.mode === 'MDI' && this.disp !== 'list') {
      if (this.c.exec?.kind === 'mdi') return this.say('MDI is running', 'warn');
      this.mdiUndo.push({ text: this.ui.mdaText, cur: { ...this.mdiCur } });
      this.ui.setMda('');
      this.mdiCur = { line: 0, word: 0 };
      return this.say('MDI program erased');
    }
    if (this.disp === 'alarms' && this.tab.alarms === 1) { this.st.messages = []; this.save(); return; }
    if (this.disp !== 'list') return this.say('ERASE PROGRAM: highlight a program in LIST PROGRAM (in MDI it erases the MDI program)', 'warn');
    this.lpErase();
  }

  lpRename() {
    const f = this.lpSel();
    if (!f || f.usb) return this.say('Highlight a program in Memory', 'warn');
    if (this.locked('programs')) return;
    this.popup = {
      kind: 'form', title: 'Rename', row: 0, fields: [{ k: 'file', label: 'New File Name', v: f.name.replace(/\.MPF$/, '') }], hint: 'Type the new name and press ENTER',
      done: (v) => {
        const name = normName(v.file);
        if (!validName(name)) return this.say(`"${name}" is not a valid file name`, 'error');
        if (!this.app.programs.rename(f.name, name)) return this.say(`${name} already exists`, 'error');
        if (this.app.programName === f.name) { this.app.programName = name; this.ui.setProgramName(name); }
        this.say(`${f.name} renamed to ${name}`);
      },
    };
  }

  lpCopy() {
    const f = this.lpSel();
    if (!f) return;
    if (this.locked('programs')) return;
    const store = this.app.programs;
    if (f.usb) {
      const text = f.usb === 'haas' ? EXAMPLES_HAAS.find((x) => x.id === f.id).code : f.usb === 'vps' ? VPS_SAMPLES().find((x) => x.id === f.id).code() : (() => { const e = EXAMPLES_808.find((x) => x.id === f.id); return this.app.programs.get(f.name) ?? (e.lazy && !e.code ? (Object.assign(e, e.lazy()), e.code) : e.code); })();
      const name = store.has(f.name) ? store.uniqueName(f.name) : f.name;
      store.put(name, text);
      return this.say(`${f.name} copied to Memory as ${name}`);
    }
    const name = store.uniqueName(f.name.replace(/\.(MPF|SPF)$/, '') + '_COPY');
    store.put(name, store.get(f.name));
    this.say(`${f.name} copied to ${name}`);
  }

  // ------------------------------------------------------------------ overrides
  setFeedOv(v, quiet) {
    if (this.set(19)) return this.say('Feed rate override is locked (Setting 19)', 'warn');
    this.c.overrides.feed = clampI(Math.round(v), 10, 200);
    if (!quiet) this.say(`Feed rate override ${this.c.overrides.feed}%`);
    this.ui.renderMCP?.();
  }

  setSpinOv(v, quiet) {
    if (this.set(20)) return this.say('Spindle override is locked (Setting 20)', 'warn');
    this.c.overrides.spindle = clampI(Math.round(v), 10, 200);
    if (!quiet) this.say(`Spindle override ${this.c.overrides.spindle}%`);
    this.ui.renderMCP?.();
  }

  setRapid(v) {
    if (this.set(21)) return this.say('Rapid override is locked (Setting 21)', 'warn');
    this.rapidSel = v;
    this.c.overrides.rapid = Math.min(v, this.rapidLimit());
    this.say(`Rapid ${v}%${this.rapidLimit() < v ? ' (limited to 25% with the door open)' : ''}`);
  }

  k_FEED_M10() { this.setFeedOv(this.c.overrides.feed - 10); }
  k_FEED_100() { this.setFeedOv(100); }
  k_FEED_P10() { this.setFeedOv(this.c.overrides.feed + 10); }
  k_SPIN_M10() { this.setSpinOv(this.c.overrides.spindle - 10); }
  k_SPIN_100() { this.setSpinOv(100); }
  k_SPIN_P10() { this.setSpinOv(this.c.overrides.spindle + 10); }
  k_RAPID_5() { this.setRapid(5); }
  k_RAPID_25() { this.setRapid(25); }
  k_RAPID_50() { this.setRapid(50); }
  k_RAPID_100() { this.setRapid(100); }

  manualSpindle(dir) {
    const c = this.c;
    if (dir && !['JOG', 'MDI', 'ZERO'].includes(this.mode)) return this.say('Spindle FWD / REV work in HANDLE JOG (or MDI)', 'warn');
    if (!dir) {
      if (c.exec?.kind === 'program' || c.exec?.kind === 'mdi') return this.say('Spindle STOP: FEED HOLD or RESET the program first', 'warn');
      c.setSpindle(c.spindle.cmd, 0);
      return this.say('Spindle stop');
    }
    if (c.exec) return this.say('The machine is busy', 'warn');
    if (!this.motionOk('spindle')) return;
    const rpm = c.spindle.cmd || c.modal.rpm || this.app.settings.jogRpm || 1000;
    c.setSpindle(rpm, dir);
    this.say(`Spindle ${dir > 0 ? 'forward (CW)' : 'reverse (CCW)'} at ${Math.round(rpm)} RPM`);
  }

  k_SP_FWD() { this.manualSpindle(1); }
  k_SP_STOP() { this.manualSpindle(0); }
  k_SP_REV() { this.manualSpindle(-1); }

  // ------------------------------------------------------------------ alpha / numeric special keys
  k_SHIFT() { this.shift = !this.shift; }
  k_CANCEL() {
    if (this.input) this.input = this.input.slice(0, -1);
    else if (this.disp === 'edit' && this.tab.edit === 1 && this.vps.tpl) { this.vps.tpl = null; }
    else if (this.sel) { this.sel = null; this.say('Selection cancelled'); }
  }
  k_SPACE() { this.typeChar(' '); }
  k_ENTER() { this.enter(); }

  // ------------------------------------------------------------------ pendant controls
  k_CYCLE_START() { this.cycleStart(true); }
  k_FEED_HOLD() { this.feedHold(); }
  k_ESTOP() { this.estop(); }

  estop() {
    const c = this.c;
    if (this.estopLatched) {
      this.estopLatched = false;
      this.say('E-STOP released. Press RESET to clear the alarm');
      this.app.sound.click?.();
      this.paint();
      return;
    }
    this.estopLatched = true;
    c.emergencyStop();
    this.graphics.run = false;
    this.jogLock = false;
    this.addAlarm({ num: 107, text: ALARM_TEXT[107] });
    this.say('EMERGENCY STOP: motion, spindle, tool changer and coolant stopped', 'error');
    this.paint();
  }

  k_POWER_OFF() {
    if (!this.power) return;
    const c = this.c;
    c.stop('Power off');
    c.setSpindle(0, 0);
    c.setCoolant(false, false);
    c.homed = false;
    c.ref = { x: false, y: false, z: false };
    this.power = false;
    this.alarms = [];
    this.input = '';
    this.popup = null;
    this.graphics.run = false;
    this.paint(true);
  }

  k_POWER_ON() {
    if (this.power) return this.say('The control is already on');
    this.power = true;
    this.boot = 2.2;
    this.estopLatched = false;
    if (this.c.estop || this.c.state === 'alarm') this.c.reset();
    this.mode = 'JOG';
    this.c.setMode('JOG');
    this.disp = 'position';
    this.paint(true);
  }

  k_MEMORY_LOCK() {
    this.st.memLock = !this.st.memLock;
    this.save();
    this.say(this.st.memLock ? 'Memory lock: programs, settings and offsets are locked' : 'Memory lock off');
  }

  k_SETUP_MODE() {
    this.st.setup = !this.st.setup;
    this.save();
    this.say(this.st.setup ? 'SETUP mode: jogging with the door open, rapids 25 %, spindle limited (Setting 292), hold CYCLE START to run with the door open' : 'RUN mode: all safety features on; the door must be closed to run');
  }

  k_SECOND_HOME() {
    const c = this.c;
    if (!c.homed) return this.say('Zero return required before SECOND HOME', 'warn');
    if (c.exec) return this.say('The machine is busy', 'warn');
    if (!this.motionOk('home')) return;
    const tgt = c.clampTravel({ x: this.set(268), y: this.set(269), z: this.set(270) });
    const p = { ...c.pos };
    const r = this.rapidLimit() / 100;
    const ops = [];
    const up = Math.max(p.z, tgt.z);
    const a = c.manualMove(p, { ...p, z: up }, MACHINE.rapidZ * r, true);
    if (a) ops.push(a);
    const b = c.manualMove({ ...p, z: up }, { ...tgt, z: up }, MACHINE.rapidXY * r, true);
    if (b) ops.push(b);
    const d = c.manualMove({ ...tgt, z: up }, tgt, MACHINE.rapidZ * r, true);
    if (d) ops.push(d);
    if (ops.length) c.runOps(ops, 'jog');
    this.say('SECOND HOME: rapid to the position in Settings 268-270');
  }

  k_WORK_LIGHT() {
    const b = document.querySelector('[data-toggle="lights"]');
    this.ui.toggle('lights', b);
  }

  k_AUTO_DOOR() { this.say('Auto door is an option that is not installed: open the door by hand', 'warn'); }
  k_USB() { this.say('USB: the example programs are on the USB tab of LIST PROGRAM', 'info'); this.selectMode('LIST'); this.tab.list = 1; this.lpClamp(); }

  // ------------------------------------------------------------------ cycle start / feed hold / door
  cycleStart(fromKey = false) {
    const app = this.app, c = this.c;
    if (!this.power) return;
    if (this.set(103) && c.state === 'running') return this.feedHold();
    if (c.state === 'hold') {
      if (!this.motionOk('cycle')) return;
      if (this.doorOpen() && !this.st.setup) return this.say('Door open: close the door and press CYCLE START to continue', 'warn');
      if (this.doorOpen() && this.st.setup) this._holdToRun = !!fromKey;
      c.cycleStart();
      return;
    }
    if (this.disp === 'graphics') return this.graphicsStart();
    if (this.disp === 'edit' && this.tab.edit === 1 && this.vps.tpl) return this.vpsRun();
    if (c.exec) return;
    if (this.mode !== 'MEM' && this.mode !== 'MDI') return this.say('CYCLE START: select MEMORY (or MDI) mode', 'warn');
    if (!this.motionOk('cycle')) return;
    if (!c.homed) return this.say('Zero return required: press POWER UP (or ZERO RETURN, ALL) before CYCLE START', 'warn');
    if (this.doorOpen()) {
      if (!this.st.setup) return this.say('Door open: close the door to run (RUN mode)', 'warn');
      if (!fromKey) return this.say('SETUP mode, door open: hold the CYCLE START button on the pendant to run', 'warn');
      this._holdToRun = true;
    }
    if (this.mode === 'MEM') {
      if (!app.programName) return this.say('No active program: LIST PROGRAM, SELECT PROGRAM', 'warn');
      app.cycleStart();
      if (app.compiled?.errors.length) {
        const e = app.compiled.errors[0];
        this.addAlarm(alarmFromMessage(`Line ${e.line + 1}: ${e.msg}`, true));
      }
    } else {
      if (!this.ui.mdaText.trim()) return this.say('The MDI program is empty: type a block (e.g. G00 G90 G54 X0. Y0. ;) and press INSERT', 'warn');
      app.cycleStart();
    }
  }

  feedHold() {
    const c = this.c;
    if (this.graphics.run) { this.graphics.run = false; return; }
    if (c.state === 'running') c.feedHold('Feed hold');
  }

  // door handle / door button: RUN mode locks the door while the machine moves or the spindle turns
  door(orig) {
    const c = this.c;
    const opening = c.door.target < 0.5;
    if (opening && !this.st.setup && (c.state === 'running' || Math.abs(c.spindle.rpm) > 1)) {
      this.say('Door locked (RUN mode): the machine is running. FEED HOLD and stop the spindle, or use SETUP mode', 'warn');
      this.app.game?.ui?.toast?.('Door locked: the machine is running (RUN mode).', 'warn');
      return;
    }
    orig();
    if (opening && this.st.setup && c.state === 'running' && c.exec && c.exec.kind !== 'jog' && !this._holdToRun) {
      c.feedHold('Door Hold');
      this.say('Door Hold: close the door and press CYCLE START to continue', 'warn');
    }
  }

  // ------------------------------------------------------------------ ENTER and F-keys by context
  enter() {
    const d = this.disp, inp = this.input.trim();
    const ctx = this.textCtx();
    if (ctx && ctx.key === 'edit' && this.sel && !this.sel.open) {
      const lines = this.ui.editor.lines;
      const [a, b] = [Math.min(this.sel.a, this.sel.b), Math.max(this.sel.a, this.sel.b)];
      this.clip = lines.slice(a, b + 1).join('\n') + '\n';
      this.sel = null;
      return this.say(`${b - a + 1} block(s) copied to the clipboard. INSERT with an empty input line pastes them`);
    }
    if (ctx) {
      if (inp) return ctx.key === 'edit' || ctx.key === 'mdi' ? this.editInsert(ctx) : null;
      return;
    }
    if (d === 'offset') return this.offsetEntry(false);
    if (d === 'list') {
      const f = this.lpSel();
      if (!f) return;
      if (this.lp.marked.has(f.name)) this.lp.marked.delete(f.name); else this.lp.marked.add(f.name);
      return;
    }
    if (d === 'setting') return this.settingEnter();
    if (d === 'edit' && this.tab.edit === 1) return this.vpsEnter();
    if (d === 'commands' && this.tab.commands === 2) {
      const r = MACRO_ROWS[this.cursor('cmd2').row];
      const v = parseFloat(inp);
      if (!isFinite(v)) return this.say('Type a value, then ENTER', 'warn');
      if (this.set(120)) return this.say('Macro variables are locked (Setting 120)', 'warn');
      this.app.macroVars[r] = v;
      this.app.saveVars();
      this.app.scheduleCompile();
      this.input = '';
      return this.say(`#${r} = ${v}`);
    }
    if (d === 'commands' && this.tab.commands === 4) return this.say('Pocket assignment is fixed in this machine: tool n sits in pocket n. INSERT adds a tool, DELETE removes one', 'warn');
    if (d === 'alarms' && this.tab.alarms === 1) return this.msgInsert();
    if (d === 'help' && this.tab.help === 1) return this.calcEnter();
    if (d === 'help' && this.tab.help === 0) return;
    if (inp) this.say('ENTER: nothing to write on this screen', 'warn');
  }

  fkey(n) {
    const d = this.disp;
    if (d === 'offset') {
      if (this.tab.offset === 0) {
        if (n === 1) {
          const cur = this.cursor('tool', { col: 1 });
          if (cur.col === 7) return this.toolTypePopup();
          return this.offsetEntry(true);
        }
        if (n === 4) { this.tab.offset = 1; this.onTab('offset'); return; }
        return this.say(`F${n}: no function on the Tool tab`, 'warn');
      }
      if (n === 1) {
        if (this.input.trim()) return this.offsetEntry(true);
        return this.workOptions();
      }
      if (n === 3) return this.probingActions();
      if (n === 4) { this.tab.offset = 0; this.onTab('offset'); return; }
      return this.say(`F${n}: no function on the Work tab`, 'warn');
    }
    if (d === 'list') {
      if (n === 1) {
        this.lp.search = this.input.trim().toUpperCase();
        this.input = '';
        this.lp.row = 0;
        return this.say(this.lp.search ? `Search: ${this.lp.search}` : 'Search cleared');
      }
      if (n === 2) return this.lpCopy();
      if (n === 3) return this.fileMenu();
      if (n === 4) return this.say('System files are not available in this simulator', 'warn');
    }
    if (d === 'edit' && this.tab.edit === 0) {
      if (n === 1) return this.editorMenu();
      if (n === 2) {
        if (!this.sel || !this.sel.open) { this.sel = { a: this.editCur.line, b: this.editCur.line, open: true }; return this.say('Block select: move the cursor, F2 again to end the selection'); }
        this.sel.open = false;
        return this.say('Selection made: ENTER copies, ALTER moves it to the cursor, DELETE deletes');
      }
      if (n === 4) { this.tab.edit = 1; return; }
      return this.say(`F${n}: no function in the editor`, 'warn');
    }
    if (d === 'edit' && this.tab.edit === 1) {
      if (n === 4) return this.vps.tpl ? this.vpsGenerate() : this.say('Select a template first (cursor, then ENTER)', 'warn');
      if (n === 1 && !this.vps.tpl) return this.vpsOpen();
      return this.say(`F${n}: no function here`, 'warn');
    }
    if (d === 'setting' && n === 1) return this.settingJump();
    if (d === 'alarms' && (this.tab.alarms === 2 || this.tab.alarms === 3) && n === 1) {
      const q = this.input.trim().toUpperCase();
      this.input = '';
      const key = 'al' + this.tab.alarms;
      const list = this.tab.alarms === 2 ? this.alarmHist.map((a) => `${a.num} ${a.text}`) : Object.entries(ALARM_TEXT).map(([k, v]) => `${k} ${v}`);
      const i = list.findIndex((s) => s.toUpperCase().includes(q));
      if (i < 0) return this.say(`"${q}" not found`, 'warn');
      this.cursor(key).row = i;
      return;
    }
    if (d === 'commands' && this.tab.commands === 0) {
      if (n === 2) {
        const v = parseFloat(this.input);
        if (!(v >= 0)) return this.say('Type the spindle speed (RPM), then F2', 'warn');
        this.app.settings.jogRpm = Math.min(MACHINE.maxRpm, Math.round(v));
        this.c.setSpindle(this.app.settings.jogRpm, this.c.spindle.dir);
        this.input = '';
        this.app.save();
        return this.say(`Main spindle speed set to ${this.app.settings.jogRpm} RPM`);
      }
      if (n === 3 || n === 4) {
        if (this.c.exec) return this.say('The machine is busy', 'warn');
        if (!this.motionOk('spindle')) return;
        this.c.setSpindle(this.app.settings.jogRpm || 1000, n === 3 ? 1 : -1);
        this._devSpin = true;
        return this.say(`Main spindle ${n === 3 ? 'CW' : 'CCW'} while F${n} is held`);
      }
    }
    if (d === 'graphics') {
      if (n === 3) { this.graphics.speed = Math.max(0.25, this.graphics.speed / 2); return this.say(`Graphics run speed ${this.graphics.speed}×`); }
      if (n === 4) { this.graphics.speed = Math.min(64, this.graphics.speed * 2); return this.say(`Graphics run speed ${this.graphics.speed}×`); }
      if (n === 2) { this.graphics.zoom = this.graphics.zoom > 1 ? 1 : 2; return; }
    }
    if (d === 'help' && this.tab.help === 1 && n === 1) { this.calc = { lines: [], res: null }; return; }
    this.say(`F${n}: no function on this screen`, 'warn');
  }

  // ------------------------------------------------------------------ offsets
  locked(what) {
    if (this.st.memLock) { this.say(`MEMORY LOCK is on: ${what} cannot be changed (side panel key switch)`, 'warn'); return true; }
    if (what === 'offsets' && this.set(119)) { this.say('Offsets are locked (Setting 119)', 'warn'); return true; }
    return false;
  }

  toolRows() {
    const n = MACHINE.atcPockets;
    return Array.from({ length: n }, (_, i) => i + 1);
  }

  toolGeom(t) {
    const hW = t.hWear || 0, dW = t.hDWear || 0;
    const h = t.length + (t.dLength || 0) - hW;
    const dg = t.diameter + 2 * (t.dRadius || 0) - dW;
    return { h, hW, dg, dW };
  }

  setToolOffset(t, col, v) {
    const g = this.toolGeom(t);
    if (col === 1) t.dLength = v + g.hW - t.length;
    else if (col === 2) { t.hWear = v; t.dLength = g.h + v - t.length; }
    else if (col === 3) t.dRadius = (v + g.dW - t.diameter) / 2;
    else if (col === 4) { t.hDWear = v; t.dRadius = (g.dg + v - t.diameter) / 2; }
    t.dLength = Math.round(t.dLength * 1e4) / 1e4;
    t.dRadius = Math.round(t.dRadius * 1e4) / 1e4;
    this.app.toolsChanged(false);
  }

  // display units <-> mm
  fromD(v) { return this.inch ? v * 25.4 : v; }
  toD(v) { return this.inch ? v / 25.4 : v; }
  fmtNum(mm) {
    const v = this.toD(mm);
    if (Math.abs(v) < 1e-9) return '0.';
    return v.toFixed(this.inch ? 4 : 3);
  }

  guardChange(oldV, newV, apply) {
    const tol = this.set(142);
    if (Math.abs(newV - oldV) > tol + 1e-9) {
      this.popup = { kind: 'yn', title: 'Offset Change', text: `Greater Than Setting 142! Accept (Y/N)`, yes: apply };
      return;
    }
    apply();
  }

  offsetEntry(setMode) {
    const app = this.app;
    const inp = this.input.trim();
    const v = parseFloat(inp);
    if (this.locked('offsets')) return;
    if (this.c.exec?.kind === 'program') return this.say('Offsets cannot be changed while the program runs', 'warn');
    if (this.tab.offset === 0) {
      const cur = this.cursor('tool', { col: 1 });
      const n = this.toolRows()[cur.row];
      const t = app.tools.find((x) => x.number === n);
      if (!t) return this.say(`Pocket ${n} is empty: add a tool under CURRENT COMMANDS > Tool Table (INSERT)`, 'warn');
      if (cur.col === 7) return this.toolTypePopup();
      if (!inp || !isFinite(v)) return this.say('Enter A Value', 'warn');
      const g = this.toolGeom(t);
      const col = cur.col;
      if (col >= 1 && col <= 4) {
        const old = [0, g.h, g.hW, g.dg, g.dW][col];
        const nv = setMode ? this.fromD(v) : old + this.fromD(v);
        if ((col === 3 || col === 4) && g.dg + (col === 4 ? nv : g.dW) - (col === 3 ? g.dW : 0) < 0 && col === 3 && nv < 0) return this.say('Diameter must not be negative', 'error');
        this.input = '';
        this.guardChange(old, nv, () => {
          this.setToolOffset(t, col, nv);
          this.say(`T${n} ${TOOL_COLS[col]} = ${this.fmtNum(nv)}`);
        });
        return;
      }
      const dummy = {};
      if (col === 5) app.ui.editTool(t, 'flutes', setMode ? v : t.flutes + v, dummy);
      else if (col === 6) app.ui.editTool(t, 'radius', (setMode ? this.fromD(v) : t.diameter + this.fromD(v)) / 2, dummy);
      else if (col === 8) app.ui.editTool(t, 'length', setMode ? this.fromD(v) : t.length + this.fromD(v), dummy);
      this.input = '';
      return;
    }
    const cur = this.cursor('work', { row: 1, col: 1 });
    if (cur.row === 0) return this.say('G52 is set by the program (G52 X_ Y_ Z_)', 'warn');
    if (cur.col === 4) return this.say('Work material: set by the blank in the vise', 'info');
    if (!inp || !isFinite(v)) return this.say('Enter A Value', 'warn');
    const i = cur.row - 1, axis = 'xyz'[cur.col - 1];
    const o = app.offsets[i];
    const nv = setMode ? this.fromD(v) : o[axis] + this.fromD(v);
    this.input = '';
    this.guardChange(o[axis], nv, () => {
      o[axis] = Math.round(nv * 10000) / 10000;
      app.offsetsChanged();
      this.say(`G${54 + i} ${axis.toUpperCase()} = ${this.fmtNum(o[axis])}`);
    });
  }

  toolTypePopup() {
    const cur = this.cursor('tool', { col: 1 });
    const n = this.toolRows()[cur.row];
    const t = this.app.tools.find((x) => x.number === n);
    if (!t) return this.say(`Pocket ${n} is empty`, 'warn');
    this.popup = {
      kind: 'list', title: `Tool Type T${n}`, items: HAAS_TYPES.map((x) => x[1]), row: Math.max(0, HAAS_TYPES.findIndex((x) => x[0] === t.type)),
      pick: (i) => { this.app.ui.editTool(t, 'type', HAAS_TYPES[i][0], {}); this.say(`T${n} tool type: ${HAAS_TYPES[i][1]}`); },
    };
  }

  workOptions() {
    this.popup = {
      kind: 'list', title: 'Work Offset Options', items: ['Clear the highlighted offset', 'Clear all work offsets G54-G59', 'Set to the blank: top centre (simulator)'], row: 0,
      pick: (i) => {
        const app = this.app;
        if (this.locked('offsets')) return;
        const cur = this.cursor('work', { row: 1, col: 1 });
        if (i === 0) { if (cur.row > 0) { Object.assign(app.offsets[cur.row - 1], { x: 0, y: 0, z: 0 }); app.offsetsChanged(); } }
        else if (i === 1) { for (const o of app.offsets) Object.assign(o, { x: 0, y: 0, z: 0 }); app.offsetsChanged(); }
        else app.setZeroFromStock('top-center', Math.max(0, cur.row - 1));
        this.say('Work offsets updated');
      },
    };
  }

  probingActions() {
    const items = [['top-front-left', 'Probe corner: top front-left of the part'], ['top-center', 'Probe: top centre of the part (X, Y centre + Z top)'], ['top-back-left', 'Probe corner: top back-left'], ['top-front-right', 'Probe corner: top front-right'], ['top-back-right', 'Probe corner: top back-right']];
    this.popup = {
      kind: 'list', title: 'Probing Actions (simulated WIPS)', items: items.map((x) => x[1]), row: 0,
      pick: (i) => {
        if (this.locked('offsets')) return;
        if (this.app.stockEmpty) return this.say('Probing: there is no part in the vise', 'warn');
        const cur = this.cursor('work', { row: 1, col: 1 });
        const idx = Math.max(0, cur.row - 1);
        this.app.setZeroFromStock(items[i][0], idx);
        this.say(`G${54 + idx} probed: ${items[i][1].replace(/^Probe( corner)?: /, '')}`);
      },
    };
  }

  // ------------------------------------------------------------------ popups
  popupKey(id, o) {
    const p = this.popup;
    if (id === 'RESET' || id === 'POWER_OFF' || id === 'ESTOP' || id === 'FEED_HOLD' || id === 'POWER_ON') { if (id !== 'RESET') this.popup = null; return false; }
    if (p.kind === 'yn') {
      if (id === 'A_Y') { this.popup = null; p.yes?.(); return true; }
      if (id === 'A_N' || id === 'CANCEL') { this.popup = null; p.no?.(); this.say('Cancelled'); return true; }
      if (id === 'ENTER') return true;
      return true;
    }
    if (p.kind === 'list') {
      if (id === 'UP') p.row = Math.max(0, p.row - 1);
      else if (id === 'DOWN') p.row = Math.min(p.items.length - 1, p.row + 1);
      else if (id === 'ENTER' || id === 'RIGHT') { this.popup = null; p.pick(p.row); }
      else if (id === 'CANCEL' || id === 'LEFT') this.popup = null;
      else if (/^N_\d$/.test(id)) { const i = +id.slice(2) - 1; if (i >= 0 && i < p.items.length) { this.popup = null; p.pick(i); } }
      return true;
    }
    if (p.kind === 'form') {
      const f = p.fields[p.row];
      if (CHARS[id]) {
        const ch = CHARS[id][this.shift || o.shift ? 1 : 0];
        this.shift = false;
        // the suggested value is replaced by the first key typed into the field
        if (!f.typed) { f.v = ''; f.typed = true; }
        f.v += ch;
        return true;
      }
      if (id === 'SHIFT') { this.shift = !this.shift; return true; }
      if (id === 'SPACE') { f.v += ' '; return true; }
      if (id === 'CANCEL') { f.typed = true; if (f.v) f.v = f.v.slice(0, -1); else { this.popup = null; this.say('Cancelled'); } return true; }
      if (id === 'UP') { p.row = Math.max(0, p.row - 1); return true; }
      if (id === 'DOWN') { p.row = Math.min(p.fields.length - 1, p.row + 1); return true; }
      if (id === 'ENTER') {
        if (p.row < p.fields.length - 1) p.row++;
        else { this.popup = null; p.done(Object.fromEntries(p.fields.map((x) => [x.k, x.v.trim()]))); }
        return true;
      }
      return true;
    }
    if (p.kind === 'info') {
      if (['ENTER', 'CANCEL', 'LEFT'].includes(id)) this.popup = null;
      return true;
    }
    return false;
  }

  fileMenu() {
    this.popup = {
      kind: 'list', title: 'File', items: ['Rename', 'Duplicate (copy in Memory)', 'Show file details', 'Special Symbols'], row: 0,
      pick: (i) => {
        if (i === 0) this.lpRename();
        else if (i === 1) this.lpCopy();
        else if (i === 2) {
          const f = this.lpSel();
          if (!f) return;
          this.popup = { kind: 'info', title: 'File Details', lines: [`File Name: ${f.name}`, `O Number: ${f.onum || '-'}`, `Comment: ${f.comment || '-'}`, `Size: ${f.size} bytes`, f.modified ? `Last Modified: ${new Date(f.modified).toLocaleString()}` : `Device: USB`] };
        } else this.specialSymbols();
      },
    };
  }

  specialSymbols() {
    const sym = ['_', '^', '~', '{', '}', '\\', '|', '<', '>', '"', ','];
    this.popup = { kind: 'list', title: 'Special Symbols', items: sym.map((s) => `${s}`), row: 0, pick: (i) => { this.typeChar(sym[i]); } };
  }

  editorMenu() {
    const ed = this.ui.editor;
    this.popup = {
      kind: 'list', title: 'Editor Menu', row: 0,
      items: ['Search: find the text on the input line', 'Find next', 'Go to the top of the program', 'Go to the end of the program', 'Renumber all blocks (N10, N20 ...)', 'Remove all block numbers', 'Paste the clipboard after the cursor', 'Save and load (as MEMORY)'],
      pick: (i) => {
        const lines = ed.lines;
        if (i === 0 || i === 1) {
          const q = (i === 0 ? this.input.trim() : this._find || '').toUpperCase();
          if (!q) return this.say('Type the text to find on the input line first', 'warn');
          this._find = q;
          if (i === 0) this.input = '';
          for (let k = 1; k <= lines.length; k++) {
            const n = (this.editCur.line + k) % lines.length;
            const ws = lineWords(lines[n]);
            const w = ws.findIndex((x) => x.s.toUpperCase().includes(q));
            if (w >= 0) { this.editCur = { line: n, word: w }; return this.say(`Found "${q}" in line ${n + 1}`); }
          }
          return this.say(`"${q}" not found`, 'warn');
        }
        if (i === 2) this.editCur = { line: 0, word: 0 };
        else if (i === 3) this.editCur = { line: Math.max(0, lines.length - 1), word: 0 };
        else if (i === 4 || i === 5) {
          if (!this.textEditable(this.textCtx())) return;
          this.pushUndo(this.textCtx());
          if (i === 4) this.ui.hmi.renumber(); else this.ui.hmi.stripN();
        } else if (i === 6) {
          if (!this.clip) return this.say('The clipboard is empty (F2 to select, ENTER to copy)', 'warn');
          this.editInsert(this.textCtx());
        } else this.selectMode('MEM');
      },
    };
  }

  // ------------------------------------------------------------------ settings
  settingList() {
    const defs = settingDefs(this);
    const g = this.cursor('setting', { group: null });
    if (g.group == null) return null;
    return defs.filter((d) => d.g === g.group);
  }

  settingMove(dx, dy) {
    const cur = this.cursor('setting', { group: null });
    if (cur.group == null) {
      if (dx > 0) { cur.group = SETTINGS_GROUPS[cur.row] ? cur.row : 0; cur.srow = 0; return; }
      cur.row = clampI(cur.row + dy, 0, SETTINGS_GROUPS.length - 1);
      return;
    }
    const list = this.settingList();
    if (dx < 0) { cur.group = null; return; }
    if (dx > 0) {
      const s = list[cur.srow];
      if (s && (s.type === 'list' || s.type === 'bool')) this.settingChoices(s);
      return;
    }
    cur.srow = clampI((cur.srow || 0) + dy, 0, list.length - 1);
  }

  settingChoices(s) {
    const items = s.type === 'bool' ? ['OFF', 'ON'] : s.opts;
    const curV = this.settingValue(s);
    this.popup = {
      kind: 'list', title: `Setting ${s.n}: ${s.name}`, items, row: Math.max(0, items.indexOf(curV)),
      pick: (i) => this.settingWrite(s, s.type === 'bool' ? i === 1 : items[i]),
    };
  }

  settingValue(s) {
    if (s.get) return s.get();
    const v = this.set(s.n);
    if (s.type === 'bool') return v ? 'ON' : 'OFF';
    return v;
  }

  settingWrite(s, v) {
    if (s.n !== 'S1' && this.locked('settings')) return;
    if (s.ro) return this.say(`Setting ${s.n} is read-only on this machine`, 'warn');
    if (s.set) s.set(v);
    else this.st.set[s.n] = v;
    this.save();
    if (s.n === 101) this.c.rov = !!v;
    this.say(`Setting ${s.n} ${s.name}: ${this.settingValue(s)}`);
  }

  settingEnter() {
    const cur = this.cursor('setting', { group: null });
    if (cur.group == null) { cur.group = cur.row; cur.srow = 0; return; }
    const s = this.settingList()[cur.srow];
    if (!s) return;
    if (s.type === 'list' || s.type === 'bool') return this.settingChoices(s);
    const v = parseFloat(this.input);
    if (!isFinite(v)) return this.say('Type a value, then ENTER', 'warn');
    if (s.min != null && v < s.min) return this.say(`Setting ${s.n}: minimum ${s.min}`, 'error');
    if (s.max != null && v > s.max) return this.say(`Setting ${s.n}: maximum ${s.max}`, 'error');
    this.input = '';
    this.settingWrite(s, s.len ? this.fromD(v) : v);
  }

  settingJump() {
    const q = this.input.trim().toUpperCase();
    const defs = settingDefs(this);
    const s = defs.find((d) => String(d.n) === q || String(d.n) === q.replace(/^0+/, ''));
    if (!s) return this.say(`Setting ${q || '?'} is not available on this machine`, 'warn');
    this.input = '';
    const cur = this.cursor('setting', { group: null });
    cur.group = s.g;
    cur.srow = this.settingList().indexOf(s);
    cur.row = s.g;
  }

  settingOrigin() {
    const cur = this.cursor('setting', { group: null });
    if (cur.group == null) return;
    const s = this.settingList()[cur.srow];
    if (!s || s.get) return this.say('ORIGIN: this setting has no factory default here', 'warn');
    delete this.st.set[s.n];
    this.save();
    this.say(`Setting ${s.n} back to its default`);
  }

  // ------------------------------------------------------------------ messages tab
  msgInsert() {
    const t = this.input.trim();
    if (!t) return this.say('Type the message on the input line, then ENTER', 'warn');
    const cur = this.cursor('al1');
    this.st.messages.splice(Math.min(cur.row + (this.st.messages.length ? 1 : 0), this.st.messages.length), 0, t);
    cur.row = Math.min(cur.row + 1, this.st.messages.length - 1);
    this.input = '';
    this.save();
  }

  // ------------------------------------------------------------------ calculator (HELP > Calculator)
  calcEnter() {
    const src = this.input.trim();
    if (!src) return;
    try {
      const v = calcEval(src);
      this.calc.lines.unshift(`${src} = ${+v.toPrecision(10)}`);
      this.calc.lines = this.calc.lines.slice(0, 12);
      this.calc.res = v;
      this.input = String(+v.toPrecision(10));
    } catch (e) {
      this.say('Calculator: ' + e.message, 'error');
    }
  }

  // ------------------------------------------------------------------ VPS
  vpsMove(dx, dy) {
    const v = this.vps;
    if (!v.tpl) {
      if (dx > 0) return this.vpsOpen();
      v.dirRow = clampI(v.dirRow + dy, 0, VPS_TEMPLATES.length - 1);
      return;
    }
    if (dx < 0) { v.tpl = null; return; }
    const tpl = VPS_TEMPLATES.find((t) => t.id === v.tpl);
    v.row = clampI(v.row + dy, 0, tpl.vars.length - 1);
  }

  vpsOpen() {
    const v = this.vps;
    const tpl = VPS_TEMPLATES[v.dirRow];
    if (!tpl) return;
    if (v.tpl !== tpl.id || !v.vals) {
      v.vals = vpsDefaults(tpl, this.inch);
      v.changed = new Set();
      v.row = 0;
    }
    v.tpl = tpl.id;
    v.recent = [tpl.id, ...v.recent.filter((x) => x !== tpl.id)].slice(0, 5);
    this.say(`${tpl.name}: UP/DOWN selects a variable, type a value + ENTER. F4 generates the G-code, CYCLE START runs it in MDI`);
  }

  vpsEnter() {
    const v = this.vps;
    if (!v.tpl) return this.vpsOpen();
    const tpl = VPS_TEMPLATES.find((t) => t.id === v.tpl);
    const vr = tpl.vars[v.row];
    const x = parseFloat(this.input);
    if (!isFinite(x)) return this.say('Type a value, then ENTER', 'warn');
    if (vr.min != null && x < vr.min) return this.say(`${vr.k}: minimum ${vr.min}`, 'error');
    if (vr.max != null && x > vr.max) return this.say(`${vr.k}: maximum ${vr.max}`, 'error');
    v.vals[vr.k] = vr.kind === 'int' || vr.kind === 'choice' || vr.kind === 'bool' ? Math.round(x) : x;
    v.changed.add(vr.k);
    this.input = '';
    v.row = Math.min(v.row + 1, tpl.vars.length - 1);
  }

  vpsCode() {
    const tpl = VPS_TEMPLATES.find((t) => t.id === this.vps.tpl);
    const app = this.app;
    const res = vpsGenerate(tpl, this.vps.vals, {
      inch: this.inch, haas: haasDialect() === 'haas',
      toolDia: (n) => { const t = app.tools.find((x) => x.number === n); return t ? this.toD(this.toolGeom(t).dg) : 0; },
      toolDesc: (n) => { const t = app.tools.find((x) => x.number === n); return t ? t.name.toUpperCase().replace(/[()]/g, '').replace(/Ø/g, 'D') : 'NO TOOL'; },
    });
    if (res.error) this.say('VPS: ' + res.error, 'error');
    return res.error ? null : res.lines;
  }

  vpsGenerate() {
    const lines = this.vpsCode();
    if (!lines) return;
    this.popup = {
      kind: 'list', title: 'Generate G-code: output to', row: 0,
      items: ['1  Insert into the active program after the cursor', '2  MDI program', '3  New program (next free O number)'],
      pick: (i) => this.vpsOutput(i, lines),
    };
  }

  vpsOutput(i, lines) {
    const app = this.app, store = app.programs;
    const tpl = VPS_TEMPLATES.find((t) => t.id === this.vps.tpl);
    if (i === 0) {
      if (!app.programName) return this.say('No active program: use output 3 (new program)', 'warn');
      if (this.locked('programs')) return;
      if (this.c.exec?.kind === 'program') return this.say('The active program is running', 'warn');
      const ed = this.ui.editor;
      this.undo.push({ text: ed.getValue(), cur: { ...this.editCur } });
      const all = ed.getValue().replace(/\n$/, '').split('\n');
      let at = Math.min(this.editCur.line + 1, all.length);
      // never after M30 / %: insert before the program end
      const end = all.findIndex((l, k) => k >= 1 && /^\s*(M30|M02|%)\b/i.test(l.trim()));
      if (end >= 0 && at > end) at = end;
      all.splice(at, 0, ...lines);
      ed.applyText(all.join('\n') + '\n', at);
      this.editCur = { line: at + lines.length - 1, word: 0 };
      this.tab.edit = 0;
      return this.say(`${tpl.name}: ${lines.length} blocks inserted into ${app.programName}`);
    }
    if (i === 1) {
      this.ui.setMda(lines.join('\n') + '\n');
      this.mdiCur = { line: 0, word: 0 };
      this.selectMode('MDI');
      return this.say(`${tpl.name}: G-code in the MDI program. Press CYCLE START to run it`);
    }
    if (this.locked('programs')) return;
    let n = 1;
    while (store.has(`O${String(n).padStart(5, '0')}.MPF`)) n++;
    const onum = `O${String(n).padStart(5, '0')}`;
    const name = `${onum}.MPF`;
    store.put(name, ['%', `${onum} (VPS ${tpl.name.toUpperCase()})`, ...lines, 'M30', '%'].join('\n') + '\n');
    app.openProgram(name);
    this.editCur = { line: 0, word: 0 };
    this.undo = [];
    this.say(`${tpl.name}: saved as ${onum} and selected. MEMORY, then CYCLE START (check it in GRAPHICS first)`);
  }

  vpsRun() {
    const lines = this.vpsCode();
    if (!lines) return;
    this.vpsOutput(1, lines);
    if (this.mode === 'MDI') this.cycleStart(true);
  }

  // ------------------------------------------------------------------ graphics (simulation without motion)
  graphicsStart() {
    const app = this.app;
    const prog = this.mode === 'MDI' ? app.compileMDA(this.ui.mdaText) : app.compile();
    if (!prog || prog.errors.length) {
      const e = prog?.errors[0];
      return this.say(e ? `Graphics: line ${e.line + 1}: ${e.msg}` : 'Graphics: nothing to simulate', 'error');
    }
    this.graphics.prog = prog;
    this.graphics.t = 0;
    this.graphics.run = true;
    this.say('Graphics running (no machine motion). FEED HOLD stops it');
  }

  graphicsTick(dt) {
    const g = this.graphics;
    if (!g.run || !g.prog) return;
    g.t += dt * g.speed * 4;
    if (g.t >= g.prog.totalTime) { g.t = g.prog.totalTime; g.run = false; this.say('Graphics: program end'); }
  }

  // ------------------------------------------------------------------ 3D pendant screen
  drawScreen(canvas) {
    drawPendantTexture(this, canvas);
  }
}

export const MACRO_ROWS = [...Array.from({ length: 100 }, (_, i) => 100 + i), ...Array.from({ length: 500 }, (_, i) => 500 + i)];
const CTRL_MODE_INV = { AUTO: 'MEM', MDA: 'MDI', JOG: 'JOG', REF: 'ZERO' };

function clampI(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

export function progHead(text) {
  let onum = '', comment = '';
  for (const raw of String(text || '').split('\n', 20)) {
    const l = raw.trim();
    if (!l || l === '%') continue;
    const m = /^O(\d{1,5})\s*(\((.*?)\))?/i.exec(l);
    if (m) { onum = m[1].padStart(5, '0'); if (m[3]) comment = m[3]; continue; }
    if (!comment) {
      const c = /^\((.*?)\)$/.exec(l) || /^;\s*(.*)$/.exec(l);
      if (c) comment = c[1];
    }
    if (onum || comment) break;
  }
  return { onum, comment: comment.slice(0, 40) };
}

export function alarmFromMessage(msg, prog = false) {
  const s = String(msg);
  const ot = /Over-travel: machine ([XYZ])/i.exec(s);
  if (ot) return { num: { X: 316, Y: 317, Z: 318 }[ot[1].toUpperCase()], text: `${ot[1].toUpperCase()} OVER TRAVEL RANGE: ${s}` };
  const m = /^(?:Line \d+: )?(\d{3,5})\s+(.*)$/.exec(s);
  if (m) return { num: +m[1], text: s.replace(m[1] + ' ', '') };
  if (/crash|collision/i.test(s)) return { num: 'SIM', text: `COLLISION: ${s}` };
  return { num: prog ? 'PRG' : 'SIM', text: s };
}

// Expression calculator: + - * / ^ ( ) and sin cos tan sqrt abs pi (degrees).
export function calcEval(src) {
  const s = src.replace(/\s+/g, '').toLowerCase();
  let i = 0;
  const num = () => {
    const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/.exec(s.slice(i));
    if (!m) throw new Error(`unexpected "${s[i] || 'end'}"`);
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const atom = () => {
    if (s[i] === '(') { i++; const v = expr(); if (s[i] !== ')') throw new Error('missing ")"'); i++; return v; }
    if (s[i] === '-') { i++; return -atom(); }
    if (s[i] === '+') { i++; return atom(); }
    const f = /^(sin|cos|tan|sqrt|abs|atan|asin|acos)/.exec(s.slice(i));
    if (f) { i += f[1].length; const v = atom(); const r = Math.PI / 180; return { sin: Math.sin(v * r), cos: Math.cos(v * r), tan: Math.tan(v * r), sqrt: Math.sqrt(v), abs: Math.abs(v), atan: Math.atan(v) / r, asin: Math.asin(v) / r, acos: Math.acos(v) / r }[f[1]]; }
    if (s.startsWith('pi', i)) { i += 2; return Math.PI; }
    return num();
  };
  const pow = () => { let v = atom(); while (s[i] === '^') { i++; v = v ** atom(); } return v; };
  const term = () => { let v = pow(); while (s[i] === '*' || s[i] === '/') { const o = s[i++]; const w = pow(); v = o === '*' ? v * w : v / w; } return v; };
  const expr = () => { let v = term(); while (s[i] === '+' || s[i] === '-') { const o = s[i++]; const w = term(); v = o === '+' ? v + w : v - w; } return v; };
  const v = expr();
  if (i < s.length) throw new Error(`unexpected "${s[i]}"`);
  if (!isFinite(v)) throw new Error('result is not a number');
  return v;
}

// Sample programs on the "USB stick", generated by the VPS templates (metric, G54 = top centre of the
// default 120 x 80 blank).
let samples = null;
export function VPS_SAMPLES() {
  if (samples) return samples;
  const mk = (id, onum, file, comment, tplId, vals) => ({
    id, onum, file, comment,
    code: () => {
      const tpl = VPS_TEMPLATES.find((t) => t.id === tplId);
      const v = { ...vpsDefaults(tpl, false), ...vals };
      const res = vpsGenerate(tpl, v, { inch: false, haas: haasDialect() === 'haas', toolDia: (n) => ({ 1: 50, 2: 10, 3: 6, 4: 10, 5: 6.8 }[n] || 10), toolDesc: (n) => ({ 1: 'FACE MILL D50', 2: 'END MILL D10', 3: 'END MILL D6', 4: 'SPOT DRILL D10', 5: 'DRILL D6.8' }[n] || 'TOOL') });
      return ['%', `O${onum} (${comment})`, ...(res.lines || []), 'M30', '%'].join('\n') + '\n';
    },
  });
  samples = [
    mk('vps-face', '01001', 'O01001.MPF', 'VPS FACE MILL 120X80', 'face', {}),
    mk('vps-rpocket', '01002', 'O01002.MPF', 'VPS RECT POCKET 60X40X6', 'rpocket', {}),
    mk('vps-cpocket', '01003', 'O01003.MPF', 'VPS CIRCULAR POCKET D40', 'cpocket', { T: 2 }),
    mk('vps-drill', '01004', 'O01004.MPF', 'VPS BOLT CIRCLE 6X R25', 'drill', {}),
  ];
  return samples;
}

export function haasDefaultDialect(app, text) {
  return looksHaas(text) ? haasDialect() : null;
}

export { detectDialect };
