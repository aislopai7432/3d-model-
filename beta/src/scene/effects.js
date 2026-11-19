// Machining effects: chips thrown off the cutter that land on the actual machined surface (and ride
// on the table afterwards), coolant streams from the nozzles, sparks (collisions and dry high-speed
// steel cutting only) and a motion-blur sleeve around the spinning cutter. Fixed-size pools keep the
// cost bounded.
import * as THREE from 'three';
import { VISE } from '../config.js';

const G = -9810; // mm/s^2

function chipGeometry() {
  const pts = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const a = t * Math.PI * 2.6;
    pts.push(new THREE.Vector3(Math.cos(a) * 0.9 * (1 - 0.3 * t), t * 1.6 - 0.8, Math.sin(a) * 0.9 * (1 - 0.3 * t)));
  }
  const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 10, 0.28, 3, false);
  return g;
}

export class Effects {
  constructor(scene, workGroup) {
    this.scene = scene;
    this.work = workGroup;
    const geo = chipGeometry();
    this.chipMat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.9, roughness: 0.3 });
    this.FLY = 360;
    this.REST = 900;
    this.fly = new THREE.InstancedMesh(geo, this.chipMat, this.FLY);
    this.rest = new THREE.InstancedMesh(geo, this.chipMat, this.REST);
    for (const m of [this.fly, this.rest]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.castShadow = false;
      m.count = 0;
      m.setColorAt(0, new THREE.Color(1, 1, 1));
    }
    scene.add(this.fly);
    workGroup.add(this.rest);
    this.flyP = [];
    this.restP = [];
    this.restIdx = 0;
    this.tmpM = new THREE.Matrix4();
    this.tmpQ = new THREE.Quaternion();
    this.tmpE = new THREE.Euler();
    this.tmpS = new THREE.Vector3();
    this.tmpV = new THREE.Vector3();
    this.tmpC = new THREE.Color();

    // coolant streaks
    this.CN = 1400;
    this.cool = [];
    const cg = new THREE.BufferGeometry();
    this.coolPos = new Float32Array(this.CN * 6);
    this.coolCol = new Float32Array(this.CN * 6);
    cg.setAttribute('position', new THREE.BufferAttribute(this.coolPos, 3).setUsage(THREE.DynamicDrawUsage));
    cg.setAttribute('color', new THREE.BufferAttribute(this.coolCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.coolLines = new THREE.LineSegments(cg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false }));
    this.coolLines.frustumCulled = false;
    scene.add(this.coolLines);

    // sparks
    this.SN = 260;
    this.sparks = [];
    const sg = new THREE.BufferGeometry();
    this.sparkPos = new Float32Array(this.SN * 6);
    this.sparkCol = new Float32Array(this.SN * 6);
    sg.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3).setUsage(THREE.DynamicDrawUsage));
    sg.setAttribute('color', new THREE.BufferAttribute(this.sparkCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.sparkLines = new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.sparkLines.frustumCulled = false;
    scene.add(this.sparkLines);

    // motion blur sleeve around the cutter
    this.blur = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 32, 1, true), new THREE.MeshBasicMaterial({ color: 0xc7d0d8, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
    this.blur.visible = false;
    this.showChips = true;
    this.showCoolant = true;
    this.material = null;
  }

  setMaterial(spec) {
    this.material = spec;
    this.chipMat.metalness = spec.metalness;
    this.chipMat.roughness = spec.metalness > 0.5 ? 0.28 : 0.55;
  }

  attachBlur(head) {
    head.add(this.blur);
  }

  setTool(tool) {
    if (!tool) {
      this.blur.visible = false;
      this.blurTool = null;
      return;
    }
    const r = tool.diameter / 2;
    const h = Math.min(tool.fluteLength, tool.length - 20);
    this.blur.scale.set(r * 1.03, h, r * 1.03);
    this.blur.position.set(0, -tool.length + h / 2, 0);
    this.blurTool = tool;
  }

  // world-space chip emission at the cutter
  spawnChips(n, tip, radius, dir, hot) {
    if (!this.showChips || !this.material) return;
    const base = new THREE.Color(this.material.chip);
    for (let k = 0; k < n; k++) {
      let p;
      if (this.flyP.length < this.FLY) {
        p = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), rot: new THREE.Vector3(), w: new THREE.Vector3(), color: new THREE.Color(), s: 1 };
        this.flyP.push(p);
      } else {
        p = this.flyP[(this.flyIdx = ((this.flyIdx || 0) + 1) % this.FLY)];
      }
      const a = Math.random() * Math.PI * 2;
      const cx = Math.cos(a), cz = Math.sin(a);
      p.pos.set(tip.x + cx * radius, tip.y + 0.5 + Math.random() * 2, tip.z + cz * radius);
      const sp = 700 + Math.random() * 1300;
      // tangential to the cutter rotation (CW from above for M03) plus a bit outward and up
      p.vel.set(-cz * sp * dir + cx * 260, 250 + Math.random() * 700, cx * sp * dir + cz * 260);
      p.rot.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      p.w.set((Math.random() - 0.5) * 40, (Math.random() - 0.5) * 40, (Math.random() - 0.5) * 40);
      p.s = this.material.chipSize * (0.7 + Math.random() * 0.7);
      p.color.copy(base).multiplyScalar(0.75 + Math.random() * 0.35);
      if (hot) p.color.lerp(new THREE.Color(Math.random() < 0.5 ? 0x3d5a9e : 0xb08a3a), 0.65);
      p.life = 2.5;
      p.alive = true;
    }
  }

  spawnSparks(n, pos, power = 1) {
    for (let k = 0; k < n; k++) {
      let s;
      if (this.sparks.length < this.SN) {
        s = { pos: new THREE.Vector3(), vel: new THREE.Vector3() };
        this.sparks.push(s);
      } else s = this.sparks[(this.sparkIdx = ((this.sparkIdx || 0) + 1) % this.SN)];
      s.pos.copy(pos);
      const a = Math.random() * Math.PI * 2;
      const sp = (900 + Math.random() * 2400) * power;
      s.vel.set(Math.cos(a) * sp, 300 + Math.random() * 1500 * power, Math.sin(a) * sp);
      s.life = s.max = 0.25 + Math.random() * 0.45;
    }
  }

  clear() {
    this.flyP.length = 0;
    this.restP.length = 0;
    this.restIdx = 0;
    this.fly.count = 0;
    this.rest.count = 0;
    this.cool.length = 0;
    this.sparks.length = 0;
  }

  // surfaceZ(x, y) -> table-frame landing height or null when off the table
  update(dt, ctx) {
    dt = Math.min(dt, 0.05);
    const M = this.tmpM, Q = this.tmpQ, E = this.tmpE, S = this.tmpS, V = this.tmpV;
    // ---- flying chips
    let n = 0;
    for (const p of this.flyP) {
      if (!p.alive) continue;
      p.vel.y += G * dt;
      p.vel.multiplyScalar(1 - 1.2 * dt);
      p.pos.addScaledVector(p.vel, dt);
      p.rot.addScaledVector(p.w, dt);
      p.life -= dt;
      // landing test in the work (table) frame
      V.copy(p.pos);
      this.work.worldToLocal(V);
      const surf = ctx.surfaceAt(V.x, -V.z);
      if (surf != null && V.y <= surf + 0.4 && p.vel.y < 0) {
        this.toRest(V.set(V.x, surf + 0.4, V.z), p);
        p.alive = false;
        continue;
      }
      if (p.pos.y < ctx.floorY || p.life <= 0) {
        p.alive = false;
        continue;
      }
      E.set(p.rot.x, p.rot.y, p.rot.z);
      Q.setFromEuler(E);
      S.setScalar(p.s);
      M.compose(p.pos, Q, S);
      this.fly.setMatrixAt(n, M);
      this.fly.setColorAt(n, p.color);
      n++;
    }
    this.flyP = this.flyP.filter((p) => p.alive);
    this.fly.count = n;
    this.fly.instanceMatrix.needsUpdate = true;
    if (this.fly.instanceColor) this.fly.instanceColor.needsUpdate = true;

    // ---- resting chips: fade out slowly (faster under flood coolant, which washes them away)
    const wash = ctx.flood ? 0.25 : 0.035;
    let rn = 0;
    for (const r of this.restP) {
      r.age += dt * wash;
      if (r.age > 1) continue;
      if (r.surfFn) {
        // re-seat on the surface in case it was machined away below the chip
        const h = ctx.surfaceAt(r.pos.x, -r.pos.z);
        if (h != null && h + 0.4 < r.pos.y - 0.2) r.pos.y = h + 0.4;
      }
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

    this.updateCoolant(dt, ctx);
    this.updateSparks(dt);
    // blur sleeve
    const rpm = Math.abs(ctx.rpm || 0);
    if (this.blurTool && rpm > 400) {
      this.blur.visible = true;
      this.blur.material.opacity = Math.min(0.22, (rpm / 12000) * 0.3 + 0.04);
    } else this.blur.visible = false;
  }

  toRest(local, p) {
    let r;
    if (this.restP.length < this.REST) {
      r = { pos: new THREE.Vector3(), q: new THREE.Quaternion(), color: new THREE.Color() };
      this.restP.push(r);
    } else {
      r = this.restP[this.restIdx];
      this.restIdx = (this.restIdx + 1) % this.REST;
    }
    r.pos.copy(local);
    this.tmpE.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    r.q.setFromEuler(this.tmpE);
    r.color.copy(p.color);
    r.s = p.s;
    r.age = Math.random() * 0.1;
    r.surfFn = true;
  }

  updateCoolant(dt, ctx) {
    const on = this.showCoolant && (ctx.flood || ctx.mist);
    const P = this.coolPos, C = this.coolCol;
    if (on) {
      const rate = ctx.mist ? 260 : 520; // droplets per second per nozzle
      for (const nz of ctx.nozzles) {
        let k = Math.floor(rate * dt + Math.random());
        while (k-- > 0) {
          let d;
          if (this.cool.length < this.CN) {
            d = { pos: new THREE.Vector3(), vel: new THREE.Vector3() };
            this.cool.push(d);
          } else d = this.cool[(this.coolIdx = ((this.coolIdx || 0) + 1) % this.CN)];
          d.pos.copy(nz).addScaledVector(this.tmpV.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5), 2);
          const dir = this.tmpV.copy(ctx.target).sub(nz);
          const dist = dir.length();
          dir.normalize();
          const spread = ctx.mist ? 0.22 : 0.05;
          dir.x += (Math.random() - 0.5) * spread; dir.y += (Math.random() - 0.5) * spread; dir.z += (Math.random() - 0.5) * spread;
          dir.normalize();
          const sp = ctx.mist ? 2600 : 3200 + Math.random() * 500;
          d.vel.copy(dir).multiplyScalar(sp);
          d.vel.y += (-G * dist) / sp / 2; // aim compensates for the drop
          d.life = 0.9;
          d.splash = false;
          d.mist = ctx.mist && !ctx.flood;
        }
      }
    }
    let n = 0;
    const V = this.tmpV;
    for (const d of this.cool) {
      if (d.life <= 0) continue;
      d.life -= dt;
      d.vel.y += G * dt;
      d.pos.addScaledVector(d.vel, dt);
      V.copy(d.pos);
      this.work.worldToLocal(V);
      const surf = ctx.surfaceAt(V.x, -V.z);
      if (!d.splash && ((surf != null && V.y <= surf + 0.5) || d.pos.y < ctx.target.y - 2)) {
        // splash: scatter sideways off the cutter / part
        d.splash = true;
        d.life = 0.12 + Math.random() * 0.2;
        const a = Math.random() * Math.PI * 2;
        const sp = 600 + Math.random() * 900;
        d.vel.set(Math.cos(a) * sp, 200 + Math.random() * 500, Math.sin(a) * sp);
      }
      if (d.pos.y < ctx.floorY) d.life = 0;
      if (d.life <= 0) continue;
      const k = n * 6;
      const tail = d.splash ? 0.01 : 0.012;
      P[k] = d.pos.x; P[k + 1] = d.pos.y; P[k + 2] = d.pos.z;
      P[k + 3] = d.pos.x - d.vel.x * tail; P[k + 4] = d.pos.y - d.vel.y * tail; P[k + 5] = d.pos.z - d.vel.z * tail;
      const b = d.mist ? 0.75 : 0.95;
      C[k] = 0.78 * b; C[k + 1] = 0.88 * b; C[k + 2] = b;
      C[k + 3] = 0.3; C[k + 4] = 0.36; C[k + 5] = 0.42;
      n++;
    }
    if (n < this.cool.length * 0.5 && !on) this.cool = this.cool.filter((d) => d.life > 0);
    this.coolLines.geometry.setDrawRange(0, n * 2);
    this.coolLines.geometry.attributes.position.needsUpdate = true;
    this.coolLines.geometry.attributes.color.needsUpdate = true;
  }

  updateSparks(dt) {
    const P = this.sparkPos, C = this.sparkCol;
    let n = 0;
    for (const s of this.sparks) {
      if (s.life <= 0) continue;
      s.life -= dt;
      s.vel.y += G * 0.5 * dt;
      s.pos.addScaledVector(s.vel, dt);
      if (s.life <= 0) continue;
      const k = n * 6;
      const f = s.life / s.max;
      P[k] = s.pos.x; P[k + 1] = s.pos.y; P[k + 2] = s.pos.z;
      P[k + 3] = s.pos.x - s.vel.x * 0.01; P[k + 4] = s.pos.y - s.vel.y * 0.01; P[k + 5] = s.pos.z - s.vel.z * 0.01;
      C[k] = 1.0 * f + 0.2; C[k + 1] = 0.75 * f; C[k + 2] = 0.3 * f;
      C[k + 3] = 0.6 * f; C[k + 4] = 0.2 * f; C[k + 5] = 0;
      n++;
    }
    if (!n) this.sparks.length = 0;
    this.sparkLines.geometry.setDrawRange(0, n * 2);
    this.sparkLines.geometry.attributes.position.needsUpdate = true;
    this.sparkLines.geometry.attributes.color.needsUpdate = true;
  }
}

// Landing height lookup in the table frame: stock surface, vise, table, or null (falls off).
export function makeSurfaceFn(app) {
  return (x, y) => {
    const z = app.zmap;
    if (z && z.inFootprint(x, y)) return z.heightAt(x, y);
    const pl = app.placement;
    if (Math.abs(x) <= VISE.jawWidth / 2 && pl) {
      const W = pl.width / 2;
      if ((y >= W && y <= W + VISE.jawThickness) || (y <= -W && y >= -W - VISE.jawThickness)) return pl.jawTop;
      if (y > -240 && y < 195) return VISE.floor - 10;
    }
    if (Math.abs(x) <= 400 && Math.abs(y) <= 190) return 0;
    return null;
  };
}
