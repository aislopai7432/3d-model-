// Workshop game: first-person play in the machine shop around the VMC. Owns the two app modes
// (WORKSHOP = first person, SIMULATOR = the classic orbit view with the docked control), the job flow
// (job board -> drawing -> blank from the stock rack -> vise -> control panel -> unload -> inspection
// bench -> measuring instruments), objectives, persistence ('milllab.game') and the interactables.
import * as THREE from 'three';
import { MACHINE, MATERIALS } from '../config.js';
import { FirstPerson } from './fps.js';
import { PARTS, getPart } from './parts.js';
import { inspectPart } from './inspect.js';
import { drawingCanvas } from './drawing.js';
import { StockMesh } from '../scene/stockmesh.js';
import { GameUI } from './ui-game.js';
import { partStore, zmapState, zmapFromState } from './partstore.js';
import { ZMap } from '../sim/zmap.js';

const KEY = 'milllab.game';
const TC = MACHINE.tableCenter;
const GZ = MACHINE.gaugeAtZ0;
const GRADE_RANK = { A: 5, B: 4, C: 3, D: 2, FAIL: 1 };
const r3 = (v) => Math.round(v * 1000) / 1000;

// Blanks on the stock rack: one per job (sawn to the drawing's blank size) plus two near misses, so the
// player has to read the drawing to pick the right one.
export const BLANKS = (() => {
  const out = [];
  const add = (b) => {
    const k = `${b.x}x${b.y}x${b.z}-${b.material}`;
    if (!out.some((o) => o.key === k)) out.push({ ...b, key: k });
  };
  for (const p of PARTS) add({ x: p.stock.x, y: p.stock.y, z: p.stock.z, material: p.material, protrusion: p.protrusion });
  add({ x: 100, y: 60, z: 26, material: 'aluminium', protrusion: 14 });
  add({ x: 120, y: 70, z: 16, material: 'steel', protrusion: 10 });
  const order = { aluminium: 0, plastic: 1, brass: 2, steel: 3 };
  out.sort((a, b) => order[a.material] - order[b.material] || a.x - b.x || a.y - b.y || a.z - b.z);
  return out.map((b, i) => ({ ...b, id: `B${String(i + 1).padStart(2, '0')}` }));
})();

export const blankLabel = (b) => `${b.x} × ${b.y} × ${b.z} ${MATERIALS[b.material]?.short || b.material}`;
const sameBlank = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z && a.material === b.material;
const fitsPart = (b, p) => !!b && !!p && b.x === p.stock.x && b.y === p.stock.y && b.z === p.stock.z && b.material === p.material;

function cloneZMap(z) {
  const c = Object.create(Object.getPrototypeOf(z));
  Object.assign(c, z);
  c.h = z.h.slice();
  c.shade = z.shade.slice();
  c.dirty = new Uint8Array(z.dirty.length).fill(1);
  c.anyDirty = true;
  c.edgeDirty = true;
  return c;
}

