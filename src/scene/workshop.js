// The machine shop / toolroom around the VMC: building shell, equipment, props, lights and the game
// anchors (job board, stock rack, inspection bench, tool crib, CAM desk, drawing desk).
//
// World units are mm, +Y up, +Z toward the machine operator; the VMC stands at the origin.
// Static geometry is accumulated into per-(bucket, material) vertex buffers and emitted as one mesh
// each, so the whole shop costs roughly 45-55 draw calls. Plain painted / metal / matte parts share
// three vertex-coloured materials. Each outer wall and the roof is its own bucket so the orbit camera
// can see in when it is outside the building (cut-away, see update()).
import * as THREE from 'three';
import { hazardTexture } from './textures.js';
import { PROFILE } from '../config.js';
import {
  canvasTex, makeCanvas, rng, concreteCanvas, stainCanvas, blockCanvas, corrugatedCanvas, slatCanvas,
  woodCanvas, graniteCanvas, rubberMatCanvas, corkCanvas, decalAtlas, camScreenCanvas,
} from './workshop-textures.js';

export const WORKSHOP_ROOM = { x0: -7500, x1: 7500, z0: -5000, z1: 8000, eave: 5400, ridge: 6200 };
const R = WORKSHOP_ROOM;
const SLOPE = Math.atan((R.ridge - R.eave) / R.x1);
const roofY = (x) => R.eave + (R.ridge - R.eave) * (1 - Math.min(1, Math.abs(x) / R.x1));
// portal frame column lines (z) and the bays between them
const CZ = [-4850, -1600, 1650, 4900, 7850];
const HALF_PI = Math.PI / 2;

// ---------------------------------------------------------------- geometry accumulation

const TPL = new Map();
function tpl(key, make) {
  let t = TPL.get(key);
  if (!t) {
    let g = make();
    if (g.index) g = g.toNonIndexed();
    t = { pos: g.attributes.position.array, nrm: g.attributes.normal.array, uv: g.attributes.uv.array, count: g.attributes.position.count };
    TPL.set(key, t);
    g.dispose();
  }
  return t;
}
const tBox = () => tpl('box', () => new THREE.BoxGeometry(1, 1, 1));
const tPlane = () => tpl('plane', () => new THREE.PlaneGeometry(1, 1));
const tCyl = (segs = 16, top = 1, open = false) => tpl(`cyl${segs}_${top}_${open}`, () => new THREE.CylinderGeometry(0.5 * top, 0.5, 1, segs, 1, open));
const tTorus = (segs = 24, tube = 0.08) => tpl(`tor${segs}_${tube}`, () => new THREE.TorusGeometry(0.5, tube, 6, segs));
const tSphere = (segs = 12) => tpl(`sph${segs}`, () => new THREE.SphereGeometry(0.5, segs, Math.max(4, segs >> 1)));

const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
function mtx(x, y, z, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0, order = 'XYZ') {
  _e.set(rx, ry, rz, order);
  _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(_v.set(x, y, z), _q, _s.set(sx, sy, sz));
}

class Builder {
  constructor() {
    this.chunks = new Map();
    this.stack = [new THREE.Matrix4()];
    this.colliders = [];
  }
  get top() { return this.stack[this.stack.length - 1]; }
  // local frame: translate to (x, y, z) and turn by ry about +Y
  at(x, z, ry, fn, y = 0) {
    this.stack.push(this.top.clone().multiply(mtx(x, y, z, 1, 1, 1, 0, ry, 0)));
    fn();
    this.stack.pop();
  }
  add(bucket, spec, t, local, uvRect = null) {
    const m = spec.isMaterial ? spec : spec.m;
    const c = spec.isMaterial ? null : spec.c;
    const key = bucket + '|' + m.uuid;
    let ch = this.chunks.get(key);
    if (!ch) { ch = { bucket, mat: m, items: [], verts: 0 }; this.chunks.set(key, ch); }
    ch.items.push({ t, w: this.top.clone().multiply(local), c, uvRect });
    ch.verts += t.count;
  }
  // axis-aligned box from min/max corners (in the current frame)
  box(b, s, x0, y0, z0, x1, y1, z1) {
    this.add(b, s, tBox(), mtx((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0)));
  }
  boxC(b, s, x, y, z, w, h, d, rx = 0, ry = 0, rz = 0, order = 'XYZ') {
    this.add(b, s, tBox(), mtx(x, y, z, w, h, d, rx, ry, rz, order));
  }
  cyl(b, s, x, y, z, r, h, axis = 'y', segs = 16, top = 1, open = false) {
    const rx = axis === 'z' ? HALF_PI : 0, rz = axis === 'x' ? HALF_PI : 0;
    this.add(b, s, tCyl(segs, top, open), mtx(x, y, z, 2 * r, h, 2 * r, rx, 0, rz));
  }
  // cylinder between two points
  rod(b, s, a, c, r, segs = 8) {
    const d = new THREE.Vector3().subVectors(c, a);
    const len = d.length();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    const m = new THREE.Matrix4().compose(new THREE.Vector3().addVectors(a, c).multiplyScalar(0.5), q, new THREE.Vector3(2 * r, len, 2 * r));
    this.add(b, s, tCyl(segs), m);
  }
  sphere(b, s, x, y, z, r, segs = 12) { this.add(b, s, tSphere(segs), mtx(x, y, z, 2 * r, 2 * r, 2 * r)); }
  torus(b, s, x, y, z, r, tube, axis = 'z', segs = 24) {
    const rx = axis === 'y' ? HALF_PI : 0, ry = axis === 'x' ? HALF_PI : 0;
    this.add(b, s, tTorus(segs, tube / (2 * r)), mtx(x, y, z, 2 * r, 2 * r, 2 * r, rx, ry, 0));
  }
  // plane facing local +Z by default (ry turns it), uvRect = [u0, v0, u1, v1] into the material's map
  plane(b, s, x, y, z, w, h, ry = 0, rx = 0, uvRect = null) {
    this.add(b, s, tPlane(), mtx(x, y, z, w, h, 1, rx, ry, 0, 'YXZ'), uvRect);
  }
  // horizontal floor decal / marking (faces up)
  floorRect(b, s, x0, z0, x1, z1, y = 1.5, uvRect = null) {
    this.add(b, s, tPlane(), mtx((x0 + x1) / 2, y, (z0 + z1) / 2, Math.abs(x1 - x0), Math.abs(z1 - z0), 1, -HALF_PI, 0, 0), uvRect);
  }
  geo(b, s, geometry, local = new THREE.Matrix4()) {
    let g = geometry.index ? geometry.toNonIndexed() : geometry;
    const t = { pos: g.attributes.position.array, nrm: g.attributes.normal.array, uv: g.attributes.uv.array, count: g.attributes.position.count };
    this.add(b, s, t, local);
  }
  // collider rectangle given in the current local frame (converted to a world AABB)
  collide(x0, z0, x1, z1) {
    const m = this.top;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) {
      _v.set(x, 0, z).applyMatrix4(m);
      minX = Math.min(minX, _v.x); maxX = Math.max(maxX, _v.x);
      minZ = Math.min(minZ, _v.z); maxZ = Math.max(maxZ, _v.z);
    }
    this.colliders.push({ minX: Math.round(minX), maxX: Math.round(maxX), minZ: Math.round(minZ), maxZ: Math.round(maxZ) });
  }
  worldPoint(x, y, z) { return new THREE.Vector3(x, y, z).applyMatrix4(this.top); }
  worldQuat(extra = null) {
    const q = new THREE.Quaternion();
    this.top.decompose(new THREE.Vector3(), q, new THREE.Vector3());
    if (extra) q.multiply(extra);
    return q;
  }
  worldMatrix(local) { return this.top.clone().multiply(local); }

  // Emits one mesh per (bucket, material).
  build(groups) {
    const nm = new THREE.Matrix3();
    const col = new THREE.Color();
    for (const ch of this.chunks.values()) {
      const n = ch.verts;
      const P = new Float32Array(n * 3), N = new Float32Array(n * 3), U = new Float32Array(n * 2);
      const vc = ch.mat.vertexColors;
      const C = vc ? new Float32Array(n * 3) : null;
      const wuv = ch.mat.userData.wuv;
      let o = 0;
      for (const it of ch.items) {
        const e = it.w.elements;
        nm.getNormalMatrix(it.w);
        const ne = nm.elements;
        const { pos, nrm, uv, count } = it.t;
        if (vc) col.set(it.c ?? 0xffffff);
        const ur = it.uvRect;
        for (let i = 0; i < count; i++) {
          const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
          const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
          const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
          const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
          const a = nrm[i * 3], b = nrm[i * 3 + 1], c = nrm[i * 3 + 2];
          let nx = ne[0] * a + ne[3] * b + ne[6] * c;
          let ny = ne[1] * a + ne[4] * b + ne[7] * c;
          let nz = ne[2] * a + ne[5] * b + ne[8] * c;
          const l = Math.hypot(nx, ny, nz) || 1;
          nx /= l; ny /= l; nz /= l;
          const k = o + i;
          P[k * 3] = wx; P[k * 3 + 1] = wy; P[k * 3 + 2] = wz;
          N[k * 3] = nx; N[k * 3 + 1] = ny; N[k * 3 + 2] = nz;
          if (wuv) {
            const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
            let u, v;
            if (ay >= ax && ay >= az) { u = wx; v = -wz; } else if (ax >= az) { u = wz; v = wy; } else { u = wx; v = wy; }
            U[k * 2] = u / wuv[0] + (wuv[2] || 0);
            U[k * 2 + 1] = v / wuv[1] + (wuv[3] || 0);
          } else if (ur) {
            U[k * 2] = ur[0] + uv[i * 2] * (ur[2] - ur[0]);
            U[k * 2 + 1] = ur[1] + uv[i * 2 + 1] * (ur[3] - ur[1]);
          } else {
            U[k * 2] = uv[i * 2];
            U[k * 2 + 1] = uv[i * 2 + 1];
          }
          if (vc) { C[k * 3] = col.r; C[k * 3 + 1] = col.g; C[k * 3 + 2] = col.b; }
        }
        o += count;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(P, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(U, 2));
      if (vc) g.setAttribute('color', new THREE.BufferAttribute(C, 3));
      g.computeBoundingSphere();
      g.computeBoundingBox();
      const mesh = new THREE.Mesh(g, ch.mat);
      mesh.matrixAutoUpdate = false;
      mesh.name = `ws-${ch.bucket}-${ch.mat.name || 'mat'}`;
      const grp = groups[ch.bucket];
      mesh.castShadow = !!grp.userData.cast && !ch.mat.transparent && !ch.mat.isMeshBasicMaterial;
      mesh.receiveShadow = !ch.mat.isMeshBasicMaterial;
      grp.add(mesh);
    }
    this.chunks.clear();
  }
}

// Raycast-only box: renders nothing (no draw call) but is hit by THREE.Raycaster (incl. recursive
// intersectObjects). Local AABB in the object's frame.
const _inv = new THREE.Matrix4(), _ray = new THREE.Ray(), _hp = new THREE.Vector3();
export class HitBox extends THREE.Object3D {
  constructor(min, max) {
    super();
    this.box = new THREE.Box3(min.clone(), max.clone());
    this.isHitBox = true;
  }
  raycast(raycaster, intersects) {
    _inv.copy(this.matrixWorld).invert();
    _ray.copy(raycaster.ray).applyMatrix4(_inv);
    if (!_ray.intersectBox(this.box, _hp)) return;
    const point = _hp.clone().applyMatrix4(this.matrixWorld);
    const distance = raycaster.ray.origin.distanceTo(point);
    if (distance < raycaster.near || distance > raycaster.far) return;
    intersects.push({ distance, point, object: this, face: null });
  }
}

