// Wheels: lathe-turned tyre and barrel, extruded spokes, drilled brake disc and caliper.
// Local frame: axle along +z (outboard = +z), wheel centre at the origin.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const TYRE_R = 0.345;
const RIM_R = 0.254;

function lathe(points, segments = 128) {
  // points: [r, z] pairs. LatheGeometry spins around +y, we want +z.
  const g = new THREE.LatheGeometry(points.map(([r, z]) => new THREE.Vector2(r, z)), segments);
  g.rotateX(Math.PI / 2);
  return g;
}

function tyre(width, M) {
  const hw = width / 2;
  const group = new THREE.Group();
  // Sidewalls (outer gets lettering through the normal map; the inner one reuses it, unseen)
  const side = (sgn) => {
    const pts = [];
    const n = 14;
    for (let k = 0; k <= n; k++) {
      const t = k / n; // 0 bead → 1 shoulder
      const r = THREE.MathUtils.lerp(RIM_R + 0.012, TYRE_R - 0.016, t);
      const bulge = Math.sin(t * Math.PI) * 0.012 + t * t * 0.004;
      pts.push([r, sgn * (hw - 0.012 + bulge * 0.9 - t * 0.004)]);
    }
    // shoulder roll into the tread
    for (let k = 1; k <= 6; k++) {
      const a = (k / 6) * Math.PI / 2;
      pts.push([TYRE_R - 0.016 + Math.sin(a) * 0.016, sgn * (hw - 0.016 + Math.cos(a) * 0.012 - 0.002)]);
    }
    const g = lathe(sgn > 0 ? pts.reverse() : pts, 144);
    return new THREE.Mesh(g, M.tyre);
  };
  group.add(side(1), side(-1));
  // Tread with four circumferential grooves
  const tp = [];
  const z0 = -(hw - 0.016), z1 = hw - 0.016;
  const grooves = [-0.55, -0.18, 0.18, 0.55].map((f) => f * (hw - 0.02));
  const N = 60;
  for (let k = 0; k <= N; k++) {
    const z = THREE.MathUtils.lerp(z0, z1, k / N);
    let r = TYRE_R;
    for (const gz of grooves) {
      const d = Math.abs(z - gz);
      if (d < 0.0065) r = Math.min(r, TYRE_R - 0.007 * Math.min(1, (0.0065 - d) / 0.002));
    }
    // slight crown
    r -= Math.pow((z / hw), 4) * 0.002;
    tp.push([r, z]);
  }
  const tg = lathe(tp.reverse(), 192);
  group.add(new THREE.Mesh(tg, M.tread));
  return group;
}

function spokeShapeStraight(r0, r1, w0, w1) {
  const s = new THREE.Shape();
  const n = 10;
  s.moveTo(r0, -w0 / 2);
  for (let k = 1; k <= n; k++) {
    const t = k / n, r = THREE.MathUtils.lerp(r0, r1, t);
    const w = THREE.MathUtils.lerp(w0, w1, t * t) * (1 - 0.18 * Math.sin(t * Math.PI));
    s.lineTo(r, -w / 2);
  }
  for (let k = n; k >= 0; k--) {
    const t = k / n, r = THREE.MathUtils.lerp(r0, r1, t);
    const w = THREE.MathUtils.lerp(w0, w1, t * t) * (1 - 0.18 * Math.sin(t * Math.PI));
    s.lineTo(r, w / 2);
  }
  return s;
}

function spokeShapeY(r0, r1) {
  const s = new THREE.Shape();
  s.moveTo(r0, -0.017);
  s.lineTo(0.150, -0.0145);
  s.quadraticCurveTo(0.2, -0.02, r1, -0.056);
  s.lineTo(r1, -0.032);
  s.quadraticCurveTo(0.2, -0.006, 0.188, 0);
  s.quadraticCurveTo(0.2, 0.006, r1, 0.032);
  s.lineTo(r1, 0.056);
  s.quadraticCurveTo(0.2, 0.02, 0.150, 0.0145);
  s.lineTo(r0, 0.017);
  s.closePath();
  return s;
}

