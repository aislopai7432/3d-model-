// GOLD RUSH: game bootstrap and main loop.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { AREAS, DETECTORS, DIGGERS, BAGS, GEAR, RARITIES, RARITY_ORDER, TREASURES, xpForFind, xpForSale } from './config.js';
import { getAtlas } from './textures.js';
import { Pile } from './pile.js';
import { buildWorld, createGroundMaterial } from './world.js';
import { scan as detScan, idText, TONES, DetectorRig } from './detector.js';
import { FX } from './fx.js';
import { Audio } from './audio.js';
import { Thumbs } from './thumbs.js';
import { Refinery } from './buyer.js';
import { valueOf, currentPrices, itemName, massLabel, fineGold } from './treasure.js';
import { loadState, saveState, clearSave, defaultState, detector, digger, capacity, hasGear, digTime, pickReach, addXp, areaLocked, recordFind, checkAchievements } from './state.js';
import { UI, money, moneyShort, TIER_LEVEL } from './ui.js';
import { hashStr } from './rng.js';

const $ = (s) => document.querySelector(s);
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const params = new URLSearchParams(location.search);
const isMobile = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 600;
const CAPTURE = params.has('capture');

function loading(text, pct) {
  $('#load-status').textContent = text;
  if (pct != null) $('#load-bar').style.width = `${pct}%`;
}

