// Assembles the vehicle: shell panels, glass, doors, lamps, aero, wheels, interior.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { D, buildShell, surfacePoint, surfaceFrame, archRim, xDF, xDR, uFromSF, uFromSR, PROFILE } from './body.js';
import { createWheel, setWheelStyle } from './wheels.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const sideI = (j, sgn) => (sgn > 0 ? j : 12 - j);

function mesh(g, m, { cast = true } = {}) {
  const o = new THREE.Mesh(g, m);
  o.castShadow = cast;
  return o;
}

// Tube along a list of surface parameters, pushed along the normal by `off`.
function surfaceTube(params, radius, off, mat, radial = 8) {
  const pts = params.map(([u, i]) => {
    const f = surfaceFrame(u, i);
    return f.p.addScaledVector(f.n, off);
  });
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  return mesh(new THREE.TubeGeometry(curve, Math.max(8, pts.length * 2), radius, radial, false), mat, { cast: false });
}

const sample = (n, f) => Array.from({ length: n + 1 }, (_, k) => f(k / n));

// Grid patch lying on the skin (decals, vents).
function skinPatch(u0, u1, i0, i1, nu, nv, off) {
  const P = [], UV = [], idx = [];
  for (let a = 0; a <= nv; a++) {
    for (let b = 0; b <= nu; b++) {
      const u = THREE.MathUtils.lerp(u0, u1, b / nu), i = THREE.MathUtils.lerp(i0, i1, a / nv);
      const f = surfaceFrame(u, i);
      f.p.addScaledVector(f.n, off);
      P.push(f.p.x, f.p.y, f.p.z);
      UV.push(b / nu, a / nv);
    }
  }
  for (let a = 0; a < nv; a++) for (let b = 0; b < nu; b++) {
    const k = a * (nu + 1) + b;
    idx.push(k, k + 1, k + nu + 2, k, k + nu + 2, k + nu + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // make sure normals point outwards
  const f = surfaceFrame((u0 + u1) / 2, (i0 + i1) / 2);
  const n = g.getAttribute('normal');
  if (n.getX(0) * f.n.x + n.getY(0) * f.n.y + n.getZ(0) * f.n.z < 0) {
    const ix = g.getIndex().array;
    for (let k = 0; k < ix.length; k += 3) { const t = ix[k + 1]; ix[k + 1] = ix[k + 2]; ix[k + 2] = t; }
    g.computeVertexNormals();
  }
  return g;
}

// Cylinder spanning two points.
function beam(a, b, r0, r1, mat, seg = 12) {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r1, r0, len, seg);
  const m = mesh(g, mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(V(0, 1, 0), b.clone().sub(a).normalize());
  return m;
}

export function buildCar(M, onProgress = () => {}) {
  const car = new THREE.Group();
  car.name = 'car';
  const api = {};
  const lights = {};

  onProgress('Lofting body surface');
  const shell = buildShell();
  const { cellsOf, geometryFromCells, boundaryEdges, wallGeometry, splitBorder } = shell;

  // ---- Shell panels -----------------------------------------------------------
  const body = mesh(geometryFromCells(cellsOf((l) => l === 'body')), M.paint);
  body.name = 'body';
  car.add(body);
  car.add(mesh(geometryFromCells(cellsOf((l) => l === 'under')), M.under));
  car.add(mesh(geometryFromCells(cellsOf((l) => l === 'body' || l === 'under'), { offset: -0.02, flip: true }), M.liner, { cast: false }));

  // Glass with a black ceramic frit border
  function glass(lab, parent, frit = 2) {
    const cells = cellsOf((l) => l === lab);
    const { border, inner } = splitBorder(cells, frit, (l) => l === lab);
    parent.add(mesh(geometryFromCells(border, { offset: 0.0006 }), M.frit));
    const geo = geometryFromCells(inner, { offset: 0.0006 });
    const tint = mesh(geo, M.glassTint, { cast: false });
    const refl = mesh(geo, M.glassRefl, { cast: false });
    tint.renderOrder = 2;
    refl.renderOrder = 3;
    parent.add(tint, refl);
  }
  glass('windshield', car, 2);
  glass('rearGlass', car, 2);
  glass('qglassR', car, 1);
  glass('qglassL', car, 1);

  // Recessed openings: floor + walls (+ optional flush lens)
  function recess(lab, depth, floorMat, wallMat, lensMat) {
    const cells = cellsOf((l) => l === lab);
    const g = new THREE.Group();
    g.add(mesh(geometryFromCells(cells, { offset: -depth }), floorMat));
    g.add(mesh(wallGeometry(boundaryEdges(cells), depth, 'in'), wallMat));
    if (lensMat) {
      const geo = geometryFromCells(cells, { offset: 0.0008 });
      const lens = mesh(geo, lensMat, { cast: false });
      lens.renderOrder = 3;
      const refl = mesh(geo, M.glassRefl, { cast: false });
      refl.renderOrder = 4;
      g.add(lens, refl);
    }
    car.add(g);
    return g;
  }
  onProgress('Cutting intakes and lamp housings');
  recess('grille', 0.07, M.honeycomb, M.wall);
  recess('intakeFR', 0.06, M.honeycomb, M.wall);
  recess('intakeFL', 0.06, M.honeycomb, M.wall);
  recess('sideIntakeR', 0.1, M.honeycomb, M.wall);
  recess('sideIntakeL', 0.1, M.honeycomb, M.wall);
  recess('headR', 0.042, M.housing, M.housing, M.lensTint);
  recess('headL', 0.042, M.housing, M.housing, M.lensTint);
  recess('tail', 0.026, M.tailHousing, M.tailHousing, M.redLens);
  recess('diffuser', 0.1, M.carbon, M.carbon);

  // ---- Doors ----------------------------------------------------------------------
  onProgress('Building doors');
  const doors = [];
  for (const sgn of [1, -1]) {
    const S = sgn > 0 ? 'R' : 'L';
    const doorCells = cellsOf((l) => l === 'door' + S);
    const glassCells = cellsOf((l) => l === 'dglass' + S);
    const hinge = surfacePoint(xDF(3.2) - 0.05, sideI(3.2, sgn)).clone();
    hinge.z -= 0.05 * sgn;
    const pivot = new THREE.Group();
    pivot.position.copy(hinge);
    const local = new THREE.Group();
    local.position.copy(hinge).negate();
    pivot.add(local);
    car.add(pivot);
    local.add(mesh(geometryFromCells(doorCells), M.paint));
    local.add(mesh(geometryFromCells(doorCells, { offset: -0.065, flip: true }), M.leather));
    local.add(mesh(wallGeometry(boundaryEdges(doorCells), 0.065, 'out'), M.paint));
    glass('dglass' + S, local, 1);
    // jamb inside the body opening
    car.add(mesh(wallGeometry(boundaryEdges(doorCells.concat(glassCells)), 0.1, 'in', -0.001), M.paint));
    // flush handle
    const hf = surfaceFrame(-0.12, sideI(3.86, sgn));
    const handle = mesh(new THREE.CapsuleGeometry(0.0085, 0.13, 6, 12), M.gloss);
    handle.position.copy(hf.p).addScaledVector(hf.n, 0.003);
    handle.quaternion.setFromUnitVectors(V(0, 1, 0), hf.tu);
    local.add(handle);
    const pocket = mesh(new THREE.CapsuleGeometry(0.012, 0.14, 6, 12), M.satin);
    pocket.scale.set(1, 1, 0.25);
    pocket.position.copy(hf.p).addScaledVector(hf.n, -0.001);
    pocket.quaternion.copy(handle.quaternion);
    local.add(pocket);
    // ambient strip on the door card
    local.add(surfaceTube(sample(30, (t) => [THREE.MathUtils.lerp(xDR(3.5) + 0.12, xDF(3.5) - 0.12, t), sideI(3.5, sgn)]), 0.0035, -0.068, M.ambient, 6));
    // door seams (front, bottom, rear, top notch)
    const seamR = 0.0022, seamOff = -0.0009;
    local.add(surfaceTube(sample(24, (t) => { const j = THREE.MathUtils.lerp(2.1, 4.12, t); return [xDF(j), sideI(j, sgn)]; }), seamR, seamOff, M.seam, 5));
    local.add(surfaceTube(sample(40, (t) => [THREE.MathUtils.lerp(xDR(2.1), xDF(2.1), t), sideI(2.1, sgn)]), seamR, seamOff, M.seam, 5));
    local.add(surfaceTube(sample(24, (t) => { const j = THREE.MathUtils.lerp(2.1, 4.12, t); return [xDR(j), sideI(j, sgn)]; }), seamR, seamOff, M.seam, 5));
    local.add(surfaceTube(sample(8, (t) => [THREE.MathUtils.lerp(0.8, 0.9, t), sideI(4.12, sgn)]), seamR, seamOff, M.seam, 5));
    const beta = 0.42;
    doors.push({ pivot, axis: V(-Math.sin(beta), Math.cos(beta), 0).normalize(), max: 1.12 * sgn, t: 0 });
  }

  // ---- Seams on the fixed panels -------------------------------------------
  const seam = (params) => car.add(surfaceTube(params, 0.0022, -0.0009, M.seam, 5));
  seam(sample(60, (t) => [THREE.MathUtils.lerp(0.96, 1.98, t), 4.8]));
  seam(sample(60, (t) => [THREE.MathUtils.lerp(0.96, 1.98, t), 7.2]));
  seam(sample(50, (t) => [1.98, THREE.MathUtils.lerp(4.8, 7.2, t)]));
  seam(sample(50, (t) => [0.96, THREE.MathUtils.lerp(4.8, 7.2, t)]));
  seam(sample(30, (t) => [THREE.MathUtils.lerp(-2.02, -1.36, t), 4.9]));
  seam(sample(30, (t) => [THREE.MathUtils.lerp(-2.02, -1.36, t), 7.1]));
  seam(sample(50, (t) => [-2.02, THREE.MathUtils.lerp(4.9, 7.1, t)]));
  seam(sample(50, (t) => [-1.36, THREE.MathUtils.lerp(4.9, 7.1, t)]));
  // fuel filler door on the right rear haunch
  {
    const c = surfaceFrame(-1.42, 4.05);
    const pts = [];
    for (let k = 0; k <= 40; k++) {
      const a = (k / 40) * Math.PI * 2;
      pts.push(c.p.clone().addScaledVector(c.tu, Math.cos(a) * 0.055).addScaledVector(c.ti, Math.sin(a) * 0.055).addScaledVector(c.n, -0.0009));
    }
    car.add(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 60, 0.0018, 5, true), M.seam, { cast: false }));
  }

  // ---- Hood vents -----------------------------------------------------------------
  for (const sgn of [1, -1]) {
    const i0 = sideI(5.2, sgn), i1 = sideI(5.62, sgn);
    car.add(mesh(skinPatch(1.36, 1.64, Math.min(i0, i1), Math.max(i0, i1), 12, 8, 0.0012), M.louvre, { cast: false }));
  }

  // ---- Wheel arches -------------------------------------------------------------
  onProgress('Shaping wheel arches');
  for (const xc of [D.axleF, D.axleR]) {
    for (const sgn of [1, -1]) {
      const rim = archRim(xc, sgn);
      const lip = rim.map((p) => {
        const dir = V(p.x - xc, Math.max(0, p.y - D.wheelR), 0).normalize();
        return p.clone().addScaledVector(dir, -0.004).add(V(0, 0, -0.008 * sgn));
      });
      car.add(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(lip, false, 'centripetal'), 160, 0.0105, 10, false), M.paint));
      // liner strip from the skin edge inwards
      const P = [], idx = [];
      rim.forEach((p, k) => {
        const dir = V(p.x - xc, Math.max(0, p.y - D.wheelR), 0).normalize();
        const o = p.clone().addScaledVector(dir, 0.022);
        P.push(o.x, o.y, p.z - 0.004 * sgn, o.x, o.y, D.zInner * sgn);
        if (k) { const a = (k - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      });
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      lg.setIndex(idx);
      lg.computeVertexNormals();
      car.add(mesh(lg, M.liner, { cast: false }));
      // inner wall
      const s = new THREE.Shape();
      const R = D.archR + 0.022, yb = 0.1;
      s.moveTo(xc + R, yb);
      s.lineTo(xc + R, D.wheelR);
      s.absarc(xc, D.wheelR, R, 0, Math.PI, false);
      s.lineTo(xc - R, yb);
      s.closePath();
      const wall = mesh(new THREE.ShapeGeometry(s, 48), M.liner, { cast: false });
      wall.position.z = D.zInner * sgn;
      car.add(wall);
    }
  }

  // ---- Wheels --------------------------------------------------------------------
  onProgress('Machining wheels');
  const wheels = [];
  for (const [x, w, front] of [[D.axleF, 0.255, true], [D.axleR, 0.305, false]]) {
    for (const sgn of [1, -1]) {
      const wh = createWheel(w, M, { front });
      wh.position.set(x, D.wheelR, (front ? D.trackF : D.trackR) * sgn);
      if (sgn < 0) wh.scale.z = -1;
      wh.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      car.add(wh);
      wheels.push(wh);
    }
  }

  // ---- Lamps ---------------------------------------------------------------------
  onProgress('Fitting LED lamps');
  const uHeadEnd = uFromSF(0.62);
  const projGeo = new THREE.LatheGeometry([V(0.0, -0.006, 0), V(0.012, -0.006, 0), V(0.022, 0.004, 0), V(0.025, 0.016, 0)].map((v) => new THREE.Vector2(v.x, v.y)), 32);
  projGeo.rotateX(Math.PI / 2);
  const headLens = [];
  for (const sgn of [1, -1]) {
    for (const t of [0.18, 0.5, 0.82]) {
      const u = THREE.MathUtils.lerp(1.94, uHeadEnd - 0.035, t);
      const f = surfaceFrame(u, sideI(4.12, sgn));
      const dir = f.n.clone().multiplyScalar(0.45).add(V(0.55, 0, 0)).normalize();
      const g = new THREE.Group();
      g.position.copy(f.p).addScaledVector(f.n, -0.028);
      g.quaternion.setFromUnitVectors(V(0, 0, 1), dir);
      const cup = mesh(projGeo, M.chrome, { cast: false });
      const lens = mesh(new THREE.CircleGeometry(0.0165, 32), M.ledLow, { cast: false });
      lens.position.z = 0.006;
      const ring = mesh(new THREE.TorusGeometry(0.019, 0.0018, 8, 32), M.drl, { cast: false });
      ring.position.z = 0.009;
      g.add(cup, lens, ring);
      car.add(g);
      headLens.push(lens);
    }
    // DRL light pipe along the top of the lamp, amber indicator along the bottom
    car.add(surfaceTube(sample(40, (t) => [THREE.MathUtils.lerp(1.925, uHeadEnd - 0.012, t), sideI(4.58, sgn)]), 0.0036, -0.012, M.drl, 8));
    car.add(surfaceTube(sample(40, (t) => [THREE.MathUtils.lerp(1.93, uHeadEnd - 0.012, t), sideI(3.62, sgn)]), 0.003, -0.012, M.amber, 8));
    // headlight beam
    const hp = surfaceFrame((1.94 + uHeadEnd) / 2, sideI(4.12, sgn)).p;
    const spot = new THREE.SpotLight(0xeef4ff, 0, 14, 0.36, 0.75, 1.8);
    spot.position.copy(hp).add(V(0.05, 0, 0));
    spot.target.position.set(hp.x + 8, -0.4, hp.z + 0.6 * sgn);
    car.add(spot, spot.target);
    (lights.spots ||= []).push(spot);
    // rear amber indicators at the ends of the light bar
    car.add(surfaceTube(sample(14, (t) => [uFromSR(0.755), sideI(THREE.MathUtils.lerp(4.36, 4.8, t), sgn)]), 0.0042, -0.012, M.amber, 8));
  }
  // full-width tail bar + brake bar
  car.add(surfaceTube(sample(120, (t) => [uFromSR(0.725), THREE.MathUtils.lerp(4.42, 7.58, t)]), 0.0052, -0.013, M.tail, 8));
  car.add(surfaceTube(sample(120, (t) => [uFromSR(0.69), THREE.MathUtils.lerp(4.86, 7.14, t)]), 0.003, -0.013, M.brake, 6));

  // ---- Mirrors ------------------------------------------------------------------------
  for (const sgn of [1, -1]) {
    const f = surfaceFrame(0.865, sideI(4.3, sgn));
    const base = f.p.clone();
    const head = base.clone().add(V(-0.06, 0.05, 0.13 * sgn));
    const sph = new THREE.SphereGeometry(1, 40, 24);
    const p = sph.getAttribute('position');
    for (let k = 0; k < p.count; k++) {
      let x = p.getX(k);
      if (x < -0.3) x = -0.3;
      // teardrop: thicker towards the body
      const z = p.getZ(k);
      p.setXYZ(k, x * 0.085 * (1 + z * sgn * 0.18), p.getY(k) * 0.062 * (1 + z * sgn * 0.1), z * 0.125);
    }
    sph.computeVertexNormals();
    const housing = mesh(sph, M.paint);
    housing.position.copy(head);
    car.add(housing);
    const glassM = mesh(new THREE.CircleGeometry(1, 40), M.mirrorGlass, { cast: false });
    glassM.scale.set(0.112, 0.054, 1);
    glassM.position.copy(head).add(V(-0.3 * 0.085 - 0.0015, 0, 0));
    glassM.rotation.y = -Math.PI / 2;
    car.add(glassM);
    const cap = mesh(new THREE.CircleGeometry(1, 40), M.carbon, { cast: false });
    cap.scale.set(0.118, 0.058, 1);
    cap.position.copy(glassM.position).add(V(-0.0004, 0, 0));
    cap.rotation.y = -Math.PI / 2;
    car.add(cap);
    glassM.renderOrder = 4;
    const arm = beam(base.clone().addScaledVector(f.n, -0.01), head.clone().add(V(0.01, -0.012, -0.08 * sgn)), 0.016, 0.011, M.carbon);
    arm.scale.set(1.0, 1, 0.45);
    car.add(arm);
  }

  // ---- Wipers -------------------------------------------------------------------------
  for (const [u, j0, j1] of [[0.8, 5.25, 6.02], [0.775, 6.08, 6.82]]) {
    car.add(surfaceTube(sample(24, (t) => [u, THREE.MathUtils.lerp(j0, j1, t)]), 0.0055, 0.011, M.satin, 6));
    car.add(surfaceTube(sample(24, (t) => [u + 0.012, THREE.MathUtils.lerp(j0 + 0.04, j1, t)]), 0.0035, 0.005, M.satin, 6));
    const f = surfaceFrame(u + 0.02, j0);
    const pivotCap = mesh(new THREE.CylinderGeometry(0.012, 0.014, 0.012, 16), M.satin);
    pivotCap.position.copy(f.p).addScaledVector(f.n, 0.006);
    pivotCap.quaternion.setFromUnitVectors(V(0, 1, 0), f.n);
    car.add(pivotCap);
  }

  // ---- Carbon aero -------------------------------------------------------------------
  onProgress('Laying up carbon aero');
  // Side skirts
  for (const sgn of [1, -1]) {
    const N = 70, P = [], idx = [];
    const prof = (x) => {
      const top = surfacePoint(x, sideI(2.02, sgn)).clone();
      const bot = surfacePoint(x, sideI(1.3, sgn)).clone();
      const tip = bot.clone().add(V(0, -0.012, 0.045 * sgn));
      const tipU = tip.clone().add(V(0, 0.014, -0.004 * sgn));
      return [top, tipU, tip, bot];
    };
    for (let k = 0; k <= N; k++) {
      const x = THREE.MathUtils.lerp(-0.875, 0.95, k / N);
      const taper = Math.min(1, Math.min(k, N - k) / 6);
      const pr = prof(x);
      pr[1].lerp(pr[0], 1 - taper);
      pr[2].lerp(pr[3], 1 - taper);
      for (const v of pr) P.push(v.x, v.y, v.z);
      if (k) {
        const a = (k - 1) * 4, b = k * 4;
        for (let q = 0; q < 3; q++) idx.push(a + q, b + q, b + q + 1, a + q, b + q + 1, a + q + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    const uvs = [];
    for (let k = 0; k < P.length / 3; k++) uvs.push(P[k * 3], (k % 4) * 0.012);
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    car.add(mesh(g, M.carbon));
  }

  // Front splitter: follows the lower nose outline in plan
  {
    const uS = uFromSF(0.9);
    const front = [];
    for (let k = 0; k <= 40; k++) {
      const i = THREE.MathUtils.lerp(10.7, 13.3, k / 40) % 12;
      const p = surfacePoint(uS, i);
      front.push(new THREE.Vector2(p.x, p.z));
    }
    const off = front.map((p, k) => {
      const a = front[Math.max(0, k - 1)], b = front[Math.min(front.length - 1, k + 1)];
      const t = b.clone().sub(a).normalize();
      const n = new THREE.Vector2(t.y, -t.x);
      if (n.x < 0) n.negate();
      return p.clone().addScaledVector(n, 0.05);
    });
    const s = new THREE.Shape();
    const zs = off[0].y < 0 ? 1 : -1;
    s.moveTo(1.6, -0.8 * zs);
    s.lineTo(1.88, -0.86 * zs);
    for (const p of off) s.lineTo(p.x, p.y);
    s.lineTo(1.88, 0.86 * zs);
    s.lineTo(1.6, 0.8 * zs);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.016, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.004, bevelSegments: 2, curveSegments: 4 });
    g.rotateX(Math.PI / 2);
    const pos = g.getAttribute('position'), uv = g.getAttribute('uv');
    for (let k = 0; k < pos.count; k++) uv.setXY(k, pos.getX(k), pos.getZ(k) );
    const m = mesh(g, M.carbon);
    m.position.y = surfacePoint(uS, 0).y - 0.004;
    car.add(m);
  }

  // Diffuser strakes under the rear ramp
  for (const z of [0, 0.17, -0.17, 0.46, -0.46]) {
    const s = new THREE.Shape();
    const x0 = -1.7, x1 = -2.16;
    s.moveTo(x0, 0.115);
    for (let k = 0; k <= 12; k++) {
      const x = THREE.MathUtils.lerp(x0, x1, k / 12);
      s.lineTo(x, Math.min(PROFILE.YB(Math.max(x, D.xRm)), 0.42) + 0.02);
    }
    s.lineTo(x1, 0.16);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.008, bevelEnabled: false });
    g.translate(0, 0, z - 0.004);
    const pos = g.getAttribute('position'), uv = g.getAttribute('uv');
    for (let k = 0; k < pos.count; k++) uv.setXY(k, pos.getX(k), pos.getY(k) );
    car.add(mesh(g, M.carbon));
  }

  // Exhaust tips (twin oval, heat-tinted titanium)
  for (const sgn of [1, -1]) {
    const g = new THREE.Group();
    const outer = new THREE.LatheGeometry([new THREE.Vector2(0.052, -0.13), new THREE.Vector2(0.052, -0.01), new THREE.Vector2(0.05, 0.0), new THREE.Vector2(0.046, -0.002), new THREE.Vector2(0.044, -0.13)], 48);
    outer.rotateZ(Math.PI / 2);
    g.add(mesh(outer, M.titanium));
    const inner = mesh(new THREE.CircleGeometry(0.044, 40), M.exhaustInner, { cast: false });
    inner.rotation.y = -Math.PI / 2;
    inner.position.x = 0.06;
    g.add(inner);
    const p = surfacePoint(uFromSR(0.5), sideI(0.42, sgn));
    g.position.set(p.x + 0.03, 0.43, 0.3 * sgn);
    g.scale.set(1, 0.78, 1);
    g.rotation.y = Math.PI; // open end faces rearwards
    car.add(g);
  }

  // Rear wing: cambered aerofoil on swan-neck pylons
  {
    const foil = new THREE.Shape();
    const c = 0.32, t = 0.11, m = 0.05, pk = 0.42;
    const top = [], bot = [];
    for (let k = 0; k <= 40; k++) {
      const xx = 0.5 * (1 - Math.cos((k / 40) * Math.PI));
      const yt = 5 * t * (0.2969 * Math.sqrt(xx) - 0.126 * xx - 0.3516 * xx * xx + 0.2843 * xx ** 3 - 0.1036 * xx ** 4);
      const yc = xx < pk ? (m / pk ** 2) * (2 * pk * xx - xx * xx) : (m / (1 - pk) ** 2) * (1 - 2 * pk + 2 * pk * xx - xx * xx);
      top.push([xx * c, (yc + yt) * c]);
      bot.push([xx * c, (yc - yt) * c]);
    }
    // inverted (downforce): flip y, leading edge points forward (+x)
    foil.moveTo(-top[0][0], -top[0][1]);
    for (const [x, y] of top) foil.lineTo(-x, -y);
    for (let k = bot.length - 1; k >= 0; k--) foil.lineTo(-bot[k][0], -bot[k][1]);
    const span = 1.62;
    const g = new THREE.ExtrudeGeometry(foil, { depth: span, bevelEnabled: false, curveSegments: 2 });
    g.translate(0, 0, -span / 2);
    const pos = g.getAttribute('position'), uv = g.getAttribute('uv');
    for (let k = 0; k < pos.count; k++) uv.setXY(k, pos.getZ(k), (pos.getX(k) + pos.getY(k)) );
    const wing = mesh(g, M.carbon);
    const wingGroup = new THREE.Group();
    wingGroup.add(wing);
    wingGroup.position.set(-1.8, 1.15, 0);
    wingGroup.rotation.z = 0.12; // angle of attack
    // endplates
    for (const sgn of [1, -1]) {
      const ep = new THREE.Shape();
      ep.moveTo(0.05, 0.05);
      ep.lineTo(-0.34, 0.07);
      ep.quadraticCurveTo(-0.37, 0.07, -0.37, 0.04);
      ep.lineTo(-0.36, -0.14);
      ep.quadraticCurveTo(-0.36, -0.17, -0.33, -0.17);
      ep.lineTo(0.0, -0.12);
      ep.quadraticCurveTo(0.05, -0.11, 0.05, -0.07);
      ep.closePath();
      const eg = new THREE.ExtrudeGeometry(ep, { depth: 0.008, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.002, bevelSegments: 1 });
      eg.translate(0, 0, sgn > 0 ? span / 2 : -span / 2 - 0.008);
      const epos = eg.getAttribute('position'), euv = eg.getAttribute('uv');
      for (let k = 0; k < epos.count; k++) euv.setXY(k, epos.getX(k), epos.getY(k) );
      wingGroup.add(mesh(eg, M.carbon));
    }
    // third brake light along the trailing edge
    const tb = mesh(new THREE.BoxGeometry(0.004, 0.006, 0.36), M.brake, { cast: false });
    tb.position.set(-c + 0.004, -0.004, 0);
    wingGroup.add(tb);
    car.add(wingGroup);
    // swan-neck pylons from the engine cover up to the wing underside
    for (const sgn of [1, -1]) {
      const z = 0.36 * sgn;
      const deck = surfacePoint(-1.92, sideI(5.55, sgn));
      const s = new THREE.Shape();
      s.moveTo(-1.86, deck.y - 0.02);
      s.lineTo(-1.98, deck.y - 0.02);
      s.quadraticCurveTo(-2.02, 1.03, -1.9, 1.105);
      s.lineTo(-1.82, 1.13);
      s.quadraticCurveTo(-1.9, 1.06, -1.86, deck.y - 0.02);
      const pg = new THREE.ExtrudeGeometry(s, { depth: 0.012, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.002, bevelSegments: 1 });
      pg.translate(0, 0, z - 0.006);
      const ppos = pg.getAttribute('position'), puv = pg.getAttribute('uv');
      for (let k = 0; k < ppos.count; k++) puv.setXY(k, ppos.getX(k), ppos.getY(k) );
      car.add(mesh(pg, M.carbon));
    }
  }

  // ---- Badges, plate ---------------------------------------------------------------
  {
    const f = surfaceFrame(uFromSR(0.12), 6);
    const plate = mesh(new THREE.PlaneGeometry(0.52, 0.11), new THREE.MeshPhysicalMaterial({ map: M.tex(M.plateCanvas('AER·7S'), { srgb: true }), roughness: 0.35, clearcoat: 0.6 }), { cast: false });
    plate.material.map.wrapS = plate.material.map.wrapT = THREE.ClampToEdgeWrapping;
    plate.position.copy(f.p).addScaledVector(f.n, 0.012);
    plate.lookAt(plate.position.clone().add(f.n));
    car.add(plate);
    const back = mesh(new RoundedBoxGeometry(0.54, 0.125, 0.012, 2, 0.004), M.gloss);
    back.position.copy(f.p).addScaledVector(f.n, 0.004);
    back.lookAt(back.position.clone().add(f.n));
    car.add(back);
    const wf = surfaceFrame(uFromSR(0.52), 6);
    const wm = mesh(new THREE.PlaneGeometry(0.44, 0.069), new THREE.MeshStandardMaterial({ color: 0xd8dade, metalness: 1, roughness: 0.38, alphaMap: M.tex(M.wordmarkCanvas('AERIS')), transparent: true, alphaTest: 0.4 }), { cast: false });
    wm.material.alphaMap.wrapS = wm.material.alphaMap.wrapT = THREE.ClampToEdgeWrapping;
    wm.position.copy(wf.p).addScaledVector(wf.n, 0.002);
    wm.lookAt(wm.position.clone().add(wf.n));
    car.add(wm);
    // nose emblem: chevron
    const nf = surfaceFrame(uFromSF(0.8), 6);
    const ch = new THREE.Shape();
    ch.moveTo(-0.045, 0.018);
    ch.lineTo(0, -0.02);
    ch.lineTo(0.045, 0.018);
    ch.lineTo(0.033, 0.024);
    ch.lineTo(0, -0.004);
    ch.lineTo(-0.033, 0.024);
    ch.closePath();
    const em = mesh(new THREE.ExtrudeGeometry(ch, { depth: 0.004, bevelEnabled: true, bevelThickness: 0.0015, bevelSize: 0.0012, bevelSegments: 2 }), M.chrome, { cast: false });
    em.position.copy(nf.p).addScaledVector(nf.n, 0.001);
    em.lookAt(em.position.clone().add(nf.n));
    car.add(em);
  }

  // ---- Engine bay under the rear glass -------------------------------------------
  {
    const cover = mesh(new RoundedBoxGeometry(0.62, 0.02, 0.86, 3, 0.008), M.carbon);
    cover.position.set(-1.02, 0.9, 0);
    car.add(cover);
    for (const sgn of [1, -1]) {
      const bank = mesh(new RoundedBoxGeometry(0.5, 0.07, 0.15, 4, 0.03), M.caliper);
      bank.position.set(-1.02, 0.945, 0.2 * sgn);
      car.add(bank);
      for (let k = 0; k < 4; k++) {
        const coil = mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.02, 12), M.gloss);
        coil.position.set(-1.2 + k * 0.12, 0.985, 0.2 * sgn);
        car.add(coil);
      }
    }
  }

  // ---- Interior --------------------------------------------------------------------
  onProgress('Trimming the interior');
  buildInterior(car, M);

  // ---- API ----------------------------------------------------------------------------
  api.doors = doors;
  api.wheels = wheels;
  api.lights = lights;
  api.headLens = headLens;
  api.setWheelStyle = (s) => setWheelStyle(wheels, s);
  api.setDoorT = (t) => {
    for (const d of doors) {
      d.t = t;
      const e = t * t * (3 - 2 * t);
      d.pivot.quaternion.setFromAxisAngle(d.axis, d.max * e);
    }
  };
  car.userData.api = api;
  return car;
}