// ---------------------------------------------------------------- main entry

export function buildWorkshop(opts = {}) {
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = 'workshop';
  const groups = {};
  for (const [name, cast] of [['floor', false], ['int', false], ['near', true], ['wW', false], ['wE', false], ['wN', false], ['wS', false], ['roof', false], ['truss', false], ['out', false], ['dyn', false]]) {
    const g = new THREE.Group();
    g.name = 'ws-' + name;
    g.userData.cast = cast;
    group.add(g);
    groups[name] = g;
  }

  // ---------- materials
  const std = (o, name) => { const m = new THREE.MeshStandardMaterial(o); m.name = name; return m; };
  const atlas = decalAtlas();
  const A = atlas.uv;
  const M = {
    paint: std({ vertexColors: true, roughness: 0.55, metalness: 0.12, envMapIntensity: 0.8 }, 'paint'),
    metal: std({ vertexColors: true, roughness: 0.32, metalness: 0.85 }, 'metal'),
    matte: std({ vertexColors: true, roughness: 0.86, metalness: 0 }, 'matte'),
    glow: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
    concrete: std({ map: canvasTex(concreteCanvas()), roughness: 0.62, metalness: 0, color: 0xd4d6d4, envMapIntensity: 0.6 }, 'concrete'),
    block: std({ map: canvasTex(blockCanvas()), vertexColors: true, roughness: 0.9, metalness: 0 }, 'block'),
    clad: std({ map: canvasTex(corrugatedCanvas(false)), color: 0xb4bbc1, roughness: 0.5, metalness: 0.3 }, 'clad'),
    roofSheet: std({ map: canvasTex(corrugatedCanvas(true)), color: 0xaab0b4, roughness: 0.55, metalness: 0.3, side: THREE.DoubleSide }, 'roofSheet'),
    shutter: std({ map: canvasTex(slatCanvas()), color: 0xb9bec2, roughness: 0.45, metalness: 0.45 }, 'shutter'),
    wood: std({ map: canvasTex(woodCanvas()), roughness: 0.72, metalness: 0 }, 'wood'),
    granite: std({ map: canvasTex(graniteCanvas()), roughness: 0.3, metalness: 0.05 }, 'granite'),
    rubber: std({ map: canvasTex(rubberMatCanvas()), roughness: 0.95, metalness: 0 }, 'rubber'),
    decal: std({ map: canvasTex(atlas.canvas, { repeat: false }), roughness: 0.72, metalness: 0 }, 'decal'),
    hazard: std({ map: hazardTexture(), roughness: 0.6, metalness: 0 }, 'hazard'),
    stain: std({ map: canvasTex(stainCanvas(), { repeat: false }), transparent: true, depthWrite: false, roughness: 0.4, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }, 'stain'),
  };
  M.glow.name = 'glow';
  const tTex = performance.now();
  M.concrete.userData.wuv = [4000, 4000, 0.5, 0.5];
  M.block.userData.wuv = [1760, 1720];
  M.clad.userData.wuv = [1000, 1000];
  M.roofSheet.userData.wuv = [1000, 1000];
  M.shutter.userData.wuv = [1000, 300];
  M.wood.userData.wuv = [900, 900];
  M.granite.userData.wuv = [400, 400];
  M.rubber.userData.wuv = [70, 70];
  M.hazard.map.wrapT = THREE.ClampToEdgeWrapping;

  const P = (c) => ({ m: M.paint, c });
  const MT = (c) => ({ m: M.metal, c });
  const MA = (c) => ({ m: M.matte, c });
  const GL = (c) => ({ m: M.glow, c });
  const C = {
    white: P(0xc8c8c8), steelGrey: P(0x4f5a66), dark: P(0x2e3338), darker: P(0x1e2124), trim: P(0x6d757d),
    red: P(0xb3201c), yellow: P(0xd9a514), blue: P(0x2b5ea8), orange: P(0xd8701e), green: P(0x2f6b3a),
    lathe: P(0x7b8d84), cream: P(0xc4bfac), sawBlue: P(0x4a5866), sawYellow: P(0xd29a1e), drill: P(0x5f7d6f),
    door: P(0x35618f), office: P(0xb9bcbf), plan: P(0x6f7a84), drum: P(0x2856a0),
    steel: MT(0xb8bec4), chrome: MT(0xd5dade), galv: MT(0x9aa1a6), darkSteel: MT(0x41464c), brass: MT(0xb08a3e),
    black: MA(0x161719), rubber: MA(0x1c1d1f), card: MA(0xa47c4e), foam: MA(0x22344d), felt: MA(0x2d4a38), paper: MA(0xdedcd2),
    lampGlow: GL(0xffffff), sky: GL(0xc4d4e2), skyHi: GL(0xd6e2ec), screenOff: GL(0x10161c), led: GL(0x8af0a0),
  };

  const B = new Builder();
  const anchors = {};
  const interactables = [];
  const dyn = groups.dyn;
  const hit = (parent, x0, y0, z0, x1, y1, z1, matrix) => {
    const h = new HitBox(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
    h.matrixAutoUpdate = false;
    h.matrix.copy(matrix);
    parent.add(h);
    return h;
  };

  // ================================================================ building shell
  // floor + exterior apron
  B.floorRect('floor', M.concrete, R.x0, R.z0, R.x1, R.z1, 0);
  for (const [x0, z0, x1, z1] of [[-40000, -40000, 40000, R.z0 - 260], [-40000, R.z1 + 260, 40000, 40000], [-40000, R.z0 - 260, R.x0 - 260, R.z1 + 260], [R.x1 + 260, R.z0 - 260, 40000, R.z1 + 260]]) {
    B.floorRect('out', MA(0x2a2c2f), x0, z0, x1, z1, -2);
  }
  B.floorRect('out', MA(0x55585b), R.x0 - 1200, R.z0 - 1200, R.x1 + 1200, R.z1 + 1200, -4);

  const BAND = 2400; // blockwork height
  const DADO = 1200; // darker painted band below this
  const BLK_LO = { m: M.block, c: 0x8d99a2 }, BLK_HI = { m: M.block, c: 0xc6c8c6 };
  // conduit drop + twin socket (current local frame, against the wall)
  const drop = (b, x) => {
    B.box(b, C.office, x - 14, 1240, 0, x + 14, 2250, 28);
    B.box(b, C.white, x - 70, 1120, 0, x + 70, 1240, 48);
    B.box(b, C.red, x - 50, 1170, 48, x - 20, 1190, 52);
  };
  // long walls (x = const)
  for (const side of [-1, 1]) {
    const b = side < 0 ? 'wW' : 'wE';
    const xi = side < 0 ? R.x0 : R.x1;
    const xo = xi + side * 220;
    B.box(b, BLK_LO, Math.min(xi, xo), 0, R.z0 - 220, Math.max(xi, xo), DADO, R.z1 + 220);
    B.box(b, BLK_HI, Math.min(xi, xo), DADO, R.z0 - 220, Math.max(xi, xo), BAND, R.z1 + 220);
    B.box(b, C.dark, Math.min(xi, xi - side * 1.5), DADO - 20, R.z0, Math.max(xi, xi - side * 6), DADO + 20, R.z1);
    // cable trunking just below the cladding line
    B.box(b, C.office, Math.min(xi, xi - side * 70), 2250, R.z0, Math.max(xi, xi - side * 70), 2330, R.z1);
    B.box(b, M.clad, Math.min(xi, xo + -side * 60), BAND, R.z0 - 220, Math.max(xi, xo + -side * 60), R.eave + 40, R.z1 + 220);
    B.box(b, C.trim, Math.min(xi, xi - side * 18), BAND - 30, R.z0, Math.max(xi, xi - side * 18), BAND + 30, R.z1);
    B.box(b, C.dark, Math.min(xi, xi - side * 10), 0, R.z0, Math.max(xi, xi - side * 10), 120, R.z1);
    // high-level strip windows in every bay
    for (let i = 0; i < CZ.length - 1; i++) {
      const za = CZ[i] + 380, zb = CZ[i + 1] - 380;
      const xf = xi - side * 14;
      B.at(xf, (za + zb) / 2, -side * HALF_PI, () => {
        const w = zb - za;
        B.plane(b, C.sky, 0, 3450, 0, w, 900);
        B.plane(b, C.skyHi, 0, 3760, 1, w, 260);
        // frame + mullions
        B.box(b, C.trim, -w / 2 - 50, 2950, 0, w / 2 + 50, 3000, 40);
        B.box(b, C.trim, -w / 2 - 50, 3900, 0, w / 2 + 50, 3950, 40);
        B.box(b, C.trim, -w / 2 - 50, 2950, 0, -w / 2, 3950, 40);
        B.box(b, C.trim, w / 2, 2950, 0, w / 2 + 50, 3950, 40);
        const n = Math.round(w / 800);
        for (let k = 1; k < n; k++) B.box(b, C.trim, -w / 2 + (k * w) / n - 20, 3000, 0, -w / 2 + (k * w) / n + 20, 3900, 30);
        B.box(b, C.trim, -w / 2, 3620, 0, w / 2, 3650, 30);
        // sill
        B.box(b, C.trim, -w / 2 - 60, 2920, 0, w / 2 + 60, 2950, 90);
      });
    }
  }
  // gable walls (z = const)
  for (const side of [-1, 1]) {
    const b = side < 0 ? 'wN' : 'wS';
    const zi = side < 0 ? R.z0 : R.z1;
    const zo = zi + side * 220;
    B.box(b, BLK_LO, R.x0 - 220, 0, Math.min(zi, zo), R.x1 + 220, DADO, Math.max(zi, zo));
    B.box(b, BLK_HI, R.x0 - 220, DADO, Math.min(zi, zo), R.x1 + 220, BAND, Math.max(zi, zo));
    B.box(b, C.dark, R.x0, DADO - 20, Math.min(zi, zi - side * 1.5), side < 0 ? R.x1 : 2300, DADO + 20, Math.max(zi, zi - side * 1.5));
    B.box(b, C.office, R.x0, 2250, Math.min(zi, zi - side * 70), side < 0 ? R.x1 : 2300, 2330, Math.max(zi, zi - side * 70));
    if (side > 0) {
      B.box(b, C.dark, 6700, DADO - 20, zi - 1.5, R.x1, DADO + 20, zi);
      B.box(b, C.office, 6700, 2250, zi - 70, R.x1, 2330, zi);
    }
    const sh = new THREE.Shape();
    const xe = R.x1 + 220;
    sh.moveTo(-xe, BAND);
    sh.lineTo(xe, BAND);
    sh.lineTo(xe, roofY(xe) + 40);
    sh.lineTo(0, R.ridge + 40);
    sh.lineTo(-xe, roofY(xe) + 40);
    sh.closePath();
    const eg = new THREE.ExtrudeGeometry(sh, { depth: 160, bevelEnabled: false });
    B.geo(b, M.clad, eg, mtx(0, 0, side < 0 ? zi - 160 : zi));
    B.box(b, C.trim, R.x0, BAND - 30, Math.min(zi, zi - side * 18), R.x1, BAND + 30, Math.max(zi, zi - side * 18));
    B.box(b, C.dark, R.x0, 0, Math.min(zi, zi - side * 10), R.x1, 120, Math.max(zi, zi - side * 10));
  }
  // wall colliders (outside the interior faces)
  B.colliders.push({ minX: R.x0 - 600, maxX: R.x0, minZ: R.z0 - 600, maxZ: R.z1 + 600 });
  B.colliders.push({ minX: R.x1, maxX: R.x1 + 600, minZ: R.z0 - 600, maxZ: R.z1 + 600 });
  B.colliders.push({ minX: R.x0 - 600, maxX: R.x1 + 600, minZ: R.z0 - 600, maxZ: R.z0 });
  B.colliders.push({ minX: R.x0 - 600, maxX: R.x1 + 600, minZ: R.z1, maxZ: R.z1 + 600 });

  // portal frames: columns, rafters, purlins, roof sheets, skylights
  const SC = C.steelGrey;
  for (const z of CZ) {
    for (const side of [-1, 1]) {
      const cb = side < 0 ? 'wW' : 'wE';
      const xi = side < 0 ? R.x0 : R.x1;
      const top = roofY(xi) - 200;
      // UC column: outer flange against the wall, web, inner flange
      B.box(cb, SC, xi, 0, z - 150, xi - side * 18, top, z + 150);
      B.box(cb, SC, xi - side * 18, 0, z - 6, xi - side * 282, top, z + 6);
      B.box(cb, SC, xi - side * 282, 0, z - 150, xi - side * 300, top, z + 150);
      B.box(cb, C.darker, xi - side * 10, 0, z - 220, xi - side * 380, 20, z + 220);
      B.colliders.push({ minX: Math.min(xi, xi - side * 300), maxX: Math.max(xi, xi - side * 300), minZ: z - 150, maxZ: z + 150 });
      // haunch
      B.box(cb, SC, Math.min(xi - side * 300, xi - side * 900), top - 900, z - 6, Math.max(xi - side * 300, xi - side * 900), top - 450, z + 6);
      B.box(cb, SC, Math.min(xi - side * 300, xi - side * 900), top - 918, z - 100, Math.max(xi - side * 300, xi - side * 900), top - 900, z + 100);
    }
    // rafters (I beams following the roof pitch)
    for (const side of [-1, 1]) {
      const xc = side * R.x1 / 2;
      const len = R.x1 / Math.cos(SLOPE) + 20;
      const rz = side < 0 ? SLOPE : -SLOPE;
      const yTop = roofY(xc) - 200;
      const nx = -Math.sin(rz), ny = Math.cos(rz); // beam local up in world
      const at = (off) => [xc + nx * off, yTop + ny * off];
      let [x, y] = at(-8); B.boxC('truss', SC, x, y, z, len, 16, 200, 0, 0, rz);
      [x, y] = at(-225); B.boxC('truss', SC, x, y, z, len, 420, 12, 0, 0, rz);
      [x, y] = at(-442); B.boxC('truss', SC, x, y, z, len, 16, 200, 0, 0, rz);
    }
  }
  // purlins + eaves beams
  for (const side of [-1, 1]) {
    for (let k = 0; k < 6; k++) {
      const x = side * (400 + k * 1300);
      const y = roofY(x);
      B.box('truss', C.trim, x - 30, y - 200, R.z0, x + 30, y - 2, R.z1);
      B.box('truss', C.trim, x - 30, y - 200, R.z0, x + 3, y - 180, R.z1);
    }
    const xe = side * (R.x1 - 150);
    B.box('truss', SC, xe - 80, roofY(xe) - 420, R.z0, xe + 80, roofY(xe) - 200, R.z1);
  }
  // ridge beam
  B.box('truss', SC, -90, R.ridge - 420, R.z0, 90, R.ridge - 200, R.z1);
  // roof sheets (double sided so it reads from above as well)
  for (const side of [-1, 1]) {
    const w = R.x1 + 400;
    const xc = side * w / 2;
    const len = w / Math.cos(SLOPE);
    const rz = side < 0 ? SLOPE : -SLOPE;
    B.boxC('roof', M.roofSheet, xc, roofY(xc) + 22, (R.z0 + R.z1) / 2, len, 40, R.z1 - R.z0 + 500, 0, 0, rz);
    // skylight strips (glowing panels just below the sheet) between the frames
    for (let i = 0; i < CZ.length - 1; i++) {
      for (const xs of [2600, 5000]) {
        const x = side * xs;
        B.boxC('roof', C.skyHi, x, roofY(x) - 4, (CZ[i] + CZ[i + 1]) / 2, 900 / Math.cos(SLOPE), 6, CZ[i + 1] - CZ[i] - 900, 0, 0, rz);
      }
    }
  }

  // high-bay LED lamps
  const lampPos = [];
  for (const x of [-4600, 0, 4600]) for (const z of [-3200, 0, 3300, 6400]) lampPos.push([x, z]);
  for (const [x, z] of lampPos) {
    const y = 4550;
    B.cyl('truss', C.dark, x, y + 90, z, 210, 130, 'y', 20, 0.75);
    B.cyl('truss', C.darker, x, y + 175, z, 70, 60, 'y', 12);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI;
      B.boxC('truss', C.dark, x, y + 110, z, 440, 70, 8, 0, a, 0);
    }
    B.cyl('truss', C.lampGlow, x, y + 22, z, 190, 8, 'y', 20);
    B.rod('truss', C.darkSteel, new THREE.Vector3(x, y + 200, z), new THREE.Vector3(x, roofY(x) - 200, z), 5, 6);
  }

  // ================================================================ floor markings
  const LINE = P(0xd2a01a);
  const lineX = (x0, x1, z, w = 100) => B.floorRect('floor', LINE, x0, z - w / 2, x1, z + w / 2, 1.6);
  const lineZ = (z0, z1, x, w = 100) => B.floorRect('floor', LINE, x - w / 2, z0, x + w / 2, z1, 1.6);
  // main cross aisle and the aisle from the personnel door
  lineX(-6300, 6200, 2700);
  lineX(-6300, -4950, 4300);
  lineX(-3450, 2300, 4300);
  lineX(6500, 6200, 4300);
  lineZ(4300, 7900, -4950);
  lineZ(4300, 7900, -3450);
  // keep-clear box in front of the roller shutter
  lineX(2500, 6500, 6600);
  lineZ(6600, 7950, 2500);
  lineZ(6600, 7950, 6500);
  for (let x = 2700; x < 6500; x += 450) B.add('floor', LINE, tPlane(), mtx(x + 225, 1.6, 7300, 90, 1500, 1, -HALF_PI, 0, Math.PI / 4, 'XYZ'));
  // hazard border around the VMC working zone (operator area included)
  const hz = (x0, z0, x1, z1) => {
    const alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0);
    const len = alongX ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    B.add('floor', M.hazard, tPlane(), mtx(cx, 1.8, cz, len, 110, 1, -HALF_PI, 0, alongX ? 0 : HALF_PI, 'XYZ'), [0, 0, len / 420, 1]);
  };
  hz(-1550, -1950, 2400, -1950);
  hz(-1550, 2300, 2400, 2300);
  hz(-1550, -1950, -1550, 2300);
  hz(2400, -1950, 2400, 2300);
  // oil stains
  const stains = [[600, 1250, 900, 0], [-900, -1700, 700, 1], [1900, 200, 800, 2], [-5600, -3400, 1100, 0], [6500, 2900, 900, 1], [-2600, 900, 600, 3], [3200, 3600, 1000, 3], [-5200, 2100, 700, 2], [4300, -3300, 900, 0], [5600, 6900, 1400, 3]];
  for (const [x, z, s, k] of stains) {
    const u = (k % 2) * 0.5, v = Math.floor(k / 2) * 0.5;
    B.add('floor', M.stain, tPlane(), mtx(x, 0.8, z, s, s, 1, -HALF_PI, 0, (x * 0.37) % 3, 'XYZ'), [u, 0.5 - v, u + 0.5, 1 - v]);
  }
  // anti-fatigue mats: in front of the VMC (replaces the one in machine.js 'floor'), lathe, bench
  if (PROFILE.id === 'vmc560') B.box('floor', M.rubber, -750, 0, 940, 750, 14, 1700);
  else B.box('floor', M.rubber, -700, 0, 880, 800, 14, 1650);
  B.box('floor', M.rubber, -6700, 0, -3950, -4700, 12, -3350);
  B.box('floor', M.rubber, -1500, 0, -4150, 600, 12, -3600);

  // ================================================================ props
  const decal = (b, name, x, y, z, w, h, ry = 0, rx = 0) => B.plane(b, M.decal, x, y, z, w, h, ry, rx, A[name]);

  // ---------- JOB BOARD (left wall, bay 1650..4900)
  const JB = { w: 2400, h: 1000, cy: 1600, cols: 5, rows: 2, sw: 420, sh: 297 };
  const jobSlotsLocal = [];
  {
    const gapX = (JB.w - 120 - JB.cols * JB.sw) / (JB.cols - 1);
    for (let r = 0; r < JB.rows; r++) for (let c = 0; c < JB.cols; c++) {
      const x = -JB.w / 2 + 60 + c * (JB.sw + gapX) + JB.sw / 2;
      const yTop = JB.h / 2 - 140 - r * (JB.sh + 110);
      jobSlotsLocal.push({ x, y: yTop - JB.sh / 2 });
    }
  }
  const jbCanvas = makeCanvas(3072, 1280);
  const jbTex = canvasTex(jbCanvas, { repeat: false });
  const corkPat = jbCanvas.getContext('2d').createPattern(corkCanvas(), 'repeat');
  const pxPerMm = jbCanvas.width / JB.w;
  const slotPx = (i) => {
    const s = jobSlotsLocal[i];
    const w = JB.sw * pxPerMm, h = JB.sh * pxPerMm;
    const cx = (s.x + JB.w / 2) * pxPerMm, cy = (JB.h / 2 - s.y) * pxPerMm;
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  };
  const jobSheets = new Array(jobSlotsLocal.length).fill(null);
  function drawSlot(i) {
    const k = jbCanvas.getContext('2d');
    const r = slotPx(i);
    const m = 34;
    k.fillStyle = corkPat;
    k.fillRect(r.x - m, r.y - m, r.w + 2 * m, r.h + 2 * m + 70);
    // slot number tag
    k.fillStyle = '#efeee6';
    k.fillRect(r.x, r.y + r.h + 22, 92, 50);
    k.fillStyle = '#22272d';
    k.font = '700 36px Arial, Helvetica, sans-serif';
    k.textAlign = 'center';
    k.textBaseline = 'middle';
    k.fillText(String(i + 1), r.x + 46, r.y + r.h + 48);
    const src = jobSheets[i];
    if (!src) {
      k.strokeStyle = 'rgba(60,40,20,0.35)';
      k.setLineDash([14, 12]);
      k.lineWidth = 4;
      k.strokeRect(r.x + 4, r.y + 4, r.w - 8, r.h - 8);
      k.setLineDash([]);
      return;
    }
    const img = src.isTexture ? src.image : src;
    k.fillStyle = 'rgba(0,0,0,0.35)';
    k.fillRect(r.x + 7, r.y + 9, r.w, r.h);
    k.fillStyle = '#f4f3ee';
    k.fillRect(r.x, r.y, r.w, r.h);
    try {
      const iw = img.width || img.naturalWidth || r.w, ih = img.height || img.naturalHeight || r.h;
      const s = Math.min(r.w / iw, r.h / ih);
      const dw = iw * s, dh = ih * s;
      k.drawImage(img, r.x + (r.w - dw) / 2, r.y + (r.h - dh) / 2, dw, dh);
    } catch (err) { /* image not ready */ }
    for (const px of [r.x + 22, r.x + r.w - 22]) {
      k.fillStyle = 'rgba(0,0,0,0.3)';
      k.beginPath(); k.arc(px + 4, r.y + 24, 11, 0, Math.PI * 2); k.fill();
      k.fillStyle = '#c4161c';
      k.beginPath(); k.arc(px, r.y + 20, 11, 0, Math.PI * 2); k.fill();
      k.fillStyle = 'rgba(255,255,255,0.5)';
      k.beginPath(); k.arc(px - 3, r.y + 16, 4, 0, Math.PI * 2); k.fill();
    }
  }
  {
    const k = jbCanvas.getContext('2d');
    k.fillStyle = corkPat;
    k.fillRect(0, 0, jbCanvas.width, jbCanvas.height);
    k.fillStyle = '#22272d';
    k.fillRect(0, 0, jbCanvas.width, 110);
    k.fillStyle = '#e9b10e';
    k.font = '700 70px Arial, Helvetica, sans-serif';
    k.textAlign = 'left';
    k.textBaseline = 'middle';
    k.fillText('JOB BOARD', 40, 58);
    k.fillStyle = '#d7dce1';
    k.font = '500 46px Arial, Helvetica, sans-serif';
    k.fillText('WORK ORDERS  -  pick a drawing, collect the blank, make the part, inspect', 470, 60);
    for (let i = 0; i < jobSlotsLocal.length; i++) drawSlot(i);
  }
  const jbMat = new THREE.MeshStandardMaterial({ map: jbTex, roughness: 0.8, metalness: 0 });
  jbMat.name = 'jobBoard';
  const jobBoardMesh = new THREE.Mesh(new THREE.PlaneGeometry(JB.w, JB.h), jbMat);
  jobBoardMesh.name = 'jobBoard';
  jobBoardMesh.receiveShadow = true;
  let jobBoardInv = null;
  B.at(R.x0 + 2, 3275, HALF_PI, () => {
    const b = 'wW';
    B.box(b, C.dark, -JB.w / 2 - 20, JB.cy - JB.h / 2 - 20, 0, JB.w / 2 + 20, JB.cy + JB.h / 2 + 20, 30);
    // aluminium frame
    const fy0 = JB.cy - JB.h / 2, fy1 = JB.cy + JB.h / 2;
    B.box(b, C.steel, -JB.w / 2 - 30, fy1, 0, JB.w / 2 + 30, fy1 + 30, 48);
    B.box(b, C.steel, -JB.w / 2 - 30, fy0 - 30, 0, JB.w / 2 + 30, fy0, 48);
    B.box(b, C.steel, -JB.w / 2 - 30, fy0, 0, -JB.w / 2, fy1, 48);
    B.box(b, C.steel, JB.w / 2, fy0, 0, JB.w / 2 + 30, fy1, 48);
    B.box(b, C.steel, -700, fy0 - 60, 0, 700, fy0 - 30, 90);
    for (const x of [-300, -200]) B.cyl(b, C.blue, x, fy0 - 45 + 12, 70, 10, 120, 'x', 8);
    B.cyl(b, C.red, -60, fy0 - 45 + 12, 70, 10, 120, 'x', 8);
    // board face
    const m = B.worldMatrix(mtx(0, JB.cy, 32));
    jobBoardMesh.matrixAutoUpdate = false;
    jobBoardMesh.matrix.copy(m);
    jobBoardInv = m.clone().invert();
    anchors.jobBoardSlots = jobSlotsLocal.map((s, i) => ({
      index: i,
      position: B.worldPoint(s.x, JB.cy + s.y, 36),
      quaternion: B.worldQuat(),
      w: JB.sw, h: JB.sh,
    }));
    // interactable: visible board plane + an invisible (raycast-only) box around it
    const g = new THREE.Group();
    g.name = 'jobBoard';
    g.add(jobBoardMesh);
    hit(g, -JB.w / 2 - 40, JB.cy - JB.h / 2 - 70, -10, JB.w / 2 + 40, JB.cy + JB.h / 2 + 40, 110, B.top);
    groups.wW.add(g);
    interactables.push({ object: g, id: 'jobBoard', label: 'Read the job board' });
  });
  // banner above (on the cladding)
  decal('wW', 'bannerJobs', R.x0 + 4, 2690, 3275, 1500, 258, HALF_PI);

  // ---------- notice board, safety signs and posters (left wall, bay -4850..-1600)
  B.at(R.x0 + 2, -3225, HALF_PI, () => {
    const b = 'wW';
    B.box(b, C.trim, -620, 1280, 0, 620, 2200, 20);
    decal(b, 'noticeBoard', 0, 1740, 22, 1200, 877);
    decal(b, 'posterSpeeds', -1000, 1650, 2, 360, 504);
    decal(b, 'posterTap', 1000, 1650, 2, 360, 504);
    const signs = ['signGlasses', 'signEars', 'signBoots', 'signGloves'];
    signs.forEach((s, i) => decal(b, s, -540 + i * 360, 2700, 2, 300, 412));
    decal(b, 'calendar', 1000, 1050 + 50, 2, 200, 277);
  });

  // ---------- INSPECTION BENCH (left wall, bay -1600..1650)
  B.at(R.x0, 25, HALF_PI, () => {
    const b = 'int';
    const TOP = 850;
    // steel frame bench with grey laminate top
    for (const x of [-1260, 1260]) for (const z of [60, 840]) B.box(b, C.dark, x - 30, 0, z - 30, x + 30, TOP - 40, z + 30);
    B.box(b, C.dark, -1290, 120, 40, 1290, 160, 860);
    B.box(b, P(0x8e959b), -1300, TOP - 40, 0, 1300, TOP, 900);
    B.box(b, C.steel, -1300, TOP - 40, 898, 1300, TOP, 904);
    // drawer pedestal on the right
    B.box(b, C.office, 700, 170, 80, 1200, TOP - 45, 860);
    for (let k = 0; k < 4; k++) {
      const y0 = 190 + k * 155;
      B.box(b, P(0xa8acaf), 712, y0, 860, 1188, y0 + 145, 868);
      B.box(b, C.chrome, 880, y0 + 112, 868, 1020, y0 + 122, 885);
    }
    // granite surface plate on a low steel sub-frame (top y = 1000)
    B.box(b, C.darker, -830, TOP, 160, 130, TOP + 20, 740);
    B.box(b, M.granite, -850, TOP + 20, 135, 150, 1000, 765);
    // wooden micrometer cabinet at the back left
    B.box(b, M.wood, -1270, TOP, 30, -900, TOP + 460, 230);
    B.box(b, P(0x6a4a2c), -1265, TOP + 30, 230, -905, TOP + 430, 236);
    for (let k = 0; k < 5; k++) B.box(b, C.brass, -1110, TOP + 70 + k * 80, 236, -1060, TOP + 80 + k * 80, 246);
    // instrument tray: dark foam inlay in a wooden frame (instruments supplied by measuring.js)
    B.box(b, M.wood, 290, TOP, 220, 1270, TOP + 40, 780);
    B.box(b, C.foam, 310, TOP + 40, 240, 1250, TOP + 41, 760);
    // magnifier lamp: clamp at the back left, arm reaching over the left end of the plate
    B.box(b, C.dark, -900, TOP, 20, -820, TOP + 80, 120);
    B.rod(b, C.white, new THREE.Vector3(-860, TOP + 80, 70), new THREE.Vector3(-860, TOP + 600, 120), 12);
    B.rod(b, C.white, new THREE.Vector3(-860, TOP + 600, 120), new THREE.Vector3(-780, TOP + 560, 380), 12);
    B.torus(b, C.white, -760, TOP + 540, 430, 95, 18, 'y', 24);
    B.cyl(b, P(0xcfe3f0), -760, TOP + 540, 430, 80, 4, 'y', 24);
    B.torus(b, C.lampGlow, -760, TOP + 524, 430, 92, 8, 'y', 24);
    // labels + posters on the wall
    decal('wW', 'bannerQC', 0, 2690, 4, 1500, 258);
    drop('wW', 450);
    decal('wW', 'posterFits', -700, 1650, 4, 330, 462);
    decal('wW', 'signGlasses', 650, 1700, 4, 250, 344);
    B.collide(-1300, 0, 1300, 905);
    anchors.inspectionPlate = B.worldPoint(-350, 1000, 450);
    // instrument slots: frame X runs along the tray (to the user's right), Y up, Z toward the user
    const q = B.worldQuat();
    const slot = (id, x, y, z) => ({ id, position: B.worldPoint(x, y, z), quaternion: q.clone() });
    anchors.instrumentSlots = [
      slot('caliper', 560, TOP + 41, 380),
      slot('boreGauge', 1000, TOP + 41, 380),
      slot('micrometer', 450, TOP + 41, 630),
      slot('depthMic', 760, TOP + 41, 630),
      slot('dialIndicator', 1080, TOP + 41, 630),
      slot('heightGauge', -760, 1000, 240),
    ];
    anchors.inspectionCamera = { eye: B.worldPoint(-250, 1550, 1400), target: B.worldPoint(-250, 960, 450) };
    const g = new THREE.Group();
    g.name = 'inspection';
    hit(g, -1310, 0, -5, 1310, TOP, 910, B.top);
    hit(g, -860, TOP, 125, 160, 1002, 775, B.top);
    hit(g, -1280, TOP, 20, -890, TOP + 470, 250, B.top);
    groups.int.add(g);
    interactables.push({ object: g, id: 'inspection', label: 'Use the inspection bench' });
  });

  // ---------- PC / CAM DESK (left wall, bay 4900..7850)
  const scrCanvas = camScreenCanvas();
  const scrTex = canvasTex(scrCanvas, { repeat: false, aniso: 4 });
  const screenMesh = new THREE.Mesh(new THREE.PlaneGeometry(576, 360), new THREE.MeshBasicMaterial({ map: scrTex, toneMapped: false }));
  screenMesh.name = 'pcScreen';
  B.at(R.x0, 6050, HALF_PI, () => {
    const b = 'int';
    const TOP = 740;
    // desk: light grey frame + laminate top
    for (const x of [-760, 760]) {
      B.box(b, C.dark, x - 30, 0, 60, x + 30, TOP - 30, 120);
      B.box(b, C.dark, x - 30, 0, 680, x + 30, TOP - 30, 740);
      B.box(b, C.dark, x - 30, 0, 60, x + 30, 40, 740);
    }
    B.box(b, C.dark, -760, TOP - 90, 80, 760, TOP - 30, 100);
    B.box(b, P(0xd0d0cc), -800, TOP - 30, 0, 800, TOP, 800);
    B.box(b, C.darker, -800, TOP - 30, 798, 800, TOP, 802);
    // monitor
    B.box(b, C.black, -40, TOP, 150, 40, TOP + 250, 190);
    B.box(b, C.black, -150, TOP, 100, 150, TOP + 12, 300);
    B.box(b, C.black, -305, TOP + 200, 185, 305, TOP + 590, 225);
    B.box(b, C.led, 270, TOP + 212, 226, 280, TOP + 218, 227);
    // second (portrait-ish) monitor showing the drawing
    B.box(b, C.black, 420, TOP, 190, 480, TOP + 220, 220);
    B.box(b, C.black, 330, TOP, 140, 570, TOP + 10, 300);
    B.add(b, C.black, tBox(), mtx(450, TOP + 400, 240, 460, 300, 30, 0, -0.35, 0));
    B.plane(b, M.decal, 450 - Math.sin(0.35) * 16, TOP + 400, 240 + Math.cos(0.35) * 16, 420, 260, -0.35, 0, A.drawing1);
    // keyboard, mouse, mug, paper stack
    B.box(b, C.black, -230, TOP, 380, 230, TOP + 18, 540);
    decal(b, 'keyboard', 0, TOP + 19, 460, 440, 145, 0, -HALF_PI);
    B.box(b, C.black, 300, TOP, 440, 360, TOP + 30, 530);
    B.cyl(b, C.white, -560, TOP + 55, 450, 45, 110, 'y', 14);
    B.box(b, C.paper, -720, TOP, 200, -420, TOP + 25, 420);
    // PC tower under the desk
    B.box(b, C.black, 450, 0, 100, 650, 470, 560);
    B.box(b, C.led, 520, 430, 561, 580, 436, 562);
    // office chair (not a collider)
    B.at(80, 1120, 0.25, () => {
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2;
        B.boxC(b, C.darker, Math.cos(a) * 160, 70, Math.sin(a) * 160, 330, 30, 40, 0, -a, 0);
        B.cyl(b, C.black, Math.cos(a) * 310, 30, Math.sin(a) * 310, 30, 40, 'x', 10);
      }
      B.cyl(b, C.chrome, 0, 260, 0, 28, 360, 'y', 12);
      B.box(b, C.black, -250, 440, -240, 250, 520, 240);
      B.add(b, C.black, tBox(), mtx(0, 800, 260, 460, 520, 70, -0.12, 0, 0));
      B.box(b, C.darker, -30, 440, 230, 30, 600, 270);
    });
    // wall: banner + poster
    decal('wW', 'bannerCam', 0, 2690, 4, 1500, 258);
    drop('wW', -400);
    decal('wW', 'posterLean', -1020, 1550, 4, 300, 420);
    const m = B.worldMatrix(mtx(0, TOP + 395, 226.5));
    screenMesh.matrixAutoUpdate = false;
    screenMesh.matrix.copy(m);
    B.collide(-800, 0, 800, 805);
    const g = new THREE.Group();
    g.name = 'pcDesk';
    g.add(screenMesh);
    hit(g, -810, 0, -5, 810, TOP + 620, 810, B.top);
    groups.int.add(g);
    interactables.push({ object: g, id: 'pcDesk', label: 'Use the CAM computer' });
  });
  anchors.pcScreen = { mesh: screenMesh, w: 576, h: 360 };

  // ---------- DRAWING DESK / PLAN CHEST (front wall, left corner)
  B.at(-6550, R.z1, Math.PI, () => {
    const b = 'int';
    // plan chest (local +X = world -X)
    B.box(b, C.plan, -680, 60, 30, 680, 820, 1000);
    B.box(b, C.darker, -660, 0, 60, 660, 60, 980);
    for (let k = 0; k < 6; k++) {
      const y0 = 80 + k * 122;
      B.box(b, P(0x7d8893), -665, y0, 1000, 665, y0 + 112, 1008);
      B.box(b, C.chrome, -200, y0 + 70, 1008, 200, y0 + 80, 1024);
      B.box(b, C.paper, -60, y0 + 30, 1008, 60, y0 + 55, 1010);
    }
    B.box(b, M.wood, -700, 820, 10, 700, 850, 1020);
    // sheets lying on the top
    B.plane(b, M.decal, -260, 851, 520, 560, 400, 0.12, -HALF_PI, A.drawing2);
    B.plane(b, M.decal, 300, 852, 560, 560, 400, -0.2, -HALF_PI, A.drawing3);
    B.plane(b, M.decal, 80, 853, 380, 560, 400, 0.05, -HALF_PI, A.drawing1);
    // inclined drawing board on a stand behind
    B.add(b, C.white, tBox(), mtx(0, 1180, 220, 1100, 700, 25, -0.35, 0, 0));
    B.plane(b, M.decal, 0, 1180 + Math.sin(0.35) * 14, 220 + Math.cos(0.35) * 14, 840, 600, 0, -0.35, A.drawing2);
    B.box(b, C.dark, -520, 850, 120, -480, 1050, 160);
    B.box(b, C.dark, 480, 850, 120, 520, 1050, 160);
    // drawing lamp
    B.cyl(b, C.dark, 560, 860, 700, 70, 20, 'y', 14);
    B.rod(b, C.dark, new THREE.Vector3(560, 870, 700), new THREE.Vector3(600, 1250, 620), 8);
    B.rod(b, C.dark, new THREE.Vector3(600, 1250, 620), new THREE.Vector3(420, 1300, 760), 8);
    B.cyl(b, C.dark, 400, 1260, 780, 90, 110, 'y', 14, 0.45, true);
    B.cyl(b, C.lampGlow, 400, 1208, 780, 85, 4, 'y', 14);
    B.collide(-700, 0, 700, 1025);
    const g = new THREE.Group();
    g.name = 'drawingDesk';
    hit(g, -710, 0, 0, 710, 1550, 1030, B.top);
    groups.int.add(g);
    interactables.push({ object: g, id: 'drawingDesk', label: 'Look at the drawings' });
    decal('wS', 'calendar', -950, 1500, 4, 220, 304);
  });

  // ---------- personnel door, exit, fire point, first aid (front wall)
  B.at(-4200, R.z1, Math.PI, () => {
    const b = 'wS';
    B.box(b, C.dark, -600, 0, 0, 600, 2250, 40);
    B.box(b, C.door, -520, 10, 40, 520, 2170, 70);
    B.box(b, C.chrome, -380, 1000, 70, 380, 1040, 120);
    B.box(b, C.chrome, -400, 1000, 70, -370, 1040, 120);
    B.box(b, C.chrome, 370, 1000, 70, 400, 1040, 120);
    B.plane(b, C.sky, 0, 1650, 71, 300, 500);
    decal(b, 'signExit', 0, 2450, 4, 600, 214);
    // fire point to the right (world -X side)
    decal(b, 'signFire', -1300, 2000, 4, 520, 186);
    for (const x of [-1450, -1150]) {
      B.box(b, C.dark, x - 60, 1150, 0, x + 60, 1200, 120);
      B.cyl(b, C.red, x, 900, 120, 85, 520, 'y', 14);
      B.sphere(b, C.red, x, 1160, 120, 84, 12);
      B.box(b, C.darker, x - 25, 1170, 100, x + 25, 1280, 140);
      B.box(b, C.white, x - 60, 820, 202, x + 60, 960, 205);
    }
    // first aid box to the left (world +X side)
    B.box(b, C.white, 1100, 1350, 0, 1500, 1750, 150);
    decal(b, 'firstAidBox', 1300, 1550, 151, 400, 400);
    decal(b, 'signFirstAid', 1300, 1960, 4, 480, 171);
    decal(b, 'signGlasses', 1760, 1700, 4, 260, 357);
    decal(b, 'signEars', 2060, 1700, 4, 260, 357);
    B.collide(-1600, 0, -1000, 260);
  });

  // ---------- roller shutter door (front wall, x 2600..6400)
  B.at(4500, R.z1, Math.PI, () => {
    const b = 'wS';
    B.plane(b, M.shutter, 0, 2150, 30, 3800, 4300);
    B.box(b, C.darkSteel, -1900, 0, 20, 1900, 60, 60);
    for (const x of [-1950, 1950]) {
      B.box(b, C.trim, x - 70, 0, 0, x + 70, 4500, 120);
      B.add(b, M.hazard, tPlane(), mtx(x, 600, 121, 1200, 140, 1, 0, 0, HALF_PI), [0, 0, 1200 / 420, 1]);
    }
    B.box(b, C.trim, -2050, 4300, 0, 2050, 4850, 520);
    B.box(b, C.dark, 2100, 1200, 0, 2300, 1500, 110);
    B.box(b, C.green, 2160, 1380, 110, 2240, 1440, 120);
    B.box(b, C.red, 2160, 1260, 110, 2240, 1320, 120);
  });
  // bollards protecting the door posts
  for (const x of [2350, 6650]) {
    B.cyl('int', C.yellow, x, 500, 7700, 70, 1000, 'y', 14);
    B.cyl('int', C.darker, x, 760, 7700, 72, 80, 'y', 14);
    B.colliders.push({ minX: x - 70, maxX: x + 70, minZ: 7630, maxZ: 7770 });
  }
  decal('wS', 'bannerShop', 0, 4200, R.z1 - 4, 3000, 516, Math.PI);

  // ---------- STOCK RACK (right wall, bay -1600..1650)
  const STOCK = {
    aluminium: { raw: 0xa9afb6, metalness: 0.92, roughness: 0.36 },
    steel: { raw: 0x55595e, metalness: 0.9, roughness: 0.42 },
    brass: { raw: 0xb08a3e, metalness: 0.95, roughness: 0.3 },
    plastic: { raw: 0xd6d2c6, metalness: 0, roughness: 0.55 },
  };
  const rackDeco = { aluminium: [], steel: [], brass: [], plastic: [] };
  const rackSlotLocal = [];
  let rackFrame = null;
  B.at(R.x1, 25, -HALF_PI, () => {
    const b = 'int';
    rackFrame = B.top.clone();
    const LV = [150, 650, 1150, 1650, 2080];
    for (const x of [-1300, 0, 1300]) for (const z of [70, 630]) B.box(b, C.blue, x - 40, 0, z - 40, x + 40, 2200, z + 40);
    for (const x of [-1300, 0, 1300]) for (let y = 300; y < 2100; y += 400) B.rod(b, C.blue, new THREE.Vector3(x, y, 100), new THREE.Vector3(x, y + 380, 600), 10, 6);
    for (const y of LV) {
      for (const z of [70, 630]) B.box(b, C.orange, -1300, y - 50, z - 30, 1300, y + 50, z + 30);
      B.box(b, C.galv, -1300, y + 50, 40, 1300, y + 70, 660);
    }
    // slots on the three upper levels, front half of the shelf
    for (const y of [LV[1], LV[2], LV[3]]) for (const x of [-975, -325, 325, 975]) rackSlotLocal.push({ x, y: y + 70, z: 470 });
    // decorative stock on the back half + bottom shelf
    const r = rng(77);
    const deco = (mat, x, y, z, lx, ly, lz) => rackDeco[mat].push(mtx(x, y + ly / 2, z, lx, ly, lz));
    const mats = ['aluminium', 'steel', 'brass', 'plastic'];
    for (let li = 1; li < 4; li++) {
      const y = LV[li] + 70;
      for (let bay = 0; bay < 2; bay++) {
        let x = -1260 + bay * 1300;
        const mat = mats[(li + bay * 2) % 4];
        while (x < -80 + bay * 1300) {
          const lx = 60 + Math.floor(r() * 4) * 30, ly = 20 + Math.floor(r() * 4) * 15, lz = 140 + Math.floor(r() * 3) * 40;
          if (x + lx > -60 + bay * 1300) break;
          deco(mat, x + lx / 2, y, 170, lx, ly, lz);
          if (r() < 0.5) deco(mat, x + lx / 2, y + ly, 170, lx * 0.9, ly, lz * 0.9);
          x += lx + 25;
        }
      }
    }
    // bottom shelf: heavy blocks and plate offcuts
    const y0 = LV[0] + 70;
    deco('steel', -1000, y0, 330, 300, 120, 400);
    deco('steel', -620, y0, 330, 260, 80, 380);
    deco('aluminium', -250, y0, 330, 350, 100, 420);
    deco('aluminium', 230, y0, 330, 420, 60, 460);
    deco('brass', 600, y0, 330, 160, 90, 200);
    deco('plastic', 950, y0, 330, 380, 70, 420);
    deco('plastic', 950, y0 + 70, 330, 300, 50, 360);
    // round bars lying on top of the rack
    for (let k = 0; k < 9; k++) {
      const rr = 18 + (k % 3) * 12;
      const col = [0xa9afb6, 0x55595e, 0xb08a3e][k % 3];
      B.cyl(b, MT(col), -150 + (k % 4) * 40, 2150 + rr, 110 + k * 55, rr, 2400, 'x', 12);
    }
    // material sections labels
    decal('wE', 'bannerStock', 0, 2690, 4, 1500, 258);
    B.collide(-1340, 0, 1340, 670);
    const g = new THREE.Group();
    g.name = 'stockRack';
    hit(g, -1350, 0, 0, 1350, 2240, 690, B.top);
    groups.int.add(g);
    interactables.push({ object: g, id: 'stockRack', label: 'Take a blank from the stock rack' });
  });
  // instanced blocks per material: decorative ones first, then one per slot (hidden until set)
  const box1 = new THREE.BoxGeometry(1, 1, 1);
  const blankMeshes = {};
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (const [k, s] of Object.entries(STOCK)) {
    const m = new THREE.MeshStandardMaterial({ color: s.raw, metalness: s.metalness, roughness: s.roughness });
    m.name = 'stock-' + k;
    const n = rackDeco[k].length + rackSlotLocal.length;
    const im = new THREE.InstancedMesh(box1, m, n);
    im.name = 'ws-stock-' + k;
    rackDeco[k].forEach((lm, i) => im.setMatrixAt(i, rackFrame.clone().multiply(lm)));
    for (let i = 0; i < rackSlotLocal.length; i++) im.setMatrixAt(rackDeco[k].length + i, zero);
    im.userData.base = rackDeco[k].length;
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    im.receiveShadow = true;
    dyn.add(im);
    blankMeshes[k] = im;
  }
  anchors.stockRackSlots = rackSlotLocal.map((s, i) => ({ index: i, position: new THREE.Vector3(s.x, s.y, s.z).applyMatrix4(rackFrame) }));
  // shelf-edge tags for the slots (one canvas, one mesh)
  const tagCanvas = makeCanvas(1024, 192);
  const tagTex = canvasTex(tagCanvas, { repeat: false, aniso: 4 });
  const tagGeoParts = [];
  const drawTag = (i, text) => {
    const k = tagCanvas.getContext('2d');
    const x = (i % 4) * 256, y = Math.floor(i / 4) * 64;
    k.fillStyle = text ? '#f4f3ea' : '#c9ccd0';
    k.fillRect(x + 2, y + 2, 252, 60);
    k.fillStyle = '#22272d';
    k.textAlign = 'center';
    k.textBaseline = 'middle';
    let s = 30;
    const str = text || `SLOT ${i + 1}`;
    do { k.font = `700 ${s}px Arial, Helvetica, sans-serif`; s--; } while (k.measureText(str).width > 236 && s > 10);
    k.fillText(str, x + 128, y + 33);
    tagTex.needsUpdate = true;
  };
  for (let i = 0; i < rackSlotLocal.length; i++) {
    drawTag(i, null);
    const s = rackSlotLocal[i];
    const pg = new THREE.PlaneGeometry(240, 58);
    const u0 = (i % 4) / 4, v1 = 1 - Math.floor(i / 4) / 3;
    const uv = pg.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, u0 + uv.getX(k) * 0.25, v1 - (1 - uv.getY(k)) / 3);
    pg.applyMatrix4(rackFrame.clone().multiply(mtx(s.x, s.y - 70, 661)));
    tagGeoParts.push(pg);
  }
  {
    const merged = mergePlanes(tagGeoParts);
    const tm = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ map: tagTex, roughness: 0.7 }));
    tm.name = 'ws-rack-tags';
    dyn.add(tm);
  }
  const _bq = new THREE.Quaternion();
  rackFrame.decompose(new THREE.Vector3(), _bq, new THREE.Vector3());
  const slotState = new Array(rackSlotLocal.length).fill(null);
  function setRackBlank(i, spec) {
    if (i < 0 || i >= rackSlotLocal.length) return;
    const prev = slotState[i];
    if (prev && blankMeshes[prev]) {
      const im = blankMeshes[prev];
      im.setMatrixAt(im.userData.base + i, zero);
      im.instanceMatrix.needsUpdate = true;
    }
    slotState[i] = null;
    if (!spec) { drawTag(i, null); return; }
    const key = STOCK[spec.material] ? spec.material : 'aluminium';
    const im = blankMeshes[key];
    const p = anchors.stockRackSlots[i].position;
    // blank X along the shelf, Y (width) into the shelf, Z up
    const sx = Math.max(1, spec.x || 100), sy = Math.max(1, spec.y || 60), sz = Math.max(1, spec.z || 20);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y + sz / 2, p.z), _bq, new THREE.Vector3(sx, sz, sy));
    im.setMatrixAt(im.userData.base + i, m);
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    slotState[i] = key;
    drawTag(i, spec.label ?? `${Math.round(sx)}x${Math.round(sy)}x${Math.round(sz)} ${key.slice(0, 3).toUpperCase()}`);
  }

  // ---------- BANDSAW (right wall, bay 1650..4900)
  B.at(R.x1, 3375, -HALF_PI, () => {
    const b = 'int';
    B.box(b, C.sawBlue, -650, 80, 320, 650, 680, 900);
    B.box(b, C.darker, -620, 0, 340, 620, 80, 880);
    B.box(b, C.darkSteel, -700, 680, 300, 700, 720, 930);
    // vice
    B.box(b, C.darkSteel, -200, 720, 420, -120, 860, 820);
    B.box(b, C.darkSteel, 120, 720, 420, 200, 860, 820);
    B.cyl(b, C.darkSteel, 400, 790, 620, 18, 500, 'x', 8);
    B.cyl(b, C.chrome, 660, 790, 620, 40, 30, 'x', 14);
    // saw bow (pivots at the right) with wheel covers and blade guard
    B.at(0, 0, 0, () => {
      B.add(b, C.sawYellow, tBox(), mtx(0, 1150, 560, 1500, 220, 140, 0, 0, -0.06));
      B.cyl(b, C.sawYellow, -700, 1060, 600, 260, 160, 'z', 24);
      B.cyl(b, C.sawYellow, 700, 1150, 600, 260, 160, 'z', 24);
      B.box(b, C.darkSteel, -450, 860, 590, 450, 1040, 630);
      B.box(b, C.chrome, -440, 880, 632, 440, 890, 634);
      B.cyl(b, C.dark, 820, 1400, 470, 120, 280, 'z', 16);
      B.rod(b, C.chrome, new THREE.Vector3(-640, 760, 700), new THREE.Vector3(-640, 980, 700), 15);
    });
    // infeed roller stand
    for (const x of [-1500, -900]) {
      B.box(b, C.dark, x - 25, 0, 420, x + 25, 700, 470);
      B.box(b, C.dark, x - 25, 0, 770, x + 25, 700, 820);
    }
    B.box(b, C.dark, -1520, 680, 420, -680, 700, 820);
    for (let x = -1450; x <= -750; x += 140) B.cyl(b, C.chrome, x, 720, 620, 28, 380, 'z', 12);
    // stock in the saw
    B.cyl(b, MT(0xa9afb6), -900, 790, 620, 40, 1700, 'x', 14);
    // coolant tray + offcut bin
    B.box(b, C.dark, 900, 0, 380, 1300, 300, 820);
    for (let k = 0; k < 6; k++) B.cyl(b, MT([0xa9afb6, 0x55595e, 0xb08a3e][k % 3]), 960 + k * 50, 320, 600, 25, 120 + k * 20, 'y', 10);
    decal('wE', 'bannerSaw', 0, 2690, 4, 1500, 258);
    drop('wE', 300);
    decal('wE', 'signGlasses', 1000, 1650, 4, 260, 357);
    decal('wE', 'signEars', -1000, 1650, 4, 260, 357);
    B.collide(-1560, 280, 1320, 960);
  });

  // ---------- pallet with plates/blocks, wheelie bins, broom (right wall, front bay)
  B.at(6700, 5850, 0, () => {
    const b = 'int';
    for (const z of [-480, -50, 380]) B.box(b, M.wood, -600, 0, z, 600, 100, z + 100);
    for (let k = 0; k < 7; k++) B.box(b, M.wood, -600 + k * 183, 100, -500, -600 + k * 183 + 130, 122, 500);
    B.box(b, MT(0x55595e), -520, 122, -420, 520, 182, 420);
    B.box(b, MT(0x55595e), -480, 182, -380, 300, 302, 100);
    B.box(b, MT(0xa9afb6), -420, 182, 150, 450, 262, 400);
    B.box(b, MT(0xa9afb6), 340, 182, -380, 500, 342, -100);
    B.collide(-610, -510, 610, 510);
  });
  const bin = (x, z, col, ry) => B.at(x, z, ry, () => {
    const b = 'int';
    B.add(b, P(col), tBox(), mtx(0, 520, 0, 560, 950, 700));
    B.box(b, P(col), -300, 995, -370, 300, 1035, 370);
    B.box(b, C.darker, -260, 920, -380, 260, 960, -330);
    for (const x2 of [-230, 230]) B.cyl(b, C.black, x2, 100, -300, 100, 60, 'x', 14);
    B.collide(-300, -380, 300, 370);
  });
  bin(7050, 6750, 0x2f6b3a, -HALF_PI);
  bin(7050, 7330, 0x2856a0, -HALF_PI);
  B.rod('int', M.wood, new THREE.Vector3(7350, 20, 6250), new THREE.Vector3(7470, 1400, 6200), 14, 8);
  B.add('int', C.red, tBox(), mtx(7340, 60, 6250, 60, 90, 420, 0, 0, -0.085));

  // ---------- galvanised shelving with boxes (right wall, bay -4850..-1600)
  B.at(R.x1, -3225, -HALF_PI, () => {
    const b = 'int';
    const r = rng(5);
    for (const ux of [-1080, 60]) {
      for (const x of [ux, ux + 1000]) for (const z of [60, 560]) B.box(b, C.galv, x - 20, 0, z - 20, x + 20, 2000, z + 20);
      for (const y of [120, 560, 1000, 1440, 1880]) {
        B.box(b, C.galv, ux, y, 40, ux + 1000, y + 25, 580);
        let x = ux + 30;
        while (x < ux + 900) {
          const w = 220 + Math.floor(r() * 3) * 70, h = 160 + Math.floor(r() * 3) * 70, d = 380;
          if (x + w > ux + 980) break;
          if (y < 1880 || r() < 0.6) {
            if (r() < 0.35) {
              const col = [0x2856a0, 0xb3201c, 0xd9a514][Math.floor(r() * 3)];
              B.box(b, P(col), x, y + 25, 560 - d, x + w, y + 25 + 150, 560);
              B.box(b, P(col), x + 20, y + 175, 560 - d + 20, x + w - 20, y + 178, 560 - 20);
            } else {
              B.box(b, C.card, x, y + 25, 560 - d, x + w, y + 25 + h, 560);
              if (w >= 290) B.plane(b, M.decal, x + w / 2, y + 25 + h / 2, 561, 160, 96, 0, 0, A.boxLabel);
            }
          }
          x += w + 20;
        }
      }
    }
    B.collide(-1110, 30, 1090, 590);
  });

  // ---------- coolant drums on a spill pallet (back right corner)
  B.at(5700, -4550, 0, () => {
    const b = 'int';
    B.box(b, C.yellow, -900, 0, -420, 900, 280, 420);
    B.box(b, C.darker, -880, 280, -400, 880, 290, 400);
    for (const [x, z] of [[-560, -100], [0, -100], [560, -100]]) {
      B.cyl(b, C.drum, x, 290 + 440, z, 290, 880, 'y', 24);
      for (const y of [290 + 300, 290 + 590]) B.cyl(b, C.drum, x, y, z, 296, 30, 'y', 24);
      B.cyl(b, C.darker, x + 150, 290 + 885, z, 30, 12, 'y', 10);
      B.plane(b, M.decal, x, 290 + 440, z + 292, 220, 160, 0, 0, A.drumLabel);
    }
    B.rod(b, C.chrome, new THREE.Vector3(560 + 150, 1180, -100), new THREE.Vector3(560 + 150, 1500, -100), 18);
    B.box(b, C.dark, 560 + 80, 1400, -160, 560 + 240, 1520, -40);
    B.collide(-910, -430, 910, 430);
  });

  // ---------- surface grinder (back wall, right)
  B.at(3300, R.z0, 0, () => {
    const b = 'int';
    B.box(b, C.cream, -600, 0, 300, 600, 900, 1450);
    B.box(b, C.darker, -580, 0, 320, 580, 60, 1430);
    B.box(b, C.dark, -950, 900, 650, 950, 980, 1150);
    B.box(b, C.darkSteel, -800, 980, 680, 800, 1040, 1120);
    for (let k = 0; k < 14; k++) B.box(b, C.darker, -790 + k * 113, 1040, 690, -780 + k * 113, 1041, 1110);
    B.box(b, C.chrome, -1000, 920, 860, -950, 960, 940);
    B.box(b, C.chrome, 950, 920, 860, 1000, 960, 940);
    // column + wheel head + guard
    B.box(b, C.cream, -300, 900, 300, 300, 2200, 650);
    B.box(b, C.cream, -220, 1450, 550, 220, 1800, 1000);
    B.cyl(b, C.cream, 0, 1300, 900, 230, 140, 'x', 24);
    B.cyl(b, C.darkSteel, 0, 1300, 900, 200, 60, 'x', 24);
    B.box(b, C.cream, -160, 1800, 400, 160, 2050, 800);
    // splash guards
    B.box(b, MA(0x7f8a92), -950, 980, 640, 950, 1250, 650);
    // handwheels on the front
    B.cyl(b, C.chrome, -300, 700, 1480, 140, 30, 'z', 24);
    B.cyl(b, C.chrome, 250, 600, 1480, 110, 30, 'z', 24);
    B.cyl(b, C.darkSteel, -300, 700, 1460, 20, 60, 'z', 10);
    B.cyl(b, C.darkSteel, 250, 600, 1460, 20, 60, 'z', 10);
    decal(b, 'panelGrinder', 0, 2000, 651, 330, 203);
    decal(b, 'signRotating', -450, 700, 1451, 220, 302);
    B.collide(-1010, 280, 1010, 1520);
  });

  // ---------- manual lathe (back wall, left)
  B.at(-5700, R.z0, 0, () => {
    const b = 'int';
    const L = C.lathe;
    B.box(b, L, -1200, 0, 480, -700, 800, 1000);
    B.box(b, L, 800, 0, 480, 1200, 800, 1000);
    B.box(b, C.darkSteel, -1200, 740, 450, 1200, 800, 1080);
    B.box(b, L, -1150, 800, 580, 1150, 1050, 900);
    B.box(b, C.chrome, -1150, 1050, 610, 1150, 1075, 680);
    B.box(b, C.chrome, -1150, 1050, 800, 1150, 1075, 870);
    // headstock + gearbox
    B.box(b, L, -1200, 1050, 520, -650, 1500, 980);
    B.box(b, L, -1200, 800, 900, -650, 1050, 1010);
    decal(b, 'panelLathe', -925, 1300, 981, 360, 240);
    for (let k = 0; k < 3; k++) {
      B.rod(b, C.chrome, new THREE.Vector3(-1100 + k * 160, 940, 1010), new THREE.Vector3(-1100 + k * 160, 1000, 1080), 8);
      B.sphere(b, C.black, -1100 + k * 160, 1000, 1085, 18);
    }
    // spindle + 3-jaw chuck
    B.cyl(b, C.darkSteel, -620, 1250, 750, 140, 60, 'x', 24);
    B.cyl(b, C.steel, -540, 1250, 750, 130, 110, 'x', 24);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      B.boxC(b, C.darkSteel, -470, 1250 + Math.sin(a) * 70, 750 + Math.cos(a) * 70, 40, 30, 70, a, 0, 0);
    }
    B.cyl(b, MT(0xa9afb6), -330, 1250, 750, 30, 300, 'x', 14);
    // chuck guard
    B.box(b, MA(0xc33c2a), -640, 1430, 640, -430, 1450, 900);
    // carriage, apron, cross slide, toolpost
    B.box(b, L, -150, 1075, 560, 250, 1130, 940);
    B.box(b, L, -150, 830, 900, 250, 1075, 990);
    B.cyl(b, C.chrome, -60, 980, 1010, 110, 25, 'z', 24);
    B.cyl(b, C.darkSteel, -60, 980, 1000, 20, 40, 'z', 10);
    B.box(b, L, -80, 1130, 600, 180, 1180, 920);
    B.box(b, C.darkSteel, -20, 1180, 680, 120, 1280, 820);
    B.box(b, C.chrome, 20, 1230, 600, 50, 1250, 690);
    // tailstock
    B.box(b, L, 700, 1075, 600, 950, 1350, 900);
    B.cyl(b, C.steel, 640, 1250, 750, 40, 140, 'x', 14);
    B.cyl(b, C.chrome, 1000, 1250, 750, 90, 20, 'x', 20);
    // lead screw and feed rod
    B.cyl(b, C.chrome, 0, 880, 1030, 16, 2300, 'x', 10);
    B.cyl(b, C.chrome, 0, 940, 1030, 12, 2300, 'x', 10);
    // splash back + work light
    B.box(b, MA(0x7f8a92), -1200, 1050, 470, 1200, 1700, 490);
    B.rod(b, C.dark, new THREE.Vector3(-800, 1500, 600), new THREE.Vector3(-650, 1900, 760), 10);
    B.cyl(b, C.dark, -560, 1880, 820, 70, 120, 'y', 14, 0.5, true);
    B.cyl(b, C.lampGlow, -560, 1822, 820, 66, 4, 'y', 14);
    decal(b, 'signRotating', 400, 1400, 491, 200, 275);
    B.collide(-1220, 440, 1220, 1100);
  });
  // yellow tipping skip for swarf next to the lathe
  B.at(-3800, -4500, 0, () => {
    const b = 'int';
    B.add(b, C.yellow, tBox(), mtx(0, 520, 0, 900, 620, 650));
    B.box(b, C.darker, -460, 150, -340, 460, 210, 340);
    for (const x of [-380, 380]) for (const z of [-260, 260]) B.cyl(b, C.black, x, 70, z, 70, 50, 'x', 12);
    B.box(b, MT(0x9aa3ad), -400, 830, -280, 400, 845, 280);
    B.collide(-470, -350, 470, 350);
  });
  // pedestal drill
  B.at(-2700, R.z0, 0, () => {
    const b = 'int';
    const D = C.drill;
    B.box(b, D, -220, 0, 120, 220, 70, 680);
    B.cyl(b, C.chrome, 0, 900, 250, 50, 1660, 'y', 16);
    B.cyl(b, D, 0, 1000, 470, 190, 40, 'y', 24);
    B.box(b, D, -50, 960, 250, 50, 1020, 440);
    B.box(b, D, -170, 1500, 140, 170, 1820, 580);
    B.box(b, D, -190, 1820, 120, 190, 1960, 600);
    B.cyl(b, D, 0, 1650, 70, 120, 280, 'z', 16);
    B.cyl(b, C.chrome, 0, 1440, 470, 28, 120, 'y', 12);
    B.cyl(b, C.darkSteel, 0, 1350, 470, 30, 60, 'y', 12, 0.6);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      B.rod(b, C.chrome, new THREE.Vector3(180, 1600, 400), new THREE.Vector3(180 + 220 * Math.sin(a) * 0.3 + 60, 1600 + 220 * Math.cos(a), 400 + 220 * Math.sin(a)), 9);
    }
    B.box(b, C.red, -220, 1650, 581, -150, 1720, 600);
    B.collide(-230, 0, 230, 690);
  });
  // workbench with a bench vice, pegboard and an air hose reel
  B.at(-400, R.z0, 0, () => {
    const b = 'int';
    const TOP = 880;
    for (const x of [-1160, 1160]) for (const z of [100, 730]) B.box(b, C.dark, x - 30, 0, z - 30, x + 30, TOP - 50, z + 30);
    B.box(b, C.dark, -1190, 150, 70, 1190, 180, 760);
    B.box(b, C.galv, -1180, 180, 80, 1180, 190, 750);
    B.box(b, M.wood, -1200, TOP - 50, 50, 1200, TOP, 800);
    // vice
    B.box(b, C.dark, -950, TOP, 560, -650, TOP + 40, 760);
    B.box(b, C.lathe, -900, TOP + 40, 600, -700, TOP + 170, 690);
    B.box(b, C.lathe, -900, TOP + 40, 720, -700, TOP + 170, 780);
    B.box(b, C.darkSteel, -900, TOP + 140, 690, -700, TOP + 170, 720);
    B.cyl(b, C.chrome, -800, TOP + 110, 830, 14, 80, 'z', 8);
    B.cyl(b, C.chrome, -800, TOP + 110, 870, 10, 300, 'x', 8);
    // deburring tools, file, brush, parts tray
    for (let k = 0; k < 3; k++) {
      B.cyl(b, P([0xd9a514, 0xb3201c, 0x2b5ea8][k]), -300 + k * 80, TOP + 15, 600, 14, 110, 'z', 8);
      B.cyl(b, C.chrome, -300 + k * 80, TOP + 15, 690, 3, 80, 'z', 6);
    }
    B.box(b, C.darkSteel, 0, TOP, 520, 25, TOP + 8, 760);
    B.box(b, P(0x8b6a43), -10, TOP, 760, 35, TOP + 30, 860);
    B.box(b, C.blue, 300, TOP, 450, 640, TOP + 70, 700);
    B.box(b, C.darker, 320, TOP + 66, 470, 620, TOP + 67, 680);
    B.box(b, P(0x8b6a43), 750, TOP, 600, 980, TOP + 30, 650);
    B.box(b, MA(0x3a3a3a), 760, TOP + 30, 600, 970, TOP + 70, 650);
    // pegboard + signs on the wall
    B.box('wN', P(0xb9b09a), -1010, 1030, 0, 810, 1970, 12);
    decal('wN', 'pegboard', -100, 1500, 13, 1800, 936);
    B.box('wN', C.trim, -1020, 1010, 0, 820, 1030, 30);
    B.box('wN', C.trim, -1020, 1970, 0, 820, 1990, 30);
    decal('wN', 'signSwarf', 1050, 1650, 4, 260, 357);
    drop('wN', 900);
    // hose reel
    B.box('wN', C.dark, 1300, 1550, 0, 1500, 1850, 30);
    B.cyl('wN', C.red, 1400, 1700, 140, 230, 180, 'z', 24);
    B.cyl('wN', C.darker, 1400, 1700, 240, 160, 20, 'z', 24);
    B.rod('int', MA(0x2f5f8a), new THREE.Vector3(1400, 1480, 220), new THREE.Vector3(1420, 1050, 260), 9);
    B.cyl('int', C.chrome, 1420, 1010, 260, 14, 90, 'y', 8);
    B.collide(-1210, 0, 1210, 880);
  });
  // clock + shop banner high on the back wall above the VMC
  const CLOCK = { x: 0, y: 3500, z: R.z0 + 45, r: 230 };
  B.cyl('wN', C.darker, CLOCK.x, CLOCK.y, R.z0 + 22, CLOCK.r + 10, 44, 'z', 32);
  B.plane('wN', M.decal, CLOCK.x, CLOCK.y, R.z0 + 45, CLOCK.r * 2 - 10, CLOCK.r * 2 - 10, 0, 0, A.clock);
  decal('wN', 'bannerShop', 0, 4350, R.z0 + 4, 3000, 516);
  decal('wN', 'signRotating', -2200, 2650, R.z0 + 4, 300, 412);
  decal('wN', 'signGlasses', 2200, 2650, R.z0 + 4, 300, 412);
  decal('wN', 'signEars', 2560, 2650, R.z0 + 4, 300, 412);

  // ---------- TOOL CRIB (freestanding, left of the VMC; casts shadows)
  B.at(-3325, -1130, 0, () => {
    const b = 'near';
    // freestanding tool board behind the cabinets
    B.box(b, C.dark, -950, 0, 0, -910, 2400, 40);
    B.box(b, C.dark, 910, 0, 0, 950, 2400, 40);
    B.box(b, C.trim, -910, 1050, 0, 910, 2300, 20);
    B.plane(b, M.decal, 0, 1680, 21, 1760, 916, 0, 0, A.pegboard);
    B.plane(b, M.decal, 0, 2380, 21, 1200, 206, 0, 0, A.bannerTools);
    B.box(b, C.dark, -950, 2300, 0, 950, 2470, 20);
    for (const x of [-930, 930]) B.box(b, C.darker, x - 40, 0, -300, x + 40, 30, 340);
    // red roller cabinet + top chest
    B.box(b, C.red, -525, 110, 40, 525, 1000, 600);
    B.box(b, C.darker, -525, 1000, 40, 525, 1020, 600);
    for (let k = 0; k < 6; k++) {
      const y0 = 130 + k * 142;
      B.box(b, C.red, -505, y0, 600, 505, y0 + 132, 610);
      B.box(b, C.chrome, -440, y0 + 104, 610, 440, y0 + 116, 626);
    }
    for (const x of [-460, 460]) for (const z of [100, 540]) B.cyl(b, C.black, x, 55, z, 55, 40, 'x', 12);
    B.box(b, C.red, -500, 1020, 80, 500, 1420, 520);
    for (let k = 0; k < 3; k++) {
      const y0 = 1035 + k * 95;
      B.box(b, C.red, -485, y0, 520, 485, y0 + 85, 528);
      B.box(b, C.chrome, -300, y0 + 60, 528, 300, y0 + 68, 540);
    }
    B.box(b, C.darker, -500, 1420, 80, 500, 1440, 520);
    B.plane(b, M.decal, 0, 1300, 529, 300, 69, 0, 0, A.cabinetLabel);
    B.collide(-960, -310, 960, 620);
    // BT40 holder trolley to the right
    B.at(1050 + 350 - 300, 30, 0, () => {
      const tb = 'near';
      for (const x of [-230, 230]) for (const z of [40, 560]) B.box(tb, C.darkSteel, x - 20, 80, z - 20, x + 20, 1350, z + 20);
      for (const x of [-230, 230]) for (const z of [40, 560]) B.cyl(tb, C.black, x, 40, z, 40, 30, 'x', 10);
      const tiers = [[400, 120], [800, 120], [1200, 120]];
      for (const [y] of tiers) {
        B.box(tb, C.darkSteel, -250, y, 20, 250, y + 25, 580);
        for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) {
          const x = -150 + i * 150, z = 100 + j * 130;
          // BT40: taper down through the plate, flange, collet chuck nose, tool
          B.cyl(tb, C.steel, x, y - 25, z, 22, 70, 'y', 12, 1.4);
          B.cyl(tb, C.darkSteel, x, y + 40, z, 32, 30, 'y', 14);
          B.cyl(tb, C.steel, x, y + 80, z, 25, 50, 'y', 12, 0.8);
          const tl = 50 + ((i + j) % 3) * 30;
          B.cyl(tb, (i + j) % 2 ? C.chrome : MT(0xc8a24a), x, y + 105 + tl / 2, z, 5 + ((i * 2 + j) % 4) * 2, tl, 'y', 8);
        }
      }
      B.plane(tb, M.decal, 0, 1290, 581, 300, 69, 0, 0, A.cabinetLabel);
      B.collide(-260, 10, 260, 600);
    });
    const g = new THREE.Group();
    g.name = 'toolCrib';
    hit(g, -960, 0, -5, 960, 2480, 640, B.top);
    hit(g, 820, 0, 30, 1360, 1400, 640, B.top);
    groups.near.add(g);
    interactables.push({ object: g, id: 'toolCrib', label: 'Open the tool crib' });
  });
  // fire point stand to the left of the tool crib
  B.at(-4900, -200, 0, () => {
    const b = 'int';
    B.box(b, C.red, -350, 0, -150, 350, 30, 150);
    B.box(b, C.red, -30, 30, -30, 30, 1800, 30);
    B.plane(b, M.decal, 0, 1650, 31, 420, 150, 0, 0, A.signFire);
    for (const x of [-180, 180]) {
      B.cyl(b, C.red, x, 330, 40, 85, 520, 'y', 14);
      B.sphere(b, C.red, x, 590, 40, 84, 12);
      B.box(b, C.darker, x - 25, 600, 20, x + 25, 700, 60);
      B.box(b, C.white, x - 60, 250, 124, x + 60, 390, 127);
    }
    B.collide(-360, -160, 360, 160);
  });

  // ---------- VMC footprint colliders (machine.js geometry)
  if (PROFILE.id === 'vmc560') {
    B.colliders.push(
      { minX: -1120, maxX: 1060, minZ: -1520, maxZ: 770 }, // enclosure, rear cabinet, coolant tank
      { minX: 1050, maxX: 2010, minZ: -530, maxZ: -70 }, // chip conveyor + bin
      { minX: 760, maxX: 1220, minZ: 880, maxZ: 1080 }, // pendant arm / control panel
    );
  } else {
    B.colliders.push(
      { minX: -940, maxX: 800, minZ: -1260, maxZ: 660 }, // Mini Mill cabinet, rear cabinet, coolant tank
      { minX: 300, maxX: 860, minZ: 640, maxZ: 850 }, // integrated pendant + tray
    );
  }

  // ================================================================ emit meshes
  const tGeo = performance.now();
  B.build(groups);
  const tMerge = performance.now();
  // clock hands: one instanced mesh (hour, minute, second)
  const handMat = new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.5 });
  const hands = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), handMat, 3);
  hands.name = 'ws-clock-hands';
  groups.wN.add(hands);
  const handDims = [[14, CLOCK.r * 0.55, 6], [9, CLOCK.r * 0.8, 6], [4, CLOCK.r * 0.85, 4]];
  let lastClockSec = -1;
  const setClock = () => {
    const d = new Date();
    const s = d.getSeconds(), m = d.getMinutes() + s / 60, h = (d.getHours() % 12) + m / 60;
    const ang = [h / 12, m / 60, s / 60].map((f) => -f * Math.PI * 2);
    for (let i = 0; i < 3; i++) {
      const [w, l, t] = handDims[i];
      const a = ang[i];
      const mm = new THREE.Matrix4().compose(
        new THREE.Vector3(CLOCK.x - Math.sin(a) * l * 0.4 * 1, CLOCK.y + Math.cos(a) * l * 0.4, CLOCK.z + 4 + i * 5),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), a),
        new THREE.Vector3(w, l, t));
      // the hand extends from slightly behind the centre to its tip
      hands.setMatrixAt(i, mm);
    }
    hands.instanceMatrix.needsUpdate = true;
    hands.computeBoundingSphere();
  };
  setClock();

  // ambient fill lights (no shadows)
  const lights = new THREE.Group();
  lights.name = 'ws-lights';
  for (const [x, y, z, i] of [[-4600, 3900, 4800, 0.5], [4600, 3900, 4800, 0.45], [-4600, 3900, -2800, 0.5], [4600, 3900, -2800, 0.45], [0, 4200, 1600, 0.3]]) {
    const l = new THREE.PointLight(0xfff1e0, i, 9000, 0);
    l.position.set(x, y, z);
    l.castShadow = false;
    lights.add(l);
  }
  group.add(lights);

  // spawn: just inside the personnel door, facing the machine
  const sp = [-4300, 0, 5300];
  anchors.spawn = { pos: sp, yaw: Math.atan2(-(0 - sp[0]), -(0 - sp[2])), pitch: -0.08 };

  // camera cut-away: hide the wall(s) / roof between an outside camera and the shop
  const cutCam = new THREE.Vector3();
  function update(dt, camera = opts.camera) {
    if (camera) {
      camera.getWorldPosition(cutCam);
      const m = 60;
      groups.wW.visible = cutCam.x > R.x0 + m;
      groups.wE.visible = cutCam.x < R.x1 - m;
      groups.wN.visible = cutCam.z > R.z0 + m;
      groups.wS.visible = cutCam.z < R.z1 - m;
      const outside = !(groups.wW.visible && groups.wE.visible && groups.wN.visible && groups.wS.visible);
      groups.roof.visible = cutCam.y < roofY(cutCam.x) - 250 || (outside && cutCam.y < R.eave - 300);
      groups.truss.visible = groups.roof.visible;
    }
    const sec = Math.floor(Date.now() / 1000);
    if (sec !== lastClockSec) { lastClockSec = sec; setClock(); }
  }

  function setJobBoardSheet(i, src) {
    if (i < 0 || i >= jobSheets.length) return;
    jobSheets[i] = src || null;
    const img = src && (src.isTexture ? src.image : src);
    if (img && img.complete === false && img.addEventListener) {
      img.addEventListener('load', () => { if (jobSheets[i] === src) { drawSlot(i); jbTex.needsUpdate = true; } }, { once: true });
    }
    drawSlot(i);
    jbTex.needsUpdate = true;
  }
  // index of the job board slot under a world-space point (e.g. a raycast hit), or -1
  function jobBoardSlotAt(point) {
    const p = point.clone().applyMatrix4(jobBoardInv);
    for (let i = 0; i < jobSlotsLocal.length; i++) {
      const s = jobSlotsLocal[i];
      if (Math.abs(p.x - s.x) <= JB.sw / 2 + 20 && Math.abs(p.y - s.y) <= JB.sh / 2 + 20) return i;
    }
    return -1;
  }

  group.updateMatrixWorld(true);
  const occluders = [groups.wW, groups.wE, groups.wN, groups.wS].flatMap((g) => g.children.filter((c) => c.isMesh && !c.isInstancedMesh));
  const stats = { buildMs: Math.round(performance.now() - t0), texturesMs: Math.round(tTex - t0), propsMs: Math.round(tGeo - tTex), mergeMs: Math.round(tMerge - tGeo) };
  return {
    group, colliders: B.colliders, interactables, anchors, update, setJobBoardSheet, setRackBlank,
    jobBoardSlotAt, occluders, lights, groups, room: R, stats,
  };
}

function mergePlanes(list) {
  let n = 0;
  for (const g of list) n += g.index ? g.index.count : g.attributes.position.count;
  const P = new Float32Array(n * 3), N = new Float32Array(n * 3), U = new Float32Array(n * 2);
  let o = 0;
  for (let g of list) {
    if (g.index) g = g.toNonIndexed();
    P.set(g.attributes.position.array, o * 3);
    N.set(g.attributes.normal.array, o * 3);
    U.set(g.attributes.uv.array, o * 2);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(P, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  out.computeBoundingSphere();
  return out;
}
