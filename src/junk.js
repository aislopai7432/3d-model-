// Rubbish geometry library. Every junk type builds a handful of deformed variants whose UVs
// point into the shared texture atlas, so all rubbish renders with one material.
// Geometry is authored lying down: y is the thickness axis, the base sits at y = 0.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { getAtlas } from './textures.js';
import { mulberry, noise3, fbm3 } from './rng.js';

const V3 = THREE.Vector3;

export function prep(g) {
  if (g.index) g = g.toNonIndexed();
  if (!g.getAttribute('uv')) {
    const n = g.getAttribute('position').count;
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  }
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  return g;
}
// map uv [0..1] into an atlas tile (optionally a sub-rectangle of it)
export function tileUV(g, slot, sub = [0, 0, 1, 1]) {
  const A = getAtlas();
  const [u0, v0, u1, v1] = A.rect(slot);
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) {
    let u = uv.getX(i), v = uv.getY(i);
    u = sub[0] + (sub[2] - sub[0]) * THREE.MathUtils.clamp(u, 0, 1);
    v = sub[1] + (sub[3] - sub[1]) * THREE.MathUtils.clamp(v, 0, 1);
    uv.setXY(i, u0 + (u1 - u0) * u, v0 + (v1 - v0) * v);
  }
  return g;
}
function displace(g, fn) {
  const p = g.getAttribute('position'), v = new V3();
  for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); fn(v, i); p.setXYZ(i, v.x, v.y, v.z); }
  return g;
}
function crumple(g, amp, freq, seed) {
  return displace(g, (v) => {
    v.x += noise3(v.x * freq, v.y * freq, v.z * freq, seed) * amp;
    v.y += noise3(v.x * freq + 7, v.y * freq, v.z * freq, seed + 1) * amp;
    v.z += noise3(v.x * freq, v.y * freq + 3, v.z * freq, seed + 2) * amp;
  });
}
function merge(list) {
  return mergeGeometries(list.map(prep), false);
}
// rest the geometry on y = 0, centred in xz
export function settle(g) {
  g.deleteAttribute('normal');
  g = mergeVertices(g, 1e-5); // weld so deformed surfaces shade smoothly (uv seams stay split)
  g.computeBoundingBox();
  const b = g.boundingBox;
  g.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

// ---- Builders: (rng, variantIndex) → BufferGeometry ------------------------------
const A = () => getAtlas();

function can(r, i) {
  const g = prep(new THREE.CylinderGeometry(0.033, 0.033, 0.122, 16, 5, false));
  tileUV(g, A().tile('can', i));
  const squash = r.range(0.25, 0.75), twist = r.range(-0.6, 0.6), seed = r.int(0, 1e6);
  displace(g, (v) => {
    const t = v.y / 0.061;
    const pinch = 1 - 0.35 * Math.max(0, 1 - Math.abs(t)) * r.range(0.6, 1);
    v.x *= squash + (1 - squash) * Math.abs(t) * 0.6;
    v.z *= pinch;
    const a = twist * t;
    const x = v.x * Math.cos(a) - v.z * Math.sin(a), z = v.x * Math.sin(a) + v.z * Math.cos(a);
    v.x = x; v.z = z;
    v.x += noise3(v.x * 40, v.y * 40, v.z * 40, seed) * 0.006;
    v.z += noise3(v.x * 40 + 5, v.y * 40, v.z * 40, seed) * 0.006;
  });
  g.rotateZ(Math.PI / 2);
  return g;
}

function bottle(r, i) {
  const pts = [];
  const prof = [[0, 0], [0.034, 0.003], [0.037, 0.02], [0.037, 0.17], [0.03, 0.2], [0.015, 0.235], [0.013, 0.25], [0.014, 0.26], [0.0, 0.262]];
  for (let k = 0; k < 24; k++) {
    const t = k / 23 * 0.262;
    let j = 0;
    while (j < prof.length - 2 && prof[j + 1][1] < t) j++;
    const a = prof[j], b = prof[j + 1], f = (t - a[1]) / Math.max(1e-6, b[1] - a[1]);
    pts.push(new THREE.Vector2(a[0] + (b[0] - a[0]) * f + 0.0005, t));
  }
  const g = prep(new THREE.LatheGeometry(pts, 14));
  tileUV(g, A().tile('bottle', i));
  const squash = r.range(0.35, 0.9), seed = r.int(0, 1e6);
  displace(g, (v) => { v.x *= squash; v.x += noise3(v.x * 30, v.y * 30, v.z * 30, seed) * 0.008; v.z += noise3(v.x * 30, v.y * 30 + 4, v.z * 30, seed) * 0.008; });
  g.rotateZ(Math.PI / 2);
  return g;
}

function box(r, i) {
  const w = r.range(0.26, 0.42), h = r.range(0.12, 0.24), d = r.range(0.2, 0.32);
  const g = prep(new THREE.BoxGeometry(w, h, d, 4, 3, 4));
  tileUV(g, A().tile('cardboard', i));
  const seed = r.int(0, 1e6), sag = r.range(0.2, 0.6);
  displace(g, (v) => {
    const top = (v.y + h / 2) / h;
    v.y -= sag * h * top * (1 - Math.abs(v.x) / w * 1.6) * (1 - Math.abs(v.z) / d * 1.6) * 0.8;
    v.x += noise3(v.x * 9, v.y * 9, v.z * 9, seed) * 0.018;
    v.z += noise3(v.x * 9, v.y * 9 + 3, v.z * 9, seed) * 0.018;
    v.y += noise3(v.x * 9 + 2, v.y * 9, v.z * 9, seed) * 0.012;
  });
  // open flaps
  const flaps = [];
  for (let k = 0; k < 2; k++) {
    if (r() < 0.4) continue;
    const f = prep(new THREE.BoxGeometry(w * 0.95, 0.004, d * 0.45, 4, 1, 3));
    tileUV(f, A().tile('cardboard', i), [0, 0, 1, 0.45]);
    f.translate(0, 0, d * 0.22);
    f.rotateX(-r.range(0.3, 1.3));
    f.rotateY(k * Math.PI);
    f.translate(0, h / 2 * (1 - sag * 0.5), 0);
    flaps.push(f);
  }
  return merge([g, ...flaps]);
}

function sheet(r, i) {
  const w = r.range(0.38, 0.62), d = r.range(0.28, 0.44);
  const g = prep(new THREE.BoxGeometry(w, 0.006, d, 8, 1, 6));
  tileUV(g, A().tile('cardboard', i));
  const bend = r.range(-0.6, 0.6), seed = r.int(0, 1e6), foldX = r.range(-0.2, 0.2);
  displace(g, (v) => {
    v.y += Math.sin((v.x / w) * Math.PI) * bend * 0.06 + Math.max(0, v.x - foldX * w) * r.range(0, 0.0) + noise3(v.x * 6, 0, v.z * 6, seed) * 0.025;
  });
  return g;
}

function paper(r) {
  const w = 0.38, d = 0.29;
  const g = prep(new THREE.BoxGeometry(w, 0.01, d, 10, 1, 7));
  tileUV(g, A().tile('newsprint', r.int(0, 2)));
  const seed = r.int(0, 1e6), fold = r() < 0.5;
  displace(g, (v) => {
    if (fold && v.x > 0) { const a = r.range(0.2, 0.25) * 0 + 0.5; v.y += v.x * Math.sin(a) * 0.4; }
    v.y += fbm3(v.x * 5, 0, v.z * 5, seed) * 0.05;
    v.x += noise3(v.x * 8, v.y, v.z * 8, seed + 3) * 0.012;
  });
  return g;
}

function bag(r, i) {
  const g = prep(new THREE.IcosahedronGeometry(0.15, 2));
  // spherical uv
  const p = g.getAttribute('position'), uv = g.getAttribute('uv');
  for (let k = 0; k < p.count; k++) {
    const x = p.getX(k), y = p.getY(k), z = p.getZ(k);
    uv.setXY(k, 0.5 + Math.atan2(z, x) / (Math.PI * 2), 0.5 + Math.asin(THREE.MathUtils.clamp(y / 0.15, -1, 1)) / Math.PI);
  }
  tileUV(g, A().tile('bag', i));
  const seed = r.int(0, 1e6), flat = r.range(0.35, 0.6), sx = r.range(0.9, 1.5);
  displace(g, (v) => {
    const n = fbm3(v.x * 9, v.y * 9, v.z * 9, seed, 3);
    const k = 1 + n * 0.55;
    v.multiplyScalar(k);
    v.y *= flat;
    v.x *= sx;
  });
  // knotted top
  const knot = prep(new THREE.ConeGeometry(0.03, 0.07, 8, 2));
  tileUV(knot, A().tile('bag', i));
  crumple(knot, 0.01, 30, seed);
  knot.rotateZ(Math.PI / 2 + 0.3);
  knot.translate(0.15 * sx, 0.04, 0);
  return merge([g, knot]);
}

function clothes(r, i) {
  const w = r.range(0.45, 0.65), d = r.range(0.35, 0.5);
  const g = prep(new THREE.BoxGeometry(w, 0.008, d, 12, 1, 9));
  tileUV(g, A().tile('fabric', i));
  const seed = r.int(0, 1e6), fold = r.range(0.4, 0.9);
  displace(g, (v) => {
    v.y += Math.abs(fbm3(v.x * 6, 0.3, v.z * 6, seed, 4)) * 0.09 * fold;
    v.x += noise3(v.x * 5, 0, v.z * 5, seed + 2) * 0.05;
    v.z += noise3(v.x * 5, 1, v.z * 5, seed + 3) * 0.05;
  });
  return g;
}

function packaging(r, i) {
  const kind = i % 6, slot = A().tile('packaging', kind);
  let g;
  if (kind === 0 || kind === 5) { // cereal box / biscuit box, squashed
    g = prep(new THREE.BoxGeometry(0.2, 0.05, 0.28, 4, 2, 6));
    tileUV(g, slot);
    crumple(g, 0.01, 12, r.int(0, 1e6));
  } else if (kind === 1) { // crisp packet: pillow
    g = prep(new THREE.BoxGeometry(0.16, 0.04, 0.22, 8, 2, 10));
    tileUV(g, slot);
    displace(g, (v) => { const k = (1 - (v.x / 0.08) ** 2) * (1 - (v.z / 0.11) ** 2); v.y *= 0.4 + Math.max(0, k) * 1.3; });
    crumple(g, 0.008, 25, r.int(0, 1e6));
  } else if (kind === 2) { // pizza box
    g = prep(new THREE.BoxGeometry(0.33, 0.04, 0.33, 4, 1, 4));
    tileUV(g, slot);
    crumple(g, 0.006, 8, r.int(0, 1e6));
  } else if (kind === 3) { // milk carton with gable top
    const b = prep(new THREE.BoxGeometry(0.07, 0.19, 0.07, 2, 4, 2));
    tileUV(b, slot);
    const top = prep(new THREE.ConeGeometry(0.05, 0.04, 4, 1));
    tileUV(top, slot, [0, 0.8, 1, 1]);
    top.rotateY(Math.PI / 4);
    top.translate(0, 0.115, 0);
    g = merge([b, top]);
    crumple(g, 0.006, 20, r.int(0, 1e6));
    g.rotateZ(Math.PI / 2);
  } else { // takeaway tray
    const pts = [new THREE.Vector2(0.0, 0), new THREE.Vector2(0.075, 0.0), new THREE.Vector2(0.09, 0.045), new THREE.Vector2(0.092, 0.047)];
    g = prep(new THREE.LatheGeometry(pts, 4, Math.PI / 4));
    tileUV(g, slot);
    displace(g, (v) => { v.x *= 1.5; });
    crumple(g, 0.006, 20, r.int(0, 1e6));
  }
  return g;
}

function toy(r, i) {
  const slot = A().tile('plastic');
  const kind = i % 4;
  if (kind === 0) { // building brick
    const b = prep(new THREE.BoxGeometry(0.064, 0.038, 0.032));
    const studs = [];
    for (let x = 0; x < 4; x++) for (let z = 0; z < 2; z++) { const s = prep(new THREE.CylinderGeometry(0.0048, 0.0048, 0.006, 10)); s.translate(-0.024 + x * 0.016, 0.022, -0.008 + z * 0.016); studs.push(s); }
    const g = merge([b, ...studs]);
    tileUV(g, slot);
    g.scale(1.6, 1.6, 1.6);
    return g;
  }
  if (kind === 1) { const g = prep(new THREE.SphereGeometry(r.range(0.05, 0.1), 20, 14)); tileUV(g, slot); crumple(g, 0.008, 10, r.int(0, 1e6)); return g; }
  if (kind === 2) { // rubber duck
    const body = prep(new THREE.SphereGeometry(0.055, 16, 12)); body.scale(1.25, 0.85, 1);
    const head = prep(new THREE.SphereGeometry(0.032, 14, 10)); head.translate(0.035, 0.06, 0);
    const beak = prep(new THREE.ConeGeometry(0.012, 0.03, 8)); beak.rotateZ(-Math.PI / 2); beak.translate(0.075, 0.055, 0);
    const g = merge([body, head, beak]);
    tileUV(g, slot);
    return g;
  }
  // toy truck
  const cab = prep(new THREE.BoxGeometry(0.06, 0.05, 0.06)); cab.translate(0.07, 0.04, 0);
  const bed = prep(new THREE.BoxGeometry(0.12, 0.03, 0.065)); bed.translate(-0.02, 0.03, 0);
  const wheels = [];
  for (const x of [-0.05, 0.07]) for (const z of [-0.035, 0.035]) { const w = prep(new THREE.CylinderGeometry(0.018, 0.018, 0.012, 12)); w.rotateX(Math.PI / 2); w.translate(x, 0.018, z); wheels.push(w); }
  const g = merge([cab, bed, ...wheels]);
  tileUV(g, slot);
  return g;
}

function wood(r, i) {
  const len = r.range(0.3, 0.75), w = r.range(0.06, 0.11), t = r.range(0.018, 0.03);
  const g = prep(new THREE.BoxGeometry(len, t, w, 10, 1, 2));
  tileUV(g, A().tile('wood', i));
  const seed = r.int(0, 1e6);
  displace(g, (v) => {
    if (Math.abs(v.x) > len * 0.42) v.x += noise3(0, v.z * 40, 0, seed) * 0.04 * Math.sign(v.x); // splintered ends
    v.y += Math.sin(v.x / len * 3) * 0.006;
  });
  return g;
}

function household(r, i) {
  const kind = i % 3;
  if (kind === 0) { // bucket (plastic, open)
    const pts = [new THREE.Vector2(0.0, 0), new THREE.Vector2(0.085, 0), new THREE.Vector2(0.11, 0.22), new THREE.Vector2(0.115, 0.225)];
    const g = prep(new THREE.LatheGeometry(pts, 22));
    tileUV(g, A().tile('plastic'));
    crumple(g, 0.012, 9, r.int(0, 1e6));
    g.rotateZ(Math.PI / 2 - r.range(0, 0.3));
    return g;
  }
  if (kind === 1) { // cooking pan (aluminium)
    const pts = [new THREE.Vector2(0.0, 0), new THREE.Vector2(0.1, 0), new THREE.Vector2(0.11, 0.05), new THREE.Vector2(0.112, 0.052)];
    const pan = prep(new THREE.LatheGeometry(pts, 24));
    const handle = prep(new THREE.BoxGeometry(0.17, 0.012, 0.025));
    handle.translate(0.19, 0.045, 0);
    const g = merge([pan, handle]);
    tileUV(g, A().tile('aluminium'));
    crumple(g, 0.006, 8, r.int(0, 1e6));
    return g;
  }
  // mug
  const pts = [new THREE.Vector2(0.0, 0), new THREE.Vector2(0.038, 0), new THREE.Vector2(0.04, 0.095), new THREE.Vector2(0.036, 0.096), new THREE.Vector2(0.034, 0.01)];
  const body = prep(new THREE.LatheGeometry(pts, 20));
  const handle = prep(new THREE.TorusGeometry(0.025, 0.007, 8, 16, Math.PI));
  handle.rotateZ(-Math.PI / 2);
  handle.translate(0.04, 0.05, 0);
  const g = merge([body, handle]);
  tileUV(g, A().tile('ceramic'));
  g.rotateZ(Math.PI / 2);
  return g;
}

function glassJar(r, i) {
  const tall = i % 2 === 0;
  const prof = tall
    ? [[0, 0], [0.036, 0.0], [0.038, 0.2], [0.016, 0.25], [0.014, 0.3], [0.0, 0.3]]
    : [[0, 0], [0.05, 0.0], [0.052, 0.11], [0.04, 0.125], [0.04, 0.14], [0.0, 0.14]];
  const g = prep(new THREE.LatheGeometry(prof.map(([a, b]) => new THREE.Vector2(a + 0.0005, b)), 20));
  tileUV(g, A().tile('glass', i));
  if (r() < 0.5) displace(g, (v) => { if (v.y > (tall ? 0.22 : 0.1)) v.y = Math.min(v.y, (tall ? 0.22 : 0.1) + Math.abs(noise3(v.x * 60, 0, v.z * 60, i)) * 0.04); }); // broken neck
  g.rotateZ(Math.PI / 2);
  return g;
}

function tyre() {
  const g = prep(new THREE.TorusGeometry(0.26, 0.09, 14, 40));
  tileUV(g, A().tile('rubber'));
  g.rotateX(Math.PI / 2);
  displace(g, (v) => { const d = Math.hypot(v.x, v.z); if (d < 0.26) v.y *= 0.85; });
  return g;
}

function electronics(r, i) {
  const kind = i % 4;
  if (kind === 0) { // keyboard
    const g = prep(new THREE.BoxGeometry(0.45, 0.032, 0.16, 6, 1, 3));
    tileUV(g, A().tile('keyboard'));
    displace(g, (v) => { v.y += Math.sin(v.x * 4) * 0.004; });
    return g;
  }
  if (kind === 1) { // radio / router box
    const b = prep(new THREE.BoxGeometry(0.24, 0.09, 0.14, 3, 2, 2));
    tileUV(b, A().tile('monitor'), [0, 0.5, 1, 1]);
    const knob = prep(new THREE.CylinderGeometry(0.014, 0.014, 0.012, 14));
    knob.rotateX(Math.PI / 2);
    knob.translate(0.08, 0.0, 0.075);
    tileUV(knob, A().tile('aluminium'));
    const g = merge([b, knob]);
    crumple(g, 0.006, 10, r.int(0, 1e6));
    return g;
  }
  if (kind === 2) { // hard drive
    const g = prep(new THREE.BoxGeometry(0.147, 0.026, 0.102, 2, 1, 2));
    tileUV(g, A().tile('aluminium'));
    return g;
  }
  // old mobile phone
  const g = prep(new THREE.BoxGeometry(0.12, 0.022, 0.052, 2, 1, 2));
  tileUV(g, A().tile('monitor'), [0, 0, 1, 0.5]);
  return g;
}

function monitor(r, i) {
  if (i % 2 === 0) { // CRT
    const front = prep(new THREE.BoxGeometry(0.36, 0.3, 0.05, 2, 2, 1));
    tileUV(front, A().tile('monitor'), [0, 0, 1, 0.5]);
    front.translate(0, 0, 0.17);
    const back = prep(new THREE.CylinderGeometry(0.12, 0.17, 0.3, 4, 1));
    back.rotateY(Math.PI / 4);
    back.rotateX(Math.PI / 2);
    tileUV(back, A().tile('monitor'), [0, 0.5, 1, 1]);
    const g = merge([front, back]);
    crumple(g, 0.008, 6, r.int(0, 1e6));
    g.rotateX(-Math.PI / 2 + r.range(-0.2, 0.2));
    return g;
  }
  const g = prep(new THREE.BoxGeometry(0.52, 0.03, 0.32, 3, 1, 2)); // flat panel, face up
  tileUV(g, A().tile('monitor'), [0, 0, 1, 0.5]);
  return g;
}

function cables(r) {
  const list = [];
  const n = r.int(2, 4);
  for (let k = 0; k < n; k++) {
    const pts = [];
    let p = new V3(r.range(-0.1, 0.1), 0.01, r.range(-0.1, 0.1));
    for (let s = 0; s < 7; s++) { pts.push(p.clone()); p = p.clone().add(new V3(r.range(-0.12, 0.12), r.range(0, 0.02), r.range(-0.12, 0.12))); }
    const t = prep(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, r.range(0.004, 0.008), 6, false));
    tileUV(t, A().tile('plastic'));
    list.push(t);
  }
  const plug = prep(new THREE.BoxGeometry(0.05, 0.025, 0.035));
  tileUV(plug, A().tile('plastic'));
  list.push(plug);
  return merge(list);
}

