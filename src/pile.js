// The rubbish pile: a grid of cells, each holding a stack of rubbish items (bottom → top),
// with treasure buried between layers or in the soil underneath.
// Rubbish is drawn with one InstancedMesh per geometry variant; picking ray-marches the cell
// heightfield instead of raycasting thousands of instances.
import * as THREE from 'three';
import { JUNK, buildJunkLibrary } from './junk.js';
import { getAtlas } from './textures.js';
import { mulberry, fbm2 } from './rng.js';
import { TREASURES, RARITY_ORDER } from './config.js';
import { rollTreasure, buildTreasureModel } from './treasure.js';

export const CELL = 0.3;
const COMPACT = 0.8; // stacked items nest into each other
const VIS = 4; // only the top few layers of each stack are drawn; deeper items are swapped in as you dig
export const MAX_SOIL = 0.6;
const SOIL_STEP = 0.005; // save resolution for soil depth
const SIFTABLE = new Set(['flake', 'fragment', 'penny', 'sixpence', 'goldPins', 'diamond']);
const METAL_CODE = { iron: 1, aluminium: 2, copper: 3, silver: 4, gold: 5 };
export const METAL_NAMES = ['', 'iron', 'aluminium', 'copper', 'silver', 'gold'];

let junkMaterial = null;
function getJunkMaterial() {
  if (junkMaterial) return junkMaterial;
  const A = getAtlas();
  junkMaterial = new THREE.MeshStandardMaterial({
    map: A.map, normalMap: A.normalMap, normalScale: new THREE.Vector2(0.9, 0.9),
    roughnessMap: A.roughMetal, metalnessMap: A.roughMetal, roughness: 1, metalness: 1, envMapIntensity: 0.9,
  });
  return junkMaterial;
}

export function terrainHeight(x, z, seed) {
  return fbm2(x * 0.08, z * 0.08, seed, 3) * 0.35 + fbm2(x * 0.5, z * 0.5, seed + 3, 2) * 0.04;
}