class Game {
  constructor() {
    this.state = loadState();
    this.canvas = $('#game');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: CAPTURE });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.02, 400);
    this.camera.position.set(5, 4.5, 7);
    this.controls = new OrbitControls(this.camera, this.canvas);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.08, minDistance: 0.45, maxDistance: 15, maxPolarAngle: 1.4, rotateSpeed: 0.6, zoomSpeed: 0.9, panSpeed: 0.8, screenSpacePanning: false });
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.fx = new FX(this.scene);
    this.rig = new DetectorRig(this.scene);
    this.thumbs = new Thumbs();
    this.refinery = new Refinery(this.renderer);
    this.ui = new UI(this);
    this.pointer = { x: 0, y: 0, inside: false, down: false, downAt: 0, sx: 0, sy: 0, moved: false, type: 'mouse', holding: false };
    this.keys = new Set();
    this.hover = null;
    this.stroke = null;
    this.collecting = [];
    this.markers = [];
    this.scanReady = 0;
    this.detSmooth = 0;
    this.beepTimer = 0;
    this.lastInput = performance.now();
    this.saveDirty = false;
    this.lastSave = performance.now();
    this.mode = 'pile';
    this.shake = 0;
    this.buildTool();
    this.searchLight = new THREE.SpotLight(0xfff4e0, 0, 9, 0.5, 0.5, 1.4);
    this.searchLight.castShadow = false;
    this.scene.add(this.searchLight, this.searchLight.target);
    this.setupComposer();
    this.bindInput();
    Audio.setVolume(this.state.settings.volume);
    Audio.setDetectorVolume(this.state.settings.detVolume);
  }

  // ---- rendering setup ------------------------------------------------------------
  quality() { const q = this.state.settings.quality; return q === 'auto' ? (isMobile ? 'balanced' : 'high') : q; }
  setupComposer() {
    const q = this.quality();
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: q === 'high' ? 4 : 2 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
    this.gtao = null;
    if (q === 'high') {
      this.gtao = new GTAOPass(this.scene, this.camera, 1, 1);
      this.gtao.updateGtaoMaterial({ radius: 0.35, distanceExponent: 1.4, thickness: 1.2, scale: 1.1, samples: 12 });
      this.gtao.blendIntensity = 0.9;
      this.composer.addPass(this.gtao);
    }
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.32, 0.4, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.dprMax = q === 'high' ? (isMobile ? 1.75 : 2) : 1.25;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.dprMax));
    this.resize();
  }
  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.fx.setScale(h * this.renderer.getPixelRatio() / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 0.5);
  }

  // ---- tool model (shovel animates at the dig point) ------------------------------------
  buildTool() {
    this.tool = new THREE.Group();
    this.toolMats = {
      steel: new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.9, roughness: 0.35 }),
      wood: new THREE.MeshStandardMaterial({ color: 0x8a5a32, roughness: 0.7 }),
      grip: new THREE.MeshStandardMaterial({ color: 0x1d1d1f, roughness: 0.6 }),
      paint: new THREE.MeshStandardMaterial({ color: 0xe8743b, roughness: 0.5, metalness: 0.3 }),
    };
    this.tool.visible = false;
    this.scene.add(this.tool);
    this.toolTier = -1;
  }
  setToolModel() {
    const tier = DIGGERS.findIndex((d) => d.id === this.state.equipped.dig);
    if (tier === this.toolTier) return;
    this.toolTier = tier;
    this.tool.clear();
    const M = this.toolMats;
    const s = [0.55, 0.85, 0.85, 0.7, 1.2][tier];
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.016, 0.9 * s, 10), tier === 4 ? M.paint : M.wood);
    handle.position.y = 0.45 * s + 0.08;
    this.tool.add(handle);
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.019, 0.12, 10), M.grip);
    grip.position.y = 0.9 * s + 0.05;
    this.tool.add(grip);
    if (tier === 2) { // rake: tines
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.02, 0.02), M.steel);
      bar.position.y = 0.06;
      this.tool.add(bar);
      for (let k = 0; k < 9; k++) { const t = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.003, 0.09, 6), M.steel); t.position.set(-0.2 + k * 0.05, 0.02, 0.02); t.rotation.x = 0.4; this.tool.add(t); }
    } else if (tier === 4) { // grab bucket
      const bucket = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.16, 0.2, 16, 1, true, 0, Math.PI), M.paint);
      bucket.rotation.z = Math.PI / 2;
      bucket.position.y = 0.1;
      bucket.material.side = THREE.DoubleSide;
      this.tool.add(bucket);
    } else {
      const g = new THREE.SphereGeometry(0.12 * s, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2.6);
      g.scale(0.8, 1.3, 0.35);
      const blade = new THREE.Mesh(g, M.steel);
      blade.material.side = THREE.DoubleSide;
      blade.rotation.x = Math.PI;
      blade.position.y = 0.1 * s;
      this.tool.add(blade);
    }
    this.tool.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  }

  // ---- areas ---------------------------------------------------------------------------
  get area() { return AREAS.find((a) => a.id === this.state.currentArea); }
  pileSave(id) { return this.state.piles[id]; }
  async loadArea(id) {
    document.body.classList.remove('ready');
    loading('Loading ' + AREAS.find((a) => a.id === id).name, 10);
    await nextFrame();
    if (this.pile) {
      this.state.piles[this.area.id] = { ...this.state.piles[this.area.id], ...this.pile.serialize() };
      this.scene.remove(this.pile.group, this.world.group);
      this.pile.dispose();
      this.world.dispose();
      this.pile = null;
    }
    this.state.currentArea = id;
    const area = this.area;
    let ps = this.state.piles[id];
    if (!ps) { ps = { seed: hashStr(id + ':1:' + (this.state.created || 0)) % 1e9, number: 1 }; this.state.piles[id] = ps; }
    loading('Painting the rubbish', 25);
    await nextFrame();
    getAtlas();
    loading('Dumping ' + area.name.toLowerCase(), 45);
    await nextFrame();
    const groundMat = createGroundMaterial(area.look);
    this.pile = new Pile(area, ps.seed, groundMat);
    this.pile.restore(ps);
    loading('Building the yard', 75);
    await nextFrame();
    this.world = buildWorld(area, this.renderer, this.pile, groundMat);
    this.scene.add(this.world.group, this.pile.group);
    this.scene.environment = this.world.env;
    this.scene.fog = new THREE.FogExp2(this.world.look.fog, this.world.look.fogD);
    this.scene.background = new THREE.Color(this.world.look.fog);
    this.renderer.toneMappingExposure = this.world.look.exposure;
    const sm = this.quality() === 'high' ? 2048 : 1024;
    this.world.sun.shadow.mapSize.set(sm, sm);
    for (const t of this.pile.treasures) t.model.traverse((o) => { if (o.isMesh && o.material.envMapIntensity !== undefined) o.material.envMapIntensity = 1.35 * this.world.look.envI + 0.2; });
    // camera
    const top = this.pile.heightAt(0, 0);
    this.controls.target.set(0, top * 0.6, 0);
    this.camera.position.set(5.2, top + 4.2, 7.4);
    this.controls.update();
    this.setToolModel();
    this.markers.forEach((m) => this.scene.remove(m.sprite));
    this.markers = [];
    loading('Ready', 100);
    this.ui.hud();
    this.save();
    await nextFrame();
    document.body.classList.add('ready');
    ['#hud-tl', '#hud-tc', '#hud-tr', '#hud-bl', '#hud-bc', '#hud-br'].forEach((s) => ($(s).hidden = false));
  }
  pileInfo() {
    const p = this.pile ? this.pile.stats() : { found: 0, total: 0, cleared: 0 };
    return { ...p, number: this.state.piles[this.state.currentArea]?.number || 1 };
  }
  pileInfoFor(id) { return id === this.state.currentArea ? this.pileInfo() : { found: 0, total: 0, cleared: 0, number: this.state.piles[id]?.number || 1 }; }
  async travel(id) {
    if (id === this.state.currentArea) return;
    const a = AREAS.find((x) => x.id === id);
    if (areaLocked(this.state, a)) return;
    this.closeRefinery();
    await this.loadArea(id);
    this.ui.info(`Welcome to ${a.name}`, a.blurb, 'star');
  }
  async newPile() {
    const id = this.state.currentArea;
    const old = this.state.piles[id];
    const n = (old?.number || 1) + 1;
    this.state.piles[id] = { seed: hashStr(`${id}:${n}:${this.state.created}`) % 1e9, number: n };
    const pile = this.pile;
    this.pile = null;
    this.scene.remove(pile.group, this.world.group);
    pile.dispose();
    this.world.dispose();
    this.pile = null;
    await this.loadArea(id).catch(() => {});
    this.ui.info('Fresh load delivered', 'A truck has dumped a brand new pile. Happy hunting.', 'star');
  }
  unlockArea(id) {
    const a = AREAS.find((x) => x.id === id);
    const lock = areaLocked(this.state, a);
    if (!lock || !lock.canBuy) { Audio.error(); return; }
    this.state.balance -= a.unlock.price;
    this.state.areasUnlocked.push(id);
    Audio.purchase();
    this.ui.info(`${a.name} unlocked`, 'Open the map to travel there.', 'up');
    this.afterProgress({});
    this.ui.refresh();
  }

  // ---- input -----------------------------------------------------------------------------
  bindInput() {
    const c = this.canvas;
    window.addEventListener('resize', () => this.resize());
    c.addEventListener('pointermove', (e) => {
      this.pointer.x = e.clientX;
      this.pointer.y = e.clientY;
      this.pointer.inside = true;
      this.pointer.type = e.pointerType;
      if (this.pointer.down && Math.hypot(e.clientX - this.pointer.sx, e.clientY - this.pointer.sy) > 7) { this.pointer.moved = true; this.pointer.holding = false; }
      this.lastInput = performance.now();
    });
    c.addEventListener('pointerleave', () => { this.pointer.inside = false; this.ui.tip(); });
    c.addEventListener('pointerdown', (e) => {
      Audio.unlock();
      if (e.button !== 0) return;
      Object.assign(this.pointer, { down: true, downAt: performance.now(), sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, moved: false, holding: false, inside: true, type: e.pointerType });
      this.lastInput = performance.now();
    });
    const up = (e) => {
      if (!this.pointer.down) return;
      const dt = performance.now() - this.pointer.downAt;
      const wasHold = this.pointer.holding;
      this.pointer.down = false;
      this.pointer.holding = false;
      if (!this.pointer.moved && !wasHold && dt < 450 && e.type !== 'pointercancel') this.action(e.clientX, e.clientY);
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (e.target.closest('input')) return;
      Audio.unlock();
      const k = e.key.toLowerCase();
      this.keys.add(k);
      this.lastInput = performance.now();
      if (this.mode === 'refinery') { if (k === 'escape' || k === 'r') this.closeRefinery(); return; }
      if (k === 'escape') { if (!$('#inspect').hidden) this.ui.closeInspect(); else if (this.ui.open) this.ui.close(); else this.ui.toggle('menu'); }
      if (this.ui.open) { if (k === 'i' && this.ui.open === 'bag') this.ui.close(); return; }
      if (k === 't') this.toggle('detector');
      if (k === 'l') this.toggle('light');
      if (k === 'f') this.scan();
      if (k === 'i') this.ui.toggle('bag');
      if (k === 'b') this.ui.toggle('shop');
      if (k === 'm') this.ui.toggle('areas');
      if (k === 'r') this.openRefinery();
      if (k === ' ') { e.preventDefault(); if (this.hover) this.action(this.pointer.x, this.pointer.y); }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.save(true); });
    window.addEventListener('pagehide', () => this.save(true));
  }
  rayAt(x, y) {
    const ndc = new THREE.Vector2((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    return rc;
  }
  // Work out what is under a screen position: hut, treasure, rubbish or soil.
  probe(x, y) {
    if (!this.pile) return null;
    const rc = this.rayAt(x, y);
    const hit = this.pile.pick(rc.ray);
    const huts = rc.intersectObjects(this.world.clickables, true);
    if (huts.length && (!hit || huts[0].distance < hit.dist)) return { kind: 'hut', target: huts[0].object.userData.click, point: huts[0].point };
    if (!hit) return null;
    const t = this.pile.pickTreasure(rc.ray, hit.point, pickReach(this.state));
    if (t) return { kind: 'treasure', t, point: hit.point, cell: hit.cell };
    const item = this.pile.topItem(hit.cell);
    if (item >= 0) return { kind: 'junk', item, point: hit.point, cell: hit.cell };
    if (hit.cell >= 0) return { kind: 'soil', point: hit.point, cell: hit.cell };
    return { kind: 'ground', point: hit.point, cell: -1 };
  }
  action(x, y) {
    if (this.mode !== 'pile' || this.ui.open) return;
    const p = this.probe(x, y);
    if (!p) return;
    if (p.kind === 'hut') { if (p.target === 'refinery') this.openRefinery(); else this.ui.toggle('shop'); return; }
    if (p.kind === 'treasure') { this.collect(p.t, x, y); return; }
    if (p.kind === 'junk' || p.kind === 'soil') this.startStroke(p);
  }

  // ---- digging ---------------------------------------------------------------------------
  startStroke(p) {
    if (this.stroke) return;
    this.stroke = { t: 0, dur: digTime(this.state), point: p.point.clone(), cell: p.cell, done: false, kind: p.kind };
    this.tool.visible = true;
  }
  updateStroke(dt) {
    const s = this.stroke;
    if (!s) { this.ui.digProgress(0); return; }
    s.t += dt;
    const k = Math.min(1, s.t / s.dur);
    this.ui.digProgress(k);
    // shovel motion: wind up, plunge, flick back
    const lift = k < 0.4 ? THREE.MathUtils.smoothstep(k, 0, 0.4) : k < 0.55 ? 1 - THREE.MathUtils.smoothstep(k, 0.4, 0.55) : THREE.MathUtils.smoothstep(k, 0.55, 1) * 0.8;
    const camDir = new THREE.Vector3().subVectors(this.camera.position, s.point).setY(0).normalize();
    this.tool.position.copy(s.point).addScaledVector(camDir, 0.12).add(new THREE.Vector3(0, lift * 0.25 - 0.03, 0));
    this.tool.lookAt(this.tool.position.clone().add(camDir));
    this.tool.rotateX(-0.5 - lift * 0.6 + (k > 0.55 ? (k - 0.55) * 1.4 : 0));
    if (!s.done && k >= 0.48) { s.done = true; this.doDig(s); }
    if (k >= 1) {
      this.stroke = null;
      this.tool.visible = false;
      if (this.pointer.holding) {
        const p = this.probe(this.pointer.x, this.pointer.y);
        if (p && (p.kind === 'junk' || p.kind === 'soil')) this.startStroke(p);
        else if (p && p.kind === 'treasure') { this.pointer.holding = false; this.collect(p.t, this.pointer.x, this.pointer.y); }
      }
    }
  }
  doDig(s) {
    const tool = digger(this.state);
    const res = this.pile.dig(s.point, tool, { focusCell: s.cell });
    if (res.removed.length) {
      this.state.stats.rubbish += res.removed.length;
      Audio.dig();
      const metal = res.removed.some((i) => this.pile.itemMetal[i] === 1 || this.pile.itemMetal[i] === 2);
      const glass = res.removed.some((i) => this.pile.itemKey[i] === 'glass');
      setTimeout(() => Audio.rustle(metal ? 'metal' : glass ? 'glass' : 'soft'), 60);
      this.fx.dig(s.point, this.area.look === 'forgotten' ? 0xb39268 : 0x8f8068, 12 + res.removed.length * 4);
      this.markDirty();
    } else if (res.soilCells.length) {
      Audio.dig();
      this.fx.dirt(s.point);
      this.markDirty();
    } else {
      Audio.shovelScrape();
      if (!this.hintBlocked) { this.hintBlocked = true; this.ui.info('Something is in the way', 'There is a find showing here. Pick it up before digging deeper.', 'warn'); }
    }
    // newly uncovered finds: sparkle so the player notices; sieves collect small ones automatically
    const sift = tool.sift || hasGear(this.state, 'sieve');
    for (const t of res.newly) {
      if (sift && t.siftable && this.state.inventory.length < capacity(this.state)) { this.collect(t, null, null, { sifted: true }); continue; }
      this.fx.glint(t.pos.clone().add(new THREE.Vector3(0, 0.01, 0)), 0.12);
      this.fx.sparkle(t.pos, 0xffe6a8, 10, 0.4);
    }
    const st = this.pile.stats();
    if (st.cleared >= 0.9) this.afterProgress({ cleared: st.cleared });
    this.ui.hud();
  }

  // ---- collecting -------------------------------------------------------------------------
  collect(t, sx, sy, { sifted = false } = {}) {
    const s = this.state;
    if (s.inventory.length >= capacity(s)) {
      Audio.error();
      this.ui.info('Your bag is full', `Sell your finds at the refinery, or buy a bigger bag (${capacity(s)} max).`, 'bag');
      return;
    }
    this.pile.markCollected(t);
    const item = { ...t.item, found: Date.now(), area: this.area.id, areaName: this.area.name, keep: false };
    s.inventory.push(item);
    const value = valueOf(item);
    recordFind(s, item);
    if (!s.stats.best || value > s.stats.best.value) s.stats.best = { name: itemName(item), value, area: this.area.name };
    const rIdx = RARITY_ORDER.indexOf(item.rarity);
    const xp = xpForFind(value, item.rarity);
    this.collecting.push({ t, time: 0, start: t.model.position.clone(), spin: (Math.random() - 0.5) * 8 });
    const colour = item.metal === 'silver' ? 0xe8eef8 : ['diamond', 'bigDiamond'].includes(item.kind) ? 0xdff0ff : 0xffcf6a;
    this.fx.sparkle(t.pos.clone().add(new THREE.Vector3(0, 0.02, 0)), colour, 40 + rIdx * 40, 0.6 + rIdx * 0.35);
    Audio.collect(rIdx);
    if (rIdx >= 4) { this.ui.flash(); this.shake = 0.6; }
    else if (rIdx >= 3) this.shake = 0.25;
    this.ui.findToast(item, value);
    if (sx != null) this.ui.flyToBag(sx, sy, this.thumbs.get(item));
    if (sifted) this.ui.info('Sieve caught something', `${itemName(item)} (${massLabel(item.mass)}) shaken out of the rubbish.`, 'star');
    this.gainXp(xp);
    this.afterProgress({ kind: item.kind });
    this.ui.hud();
    if (this.ui.open === 'bag') this.ui.renderBag();
    this.markDirty();
  }
  updateCollecting(dt) {
    for (const c of this.collecting) {
      c.time += dt;
      const k = Math.min(1, c.time / 0.75);
      const m = c.t.model;
      m.position.copy(c.start).add(new THREE.Vector3(0, Math.sin(k * Math.PI * 0.5) * 0.35, 0));
      m.rotation.y += c.spin * dt;
      const size = m.userData.size || 0.01;
      const boost = Math.max(1, 0.04 / size);
      m.scale.setScalar(k < 0.7 ? 1 + (boost - 1) * (k / 0.7) : boost * (1 - (k - 0.7) / 0.3));
      if (k >= 1) m.visible = false;
    }
    this.collecting = this.collecting.filter((c) => c.time < 0.75);
  }
  gainXp(n) {
    const up = addXp(this.state, n);
    if (up > 0) {
      Audio.levelUp();
      this.ui.info(`Level ${this.state.level}`, this.levelUnlockText(), 'up');
    }
  }
  levelUnlockText() {
    const l = this.state.level;
    const unlocks = [];
    for (const [cat, list] of [['det', DETECTORS], ['dig', DIGGERS], ['bag', BAGS]]) for (const p of list) if (TIER_LEVEL[p.level] === l) unlocks.push(p.name);
    for (const a of AREAS) if (a.unlock.level === l) unlocks.push(a.name);
    return unlocks.length ? `Now available: ${unlocks.join(', ')}.` : 'Your reputation grows. Better finds await.';
  }
  afterProgress(ctx) {
    const got = checkAchievements(this.state, ctx);
    for (const a of got) { this.ui.info('Achievement: ' + a.name, a.desc, 'star'); Audio.levelUp(); }
    this.markDirty();
  }

  // ---- detector, light, scanner -----------------------------------------------------------
  toggle(key) {
    const s = this.state;
    if (key === 'light' && !hasGear(s, 'light')) { Audio.error(); this.ui.info('No search light yet', 'Buy the Portable Search Light at Prospector Supply.', 'warn'); return; }
    if (key === 'ironReject' && detector(s).notch < 1) return;
    if (key === 'alReject' && detector(s).notch < 2) return;
    s.toggles[key] = !s.toggles[key];
    Audio.ui();
    this.ui.hud();
    this.markDirty();
  }
  scan() {
    const s = this.state;
    if (!hasGear(s, 'scanner')) { Audio.error(); this.ui.info('No scanner', 'The Gold Pulse Scanner is sold at Prospector Supply.', 'warn'); return; }
    const now = performance.now() / 1000;
    if (now < this.scanReady) { Audio.error(); return; }
    this.scanReady = now + 20;
    const centre = this.hover ? this.hover.point : this.controls.target;
    Audio.scanner();
    this.fx.pulse(centre, 4);
    let n = 0;
    for (const t of this.pile.treasures) {
      if (t.collected) continue;
      const d = Math.hypot(t.pos.x - centre.x, t.pos.z - centre.z);
      if (d > 4 || (TREASURES[t.item.kind].metal === 'copper')) continue;
      const depth = this.pile.topHeight(t.cell) - t.pos.y;
      if (depth > 3) continue;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.markerTexture(RARITIES[t.item.rarity].color), depthTest: false, transparent: true }));
      sprite.scale.setScalar(0.22);
      sprite.position.set(t.pos.x, this.pile.topHeight(t.cell) + 0.25, t.pos.z);
      sprite.renderOrder = 20;
      this.scene.add(sprite);
      this.markers.push({ sprite, t: 0, delay: d * 0.12 });
      n++;
    }
    this.ui.info('Pulse sent', n ? `${n} target${n > 1 ? 's' : ''} marked within 4 m.` : 'Nothing valuable within 4 m.', 'star');
  }
  markerTexture(col) {
    this.markerTex ||= new Map();
    if (this.markerTex.has(col)) return this.markerTex.get(col);
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('2d');
    x.translate(32, 32);
    x.rotate(Math.PI / 4);
    x.fillStyle = col;
    x.strokeStyle = '#1a1408';
    x.lineWidth = 4;
    x.fillRect(-14, -14, 28, 28);
    x.strokeRect(-14, -14, 28, 28);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    this.markerTex.set(col, t);
    return t;
  }
  updateDetector(dt) {
    const s = this.state, det = detector(s);
    const on = s.toggles.detector && this.mode === 'pile' && !!this.hover;
    let hit = { s: 0, metal: 0 };
    if (on) hit = detScan(this.pile, this.hover.point.x, this.hover.point.z, det, s.toggles);
    this.detSmooth += (hit.s - this.detSmooth) * Math.min(1, dt * 10);
    const v = this.detSmooth;
    this.rig.update(dt, this.hover && this.mode === 'pile' ? this.hover.point : null, this.hover?.normal, det, hit, s.toggles.detector && this.mode === 'pile');
    // beeps: faster and louder as the signal grows, pitched by metal type
    if (on && v > 0.05) {
      this.beepTimer -= dt;
      if (this.beepTimer <= 0) {
        Audio.beep(TONES[hit.metal] || 600, v);
        this.beepTimer = THREE.MathUtils.lerp(0.95, 0.07, Math.pow(Math.min(1, v), 0.7));
      }
    } else this.beepTimer = 0;
    this.detTick = (this.detTick || 0) + dt;
    if (this.detTick > 0.06) {
      this.detTick = 0;
      const depth = det.idLevel >= 2 && hit.s > 0.08 ? `≈ ${hit.depth.toFixed(2)} m deep` : '';
      this.ui.detector(Math.min(1, v), idText(det, hit), depth, hit.metal, s.toggles.detector);
    }
  }
  updateGlints(dt) {
    if (!this.pile) return;
    const light = hasGear(this.state, 'light') && this.state.toggles.light;
    const rate = (this.world.look.outdoor ? 0.45 : 0.25) * (light ? 2.5 : 1);
    const cam = this.camera.position;
    for (const t of this.pile.treasures) {
      if (!t.exposed || t.collected) continue;
      const d = cam.distanceTo(t.pos);
      if (d > 14) continue;
      const lightNear = light && this.hover && this.hover.point.distanceTo(t.pos) < 2.5 ? 3 : 1;
      if (Math.random() < dt * rate * lightNear) {
        const size = THREE.MathUtils.clamp((t.model.userData.size || 0.01) * 1.2, 0.03, 0.14) * (0.8 + Math.random() * 0.6);
        this.fx.glint(t.pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.01, 0.006, (Math.random() - 0.5) * 0.01)), size, t.item.metal === 'silver' ? 0xeef4ff : 0xfff0c8);
      }
    }
  }

  // ---- hover --------------------------------------------------------------------------
  updateHover() {
    if (this.mode !== 'pile' || this.ui.open || !this.pile) { this.hover = null; this.pile && this.pile.setHighlight(null); this.ui.tip(); return; }
    // touch has no hover: aim at the centre of the view instead
    let x = this.pointer.x, y = this.pointer.y;
    if (this.pointer.type !== 'mouse' || !this.pointer.inside) { x = window.innerWidth / 2; y = window.innerHeight * 0.45; }
    const p = this.probe(x, y);
    this.hover = p && p.kind !== 'hut' && p.point ? p : null;
    if (this.hover) {
      const e = 0.12;
      const h = (dx, dz) => this.pile.heightAt(p.point.x + dx, p.point.z + dz);
      this.hover.normal = new THREE.Vector3(h(-e, 0) - h(e, 0), 2 * e, h(0, -e) - h(0, e)).normalize();
    }
    this.pile.setHighlight(p && p.kind === 'junk' ? p.item : null);
    this.canvas.className = p && (p.kind === 'treasure' || p.kind === 'hut') ? 'pick' : p ? 'dig' : '';
    if (this.pointer.type !== 'mouse' || !this.pointer.inside || this.pointer.down) { this.ui.tip(); return; }
    let html = '';
    if (!p) html = '';
    else if (p.kind === 'hut') html = p.target === 'refinery' ? '<b>Aurum Refinery</b><small>Click to weigh and sell your finds</small>' : '<b>Prospector Supply</b><small>Click to buy better equipment</small>';
    else if (p.kind === 'treasure') {
      const it = p.t.item;
      const loupe = hasGear(this.state, 'magnifier');
      html = loupe || it.mass > 2 || ['coin'].includes(it.kind) ? `<b style="color:${RARITIES[it.rarity].color}">${itemName(it)}</b><small>${loupe ? massLabel(it.mass) + ' · ' + money(valueOf(it)) + ' · ' : ''}Click to collect</small>` : '<b style="color:#ffd479">Something glinting</b><small>Click to pick it up</small>';
    } else if (p.kind === 'junk') html = `<b>${this.pile.itemKey[p.item] ? (this.junkName(p.item)) : ''}</b><small>Click or hold to clear · layer ${this.pile.cellTop[p.cell]}</small>`;
    else if (p.kind === 'soil') html = this.pile.soil[p.cell] >= 0.59 ? '<b>Bedrock</b><small>You cannot dig deeper here</small>' : `<b>Bare soil</b><small>Dig into the ground · ${Math.round(this.pile.soil[p.cell] * 100)} cm dug</small>`;
    this.ui.tip(this.pointer.x, this.pointer.y, html);
  }
  junkName(i) { return ({ can: 'Crushed drinks can', bottle: 'Plastic bottle', box: 'Cardboard box', sheet: 'Flattened cardboard', paper: 'Old newspaper', bag: 'Plastic bag', clothes: 'Old clothes', packaging: 'Food packaging', toy: 'Broken toy', wood: 'Wood fragment', household: 'Household junk', glass: 'Glass bottle', tyre: 'Worn-out tyre', electronics: 'Dead electronics', monitor: 'Broken monitor', cables: 'Tangled cables', pcb: 'Circuit board', scrap: 'Scrap metal', furniture: 'Broken furniture', machinery: 'Rusty machine part', rubble: 'Stone rubble', pottery: 'Pottery shard', rustiron: 'Corroded ironwork' })[this.pile.itemKey[i]] || 'Rubbish'; }

  // ---- refinery ----------------------------------------------------------------------------
  openRefinery(preselect) {
    if (this.mode === 'refinery') return;
    this.ui.close(true);
    this.mode = 'refinery';
    this.ui.tip();
    this.lastPrices = currentPrices();
    this.refinery.drawBoard(this.lastPrices);
    this.ui.refSel = new Set((preselect && preselect.length ? preselect : this.state.inventory.filter((i) => !i.keep).map((i) => i.uid)));
    $('#refinery').hidden = false;
    ['#hud-tl', '#hud-tc', '#hud-bl', '#hud-bc', '#hud-br'].forEach((s) => ($(s).hidden = true));
    $('#hud-tr .chips').hidden = true;
    this.ui.renderRefinery();
    Audio.ui();
  }
  closeRefinery() {
    if (this.mode !== 'refinery') return;
    this.mode = 'pile';
    $('#refinery').hidden = true;
    ['#hud-tl', '#hud-tc', '#hud-bl', '#hud-bc', '#hud-br'].forEach((s) => ($(s).hidden = false));
    $('#hud-tr .chips').hidden = false;
    this.refinery.clear();
    this.ui.hud();
  }
  sell(uids) {
    const s = this.state, prices = currentPrices();
    const items = s.inventory.filter((i) => uids.includes(i.uid) && !i.keep);
    if (!items.length) return;
    const total = Math.round(items.reduce((a, i) => a + valueOf(i, prices), 0) * 100) / 100;
    s.inventory = s.inventory.filter((i) => !items.includes(i));
    s.balance = Math.round((s.balance + total) * 100) / 100;
    s.stats.earned += total;
    s.stats.itemsSold += items.length;
    s.stats.goldSoldGrams += items.reduce((a, i) => a + (i.metal === 'gold' ? i.mass : 0), 0);
    s.sales.unshift({ t: Date.now(), n: items.length, total, fine: items.reduce((a, i) => a + fineGold(i), 0) });
    s.sales = s.sales.slice(0, 40);
    this.gainXp(items.reduce((a, i) => a + xpForSale(valueOf(i, prices)), 0));
    Audio.sell(total);
    this.ui.paid(total);
    setTimeout(() => this.ui.bumpMoney(), 1300);
    this.ui.refSel.clear();
    this.ui.renderRefinery();
    this.ui.hud();
    this.afterProgress({});
    this.save(true);
  }
  toggleKeep(uids) {
    const items = this.state.inventory.filter((i) => uids.includes(i.uid));
    const allKept = items.every((i) => i.keep);
    for (const i of items) i.keep = !allKept;
    Audio.ui();
    this.markDirty();
  }

  // ---- shop ----------------------------------------------------------------------------------
  buy(cat, id) {
    const s = this.state;
    const list = { det: DETECTORS, dig: DIGGERS, bag: BAGS, gear: GEAR }[cat];
    const p = list.find((x) => x.id === id);
    if (!p || s.balance < p.price) { Audio.error(); return; }
    s.balance = Math.round((s.balance - p.price) * 100) / 100;
    if (cat === 'gear') s.owned.gear.push(id);
    else { s.owned[cat].push(id); s.equipped[cat] = id; }
    if (id === 'light') s.toggles.light = true;
    Audio.purchase();
    this.ui.info(`${p.name} purchased`, cat === 'gear' ? p.desc : 'Equipped and ready to use.', 'up');
    this.setToolModel();
    this.afterProgress({});
    this.ui.hud();
    this.ui.refresh();
    this.save(true);
  }
  equip(cat, id) {
    if (!this.state.owned[cat].includes(id)) return;
    this.state.equipped[cat] = id;
    Audio.ui();
    this.setToolModel();
    this.ui.hud();
    this.ui.refresh();
    this.markDirty();
  }

  // ---- objectives ----------------------------------------------------------------------------
  objective() {
    const s = this.state, st = s.stats;
    const p = this.pileInfo();
    if (st.rubbish < 12 && !st.treasures) return { text: 'Click or hold on the pile to clear rubbish. Drag to look around.', prog: `${st.rubbish}/12` };
    if (!st.treasures) return { text: 'Find something valuable. Gold gives a clean mid-tone beep; iron grunts low.' };
    if (!st.itemsSold) return { text: 'Take your finds to the Gold Buyer hut (or press Sell) and cash in.' };
    if (s.inventory.length >= capacity(s)) return { text: 'Your bag is full. Sell at the refinery or buy a bigger bag.' };
    if (p.cleared > 0.85 || (p.total && p.found >= p.total)) return { text: 'This load is picked clean. Truck in a fresh load from the map.' };
    const nextDet = DETECTORS.find((d) => !s.owned.det.includes(d.id));
    const nextArea = AREAS.find((a) => !s.areasUnlocked.includes(a.id));
    if (nextDet && nextDet.level === 2) return { text: `Save up for the ${nextDet.name}`, prog: `${moneyShort(s.balance)} / ${moneyShort(nextDet.price)}` };
    if (nextArea) {
      const lock = areaLocked(s, nextArea);
      if (lock.canBuy) return { text: `You can unlock ${nextArea.name}. Open the map.` };
      return { text: `Unlock ${nextArea.name}: ${lock.reasons.length ? lock.reasons.join(', ') + ' and ' : ''}${money(nextArea.unlock.price, 0)}`, prog: `${moneyShort(s.balance)} / ${moneyShort(nextArea.unlock.price)}` };
    }
    if (nextDet) return { text: `Save up for the ${nextDet.name}`, prog: `${moneyShort(s.balance)} / ${moneyShort(nextDet.price)}` };
    if (!(st.byRarity.legendary > 0)) return { text: 'Find a legendary treasure in the Forgotten Treasure Site.' };
    return { text: 'Become a millionaire.', prog: `${moneyShort(st.earned)} / £1m` };
  }

  // ---- settings & saving ----------------------------------------------------------------------
  setSetting(k, v) {
    this.state.settings[k] = v;
    if (k === 'volume') Audio.setVolume(v);
    if (k === 'detVolume') Audio.setDetectorVolume(v);
    if (k === 'quality') {
      this.composer.dispose();
      this.setupComposer();
      if (this.world) { const sm = this.quality() === 'high' ? 2048 : 1024; this.world.sun.shadow.mapSize.set(sm, sm); this.world.sun.shadow.map?.dispose(); this.world.sun.shadow.map = null; }
    }
    this.markDirty();
  }
  markDirty() { this.saveDirty = true; }
  save(force) {
    if (!force && !this.saveDirty) return;
    if (this.pile) this.state.piles[this.state.currentArea] = { ...this.state.piles[this.state.currentArea], ...this.pile.serialize() };
    saveState(this.state);
    this.saveDirty = false;
    this.lastSave = performance.now();
  }
  resetProgress() {
    clearSave();
    this.state = defaultState();
    saveState(this.state);
    location.reload();
  }
  onPanel() { this.ui.tip(); }

  // ---- camera ---------------------------------------------------------------------------------
  updateCamera(dt) {
    const c = this.controls;
    const fwd = new THREE.Vector3().subVectors(c.target, this.camera.position).setY(0);
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
    const dist = this.camera.position.distanceTo(c.target);
    const sp = (0.8 + dist * 0.45) * dt;
    const mv = new THREE.Vector3();
    if (this.mode === 'pile' && !this.ui.open) {
      if (this.keys.has('w') || this.keys.has('arrowup')) mv.add(fwd);
      if (this.keys.has('s') || this.keys.has('arrowdown')) mv.sub(fwd);
      if (this.keys.has('a') || this.keys.has('arrowleft')) mv.sub(right);
      if (this.keys.has('d') || this.keys.has('arrowright')) mv.add(right);
      const rot = (this.keys.has('q') ? 1 : 0) - (this.keys.has('e') ? 1 : 0);
      if (rot) {
        const off = new THREE.Vector3().subVectors(this.camera.position, c.target);
        off.applyAxisAngle(new THREE.Vector3(0, 1, 0), rot * dt * 1.4);
        this.camera.position.copy(c.target).add(off);
      }
    }
    if (mv.lengthSq()) { mv.normalize().multiplyScalar(sp); c.target.add(mv); this.camera.position.add(mv); }
    // keep the focus inside the yard and resting on the surface
    const lim = this.pile ? this.pile.N * 0.3 / 2 + 1 : 8;
    const tx = THREE.MathUtils.clamp(c.target.x, -lim, lim), tz = THREE.MathUtils.clamp(c.target.z, -lim, lim);
    if (tx !== c.target.x || tz !== c.target.z) { const d = new THREE.Vector3(tx - c.target.x, 0, tz - c.target.z); c.target.add(d); this.camera.position.add(d); }
    if (this.pile) {
      const want = this.pile.heightAt(c.target.x, c.target.z) + 0.1;
      const dy = (want - c.target.y) * Math.min(1, dt * 2.5);
      c.target.y += dy;
      this.camera.position.y += dy;
      const floor = this.pile.heightAt(this.camera.position.x, this.camera.position.z) + 0.15;
      if (this.camera.position.y < floor) this.camera.position.y = floor;
    }
    c.update();
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt);
      this.camera.position.add(new THREE.Vector3((Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5)).multiplyScalar(this.shake * 0.03));
    }
  }

  // ---- loop ---------------------------------------------------------------------------------
  frame(now) {
    const dt = Math.min(0.05, (now - (this.last || now)) / 1000);
    this.last = now;
    this.time = (this.time || 0) + dt;
    if (this.mode === 'pile' && this.pile) {
      // holding still on the pile keeps digging
      if (this.pointer.down && !this.pointer.moved && !this.pointer.holding && now - this.pointer.downAt > 320 && !this.ui.open) {
        const p = this.probe(this.pointer.x, this.pointer.y);
        if (p && (p.kind === 'junk' || p.kind === 'soil')) { this.pointer.holding = true; this.startStroke(p); }
        else if (p && p.kind === 'treasure') { this.pointer.holding = true; this.collect(p.t, this.pointer.x, this.pointer.y); }
      }
      this.controls.enabled = !this.pointer.holding;
      this.updateCamera(dt);
      this.updateHover();
      this.updateStroke(dt);
      this.updateCollecting(dt);
      this.updateDetector(dt);
      this.updateGlints(dt);
      this.pile.update(dt);
      this.world.update(this.time, dt);
      this.fx.update(dt);
      // search light follows the search head
      const light = hasGear(this.state, 'light') && this.state.toggles.light && this.hover;
      this.searchLight.intensity = light ? (this.world.look.outdoor ? 16 : 34) : 0;
      if (light) {
        const camDir = new THREE.Vector3().subVectors(this.camera.position, this.hover.point).setY(0).normalize();
        this.searchLight.position.copy(this.hover.point).addScaledVector(camDir, 1.2).add(new THREE.Vector3(0, 2.6, 0));
        this.searchLight.target.position.copy(this.hover.point);
      }
      // scanner markers
      for (const m of this.markers) {
        m.t += dt;
        const k = m.t - m.delay;
        m.sprite.visible = k > 0;
        m.sprite.material.opacity = k < 0 ? 0 : k < 5 ? 0.6 + Math.sin(k * 6) * 0.3 : Math.max(0, 1 - (k - 5));
        m.sprite.position.y += Math.sin(m.t * 3) * 0.0008;
        if (k > 6) this.scene.remove(m.sprite);
      }
      this.markers = this.markers.filter((m) => m.t - m.delay <= 6);
      this.ui.scanCooldown(Math.max(0, this.scanReady - now / 1000) / 20);
      // the sun's shadow camera follows the focus so shadows stay crisp where you look
      const tgt = this.controls.target;
      this.world.sun.target.position.set(tgt.x, 0, tgt.z);
      this.world.sun.position.copy(this.world.sun.target.position).add(new THREE.Vector3(...this.world.look.sunDir).normalize().multiplyScalar(18));
      // search time
      if (!document.hidden && now - this.lastInput < 90000 && !this.ui.open) {
        this.state.stats.searchTime += dt;
        if (Math.floor(this.state.stats.searchTime) % 60 === 0 && Math.floor(this.state.stats.searchTime - dt) % 60 === 59) this.afterProgress({});
      }
      this.composer.render(dt);
    } else if (this.mode === 'refinery') {
      this.refinery.setPointer(this.pointer.x / window.innerWidth * 2 - 1, -(this.pointer.y / window.innerHeight * 2 - 1));
      this.refinery.update(dt);
      const panelW = window.innerWidth > 700 ? Math.min(460, window.innerWidth) : 0;
      if (window.innerWidth > 700) this.refinery.render(this.renderer, window.innerWidth, window.innerHeight, panelW / 2);
      else { this.renderer.setViewport(0, window.innerHeight * 0.62, window.innerWidth, window.innerHeight * 0.38); this.refinery.render(this.renderer, window.innerWidth, window.innerHeight * 0.38); this.renderer.setViewport(0, 0, window.innerWidth, window.innerHeight); }
    }
    this.thumbs.updatePreview(dt);
    if (performance.now() - this.lastSave > 15000) this.save();
    // adaptive resolution
    this.fpsAcc = (this.fpsAcc || 0) + dt;
    this.fpsN = (this.fpsN || 0) + 1;
    if (this.fpsAcc > 3 && !CAPTURE) {
      const avg = this.fpsAcc / this.fpsN;
      if (avg > 1 / 28 && this.renderer.getPixelRatio() > 0.8) { this.renderer.setPixelRatio(this.renderer.getPixelRatio() * 0.85); this.resize(); }
      this.fpsAcc = 0;
      this.fpsN = 0;
    }
    if (!CAPTURE) requestAnimationFrame((t) => this.frame(t));
  }
}

async function boot() {
  loading('Starting', 4);
  const game = new Game();
  window.__game = game;
  await game.loadArea(game.state.currentArea);
  if (!game.state.tutorial.welcome) {
    game.state.tutorial.welcome = true;
    setTimeout(() => game.ui.info('Welcome to the dump', 'Somewhere in this rubbish there is gold. Dig, listen to the detector, and click anything that glints.', 'star'), 1200);
  }
  if (CAPTURE) {
    // test hook: advance n frames; with fast=true only the last frame is rendered
    window.__step = (ms = 16, n = 1, fast = false) => {
      const realC = game.composer.render.bind(game.composer), realR = game.refinery.render.bind(game.refinery);
      for (let i = 0; i < n; i++) {
        const skip = fast && i < n - 1;
        if (skip) { game.composer.render = () => {}; game.refinery.render = () => {}; }
        game.frame((game.last || 0) + ms);
        game.composer.render = realC; game.refinery.render = realR;
      }
    };
  } else requestAnimationFrame((t) => game.frame(t));
}

boot().catch((e) => {
  console.error(e);
  loading('Something went wrong: ' + e.message, 100);
});
