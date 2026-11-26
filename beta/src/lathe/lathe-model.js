// Generic toolroom engine lathe (330 mm swing x 1000 mm between centres), built from primitives in
// millimetres. World frame = the app's (x right, y up, z toward the operator). The lathe stands at the
// origin: spindle axis along world X at height CENTER_Y, headstock on the left (-X), tailstock on the
// right (+X), operator at +Z.
//   Lathe Z = world X from the chuck jaw face (CHUCK_FACE_X); lathe X = radius = world Z of the tool tip.
//
// Articulated groups: spinGroup (chuck+jaws+stock), carriage -> crossGroup (cross slide) -> compoundRot
// -> compSlide -> postGroup (4-way tool post), tailstock -> quillGroup, guard, handwheels, levers, rods.
// Everything static is merged per material (draw calls stay modest).
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { dialTexture, threadDialTexture, angleRingTexture, quillScaleTexture, leadscrewTexture, keywayTexture, plateAtlas } from './lathe-textures.js';

export const CENTER_Y = 1100; // spindle centreline height
export const CHUCK_FACE_X = -600; // world X of Z0 (chuck jaw face)
export const LATHE_COLLIDERS = [{ minX: -1000, maxX: 985, minZ: -265, maxZ: 300 }]; // bed, stand, apron/handwheels
export const TIP_REACH = 68; // tool tip distance from the tool post centre
export const TAIL_GEOM = { faceToBodyX: 100, bedTop: 914, quillStroke: 100 };
export const LATHE_DIMS = { bedX0: -980, bedX1: 960, bedTopY: 914, wayZ: 100 };
const D2R = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

// Merge the direct mesh children of `group` that share a material (leaves child groups alone).
function flat(group) {
  const byMat = new Map();
  const remove = [];
  for (const o of group.children) {
    if (!o.isMesh || o.userData.keep || o.material.transparent || Array.isArray(o.material)) continue;
    o.updateMatrix();
    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    g.clearGroups();
    g.applyMatrix4(o.matrix);
    if (!byMat.has(o.material)) byMat.set(o.material, []);
    byMat.get(o.material).push(g);
    remove.push(o);
  }
  for (const o of remove) { group.remove(o); o.geometry.dispose(); }
  for (const [mat, list] of byMat) {
    const merged = mergeGeometries(list, false);
    list.forEach((g) => g.dispose());
    if (merged) group.add(new THREE.Mesh(merged, mat));
  }
}

