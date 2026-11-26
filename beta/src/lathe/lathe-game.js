// Manual-lathe workshop game: first person in the shop around the engine lathe, the job flow (job board ->
// drawing -> round bar from the stock rack -> chuck -> turn by hand -> part off -> pick up the part ->
// inspection bench -> measuring instruments -> report), the operator position at the lathe (own camera,
// keyboard handwheels, 3D clickables) and persistence ('milllab.lathe.game').
import * as THREE from 'three';
import { MATERIALS } from '../config.js';
import { FirstPerson } from '../game/fps.js';
import { StockMesh } from './stock-mesh.js';
import { LATHE_JOBS, getLatheJob, BARS, barFits, barLabel, inspectTurned, latheDrawingSVG } from './lathe-jobs.js';
import { CHUCK_FACE_X, CENTER_Y } from './lathe-model.js';
import { HitBox } from '../scene/workshop.js';
import { SPEEDS, FEEDS, PITCHES } from './lathe-sim.js';
import { LatheUI } from './lathe-ui.js';
import { LatheTutorial } from './lathe-tutorial.js';

const KEY = 'milllab.lathe.game';
const GRADE_RANK = { A: 5, B: 4, C: 3, D: 2, FAIL: 1 };
const r3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const TAIL_TOOLS = [
  { id: 'none', label: 'Empty drill chuck', tool: null },
  { id: 'c5', label: 'Centre drill Ø5', tool: { type: 'centre', d: 5 } },
  { id: 'd6', label: 'Twist drill Ø6', tool: { type: 'drill', d: 6 } },
  { id: 'd8', label: 'Twist drill Ø8', tool: { type: 'drill', d: 8 } },
  { id: 'd10', label: 'Twist drill Ø10', tool: { type: 'drill', d: 10 } },
  { id: 'd12', label: 'Twist drill Ø12', tool: { type: 'drill', d: 12 } },
];
export const POST_TOOLS = [
  { label: 'T1 Turning 95°', short: 'Turn' },
  { label: 'T2 Chamfer 45°', short: 'Chamfer' },
  { label: 'T3 Parting 3 mm', short: 'Part' },
  { label: 'T4 Thread 60°', short: 'Thread' },
];
// keyboard handwheels in the operator view: key -> [axis, direction]
const HAND_KEYS = {
  ArrowLeft: ['carriage', 1], KeyA: ['carriage', 1], ArrowRight: ['carriage', -1], KeyD: ['carriage', -1],
  ArrowUp: ['cross', 1], KeyW: ['cross', 1], ArrowDown: ['cross', -1], KeyS: ['cross', -1],
  BracketRight: ['compound', 1], BracketLeft: ['compound', -1],
  PageDown: ['quill', 1], Period: ['quill', 1], PageUp: ['quill', -1], Comma: ['quill', -1],
};
// continuous rates while a key is held (dial divisions per second): normal / Shift (coarse) / Alt (fine)
const RATES = { carriage: [60, 250, 8], cross: [25, 150, 4], compound: [25, 120, 4], quill: [40, 200, 6] };

export class LatheGame {
  constructor(app) {
    this.app = app;
    this.ws = app.workshop;
    this.sim = app.sim;
    this.model = app.model;
    this.s = this.load();
    this.mode = 'workshop';
    this.op = null;
    this.measuring = false;
    this.carry = null; // { kind: 'bar', bar } | { kind: 'part', piece, jobId }
    this.pieces = []; // parted-off parts lying on the bed
    this.plate = null; // part on the inspection plate
    this.report = null;
    this.mlog = []; // measurements of the part on the plate
    this.loaded = null; // { bar, machined } bar in the chuck
    this.prog = this.s.jobId ? { jobId: this.s.jobId, time: 0 } : null;
    this.held = new Map();
    this.mods = { shift: false, alt: false };
    this.step = 1; // dial divisions per scroll notch / tap (1 fine, 10 coarse)
    this._il = [];
    this.cam = { preset: 'work', zoom: 1, yaw: 0, pitch: 0, pos: new THREE.Vector3(), tgt: new THREE.Vector3(), ready: false };
    this._v = new THREE.Vector3();
    this._pieceId = 0;

    const v = app.viewer;
    v.scene.add(v.camera); // carried items are children of the camera
    v.showGizmo = false;
    this.fp = new FirstPerson({ camera: v.camera, dom: v.canvas, container: document.getElementById('viewport'), controls: v.controls });
    this.fp.setColliders(this.ws.colliders);
    this.fp.setInteractables(() => this.interactables(), { occluders: this.ws.occluders });
    this.fp.onInteract = (hit) => this.interact(hit);
    this.fp.onStep = (sp) => this.footstep(sp);
    this.fp.onLockChange = () => this.ui?.syncHud();

    this.buildHand();
    this.buildRackBars();
    this.ui = new LatheUI(this);
    this.ui.build();
    this.tut = new LatheTutorial(this);
    this.fillJobBoard();
    this.bindOpInput();
    this.restoreMachine();

    const pose = this.s.pose && this.validPose(this.s.pose) ? this.s.pose : { pos: [400, 0, 1900], yaw: 0.25, pitch: -0.12 };
    this.fp.enable({ pos: pose.pos, yaw: pose.yaw, pitch: pose.pitch ?? -0.08 });
    this.ui.syncHud();
    if (!this.s.helpSeen) this.ui.showHelp(true);
    addEventListener('beforeunload', () => this.save(true));
    addEventListener('pagehide', () => this.save(true));
  }

