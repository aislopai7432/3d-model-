import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createMaterials, PAINTS, WHEEL_FINISHES, CALIPERS, INTERIORS } from './materials.js';
import { buildEnvironment, buildFloor, buildContactShadow, BG } from './studio.js';
import { buildCar } from './car.js';
import { D } from './body.js';

const $ = (s) => document.querySelector(s);
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const status = (t) => { const el = $('#loader-status'); if (el) el.textContent = t; };

const params = new URLSearchParams(location.search);
const isMobile = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 600;
const state = {
  quality: params.get('q') || 'high',
  paint: PAINTS[0].id,
  wheelStyle: 0,
  wheelFinish: WHEEL_FINISHES[0].id,
  caliper: CALIPERS[0].id,
  interior: INTERIORS[0].id,
  headlights: false,
  brake: false,
  hazard: false,
  ambient: true,
  doorsOpen: false,
  showcase: false,
};

async function main() {
  const canvas = $('#scene');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: params.has('capture') });
  const dprFor = (q) => Math.min(window.devicePixelRatio, q === 'high' ? (isMobile ? 1.75 : 2) : 1.25);
  renderer.setPixelRatio(dprFor(state.quality));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = BG.clone();
  scene.fog = new THREE.Fog(BG, 11, 26);

  status('Lighting the studio');
  await nextFrame();
  scene.environment = buildEnvironment(renderer);

  const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.06, 90);
  camera.position.set(6.4, 1.6, 4.9);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.target.set(0, 0.55, 0);
  controls.minDistance = 0.35;
  controls.maxDistance = 16;
  controls.maxPolarAngle = Math.PI / 2 - 0.015;
  controls.zoomSpeed = 0.8;
  controls.rotateSpeed = 0.7;
  controls.panSpeed = 0.7;
  controls.screenSpacePanning = true;
  controls.autoRotateSpeed = 0.9;
  controls.update();

  const M = createMaterials();
  const car = buildCar(M, async (msg) => status(msg));
  scene.add(car);
  const api = car.userData.api;
  await nextFrame();

  const floor = buildFloor(scene, { pixelRatio: renderer.getPixelRatio() });
  const shadow = buildContactShadow(renderer, scene, [floor]);
  scene.add(shadow);

  // Key directional light for crisp speculars, plus a weak hemisphere for the cabin.
  const key = new THREE.DirectionalLight(0xffffff, 0.6);
  key.position.set(3, 8, 4);
  scene.add(key);
  scene.add(new THREE.HemisphereLight(0x9aa4b0, 0x080808, 0.25));
  // Soft pool of light on the floor around the car
  const pool = new THREE.SpotLight(0xffffff, 12, 0, 0.62, 1, 2);
  pool.position.set(0, 9, 0);
  pool.target.position.set(0, 0, 0);
  scene.add(pool, pool.target);

  // ---- Post-processing ----
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.32, 0.45, 1.6);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const resize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(w, h);
    camera.aspect = w / h;
    // On portrait screens the configurator sheet covers the lower third, so shift
    // the projection window to centre the car in the space above it.
    const sheet = document.querySelector('.sheet');
    const sh = sheet ? sheet.getBoundingClientRect().height : 0;
    document.documentElement.style.setProperty('--sheet-h', `${Math.round(sh)}px`);
    if (currentView !== 'interior' && !anim) camera.fov = baseFov();
    camera.setViewOffset(w, h, 0, Math.round(sh * (w < 760 ? 0.42 : 0.3)), w, h);
    camera.updateProjectionMatrix();
    const r = floor.userData.reflector;
    if (r) r.getRenderTarget().setSize(Math.round(w * renderer.getPixelRatio() * 0.5), Math.round(h * renderer.getPixelRatio() * 0.5));
    fitView();
  };

  // ---- Camera views & transitions ----
  const VIEWS = {
    hero: { pos: [5.6, 1.45, 4.4], target: [0.05, 0.52, 0] },
    front: { pos: [7.4, 0.95, 0], target: [0, 0.5, 0] },
    side: { pos: [0.1, 0.85, 7.6], target: [0, 0.55, 0] },
    rear: { pos: [-5.4, 1.55, -4.3], target: [-0.1, 0.55, 0] },
    top: { pos: [0, 9.6, 0.02], target: [0, 0.4, 0] },
    wheel: { pos: [2.35, 0.52, 1.95], target: [D.axleF, 0.36, 0.86] },
    interior: { pos: [-0.3, 1.02, D.driverZ - 0.01], target: [0.9, 0.9, 0.15] },
  };
  let anim = null;
  let currentView = 'hero';
  // Portrait screens get a wider lens plus whatever distance keeps the car's width in frame.
  const baseFov = () => (camera.aspect < 0.9 ? 42 : 30);
  function fitView() {
    const h = Math.atan(Math.tan(THREE.MathUtils.degToRad(baseFov() / 2)) * camera.aspect);
    const k = Math.max(1.08, 2.75 / (Math.tan(h) * 7.0));
    scene.fog.near = 11 * k;
    scene.fog.far = 26 * k;
    return k;
  }
  function viewPose(name) {
    const v = VIEWS[name];
    const t = new THREE.Vector3(...v.target);
    const p = new THREE.Vector3(...v.pos);
    if (name !== 'interior' && name !== 'wheel') p.sub(t).multiplyScalar(fitView()).add(t);
    return { p, t };
  }
  function goTo(name, dur = 1.6) {
    currentView = name;
    const { p, t } = viewPose(name);
    const from = { p: camera.position.clone(), t: controls.target.clone() };
    // travel along an arc around the car rather than through it
    const r0 = Math.hypot(from.p.x - from.t.x, from.p.z - from.t.z);
    const r1 = Math.hypot(p.x - t.x, p.z - t.z);
    const a0 = Math.atan2(from.p.z - from.t.z, from.p.x - from.t.x);
    let a1 = Math.atan2(p.z - t.z, p.x - t.x);
    while (a1 - a0 > Math.PI) a1 -= Math.PI * 2;
    while (a1 - a0 < -Math.PI) a1 += Math.PI * 2;
    const inside = name === 'interior' || r0 < 1.2;
    anim = { from, to: { p, t }, a0, a1, r0, r1, start: performance.now(), dur: dur * 1000, inside };
    controls.minDistance = name === 'interior' ? 0.05 : 0.35;
    anim.fov0 = camera.fov;
    anim.fov1 = name === 'interior' ? 58 : baseFov();
    document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.view === name ? 'true' : 'false'));
  }
  function stepAnim(now) {
    if (!anim) return;
    const k = Math.min(1, (now - anim.start) / anim.dur);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    const t = anim.from.t.clone().lerp(anim.to.t, e);
    if (anim.inside) {
      camera.position.copy(anim.from.p).lerp(anim.to.p, e);
    } else {
      const a = THREE.MathUtils.lerp(anim.a0, anim.a1, e);
      const r = THREE.MathUtils.lerp(anim.r0, anim.r1, e);
      const y = THREE.MathUtils.lerp(anim.from.p.y - anim.from.t.y, anim.to.p.y - anim.to.t.y, e);
      camera.position.set(t.x + Math.cos(a) * r, t.y + y, t.z + Math.sin(a) * r);
    }
    controls.target.copy(t);
    if (anim.fov0 !== anim.fov1) {
      camera.fov = THREE.MathUtils.lerp(anim.fov0, anim.fov1, e);
      camera.updateProjectionMatrix();
    }
    if (k >= 1) anim = null;
  }
  controls.addEventListener('start', () => {
    anim = null;
    if (state.showcase) setShowcase(false);
  });

  // ---- Configurator actions ----
  const paintMats = [M.paint];
  function setPaint(id) {
    const p = PAINTS.find((x) => x.id === id);
    state.paint = id;
    for (const m of paintMats) {
      m.color.set(p.hex);
      m.metalness = p.metalness;
      m.roughness = p.roughness;
      m.clearcoatRoughness = p.cc;
      m.normalScale.setScalar(p.metalness > 0.3 ? 0.22 : 0.08);
    }
    $('#paint-name').textContent = p.name;
    markActive('#paints', id);
  }
  function setWheelFinish(id) {
    const f = WHEEL_FINISHES.find((x) => x.id === id);
    state.wheelFinish = id;
    M.rim.color.set(f.hex);
    M.rim.metalness = f.metalness;
    M.rim.roughness = f.roughness;
    $('#finish-name').textContent = f.name;
    markActive('#finishes', id);
  }
  function setWheelStyle(i) {
    state.wheelStyle = i;
    api.setWheelStyle(i);
    $('#style-name').textContent = ['Split ten-spoke', 'Forged Y-spoke', 'Turbine fifteen'][i];
    markActive('#styles', String(i));
  }
  function setCaliper(id) {
    const c = CALIPERS.find((x) => x.id === id);
    state.caliper = id;
    M.caliper.color.set(c.hex);
    $('#caliper-name').textContent = c.name;
    markActive('#calipers', id);
  }
  function setInterior(id) {
    const c = INTERIORS.find((x) => x.id === id);
    state.interior = id;
    M.accent.color.set(c.hex);
    M.accent.sheenColor.set(c.sheen);
    $('#interior-name').textContent = c.name;
    markActive('#interiors', id);
  }
  function applyLights() {
    const on = state.headlights;
    M.ledLow.emissiveIntensity = on ? 14 : 0.0;
    M.drl.emissiveIntensity = on ? 6 : 3.2;
    api.lights.spots.forEach((s) => (s.intensity = on ? 9 : 0));
    M.tail.emissiveIntensity = on ? 4 : 1.2;
    M.brake.emissiveIntensity = state.brake ? 16 : 0;
    if (state.brake) M.tail.emissiveIntensity = Math.max(M.tail.emissiveIntensity, 9);
    M.ambient.emissiveIntensity = state.ambient ? 2.4 : 0;
    toggleBtn('#t-head', on);
    toggleBtn('#t-brake', state.brake);
    toggleBtn('#t-hazard', state.hazard);
    toggleBtn('#t-ambient', state.ambient);
  }
  let doorAnim = null;
  function setDoors(open) {
    state.doorsOpen = open;
    doorAnim = { from: api.doors[0].t, to: open ? 1 : 0, start: performance.now(), dur: 1500 };
    toggleBtn('#t-doors', open);
    $('#t-doors .lbl').textContent = open ? 'Close doors' : 'Open doors';
  }
  function setShowcase(on) {
    state.showcase = on;
    controls.autoRotate = on;
    toggleBtn('#t-showcase', on);
    if (on) {
      const { p, t } = viewPose('hero');
      if (camera.position.distanceTo(controls.target) < 3) goTo('hero', 1.4);
      else { anim = null; controls.target.copy(t); }
      void p;
    }
  }

  // ---- UI wiring ----
  function markActive(sel, id) {
    document.querySelectorAll(`${sel} [data-id]`).forEach((b) => b.setAttribute('aria-checked', b.dataset.id === id ? 'true' : 'false'));
  }
  function toggleBtn(sel, on) {
    const b = $(sel);
    if (b) b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  function swatches(sel, list, onPick) {
    const root = $(sel);
    for (const item of list) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.type = 'button';
      b.dataset.id = item.id;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', item.name);
      b.title = item.name;
      b.style.setProperty('--sw', item.hex);
      b.addEventListener('click', () => onPick(item.id));
      root.appendChild(b);
    }
  }
  swatches('#paints', PAINTS, setPaint);
  swatches('#finishes', WHEEL_FINISHES, setWheelFinish);
  swatches('#calipers', CALIPERS, setCaliper);
  swatches('#interiors', INTERIORS, setInterior);
  document.querySelectorAll('#styles [data-id]').forEach((b) => b.addEventListener('click', () => setWheelStyle(+b.dataset.id)));
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => { setShowcase(false); goTo(b.dataset.view); }));
  $('#t-head').addEventListener('click', () => { state.headlights = !state.headlights; applyLights(); });
  $('#t-brake').addEventListener('click', () => { state.brake = !state.brake; applyLights(); });
  $('#t-hazard').addEventListener('click', () => { state.hazard = !state.hazard; applyLights(); });
  $('#t-ambient').addEventListener('click', () => { state.ambient = !state.ambient; applyLights(); });
  $('#t-doors').addEventListener('click', () => setDoors(!state.doorsOpen));
  $('#t-showcase').addEventListener('click', () => setShowcase(!state.showcase));
  $('#t-reset').addEventListener('click', () => { setShowcase(false); goTo('hero'); });
  $('#t-full').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { /* fullscreen not available in this viewer */ }
  });
  document.addEventListener('fullscreenchange', () => toggleBtn('#t-full', !!document.fullscreenElement));
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.setAttribute('aria-selected', x === t ? 'true' : 'false'));
    document.querySelectorAll('.pane').forEach((p) => (p.hidden = p.id !== t.getAttribute('aria-controls')));
    resize();
  }));
  // High: planar floor reflection, bloom, full resolution. Balanced: none of those, for slower devices.
  function setQuality(q) {
    state.quality = q;
    floor.userData.setReflections(q === 'high');
    bloom.enabled = q === 'high';
    renderer.setPixelRatio(dprFor(q));
    resize();
    $('#t-quality .lbl').textContent = q === 'high' ? 'High quality' : 'Balanced';
    $('#t-quality').setAttribute('aria-pressed', q === 'high' ? 'true' : 'false');
  }
  $('#t-quality').addEventListener('click', () => setQuality(state.quality === 'high' ? 'balanced' : 'high'));

  setPaint(state.paint);
  setWheelFinish(state.wheelFinish);
  setWheelStyle(state.wheelStyle);
  setCaliper(state.caliper);
  setInterior(state.interior);
  applyLights();

  window.addEventListener('resize', resize);
  setQuality(state.quality);
  const start = viewPose('hero');
  camera.position.copy(start.p).add(new THREE.Vector3(2.5, 0.6, 2.5));
  controls.target.copy(start.t);
  goTo('hero', 2.4);

  status('Ready');
  shadow.userData.update();
  await nextFrame();
  document.body.classList.add('ready');

  // ---- Loop ----
  let last = performance.now();
  const bootTime = last;
  let shadowDirty = false;
  const fpsWin = [];
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    stepAnim(now);
    if (doorAnim) {
      const k = Math.min(1, (now - doorAnim.start) / doorAnim.dur);
      api.setDoorT(THREE.MathUtils.lerp(doorAnim.from, doorAnim.to, k));
      if (k >= 1) { doorAnim = null; shadowDirty = true; }
    }
    if (state.hazard) {
      const on = Math.floor(now / 380) % 2 === 0;
      M.amber.emissiveIntensity = on ? 9 : 0;
    } else M.amber.emissiveIntensity = 0;
    if (shadowDirty) { shadow.userData.update(); shadowDirty = false; }
    controls.update(dt);
    composer.render(dt);
    // Adaptive quality: after a warm-up, if frames stay slow, lower resolution, then effects.
    if (now - bootTime > 4000 && !document.hidden) fpsWin.push(dt);
    if (fpsWin.length > 90) {
      fpsWin.shift();
      const avg = fpsWin.reduce((a, b) => a + b, 0) / fpsWin.length;
      if (avg > 1 / 30) {
        if (renderer.getPixelRatio() > 1.01) {
          renderer.setPixelRatio(Math.max(1, renderer.getPixelRatio() * 0.8));
          resize();
        } else if (state.quality === 'high') setQuality('balanced');
        fpsWin.length = 0;
      }
    }
    if (!capture) requestAnimationFrame(frame);
  }
  const capture = params.has('capture');
  if (!capture) requestAnimationFrame(frame);
  // Test hook: jump all animations to their end and draw one frame.
  window.__snap = () => {
    if (anim) anim.start = -1e9;
    if (doorAnim) doorAnim.start = -1e9;
    controls.enableDamping = false;
    frame(performance.now());
    frame(performance.now() + 16);
  };
  window.__app = { cam: (p, t) => { anim = null; camera.position.set(...p); controls.target.set(...t); }, M, THREE, scene, camera, controls, car, api, goTo, setPaint, setDoors, state, renderer, composer, setWheelStyle, setWheelFinish, applyLights, setShowcase };
}

main().catch((e) => {
  console.error(e);
  status('Could not start WebGL: ' + e.message);
});
