// MillLab manual lathe: application bootstrap for the 'lathe' machine profile. Builds the shop around the
// engine lathe (no G-code control), runs the turning simulation (lathe-sim.js) and keeps the 3D model,
// the workpiece mesh, chips and sound in step with it. The first-person game, job flow and the operator
// panel live in lathe-game.js / lathe-ui.js / lathe-panel.js.
//
// window.__app exposes what the shared add-ons expect (coffee break, operator chair, machine menu,
// marquee): .viewer, .game (.fp, .mode, .op, .ui.toast, .interactables(), .interact()), .settings,
// .sound, .controller.state.
import * as THREE from 'three';
import { MATERIALS } from '../config.js';
import { Viewer } from '../scene/viewer.js';
import { buildWorkshop } from '../scene/workshop.js';
import { Sound } from '../audio/sound.js';
import { LatheModel, LATHE_COLLIDERS, CHUCK_FACE_X, CENTER_Y } from './lathe-model.js';
import { LatheSim, GRAD } from './lathe-sim.js';
import { StockMesh } from './stock-mesh.js';
import { LatheChips } from './lathe-chips.js';
import { LatheGame } from './lathe-game.js';

const SETTINGS_KEY = 'milllab.lathe.settings';
const $ = (s) => document.querySelector(s);
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const TAU = Math.PI * 2;

// Dial graduations run so that the number under the fixed index mark increases as the wheel turns
// clockwise (seen from the operator): the dial angle follows the reading.
export function wheelTurns(sim, axis) {
  const g = GRAD[axis], a = sim.ax[axis];
  return (g.sign * a.hw) / (g.unit * g.div);
}

export class LatheApp {
  constructor() {
    this.lathe = true;
    let s = {};
    try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch { s = {}; }
    this.settings = { volume: 0.7, muted: false, dro: true, droRadius: false, ...s };
    this.controller = { state: 'idle' }; // coffee.js asks whether a program is running
    this.chairPos = { x: 1350, z: 1050 }; // operator chair beside the tailstock end, facing the lathe
    this.chairLook = { x: 0, z: 0 };
    this.vis = { angle: 0, guard: 1, tool: 0, jaw: 56, light: true };
    this.pieces = []; // parted-off pieces in the world (handled by the game)
  }

  saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch { /* storage blocked */ }
  }

  loading(text) {
    const el = $('#loading');
    if (!el) return;
    if (text == null) { el.classList.add('done'); el.hidden = true; return; }
    el.hidden = false;
    const t = $('#loadingText');
    if (t) t.textContent = text;
  }

  async init() {
    document.body.classList.add('lathe', 'ws');
    document.title = 'MillLab: Manual Engine Lathe';
    const bt = $('.brand-text span');
    if (bt) bt.textContent = 'Engine lathe · manual';
    this.loading('Building the lathe…');
    await nextFrame();
    this.viewer = new Viewer($('#view'), $('#viewport'));
    this.model = new LatheModel();
    this.viewer.scene.add(this.model.root);

    // the work light on its gooseneck really lights the work (toggle: LIGHT)
    this.workLight = new THREE.SpotLight(0xfff0d8, 0.9, 1600, 0.55, 0.6, 0);
    this.workLight.position.set(-660, 1430, -262);
    this.workLight.target.position.set(-520, 1100, 20);
    this.viewer.scene.add(this.workLight, this.workLight.target);

    this.sim = new LatheSim();
    this.sim.setTool(1, 'chamfer'); // T2 on the model is the 45 degree V tool (faces and chamfers)
    this.sim.setGuard(true); // the chuck guard starts open: close it before starting the spindle
    this.stockMesh = new StockMesh({ material: 'steel' });
    this.stockMesh.group.visible = false;
    this.model.stockGroup.add(this.stockMesh.group);
    this.chips = new LatheChips(this.viewer.scene);
    this.sound = new Sound();
    this.sound.volume = this.settings.volume;
    this.sound.muted = this.settings.muted;
    const wake = () => { try { this.sound.init(); } catch { /* audio blocked */ } };
    addEventListener('pointerdown', wake, { once: false, passive: true });
    addEventListener('keydown', wake, { once: false });

    this.loading('Building the workshop…');
    await nextFrame();
    this.workshop = buildWorkshop({ camera: this.viewer.camera });
    this.viewer.scene.add(this.workshop.group);
    for (const c of LATHE_COLLIDERS) this.workshop.colliders.push({ ...c });
    this.viewer.scene.fog = new THREE.Fog(0x9aa0a6, 16000, 34000);

    this.sim.on((e) => this.onSimEvent(e));
    this.game = new LatheGame(this);
    window.__game = this.game;
    this.bindTopbar();
    this.loading(null);
    this.last = performance.now();
    const loop = (now) => {
      requestAnimationFrame(loop);
      if (window.__pauseRender) { this.last = now; return; }
      try { this.frame(now); } catch (e) {
        this.last = now;
        if (!this._errT || now - this._errT > 3000) { this._errT = now; console.error('lathe frame', e); }
      }
    };
    requestAnimationFrame(loop);
    window.__app = this;
  }

  bindTopbar() {
    const snd = $('#btnSound');
    const syncSnd = () => { if (snd) snd.innerHTML = `<svg><use href="#i-${this.settings.muted ? 'mute' : 'sound'}"/></svg>`; };
    syncSnd();
    snd?.addEventListener('click', () => {
      this.settings.muted = !this.settings.muted;
      this.sound.setMuted(this.settings.muted);
      this.saveSettings();
      syncSnd();
    });
    $('[data-action="help"]')?.addEventListener('click', () => this.game.ui.showHelp(true));
  }

  // ------------------------------------------------------------------ simulation events
  onSimEvent(e) {
    const g = this.game, snd = this.sound;
    switch (e.type) {
      case 'chip': {
        const s = this.sim.state;
        const n = Math.max(1, Math.min(6, Math.round((e.rate || 0) / 60)));
        const tip = this.model.toolTipWorld(s.toolIndex, new THREE.Vector3());
        this.chips.spawn(n, tip, { hot: s.stock?.material === 'steel' && !s.coolant && (s.cut.vc || 0) > 140, kind: e.tool, dir: s.spindle.dir });
        break;
      }
      case 'drilling': {
        if (Math.random() < 0.5) this.chips.spawn(1, this.model.tailTipWorld(new THREE.Vector3()), { kind: 'drill' });
        break;
      }
      case 'crash': {
        if (e.hard) { snd.crash(); snd.alarm(); this.chips.spawnSparks(80, this.model.toolTipWorld(this.sim.state.toolIndex, new THREE.Vector3()), 1.2); }
        else snd.clunk();
        g?.onCrash(e);
        break;
      }
      case 'rub': snd.noiseBurst?.(2600, 3, 0.002, 0.2, 0.25, 'bandpass'); break;
      case 'toolBroken': snd.crash(); g?.ui?.toast('The tool broke! Reset the alarm (fresh insert) after you back off.', 'warn', 5000); break;
      case 'stall': snd.tone?.(90, 0.01, 0.5, 0.4, 'sawtooth', -50); g?.ui?.toast('Spindle stalled: the cut is too heavy.', 'warn', 4500); break;
      case 'gear': case 'toolIndex': case 'lever': snd.click?.(); break;
      case 'gearGrind': snd.noiseBurst?.(900, 4, 0.005, 0.35, 0.4, 'bandpass'); break;
      case 'chuckClamp': case 'chuckOpen': case 'stockLoaded': snd.clunk(); break;
      case 'estop': snd.estop(); break;
      case 'partedOff': snd.clunk(); g?.onPartedOff(e.piece); break;
      default: break;
    }
    g?.onSimEvent?.(e);
  }

  // ------------------------------------------------------------------ stock
  stockChanged() {
    const s = this.sim.state;
    if (this.sim.profile && s.stock) {
      this.stockMesh.setProfile(this.sim.profile, s.stock.material);
      this.stockMesh.group.visible = true;
      this.chips.setMaterial(s.stock.material);
    } else {
      this.stockMesh.setProfile(null);
      this.stockMesh.group.visible = false;
    }
  }

  // ------------------------------------------------------------------ frame
  frame(now) {
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.game.update(dt);
    this.sim.step(dt);
    if (this.sim.events.length > 200) this.sim.drainEvents();
    this.syncModel(dt);
    this.stockMesh.update(now / 1000);
    this.stockMesh.setWet(this.sim.state.coolant ? 1 : Math.max(0, this.stockMesh.uniforms.uWet.value - dt * 0.05));
    this.game.updatePieces(dt, now / 1000);
    this.chips.update(dt);
    const s = this.sim.state;
    this.sound.update({
      rpm: s.spindle.rpm * 4, load: s.cut.load || 0, cutting: !!s.cut.active, material: s.stock?.material || 'steel',
      flutes: 1, speed: s.feed.engaged !== 'off' || s.halfNut ? 40 : 0, rapid: false, coolant: s.coolant,
    });
    if (!this.game.driveCamera(dt)) this.viewer.update(dt);
    this.workshop.update(dt, this.viewer.camera);
    this.viewer.render();
  }

  // 3D model <- simulation (+ eased purely visual motion: guard, tool post index, jaws, display spin)
  syncModel(dt) {
    const sim = this.sim, s = sim.state, v = this.vis, m = this.model;
    const k = 1 - Math.exp(-dt * 7);
    v.guard += ((s.guardOpen ? 1 : 0) - v.guard) * k;
    let dTool = s.toolIndex - v.tool;
    dTool = ((dTool % 4) + 6) % 4 - 2;
    v.tool += Math.sign(dTool) * Math.min(Math.abs(dTool), dt * 5);
    const jawT = s.stock ? (s.chuck.clamped ? s.stock.dia : s.stock.dia + 5) : (s.chuck.clamped ? 20 : 56);
    v.jaw += (jawT - v.jaw) * k;
    // the displayed spin is limited so high speeds don't strobe backwards at 60 fps
    const rps = s.spindle.w / 60;
    const shown = Math.sign(rps) * Math.min(Math.abs(rps), 2.2 + Math.abs(rps) * 0.06);
    v.angle = (v.angle + shown * TAU * dt) % (TAU * 1000);
    const tip = sim.toolTip();
    m.setTailTool(s.tailstock.tool);
    const tailLen = m.tailToolLen || 0;
    const turns = (ax) => wheelTurns(sim, ax);
    const dialOff = (ax) => { const g = GRAD[ax], a = sim.ax[ax]; return ((g.sign * a.zero) / (g.unit * g.div)) * TAU; }; // collar slip from zeroing
    m.update({
      spindle: { dir: s.spindle.dir, rpm: s.spindle.rpm, angle: v.angle },
      chuck: { dia: v.jaw },
      carriageZ: tip.z, crossX: tip.r,
      compound: { angle: s.compound.angle, slide: s.compound.slide },
      toolIndex: v.tool,
      tailstock: { z: s.tailstock.z + tailLen, quill: s.tailstock.quill, tool: s.tailstock.tool, locked: s.tailstock.locked, quillLock: false },
      gear: s.gear, speeds: s.speeds,
      feed: s.feed, halfNut: s.halfNut, threadPitch: s.threadPitch,
      // clockwise from the operator = negative rotation about the wheel's outward axis
      handwheels: { carriage: -turns('carriage') * TAU, cross: -turns('cross') * TAU, compound: -turns('compound') * TAU, tail: -turns('quill') * TAU },
      dials: { carriage: dialOff('carriage'), cross: dialOff('cross'), compound: dialOff('compound'), tail: dialOff('quill') },
      guardOpen: v.guard, estop: s.estop, coolant: s.coolant, brake: s.spindle.brake ? 1 : 0,
      lightOn: v.light,
    });
    if (m.M.lamp.emissiveIntensity !== (v.light ? 1.4 : 0)) m.M.lamp.emissiveIntensity = v.light ? 1.4 : 0;
    this.workLight.visible = v.light;
  }

  // world position of a lathe (z, r) point on the front (operator) side of the spindle axis
  latheToWorld(z, r, out = new THREE.Vector3()) {
    return out.set(CHUCK_FACE_X + z, CENTER_Y, r);
  }

  materialName(k) { return MATERIALS[k]?.short || k; }
}

export async function startLathe() {
  const app = new LatheApp();
  await app.init();
  return app;
}
