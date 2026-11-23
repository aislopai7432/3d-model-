// UI glue: machine control panel, keyboard, viewport interaction, program manager operations, tool
// editing, setup wizard and logging. The 808D-style screen itself lives in hmi.js.
import { MACHINE, MATERIALS, TOOL_TYPES, VISE } from '../config.js';
import { holderFor } from '../sim/tooling.js';
import { fmtTime } from '../sim/controller.js';
import { stockPlacement } from '../scene/workholding.js';
import { getExample808 } from '../gcode/examples808.js';
import { Editor } from './editor.js';
import { HMI, SIE_TYPES } from './hmi.js';
import { normName, validName } from './programs.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const SPEEDS = [0.25, 0.5, 1, 2, 5, 10, 20, 50, 100, 'max'];
const FEED_STEPS = [0, 1, 2, 4, 6, 8, 10, 20, 30, 40, 50, 60, 70, 75, 80, 85, 90, 95, 100, 105, 110, 115, 120];
const SP_STEPS = [50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100, 105, 110, 115, 120];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const r3 = (v) => Math.round(v * 1000) / 1000;

export class UI {
  constructor(app) {
    this.app = app;
    this.hmi = new HMI(app, this);
    this.editor = new Editor($('#editor'));
    this.editor.onChange(() => app.scheduleCompile());
    this.logItems = [];
    this.mdaText = 'G0 G90 G54 X0 Y0\n';
    this.inc = null;
    this.zeroPos = 'top-center';
    this.zeroIdx = 0;
    this.lastUi = {};
  }

  loading(text) {
    const el = $('#loading');
    if (!el) return;
    if (text == null) {
      el.classList.add('done');
      setTimeout(() => el.remove(), 600);
    } else $('#loadingText').textContent = text;
  }

  get c() {
    return this.app.controller;
  }