function pcb(r, i) {
  const w = r.range(0.14, 0.3), d = r.range(0.1, 0.22);
  const g = prep(new THREE.BoxGeometry(w, 0.004, d, 4, 1, 4));
  tileUV(g, A().tile('pcb', i));
  const bend = r.range(-0.15, 0.15);
  displace(g, (v) => { v.y += v.x * v.x * bend * 4; });
  return g;
}

function scrap(r, i) {
  const kind = i % 4, slot = A().tile('rust', r.int(0, 3));
  let g;
  if (kind === 0) { // bent sheet metal
    g = prep(new THREE.BoxGeometry(r.range(0.3, 0.55), 0.004, r.range(0.2, 0.4), 10, 1, 8));
    tileUV(g, slot);
    const a = r.range(0.4, 1.4), seed = r.int(0, 1e6);
    displace(g, (v) => { if (v.x > 0) { v.y += v.x * Math.sin(a) * 0.9; v.x *= Math.cos(a) * 0.5 + 0.5; } v.y += noise3(v.x * 6, 0, v.z * 6, seed) * 0.02; });
  } else if (kind === 1) { // rebar
    const pts = [];
    for (let s = 0; s < 5; s++) pts.push(new V3(-0.35 + s * 0.18, s === 2 ? r.range(0, 0.1) : 0, r.range(-0.08, 0.08)));
    g = prep(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 30, 0.008, 6, false));
    tileUV(g, slot);
  } else if (kind === 2) { // angle iron
    const s = new THREE.Shape();
    s.moveTo(0, 0); s.lineTo(0.05, 0); s.lineTo(0.05, 0.005); s.lineTo(0.005, 0.005); s.lineTo(0.005, 0.05); s.lineTo(0, 0.05); s.closePath();
    g = prep(new THREE.ExtrudeGeometry(s, { depth: r.range(0.3, 0.6), bevelEnabled: false }));
    displace(g, (v) => { const u = v.clone(); v.set(u.z, u.y, u.x); });
    const uv = g.getAttribute('uv'), p = g.getAttribute('position');
    for (let k = 0; k < uv.count; k++) uv.setXY(k, p.getX(k) * 2, (p.getY(k) + p.getZ(k)) * 5);
    tileUV(g, slot);
    g.rotateZ(r.range(-0.3, 0.3));
  } else { // pipe section
    const pts = [new THREE.Vector2(0.03, -0.2), new THREE.Vector2(0.03, 0.2), new THREE.Vector2(0.026, 0.2), new THREE.Vector2(0.026, -0.2), new THREE.Vector2(0.03, -0.2)];
    g = prep(new THREE.LatheGeometry(pts, 16));
    tileUV(g, slot);
    crumple(g, 0.006, 6, r.int(0, 1e6));
    g.rotateZ(Math.PI / 2);
  }
  return g;
}

