// First-person "workshop" controller: pointer-lock mouse look, WASD walking with smooth
// acceleration, sprint / crouch / hop, head bob + footstep callback, circle-vs-AABB collisions
// with wall sliding, centre-screen hover raycast with crosshair + prompt, interaction,
// a smooth focusOn() camera move and a touch scheme (left-half joystick, right-half look, tap).
// World units are millimetres; +Y up. Yaw follows Three's rotation.y convention (yaw 0 looks
// down -Z, positive yaw turns left), pitch is rotation.x (positive looks up), Euler order YXZ.
import * as THREE from 'three';

const DEG = Math.PI / 180;
const GRAVITY = 9810; // mm/s²

const DEFAULTS = {
  eyeHeight: 1650,
  crouchHeight: 1150,
  radius: 260,
  walkSpeed: 1500,
  sprintSpeed: 3000,
  crouchSpeed: 750,
  accel: 11, // 1/s exponential approach toward the wanted velocity
  decel: 9,
  reach: 2600, // hover raycast far distance
  fov: 70,
  sensitivity: 0.0022, // rad per mouse pixel
  touchSensitivity: 0.0050, // rad per touch pixel
  pitchLimit: 85 * DEG,
  hopSpeed: 1500, // mm/s initial upward speed (≈ 115 mm hop)
  bob: 16, // head bob amplitude at walk speed (mm)
  stride: 760, // distance per footstep at walk speed (mm)
  controls: null, // optional OrbitControls: disabled while active, its target kept on the look point
};

const MOVE_KEYS = {
  KeyW: 'f', ArrowUp: 'f', KeyS: 'b', ArrowDown: 'b', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r',
};
const HANDLED = new Set([...Object.keys(MOVE_KEYS), 'ShiftLeft', 'ShiftRight', 'KeyC', 'ControlLeft', 'ControlRight', 'Space', 'KeyE']);

const CSS = `
.fp-root { position: absolute; inset: 0; pointer-events: none; z-index: 6; overflow: hidden; font: 500 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #eef2f6; user-select: none; -webkit-user-select: none; }
.fp-root[hidden], .fp-root [hidden] { display: none !important; }
.fp-cross { position: absolute; left: 50%; top: 50%; width: 6px; height: 6px; margin: -3px 0 0 -3px; border-radius: 50%; background: rgba(255,255,255,.92); box-shadow: 0 0 0 1px rgba(0,0,0,.45), 0 0 6px rgba(0,0,0,.35); box-sizing: border-box; transition: width .14s ease, height .14s ease, margin .14s ease, background-color .14s ease, border-color .14s ease; border: 0 solid rgba(255,255,255,.95); }
.fp-cross.fp-on { width: 26px; height: 26px; margin: -13px 0 0 -13px; background: rgba(255,196,64,.12); border: 2px solid #ffc440; box-shadow: 0 0 0 1px rgba(0,0,0,.4), 0 0 10px rgba(255,196,64,.35); }
.fp-prompt { position: absolute; left: 50%; top: calc(50% + 30px); transform: translateX(-50%); white-space: nowrap; padding: 6px 12px 6px 7px; border-radius: 8px; background: rgba(14,18,22,.78); border: 1px solid rgba(255,255,255,.14); box-shadow: 0 6px 18px rgba(0,0,0,.35); font-weight: 600; letter-spacing: .01em; opacity: 0; transition: opacity .12s ease; }
.fp-prompt.fp-on { opacity: 1; }
.fp-prompt.fp-touch { pointer-events: auto; -webkit-tap-highlight-color: transparent; touch-action: manipulation; cursor: pointer; padding: 10px 16px 10px 10px; font-size: 15px; }
.fp-key { display: inline-block; min-width: 1.6em; padding: 1px 6px; margin-right: 2px; border-radius: 5px; text-align: center; background: #ffc440; color: #1b1406; font-weight: 800; box-shadow: inset 0 -2px 0 rgba(0,0,0,.25); }
.fp-sep { opacity: .55; }
.fp-hint { position: absolute; left: 50%; top: calc(50% + 78px); transform: translateX(-50%); width: max-content; max-width: min(92%, 560px); padding: 14px 20px; border-radius: 12px; text-align: center; background: rgba(12,15,19,.8); border: 1px solid rgba(255,255,255,.14); box-shadow: 0 12px 32px rgba(0,0,0,.45); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }
@media (max-height: 560px) { .fp-hint { top: auto; bottom: 12px; } }
.fp-hint b { color: #ffc440; font-weight: 700; }
.fp-hint .fp-hint-sub { display: block; margin-top: 4px; opacity: .72; font-size: 12px; }
.fp-joy { position: absolute; width: 124px; height: 124px; margin: -62px 0 0 -62px; border-radius: 50%; border: 2px solid rgba(255,255,255,.35); background: rgba(255,255,255,.07); }
.fp-knob { position: absolute; left: 50%; top: 50%; width: 52px; height: 52px; margin: -26px 0 0 -26px; border-radius: 50%; background: rgba(255,255,255,.45); box-shadow: 0 2px 8px rgba(0,0,0,.35); }
`;