function spokeShapeTurbine(r0, r1) {
  const s = new THREE.Shape();
  const n = 14, sweep = 0.42;
  const pts = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n, r = THREE.MathUtils.lerp(r0, r1, t);
    const a = sweep * t * t;
    const w = THREE.MathUtils.lerp(0.011, 0.02, t) / r; // angular half-width
    pts.push([r, a - w, a + w]);
  }
  s.moveTo(pts[0][0] * Math.cos(pts[0][1]), pts[0][0] * Math.sin(pts[0][1]));
  for (const [r, a] of pts) s.lineTo(r * Math.cos(a), r * Math.sin(a));
  for (let k = pts.length - 1; k >= 0; k--) { const [r, , a] = pts[k]; s.lineTo(r * Math.cos(a), r * Math.sin(a)); }
  s.closePath();
  return s;
}

function spokes(style, faceZ) {
  const r0 = 0.07, r1 = 0.246;
  const geos = [];
  const extrude = (shape, depth) => new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.0035, bevelSegments: 3, curveSegments: 10 });
  const place = (g, angle, dish) => {
    g.translate(0, 0, -0.02);
    g.rotateY(dish); // positive dish pushes the outer end outboard → concave face
    g.rotateZ(angle);
    g.translate(0, 0, faceZ);
    geos.push(g);
  };
  if (style === 0) {
    // 5 split spokes (10 blades)
    for (let k = 0; k < 5; k++) for (const o of [-0.115, 0.115]) place(extrude(spokeShapeStraight(r0, r1, 0.026, 0.034), 0.022), (k / 5) * Math.PI * 2 + o, -0.16);
  } else if (style === 1) {
    for (let k = 0; k < 5; k++) place(extrude(spokeShapeY(r0, r1), 0.024), (k / 5) * Math.PI * 2, -0.14);
  } else {
    for (let k = 0; k < 15; k++) place(extrude(spokeShapeTurbine(r0, r1), 0.018), (k / 15) * Math.PI * 2, -0.1);
  }
  return mergeGeometries(geos);
}

function rimBarrel(width, M) {
  const hw = width / 2 - 0.012;
  const group = new THREE.Group();
  // inner barrel surface (seen through the spokes)
  const inner = lathe([[0.232, hw - 0.022], [0.232, 0.0], [0.226, -hw * 0.45], [0.236, -hw + 0.01], [0.252, -hw]].reverse(), 128);
  const innerMesh = new THREE.Mesh(inner, M.rimInner);
  innerMesh.material = M.rimInner.clone();
  innerMesh.material.side = THREE.DoubleSide;
  group.add(innerMesh);
  // polished outer lip
  const lip = lathe([[0.232, hw - 0.022], [0.238, hw - 0.012], [0.25, hw - 0.004], [0.258, hw + 0.002], [0.264, hw - 0.004], [0.262, hw - 0.012]].reverse(), 160);
  group.add(new THREE.Mesh(lip, M.rimLip));
  return group;
}

function hub(faceZ, M) {
  const g = new THREE.Group();
  const centre = lathe([[0.0, faceZ + 0.006], [0.05, faceZ + 0.004], [0.072, faceZ - 0.004], [0.08, faceZ - 0.03], [0.07, faceZ - 0.06]].reverse(), 64);
  g.add(new THREE.Mesh(centre, M.rim));
  // lug nuts
  const nutGeo = new THREE.CylinderGeometry(0.0105, 0.0115, 0.022, 6);
  nutGeo.rotateX(Math.PI / 2);
  const capGeo = new THREE.SphereGeometry(0.0085, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  capGeo.rotateX(Math.PI / 2);
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + Math.PI / 10;
    const n = new THREE.Mesh(nutGeo, M.lug);
    n.position.set(Math.cos(a) * 0.05, Math.sin(a) * 0.05, faceZ + 0.012);
    const c = new THREE.Mesh(capGeo, M.lug);
    c.position.set(Math.cos(a) * 0.05, Math.sin(a) * 0.05, faceZ + 0.023);
    g.add(n, c);
  }
  // centre cap with ring
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.031, 0.01, 48).rotateX(Math.PI / 2), M.gloss);
  cap.position.z = faceZ + 0.012;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.0025, 8, 48), M.chrome);
  ring.position.z = faceZ + 0.017;
  const mark = new THREE.Mesh(new THREE.TorusGeometry(0.012, 0.002, 6, 3), M.chrome);
  mark.position.z = faceZ + 0.018;
  mark.rotation.z = Math.PI / 2;
  g.add(cap, ring, mark);
  return g;
}

