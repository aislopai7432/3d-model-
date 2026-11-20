// MillLab: application bootstrap. Wires the interpreter, controller, Z-map, 3D scene, effects, sound
// and UI together and runs the frame loop.
import * as THREE from 'three';
import { MACHINE, MATERIALS, DEFAULT_TOOLS, DEFAULT_STOCK, DEFAULT_SETTINGS, ACCURACY } from './config.js';
import { compileProgram, detectDialect } from './gcode/compile.js';
import { siemensDefault } from './gcode/siemens.js';
import { getExample808 } from './gcode/examples808.js';
import { ProgramStore } from './ui/programs.js';
import { ZMap } from './sim/zmap.js';
import { makeCutter, surfaceSpeed } from './sim/tooling.js';
import { Controller, fmtTime } from './sim/controller.js';
import { createTextures } from './scene/textures.js';
import { Viewer } from './scene/viewer.js';
import { MachineModel } from './scene/machine.js';
import { buildToolModel } from './scene/toolmodels.js';
import { StockMesh } from './scene/stockmesh.js';
import { buildVise, buildWcsMarker, stockPlacement } from './scene/workholding.js';
import { Toolpath } from './scene/toolpath.js';
import { Effects, makeSurfaceFn } from './scene/effects.js';
import { Sound } from './audio/sound.js';
import { UI } from './ui/ui.js';
import { buildWorkshop } from './scene/workshop.js';
import { Game } from './game/game.js';
import { applyZMapState, zmapFromState } from './game/partstore.js';
import { HaasControl, haasDialect } from './ui/haas/haas.js';
import { makeProgramLookup } from './gcode/haas.js';
import { getExampleHaas } from './gcode/examples-haas.js';

const STORE = 'milllab.v1';
const $ = (s) => document.querySelector(s);

function loadStore() {
  try {
    return JSON.parse(localStorage.getItem(STORE) || 'null') || {};
  } catch {
    return {};
  }
}

const TC = MACHINE.tableCenter;
const GZ = MACHINE.gaugeAtZ0;
const TABLE = MACHINE.table;

class App {
  constructor() {
    const s = loadStore();
    this.settings = { ...DEFAULT_SETTINGS, control: 'haas', ...(s.settings || {}) }; // control: 'haas' (NGC-style) | '808d'
    this.settings.wal = { ...DEFAULT_SETTINGS.wal, ...(this.settings.wal || {}) };
    this.tools = (s.tools && s.tools.length ? s.tools : DEFAULT_TOOLS).map((t) => ({ dLength: 0, dRadius: 0, ...t }));
    this.programs = new ProgramStore();
    this.R = new Float64Array(300);
    try {
      const r = JSON.parse(localStorage.getItem('milllab.r') || 'null');
      if (Array.isArray(r)) r.forEach((v, i) => { if (i < 300 && isFinite(v)) this.R[i] = v; });
    } catch { /* ignore */ }
    this.macroVars = {};
    try { Object.assign(this.macroVars, JSON.parse(localStorage.getItem('milllab.vars') || '{}')); } catch { /* ignore */ }
    this.stock = { ...DEFAULT_STOCK, ...(s.stock || {}) };
    this.offsets = s.offsets && s.offsets.length === 6 ? s.offsets.map((o) => ({ ...o })) : null;
    this.programText = s.program ?? null;
    this.programName = s.programName || '';
    this.compiled = null;
    this.stats = { mrr: 0, load: 0, temp: 22, removedWindow: 0, timeWindow: 0, cutting: false, overloadWarned: 0 };
    this.measurePts = [];
    this.measureOn = false;
    this.lastCollisionLog = 0;
    this.stockEmpty = false; // workshop game: the vise can be empty (no blank loaded)
    this.stockSerial = 0; // bumped by every rebuildStock()
  }

