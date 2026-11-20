// The vertical machining centre, built from individual components in millimetres (Three.js world:
// +X right, +Y up, +Z towards the operator). Moving assemblies:
//   saddle (Y axis, moves in Z world) -> table (X axis, moves in X world) -> workGroup (stock, vise...)
//   head (Z axis, moves in Y world)   -> rotor (spindle, rotates)          -> tool model
//   atc carriage (slides in X)        -> carousel (indexes about Y)        -> pocket tool models
// plus sliding doors, telescopic way covers, ball screws that turn with axis motion and a stack light.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MACHINE } from '../config.js';
import { labelTexture, hazardTexture } from './textures.js';
import { GROUPS as HAAS_GROUPS } from '../ui/haas/haas-keys.js';

const TT = MACHINE.tableTopY; // 930
const GAUGE0 = TT + MACHINE.gaugeAtZ0; // world Y of the gauge line at Z0 (1413)
// cabinet layout (world mm; spindle axis at x 0, z 0; operator at +Z)
const XL = -900, XR = 760, ZF = 640, ZB = -720, YR = 1900;
const CH_Y = 720, CH_B = 440, CH_XL = -500, CH_XR = 520; // chamfer start height / bottom height / bottom x
const WX0 = -300, WX1 = 330, WY0 = 900, WY1 = 1700; // front window opening
const COLZ = -400, COL_TOP = 2880; // column face z, column top
const BEACON_X = 640;
const PEND_X = 575, PEND_Y = 1330, PEND_Z = ZF + 100;
const PITCH = 10; // ball screw lead, mm/rev
// Umbrella: 10 pockets on a 240 mm pitch radius; the static drum shroud has a bite where the spindle sits.
export const ATC_GEOM = { pitchR: 240, engagedX: -240, retractedX: -470, shroudR: 285, biteR: 120, drumTop: 105, drumBottom: -66 };

export class MachineModel {
  constructor(T, opts = {}) {
    this.T = T;
    this.root = new THREE.Group();
    this.root.name = 'machine';
    this.clickables = [];
    this.coolantNozzles = []; // { obj, tip: Vector3 local to head }
    this.makeMaterials();
    this.buildFloor();
    this.base = new THREE.Group();
    this.root.add(this.base);
    this.buildBase();
    this.buildColumn();
    this.buildSaddle();
    this.buildTable();
    this.buildHead();
    this.buildATC();
    this.enclosure = new THREE.Group();
    this.enclosure.name = 'enclosure';
    this.root.add(this.enclosure);
    this.buildEnclosure();
    this.buildDoors();
    this.buildPendant();
    this.buildStackLight();
    this.buildLights();
    this.buildExtras();
    this.mergeStatic(this.base);
    this.mergeStatic(this.encStatic);
    this.mergeStatic(this.extras);
    this.root.traverse((o) => {
      if (o.isMesh && o.userData.shadow !== false) {
        o.castShadow = o.userData.cast !== false;
        o.receiveShadow = true;
      }
    });
    this.toolModels = new Map();
    this.screwAngle = { x: 0, y: 0, z: 0 };
  }

  makeMaterials() {
    const T = this.T;
    const std = (o) => new THREE.MeshStandardMaterial(o);
    this.M = {
      paint: std({ color: 0xd2d5d7, roughness: 0.55, metalness: 0.1, roughnessMap: T.paintRough, envMapIntensity: 0.7 }),
      paintLight: std({ color: 0xd5d8da, roughness: 0.5, metalness: 0.1, envMapIntensity: 0.7 }),
      charcoal: std({ color: 0x2c3035, roughness: 0.55, metalness: 0.25 }),
      steel: std({ color: 0xc9cfd4, roughness: 0.3, metalness: 0.9, roughnessMap: T.brushedRough }),
      wall: std({ color: 0xaab6c0, roughness: 0.5, metalness: 0.2 }),
      wallLow: std({ color: 0x9aa5ae, roughness: 0.45, metalness: 0.4 }),
      paintDark: std({ color: 0x2b2f34, roughness: 0.6, metalness: 0.2 }),
      accent: std({ color: 0x2f7de1, roughness: 0.42, metalness: 0.2 }),
      cast: std({ color: 0x59616a, roughness: 0.62, metalness: 0.3, map: T.castColor }),
      castDark: std({ color: 0x3c4249, roughness: 0.6, metalness: 0.3, map: T.castColor }),
      rail: std({ color: 0xcfd4d9, roughness: 0.2, metalness: 1, roughnessMap: T.brushedRough }),
      table: std({ color: 0x80878d, roughness: 0.34, metalness: 0.85, roughnessMap: T.groundRough }),
      screw: std({ color: 0xb9c0c7, roughness: 0.22, metalness: 1 }),
      black: std({ color: 0x1a1c1f, roughness: 0.48, metalness: 0.45 }),
      rubber: std({ color: 0x121315, roughness: 0.92, metalness: 0 }),
      chrome: std({ color: 0xd8dde2, roughness: 0.14, metalness: 1 }),
      interior: std({ color: 0xa3a9af, roughness: 0.42, metalness: 0.65, roughnessMap: T.brushedRough }),
      wayCover: std({ color: 0xd2d6da, roughness: 0.32, metalness: 0.9, map: T.wayCover }),
      bellows: std({ color: 0x3a3d42, roughness: 0.8, metalness: 0.1, map: T.bellows }),
      orange: std({ color: 0xe07a1f, roughness: 0.55, metalness: 0.1 }),
      blueHose: std({ color: 0x2c64b0, roughness: 0.35, metalness: 0.1 }),
      yellow: std({ color: 0xe8b21a, roughness: 0.5, metalness: 0.1 }),
      red: std({ color: 0xc8191e, roughness: 0.35, metalness: 0.1 }),
      green: std({ color: 0x1f9a4a, roughness: 0.35, metalness: 0.1 }),
      amber: std({ color: 0xe08a12, roughness: 0.35, metalness: 0.1 }),
      floor: std({ color: 0xffffff, map: T.floorColor, roughnessMap: T.floorRough, roughness: 0.92, metalness: 0 }),
      mat: std({ color: 0xffffff, map: T.mat, roughness: 0.95, metalness: 0 }),
      glass: new THREE.MeshPhysicalMaterial({
        color: 0xc6d4de, metalness: 0, roughness: 0.06, transparent: true, opacity: 0.16, envMapIntensity: 1.4,
        depthWrite: false, side: THREE.DoubleSide, clearcoat: 1, clearcoatRoughness: 0.05,
      }),
    };
    this.M.glass.userData.noShadow = true;
  }

  // ---------- helpers
  box(w, h, d, mat, x, y, z, parent, round = 0) {
    const g = round > 0 ? new RoundedBoxGeometry(w, h, d, 2, round) : new THREE.BoxGeometry(w, h, d);
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }
  // Box from min/max corners.
  bx(x0, y0, z0, x1, y1, z1, mat, parent, round = 0) {
    return this.box(x1 - x0, y1 - y0, z1 - z0, mat, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, parent, round);
  }
  cyl(r, h, mat, x, y, z, parent, axis = 'y', segs = 32, r2 = r) {
    const g = new THREE.CylinderGeometry(r, r2, h, segs);
    if (axis === 'x') g.rotateZ(Math.PI / 2);
    if (axis === 'z') g.rotateX(Math.PI / 2);
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }

  // Merges every mesh below `group` that shares a material into a single mesh (static parts only).
  mergeStatic(group) {
    group.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
    const byMat = new Map();
    const remove = [];
    group.traverse((o) => {
      if (!o.isMesh || o.userData.keep || o.material.transparent) return;
      let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
      if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((g.attributes.position.count) * 2), 2));
      g.clearGroups();
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
      if (!byMat.has(o.material)) byMat.set(o.material, []);
      byMat.get(o.material).push(g);
      remove.push(o);
    });
    for (const o of remove) {
      o.parent.remove(o);
      o.geometry.dispose();
    }
    // drop now-empty helper groups
    for (const [mat, list] of byMat) {
      const merged = mergeGeometries(list, false);
      list.forEach((g) => g.dispose());
      if (!merged) continue;
      const m = new THREE.Mesh(merged, mat);
      group.add(m);
    }
  }

  // ---------- floor and surroundings
  buildFloor() {
    const g = new THREE.Group();
    g.name = 'floor';
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(16000, 16000), this.M.floor);
    floor.rotation.x = -Math.PI / 2;
    floor.userData.cast = false;
    g.add(floor);
    const lineMat = new THREE.MeshStandardMaterial({ color: 0xe0b020, roughness: 0.7 });
    const L = (x0, z0, x1, z1) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(Math.abs(x1 - x0) || 60, Math.abs(z1 - z0) || 60), lineMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set((x0 + x1) / 2, 1, (z0 + z1) / 2);
      m.userData.cast = false;
      g.add(m);
    };
    L(-1700, -1700, 2100, -1700);
    L(-1700, 1850, -1150, 1850);
    L(1550, 1850, 2100, 1850);
    L(-1700, -1700, -1700, 1850);
    L(2100, -1700, 2100, 1850);
    const mat = new THREE.Mesh(new RoundedBoxGeometry(1500, 14, 760, 2, 6), this.M.mat);
    mat.position.set(0, 7, 1320);
    g.add(mat);
    this.root.add(g);
  }

  // ---------- base casting, Y rails and Y screw
  buildBase() {
    const B = this.base;
    const M = this.M;
    // Dark charcoal plinth the cabinet chamfers down onto, with levelling feet
    this.bx(-480, 40, ZB + 70, 500, 440, ZF - 70, M.charcoal, B, 6);
    for (const x of [-420, 440]) for (const z of [ZB + 130, ZF - 130]) this.cyl(45, 40, M.black, x, 20, z, B, 'y', 16);
    // Base casting under the saddle
    this.bx(-400, 440, -380, 400, 690, 420, M.cast, B, 14);
    this.bx(-436, 440, -390, 436, 520, 428, M.castDark, B, 10);
    // ground mounting pads and Y linear rails (run from the column foot to the base front)
    for (const x of [-250, 250]) this.bx(x - 32, 690, -384, x + 32, 700, 416, M.castDark, B);
    for (const x of [-250, 250]) {
      this.bx(x - 17, 700, -384, x + 17, 730, 416, M.rail, B);
      this.bx(x - 18, 712, -384, x + 18, 716, 416, M.castDark, B);
    }
    this.bx(-55, 690, -384, 55, 734, -356, M.cast, B, 6);
    this.bx(-55, 690, 388, 55, 732, 420, M.cast, B, 6);
    // end plate the front way cover is bolted to
    this.bx(-380, 690, 420, 380, 772, 432, M.castDark, B, 3);
    this.bx(-70, 560, ZB + 70, 70, 680, -400, M.black, B, 8);
    // Y screw (rotates)
    this.yScrew = this.makeScrew(16, 780, 'z');
    this.yScrew.position.set(0, 718, 20);
    this.yScrew.userData.keep = true;
    B.add(this.yScrew);
  }

  makeScrew(r, len, axis) {
    const g = new THREE.Group();
    const core = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.82, r * 0.82, len, 20), this.M.screw);
    g.add(core);
    // helical thread
    const turns = Math.floor(len / PITCH);
    const pts = [];
    const n = turns * 14;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const a = t * turns * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * r * 0.86, -len / 2 + t * len, Math.sin(a) * r * 0.86));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, n, r * 0.2, 5, false), this.M.screw);
    g.add(tube);
    const inner = new THREE.Group();
    inner.add(g);
    if (axis === 'x') g.rotation.z = Math.PI / 2;
    if (axis === 'z') g.rotation.x = Math.PI / 2;
    inner.userData.spin = g;
    inner.userData.axis = axis;
    g.traverse((o) => { if (o.isMesh) o.userData.keep = true; });
    return inner;
  }

  // ---------- column (dark charcoal casting that rises through the cabinet roof) with Z rails
  buildColumn() {
    const B = this.base;
    const M = this.M;
    // column casting: its face is at z = COLZ; the table never gets closer than 70 mm to it
    this.bx(-220, 600, ZB + 40, 220, COL_TOP, COLZ, M.charcoal, B, 14);
    this.bx(-300, 440, ZB + 40, 300, 700, COLZ + 20, M.castDark, B, 10);
    // Z rails on the column face and the Z ball screw (inside the casting, only the drive shows)
    for (const x of [-150, 150]) {
      this.bx(x - 16, 800, COLZ, x + 16, 2330, COLZ + 12, M.rail, B);
    }
    this.zScrew = this.makeScrew(14, 900, 'y');
    this.zScrew.position.set(0, 1500, COLZ - 30);
    B.add(this.zScrew);
    // Z servo motor on the back of the column top
    this.bx(-70, COL_TOP - 160, ZB + 20, 70, COL_TOP - 20, ZB + 50, M.black, B, 10);
    // cable carrier: a ribbed arc over the top of the column
    const chain = new THREE.Group();
    chain.position.set(0, COL_TOP, (COLZ + ZB + 40) / 2);
    const rA = (COLZ - ZB - 40) / 2 - 20;
    const n = 26;
    const link = new THREE.BoxGeometry(110, 44, 20);
    const inst = new THREE.InstancedMesh(link, M.black, n + 1);
    const mm = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI;
      e.set(a - Math.PI / 2, 0, 0);
      q.setFromEuler(e);
      mm.compose(new THREE.Vector3(0, Math.sin(a) * rA + 22, -Math.cos(a) * rA), q, new THREE.Vector3(1, 1, 1));
      inst.setMatrixAt(i, mm);
    }
    chain.add(inst);
    B.add(chain);
    this.bx(-60, COL_TOP, COLZ - 30, 60, COL_TOP + 40, COLZ - 10, M.black, B, 6);
    this.bx(-60, COL_TOP, ZB + 60, 60, COL_TOP + 40, ZB + 80, M.black, B, 6);
  }

  // ---------- saddle (Y axis)
  buildSaddle() {
    const S = new THREE.Group();
    S.name = 'saddle';
    this.saddle = S;
    this.root.add(S);
    const M = this.M;
    // Saddle casting, 400 deep: at the back of the Y travel (saddle at z -178) it stops 22 mm short of the
    // column foot, and it is 860 wide so the X rails carry the table carriages over the full X travel.
    this.bx(-430, 752, -200, 430, 846, 200, M.cast, S, 12);
    this.bx(-436, 770, -180, 436, 828, 180, M.castDark, S, 6);
    for (const x of [-250, 250]) for (const z of [-110, 110]) this.bx(x - 38, 718, z - 50, x + 38, 754, z + 50, M.rail, S, 3);
    this.bx(-55, 696, -60, 55, 752, 60, M.castDark, S, 6);
    // X rails
    for (const z of [-95, 95]) {
      this.bx(-430, 846, z - 15, 430, 872, z + 15, M.rail, S);
      this.bx(-430, 856, z - 16, 430, 860, z + 16, M.castDark, S);
    }
    this.bx(-428, 846, -28, -396, 867, 28, M.cast, S, 4);
    this.bx(396, 846, -28, 428, 867, 28, M.cast, S, 4);
    this.bx(436, 772, -52, 586, 864, 52, M.black, S, 8);
    this.bx(430, 790, -40, 438, 850, 40, M.castDark, S);
    this.cyl(9, 40, M.orange, 521, 810, 88, S, 'z', 10);
    this.xScrew = this.makeScrew(10, 820, 'x');
    this.xScrew.position.set(0, 858, 0);
    S.add(this.xScrew);
    // Telescopic steel way covers (front: saddle -> base front; rear: column -> saddle)
    this.covers = new THREE.Group();
    this.covers.name = 'covers';
    this.root.add(this.covers);
    this.frontCover = this.makeCover(6, 100, -1);
    this.rearCover = this.makeCover(5, 100, 1);
  }

  // dir: which way the cover extends from its fixed end (+1 = towards +Z).
  makeCover(n, segLen, dir) {
    const secs = [];
    for (let k = 0; k < n; k++) {
      const w = 780 - k * 12;
      const g = new THREE.Group();
      const top = new THREE.Mesh(new THREE.BoxGeometry(w, 4, segLen), this.M.wayCover);
      g.add(top);
      for (const s of [-1, 1]) {
        const side = new THREE.Mesh(new THREE.BoxGeometry(4, 42, segLen), this.M.wayCover);
        side.position.set((s * w) / 2, -21, 0);
        g.add(side);
      }
      const lip = new THREE.Mesh(new THREE.BoxGeometry(w + 4, 8, 6), this.M.paintDark);
      lip.position.set(0, 2, (dir * segLen) / 2);
      g.add(lip);
      g.userData.y = 766 - k * 5;
      this.covers.add(g);
      secs.push(g);
    }
    return { secs, segLen };
  }

  layoutCover(cover, a, b) {
    // a: fixed end (base side), b: moving end (saddle side). Sections nest from a to b.
    const { secs, segLen } = cover;
    const n = secs.length;
    const dir = Math.sign(b - a) || 1;
    const start = a + (dir * segLen) / 2, end = b - (dir * segLen) / 2;
    for (let k = 0; k < n; k++) {
      const f = n === 1 ? 0 : k / (n - 1);
      const s = secs[k];
      s.position.set(0, s.userData.y, start + (end - start) * f);
    }
  }

  // ---------- table (X axis) with T-slots; workGroup sits on the table top
  buildTable() {
    const Tg = new THREE.Group();
    Tg.name = 'table';
    this.table = Tg;
    this.saddle.add(Tg);
    const M = this.M;
    const tb = MACHINE.table;
    const shape = new THREE.Shape();
    const hw = tb.width / 2;
    const H = 52;
    const slots = [];
    for (let i = 0; i < tb.slots; i++) slots.push((i - (tb.slots - 1) / 2) * tb.slotPitch);
    shape.moveTo(-hw, 0);
    shape.lineTo(hw, 0);
    shape.lineTo(hw, H);
    const sw = tb.slotWidth / 2, cw = 13;
    for (let i = slots.length - 1; i >= 0; i--) {
      const c = slots[i];
      shape.lineTo(c + sw, H);
      shape.lineTo(c + sw, H - 13);
      shape.lineTo(c + cw, H - 13);
      shape.lineTo(c + cw, H - 27);
      shape.lineTo(c - cw, H - 27);
      shape.lineTo(c - cw, H - 13);
      shape.lineTo(c - sw, H - 13);
      shape.lineTo(c - sw, H);
    }
    shape.lineTo(-hw, H);
    shape.lineTo(-hw, 0);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: tb.length, bevelEnabled: false });
    geo.rotateY(Math.PI / 2);
    geo.translate(-tb.length / 2, TT - H, 0);
    Tg.add(new THREE.Mesh(geo, M.table));
    this.bx(-tb.length / 2 + 20, 870, -hw + 20, tb.length / 2 - 20, TT - H, hw - 20, M.cast, Tg);
    // carriages sit near the middle so they stay on the X rails (x +-430) at both ends of the travel
    for (const x of [-150, 150]) for (const z of [-95, 95]) this.bx(x - 50, 856, z - 34, x + 50, 878, z + 34, M.rail, Tg, 3);
    this.bx(-40, 849, -30, 40, 871, 30, M.castDark, Tg, 3);
    for (const s of [-1, 1]) this.bx(s * (tb.length / 2) - 4, 870, -hw, s * (tb.length / 2) + 4, TT + 4, hw, M.paintDark, Tg);
    this.workGroup = new THREE.Group();
    this.workGroup.name = 'work';
    this.workGroup.position.y = TT;
    Tg.add(this.workGroup);
  }

  // ---------- spindle head (Z axis). Origin = gauge line on the spindle axis; +Z is towards the operator.
  buildHead() {
    const H = new THREE.Group();
    H.name = 'head';
    this.head = H;
    this.root.add(H);
    const M = this.M;
    const zb = COLZ; // column face (local z)
    // Z carriages on the column rails
    for (const x of [-150, 150]) for (const y of [190, 470]) this.bx(x - 38, y, zb, x + 38, y + 110, zb + 34, M.rail, H, 3);
    // dark charcoal back plate and neck
    this.bx(-215, 130, zb + 30, 215, 700, zb + 100, M.charcoal, H, 10);
    // light grey head housing
    this.bx(-190, 125, zb + 100, 190, 372, 44, M.paintLight, H, 16);
    // charcoal upper casting that rises through the roof slot when Z is high
    this.bx(-200, 360, zb + 30, 200, 800, -70, M.charcoal, H, 14);
    // warning sticker (pictograms only) and TOOL RELEASE button on the housing front
    const stk = new THREE.Mesh(new THREE.PlaneGeometry(220, 112), new THREE.MeshStandardMaterial({ map: warningStickerTexture(), roughness: 0.6 }));
    stk.position.set(-20, 292, 44.6);
    H.add(stk);
    this.cyl(17, 10, M.chrome, 125, 195, 46, H, 'z', 20);
    const rel = this.cyl(12, 12, M.black, 125, 195, 50, H, 'z', 20);
    rel.userData.keep = true;
    // black spindle cartridge with a chrome nose
    this.cyl(98, 36, M.black, 0, 138, 0, H, 'y', 48);
    this.cyl(88, 100, M.black, 0, 62, 0, H, 'y', 48);
    this.cyl(66, 14, M.chrome, 0, 8, 0, H, 'y', 48);
    this.cyl(10, 8, M.orange, -64, 60, 70, H, 'y', 10); // small cartridge fitting
    // rotor (rotates) - spindle face with drive keys; tool models are added to it
    this.rotor = new THREE.Group();
    this.rotor.name = 'rotor';
    H.add(this.rotor);
    const face = new THREE.Mesh(new THREE.CylinderGeometry(58, 58, 4, 40), M.chrome);
    face.position.y = -1;
    this.rotor.add(face);
    for (const s of [-1, 1]) this.bx(s * 46 - 7, -6, -8, s * 46 + 7, 0, 8, M.castDark, this.rotor);
    // steel cover on the column face that moves with Z
    const plate = this.bx(-195, -360, zb - 4, 195, 130, zb + 4 + 24, M.steel, H);
    plate.userData.keep = true;
    for (const x of [-175, 175]) for (const y of [-340, -150, 20]) {
      this.cyl(5, 4, M.black, x, y, zb + 29, H, 'z', 8);
    }
    // Loc-Line coolant hoses aimed at the cutter, on the +X side away from the tool changer
    const mm = new THREE.Matrix4();
    const segGeo = new THREE.SphereGeometry(6.5, 10, 8);
    const coneGeo = new THREE.CylinderGeometry(3, 6, 18, 10);
    coneGeo.translate(0, -9, 0);
    for (const a of [-Math.PI * 0.3, Math.PI * 0.05, Math.PI * 0.32]) {
      const start = new THREE.Vector3(Math.cos(a) * 92, 42, Math.sin(a) * 92);
      const mid = new THREE.Vector3(Math.cos(a) * 110, -10, Math.sin(a) * 110);
      const end = new THREE.Vector3(Math.cos(a) * 62, -58, Math.sin(a) * 62);
      const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
      const n = 11;
      const inst = new THREE.InstancedMesh(segGeo, M.blueHose, n);
      for (let i = 0; i < n; i++) {
        const p = curve.getPoint(i / (n - 1));
        mm.makeTranslation(p.x, p.y, p.z);
        inst.setMatrixAt(i, mm);
      }
      H.add(inst);
      const tipDir = curve.getTangent(1).normalize();
      const nozzle = new THREE.Mesh(coneGeo, M.orange);
      nozzle.position.copy(end);
      nozzle.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), tipDir);
      H.add(nozzle);
      const tip = end.clone().addScaledVector(tipDir, 18);
      this.coolantNozzles.push({ tip, dir: tipDir });
    }
  }

  // ---------- enclosed umbrella tool changer on the left of the spindle (10 pockets, 36 degrees apart)
  buildATC() {
    const M = this.M;
    const R = ATC_GEOM.pitchR;
    const A = new THREE.Group();
    A.name = 'atc';
    this.root.add(A);
    // fixed shuttle rail housing bolted to the column face, beside the head
    this.bx(-760, GAUGE0 + 90, COLZ, -170, GAUGE0 + 250, COLZ + 60, M.black, A, 6);
    this.bx(-760, GAUGE0 + 120, COLZ + 60, -170, GAUGE0 + 140, COLZ + 90, M.rail, A);
    // carriage + carousel move together (slide along X)
    this.atcSlide = new THREE.Group();
    A.add(this.atcSlide);
    this.bx(-250, GAUGE0 + 80, COLZ + 20, 100, GAUGE0 + 290, COLZ + 160, M.black, this.atcSlide, 8); // dark shuttle block
    for (const x of [-170, 20]) this.cyl(16, 30, M.chrome, x, GAUGE0 + 230, COLZ + 172, this.atcSlide, 'z', 14);
    this.carousel = new THREE.Group();
    this.carousel.position.y = GAUGE0;
    this.atcSlide.add(this.carousel);
    // Static drum shroud (does not index): a cylinder with a bite taken out where the spindle sits.
    const RS = ATC_GEOM.shroudR, RB = ATC_GEOM.biteR;
    const cosP = (RS * RS + R * R - RB * RB) / (2 * RS * R);
    const phi = Math.acos(cosP);
    const sh = new THREE.Shape();
    sh.absarc(0, 0, RS, phi, Math.PI * 2 - phi, false);
    const px = RS * Math.cos(phi), py = RS * Math.sin(phi);
    const aB = Math.atan2(py, px - R);
    sh.absarc(R, 0, RB, Math.PI * 2 - aB, aB, true);
    sh.closePath();
    const dh = ATC_GEOM.drumTop - ATC_GEOM.drumBottom;
    const dg = new THREE.ExtrudeGeometry(sh, { depth: dh, bevelEnabled: false, curveSegments: 48 });
    dg.rotateX(-Math.PI / 2); // extrusion now runs up +Y
    dg.translate(0, ATC_GEOM.drumBottom, 0);
    const drum = new THREE.Mesh(dg, M.paintLight);
    drum.position.y = GAUGE0;
    this.drum = drum;
    this.atcSlide.add(drum);
    // dark trim ring along the bottom edge of the drum
    const trim = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth: 8, bevelEnabled: false, curveSegments: 48 }).rotateX(-Math.PI / 2).translate(0, ATC_GEOM.drumBottom - 2, 0), M.paintDark);
    trim.position.y = GAUGE0;
    trim.scale.set(1.004, 1, 1.004);
    this.atcSlide.add(trim);
    // box-shaped upper hood on the drum
    const hood = new THREE.Mesh(new RoundedBoxGeometry(310, 230, 400, 2, 10), M.paintLight);
    hood.position.set(-110, GAUGE0 + ATC_GEOM.drumTop + 105, -60);
    this.atcSlide.add(hood);
    // pockets: fork tongues that carry the tool flanges, indexed with the carousel
    this.pockets = [];
    const P = MACHINE.atcPockets;
    const prong = new THREE.BoxGeometry(40, 6, 15);
    const tongue = new THREE.BoxGeometry(150, 6, 96);
    for (let k = 1; k <= P; k++) {
      const a = ((k - 1) / P) * Math.PI * 2;
      const pocket = new THREE.Group();
      pocket.position.set(Math.cos(a) * R, 0, -Math.sin(a) * R);
      pocket.rotation.y = a;
      const t = new THREE.Mesh(tongue, M.paintDark);
      t.position.set(-90, -7, 0);
      pocket.add(t);
      for (const s of [-1, 1]) {
        const p = new THREE.Mesh(prong, M.chrome);
        p.position.set(-14, -6.5, s * 38);
        pocket.add(p);
      }
      this.carousel.add(pocket);
      this.pockets[k] = pocket;
    }
  }

  // ---------- enclosure sheet metal: light grey cabinet that chamfers in onto the dark base
  buildEnclosure() {
    const E = this.enclosure;
    const M = this.M;
    const S = new THREE.Group();
    this.encStatic = S;
    E.add(S);
    const T = 20;
    // front plate: octagon-ish silhouette with the big window opening
    const prof = new THREE.Shape();
    prof.moveTo(XL, YR); prof.lineTo(XR, YR); prof.lineTo(XR, CH_Y); prof.lineTo(CH_XR, CH_B); prof.lineTo(CH_XL, CH_B); prof.lineTo(XL, CH_Y); prof.closePath();
    const hole = new THREE.Path();
    hole.moveTo(WX0, WY0); hole.lineTo(WX0, WY1); hole.lineTo(WX1, WY1); hole.lineTo(WX1, WY0); hole.closePath();
    const front = new THREE.Shape(prof.getPoints());
    front.holes.push(hole);
    const fg = new THREE.ExtrudeGeometry(front, { depth: T, bevelEnabled: false });
    fg.translate(0, 0, ZF - T);
    S.add(new THREE.Mesh(fg, M.paint));
    const bg = new THREE.ExtrudeGeometry(prof, { depth: T, bevelEnabled: false });
    bg.translate(0, 0, ZB);
    S.add(new THREE.Mesh(bg, M.paint));
    // window frame (dark charcoal) lining the opening
    this.bx(WX0 - 8, WY0 - 12, ZF - T - 2, WX1 + 8, WY0 + 6, ZF + 6, M.charcoal, S);
    this.bx(WX0 - 8, WY1 - 6, ZF - T - 2, WX1 + 8, WY1 + 12, ZF + 6, M.charcoal, S);
    this.bx(WX0 - 8, WY0 - 12, ZF - T - 2, WX0 + 6, WY1 + 12, ZF + 6, M.charcoal, S);
    this.bx(WX1 - 6, WY0 - 12, ZF - T - 2, WX1 + 8, WY1 + 12, ZF + 6, M.charcoal, S);
    // side walls, chamfer panels and roof (roof has a slot for the column / head)
    for (const [x, sgn] of [[XL, -1], [XR, 1]]) {
      // side wall with an observation window (z -240..380, y 1040..1640)
      const sx0 = sgn < 0 ? x : x - T, sx1 = sgn < 0 ? x + T : x;
      const SZ0 = -240, SZ1 = 380, SY0 = 1040, SY1 = 1640;
      this.bx(sx0, CH_Y, ZB, sx1, SY0, ZF, M.paint, S);
      this.bx(sx0, SY1, ZB, sx1, YR, ZF, M.paint, S);
      this.bx(sx0, SY0, ZB, sx1, SY1, SZ0, M.paint, S);
      this.bx(sx0, SY0, SZ1, sx1, SY1, ZF, M.paint, S);
      const wg = new THREE.Mesh(new THREE.BoxGeometry(6, SY1 - SY0, SZ1 - SZ0), M.glass);
      wg.position.set((sx0 + sx1) / 2, (SY0 + SY1) / 2, (SZ0 + SZ1) / 2);
      wg.userData.shadow = false;
      S.add(wg);
      const fx0 = sx0 - 4 * sgn, fx1 = sx1 + 4 * sgn, a = Math.min(fx0, fx1), b = Math.max(fx0, fx1);
      this.bx(a, SY0 - 10, SZ0 - 10, b, SY0 + 8, SZ1 + 10, M.charcoal, S);
      this.bx(a, SY1 - 8, SZ0 - 10, b, SY1 + 10, SZ1 + 10, M.charcoal, S);
      this.bx(a, SY0 - 10, SZ0 - 10, b, SY1 + 10, SZ0 + 8, M.charcoal, S);
      this.bx(a, SY0 - 10, SZ1 - 8, b, SY1 + 10, SZ1 + 10, M.charcoal, S);
      const x1 = sgn < 0 ? CH_XL : CH_XR;
      const dx = x1 - x, dy = CH_B - CH_Y, len = Math.hypot(dx, dy);
      const m = new THREE.Mesh(new THREE.BoxGeometry(len, T, ZF - ZB), M.paint);
      m.position.set((x + x1) / 2, (CH_Y + CH_B) / 2, (ZF + ZB) / 2);
      m.rotation.z = Math.atan2(dy, dx);
      S.add(m);
    }
    const roof = new THREE.Shape();
    roof.moveTo(XL, ZB); roof.lineTo(XR, ZB); roof.lineTo(XR, ZF); roof.lineTo(XL, ZF); roof.closePath();
    const rh = new THREE.Path();
    rh.moveTo(-235, ZB + 30); rh.lineTo(235, ZB + 30); rh.lineTo(235, -40); rh.lineTo(-235, -40); rh.closePath();
    roof.holes.push(rh);
    const rg = new THREE.ExtrudeGeometry(roof, { depth: T, bevelEnabled: false });
    rg.rotateX(Math.PI / 2); // (x, z, depth) -> (x, -depth.., z) ; flip so the roof faces up
    rg.scale(1, 1, 1);
    const rm = new THREE.Mesh(rg, M.paint);
    rm.position.y = YR; // plate occupies y YR-T..YR after the rotation maps depth to -y
    S.add(rm);
    // dark plate under the roof slot so the hole looks closed from above
    this.bx(-240, YR - 60, ZB + 25, 240, YR - 50, -35, M.charcoal, S);
    // interior light grey-blue lining
    this.bx(XL + T, CH_Y, ZB + T, XL + T + 2, YR - T, ZF - T, M.wall, S);
    this.bx(XR - T - 2, CH_Y, ZB + T, XR - T, YR - T, ZF - T, M.wall, S);
    this.bx(XL + T, CH_Y, ZB + T, XR - T, YR - T, ZB + T + 2, M.wall, S);
    this.bx(XL + T, YR - T - 2, ZB + T, XR - T, YR - T, ZF - T, M.wall, S);
    // sloped chip pan: side slopes from the chamfers up to the base casting, front guard up to the sill
    const slope = (xa, ya, xb, yb) => {
      const dx = xb - xa, dy = yb - ya, len = Math.hypot(dx, dy);
      const m = new THREE.Mesh(new THREE.BoxGeometry(len, 6, ZF - ZB - 2 * T - 10), M.wallLow);
      m.position.set((xa + xb) / 2, (ya + yb) / 2, (ZF + ZB) / 2);
      m.rotation.z = Math.atan2(dy, dx);
      S.add(m);
    };
    slope(XL + T, 800, -410, 640);
    slope(XR - T, 800, 410, 640);
    this.bx(-410, 634, ZB + T, 410, 640, ZF - T, M.wallLow, S);
    {
      const z0 = 436, y0 = 690, z1 = ZF - T - 4, y1 = WY0 - 20;
      const len = Math.hypot(z1 - z0, y1 - y0);
      const fr = new THREE.Mesh(new THREE.BoxGeometry(XR - XL - 2 * T - 20, 6, len), M.wallLow);
      fr.position.set((XL + XR) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      fr.rotation.x = -Math.atan2(y1 - y0, z1 - z0);
      S.add(fr);
    }
    // ---- front details
    // plain red square badge and safety decals on the left panel
    this.bx(-740, 1460, ZF, -620, 1580, ZF + 3, M.red, S);
    const dec = (w, h, tex, x, y) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 }));
      m.position.set(x, y, ZF + 1.2);
      S.add(m);
    };
    dec(150, 110, warningStickerTexture(), -690, 1250);
    dec(120, 110, pictogramTexture(1), -540, 1250);
    dec(80, 130, pictogramTexture(2), -600, 1040);
    // screw heads along the panel edges
    const sg = new THREE.CylinderGeometry(5, 5, 3, 8);
    sg.rotateX(Math.PI / 2);
    const pts = [];
    for (let y = 760; y <= 1860; y += 110) pts.push([XL + 22, y], [WX0 - 24, y]);
    for (let x = XL + 100; x < WX0 - 40; x += 105) pts.push([x, 1880], [x, 760]);
    const screws = new THREE.InstancedMesh(sg, M.rail, pts.length);
    const mm = new THREE.Matrix4();
    pts.forEach(([x, y], i) => { mm.makeTranslation(x, y, ZF + 1.5); screws.setMatrixAt(i, mm); });
    S.add(screws);
    // small sheet tray under the pendant, with a holder
    this.bx(340, 960, ZF, 760, 972, ZF + 190, M.steel, S);
    this.bx(340, 972, ZF + 184, 760, 1000, ZF + 190, M.steel, S);
    this.bx(340, 972, ZF, 346, 1000, ZF + 190, M.steel, S);
    this.bx(754, 972, ZF, 760, 1000, ZF + 190, M.steel, S);
    this.cyl(26, 70, M.paintDark, 440, 1005, ZF + 100, S, 'y', 14);
    // coiled air-gun hose on the front left, with the gun in a holder
    const gx = -770 + 130, gy = 930;
    this.bx(gx - 24, gy - 10, ZF, gx + 24, gy + 90, ZF + 28, M.black, S, 5);
    const gun = this.bx(gx - 12, gy - 60, ZF + 20, gx + 12, gy + 80, ZF + 40, M.red, S, 6);
    gun.userData.shadow = true;
    const helix = [];
    for (let i = 0; i <= 160; i++) {
      const t = i / 160;
      const a = t * 16 * Math.PI * 2;
      helix.push(new THREE.Vector3(gx + 20 + Math.cos(a) * 30 + t * 60, gy - 60 - t * 330 + Math.sin(a) * 14, ZF + 30 + Math.sin(a) * 30));
    }
    const coil = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(helix), 400, 5, 6, false), M.black);
    S.add(coil);
    // lower door track above the window
    this.bx(WX0 - 700, WY1 + 20, ZF, WX1 + 20, WY1 + 40, ZF + 36, M.charcoal, S);
  }

  buildDoors() {
    const M = this.M;
    this.doors = [];
    const w = WX1 - WX0 + 40, h = WY1 - WY0 + 40;
    const d = new THREE.Group();
    d.name = 'door';
    // door slides on a track just behind the front plate, into the left panel
    const zD = ZF - 40;
    const fr = (x0, y0, x1, y1) => this.bx(x0, y0, -8, x1, y1, 8, M.paintLight, d);
    fr(-w / 2, 0, w / 2, 40); fr(-w / 2, h - 40, w / 2, h); fr(-w / 2, 0, -w / 2 + 40, h); fr(w / 2 - 40, 0, w / 2, h);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(w - 60, h - 60, 6), M.glass);
    glass.position.set(0, h / 2, 0);
    glass.userData.shadow = false;
    d.add(glass);
    // tall vertical chrome handle on the leading edge (passes through the window opening)
    const hx = w / 2 - 22;
    for (const y of [h * 0.3, h * 0.78]) this.bx(hx - 10, y - 8, 0, hx + 10, y + 8, 56, M.chrome, d, 3);
    const handle = this.bx(hx - 13, h * 0.26, 46, hx + 13, h * 0.82, 70, M.chrome, d, 12);
    handle.userData.action = 'door';
    handle.userData.keep = true;
    this.clickables.push(handle);
    const cx = (WX0 + WX1) / 2;
    d.position.set(cx, WY0 - 20, zD);
    d.userData.closedX = cx;
    d.userData.openX = cx - (w - 60) - 0;
    this.enclosure.add(d);
    this.doors.push(d);
  }

  // ---------- control pendant
  buildPendant() {
    const M = this.M;
    const c0 = this.clickables.length;
    const P = new THREE.Group();
    P.name = 'pendant';
    this.pendant = P;
    this.root.add(P);
    // integrated: a flush angled panel in the right-hand front of the cabinet (no swing arm)
    P.position.set(PEND_X, PEND_Y, PEND_Z);
    P.rotation.set(-0.1, -0.3, 0);
    P.scale.setScalar(0.8);
    const hous = new THREE.Group();
    P.add(hous);
    this.bx(-300, -380, -230, 300, 380, -40, M.paintLight, hous, 18);
    this.bx(-305, -385, -60, 305, -340, -30, M.paintLight, hous, 8);
    const body = new THREE.Group();
    P.add(body);
    this.pendantBody = body;
    this.bx(-230, -330, -50, 230, 330, 40, M.paint, body, 20);
    this.bx(-232, -332, -55, 232, 332, -40, M.paintDark, body, 10);
    this.bx(-15, 330, -20, 15, 380, 20, M.paintDark, body);
    // screen
    this.bx(-190, 50, 38, 190, 300, 44, M.black, body, 6);
    this.screenCanvas = document.createElement('canvas');
    this.screenCanvas.width = 640;
    this.screenCanvas.height = 420;
    this.screenTex = new THREE.CanvasTexture(this.screenCanvas);
    this.screenTex.colorSpace = THREE.SRGBColorSpace;
    this.screenTex.anisotropy = 4;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(352, 231), new THREE.MeshBasicMaterial({ map: this.screenTex, toneMapped: false }));
    screen.position.set(0, 175, 45);
    body.add(screen);
    // keypad
    const key = new THREE.BoxGeometry(34, 22, 10);
    const keys = new THREE.InstancedMesh(key, M.paintDark, 36);
    const mm = new THREE.Matrix4();
    let i = 0;
    for (let r = 0; r < 4; r++) for (let c = 0; c < 9; c++) {
      mm.makeTranslation(-176 + c * 44, 18 - r * 32, 44);
      keys.setMatrixAt(i++, mm);
    }
    body.add(keys);
    const legend = new THREE.Mesh(new THREE.PlaneGeometry(400, 20), new THREE.MeshBasicMaterial({ map: labelTexture(['POSITION   OFFSET   PROGRAM   PROG MGR   SYSTEM ALARM   CUSTOM'], { w: 1024, h: 52, bg: '#d9dcdf', fg: '#30353b', font: '600 30px Arial' }) }));
    legend.position.set(0, 38, 41);
    body.add(legend);
    // E-STOP (mushroom on yellow ring), CYCLE START, FEED HOLD, handwheel
    const ring = this.cyl(46, 8, M.yellow, -150, -230, 44, body, 'z', 32);
    ring.userData.keep = true;
    this.estopBtn = new THREE.Group();
    this.estopBtn.position.set(-150, -230, 48);
    body.add(this.estopBtn);
    const stem = this.cyl(16, 22, M.red, 0, 0, 11, this.estopBtn, 'z', 20);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(34, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), M.red);
    cap.rotation.x = Math.PI / 2;
    cap.position.z = 20;
    cap.scale.y = 0.55;
    this.estopBtn.add(cap);
    for (const m of [stem, cap]) {
      m.userData.action = 'estop';
      m.userData.keep = true;
      this.clickables.push(m);
    }
    const mkBtn = (x, mat, action, label) => {
      const g = new THREE.Group();
      g.position.set(x, -230, 44);
      body.add(g);
      const bezel = this.cyl(30, 6, M.chrome, 0, 0, 0, g, 'z', 28);
      const b = this.cyl(22, 14, mat, 0, 0, 8, g, 'z', 28);
      b.userData.action = action;
      b.userData.keep = true;
      bezel.userData.keep = true;
      this.clickables.push(b);
      const t = new THREE.Mesh(new THREE.PlaneGeometry(90, 18), new THREE.MeshBasicMaterial({ map: labelTexture([label], { w: 256, h: 52, bg: '#d9dcdf', fg: '#24282d', font: '700 30px Arial' }) }));
      t.position.set(0, -44, 0);
      g.add(t);
      return b;
    };
    this.cycleBtn = mkBtn(-45, M.green.clone(), 'cycleStart', 'CYCLE START');
    this.holdBtn = mkBtn(55, M.amber.clone(), 'feedHold', 'CYCLE STOP');
    const estopLabel = new THREE.Mesh(new THREE.PlaneGeometry(90, 18), new THREE.MeshBasicMaterial({ map: labelTexture(['EMERGENCY STOP'], { w: 256, h: 52, bg: '#d9dcdf', fg: '#a01015', font: '700 26px Arial' }) }));
    estopLabel.position.set(-150, -294, 44);
    body.add(estopLabel);
    const mpg = this.cyl(52, 26, M.black, 160, -230, 50, body, 'z', 36);
    mpg.userData.keep = true;
    this.cyl(40, 4, M.chrome, 160, -230, 64, body, 'z', 36);
    this.cyl(7, 26, M.chrome, 190, -210, 76, body, 'z', 12);
    // mode selector knob
    this.cyl(26, 20, M.black, 160, -110, 50, body, 'z', 24);
    this.bx(155, -130, 60, 165, -90, 66, M.chrome, body);
    this.p808 = { body, canvas: this.screenCanvas, tex: this.screenTex, click: this.clickables.splice(c0) };
    this.clickBase = this.clickables.slice();
    this.buildHaasPendant(P);
    this.setControlStyle('808d');
  }

  // NGC-style pendant: screen on top, keyboard below, power / E-STOP / handle / cycle start on the left,
  // beacon on top. Same arm and position as the 808D-style panel.
  buildHaasPendant(P) {
    const M = this.M;
    const click = [];
    const body = new THREE.Group();
    P.add(body);
    const shell = new THREE.MeshStandardMaterial({ color: 0xd9dcdf, roughness: 0.42, metalness: 0.25 });
    this.bx(-270, -340, -45, 270, 340, 38, shell, body, 22);
    this.bx(-262, -332, -52, 262, 332, -44, M.paintDark, body, 10);
    this.bx(-15, 340, -20, 15, 380, 20, M.paintDark, body);
    // screen
    this.bx(-148, 18, 34, 258, 332, 42, M.black, body, 6);
    const cv = document.createElement('canvas');
    cv.width = 800;
    cv.height = 600;
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(392, 294), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    screen.position.set(55, 175, 43);
    body.add(screen);
    // keyboard (a printed key plate)
    const kc = document.createElement('canvas');
    kc.width = 1024;
    kc.height = 860;
    drawHaasKeyboard(kc);
    const ktex = new THREE.CanvasTexture(kc);
    ktex.colorSpace = THREE.SRGBColorSpace;
    ktex.anisotropy = 4;
    const kb = new THREE.Mesh(new THREE.PlaneGeometry(404, 340), new THREE.MeshStandardMaterial({ map: ktex, roughness: 0.55, metalness: 0.05 }));
    kb.position.set(55, -160, 39.5);
    body.add(kb);
    const lab = (txt, x, y, w = 96, col = '#202326') => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 0.18), new THREE.MeshBasicMaterial({ map: labelTexture([txt], { w: 256, h: 46, bg: '#d9dcdf', fg: col, font: '700 28px Arial' }) }));
      m.position.set(x, y, 39);
      body.add(m);
    };
    this.bx(-232, 292, 38, -178, 328, 41, M.red, body); // plain red square badge
    // power on / off
    lab('POWER ON', -232, 272, 52);
    lab('POWER OFF', -178, 272, 52);
    this.cyl(16, 10, M.green, -232, 248, 42, body, 'z', 20);
    this.cyl(16, 10, M.red, -178, 248, 42, body, 'z', 20);
    // E-STOP
    lab('EMERGENCY STOP', -205, 196, 100);
    const ring = this.cyl(44, 8, M.yellow, -205, 140, 42, body, 'z', 32);
    ring.userData.keep = true;
    this.haasEstop = new THREE.Group();
    this.haasEstop.position.set(-205, 140, 46);
    body.add(this.haasEstop);
    const stem = this.cyl(15, 20, M.red, 0, 0, 10, this.haasEstop, 'z', 20);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(32, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), M.red);
    cap.rotation.x = Math.PI / 2;
    cap.position.z = 18;
    cap.scale.y = 0.55;
    this.haasEstop.add(cap);
    for (const m of [stem, cap]) { m.userData.action = 'estop'; m.userData.keep = true; click.push(m); }
    // jog handle
    lab('HANDLE JOG', -205, 70, 80);
    this.cyl(46, 22, M.chrome, -205, 10, 48, body, 'z', 40).userData.keep = true;
    this.cyl(38, 4, M.paint, -205, 10, 60, body, 'z', 40);
    this.cyl(7, 24, M.black, -205, 40, 70, body, 'z', 12);
    // cycle start / feed hold
    lab('CYCLE START', -232, -112, 56);
    lab('FEED HOLD', -178, -112, 52);
    const btn = (x, mat, action) => {
      this.bx(x - 24, -166, 38, x + 24, -128, 44, M.chrome, body, 4);
      const b = this.bx(x - 19, -162, 42, x + 19, -132, 52, mat, body, 4);
      b.userData.action = action;
      b.userData.keep = true;
      click.push(b);
      return b;
    };
    this.haasCycle = btn(-232, M.green.clone(), 'cycleStart');
    this.haasHold = btn(-178, M.red.clone(), 'feedHold');
    this.pHaas = { body, canvas: cv, tex, click };
  }

  setControlStyle(style) {
    const haas = style === 'haas';
    if (this.controlStyle === style) return;
    this.controlStyle = style;
    const on = haas ? this.pHaas : this.p808, off = haas ? this.p808 : this.pHaas;
    if (this.stackGroup) { this.stackGroup.visible = !haas; this.haasBeaconGroup.visible = haas; }
    on.body.visible = true;
    off.body.visible = false;
    this.pendantBody = on.body;
    this.screenCanvas = on.canvas;
    this.screenTex = on.tex;
    this.clickables = [...this.clickBase, ...on.click];
  }

  buildStackLight() {
    // 808-style three-colour stack and the single-lens beacon (NGC style) share the top-right corner above the pendant
    const g = new THREE.Group();
    g.position.set(BEACON_X, YR, ZF - 120);
    this.root.add(g);
    this.beaconGroup = g;
    this.cyl(40, 24, this.M.charcoal, 0, 12, 0, g, 'y', 20);
    this.stack = {};
    const colors = { green: 0x23c45e, amber: 0xffa21a, red: 0xff2a2a };
    const st = new THREE.Group();
    g.add(st);
    this.stackGroup = st;
    let y = 24;
    for (const k of ['green', 'amber', 'red']) {
      const m = new THREE.MeshStandardMaterial({ color: colors[k], emissive: colors[k], emissiveIntensity: 0, transparent: true, opacity: 0.85, roughness: 0.2 });
      const c = this.cyl(34, 44, m, 0, y + 22, 0, st, 'y', 24);
      c.userData.keep = true;
      this.stack[k] = m;
      y += 46;
    }
    this.cyl(36, 8, this.M.charcoal, 0, y + 4, 0, st, 'y', 24);
    // Haas-style beacon: one tall lens that changes colour
    this.haasBeaconMat = new THREE.MeshStandardMaterial({ color: 0xe8ecef, emissive: 0x000000, transparent: true, opacity: 0.85, roughness: 0.25 });
    const lens = this.cyl(34, 110, this.haasBeaconMat, 0, 24 + 55, 0, g, 'y', 24);
    lens.userData.keep = true;
    this.cyl(36, 8, this.M.charcoal, 0, 24 + 114, 0, g, 'y', 24);
    this.haasBeaconGroup = lens;
    lens.visible = false;
  }

  buildLights() {
    const barMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xf4f8ff, emissiveIntensity: 1.6, roughness: 0.3 });
    this.ledMat = barMat;
    const bar = this.bx(-560, YR - 40, ZF - 160, 560, YR - 24, ZF - 110, barMat, this.enclosure);
    bar.userData.keep = true;
    bar.userData.cast = false;
    const spot = new THREE.SpotLight(0xf3f6ff, 2.1, 0, 0.62, 0.55, 0);
    spot.position.set(0, YR - 50, ZF - 150);
    spot.target.position.set(-80, 930, -60);
    spot.castShadow = true;
    spot.shadow.mapSize.set(1024, 1024);
    spot.shadow.camera.near = 700;
    spot.shadow.camera.far = 2600;
    spot.shadow.bias = -0.0004;
    spot.shadow.normalBias = 0.6;
    this.root.add(spot, spot.target);
    this.workLight = spot;
    const fill = new THREE.PointLight(0xdfe8ff, 0.5, 0, 0);
    fill.position.set(-600, 1700, -300);
    this.root.add(fill);
    this.fillLight = fill;
  }

  buildExtras() {
    // Things you see when you orbit round the back: electrical cabinet, coolant tank.
    const M = this.M;
    const X = new THREE.Group();
    this.extras = X;
    this.root.add(X);
    this.bx(-700, 300, ZB - 220, -100, 1700, ZB, M.paint, X, 10);
    this.bx(-690, 1100, ZB - 224, -560, 1600, ZB - 218, M.paintDark, X);
    this.bx(200, 0, ZB - 520, 800, 650, ZB, M.paintDark, X, 10);
    this.cyl(70, 180, M.black, 500, 740, ZB - 260, X, 'y', 20);
    const hz = hazardTexture();
    hz.repeat.set(8, 1);
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(1600, 40), new THREE.MeshStandardMaterial({ map: hz, roughness: 0.6 }));
    strip.position.set(-70, 50, ZF - 62);
    strip.userData.keep = true;
    this.enclosure.add(strip);
  }

  // ---------- tool models in spindle / pockets
  setTools(tools, buildToolModel) {
    for (const m of this.toolModels.values()) m.parent?.remove(m);
    this.toolModels.clear();
    for (const t of tools) {
      if (t.number < 1 || t.number > MACHINE.atcPockets) continue;
      const m = buildToolModel(t);
      m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.toolModels.set(t.number, m);
    }
    this.placedSpindleTool = -1;
  }

  placeTools(spindleTool) {
    if (spindleTool === this.placedSpindleTool) return;
    this.placedSpindleTool = spindleTool;
    for (const [n, m] of this.toolModels) {
      const parent = n === spindleTool ? this.rotor : this.pockets[n];
      if (m.parent !== parent) {
        parent.add(m);
        m.position.set(0, 0, 0);
        m.rotation.set(0, 0, 0);
      }
    }
  }

  // ---------- per-frame update from the controller's physical state
  update(s) {
    const tc = MACHINE.tableCenter;
    this.saddle.position.z = s.y - tc.y;
    this.table.position.x = -(s.x - tc.x);
    const headZ = s.z + (s.lift || 0);
    this.head.position.y = GAUGE0 + headZ;
    this.rotor.rotation.y = s.spindleAngle || 0;
    const ang = (v) => (v / PITCH) * Math.PI * 2;
    this.xScrew.userData.spin.rotation.y = ang(s.x);
    this.yScrew.userData.spin.rotation.y = ang(s.y);
    this.zScrew.userData.spin.rotation.y = ang(headZ);
    // way covers: front from base front edge to saddle front, rear from column to saddle back
    const sz = this.saddle.position.z;
    this.layoutCover(this.frontCover, 424, sz + 200);
    this.layoutCover(this.rearCover, COLZ + 4, sz - 200);
    // doors
    for (const d of this.doors) d.position.x = d.userData.closedX + (d.userData.openX - d.userData.closedX) * (s.door || 0);
    // tool changer
    const slide = s.atcSlide || 0;
    this.atcSlide.position.x = ATC_GEOM.retractedX + (ATC_GEOM.engagedX - ATC_GEOM.retractedX) * slide;
    this.carousel.rotation.y = s.atcAngle || 0;
    this.placeTools(s.spindleTool);
    // stack light
    const st = s.state;
    const blink = (Math.sin(performance.now() / 160) > 0) ? 1 : 0.15;
    this.stack.green.emissiveIntensity = st === 'running' ? 2.2 : 0;
    this.stack.amber.emissiveIntensity = st === 'hold' || st === 'idle' || st === 'complete' ? (st === 'hold' ? 2.2 * blink : 1.2) : 0;
    this.stack.red.emissiveIntensity = st === 'alarm' || st === 'estop' ? 2.4 * blink : 0;
    // pendant buttons lit
    this.cycleBtn.material.emissive.setHex(st === 'running' ? 0x1fbf55 : 0x000000);
    this.cycleBtn.material.emissiveIntensity = 1.2;
    this.holdBtn.material.emissive.setHex(st === 'hold' ? 0xff9a1a : 0x000000);
    this.holdBtn.material.emissiveIntensity = 1.2;
    this.estopBtn.position.z = s.estop ? 40 : 48;
    if (s.control) this.setControlStyle(s.control);
    if (this.controlStyle === 'haas') {
      // beacon: off idle, solid green running, flashing green stopped / waiting, flashing red alarm
      const b = s.beacon || 'off';
      const on = b === 'green' || ((b === 'green-flash' || b === 'red' || b === 'yellow') && blink > 0.5);
      const col = b.startsWith('green') ? 0x22e055 : b === 'red' ? 0xff2a2a : b === 'yellow' ? 0xffc21a : 0;
      this.haasBeaconMat.emissive.setHex(on ? col : 0);
      this.haasBeaconMat.emissiveIntensity = on ? 2.4 : 0;
      this.stack.green.emissiveIntensity = b === 'green' ? 2.2 : b === 'green-flash' ? 2.2 * blink : 0;
      this.stack.amber.emissiveIntensity = b === 'yellow' ? 2.2 * blink : 0;
      this.stack.red.emissiveIntensity = b === 'red' ? 2.4 * blink : 0;
      this.haasCycle.material.emissive.setHex(st === 'running' ? 0x1fbf55 : 0x000000);
      this.haasCycle.material.emissiveIntensity = 1.2;
      this.haasHold.material.emissive.setHex(st === 'hold' ? 0xff3a2a : 0x000000);
      this.haasHold.material.emissiveIntensity = 1.2;
      this.haasEstop.position.z = s.haasEstop ? 38 : 46;
    }
  }

  setLights(on) {
    this.workLight.visible = on;
    this.fillLight.visible = on;
    this.ledMat.emissiveIntensity = on ? 1.6 : 0.05;
  }

  setEnclosureVisible(v) {
    this.enclosure.visible = v;
  }

  setCoversVisible(v) {
    this.covers.visible = v;
  }

  // world position of the spindle gauge line / coolant nozzle tips
  nozzleWorld(i, out) {
    const n = this.coolantNozzles[i];
    out.copy(n.tip);
    return this.head.localToWorld(out);
  }
}