function brakeDisc(M) {
  const R = 0.19, r = 0.105;
  const s = new THREE.Shape();
  s.absarc(0, 0, R, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, r, 0, Math.PI * 2, true);
  s.holes.push(hole);
  // cross-drilled pattern: 3 staggered rings of holes
  for (let ring = 0; ring < 3; ring++) {
    const rr = 0.128 + ring * 0.02;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2 + ring * 0.09;
      const h = new THREE.Path();
      h.absarc(Math.cos(a) * rr, Math.sin(a) * rr, 0.0042, 0, Math.PI * 2, true);
      s.holes.push(h);
    }
  }
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.032, bevelEnabled: false, curveSegments: 64 });
  g.translate(0, 0, -0.016);
  // planar UVs for the turned-metal texture
  const p = g.getAttribute('position'), uv = g.getAttribute('uv');
  for (let k = 0; k < p.count; k++) uv.setXY(k, p.getX(k) / (2 * 0.26) + 0.5, p.getY(k) / (2 * 0.26) + 0.5);
  const disc = new THREE.Mesh(g, M.disc);
  const hat = new THREE.Mesh(lathe([[0.106, 0.016], [0.1, 0.03], [0.09, 0.05], [0.0, 0.05]].reverse(), 64), M.discHat);
  const grp = new THREE.Group();
  grp.add(disc, hat);
  return grp;
}

function caliper(M) {
  const s = new THREE.Shape();
  const a0 = -0.62, a1 = 0.62, ri = 0.138, ro = 0.214;
  s.absarc(0, 0, ro, a0, a1, false);
  s.absarc(ro * Math.cos(a1) * 0 + 0, 0, ri, a1, a0, true);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.064, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.01, bevelSegments: 4, curveSegments: 32 });
  g.translate(0, 0, -0.032);
  const mesh = new THREE.Mesh(g, M.caliper);
  // bridge bolts
  const grp = new THREE.Group();
  grp.add(mesh);
  const bolt = new THREE.CylinderGeometry(0.0055, 0.0055, 0.01, 12).rotateX(Math.PI / 2);
  for (const a of [-0.4, 0.4]) {
    const b = new THREE.Mesh(bolt, M.lug);
    b.position.set(Math.cos(a) * 0.176, Math.sin(a) * 0.176, 0.044);
    grp.add(b);
  }
  return grp;
}

export function createWheel(width, M, { front = true } = {}) {
  const root = new THREE.Group(); // static (caliper)
  const spin = new THREE.Group(); // rotates with the wheel
  root.add(spin);
  spin.add(tyre(width, M));
  spin.add(rimBarrel(width, M));
  const faceZ = width / 2 - 0.045;
  const spokeMeshes = [0, 1, 2].map((st) => {
    const m = new THREE.Mesh(spokes(st, faceZ), M.rim);
    m.visible = st === 0;
    spin.add(m);
    return m;
  });
  spin.add(hub(faceZ - 0.012, M));
  const disc = brakeDisc(M);
  disc.position.z = -0.012;
  spin.add(disc);
  const cal = caliper(M);
  cal.position.z = -0.012;
  cal.rotation.z = front ? Math.PI * 0.62 : Math.PI * 0.38; // trailing side, upper half
  root.add(cal);
  root.userData = { spin, spokeMeshes };
  return root;
}

export function setWheelStyle(wheels, style) {
  for (const w of wheels) w.userData.spokeMeshes.forEach((m, i) => (m.visible = i === style));
}

export { TYRE_R, RIM_R };