  // ------------------------------------------------------------------ init
  init() {
    const app = this.app;
    this.actions = this.makeActions();
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-action]');
      if (b) this.act(b.dataset.action);
    });
    $$('[data-toggle]').forEach((b) => b.addEventListener('click', () => this.toggle(b.dataset.toggle, b)));
    $$('[data-view]').forEach((b) => b.addEventListener('click', () => this.setView(b.dataset.view)));
    $$('#mobileTabs button').forEach((b) => b.addEventListener('click', () => {
      document.body.dataset.mview = b.dataset.mview;
      $$('#mobileTabs button').forEach((x) => x.classList.toggle('active', x === b));
      setTimeout(() => app.viewer.resize(), 50);
    }));
    this.bindSplitter();
    this.bindMCP();
    this.bindKeyboard();
    this.bindViewport();
    $('#fileInput').addEventListener('change', (e) => this.importFile(e.target.files[0]));
    const vp = $('#viewport');
    vp.addEventListener('dragover', (e) => e.preventDefault());
    vp.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer.files[0]) this.importFile(e.dataTransfer.files[0]);
    });
    const s = app.settings;
    if (s.lights === false) this.toggle('lights', $('[data-toggle="lights"]'), false);
    if (s.enclosure === false) this.toggle('enclosure', $('[data-toggle="enclosure"]'), false);
    if (s.covers === false) this.toggle('covers', $('[data-toggle="covers"]'), false);
    $('[data-toggle="toolpath"]').classList.toggle('on', s.showToolpath);
    this.updateSoundBtn();
    for (const el of $$('[data-action]')) if (!this.actions[el.dataset.action]) console.warn('Unbound action', el.dataset.action);
    window.addEventListener('pointerdown', () => app.sound.init(), { once: true, capture: true });
    window.addEventListener('keydown', () => app.sound.init(), { once: true, capture: true });
    this.hmi.init();
    this.renderMCP();
    this.update(true);
  }

  act(name) {
    const fn = this.actions[name];
    if (!fn) return console.warn('No handler for action', name);
    this.app.sound.init();
    fn();
  }

  makeActions() {
    const app = this.app;
    const c = () => app.controller;
    const manual = (what) => {
      if (!c().canManual()) {
        this.log(c().exec ? `Stop the program before ${what}` : 'Clear the alarm / E-stop with RESET first', 'warn');
        return false;
      }
      return true;
    };
    return {
      cycleStart: () => app.cycleStart(),
      feedHold: () => c().feedHold('Cycle stop'),
      reset: () => this.resetChannel(),
      estop: () => c().emergencyStop(),
      home: () => c().home(),
      newBlank: () => {
        if (c().exec) return this.log('Stop the program before loading a new blank', 'warn');
        if (app.game?.blockStockChange('New blank')) return;
        app.stockEmpty = false;
        app.rebuildStock();
        this.log('Fresh blank loaded');
        this.hmi.rerender();
      },
      coolantFlood: () => { if (manual('changing coolant')) { c().setCoolant(true, c().coolant.mist); this.log('Coolant on (M8)'); this.hmi.rerender(); } },
      coolantOff: () => { if (manual('changing coolant')) { c().setCoolant(false, false); this.log('Coolant off (M9)'); this.hmi.rerender(); } },
      toolChange: () => {
        const sel = $('#tcTool');
        const n = sel ? +sel.value : this.hmi.toolSel || 0;
        if (manual('changing tools')) this.runMDI(app.dialect() === 'iso' ? `T${n} M06` : `T${n} M6`);
      },
      gotoZero: () => {
        if (!manual('moving')) return;
        const w = c().modal.wcs === 500 ? 54 : c().modal.wcs;
        this.runMDI(`G0 G53 Z0 D0\nG0 G90 G${w} X0 Y0${c().tool ? '\nD1' : ''}`, true);
      },
      door: () => {
        const open = c().door.target < 0.5;
        c().setDoor(open);
        this.log(open ? 'Doors opening' : 'Doors closing');
      },
      openFile: () => $('#fileInput').click(),
      resetAll: () => {
        if (!confirm('Reset all settings, tools, offsets, R variables and stored programs to their defaults?')) return;
        try {
          for (const k of ['milllab.v1', 'milllab.programs.v1', 'milllab.r', 'milllab.layout', 'milllab.game', 'milllab.haas', 'milllab.vars']) localStorage.removeItem(k);
        } catch { /* ignore */ }
        location.reload();
      },
      wizard: () => this.openWizard(),
      wizardClose: () => { $('#wizard').hidden = true; },
      wizardBack: () => this.wizardStep(this.wz.step - 1),
      wizardNext: () => this.wizardNext(),
      sound: () => {
        app.settings.muted = !app.settings.muted;
        app.sound.init();
        app.sound.setMuted(app.settings.muted);
        this.updateSoundBtn();
        app.save();
      },
      help: () => { $('#helpModal').hidden = false; },
      helpClose: () => { $('#helpModal').hidden = true; },
    };
  }

  resetChannel() {
    const app = this.app, c = this.c;
    const wasProgram = c.exec?.kind === 'program' || c.state === 'hold' || c.state === 'alarm';
    c.reset();
    app.toolpath.setProgress(-1);
    this.editor.setExecLine(-1);
    this.hmi.clearAlarms();
    if (c.homed && c.pos.z < -1e-6 && wasProgram) {
      const op = c.manualMove({ ...c.pos }, { ...c.pos, z: 0 }, MACHINE.rapidZ * 0.5);
      if (op) c.runOps([op], 'jog');
    }
    app.compile();
    this.log('RESET: channel reset, program aborted, alarms cleared');
    this.hmi.rerender();
  }

  // ------------------------------------------------------------------ MCP
  bindMCP() {
    const c = () => this.c;
    $$('.key.mode').forEach((b) => b.addEventListener('click', () => {
      this.app.sound.click();
      if (c().setMode(b.dataset.mode)) {
        this.log(`Mode ${b.dataset.mode === 'REF' ? 'REF POINT' : b.dataset.mode}`);
        if (b.dataset.mode !== 'JOG' && this.hmi.sub.machine === 'wo') this.hmi.sub.machine = null;
        this.hmi.showArea('machine');
      }
      this.renderMCP();
    }));
    $$('.key.inc').forEach((b) => b.addEventListener('click', () => {
      this.app.sound.click();
      const v = +b.dataset.inc;
      this.setInc(this.inc === v ? null : v);
    }));
    $$('[data-pc]').forEach((b) => b.addEventListener('click', () => { this.app.sound.click(); this.progCtrl(b.dataset.pc); }));
    $$('[data-sp]').forEach((b) => b.addEventListener('click', () => { this.app.sound.click(); this.manualSpindle(+b.dataset.sp); }));
    // axis keys: JOG (incremental / continuous) or REF POINT
    this.rapidHeld = false;
    const rapid = $('[data-rapid]');
    rapid.addEventListener('pointerdown', (e) => { e.preventDefault(); this.rapidHeld = true; rapid.classList.add('on'); });
    const rup = () => { this.rapidHeld = false; rapid.classList.remove('on'); };
    rapid.addEventListener('pointerup', rup);
    rapid.addEventListener('pointerleave', rup);
    for (const b of $$('[data-jog]')) {
      const axis = b.dataset.jog[0], dir = b.dataset.jog[1] === '+' ? 1 : -1;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.app.sound.init();
        b.classList.add('held');
        this.axisPress(axis, dir, this.rapidHeld || e.shiftKey);
      });
      const end = () => {
        b.classList.remove('held');
        if (!this.inc) this.c.jogStop();
      };
      b.addEventListener('pointerup', end);
      b.addEventListener('pointerleave', end);
      b.addEventListener('pointercancel', end);
    }
    this.knob($('#knobFeed'), FEED_STEPS, () => c().overrides.feed, (v) => { c().overrides.feed = v; });
    this.knob($('#knobSpindle'), SP_STEPS, () => c().overrides.spindle, (v) => { c().overrides.spindle = v; });
    const sp = $('#simSpeed');
    sp.max = SPEEDS.length - 1;
    sp.addEventListener('input', () => this.setSimSpeed(+sp.value));
    this.setSimSpeed(2);
  }

  knob(el, steps, get, set) {
    el.tabIndex = 0;
    const draw = () => {
      const v = get();
      const i = steps.indexOf(v) >= 0 ? steps.indexOf(v) : steps.findIndex((s) => s >= v);
      const ang = -135 + (270 * i) / (steps.length - 1);
      el.querySelector('.dial i').style.transform = `rotate(${ang}deg)`;
      el.querySelector('b').textContent = `${v}%`;
    };
    const stepBy = (d) => {
      const v = get();
      let i = steps.indexOf(v);
      if (i < 0) i = steps.findIndex((s) => s >= v);
      i = Math.max(0, Math.min(steps.length - 1, i + d));
      set(steps[i]);
      draw();
    };
    el.addEventListener('wheel', (e) => { e.preventDefault(); stepBy(e.deltaY < 0 ? 1 : -1); }, { passive: false });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); stepBy(1); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); stepBy(-1); }
    });
    let drag = null;
    el.addEventListener('pointerdown', (e) => { drag = { y: e.clientY, acc: 0 }; el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      drag.acc += drag.y - e.clientY;
      drag.y = e.clientY;
      while (drag.acc > 12) { stepBy(1); drag.acc -= 12; }
      while (drag.acc < -12) { stepBy(-1); drag.acc += 12; }
    });
    el.addEventListener('pointerup', () => { drag = null; });
    el.redraw = draw;
    draw();
  }

  setInc(v) {
    this.inc = v || null;
    this.renderMCP();
    if (this.hmi.area === 'machine') this.hmi.rerender();
  }

  setSimSpeed(i) {
    const sp = $('#simSpeed');
    sp.value = i;
    const v = SPEEDS[i];
    this.c.simSpeed = v;
    $('#simSpeedVal').textContent = v === 'max' ? 'MAX' : `${v}×`;
  }

  renderMCP() {
    const c = this.c;
    $$('.key.mode').forEach((b) => b.classList.toggle('on', b.dataset.mode === c.mode));
    $$('.key.inc').forEach((b) => b.classList.toggle('on', this.inc === +b.dataset.inc));
    const pc = { sbl: c.singleBlock, m01: c.optionalStop, skp: this.app.settings.blockDelete, dry: c.dryRun };
    $$('[data-pc]').forEach((b) => b.classList.toggle('on', !!pc[b.dataset.pc]));
    const sd = c.spindle.dir;
    $$('[data-sp]').forEach((b) => b.classList.toggle('on', +b.dataset.sp === sd && (sd !== 0 || Math.abs(c.spindle.rpm) < 1)));
    $('#knobFeed').redraw?.();
    $('#knobSpindle').redraw?.();
  }

  axisPress(axis, dir, rapid) {
    const c = this.c;
    if (c.mode === 'REF') {
      if (dir < 0) return this.log('REF POINT: reference with the + direction keys', 'warn');
      return c.refAxis(axis);
    }
    if (c.mode !== 'JOG') return this.log(`Axis keys work in JOG or REF POINT mode (now ${c.mode})`, 'warn');
    const feed = rapid ? (axis === 'z' ? MACHINE.rapidZ : MACHINE.rapidXY) : this.app.settings.jogFeed;
    if (this.inc) c.jog(axis, dir * this.inc, Math.max(feed, this.inc >= 1 ? 2000 : feed));
    else c.jogStart(axis, dir, feed);
  }

  progCtrl(k) {
    const c = this.c, s = this.app.settings;
    if (k === 'sbl') c.singleBlock = !c.singleBlock;
    else if (k === 'm01') { c.optionalStop = !c.optionalStop; s.optionalStop = c.optionalStop; }
    else if (k === 'skp') {
      s.blockDelete = !s.blockDelete;
      this.app.compile();
    } else if (k === 'dry') c.dryRun = !c.dryRun;
    else if (k === 'rov') c.rov = !c.rov;
    const names = { sbl: ['SBL', c.singleBlock], m01: ['M01', c.optionalStop], skp: ['SKP', s.blockDelete], dry: ['DRY', c.dryRun], rov: ['ROV', c.rov] };
    this.log(`${names[k][0]} ${names[k][1] ? 'on' : 'off'}`);
    this.app.save();
    this.renderMCP();
    this.hmi.rerender();
  }

  manualSpindle(dir) {
    const c = this.c;
    if (!c.canManual()) return this.log(c.exec ? 'Stop the program before using the spindle manually' : 'Clear the alarm first', 'warn');
    if (dir && c.mode !== 'JOG' && c.mode !== 'MDA') return this.log('Spindle keys work in JOG (use M3/M4 in MDA or AUTO)', 'warn');
    const rpm = Math.max(0, Math.min(MACHINE.maxRpm, this.app.settings.jogRpm));
    if (dir && !c.tool) this.log('Spindle started with no tool loaded', 'warn');
    c.setSpindle(rpm, dir);
    this.log(dir ? `Spindle ${dir > 0 ? 'CW' : 'CCW'} at ${rpm} rpm` : 'Spindle stop');
    this.renderMCP();
  }

  touchOff(axis) {
    const app = this.app, c = this.c;
    if (!c.canManual()) return this.log('Stop the program first', 'warn');
    const w = c.modal.wcs === 500 ? 54 : c.modal.wcs;
    const i = w - 54;
    const o = app.offsets[i];
    if (!o) return this.log(`The active work offset G${w} is not in the 808D/NGC offset table: select G54-G59`, 'warn');
    const tool = app.tools.find((t) => t.number === c.tool);
    if (axis === 'z') o.z = r3(c.pos.z - (tool ? tool.length + (tool.dLength || 0) : 0));
    else o[axis] = r3(c.pos[axis]);
    this.log(`G${w} ${axis.toUpperCase()} = ${o[axis]} (${axis === 'z' ? (tool ? `tip of T${tool.number}` : 'gauge line, no tool') : 'spindle centre'} is now ${axis.toUpperCase()}0)`);
    app.offsetsChanged();
  }

  setMda(t) {
    this.mdaText = t;
    const ta = $('#mdaText');
    if (ta) ta.value = t;
  }

  runMDI(text, quiet = false) {
    const app = this.app, c = this.c;
    if (!c.canManual()) return this.log(c.exec ? 'Machine is busy' : 'Clear the alarm / E-stop with RESET first', 'warn');
    const res = app.compileMDA(text);
    if (res.errors.length) {
      const e = res.errors[0];
      this.log(`MDA line ${e.line + 1}: ${e.msg}`, 'error');
      this.hmi.addAlarm(e.msg);
      return;
    }
    for (const w of res.warnings) this.log(`MDA: ${w.msg}`, 'warn');
    if (!quiet) this.log(`MDA: ${text.replace(/\n/g, ' | ')}`);
    if (!res.ops.length) return;
    app.mdaResult = res;
    c.runOps(res.ops, 'mdi');
  }

  // ------------------------------------------------------------------ program manager
  pmExecute(folder, sel) {
    const app = this.app;
    if (this.c.exec) return this.log('Stop the program first', 'warn');
    if (folder === 'ex') {
      app.loadExample808(sel);
    } else {
      app.openProgram(sel);
    }
    if (this.c.setMode('AUTO')) this.renderMCP();
    this.log(`${app.programName} selected for AUTO. Press CYCLE START.`);
    this.hmi.showArea('machine');
  }

  pmOpen(folder, sel) {
    if (this.c.exec?.kind === 'program') return this.log('Stop the program first', 'warn');
    this.app.openProgram(sel);
    this.hmi.showArea('program');
  }

  pmNew() {
    const store = this.app.programs;
    const name = normName(prompt('New program name (letters, digits, _):', store.uniqueName('NEW_PART')) || '');
    if (!name || name === '.MPF') return;
    if (!validName(name)) return this.log(`"${name}" is not a valid program name`, 'error');
    if (store.has(name)) return this.log(`${name} already exists`, 'error');
    store.put(name, `; ${name.replace('.MPF', '')}\nN10 G17 G90 G71 G94 G40 G54\nN20 T2 D1 M6\nN30 S8000 M3 M8\nN40 G0 X0 Y0 Z25\n\nN900 G0 Z100 M9\nN910 M5\nN920 M30\n`);
    this.app.openProgram(name);
    this.log(`${name} created`);
    this.hmi.showArea('program');
  }

  pmCopy(sel) {
    const store = this.app.programs;
    const name = store.uniqueName(sel.replace(/\.(MPF|SPF)$/, '') + '_COPY');
    store.put(name, store.get(sel));
    this.hmi.pmSel = name;
    this.log(`${sel} copied to ${name}`);
    this.hmi.rerender();
  }

  pmCopyExample(id) {
    const e = getExample808(id);
    const store = this.app.programs;
    const name = store.has(e.file) ? store.uniqueName(e.file) : e.file;
    store.put(name, e.code, { example: id });
    this.log(`${e.file} copied to NC memory as ${name}`);
    this.hmi.pmFolder = 'nc';
    this.hmi.pmSel = name;
    this.hmi.rerender();
  }

  pmRename(sel) {
    const store = this.app.programs;
    const name = normName(prompt(`Rename ${sel} to:`, sel) || '');
    if (!name || name === sel) return;
    if (!validName(name)) return this.log(`"${name}" is not a valid program name`, 'error');
    if (!store.rename(sel, name)) return this.log(`Cannot rename: ${name} exists`, 'error');
    if (this.app.programName === sel) this.app.programName = name;
    this.hmi.pmSel = name;
    this.setProgramName(this.app.programName);
    this.hmi.rerender();
  }

  pmDelete(sel) {
    if (sel === this.app.programName && this.c.exec) return this.log('The selected program is running', 'warn');
    if (!confirm(`Delete ${sel}?`)) return;
    this.app.programs.remove(sel);
    this.hmi.pmSel = null;
    this.log(`${sel} deleted`);
    this.hmi.rerender();
  }

  pmExport(sel) {
    const text = sel === this.app.programName ? this.editor.getValue() : this.app.programs.get(sel);
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = sel;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    this.log(`${sel} saved to this computer`);
  }

  saveAs() {
    const store = this.app.programs;
    const name = normName(prompt('Save the program as:', store.uniqueName((this.app.programName || 'PART').replace(/\.(MPF|SPF)$/, '') + '_2')) || '');
    if (!name || name === '.MPF') return;
    if (!validName(name)) return this.log(`"${name}" is not a valid program name`, 'error');
    store.put(name, this.editor.getValue());
    this.app.openProgram(name);
    this.log(`Saved as ${name}`);
  }

  executeCurrent() {
    if (this.c.setMode('AUTO')) this.renderMCP();
    this.hmi.showArea('machine');
    this.log(`${this.app.programName} selected for AUTO. Press CYCLE START.`);
  }

  simRun() {
    if (this.c.exec) return this.log('A program is already running', 'warn');
    this.c.setMode('AUTO');
    this.renderMCP();
    this.setSimSpeed(9);
    this.app.cycleStart();
  }

  importFile(file) {
    if (!file) return;
    if (this.c.exec) return this.log('Stop the program before loading a file', 'warn');
    if (file.size > 25 * 1024 * 1024) return this.log('File is larger than 25 MB', 'error');
    const r = new FileReader();
    r.onload = () => {
      if (this.app.haas?.active) {
        // NGC-style control: the file becomes Onnnnn program(s) in memory
        this.app.importProgramText(String(r.result), file.name);
        $('#fileInput').value = '';
        return;
      }
      const store = this.app.programs;
      let name = normName(file.name);
      if (!validName(name)) name = store.uniqueName('IMPORTED');
      if (store.has(name)) name = store.uniqueName(name);
      store.put(name, String(r.result).replace(/\r\n?/g, '\n'));
      this.app.openProgram(name);
      const res = this.app.compiled;
      this.log(`Loaded ${file.name} as ${name}: ${res.lineCount} lines, ${res.dialect === 'iso' ? 'ISO dialect' : 'Siemens mode'}, ${res.errors.length} error(s), est. ${fmtTime(res.totalTime)}`);
      if (res.workBounds) {
        const b = res.workBounds;
        this.log(`Cutting extents X${b.min[0].toFixed(1)}..${b.max[0].toFixed(1)} Y${b.min[1].toFixed(1)}..${b.max[1].toFixed(1)} Z${b.min[2].toFixed(1)}..${b.max[2].toFixed(1)}. Check the blank and work offset.`);
      }
      $('#fileInput').value = '';
      this.hmi.showArea('program');
    };
    r.onerror = () => this.log('Could not read the file', 'error');
    r.readAsText(file);
  }

  // ------------------------------------------------------------------ tools / offsets / R
  editTool(t, field, value, inp) {
    const app = this.app;
    if (this.c.exec) {
      this.log('Stop the program before editing tools', 'warn');
      this.hmi.rerender();
      return;
    }
    const next = { ...t };
    if (field === 'type') {
      next.type = value;
      if (['drill', 'spot', 'chamfer'].includes(value)) next.tipAngle = value === 'drill' ? 118 : 90;
      if (value === 'face') { next.flutes = 5; next.cornerRadius = 0.8; next.fluteLength = Math.min(next.fluteLength, 8); next.diameter = Math.max(next.diameter, 32); }
      if (value === 'bull' && !(next.cornerRadius > 0)) next.cornerRadius = 1;
    } else if (field === 'radius') next.diameter = +value * 2;
    else next[field] = +value;
    const err = validateTool(next);
    if (err) {
      this.log(`T${t.number}: ${err}`, 'error');
      inp.value = field === 'radius' ? t.diameter / 2 : t[field];
      return;
    }
    Object.assign(t, next);
    t.name = toolName(t);
    app.toolsChanged();
    this.hmi.rerender();
  }

  addTool() {
    const app = this.app;
    if (this.c.exec) return this.log('Stop the program first', 'warn');
    let n = 1;
    while (app.tools.some((t) => t.number === n)) n++;
    if (n > MACHINE.atcPockets) return this.log(`All ${MACHINE.atcPockets} magazine pockets are used`, 'warn');
    const t = { number: n, type: 'flat', diameter: 8, fluteLength: 20, length: 95, cornerRadius: 0, tipAngle: 0, flutes: 3, wear: 0, dLength: 0, dRadius: 0 };
    t.name = toolName(t);
    app.tools.push(t);
    this.hmi.toolSel = n;
    app.toolsChanged();
    this.hmi.rerender();
    this.log(`T${n} created in pocket ${n}`);
  }

  deleteTool(n) {
    const app = this.app;
    if (!n) return;
    if (this.c.tool === n) return this.log('Unload the tool from the spindle first', 'warn');
    if (this.c.exec) return this.log('Stop the program first', 'warn');
    app.tools = app.tools.filter((x) => x.number !== n);
    this.hmi.toolSel = app.tools[0]?.number;
    app.toolsChanged();
    this.hmi.rerender();
    this.log(`T${n} deleted`);
  }

  loadTool(n) {
    if (!this.c.canManual()) return this.log('Stop the program before changing tools', 'warn');
    if (n == null) return;
    this.runMDI(this.app.dialect() === 'iso' ? `T${n} M06` : `T${n} M6`);
  }

  resetWear(n) {
    const t = this.app.tools.find((x) => x.number === n);
    if (!t) return;
    t.wear = 0;
    t._warned = false;
    this.log(`T${n}: new cutter, tool life reset`);
    this.app.save();
    this.hmi.rerender();
  }

  clearDeltas(n) {
    const t = this.app.tools.find((x) => x.number === n);
    if (!t) return;
    t.dLength = 0;
    t.dRadius = 0;
    this.app.toolsChanged(false);
    this.hmi.rerender();
  }

  zeroFromBlank() {
    if (this.c.exec) return this.log('Stop the program first', 'warn');
    this.app.setZeroFromStock(this.zeroPos, this.zeroIdx);
    this.hmi.rerender();
  }

  clearOffsets() {
    if (this.c.exec) return this.log('Stop the program first', 'warn');
    if (!confirm('Set G54..G59 to zero?')) return;
    for (const o of this.app.offsets) Object.assign(o, { x: 0, y: 0, z: 0 });
    this.app.offsetsChanged();
    this.hmi.rerender();
  }

  clearR() {
    this.app.R.fill(0);
    this.app.saveR();
    this.app.compile();
    this.hmi.rerender();
    this.log('R0..R299 = 0');
  }

  applyStockForm() {
    const app = this.app;
    if (this.c.exec) return this.log('Stop the program before changing the blank', 'warn');
    if (app.game?.blockStockChange('Load blank')) return;
    const st = { x: +$('#bkX').value, y: +$('#bkY').value, z: +$('#bkZ').value, protrusion: +$('#bkP').value, material: $('#bkMat').value };
    const err = validateStock(st);
    if (err) return this.log(err, 'error');
    Object.assign(app.stock, st);
    app.rebuildStock();
    app.setZeroFromStock(this.zeroPos, this.zeroIdx);
    app.save();
    this.hmi.rerender();
    this.log(`New blank ${st.x} × ${st.y} × ${st.z} mm ${MATERIALS[st.material].name}`);
  }

  suggest(t) {
    const m = MATERIALS[this.app.stock.material];
    const drill = t.type === 'drill' || t.type === 'spot';
    const vc = ((m.vc[0] + m.vc[1]) / 2) * (drill ? 0.45 : 1);
    const rpm = Math.min(MACHINE.maxRpm, Math.round((vc * 1000) / (Math.PI * t.diameter) / 50) * 50);
    const fz = m.fz * Math.min(1.6, Math.max(0.25, t.diameter / 10)) * (drill ? 0.6 : 1);
    const f = Math.round(rpm * fz * (drill ? 1 : t.flutes));
    return `S${rpm} F${f} (Vc ${Math.round((Math.PI * t.diameter * rpm) / 1000)} m/min, fz ${fz.toFixed(3)} mm)`;
  }

  setOption(k, v) {
    const app = this.app, s = app.settings;
    if (k === 'control') return app.haas?.setControl(v);
    // a new accuracy re-creates the Z-map: in the workshop that would throw away the machined blank
    if (k === 'accuracy' && !app.stockEmpty && app.zmap?.removedTotal > 0 && app.game?.blockStockChange('Accuracy')) { this.hmi.rerender(); return; }
    s[k] = v;
    if (k === 'accuracy') {
      if (this.c.exec) { this.log('Stop the program before changing the accuracy', 'warn'); return; }
      app.rebuildStock();
      app.compile();
      this.log('Accuracy changed; blank reloaded at the new resolution');
    }
    if (k === 'dialect' || k === 'requireG43') app.compile();
    if (k === 'doorInterlock') this.c.doorInterlock = v;
    if (k === 'showChips') app.effects.showChips = v;
    if (k === 'showCoolant') app.effects.showCoolant = v;
    if (k === 'volume') app.sound.setVolume(v);
    app.save();
  }

  // ------------------------------------------------------------------ toggles and views
  toggle(name, btn, force) {
    const app = this.app;
    const on = force != null ? force : !btn.classList.contains('on');
    btn?.classList.toggle('on', on);
    const s = app.settings;
    if (name === 'enclosure') { app.machine.setEnclosureVisible(on); s.enclosure = on; this.autoHidden = false; }
    else if (name === 'lights') { app.machine.setLights(on); s.lights = on; }
    else if (name === 'covers') { app.machine.setCoversVisible(on); s.covers = on; }
    else if (name === 'toolpath') { app.toolpath.group.visible = on; s.showToolpath = on; }
    else if (name === 'measure') app.setMeasure(on);
    app.save();
  }

  toggleView(name) {
    const b = $(`[data-toggle="${name}"]`);
    this.toggle(name, b);
  }

  toggleMeasure() {
    this.toggleView('measure');
  }

  setView(v) {
    const app = this.app;
    $$('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
    const encBtn = $('[data-toggle="enclosure"]');
    if (v === 'top' && app.machine.enclosure.visible) {
      app.machine.setEnclosureVisible(false);
      encBtn.classList.remove('on');
      this.autoHidden = true;
    } else if (v !== 'top' && this.autoHidden) {
      app.machine.setEnclosureVisible(true);
      encBtn.classList.add('on');
      this.autoHidden = false;
    }
    app.viewer.setView(v);
  }

  bindSplitter() {
    const root = document.documentElement;
    let s = {};
    try { s = JSON.parse(localStorage.getItem('milllab.layout') || '{}'); } catch { /* ignore */ }
    if (s.cu) { root.style.setProperty('--cu', s.cu + 'px'); root.style.setProperty('--cu-u', s.cu + 'px'); }
    const sp = $('.splitter');
    sp.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      sp.setPointerCapture(e.pointerId);
      sp.classList.add('drag');
      const ws = $('#workspace').getBoundingClientRect();
      const move = (ev) => {
        const w = Math.max(420, Math.min(ws.width - 360, ws.right - ev.clientX));
        root.style.setProperty('--cu', w + 'px');
        root.style.setProperty('--cu-u', w + 'px');
        s.cu = w;
      };
      const up = () => {
        sp.classList.remove('drag');
        sp.removeEventListener('pointermove', move);
        sp.removeEventListener('pointerup', up);
        try { localStorage.setItem('milllab.layout', JSON.stringify(s)); } catch { /* ignore */ }
      };
      sp.addEventListener('pointermove', move);
      sp.addEventListener('pointerup', up);
    });
    sp.addEventListener('dblclick', () => {
      root.style.removeProperty('--cu');
      root.style.removeProperty('--cu-u');
      delete s.cu;
      try { localStorage.setItem('milllab.layout', JSON.stringify(s)); } catch { /* ignore */ }
    });
  }

  bindKeyboard() {
    const keyJog = { ArrowLeft: ['x', -1], ArrowRight: ['x', 1], ArrowUp: ['y', 1], ArrowDown: ['y', -1], PageUp: ['z', 1], PageDown: ['z', -1] };
    window.addEventListener('keydown', (e) => {
      // the NGC-style control takes the keys it uses (input line, cursor, F1-F4 ...) when it is shown
      if (this.app.haas?.handleKey(e)) return;
      // the workshop game owns the keyboard while walking or while one of its overlays is open
      if (this.app.game?.blocksKey(e)) return;
      const tag = e.target.tagName;
      if (/^F[1-5]$/.test(e.key)) {
        e.preventDefault();
        this.hmi.showArea(['machine', 'offset', 'program', 'pm', 'system'][+e.key.slice(1) - 1]);
        return;
      }
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!$('#wizard').hidden || !$('#helpModal').hidden) {
        if (e.key === 'Escape') { $('#wizard').hidden = true; $('#helpModal').hidden = true; }
        return;
      }
      const c = this.c;
      if (e.code === 'Space') {
        e.preventDefault();
        if (c.state === 'running') c.feedHold('Cycle stop');
        else this.app.cycleStart();
      } else if (e.key === 's' || e.key === 'S') {
        c.singleBlock = true;
        this.renderMCP();
        this.app.cycleStart();
      } else if (e.key === 'Escape') {
        if (this.app.measureOn) this.toggle('measure', $('[data-toggle="measure"]'), false);
        else this.resetChannel();
      } else if (keyJog[e.key]) {
        e.preventDefault();
        if (e.repeat) return;
        this.axisPress(...keyJog[e.key], e.shiftKey);
      } else if (/^[1-6]$/.test(e.key)) {
        this.setView(['iso', 'front', 'side', 'top', 'work', 'machine'][+e.key - 1]);
      }
    });
    window.addEventListener('keyup', (e) => {
      if (keyJog[e.key] && !this.inc) this.c.jogStop();
    });
  }

  bindViewport() {
    const cv = $('#view');
    const app = this.app;
    let down = null;
    let hoverT = 0;
    cv.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    cv.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.t < 600;
      down = null;
      if (moved > 6 || !quick || e.button !== 0) return;
      if (app.game?.blocksPointer()) return;
      if (app.measureOn) return app.measureClick(e.clientX, e.clientY);
      const hit = app.viewer.pick(e.clientX, e.clientY, app.machine.clickables);
      if (hit) this.act(hit.object.userData.action);
    });
    cv.addEventListener('pointermove', (e) => {
      const now = performance.now();
      if (now - hoverT < 60) return;
      hoverT = now;
      if (app.measureOn) return app.measureHover(e.clientX, e.clientY);
      if (e.buttons || app.game?.blocksPointer()) return;
      const hit = app.viewer.pick(e.clientX, e.clientY, app.machine.clickables);
      cv.classList.toggle('pick', !!hit);
      cv.title = hit ? { estop: 'Emergency stop', cycleStart: 'Cycle start', feedHold: 'Cycle stop', door: 'Open / close doors' }[hit.object.userData.action] : '';
    });
    cv.addEventListener('pointerleave', () => { $('#probeLabel').hidden = true; });
  }

  // ------------------------------------------------------------------ status display
  setProgramName(n) {
    $('#progName').textContent = n || '—';
    this.hmi.renderHeader();
    const ps = $('#psName');
    if (ps) ps.textContent = n || '—';
  }

  setState(s, reason) {
    const pill = $('#statePill');
    pill.dataset.state = s;
    const kind = this.c.kind;
    $('#stateText').textContent = s === 'running' ? ({ homing: 'REFERENCING', jog: 'JOG', mdi: 'MDA' }[kind] || 'RUNNING') : { idle: 'RESET', hold: 'STOPPED', alarm: 'ALARM', estop: 'E-STOP', complete: 'COMPLETE' }[s] || s.toUpperCase();
    const ab = $('#alarmBanner');
    if (s === 'alarm' || s === 'estop') {
      ab.hidden = false;
      $('#alarmTitle').textContent = s === 'estop' ? 'E-STOP' : 'ALARM';
      $('#alarmText').textContent = s === 'estop' ? 'Emergency stop pressed. All motion and the spindle stopped. Press RESET to release.' : reason;
      this.hmi.addAlarm(s === 'estop' ? '3000 Emergency stop' : reason);
    } else ab.hidden = true;
    const hb = $('#holdBanner');
    hb.hidden = s !== 'hold';
    if (s === 'hold') hb.textContent = `${reason || 'Cycle stop'} · press CYCLE START`;
    $('.key.cstart').classList.toggle('lit', s === 'running');
    $('.key.cstop').classList.toggle('lit', s === 'hold');
    $('.estop').classList.toggle('on', s === 'estop');
    const locked = this.c.exec?.kind === 'program';
    this.editor.setReadOnly(locked);
    this.hmi.renderHeader();
    if (this.hmi.area === 'machine' || (this.hmi.area === 'offset' && this.hmi.pages.offset === 'tools')) this.hmi.rerender();
    this.renderMCP();
  }

  hideAlarm() {
    $('#alarmBanner').hidden = true;
  }

  setExecLine(l) {
    this.editor.setExecLine(l);
    $('#hudLine').textContent = l >= 0 ? `N${l + 1}  ${this.editor.lines[l] || ''}` : '—';
  }

  setFps(fps, calls) {
    $('#fps').textContent = `${fps.toFixed(0)} fps · ${calls} draws`;
  }

  updateSoundBtn() {
    const m = this.app.settings.muted;
    $('#btnSound').innerHTML = `<svg><use href="#i-${m ? 'mute' : 'sound'}"/></svg>`;
  }

  set(id, v) {
    if (this.lastUi[id] === v) return;
    this.lastUi[id] = v;
    const e = document.getElementById(id);
    if (e) e.textContent = v;
  }

  update(force = false) {
    if (force) this.lastUi = {};
    this.app.haas?.tick();
    const app = this.app, c = this.c;
    const w = c.workPos({});
    const inch = c.modal.units === 20;
    const k = inch ? 1 / 25.4 : 1, dp = inch ? 4 : 3;
    this.set('hX', (w.x * k).toFixed(dp));
    this.set('hY', (w.y * k).toFixed(dp));
    this.set('hZ', (w.z * k).toFixed(dp));
    this.set('hS', String(Math.round(Math.abs(c.spindle.rpm))));
    this.set('hF', String(Math.round(c.speed * 60 * k)));
    this.set('hT', `${c.tool} D${c.modal.tloH || 0}`);
    this.hmi.updatePos(force);
    const prog = c.program;
    if (prog) {
      const running = c.exec?.kind === 'program';
      const p = running ? c.progress : c.state === 'complete' ? 1 : 0;
      this.set('pgPct', `${(p * 100).toFixed(0)}%`);
      $('#pgBar').style.width = (p * 100).toFixed(1) + '%';
      this.set('pgElapsed', fmtTime(c.elapsed));
      this.set('pgRemain', running ? `-${fmtTime(prog.totalTime * (1 - p))}` : fmtTime(prog.totalTime));
    }
    const msg = c.message || '';
    if (this.lastUi.msg !== msg) {
      this.lastUi.msg = msg;
      $('#msgLine').textContent = msg;
    }
    const sk = `${c.spindle.dir}|${Math.abs(c.spindle.rpm) < 1}`;
    if (this.lastUi.sp !== sk) {
      this.lastUi.sp = sk;
      this.renderMCP();
    }
    if (app.toolWearDirty && this.hmi.area === 'offset' && this.hmi.pages.offset === 'wear' && (!this._wearT || performance.now() - this._wearT > 1500)) {
      this._wearT = performance.now();
      app.toolWearDirty = false;
      this.hmi.rerender();
    }
    if (this.hmi.area === 'system' && this.hmi.pages.system === 'service' && (!this._svcT || performance.now() - this._svcT > 1000)) {
      this._svcT = performance.now();
      this.hmi.rerender();
    }
    const doorOn = c.door.target > 0.5;
    if (this.lastUi.door !== doorOn) {
      this.lastUi.door = doorOn;
      $('#btnDoor').classList.toggle('on', doorOn);
    }
  }

  // app hooks used by main.js
  renderSetup() {
    if (this.hmi.area === 'offset') this.hmi.rerender();
  }

  renderOffsets() {
    if (this.hmi.area === 'offset' && this.hmi.pages.offset === 'wo') this.hmi.rerender();
  }

  renderTools() {
    if (this.hmi.area === 'offset') this.hmi.rerender();
  }

  updateStockInfo() {
    if (this.hmi.area === 'offset' && this.hmi.pages.offset === 'blank') this.hmi.rerender();
  }

  log(msg, level = 'info') {
    const t = new Date();
    const html = esc(msg).replace(/[Ll]ine (\d+)/g, (m, n) => `<a data-line="${n}">${m}</a>`);
    this.logItems.push({ time: t.toTimeString().slice(0, 8), level, html });
    if (this.logItems.length > 400) this.logItems.splice(0, this.logItems.length - 400);
    if (level !== 'info' || !this.c?.exec) {
      const ml = $('#msgLine');
      if (ml && !this.c?.message) {
        ml.textContent = msg;
        clearTimeout(this._mlT);
        this._mlT = setTimeout(() => { if (!this.c?.message) ml.textContent = ''; }, 6000);
      }
    }
    if (this.hmi.area === 'system' && this.hmi.pages.system === 'msgs') this.hmi.rerender();
  }

  showDiagnostics(res) {
    this.editor.dialect = res.dialect || 'siemens';
    this.editor.setDiagnostics(res.errors, res.warnings);
    $('#psLines').textContent = `${res.lineCount} lines · ${res.ops.length} ops`;
    const pe = $('#psErrors');
    if (res.errors.length) {
      pe.textContent = `${res.errors.length} error${res.errors.length > 1 ? 's' : ''}`;
      pe.className = 'err';
    } else {
      pe.textContent = res.warnings.length ? `OK · ${res.warnings.length} warning${res.warnings.length > 1 ? 's' : ''}` : 'No errors';
      pe.className = 'ok';
    }
    $('#psDialect').textContent = res.dialect === 'iso' ? 'ISO dialect (G291)' : res.dialect === 'haas' ? 'Haas (NGC)' : 'Siemens mode';
    $('#psTime').textContent = `est. ${fmtTime(res.totalTime)}`;
    const items = [...res.errors.map((x) => ({ ...x, lvl: 'err' })), ...res.warnings.map((x) => ({ ...x, lvl: 'warn' }))].slice(0, 30);
    const dl = $('#diagList');
    dl.innerHTML = items.map((x, i) => `<button class="${x.lvl}" data-i="${i}"><b>${x.lvl === 'err' ? 'ALARM' : 'NOTE'} L${x.line + 1}</b>${esc(x.msg)}</button>`).join('');
    $$('button', dl).forEach((b) => b.addEventListener('click', () => this.editor.gotoLine(items[+b.dataset.i].line)));
  }

  // ------------------------------------------------------------------ setup wizard
  openWizard() {
    if (this.c.exec) return this.log('Stop the program before running the setup wizard', 'warn');
    if (this.app.game?.blockStockChange('Setup wizard')) return;
    const app = this.app;
    this.wz = { step: 0, material: app.stock.material, stock: { ...app.stock }, zero: this.zeroPos, wcs: this.zeroIdx, home: !this.c.homed };
    $('#wizard').hidden = false;
    this.wizardStep(0);
  }

  wizardStep(i) {
    const wz = this.wz;
    wz.step = Math.max(0, Math.min(3, i));
    $$('#wzSteps li').forEach((li, k) => { li.className = k === wz.step ? 'on' : k < wz.step ? 'done' : ''; });
    $('#wzStepLbl').textContent = `Step ${wz.step + 1} of 4`;
    $('#wzBack').disabled = wz.step === 0;
    $('#wzNext').textContent = wz.step === 3 ? 'Finish setup' : 'Next';
    const body = $('#wzBody');
    if (wz.step === 0) {
      body.innerHTML = `<p class="wz-note">Choose the workpiece material. It sets the colour, density, cutting force (spindle load), chips, tool wear rate and whether sparks can occur.</p>
        <div class="mat-grid">${Object.entries(MATERIALS).map(([k, m]) => `<button class="mat-card${k === wz.material ? ' on' : ''}" data-m="${k}"><i style="background:linear-gradient(135deg,#${m.cut.toString(16).padStart(6, '0')},#${m.raw.toString(16).padStart(6, '0')})"></i><div><b>${m.short}</b><span>${m.name}<br>${m.density} g/cm³ · kc ${m.kc} N/mm² · Vc ${m.vc[0]}–${m.vc[1]} m/min</span></div></button>`).join('')}</div>`;
      $$('.mat-card', body).forEach((b) => b.addEventListener('click', () => { wz.material = b.dataset.m; this.wizardStep(0); }));
    } else if (wz.step === 1) {
      const s = wz.stock;
      body.innerHTML = `<p class="wz-note">The blank is clamped in a ${VISE.maxOpening} mm vise on parallels. "Above jaws" must be more than your deepest cut, otherwise the tool hits the jaws.</p>
        <div class="form-grid"><label>Length X (mm)<input type="number" id="wzX" value="${s.x}"></label><label>Width Y (mm)<input type="number" id="wzY" value="${s.y}"></label>
        <label>Height Z (mm)<input type="number" id="wzZ" value="${s.z}"></label><label>Above jaws (mm)<input type="number" id="wzP" value="${s.protrusion}"></label></div><div class="wz-note" id="wzStockNote"></div>`;
      const upd = () => {
        Object.assign(s, { x: +$('#wzX').value, y: +$('#wzY').value, z: +$('#wzZ').value, protrusion: +$('#wzP').value });
        const err = validateStock({ ...s, material: wz.material });
        const pl = stockPlacement(s);
        $('#wzStockNote').textContent = err || `Top of the blank ${pl.top.toFixed(1)} mm above the table, ${pl.protrusion.toFixed(1)} mm above the jaws. Mass ${(s.x * s.y * s.z / 1000 * MATERIALS[wz.material].density).toFixed(0)} g.`;
        $('#wzStockNote').style.color = err ? 'var(--err)' : '';
      };
      $$('input', body).forEach((x) => x.addEventListener('input', upd));
      upd();
    } else if (wz.step === 2) {
      const pl = stockPlacement(wz.stock);
      const opts = [['top-center', 'Top centre'], ['top-front-left', 'Top front-left'], ['top-back-left', 'Top back-left'], ['top-front-right', 'Top front-right'], ['top-back-right', 'Top back-right']];
      body.innerHTML = `<p class="wz-note">Pick the part zero on the blank. The simulator touches it off and writes it into the chosen settable work offset, as you would with an edge finder and a tool setter.</p>
        <div class="seg" id="wzZero" style="flex-wrap:wrap">${opts.map(([k, l]) => `<button data-z="${k}" class="${k === wz.zero ? 'on' : ''}">${l}</button>`).join('')}</div>
        <label class="row"><span class="lbl">Offset</span><select id="wzWcs">${[0, 1, 2, 3, 4, 5].map((i) => `<option value="${i}" ${i === wz.wcs ? 'selected' : ''}>G${54 + i}</option>`).join('')}</select></label>
        <div class="wz-summary" id="wzZeroOut"></div>`;
      const upd = () => {
        let x = 0, y = 0;
        if (wz.zero.includes('left')) x = pl.x0;
        if (wz.zero.includes('right')) x = pl.x0 + pl.lx;
        if (wz.zero.includes('front')) y = pl.y0;
        if (wz.zero.includes('back')) y = pl.y0 + pl.ly;
        const tc = MACHINE.tableCenter;
        $('#wzZeroOut').textContent = `G${54 + wz.wcs}  X${r3(x + tc.x)}  Y${r3(y + tc.y)}  Z${r3(pl.top - MACHINE.gaugeAtZ0)}`;
      };
      $$('#wzZero button').forEach((b) => b.addEventListener('click', () => { wz.zero = b.dataset.z; $$('#wzZero button').forEach((x) => x.classList.toggle('on', x === b)); upd(); }));
      $('#wzWcs').addEventListener('change', (e) => { wz.wcs = +e.target.value; upd(); });
      upd();
    } else {
      const t = this.app.tools;
      body.innerHTML = `<p class="wz-note">Tools in the magazine (T = pocket). Lengths are gauge line to tip, as measured on a tool setter; D1 activates them. Edit them under OFFSET › Tool list.</p>
        <div class="wz-summary">${t.map((x) => `T${String(x.number).padEnd(3)}${String(SIE_TYPES.find((s) => s[1] === x.type)?.[0] ?? '').padEnd(5)}Ø${String(x.diameter).padEnd(6)}L${String(x.length).padEnd(7)}${esc(x.name)}`).join('\n')}</div>
        <label class="check"><input type="checkbox" id="wzHome" ${wz.home ? 'checked' : ''}> Reference all axes when finished</label>`;
      $('#wzHome').addEventListener('change', (e) => { wz.home = e.target.checked; });
    }
  }

  wizardNext() {
    const wz = this.wz;
    if (wz.step === 1 && validateStock({ ...wz.stock, material: wz.material })) return;
    if (wz.step < 3) return this.wizardStep(wz.step + 1);
    const app = this.app;
    Object.assign(app.stock, wz.stock, { material: wz.material });
    this.zeroPos = wz.zero;
    this.zeroIdx = wz.wcs;
    app.rebuildStock();
    app.setZeroFromStock(wz.zero, wz.wcs);
    app.save();
    $('#wizard').hidden = true;
    this.log(`Setup: ${MATERIALS[wz.material].short} blank ${wz.stock.x} × ${wz.stock.y} × ${wz.stock.z} mm, zero ${wz.zero.replace(/-/g, ' ')} in G${54 + wz.wcs}`);
    this.hmi.rerender();
    if (wz.home) this.c.home();
  }
}

