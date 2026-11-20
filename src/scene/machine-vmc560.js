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
const GAUGE0 = TT + MACHINE.gaugeAtZ0; // world Y of the gauge line at Z0 (1430)
const PITCH = 10; // ball screw lead, mm/rev
// Pocket pitch radius 330 leaves the neighbouring pocket tools clear of the coolant ring (r 98) when a
// pocket is under the spindle; retracted, the carousel stays inside the cabinet (left wall x -1030).
export const ATC_GEOM = { pitchR: 330, engagedX: -330, retractedX: -630 };

export class Vmc560Model {
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
      paint: std({ color: 0xcdd1d5, roughness: 0.55, metalness: 0.1, roughnessMap: T.paintRough, envMapIntensity: 0.7 }),
      paintDark: std({ color: 0x2b2f34, roughness: 0.6, metalness: 0.2 }),
      accent: std({ color: 0x2f7de1, roughness: 0.42, metalness: 0.2 }),
      cast: std({ color: 0x59616a, roughness: 0.62, metalness: 0.3, map: T.castColor }),
      castDark: std({ color: 0x3c4249, roughness: 0.6, metalness: 0.3, map: T.castColor }),
      rail: std({ color: 0xcfd4d9, roughness: 0.2, metalness: 1, roughnessMap: T.brushedRough }),
      table: std({ color: 0x8d949b, roughness: 0.34, metalness: 0.85, roughnessMap: T.groundRough }),
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
    // Enclosure plinth (sheet metal pan the machine sits in), kept just inside the cabinet walls so
    // its faces never share a plane with them.
    this.bx(-1028, 0, -1128, 1028, 130, 738, M.paintDark, B);
    // Base casting with chamfered top; the wider foot band is a few mm proud at the ends as well so
    // the two castings don't z-fight on the front and back faces.
    this.bx(-430, 130, -1000, 430, 690, 620, M.cast, B, 14);
    this.bx(-470, 130, -1004, 470, 300, 624, M.castDark, B, 10);
    // rib pockets on the base sides
    for (let z = -820; z <= 500; z += 220) {
      this.bx(-436, 330, z, -428, 650, z + 140, M.castDark, B);
      this.bx(428, 330, z, 436, 650, z + 140, M.castDark, B);
    }
    // ground mounting pads for the Y rails (they run from the column foot to the base front)
    for (const x of [-300, 300]) this.bx(x - 32, 690, -446, x + 32, 700, 600, M.castDark, B);
    // Y linear rails (profile rails with a groove)
    for (const x of [-300, 300]) {
      this.bx(x - 17, 700, -446, x + 17, 730, 590, M.rail, B);
      this.bx(x - 18, 712, -446, x + 18, 716, 590, M.castDark, B);
    }
    // Y ball screw bearing blocks, low enough to pass under the way covers; motor on the back of the base
    this.bx(-55, 690, -446, 55, 734, -418, M.cast, B, 6);
    this.bx(-55, 690, 578, 55, 732, 612, M.cast, B, 6);
    // end plate the front way cover is bolted to (closes the gap under the raised cover end)
    this.bx(-376, 690, 612, 376, 772, 624, M.castDark, B, 3);
    this.bx(-70, 560, -1110, 70, 680, -1004, M.black, B, 8);
    this.cyl(26, 16, M.black, 0, 620, -1118, B, 'z', 16);
    // chip augers along the base sides (inside the enclosure trough)
    for (const x of [-500, 500]) this.cyl(60, 1500, M.interior, x, 470, -180, B, 'z', 20);
    // Y screw (rotates)
    this.yScrew = this.makeScrew(16, 1036, 'z');
    this.yScrew.position.set(0, 718, 80);
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