  get job() { return getLatheJob(this.s.jobId); }

  // ------------------------------------------------------------------ persistence
  load() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { s = null; }
    return { jobId: null, jobs: {}, helpSeen: false, tutDone: false, pose: null, ...(s || {}) };
  }
  save(now = false) {
    const p = this.fp?.position;
    if (p && !this.op) this.s.pose = { pos: [r3(p.x), 0, r3(p.z)], yaw: this.fp.yaw, pitch: this.fp.pitch };
    // the machine set-up and the (part-turned) bar in the chuck survive a reload
    try { this.s.machine = { sim: this.sim.saveState(), barId: this.loaded?.bar?.id || null, machined: !!this.loaded?.machined }; } catch { /* keep the old snapshot */ }
    const write = () => { try { localStorage.setItem(KEY, JSON.stringify(this.s)); } catch { /* storage blocked */ } };
    clearTimeout(this._saveT);
    if (now) write(); else this._saveT = setTimeout(write, 500);
  }
  restoreMachine() {
    const m = this.s.machine;
    if (!m?.sim) return;
    if (!this.sim.restoreState(m.sim)) return;
    this.sim.drainEvents();
    const st = this.sim.state;
    if (st.stock) {
      const bar = BARS.find((b) => b.id === m.barId) || BARS.find((b) => b.dia === st.stock.dia && b.material === st.stock.material) || null;
      this.loaded = bar ? { bar, machined: !!m.machined } : null;
      if (this.prog && this.job && bar && barFits(bar, this.job)) this.prog.loaded = true;
    }
    this.app.stockChanged();
  }
  validPose(p) {
    if (!p || !Array.isArray(p.pos)) return false;
    const R = this.ws.room;
    if (!(p.pos[0] > R.x0 + 300 && p.pos[0] < R.x1 - 300 && p.pos[2] > R.z0 + 300 && p.pos[2] < R.z1 - 300)) return false;
    return !this.ws.colliders.some((c) => p.pos[0] > c.minX - 280 && p.pos[0] < c.maxX + 280 && p.pos[2] > c.minZ - 280 && p.pos[2] < c.maxZ + 280);
  }

  // ------------------------------------------------------------------ job board, rack
  fillJobBoard() {
    if (!this.ws.setJobBoardSheet) return;
    for (let i = 0; i < 10; i++) {
      const j = LATHE_JOBS[i];
      if (!j) { this.ws.setJobBoardSheet(i, null); continue; }
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(latheDrawingSVG(j, { width: 840, height: 594 }));
      this.ws.setJobBoardSheet(i, img);
    }
  }

  buildRackBars() {
    const slots = this.ws.anchors.stockRackSlots || [];
    this.rackBars = [];
    if (slots.length < 2) return;
    const along = slots[1].position.clone().sub(slots[0].position).setY(0).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), along);
    BARS.forEach((b, i) => {
      const sl = slots[i];
      if (!sl) return;
      const M = MATERIALS[b.material];
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(b.dia / 2, b.dia / 2, b.length * 3, 28),
        new THREE.MeshStandardMaterial({ color: M.raw, metalness: M.metalness, roughness: Math.min(0.9, M.roughness + 0.25) }));
      // rack stock is a long length: the sawn bar is cut from it when you take one
      mesh.quaternion.copy(q);
      mesh.position.copy(sl.position).add(new THREE.Vector3(0, b.dia / 2 + 2, 0));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = 'rack-bar-' + b.id;
      this.app.viewer.scene.add(mesh);
      this.rackBars.push(mesh);
      // shelf tag only (a 1 mm "blank" keeps the rack's own block out of sight)
      this.ws.setRackBlank?.(i, { x: 1, y: 1, z: 1, material: b.material, label: `Ø${b.dia}x${b.length} ${M.short.slice(0, 5).toUpperCase()}` });
    });
  }

  takeBar(id) {
    const b = BARS.find((x) => x.id === id);
    if (!b) return;
    if (this.carry?.kind === 'part') return this.ui.toast('Your hands are full: take the part to the inspection bench first.', 'warn');
    this.carry = { kind: 'bar', bar: b };
    this.app.sound.clunk();
    this.updateHand();
    const j = this.job;
    if (j && !barFits(b, j)) this.ui.toast(`That is ${barLabel(b)}: drawing ${j.drawingNo} calls for Ø${j.bar.dia} × ${j.bar.length} ${MATERIALS[j.material].short.toLowerCase()}.`, 'warn', 5500);
    else this.ui.toast(`Sawn off: ${barLabel(b)} bar. Take it to the lathe and press E on the chuck.`, 'ok', 4500);
    this.ui.syncHud();
  }
  putBackBar() {
    if (this.carry?.kind !== 'bar') return;
    this.carry = null;
    this.updateHand();
    this.ui.toast('Bar put back on the rack.', 'info');
    this.ui.syncHud();
  }

  // ------------------------------------------------------------------ chuck
  loadBar(stickout, tighten = true) {
    const sim = this.sim, b = this.carry?.bar;
    if (!b) return false;
    if (Math.abs(sim.state.spindle.w) > 1) { this.ui.toast('Stop the spindle first.', 'warn'); return false; }
    stickout = clamp(Math.round(stickout), 10, b.length - 15);
    if (!sim.loadStock({ dia: b.dia, length: b.length, stickout, material: b.material, clamp: !!tighten })) {
      this.ui.toast(sim.state.message || 'The bar does not fit the chuck.', 'warn');
      return false;
    }
    this.loaded = { bar: b, machined: false };
    this.carry = null;
    this.app.stockChanged();
    this.updateHand();
    if (this.prog && this.job && barFits(b, this.job)) this.prog.loaded = true;
    this.ui.toast(`Bar in the chuck, ${stickout} mm out of the jaws${tighten ? ', chuck tightened' : ' (chuck still open)'}.`, 'ok');
    this.ui.syncHud();
    return true;
  }
  setChuck(clamped) {
    const sim = this.sim;
    if (!sim.state.stock) return this.ui.toast('The chuck is empty.', 'info');
    if (!sim.clampChuck(clamped)) return this.ui.toast(sim.state.message || 'Stop the spindle first.', 'warn');
    this.ui.toast(clamped ? 'Chuck tightened with the key (do not leave the key in!).' : 'Chuck opened.', 'info');
  }
  removeBar() {
    const sim = this.sim, st = sim.state;
    if (!st.stock) return;
    if (Math.abs(st.spindle.w) > 1) return this.ui.toast('Stop the spindle first.', 'warn');
    if (this.carry) return this.ui.toast('Your hands are full.', 'warn');
    const machined = this.loaded?.machined || (sim.profile && sim.profile.mach.some((m) => m));
    const bar = this.loaded?.bar;
    sim.removeStock();
    this.app.stockChanged();
    if (!machined && bar) {
      this.carry = { kind: 'bar', bar };
      this.ui.toast('Bar out of the chuck: in your hands.', 'info');
    } else {
      this.ui.toast('The bar end goes into the scrap bin.', 'info');
    }
    this.loaded = null;
    this.updateHand();
    this.ui.syncHud();
  }

  // ------------------------------------------------------------------ parted-off pieces
  onPartedOff(piece) {
    const mesh = new StockMesh({ profile: piece.profile, material: piece.material, segments: 48 });
    const g = new THREE.Group();
    g.name = 'parted-piece';
    g.add(mesh.group);
    // generous pick box around the (small) part so it is easy to grab out of the tray
    const pr = piece.profile, pad = Math.max(110, pr.rBound + 70); // reaches out past the chip-tray lip
    g.add(new HitBox(new THREE.Vector3(pr.zMin - 25, -pad, -pad), new THREE.Vector3(pr.zMax + 25, pad, pad)));
    g.position.set(CHUCK_FACE_X, CENTER_Y, 0);
    g.rotation.x = this.app.vis.angle;
    this.app.viewer.scene.add(g);
    const r = piece.profile.rBound;
    // it drops through the bed gap and rolls forward into the chip tray (where you can reach it)
    const x0 = g.position.x + (piece.profile.zMin + piece.profile.zMax) / 2;
    const p = { id: ++this._pieceId, piece, group: g, mesh, vy: 0, dx: clamp(Math.max(-400, CHUCK_FACE_X + this.sim.ax.carriage.pos + 20 + 215), -400, 470) - x0, vz: 260 + Math.random() * 60, zEnd: 225 - r, spin: (Math.random() - 0.5) * 6, settled: false, floor: 597 + r, jobId: this.s.jobId };
    this.pieces.push(p);
    if (this.loaded) this.loaded.machined = true;
    if (this.prog && this.job) this.prog.parted = true;
    this.ui.toast(`Parted off: ${piece.length.toFixed(2)} mm long, ${piece.massG} g. It dropped into the chip tray: stop the spindle and pick it up.`, 'ok', 5000);
  }

  updatePieces(dt) {
    for (const p of this.pieces) {
      if (!p.settled) {
        p.vy -= 9810 * dt;
        p.group.position.y += p.vy * dt;
        p.group.rotation.x += p.spin * dt;
        if (p.group.position.y <= p.floor) {
          p.group.position.y = p.floor;
          if (Math.abs(p.vy) > 400) { p.vy = -p.vy * 0.25; this.app.sound.noiseBurst?.(1800, 2, 0.001, 0.12, 0.3, 'bandpass'); } else { p.vy = 0; if (Math.abs(p.dx) < 1 && p.group.position.z >= p.zEnd - 1) p.settled = true; }
        }
        p.group.position.z = Math.min(p.zEnd, p.group.position.z + p.vz * dt);
        const mx = p.dx * Math.min(1, dt * 3);
        p.group.position.x += mx;
        p.dx -= mx;
      }
      p.mesh.update(performance.now() / 1000);
    }
  }

  pickUpPiece(id) {
    const p = this.pieces.find((x) => x.id === id);
    if (!p) return;
    if (Math.abs(this.sim.state.spindle.w) > 1) return this.ui.toast('Stop the spindle before you reach into the lathe!', 'warn');
    if (this.carry) return this.ui.toast('Your hands are full.', 'warn');
    this.app.viewer.scene.remove(p.group);
    p.mesh.dispose();
    this.pieces = this.pieces.filter((x) => x !== p);
    this.carry = { kind: 'part', piece: p.piece, jobId: p.jobId };
    this.updateHand();
    this.ui.toast('Part in your hands: take it to the inspection bench (left wall).', 'info', 4000);
    this.ui.syncHud();
  }

  // ------------------------------------------------------------------ the hand (carried item)
  buildHand() {
    this.hand = new THREE.Group();
    this.hand.name = 'lathe-hand';
    this.hand.position.set(210, -230, -520);
    this.hand.rotation.set(0.25, -0.5, 0.1);
    this.app.viewer.camera.add(this.hand);
  }
  updateHand() {
    const h = this.hand;
    while (h.children.length) {
      const o = h.children.pop();
      o.userData.dispose?.();
      o.traverse?.((c) => { if (c.isMesh && !c.userData.shared) c.geometry?.dispose(); });
    }
    if (!this.carry) { h.visible = false; return; }
    if (this.carry.kind === 'bar') {
      const b = this.carry.bar, M = MATERIALS[b.material];
      const m = new THREE.Mesh(new THREE.CylinderGeometry(b.dia / 2, b.dia / 2, b.length, 28), new THREE.MeshStandardMaterial({ color: M.raw, metalness: M.metalness, roughness: Math.min(0.9, M.roughness + 0.25) }));
      m.rotation.z = Math.PI / 2;
      h.add(m);
    } else {
      const pr = this.carry.piece.profile;
      const sm = new StockMesh({ profile: pr, material: this.carry.piece.material, segments: 40 });
      sm.update(0, true, true);
      sm.group.position.x = -(pr.zMin + pr.zMax) / 2;
      const w = new THREE.Group();
      w.add(sm.group);
      w.userData.dispose = () => sm.dispose();
      h.add(w);
    }
    h.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.renderOrder = 2; } });
    this.syncHandVisible();
  }
  syncHandVisible() { this.hand.visible = !!this.carry && !this.op && !this.measuring && !this.ui?.topModal(); }

  // ------------------------------------------------------------------ jobs
  acceptJob(id) {
    const j = getLatheJob(id);
    if (!j) return;
    this.s.jobId = id;
    this.prog = { jobId: id, time: 0 };
    if (this.loaded && barFits(this.loaded.bar, j)) this.prog.loaded = true;
    this.save();
    this.ui.toast(`Job ${j.id} accepted: ${j.title}. Fetch a Ø${j.bar.dia} ${MATERIALS[j.material].short.toLowerCase()} bar from the stock rack.`, 'ok', 5000);
    this.ui.syncHud();
  }

  objectives() {
    const j = this.job, p = this.prog || {};
    const carryBar = this.carry?.kind === 'bar' && j && barFits(this.carry.bar, j);
    const steps = [
      { t: 'Pick a job at the job board', done: !!j },
      { t: j ? `Get a Ø${j.bar.dia} × ${j.bar.length} ${MATERIALS[j.material].short.toLowerCase()} bar from the stock rack` : 'Get the bar from the stock rack', done: !!(p.loaded || carryBar) },
      { t: 'Chuck it, close the guard', done: !!p.loaded && !this.sim.state.guardOpen || !!p.parted },
      { t: 'Turn it to the drawing', done: !!p.parted, sub: j ? `${j.segs.length} diameter${j.segs.length > 1 ? 's' : ''}${j.chamfer ? ', chamfer' : ''}${j.bore ? ', drill' : ''}${j.thread ? ', thread' : ''}` : '' },
      { t: j ? `Part it off ${j.length} mm long` : 'Part it off', done: !!p.parted },
      { t: 'Inspect it at the inspection bench', done: !!p.inspected },
    ];
    let next = steps.findIndex((s) => !s.done);
    return { job: j, steps, next, done: !!p.done, time: p.time || 0 };
  }

  // ------------------------------------------------------------------ inspection
  placeOnPlate() {
    const c = this.carry;
    if (c?.kind !== 'part') return;
    const part = getLatheJob(c.jobId) || this.job;
    if (!part) return this.ui.toast('Accept a job at the job board first: the inspection compares the part with its drawing.', 'warn', 5000);
    const report = inspectTurned(part, { profile: c.piece.profile, material: c.piece.material });
    this.showOnPlate(c.piece, part);
    this.carry = null;
    this.updateHand();
    this.app.sound.clunk();
    this.mlog = [];
    const p = this.prog && this.prog.jobId === part.id ? this.prog : null;
    const time = p ? p.time : null;
    const best = this.s.jobs[part.id]?.best;
    const isBest = !best || GRADE_RANK[report.grade] > GRADE_RANK[best.grade] || (report.grade === best.grade && report.score > best.score);
    const rec = this.s.jobs[part.id] || (this.s.jobs[part.id] = { attempts: 0 });
    rec.attempts = (rec.attempts || 0) + 1;
    if (isBest) rec.best = { grade: report.grade, score: Math.round(report.score), time: time != null ? Math.round(time) : null, at: Date.now() };
    if (p) { p.inspected = true; if (report.grade !== 'FAIL') p.done = true; }
    this.report = { report, part, piece: c.piece, time, isBest, prevBest: best, complete: report.grade !== 'FAIL' };
    this.save();
    this.ui.openReport(this.report);
    this.ui.toast(report.grade === 'FAIL' ? `Inspection: FAIL (${Math.round(report.score)})` : `Inspection: grade ${report.grade} (${Math.round(report.score)}/100)`, report.grade === 'FAIL' ? 'warn' : 'ok', 4000);
  }
  showOnPlate(piece, part) {
    this.clearPlate();
    const mesh = new StockMesh({ profile: piece.profile, material: piece.material, segments: 56 });
    mesh.update(0, true, true);
    const holder = new THREE.Group();
    holder.name = 'inspection-part';
    const inner = new THREE.Group();
    inner.position.set(-(piece.profile.zMin + piece.profile.zMax) / 2, piece.profile.rBound, 0);
    inner.add(mesh.group);
    holder.add(inner);
    const a = this.ws.anchors.inspectionPlate;
    holder.position.copy(a);
    holder.rotation.y = Math.PI / 2;
    mesh.group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.app.viewer.scene.add(holder);
    this.plate = { piece, part, holder, mesh };
  }
  clearPlate() {
    if (!this.plate) return;
    this.app.viewer.scene.remove(this.plate.holder);
    this.plate.mesh.dispose();
    this.plate = null;
  }

  // ------------------------------------------------------------------ interactables (walking)
  interactables() {
    const L = this._il;
    L.length = 0;
    if (this.op || this.measuring) return L;
    const carryBar = this.carry?.kind === 'bar', carryPart = this.carry?.kind === 'part';
    for (const e of this.ws.interactables) {
      let label = e.label;
      if (e.id === 'stockRack') label = carryBar ? 'Put the bar back / take another' : carryPart ? 'Stock rack (hands full)' : 'Take a round bar from the stock rack';
      else if (e.id === 'inspection') label = carryPart ? 'Put the part on the surface plate and inspect it' : this.plate ? 'Read the inspection report' : 'Inspection bench';
      else if (e.id === 'toolCrib') label = 'Look at the lathe tooling';
      else if (e.id === 'pcDesk') label = 'CAM computer (for the CNC mill)';
      else if (e.id === 'drawingDesk') label = this.job ? 'Read the drawing' : 'Look at the drawings';
      else if (e.id === 'jobBoard') label = 'Read the job board';
      L.push({ object: e.object, id: e.id, label });
    }
    const st = this.sim.state;
    let cl;
    if (!st.stock) cl = carryBar ? 'Put the bar in the chuck' : 'Chuck (empty): fetch a bar from the stock rack';
    else cl = st.chuck.clamped ? 'Chuck: open it / take the bar out' : 'Chuck: tighten it / take the bar out';
    L.push({ object: this.model.spinGroup, id: 'chuck', label: cl });
    for (const p of this.pieces) if (p.settled) L.push({ object: p.group, id: 'piece:' + p.id, label: 'Pick up the parted-off part' });
    for (const c of this.model.clickables) if (c.action !== 'chuck') L.push({ object: c.object, id: 'lc:' + c.action, label: 'Work at the lathe' });
    L.push({ object: this.model.root, id: 'lathe', label: 'Work at the lathe (operator position)' });
    if (this.plate) L.push({ object: this.plate.holder, id: 'platePart', label: 'Measure the part' });
    return L;
  }

  interact(hit) {
    const id = hit.id;
    this.app.sound.init?.();
    if (id === 'jobBoard') {
      const slot = this.ws.jobBoardSlotAt?.(hit.point) ?? -1;
      if (slot >= 0 && LATHE_JOBS[slot]) this.ui.openDrawing(LATHE_JOBS[slot]);
      else this.ui.openJobs();
    } else if (id === 'stockRack') {
      if (this.carry?.kind === 'part') this.ui.toast('Take the finished part to the inspection bench first.', 'warn');
      else this.ui.openRack();
    } else if (id === 'inspection' || id === 'platePart') {
      if (this.carry?.kind === 'part') this.placeOnPlate();
      else if (id === 'platePart' && this.plate) this.ui.openMeasure();
      else if (this.report) this.ui.openReport(this.report);
      else this.ui.toast('Bring a parted-off part here to inspect it.', 'info');
    } else if (id === 'toolCrib') this.ui.openTooling();
    else if (id === 'pcDesk') this.ui.toast('The CAM computer programs the CNC mill. On the engine lathe, you are the control!', 'info', 4500);
    else if (id === 'drawingDesk') { if (this.job) this.ui.openDrawing(this.job); else this.ui.openJobs(); }
    else if (id === 'chuck') this.ui.openChuck();
    else if (id.startsWith('piece:')) this.pickUpPiece(+id.slice(6));
    else if (id === 'lathe' || id.startsWith('lc:')) {
      // a part lying in the chip tray right where you are looking: pick it up rather than step up to the lathe
      const p = this.pieceAlongView();
      if (p) this.pickUpPiece(p.id); else this.enterOp();
    }
  }

  pieceAlongView() {
    const cam = this.app.viewer.camera, o = cam.getWorldPosition(new THREE.Vector3()), d = cam.getWorldDirection(new THREE.Vector3());
    let best = null, bd = Infinity;
    for (const p of this.pieces) {
      if (!p.settled) continue;
      const c = p.group.getWorldPosition(new THREE.Vector3()).sub(o);
      const t = c.dot(d);
      if (t < 0 || t > 2600) continue;
      const off = c.addScaledVector(d, -t).length();
      if (off < Math.max(90, p.piece.profile.rBound + 60) && off < bd) { bd = off; best = p; }
    }
    return best;
  }

  footstep(speed) {
    const snd = this.app.sound;
    if (!snd.ready?.() || this.app.settings.muted) return;
    const k = Math.min(1.3, speed / 1500);
    snd.noiseBurst(150 + Math.random() * 90, 0.9, 0.003, 0.08 + Math.random() * 0.03, 0.09 * k, 'lowpass');
  }

  // ------------------------------------------------------------------ operator position
  enterOp() {
    if (this.op) return;
    this.ui.closeAll();
    this.op = 'lathe';
    this.fp.frozen = true;
    document.body.classList.add('op', 'lt-op');
    const c = this.cam, cam = this.app.viewer.camera;
    c.pos.copy(cam.position);
    c.tgt.copy(this.fp.getLookTarget(1200, new THREE.Vector3()));
    c.ready = true;
    c.yaw = 0; c.pitch = 0;
    cam.fov = 42;
    cam.updateProjectionMatrix();
    this.syncHandVisible();
    this.ui.syncHud();
    this.ui.panel.show(true);
  }
  exitOp() {
    if (!this.op) return;
    this.op = null;
    this.held.clear();
    document.body.classList.remove('op', 'lt-op');
    this.app.viewer.setCenter(null);
    this.ui.panel.show(false);
    const cam = this.app.viewer.camera;
    this.fp.fov = this.fp.opts.fov;
    const x = clamp(cam.position.x, -900, 900);
    this.fp.setPose({ pos: [x, 0, 820], yaw: 0, pitch: -0.18 });
    this.fp.frozen = false;
    this.syncHandVisible();
    this.ui.syncHud();
  }

  setView(preset) {
    this.cam.preset = preset;
    this.cam.yaw = 0; this.cam.pitch = 0; this.cam.zoom = 1;
  }

  opCamGoal(outPos, outTgt) {
    const c = this.cam, sim = this.sim, st = sim.state;
    const tip = sim.toolTip();
    const end = sim.endZ() ?? 40;
    const tipX = CHUCK_FACE_X + tip.z;
    let tx;
    switch (c.preset) {
      case 'top':
        tx = clamp(CHUCK_FACE_X + Math.min(tip.z, end + 30) * 0.7 + 10, -560, 500);
        outTgt.set(tx, CENTER_Y, 10);
        outPos.set(0, 520, 60);
        break;
      case 'wide':
        outTgt.set(-150, 1010, 0);
        outPos.set(420, 640, 1750);
        break;
      case 'tail': {
        const tt = CHUCK_FACE_X + (st.tailstock.z - st.tailstock.quill);
        outTgt.set(clamp((CHUCK_FACE_X + end + tt) / 2, -560, 600), CENTER_Y, 0);
        outPos.set(560, 230, 520);
        break;
      }
      default:
        tx = clamp(0.5 * tipX + 0.5 * (CHUCK_FACE_X + Math.min(end, 90)) + 10, -540, 600);
        // from the operator's position, a little toward the tailstock and high enough to look past the
        // tool post: tool tip, the work and the chuck face all in view
        outTgt.set(tx, 1090, 0);
        outPos.set(420, 640, 480);
    }
    // user orbit / zoom around the target
    const off = outPos;
    const r = off.length() * c.zoom;
    const yaw0 = Math.atan2(off.x, off.z) + c.yaw;
    const pitch0 = clamp(Math.asin(off.y / off.length()) + c.pitch, -0.2, 1.52);
    off.set(Math.sin(yaw0) * Math.cos(pitch0) * r, Math.sin(pitch0) * r, Math.cos(yaw0) * Math.cos(pitch0) * r);
    outPos.add(outTgt);
    void tipX;
  }

  driveCamera(dt) {
    if (!this.op) {
      this.fp.update(dt);
      return true;
    }
    const c = this.cam, cam = this.app.viewer.camera;
    const gp = this._gp || (this._gp = new THREE.Vector3()), gt = this._gt || (this._gt = new THREE.Vector3());
    this.opCamGoal(gp, gt);
    const k = 1 - Math.exp(-dt * 5);
    c.pos.lerp(gp, k);
    c.tgt.lerp(gt, k);
    cam.position.copy(c.pos);
    cam.lookAt(c.tgt);
    cam.updateMatrixWorld();
    return true;
  }

  // ------------------------------------------------------------------ operator input (3D clicks, wheel, keys)
  bindOpInput() {
    const v = this.app.viewer, cv = v.canvas;
    let down = null;
    cv.addEventListener('pointerdown', (e) => {
      if (!this.op || e.button > 2) return;
      down = { x: e.clientX, y: e.clientY, moved: false, yaw: this.cam.yaw, pitch: this.cam.pitch, id: e.pointerId };
      cv.setPointerCapture?.(e.pointerId);
    });
    cv.addEventListener('pointermove', (e) => {
      if (!this.op || !down) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (Math.hypot(dx, dy) > 5) down.moved = true;
      if (down.moved) {
        this.cam.yaw = clamp(down.yaw - dx * 0.005, -1.4, 1.4);
        this.cam.pitch = clamp(down.pitch + dy * 0.004, -0.9, 0.9);
      }
    });
    const up = (e) => {
      if (!this.op || !down) return;
      const d = down;
      down = null;
      if (!d.moved) this.clickAt(e.clientX, e.clientY, e);
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', () => { down = null; });
    cv.addEventListener('wheel', (e) => {
      if (!this.op) return;
      e.preventDefault();
      const hit = this.pickClickable(e.clientX, e.clientY);
      const wheels = { carriageWheel: 'carriage', crossWheel: 'cross', compoundWheel: 'compound', tailWheel: 'quill' };
      if (hit && wheels[hit]) {
        const n = (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 10 : this.step);
        this.turn(wheels[hit], n);
        this.ui.panel.flashWheel(wheels[hit]);
      } else {
        this.cam.zoom = clamp(this.cam.zoom * (e.deltaY > 0 ? 1.1 : 1 / 1.1), 0.35, 2.4);
      }
    }, { passive: false });
    addEventListener('keydown', (e) => this.onKey(e, true));
    addEventListener('keyup', (e) => this.onKey(e, false));
    addEventListener('blur', () => this.held.clear());
  }

  pickClickable(x, y) {
    const objs = this.model.clickables.map((c) => c.object);
    const ray = this.app.viewer.setPointer(x, y);
    const hits = ray.intersectObjects(objs, true);
    for (const h of hits) {
      for (let o = h.object; o; o = o.parent) if (o.userData.action) return o.userData.action;
    }
    return null;
  }

  clickAt(x, y, e) {
    const a = this.pickClickable(x, y);
    if (!a) return;
    const st = this.sim.state, sh = e?.shiftKey;
    const wheels = { carriageWheel: 'carriage', crossWheel: 'cross', compoundWheel: 'compound', tailWheel: 'quill' };
    if (wheels[a]) { this.ui.panel.flashWheel(wheels[a]); this.ui.toast('Scroll the mouse wheel over a handwheel to turn it, or use the dials in the panel.', 'info', 3000); return; }
    switch (a) {
      case 'spindleLever': this.act('spindle', sh ? -1 : st.spindle.dir ? 0 : 1); break;
      case 'feedLever': this.act('feed', st.feed.engaged !== 'off' ? 'off' : sh ? 'cross' : 'long'); break;
      case 'halfNut': this.act('halfNut', !(st.halfNut || st.halfNutPending)); break;
      case 'feedDir': this.act('feedDir', -st.feed.dir); break;
      case 'estop': this.act('estop', !st.estop); break;
      case 'speedSelector': this.act('gear', st.gear + (sh ? -1 : 1)); break;
      case 'rangeLever': this.act('gear', st.gear >= 6 ? st.gear - 6 : st.gear + 6); break;
      case 'gearboxA': case 'gearboxB': this.act('feedIndex', (st.feed.index + (sh ? FEEDS.length - 1 : 1)) % FEEDS.length); break;
      case 'gearboxC': this.act('pitch', (st.threadIndex + (sh ? PITCHES.length - 1 : 1)) % PITCHES.length); break;
      case 'tailClamp': this.act('tailLock', !st.tailstock.locked); break;
      case 'quillLock': this.ui.toast('Quill lock: the quill stays where the handwheel puts it.', 'info'); break;
      case 'toolPost': this.act('tool', (st.toolIndex + (sh ? 3 : 1)) % 4); break;
      case 'chuck': this.ui.openChuck(); break;
      case 'guard': this.act('guard', !st.guardOpen); break;
      case 'brake': this.act('brake'); break;
      case 'light': this.act('light', !this.app.vis.light); break;
      case 'coolant': this.act('coolant', !st.coolant); break;
      default: break;
    }
  }

  onKey(e, down) {
    if (e.shiftKey !== undefined) { this.mods.shift = e.shiftKey; this.mods.alt = e.altKey; }
    if (!this.op || (down && e.defaultPrevented)) return; // e.g. Esc that just closed a dialog
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && t.type !== 'range')) return;
    if (this.ui.topModal() || this.measuring) return;
    const code = e.code;
    const hk = HAND_KEYS[code];
    if (hk) {
      e.preventDefault();
      if (down) {
        if (!this.held.has(code)) {
          this.held.set(code, { axis: hk[0], dir: hk[1], t: 0 });
          this.turn(hk[0], hk[1] * (e.shiftKey ? 10 : this.step));
        }
      } else this.held.delete(code);
      return;
    }
    if (!down || e.repeat || e.ctrlKey || e.metaKey) return;
    const st = this.sim.state;
    let used = true;
    if (code === 'Escape') this.exitOp();
    else if (code === 'Space') this.act('spindle', st.spindle.dir ? 0 : e.shiftKey ? -1 : 1);
    else if (code === 'KeyF') this.act('feed', st.feed.engaged !== 'off' ? 'off' : e.shiftKey ? 'cross' : 'long');
    else if (code === 'KeyR') this.act('feedDir', -st.feed.dir);
    else if (code === 'KeyN') this.act('halfNut', !(st.halfNut || st.halfNutPending));
    else if (/^Digit[1-4]$/.test(code)) this.act('tool', +code.slice(5) - 1);
    else if (code === 'KeyC') this.act('coolant', !st.coolant);
    else if (code === 'KeyG') this.act('guard', !st.guardOpen);
    else if (code === 'KeyX') this.act('estop', !st.estop);
    else if (code === 'KeyV') this.setView({ work: 'top', top: 'tail', tail: 'wide', wide: 'work' }[this.cam.preset] || 'work');
    else if (code === 'KeyZ') this.act('zeroDial', e.shiftKey ? 'carriage' : 'cross');
    else if (code === 'Equal' || code === 'NumpadAdd') this.act('gear', st.gear + 1);
    else if (code === 'Minus' || code === 'NumpadSubtract') this.act('gear', st.gear - 1);
    else if (code === 'Tab') { this.step = this.step === 1 ? 10 : 1; this.ui.panel.refresh(true); }
    else used = false;
    if (used) e.preventDefault();
  }

  // hand-wheel turn (dial divisions, + = clockwise = advance)
  turn(axis, div) {
    if (!div) return;
    const sim = this.sim;
    if (axis === 'carriage') sim.turnCarriage(div);
    else if (axis === 'cross') sim.turnCross(div);
    else if (axis === 'compound') sim.turnCompound(div);
    else if (axis === 'quill') {
      if (sim.state.tailstock.locked === false) this.ui.toast('Lock the tailstock to the bed before drilling.', 'info', 2500);
      sim.turnTailQuill(div);
    }
    if (sim.state.cut.active && this.loaded) this.loaded.machined = true;
  }

  // every control goes through here (panel buttons, 3D levers, keys); refusals become toasts
  act(name, v) {
    const sim = this.sim, st = sim.state;
    let ok = true;
    switch (name) {
      case 'spindle': ok = sim.setSpindle(v); break;
      case 'brake': sim.setSpindle(0); sim.setBrake(true); break;
      case 'gear': ok = sim.setGear(clamp(v, 0, SPEEDS.length - 1)); break;
      case 'feedIndex': sim.setFeedIndex(v); break;
      case 'feed':
        ok = sim.engageFeed(v);
        if (ok && v !== 'off' && Math.abs(st.spindle.w) < 5) this.ui.toast('Power feed engaged: it only moves while the spindle turns.', 'info');
        break;
      case 'feedDir': sim.setFeedDir(v); break;
      case 'halfNut': ok = sim.setHalfNut(v); break;
      case 'pitch': sim.setThreadIndex(v); break;
      case 'compoundAngle': sim.setCompoundAngle(clamp(v, -60, 60)); break;
      case 'tool': ok = sim.indexTool(v); break;
      case 'tailTool': this.setTailTool(v); break;
      case 'tailLock': sim.lockTailstock(v); break;
      case 'tailSlide': {
        const len = this.model.tailToolLen || 0;
        const z = st.tailstock.z, maxZ = 640 - len;
        const dz = clamp(z + v, 60, maxZ) - z;
        ok = sim.slideTailstock(dz);
        break;
      }
      case 'guard': sim.setGuard(v); this.app.sound.door?.(); break;
      case 'coolant': sim.setCoolant(v); break;
      case 'light': this.app.vis.light = !!v; break;
      case 'estop': sim.setEstop(v); break;
      case 'reset': ok = sim.resetAlarm(); if (ok) this.ui.toast('Alarm reset. Fresh inserts fitted where a tool was broken.', 'ok'); break;
      case 'zeroDial': sim.zeroDial(v); this.app.sound.click(); break;
      case 'zeroDro': sim.zeroDro(v); this.app.sound.click(); break;
      case 'chuck': this.ui.openChuck(); break;
      default: ok = false;
    }
    if (!ok && st.message) this.ui.toast(st.message, 'warn', 3500);
    this.ui.panel?.refresh(true);
    this.tut?.poke();
    return ok;
  }

  setTailTool(id) {
    const t = TAIL_TOOLS.find((x) => x.id === id) || TAIL_TOOLS[0];
    const st = this.sim.state;
    if (Math.abs(st.spindle.w) > 1 && st.tailstock.quill > 0.5) return this.ui.toast('Retract the quill and stop the spindle before changing the drill.', 'warn');
    const m = this.model, prev = st.tailstock.tool, oldLen = m.tailToolLen || 0;
    m.setTailTool(t.tool);
    const nl = m.tailToolLen || 0;
    // the tailstock body stays where it is: a longer drill must not end up inside the work
    const z = st.tailstock.z - (nl - oldLen), end = this.sim.endZ();
    if (end != null && z - st.tailstock.quill < end + 3) {
      m.setTailTool(prev);
      return this.ui.toast('No room for that drill: slide the tailstock back first (unlock it).', 'warn', 4000);
    }
    this.sim.setTailTool(t.tool);
    st.tailstock.z = z;
    this.ui.toast(`${t.label} in the tailstock drill chuck.`, 'info');
  }

  onCrash(e) {
    const msg = e.hard ? `CRASH: ${this.sim.state.message}. Reset the alarm, back the tool off and check it.` : this.sim.state.message;
    if (msg) this.ui.toast(msg, 'warn', 5000);
  }
  onSimEvent(e) {
    if (e.type === 'halfNutIn') this.ui.toast(e.ok ? `Half nut in on thread-dial mark ${e.mark}.` : this.sim.state.message, e.ok ? 'info' : 'warn', e.ok ? 2200 : 5500);
    this.tut?.onEvent(e);
  }

  // ------------------------------------------------------------------ frame
  update(dt) {
    if (!(dt > 0)) dt = 0;
    // held handwheel keys: a tap turned one step; holding keeps the wheel turning
    for (const h of this.held.values()) {
      h.t += dt;
      if (h.t < 0.22) continue;
      const r = RATES[h.axis];
      const rate = this.mods.shift ? r[1] : this.mods.alt ? r[2] : r[0];
      h.acc = (h.acc || 0) + rate * dt;
      const n = Math.floor(h.acc);
      if (n) { h.acc -= n; this.turn(h.axis, n * h.dir); }
    }
    if (this.prog && !this.prog.done && !document.hidden) this.prog.time = (this.prog.time || 0) + dt;
    this.tut?.update(dt);
    this.ui.update(dt);
    this.syncHandVisible();
    // bar pulled from the rack is hidden on the rack while it is in your hands / the chuck (unmachined)
    if (this.rackBars) {
      const hid = this.carry?.kind === 'bar' ? this.carry.bar.id : null;
      BARS.forEach((b, i) => { if (this.rackBars[i]) this.rackBars[i].scale.y = hid === b.id ? 0.66 : 1; });
    }
  }
}