function buildInterior(car, M) {
  const DZ = D.driverZ;
  const cabin = new THREE.Group();
  cabin.position.x = 0.3; // cabin sits 30 cm forward of the original package
  car.add(cabin);
  car = cabin;
  const add = (o) => { car.add(o); return o; };
  // Dashboard
  const dash = new THREE.Shape();
  dash.moveTo(0.68, 0.5);
  dash.lineTo(0.68, 0.84);
  dash.quadraticCurveTo(0.5, 0.9, 0.3, 0.86);
  dash.quadraticCurveTo(0.14, 0.84, 0.12, 0.76);
  dash.quadraticCurveTo(0.1, 0.66, 0.2, 0.58);
  dash.quadraticCurveTo(0.3, 0.5, 0.46, 0.48);
  dash.closePath();
  const dg = new THREE.ExtrudeGeometry(dash, { depth: 1.5, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 3, curveSegments: 16 });
  dg.translate(0, 0, -0.75);
  add(mesh(dg, M.leather));
  // stitched accent along the dash top
  const st = mesh(new THREE.BoxGeometry(0.006, 0.004, 1.44), M.accent, { cast: false });
  st.position.set(0.33, 0.862, 0);
  st.rotation.z = 0.08;
  add(st);
  // instrument binnacle and cluster display
  const bin = new THREE.Shape();
  bin.moveTo(0.34, 0.86);
  bin.quadraticCurveTo(0.26, 0.95, 0.12, 0.92);
  bin.lineTo(0.13, 0.9);
  bin.quadraticCurveTo(0.24, 0.915, 0.3, 0.85);
  bin.closePath();
  const bg = new THREE.ExtrudeGeometry(bin, { depth: 0.36, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.008, bevelSegments: 2 });
  bg.translate(0, 0, DZ - 0.18);
  add(mesh(bg, M.leather));
  const cl = mesh(new THREE.PlaneGeometry(0.3, 0.105), M.cluster, { cast: false });
  cl.position.set(0.2, 0.845, DZ);
  cl.rotation.set(0, -Math.PI / 2, 0);
  cl.rotateX(-0.25);
  add(cl);
  // centre screen
  const scr = mesh(new RoundedBoxGeometry(0.012, 0.135, 0.215, 2, 0.004), M.gloss);
  scr.position.set(0.16, 0.73, 0);
  scr.rotation.z = 0.25;
  add(scr);
  const sp = mesh(new THREE.PlaneGeometry(0.2, 0.124), M.screen, { cast: false });
  sp.position.set(0.153, 0.731, 0);
  sp.rotation.set(0, -Math.PI / 2, 0);
  sp.rotateX(-0.25);
  add(sp);
  // vents
  for (const z of [-0.12, 0.12, DZ + 0.24, -DZ - 0.24]) {
    const v = mesh(new RoundedBoxGeometry(0.02, 0.035, 0.09, 2, 0.006), M.brushed);
    v.position.set(0.15, 0.8, z);
    add(v);
  }
  // ambient strip under the dash lip
  const amb = new THREE.CatmullRomCurve3([V(0.2, 0.585, -0.72), V(0.15, 0.6, -0.3), V(0.14, 0.6, 0.3), V(0.2, 0.585, 0.72)]);
  add(mesh(new THREE.TubeGeometry(amb, 60, 0.003, 6, false), M.ambient, { cast: false }));

  // Centre console / tunnel
  const con = mesh(new RoundedBoxGeometry(1.0, 0.3, 0.24, 4, 0.04), M.leather);
  con.position.set(-0.22, 0.3, 0);
  add(con);
  const conTop = mesh(new RoundedBoxGeometry(0.62, 0.02, 0.17, 2, 0.008), M.carbon);
  conTop.position.set(-0.2, 0.455, 0);
  add(conTop);
  const sel = mesh(new RoundedBoxGeometry(0.07, 0.05, 0.05, 3, 0.015), M.brushed);
  sel.position.set(-0.06, 0.49, 0);
  add(sel);
  for (const sgn of [1, -1]) {
    add(mesh(new THREE.TubeGeometry(new THREE.LineCurve3(V(0.18, 0.43, 0.121 * sgn), V(-0.6, 0.43, 0.121 * sgn)), 4, 0.0025, 6), M.ambient, { cast: false }));
  }

  // Steering wheel (flat-bottomed, alcantara rim, carbon top section)
  const sw = new THREE.Group();
  const rimG = new THREE.TorusGeometry(0.172, 0.019, 16, 96);
  const rp = rimG.getAttribute('position');
  for (let k = 0; k < rp.count; k++) if (rp.getY(k) < -0.13) rp.setY(k, -0.13 + (rp.getY(k) + 0.13) * 0.25);
  rimG.computeVertexNormals();
  sw.add(mesh(rimG, M.leather));
  const topMark = mesh(new THREE.TorusGeometry(0.172, 0.0195, 8, 12, 0.08), M.accent);
  topMark.rotation.z = Math.PI / 2 - 0.04;
  sw.add(topMark);
  for (const a of [0, Math.PI, -Math.PI / 2]) {
    const sp2 = mesh(new RoundedBoxGeometry(0.15, 0.03, 0.022, 2, 0.008), M.brushed);
    sp2.position.set(Math.cos(a) * 0.09, Math.sin(a) * 0.09, 0);
    sp2.rotation.z = a;
    sw.add(sp2);
  }
  const hubM = mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.04, 32).rotateX(Math.PI / 2), M.leather);
  sw.add(hubM);
  const logo = mesh(new THREE.TorusGeometry(0.014, 0.002, 6, 3), M.chrome);
  logo.position.z = 0.022;
  logo.rotation.z = Math.PI / 2;
  sw.add(logo);
  for (const sgn of [1, -1]) {
    const pad = mesh(new RoundedBoxGeometry(0.03, 0.09, 0.006, 2, 0.003), M.carbon);
    pad.position.set(0.15 * sgn, 0.02, -0.035);
    sw.add(pad);
  }
  const swHolder = new THREE.Group();
  swHolder.position.set(0.04, 0.73, DZ);
  swHolder.rotation.set(0, -Math.PI / 2, 0);
  swHolder.rotateX(0.32);
  swHolder.add(sw);
  add(swHolder);
  add(beam(V(0.06, 0.72, DZ), V(0.26, 0.77, DZ), 0.03, 0.04, M.leather));

  // Soft courtesy light so the cabin reads through the tinted glass
  const cabinLight = new THREE.PointLight(0xffe2c4, 0.5, 1.8, 2);
  cabinLight.position.set(-0.15, 1.05, 0);
  add(cabinLight);
  // Seats
  for (const z of [DZ, -DZ]) buildSeat(car, M, z);

  // Floor carpet, firewall and rear bulkhead
  const floor = mesh(new THREE.PlaneGeometry(1.4, 1.5), M.trim, { cast: false });
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(-0.2, 0.15, 0);
  add(floor);
  const bulk = mesh(new THREE.PlaneGeometry(1.7, 1.0), M.trim, { cast: false });
  bulk.rotation.y = Math.PI / 2;
  bulk.position.set(-0.98, 0.65, 0);
  add(bulk);
  const shelf = mesh(new RoundedBoxGeometry(0.2, 0.03, 1.5, 2, 0.01), M.leather);
  shelf.position.set(-0.95, 0.88, 0);
  add(shelf);
}