// The NGC-style key plate as a texture for the 3D pendant (same groups and legends as the HTML pendant).
function drawHaasKeyboard(cv) {
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  g.fillStyle = '#cfd0d2';
  g.fillRect(0, 0, W, H);
  const u = W / 14.3, pad = u * 0.25;
  const by = (id) => HAAS_GROUPS.find((x) => x.id === id);
  const plate = { grey: '#c5c6c8', light: '#c5c6c8', none: '#c5c6c8', black: '#151515', blue: '#0e92c8' };
  const text = (html) => html.replace(/<i class="sh">[^<]*<\/i>/g, '').replace(/<br>/g, '\n').replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').trim();
  const drawGroup = (grp, x, y, w) => {
    const rows = Math.ceil(grp.keys.reduce((n, k) => n + (k.span || 1), 0) / grp.cols);
    const kh = u * 0.62, gap = u * 0.14, title = grp.title ? u * 0.42 : 0;
    const h = title + rows * kh + (rows - 1) * gap + u * 0.26;
    g.fillStyle = plate[grp.plate] || '#c5c6c8';
    g.beginPath(); g.roundRect(x, y, w, h, 8); g.fill();
    g.strokeStyle = grp.plate === 'black' ? '#000' : '#6d7074'; g.lineWidth = 1.5; g.stroke();
    if (grp.title) { g.fillStyle = '#fff'; g.font = `700 ${u * 0.3}px Arial`; g.textAlign = 'center'; g.fillText(grp.title, x + w / 2, y + u * 0.36); }
    const kw = (w - u * 0.24 - (grp.cols - 1) * gap * 0.9) / grp.cols;
    let col = 0, row = 0;
    for (const k of grp.keys) {
      const span = k.span || 1;
      const kx = x + u * 0.12 + col * (kw + gap * 0.9), ky = y + title + u * 0.12 + row * (kh + gap);
      const ww = kw * span + gap * 0.9 * (span - 1);
      if (k.text) {
        g.fillStyle = '#fff'; g.font = `700 ${u * 0.22}px Arial`; g.textAlign = 'center'; g.fillText(k.text, kx + ww / 2, ky + kh * 0.62);
      } else {
        const cls = k.cls || 'g';
        g.fillStyle = cls.startsWith('r') ? '#e8590c' : cls.startsWith('t') ? '#49c2e2' : cls.startsWith('w') ? '#f4f4f4' : grp.plate === 'black' ? '#a3a4a7' : '#bfc0c3';
        g.beginPath(); g.roundRect(kx, ky, ww, kh, 6); g.fill();
        g.strokeStyle = '#f8f8f8'; g.lineWidth = 1.5; g.stroke();
        const lines = text(k.label).split('\n');
        const fs = cls.includes('f') && !cls.includes('fn') ? u * 0.3 : cls.includes('ch') ? u * 0.28 : u * 0.14;
        g.fillStyle = '#222'; g.font = `600 ${fs}px Arial`; g.textAlign = 'center';
        lines.forEach((l, i) => g.fillText(l.slice(0, 9), kx + ww / 2, ky + kh / 2 + (i - (lines.length - 1) / 2) * fs * 1.05 + fs * 0.35));
      }
      col += span;
      if (col >= grp.cols) { col = 0; row++; }
    }
    return y + h + u * 0.18;
  };
  const top = pad, x0 = pad;
  let y = drawGroup(by('function'), x0, top, u * 4.15);
  y = drawGroup(by('jog'), x0, y, u * 4.15);
  let y2 = drawGroup(by('display'), x0 + u * 4.35, top, u * 4.05);
  y2 = drawGroup(by('cursor'), x0 + u * 4.55, y2, u * 3.85);
  const y3 = drawGroup(by('modes'), x0 + u * 8.6, top, u * 5.25);
  const yb = Math.max(y, y2, y3) + u * 0.05;
  drawGroup(by('overrides'), x0, yb, u * 4.05);
  drawGroup(by('alpha'), x0 + u * 4.25, yb, u * 6.1);
  drawGroup(by('numeric'), x0 + u * 10.55, yb, u * 3.25);
}