export class LatheModel {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'lathe';
    this.clickables = [];
    this.stockGroup = new THREE.Group();
    this.stockGroup.name = 'lathe-stock';
    this._spin = 0;
    this._lead = 0;
    this._feed = 0;
    this._t = performance.now();
    this._tailKey = '';
    this.state = {};
    this.makeMaterials();
    this.buildFloorStand();
    this.buildBed();
    this.buildHeadstock();
    this.buildGearbox();
    this.buildSpindle();
    this.buildGuard();
    this.buildRods();
    this.buildCarriage();
    this.buildTailstock();
    this.buildExtras();
    this.root.traverse((o) => {
      if (o.isMesh && o.userData.noShadow !== true && !o.material.transparent && o.material.visible !== false) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.update({});
  }

  // ------------------------------------------------------------------ helpers
  makeMaterials() {
    const std = (o) => new THREE.MeshStandardMaterial(o);
    const atlas = plateAtlas();
    this.atlas = atlas;
    const lead = leadscrewTexture();
    const key = keywayTexture();
    this.M = {
      paint: std({ color: 0xa9b9ad, roughness: 0.5, metalness: 0.12, envMapIntensity: 0.8 }),
      paintDark: std({ color: 0x70857a, roughness: 0.55, metalness: 0.12, envMapIntensity: 0.7 }),
      cream: std({ color: 0xded9c6, roughness: 0.5, metalness: 0.08, envMapIntensity: 0.8 }),
      cast: std({ color: 0x5b636a, roughness: 0.58, metalness: 0.35 }),
      ground: std({ color: 0x9aa1a7, roughness: 0.26, metalness: 0.9 }),
      steel: std({ color: 0xc4cad0, roughness: 0.3, metalness: 0.9 }),
      chrome: std({ color: 0xdde2e6, roughness: 0.12, metalness: 1 }),
      black: std({ color: 0x17191c, roughness: 0.45, metalness: 0.45 }),
      chuckBody: std({ color: 0x2b2f34, roughness: 0.4, metalness: 0.8 }),
      rubber: std({ color: 0x121315, roughness: 0.92, metalness: 0 }),
      red: std({ color: 0xc8191e, roughness: 0.35, metalness: 0.1 }),
      yellow: std({ color: 0xe8b21a, roughness: 0.5, metalness: 0.1 }),
      carbide: std({ color: 0xc9a43a, roughness: 0.3, metalness: 0.8 }),
      toolSteel: std({ color: 0x6c737a, roughness: 0.35, metalness: 0.85 }),
      green: std({ color: 0x1f9a4a, roughness: 0.35, metalness: 0.1 }),
      // one dial per handwheel, graduated like the panel dials (lathe-sim GRAD)
      dial: std({ color: 0xffffff, map: dialTexture(100, 10), roughness: 0.4, metalness: 0.6, side: THREE.DoubleSide }),
      dialCarriage: std({ color: 0xffffff, map: dialTexture(250, 25, 2), roughness: 0.4, metalness: 0.6, side: THREE.DoubleSide }),
      dialCross: std({ color: 0xffffff, map: dialTexture(200, 20), roughness: 0.4, metalness: 0.6, side: THREE.DoubleSide }),
      ring: std({ color: 0xffffff, map: angleRingTexture(), roughness: 0.4, metalness: 0.5, transparent: true, alphaTest: 0.3 }),
      plate: std({ color: 0xffffff, map: atlas.texture, roughness: 0.5, metalness: 0.2, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      quill: std({ color: 0xffffff, map: quillScaleTexture(), roughness: 0.3, metalness: 0.85 }),
      leadscrew: std({ color: 0xffffff, map: lead, roughness: 0.35, metalness: 0.85 }),
      feedrod: std({ color: 0xffffff, map: key, roughness: 0.3, metalness: 0.9 }),
      coolantMat: new THREE.MeshStandardMaterial({ color: 0x9fd0ff, roughness: 0.1, transparent: true, opacity: 0.45, depthWrite: false }),
      glass: new THREE.MeshPhysicalMaterial({ color: 0xc6d4de, roughness: 0.06, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide, clearcoat: 1, envMapIntensity: 1.2 }),
      lamp: new THREE.MeshStandardMaterial({ color: 0xfff4d0, emissive: 0xffe8a0, emissiveIntensity: 1.4, roughness: 0.4 }),
      pick: new THREE.MeshBasicMaterial({ visible: false }),
    };
    this.M.glass.userData.noShadow = true;
    this.M.coolantMat.userData.noShadow = true;
  }

  box(w, h, d, mat, x, y, z, parent, round = 0) {
    const g = round > 0 ? new RoundedBoxGeometry(w, h, d, 2, round) : new THREE.BoxGeometry(w, h, d);
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }
  bx(x0, y0, z0, x1, y1, z1, mat, parent, round = 0) {
    return this.box(x1 - x0, y1 - y0, z1 - z0, mat, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, parent, round);
  }
  cyl(r, h, mat, x, y, z, parent, axis = 'y', segs = 28, r2 = r) {
    const g = new THREE.CylinderGeometry(r, r2, h, segs);
    if (axis === 'x') g.rotateZ(Math.PI / 2);
    if (axis === 'z') g.rotateX(Math.PI / 2);
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }
  sph(r, mat, x, y, z, parent, segs = 14) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, segs, segs - 4), mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }
  // profile in (z, y) extruded along world x from x0 to x1
  prism(pts, x0, x1, mat, parent) {
    const sh = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y)));
    const g = new THREE.ExtrudeGeometry(sh, { depth: x1 - x0, bevelEnabled: false });
    g.rotateY(-Math.PI / 2);
    g.translate(x1, 0, 0);
    const m = new THREE.Mesh(g, mat);
    parent.add(m);
    return m;
  }
  plate(name, w, parent, x, y, z, ry = 0) {
    const [sw, sh] = this.atlas.size(name);
    const h = (w * sh) / sw;
    const g = new THREE.PlaneGeometry(w, h);
    const [u0, v0, u1, v1] = this.atlas.uv(name);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) < 0.5 ? u0 : u1, uv.getY(i) < 0.5 ? v0 : v1);
    g.rotateY(ry);
    const m = new THREE.Mesh(g, this.M.plate);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }
  // move the meshes of a temporary rotated group into `parent` with the rotation baked in
  bake(tmp, parent) {
    tmp.updateMatrix();
    for (const m of [...tmp.children]) {
      if (!m.isMesh) continue;
      m.applyMatrix4(tmp.matrix);
      parent.add(m);
    }
  }
  pickSphere(parent, x, y, z, r) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 6, 4), this.M.pick);
    m.position.set(x, y, z);
    m.userData.keep = true;
    m.userData.noShadow = true;
    parent.add(m);
    return m;
  }
  click(obj, action) {
    obj.userData.action = action;
    this.clickables.push({ object: obj, action });
  }
  group(name, parent, x = 0, y = 0, z = 0) {
    const g = new THREE.Group();
    g.name = name;
    g.position.set(x, y, z);
    parent.add(g);
    return g;
  }

  // Handwheel with chrome rim, black spokes, spinner handle and a graduated dial. Axis = local +z.
  handwheel(parent, name, x, y, z, { r = 85, dialR = 46, handle = true, hubR = 22, spokes = 3, dialMat = null } = {}) {
    const M = this.M;
    const g = this.group(name, parent, x, y, z);
    const dial = this.group(name + '-dial', g, 0, 0, 34);
    // graduated cone band
    const band = new THREE.Mesh(new THREE.CylinderGeometry(dialR - 9, dialR, 16, 64, 1, true), dialMat || M.dial);
    band.geometry.rotateX(Math.PI / 2);
    band.position.z = 8;
    dial.add(band);
    this.cyl(dialR - 8.5, 1, M.chrome, 0, 0, 16, dial, 'z', 40);
    this.cyl(dialR + 1, 3, M.black, 0, 0, 1.5, dial, 'z', 40);
    this.cyl(7, 6, M.chrome, 0, 0, 19, dial, 'z', 12);
    flat(dial);
    // wheel body
    const zW = 14;
    this.cyl(hubR, 34, M.black, 0, 0, 17, g, 'z', 24);
    this.cyl(dialR - 6, 4, M.black, 0, 0, 36, g, 'z', 32);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(r, 6.5, 10, 48), M.chrome);
    rim.position.z = zW;
    g.add(rim);
    for (let i = 0; i < spokes; i++) {
      const a = (i / spokes) * Math.PI * 2 + Math.PI / 6;
      const sp = this.box(r - hubR + 4, 11, 9, M.black, 0, 0, 0, g, 2);
      sp.position.set(Math.cos(a) * (r + hubR) * 0.5, Math.sin(a) * (r + hubR) * 0.5, zW + 2);
      sp.rotation.z = a;
    }
    if (handle) {
      const hx = r - 14;
      this.cyl(7, 12, M.chrome, hx, 0, zW + 8, g, 'z', 12);
      this.cyl(3.5, 40, M.chrome, hx, 0, zW + 24, g, 'z', 10);
      const grip = this.cyl(8, 40, M.black, hx, 0, zW + 46, g, 'z', 14, 6);
      void grip;
    }
    this.pickSphere(g, 0, 0, zW, r + 8);
    flat(g);
    // fixed index: a stationary collar behind the dial with a red pointer at the top (12 o'clock)
    const ix = this.group(name + '-index', parent, x, y, z);
    const col = new THREE.Mesh(new THREE.TorusGeometry(dialR + 2.5, 2.2, 6, 48), M.paintDark);
    col.position.z = 33;
    ix.add(col);
    const ptr = new THREE.ExtrudeGeometry(new THREE.Shape([new THREE.Vector2(-4.5, dialR + 3), new THREE.Vector2(4.5, dialR + 3), new THREE.Vector2(0, dialR - 4)]), { depth: 8, bevelEnabled: false });
    ptr.translate(0, 0, 29);
    ix.add(new THREE.Mesh(ptr, M.red));
    flat(ix);
    return { group: g, dial };
  }

  // lever along +y with a ball end; returns the pivot group
  lever(parent, name, x, y, z, len, { ball = 11, mat = this.M.black, axis = 'y', rod = this.M.chrome } = {}) {
    const g = this.group(name, parent, x, y, z);
    const inner = this.group(name + '-m', g);
    this.cyl(6, len, rod, 0, len / 2, 0, inner, 'y', 10);
    this.cyl(10, 10, this.M.black, 0, 0, 0, inner, 'y', 14);
    this.sph(ball, mat, 0, len + ball * 0.5, 0, inner);
    if (axis === 'z') inner.rotation.x = Math.PI / 2; // lever points toward the operator
    this.pickSphere(g, 0, 0, 0, 0);
    flat(inner);
    return g;
  }

  // ------------------------------------------------------------------ cabinet, tray
  buildFloorStand() {
    const M = this.M;
    const g = this.group('stand', this.root);
    for (const [x0, x1] of [[-965, -470], [520, 945]]) {
      this.bx(x0, 30, -190, x1, 790, 190, M.paintDark, g, 3);
      this.bx(x0 - 6, 0, -196, x1 + 6, 30, 196, M.black, g); // plinth
      this.bx(x0 + 8, 40, 190, x0 + 16, 780, 193, M.black, g);
    }
    // doors with seams and handles on both stands
    for (const [xc, dw] of [[-717, 240], [732, 205]]) {
      for (const sgn of [-1, 1]) {
        const cx = xc + sgn * (dw / 2 + 1);
        this.bx(cx - dw / 2 + 4, 60, 190, cx + dw / 2 - 4, 770, 194, M.paint, g, 2);
        this.bx(cx - sgn * (dw / 2 - 26) - 3, 380, 194, cx - sgn * (dw / 2 - 26) + 3, 490, 202, M.chrome, g);
      }
    }
    // chip tray (under the bed between the stands) with a front lip, and a rear splash panel
    this.bx(-475, 520, -195, 525, 530, 232, M.cast, g);
    this.bx(-475, 530, 226, 525, 600, 234, M.cast, g);
    this.bx(-475, 530, -195, 525, 700, -189, M.cast, g);
    this.bx(-475, 530, -195, -469, 600, 232, M.cast, g);
    this.bx(519, 530, -195, 525, 600, 232, M.cast, g);
    for (let i = 0; i < 10; i++) this.bx(-440 + i * 100, 590, -190, -380 + i * 100, 594, 226, M.black, g); // grating
    // rear: motor + belt cover behind the left stand
    this.cyl(88, 270, M.paintDark, -820, 800, -240, g, 'x', 28);
    this.cyl(70, 40, M.black, -675, 800, -240, g, 'x', 24);
    this.bx(-960, 880, -230, -690, 905, -150, M.cast, g);
    // electrical cabinet (rear right of headstock end)
    this.bx(-950, 905, -178, -740, 1150, -155, M.paint, g, 2);
    // splash guard: clear screen behind the carriage and a metal top rail
    const glass = new THREE.Mesh(new THREE.BoxGeometry(1470, 260, 4), M.glass);
    glass.position.set(210, 1040, -150);
    g.add(glass);
    this.bx(-525, 1168, -154, 945, 1178, -146, M.steel, g);
    // levelling feet
    for (const x of [-940, -480, 540, 930]) for (const z of [-170, 170]) this.cyl(18, 14, M.black, x, 7, z, g, 'y', 12);
    // foot brake bar: along the front low down with a pedal on the right
    flat(g);
    this.brakeBar = this.group('brake', this.root, -480, 80, 238);
    this.bx(-380, -9, -9, 380, 9, 9, M.chrome, this.brakeBar);
    this.bx(380, -12, -14, 460, 4, 14, M.black, this.brakeBar, 2);
    for (const x of [-380, 380]) this.bx(x - 6, -20, -16, x + 6, 16, 0, M.cast, this.brakeBar);
    this.pickSphere(this.brakeBar, 420, -4, 0, 55);
    flat(this.brakeBar);
    this.click(this.brakeBar, 'brake');
  }

  // ------------------------------------------------------------------ bed with V-ways
  buildBed() {
    const M = this.M;
    const g = this.group('bed', this.root);
    const x0 = -980, x1 = 960;
    const pts = [[-140, 780], [140, 780], [140, 860], [118, 872], [112, 900], [98, 914], [62, 914], [50, 900], [30, 886], [-30, 886], [-50, 900], [-62, 914], [-98, 914], [-112, 900], [-118, 872], [-140, 860]];
    this.prism(pts, x0, x1, M.cast, g);
    // ground way tops (lighter)
    this.bx(x0 + 260, 913.5, 62, x1 - 20, 914.6, 98, M.ground, g);
    this.bx(x0 + 260, 913.5, -98, x1 - 20, 914.6, -62, M.ground, g);
    // rack under the front way and bed end casting / gap
    this.bx(x0 + 250, 846, 126, x1 - 30, 868, 134, M.steel, g);
    for (let x = x0 + 255; x < x1 - 35; x += 18) this.bx(x, 840, 126, x + 6, 846, 134, M.steel, g);
    this.bx(x1 - 10, 790, -130, x1 + 14, 905, 130, M.paint, g, 3);
    this.bx(x0 + 250, 780, -142, x0 + 262, 906, 142, M.paintDark, g);
    // oil cups on the bed face
    for (const x of [-350, 100, 550]) this.cyl(6, 12, M.carbide, x, 800, 142, g, 'z', 10);
    flat(g);
  }

  // ------------------------------------------------------------------ headstock
  buildHeadstock() {
    const M = this.M;
    const g = this.group('headstock', this.root);
    this.bx(-980, 895, -158, -700, 1272, 158, M.paint, g, 8);
    this.bx(-975, 1272, -150, -770, 1292, 100, M.cream, g, 6); // belt/gear lid
    this.cyl(26, 16, M.chrome, -840, 1300, -20, g, 'y', 20); // oil filler cap
    this.bx(-860, 1275, 105, -770, 1285, 150, M.black, g, 2);
    this.cyl(18, 6, M.glass, -735, 1090, 159, g, 'z', 20); // sight window rim
    // front face details: screws, panels
    this.bx(-965, 905, 158, -715, 1262, 162, M.paintDark, g, 4);
    for (const [x, y] of [[-955, 915], [-725, 915], [-955, 1250], [-725, 1250]]) this.cyl(6, 4, M.steel, x, y, 163, g, 'z', 8);
    this.plate('speeds', 220, g, -840, 1040, 162.5);
    this.plate('range', 105, g, -772, 1180, 162.5);
    this.plate('warnRotate', 62, g, -950, 1225, 162.5);
    this.plate('serial', 150, g, -840, 940, 162.5);
    // spindle bearing cap and nose
    this.cyl(98, 14, M.paintDark, -706, CENTER_Y, 0, g, 'x', 40);
    this.cyl(62, 16, M.chrome, -696, CENTER_Y, 0, g, 'x', 40);
    flat(g);
    // speed selector knob (rotates)
    const sel = this.group('speedSelector', g, -905, 1180, 162);
    this.selKnob = sel;
    this.cyl(40, 14, M.black, 0, 0, 7, sel, 'z', 32);
    this.cyl(34, 6, M.chrome, 0, 0, 16, sel, 'z', 32);
    this.bx(-5, 6, 16, 5, 38, 23, M.black, sel);
    this.cyl(10, 24, M.black, 0, 0, 28, sel, 'z', 14);
    this.pickSphere(sel, 0, 0, 20, 52);
    flat(sel);
    this.click(sel, 'speedSelector');
    // range lever (LOW/HIGH)
    this.rangeLever = this.lever(g, 'rangeLever', -772, 1160, 164, 50, { axis: 'y' });
    this.pickSphere(this.rangeLever, 0, 30, 0, 34);
    this.click(this.rangeLever, 'rangeLever');
    this.rangeLever.rotation.z = 0;
  }

  // ------------------------------------------------------------------ quick-change feed gearbox
  buildGearbox() {
    const M = this.M;
    const g = this.group('gearbox', this.root);
    this.bx(-975, 770, 140, -728, 900, 222, M.paint, g, 6);
    this.bx(-968, 778, 222, -735, 893, 227, M.paintDark, g, 3);
    this.plate('gearbox', 220, g, -851, 836, 227.8);
    for (const [x, y] of [[-960, 785], [-743, 785], [-960, 886], [-743, 886]]) this.cyl(5, 4, M.steel, x, y, 228, g, 'z', 8);
    flat(g);
    // three levers on the front: feed selector A-D, range I-II and feed/thread/off tumbler
    const defs = [['gearboxA', -936, 'A'], ['gearboxB', -851, 'B'], ['gearboxC', -766, 'C']];
    this.gbLevers = [];
    for (const [nm, x] of defs) {
      const bossG = this.group(nm, g, x, 790, 230);
      this.cyl(15, 8, M.black, 0, 0, 4, bossG, 'z', 20);
      this.cyl(9, 8, M.chrome, 0, 0, 10, bossG, 'z', 16);
      const l = this.lever(bossG, nm + '-l', 0, 0, 10, 36, { ball: 9, axis: 'z' });
      this.pickSphere(bossG, 0, 0, 40, 24);
      flat(bossG);
      this.gbLevers.push(l);
      this.click(bossG, nm);
    }
    // output stubs for leadscrew and feed rod come out of the right side (see buildRods)
  }

  // ------------------------------------------------------------------ spindle, chuck, jaws
  buildSpindle() {
    const M = this.M;
    this.spinGroup = this.group('spindle', this.root, 0, CENTER_Y, 0);
    const s = this.spinGroup;
    const x0 = -692, x1 = CHUCK_FACE_X, xf = x1 - 14; // body face is 14 mm behind the jaw faces (Z0)
    this.cyl(103, xf - x0 - 1.5, M.chuckBody, (x0 + xf - 1.5) / 2, 0, 0, s, 'x', 56);
    this.cyl(106, 14, M.black, x0 + 8, 0, 0, s, 'x', 56);
    this.cyl(99, 1.5, M.steel, xf - 0.75, 0, 0, s, 'x', 56); // machined front face
    this.cyl(40, 0.6, M.black, xf + 0.3, 0, 0, s, 'x', 30); // centre pocket
    // radial slots on the face and key sockets on the periphery
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + Math.PI / 6;
      const tmp = new THREE.Group();
      tmp.rotation.x = a;
      this.bx(xf - 0.2, 12, -9, xf + 0.35, 98, 9, M.black, tmp);
      this.bake(tmp, s);
      const sk = new THREE.Group();
      sk.rotation.x = a + Math.PI / 3;
      this.cyl(11, 4, M.black, x0 + 55, 103.5, 0, sk, 'y', 4);
      this.bx(x0 + 49, 103, -5, x0 + 61, 104.5, 5, M.steel, sk);
      this.cyl(3, 3, M.steel, x0 + 20, 106.2, 0, sk, 'y', 8);
      this.bake(sk, s);
    }
    flat(s);
    // jaws: opening follows chuck dia; stepped, standing 14 mm proud of the body face
    this.jaws = [];
    for (let k = 0; k < 3; k++) {
      const jg = this.group('jaw' + k, s);
      jg.rotation.x = (k / 3) * Math.PI * 2 + Math.PI / 6;
      const jp = this.group('jawPos', jg);
      this.bx(xf - 26, 0, -11, x1, 38, 11, M.steel, jp, 1.5);
      this.bx(xf - 26, 0, -11.2, xf - 12, 38, 11.2, M.black, jp);
      this.bx(x1 - 18, 0, -9.5, x1 + 0.2, 10, 9.5, M.ground, jp); // gripping step
      this.bx(x1 - 18, 10, -9.5, x1 - 14, 38, 9.5, M.chuckBody, jp);
      for (const zz of [-5, 5]) this.cyl(2.8, 4, M.black, xf - 6, 38.5, zz, jp, 'y', 8);
      flat(jp);
      this.jaws.push(jp);
    }
    // chuck key hanging in the pocket? (clickable key socket)
    this.chuckPick = this.group('chuck', this.root, x1 - 45, CENTER_Y, 0);
    this.pickSphere(this.chuckPick, 0, 0, 0, 110);
    this.click(this.chuckPick, 'chuck');
    // stock group: origin at Z0 on the axis, +Z along world +X, rotates with the spindle
    this.stockGroup.position.set(CHUCK_FACE_X, 0, 0);
    s.add(this.stockGroup);
  }

  buildGuard() {
    const M = this.M;
    // hinged chuck guard: half-shell about the spindle axis; opens by rotating up and back
    this.guard = this.group('guard', this.root, 0, CENTER_Y, 0);
    const g = this.guard;
    // it covers the chuck only (ends just past the jaw face) and does not hang down in front of the work,
    // so the operator still sees the cut; light, thin edge bands instead of heavy black rims
    const R = 168, x0 = -700, x1 = -584, a0 = -Math.PI * 0.08, span = Math.PI * 1.08;
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(R, R, x1 - x0, 40, 1, true, a0, span), M.glass);
    shell.geometry.rotateZ(Math.PI / 2); // axis along x; theta 0 = front (+z), 90 deg = up
    shell.position.set((x0 + x1) / 2, 0, 0);
    g.add(shell);
    for (const x of [x0, x1]) {
      const tg = new THREE.TorusGeometry(R, 2.2, 6, 40, span);
      tg.rotateZ(a0);
      const ring = new THREE.Mesh(tg, M.paintDark);
      ring.rotation.y = -Math.PI / 2;
      ring.position.set(x, 0, 0);
      g.add(ring);
    }
    this.bx(x0, 140, -R - 8, x1, 190, -R + 12, M.black, g, 3); // hinge block at the rear
    const hy = R * Math.sin(a0) + 4, hz = R * Math.cos(a0) + 14;
    this.cyl(6, 110, M.chrome, (x0 + x1) / 2, hy, hz, g, 'x', 10); // front handle
    for (const x of [x0 + 12, x1 - 12]) this.bx(x - 4, hy - 4, hz - 16, x + 4, hy + 4, hz, M.chrome, g);
    flat(g);
    this.pickSphere(g, (x0 + x1) / 2, hy, hz, 60);
    this.click(g, 'guard');
  }

  // ------------------------------------------------------------------ leadscrew and feed rod
  buildRods() {
    const M = this.M;
    const g = this.group('rods', this.root);
    const mk = (r, mat, y, name, repeatPer) => {
      const geo = new THREE.CylinderGeometry(r, r, 1720, 20);
      geo.rotateZ(Math.PI / 2);
      const uv = geo.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 3, uv.getY(i) * repeatPer);
      const m = new THREE.Mesh(geo, mat);
      m.name = name;
      m.position.set(-730 + 860, y, 160);
      g.add(m);
      return m;
    };
    this.leadscrew = mk(16, M.leadscrew, 818, 'leadscrew', 1720 / 20);
    this.feedRod = mk(11, M.feedrod, 852, 'feedRod', 1720 / 60);
    this.rodsMeshes = [this.leadscrew, this.feedRod];
    // brackets / end supports
    this.bx(-742, 800, 140, -728, 870, 175, M.paintDark, g);
    this.bx(935, 795, 140, 965, 880, 185, M.paint, g, 3);
    this.bx(-738, 800, 150, -735, 870, 170, M.black, g);
    this.cyl(22, 12, M.black, 972, 818, 160, g, 'x', 20);
    this.cyl(14, 12, M.black, 972, 852, 160, g, 'x', 20);
    this.bx(945, 770, 90, 975, 800, 230, M.cast, g);
    flat(g);
    // lead-screw end handwheel (tiny) skipped; reversing is by the apron
  }

  // ------------------------------------------------------------------ carriage, apron, cross slide, compound, tool post
  buildCarriage() {
    const M = this.M;
    this.carriage = this.group('carriage', this.root, 0, 0, 0);
    const c = this.carriage;
    // saddle bridging the ways, wrap-around gibs, wipers
    this.bx(-150, 922, -150, 150, 976, 175, M.paint, c, 4);
    this.bx(-150, 880, -150, 150, 924, -128, M.paint, c, 2);
    this.bx(-150, 880, 138, 150, 924, 175, M.paint, c, 2);
    this.bx(-157, 900, -142, -150, 976, 160, M.rubber, c);
    this.bx(150, 900, -142, 157, 976, 160, M.rubber, c);
    for (const x of [-100, 100]) this.cyl(5, 8, M.carbide, x, 978, 150, c, 'y', 8); // oilers
    // front shelf for the cross-slide bracket
    this.bx(-62, 958, 172, 24, 990, 262, M.paint, c, 3);
    // apron
    this.bx(-150, 640, 175, 150, 922, 200, M.paintDark, c, 5);
    this.bx(-150, 625, 168, 150, 650, 210, M.paint, c, 4);
    this.bx(-140, 650, 200, 140, 915, 203, M.paint, c, 3);
    this.plate('fwdStopRev', 38, c, 112, 735, 203.6);
    this.plate('warnChips', 38, c, -112, 865, 203.6);
    this.plate('halfnut', 66, c, 55, 880, 203.6);
    this.plate('feeddir', 62, c, 25, 715, 203.6);
    for (const [x, y] of [[-135, 660], [135, 660], [-135, 905], [135, 905]]) this.cyl(5, 3, M.steel, x, y, 204, c, 'z', 8);
    // E-stop: yellow label ring + red mushroom
    this.cyl(34, 6, M.yellow, 118, 880, 204, c, 'z', 24);
    flat(c);
    this.estop = this.group('estop', c, 118, 880, 207);
    this.cyl(20, 6, M.black, 0, 0, 0, this.estop, 'z', 20);
    this.cyl(26, 18, M.red, 0, 0, 12, this.estop, 'z', 28, 24);
    this.pickSphere(this.estop, 0, 0, 10, 34);
    flat(this.estop);
    this.click(this.estop, 'estop');
    // carriage handwheel (left of the apron) with dial
    this.hwCarriage = this.handwheel(c, 'carriageWheel', -62, 760, 205, { r: 88, dialR: 50, hubR: 24, spokes: 3, dialMat: this.M.dialCarriage });
    this.click(this.hwCarriage.group, 'carriageWheel');
    // spindle FWD/STOP/REV lever (vertical slot at the right of the apron)
    this.bx(106, 735 - 36, 203, 118, 735 + 36, 205, M.black, c);
    this.spindleLever = this.lever(c, 'spindleLever', 112, 735, 205, 56, { axis: 'z', ball: 12, mat: this.M.red });
    this.pickSphere(this.spindleLever, 0, 0, 46, 28);
    this.click(this.spindleLever, 'spindleLever');
    // power feed lever (4-way: long / cross) above the handwheel
    const fb = this.group('feedLeverBoss', c, 25, 800, 203);
    this.cyl(26, 6, M.black, 0, 0, 3, fb, 'z', 24);
    this.cyl(14, 8, M.chrome, 0, 0, 8, fb, 'z', 18);
    flat(fb);
    this.feedLever = this.lever(fb, 'feedLever', 0, 0, 8, 62, { axis: 'z', ball: 12 });
    this.pickSphere(this.feedLever, 0, 0, 52, 30);
    this.click(this.feedLever, 'feedLever');
    // half-nut lever (right, pivots in the apron plane)
    const hb = this.group('halfNutBoss', c, 100, 800, 203);
    this.cyl(20, 6, M.black, 0, 0, 3, hb, 'z', 20);
    flat(hb);
    this.halfNutLever = this.lever(hb, 'halfNut', 0, 0, 6, 70, { axis: 'y', ball: 12 });
    this.halfNutLever.rotation.z = 0;
    this.pickSphere(this.halfNutLever, 0, 60, 0, 30);
    this.click(this.halfNutLever, 'halfNut');
    // thread dial on the right of the apron: its worm wheel runs on the leadscrew; the half nut only drops
    // in on a numbered mark (read at the red index on the operator side)
    this.bx(150, 868, 150, 196, 932, 196, M.paintDark, c, 3);
    this.cyl(24, 6, M.chrome, 174, 935, 174, c, 'y', 24);
    const ti = new THREE.ExtrudeGeometry(new THREE.Shape([new THREE.Vector2(-5, 0), new THREE.Vector2(5, 0), new THREE.Vector2(0, 9)]), { depth: 4, bevelEnabled: false });
    ti.rotateX(-Math.PI / 2); ti.translate(174, 946, 205); // triangle in the xz plane pointing at the dial
    c.add(new THREE.Mesh(ti, M.red));
    this.threadDial = this.group('threadDial', c, 174, 938, 174);
    this.cyl(22, 12, M.chrome, 0, 6, 0, this.threadDial, 'y', 32);
    flat(this.threadDial);
    this.threadDialFace = new THREE.Mesh(new THREE.CircleGeometry(21, 40), new THREE.MeshStandardMaterial({ map: threadDialTexture(4), roughness: 0.4, metalness: 0.3 }));
    this.threadDialFace.geometry.rotateX(-Math.PI / 2);
    this.threadDialFace.position.y = 12.3;
    this.threadDialFace.userData.keep = true;
    this.threadDial.add(this.threadDialFace);
    this._tdN = 4;
    // feed direction knob
    this.feedDirKnob = this.group('feedDir', c, 25, 690, 203);
    this.cyl(22, 12, M.black, 0, 0, 6, this.feedDirKnob, 'z', 24);
    this.cyl(18, 4, M.chrome, 0, 0, 13, this.feedDirKnob, 'z', 24);
    this.bx(-3, 0, 14, 3, 30, 18, M.red, this.feedDirKnob);
    this.pickSphere(this.feedDirKnob, 0, 0, 8, 30);
    flat(this.feedDirKnob);
    this.click(this.feedDirKnob, 'feedDir');
    // coolant pump switch + nozzle on the saddle
    this.cyl(16, 10, M.black, -112, 700, 203, c, 'z', 16);
    this.plate('coolant', 52, c, -112, 668, 203.6);
    // cross-slide handwheel at the front bracket
    this.bx(-60, 962, 258, 22, 986, 275, M.paintDark, c, 2);
    flat(c);
    this.hwCross = this.handwheel(c, 'crossWheel', -20, 985, 268, { r: 52, dialR: 38, hubR: 18, spokes: 3, dialMat: this.M.dialCross });
    this.click(this.hwCross.group, 'crossWheel');
    this.plate('cross', 50, c, -20, 940, 262);
    // hose to the coolant nozzle (flexible, drawn static) and nozzle
    // hose runs up behind the work and the nozzle points down at the tip from the back (keeps the
    // operator's view of the cut clear)
    // short and low behind the work, so it never crosses the operator's view of the tool tip
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(62, 978, -165), new THREE.Vector3(54, 1040, -168), new THREE.Vector3(44, 1088, -146), new THREE.Vector3(34, 1106, -118), new THREE.Vector3(30, 1108, -106)]);
    const hose = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 7, 8), M.black);
    hose.name = 'coolant-hose'; hose.userData.keep = true;
    c.add(hose);
    this.nozzle = new THREE.Object3D();
    this.nozzle.position.set(27, 1108, -86);
    c.add(this.nozzle);
    this.cyl(6, 24, M.chrome, 28, 1108, -96, c, 'y', 10).rotation.x = Math.PI / 2;
    flat(c);
    this.stream = new THREE.Mesh(new THREE.CylinderGeometry(2, 3, 1, 8, 1, true), M.coolantMat);
    this.stream.visible = false;
    this.stream.userData.noShadow = true;
    this.root.add(this.stream);
    this.pickSphere(c, 28, 1108, -96, 22).userData.action = 'coolant';
    // ---- cross slide (tip frame: x 0, tool tip at z 0)
    this.cross = this.group('crossSlide', c, -20, 0, 0);
    const x = this.cross;
    this.bx(-92, 978, -130, 92, 1012, 40, M.paintDark, x, 3);
    this.bx(-98, 976, -130, -92, 1010, 40, M.steel, x); // gib strips
    this.bx(92, 976, -130, 98, 1010, 40, M.steel, x);
    this.cyl(79, 18, M.paintDark, 0, 1021, TIP_REACH, x, 'y', 40);
    const ring = new THREE.Mesh(new THREE.PlaneGeometry(160, 160), M.ring);
    ring.geometry.rotateX(-Math.PI / 2);
    ring.position.set(0, 1030.4, TIP_REACH);
    x.add(ring);
    // clamp screw heads on the swivel
    for (const a of [Math.PI * 0.75, -Math.PI * 0.75]) this.cyl(7, 8, M.black, Math.sin(a) * 70, 1033, TIP_REACH + Math.cos(a) * 70, x, 'y', 8);
    flat(x);
    // compound rest (rotates with the swivel angle)
    this.compoundRot = this.group('compoundRot', x, 0, 1030, TIP_REACH);
    const cr = this.compoundRot;
    this.bx(-50, 1, -110, 50, 20, 125, M.paint, cr, 3);
    this.bx(-54, 3, -110, -50, 19, 125, M.steel, cr);
    this.bx(50, 3, -110, 54, 19, 125, M.steel, cr);
    this.cyl(8, 10, M.black, 0, 28, 105, cr, 'y', 12); // lock screw
    // swivel pointer
    this.bx(-2, 0, 118, 2, 22, 140, M.red, cr);
    flat(cr);
    this.hwCompound = this.handwheel(cr, 'compoundWheel', 0, 12, 127, { r: 36, dialR: 28, hubR: 14, spokes: 3, handle: true });
    this.click(this.hwCompound.group, 'compoundWheel');
    this.compSlide = this.group('compSlide', cr, 0, 0, 0);
    const cs = this.compSlide;
    this.bx(-58, 20, -62, 58, 33, 62, M.paintDark, cs, 2);
    this.bx(-62, 21, -62, -58, 31, 62, M.steel, cs);
    this.bx(58, 21, -62, 62, 31, 62, M.steel, cs);
    flat(cs);
    this.buildToolPost(cs);
  }

  buildToolPost(parent) {
    const M = this.M;
    this.post = this.group('toolPost', parent, 0, 33, 0); // y 1063 above floor in world (1030+33)
    const p = this.post;
    this.bx(-38, 0, -38, 38, 40, 38, M.black, p, 5);
    this.cyl(30, 4, M.chrome, 0, 40, 0, p, 'y', 28);
    this.cyl(12, 40, M.chrome, 0, 62, 0, p, 'y', 16); // clamping stud
    for (let i = 0; i < 4; i++) {
      const f = new THREE.Group();
      f.rotation.y = (i * Math.PI) / 2;
      this.bx(-22, 8, -40, 22, 36, -36, M.paintDark, f);
      for (const sx of [-12, 12]) this.cyl(4.5, 14, M.steel, sx, 42, -28, f, 'y', 8);
      this.bake(f, p);
    }
    flat(p);
    // tools (tool i points to local -z at rotation 0; group i rotated by i*90 about y)
    this.toolTips = [];
    for (let i = 0; i < 4; i++) {
      const tg = new THREE.Group();
      tg.rotation.y = (i * Math.PI) / 2;
      this.makeTool(i, tg);
      this.bake(tg, p);
      const tip = new THREE.Object3D();
      tip.position.set(0, 38 - 1, -TIP_REACH).applyAxisAngle(new THREE.Vector3(0, 1, 0), (i * Math.PI) / 2);
      p.add(tip);
      this.toolTips.push(tip);
    }
    flat(p);
    this.pickSphere(p, 0, 70, 0, 60);
    this.click(p, 'toolPost');
    // clamping lever on the stud nut: it stays pointing toward the operator's right (it does not index
    // with the post), so it never lies across the operator's view of the work
    this.postHandle = this.group('toolPostLever', parent, 0, 33, 0);
    const h = this.postHandle;
    this.cyl(17, 12, M.black, 0, 72, 0, h, 'y', 16);
    const lev = this.bx(0, 67, -6, 84, 77, 6, M.black, h, 3);
    void lev;
    this.sph(10, M.chrome, 90, 72, 0, h);
    h.rotation.y = -Math.PI / 4; // local +x -> world (+x, +z): toward the operator, right of the post
    flat(h);
  }

  makeTool(i, g) {
    const M = this.M;
    const tri = (pts, mat, y0, th) => {
      const sh = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
      const geo = new THREE.ExtrudeGeometry(sh, { depth: th, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2); // extrude up (+y)
      geo.translate(0, y0, 0);
      const m = new THREE.Mesh(geo, mat);
      g.add(m);
    };
    if (i === 0) { // RH turning tool, tip at the left front corner
      this.bx(0, 18, -62, 16, 34, -18, M.toolSteel, g, 1);
      tri([[0, -69], [16, -58], [16, -52], [0, -52]], M.toolSteel, 30, 4);
      tri([[0, -69], [11, -62], [0, -57]], M.carbide, 34, 4);
    } else if (i === 1) { // 45 degree chamfer / facing tool: 90 degree V point centred on the tip
      this.bx(-8, 18, -50, 8, 34, -18, M.toolSteel, g, 1);
      tri([[0, -67], [-9, -58], [-9, -50], [9, -50], [9, -58]], M.toolSteel, 18, 16);
      tri([[0, -69], [-8, -61], [8, -61]], M.carbide, 34, 4);
    } else if (i === 2) { // 3 mm parting blade in a holder
      this.bx(-12, 18, -46, 12, 34, -18, M.toolSteel, g, 1);
      // blade 0..3 mm on the tailstock side of the tip: the reference is the chuck-side corner
      this.bx(0, 14, -TIP_REACH + 0.5, 3, 37, -40, M.steel, g);
      this.bx(-0.05, 34, -TIP_REACH, 3.05, 37.2, -TIP_REACH + 6, M.carbide, g);
    } else { // 60 degree threading tool
      this.bx(-8, 18, -52, 8, 34, -18, M.toolSteel, g, 1);
      tri([[0, -69], [9, -52], [-9, -52]], M.carbide, 34, 4);
    }
  }

  // ------------------------------------------------------------------ tailstock
  buildTailstock() {
    const M = this.M;
    this.tail = this.group('tailstock', this.root, 0, 0, 0);
    const t = this.tail;
    // body (origin x = Z of the drill chuck face at quill 0)
    this.bx(100, 914, -100, 330, 975, 100, M.paint, t, 4);
    this.bx(100, 975, -78, 318, 1190, 78, M.paint, t, 10);
    this.bx(108, 1190, -52, 280, 1200, 52, M.paintDark, t, 3);
    this.cyl(40, 6, M.black, 101, CENTER_Y, 0, t, 'x', 28);
    this.bx(318, 1050, -48, 342, 1155, 48, M.paintDark, t, 4);
    this.cyl(11, 14, M.carbide, 240, 1202, 0, t, 'y', 10); // oiler
    for (const z of [-84, 84]) this.cyl(5, 6, M.steel, 150, 1010, z, t, 'z', 8);
    // clamp bolt block at the base
    this.bx(150, 935, 100, 230, 975, 112, M.paintDark, t, 2);
    flat(t);
    // quill group: slides along -x
    this.quill = this.group('quill', t);
    const q = this.quill;
    const quillGeo = new THREE.CylinderGeometry(30, 30, 190, 32);
    quillGeo.rotateZ(Math.PI / 2);
    const uv = quillGeo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i), 1 - uv.getY(i)); // scale grows away from the nose
    const quillMesh = new THREE.Mesh(quillGeo, M.quill);
    quillMesh.position.set(100 + 95 - 5, CENTER_Y, 0);
    q.add(quillMesh);
    this.cyl(30, 2, M.steel, 5, CENTER_Y, 0, q, 'x', 24);
    // drill chuck
    this.cyl(21, 52, M.chrome, 26, CENTER_Y, 0, q, 'x', 32, 24);
    this.cyl(23, 18, M.black, 40, CENTER_Y, 0, q, 'x', 32);
    this.cyl(14, 12, M.steel, 0, CENTER_Y, 0, q, 'x', 20, 18);
    this.cyl(21, 10, M.steel, 60, CENTER_Y, 0, q, 'x', 20, 26); // chuck-to-quill taper
    flat(q);
    this.tailToolGroup = this.group('tailTool', q, 0, CENTER_Y, 0);
    // handwheel at the rear end (axis along world x)
    this.hwTailWrap = this.group('tailWheelWrap', t, 342, CENTER_Y, 0);
    this.hwTailWrap.rotation.y = Math.PI / 2;
    this.hwTail = this.handwheel(this.hwTailWrap, 'tailWheel', 0, 0, 0, { r: 72, dialR: 40, hubR: 20, spokes: 3 });
    this.click(this.hwTail.group, 'tailWheel');
    // quill lock lever (front side, pivots up/down) and bed clamp lever
    this.quillLock = this.lever(t, 'quillLock', 262, 1120, 78, 60, { axis: 'z', ball: 11 });
    this.pickSphere(this.quillLock, 0, 0, 55, 26);
    this.click(this.quillLock, 'quillLock');
    this.tailClamp = this.lever(t, 'tailClamp', 215, 955, 112, 85, { axis: 'z', ball: 11 });
    this.pickSphere(this.tailClamp, 0, 0, 70, 28);
    this.click(this.tailClamp, 'tailClamp');
    this.plate('quill', 90, t, 215, 1165, 78.5);
  }

  // ------------------------------------------------------------------ extras: work light, nameplates
  buildExtras() {
    const M = this.M;
    const g = this.group('extras', this.root);
    // gooseneck work light on the headstock top
    // gooseneck from the back of the headstock lid, lamp over the chuck from behind (out of the
    // operator's line of sight to the cut)
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(-760, 1272, -150), new THREE.Vector3(-758, 1380, -205), new THREE.Vector3(-730, 1462, -262), new THREE.Vector3(-676, 1470, -282)]);
    const neck = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 6, 8), M.black);
    neck.name = 'lamp-neck'; neck.userData.keep = true;
    g.add(neck);
    this.cyl(16, 12, M.black, -760, 1274, -150, g, 'y', 16);
    const head = this.cyl(34, 56, M.paint, -652, 1452, -280, g, 'y', 24, 24);
    head.rotation.set(0.75, 0, -0.45);
    this.cyl(30, 3, M.lamp, -660, 1432, -264, g, 'y', 24).rotation.set(0.75, 0, -0.45);
    this.bx(-1000, 1100, -150, -985, 1110, -140, M.black, g); // dummy cable gland
    this.plate('warnGlasses', 55, g, -930, 1225, 162.6);
    flat(g);
    // work light pick
    this.lightPick = this.group('light', this.root);
    this.pickSphere(this.lightPick, -654, 1450, -276, 55);
    this.click(this.lightPick, 'light');
  }

  // ------------------------------------------------------------------ API
  // State fields read (all optional): spindle{dir,rpm,rpmSet,angle}, chuck{dia}, carriageZ, crossX,
  // compound{angle(deg),slide(mm, + = advance toward the work)}, toolIndex, tailstock{z,quill,tool,locked,quillLock},
  // gear, speeds[], feed{rate,engaged,dir}, halfNut, threadPitch, handwheels{carriage,cross,compound,tail}(rad),
  // dials{carriage,cross,compound,tail}(rad offsets relative to the wheel), leadscrewAngle, feedRodAngle,
  // guardOpen|door, estop, coolant, brake, gearbox{a,b,c}, lightOn.
  update(state = {}) {
    const s = state || {};
    this.state = s;
    const M = this.M;
    const now = performance.now();
    const dt = clamp((now - this._t) / 1000, 0, 0.1);
    this._t = now;
    const sp = s.spindle || {};
    const dir = num(sp.dir, 0);
    const rpm = num(sp.rpm, 0);
    const w = (dir * rpm * Math.PI * 2) / 60; // rad/s, forward positive
    let ang;
    if (typeof sp.angle === 'number') ang = sp.angle;
    else if (typeof s.spindleAngle === 'number') ang = s.spindleAngle;
    else { this._spin = (this._spin + clamp(w * dt, -0.8, 0.8)) % (Math.PI * 2); ang = this._spin; }
    // FWD (angle growing) turns the work so its operator-side surface moves DOWN onto the tool's top rake
    // (counter-clockwise seen from the tailstock): +angle about +X
    this.spinGroup.rotation.x = ang;
    this.spinAngle = ang;
    // chuck jaws
    const dia = clamp(num(s.chuck && s.chuck.dia, 40), 0, 200);
    for (const jp of this.jaws) jp.position.y = clamp(dia / 2, 0, 64);
    // carriage / cross / compound
    const cz = num(s.carriageZ, 120);
    const cx = num(s.crossX, 60);
    const comp = s.compound || {};
    const cang = num(comp.angle, 0) * D2R;
    const cslide = num(comp.slide, 0);
    this.carriage.position.x = CHUCK_FACE_X + cz + 20 + cslide * Math.sin(cang);
    this.cross.position.z = cx + cslide * Math.cos(cang);
    this.compoundRot.rotation.y = cang;
    this.compSlide.position.z = -cslide;
    // tool post
    const ti = num(s.toolIndex, 0);
    this.post.rotation.y = -ti * (Math.PI / 2);
    // handwheels (angles in rad, clockwise-from-operator motion = negative rotation about the outward axis)
    const hwS = s.handwheels || {}, dials = s.dials || {};
    const aC = num(hwS.carriage, -(cz / 25) * Math.PI * 2);
    const aX = num(hwS.cross, (cx / 2) * Math.PI * 2);
    const aP = num(hwS.compound, -(cslide / 2) * Math.PI * 2);
    const q = num(s.tailstock && s.tailstock.quill, 0);
    const aT = num(hwS.tail, -(q / 5) * Math.PI * 2);
    this.hwCarriage.group.rotation.z = aC;
    this.hwCross.group.rotation.z = aX;
    this.hwCompound.group.rotation.z = aP;
    this.hwTail.group.rotation.z = aT;
    this.hwCarriage.dial.rotation.z = num(dials.carriage, 0);
    this.hwCross.dial.rotation.z = num(dials.cross, 0);
    this.hwCompound.dial.rotation.z = num(dials.compound, 0);
    this.hwTail.dial.rotation.z = num(dials.tail, 0);
    // tailstock
    const t = s.tailstock || {};
    this.tail.position.x = CHUCK_FACE_X + num(t.z, 700);
    this.quill.position.x = -clamp(q, 0, TAIL_GEOM.quillStroke);
    this.setTailTool(t.tool);
    this.tailClamp.rotation.x = t.locked === false ? 0.9 : -0.25; // clamped = lever down toward bed
    this.quillLock.rotation.x = t.quillLock ? -0.5 : 0.7;
    // levers
    const feed = s.feed || {};
    const eng = feed.engaged || 'off';
    const fdir = num(feed.dir, 1) >= 0 ? 1 : -1;
    this.spindleLever.rotation.x = -dir * 0.55; // up = forward, down = reverse
    this.feedLever.rotation.set(0, 0, 0);
    if (eng === 'long') this.feedLever.rotation.y = fdir * 0.6;
    else if (eng === 'cross') this.feedLever.rotation.x = -fdir * 0.6;
    this.halfNutLever.rotation.z = s.halfNut ? -0.95 : 0.15;
    this.feedDirKnob.rotation.z = -fdir * 0.7;
    const speeds = Array.isArray(s.speeds) && s.speeds.length ? s.speeds : null;
    const gear = num(s.gear, 0);
    const half = speeds ? Math.max(1, speeds.length / 2) : 6;
    this.selKnob.rotation.z = (2.5 - (gear % half)) * 0.9 - 0.1;
    this.rangeLever.rotation.z = gear >= half ? -0.55 : 0.55;
    const gb = s.gearbox || {};
    const rate = num(feed.rate, 0.1);
    const n = clamp(Math.round(Math.log2(Math.max(0.01, rate) / 0.04)), 0, 7);
    const gA = num(gb.a, n % 4), gB = num(gb.b, Math.floor(n / 4)), gC = num(gb.c, s.halfNut ? 2 : eng !== 'off' ? 1 : 0);
    this.gbLevers[0].rotation.z = (1.5 - gA) * 0.5;
    this.gbLevers[1].rotation.z = (0.5 - gB) * 0.7;
    this.gbLevers[2].rotation.z = (1 - gC) * 0.6;
    // leadscrew / feed rod
    if (typeof s.leadscrewAngle === 'number') this._lead = s.leadscrewAngle;
    else if (s.halfNut || eng !== 'off') this._lead = (this._lead + clamp(-w * 0.25 * dt, -0.5, 0.5)) % (Math.PI * 2);
    if (typeof s.feedRodAngle === 'number') this._feed = s.feedRodAngle;
    else if (eng !== 'off') this._feed = (this._feed + clamp(-w * 0.4 * dt, -0.5, 0.5)) % (Math.PI * 2);
    this.leadscrew.rotation.x = this._lead;
    this.feedRod.rotation.x = this._feed;
    // guard, e-stop, brake, coolant
    const go = clamp(num(s.guardOpen !== undefined ? +s.guardOpen : s.door !== undefined ? +s.door : 0, 0), 0, 1);
    this.guard.rotation.x = -go * 1.9; // flips up and back
    this.estop.position.z = s.estop ? 203 : 207;
    this.brakeBar.rotation.z = num(s.brake, 0) * 0.12;
    this.coolantOn = !!s.coolant;
    if (this.coolantOn) {
      this.root.updateWorldMatrix(true, true);
      const a = this.nozzle.getWorldPosition(new THREE.Vector3());
      const b = this.toolTipWorld(Math.round(ti) & 3);
      const len = a.distanceTo(b);
      this.stream.visible = true;
      this.stream.position.copy(a).add(b).multiplyScalar(0.5);
      this.stream.scale.set(1, len, 1);
      this.stream.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    } else this.stream.visible = false;
    this.lamp = s.lightOn !== false;
    // thread dial: N marks (changes with the pitch: a different dial gear), pos = turn fraction
    const td = s.threadDial;
    if (td && td.N && this.threadDialFace) {
      if (td.N !== this._tdN) {
        this._tdN = td.N;
        const mat = this.threadDialFace.material;
        mat.map?.dispose();
        mat.map = threadDialTexture(td.N);
        mat.needsUpdate = true;
      }
      this.threadDial.rotation.y = -num(td.pos, 0) * Math.PI * 2;
    }
  }

  setTailTool(tool) {
    const key = tool ? `${tool.type}:${tool.d}` : '';
    if (key === this._tailKey) return;
    this._tailKey = key;
    const tg = this.tailToolGroup;
    while (tg.children.length) { const o = tg.children.pop(); o.geometry?.dispose(); }
    if (!tool) { this.tailToolLen = 0; return; }
    const M = this.M;
    const d = num(tool.d, 6);
    let len;
    if (tool.type === 'centre') {
      // combined drill and countersink
      len = 44;
      const a = new THREE.Mesh(new THREE.CylinderGeometry(d * 0.5, d * 0.5, 30, 12), M.steel);
      a.geometry.rotateZ(Math.PI / 2);
      a.position.x = -8;
      const b = new THREE.Mesh(new THREE.CylinderGeometry(d * 1.2, d * 0.5, d * 1.1, 12), M.steel);
      b.geometry.rotateZ(Math.PI / 2);
      b.position.x = -(23 + d * 0.5);
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.1, d * 0.5, d * 0.5, 12), M.steel);
      c.geometry.rotateZ(Math.PI / 2);
      c.position.x = -(23 + d * 1.35);
      tg.add(a, b, c);
      len = 23 + d * 1.6;
    } else {
      len = clamp(d * 11 + 30, 50, 190);
      const shank = new THREE.Mesh(new THREE.CylinderGeometry(d / 2, d / 2, len - d * 0.3, 16), M.steel);
      shank.geometry.rotateZ(Math.PI / 2);
      shank.position.x = -(len - d * 0.3) / 2;
      const tipLen = (d / 2) / Math.tan((118 / 2) * D2R);
      const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.05, d / 2, tipLen, 16), M.steel);
      tip.geometry.rotateZ(Math.PI / 2);
      tip.position.x = -(len - d * 0.3 + tipLen / 2);
      tg.add(shank, tip);
      len = len - d * 0.3 + tipLen;
    }
    this.tailToolLen = len;
    for (const o of tg.children) { o.castShadow = true; }
  }

  // World position of the cutting tip of tool i (0..3) in its present pose.
  toolTipWorld(i, target = new THREE.Vector3()) {
    this.root.updateWorldMatrix(true, true);
    return this.toolTips[((i % 4) + 4) % 4].getWorldPosition(target);
  }
  // World position of the tailstock tool tip (or the chuck face when no tool is fitted).
  tailTipWorld(target = new THREE.Vector3()) {
    this.root.updateWorldMatrix(true, true);
    this.quill.updateWorldMatrix(true, false);
    return this.tailToolGroup.localToWorld(target.set(-(this.tailToolLen || 0), 0, 0));
  }
  // Spindle axis point at lathe Z (mm from the chuck face), in world space.
  axisPoint(z, target = new THREE.Vector3()) {
    return target.set(CHUCK_FACE_X + z, CENTER_Y, 0);
  }
}