  // ---------- column with Z rails and Z screw
  buildColumn() {
    const B = this.base;
    const M = this.M;
    this.bx(-330, 690, -1000, 330, 2480, -450, M.cast, B, 18);
    // flared foot: 4 mm proud of the column front/back so the faces don't share a plane. The rear
    // way cover slides into a wiper slot in its front face.
    this.bx(-420, 690, -1004, 420, 860, -446, M.cast, B, 14);
    this.bx(-384, 694, -449, 384, 772, -445, M.rubber, B);
    // side ribs / lightening pockets (kept below the column top)
    for (let y = 950; y < 2350; y += 330) {
      const y1 = Math.min(y + 240, 2440);
      this.bx(-336, y, -930, -326, y1, -520, M.castDark, B);
      this.bx(326, y, -930, 336, y1, -520, M.castDark, B);
    }
    // rail pads and Z rails
    this.bx(-250, 950, -455, 250, 2470, -440, M.castDark, B);
    for (const x of [-170, 170]) {
      this.bx(x - 16, 960, -440, x + 16, 2460, -412, M.rail, B);
      this.bx(x - 17, 960, -428, x + 17, 2460, -424, M.castDark, B);
    }
    // Z screw supports, motor on top
    this.bx(-50, 1000, -445, 50, 1050, -380, M.cast, B, 6);
    this.bx(-50, 2400, -445, 50, 2470, -380, M.cast, B, 6);
    // Z servo motor on top of the column (clear of the cabinet roof at y 2680)
    this.bx(-75, 2480, -500, 75, 2655, -360, M.black, B, 10);
    this.cyl(30, 40, M.black, 0, 2568, -340, B, 'z', 16);
    this.zScrew = this.makeScrew(16, 1360, 'y');
    this.zScrew.position.set(0, 1730, -408);
    B.add(this.zScrew);
    // counterbalance / cable carrier housing on the column side
    this.bx(330, 1100, -760, 380, 2380, -620, M.paintDark, B, 8);
  }

  // ---------- saddle (Y axis)
  buildSaddle() {
    const S = new THREE.Group();
    S.name = 'saddle';
    this.saddle = S;
    this.root.add(S);
    const M = this.M;
    // Saddle casting. It is 440 deep so that at the back of the Y travel (saddle at z -205) it stops
    // short of the column foot (front face z -446), and 860 wide so the X rails can carry the table
    // carriages over the full X travel.
    this.bx(-430, 752, -220, 430, 846, 220, M.cast, S, 12);
    this.bx(-436, 770, -200, 436, 828, 200, M.castDark, S, 6);
    // Y carriages (stay on the Y rails, z -446..590, over the whole travel)
    for (const x of [-300, 300]) for (const z of [-160, 160]) this.bx(x - 38, 718, z - 50, x + 38, 754, z + 50, M.rail, S, 3);
    // Y ball nut housing
    this.bx(-55, 696, -60, 55, 752, 60, M.castDark, S, 6);
    // X rails
    for (const z of [-125, 125]) {
      this.bx(-430, 846, z - 15, 430, 872, z + 15, M.rail, S);
      this.bx(-430, 856, z - 16, 430, 860, z + 16, M.castDark, S);
    }
    // X ball screw sits low between the rails, under the table (table underside is y 870). Bearing
    // blocks at the saddle ends and the servo motor on the right end face all stay below y 870, so the
    // table can travel over them.
    this.bx(-428, 846, -28, -396, 867, 28, M.cast, S, 4);
    this.bx(396, 846, -28, 428, 867, 28, M.cast, S, 4);
    this.bx(436, 772, -52, 586, 864, 52, M.black, S, 8);
    this.bx(430, 790, -40, 438, 850, 40, M.castDark, S); // motor flange
    this.cyl(22, 24, M.black, 598, 818, 0, S, 'x', 16);
    this.bx(496, 790, 52, 546, 830, 70, M.black, S, 4); // connector
    this.cyl(9, 40, M.orange, 521, 810, 88, S, 'z', 10);
    this.cyl(9, 70, M.orange, 521, 773, 106, S, 'y', 10);
    this.xScrew = this.makeScrew(10, 820, 'x');
    this.xScrew.position.set(0, 858, 0);
    S.add(this.xScrew);
    // Telescopic way covers (front: saddle -> base front; rear: column -> saddle)
    this.covers = new THREE.Group();
    this.covers.name = 'covers';
    this.root.add(this.covers);
    // Front: 6 x 112 (compressed 112, saddle front gap is 195..605). Rear: 5 x 180, fixed inside the
    // column foot so it can retract into the wiper slot (gap 375..785 from that anchor).
    this.frontCover = this.makeCover(6, 112, -1);
    this.rearCover = this.makeCover(5, 180, 1);
  }