// Generic safety-sticker artwork (pictograms only, no lettering).
function stickerCanvas(w, h, draw, bg = '#f1f1ee') {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
function tri(g, x, y, s, col = '#f2c200') {
  g.fillStyle = col; g.strokeStyle = '#111'; g.lineWidth = s * 0.07;
  g.beginPath(); g.moveTo(x, y - s * 0.55); g.lineTo(x + s * 0.55, y + s * 0.42); g.lineTo(x - s * 0.55, y + s * 0.42); g.closePath(); g.fill(); g.stroke();
  g.fillStyle = '#111'; g.fillRect(x - s * 0.04, y - s * 0.2, s * 0.08, s * 0.35); g.beginPath(); g.arc(x, y + s * 0.26, s * 0.05, 0, 7); g.fill();
}
function noSign(g, x, y, r) {
  g.strokeStyle = '#c8191e'; g.lineWidth = r * 0.2; g.beginPath(); g.arc(x, y, r, 0, 7); g.moveTo(x - r * 0.7, y - r * 0.7); g.lineTo(x + r * 0.7, y + r * 0.7); g.stroke();
  g.fillStyle = '#222'; g.fillRect(x - r * 0.35, y - r * 0.12, r * 0.7, r * 0.24);
}
let warnTex, pictoTex = {};
function warningStickerTexture() {
  return warnTex || (warnTex = stickerCanvas(512, 256, (g, w, h) => {
    g.fillStyle = '#e8651a'; g.fillRect(0, 0, w, h * 0.3);
    g.fillStyle = '#f5f0e6'; for (let i = 0; i < 6; i++) g.fillRect(24 + i * 78, 14, 50, 14);
    for (let i = 0; i < 4; i++) { g.fillStyle = '#fff'; g.fillRect(10 + i * 125, h * 0.36, 115, h * 0.58); g.strokeStyle = '#222'; g.lineWidth = 3; g.strokeRect(10 + i * 125, h * 0.36, 115, h * 0.58); if (i % 2) noSign(g, 67 + i * 125, h * 0.65, 34); else tri(g, 67 + i * 125, h * 0.64, 90); }
  }));
}
function pictogramTexture(k) {
  return pictoTex[k] || (pictoTex[k] = stickerCanvas(256, 256, (g, w, h) => {
    if (k === 1) { tri(g, 64, 64, 100); tri(g, 192, 64, 100); noSign(g, 64, 190, 44); noSign(g, 192, 190, 44); }
    else { g.fillStyle = '#f5f0e6'; g.fillRect(0, 0, w, h); for (let i = 0; i < 3; i++) tri(g, 128, 50 + i * 80, 100, i === 1 ? '#c8191e' : '#f2c200'); }
  }));
}
