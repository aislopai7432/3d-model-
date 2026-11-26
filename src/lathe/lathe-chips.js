// Lathe chips and sparks: curly chips leave the tool tip, fly toward the operator / down and settle on the
// bed ways or in the chip tray (they fade out slowly); sparks for crashes. Fixed-size instanced pools.
import * as THREE from 'three';
import { MATERIALS } from '../config.js';

const G = -9810;
const TRAY = { x0: -470, x1: 520, z0: -188, z1: 224, y: 596 };
const BED = { x0: -720, x1: 955, z0: -138, z1: 138, y: 915 };

function curlGeometry() {
  const pts = [];
  for (let i = 0; i <= 14; i++) {
    const t = i / 14, a = t * Math.PI * 3.2;
    pts.push(new THREE.Vector3(Math.cos(a) * 2.4 * (1 - 0.35 * t), t * 5 - 2.5, Math.sin(a) * 2.4 * (1 - 0.35 * t)));
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 14, 0.35, 3, false);
}

export class LatheChips {
  constructor(scene) {
    this.scene = scene;
    const geo = curlGeometry();
    this.mat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.9, roughness: 0.3 });
    this.FLY = 260;
    this.REST = 700;
    this.fly = new THREE.InstancedMesh(geo, this.mat, this.FLY);
    this.rest = new THREE.InstancedMesh(geo, this.mat, this.REST);
    for (const m of [this.fly, this.rest]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
      m.setColorAt(0, new THREE.Color(1, 1, 1));
      scene.add(m);
    }
    this.rest.receiveShadow = true;
    this.flyP = [];
    this.restP = [];
    this.restIdx = 0;
    // sparks: short additive streaks
    this.SN = 160;
    const sg = new THREE.BufferGeometry();
    this.sPos = new Float32Array(this.SN * 6);
    this.sCol = new Float32Array(this.SN * 6);
    sg.setAttribute('position', new THREE.BufferAttribute(this.sPos, 3).setUsage(THREE.DynamicDrawUsage));
    sg.setAttribute('color', new THREE.BufferAttribute(this.sCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.sparkLines = new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.sparkLines.frustumCulled = false;
    scene.add(this.sparkLines);
    this.sparks = [];
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._s = new THREE.Vector3();
    this.setMaterial('steel');
  }

  setMaterial(key) {
    const M = MATERIALS[key] || MATERIALS.steel;
    this.spec = M;
    this.mat.metalness = M.metalness;
    this.mat.roughness = M.metalness > 0.5 ? 0.28 : 0.6;
  }

  // n chips at the tool tip (world). kind: tool type ('part' -> short C-chips, 'drill' -> needles)
  spawn(n, tip, { hot = false, kind = 'turn', dir = 1 } = {}) {
    const base = new THREE.Color(this.spec.chip);
    for (let k = 0; k < n; k++) {
      let p;
      if (this.flyP.length < this.FLY) { p = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), rot: new THREE.Vector3(), w: new THREE.Vector3(), color: new THREE.Color() }; this.flyP.push(p); }
      else p = this.flyP[(this._fi = ((this._fi || 0) + 1) % this.FLY)];
      p.pos.set(tip.x + (Math.random() - 0.5) * 2, tip.y + 1 + Math.random() * 2, tip.z + Math.random() * 2);
      const sp = 400 + Math.random() * 900;
      if (kind === 'drill') p.vel.set(300 + Math.random() * 500, 200 + Math.random() * 400, (Math.random() - 0.5) * 600);
      // the work surface moves down at the tool: chips curl up off the rake face toward the operator
      else p.vel.set((Math.random() - 0.3) * 350, (150 + Math.random() * 500) * (dir >= 0 ? 1 : -0.5), sp);
      p.rot.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      p.w.set((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30);
      p.s = (this.spec.chipSize || 1) * (kind === 'part' ? 0.55 : 0.8 + Math.random() * 0.7);
      p.color.copy(base).multiplyScalar(0.75 + Math.random() * 0.35);
      if (hot) p.color.lerp(new THREE.Color(Math.random() < 0.5 ? 0x3d5a9e : 0xb08a3a), 0.6);
      p.life = 3;
      p.alive = true;
    }
  }

  spawnSparks(n, pos, power = 1) {
    for (let k = 0; k < n; k++) {
      let s;
      if (this.sparks.length < this.SN) { s = { pos: new THREE.Vector3(), vel: new THREE.Vector3() }; this.sparks.push(s); }
      else s = this.sparks[(this._si = ((this._si || 0) + 1) % this.SN)];
      s.pos.copy(pos);
      const a = Math.random() * Math.PI * 2;
      const sp = (800 + Math.random() * 2200) * power;
      s.vel.set(Math.cos(a) * sp * 0.6, 200 + Math.random() * 1200 * power, Math.abs(Math.sin(a)) * sp);
      s.life = s.max = 0.2 + Math.random() * 0.45;
    }
  }

  clear() {
    this.flyP.length = 0; this.restP.length = 0; this.sparks.length = 0;
    this.fly.count = 0; this.rest.count = 0;
  }

  _land(p) {
    const x = p.pos.x, z = p.pos.z;
    if (x > BED.x0 && x < BED.x1 && z > BED.z0 && z < BED.z1) return BED.y;
    if (x > TRAY.x0 && x < TRAY.x1 && z > TRAY.z0 && z < TRAY.z1) return TRAY.y;
    return 2;
  }

  update(dt) {
    dt = Math.min(dt, 0.05);
    const M = this._m, Q = this._q, E = this._e, S = this._s;
    let n = 0;
    for (const p of this.flyP) {
      if (!p.alive) continue;
      p.vel.y += G * dt;
      p.vel.multiplyScalar(1 - 1.5 * dt);
      const y0 = p.pos.y;
      p.pos.addScaledVector(p.vel, dt);
      p.rot.addScaledVector(p.w, dt);
      p.life -= dt;
      const ly = this._land(p);
      if (p.vel.y < 0 && p.pos.y <= ly + 0.5 && y0 >= ly - 1) {
        p.pos.y = ly + 0.6;
        this._toRest(p);
        p.alive = false;
        continue;
      }
      if (p.life <= 0 || p.pos.y < 0) { p.alive = false; continue; }
      E.set(p.rot.x, p.rot.y, p.rot.z); Q.setFromEuler(E); S.setScalar(p.s);
      M.compose(p.pos, Q, S);
      this.fly.setMatrixAt(n, M);
      this.fly.setColorAt(n, p.color);
      n++;
    }
    if (n !== this.flyP.length) this.flyP = this.flyP.filter((p) => p.alive);
    this.fly.count = n;
    this.fly.instanceMatrix.needsUpdate = true;
    if (this.fly.instanceColor) this.fly.instanceColor.needsUpdate = true;
    let rn = 0;
    for (const r of this.restP) {
      r.age += dt * 0.012;
      if (r.age > 1) continue;
      S.setScalar(r.s * (r.age > 0.85 ? (1 - r.age) / 0.15 : 1));
      M.compose(r.pos, r.q, S);
      this.rest.setMatrixAt(rn, M);
      this.rest.setColorAt(rn, r.color);
      rn++;
    }
    if (rn !== this.restP.length) this.restP = this.restP.filter((r) => r.age <= 1);
    this.rest.count = rn;
    this.rest.instanceMatrix.needsUpdate = true;
    if (this.rest.instanceColor) this.rest.instanceColor.needsUpdate = true;
    // sparks
    const P = this.sPos, C = this.sCol;
    let k = 0;
    for (const s of this.sparks) {
      s.life -= dt;
      if (s.life <= 0) continue;
      s.vel.y += G * 0.5 * dt;
      s.pos.addScaledVector(s.vel, dt);
      const f = s.life / s.max, o = k * 6;
      P[o] = s.pos.x; P[o + 1] = s.pos.y; P[o + 2] = s.pos.z;
      P[o + 3] = s.pos.x - s.vel.x * 0.012; P[o + 4] = s.pos.y - s.vel.y * 0.012; P[o + 5] = s.pos.z - s.vel.z * 0.012;
      C[o] = 1; C[o + 1] = 0.55 + 0.4 * f; C[o + 2] = 0.15 * f;
      C[o + 3] = 0.6 * f; C[o + 4] = 0.2 * f; C[o + 5] = 0;
      k++;
    }
    if (k !== this.sparks.length) this.sparks = this.sparks.filter((s) => s.life > 0);
    this.sparkLines.geometry.setDrawRange(0, k * 2);
    this.sparkLines.geometry.attributes.position.needsUpdate = true;
    this.sparkLines.geometry.attributes.color.needsUpdate = true;
    this.sparkLines.visible = k > 0;
  }

  _toRest(p) {
    let r;
    if (this.restP.length < this.REST) { r = { pos: new THREE.Vector3(), q: new THREE.Quaternion(), color: new THREE.Color() }; this.restP.push(r); }
    else { r = this.restP[this.restIdx]; this.restIdx = (this.restIdx + 1) % this.REST; }
    r.pos.copy(p.pos);
    this._e.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    r.q.setFromEuler(this._e);
    r.color.copy(p.color);
    r.s = p.s;
    r.age = Math.random() * 0.1;
  }
}
