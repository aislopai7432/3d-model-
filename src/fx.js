// Particle effects (dust, dirt, gold sparkles), glints on exposed finds and scanner pulses.
import * as THREE from 'three';
import { glintTexture, softDot } from './textures.js';

class Pool {
  constructor(n, additive) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.max = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.base = new Float32Array(n);
    this.cursor = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    this.geo = g;
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: additive ? glintTexture() : softDot() }, scale: { value: 600 } },
      vertexShader: `attribute float size; attribute float alpha; attribute vec3 color; varying float vA; varying vec3 vC;
        uniform float scale;
        void main(){ vA = alpha; vC = color; vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_PointSize = size * scale / -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform sampler2D map; varying float vA; varying vec3 vC;
        void main(){ vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(vC * t.rgb, t.a * vA); if (gl_FragColor.a < 0.01) discard; }`,
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
  }
  emit(p, v, color, size, life, { drag = 1.5, grav = -3, alpha = 1 } = {}) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.n;
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([v.x, v.y, v.z], i * 3);
    this.col.set([color.r, color.g, color.b], i * 3);
    this.size[i] = size;
    this.life[i] = life;
    this.max[i] = life;
    this.drag[i] = drag;
    this.grav[i] = grav;
    this.base[i] = alpha;
  }
  update(dt) {
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      const k = Math.max(0, this.life[i] / this.max[i]);
      const d = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= d; this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d + this.grav[i] * dt; this.vel[i * 3 + 2] *= d;
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.alpha[i] = this.base[i] * Math.min(1, k * 2.5) * Math.min(1, (1 - k) * 12 + 0.2);
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.alpha.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.geo.attributes.size.needsUpdate = true;
  }
}

const rnd = (a, b) => a + Math.random() * (b - a);

export class FX {
  constructor(scene) {
    this.dust = new Pool(900, false);
    this.spark = new Pool(700, true);
    scene.add(this.dust.points, this.spark.points);
    this.pulses = [];
    this.scene = scene;
    this.glintCooldown = new Map();
  }
  setScale(h) {
    this.dust.points.material.uniforms.scale.value = h * 0.9;
    this.spark.points.material.uniforms.scale.value = h * 0.9;
  }
  dig(point, colour, n = 22) {
    const c = new THREE.Color(colour);
    for (let k = 0; k < n; k++) {
      const v = new THREE.Vector3(rnd(-1, 1), rnd(0.6, 2.2), rnd(-1, 1));
      this.dust.emit(point.clone().add(new THREE.Vector3(rnd(-0.15, 0.15), rnd(0, 0.1), rnd(-0.15, 0.15))), v, c.clone().multiplyScalar(rnd(0.7, 1.15)), rnd(0.05, 0.16), rnd(0.6, 1.3), { drag: 2.2, grav: -1.2, alpha: 0.55 });
    }
  }
  dirt(point, n = 18) {
    for (let k = 0; k < n; k++) {
      const v = new THREE.Vector3(rnd(-1.2, 1.2), rnd(1.5, 3.2), rnd(-1.2, 1.2));
      this.dust.emit(point.clone(), v, new THREE.Color(0x3b2c1e).multiplyScalar(rnd(0.6, 1.3)), rnd(0.02, 0.05), rnd(0.6, 1.0), { drag: 0.6, grav: -9, alpha: 1 });
    }
    this.dig(point, 0x8a7458, 10);
  }
  sparkle(point, colour = 0xffd27a, n = 60, power = 1) {
    const c = new THREE.Color(colour);
    for (let k = 0; k < n; k++) {
      const dir = new THREE.Vector3(rnd(-1, 1), rnd(-0.2, 1), rnd(-1, 1)).normalize().multiplyScalar(rnd(0.4, 2.2) * power);
      this.spark.emit(point.clone(), dir, c.clone().multiplyScalar(rnd(0.8, 1.6)), rnd(0.03, 0.09) * Math.sqrt(power), rnd(0.5, 1.4), { drag: 2.5, grav: -0.6, alpha: 1 });
    }
  }
  glint(point, size = 0.05, colour = 0xfff3d0) {
    this.spark.emit(point, new THREE.Vector3(0, 0.02, 0), new THREE.Color(colour), size, 0.45, { drag: 0, grav: 0, alpha: 1 });
  }
  pulse(point, radius, colour = 0xffd479) {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 96), new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
    m.rotation.x = -Math.PI / 2;
    m.position.copy(point).add(new THREE.Vector3(0, 0.05, 0));
    this.scene.add(m);
    this.pulses.push({ m, t: 0, radius });
  }
  update(dt) {
    this.dust.update(dt);
    this.spark.update(dt);
    for (const p of this.pulses) {
      p.t += dt;
      const k = p.t / 1.2;
      p.m.scale.setScalar(0.1 + k * p.radius);
      p.m.material.opacity = 0.8 * (1 - k);
      if (k >= 1) { this.scene.remove(p.m); p.m.geometry.dispose(); p.m.material.dispose(); }
    }
    this.pulses = this.pulses.filter((p) => p.t < 1.2);
  }
}