  async init() {
    this.ui = new UI(this);
    this.ui.loading('Generating textures…');
    await nextFrame();
    const T = createTextures();
    this.viewer = new Viewer($('#view'), $('#viewport'));
    this.ui.loading('Building machine…');
    await nextFrame();
    this.machine = new MachineModel(T);
    this.viewer.scene.add(this.machine.root);
    this.machine.setTools(this.tools, buildToolModel);
    this.toolpath = new Toolpath();
    this.machine.workGroup.add(this.toolpath.group);
    this.wcsMarker = buildWcsMarker();
    this.machine.workGroup.add(this.wcsMarker);
    this.effects = new Effects(this.viewer.scene, this.machine.workGroup);
    this.effects.attachBlur(this.machine.head);
    // chips land on the stock only while there is one in the vise
    const app = this;
    const surf = makeSurfaceFn({ get zmap() { return app.stockEmpty ? null : app.zmap; }, get placement() { return app.placement; } });
    this.surfaceAt = surf;
    this.sound = new Sound();
    this.sound.volume = this.settings.volume;
    this.sound.muted = this.settings.muted;
    this.measureGroup = new THREE.Group();
    this.machine.workGroup.add(this.measureGroup);

    const c = (this.controller = new Controller());
    this.applyControllerSettings();
    // Siemens-mode reset state of the channel
    c.modal = Object.freeze({ ...siemensDefault(), tloLen: 0, tlo: 49, tloH: 0, codes: 'G0 G17 G90 G71 G500 G40 G64 G94 D0' });
    c.onMotion = (a, b, op) => this.onMotion(a, b, op);
    this.bindController();
    this.refreshCutters();

    this.ui.loading('Preparing stock…');
    await nextFrame();
    if (!this.offsets) {
      this.offsets = Array.from({ length: 6 }, () => ({ x: 0, y: 0, z: 0 }));
      this.rebuildStock();
      this.setZeroFromStock('top-center', 0, true);
    } else this.rebuildStock();
    c.offsets = this.offsets;

    const cur = this.programs.current && this.programs.has(this.programs.current) ? this.programs.current : null;
    if (cur) this.openProgram(cur);
    else if (this.settings.control !== '808d') this.loadExampleHaas('haas-part');
    else this.loadExample808('sie-full', true);
    this.ui.init();
    // NGC-style control (pendant keyboard + screen); the 808D-style control stays available
    this.haas = new HaasControl(this);
    this.haas.init();
    this.applyVisualSettings();
    this.ui.loading('Building the workshop…');
    await nextFrame();
    // the machine shop around the VMC: always the 3D background (simulator and workshop modes)
    this.workshop = buildWorkshop({ camera: this.viewer.camera });
    this.viewer.scene.add(this.workshop.group);
    const floor = this.machine.root.getObjectByName('floor');
    if (floor) floor.visible = false;
    this.viewer.scene.fog = new THREE.Fog(0x9aa0a6, 16000, 34000);
    this.game = new Game(this);
    window.__game = this.game;
    // machined parts (vise / hands / inspection plate) come back from IndexedDB before the first frame
    this.ui.loading('Restoring the workshop…');
    await this.game.restoreParts();
    this.ui.loading(null);
    this.last = performance.now();
    this.uiTimer = 0;
    this.screenTimer = 1; // draw the pendant screen on the very first frame
    try { this.drawPendantScreen(); } catch (e) { /* fonts/ui not ready: the first frame redraws */ }
    this.fpsAcc = { n: 0, t: 0 };
    const loop = (now) => {
      if (!window.__pauseRender) this.frame(now);
      else this.last = now;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    this.ui.log('Control ready. REF POINT or AUTO references the machine; select AUTO and press CYCLE START to run the selected program.');
    window.__app = this;
  }

  // ------------------------------------------------------------------ persistence
  save() {
    clearTimeout(this.saveT);
    this.saveT = setTimeout(() => {
      try {
        localStorage.setItem(STORE, JSON.stringify({
          settings: this.settings, tools: this.tools, stock: this.stock, offsets: this.offsets,
        }));
      } catch {
        /* storage unavailable (private mode): the simulator still works, it just won't remember */
      }
    }, 400);
  }

  // ------------------------------------------------------------------ tools
  toolMap() {
    return new Map(this.tools.map((t) => [t.number, t]));
  }

  refreshCutters() {
    this.cutters = new Map(this.tools.map((t) => [t.number, makeCutter(t)]));
  }

  toolsChanged(rebuildModels = true) {
    this.tools.sort((a, b) => a.number - b.number);
    this.refreshCutters();
    if (rebuildModels) this.machine.setTools(this.tools, buildToolModel);
    const cur = this.tools.find((t) => t.number === this.controller.tool);
    this.effects.setTool(cur || null);
    this.compile();
    this.save();
  }

  // ------------------------------------------------------------------ stock / setup
  rebuildStock() {
    const pl = (this.placement = stockPlacement(this.stock));
    const acc = ACCURACY[this.settings.accuracy] || ACCURACY.balanced;
    if (this.stockMesh) {
      this.machine.workGroup.remove(this.stockMesh.group);
      this.stockMesh.dispose();
    }
    this.stockSerial++;
    this.zmap = new ZMap({ x0: pl.x0, y0: pl.y0, lx: pl.lx, ly: pl.ly, top: pl.top, bottom: pl.bottom, cell: acc.cell, maxNodes: acc.maxNodes });
    const spec = MATERIALS[this.stock.material] || MATERIALS.aluminium;
    this.stockMesh = new StockMesh(this.zmap, spec);
    this.stockMesh.group.visible = !this.stockEmpty;
    this.machine.workGroup.add(this.stockMesh.group);
    if (this.vise) this.machine.workGroup.remove(this.vise.group);
    this.vise = buildVise(pl);
    this.machine.workGroup.add(this.vise.group);
    this.effects.setMaterial(spec);
    this.effects.clear();
    this.clearMeasure();
    this.stats.removedTotal = 0;
    this.ui?.updateStockInfo();
  }

  // Workshop game: put saved Z-map heights (a machined part) back into the stock in the vise.
  restoreStockZMap(state) {
    if (!state) return false;
    if (!applyZMapState(this.zmap, state)) {
      // different grid (accuracy changed): adopt the saved Z-map as it is
      const z = zmapFromState(Object.getPrototypeOf(this.zmap), state);
      if (!z) return false;
      this.machine.workGroup.remove(this.stockMesh.group);
      this.stockMesh.dispose();
      this.zmap = z;
      this.stockMesh = new StockMesh(z, MATERIALS[this.stock.material] || MATERIALS.aluminium);
      this.stockMesh.group.visible = !this.stockEmpty;
      this.machine.workGroup.add(this.stockMesh.group);
    }
    this.stockMesh.update(true);
    this.effects.clear();
    this.ui?.updateStockInfo();
    return true;
  }

  // Workshop game: an empty vise has no stock to cut (removal and stock collisions are skipped).
  setStockEmpty(empty) {
    this.stockEmpty = !!empty;
    if (this.stockMesh) this.stockMesh.group.visible = !this.stockEmpty;
    this.clearMeasure();
  }

  setZeroFromStock(where, wcsIndex, silent = false) {
    const pl = this.placement;
    let x = 0, y = 0;
    if (where.includes('left')) x = pl.x0;
    if (where.includes('right')) x = pl.x0 + pl.lx;
    if (where.includes('front')) y = pl.y0;
    if (where.includes('back')) y = pl.y0 + pl.ly;
    const o = this.offsets[wcsIndex];
    o.x = round3(x + TC.x);
    o.y = round3(y + TC.y);
    o.z = round3(pl.top - GZ);
    if (!silent) this.ui.log(`G${54 + wcsIndex} set to the ${where.replace(/-/g, ' ')} of the stock: X${o.x} Y${o.y} Z${o.z}`);
    this.offsetsChanged();
  }

  offsetsChanged() {
    this.controller.offsets = this.offsets;
    this.compile();
    this.ui?.renderOffsets();
    this.save();
  }

  // ------------------------------------------------------------------ program
  dialect() {
    const t = this.ui.editor.getValue();
    return detectDialect(t, this.defaultDialect(t));
  }

  compileOpts() {
    const acc = ACCURACY[this.settings.accuracy] || ACCURACY.balanced;
    const w = this.settings.wal;
    return {
      tools: this.toolMap(), offsets: this.offsets, requireG43: this.settings.requireG43, arcTol: acc.arcTol, blockDelete: this.settings.blockDelete,
      dialect: this.settings.dialect, limits: w.on ? { x: w.x, y: w.y, z: w.z } : null,
      programLookup: this._lookup || (this._lookup = makeProgramLookup(this.programs)), macroVars: this.macroVars,
    };
  }

  // Default dialect of a program without a G290/G291 or %/O header: the NGC-style control reads Haas
  // G-code; older Siemens-mode programs (cycles, ";" comments, R parameters) still compile as before.
  defaultDialect(text) {
    if (!this.haas?.active) return this.settings.dialect;
    const sie = /^\s*;|\b(CYCLE\d+|POCKET[34]|MCALL|SLOT[12]|LONGHOLE|HOLES[12]|MSG\s*\(|G500|GOTO[FB]|SUPA|TRANS|AROT)\b|\bR\d+\s*=|\bD\d+\b/m;
    return sie.test(text.slice(0, 20000)) ? 'siemens' : haasDialect();
  }

  saveVars() {
    try { localStorage.setItem('milllab.vars', JSON.stringify(this.macroVars)); } catch { /* ignore */ }
  }

  // G10 L10-L13 / #2001.. writes from a Haas program: geometry and wear land in the offsets, the
  // physical cutter stays as it is (dLength / dRadius carry the difference).
  applyToolWrites(list) {
    if (!list?.length) return;
    for (const w of list) {
      const t = this.tools.find((x) => x.number === w.tool);
      if (!t) continue;
      t.dLength = Math.round((w.length + w.dLength - t.length - (t.hWear || 0) + (t.hWear || 0)) * 1e4) / 1e4;
      t.dRadius = Math.round((w.diameter / 2 + w.dRadius - t.diameter / 2) * 1e4) / 1e4;
    }
    this.toolsChanged(false);
    this.ui.log(`Tool offsets written by the program: ${[...new Set(list.map((w) => 'T' + w.tool))].join(' ')}`);
  }

  compile() {
    const c = this.controller;
    const text = this.ui.editor.getValue();
    const t0 = performance.now();
    const opts = this.compileOpts();
    opts.dialect = this.defaultDialect(text);
    const res = compileProgram(text, opts, { pos: { ...c.pos }, tool: c.tool, carousel: c.carousel, rpm: Math.abs(c.spindle.rpm), units: this.settings.defaultUnits, R: this.R });
    res.compileMs = performance.now() - t0;
    this.compiled = res;
    if (!c.exec || c.exec.kind !== 'program') {
      c.program = res;
      this.toolpath.build(res.ops);
      this.toolpath.setProgress(-1);
    }
    this.ui.showDiagnostics(res);
    this.programDirty = false;
    return res;
  }

  // MDA blocks continue from the current modal state of the channel.
  compileMDA(text) {
    const c = this.controller;
    const modal = { ...c.modal };
    delete modal.tloLen;
    delete modal.codes;
    if (modal.mcall) delete modal.mcall;
    const opts = this.compileOpts();
    opts.forceDialect = this.haas?.active ? detectDialect(text, haasDialect()) : modal.dialect === 'iso' ? 'iso' : modal.dialect === 'haas' || this.settings.dialect === 'haas' ? 'haas' : detectDialect(text, 'siemens');
    return compileProgram(text, opts, { pos: { ...c.pos }, tool: c.tool, carousel: c.carousel, rpm: Math.abs(c.spindle.rpm), modal, R: this.R });
  }

  scheduleCompile() {
    this.programDirty = true;
    clearTimeout(this.compileT);
    this.compileT = setTimeout(() => this.compile(), 300);
    if (this.programName) this.programs.put(this.programName, this.ui.editor.getValue());
  }

  // CYCLE START depends on the operating mode, like on the real control.
  cycleStart() {
    const c = this.controller;
    if (c.state === 'hold') return c.cycleStart();
    if (c.estop || c.state === 'alarm') return c.cycleStart();
    if (c.exec) return;
    if (c.mode === 'AUTO') {
      if (this.settings.freshBlank && !this.stockEmpty && this.zmap.removedTotal > 0) {
        if (this.game?.manualBlanks) {
          // workshop: the blank in the vise is a real one; running again keeps cutting the same material
          this.ui.log('Workshop: running again on the same blank ("Fresh blank at each AUTO start" only applies in the simulator)');
        } else {
          this.rebuildStock();
          this.ui.log('Fresh blank loaded for the new cycle (Settings: "Fresh blank at each AUTO start")');
        }
      }
      this.toolpath.setProgress(-1);
      c.cycleStart();
      if (this.compiled?.errors.length) this.ui.hmi.addAlarm(this.compiled.errors[0].msg);
    } else if (c.mode === 'MDA') {
      const text = this.ui.mdaText.trim();
      if (!text) return this.ui.log('MDA buffer is empty', 'warn');
      c.startWithDoor(() => this.ui.runMDI(text));
    } else {
      this.ui.log(`CYCLE START has no function in ${c.mode === 'REF' ? 'REF POINT' : 'JOG'} mode. Select AUTO or MDA.`, 'warn');
    }
  }

  openProgram(name) {
    const text = this.programs.get(name);
    if (text == null) return;
    if (this.controller.exec) this.controller.stop();
    this.programName = name;
    this.programs.setCurrent(name);
    this.ui.editor.setValue(text);
    const ex = this.programs.info(name)?.example;
    if (ex && !this._exampleBlankLoaded && !this.game?.manualBlanks) {
      const e = getExample808(ex);
      if (e) {
        this.stock = { ...this.stock, ...e.stock };
        this.rebuildStock();
        this.setZeroFromStock('top-center', 0, true);
      }
    }
    this._exampleBlankLoaded = false;
    this.compile();
    this.ui.setProgramName(name);
    this.save();
  }

  loadExample808(id, initial = false) {
    const ex = getExample808(id);
    if (!ex) return;
    if (this.controller.exec) this.controller.stop();
    // workshop: example programs open as programs only; the blank in the vise stays as it is
    const keepBlank = !!this.game?.manualBlanks;
    if (!keepBlank) {
      this.stock = { ...this.stock, ...ex.stock };
      this.rebuildStock();
      this.setZeroFromStock('top-center', 0, true);
    }
    const name = ex.file;
    if (!this.programs.has(name) || this.programs.info(name)?.example === id) this.programs.put(name, ex.code, { example: id });
    this._exampleBlankLoaded = true;
    this.openProgram(name);
    this.ui.renderSetup();
    if (keepBlank) {
      const st = ex.stock;
      this.ui.log(`${ex.file}: ${ex.name}. Opened as a program only. ${this.game.blankMessage()} (This example expects a ${st.x} × ${st.y} × ${st.z} mm ${MATERIALS[st.material].short.toLowerCase()} blank with G54 at its top centre.)`, 'warn');
      this.game.ui.toast(`${ex.file} opened as a program only: the blank in the vise was not changed.`, 'warn', 5000);
    } else if (!initial) this.ui.log(`${ex.file}: ${ex.name}. Blank ${ex.stock.x} × ${ex.stock.y} × ${ex.stock.z} mm ${MATERIALS[ex.stock.material].short}, G54 at the top centre.`);
  }

  // A Haas example from the control's USB stick: into memory as Onnnnn.MPF, with its blank and G54
  // (top centre) unless the workshop's real blank is in the vise.
  loadExampleHaas(id) {
    const ex = getExampleHaas(id);
    if (!ex) return;
    if (this.controller.exec) this.controller.stop();
    if (!this.game?.manualBlanks && ex.stock) {
      this.stock = { ...this.stock, protrusion: 14, ...ex.stock };
      this.rebuildStock();
      this.setZeroFromStock('top-center', 0, true);
    }
    const name = ex.file.replace(/\.NC$/i, '.MPF');
    this.programs.put(name, ex.code);
    this.openProgram(name);
  }

  applyControllerSettings() {
    const c = this.controller;
    const s = this.settings;
    c.doorInterlock = s.doorInterlock;
    c.optionalStop = s.optionalStop;
    c.dryFeed = s.dryFeed;
    c.limits = s.wal.on ? { x: s.wal.x, y: s.wal.y, z: s.wal.z } : null;
  }

  saveR() {
    try {
      localStorage.setItem('milllab.r', JSON.stringify(Array.from(this.R)));
    } catch { /* ignore */ }
  }

  // ------------------------------------------------------------------ controller events
  bindController() {
    const c = this.controller;
    c.on('state', (s, reason) => {
      this.ui.setState(s, reason);
      if (s === 'complete') this.sound.tone(660, 0.01, 0.25, 0.12);
    });
    c.on('line', (l) => this.ui.setExecLine(l));
    c.on('message', (m, lvl) => this.ui.log(m, lvl));
    c.on('beforeStart', () => {
      this.compile();
      if (this.compiled.errors.length) {
        const e = this.compiled.errors[0];
        this.ui.log(`Cannot start: line ${e.line + 1}: ${e.msg}`, 'error');
      }
      this.toolpath.setProgress(-1);
    });
    c.on('cycle', (k) => {
      if (k === 'start') {
        this.stats.overloadWarned = 0;
        this.ui.log(`Cycle start: ${this.programName || 'program'} (est. ${fmtTime(this.compiled.totalTime)})`);
      }
    });
    c.on('alarm', (msg) => {
      this.sound.crash();
      this.sound.alarm();
      const tip = this.toolTipWorld(new THREE.Vector3());
      this.effects.spawnSparks(90, tip, 1.3);
    });
    c.on('estop', () => this.sound.estop());
    c.on('toolchange', (kind, a, b) => {
      if (kind === 'phase') {
        const n = a.name;
        if (n.startsWith('carousel')) this.sound.slide();
        else if (n.startsWith('index')) this.sound.index();
      } else if (kind === 'sound') {
        if (a === 'air') this.sound.air();
        if (a === 'clamp') this.sound.clunk();
      } else if (kind === 'end') {
        const t = this.tools.find((x) => x.number === a);
        this.effects.setTool(t || null);
      }
    });
    c.on('toolInSpindle', (n) => {
      const t = this.tools.find((x) => x.number === n);
      this.effects.setTool(t || null);
    });
    c.on('offset', (i, v) => {
      Object.assign(this.offsets[i], v);
      this.ui.renderOffsets();
      this.ui.log(`G10: G${54 + i} = X${round3(v.x)} Y${round3(v.y)} Z${round3(v.z)}`);
      this.save();
    });
    c.on('homed', () => {
      this.ui.update(true);
      this.ui.hmi.rerender();
    });
    c.on('door', () => this.sound.door());
    c.on('reset', () => this.ui.hideAlarm());
    c.on('programEnd', () => {
      this.toolpath.setProgress(1e9);
      if (this.compiled?.endR) {
        this.R.set(this.compiled.endR);
        this.saveR();
      }
      if (this.compiled?.endVars) { Object.assign(this.macroVars, this.compiled.endVars); this.saveVars(); }
      this.applyToolWrites(this.compiled?.toolOffsetWrites);
      this.wearCheck();
    });
    c.on('mdiDone', () => {
      if (this.mdaResult?.endR) {
        this.R.set(this.mdaResult.endR);
        this.saveR();
      }
      if (this.mdaResult?.endVars) { Object.assign(this.macroVars, this.mdaResult.endVars); this.saveVars(); }
      this.applyToolWrites(this.mdaResult?.toolOffsetWrites);
      this.ui.hmi.rerender();
    });
    c.on('mode', () => {
      this.ui.renderMCP();
      this.ui.hmi.renderHeader();
    });
    c.on('msg', (t) => { if (t) this.ui.log(`MSG: ${t}`); });
  }

  // ------------------------------------------------------------------ material removal and collisions
  toolTipWorld(out) {
    const t = this.cutters.get(this.controller.tool);
    out.set(0, MACHINE.tableTopY + GZ + this.controller.pos.z - (t ? t.length : 0), 0);
    return out;
  }

  onMotion(a, b, op) {
    const c = this.controller;
    const cut = c.tool ? this.cutters.get(c.tool) : null;
    const L = cut ? cut.length : 0;
    const ax = a.x - TC.x, ay = a.y - TC.y, az = GZ + a.z - L;
    const bx = b.x - TC.x, by = b.y - TC.y, bz = GZ + b.z - L;
    const where = () => (op && op.line >= 0 ? ` (line ${op.line + 1})` : '');

    // 1. tool tip (or empty spindle nose) into the table
    if (Math.min(az, bz) < -0.01 && Math.abs(bx) <= TABLE.length / 2 && Math.abs(by) <= TABLE.width / 2) {
      return `Crash: the ${cut ? 'tool' : 'spindle'} hit the machine table at X${round3(b.x)} Y${round3(b.y)}${where()}`;
    }
    // 2. vise / fixture collisions (tool body, holder and spindle nose against the vise boxes)
    const len = Math.hypot(bx - ax, by - ay, bz - az);
    const n = Math.min(40, Math.max(1, Math.ceil(len / 5)));
    for (let k = 1; k <= n; k++) {
      const f = k / n;
      const px = ax + (bx - ax) * f, py = ay + (by - ay) * f, pz = az + (bz - az) * f;
      const hit = this.fixtureHit(px, py, pz, cut);
      if (hit) return `Collision: the ${hit} hit the ${this.lastFixture}${where()}`;
    }
    // 3. material removal (nothing to cut with an empty vise)
    if (this.stockEmpty) return null;
    const zm = this.zmap;
    if (cut) {
      const r = cut.r;
      const minX = Math.min(ax, bx) - r, maxX = Math.max(ax, bx) + r, minY = Math.min(ay, by) - r, maxY = Math.max(ay, by) + r;
      if (Math.min(az, bz) < zm.top && maxX >= zm.x0 && minX <= zm.x0 + zm.lx && maxY >= zm.y0 && minY <= zm.y0 + zm.ly) {
        zm.shankExcess = 0;
        const v = zm.sweep(ax, ay, az, bx, by, bz, cut);
        if (v > 0) {
          if (v > 0.05 && op && op.rapid) {
            const iso = this.compiled?.dialect === 'iso';
            const hint = iso ? (this.settings.requireG43 && c.modal.tlo !== 43 ? '. Hint: no G43 tool length offset is active, so Z refers to the spindle gauge line. Add G43 H_ after the tool change' : '')
              : (!c.modal.tloH ? '. Hint: no tool offset is active (D0), so Z refers to the spindle gauge line. Program D1 (or T.. D1 M6)' : '');
            return `Crash: rapid traverse (G0) into the workpiece${where()}. Rapids must stay clear of material${hint}.`;
          }
          if (v > 0.05 && Math.abs(c.spindle.rpm) < 30) {
            return `Crash: the tool was fed into the workpiece with the spindle stopped${where()}. Start it with S_ M03 first.`;
          }
          if (zm.shankExcess > 0.3) {
            return `Collision: cutting ${round3(zm.shankExcess + cut.flute)} mm deep but T${cut.number} only has ${cut.flute} mm of flute; the shank/body rubbed the part${where()}.`;
          }
          this.stats.removedFrame += v;
          this.stats.cutFrame = true;
        }
        // holder or collet nut against the part
        const holderZ = bz + cut.stickout;
        if (holderZ < zm.top + 0.01) {
          const m = zm.maxInDisc(bx, by, cut.holderR);
          if (m > holderZ + 0.2) return `Collision: the tool holder hit the workpiece. T${cut.number} sticks out ${round3(cut.stickout)} mm but the cut needs more${where()}.`;
        }
      }
    } else {
      // empty spindle: the nose itself
      if (bz < zm.top + 0.01) {
        const m = zm.maxInDisc(bx, by, 80);
        if (m > bz) return `Crash: the spindle nose hit the workpiece (no tool in the spindle)${where()}`;
      }
    }
    return null;
  }

  // Tool body / holder / spindle nose against the vise (table frame AABBs).
  fixtureHit(x, y, tip, cut) {
    const parts = cut
      ? [['cutter', cut.r, tip, tip + cut.flute], ['tool shank', cut.bodyR, tip + cut.flute, tip + cut.stickout], ['tool holder', cut.holderR, tip + cut.stickout, tip + cut.length], ['spindle nose', 86, tip + cut.length, tip + cut.length + 200]]
      : [['spindle nose', 86, tip, tip + 200]];
    for (const b of this.vise.boxes) {
      const dx = Math.max(b.min[0] - x, 0, x - b.max[0]);
      const dy = Math.max(b.min[1] - y, 0, y - b.max[1]);
      const d2 = dx * dx + dy * dy;
      for (const [name, r, z0, z1] of parts) {
        if (d2 < r * r && z0 < b.max[2] - 0.01 && z1 > b.min[2]) {
          this.lastFixture = b.name;
          return name;
        }
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ cutting physics (load, temperature, wear)
  updatePhysics(dtReal) {
    const c = this.controller;
    const st = this.stats;
    const simT = c.frameTime || 0;
    st.removedWindow = st.removedWindow * 0.85 + st.removedFrame;
    st.timeWindow = st.timeWindow * 0.85 + simT;
    st.mrr = st.timeWindow > 1e-6 ? st.removedWindow / st.timeWindow : 0; // mm^3/s
    const spec = MATERIALS[this.stock.material];
    const kw = (st.mrr * spec.kc) / 1e6;
    const rpm = Math.abs(c.spindle.rpm);
    const idle = (rpm / MACHINE.maxRpm) * 6;
    st.load = Math.min(250, idle + (kw / MACHINE.spindlePowerKw) * 100);
    st.cutting = st.cutFrame;
    if (st.load > 120 && performance.now() - st.overloadWarned > 8000 && st.cutFrame) {
      st.overloadWarned = performance.now();
      this.ui.log(`Spindle load ${st.load.toFixed(0)}%: the cut is too heavy for ${spec.short.toLowerCase()} at this feed and depth`, 'warn');
    }
    // spindle temperature: first-order response to speed and load, coolant pulls it down
    const tTarget = 22 + 17 * (rpm / MACHINE.maxRpm) + 0.16 * Math.min(st.load, 150) - (c.coolant.flood ? 4 : 0);
    const simDt = c.simSpeed === 'max' ? Math.max(simT, dtReal) : dtReal * c.simSpeed;
    st.temp += (tTarget - st.temp) * (1 - Math.exp(-simDt / 80));
    // tool wear: removed volume weighted by material abrasiveness, tool size and dry cutting
    if (st.removedFrame > 0 && c.tool) {
      const tool = this.tools.find((t) => t.number === c.tool);
      if (tool) {
        const life = 2.5e5 * Math.max(2, tool.diameter);
        const dry = c.coolant.flood ? 1 : c.coolant.mist ? 1.25 : 1.6;
        const vcMax = spec.vc[1];
        const vc = surfaceSpeed(tool.diameter, rpm);
        const speedF = vc > vcMax ? 1 + (vc - vcMax) / vcMax * 3 : 1;
        tool.wear = (tool.wear || 0) + (st.removedFrame * spec.wear * dry * speedF) / life * 100;
        if (tool.wear >= 100 && !tool._warned) {
          tool._warned = true;
          this.ui.log(`T${tool.number} is worn out (${tool.wear.toFixed(0)}%). Replace it in the Tools tab.`, 'warn');
        }
        this.toolWearDirty = true;
      }
    }
    // sparks only for dry, fast ferrous cutting
    if (st.cutFrame && spec.ferrous && !c.coolant.flood && !c.coolant.mist) {
      const tool = this.tools.find((t) => t.number === c.tool);
      if (tool && surfaceSpeed(tool.diameter, rpm) > 160 && Math.random() < 0.35) {
        this.effects.spawnSparks(1 + (Math.random() * 3) | 0, this.toolTipWorld(new THREE.Vector3()), 0.5);
      }
    }
    // chips: proportional to removal, capped per frame
    if (st.removedFrame > 0 && c.tool) {
      const tool = this.cutters.get(c.tool);
      const per = 3.5 * (spec.chipSize || 1);
      let n = st.removedFrame / per;
      n = Math.min(c.simSpeed === 'max' || c.simSpeed > 10 ? 4 : 14, Math.floor(n) + (Math.random() < n % 1 ? 1 : 0));
      if (n > 0) {
        const tip = this.toolTipWorld(new THREE.Vector3());
        tip.y += Math.min(tool.flute, 3);
        const hot = spec.ferrous && !c.coolant.flood && surfaceSpeed(tool.r * 2, rpm) > 140;
        this.effects.spawnChips(n, tip, tool.r, Math.sign(c.spindle.rpm) || 1, hot);
      }
    }
  }

  wearCheck() {
    this.ui.renderTools();
    this.save();
  }

  // ------------------------------------------------------------------ frame
  frame(now) {
    const dt = Math.max(0, Math.min(0.1, (now - this.last) / 1000));
    this.last = now;
    const c = this.controller;
    this.stats.removedFrame = 0;
    this.stats.cutFrame = false;
    c.update(dt);
    this.updatePhysics(dt);
    const m = this.machine;
    m.update({
      x: c.pos.x, y: c.pos.y, z: c.pos.z, lift: c.atc.lift, spindleAngle: visualAngle(c, dt, this), door: c.door.pos,
      atcSlide: c.atc.slide, atcAngle: c.atc.angle, spindleTool: c.tool, state: c.state, estop: c.estop,
      control: this.haas?.active ? 'haas' : '808d', beacon: this.haas?.active ? this.haas.beaconNow || 'off' : null, haasEstop: this.haas?.estopLatched,
    });
    this.stockMesh.update();
    this.stockMesh.setWet(c.coolant.flood ? Math.min(1, (this.wet = Math.min(1, (this.wet || 0) + dt * 0.6))) : (this.wet = Math.max(0, (this.wet || 0) - dt * 0.05)));
    const tip = this.toolTipWorld(new THREE.Vector3());
    const nozzles = [];
    if ((c.coolant.flood || c.coolant.mist) && !c.atc.busy && c.tool) {
      for (let i = 0; i < m.coolantNozzles.length; i++) nozzles.push(m.nozzleWorld(i, new THREE.Vector3()));
    }
    const tool = this.cutters.get(c.tool);
    this.effects.update(dt, {
      surfaceAt: this.surfaceAt, floorY: 560, flood: c.coolant.flood && !c.atc.busy && !!c.tool, mist: c.coolant.mist && !c.atc.busy && !!c.tool,
      nozzles, target: tip.clone().add(new THREE.Vector3(0, tool ? Math.min(tool.flute * 0.6, 12) : 0, 0)), rpm: c.spindle.rpm,
    });
    this.sound.update({
      rpm: c.spindle.rpm, load: this.stats.load / 100, cutting: this.stats.cutFrame, material: this.stock.material,
      flutes: tool ? tool.flutes : 2, speed: c.speed, rapid: c.rapidMove, coolant: (c.coolant.flood || c.coolant.mist) && !c.atc.busy,
    });
    if (c.exec?.kind === 'program') this.toolpath.setProgress(c.exec.i);
    const wo = this.offsets[c.modal.wcs - 54];
    this.wcsMarker.visible = !!wo;
    if (wo) {
      const fr = c.modal.frame || { tx: 0, ty: 0, tz: 0, rot: 0 };
      this.wcsMarker.position.set(wo.x + fr.tx - TC.x, wo.z + fr.tz + GZ, -(wo.y + fr.ty - TC.y));
      this.wcsMarker.rotation.y = (fr.rot * Math.PI) / 180;
    }
    // the workshop game drives the camera itself in first person (and in the measuring station)
    if (!this.game || !this.game.driveCamera(dt)) this.viewer.update(dt);
    if (this.workshop) this.workshop.update(dt, this.viewer.camera);
    this.game?.update(dt);
    this.viewer.render();
    this.updateMeasureLabels();
    this.uiTimer += dt;
    if (this.uiTimer > 0.066) {
      this.uiTimer = 0;
      this.ui.update();
    }
    this.screenTimer += dt;
    if (this.screenTimer > 0.2) {
      this.screenTimer = 0;
      this.drawPendantScreen();
    }
    const f = this.fpsAcc;
    f.n++;
    f.t += dt;
    if (f.t > 1) {
      this.ui.setFps(f.n / f.t, this.viewer.renderer.info.render.calls);
      this.fpsNow = f.n / f.t;
      f.n = 0;
      f.t = 0;
    }
  }

  // ------------------------------------------------------------------ pendant screen texture
  drawPendantScreen() {
    if (this.haas?.active) return this.haas.drawScreen(this.machine.screenCanvas);
    const cv = this.machine.screenCanvas;
    const g = cv.getContext('2d');
    const c = this.controller;
    const W = cv.width, H = cv.height;
    g.fillStyle = '#d3d9df';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#22405b';
    g.fillRect(0, 0, W, 40);
    g.font = '700 22px "IBM Plex Sans Condensed", Arial';
    g.fillStyle = '#e8f0f7';
    g.fillText(this.ui.hmi.area.toUpperCase(), 12, 28);
    g.fillStyle = '#ffffff';
    g.fillRect(150, 9, 92, 24);
    g.fillStyle = '#22405b';
    g.fillText(c.mode === 'REF' ? 'REF' : c.mode, 160, 28);
    const stc = { running: '#9df0c0', hold: '#ffd88a', alarm: '#ff9c9c', estop: '#ff9c9c' }[c.state] || '#c5d6e6';
    g.fillStyle = stc;
    g.textAlign = 'right';
    g.fillText(c.state === 'running' ? 'CHANNEL ACTIVE' : c.state === 'hold' ? 'INTERRUPTED' : c.state === 'estop' ? 'E-STOP' : c.state === 'alarm' ? 'ALARM' : 'CHANNEL RESET', W - 12, 28);
    g.textAlign = 'left';
    g.fillStyle = '#f3f5f7';
    g.fillRect(8, 48, 380, 200);
    g.strokeStyle = '#b3bdc7';
    g.strokeRect(8, 48, 380, 200);
    const w = c.workPos({});
    const rows = [['X', w.x, '#c0332a'], ['Y', w.y, '#1f8a4c'], ['Z', w.z, '#1d63b8']];
    g.font = '600 44px "IBM Plex Mono", monospace';
    rows.forEach(([ax, v, col], i) => {
      g.fillStyle = col;
      g.fillText(ax, 22, 104 + i * 60);
      g.fillStyle = '#18222d';
      g.textAlign = 'right';
      g.fillText(v.toFixed(3), 372, 104 + i * 60);
      g.textAlign = 'left';
    });
    g.fillStyle = '#f3f5f7';
    g.fillRect(396, 48, W - 404, 200);
    g.strokeRect(396, 48, W - 404, 200);
    g.font = '600 21px "IBM Plex Mono", monospace';
    g.fillStyle = '#22405b';
    g.fillText(`T ${c.tool}  D${c.modal.tloH || 0}`, 408, 84);
    g.fillText(`F ${Math.round(c.speed * 60)}`, 408, 120);
    g.fillText(`  ${c.overrides.feed}%`, 408, 146);
    g.fillText(`S ${Math.round(Math.abs(c.spindle.rpm))}`, 408, 184);
    g.fillText(`  ${c.overrides.spindle}%  ${(this.stats.load || 0).toFixed(0)}%L`, 408, 210);
    const lines = this.ui.editor.lines;
    const cur = c.line;
    g.fillStyle = '#ffffff';
    g.fillRect(8, 256, W - 16, H - 300);
    g.font = '500 18px "IBM Plex Mono", monospace';
    const start = Math.max(0, (cur < 0 ? 0 : cur) - 1);
    for (let i = 0; i < 4; i++) {
      const li = start + i;
      if (li >= lines.length) break;
      const y = 280 + i * 24;
      if (li === cur) {
        g.fillStyle = '#ffd27a';
        g.fillRect(8, y - 18, W - 16, 24);
      }
      g.fillStyle = '#18222d';
      g.fillText(lines[li].slice(0, 54), 16, y);
    }
    // softkey strip
    const labels = ['', '', '', '', '', '', '', ''];
    g.font = '600 13px "IBM Plex Sans Condensed", Arial';
    const sw = (W - 16) / 8;
    for (let i = 0; i < 8; i++) {
      g.fillStyle = '#e9edf1';
      g.fillRect(8 + i * sw + 2, H - 38, sw - 4, 30);
      g.fillStyle = '#18222d';
      g.fillText(labels[i], 14 + i * sw, H - 18);
    }
    if ((c.state === 'alarm' && c.alarm) || c.message) {
      g.fillStyle = c.state === 'alarm' ? '#c21d1d' : '#1d6bd0';
      g.font = '600 15px "IBM Plex Sans", Arial';
      g.fillText((c.state === 'alarm' ? c.alarm : c.message).slice(0, 70), 12, H - 46);
    }
    this.machine.screenTex.needsUpdate = true;
  }

  // ------------------------------------------------------------------ measurement
  setMeasure(on) {
    this.measureOn = on;
    $('#view').classList.toggle('measure', on);
    if (!on) this.clearMeasure();
    else this.ui.log('Measure: click two points on the workpiece. Esc to finish.');
  }

  clearMeasure() {
    this.measurePts = [];
    if (this.measureGroup) {
      for (const ch of [...this.measureGroup.children]) {
        this.measureGroup.remove(ch);
        ch.geometry?.dispose();
      }
    }
    $('#measureLabel').hidden = true;
    $('#measureBox').hidden = true;
    $('#probeLabel').hidden = true;
  }

  stockHit(clientX, clientY) {
    const meshes = this.stockMesh.group.children.filter((o) => o.isMesh);
    const hit = this.viewer.pick(clientX, clientY, meshes);
    if (!hit) return null;
    const local = this.machine.workGroup.worldToLocal(hit.point.clone());
    return { local, table: { x: local.x, y: -local.z, z: local.y } };
  }

  toWork(tp) {
    const o = this.offsets[this.controller.modal.wcs - 54] || { x: 0, y: 0, z: 0 };
    return { x: tp.x + TC.x - o.x, y: tp.y + TC.y - o.y, z: tp.z - GZ - o.z };
  }

  measureClick(clientX, clientY) {
    const h = this.stockHit(clientX, clientY);
    if (!h) return;
    if (this.measurePts.length >= 2) this.clearMeasure();
    this.measurePts.push(h);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(1.4, 12, 8), new THREE.MeshBasicMaterial({ color: 0x74aeff, depthTest: false }));
    dot.renderOrder = 20;
    dot.position.copy(h.local);
    this.measureGroup.add(dot);
    if (this.measurePts.length === 2) {
      const [p, q] = this.measurePts;
      const g = new THREE.BufferGeometry().setFromPoints([p.local, q.local]);
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x74aeff, depthTest: false }));
      line.renderOrder = 20;
      this.measureGroup.add(line);
      const a = this.toWork(p.table), b = this.toWork(q.table);
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const box = $('#measureBox');
      box.hidden = false;
      box.textContent = `MEASURE (work ${this.controller.modal.wcs === 500 ? 'G500' : 'G' + this.controller.modal.wcs})\nP1  X${a.x.toFixed(3)} Y${a.y.toFixed(3)} Z${a.z.toFixed(3)}\nP2  X${b.x.toFixed(3)} Y${b.y.toFixed(3)} Z${b.z.toFixed(3)}\nΔX ${dx.toFixed(3)}  ΔY ${dy.toFixed(3)}  ΔZ ${dz.toFixed(3)}\nDistance ${Math.hypot(dx, dy, dz).toFixed(3)} mm   XY ${Math.hypot(dx, dy).toFixed(3)} mm`;
    }
  }

  measureHover(clientX, clientY) {
    const lab = $('#probeLabel');
    const h = this.stockHit(clientX, clientY);
    if (!h) {
      lab.hidden = true;
      return;
    }
    const w = this.toWork(h.table);
    const rect = $('#viewport').getBoundingClientRect();
    lab.hidden = false;
    lab.style.left = clientX - rect.left + 'px';
    lab.style.top = clientY - rect.top + 'px';
    lab.textContent = `X${w.x.toFixed(3)} Y${w.y.toFixed(3)} Z${w.z.toFixed(3)}`;
  }

  updateMeasureLabels() {
    const lab = $('#measureLabel');
    if (this.measurePts.length !== 2) {
      lab.hidden = true;
      return;
    }
    const [p, q] = this.measurePts;
    const mid = p.local.clone().add(q.local).multiplyScalar(0.5);
    this.machine.workGroup.localToWorld(mid);
    const s = this.viewer.project(mid);
    const a = this.toWork(p.table), b = this.toWork(q.table);
    lab.hidden = s.behind;
    lab.style.left = s.x + 'px';
    lab.style.top = s.y + 'px';
    lab.textContent = `${Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z).toFixed(3)} mm`;
  }

  // ------------------------------------------------------------------ visual settings
  applyVisualSettings() {
    const s = this.settings;
    this.effects.showChips = s.showChips;
    this.effects.showCoolant = s.showCoolant;
    this.toolpath.group.visible = s.showToolpath;
    this.sound.setVolume(s.volume);
    this.sound.setMuted(s.muted);
  }
}

// Spindle rotation shown on screen: true speed at low rpm, then a slower "motion picture" rate so the
// flutes don't strobe; the blur sleeve conveys the real speed.
function visualAngle(c, dt, app) {
  const rpm = c.spindle.rpm;
  const rps = rpm / 60;
  const shown = Math.sign(rps) * Math.min(Math.abs(rps), 3 + Math.abs(rps) * 0.02);
  app._vAngle = ((app._vAngle || 0) - shown * Math.PI * 2 * dt) % (Math.PI * 200);
  // Spindle orientation for the tool change: once stopped, turn the drive keys to line up with the
  // carousel fork (keys along X) so they pass between the fork prongs.
  if (c.atc.busy && rps === 0) {
    const target = Math.round(app._vAngle / Math.PI) * Math.PI;
    const d = target - app._vAngle;
    // ease during the orient phase; snap if the carousel is already moving in (high sim speeds)
    app._vAngle = c.atc.slide > 0.02 ? target : app._vAngle + Math.sign(d) * Math.min(Math.abs(d), 6 * Math.max(dt, 0));
  }
  return app._vAngle;
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

const app = new App();
app.init().catch((e) => {
  console.error(e);
  const el = document.getElementById('loadingText');
  if (el) el.textContent = 'Failed to start: ' + e.message;
});

