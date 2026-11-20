// Interactive tutorial for the workshop game: makes the tutorial part T01 from the job board to the
// measured part. Every step explains one thing and advances by itself when the real game / control
// state shows it is done (pure explanation steps have a Next button). Guidance: a tutorial card, a
// spotlight ring + pointer bubble around the exact control to press (positioned live), a 3D waypoint
// (arrow, beacon, floor ring) over the next place to walk to with an edge arrow when it is off-screen,
// and highlights on the drawing sheet. Loaded lazily by game.js: no cost while it is not running.
import * as THREE from 'three';
import { CYCLES } from '../gcode/sinucycles.js';
import { findCall, formatCall } from '../ui/cycleforms.js';
import { DRILL_POINT_K } from './parts.js';
import { MATERIALS } from '../config.js';
import { MARK_RE } from './tutorial-template.js';
import { haasSteps, fillHaas } from './tutorial-haas.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
const r3 = (v) => Math.round(v * 1000) / 1000;
const num = (v) => (v === '' || v == null ? null : Number(v));
const TPROG = 'JOB_T01.MPF';

// ------------------------------------------------------------------ expected cycle values
// The values the player types into the programGUIDE forms. Taken from tutorial-part.js
// (TUTORIAL_PROGRAM_STEPS) when it provides them, otherwise derived from the drawing.
const CHECK_KEYS = {
  CYCLE71: ['RFP', 'DP', 'PA', 'PO', 'LENG', 'WID'],
  POCKET3: ['RFP', 'DP', 'LENG', 'WID', 'CRAD', 'PA', 'PO'],
  CYCLE81: ['RFP', 'DP'],
  CYCLE82: ['RFP', 'DP'],
  CYCLE83: ['RFP', 'DP'],
};

function toKeyed(name, vals) {
  const P = CYCLES[name]?.params || [];
  const out = {};
  if (Array.isArray(vals)) P.forEach((p, i) => { out[p.k] = vals[i] ?? ''; });
  else if (vals && typeof vals === 'object') for (const p of P) if (vals[p.k] !== undefined) out[p.k] = vals[p.k];
  return out;
}

export function deriveSteps(part) {
  const face = r3(part.stock.z - part.size.z);
  const pocket = part.features.find((f) => f.type === 'pocketRect');
  const holes = part.features.filter((f) => f.type === 'hole');
  const steps = [];
  steps.push({ op: 'face', cycle: 'CYCLE71', values: { RTP: 10, RFP: 0, SDIS: 2, DP: -face, PA: 0, PO: 0, LENG: part.size.x, WID: part.size.y, STA: 0, MID: 1, MIDA: '', FDP: 5, FALD: 0, FFP1: 1300, VARI: 31, FDP1: 5 } });
  if (pocket) steps.push({ op: 'pocket', cycle: 'POCKET3', featureId: pocket.id, values: { RTP: 10, RFP: -face, SDIS: 2, DP: r3(-face - pocket.depth), LENG: pocket.w, WID: pocket.h, CRAD: pocket.r, PA: pocket.x, PO: pocket.y, STA: pocket.rot || 0, MID: 2.5, FAL: 0, FALD: 0, FFP1: 1400, FFD: 400, CDIR: 0, VARI: 11, MIDA: '', AP1: '', AP2: '', AD: '', RAD1: 3, DP1: 1 } });
  if (holes.length) {
    const h = holes[0];
    const tip = r3(-face - h.depth - (h.d / 2) * DRILL_POINT_K);
    steps.push({ op: 'drill', cycle: 'CYCLE81', modal: true, count: 1, holes: holes.map((x) => ({ id: x.id, x: x.x, y: x.y })), values: { RTP: 10, RFP: -face, SDIS: 2, DP: Math.round(tip * 100) / 100, DPR: '' } });
  }
  return steps;
}

// Normalise TUTORIAL_PROGRAM_STEPS (tutorial-part.js) to [{ op, cycle, modal, values: {KEY: v}, keys,
// fields: {KEY: {label, why, edit}}, intro, count }]; anything missing is derived from the drawing.
export function programSteps(part, given) {
  const derived = deriveSteps(part);
  const out = [];
  for (const s of Array.isArray(given) ? given : []) {
    const cycle = String(s.cycle || '').toUpperCase();
    if (!CYCLES[cycle]) continue;
    const values = toKeyed(cycle, s.formValues || s.values || {});
    const fields = {};
    for (const f of s.fields || []) fields[f.key] = f;
    const edit = (s.fields || []).filter((f) => f.edit).map((f) => f.key);
    const keys = [...new Set([...(CHECK_KEYS[cycle] || []), ...edit])];
    const op = s.id || (/CYCLE71/.test(cycle) ? 'face' : /POCKET/.test(cycle) ? 'pocket' : 'drill');
    out.push({ op, cycle, modal: !!s.modal, values, keys, fields, intro: s.intro || '', title: s.title, group: s.group, src: s, count: 1 });
  }
  for (const d of derived) if (!out.some((x) => x.op === d.op)) out.push(d);
  const order = { face: 0, pocket: 1, drill: 2 };
  out.sort((a, b) => (order[a.op] ?? 9) - (order[b.op] ?? 9));
  return out;
}