export function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export class Game {
  constructor(app) {
    this.app = app;
    this.ws = app.workshop;
    this.s = this.load();
    this.mode = null;
    this.op = null; // null | 'pendant' | 'pc'
    this.measuring = false;
    this.carryPart = null; // machined part snapshot in the player's hands (persisted in IndexedDB)
    this.plate = null; // part on the inspection plate { snap, holder, inner, mesh }
    this.report = null; // last inspection report { report, part, snap, time, ... }
    this.timers = { obj: 0, pc: 0, save: 0, sync: 0 };
    this._ilist = [];
    this._tmpV = new THREE.Vector3();
    this.machinedSerial = -1;
    this.runSerial = -1;

    const v = app.viewer;
    v.scene.add(v.camera); // the hand-held item is a child of the camera
    this.fp = new FirstPerson({ camera: v.camera, dom: v.canvas, container: document.getElementById('viewport'), controls: v.controls });
    this.fp.setColliders(this.ws.colliders);
    this.fp.setInteractables(() => this.interactables(), { occluders: this.ws.occluders });
    this.fp.onInteract = (hit) => this.interact(hit);
    this.fp.onStep = (speed) => this.footstep(speed);
    this.fp.onLockChange = () => this.ui?.syncHud();

    this.buildHand();
    this.buildPcScreen();
    this.ui = new GameUI(this);
    this.ui.build();
    this.initVise();
    this.bindController();
    this.fillRack();
    this.fillJobBoard();
    this._msReady = this.loadMeasuring();

    const q = new URLSearchParams(location.search).get('mode');
    const mode = q === 'sim' || q === 'simulator' ? 'sim' : q === 'workshop' || q === 'game' ? 'workshop' : this.s.mode || 'workshop';
    this.setMode(mode, true);
    window.addEventListener('beforeunload', () => this.save(true));
    // machined parts live in IndexedDB: write them when the page is hidden or closed (debounced
    // saves happen after load / unload / program end / feed hold / inspection)
    const flushAll = () => { this.save(true); this.flushParts(true); };
    window.addEventListener('pagehide', flushAll);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flushAll(); });
  }

  // ------------------------------------------------------------------ machined parts in IndexedDB
  serSnap(snap) {
    return { placement: { ...snap.placement }, material: snap.material, blank: { ...snap.blank }, jobId: snap.jobId, complete: !!snap.complete, removed: snap.removed, zmap: zmapState(snap.zmap) };
  }

  deserSnap(o) {
    if (!o || !o.zmap) return null;
    const zmap = zmapFromState(ZMap.prototype, o.zmap);
    if (!zmap) return null;
    return { zmap, placement: o.placement, material: o.material, blank: o.blank, jobId: o.jobId, complete: o.complete, removed: o.removed };
  }

  // keys: 'vise' | 'carry' | 'plate'
  markParts(...keys) {
    (this._dirtyParts ||= new Set());
    for (const k of keys) this._dirtyParts.add(k);
    clearTimeout(this._partsT);
    this._partsT = setTimeout(() => this.flushParts(), 400);
  }

  viseSig() {
    const app = this.app;
    return app.stockEmpty ? 'empty' : `${app.stockSerial}|${app.zmap.removedTotal}|${this.machinedSerial === app.stockSerial}|${app.stock.x}x${app.stock.y}x${app.stock.z}${app.stock.material}`;
  }

  flushParts(all = false) {
    clearTimeout(this._partsT);
    const keys = this._dirtyParts || new Set();
    this._dirtyParts = new Set();
    if (all) keys.add('vise');
    const app = this.app;
    if (keys.has('vise')) {
      const sig = this.viseSig();
      if (sig !== this._viseSaved) {
        this._viseSaved = sig;
        if (app.stockEmpty || !(app.zmap.removedTotal > 0)) partStore.del('vise');
        else {
          partStore.put('vise', {
            stock: { ...app.stock }, placement: { ...app.placement }, zmap: zmapState(app.zmap),
            machined: this.machinedSerial === app.stockSerial, jobId: this.s.jobId, savedAt: Date.now(),
          });
        }
      }
    }
    if (keys.has('carry')) {
      if (this.carryPart) partStore.put('carry', this.serSnap(this.carryPart));
      else partStore.del('carry');
    }
    if (keys.has('plate')) {
      if (this.plate) {
        const r = this.report;
        let log = [];
        try { log = JSON.parse(JSON.stringify(this.ms?.log || r?.log || [])); } catch { /* ignore */ }
        partStore.put('plate', {
          snap: this.serSnap(this.plate.snap), partId: this.plate.part.id,
          report: r && r.snap === this.plate.snap ? { report: r.report, time: r.time, isBest: r.isBest, prevBest: r.prevBest || null, complete: r.complete, log } : null,
        });
      } else partStore.del('plate');
    }
  }

  // Called once by the app before the first frame: bring back the part in the vise, in the hands and
  // on the inspection plate. Never throws; gives up after a few seconds (IndexedDB stuck / blocked).
  async restoreParts() {
    const work = (async () => {
      const [vise, carry, plate] = await Promise.all([partStore.get('vise'), partStore.get('carry'), partStore.get('plate')]);
      const app = this.app;
      // the vise: only if the blank there is still the one the saved Z-map belongs to
      if (vise && vise.zmap && !app.stockEmpty) {
        const st = vise.stock || {};
        const same = sameBlank(st, app.stock) && st.protrusion === app.stock.protrusion;
        if (same && app.restoreStockZMap(vise.zmap)) {
          if (vise.machined) this.machinedSerial = app.stockSerial;
          this._viseSaved = this.viseSig();
          app.ui.log(`Restored the part in the vise (${(app.zmap.removedTotal / 1000).toFixed(2)} cm³ machined)`);
        } else partStore.del('vise');
      } else if (vise) partStore.del('vise');
      if (carry && !this.s.carry && !this.carryPart) {
        const snap = this.deserSnap(carry);
        if (snap) this.carryPart = snap;
      } else if (carry) partStore.del('carry');
      if (plate) {
        const snap = this.deserSnap(plate.snap);
        const part = getPart(plate.partId);
        if (snap && part) {
          this.showOnPlate(snap, part);
          if (plate.report) {
            this.report = { ...plate.report, part, snap, log: plate.report.log || [] };
            this._msReady?.then(() => { if (this.ms && !this.ms.log.length) { this.ms.part = part; this.ms.log = this.report.log.slice(); } });
          }
        }
      }
    })().catch((e) => console.warn('Could not restore saved parts:', e));
    await Promise.race([work, new Promise((r) => setTimeout(r, 4000))]);
    this.updateHand();
    this.ui._objKey = '';
    this.ui.renderObjectives(this.objectives());
  }

  // ------------------------------------------------------------------ persistence
  load() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* ignore */ }
    const d = { v: 1, mode: 'workshop', jobId: null, jobs: {}, prog: null, carry: null, vise: undefined, helpSeen: false, pose: null };
    if (!s || s.v !== 1) return d;
    return { ...d, ...s, jobs: s.jobs || {} };
  }

  save(now = false) {
    clearTimeout(this._saveT);
    const write = () => {
      try {
        const s = this.s;
        if (this.mode === 'workshop' && this.fp.enabled && !this.op) s.pose = { pos: [r3(this.fp.position.x), 0, r3(this.fp.position.z)], yaw: this.fp.yaw, pitch: this.fp.pitch };
        localStorage.setItem(KEY, JSON.stringify(s));
      } catch { /* storage unavailable */ }
    };
    if (now) write();
    else this._saveT = setTimeout(write, 500);
  }

  get job() { return this.s.jobId ? getPart(this.s.jobId) : null; }
  get prog() { return this.s.prog && this.s.prog.jobId === this.s.jobId ? this.s.prog : null; }
  get manualBlanks() { return this.mode === 'workshop'; }
  get walking() { return this.mode === 'workshop' && !this.op && !this.measuring; }

  // ------------------------------------------------------------------ modes
  setMode(mode, initial = false) {
    const app = this.app, v = app.viewer, ui = app.ui;
    if (mode !== 'sim') mode = 'workshop';
    if (this.mode === mode && !initial) return;
    if (this.mode === 'workshop' && mode === 'sim') {
      this.closeMeasuring();
      this.exitOp(true);
      this.ui.closeAll();
      this.s.pose = { pos: [r3(this.fp.position.x), 0, r3(this.fp.position.z)], yaw: this.fp.yaw, pitch: this.fp.pitch };
    }
    this.mode = mode;
    this.s.mode = mode;
    document.body.classList.toggle('ws', mode === 'workshop');
    document.body.classList.remove('op', 'op-pc', 'op-peek');
    v.showGizmo = mode === 'sim';
    if (app.measureOn) ui.toggle('measure', document.querySelector('[data-toggle="measure"]'), false);
    if (mode === 'workshop') {
      v.tween = null;
      // the machine as it stands in the shop: enclosure and covers on
      app.machine.setEnclosureVisible(true);
      app.machine.setCoversVisible(true);
      const pose = this.s.pose && this.validPose(this.s.pose) ? this.s.pose : this.ws.anchors.spawn;
      this.fp.enable({ pos: pose.pos, yaw: pose.yaw, pitch: pose.pitch ?? -0.08 });
      v.setCenter(null);
      if (!this.s.helpSeen) this.ui.showHelp(true);
    } else {
      this.fp.disable();
      v.setCenter(null);
      app.machine.setEnclosureVisible(app.settings.enclosure !== false);
      app.machine.setCoversVisible(app.settings.covers !== false);
      v.camera.fov = 38;
      v.camera.updateProjectionMatrix();
      if (!initial) v.setView('iso');
      // the simulator always has a blank in the vise
      if (app.stockEmpty) {
        app.setStockEmpty(false);
        app.rebuildStock();
        ui.log('Simulator: blank loaded into the empty vise');
      }
      this.ui.showHelp(false);
      ui.update(true);
    }
    this.ui.syncMode();
    this.hand.visible = false;
    this.updateHand();
    setTimeout(() => v.resize(), 30);
    this.save();
  }

  validPose(p) {
    if (!p || !Array.isArray(p.pos)) return false;
    const R = this.ws.room;
    return p.pos[0] > R.x0 + 300 && p.pos[0] < R.x1 - 300 && p.pos[2] > R.z0 + 300 && p.pos[2] < R.z1 - 300;
  }

  // Frame hook: returns true when the game positioned the camera (so the orbit controls must not).
  driveCamera(dt) {
    if (this.mode !== 'workshop') return false;
    this.app.viewer.tween = null;
    if (this.measuring && this.ms?.active) {
      this.ms.update(dt);
      return true;
    }
    this.fp.update(dt);
    return true;
  }

  update(dt) {
    if (!(dt > 0)) dt = 0;
    if (this.mode === 'workshop') {
      const p = this.prog;
      if (p && !p.done && !document.hidden) p.time = (p.time || 0) + dt;
    }
    const t = this.timers;
    t.sync += dt;
    if (t.sync > 0.2) {
      t.sync = 0;
      this.syncVise();
    }
    t.obj += dt;
    if (t.obj > 0.25) {
      t.obj = 0;
      this.ui.renderObjectives(this.objectives());
      if (this.op) this.ui.layoutOp();
    }
    t.pc += dt;
    if (t.pc > 0.6) {
      t.pc = 0;
      this.drawPcScreen();
    }
    t.save += dt;
    if (t.save > 5) {
      t.save = 0;
      if (this.mode === 'workshop') this.save();
      // safety net while cutting: keep the saved part in the vise at most ~20 s behind
      t.parts = (t.parts || 0) + 1;
      if (t.parts >= 4) {
        t.parts = 0;
        if (!this.app.stockEmpty && this.viseSig() !== this._viseSaved) this.markParts('vise');
      }
    }
  }

  // ------------------------------------------------------------------ keyboard / pointer gates for ui.js
  blocksKey(e) {
    if (this.mode !== 'workshop') return false;
    if (this.ui.topModal() || this.measuring) return true;
    if (!this.op) return true; // walking: WASD etc. belong to the first-person controller
    // operator view: the control's keys work, except view presets and Esc (= step back)
    if (e.key === 'Escape' || /^[1-6]$/.test(e.key) || e.code === 'KeyQ') return true;
    if (this.op === 'pc' && (e.code === 'Space' || /^Arrow|^Page/.test(e.key))) return true; // no machine at the PC
    return false;
  }

  blocksPointer() {
    return this.mode === 'workshop' && (!this.op || this.measuring);
  }

  blankMessage() {
    return 'In the workshop the blank comes from the stock rack: load it into the vise by hand.';
  }

  // The control's own stock-changing features (Load blank, New blank, setup wizard, accuracy) would
  // swap the blank in the vise behind the player's back: in the workshop they are refused.
  blockStockChange(what) {
    if (this.mode !== 'workshop') return false;
    const msg = what === 'Accuracy'
      ? 'Accuracy: changing it re-creates the blank, so in the workshop it can only change while the vise is empty or holds an unmachined blank.'
      : `${what}: ${this.blankMessage()}`;
    this.app.ui.log(msg, 'warn');
    this.ui.toast(msg, 'warn', 5000);
    return true;
  }

  // ------------------------------------------------------------------ vise / blanks
  initVise() {
    const app = this.app, s = this.s;
    if (s.vise === undefined) {
      // first start: the workshop begins with an empty vise; the simulator keeps its default blank
      s.vise = (new URLSearchParams(location.search).get('mode') === 'sim' || s.mode === 'sim') ? this.blankFromApp() : null;
    }
    if (s.vise) {
      const b = s.vise;
      if (!sameBlank(b, app.stock) || app.stock.protrusion !== b.protrusion) {
        Object.assign(app.stock, { x: b.x, y: b.y, z: b.z, material: b.material, protrusion: b.protrusion });
        app.setStockEmpty(false);
        app.rebuildStock();
        app.save();
      } else app.setStockEmpty(false);
    } else {
      app.setStockEmpty(true);
    }
    if (s.carry && s.carry.kind !== 'blank') s.carry = null;
    this.seenSerial = app.stockSerial;
  }

  blankFromApp() {
    const st = this.app.stock;
    return { x: st.x, y: st.y, z: st.z, material: st.material, protrusion: st.protrusion };
  }

  // Follow stock changes made by the control (New blank, Blank form, examples, wizard, fresh blank).
  syncVise() {
    const app = this.app;
    if (app.stockSerial === this.seenSerial) return;
    this.seenSerial = app.stockSerial;
    if (this._ownRebuild) { this._ownRebuild = false; return; }
    this.s.vise = app.stockEmpty ? null : this.blankFromApp();
    this.save();
    this.markParts('vise');
  }

  rackSlotOf(b) {
    return BLANKS.findIndex((x) => sameBlank(x, b));
  }

  fillRack() {
    BLANKS.forEach((b, i) => this.ws.setRackBlank(i, { x: b.x, y: b.y, z: b.z, material: b.material, label: `${b.x}x${b.y}x${b.z} ${b.material.slice(0, 3).toUpperCase()}` }));
    this.refreshRack();
  }

  refreshRack() {
    const carried = this.s.carry?.kind === 'blank' ? this.rackSlotOf(this.s.carry.blank) : -1;
    BLANKS.forEach((b, i) => {
      if (i >= (this.ws.anchors.stockRackSlots?.length || 0)) return;
      const want = i !== carried;
      if (this._rackShown?.[i] === want) return;
      (this._rackShown ||= [])[i] = want;
      this.ws.setRackBlank(i, want ? { x: b.x, y: b.y, z: b.z, material: b.material, label: `${b.x}x${b.y}x${b.z} ${b.material.slice(0, 3).toUpperCase()}` } : null);
    });
  }

  takeBlank(id) {
    const b = BLANKS.find((x) => x.id === id);
    if (!b) return;
    if (this.carryPart) return this.ui.toast('Your hands are full: take the finished part to the inspection bench first.', 'warn');
    if (this.s.carry?.kind === 'blank') this.ui.toast(`Put back the ${blankLabel(this.s.carry.blank)} blank`, 'info');
    this.s.carry = { kind: 'blank', blank: { x: b.x, y: b.y, z: b.z, material: b.material, protrusion: b.protrusion } };
    const job = this.job;
    if (job) {
      if (fitsPart(b, job)) this.ui.toast(`Took a ${blankLabel(b)} blank: matches drawing ${job.drawingNo}. Load it into the vise.`, 'ok');
      else this.ui.toast(`Took a ${blankLabel(b)} blank. Check it against the drawing: ${job.id} needs ${blankLabel({ ...job.stock, material: job.material })}.`, 'warn', 5200);
    } else this.ui.toast(`Took a ${blankLabel(b)} blank`, 'ok');
    this.app.sound.clunk();
    this.refreshRack();
    this.updateHand();
    this.save();
  }

  putBackBlank() {
    if (this.s.carry?.kind !== 'blank') return;
    this.ui.toast(`Put the ${blankLabel(this.s.carry.blank)} blank back on the rack`);
    this.s.carry = null;
    this.app.sound.clunk();
    this.refreshRack();
    this.updateHand();
    this.save();
  }

  machineBusy() {
    const c = this.app.controller;
    if (c.exec) return 'Stop the program first (RESET at the control panel).';
    if (Math.abs(c.spindle.rpm) > 1) return 'Stop the spindle first.';
    if (c.door.pos < 0.85) return c.door.target > 0.5 ? 'Wait for the doors to open.' : 'Open the machine doors first (door handle on the front).';
    return null;
  }

  loadBlank() {
    const app = this.app, s = this.s;
    const busy = this.machineBusy();
    if (busy) return this.ui.toast(busy, 'warn');
    if (s.carry?.kind !== 'blank') return;
    if (!app.stockEmpty) return this.ui.toast('The vise is not empty: unload it first.', 'warn');
    const b = s.carry.blank;
    Object.assign(app.stock, { x: b.x, y: b.y, z: b.z, material: b.material, protrusion: b.protrusion });
    app.setStockEmpty(false);
    this._ownRebuild = true;
    app.rebuildStock();
    app.save();
    s.vise = { ...b };
    s.carry = null;
    this.seenSerial = app.stockSerial;
    this._ownRebuild = false;
    this.markParts('vise');
    const job = this.job;
    if (job && fitsPart(b, job) && this.prog) Object.assign(this.prog, { machined: false, unloaded: false, inspected: false });
    app.sound.clunk();
    setTimeout(() => app.sound.clunk(), 180);
    app.ui.log(`Blank ${blankLabel(b)} clamped in the vise, ${app.placement.protrusion.toFixed(1)} mm above the jaws`);
    this.ui.toast(job && fitsPart(b, job) ? 'Blank clamped. Next: set G54 on its top front-left corner at the control panel.' : `Blank ${blankLabel(b)} clamped in the vise.`, 'ok', 4500);
    this.refreshRack();
    this.updateHand();
    this.save();
  }

  unload() {
    const app = this.app, s = this.s;
    const busy = this.machineBusy();
    if (busy) return this.ui.toast(busy, 'warn');
    if (app.stockEmpty) return this.ui.toast('The vise is empty.', 'warn');
    if (s.carry || this.carryPart) return this.ui.toast('Your hands are full.', 'warn');
    const blank = this.blankFromApp();
    if (app.zmap.removedTotal > 0.5) {
      const job = this.job;
      this.carryPart = {
        zmap: cloneZMap(app.zmap), placement: { ...app.placement }, material: app.stock.material, blank,
        jobId: job && fitsPart(blank, job) ? job.id : job?.id || null,
        complete: this.machinedSerial === app.stockSerial,
        removed: app.zmap.removedTotal,
      };
      if (this.prog && job && fitsPart(blank, job)) this.prog.unloaded = true;
      this.ui.toast('Part unloaded. Take it to the inspection bench (granite surface plate).', 'ok', 4500);
      app.ui.log('Part taken out of the vise');
    } else {
      s.carry = { kind: 'blank', blank };
      this.ui.toast(`Took the unmachined ${blankLabel(blank)} blank out of the vise.`);
    }
    app.setStockEmpty(true);
    s.vise = null;
    this.markParts('vise', 'carry');
    app.sound.clunk();
    this.refreshRack();
    this.updateHand();
    this.save();
  }

  // ------------------------------------------------------------------ hand-held item
  buildHand() {
    const cam = this.app.viewer.camera;
    const hand = new THREE.Group();
    hand.name = 'game-hand';
    hand.position.set(170, -175, -430);
    hand.rotation.set(0.32, -0.5, 0.05);
    cam.add(hand);
    // convex box with back-face culling: drawn last without depth test so it never clips into walls
    const mat = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, metalness: 0.85, roughness: 0.4, depthTest: false, depthWrite: false, envMapIntensity: 1.2 });
    const block = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
    block.renderOrder = 1000;
    block.frustumCulled = false;
    hand.add(block);
    this.hand = hand;
    this.handBlock = block;
    this.handPart = null;
    hand.visible = false;
  }

  updateHand() {
    const s = this.s;
    const show = this.mode === 'workshop' && !this.op && !this.measuring;
    if (this.handPart && (!this.carryPart || this.handPart.snap !== this.carryPart)) {
      this.hand.remove(this.handPart.group);
      this.handPart.mesh.dispose();
      this.handPart = null;
    }
    if (s.carry?.kind === 'blank') {
      const b = s.carry.blank;
      const m = MATERIALS[b.material] || MATERIALS.aluminium;
      this.handBlock.scale.set(b.x, b.z, b.y);
      this.handBlock.material.color.setHex(m.raw);
      this.handBlock.material.metalness = m.metalness;
      this.handBlock.material.roughness = Math.max(0.35, m.roughness);
      this.handBlock.visible = true;
    } else this.handBlock.visible = false;
    if (this.carryPart && !this.handPart) {
      const snap = this.carryPart;
      const mesh = new StockMesh(snap.zmap, MATERIALS[snap.material] || MATERIALS.aluminium);
      const g = new THREE.Group();
      const pl = snap.placement;
      mesh.group.position.set(-(pl.x0 + pl.lx / 2), -(pl.bottom + pl.top) / 2, pl.y0 + pl.ly / 2);
      g.add(mesh.group);
      mesh.group.traverse((o) => { o.frustumCulled = false; });
      this.hand.add(g);
      this.handPart = { group: g, mesh, snap };
    }
    this.hand.visible = show && (!!s.carry || !!this.carryPart);
    this.ui.setCarry(this.carryText());
  }

  carryText() {
    if (this.carryPart) {
      const p = this.carryPart.jobId ? getPart(this.carryPart.jobId) : null;
      return { icon: 'part', text: p ? `Machined part · ${p.id} ${p.title}` : `Machined part · ${blankLabel(this.carryPart.blank)}` };
    }
    if (this.s.carry?.kind === 'blank') return { icon: 'blank', text: `Blank · ${blankLabel(this.s.carry.blank)}` };
    return null;
  }

  // ------------------------------------------------------------------ jobs
  async fillJobBoard() {
    const n = Math.min(PARTS.length, this.ws.anchors.jobBoardSlots?.length || 0);
    for (let i = 0; i < n; i++) {
      try {
        const cv = await drawingCanvas(PARTS[i], 512, { thumb: true });
        this.ws.setJobBoardSheet(i, cv);
      } catch (e) {
        console.warn('job board sheet', PARTS[i].id, e);
      }
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  acceptJob(id) {
    const part = getPart(id);
    if (!part) return;
    const app = this.app;
    const prev = this.s.jobId;
    this.s.jobId = id;
    if (!this.s.prog || this.s.prog.jobId !== id || this.s.prog.done) {
      this.s.prog = { jobId: id, read: true, time: 0, machined: false, unloaded: false, inspected: false, done: false };
    } else this.s.prog.read = true;
    const name = `JOB_${part.id}.MPF`;
    if (!app.programs.has(name)) app.programs.put(name, this.programTemplate(part));
    if (app.controller.exec) this.ui.toast(`${name} is ready in the program manager (a program is running, so it was not selected).`, 'warn', 5000);
    else {
      app.openProgram(name);
      app.ui.log(`Job ${part.id} accepted: ${name} created and selected`);
    }
    this.ui.toast(prev === id ? `Job ${part.id} is your current job.` : `Job accepted: ${part.id} ${part.title}. ${name} is selected at the control.`, 'ok', 4500);
    this.ui.dpanelSetPart(part);
    this.save();
  }

  programTemplate(p) {
    const MAT = { aluminium: 'ALUMINIUM', steel: 'STEEL', brass: 'BRASS', plastic: 'ACETAL' };
    const face = r3(p.stock.z - p.size.z);
    return [
      `; JOB_${p.id}  ${p.title.toUpperCase()}  DRG ${p.drawingNo} REV ${p.rev}`,
      `; CUSTOMER: ${p.customer}`,
      `; BLANK ${p.stock.x} x ${p.stock.y} x ${p.stock.z} ${MAT[p.material] || p.material.toUpperCase()} -> FINISHED ${p.size.x} x ${p.size.y} x ${p.size.z}`,
      '; SETUP: G54 = TOP FRONT-LEFT CORNER OF THE RAW BLANK, Z0 = TOP OF THE RAW BLANK',
      `; FINISHED TOP FACE AT Z-${face} (FACE OFF ${face} MM), FEATURE FLOOR Z = -${face} - DEPTH`,
      '; TOOLS: T1 FACE MILL D50, T2 END MILL D10, T3 END MILL D6, T4 SPOT DRILL D10, T5 DRILL D6.8',
      'N10 G17 G90 G71 G94 G40',
      'N20 G54',
      'N30 T1 D1 M6',
      'N40 S3200 M3 M8',
      'N50 G0 X0 Y0 Z25',
      '',
      '; YOUR MACHINING HERE (DRILLING / MILLING / CONTOUR SOFTKEYS INSERT CYCLES)',
      '',
      'N900 G0 Z100 M9',
      'N910 M5',
      'N920 M30',
      '',
    ].join('\n');
  }

  loadReference(id) {
    const part = getPart(id);
    if (!part) return;
    const app = this.app;
    if (app.controller.exec) return this.ui.toast('Stop the running program first.', 'warn');
    const name = `JOB_${part.id}_REF.MPF`;
    app.programs.put(name, part.solution);
    app.openProgram(name);
    app.ui.log(`${name}: reference program for ${part.id} loaded and selected`);
    this.ui.toast(`${name} loaded and selected. Set G54 on the top front-left corner of the raw blank before you run it.`, 'ok', 5200);
  }

  markRead(id) {
    if (this.prog && this.s.jobId === id && !this.prog.read) {
      this.prog.read = true;
      this.save();
    }
  }

  // ------------------------------------------------------------------ objectives
  expectedG54() {
    const pl = this.app.placement;
    return { x: r3(pl.x0 + TC.x), y: r3(pl.y0 + TC.y), z: r3(pl.top - GZ) };
  }

  g54Ok() {
    const o = this.app.offsets[0], e = this.expectedG54();
    return Math.abs(o.x - e.x) <= 0.05 && Math.abs(o.y - e.y) <= 0.05 && Math.abs(o.z - e.z) <= 0.05;
  }

  programOk() {
    const app = this.app, c = app.compiled;
    if (!c || c.errors.length || !app.programName) return false;
    return c.ops.some((o) => o.t === 'move' && !o.rapid);
  }

  objectives() {
    const job = this.job, p = this.prog, app = this.app;
    if (!job || !p) {
      return { job: null, steps: [{ label: 'Pick a job at the job board', done: false, hint: 'The cork board on the left wall' }] };
    }
    const viseOk = !app.stockEmpty && fitsPart(this.s.vise, job);
    const carryOk = this.s.carry?.kind === 'blank' && fitsPart(this.s.carry.blank, job);
    const partInHand = this.carryPart && this.carryPart.jobId === job.id;
    const partOnPlate = this.plate && this.plate.snap.jobId === job.id;
    const machinedNow = viseOk && this.machinedSerial === app.stockSerial;
    const machined = machinedNow || p.machined;
    const unloaded = p.unloaded || partInHand || partOnPlate;
    const inspected = p.inspected;
    const later = (k) => [machined, unloaded, inspected].slice(k).some(Boolean);
    const steps = [
      { label: 'Read the drawing', done: !!p.read, hint: 'Press Q or the Drawing button' },
      { label: `Take the right blank (${blankLabel({ ...job.stock, material: job.material })})`, done: carryOk || viseOk || later(0), hint: 'Stock rack, right-hand wall' },
      { label: 'Load it into the vise', done: viseOk || later(0), hint: 'Open the doors, then use the vise' },
      { label: 'Set G54 on the top front-left corner', done: (viseOk && this.g54Ok()) || later(0), hint: 'OFFSET › Work offset, or JOG › Set WO' },
      { label: 'Program selected (no errors)', done: (this.programOk() && /^JOB_/.test(app.programName)) || later(0) || (this.programOk() && viseOk), hint: 'PROGRAM area, or Load reference program' },
      { label: 'Machine the part (AUTO, CYCLE START)', done: machined, hint: 'Close the doors, AUTO, CYCLE START' },
      { label: 'Unload the part', done: unloaded, hint: 'Open the doors and take the part' },
      { label: 'Inspect it at the inspection bench', done: inspected, hint: 'Granite surface plate, left wall' },
    ];
    const next = steps.find((x) => !x.done);
    return { job, time: p.time, done: p.done, steps, next, best: this.s.jobs[job.id]?.best };
  }

  // ------------------------------------------------------------------ controller hooks
  bindController() {
    const app = this.app, c = app.controller;
    c.on('cycle', (k) => {
      if (k === 'start') this.runSerial = app.stockSerial;
    });
    c.on('programEnd', () => {
      if (app.stockEmpty || app.zmap.removedTotal < 0.5) {
        if (this.mode === 'workshop' && app.stockEmpty) this.ui.toast('Program finished, but the vise was empty: nothing was machined.', 'warn', 4500);
        return;
      }
      this.machinedSerial = app.stockSerial;
      this.markParts('vise');
      const job = this.job;
      if (job && this.prog && fitsPart(this.s.vise, job)) {
        this.prog.machined = true;
        this.save();
      }
      if (this.mode === 'workshop') this.ui.toast('Program complete. Open the doors and unload the part.', 'ok', 4500);
    });
    // a run interrupted by feed hold, an alarm or E-stop leaves a partly machined blank: save it
    c.on('state', (st) => {
      if ((st === 'hold' || st === 'alarm' || st === 'estop') && !app.stockEmpty) this.markParts('vise');
    });
    c.on('cycle', (k) => {
      if (k === 'start' && this.mode === 'workshop' && app.stockEmpty) this.ui.toast('The vise is empty: the program will cut air.', 'warn', 4000);
    });
  }

  // ------------------------------------------------------------------ interactables
  interactables() {
    const L = this._ilist;
    L.length = 0;
    const app = this.app, m = app.machine, s = this.s;
    for (const e of this.ws.interactables) {
      let label = e.label;
      if (e.id === 'stockRack') label = s.carry?.kind === 'blank' ? 'Put the blank back / swap it' : this.carryPart ? 'Stock rack (hands full)' : 'Take a blank from the stock rack';
      else if (e.id === 'inspection') label = this.carryPart ? 'Put the part on the surface plate and inspect it' : this.plate ? 'Read the inspection report' : 'Inspection bench';
      else if (e.id === 'toolCrib') label = 'Look at the tool list';
      else if (e.id === 'pcDesk') label = 'Program at the CAM computer';
      else if (e.id === 'drawingDesk') label = this.job ? 'Read the drawing' : 'Look at the drawings';
      else if (e.id === 'jobBoard') label = 'Read the job board';
      L.push({ object: e.object, id: e.id, label });
    }
    const c = app.controller;
    L.push({ object: m.pendantBody, id: 'pendant', label: 'Use the control panel' });
    for (const o of m.clickables) {
      const a = o.userData.action;
      const label = a === 'door' ? (c.door.target > 0.5 ? 'Close the doors' : 'Open the doors')
        : a === 'cycleStart' ? 'Press CYCLE START' : a === 'feedHold' ? 'Press CYCLE STOP' : a === 'estop' ? (c.estop ? 'E-STOP is pressed (RESET at the panel)' : 'Press EMERGENCY STOP') : a;
      L.push({ object: o, id: 'mc:' + a, label });
    }
    let vl;
    if (!app.stockEmpty) vl = this.carryPart || s.carry ? 'Vise (hands full)' : app.zmap.removedTotal > 0.5 ? 'Unload the part' : 'Take the blank out of the vise';
    else vl = s.carry?.kind === 'blank' ? 'Clamp the blank in the vise' : 'Vise (empty): fetch a blank from the stock rack';
    if (app.vise) L.push({ object: app.vise.group, id: 'vise', label: vl });
    if (app.stockMesh && !app.stockEmpty) L.push({ object: app.stockMesh.group, id: 'vise', label: vl });
    if (this.instruments) {
      for (const p of this.instruments) if (p.visible) L.push({ object: p, id: 'instr:' + p.userData.id, label: `Measure with the ${p.userData.name}` });
    }
    if (this.plate) L.push({ object: this.plate.holder, id: 'platePart', label: 'Measure the part' });
    return L;
  }

  interact(hit) {
    const id = hit.id;
    const app = this.app;
    app.sound.init();
    if (id === 'jobBoard') {
      const slot = this.ws.jobBoardSlotAt?.(hit.point) ?? -1;
      if (slot >= 0 && PARTS[slot]) this.ui.openDrawing(PARTS[slot]);
      else this.ui.openJobs();
    } else if (id === 'stockRack') {
      if (this.carryPart) this.ui.toast('Take the finished part to the inspection bench first.', 'warn');
      else this.ui.openRack();
    } else if (id === 'inspection' || id === 'platePart') {
      if (this.carryPart) this.placeOnPlate();
      else if (id === 'platePart' && this.plate) this.openMeasuring();
      else if (this.report) this.ui.openReport(this.report);
      else this.ui.toast('Bring a machined part here to inspect it.', 'info');
    } else if (id === 'toolCrib') {
      this.ui.openTools();
    } else if (id === 'pcDesk') {
      this.enterOp('pc');
    } else if (id === 'drawingDesk') {
      if (this.job) this.ui.openDrawing(this.job);
      else this.ui.openJobs();
    } else if (id === 'pendant') {
      this.enterOp('pendant');
    } else if (id.startsWith('mc:')) {
      const a = id.slice(3);
      if (a === 'door' && app.controller.exec && app.controller.doorInterlock && app.controller.door.target < 0.5) this.ui.toast('Door interlock: the doors stay closed while the program runs.', 'warn');
      app.ui.act(a);
    } else if (id === 'vise') {
      if (!app.stockEmpty) this.unload();
      else if (this.s.carry?.kind === 'blank') this.loadBlank();
      else if (this.carryPart) this.ui.toast('Your hands are full: take the part to the inspection bench.', 'warn');
      else this.ui.toast('The vise is empty: fetch a blank from the stock rack (right-hand wall).', 'info');
    } else if (id.startsWith('instr:')) {
      if (this.plate) this.openMeasuring(id.slice(6));
      else this.ui.toast('Put a machined part on the surface plate first, then measure it.', 'info');
    }
  }

  footstep(speed) {
    const snd = this.app.sound;
    if (!snd.ready?.() || this.app.settings.muted) return;
    const k = Math.min(1.3, speed / 1500);
    snd.noiseBurst(150 + Math.random() * 90, 0.9, 0.003, 0.08 + Math.random() * 0.03, 0.09 * k, 'lowpass');
  }

  // ------------------------------------------------------------------ operator view (control panel / CAM PC)
  async enterOp(kind = 'pendant', area = null) {
    if (this.mode !== 'workshop') return;
    const app = this.app, fp = this.fp;
    this.ui.closeAll();
    this.op = kind;
    fp.frozen = true;
    document.body.classList.add('op');
    document.body.classList.toggle('op-pc', kind === 'pc');
    document.body.classList.remove('op-peek');
    this.updateHand();
    if (area) app.ui.hmi.showArea(area);
    else if (kind === 'pc') app.ui.hmi.showArea('program');
    if (this.job) this.ui.dpanelSetPart(this.job);
    this.ui.syncHud();
    const cam = app.viewer.camera;
    this._savedFov = fp.fov;
    let eye, target;
    if (kind === 'pc') {
      const mesh = this.ws.anchors.pcScreen.mesh;
      target = mesh.getWorldPosition(new THREE.Vector3());
      const n = new THREE.Vector3(0, 0, 1).applyQuaternion(mesh.getWorldQuaternion(new THREE.Quaternion()));
      eye = target.clone().addScaledVector(n, 820);
      eye.y = target.y + 120;
      fp.fov = 50;
    } else {
      // standing on the mat in front of the pendant, looking into the work area through the doors
      eye = new THREE.Vector3(470, 1610, 1640);
      target = new THREE.Vector3(10, 1090, 40);
      fp.fov = 50;
    }
    this.ui.layoutOp();
    await fp.focusOn(target, eye, 0.8);
    cam.updateProjectionMatrix();
  }

  exitOp(silent = false) {
    if (!this.op) return;
    this.op = null;
    document.body.classList.remove('op', 'op-pc', 'op-peek');
    const a = document.activeElement;
    if (a && a !== document.body && a.blur) a.blur();
    this.app.viewer.setCenter(null);
    if (this._savedFov) this.fp.fov = this._savedFov;
    // step back from the panel a little so it does not fill the view
    const p = this.fp.position;
    if (!silent) this.fp.setPose({ pos: [p.x + 0, 0, p.z + 120] });
    this.fp.frozen = false;
    this.updateHand();
    this.ui.syncHud();
  }

  // ------------------------------------------------------------------ inspection
  placeOnPlate() {
    const snap = this.carryPart;
    if (!snap) return;
    const part = getPart(snap.jobId) || this.job;
    if (!part) return this.ui.toast('Accept a job at the job board first: the inspection compares the part with its drawing.', 'warn', 5000);
    this.showOnPlate(snap, part);
    if (this.ms) this.ms.log = [];
    this.carryPart = null;
    this.updateHand();
    this.app.sound.clunk();

    let report;
    try {
      report = inspectPart(part, snap.zmap, snap.placement);
    } catch (e) {
      console.error(e);
      return this.ui.toast('Inspection failed: ' + e.message, 'warn');
    }
    report.grade = String(report.grade || 'FAIL').toUpperCase();
    if (snap.material !== part.material && report.grade !== 'FAIL') {
      report.grade = 'FAIL';
      report.pass = false;
      report.notes = [`Wrong material: the drawing calls for ${MATERIALS[part.material].short.toLowerCase()} but the part is ${MATERIALS[snap.material].short.toLowerCase()}.`, ...(report.notes || [])];
    }
    const p = this.s.jobId === part.id ? this.prog : null;
    const time = p ? p.time : null;
    const best = this.s.jobs[part.id]?.best;
    const isBest = !best || GRADE_RANK[report.grade] > GRADE_RANK[best.grade] || (report.grade === best.grade && report.score > best.score);
    const rec = this.s.jobs[part.id] || (this.s.jobs[part.id] = { attempts: 0 });
    rec.attempts = (rec.attempts || 0) + 1;
    if (isBest) rec.best = { grade: report.grade, score: Math.round(report.score), time: time != null ? Math.round(time) : null, at: Date.now() };
    if (p) {
      p.inspected = true;
      p.unloaded = true;
      if (report.grade !== 'FAIL') p.done = true;
    }
    this.report = { report, part, snap, time, isBest, prevBest: best, complete: report.grade !== 'FAIL', log: [] };
    this.save();
    this.markParts('carry', 'plate');
    this.ui.openReport(this.report);
    this.ui.toast(report.grade === 'FAIL' ? `Inspection: FAIL (${Math.round(report.score)})` : `Inspection: grade ${report.grade} (${Math.round(report.score)}/100)`, report.grade === 'FAIL' ? 'warn' : 'ok', 4000);
  }

  // Show a part snapshot on the granite plate (partGroup for the measuring station = inner).
  showOnPlate(snap, part) {
    this.clearPlate();
    const mesh = new StockMesh(snap.zmap, MATERIALS[snap.material] || MATERIALS.aluminium);
    const holder = new THREE.Group();
    holder.name = 'inspection-part';
    const inner = new THREE.Group();
    const pl = snap.placement;
    inner.position.set(-(pl.x0 + pl.lx / 2), -pl.bottom, pl.y0 + pl.ly / 2);
    inner.add(mesh.group);
    holder.add(inner);
    holder.position.copy(this.ws.anchors.inspectionPlate);
    holder.rotation.y = Math.PI / 2; // part front faces the player standing in front of the bench
    mesh.group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.app.viewer.scene.add(holder);
    holder.updateMatrixWorld(true);
    this.plate = { snap, holder, inner, mesh, part };
  }

  clearPlate() {
    if (!this.plate) return;
    this.app.viewer.scene.remove(this.plate.holder);
    this.plate.mesh.dispose();
    this.plate = null;
  }

  // ------------------------------------------------------------------ measuring instruments (Agent F's module)
  async loadMeasuring() {
    try {
      this.M = await import('./measuring.js');
    } catch (e) {
      console.warn('Measuring instruments unavailable:', e);
      return;
    }
    const M = this.M, slots = this.ws.anchors.instrumentSlots || [];
    this.instruments = [];
    for (const sl of slots) {
      try {
        const prop = M.buildInstrumentProp ? M.buildInstrumentProp(sl.id) : M.buildInstrumentModel(sl.id);
        prop.position.copy(sl.position);
        prop.quaternion.copy(sl.quaternion);
        const info = (M.INSTRUMENTS || []).find((i) => i.id === sl.id);
        prop.userData.id = sl.id;
        prop.userData.name = (info?.name || sl.id).replace(/^./, (ch) => ch.toLowerCase());
        this.app.viewer.scene.add(prop);
        this.instruments.push(prop);
      } catch (e) {
        console.warn('instrument prop', sl.id, e);
      }
    }
    const v = this.app.viewer;
    this.ms = new M.MeasuringStation({ scene: v.scene, camera: v.camera, dom: v.canvas, container: document.getElementById('viewport') });
    this.ms.onClose = () => this.closeMeasuring();
    this.ms.onMeasure = (rec) => {
      this.app.sound.click?.();
      if (this.report) this.report.log = this.ms.log;
      this.markParts('plate');
    };
    this.ms.onSelect = (id) => {
      for (const p of this.instruments) p.visible = p.userData.id !== id;
    };
  }

  async openMeasuring(instrument) {
    if (!this.plate) return this.ui.toast('Put a machined part on the surface plate first.', 'info');
    if (!this.ms) await this._msReady;
    if (!this.ms) return this.ui.toast('The measuring instruments are not available.', 'warn');
    if (this.mode !== 'workshop') return;
    this.ui.closeAll();
    this.measuring = true;
    this.fp.frozen = true;
    this.updateHand();
    this.ui.syncHud();
    const cam = this.ws.anchors.inspectionCamera;
    if (cam) await this.fp.focusOn(cam.target, cam.eye, 0.6);
    if (!this.measuring) return;
    const { snap, inner, part } = this.plate;
    this.ms.open({ zmap: snap.zmap, placement: snap.placement, part, partGroup: inner, instrument });
    this.ui.syncHud();
  }

  closeMeasuring() {
    if (!this.measuring) return;
    this.measuring = false;
    if (this.ms?.active) this.ms.close();
    for (const p of this.instruments || []) p.visible = true;
    if (this.report) this.report.log = this.ms?.log || [];
    this.markParts('plate');
    this.fp.frozen = false;
    this.updateHand();
    this.ui.syncHud();
    const n = this.ms?.log?.length || 0;
    if (n) this.ui.toast(`${n} measurement${n > 1 ? 's' : ''} recorded on the inspection report.`, 'ok');
  }

  // ------------------------------------------------------------------ CAM PC monitor
  buildPcScreen() {
    const sc = this.ws.anchors.pcScreen;
    if (!sc?.mesh) return;
    const cv = document.createElement('canvas');
    cv.width = 768;
    cv.height = 480;
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    sc.mesh.material.map = tex;
    sc.mesh.material.needsUpdate = true;
    this.pc = { cv, g: cv.getContext('2d'), tex, key: '' };
  }

  drawPcScreen() {
    const pc = this.pc;
    if (!pc || this.mode !== 'workshop') return;
    const app = this.app, job = this.job;
    // only redraw when something shown changed and the player is in the left half of the shop
    const near = this.fp.position.x < -1500 || this.op === 'pc';
    const lines = app.ui.editor.lines;
    const comp = app.compiled;
    const key = `${app.programName}|${lines.length}|${app.ui.editor.getValue().length}|${comp?.errors.length}|${job?.id}|${app.controller.line}`;
    if (!near || key === pc.key) return;
    pc.key = key;
    const g = pc.g, W = 768, H = 480;
    g.fillStyle = '#1b2026';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#2b5d93';
    g.fillRect(0, 0, W, 34);
    g.font = '600 17px "IBM Plex Sans", Arial';
    g.fillStyle = '#eef4fa';
    g.fillText(`MillLab CAM · ${app.programName || 'no program'}`, 12, 23);
    g.textAlign = 'right';
    g.fillText(job ? `${job.id} · ${job.drawingNo}` : 'no job', W - 12, 23);
    g.textAlign = 'left';
    // editor pane
    g.fillStyle = '#f6f7f9';
    g.fillRect(10, 44, 486, H - 84);
    g.font = '500 13.5px "IBM Plex Mono", monospace';
    const start = Math.max(0, Math.min(lines.length - 24, app.controller.line >= 0 ? app.controller.line - 6 : 0));
    for (let i = 0; i < 24 && start + i < lines.length; i++) {
      const t = lines[start + i];
      const y = 62 + i * 16.2;
      if (start + i === app.controller.line) {
        g.fillStyle = '#ffd27a';
        g.fillRect(10, y - 12, 486, 16);
      }
      g.fillStyle = '#9aa4ae';
      g.fillText(String(start + i + 1).padStart(3, ' '), 14, y);
      g.fillStyle = t.trim().startsWith(';') ? '#6b7a88' : /CYCLE|POCKET|SLOT|MCALL/.test(t) ? '#0b6e4f' : '#1d2733';
      g.fillText(t.slice(0, 50), 50, y);
    }
    // info pane
    g.fillStyle = '#232a31';
    g.fillRect(506, 44, W - 516, H - 84);
    g.fillStyle = '#c9d3dd';
    g.font = '700 14px "IBM Plex Sans Condensed", Arial';
    g.fillText('JOB', 518, 66);
    g.font = '500 14px "IBM Plex Sans", Arial';
    const info = job ? [`${job.id} ${job.title}`, `${job.drawingNo} rev ${job.rev}`, `${MATERIALS[job.material].short} ${job.stock.x}×${job.stock.y}×${job.stock.z}`, `Difficulty ${'★'.repeat(job.difficulty)}`] : ['Pick a job at the', 'job board'];
    info.forEach((t, i) => { g.fillStyle = '#e6edf5'; g.fillText(t, 518, 88 + i * 21); });
    g.font = '700 14px "IBM Plex Sans Condensed", Arial';
    g.fillStyle = '#c9d3dd';
    g.fillText('PROGRAM CHECK', 518, 196);
    g.font = '500 14px "IBM Plex Sans", Arial';
    const ok = comp && !comp.errors.length;
    g.fillStyle = ok ? '#5fd39a' : '#ff8a8a';
    g.fillText(comp ? (ok ? 'No errors' : `${comp.errors.length} error(s)`) : '—', 518, 218);
    g.fillStyle = '#e6edf5';
    if (comp) g.fillText(`${lines.length} lines · ${comp.ops.length} moves`, 518, 240);
    // toolpath sketch (XY of the compiled program, feed moves)
    if (comp?.ops?.length) {
      const bx = 518, by = 256, bw = W - 540, bh = H - 316;
      g.strokeStyle = '#3a4550';
      g.lineWidth = 1;
      g.strokeRect(bx, by, bw, bh);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const op of comp.ops) {
        if (op.t !== 'move' || op.rapid) continue;
        const p = op.pts;
        for (let i = 0; i < p.length; i += 3) {
          if (p[i] < x0) x0 = p[i];
          if (p[i] > x1) x1 = p[i];
          if (p[i + 1] < y0) y0 = p[i + 1];
          if (p[i + 1] > y1) y1 = p[i + 1];
        }
      }
      if (isFinite(x0)) {
        const sc = Math.min(bw / Math.max(1, x1 - x0), bh / Math.max(1, y1 - y0)) * 0.9;
        const ox = bx + bw / 2 - ((x0 + x1) / 2) * sc, oy = by + bh / 2 + ((y0 + y1) / 2) * sc;
        g.strokeStyle = '#59a8ff';
        g.beginPath();
        let n = 0;
        for (const op of comp.ops) {
          if (op.t !== 'move' || op.rapid) continue;
          const p = op.pts;
          g.moveTo(ox + p[0] * sc, oy - p[1] * sc);
          for (let i = 3; i < p.length; i += 3) g.lineTo(ox + p[i] * sc, oy - p[i + 1] * sc);
          if (++n > 6000) break;
        }
        g.stroke();
      }
    }
    g.fillStyle = '#11151a';
    g.fillRect(0, H - 30, W, 30);
    g.fillStyle = '#9aa6b2';
    g.font = '500 13px "IBM Plex Sans", Arial';
    g.fillText(this.op === 'pc' ? 'Offline programming · the control on the right edits the same program' : 'Use the desk to program offline', 12, H - 10);
    pc.tex.needsUpdate = true;
  }
}