function furniture(r, i) {
  const kind = i % 3;
  if (kind === 0) { // chair leg
    const g = prep(new THREE.CylinderGeometry(0.018, 0.012, 0.45, 10));
    tileUV(g, A().tile('wood', 1));
    g.rotateZ(Math.PI / 2);
    return g;
  }
  if (kind === 1) { // drawer
    const parts = [];
    const W = 0.4, D = 0.32, H = 0.12, T = 0.012;
    const add = (w, h, d, x, y, z) => { const b = prep(new THREE.BoxGeometry(w, h, d)); tileUV(b, A().tile('wood', 0)); b.translate(x, y, z); parts.push(b); };
    add(W, T, D, 0, T / 2, 0);
    add(W, H, T, 0, H / 2, D / 2);
    add(W, H, T, 0, H / 2, -D / 2);
    add(T, H, D, W / 2, H / 2, 0);
    if (r() < 0.6) add(T, H, D, -W / 2, H / 2, 0);
    return merge(parts);
  }
  // cushion (foam)
  const g = prep(new THREE.BoxGeometry(0.4, 0.08, 0.38, 6, 2, 6));
  tileUV(g, A().tile('foam'));
  displace(g, (v) => { v.y *= 1 - (v.x / 0.2) ** 2 * 0.4 - (v.z / 0.19) ** 2 * 0.4; });
  crumple(g, 0.012, 7, r.int(0, 1e6));
  return g;
}