function buildSeat(car, M, z) {
  const g = new THREE.Group();
  g.position.set(-0.47, 0.2, z);
  const cushion = mesh(new RoundedBoxGeometry(0.5, 0.1, 0.46, 4, 0.04), M.leather);
  cushion.position.set(0, 0.04, 0);
  g.add(cushion);
  const cIns = mesh(new RoundedBoxGeometry(0.4, 0.02, 0.22, 3, 0.008), M.accent);
  cIns.position.set(0.01, 0.092, 0);
  g.add(cIns);
  for (const s of [1, -1]) {
    const b = mesh(new RoundedBoxGeometry(0.46, 0.08, 0.08, 4, 0.035), M.leather);
    b.position.set(0, 0.1, 0.2 * s);
    b.rotation.x = 0.25 * s;
    g.add(b);
  }
  const back = new THREE.Group();
  back.position.set(-0.24, 0.08, 0);
  back.rotation.z = 0.32;
  const bgeo = new RoundedBoxGeometry(0.1, 0.66, 0.48, 4, 0.04);
  const p = bgeo.getAttribute('position');
  for (let k = 0; k < p.count; k++) {
    const y = p.getY(k);
    if (y > 0.12) p.setZ(k, p.getZ(k) * THREE.MathUtils.lerp(1, 0.6, Math.min(1, (y - 0.12) / 0.14)));
  }
  bgeo.computeVertexNormals();
  const bm = mesh(bgeo, M.leather);
  bm.position.y = 0.33;
  back.add(bm);
  const bIns = mesh(new RoundedBoxGeometry(0.02, 0.4, 0.2, 3, 0.008), M.accent);
  bIns.position.set(0.055, 0.27, 0);
  back.add(bIns);
  for (const s of [1, -1]) {
    const bol = mesh(new RoundedBoxGeometry(0.12, 0.42, 0.075, 4, 0.035), M.leather);
    bol.position.set(0.04, 0.24, 0.205 * s);
    bol.rotation.y = -0.3 * s;
    back.add(bol);
  }
  // harness slots in the headrest area
  for (const s of [1, -1]) {
    const slot = mesh(new RoundedBoxGeometry(0.02, 0.05, 0.022, 2, 0.008), M.satin);
    slot.position.set(0.05, 0.55, 0.075 * s);
    back.add(slot);
  }
  g.add(back);
  car.add(g);
}