  // dir: which way the cover extends from its fixed end (+1 = towards +Z).
  makeCover(n, segLen, dir) {
    // Sections nest: each one is a little narrower and lower than the one before. They are narrower
    // than the base top (x +-430) and their skirts stop above it (y 690).
    const secs = [];
    for (let k = 0; k < n; k++) {
      const w = 740 - k * 10;
      const g = new THREE.Group();
      const top = new THREE.Mesh(new THREE.BoxGeometry(w, 4, segLen), this.M.wayCover);
      top.position.y = 0;
      g.add(top);
      for (const s of [-1, 1]) {
        const side = new THREE.Mesh(new THREE.BoxGeometry(4, 42, segLen), this.M.wayCover);
        side.position.set((s * w) / 2, -21, 0);
        g.add(side);
      }
      // wiper lip on the end that faces the saddle, riding over the next (smaller) section
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
    // cross-section in (u = -z world, v = y above table bottom) with T-slots cut in the top
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
    const table = new THREE.Mesh(geo, M.table);
    Tg.add(table);
    // table underside, carriages, nut bracket
    this.bx(-tb.length / 2 + 20, 870, -hw + 20, tb.length / 2 - 20, TT - H, hw - 20, M.cast, Tg);
    // carriages close to the middle so they stay on the X rails (x +-430) at both ends of the travel
    for (const x of [-90, 90]) for (const z of [-125, 125]) this.bx(x - 50, 856, z - 34, x + 50, 878, z + 34, M.rail, Tg, 3);
    // ball nut bracket hanging round the X screw
    this.bx(-40, 849, -30, 40, 871, 30, M.castDark, Tg, 3);
    // end plates and chip guards
    for (const s of [-1, 1]) this.bx(s * (tb.length / 2) - 4, 870, -hw, s * (tb.length / 2) + 4, TT + 4, hw, M.paintDark, Tg);
    this.workGroup = new THREE.Group();
    this.workGroup.name = 'work';
    this.workGroup.position.y = TT;
    Tg.add(this.workGroup);
  }

  // ---------- spindle head (Z axis)
  buildHead() {
    const H = new THREE.Group();
    H.name = 'head';
    this.head = H;
    this.root.add(H);
    const M = this.M;
    // Z carriages
    for (const x of [-170, 170]) for (const y of [180, 560]) this.bx(x - 38, y, -412, x + 38, y + 110, -382, M.rail, H, 3);
    // back plate and body
    this.bx(-245, 130, -385, 245, 720, -335, M.cast, H, 10);
    this.bx(-165, 140, -340, 165, 660, 0, M.paint, H, 16);
    const nose = new THREE.Mesh(new THREE.CylinderGeometry(165, 165, 520, 48, 1, false, -Math.PI / 2, Math.PI), M.paint);
    nose.position.set(0, 400, 0);
    H.add(nose);
    // half-disc caps on the front (+Z) half of the rounded nose
    const capTop = new THREE.Mesh(new THREE.CircleGeometry(165, 48, Math.PI, Math.PI), M.paint);
    capTop.rotation.x = -Math.PI / 2;
    capTop.position.set(0, 660, 0);
    H.add(capTop);
    const capBot = new THREE.Mesh(new THREE.CircleGeometry(165, 48, 0, Math.PI), M.paint);
    capBot.rotation.x = Math.PI / 2;
    capBot.position.set(0, 140, 0);
    H.add(capBot);
    // accent band and name plate
    const band = new THREE.Mesh(new THREE.CylinderGeometry(166.5, 166.5, 26, 48, 1, true, -Math.PI / 2, Math.PI), M.accent);
    band.position.set(0, 600, 0);
    H.add(band);
    this.bx(-166.5, 587, -340, -164, 613, 0, M.accent, H);
    this.bx(164, 587, -340, 166.5, 613, 0, M.accent, H);
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(166.5, 166.5, 46, 24, 1, true, -0.62, 1.24), new THREE.MeshStandardMaterial({ map: labelTexture(['VMC-560'], { w: 512, h: 124, bg: '#24282d', fg: '#e9edf1', font: '700 70px "IBM Plex Sans Condensed", Arial', accent: '#2f7de1' }), roughness: 0.5, metalness: 0.3 }));
    plate.position.set(0, 470, 0);
    H.add(plate);
    // spindle cartridge: narrow nose, lower housing, upper housing
    this.cyl(112, 60, M.paintDark, 0, 125, 0, H, 'y', 48);
    this.cyl(86, 80, M.castDark, 0, 60, 0, H, 'y', 48);
    this.cyl(80, 20, M.chrome, 0, 10, 0, H, 'y', 48);
    // coolant ring with nozzles
    const ring = new THREE.Mesh(new THREE.TorusGeometry(92, 6, 10, 48), M.chrome);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 42;
    H.add(ring);
    // spindle motor on top with cooling fins
    this.cyl(118, 250, M.black, 0, 790, -60, H, 'y', 40);
    const fin = new THREE.BoxGeometry(14, 230, 3);
    const fins = new THREE.InstancedMesh(fin, M.black, 28);
    const mm = new THREE.Matrix4();
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2;
      mm.makeRotationY(-a);
      mm.setPosition(Math.cos(a) * 124, 790, -60 + Math.sin(a) * 124);
      fins.setMatrixAt(i, mm);
    }
    H.add(fins);
    this.cyl(105, 22, M.paintDark, 0, 926, -60, H, 'y', 40);
    this.bx(-45, 870, -250, 45, 950, -175, M.black, H, 6);
    // short cable tail (stays under the cabinet roof when the head lifts for a tool change)
    this.cyl(10, 140, M.orange, 30, 950, -260, H, 'y', 10);
    // rotor (rotates) - spindle face with drive keys; tool models are added to it
    this.rotor = new THREE.Group();
    this.rotor.name = 'rotor';
    H.add(this.rotor);
    const face = new THREE.Mesh(new THREE.CylinderGeometry(58, 58, 4, 40), M.chrome);
    face.position.y = -1;
    this.rotor.add(face);
    for (const s of [-1, 1]) this.bx(s * 46 - 7, -6, -8, s * 46 + 7, 0, 8, M.castDark, this.rotor);
    // Loc-Line coolant hoses aimed at the cutter. They hang on the +X side of the spindle, away from
    // the tool changer that swings in from -X, so the carousel and pocket tools never pass through them.
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