export class Pile {
  constructor(area, seed, groundMaterial) {
    this.area = area;
    this.seed = seed;
    this.group = new THREE.Group();
    this.anims = [];
    this.highlight = null;
    const r = mulberry(seed);
    const P = area.pile;
    const N = Math.ceil((P.radius * 2 + 2.4) / CELL / 6) * 6; // multiple of 6 so the world ground grid (0.9 m) lines up
    this.N = N;
    this.origin = -N * CELL / 2;
    const NC = N * N;
    this.terrainSeed = seed % 997;

    // ---- mound shape --------------------------------------------------------------
    const mounds = [];
    for (let k = 0; k < P.mounds; k++) {
      const a = r() * Math.PI * 2, d = k === 0 ? r.range(0, 0.8) : r.range(1.5, P.radius * 0.6);
      mounds.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, s: k === 0 ? P.radius * 0.6 : r.range(1.4, 2.6), h: k === 0 ? 1 : r.range(0.55, 0.95) });
    }
    const shape = (x, z) => {
      let h = 0;
      for (const m of mounds) h = Math.max(h, m.h * Math.exp(-((x - m.x) ** 2 + (z - m.z) ** 2) / (2 * m.s * m.s)));
      const edge = Math.hypot(x, z) / P.radius;
      const noise = fbm2(x * 0.45, z * 0.45, seed + 11, 3) * 0.35;
      return Math.max(0, h + noise * 0.4 - Math.max(0, edge - 0.75) * 1.4);
    };

    // ---- cells and stacks -------------------------------------------------------------
    this.cellBase = new Float32Array(NC); // terrain height at cell centre
    this.soil = new Float32Array(NC); // soil dug (m)
    this.cellStart = new Int32Array(NC + 1); // item id range per cell
    this.cellTop = new Uint8Array(NC); // number of remaining items
    this.cellFull = new Uint8Array(NC);
    const stacks = [];
    const junkKeys = Object.keys(area.junk);
    this.lib = buildJunkLibrary(junkKeys, 777);
    const items = []; // temp
    for (let iz = 0; iz < N; iz++) {
      for (let ix = 0; ix < N; ix++) {
        const c = iz * N + ix;
        const x = this.origin + (ix + 0.5) * CELL, z = this.origin + (iz + 0.5) * CELL;
        this.cellBase[c] = terrainHeight(x, z, this.terrainSeed);
        const s = shape(x, z);
        let n = Math.round(P.maxLayers * s + (r() - 0.5) * 1.2);
        if (s > 0.02 && n < 1 && r() < 0.6) n = 1;
        n = THREE.MathUtils.clamp(n, 0, 250);
        stacks.push(n);
      }
    }
    // item records
    let id = 0;
    for (let c = 0; c < NC; c++) {
      this.cellStart[c] = id;
      for (let k = 0; k < stacks[c]; k++) {
        const key = r.weighted(area.junk);
        const v = r.int(0, this.lib[key].length - 1);
        items.push({ key, v, cell: c });
        id++;
      }
      this.cellTop[c] = stacks[c];
      this.cellFull[c] = stacks[c];
    }
    this.cellStart[NC] = id;
    this.count = id;

    // ---- per-item arrays ------------------------------------------------------------
    const n = this.count;
    this.itemKey = new Array(n);
    this.itemMesh = new Uint16Array(n);
    this.itemInst = new Int32Array(n).fill(-1); // instance slot while drawn, -1 when not
    this.itemY = new Float32Array(n); // bottom height
    this.itemT = new Float32Array(n); // stacked thickness
    this.itemMetal = new Uint8Array(n);
    this.itemMass = new Float32Array(n);
    this.itemPos = new Float32Array(n * 3);
    this.itemQuat = new Float32Array(n * 4);
    this.itemScale = new Float32Array(n);
    this.itemColor = new Float32Array(n * 3);
    // stack heights (cumulative from cell base)
    this.stackY = new Float32Array(n + NC); // offset per (cell, level): level l at cellStart[c] + c + l
    const meshKeys = [], meshIndex = new Map(), meshCounts = [];
    for (const key of junkKeys) this.lib[key].forEach((_, v) => { meshIndex.set(key + v, meshKeys.length); meshKeys.push([key, v]); meshCounts.push(0); });
    for (let i = 0; i < n; i++) {
      const it = items[i];
      this.itemKey[i] = it.key;
      const mi = meshIndex.get(it.key + it.v);
      this.itemMesh[i] = mi;
      meshCounts[mi]++;
      const def = JUNK[it.key];
      const metal = def.metal && (!def.metalFor || def.metalFor(it.v)) ? def.metal : null;
      this.itemMetal[i] = metal ? METAL_CODE[metal] : 0;
      this.itemMass[i] = metal ? r.range(def.mass[0], def.mass[1]) : 0;
    }
    // heights
    for (let c = 0; c < NC; c++) {
      let y = 0;
      const s0 = this.cellStart[c], cnt = this.cellStart[c + 1] - s0;
      for (let l = 0; l < cnt; l++) {
        const i = s0 + l;
        const geo = this.lib[this.itemKey[i]][items[i].v];
        const sc = r.range(0.85, 1.15);
        this.itemScale[i] = sc;
        this.stackY[s0 + c + l] = y;
        this.itemY[i] = y;
        const t = Math.min(geo.thickness * sc, 0.32) * COMPACT;
        this.itemT[i] = t;
        y += t;
      }
      this.stackY[s0 + c + cnt] = y;
    }
    // placement with slope-aware tilt
    const q = new THREE.Quaternion(), qy = new THREE.Quaternion(), e = new THREE.Euler(), up = new THREE.Vector3(0, 1, 0), nrm = new THREE.Vector3();
    const fullTop = (ix, iz) => {
      ix = THREE.MathUtils.clamp(ix, 0, N - 1); iz = THREE.MathUtils.clamp(iz, 0, N - 1);
      const c = iz * N + ix;
      return this.cellBase[c] + this.stackY[this.cellStart[c + 1] + c];
    };
    for (let c = 0; c < NC; c++) {
      const ix = c % N, iz = Math.floor(c / N);
      const s0 = this.cellStart[c], cnt = this.cellStart[c + 1] - s0;
      if (!cnt) continue;
      const dx = fullTop(ix + 1, iz) - fullTop(ix - 1, iz), dz = fullTop(ix, iz + 1) - fullTop(ix, iz - 1);
      nrm.set(-dx / (2 * CELL), 1, -dz / (2 * CELL)).normalize();
      for (let l = 0; l < cnt; l++) {
        const i = s0 + l;
        const x = this.origin + (ix + 0.5 + r.range(-0.45, 0.45)) * CELL;
        const z = this.origin + (iz + 0.5 + r.range(-0.45, 0.45)) * CELL;
        const yRest = this.cellBase[c] + this.itemY[i] - this.itemT[i] * 0.25;
        this.itemPos[i * 3] = x; this.itemPos[i * 3 + 1] = yRest; this.itemPos[i * 3 + 2] = z;
        q.setFromUnitVectors(up, nrm);
        e.set(r.range(-0.28, 0.28), 0, r.range(-0.28, 0.28));
        q.multiply(new THREE.Quaternion().setFromEuler(e));
        qy.setFromAxisAngle(up, r() * Math.PI * 2);
        q.multiply(qy);
        q.toArray(this.itemQuat, i * 4);
        const def = JUNK[this.itemKey[i]];
        const tint = new THREE.Color(def.tints[def.tintFor ? def.tintFor(items[i].v) * 0 + Math.floor(r() * def.tints.length) : Math.floor(r() * def.tints.length)]);
        const dirt = r.range(0.62, 1.0) * (1 - Math.min(0.25, l * 0.015));
        tint.multiplyScalar(dirt);
        tint.toArray(this.itemColor, i * 3);
      }
    }

    // ---- instanced meshes -------------------------------------------------------------
    const mat = getJunkMaterial();
    this.meshes = meshKeys.map(([key, v], mi) => {
      const m = new THREE.InstancedMesh(this.lib[key][v].geo, mat, Math.max(1, meshCounts[mi]));
      m.count = 0;
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, meshCounts[mi]) * 3), 3);
      m.userData.slots = new Int32Array(Math.max(1, meshCounts[mi]));
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(m);
      return m;
    });
    // ---- ground patch with diggable soil ---------------------------------------------------
    this.buildGround(groundMaterial);
    this.rebuildVisibility();

    // ---- treasure -------------------------------------------------------------------------
    this.treasures = [];
    this.treasureGroup = new THREE.Group();
    this.group.add(this.treasureGroup);
    const TC = area.treasures;
    const count = Math.round(TC.count * r.range(0.9, 1.1));
    const filled = [];
    for (let c = 0; c < NC; c++) if (this.cellFull[c] > 0) filled.push(c);
    for (let k = 0; k < count; k++) {
      let rarity = r.weighted(TC.weights);
      let kinds = area.kinds.filter((kk) => TREASURES[kk].rarity === rarity);
      while (!kinds.length) { rarity = RARITY_ORDER[Math.max(0, RARITY_ORDER.indexOf(rarity) - 1)]; kinds = area.kinds.filter((kk) => TREASURES[kk].rarity === rarity); }
      let kind = r.pick(kinds);
      if (kind === 'bar1k' && r() < 0.75) kind = kinds.includes('bar100') ? 'bar100' : kind; // kilo bars are rarer still
      const item = rollTreasure(kind, r, `${area.id}:${seed}:${k}`);
      const rIdx = RARITY_ORDER.indexOf(rarity);
      const c = r.pick(filled);
      const full = this.cellFull[c];
      const inSoil = r() < TC.soilShare * (0.6 + rIdx * 0.25);
      const layer = inSoil ? 0 : Math.floor(full * Math.pow(r(), 1 + rIdx * 0.55));
      const soilDepth = inSoil ? r.range(0.04, 0.18 + rIdx * 0.09) : 0;
      const ix = c % N, iz = Math.floor(c / N);
      const x = this.origin + (ix + 0.5 + r.range(-0.3, 0.3)) * CELL;
      const z = this.origin + (iz + 0.5 + r.range(-0.3, 0.3)) * CELL;
      const model = buildTreasureModel(item);
      const y = inSoil ? this.cellBase[c] - soilDepth : this.cellBase[c] + this.stackY[this.cellStart[c] + c + layer] - 0.004;
      model.position.set(x, y, z);
      model.rotation.y = r() * Math.PI * 2;
      model.rotation.x = r.range(-0.25, 0.25);
      this.treasureGroup.add(model);
      this.treasures.push({ item, cell: c, layer, soilDepth, inSoil, model, pos: new THREE.Vector3(x, y, z), collected: false, exposed: false, siftable: SIFTABLE.has(kind), metal: METAL_CODE[TREASURES[kind].metal] || 0 });
    }
    this.treasuresByCell = new Map();
    for (const t of this.treasures) {
      if (!this.treasuresByCell.has(t.cell)) this.treasuresByCell.set(t.cell, []);
      this.treasuresByCell.get(t.cell).push(t);
    }
    this.totalItems = n;
    this.updateExposure();
  }

  // ---- helpers ------------------------------------------------------------------------------
  cellIndex(x, z) {
    const ix = Math.floor((x - this.origin) / CELL), iz = Math.floor((z - this.origin) / CELL);
    if (ix < 0 || iz < 0 || ix >= this.N || iz >= this.N) return -1;
    return iz * this.N + ix;
  }
  cellCenter(c, out = new THREE.Vector3()) {
    const ix = c % this.N, iz = Math.floor(c / this.N);
    return out.set(this.origin + (ix + 0.5) * CELL, 0, this.origin + (iz + 0.5) * CELL);
  }
  topHeight(c) {
    return this.cellBase[c] - this.soil[c] + this.stackY[this.cellStart[c] + c + this.cellTop[c]] * (this.cellTop[c] ? 1 : 0);
  }
  // smooth surface height (bilinear between cell tops)
  heightAt(x, z) {
    const fx = (x - this.origin) / CELL - 0.5, fz = (z - this.origin) / CELL - 0.5;
    const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
    const h = (a, b) => {
      if (a < 0 || b < 0 || a >= this.N || b >= this.N) return terrainHeight(this.origin + (a + 0.5) * CELL, this.origin + (b + 0.5) * CELL, this.terrainSeed);
      return this.topHeight(b * this.N + a);
    };
    return THREE.MathUtils.lerp(THREE.MathUtils.lerp(h(ix, iz), h(ix + 1, iz), tx), THREE.MathUtils.lerp(h(ix, iz + 1), h(ix + 1, iz + 1), tx), tz);
  }
  topItem(c) {
    if (c < 0 || !this.cellTop[c]) return -1;
    return this.cellStart[c] + this.cellTop[c] - 1;
  }

  // Dense instance packing: visible items occupy slots [0, count) of their mesh.
  show(i) {
    if (this.itemInst[i] >= 0) return;
    const m = this.meshes[this.itemMesh[i]];
    const slot = m.count++;
    m.userData.slots[slot] = i;
    this.itemInst[i] = slot;
    this.writeInstance(i);
    m.instanceMatrix.needsUpdate = true;
    m.instanceColor.needsUpdate = true;
  }
  hide(i) {
    const slot = this.itemInst[i];
    if (slot < 0) return;
    const m = this.meshes[this.itemMesh[i]];
    const last = --m.count;
    const li = m.userData.slots[last];
    if (li !== i) {
      const M = new THREE.Matrix4(), C = new THREE.Color();
      m.getMatrixAt(last, M);
      m.getColorAt(last, C);
      m.setMatrixAt(slot, M);
      m.setColorAt(slot, C);
      m.userData.slots[slot] = li;
      this.itemInst[li] = slot;
    }
    this.itemInst[i] = -1;
    m.instanceMatrix.needsUpdate = true;
    m.instanceColor.needsUpdate = true;
  }
  revealCell(c) {
    const s0 = this.cellStart[c], top = this.cellTop[c];
    for (let l = Math.max(0, top - VIS); l < top; l++) this.show(s0 + l);
  }
  rebuildVisibility() {
    for (const m of this.meshes) m.count = 0;
    this.itemInst.fill(-1);
    for (let c = 0; c < this.N * this.N; c++) this.revealCell(c);
    this.refreshCore();
  }
  writeInstance(i, pos, quat, scaleMul = 1) {
    if (this.itemInst[i] < 0) return;
    const m = this.meshes[this.itemMesh[i]];
    const M = new THREE.Matrix4();
    const p = pos || new THREE.Vector3().fromArray(this.itemPos, i * 3);
    const q = quat || new THREE.Quaternion().fromArray(this.itemQuat, i * 4);
    const s = this.itemScale[i] * scaleMul;
    M.compose(p, q, new THREE.Vector3(s, s, s));
    m.setMatrixAt(this.itemInst[i], M);
    m.setColorAt(this.itemInst[i], new THREE.Color().fromArray(this.itemColor, i * 3));
  }
  hideInstance(i) { this.hide(i); }

  // ---- ground patch -----------------------------------------------------------------
  buildGround(material) {
    const N = this.N, size = N * CELL;
    const g = new THREE.PlaneGeometry(size, size, N, N);
    g.rotateX(-Math.PI / 2);
    const p = g.getAttribute('position');
    const uv = g.getAttribute('uv');
    const col = new Float32Array(p.count * 3).fill(1);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      p.setY(i, terrainHeight(x, z, this.terrainSeed));
      uv.setXY(i, x / 4, z / 4);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    this.groundGeo = g;
    const m = material.clone();
    m.vertexColors = true;
    m.polygonOffset = true;
    m.polygonOffsetFactor = -1;
    m.polygonOffsetUnits = -2;
    this.ground = new THREE.Mesh(g, m);
    this.ground.receiveShadow = true;
    this.group.add(this.ground);
  }
  // Dark 'compacted rubbish' surface at the top of the undrawn layers, so gaps between
  // drawn items show more rubbish instead of the ground far below.
  coreHeight(c) {
    const hidden = Math.max(0, this.cellTop[c] - VIS);
    if (!hidden) return this.cellBase[c] - this.soil[c] - 0.03;
    return this.cellBase[c] + this.stackY[this.cellStart[c] + c + hidden] - 0.02;
  }
  refreshCore(cells) {
    const N = this.N;
    if (!this.core) {
      const g = new THREE.PlaneGeometry(N * CELL, N * CELL, N, N);
      g.rotateX(-Math.PI / 2);
      const uv = g.getAttribute('uv'), p = g.getAttribute('position');
      for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / 2, p.getZ(i) / 2);
      const m = this.ground.material.clone();
      m.vertexColors = false;
      m.color = new THREE.Color(0.32, 0.27, 0.22);
      m.polygonOffset = false;
      this.core = new THREE.Mesh(g, m);
      this.core.receiveShadow = true;
      this.group.add(this.core);
      cells = null;
    }
    const p = this.core.geometry.getAttribute('position');
    const verts = new Set();
    if (cells) {
      for (const c of cells) { const ix = c % N, iz = Math.floor(c / N); for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) verts.add((iz + b) * (N + 1) + ix + a); }
    }
    const each = (v) => {
      const vx = v % (N + 1), vz = Math.floor(v / (N + 1));
      let h = Infinity;
      for (const [a, b] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
        const cx = vx + a, cz = vz + b;
        if (cx < 0 || cz < 0 || cx >= N || cz >= N) continue;
        h = Math.min(h, this.coreHeight(cz * N + cx));
      }
      p.setY(v, h === Infinity ? -1 : h);
    };
    if (cells) verts.forEach(each); else for (let v = 0; v < p.count; v++) each(v);
    p.needsUpdate = true;
    this.core.geometry.computeVertexNormals();
  }
  refreshGround(cells) {
    const N = this.N, p = this.groundGeo.getAttribute('position'), col = this.groundGeo.getAttribute('color');
    const touched = new Set();
    for (const c of cells) {
      const ix = c % N, iz = Math.floor(c / N);
      for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) touched.add((iz + b) * (N + 1) + ix + a);
    }
    for (const v of touched) {
      const vx = v % (N + 1), vz = Math.floor(v / (N + 1));
      let mx = 0, sum = 0, cnt = 0;
      for (const [a, b] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
        const cx = vx + a, cz = vz + b;
        if (cx < 0 || cz < 0 || cx >= N || cz >= N) continue;
        const s = this.soil[cz * N + cx];
        mx = Math.max(mx, s); sum += s; cnt++;
      }
      const d = mx * 0.65 + (cnt ? sum / cnt : 0) * 0.35;
      p.setY(v, terrainHeight(p.getX(v), p.getZ(v), this.terrainSeed) - d);
      const k = 1 - Math.min(0.55, d * 1.6);
      col.setXYZ(v, k, k * 0.96, k * 0.92);
    }
    p.needsUpdate = true;
    col.needsUpdate = true;
    this.groundGeo.computeVertexNormals();
  }

  // ---- exposure ----------------------------------------------------------------------
  isExposed(t) {
    if (t.collected) return false;
    if (t.inSoil) return this.cellTop[t.cell] === 0 && this.soil[t.cell] >= t.soilDepth - 0.025;
    return this.cellTop[t.cell] <= t.layer;
  }
  updateExposure(cells) {
    const newly = [];
    const list = cells ? cells.flatMap((c) => this.treasuresByCell.get(c) || []) : this.treasures;
    for (const t of list) {
      const e = this.isExposed(t);
      if (e && !t.exposed) newly.push(t);
      t.exposed = e;
    }
    return newly;
  }

  // ---- picking -----------------------------------------------------------------------
  // March along the ray against the cell heightfield. Returns { point, cell } or null.
  pick(ray, maxDist = 80) {
    const o = ray.origin, d = ray.direction;
    let prev = 0, prevAbove = true;
    const step = 0.05;
    for (let t = 0.2; t < maxDist; t += step * (1 + t * 0.02)) {
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
      const h = this.heightAt(x, z);
      const above = y > h;
      if (!above && prevAbove) {
        let a = prev, b = t;
        for (let k = 0; k < 10; k++) { const m = (a + b) / 2; const ym = o.y + d.y * m; if (ym > this.heightAt(o.x + d.x * m, o.z + d.z * m)) a = m; else b = m; }
        const point = new THREE.Vector3(o.x + d.x * b, o.y + d.y * b, o.z + d.z * b);
        return { point, cell: this.cellIndex(point.x, point.z), dist: b };
      }
      prev = t;
      prevAbove = above;
      if (y < -3) break;
    }
    return null;
  }
  // nearest collectable treasure near a ray/point
  pickTreasure(ray, hitPoint, reach) {
    let best = null, bestD = Infinity;
    const tmp = new THREE.Vector3();
    for (const t of this.treasures) {
      if (!t.exposed || t.collected) continue;
      const c = tmp.copy(t.pos);
      c.y += 0.004;
      const rr = reach + (t.model.userData.size || 0) * 0.5;
      const dRay = ray.distanceToPoint(c);
      const dHit = hitPoint ? hitPoint.distanceTo(c) : Infinity;
      const d = Math.min(dRay, dHit);
      if (d < rr && d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  setHighlight(i) {
    if (this.highlight === i) return;
    if (this.highlight != null && this.highlight >= 0 && this.itemInst[this.highlight] >= 0) {
      const m = this.meshes[this.itemMesh[this.highlight]];
      m.setColorAt(this.itemInst[this.highlight], new THREE.Color().fromArray(this.itemColor, this.highlight * 3));
      m.instanceColor.needsUpdate = true;
    }
    this.highlight = i;
    if (i != null && i >= 0 && this.itemInst[i] >= 0) {
      const m = this.meshes[this.itemMesh[i]];
      const c = new THREE.Color().fromArray(this.itemColor, i * 3);
      c.lerp(new THREE.Color(1.6, 1.45, 1.1), 0.35);
      m.setColorAt(this.itemInst[i], c);
      m.instanceColor.needsUpdate = true;
    }
  }

  // ---- digging -----------------------------------------------------------------------
  // Clears rubbish around a point. Returns what happened so the game can animate and score it.
  dig(point, tool, { focusCell = -1 } = {}) {
    const removed = [], soilCells = [], touched = [];
    const R = tool.radius;
    const cR = Math.ceil(R / CELL) + 1;
    const c0 = focusCell >= 0 ? focusCell : this.cellIndex(point.x, point.z);
    if (c0 < 0) return { removed, soilCells, newly: [] };
    const ix0 = c0 % this.N, iz0 = Math.floor(c0 / this.N);
    const centre = new THREE.Vector3();
    for (let dz = -cR; dz <= cR; dz++) for (let dx = -cR; dx <= cR; dx++) {
      const ix = ix0 + dx, iz = iz0 + dz;
      if (ix < 0 || iz < 0 || ix >= this.N || iz >= this.N) continue;
      const c = iz * this.N + ix;
      this.cellCenter(c, centre);
      const dist = Math.hypot(centre.x - point.x, centre.z - point.z);
      if (c !== c0 && dist > R) continue;
      const protect = (this.treasuresByCell.get(c) || []).filter((t) => !t.collected && t.exposed);
      if (protect.length) continue; // never shovel over a find that is already showing
      if (this.cellTop[c] > 0) {
        for (let k = 0; k < tool.layers && this.cellTop[c] > 0; k++) {
          const blocking = (this.treasuresByCell.get(c) || []).some((t) => !t.collected && !t.inSoil && t.layer >= this.cellTop[c]);
          if (blocking) break;
          const i = this.topItem(c);
          this.cellTop[c]--;
          removed.push(i);
        }
        touched.push(c);
      } else if (dist <= Math.max(CELL * 0.75, R * 0.6) && this.soil[c] < MAX_SOIL && ix > 3 && iz > 3 && ix < this.N - 4 && iz < this.N - 4) {
        const blockingSoil = (this.treasuresByCell.get(c) || []).some((t) => !t.collected && t.inSoil && this.soil[c] >= t.soilDepth - 0.025);
        if (blockingSoil) continue;
        this.soil[c] = Math.min(MAX_SOIL, this.soil[c] + tool.soil * (c === c0 ? 1 : 0.6));
        soilCells.push(c);
        touched.push(c);
      }
    }
    if (soilCells.length) this.refreshGround(soilCells);
    if (removed.length) {
      this.removedCount = (this.removedCount || 0) + removed.length;
      for (const c of touched) this.revealCell(c);
      this.refreshCore(touched);
    }
    const newly = this.updateExposure(touched);
    for (const i of removed) this.startThrow(i, point);
    return { removed, soilCells, newly };
  }

  startThrow(i, from) {
    const pos = new THREE.Vector3().fromArray(this.itemPos, i * 3);
    const away = new THREE.Vector3(pos.x - from.x, 0, pos.z - from.z);
    if (away.lengthSq() < 1e-4) away.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    away.normalize();
    const out = new THREE.Vector3(pos.x, 0, pos.z).normalize();
    away.lerp(out, 0.5).normalize();
    const vel = away.multiplyScalar(1.4 + Math.random() * 1.2);
    vel.y = 2.0 + Math.random() * 1.3;
    const spin = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    this.anims.push({ i, t: 0, dur: 0.75 + Math.random() * 0.2, pos, vel, spin, spinRate: 5 + Math.random() * 6, quat: new THREE.Quaternion().fromArray(this.itemQuat, i * 4) });
  }

  update(dt) {
    if (!this.anims.length) return;
    const dirty = new Set();
    const dq = new THREE.Quaternion();
    for (const a of this.anims) {
      a.t += dt;
      a.vel.y -= 9.8 * dt;
      a.pos.addScaledVector(a.vel, dt);
      dq.setFromAxisAngle(a.spin, a.spinRate * dt);
      a.quat.premultiply(dq);
      const k = a.t / a.dur;
      const s = k < 0.6 ? 1 : Math.max(0, 1 - (k - 0.6) / 0.4);
      if (k >= 1) this.hide(a.i);
      else this.writeInstance(a.i, a.pos, a.quat, s);
      dirty.add(this.itemMesh[a.i]);
    }
    this.anims = this.anims.filter((a) => a.t < a.dur);
    for (const mi of dirty) { this.meshes[mi].instanceMatrix.needsUpdate = true; this.meshes[mi].instanceColor.needsUpdate = true; }
  }

  // ---- detector support --------------------------------------------------------------
  // Calls fn(kind, x, z, depth, massG, metalCode, ref) for every metallic target near (x, z).
  forTargets(x, z, radius, fn) {
    const c0 = this.cellIndex(x, z);
    const cR = Math.ceil(radius / CELL);
    const ix0 = c0 >= 0 ? c0 % this.N : Math.floor((x - this.origin) / CELL);
    const iz0 = c0 >= 0 ? Math.floor(c0 / this.N) : Math.floor((z - this.origin) / CELL);
    for (let dz = -cR; dz <= cR; dz++) for (let dx = -cR; dx <= cR; dx++) {
      const ix = ix0 + dx, iz = iz0 + dz;
      if (ix < 0 || iz < 0 || ix >= this.N || iz >= this.N) continue;
      const c = iz * this.N + ix;
      const top = this.topHeight(c);
      const s0 = this.cellStart[c];
      for (let l = 0; l < this.cellTop[c]; l++) {
        const i = s0 + l;
        if (!this.itemMetal[i]) continue;
        const px = this.itemPos[i * 3], pz = this.itemPos[i * 3 + 2];
        const py = this.cellBase[c] + this.itemY[i] + this.itemT[i] * 0.5;
        fn('junk', px, pz, Math.max(0, top - py), this.itemMass[i], this.itemMetal[i], i);
      }
      const ts = this.treasuresByCell.get(c);
      if (ts) for (const t of ts) {
        if (t.collected || !t.metal) continue;
        fn('treasure', t.pos.x, t.pos.z, Math.max(0, top - t.pos.y), t.item.mass, t.metal, t);
      }
    }
  }

  // ---- collection -------------------------------------------------------------------------
  markCollected(t) {
    t.collected = true;
    t.exposed = false;
  }

  stats() {
    const found = this.treasures.filter((t) => t.collected).length;
    const removed = this.totalItems - this.cellTop.reduce((a, b) => a + b, 0);
    return { found, total: this.treasures.length, cleared: this.totalItems ? removed / this.totalItems : 1, removed };
  }

  // ---- save / restore -------------------------------------------------------------------
  serialize() {
    const soil = new Uint8Array(this.soil.length);
    for (let i = 0; i < soil.length; i++) soil[i] = Math.round(this.soil[i] / SOIL_STEP);
    return {
      seed: this.seed,
      top: b64(this.cellTop),
      soil: b64(soil),
      collected: this.treasures.filter((t) => t.collected).map((t) => t.item.uid),
    };
  }
  restore(s) {
    if (!s || s.seed !== this.seed) return;
    const top = unb64(s.top), soil = unb64(s.soil);
    if (top.length !== this.cellTop.length) return;
    const soilCells = [];
    for (let c = 0; c < top.length; c++) {
      const t = Math.min(top[c], this.cellFull[c]);
      this.cellTop[c] = t;
      this.soil[c] = (soil[c] || 0) * SOIL_STEP;
      if (this.soil[c] > 0) soilCells.push(c);
    }
    const col = new Set(s.collected || []);
    for (const t of this.treasures) if (col.has(t.item.uid)) { t.collected = true; t.model.visible = false; }
    if (soilCells.length) this.refreshGround(soilCells);
    this.rebuildVisibility();
    this.updateExposure();
  }

  dispose() {
    for (const m of this.meshes) m.dispose();
    for (const key in this.lib) for (const v of this.lib[key]) v.geo.dispose();
    this.groundGeo.dispose();
    this.ground.material.dispose();
    if (this.core) { this.core.geometry.dispose(); this.core.material.dispose(); }
    this.treasureGroup.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
  }
}

function b64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
function unb64(str) {
  const s = atob(str || '');
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
