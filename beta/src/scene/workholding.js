// Machine vise, parallels and the work-coordinate marker. Geometry is built in the table frame and
// converted to the table group's local Three.js frame: (x, y, z)table -> (x, z, -y)three.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { VISE } from '../config.js';

// Where the stock sits for a given stock spec. Shared by the scene, the Z-map and the setup logic.
export function stockPlacement(stock) {
  const jawTop = VISE.floor + VISE.jawHeight;
  const W = Math.min(stock.y, VISE.maxOpening);
  const protrusion = Math.max(2, Math.min(stock.protrusion, stock.z - 3));
  const top = jawTop + protrusion;
  const bottom = Math.max(VISE.floor, top - stock.z);
  return {
    x0: -stock.x / 2, y0: -W / 2, lx: stock.x, ly: W, top: bottom + stock.z, bottom,
    jawTop, protrusion: bottom + stock.z - jawTop, width: W,
  };
}

const mats = {};
function M() {
  if (mats.body) return mats;
  mats.body = new THREE.MeshStandardMaterial({ color: 0x3b4552, roughness: 0.55, metalness: 0.35 });
  mats.jaw = new THREE.MeshStandardMaterial({ color: 0xaab1b8, roughness: 0.26, metalness: 1 });
  mats.dark = new THREE.MeshStandardMaterial({ color: 0x1d1f22, roughness: 0.5, metalness: 0.6 });
  mats.parallel = new THREE.MeshStandardMaterial({ color: 0xc9cfd4, roughness: 0.2, metalness: 1 });
  return mats;
}

function tbox(g, x0, y0, z0, x1, y1, z1, mat, round = 0) {
  const geo = round ? new RoundedBoxGeometry(x1 - x0, z1 - z0, y1 - y0, 2, round) : new THREE.BoxGeometry(x1 - x0, z1 - z0, y1 - y0);
  const m = new THREE.Mesh(geo, mat);
  m.position.set((x0 + x1) / 2, (z0 + z1) / 2, -(y0 + y1) / 2);
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

// Returns { group, boxes } where boxes are table-frame AABBs used for collision checks.
export function buildVise(place) {
  const m = M();
  const g = new THREE.Group();
  g.name = 'vise';
  const W = place.width;
  const fl = VISE.floor, jt = place.jawTop, jw = VISE.jawWidth / 2, th = VISE.jawThickness;
  const boxes = [];
  const add = (name, x0, y0, z0, x1, y1, z1, mat, round) => {
    tbox(g, x0, y0, z0, x1, y1, z1, mat, round);
    if (name) boxes.push({ name, min: [x0, y0, z0], max: [x1, y1, z1] });
  };
  // base and body
  add('vise base', -95, -255, 0, 95, 205, 20, m.body, 4);
  add('vise body', -78, -240, 20, 78, 195, fl - 10, m.body, 5);
  add(null, -70, -230, fl - 10, 70, 190, fl, m.jaw);
  // fixed jaw at the back (+Y), moving jaw at the front (-Y)
  add('fixed jaw', -jw, W / 2 + 6, fl, jw, W / 2 + th, jt, m.body, 3);
  add('fixed jaw plate', -jw, W / 2, fl + 4, jw, W / 2 + 6, jt, m.jaw);
  add('moving jaw', -jw, -W / 2 - th, fl, jw, -W / 2 - 6, jt, m.body, 3);
  add('moving jaw plate', -jw, -W / 2 - 6, fl + 4, jw, -W / 2, jt, m.jaw);
  // rear jaw support block
  add('vise body', -78, W / 2 + th, fl - 10, 78, Math.min(195, W / 2 + th + 40), fl + 20, m.body, 4);
  // parallels under the stock
  if (place.bottom > fl + 0.5) {
    for (const s of [-1, 1]) {
      const yc = s * (W / 2 - 7);
      add(null, -75, yc - 2.5, fl, 75, yc + 2.5, place.bottom, m.parallel);
    }
  }
  // screw and handle out of the front of the vise
  const screw = new THREE.Mesh(new THREE.CylinderGeometry(11, 11, 60, 16), m.jaw);
  screw.rotation.x = Math.PI / 2;
  screw.position.set(0, 45, 255 + 30);
  g.add(screw);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(18, 18, 30, 6), m.dark);
  hub.rotation.x = Math.PI / 2;
  hub.position.set(0, 45, 320);
  g.add(hub);
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 220, 12), m.dark);
  bar.rotation.z = Math.PI / 2;
  bar.position.set(0, 45, 330);
  g.add(bar);
  boxes.push({ name: 'vise handle', min: [-110, -350, 30], max: [110, -255, 60] });
  // clamps holding the vise to the T-slots
  for (const s of [-1, 1]) {
    add(null, s * 95, -40, 0, s * 95 + s * 40, 40, 14, m.dark);
    const bolt = new THREE.Mesh(new THREE.CylinderGeometry(8, 8, 40, 6), m.dark);
    bolt.position.set(s * 112, 20, 0);
    g.add(bolt);
  }
  return { group: g, boxes };
}

// X/Y/Z triad drawn at the active work zero.
export function buildWcsMarker() {
  const g = new THREE.Group();
  g.name = 'wcs';
  const mk = (color, dir, label) => {
    const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(), 28, color, 7, 4);
    arrow.traverse((o) => {
      if (o.material) {
        o.material.depthTest = false;
        o.material.transparent = true;
        o.material.opacity = 0.95;
      }
      o.renderOrder = 10;
    });
    g.add(arrow);
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#' + new THREE.Color(color).getHexString();
    ctx.font = '700 46px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 32, 34);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
    sp.scale.setScalar(10);
    sp.position.copy(dir).multiplyScalar(36);
    sp.renderOrder = 11;
    g.add(sp);
  };
  mk(0xff5a4f, new THREE.Vector3(1, 0, 0), 'X');
  mk(0x45d483, new THREE.Vector3(0, 0, -1), 'Y');
  mk(0x4aa3ff, new THREE.Vector3(0, 1, 0), 'Z');
  const dot = new THREE.Mesh(new THREE.SphereGeometry(2.2, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
  dot.renderOrder = 11;
  g.add(dot);
  return g;
}