function gearShape(teeth, rO, rI, hole) {
  const s = new THREE.Shape();
  for (let k = 0; k < teeth * 4; k++) {
    const a = (k / (teeth * 4)) * Math.PI * 2;
    const rr = (k % 4 === 1 || k % 4 === 2) ? rO : rI;
    k ? s.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : s.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  s.closePath();
  const h = new THREE.Path();
  h.absarc(0, 0, hole, 0, Math.PI * 2, true);
  s.holes.push(h);
  return s;
}

function machinery(r, i) {
  const kind = i % 4, slot = A().tile('rust', r.int(0, 3));
  let g;
  if (kind === 0) {
    const rO = r.range(0.08, 0.16);
    g = prep(new THREE.ExtrudeGeometry(gearShape(r.int(10, 18), rO, rO * 0.86, rO * 0.25), { depth: 0.03, bevelEnabled: true, bevelSize: 0.003, bevelThickness: 0.003, bevelSegments: 1 }));
    const uv = g.getAttribute('uv'), p = g.getAttribute('position');
    for (let k = 0; k < uv.count; k++) uv.setXY(k, p.getX(k) * 3 + 0.5, p.getY(k) * 3 + 0.5);
    tileUV(g, slot);
    g.rotateX(-Math.PI / 2);
  } else if (kind === 1) { // block with cylinder bosses
    const b = prep(new THREE.BoxGeometry(0.34, 0.16, 0.2, 2, 2, 2));
    const parts = [b];
    for (let k = 0; k < 3; k++) { const c = prep(new THREE.CylinderGeometry(0.035, 0.035, 0.05, 14)); c.translate(-0.1 + k * 0.1, 0.1, 0); parts.push(c); }
    g = merge(parts);
    tileUV(g, slot);
    crumple(g, 0.006, 8, r.int(0, 1e6));
  } else if (kind === 2) { // pipe elbow
    const curve = new THREE.CatmullRomCurve3([new V3(0, 0, 0), new V3(0.12, 0, 0), new V3(0.2, 0, 0.08), new V3(0.2, 0, 0.22)]);
    g = prep(new THREE.TubeGeometry(curve, 20, 0.04, 12, false));
    tileUV(g, slot);
  } else { // chain
    const links = [];
    for (let k = 0; k < 7; k++) { const t = prep(new THREE.TorusGeometry(0.022, 0.006, 6, 12)); t.scale(1.4, 1, 1); t.rotateX(k % 2 ? Math.PI / 2 : 0); t.translate(k * 0.048, 0, Math.sin(k) * 0.02); links.push(t); }
    g = merge(links);
    tileUV(g, slot);
  }
  return g;
}

function rubble(r, i) {
  const rad = r.range(0.06, 0.16);
  const g = prep(new THREE.IcosahedronGeometry(rad, 2));
  const p = g.getAttribute('position'), uv = g.getAttribute('uv');
  for (let k = 0; k < p.count; k++) uv.setXY(k, p.getX(k) / rad * 0.5 + 0.5, p.getZ(k) / rad * 0.5 + 0.5);
  tileUV(g, A().tile('stone', i));
  const seed = r.int(0, 1e6), flat = r.range(0.5, 0.9);
  displace(g, (v) => { const n = fbm3(v.x * 12, v.y * 12, v.z * 12, seed); v.multiplyScalar(1 + n * 0.45); v.y *= flat; });
  // chop a flat face for a broken-block look
  if (i % 2) displace(g, (v) => { if (v.x > rad * 0.4) v.x = rad * 0.4 + (v.x - rad * 0.4) * 0.15; });
  return g;
}

function pottery(r) {
  const R = r.range(0.1, 0.17), H = r.range(0.1, 0.2), a0 = r.range(0, 6), span = r.range(0.7, 1.6);
  const pts = [new THREE.Vector2(R * 0.9, 0), new THREE.Vector2(R, H * 0.5), new THREE.Vector2(R * 0.85, H), new THREE.Vector2(R * 0.8, H), new THREE.Vector2(R * 0.95, H * 0.5), new THREE.Vector2(R * 0.85, 0)];
  const g = prep(new THREE.LatheGeometry(pts, 10, a0, span));
  tileUV(g, A().tile('terracotta'));
  const seed = r.int(0, 1e6);
  displace(g, (v) => { v.y += noise3(v.x * 20, 0, v.z * 20, seed) * 0.015; });
  g.rotateX(Math.PI / 2 * r.range(0.6, 1));
  return g;
}

function rustiron(r, i) {
  const kind = i % 3, slot = A().tile('rust', 0);
  if (kind === 0) { // horseshoe
    const g = prep(new THREE.TorusGeometry(0.055, 0.01, 6, 18, Math.PI * 1.35));
    tileUV(g, slot);
    g.rotateX(Math.PI / 2);
    return g;
  }
  if (kind === 1) { // old blade
    const s = new THREE.Shape();
    s.moveTo(0, 0); s.lineTo(0.3, 0.02); s.lineTo(0.32, 0.035); s.lineTo(0, 0.045); s.closePath();
    const g = prep(new THREE.ExtrudeGeometry(s, { depth: 0.006, bevelEnabled: false }));
    const uv = g.getAttribute('uv'), p = g.getAttribute('position');
    for (let k = 0; k < uv.count; k++) uv.setXY(k, p.getX(k) * 3, p.getY(k) * 3);
    tileUV(g, slot);
    crumple(g, 0.005, 15, r.int(0, 1e6));
    g.rotateX(-Math.PI / 2);
    return g;
  }
  const nails = []; // bundle of nails
  for (let k = 0; k < 6; k++) { const n = prep(new THREE.CylinderGeometry(0.003, 0.002, 0.1, 5)); n.rotateZ(Math.PI / 2 + r.range(-0.3, 0.3)); n.rotateY(r.range(0, 3)); n.translate(r.range(-0.03, 0.03), 0.004, r.range(-0.03, 0.03)); nails.push(n); }
  const g = merge(nails);
  tileUV(g, slot);
  return g;
}

// ---- Type table -----------------------------------------------------------------------
// tints: instance colour multipliers (printed items stay near white)
const W = ['#ffffff', '#f2f0ea', '#e6e2d8'];
export const JUNK = {
  can: { name: 'Crushed drinks can', build: can, variants: 6, tints: W, metal: 'aluminium', mass: [13, 16] },
  bottle: { name: 'Plastic bottle', build: bottle, variants: 3, tints: ['#dfeef5', '#cfe8d6', '#f2f2f2', '#c9dbe8'], metal: null },
  box: { name: 'Cardboard box', build: box, variants: 2, tints: W, metal: null },
  sheet: { name: 'Flattened cardboard', build: sheet, variants: 2, tints: W, metal: null },
  paper: { name: 'Old newspaper', build: paper, variants: 3, tints: ['#ffffff', '#efe6cf', '#e2dccb'], metal: null },
  bag: { name: 'Plastic bag', build: bag, variants: 4, tints: ['#ffffff', '#e8e4dc', '#bcd3e8', '#ffffff'], metal: null, tintFor: (i) => (i >= 2 ? 1 : 0) },
  clothes: { name: 'Old clothes', build: clothes, variants: 6, tints: W, metal: null },
  packaging: { name: 'Food packaging', build: packaging, variants: 6, tints: W, metal: null },
  toy: { name: 'Broken toy', build: toy, variants: 4, tints: ['#d32f2f', '#1e88e5', '#fdd835', '#43a047', '#ff7043', '#ab47bc'], metal: null },
  wood: { name: 'Wood fragment', build: wood, variants: 3, tints: W, metal: null },
  household: { name: 'Household item', build: household, variants: 3, tints: ['#e53935', '#1e88e5', '#ffffff', '#43a047'], metal: 'aluminium', mass: [250, 500], metalFor: (i) => i % 3 === 1 },
  glass: { name: 'Glass bottle', build: glassJar, variants: 3, tints: W, metal: null },
  tyre: { name: 'Worn-out tyre', build: tyre, variants: 1, tints: W, metal: 'iron', mass: [900, 1500] },
  electronics: { name: 'Old electronics', build: electronics, variants: 4, tints: ['#ffffff', '#d8d8d8', '#5a5a5a'], metal: 'copper', mass: [60, 400] },
  monitor: { name: 'Dead monitor', build: monitor, variants: 2, tints: ['#ffffff', '#cfcfcf'], metal: 'iron', mass: [600, 2500] },
  cables: { name: 'Tangled cables', build: cables, variants: 3, tints: ['#2a2a2a', '#444444', '#e0e0e0', '#c62828', '#1565c0'], metal: 'copper', mass: [40, 160] },
  pcb: { name: 'Circuit board', build: pcb, variants: 2, tints: W, metal: 'copper', mass: [20, 60] },
  scrap: { name: 'Scrap metal', build: scrap, variants: 6, tints: W, metal: 'iron', mass: [250, 2400] },
  furniture: { name: 'Broken furniture', build: furniture, variants: 3, tints: W, metal: null },
  machinery: { name: 'Rusty machine part', build: machinery, variants: 4, tints: W, metal: 'iron', mass: [800, 6000] },
  rubble: { name: 'Stone rubble', build: rubble, variants: 4, tints: ['#ffffff', '#e8dccb', '#d9c9b5', '#c7b6a2'], metal: null },
  pottery: { name: 'Pottery shard', build: pottery, variants: 3, tints: W, metal: null },
  rustiron: { name: 'Corroded ironwork', build: rustiron, variants: 3, tints: W, metal: 'iron', mass: [40, 300] },
};

// Build every variant of the junk types an area uses.
export function buildJunkLibrary(keys, seed) {
  const lib = {};
  for (const key of keys) {
    const def = JUNK[key];
    const r = mulberry(seed + key.length * 131 + key.charCodeAt(0) * 7);
    lib[key] = [];
    for (let i = 0; i < def.variants; i++) {
      const g = settle(def.build(r, i));
      const s = g.boundingBox.getSize(new V3());
      lib[key].push({ geo: g, thickness: s.y, footprint: Math.max(s.x, s.z) });
    }
  }
  return lib;
}