  // ---------- umbrella tool changer
  buildATC() {
    const M = this.M;
    const A = new THREE.Group();
    A.name = 'atc';
    this.root.add(A);
    // support beam from the column to the slide rail
    this.bx(-940, 1800, -540, -330, 1860, -470, M.cast, this.base, 6);
    this.bx(-940, 1760, -540, -880, 1860, 60, M.cast, this.base, 6);
    this.bx(-950, 1840, -40, -220, 1880, 40, M.rail, this.base, 3);
    // carriage + carousel move together
    this.atcSlide = new THREE.Group();
    A.add(this.atcSlide);
    this.bx(-90, 1800, -55, 90, 1846, 55, M.paintDark, this.atcSlide, 6);
    this.cyl(30, 280, M.chrome, 0, 1665, 0, this.atcSlide, 'y', 20);
    // pneumatic slide cylinder (body fixed inside the cabinet, rod follows the carriage)
    this.cyl(26, 140, M.paintDark, -950, 1905, 0, this.base, 'x', 16);
    this.bx(-1000, 1840, -22, -950, 1882, 22, M.cast, this.base, 3); // cylinder mount on the rail end
    this.atcRod = this.cyl(8, 1, M.chrome, 0, 1905, 0, this.root, 'x', 10);
    this.atcRod.userData.keep = true;
    this.bx(-30, 1846, -20, 30, 1920, 20, M.paintDark, this.atcSlide);
    this.carousel = new THREE.Group();
    this.carousel.position.y = GAUGE0;
    this.atcSlide.add(this.carousel);
    const R = ATC_GEOM.pitchR;
    // Disc stops 40 mm short of the pocket centres so it clears the BT40 flanges (r 31.75), and sits
    // below the spindle face and drive keys (y >= -6) when a pocket is under the spindle.
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(R - 40, R - 40, 12, 64), M.paintDark);
    disc.position.y = -14;
    this.carousel.add(disc);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(120, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), M.paint);
    dome.position.y = -8;
    dome.scale.y = 0.9;
    this.carousel.add(dome);
    const label = new THREE.Mesh(new THREE.CylinderGeometry(121, 121, 18, 48, 1, true), M.accent);
    label.position.y = 1;
    this.carousel.add(label);
    this.pockets = [];
    const P = MACHINE.atcPockets;
    // fork prongs sit in the flange V-groove (y -1..-12, r >= 27.5) without cutting into the flange
    const prong = new THREE.BoxGeometry(40, 6, 15);
    const numMat = new Map();
    for (let k = 1; k <= P; k++) {
      const a = ((k - 1) / P) * Math.PI * 2;
      const pocket = new THREE.Group();
      pocket.position.set(Math.cos(a) * R, 0, -Math.sin(a) * R);
      pocket.rotation.y = a;
      // fork: two prongs either side of the holder flange
      for (const s of [-1, 1]) {
        const p = new THREE.Mesh(prong, M.chrome);
        p.position.set(-16, -6.5, s * 37.5);
        pocket.add(p);
      }
      const back = new THREE.Mesh(new THREE.BoxGeometry(12, 10, 90), M.paintDark);
      back.position.set(-42, -12, 0);
      pocket.add(back);
      // pocket number tag
      const tex = labelTexture([String(k)], { w: 64, h: 64, bg: '#2f7de1', fg: '#ffffff', font: '700 44px Arial' });
      numMat.set(k, tex);
      // number tag lying on the disc top, inboard of the pocket
      const tag = new THREE.Mesh(new THREE.PlaneGeometry(22, 22), new THREE.MeshBasicMaterial({ map: tex }));
      tag.position.set(-72, -7.7, 0);
      tag.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
      pocket.add(tag);
      this.carousel.add(pocket);
      this.pockets[k] = pocket;
    }
  }

  // ---------- enclosure sheet metal
  buildEnclosure() {
    const E = this.enclosure;
    const M = this.M;
    const S = new THREE.Group();
    this.encStatic = S;
    E.add(S);
    const X = 1050, ZB = -1150, ZF = 760, YT = 2700;
    // front lower skirt with kick plate
    this.bx(-X, 130, ZF - 20, X, 1000, ZF, M.paint, S);
    // kick plate and door sill run 2 mm past the side walls so their ends don't share a plane with them
    this.bx(-X - 2, 0, ZF - 20, X + 2, 130, ZF + 4, M.paintDark, S);
    this.bx(-X - 2, 985, ZF - 20, X + 2, 1000, ZF + 60, M.paintDark, S); // door sill
    // fixed side panels at the front
    this.bx(-X, 1000, ZF - 20, -620, 2350, ZF, M.paint, S);
    this.bx(620, 1000, ZF - 20, X, 2350, ZF, M.paint, S);
    // header
    this.bx(-X, 2350, ZF - 20, X, YT, ZF, M.paint, S);
    this.bx(-X, 2350, ZF, X, 2380, ZF + 70, M.paintDark, S); // door track
    this.bx(-X, 2560, ZF, X, 2590, ZF + 3, M.accent, S);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(620, 104), new THREE.MeshStandardMaterial({ map: labelTexture(['VMC-560   VERTICAL MACHINING CENTRE'], { w: 1024, h: 172, bg: '#d9dcdf', fg: '#24282d', font: '700 64px "IBM Plex Sans Condensed", Arial' }), roughness: 0.6 }));
    sign.position.set(-560, 2470, ZF + 1);
    S.add(sign);
    const warn = new THREE.Mesh(new THREE.PlaneGeometry(220, 110), new THREE.MeshStandardMaterial({ map: labelTexture(['CAUTION', 'CLOSE DOORS BEFORE', 'CYCLE START'], { w: 440, h: 220, bg: '#e8b21a', fg: '#16171a', font: '700 36px Arial', border: '#16171a' }), roughness: 0.6 }));
    warn.position.set(840, 2160, ZF + 1);
    S.add(warn);
    // side walls with windows
    for (const s of [-1, 1]) {
      const x = s * X;
      const x0 = x - (s > 0 ? 20 : 0), x1 = x + (s > 0 ? 0 : 20);
      this.bx(x0, 0, ZB, x1, 1250, ZF, M.paint, S);
      this.bx(x0, 2250, ZB, x1, YT, ZF, M.paint, S);
      this.bx(x0, 1250, ZB, x1, 2250, -560, M.paint, S);
      this.bx(x0, 1250, 380, x1, 2250, ZF, M.paint, S);
      const glass = new THREE.Mesh(new THREE.BoxGeometry(6, 1000, 940), M.glass);
      glass.position.set(x - s * 10, 1750, -90);
      glass.userData.shadow = false;
      E.add(glass);
      this.bx(x - 12, 1240, -570, x + 12, 1260, 390, M.paintDark, S);
      this.bx(x - 12, 2240, -570, x + 12, 2260, 390, M.paintDark, S);
    }
    // back wall and roof
    this.bx(-X, 0, ZB, X, YT, ZB + 20, M.paint, S);
    this.bx(-X, YT - 20, ZB, X, YT, ZF, M.paint, S);
    // interior chip slopes and trough
    // sloped guards from the walls (high) down to the auger troughs (low)
    const slope = (xWall, xTrough) => {
      const run = Math.abs(xTrough - xWall);
      const len = Math.hypot(run, 360);
      const m = new THREE.Mesh(new THREE.BoxGeometry(len, 6, 1850), M.interior);
      m.position.set((xWall + xTrough) / 2, 820, -200);
      m.rotation.z = (xWall < xTrough ? -1 : 1) * Math.atan2(360, run);
      S.add(m);
    };
    slope(-1030, -540);
    slope(1030, 540);
    // front chip guard: from the base front edge (z 620, just above the way cover's fixed end) up to
    // the inside of the front skirt under the door sill (z 738, y 982)
    {
      const z0 = 626, y0 = 692, z1 = 738, y1 = 982;
      const len = Math.hypot(z1 - z0, y1 - y0);
      const fr = new THREE.Mesh(new THREE.BoxGeometry(2060, 6, len), M.interior);
      fr.position.set(0, (y0 + y1) / 2, (z0 + z1) / 2);
      fr.rotation.x = -Math.atan2(y1 - y0, z1 - z0);
      S.add(fr);
    }
    this.bx(-1030, 560, -1130, -540, 566, 740, M.interior, S);
    this.bx(540, 560, -1130, 1030, 566, 740, M.interior, S);
  }

  buildDoors() {
    const M = this.M;
    this.doors = [];
    for (const s of [-1, 1]) {
      const d = new THREE.Group();
      d.name = s < 0 ? 'doorL' : 'doorR';
      const w = 640, h = 1350;
      const z = s < 0 ? 780 : 812;
      const F = new THREE.Group();
      d.add(F);
      this.bx(-w / 2, 0, -12, w / 2, 70, 12, M.paint, F);
      this.bx(-w / 2, h - 90, -12, w / 2, h, 12, M.paint, F);
      this.bx(-w / 2, 0, -12, -w / 2 + 70, h, 12, M.paint, F);
      this.bx(w / 2 - 70, 0, -12, w / 2, h, 12, M.paint, F);
      this.bx(-w / 2 + 70, 68, -14, w / 2 - 70, 76, 14, M.rubber, F);
      this.bx(-w / 2 + 70, h - 96, -14, w / 2 - 70, h - 88, 14, M.rubber, F);
      const glass = new THREE.Mesh(new THREE.BoxGeometry(w - 140, h - 160, 8), M.glass);
      glass.position.set(0, h / 2 - 10, 0);
      glass.userData.shadow = false;
      d.add(glass);
      // handle bar near the meeting edge
      const hx = -s * (w / 2 - 40);
      const handle = this.bx(hx - 14, 520, 14, hx + 14, 920, 44, M.chrome, d, 10);
      handle.userData.action = 'door';
      handle.userData.keep = true;
      this.clickables.push(handle);
      // rollers at the top
      for (const rx of [-w / 2 + 90, w / 2 - 90]) this.cyl(20, 22, M.black, rx, h + 15, 0, d, 'z', 14);
      d.position.set(s * (w / 2 - 10), 1000, z);
      d.userData.closedX = s * (w / 2 - 10);
      // open travel keeps the door (and its rollers) on the track, inside the cabinet width
      d.userData.openX = s * (w / 2 - 10) + s * 420;
      this.enclosure.add(d);
      this.doors.push(d);
    }
  }

  // ---------- control pendant
  buildPendant() {
    const M = this.M;
    const c0 = this.clickables.length;
    const P = new THREE.Group();
    P.name = 'pendant';
    this.pendant = P;
    this.root.add(P);
    // arm from the header
    // bracket sits above the door track and door rollers (y <= 2385)
    this.cyl(26, 440, M.paintDark, 990, 2170, 952, this.root, 'y', 16);
    this.bx(940, 2388, 760, 1040, 2440, 990, M.paintDark, this.root, 8);
    const body = new THREE.Group();
    body.position.set(990, 1630, 990);
    body.rotation.set(-0.12, -0.32, 0);
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
    body.position.set(990, 1630, 990);
    body.rotation.set(-0.12, -0.32, 0);
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
    lab('VMC-MINI', -205, 312, 100, '#33373b');
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
    // beacon on top
    this.bx(196, 340, -18, 244, 352, 18, M.paintDark, body, 3);
    this.haasBeaconMat = new THREE.MeshStandardMaterial({ color: 0xe8ecef, emissive: 0x000000, transparent: true, opacity: 0.85, roughness: 0.25 });
    this.cyl(18, 46, this.haasBeaconMat, 220, 376, 0, body, 'y', 20).userData.keep = true;
    this.pHaas = { body, canvas: cv, tex, click };
  }

  setControlStyle(style) {
    const haas = style === 'haas';
    if (this.controlStyle === style) return;
    this.controlStyle = style;
    const on = haas ? this.pHaas : this.p808, off = haas ? this.p808 : this.pHaas;
    on.body.visible = true;
    off.body.visible = false;
    this.pendantBody = on.body;
    this.screenCanvas = on.canvas;
    this.screenTex = on.tex;
    this.clickables = [...this.clickBase, ...on.click];
  }

  buildStackLight() {
    const g = new THREE.Group();
    g.position.set(900, 2700, 600);
    this.root.add(g);
    this.cyl(14, 120, this.M.paintDark, 0, 60, 0, g, 'y', 12);
    this.stack = {};
    const colors = { green: 0x23c45e, amber: 0xffa21a, red: 0xff2a2a };
    let y = 150;
    for (const k of ['green', 'amber', 'red']) {
      const m = new THREE.MeshStandardMaterial({ color: colors[k], emissive: colors[k], emissiveIntensity: 0, transparent: true, opacity: 0.85, roughness: 0.2 });
      const c = this.cyl(42, 66, m, 0, y, 0, g, 'y', 24);
      c.userData.keep = true;
      this.stack[k] = m;
      y += 70;
    }
    this.cyl(44, 10, this.M.paintDark, 0, y - 32, 0, g, 'y', 24);
  }

  buildLights() {
    // LED light bar inside the enclosure roof + work light
    const barMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xf4f8ff, emissiveIntensity: 1.6, roughness: 0.3 });
    this.ledMat = barMat;
    const bar = this.bx(-760, 2655, 540, 760, 2672, 600, barMat, this.enclosure);
    bar.userData.keep = true;
    bar.userData.cast = false;
    this.bx(-780, 2672, 520, 780, 2682, 620, this.M.paintDark, this.encStatic);
    const spot = new THREE.SpotLight(0xf3f6ff, 2.1, 0, 0.62, 0.55, 0);
    spot.position.set(0, 2640, 560);
    spot.target.position.set(-80, 930, -60);
    spot.castShadow = true;
    spot.shadow.mapSize.set(1024, 1024);
    spot.shadow.camera.near = 800;
    spot.shadow.camera.far = 2600;
    spot.shadow.bias = -0.0004;
    spot.shadow.normalBias = 0.6;
    this.root.add(spot, spot.target);
    this.workLight = spot;
    const fill = new THREE.PointLight(0xdfe8ff, 0.5, 0, 0);
    fill.position.set(-600, 2300, -300);
    this.root.add(fill);
    this.fillLight = fill;
  }

  buildExtras() {
    // Things you see when you orbit round the back: electrical cabinet, coolant tank, chip conveyor.
    const M = this.M;
    const X = new THREE.Group();
    this.extras = X;
    this.root.add(X);
    this.bx(-700, 300, -1420, 300, 2300, -1150, M.paint, X, 10);
    this.bx(-690, 1500, -1424, -560, 2200, -1418, M.paintDark, X);
    this.bx(-200, 2000, -1424, 200, 2200, -1418, M.accent, X);
    this.bx(450, 0, -1500, 1000, 650, -1170, M.paintDark, X, 10);
    this.cyl(70, 180, M.black, 720, 740, -1330, X, 'y', 20);
    // chip conveyor out of the right side into a bin
    const conv = new THREE.Mesh(new THREE.BoxGeometry(900, 160, 320), M.paintDark);
    conv.position.set(1380, 760, -300);
    conv.rotation.z = 0.62;
    X.add(conv);
    this.bx(1600, 0, -520, 2000, 650, -80, M.castDark, X, 12);
    // lubrication unit on the left wall
    this.bx(-1110, 1100, -700, -1050, 1400, -500, M.paint, X, 6);
    this.cyl(35, 220, new THREE.MeshStandardMaterial({ color: 0xd8c27a, transparent: false, roughness: 0.3 }), -1085, 1240, -600, X, 'y', 16);
    const hz = hazardTexture();
    hz.repeat.set(10, 1);
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(2100, 40), new THREE.MeshStandardMaterial({ map: hz, roughness: 0.6 }));
    strip.position.set(0, 110, 766);
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
    this.layoutCover(this.frontCover, 620, sz + 220);
    this.layoutCover(this.rearCover, -800, sz - 220);
    // doors
    for (const d of this.doors) d.position.x = d.userData.closedX + (d.userData.openX - d.userData.closedX) * (s.door || 0);
    // tool changer
    const slide = s.atcSlide || 0;
    this.atcSlide.position.x = ATC_GEOM.retractedX + (ATC_GEOM.engagedX - ATC_GEOM.retractedX) * slide;
    const rodA = -880, rodB = this.atcSlide.position.x;
    this.atcRod.position.x = (rodA + rodB) / 2;
    this.atcRod.scale.x = rodB - rodA;
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