function injectStyle() {
  if (typeof document === 'undefined' || document.getElementById('fp-style')) return;
  const s = document.createElement('style');
  s.id = 'fp-style';
  s.textContent = CSS;
  document.head.appendChild(s);
}

function isTypingTarget(t) {
  if (!t || t.nodeType !== 1) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (t.type || 'text').toLowerCase();
    return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image'].includes(type);
  }
  return false;
}

function chainVisible(o) {
  for (let p = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class FirstPerson {
  constructor({ camera, dom, container, ...opts } = {}) {
    this.camera = camera;
    this.dom = dom;
    this.container = container || dom?.parentElement || document.body;
    this.opts = { ...DEFAULTS, ...opts };
    this.sensitivity = this.opts.sensitivity;
    this.touchSensitivity = this.opts.touchSensitivity;
    this.invertY = false;

    // callbacks
    this.onInteract = () => {};
    this.onStep = () => {};
    this.onHover = null; // optional (hit|null) => {} when the hovered entry changes
    this.onLockChange = null; // optional (locked:boolean) => {}

    // state
    this._enabled = false;
    this._frozen = false;
    this.position = new THREE.Vector3(); // feet position (y = floor)
    this.velocity = new THREE.Vector2(); // x, z (mm/s)
    this.yaw = 0;
    this.pitch = 0;
    this.eyeY = this.opts.eyeHeight; // current (smoothed) stance eye height above feet
    this.eyeOffset = 0; // extra height from focusOn(), decays once the player walks
    this.hopY = 0;
    this.hopV = 0;
    this.crouching = false;
    this.sprinting = false;
    this.speed = 0;
    this.locked = false;
    this.touchMode = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    this.hover = null;
    this.lookTarget = new THREE.Vector3();
    this.colliders = [];
    this.occluders = [];

    this._keys = new Set(); // KeyboardEvent.code values currently held (test hook: fp._keys.add('KeyW'))
    this._stick = new THREE.Vector2(); // analogue move input (x strafe right, y forward), from the joystick
    this._bobPhase = 0;
    this._bobWeight = 0;
    this._stepIndex = 0;
    this._interactables = [];
    this._interactablesFn = null;
    this._interactablesAge = Infinity;
    this._entryMap = new Map();
    this._targets = [];
    this._lastRayPose = { p: new THREE.Vector3(Infinity, 0, 0), q: new THREE.Quaternion(), age: Infinity };
    this._focus = null;
    this._wantLock = false;
    this._lockRetries = 0;
    this._lockTimer = 0;
    this._unlockTime = -1e9;
    this._wasLocked = false;
    this._prevFov = null;
    this._prevControlsEnabled = null;
    this._touches = new Map();
    this._joyId = null;

    this._ray = new THREE.Raycaster();
    this._ray.far = this.opts.reach;
    this._ndc = new THREE.Vector2();
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._v = new THREE.Vector3();

    injectStyle();
    this._buildDom();
    this._bind();
  }

  // ---------------------------------------------------------------- public API

  get enabled() { return this._enabled; }

  get frozen() { return this._frozen; }
  set frozen(v) {
    v = !!v;
    if (v === this._frozen) return;
    this._frozen = v;
    if (v) {
      this._wasLocked = this.locked || this._wantLock;
      this._keys.clear();
      this._stick.set(0, 0);
      this._endTouches();
      this.releaseLock();
      this._setHover(null);
    } else if (this._enabled && this._wasLocked && !this.touchMode) {
      // usually called from a UI click (user activation), so re-locking works straight away
      this.requestLock();
    }
    this._syncDom();
  }

  get fov() { return this.opts.fov; }
  set fov(v) {
    this.opts.fov = v;
    if (this._enabled && this.camera.isPerspectiveCamera) { this.camera.fov = v; this.camera.updateProjectionMatrix(); }
  }

  /** Eye position in world space (Vector3, live). */
  get eye() { return this.camera.position; }

  enable(spawn = {}) {
    const cam = this.camera;
    if (!this._enabled) {
      this._enabled = true;
      if (cam.isPerspectiveCamera && this.opts.fov) {
        this._prevFov = cam.fov;
        cam.fov = this.opts.fov;
        cam.updateProjectionMatrix();
      }
      const c = this.opts.controls;
      if (c) { this._prevControlsEnabled = c.enabled; c.enabled = false; }
    }
    if (spawn.pos) this.setPose(spawn);
    else {
      // start from wherever the camera currently is, looking the same way
      this._euler.setFromQuaternion(cam.quaternion, 'YXZ');
      this.setPose({ pos: [cam.position.x, 0, cam.position.z], yaw: spawn.yaw ?? this._euler.y, pitch: spawn.pitch ?? this._euler.x });
    }
    this.velocity.set(0, 0);
    this.hopY = this.hopV = 0;
    this._resolve(this.position);
    this._applyCamera(0);
    this._interactablesAge = Infinity;
    this._lastRayPose.age = Infinity;
    this._syncDom();
  }

  disable() {
    if (!this._enabled) return;
    this._enabled = false;
    this._keys.clear();
    this._stick.set(0, 0);
    this._endTouches();
    this._wantLock = false;
    clearTimeout(this._lockTimer);
    this.releaseLock();
    this._setHover(null);
    if (this._focus) { const f = this._focus; this._focus = null; f.resolve(false); }
    const cam = this.camera;
    if (this._prevFov != null && cam.isPerspectiveCamera) { cam.fov = this._prevFov; cam.updateProjectionMatrix(); }
    this._prevFov = null;
    const c = this.opts.controls;
    if (c) {
      c.target.copy(this.lookTarget);
      if (this._prevControlsEnabled != null) c.enabled = this._prevControlsEnabled;
    }
    this._syncDom();
  }

  /** Place the player: pos = [x, y, z] or Vector3 (XZ used; y is the floor and ignored), yaw/pitch in radians. */
  setPose({ pos, yaw, pitch } = {}) {
    if (pos) {
      const x = Array.isArray(pos) ? pos[0] : pos.x, z = Array.isArray(pos) ? pos[2] : pos.z;
      this.position.set(x, 0, z);
    }
    if (yaw != null) this.yaw = yaw;
    if (pitch != null) this.pitch = THREE.MathUtils.clamp(pitch, -this.opts.pitchLimit, this.opts.pitchLimit);
    this.eyeOffset = 0;
    if (this._enabled) this._applyCamera(0);
  }

  setColliders(list) { this.colliders = Array.isArray(list) ? list : []; }

  /** fnOrArray: [{ object, id, label, ... }] or a function returning one (re-read 4x per second).
   *  opts.occluders: Object3D[] that block the hover ray (e.g. the workshop group). */
  setInteractables(fnOrArray, opts = {}) {
    if (typeof fnOrArray === 'function') { this._interactablesFn = fnOrArray; this._interactables = []; }
    else { this._interactablesFn = null; this._interactables = fnOrArray || []; }
    if (opts.occluders) this.occluders = opts.occluders;
    this._interactablesAge = Infinity;
    this._lastRayPose.age = Infinity;
    this._rebuildTargets();
  }

  /** Force the interactables function to be re-read on the next update. */
  refreshInteractables() { this._interactablesAge = Infinity; this._lastRayPose.age = Infinity; }

  requestLock() {
    if (!this._enabled || this._frozen || this.touchMode || !this.dom?.requestPointerLock) return;
    if (document.pointerLockElement === this.dom) return;
    this._wantLock = true;
    clearTimeout(this._lockTimer);
    // browsers refuse a re-lock for ~1 s after the user pressed Esc: wait it out
    const wait = 1100 - (performance.now() - this._unlockTime);
    if (wait > 0) this._lockTimer = setTimeout(() => this._tryLock(), wait);
    else this._tryLock();
    this._syncDom();
  }

  releaseLock() {
    this._wantLock = false;
    clearTimeout(this._lockTimer);
    if (typeof document !== 'undefined' && document.pointerLockElement === this.dom) document.exitPointerLock?.();
  }

  /** Fire onInteract for the current hover (or a given hit). Returns true when something was used. */
  interact(hit = this.hover) {
    if (!hit || !this._enabled || this._frozen) return false;
    this.onInteract?.(hit);
    return true;
  }

  /** Smoothly move the eye to eyePos while turning to look at target. Resolves true when done
   *  (false if cancelled by another focusOn() or disable()). */
  focusOn(target, eyePos, dur = 0.6) {
    if (this._focus) { const f = this._focus; this._focus = null; f.resolve(false); }
    const t = target.clone ? target.clone() : new THREE.Vector3(...target);
    const e = eyePos ? (eyePos.clone ? eyePos.clone() : new THREE.Vector3(...eyePos)) : this.camera.position.clone();
    const d = this._v.copy(t).sub(e);
    const yaw1 = Math.atan2(-d.x, -d.z);
    const pitch1 = THREE.MathUtils.clamp(Math.atan2(d.y, Math.hypot(d.x, d.z)), -this.opts.pitchLimit, this.opts.pitchLimit);
    return new Promise((resolve) => {
      this.velocity.set(0, 0);
      this._focus = {
        t: 0, dur: Math.max(1e-3, dur), resolve,
        p0: this.camera.position.clone(), p1: e,
        yaw0: this.yaw, dyaw: wrapAngle(yaw1 - this.yaw), pitch0: this.pitch, pitch1,
      };
      if (!this._enabled || dur <= 0) this._stepFocus(1e9);
    });
  }

  /** A point `dist` mm straight ahead of the eye (e.g. for OrbitControls.target on exit). */
  getLookTarget(dist = 1000, out = new THREE.Vector3()) {
    this.camera.getWorldDirection(out);
    return out.multiplyScalar(dist).add(this.camera.position);
  }

  update(dt) {
    if (!this._enabled) return;
    dt = Math.min(Math.max(dt || 0, 0), 0.1);

    if (this._focus) {
      this._stepFocus(dt);
    } else {
      this._move(dt);
      this._applyCamera(dt);
    }
    this.camera.updateMatrixWorld();
    this.getLookTarget(1000, this.lookTarget);
    if (this.opts.controls) this.opts.controls.target.copy(this.lookTarget);

    this._interactablesAge += dt;
    this._lastRayPose.age += dt;
    if (this._interactablesFn && this._interactablesAge >= 0.25) {
      this._interactablesAge = 0;
      this._interactables = this._interactablesFn() || [];
      this._rebuildTargets();
    }
    if (this._frozen || this._focus) this._setHover(null);
    else this._updateHover();
  }

  dispose() {
    this.disable();
    for (const [t, ev, fn, o] of this._listeners) t.removeEventListener(ev, fn, o);
    this._listeners = [];
    this.root.remove();
  }

  // ---------------------------------------------------------------- movement

  _input() {
    const k = this._keys;
    let f = ((k.has('KeyW') || k.has('ArrowUp')) ? 1 : 0) - ((k.has('KeyS') || k.has('ArrowDown')) ? 1 : 0);
    let r = ((k.has('KeyD') || k.has('ArrowRight')) ? 1 : 0) - ((k.has('KeyA') || k.has('ArrowLeft')) ? 1 : 0);
    f += this._stick.y;
    r += this._stick.x;
    const len = Math.hypot(f, r);
    if (len > 1) { f /= len; r /= len; }
    return { f, r, mag: Math.min(1, len) };
  }

  _move(dt) {
    const o = this.opts, k = this._keys;
    const active = !this._frozen;
    const inp = active ? this._input() : { f: 0, r: 0, mag: 0 };
    this.crouching = active && (k.has('KeyC') || k.has('ControlLeft') || k.has('ControlRight'));
    this.sprinting = active && !this.crouching && (k.has('ShiftLeft') || k.has('ShiftRight')) && inp.f > 0.3;
    const maxSpeed = this.crouching ? o.crouchSpeed : this.sprinting ? o.sprintSpeed : o.walkSpeed;

    // wanted velocity in world XZ
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    // forward = (-sin yaw, -cos yaw), right = (cos yaw, -sin yaw)
    const wx = (-sy * inp.f + cy * inp.r) * maxSpeed;
    const wz = (-cy * inp.f - sy * inp.r) * maxSpeed;
    const rate = inp.mag > 0.01 ? o.accel : o.decel;
    const a = 1 - Math.exp(-rate * dt);
    this.velocity.x += (wx - this.velocity.x) * a;
    this.velocity.y += (wz - this.velocity.y) * a;
    if (inp.mag < 0.01 && this.velocity.lengthSq() < 25) this.velocity.set(0, 0);

    // sub-stepped move + collision resolve (max 1/3 radius per step: no tunnelling at sprint speed)
    const dx = this.velocity.x * dt, dz = this.velocity.y * dt;
    const dist = Math.hypot(dx, dz);
    if (dist > 0) {
      const n = Math.max(1, Math.ceil(dist / (o.radius / 3)));
      const before = this._v.copy(this.position);
      for (let i = 0; i < n; i++) {
        this.position.x += dx / n;
        this.position.z += dz / n;
        this._resolve(this.position);
      }
      // keep the velocity consistent with what actually happened (slide, no build-up into walls)
      if (dt > 0) {
        const mvx = (this.position.x - before.x) / dt, mvz = (this.position.z - before.z) / dt;
        if (mvx * mvx + mvz * mvz < this.velocity.lengthSq()) this.velocity.set(mvx, mvz);
      }
    }
    const moved = Math.hypot(this.velocity.x, this.velocity.y);
    this.speed = moved;

    // hop
    if (active && k.has('Space') && this.hopY <= 0 && this.hopV <= 0 && !this.crouching) this.hopV = o.hopSpeed;
    if (this.hopV !== 0 || this.hopY > 0) {
      this.hopV -= GRAVITY * dt;
      this.hopY += this.hopV * dt;
      if (this.hopY <= 0) {
        this.hopY = 0;
        if (this.hopV < -300) this.onStep?.(Math.max(moved, o.walkSpeed * 0.6));
        this.hopV = 0;
      }
    }

    // stance height (smooth)
    const targetEye = this.crouching ? o.crouchHeight : o.eyeHeight;
    this.eyeY += (targetEye - this.eyeY) * (1 - Math.exp(-10 * dt));
    if (moved > 60 && this.eyeOffset !== 0) {
      this.eyeOffset *= Math.exp(-4 * dt);
      if (Math.abs(this.eyeOffset) < 0.5) this.eyeOffset = 0;
    }

    // head bob + footsteps (only while on the ground)
    const grounded = this.hopY <= 0;
    const walking = grounded && moved > 120;
    this._bobWeight += ((walking ? Math.min(1.3, moved / o.walkSpeed) : 0) - this._bobWeight) * (1 - Math.exp(-8 * dt));
    if (walking) {
      const stride = o.stride * (this.sprinting ? 1.3 : this.crouching ? 0.8 : 1);
      this._bobPhase += (moved * dt / stride) * Math.PI;
      const idx = Math.floor(this._bobPhase / Math.PI + 0.5);
      if (idx !== this._stepIndex) { this._stepIndex = idx; this.onStep?.(moved); }
    } else if (this._bobWeight < 0.02) {
      // settle the phase on a stride boundary so the next step starts cleanly
      this._bobPhase = Math.round(this._bobPhase / Math.PI) * Math.PI;
      this._stepIndex = Math.floor(this._bobPhase / Math.PI + 0.5);
    }
  }

  /** Push a circle (centre p, radius r) out of every collider rectangle. */
  _resolve(p) {
    const r = this.opts.radius, list = this.colliders;
    if (!list.length) return;
    for (let iter = 0; iter < 4; iter++) {
      let any = false;
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (p.x < c.minX - r || p.x > c.maxX + r || p.z < c.minZ - r || p.z > c.maxZ + r) continue;
        const cx = Math.min(Math.max(p.x, c.minX), c.maxX);
        const cz = Math.min(Math.max(p.z, c.minZ), c.maxZ);
        let nx = p.x - cx, nz = p.z - cz;
        const d2 = nx * nx + nz * nz;
        if (d2 >= r * r) continue;
        if (d2 > 1e-6) {
          const d = Math.sqrt(d2);
          p.x += (nx / d) * (r - d);
          p.z += (nz / d) * (r - d);
        } else {
          // centre inside the rectangle: leave by the nearest side
          const l = p.x - c.minX, rr = c.maxX - p.x, b = p.z - c.minZ, f = c.maxZ - p.z;
          const m = Math.min(l, rr, b, f);
          if (m === l) p.x = c.minX - r; else if (m === rr) p.x = c.maxX + r;
          else if (m === b) p.z = c.minZ - r; else p.z = c.maxZ + r;
        }
        any = true;
      }
      if (!any) break;
    }
  }

  _applyCamera(dt) {
    const cam = this.camera, o = this.opts;
    const w = this._bobWeight;
    const bobY = -o.bob * w * Math.abs(Math.sin(this._bobPhase));
    const bobX = o.bob * 0.45 * w * Math.sin(this._bobPhase);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    cam.position.set(
      this.position.x + cy * bobX,
      this.position.y + this.eyeY + this.eyeOffset + this.hopY + bobY,
      this.position.z - sy * bobX,
    );
    this._euler.set(this.pitch, this.yaw, 0, 'YXZ');
    cam.quaternion.setFromEuler(this._euler);
  }

  _stepFocus(dt) {
    const f = this._focus;
    f.t = Math.min(1, f.t + dt / f.dur);
    const e = easeInOut(f.t);
    const cam = this.camera;
    cam.position.lerpVectors(f.p0, f.p1, e);
    this.yaw = wrapAngle(f.yaw0 + f.dyaw * e);
    this.pitch = f.pitch0 + (f.pitch1 - f.pitch0) * e;
    this._euler.set(this.pitch, this.yaw, 0, 'YXZ');
    cam.quaternion.setFromEuler(this._euler);
    if (f.t >= 1) {
      // hand the pose back to the walker so look / movement continue from here
      this.position.set(f.p1.x, 0, f.p1.z);
      this.eyeOffset = f.p1.y - this.eyeY;
      this.velocity.set(0, 0);
      this._bobWeight = 0;
      this.hopY = this.hopV = 0;
      this._focus = null;
      cam.updateMatrixWorld();
      f.resolve(true);
    }
  }

  // ---------------------------------------------------------------- hover / picking

  _rebuildTargets() {
    this._entryMap.clear();
    this._targets = [];
    for (const e of this._interactables) {
      if (!e || !e.object) continue;
      this._entryMap.set(e.object, e);
      this._targets.push(e.object);
    }
  }

  /** Raycast from NDC (0,0 = screen centre); returns a hit {id,label,object,point,entry,distance} or null. */
  pick(ndcX = 0, ndcY = 0) {
    if (!this._targets.length) return null;
    this._ndc.set(ndcX, ndcY);
    this._ray.far = this.opts.reach;
    this._ray.setFromCamera(this._ndc, this.camera);
    const objs = this.occluders.length ? this._targets.concat(this.occluders) : this._targets;
    const hits = this._ray.intersectObjects(objs, true);
    hits.sort((a, b) => a.distance - b.distance);
    for (const h of hits) {
      if (!chainVisible(h.object)) continue;
      const m = h.object.material;
      if (m && !Array.isArray(m) && m.visible === false) continue;
      for (let p = h.object; p; p = p.parent) {
        const entry = this._entryMap.get(p);
        if (entry) return { id: entry.id, label: entry.label, object: entry.object, point: h.point.clone(), distance: h.distance, entry };
      }
      return null; // something that is not interactable is in front
    }
    return null;
  }

  _updateHover() {
    const lp = this._lastRayPose, cam = this.camera;
    // skip the raycast when the view hasn't changed (cheap on big merged meshes); refresh 5x/s anyway
    const still = lp.p.distanceToSquared(cam.position) < 1 && Math.abs(lp.q.dot(cam.quaternion)) > 0.999999 && lp.age < 0.2;
    if (still) return;
    lp.p.copy(cam.position);
    lp.q.copy(cam.quaternion);
    lp.age = 0;
    this._setHover(this.pick(0, 0));
  }

  _setHover(hit) {
    const prev = this.hover;
    const same = (prev && hit && prev.entry === hit.entry) || (!prev && !hit);
    this.hover = hit;
    if (same) return;
    if (hit) {
      this.el.key.textContent = this.touchMode ? 'Tap' : 'E';
      this.el.label.textContent = hit.label ?? hit.id ?? '';
    }
    this._syncDom();
    this.onHover?.(hit);
  }

  // ---------------------------------------------------------------- DOM

  _buildDom() {
    const root = document.createElement('div');
    root.className = 'fp-root';
    root.hidden = true;
    root.innerHTML = `
      <div class="fp-cross"></div>
      <div class="fp-prompt" role="button" aria-live="polite"><span class="fp-key">E</span><span class="fp-sep"> · </span><span class="fp-label"></span></div>
      <div class="fp-hint"><b>Click</b> to look around · <b>WASD</b> move · <b>Shift</b> sprint · <b>E</b> interact · <b>Esc</b> release mouse<span class="fp-hint-sub">C / Ctrl crouch · Space hop</span></div>
      <div class="fp-joy" hidden><div class="fp-knob"></div></div>`;
    if (getComputedStyle(this.container).position === 'static') this.container.style.position = 'relative';
    this.container.appendChild(root);
    this.root = root;
    this.el = {
      cross: root.querySelector('.fp-cross'),
      prompt: root.querySelector('.fp-prompt'),
      key: root.querySelector('.fp-key'),
      label: root.querySelector('.fp-label'),
      hint: root.querySelector('.fp-hint'),
      joy: root.querySelector('.fp-joy'),
      knob: root.querySelector('.fp-knob'),
    };
    this._touchHintShown = false;
  }

  _syncDom() {
    const on = this._enabled, fr = this._frozen;
    this.root.hidden = !on;
    if (!on) return;
    this.el.cross.hidden = fr;
    this.el.cross.classList.toggle('fp-on', !!this.hover && !fr);
    const showPrompt = !!this.hover && !fr;
    this.el.prompt.classList.toggle('fp-on', showPrompt);
    this.el.prompt.classList.toggle('fp-touch', this.touchMode && showPrompt);
    this.el.prompt.hidden = !showPrompt;
    this.el.key.textContent = this.touchMode ? 'Tap' : 'E';
    let hint = !fr && !this.locked && !this._focus;
    if (this.touchMode) {
      hint = hint && !this._touchHintShown;
      if (hint) this.el.hint.innerHTML = '<b>Left thumb</b> move · <b>Right thumb</b> look · <b>Tap</b> to interact';
    } else if (hint) {
      this.el.hint.innerHTML = this._wantLock
        ? 'Locking the mouse…<span class="fp-hint-sub">click the view again if nothing happens</span>'
        : '<b>Click</b> to look around · <b>WASD</b> move · <b>Shift</b> sprint · <b>E</b> interact · <b>Esc</b> release mouse<span class="fp-hint-sub">C / Ctrl crouch · Space hop</span>';
    }
    this.el.hint.hidden = !hint;
    if (fr || !this.touchMode) this.el.joy.hidden = true;
  }

  // ---------------------------------------------------------------- events

  _bind() {
    this._listeners = [];
    const on = (t, ev, fn, o) => { t.addEventListener(ev, fn, o); this._listeners.push([t, ev, fn, o]); };
    const dom = this.dom;

    on(document, 'pointerlockchange', () => {
      const was = this.locked;
      this.locked = document.pointerLockElement === dom && !!dom;
      if (this.locked) { this._wantLock = false; this._lockRetries = 0; this.touchMode = false; }
      else if (was) { this._unlockTime = performance.now(); this._keys.clear(); }
      if (was !== this.locked) this.onLockChange?.(this.locked);
      if (this.locked && (!this._enabled || this._frozen)) document.exitPointerLock?.();
      this._syncDom();
    });
    on(document, 'pointerlockerror', () => this._lockFailed());

    on(document, 'mousemove', (e) => {
      if (!this.locked || !this._enabled || this._frozen || this._focus) return;
      // ignore the occasional bogus spike some browsers report right after locking
      const mx = Math.abs(e.movementX) > 600 ? 0 : e.movementX;
      const my = Math.abs(e.movementY) > 600 ? 0 : e.movementY;
      this._look(mx * this.sensitivity, my * this.sensitivity);
    });

    if (dom) {
      on(dom, 'click', () => {
        if (!this._enabled || this._frozen || this.touchMode || this.locked) return;
        this._lockRetries = 0;
        this.requestLock();
      });
      on(dom, 'mousedown', (e) => {
        if (e.button === 0 && this.locked && this._enabled && !this._frozen) this.interact();
      });
      on(dom, 'touchstart', (e) => this._touchStart(e), { passive: false });
      on(dom, 'touchmove', (e) => this._touchMove(e), { passive: false });
      on(dom, 'touchend', (e) => this._touchEnd(e), { passive: false });
      on(dom, 'touchcancel', (e) => this._touchEnd(e), { passive: false });
    }
    on(this.el.prompt, 'click', (e) => { if (this.touchMode) { e.preventDefault(); this.interact(); } });

    on(window, 'keydown', (e) => this._key(e, true));
    on(window, 'keyup', (e) => this._key(e, false));
    on(window, 'blur', () => { this._keys.clear(); this._stick.set(0, 0); });
  }

  _key(e, down) {
    const code = e.code;
    if (!HANDLED.has(code)) return;
    if (!down) { this._keys.delete(code); return; }
    if (!this._enabled || this._frozen) return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    if (e.altKey || e.metaKey) return;
    if (code === 'KeyE') {
      if (!e.repeat) this.interact();
    } else {
      this._keys.add(code);
      if (MOVE_KEYS[code] && this.touchMode && typeof matchMedia === 'function' && !matchMedia('(pointer: coarse)').matches) this.touchMode = false;
    }
    if (!e.ctrlKey || code.startsWith('Control')) e.preventDefault();
  }

  _look(dx, dy) {
    this.yaw = wrapAngle(this.yaw - dx);
    const lim = this.opts.pitchLimit;
    this.pitch = THREE.MathUtils.clamp(this.pitch - (this.invertY ? -dy : dy), -lim, lim);
  }

  _tryLock() {
    if (!this._wantLock || !this._enabled || this._frozen || this.locked) return;
    try {
      const p = this.dom.requestPointerLock();
      if (p && typeof p.catch === 'function') p.catch(() => this._lockFailed());
    } catch {
      this._lockFailed();
    }
  }

  _lockFailed() {
    if (!this._wantLock) return;
    if (this._lockRetries++ < 2) {
      clearTimeout(this._lockTimer);
      this._lockTimer = setTimeout(() => this._tryLock(), 450);
    } else {
      this._wantLock = false; // give up until the next click
      this._syncDom();
    }
  }

  // touch: left half = floating joystick, right half = look; short still touches = tap
  _touchStart(e) {
    if (!this._enabled) return;
    if (!this.touchMode) { this.touchMode = true; this.releaseLock(); }
    this._touchHintShown = true;
    if (this._frozen) { this._syncDom(); return; }
    e.preventDefault();
    const rect = this.dom.getBoundingClientRect();
    for (const t of e.changedTouches) {
      const left = t.clientX - rect.left < rect.width / 2;
      const rec = { x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY, t0: performance.now(), moved: 0, joy: false };
      if (left && this._joyId == null) {
        rec.joy = true;
        this._joyId = t.identifier;
        const rr = this.root.getBoundingClientRect();
        this.el.joy.style.left = `${t.clientX - rr.left}px`;
        this.el.joy.style.top = `${t.clientY - rr.top}px`;
        this.el.knob.style.transform = 'translate(0px, 0px)';
        this.el.joy.hidden = false;
      }
      this._touches.set(t.identifier, rec);
    }
    this._syncDom();
  }

  _touchMove(e) {
    if (!this._enabled || this._frozen) return;
    e.preventDefault();
    for (const t of e.changedTouches) {
      const rec = this._touches.get(t.identifier);
      if (!rec) continue;
      const dx = t.clientX - rec.x, dy = t.clientY - rec.y;
      rec.x = t.clientX; rec.y = t.clientY;
      rec.moved = Math.max(rec.moved, Math.hypot(t.clientX - rec.x0, t.clientY - rec.y0));
      if (rec.joy) {
        const R = 56;
        let ox = t.clientX - rec.x0, oy = t.clientY - rec.y0;
        const l = Math.hypot(ox, oy);
        if (l > R) { ox *= R / l; oy *= R / l; }
        this.el.knob.style.transform = `translate(${ox}px, ${oy}px)`;
        // small dead zone, then linear
        const m = Math.max(0, (Math.min(l, R) - 6) / (R - 6));
        const s = l > 0 ? m / Math.min(l, R) : 0;
        this._stick.set(ox * s, -oy * s);
      } else if (!this._focus) {
        this._look(dx * this.touchSensitivity, dy * this.touchSensitivity);
      }
    }
  }

  _touchEnd(e) {
    if (!this._enabled) return;
    for (const t of e.changedTouches) {
      const rec = this._touches.get(t.identifier);
      if (!rec) continue;
      this._touches.delete(t.identifier);
      if (rec.joy) {
        this._joyId = null;
        this._stick.set(0, 0);
        this.el.joy.hidden = true;
      }
      if (!this._frozen && rec.moved < 12 && performance.now() - rec.t0 < 350) {
        e.preventDefault(); // no emulated mouse click
        const rect = this.dom.getBoundingClientRect();
        const hit = this.pick(((t.clientX - rect.left) / rect.width) * 2 - 1, -((t.clientY - rect.top) / rect.height) * 2 + 1) || this.hover;
        if (hit) this.interact(hit);
      }
    }
  }

  _endTouches() {
    this._touches.clear();
    this._joyId = null;
    this._stick.set(0, 0);
    if (this.el) this.el.joy.hidden = true;
  }
}
