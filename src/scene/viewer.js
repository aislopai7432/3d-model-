// Renderer, camera, controls, environment lighting, view presets, picking and the axis gizmo.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const VIEWS = {
  iso: { pos: [-1350, 2250, 4000], target: [80, 1500, -60] },
  front: { pos: [100, 1650, 4600], target: [100, 1650, 0] },
  side: { pos: [6000, 1800, -40], target: [0, 1750, -40] },
  top: { pos: [0, 4300, 60], target: [0, 1000, 0] },
  work: { pos: [-150, 1500, 1400], target: [0, 1040, 0] },
  machine: { pos: [3700, 2800, 5500], target: [-60, 1650, -100] },
};

export class Viewer {
  constructor(canvas, container) {
    this.canvas = canvas;
    this.container = container;
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance', preserveDrawingBuffer: new URLSearchParams(location.search).has('capture') });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.86;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.setClearColor(0x000000, 0);
    r.autoClear = false;
    this.renderer = r;
    this.overlays = []; // [{scene, camera?, visible?, beforeRender?}] rendered after the world with depth cleared

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x15181c, 7000, 15000);
    const pm = new THREE.PMREMGenerator(r);
    this.envTex = pm.fromScene(new RoomEnvironment(r), 0.04).texture;
    this.scene.environment = this.envTex;
    pm.dispose();

    this.camera = new THREE.PerspectiveCamera(38, 1, 20, 30000);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 120;
    this.controls.maxDistance = 9000;
    this.controls.maxPolarAngle = Math.PI * 0.497;
    this.controls.screenSpacePanning = true;
    this.controls.zoomSpeed = 1.1;
    this.controls.addEventListener('start', () => { this.tween = null; });

    const hemi = new THREE.HemisphereLight(0xdfe8f5, 0x2a2620, 0.42);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xfff6ea, 1.7);
    key.position.set(2600, 5200, 3600);
    key.target.position.set(0, 900, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera;
    sc.left = -2400; sc.right = 2400; sc.top = 2600; sc.bottom = -2200; sc.near = 2000; sc.far = 11000;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 2.5;
    this.scene.add(key, key.target);
    const rim = new THREE.DirectionalLight(0xbfd6ff, 0.45);
    rim.position.set(-3000, 2500, -2500);
    this.scene.add(rim);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.tween = null;
    this.showGizmo = true;
    this.center = null; // optional principal point (canvas px) for overlays that cover part of the view
    this._gDir = new THREE.Vector3();
    this.buildGizmo();
    this.setView('iso', false);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
  }

  buildGizmo() {
    this.gScene = new THREE.Scene();
    this.gCam = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
    const axes = [
      [new THREE.Vector3(1, 0, 0), 0xff5a4f, 'X'],
      [new THREE.Vector3(0, 0, -1), 0x45d483, 'Y'],
      [new THREE.Vector3(0, 1, 0), 0x4aa3ff, 'Z'],
    ];
    for (const [d, c, l] of axes) {
      const a = new THREE.ArrowHelper(d, new THREE.Vector3(), 1, c, 0.3, 0.16);
      this.gScene.add(a);
      const cv = document.createElement('canvas');
      cv.width = cv.height = 64;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#' + new THREE.Color(c).getHexString();
      ctx.font = '700 44px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(l, 32, 34);
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv) }));
      s.position.copy(d).multiplyScalar(1.32);
      s.scale.setScalar(0.5);
      this.gScene.add(s);
    }
  }

  setView(name, animate = true) {
    const v = VIEWS[name];
    if (!v) return;
    this.view = name;
    const pos = new THREE.Vector3(...v.pos), tgt = new THREE.Vector3(...v.target);
    if (!animate) {
      this.camera.position.copy(pos);
      this.controls.target.copy(tgt);
      this.camera.lookAt(tgt);
      this.controls.update();
      return;
    }
    this.tween = { t: 0, dur: 0.85, p0: this.camera.position.clone(), t0: this.controls.target.clone(), p1: pos, t1: tgt };
  }

  // Frame an arbitrary point (e.g. the work zero) keeping the current view direction.
  focus(target, distance = 520) {
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.tween = { t: 0, dur: 0.7, p0: this.camera.position.clone(), t0: this.controls.target.clone(), p1: target.clone().addScaledVector(dir, distance), t1: target.clone() };
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.width = w;
    this.height = h;
    this.applyCenter();
  }

  // Shift the projection so the view's centre lands at canvas pixel (x, y) (e.g. the part of the
  // view left free by docked panels). null restores the normal centred projection.
  setCenter(c) {
    this.center = c ? { x: c.x, y: c.y } : null;
    this.applyCenter();
  }

  applyCenter() {
    const cam = this.camera, w = this.width || 1, h = this.height || 1;
    if (this.center) cam.setViewOffset(w, h, w / 2 - this.center.x, h / 2 - this.center.y, w, h);
    else cam.clearViewOffset();
    cam.updateProjectionMatrix();
  }

  update(dt) {
    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(1, tw.t + dt / tw.dur);
      const e = tw.t < 0.5 ? 4 * tw.t * tw.t * tw.t : 1 - Math.pow(-2 * tw.t + 2, 3) / 2;
      this.camera.position.lerpVectors(tw.p0, tw.p1, e);
      this.controls.target.lerpVectors(tw.t0, tw.t1, e);
      if (tw.t >= 1) this.tween = null;
    }
    this.controls.update();
  }

  render() {
    const r = this.renderer;
    r.setViewport(0, 0, this.width, this.height);
    r.setScissorTest(false);
    r.clear();
    r.render(this.scene, this.camera);
    // overlay scenes (e.g. the coffee mug): drawn over the world with a cleared depth buffer
    for (const o of this.overlays) {
      if (o.visible === false) continue;
      o.beforeRender?.(this.camera);
      r.clearDepth();
      r.render(o.scene, o.camera || this.camera);
    }
    if (!this.showGizmo) return;
    // axis gizmo in the bottom-left corner
    const s = 96;
    r.clearDepth();
    r.setScissorTest(true);
    r.setScissor(10, 10, s, s);
    r.setViewport(10, 10, s, s);
    const dir = this._gDir.copy(this.camera.position).sub(this.controls.target).normalize();
    this.gCam.position.copy(dir).multiplyScalar(4);
    this.gCam.quaternion.copy(this.camera.quaternion);
    r.render(this.gScene, this.gCam);
    r.setScissorTest(false);
    r.setViewport(0, 0, this.width, this.height);
  }

  setPointer(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster;
  }

  pick(clientX, clientY, objects, recursive = false) {
    this.setPointer(clientX, clientY);
    const hits = this.raycaster.intersectObjects(objects, recursive);
    return hits.find((h) => h.object.visible && isVisible(h.object)) || null;
  }

  project(v) {
    const p = v.clone().project(this.camera);
    return { x: (p.x * 0.5 + 0.5) * this.width, y: (-p.y * 0.5 + 0.5) * this.height, behind: p.z > 1 };
  }
}

function isVisible(o) {
  for (let p = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}