// ------------------------------------------------------------------ 3D waypoint
function buildMarker() {
  const g = new THREE.Group();
  g.name = 'tutorial-waypoint';
  const mat = (o) => new THREE.MeshBasicMaterial({ color: 0xffc440, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, ...o });
  const arrow = new THREE.Group();
  const cone = new THREE.Mesh(new THREE.ConeGeometry(95, 210, 24), mat({ opacity: 0.95 }));
  cone.rotation.x = Math.PI;
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(34, 34, 160, 16), mat({ opacity: 0.95 }));
  stem.position.y = 180;
  arrow.add(cone, stem);
  arrow.position.y = 105;
  const beacon = new THREE.Mesh(new THREE.CylinderGeometry(22, 22, 1, 12, 1, true), mat({ opacity: 0.22, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  const ring = new THREE.Mesh(new THREE.RingGeometry(330, 420, 48), mat({ opacity: 0.85, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  const ring2 = new THREE.Mesh(new THREE.RingGeometry(160, 190, 40), mat({ opacity: 0.55, side: THREE.DoubleSide }));
  ring2.rotation.x = -Math.PI / 2;
  const top = new THREE.Group();
  top.add(arrow, beacon);
  const floor = new THREE.Group();
  floor.add(ring, ring2);
  g.add(top, floor);
  for (const m of [cone, stem, beacon, ring, ring2]) { m.renderOrder = 990; m.frustumCulled = false; }
  g.userData = { top, floor, arrow, beacon, ring, ring2 };
  g.visible = false;
  return g;
}

// ------------------------------------------------------------------ the tutorial
export class Tutorial {
  constructor(game, part, givenSteps) {
    this.game = game;
    this.app = game.app;
    this.part = part;
    this.prog = programSteps(part, givenSteps);
    this.idx = 0;
    this.hold = false;
    this.active = false;
    this.min = false;
    this.t = 0;
    this.checkT = 0;
    this.lookAcc = 0; // radians the player has looked around since the tutorial started
    this._look = null;
    this.marker = buildMarker();
    this._v = new THREE.Vector3();
    this._w = new THREE.Vector3();
    this.ctl = this.ctlNow();
    this.steps = this.buildSteps();
    this.buildDom();
  }

  get touch() { return !!this.game.fp.touchMode; }
  get c() { return this.app.controller; }
  get hmi() { return this.app.ui.hmi; }
  get st() { return this.game.s.tut; }
  step(id) { return this.prog.find((s) => s.op === id); }

  // ---------------------------------------------------------------- state helpers
  jobOn() {
    const g = this.game;
    return g.s.jobId === this.part.id && !!g.prog && !g.prog.done;
  }
  fits(b) {
    const p = this.part;
    return !!b && b.x === p.stock.x && b.y === p.stock.y && b.z === p.stock.z && b.material === p.material;
  }
  viseOk() { return !this.app.stockEmpty && this.fits(this.game.s.vise); }
  machined() {
    const g = this.game;
    return (this.viseOk() && g.machinedSerial === this.app.stockSerial) || (this.jobOn() && !!g.prog.machined) || this.unloaded();
  }
  unloaded() {
    const g = this.game;
    return (g.carryPart && g.carryPart.jobId === this.part.id) || this.onPlate();
  }
  onPlate() { return !!(this.game.plate && this.game.plate.part.id === this.part.id); }
  measuredLog() { return (this.game.ms?.log || []).filter(Boolean); }
  passed(stepId) {
    // a later milestone implies an earlier step: used to skip ahead when the player is ahead
    const order = this.steps.map((s) => s.id);
    const i = order.indexOf(stepId);
    const ms = [
      ['takeBlank', () => this.viseOk() || this.machined()],
      ['loadVise', () => this.viseOk() && this.app.zmap.removedTotal > 0.5 || this.machined()],
      ['cycleStart', () => this.machined()],
      ['unload', () => this.unloaded()],
      ['bench', () => this.onPlate()],
    ];
    return ms.some(([id, fn]) => order.indexOf(id) > i && fn());
  }

  // the program editor is on screen, on whichever control style is active (808D: PROGRAM area;
  // NGC-style: EDIT mode / edit display)
  programView() {
    const h = this.app.haas;
    if (h?.active) return h.mode === 'EDIT' || h.disp === 'edit';
    return this.hmi?.area === 'program';
  }

  // ---------------------------------------------------------------- program helpers
  editorLines() { return this.app.ui.editor.getValue().split('\n'); }
  markerLine(re) { return this.editorLines().findIndex((l) => re.test(l)); }
  calls(name) {
    const out = [];
    this.editorLines().forEach((l, i) => {
      if (l.trim().startsWith(';')) return;
      const c = findCall(l);
      if (c && c.name === name) out.push({ line: i, args: c.args, modal: c.modal });
    });
    return out;
  }
  // mismatching required keys of a cycle call: [{ i, k, want, got }]
  mismatches(s, args) {
    const P = CYCLES[s.cycle].params;
    const keys = s.keys || CHECK_KEYS[s.cycle] || [];
    const bad = [];
    for (const k of keys) {
      const i = P.findIndex((p) => p.k === k);
      if (i < 0) continue;
      const want = s.values[k];
      if (want === undefined) continue;
      const got = args[i] ?? '';
      const wn = num(want), gn = num(String(got).trim());
      const ok = wn == null ? String(got).trim() === '' : gn != null && Math.abs(wn - gn) <= 0.011;
      if (!ok) {
        // drilling: DP may be given relative (DPR) instead
        if (k === 'DP' && /CYCLE8/.test(s.cycle) && String(got).trim() === '') {
          const ri = P.findIndex((p) => p.k === 'DPR'), fi = P.findIndex((p) => p.k === 'RFP');
          const dpr = num(String(args[ri] ?? '').trim()), rfp = num(String(args[fi] ?? '').trim()) ?? 0;
          if (dpr != null && Math.abs(rfp - dpr - wn) <= 0.011) continue;
        }
        bad.push({ i, k, want, got, label: P[i].label });
      }
    }
    return bad.sort((a, b) => a.i - b.i);
  }
  callOk(s, c) { return !this.mismatches(s, c.args).length && (!s.modal || c.modal); }
  validCalls(s) { return this.calls(s.cycle).filter((c) => this.callOk(s, c)); }
  badCalls(s) { return this.calls(s.cycle).filter((c) => !this.callOk(s, c)); }
  refLoaded() { return /^JOB_T01_REF\.MPF$/.test(this.app.programName || '') || (this.app.programName === `JOB_${this.part.id}_REF.MPF`); }
  progDone(op) {
    const s = this.step(op);
    if (!s) return true;
    if (this.refLoaded() || this.machined()) return true;
    return this.app.programName === `JOB_${this.part.id}.MPF` && this.validCalls(s).length >= (s.count || 1);
  }
  callText(s) {
    const P = CYCLES[s.cycle].params;
    return (s.modal ? 'MCALL ' : '') + formatCall(s.cycle, P.map((p) => String(s.values[p.k] ?? p.def ?? '')));
  }
  // the line the next cycle should be inserted after
  insertLineFor(s) {
    const L = this.editorLines();
    const re = MARK_RE[s.op];
    const i = re ? L.findIndex((l) => re.test(l)) : -1;
    if (i < 0) return -1;
    const nx = findCall(L[i + 1] || '');
    return !nx || nx.name !== s.cycle ? i : -1;
  }
  placeCaret(s, line = null) {
    const i = line ?? this.insertLineFor(s);
    if (i < 0) return;
    const ed = this.app.ui.editor;
    if (ed.caretLine() === i) return;
    const L = this.editorLines();
    let pos = 0;
    for (let k = 0; k < i; k++) pos += L[k].length + 1;
    try { ed.ta.setSelectionRange(pos, pos); } catch { /* ignore */ }
    ed.ta.scrollTop = Math.max(0, i * ed.lh - ed.ta.clientHeight * 0.35);
    ed.schedule?.();
  }
  ensureProgram() {
    const app = this.app, g = this.game;
    if (app.controller.exec) return;
    const name = `JOB_${this.part.id}.MPF`;
    if (!app.programs.has(name)) app.programs.put(name, g.programTemplate(this.part));
    if (app.programName !== name && !this.refLoaded()) app.openProgram(name);
  }
  fill(op) {
    if (this.ctl === 'haas') return fillHaas(this, op);
    const s = this.step(op);
    if (!s) return;
    const hmi = this.hmi, ed = this.app.ui.editor;
    if (hmi.pages.program === 'form' && hmi.form?.name === s.cycle) {
      const P = CYCLES[s.cycle].params;
      P.forEach((p, i) => {
        const inp = $(`#cf_${i}`);
        if (inp && s.values[p.k] !== undefined) { inp.value = String(s.values[p.k]); inp.dispatchEvent(new Event('input')); }
      });
      return;
    }
    this.ensureProgram();
    // fix wrong calls in place, then add the missing ones
    for (const c of this.badCalls(s)) ed.replaceLine(c.line, this.callText(s));
    let guard = 0;
    while (this.validCalls(s).length < (s.count || 1) && guard++ < 6) {
      const i = this.insertLineFor(s);
      if (i < 0) break;
      ed.replaceLine(i, this.callText(s), true);
    }
    this.app.ui.log(`Tutorial: ${s.cycle} filled in with the values from the drawing`);
  }

  progText(op) {
    const s = this.step(op);
    if (!s) return '';
    const P = CYCLES[s.cycle].params;
    const keys = (s.keys || CHECK_KEYS[s.cycle] || []).slice().sort((a, b) => P.findIndex((p) => p.k === a) - P.findIndex((p) => p.k === b));
    const list = keys.map((k) => `<b>${k} ${esc(s.values[k] === '' ? '(empty)' : s.values[k])}</b>`).join(', ');
    const path = s.modal ? `<b>Drilling › MCALL on</b>, then <b>Re-compile</b> on the new line` : `<b>${/CYCLE8|HOLES/.test(s.cycle) ? 'Drilling' : 'Milling'} › ${s.cycle}</b>`;
    return `${esc(s.intro || '')} Press ${path} and enter ${list}. Then <b>OK</b>.`;
  }

  // ---------------------------------------------------------------- DOM targets
  sk(label) {
    const n = norm(label);
    return $$('#hsk .sk, #vsk .sk').find((b) => !b.disabled && (norm(b.textContent) === n || norm(b.textContent).startsWith(n)));
  }
  area(a) { return $(`#areaKeys [data-area="${a}"]`); }
  // guidance for an HMI path: area -> page / group softkey -> final element
  hmiTarget(area, inner) {
    const h = this.hmi;
    if (h.area !== area) return { el: this.area(area), text: `Press ${area === 'pm' ? 'PROG. MGR' : area.toUpperCase()}` };
    return inner();
  }
  cycleTarget(s) {
    const h = this.hmi;
    if (h.pages.program === 'form' && h.form) {
      if (h.form.name !== s.cycle) return { el: this.sk('Cancel'), text: `This is the ${h.form.name} form: press Cancel` };
      if (s.modal && !h.form.modal) return { el: this.sk('Cancel'), text: 'Use MCALL on instead: press Cancel' };
      const P = CYCLES[s.cycle].params;
      const vals = P.map((_, i) => $(`#cf_${i}`)?.value ?? '');
      const bad = this.mismatches(s, vals);
      if (bad.length) {
        const b = bad[0];
        return { el: $(`#cf_${b.i}`), text: `${b.k}: enter ${b.want === '' ? '(empty)' : b.want}`, sub: s.fields?.[b.k]?.why || b.label };
      }
      return { el: this.sk('OK'), text: 'Values OK: press OK to insert the cycle' };
    }
    return this.hmiTarget('program', () => {
      if (h.pages.program !== 'prog') return { el: this.sk('Edit'), text: 'Press Edit' };
      const grp = /CYCLE8|HOLES/.test(s.cycle) ? 'drill' : 'mill';
      const bad = this.badCalls(s)[0];
      if (bad && (!s.modal || bad.modal)) {
        // a call is there but its values are wrong: edit it with Re-compile
        this.placeCaret(s, bad.line);
        return { el: this.sk('Re-compile'), text: 'Re-compile: edit the values', sub: `Line ${bad.line + 1}` };
      }
      if (bad) return null; // plain CYCLE81 where MCALL is needed: see the card (Fill for me)
      this.placeCaret(s);
      if (h.sub.program !== grp) return { el: this.sk(grp === 'drill' ? 'Drilling' : 'Milling'), text: `Press ${grp === 'drill' ? 'Drilling' : 'Milling'}` };
      if (s.modal) return { el: this.sk('MCALL on'), text: 'MCALL on', sub: 'Inserts a modal drilling call; then Re-compile' };
      return { el: this.sk(s.cycle), text: `Press ${s.cycle}` };
    });
  }
  sheet() {
    const top = this.game.ui.topModal();
    return top?.kind === 'drawing' && top.partId === this.part.id ? this.game.ui.drawView : null;
  }
  // bounding box (sheet mm) of SVG texts matching a predicate
  sheetBox(pred, pad = 6) {
    const v = this.sheet();
    const svg = v?.svg;
    if (!svg) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    let rootInv;
    try { rootInv = svg.getScreenCTM().inverse(); } catch { return null; }
    for (const t of svg.querySelectorAll('text')) {
      const s = t.textContent.trim();
      if (!s || !pred(s, t)) continue;
      let b, m;
      try { b = t.getBBox(); m = rootInv.multiply(t.getScreenCTM()); } catch { continue; }
      if (!b || !m || (!b.width && !b.height)) continue;
      const pts = [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]].map(([x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]);
      if (pts.some(([X, Y]) => X < 14 || X > 406 || Y < 14 || Y > 283)) continue; // sheet frame zone labels
      for (const [X, Y] of pts) { x0 = Math.min(x0, X); y0 = Math.min(y0, Y); x1 = Math.max(x1, X); y1 = Math.max(y1, Y); }
    }
    if (!isFinite(x0)) return null;
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
  }

  // ---------------------------------------------------------------- steps
  buildSteps() {
    const g = this.game, app = this.app, P = this.part;
    const touch = () => this.touch;
    const anchors = g.ws.anchors;
    const avg = (list) => { const v = new THREE.Vector3(); for (const s of list) v.add(s.position); return v.multiplyScalar(1 / list.length); };
    const board = avg(anchors.jobBoardSlots || [{ position: new THREE.Vector3(-7500, 1600, 3200) }]);
    const rack = avg(anchors.stockRackSlots || [{ position: new THREE.Vector3(7000, 1200, 2000) }]);
    const W = (pt, stand, opts = {}) => ({ world: pt, ring: stand, ...opts });
    const near = (p, d) => { const q = g.fp.position; return Math.hypot(q.x - p.x, q.z - p.z) < d; };
    const boardStand = new THREE.Vector3(board.x + 1500, 0, board.z);
    const rackStand = new THREE.Vector3(rack.x - 1500, 0, rack.z);
    const machineStand = new THREE.Vector3(80, 0, 1320);
    const plateStand = anchors.inspectionCamera ? new THREE.Vector3(anchors.inspectionCamera.eye.x, 0, anchors.inspectionCamera.eye.z) : null;
    const viseWorld = () => app.machine.workGroup.localToWorld(this._w.set(0, (app.placement?.top || 140) + 40, 0)).clone();
    const handleWorld = () => {
      const h = app.machine.clickables.find((o) => o.userData.action === 'door');
      return h ? h.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(0, 1500, 820);
    };
    const pendantWorld = () => app.machine.pendantBody.localToWorld(new THREE.Vector3(0, 175, 60));
    this.panelTarget = () => W(pendantWorld(), null, { text: 'Control panel', small: true });
    const modal = (k) => g.ui.topModal()?.kind === k;
    const opOn = () => g.op === 'pendant' || g.op === 'pc';
    const ack = (id) => !!this.st.ack?.[id];
    const blankTxt = `${P.stock.x} × ${P.stock.y} × ${P.stock.z} mm ${MATERIALS[P.material]?.short.toLowerCase()}`;
    const face = r3(P.stock.z - P.size.z);
    const pocket = P.features.find((f) => f.type === 'pocketRect');
    const holes = P.features.filter((f) => f.type === 'hole');
    const sv = (op, k) => this.step(op)?.values[k];
    const progStep = (op, title, text) => ({
      id: 'prog-' + op, title, phase: 'Program', fill: op,
      text,
      enter: () => { this.ensureProgram(); },
      atPanel: true,
      target: () => (opOn() ? this.cycleTarget(this.step(op)) : null),
      done: () => this.progDone(op),
      extra: () => {
        const s = this.step(op);
        if (this.hmi.pages.program === 'form' && this.hmi.form?.name === s.cycle) return '';
        const bad = this.badCalls(s).map((c) => ({ c, m: this.mismatches(s, c.args) }));
        if (!bad.length) return '';
        const b = bad[0];
        if (!b.m.length) return `<div class="t-warn">Line ${b.c.line + 1} is a plain ${s.cycle}: it only drills where the tool stands. It must be <b>MCALL ${s.cycle}</b> (modal) so it drills at every position below. Delete it and use <b>MCALL on</b>, or press <b>Fill for me</b>.</div>`;
        return `<div class="t-warn">The ${s.cycle} in line ${b.c.line + 1} has ${b.m.map((m) => `${m.k} = ${esc(m.got || '(empty)')} (should be ${esc(m.want)})`).join(', ')}. Put the cursor on it and press <b>Re-compile</b> to edit it, or use <b>Fill for me</b>.</div>`;
      },
    });

    const all = [
      { id: 'welcome', phase: 'Start', title: 'Your first part', explain: true,
        text: () => `This tutorial takes you through a whole job: you pick drawing <b>${esc(P.drawingNo)}</b> from the job board and turn a sawn blank into a finished, inspected part on the real control. Each step continues by itself once you have done it; use <b>Skip step</b> if you already know it.` },
      { id: 'look', phase: 'Shop floor', title: 'Look around',
        text: () => (touch() ? 'Drag with your <b>right thumb</b> on the right half of the screen to look around.' : '<b>Click the 3D view</b> to capture the mouse, then move the mouse to look around. <b>Esc</b> gives the mouse back.'),
        // looking around is accumulated every frame since the tutorial started (update()), so looking
        // while the welcome card was up counts too; walking on / opening the board also passes it
        done: () => this.lookAcc > 0.9 || near(boardStand, 1500) || modal('jobs') || modal('drawing') || this.jobOn() },
      { id: 'walk', phase: 'Shop floor', title: 'Walk to the job board',
        text: () => (touch() ? 'Use your <b>left thumb</b> as a joystick to walk to the cork board marked with the yellow arrow.' : 'Walk with <b>W A S D</b> (hold <b>Shift</b> to run) to the cork board marked with the yellow arrow.'),
        target: () => W(new THREE.Vector3(board.x + 60, board.y + 700, board.z), boardStand, { text: 'Job board' }),
        done: () => near(boardStand, 1500) || modal('jobs') || modal('drawing') || this.jobOn() },
      { id: 'openBoard', phase: 'Job', title: 'Open the job board',
        text: () => `Aim the crosshair at the board until the prompt appears, then ${touch() ? '<b>tap the prompt</b>' : 'press <b>E</b> (or click)'}. You can also press <b>J</b> anywhere.`,
        target: () => (modal('jobs') ? null : W(new THREE.Vector3(board.x + 60, board.y + 700, board.z), boardStand, { text: 'Job board' })),
        done: () => modal('jobs') || modal('drawing') || this.jobOn() },
      { id: 'pickJob', phase: 'Job', title: `Choose job ${P.id}`,
        text: () => `Every card is a drawing with its customer, material and blank size. Open <b>${esc(P.id)} · ${esc(P.title)}</b>, the tutorial job.`,
        target: () => (modal('jobs') ? { el: $(`[data-job="${P.id}"]`), text: `Open ${P.id}` }
          : modal('drawing') ? (g.ui.topModal().partId !== P.id ? { el: $('[data-dw="jobs"]'), text: `All jobs: open ${P.id}` } : null)
          : { el: $('[data-g="jobs"]'), text: 'Open the job list (J)' }),
        done: () => (modal('drawing') && g.ui.topModal().partId === P.id) || this.jobOn() },
      { id: 'accept', phase: 'Job', title: 'Accept the job',
        text: () => `Press <b>Accept job</b>. This makes ${esc(P.id)} your current job and creates the program <b>JOB_${esc(P.id)}.MPF</b> at the control, already selected.`,
        target: () => (this.sheet() ? { el: $('[data-dw="accept"]'), text: 'Accept job' } : { el: $('#jobChip') || $('[data-g="drawing"]'), text: `Open drawing ${P.drawingNo}` }),
        enter: () => { if (!this.sheet() && !this.jobOn() && !g.ui.topModal()) g.ui.openDrawing(P); },
        done: () => this.jobOn() },
      // ---- reading the drawing
      ...[
        ['dViews', 'Views and sections', 'The <b>plan view</b> (looking down on the part) is the main view. <b>Section A–A</b> above it and <b>B–B</b> on the right are cuts through the part: they show the depths of the pocket and the holes.',
          (s) => /^(A–A|B–B|A-A|B-B)$/.test(s) || /^-?\d+(\.\d+)?$/.test(s), 4],
        ['dDatums', 'Datums and ordinate dimensions', 'Datum <b>A</b> is the left face, <b>B</b> the front face, <b>C</b> the top face. Positions are <b>ordinate dimensions</b> measured from the <b>0</b>, the front-left corner: exactly where you will set G54.',
          (s) => s === '0', 22],
        ['dTol', 'A toleranced dimension', `<b>${pocket ? `${pocket.w}±${pocket.tol ?? P.tol.general}` : '±'}</b> means the size may be off by at most that much. Everything else uses the general tolerance in the title block (<b>±${P.tol.general}</b>).`,
          (s) => /±/.test(s) && /POCKET|×/.test(s) && !/unless|linear/i.test(s), 8],
        ['dHole', 'Hole callout', `<b>${holes.length}× Ø${holes[0]?.d ?? ''}</b> with <b>↧ ${holes[0]?.depth ?? ''}</b>: ${holes.length} holes of that diameter, ${holes[0]?.depth ?? ''} mm deep to the full diameter (the 118° drill point goes a little deeper).`,
          (s) => /\d+×\s*Ø|^Ø\d/.test(s) && !/holes/i.test(s), 10],
        ['dTitle', 'Title block: material and blank', `The title block names the <b>material</b> (${esc(MATERIALS[P.material]?.name)}) and the sawn <b>blank size</b> (${P.stock.x} × ${P.stock.y} × ${P.stock.z}). You need exactly that blank from the stock rack.`,
          (s) => s === 'Material' || /^Blank size/.test(s) || s === P.drawingNo || s === (MATERIALS[P.material]?.name) || s === `${P.stock.x} × ${P.stock.y} × ${P.stock.z}`, 4],
      ].map(([id, title, text, pred, pad]) => ({
        id, phase: 'Drawing', title, explain: true, text: () => text,
        target: () => (this.sheet() ? { sheet: this.sheetBox(pred, pad) } : { el: $('#jobChip'), text: 'Open the drawing (Q)' }),
        enter: () => { if (!this.sheet() && !g.ui.topModal()) g.ui.openDrawing(P); },
        done: () => ack(id) || this.passed(id),
      })),
      { id: 'closeDrawing', phase: 'Drawing', title: 'Close the drawing',
        text: () => `Close the drawing with <b>Esc</b> or ✕. You can bring it back any time with <b>Q</b> or the <b>Drawing</b> button.`,
        target: () => (this.sheet() ? { el: $('.g-drawing-wrap .g-x'), text: 'Close (Esc)' } : null),
        done: () => !this.sheet() },
      // ---- blank
      { id: 'walkRack', phase: 'Blank', title: 'Go to the stock rack',
        text: () => 'The sawn blanks lie on the shelves of the stock rack on the right-hand wall. Walk there.',
        target: () => W(new THREE.Vector3(rack.x - 300, rack.y + 900, rack.z), rackStand, { text: 'Stock rack' }),
        done: () => near(rackStand, 1600) || modal('rack') || g.s.carry || this.viseOk() },
      { id: 'takeBlank', phase: 'Blank', title: 'Take the right blank',
        text: () => `Use the rack and take the <b>${blankTxt}</b> blank. Careful: some blanks only <i>look</i> right. A thinner one cannot be faced to ${P.size.z} mm, and another material machines and inspects differently. The inspection rejects a wrong blank.`,
        target: () => {
          if (modal('rack')) {
            const card = $$('.g-blank').find((b) => b.textContent.includes(`${P.stock.x} × ${P.stock.y} × ${P.stock.z}`) && b.textContent.includes(MATERIALS[P.material].short));
            return { el: card, text: 'This one' };
          }
          return W(new THREE.Vector3(rack.x - 300, rack.y + 900, rack.z), rackStand, { text: 'Stock rack' });
        },
        extra: () => (g.s.carry?.kind === 'blank' && !this.fits(g.s.carry.blank) ? `<div class="t-warn">You are carrying a <b>${esc(g.s.carry.blank.x)} × ${esc(g.s.carry.blank.y)} × ${esc(g.s.carry.blank.z)} ${esc(MATERIALS[g.s.carry.blank.material]?.short)}</b> blank: wrong one. Use the rack again to swap it.</div>` : ''),
        done: () => (g.s.carry?.kind === 'blank' && this.fits(g.s.carry.blank)) || this.viseOk() || this.passed('takeBlank') },
      { id: 'walkMachine', phase: 'Machine', title: 'Carry it to the machine',
        text: () => 'Walk to the front of the VMC. Stand on the black anti-fatigue mat in front of the doors.',
        target: () => W(new THREE.Vector3(0, 2500, 850), machineStand, { text: 'VMC-560' }),
        done: () => near(machineStand, 1300) || this.viseOk() || this.passed('walkMachine') },
      { id: 'doors', phase: 'Machine', title: 'Open the doors',
        text: () => `The vise sits behind the sliding doors. Aim at a <b>door handle</b> and ${touch() ? 'tap the prompt' : 'press E'}. The doors are interlocked: they stay shut while a program runs.`,
        target: () => W(handleWorld().add(new THREE.Vector3(0, 120, 60)), null, { text: 'Door handle', small: true }),
        done: () => app.controller.door.target > 0.5 || this.viseOk() || this.passed('doors') },
      { id: 'loadVise', phase: 'Machine', title: 'Clamp the blank in the vise',
        text: () => `Aim at the <b>vise</b> on the machine table and ${touch() ? 'tap the prompt' : 'press E'} to clamp the blank. It stands ${P.protrusion} mm above the jaws, enough for the deepest cut.`,
        target: () => W(viseWorld(), null, { text: 'Vise', small: true }),
        done: () => this.viseOk() || this.passed('loadVise') },
      // ---- control
      { id: 'pendant', phase: 'Control', title: 'Step up to the control panel',
        text: () => `Use the <b>control panel</b> (the pendant hanging on the right of the doors). The real 808D-style control opens: screen on the right, machine control panel along the bottom, your drawing on the left.`,
        target: () => W(pendantWorld(), null, { text: 'Control panel', small: true }),
        done: () => g.op === 'pendant' || this.passed('pendant') },
      { id: 'areas', atPanel: true, phase: 'Control', title: 'Operating areas', explain: true,
        text: () => 'The five keys on top switch the <b>operating area</b>: MACHINE (positions, JOG, MDA, AUTO), OFFSET (tools, work offsets, blank), PROGRAM (editor and cycles), PROG. MGR (program files) and SYSTEM (alarms, settings).',
        target: () => (opOn() ? { el: $('#areaKeys'), text: 'Operating areas', pad: 4 } : null),
        done: () => ack('areas') || this.passed('areas') },
      { id: 'softkeys', atPanel: true, phase: 'Control', title: 'Softkeys', explain: true,
        text: () => 'The keys along the bottom and the right of the screen are <b>softkeys</b>: their labels change with the page. Bottom row = pages and groups, right column = actions on the current page.',
        target: () => (opOn() ? { el: $('#hsk'), text: 'Softkeys', pad: 3 } : null),
        done: () => ack('softkeys') || this.passed('softkeys') },
      { id: 'mcp', atPanel: true, phase: 'Control', title: 'Machine control panel', explain: true,
        text: () => 'Along the bottom: <b>mode keys</b> (JOG, REF POINT, MDA, AUTO), jog keys, spindle keys, the <b>feed override</b> knob and <b>RESET / CYCLE STOP / CYCLE START</b>. The red mushroom is the E-STOP.',
        target: () => (opOn() ? { el: $('#mcp .mcp-group'), text: 'Mode keys', pad: 4 } : null),
        done: () => ack('mcp') || this.passed('mcp') },
      { id: 'ref', atPanel: true, phase: 'Control', title: 'Reference the machine',
        text: () => 'After power-on the control does not know where the axes are. Reference them: on the MACHINE screen press the softkey <b>Ref. all</b> and watch the axes drive home.',
        skip: () => app.controller.homed,
        target: () => (opOn() ? this.hmiTarget('machine', () => ({ el: this.sk('Ref. all'), text: 'Ref. all' })) : null),
        done: () => app.controller.homed || this.passed('ref') },
      { id: 'g54', atPanel: true, phase: 'Setup', title: 'Set G54 on the blank',
        text: () => 'A <b>work offset</b> tells the control where the part zero is. The drawing’s datums are the <b>top front-left corner</b>: go to OFFSET › Work offset, choose <b>Top front-left</b> and press <b>Set from blank</b> (it touches off the corner for you).',
        target: () => {
          if (!opOn()) return null;
          const h = this.hmi;
          return this.hmiTarget('offset', () => {
            if (h.pages.offset !== 'wo') return { el: this.sk('Work offset'), text: 'Work offset' };
            const sel = $('#woPos');
            if (sel && sel.value !== 'top-front-left') return { el: sel, text: 'Choose Top front-left' };
            return { el: this.sk('Set from blank'), text: 'Set from blank' };
          });
        },
        done: () => (this.viseOk() && g.g54Ok()) || this.passed('g54') },
      // ---- program
      { id: 'progOpen', atPanel: true, phase: 'Program', title: 'Open the program',
        text: () => `Open the <b>PROGRAM</b> area. JOB_${esc(P.id)}.MPF is prepared: tool changes and moves are there, the cycles go below the lines marked <b>&gt;&gt;&gt;</b>.`,
        enter: () => this.ensureProgram(),
        target: () => (opOn() ? this.hmiTarget('program', () => null) : null),
        done: () => (this.programView() && opOn()) || this.progDone('face') && this.progDone('pocket') && this.progDone('drill') },
      progStep('face', 'Face the top: CYCLE71', () => this.progText('face')),
      progStep('pocket', 'Mill the pocket: POCKET3', () => this.progText('pocket')),
      progStep('drill', 'Drill the holes: MCALL CYCLE81', () => this.progText('drill')),
      // ---- run
      { id: 'closeDoors', atPanel: true, phase: 'Run', title: 'Close the doors',
        text: () => 'Close the doors (the <b>Doors</b> button or a door handle). With the interlock, CYCLE START would close them too.',
        target: () => (opOn() ? { el: $('#gOpDoor'), text: 'Doors' } : null),
        done: () => app.controller.door.target < 0.5 || app.controller.exec?.kind === 'program' || this.passed('closeDoors') },
      { id: 'auto', atPanel: true, phase: 'Run', title: 'Select AUTO',
        text: () => 'Press the <b>AUTO</b> mode key: the control now runs the selected program.',
        target: () => (opOn() ? { el: $('.key.mode[data-mode="AUTO"]'), text: 'AUTO' } : null),
        done: () => app.controller.mode === 'AUTO' || this.passed('auto') },
      { id: 'safety', atPanel: true, phase: 'Run', title: 'Run it safely', explain: true,
        text: () => 'On a real machine you would first run with <b>SBL</b> (single block: one line per CYCLE START) and the <b>feed override</b> turned down, ready on CYCLE STOP. Here a crash only costs a fresh blank, so you can try it.',
        target: () => (opOn() ? { el: $('#knobFeed'), text: 'Feed override', pad: 6 } : null),
        done: () => ack('safety') || app.controller.exec?.kind === 'program' || app.controller.pendingStart === 'start' || this.passed('safety') },
      { id: 'cycleStart', atPanel: true, phase: 'Run', title: 'CYCLE START',
        text: () => 'Press <b>CYCLE START</b>. Push the <b>Simulation speed</b> slider to the right to watch it go faster.',
        target: () => (opOn() ? { el: $('.key.cstart'), text: 'CYCLE START' } : null),
        extra: () => (app.controller.state === 'alarm' ? `<div class="t-warn">Alarm: ${esc(app.controller.alarm || '')}. Press <b>RESET</b>, fix the program (or <b>Fill for me</b> on the program steps) and start again.</div>` : ''),
        // pressed: the program runs, or waits for the interlocked doors to finish closing
        done: () => app.controller.exec?.kind === 'program' || app.controller.pendingStart === 'start' || this.machined() },
      { id: 'watch', phase: 'Run', title: 'Watch it cut',
        text: () => 'The face mill, the end mill and the drill take turns. The tool path is drawn, chips fly and the screen shows the current block. Wait for <b>Program complete</b>.',
        target: () => (opOn() && app.controller.exec ? { el: $('#simSpeed'), text: 'Simulation speed', pad: 8 } : null),
        extra: () => (app.controller.state === 'alarm' ? `<div class="t-warn">Alarm: ${esc(app.controller.alarm || '')}. Press <b>RESET</b> and CYCLE START again.</div>` : app.controller.state === 'hold' ? '<div class="t-warn">Stopped: press CYCLE START to continue.</div>' : ''),
        done: () => this.machined() },
      // ---- unload / inspect
      { id: 'stepBack', phase: 'Inspect', title: 'Step back',
        text: () => 'Done! Step back from the panel with <b>Esc</b> or the <b>Step back</b> button.',
        target: () => (g.op ? { el: $('[data-op="back"]'), text: 'Step back (Esc)' } : null),
        done: () => !g.op },
      { id: 'unload', phase: 'Inspect', title: 'Unload the part',
        text: () => `Open the doors and use the vise to take the part out. ${touch() ? 'Tap the prompt' : 'Press E'} on the door handle first if they are closed.`,
        target: () => (app.controller.door.target < 0.5 ? W(handleWorld().add(new THREE.Vector3(0, 120, 60)), null, { text: 'Door handle', small: true }) : W(viseWorld(), null, { text: 'Vise', small: true })),
        done: () => this.unloaded() },
      { id: 'bench', phase: 'Inspect', title: 'Inspection bench',
        text: () => 'Carry the part to the <b>inspection bench</b> with the granite surface plate (left wall) and use it: the part is checked against the drawing.',
        target: () => W(anchors.inspectionPlate.clone().add(new THREE.Vector3(0, 450, 0)), plateStand, { text: 'Inspection bench' }),
        done: () => this.onPlate() },
      { id: 'report', phase: 'Inspect', title: 'The inspection report', explain: true,
        text: () => '<b>A</b> = every characteristic within tolerance; B–D = some out; FAIL = scrap (wrong blank, missing feature, gouge). The table compares nominal and measured values; the map shows where material is left (blue) or cut too deep (red).',
        target: () => ($('.g-report .g-grade') ? { el: $('.g-report .g-grade'), text: 'Grade', pad: 6 } : g.plate ? W(anchors.inspectionPlate.clone().add(new THREE.Vector3(0, 250, 0)), plateStand, { text: 'Read the report', small: true }) : null),
        done: () => ack('report') || g.measuring },
      // ---- measure
      { id: 'caliper', phase: 'Measure', title: 'Caliper: pocket width',
        text: () => `Check it yourself. Press <b>Measure the part</b>, pick the <b>Caliper</b>, choose <b>Inside</b> and click the <b>floor of the pocket</b> near one long wall: the inside jaws read the width (drawing: <b>${pocket?.h} ±${pocket?.tol ?? P.tol.general}</b>).`,
        target: () => {
          const ms = g.ms;
          if (!g.measuring || !ms?.active) return $('[data-rp="measure"]') ? { el: $('[data-rp="measure"]'), text: 'Measure the part' } : g.plate ? W(anchors.inspectionPlate.clone().add(new THREE.Vector3(0, 250, 0)), plateStand, { text: 'Measure', small: true }) : null;
          if (ms.sel !== 'caliper') return { el: $('.ms-tray [data-id="caliper"]') || $('.ms-tray button'), text: 'Caliper' };
          if (ms.mode.caliper !== 'inside') return { el: $$('.ms-chip').find((b) => b.textContent.trim() === 'Inside'), text: 'Inside' };
          return pocket ? { part: { x: pocket.x, y: pocket.y - pocket.h / 2 + 3, z: -face - pocket.depth }, text: 'Click the pocket floor here' } : null;
        },
        done: () => this.measuredLog().some((r) => r.instrument === 'caliper' && (r.kind === 'inside' || (pocket && r.featureId === pocket.id))) },
      { id: 'micrometer', phase: 'Measure', title: 'Micrometer: part length',
        text: () => `Now the <b>Micrometer</b> on the length: ${P.size.x} mm needs the <b>${Math.floor(P.size.x / 25) * 25}-${Math.floor(P.size.x / 25) * 25 + 25}</b> frame. Click the <b>left end face</b>, then the <b>right end face</b>. It reads to 0.001 mm.`,
        target: () => {
          const ms = g.ms;
          if (!g.measuring || !ms?.active) return $('[data-rp="measure"]') ? { el: $('[data-rp="measure"]'), text: 'Measure the part' } : g.plate ? W(anchors.inspectionPlate.clone().add(new THREE.Vector3(0, 250, 0)), plateStand, { text: 'Measure', small: true }) : null;
          if (ms.sel !== 'micrometer') return { el: $('.ms-tray [data-id="micrometer"]'), text: 'Micrometer' };
          const lo = Math.floor(P.size.x / 25) * 25;
          const chip = $$('.ms-chip').find((b) => b.textContent.trim() === `${lo}-${lo + 25}`);
          if (chip && !chip.classList.contains('on')) return { el: chip, text: `${lo}-${lo + 25} frame` };
          const n = (ms.clicks || []).length;
          return { part: { x: n % 2 ? P.size.x : 0, y: P.size.y / 2, z: -P.size.z / 2 }, text: n % 2 ? 'Right end face' : 'Left end face' };
        },
        done: () => this.measuredLog().some((r) => r.instrument === 'micrometer' && Math.abs(r.value - P.size.x) < 0.5) },
      { id: 'compare', phase: 'Measure', title: 'Compare with the drawing', explain: true,
        text: () => {
          const L = this.measuredLog();
          const cal = L.find((r) => r.instrument === 'caliper'), mic = L.find((r) => r.instrument === 'micrometer');
          const row = (r, nom, tol) => (r ? `<b>${r.value.toFixed(r.resolution < 0.005 ? 3 : 2)}</b> (drawing ${nom} ±${tol}: ${Math.abs(r.value - nom) <= tol ? '<span class="t-ok">OK</span>' : '<span class="t-ng">out</span>'})` : '—');
          return `Your readings: caliper ${row(cal, pocket?.h, pocket?.tol ?? P.tol.general)}, micrometer ${row(mic, P.size.x, P.tol.general)}. They are on your measurement sheet and in the inspection report. Close the station with <b>Esc</b> when you are done.`;
        },
        done: () => ack('compare') },
      { id: 'finish', phase: 'Done', title: 'Tutorial complete', explain: true, last: true,
        text: () => `You read a drawing, chose the blank, set up the machine, programmed three cycles, machined and inspected the part. Pick your next job at the <b>job board</b> (P01 is a good start). Restart this tutorial any time from <b>Help</b> or with <b>T</b>.`,
        done: () => ack('finish') },
    ];
    return this.ctl === 'haas' ? this.haasify(all) : all;
  }

  // ---------------------------------------------------------------- control style
  ctlNow() { return this.app.haas?.active ? 'haas' : '808d'; }
  // the player switched the control style (Settings): rebuild the steps and stay on the same one, or
  // on the start of the control part when the step does not exist on the other control
  switchControl() {
    const id = this.cur.id;
    this.cur.leave?.();
    this.ctl = this.ctlNow();
    this.steps = this.buildSteps();
    let i = this.steps.findIndex((x) => x.id === id);
    if (i < 0) i = Math.max(0, this.steps.findIndex((x) => x.id === 'pendant') + 1);
    this.idx = i;
    this.hold = false;
    this.game.s.tut.step = this.cur.id;
    this.cur.enter?.();
    this.render(true);
  }
  // the control steps of the NGC-style (Haas) control replace the 808D ones (tutorial-haas.js)
  haasify(all) {
    const { control, run } = haasSteps(this);
    const ix = (id) => all.findIndex((s) => s.id === id);
    const a = ix('areas'), b = ix('prog-drill'), c = ix('closeDoors'), d = ix('watch');
    const out = [...all.slice(0, a), ...control, ...all.slice(b + 1, c), ...run, ...all.slice(d + 1)];
    const p = out.find((s) => s.id === 'pendant');
    p.text = () => 'Use the <b>control panel</b> (the pendant hanging on the right of the doors). The NGC-style CNC control opens: screen at the top, the keyboard below it, the handle wheel and CYCLE START on the left, your drawing on the left of the view.';
    return out;
  }

  // ---------------------------------------------------------------- DOM
  buildDom() {
    const card = document.createElement('section');
    card.className = 't-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Tutorial');
    card.hidden = true;
    card.innerHTML = `
      <div class="t-head"><span class="t-ph"></span><span class="t-n"></span><button class="t-ic" data-t="restart" title="Restart the tutorial">↺</button><button class="t-ic" data-t="min" title="Minimise (T)">–</button><button class="t-ic" data-t="exit" title="Exit the tutorial">✕</button></div>
      <div class="t-bar"><i></i></div>
      <div class="t-body"><b class="t-title"></b><p class="t-text"></p><div class="t-extra"></div><div class="t-done" hidden>✓ Done</div></div>
      <div class="t-acts"><button class="btn ghost" data-t="back">Back</button><button class="btn ghost" data-t="skip">Skip step</button><span class="t-sp"></span><button class="btn" data-t="ref" hidden title="Load the worked solution JOB_${esc(this.part.id)}_REF.MPF">Reference program</button><button class="btn" data-t="fill" hidden>Fill for me</button><button class="btn primary" data-t="next" hidden>Next</button></div>`;
    document.body.appendChild(card);
    card.addEventListener('click', (e) => {
      const b = e.target.closest('[data-t]');
      if (!b) return;
      const k = b.dataset.t;
      if (k === 'exit') this.exit();
      else if (k === 'min') this.setMin(!this.min);
      else if (k === 'restart') { if (confirm('Restart the tutorial from the first step?')) this.game.startTutorial({ restart: true }); }
      else if (k === 'back') this.go(this.idx - 1, true);
      else if (k === 'skip') this.go(this.idx + 1, false);
      else if (k === 'next') this.next();
      else if (k === 'fill') { const s = this.cur; if (s?.fill) this.fill(s.fill); }
      else if (k === 'ref') this.game.loadReference(this.part.id);
    });
    const spot = document.createElement('div');
    spot.className = 't-spot';
    spot.hidden = true;
    const bub = document.createElement('div');
    bub.className = 't-bub';
    bub.hidden = true;
    const edge = document.createElement('div');
    edge.className = 't-edge';
    edge.hidden = true;
    edge.innerHTML = '<i></i><span></span>';
    const tag = document.createElement('div');
    tag.className = 't-tag';
    tag.hidden = true;
    document.body.append(spot, bub, edge, tag);
    this.el = { card, spot, bub, edge, tag, title: $('.t-title', card), text: $('.t-text', card), extra: $('.t-extra', card), ph: $('.t-ph', card), n: $('.t-n', card), bar: $('.t-bar i', card), done: $('.t-done', card), next: $('[data-t="next"]', card), fill: $('[data-t="fill"]', card), ref: $('[data-t="ref"]', card), back: $('[data-t="back"]', card) };
  }

  get cur() { return this.steps[this.idx]; }

  start(stepId) {
    const s = this.game.s;
    s.tut = { ...(s.tut || {}), active: true, ack: s.tut?.ack || {}, offered: true };
    this.active = true;
    this.lookAcc = 0;
    this._look = null;
    let i = stepId ? this.steps.findIndex((x) => x.id === stepId) : 0;
    if (i < 0) i = 0;
    this.app.viewer.scene.add(this.marker);
    this.el.card.hidden = false;
    this.setMin(false);
    this.go(i, false, true);
  }

  restart() {
    this.game.s.tut = { active: true, ack: {}, offered: true };
    this.start(this.steps[0].id);
    this.hold = true; // show the welcome first; Next then skips ahead to wherever the shop already is
    this.render(true);
  }

  exit(finished = false) {
    if (!this.active) return;
    this.active = false;
    const s = this.game.s.tut;
    s.active = false;
    if (finished) s.finished = true;
    this.cur?.leave?.();
    this.clearSheet();
    this.app.viewer.scene.remove(this.marker);
    for (const k of ['card', 'spot', 'bub', 'edge', 'tag']) this.el[k].hidden = true;
    this.game.save();
    this.game.ui.syncTutorial?.();
  }

  setMin(m) {
    this.min = m;
    this.el.card.classList.toggle('min', m);
  }

  go(i, hold, initial = false) {
    i = Math.max(0, Math.min(this.steps.length - 1, i));
    const prev = this.cur;
    if (!initial && prev) prev.leave?.();
    this.idx = i;
    this.hold = !!hold;
    const s = this.cur;
    this.game.s.tut.step = s.id;
    this.game.save();
    this.clearSheet();
    this._sheetKey = '';
    s.enter?.();
    // Back (hold) shows a step again without bouncing forward at once: remember whether it was
    // already done, so that it still continues by itself once the player does it again (advance()).
    this.holdDone = this.hold && this.safeDone(s);
    this.render(true);
    // a step whose condition already holds when it is entered goes on right away
    // (initial: start() / restart() decide first whether the welcome card holds)
    if (!initial) this.advance();
    this.checkT = 0.1;
  }

  next() {
    const s = this.cur;
    if (s.explain) this.game.s.tut.ack[s.id] = true;
    if (s.last) { this.exit(true); this.game.ui.toast('Tutorial complete. Pick your next job at the job board.', 'ok', 5000); return; }
    this.go(this.idx + 1, false);
  }

  safeDone(s) {
    try { return !!s.done?.(); } catch (e) { console.warn('tutorial step', s.id, e); return false; }
  }

  // advance while the current step is done (skips ahead when the player is ahead of the tutorial)
  advance() {
    if (this.hold) {
      // held by Back: an action step that the player now completes (again) continues by itself
      const s = this.cur;
      if (s.explain) return;
      const d = this.safeDone(s);
      if (!d) { this.holdDone = false; return; }
      if (this.holdDone) return;
      this.hold = false;
    }
    let moved = false, guard = 0;
    while (guard++ < this.steps.length) {
      const s = this.cur;
      const skip = s.skip?.();
      if (!skip && !this.safeDone(s) && !this.passed(s.id)) break;
      if (s.last) break;
      if (this.idx >= this.steps.length - 1) break;
      this.cur.leave?.();
      this.idx++;
      moved = true;
    }
    if (moved) {
      this.cur.enter?.(); // only the step we land on (skipped steps must not open windows)
      this.game.s.tut.step = this.cur.id;
      this.game.save();
      this.clearSheet();
      this._sheetKey = '';
      this.app.sound.tone?.(880, 0.005, 0.12, 0.05, 'sine', 220);
      this.render(true);
      this.checkT = 0.1;
    }
  }

  render(force = false) {
    const s = this.cur, e = this.el;
    const done = this.safeDone(s);
    const text = typeof s.text === 'function' ? s.text() : s.text;
    const extra = s.extra ? s.extra() : '';
    const key = `${this.idx}|${text}|${extra}|${done}|${this.hold}|${this.touch}`;
    if (!force && key === this._rk) return;
    this._rk = key;
    e.ph.textContent = `Tutorial · ${s.phase || ''}`;
    e.n.textContent = `${this.idx + 1} / ${this.steps.length}`;
    e.bar.style.width = `${((this.idx + (done ? 1 : 0)) / this.steps.length) * 100}%`;
    e.title.textContent = s.title;
    e.text.innerHTML = text;
    e.extra.innerHTML = extra;
    e.done.hidden = !(done && this.hold) || s.explain;
    e.next.hidden = !(s.explain || this.hold);
    e.next.textContent = s.last ? 'Finish' : 'Next';
    e.fill.hidden = !s.fill;
    e.ref.hidden = !s.fill;
    e.back.disabled = this.idx === 0;
    e.card.querySelector('[data-t="skip"]').hidden = !!s.last;
  }

  clearSheet() {
    if (this._hl) { this._hl.remove(); this._hl = null; }
  }

  // ---------------------------------------------------------------- frame update
  update(dt) {
    if (!this.active) return;
    this.t += dt;
    if (this.ctl !== this.ctlNow()) this.switchControl();
    const s = this.cur;
    // looking around (any step; the 'look' step reads it)
    const fp = this.game.fp, l = this._look;
    if (l) this.lookAcc += Math.abs(Math.atan2(Math.sin(fp.yaw - l.yaw), Math.cos(fp.yaw - l.yaw))) + Math.abs(fp.pitch - l.pitch);
    this._look = { yaw: fp.yaw, pitch: fp.pitch };
    s.tick?.(dt);
    // the step conditions are checked ~10x per second of game time, every frame at low frame rates
    this.checkT -= dt;
    if (this.checkT <= 0) {
      this.checkT = 0.1;
      this.advance();
      this.render();
    }
    this.layout();
  }

  layout() {
    const s = this.cur, e = this.el, g = this.game;
    let tgt = null;
    try { tgt = s.target ? s.target() : null; } catch (err) { console.warn('tutorial target', s.id, err); }
    if (s.atPanel && !g.op && !g.ui.topModal()) tgt = this.panelTarget();
    // ---- drawing sheet region
    if (tgt?.sheet !== undefined) {
      const v = this.sheet();
      const b = tgt.sheet;
      const key = b ? `${b.x.toFixed(1)},${b.y.toFixed(1)},${b.w.toFixed(1)}` : 'fit';
      if (v && key !== this._sheetKey) {
        this._sheetKey = key;
        this.clearSheet();
        if (b) {
          v.zoomTo(b, 0.35);
          const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          r.setAttribute('class', 't-svg-hl');
          r.setAttribute('x', b.x); r.setAttribute('y', b.y); r.setAttribute('width', b.w); r.setAttribute('height', b.h);
          r.setAttribute('rx', 2);
          r.setAttribute('vector-effect', 'non-scaling-stroke');
          v.svg.appendChild(r);
          this._hl = r;
        } else v.fit();
      }
    }
    // ---- DOM element spotlight
    const el = tgt?.el;
    let rect = null;
    if (el && el.isConnected) {
      // a form field scrolled out of its (scrolling) form: bring it into view once
      if ((el.tagName === 'INPUT' || el.tagName === 'SELECT') && this._scrolledTo !== el) {
        this._scrolledTo = el;
        try { el.scrollIntoView({ block: 'nearest' }); } catch { /* ignore */ }
      }
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && getComputedStyle(el).visibility !== 'hidden' && this.uncovered(el, r)) rect = r;
    }
    this.target = rect ? el : null;
    this.tgt = tgt;
    if (rect) {
      const pad = tgt.pad ?? 5;
      Object.assign(e.spot.style, { left: `${rect.left - pad}px`, top: `${rect.top - pad}px`, width: `${rect.width + 2 * pad}px`, height: `${rect.height + 2 * pad}px` });
      e.spot.hidden = false;
      this.placeBubble(e.bub, rect, tgt.text, tgt.sub, el.tagName === 'INPUT' || el.tagName === 'SELECT');
    } else {
      e.spot.hidden = true;
      e.bub.hidden = true;
    }
    // ---- 3D waypoint / point on the part in the measuring station
    let wp = null, small = false;
    if (tgt?.world) { wp = tgt.world; small = !!tgt.small; }
    else if (tgt?.part && g.ms?.active) { wp = g.ms.partToWorld(tgt.part); small = 'tiny'; }
    const m = this.marker, u = m.userData;
    const show3d = !!wp && g.mode === 'workshop' && (!g.ui.topModal() || tgt?.part) && (!g.op || tgt?.part);
    m.visible = show3d;
    if (show3d) {
      const sc = small === 'tiny' ? 0.07 : small ? 0.45 : 1;
      u.top.position.copy(wp);
      u.top.scale.setScalar(sc);
      u.arrow.position.y = (105 + Math.sin(this.t * 3.2) * 40);
      // light pillar going up from the arrow: visible from afar, never in front of the target
      u.beacon.visible = !small;
      u.beacon.scale.set(1, 2600, 1);
      u.beacon.position.y = 300 + 1300;
      const ring = tgt.ring;
      u.floor.visible = !!ring;
      if (ring) {
        u.floor.position.set(ring.x, 6, ring.z);
        const k = 1 + 0.08 * Math.sin(this.t * 4);
        u.ring.scale.setScalar(k);
      }
    }
    // edge arrow / label for the waypoint
    this.placeEdge(show3d ? wp : null, tgt?.text, small);
    // ---- card placement: avoid the spotlight
    this.placeCard(rect);
  }

  // is the element really on top at its centre (not under a window)? tutorial overlays don't count
  uncovered(el, r) {
    const x = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), y = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
    const list = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [];
    const top = list.find((n) => !n.closest?.('.t-card, .t-bub, .t-spot, .t-edge, .t-tag'));
    return !top || el === top || el.contains(top) || top.contains?.(el);
  }

  placeBubble(bub, r, text, sub, side = false) {
    if (!text) { bub.hidden = true; return; }
    bub.hidden = false;
    const html = `${esc(text)}${sub ? `<small>${esc(sub)}</small>` : ''}`;
    if (bub._h !== html) { bub.innerHTML = html; bub._h = html; }
    const bw = bub.offsetWidth, bh = bub.offsetHeight;
    // form fields: put the bubble beside the field so it does not hide the next ones
    if (side && r.left > bw + 24) {
      bub.style.left = `${r.left - bw - 14}px`;
      bub.style.top = `${Math.max(4, Math.min(innerHeight - bh - 4, r.top + r.height / 2 - bh / 2))}px`;
      bub.classList.remove('up');
      bub.classList.add('left');
      bub.style.setProperty('--ay', `${Math.max(10, Math.min(bh - 10, r.top + r.height / 2 - Math.max(4, Math.min(innerHeight - bh - 4, r.top + r.height / 2 - bh / 2))))}px`);
      return;
    }
    bub.classList.remove('left');
    const below = r.bottom + bh + 18 < innerHeight;
    let x = r.left + r.width / 2 - bw / 2;
    x = Math.max(6, Math.min(innerWidth - bw - 6, x));
    const y = below ? r.bottom + 12 : r.top - bh - 12;
    bub.style.left = `${x}px`;
    bub.style.top = `${Math.max(4, y)}px`;
    bub.classList.toggle('up', !below);
    bub.style.setProperty('--ax', `${Math.max(12, Math.min(bw - 12, r.left + r.width / 2 - x))}px`);
  }

  placeEdge(wp, text, small) {
    const e = this.el, cam = this.app.viewer.camera, vr = this.app.viewer.canvas.getBoundingClientRect();
    if (!wp) { e.edge.hidden = true; e.tag.hidden = true; return; }
    const p = this._v.copy(wp).project(cam);
    const behind = p.z > 1;
    let x = p.x, y = p.y;
    if (behind) { x = -x; y = -y; }
    const on = !behind && Math.abs(x) < 0.92 && Math.abs(y) < 0.9;
    const cx = vr.left + vr.width / 2, cy = vr.top + vr.height / 2;
    if (on) {
      e.edge.hidden = true;
      if (text && small !== 'tiny') {
        e.tag.hidden = false;
        if (e.tag.textContent !== text) e.tag.textContent = text;
        e.tag.style.left = `${cx + (x * vr.width) / 2}px`;
        e.tag.style.top = `${cy - (y * vr.height) / 2}px`;
      } else e.tag.hidden = true;
      return;
    }
    e.tag.hidden = true;
    const ang = Math.atan2(-y, x);
    // keep the arrow and its label inside the view (label is centred below the arrow)
    const k = Math.min((vr.width / 2 - 78) / Math.max(1e-6, Math.abs(Math.cos(ang))), (vr.height / 2 - 44) / Math.max(1e-6, Math.abs(Math.sin(ang))));
    e.edge.hidden = false;
    e.edge.style.left = `${cx + Math.cos(ang) * k}px`;
    e.edge.style.top = `${cy + Math.sin(ang) * k}px`;
    e.edge.querySelector('i').style.transform = `rotate(${ang}rad)`;
    const sp = e.edge.querySelector('span');
    if (sp.textContent !== (text || '')) sp.textContent = text || '';
  }

  placeCard(rect) {
    const c = this.el.card;
    const w = c.offsetWidth, h = c.offsetHeight;
    const phone = innerWidth <= 640;
    const g = this.game;
    const opRight = g.op && !phone ? parseFloat(getComputedStyle(document.body).getPropertyValue('--op-r')) || 0 : 0;
    const opBottom = g.op ? parseFloat(getComputedStyle(document.body).getPropertyValue('--op-b')) || 0 : 0;
    const cands = phone
      ? [['b', 8, innerHeight - h - 8 - opBottom], ['t', 8, 52]]
      : [
          ['bl', 12, innerHeight - h - 12 - opBottom],
          ['br', innerWidth - w - 12 - opRight, innerHeight - h - 12 - opBottom],
          ['tl', 12, 104],
          ['tr', innerWidth - w - 12 - opRight, 104],
        ];
    const hit = (x, y) => rect && !(x + w < rect.left - 8 || x > rect.right + 8 || y + h < rect.top - 8 || y > rect.bottom + 8);
    const bub = this.el.bub;
    const br = !bub.hidden ? bub.getBoundingClientRect() : null;
    const hitB = (x, y) => br && !(x + w < br.left || x > br.right || y + h < br.top || y > br.bottom);
    let pick = cands.find(([, x, y]) => !hit(x, y) && !hitB(x, y)) || cands[0];
    if (g.op && !phone && g.ui.dpEl && !g.ui.dpEl.classList.contains('closed') && pick[0] === 'bl') {
      // over the pinned drawing is fine, but prefer the free middle of the view
      const l = parseFloat(getComputedStyle(document.body).getPropertyValue('--op-l')) || 0;
      if (l + w + 24 < innerWidth - opRight && !hit(l + 12, pick[2])) pick = ['bm', l + 12, pick[2]];
    }
    const [, x, y] = pick;
    if (this._cx !== x || this._cy !== y) {
      this._cx = x; this._cy = y;
      c.style.left = `${Math.max(4, x)}px`;
      c.style.top = `${Math.max(48, y)}px`;
    }
  }
}
