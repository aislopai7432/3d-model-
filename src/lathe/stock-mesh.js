// Renders a lathe TurnProfile (see turn-profile.js) as a revolved surface.
//
// ORIENTATION: the mesh is built along local +X (local x = lathe Z, Z0 = chuck face at x = 0, radial in the
// local YZ plane), which is what LatheModel.stockGroup expects: add `stockMesh.group` to stockGroup (origin on
// the spindle axis at the chuck face, +Z -> world +X) and rotate stockGroup about X with spindle.angle.
// Pass { axis: 'z' } to get the bar along local +Z instead (group is pre-rotated).
//
// The bar is split into 10 mm chunks; a chunk is re-meshed only when the profile's chunk version changes,
// at most every `minInterval` seconds and within a small time budget per update(), nearest-to-tool first
// is not needed because cutting only touches a couple of chunks at a time.
//
// Look: raw bar (rough, dark mill scale with blotchy noise) vs machined (bright, low roughness) with
// helical feed-mark sheen fading out with distance, faced ends and bores are machined, thread zones are
// sheared helically by the geometry builder. Uses MeshStandardMaterial + onBeforeCompile (no textures).
import * as THREE from 'three';
import { MATERIALS } from '../config.js';
import { buildChunkArrays } from './turn-profile.js';

function patch(mat, uniforms) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRaw = uniforms.uRaw;
    shader.uniforms.uCut = uniforms.uCut;
    shader.uniforms.uWet = uniforms.uWet;
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'attribute vec4 aInfo;\nvarying vec4 vInfo;\nvarying vec3 vObj;\nvoid main() {')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vInfo = aInfo; vObj = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `uniform vec3 uRaw; uniform vec3 uCut; uniform float uWet;
varying vec4 vInfo; varying vec3 vObj;
float lh(vec3 p){ return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
float lnoise(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(lh(i), lh(i+vec3(1,0,0)), f.x), mix(lh(i+vec3(0,1,0)), lh(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(lh(i+vec3(0,0,1)), lh(i+vec3(1,0,1)), f.x), mix(lh(i+vec3(0,1,1)), lh(i+vec3(1,1,1)), f.x), f.y), f.z); }
float gAmp = 0.0; float gSh = 0.0;
void main() {`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  {
    float mach = clamp(vInfo.x, 0.0, 1.0);
    float feed = vInfo.y;
    float n = lnoise(vObj * 1.3) * 0.6 + lnoise(vObj * 9.0) * 0.4;
    vec3 rawc = uRaw * (0.72 + 0.55 * n);
    vec3 cutc = uCut;
    float ph = vObj.x / max(feed, 0.02) - vInfo.w / 6.2831853;
    float fw = fwidth(ph);
    gAmp = mach * step(0.001, feed) * (1.0 - smoothstep(0.22, 0.65, fw));
    gSh = sin(ph * 6.2831853);
    cutc *= 1.0 + 0.07 * gAmp * gSh;
    cutc *= 0.96 + 0.08 * lnoise(vec3(vObj.x * 40.0, vInfo.w * 3.0, 0.0));
    diffuseColor.rgb = mix(rawc, cutc, mach);
  }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
  roughnessFactor = mix(0.82, roughnessFactor + 0.10 * gAmp * gSh, clamp(vInfo.x, 0.0, 1.0));
  roughnessFactor = clamp(roughnessFactor * (1.0 - 0.4 * uWet), 0.04, 1.0);`);
  };
  mat.customProgramCacheKey = () => 'lathe-stock-v1';
}

export class StockMesh {
  /**
   * @param {object} o
   * @param {import('./turn-profile.js').TurnProfile} [o.profile]
   * @param {string} [o.material] key of config MATERIALS ('steel' | 'aluminium' | 'brass' | 'plastic')
   * @param {'x'|'z'} [o.axis] bar along local +X (default, for LatheModel.stockGroup) or +Z
   */
  constructor({ profile = null, material = 'steel', axis = 'x', segments = 56, minInterval = 0.04, budgetMs = 5 } = {}) {
    this.group = new THREE.Group();
    this.group.name = 'lathe-stock';
    this.inner = new THREE.Group();
    this.group.add(this.inner);
    if (axis === 'z') this.inner.rotation.y = -Math.PI / 2;
    this.segments = segments;
    this.minInterval = minInterval;
    this.budgetMs = budgetMs;
    this.uniforms = { uRaw: { value: new THREE.Color() }, uCut: { value: new THREE.Color() }, uWet: { value: 0 } };
    this.material = new THREE.MeshStandardMaterial({ metalness: 0.9, roughness: 0.35, envMapIntensity: 1.1 });
    patch(this.material, this.uniforms);
    this.meshes = [];
    this.ver = [];
    this.last = -1;
    this.stats = { rebuilt: 0, ms: 0, tris: 0 };
    this.profile = null;
    this.setMaterial(material);
    if (profile) this.setProfile(profile);
  }

  setMaterial(key) {
    const spec = MATERIALS[key] || MATERIALS.steel;
    this.spec = spec;
    this.uniforms.uRaw.value.setHex(spec.raw);
    this.uniforms.uCut.value.setHex(spec.cut);
    this.material.metalness = spec.metalness;
    this.material.roughness = spec.roughness;
    this.material.envMapIntensity = spec.metalness > 0.5 ? 1.05 : 0.45;
    this.baseRoughness = spec.roughness;
  }

  /** Coolant film makes the surface glossier (0..1). */
  setWet(w) { this.uniforms.uWet.value = w; }

  setProfile(profile, materialKey) {
    if (materialKey) this.setMaterial(materialKey);
    this._clear();
    this.profile = profile;
    if (!profile) return;
    this.ver = new Array(profile.nChunks).fill(-1);
    this.meshes = new Array(profile.nChunks).fill(null);
    this.update(0, true, true);
  }

  _clear() {
    for (const m of this.meshes) if (m) { this.inner.remove(m); m.geometry.dispose(); }
    this.meshes = []; this.ver = [];
  }

  _build(c) {
    const a = buildChunkArrays(this.profile, c, { segs: this.segments });
    let m = this.meshes[c];
    if (!a) {
      if (m) { this.inner.remove(m); m.geometry.dispose(); this.meshes[c] = null; }
      return 0;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(a.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(a.nor, 3));
    g.setAttribute('aInfo', new THREE.BufferAttribute(a.info, 4));
    g.setIndex(new THREE.BufferAttribute(a.idx, 1));
    g.computeBoundingSphere();
    if (m) { m.geometry.dispose(); m.geometry = g; } else {
      m = new THREE.Mesh(g, this.material);
      m.castShadow = true; m.receiveShadow = true;
      m.userData.stock = true;
      this.inner.add(m);
      this.meshes[c] = m;
    }
    return a.tris;
  }

  /**
   * Re-mesh dirty chunks. Call every frame with a time in seconds; cheap when nothing changed.
   * @returns {number} chunks rebuilt
   */
  update(now = performance.now() / 1000, force = false, all = false) {
    const p = this.profile;
    if (!p) return 0;
    if (!force && now - this.last < this.minInterval) return 0;
    const t0 = performance.now();
    let n = 0, tris = 0;
    for (let c = 0; c < p.nChunks; c++) {
      if (p.chunkVer[c] === this.ver[c]) continue;
      tris += this._build(c);
      this.ver[c] = p.chunkVer[c];
      n++;
      if (!all && performance.now() - t0 > this.budgetMs) break;
    }
    if (n) { this.last = now; this.stats = { rebuilt: n, ms: performance.now() - t0, tris }; }
    return n;
  }

  dispose() { this._clear(); this.material.dispose(); }
}