export function validateStock(s) {
  if (!(s.x >= 10 && s.x <= 300)) return 'Blank length X must be 10–300 mm';
  if (!(s.y >= 10 && s.y <= VISE.maxOpening)) return `Blank width Y must be 10–${VISE.maxOpening} mm (vise opening)`;
  if (!(s.z >= 6 && s.z <= 120)) return 'Blank height Z must be 6–120 mm';
  if (!(s.protrusion >= 2 && s.protrusion <= 80)) return 'Height above the jaws must be 2–80 mm';
  if (s.protrusion > s.z - 3) return 'At least 3 mm of the blank must be held in the jaws';
  if (!MATERIALS[s.material]) return 'Unknown material';
  return null;
}

function validateTool(t) {
  const h = holderFor(t);
  if (!(t.diameter >= 0.5 && t.diameter <= 80)) return 'diameter must be 0.5–80 mm';
  if (!(t.fluteLength >= 0.5)) return 'flute length must be at least 0.5 mm';
  if (!(t.flutes >= 1 && t.flutes <= 12)) return 'teeth must be 1–12';
  if (!(t.length >= h.length + t.fluteLength + 2)) return `length must be at least ${h.length + t.fluteLength + 2} mm (holder ${h.length} mm + flutes + 2 mm)`;
  if (t.length > 250) return 'length must be 250 mm or less';
  if (t.type === 'face' && t.diameter < 25) return 'face mills here are 25 mm or larger';
  if ((t.type === 'bull' || t.type === 'face') && !(t.cornerRadius >= 0 && t.cornerRadius <= t.diameter / 2)) return 'corner radius must be between 0 and the tool radius';
  if (['drill', 'spot', 'chamfer'].includes(t.type) && !(t.tipAngle >= 30 && t.tipAngle <= 150)) return 'point angle must be 30–150°';
  return null;
}

export function toolName(t) {
  const L = TOOL_TYPES[t.type].label;
  if (t.type === 'drill' || t.type === 'spot' || t.type === 'chamfer') return `${L} Ø${t.diameter} × ${t.tipAngle}°`;
  if (t.type === 'bull') return `${L} Ø${t.diameter} R${t.cornerRadius}, ${t.flutes} flute`;
  if (t.type === 'face') return `${L} Ø${t.diameter}, ${t.flutes} inserts`;
  return `${L} Ø${t.diameter}, ${t.flutes} flute`;
}
