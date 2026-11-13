// Treasure: rolling individual finds, valuing them, and building their 3D models at real-world scale.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { TREASURES, ECONOMY } from './config.js';
import { mulberry, noise3, fbm3 } from './rng.js';
import { heightToNormal } from './textures.js';

const GOLD_DENSITY = 19.3; // g/cm³

// ---- Rolling a find --------------------------------------------------------------------
export function rollTreasure(kindId, r, uid) {
  const k = TREASURES[kindId];
  const q = Math.pow(r(), 2.2); // most finds are towards the small end of the range
  const mass = +(k.mass[0] + (k.mass[1] - k.mass[0]) * q).toFixed(kindId === 'flake' ? 3 : 2);
  let purity;
  if (k.purity.length > 2) purity = r.pick(k.purity);
  else purity = +(k.purity[0] + (k.purity[1] - k.purity[0]) * r()).toFixed(4);
  const item = { uid, kind: kindId, mass, purity, rarity: k.rarity, metal: k.metal, seed: Math.floor(r() * 1e9) };
  if (k.pricing === 'fixed') {
    const vq = Math.min(1, q * 0.7 + r() * 0.3 + (kindId === 'diamond' || kindId === 'gemstone' || kindId === 'bigDiamond' ? q * 0.3 : 0));
    item.appraised = Math.round((k.value[0] + (k.value[1] - k.value[0]) * vq) * 100) / 100;
  }
  if (kindId === 'gemstone') item.variant = r.pick(['Ruby', 'Sapphire', 'Emerald']);
  return item;
}

// Current metal prices (slow deterministic drift, changes over real hours).
export function currentPrices(now = Date.now()) {
  const t = now / 3.6e6; // hours
  const wob = Math.sin(t * 0.37) * 0.6 + Math.sin(t * 1.13 + 1.7) * 0.3 + Math.sin(t * 2.9 + 0.4) * 0.1;
  const f = 1 + wob * ECONOMY.priceDrift;
  return { gold: +(ECONOMY.goldSpotPerGram * f).toFixed(2), silver: +(ECONOMY.silverSpotPerGram * (1 + wob * ECONOMY.priceDrift * 1.4)).toFixed(3), factor: f };
}

const spotOf = (metal, prices) => (metal === 'gold' ? prices.gold : metal === 'silver' ? prices.silver : 0);

// What the refinery pays today.
export function valueOf(item, prices = currentPrices()) {
  const k = TREASURES[item.kind];
  if (k.pricing === 'fixed') return item.appraised;
  const melt = item.mass * item.purity * spotOf(item.metal, prices);
  if (k.pricing === 'premium') return Math.round(melt * k.premium * 100) / 100;
  return Math.round(melt * ECONOMY.buyerMeltRate * 100) / 100;
}
export function meltValue(item, prices = currentPrices()) {
  return item.mass * item.purity * spotOf(item.metal, prices);
}

export function itemName(item) {
  const k = TREASURES[item.kind];
  if (item.kind === 'gemstone') return item.variant;
  return k.name;
}

export function purityLabel(item) {
  if (item.metal === 'gold') {
    const ct = item.purity * 24;
    if (item.purity >= 0.999) return `24ct · ${(item.purity * 100).toFixed(2)}%`;
    return `${ct >= 9.5 ? Math.round(ct) : ct.toFixed(1)}ct · ${(item.purity * 100).toFixed(1)}%`;
  }
  if (item.metal === 'silver') return item.purity >= 0.92 ? 'Sterling · 92.5%' : `${(item.purity * 100).toFixed(1)}% silver`;
  if (item.metal === 'copper') return 'Bronze';
  if (['diamond', 'bigDiamond', 'gemstone'].includes(item.kind)) return `${(item.mass * 5).toFixed(2)} ct`;
  return '—';
}

export function massLabel(g) {
  if (g < 1) return `${(g * 1000).toFixed(0)} mg`;
  if (g >= 1000) return `${(g / 1000).toFixed(3)} kg`;
  return `${g.toFixed(g < 10 ? 2 : 1)} g`;
}

export function fineGold(item) {
  return item.metal === 'gold' ? item.mass * item.purity : 0;
}

// ---- Materials --------------------------------------------------------------------------
const MAT = new Map();
function goldColor(purity) {
  // pure gold is deep yellow; lower carats are paler (silver) or pinker (copper)
  const p = THREE.MathUtils.clamp((purity - 0.375) / 0.625, 0, 1);
  const c = new THREE.Color().setRGB(0.93, 0.66, 0.5, THREE.LinearSRGBColorSpace);
  return c.lerp(new THREE.Color().setRGB(1.0, 0.71, 0.29, THREE.LinearSRGBColorSpace), p);
}
function gold(purity, rough = 0.2, normalMap = null) {
  const key = `g${purity.toFixed(2)}-${rough}-${normalMap ? normalMap.uuid : ''}`;
  if (!MAT.has(key)) {
    MAT.set(key, new THREE.MeshPhysicalMaterial({
      color: goldColor(purity), metalness: 1, roughness: rough, envMapIntensity: 1.35,
      clearcoat: rough < 0.15 ? 0.6 : 0, clearcoatRoughness: 0.05, normalMap, normalScale: new THREE.Vector2(0.8, 0.8),
    }));
  }
  return MAT.get(key);
}
function silver(rough = 0.28, tarnish = 0.2, normalMap = null) {
  const key = `s${rough}-${tarnish}-${normalMap ? normalMap.uuid : ''}`;
  if (!MAT.has(key)) MAT.set(key, new THREE.MeshPhysicalMaterial({ color: new THREE.Color().setRGB(0.95 - tarnish * 0.35, 0.94 - tarnish * 0.37, 0.92 - tarnish * 0.4, THREE.LinearSRGBColorSpace), metalness: 1, roughness: rough, envMapIntensity: 1.2, normalMap }));
  return MAT.get(key);
}
function simple(key, params) {
  if (!MAT.has(key)) MAT.set(key, new THREE.MeshPhysicalMaterial(params));
  return MAT.get(key);
}
const bronze = (nm) => simple('bronze' + (nm ? nm.uuid : ''), { color: new THREE.Color().setRGB(0.42, 0.2, 0.11, THREE.LinearSRGBColorSpace), metalness: 1, roughness: 0.5, normalMap: nm });
const gemMat = (color, key) => simple('gem' + key, {
  color, metalness: 0.15, roughness: 0.0, ior: 2.4, specularIntensity: 1, clearcoat: 1, clearcoatRoughness: 0,
  iridescence: 0.8, iridescenceIOR: 1.6, iridescenceThicknessRange: [200, 600], envMapIntensity: 2.6, flatShading: true,
});
const quartz = () => simple('quartz', { color: 0xe8e2d6, roughness: 0.55, metalness: 0, clearcoat: 0.3 });
const ceramic = () => simple('ceramicChip', { color: 0x2c2a28, roughness: 0.45, metalness: 0 });
const enamel = (map) => simple('enamel' + map.uuid, { map, roughness: 0.15, clearcoat: 1 });

// ---- Relief textures for coins and bars ---------------------------------------------
const TEX = new Map();
function canvas(w, h = w) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function coinRelief(kind) {
  if (TEX.has(kind)) return TEX.get(kind);
  const S = 256, c = canvas(S), x = c.getContext('2d');
  x.fillStyle = '#808080';
  x.fillRect(0, 0, S, S);
  x.strokeStyle = '#ffffff';
  x.lineWidth = 8;
  x.beginPath(); x.arc(S / 2, S / 2, S / 2 - 8, 0, 7); x.stroke();
  // milled rim dots
  x.fillStyle = '#c0c0c0';
  for (let k = 0; k < 90; k++) { const a = k / 90 * Math.PI * 2; x.fillRect(S / 2 + Math.cos(a) * (S / 2 - 20) - 1.5, S / 2 + Math.sin(a) * (S / 2 - 20) - 1.5, 3, 3); }
  // portrait profile
  x.fillStyle = '#ffffff';
  x.beginPath();
  x.moveTo(110, 200); x.bezierCurveTo(95, 160, 92, 130, 100, 100); x.bezierCurveTo(104, 80, 112, 70, 128, 62);
  x.bezierCurveTo(160, 55, 172, 85, 168, 110); x.lineTo(176, 122); x.lineTo(166, 128); x.bezierCurveTo(170, 150, 160, 170, 150, 200); x.closePath();
  x.fill();
  x.font = '700 18px Georgia, serif';
  x.textAlign = 'center';
  const word = kind === 'penny' ? 'ONE PENNY' : kind === 'sixpence' ? 'SIXPENCE' : kind === 'bullion' ? 'FINE GOLD 1 OZ' : 'REGINA · DEI GRATIA';
  for (let i = 0; i < word.length; i++) {
    x.save();
    const a = -Math.PI * 0.85 + (i / word.length) * Math.PI * 0.75;
    x.translate(S / 2 + Math.cos(a) * 95, S / 2 + Math.sin(a) * 95);
    x.rotate(a + Math.PI / 2);
    x.fillText(word[i], 0, 0);
    x.restore();
  }
  const t = new THREE.CanvasTexture(heightToNormal(c, 3));
  TEX.set(kind, t);
  return t;
}
function barStamp(label, serial) {
  const key = 'bar' + label;
  if (TEX.has(key)) return TEX.get(key);
  const W = 512, H = 256, c = canvas(W, H), x = c.getContext('2d');
  x.fillStyle = '#808080';
  x.fillRect(0, 0, W, H);
  x.strokeStyle = '#ffffff';
  x.lineWidth = 6;
  x.strokeRect(24, 24, W - 48, H - 48);
  x.fillStyle = '#ffffff';
  x.textAlign = 'center';
  x.font = '700 40px Georgia, serif';
  x.fillText('AURUM REFINERS', W / 2, 80);
  x.font = '700 64px Georgia, serif';
  x.fillText(label, W / 2, 150);
  x.font = '600 30px Georgia, serif';
  x.fillText('FINE GOLD 999.9', W / 2, 192);
  x.font = '600 22px monospace';
  x.fillText(serial, W / 2, 222);
  const t = new THREE.CanvasTexture(heightToNormal(c, 2.4));
  TEX.set(key, t);
  return t;
}
function watchFace() {
  if (TEX.has('watch')) return TEX.get('watch');
  const S = 256, c = canvas(S), x = c.getContext('2d');
  x.fillStyle = '#f3efe4';
  x.fillRect(0, 0, S, S);
  x.fillStyle = '#1b1b1b';
  x.font = '600 24px Georgia, serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  const rn = ['XII', 'I', 'II', 'III', 'IIII', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];
  rn.forEach((n, i) => { const a = i / 12 * Math.PI * 2 - Math.PI / 2; x.fillText(n, S / 2 + Math.cos(a) * 92, S / 2 + Math.sin(a) * 92); });
  x.strokeStyle = '#1b1b1b';
  x.lineWidth = 5;
  x.beginPath(); x.moveTo(S / 2, S / 2); x.lineTo(S / 2 + 40, S / 2 - 40); x.stroke();
  x.lineWidth = 3;
  x.beginPath(); x.moveTo(S / 2, S / 2); x.lineTo(S / 2 - 15, S / 2 + 70); x.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  TEX.set('watch', t);
  return t;
}
function roughNuggetNormal() {
  if (TEX.has('nug')) return TEX.get('nug');
  const S = 128, c = canvas(S), x = c.getContext('2d');
  const img = x.createImageData(S, S);
  for (let i = 0; i < S * S; i++) { const v = (fbm3((i % S) / 9, Math.floor(i / S) / 9, 0, 41) * 0.5 + 0.5) * 255; img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
  x.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(heightToNormal(c, 4));
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  TEX.set('nug', t);
  return t;
}

// ---- Geometry helpers ------------------------------------------------------------------
function lump(radius, seed, detail = 3, rough = 0.5, flat = 0.75) {
  let g = new THREE.IcosahedronGeometry(radius, detail);
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  g = mergeVertices(g);
  const p = g.getAttribute('position'), v = new THREE.Vector3();
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = fbm3(v.x / radius * 1.4, v.y / radius * 1.4, v.z / radius * 1.4, seed, 4);
    const d = noise3(v.x / radius * 4, v.y / radius * 4, v.z / radius * 4, seed + 9);
    v.multiplyScalar(1 + n * rough + Math.max(0, d) * 0.15);
    v.y *= flat;
    p.setXYZ(i, v.x, v.y, v.z);
    uv[i * 2] = v.x / radius * 0.5 + 0.5;
    uv[i * 2 + 1] = v.z / radius * 0.5 + 0.5;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}
const volRadius = (massG, density = GOLD_DENSITY) => Math.cbrt((3 * (massG / density)) / (4 * Math.PI)) / 100; // metres

function brilliant(radius) {
  // round brilliant: table, crown and pavilion with 16 facets around
  const n = 16, pts = [];
  const tableR = radius * 0.55, crownH = radius * 0.32, pavH = radius * 0.86;
  const g = new THREE.BufferGeometry();
  const pos = [];
  const ring = (r, y, off = 0) => Array.from({ length: n }, (_, i) => { const a = (i + off) / n * Math.PI * 2; return new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r); });
  const top = ring(tableR, crownH, 0.5), girdle = ring(radius, 0), girdle2 = ring(radius, -radius * 0.03);
  const apex = new THREE.Vector3(0, -pavH, 0), tc = new THREE.Vector3(0, crownH, 0);
  const tri = (a, b, c) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tri(tc, top[j], top[i]);
    tri(top[i], top[j], girdle[j]);
    tri(top[i], girdle[j], girdle[i]);
    tri(girdle[i], girdle[j], girdle2[j]);
    tri(girdle[i], girdle2[j], girdle2[i]);
    tri(girdle2[i], girdle2[j], apex);
  }
  void pts;
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  g.translate(0, pavH, 0);
  return g;
}

function chainGeo(r, links, linkR, wire) {
  const parts = [];
  let p = new THREE.Vector3(), dir = r() * Math.PI * 2;
  for (let k = 0; k < links; k++) {
    const t = new THREE.TorusGeometry(linkR, wire, 6, 10);
    t.scale(1.5, 1, 1);
    t.rotateX(k % 2 ? Math.PI / 2 : 0);
    t.rotateY(-dir);
    t.translate(p.x, wire, p.z);
    parts.push(t);
    dir += (r() - 0.5) * 0.5;
    p = p.clone().add(new THREE.Vector3(Math.cos(dir), 0, Math.sin(dir)).multiplyScalar(linkR * 2.2));
  }
  return mergeGeometries(parts);
}

function mesh(g, m) {
  const o = new THREE.Mesh(g, m);
  o.castShadow = true;
  o.receiveShadow = true;
  return o;
}

// ---- Models -------------------------------------------------------------------------
// Returns a Group whose origin sits at the bottom centre of the object.
export function buildTreasureModel(item) {
  const r = mulberry(item.seed || 1);
  const grp = new THREE.Group();
  const p = item.purity;
  switch (TREASURES[item.kind].model) {
    case 'flake': {
      const t = 0.00025; // 0.25 mm thick
      const area = (item.mass / GOLD_DENSITY) / (t * 100) / 1e4; // m²
      const rad = Math.sqrt(area / Math.PI);
      const s = new THREE.Shape();
      for (let k = 0; k < 9; k++) { const a = k / 9 * Math.PI * 2, rr = rad * (0.6 + r() * 0.7); k ? s.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : s.moveTo(Math.cos(a) * rr, Math.sin(a) * rr); }
      const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false });
      g.rotateX(-Math.PI / 2);
      g.rotateZ(r.range(-0.25, 0.25));
      grp.add(mesh(g, gold(p, 0.16)));
      break;
    }
    case 'fragment': {
      const g = lump(volRadius(item.mass) * 1.35, item.seed % 1000, 2, 0.55, 0.55);
      grp.add(mesh(g, gold(p, 0.28, roughNuggetNormal())));
      break;
    }
    case 'nugget': {
      const g = lump(volRadius(item.mass) * 1.3, item.seed % 1000, 3, 0.6, 0.7);
      grp.add(mesh(g, gold(p, 0.33, roughNuggetNormal())));
      break;
    }
    case 'chunk': {
      const rad = volRadius(item.mass) * 1.3;
      grp.add(mesh(lump(rad, item.seed % 1000, 3, 0.55, 0.8), gold(p, 0.36, roughNuggetNormal())));
      for (let k = 0; k < 3; k++) { const q = mesh(lump(rad * 0.55, (item.seed + k) % 1000, 2, 0.4, 0.8), quartz()); q.position.set(r.range(-rad, rad), rad * 0.2, r.range(-rad, rad)); grp.add(q); }
      break;
    }
    case 'chain': {
      grp.add(mesh(chainGeo(r, Math.round(18 + item.mass * 6), 0.0022, 0.0006), gold(p, 0.12)));
      break;
    }
    case 'ring': {
      const g = new THREE.TorusGeometry(0.009, 0.0016 + item.mass * 0.0001, 14, 40);
      g.rotateX(Math.PI / 2 - 0.15);
      const m = mesh(g, gold(p, 0.08));
      m.position.y = 0.003;
      grp.add(m);
      break;
    }
    case 'bracelet': {
      const g = new THREE.TorusGeometry(0.033, 0.0035, 12, 64);
      g.scale(1, 1, 0.9);
      g.rotateX(Math.PI / 2 - 0.1);
      const m = mesh(g, gold(p, 0.09));
      m.position.y = 0.004;
      grp.add(m);
      break;
    }
    case 'spoon': {
      const bowl = new THREE.SphereGeometry(0.02, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2.4);
      bowl.scale(1.4, 0.35, 1);
      bowl.rotateX(Math.PI);
      bowl.translate(0.06, 0.008, 0);
      const handle = new THREE.BoxGeometry(0.12, 0.002, 0.009);
      handle.translate(-0.02, 0.006, 0);
      const g = mergeGeometries([bowl.toNonIndexed(), handle.toNonIndexed()]);
      g.rotateZ(0.12);
      grp.add(mesh(g, silver(0.3, 0.5)));
      break;
    }
    case 'penny': case 'sixpence': case 'sovereign': case 'bullion': {
      const kind = TREASURES[item.kind].model;
      const R = { penny: 0.0155, sixpence: 0.0096, sovereign: 0.011, bullion: 0.01635 }[kind];
      const T = { penny: 0.0017, sixpence: 0.0012, sovereign: 0.0015, bullion: 0.0028 }[kind];
      const g = new THREE.CylinderGeometry(R, R, T, 48, 1);
      const nm = coinRelief(kind);
      const m = kind === 'penny' ? bronze(nm) : kind === 'sixpence' ? silver(0.3, 0.45, nm) : gold(p, 0.14, nm);
      const c = mesh(g, m);
      c.position.y = T / 2;
      c.rotation.z = r.range(-0.05, 0.05);
      grp.add(c);
      break;
    }
    case 'bar100': case 'bar1k': {
      const big = item.kind === 'bar1k';
      const L = big ? 0.116 : 0.055, Wd = big ? 0.052 : 0.031, H = big ? 0.009 : 0.0034;
      const g = new THREE.BoxGeometry(L, H, Wd, 2, 1, 2);
      const pp = g.getAttribute('position');
      if (big) for (let i = 0; i < pp.count; i++) if (pp.getY(i) > 0) { pp.setX(i, pp.getX(i) * 0.9); pp.setZ(i, pp.getZ(i) * 0.86); } // trapezoid cast bar
      g.computeVertexNormals();
      const m = mesh(g, gold(p, 0.1, barStamp(big ? '1 KG' : '100 G', 'AR' + (item.seed % 900000 + 100000))));
      m.position.y = H / 2;
      grp.add(m);
      break;
    }
    case 'diamond': case 'bigDiamond': {
      const ct = item.mass * 5;
      const rad = 0.00325 * Math.cbrt(ct); // 1ct ≈ 6.5 mm diameter
      const m = mesh(brilliant(rad), gemMat(new THREE.Color(0xe9f4ff), 'diamond'));
      m.rotation.set(r.range(1.2, 1.9), r() * 6, 0);
      m.position.y = rad;
      grp.add(m);
      break;
    }
    case 'gem': {
      const ct = item.mass * 5, rad = 0.0034 * Math.cbrt(ct);
      const col = { Ruby: 0xb3132f, Sapphire: 0x173dbf, Emerald: 0x0f8a48 }[item.variant || 'Ruby'];
      const g = brilliant(rad);
      g.scale(1, 1, item.variant === 'Emerald' ? 0.7 : 0.85);
      const m = mesh(g, gemMat(new THREE.Color(col), item.variant || 'Ruby'));
      m.rotation.set(Math.PI / 2 + r.range(-0.3, 0.3), r() * 6, 0);
      m.position.y = rad;
      grp.add(m);
      break;
    }
    case 'chip': case 'chipGold': {
      const sz = item.kind === 'vintageChip' ? 0.04 : 0.03;
      const body = mesh(new THREE.BoxGeometry(sz, 0.003, sz), ceramic());
      body.position.y = 0.0045;
      grp.add(body);
      const lid = mesh(new THREE.BoxGeometry(sz * 0.55, 0.0008, sz * 0.55), gold(0.999, 0.12));
      lid.position.y = 0.0064;
      grp.add(lid);
      const pins = [];
      const n = 10;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        if (i > 1 && i < n - 2 && j > 1 && j < n - 2) continue;
        const pin = new THREE.CylinderGeometry(0.0003, 0.0003, 0.003, 4);
        pin.translate(-sz / 2 + (i + 0.5) * sz / n, 0.0015, -sz / 2 + (j + 0.5) * sz / n);
        pins.push(pin.toNonIndexed());
      }
      grp.add(mesh(mergeGeometries(pins), gold(0.999, 0.15)));
      break;
    }
    case 'watchSilver': case 'watchGold': {
      const isGold = item.kind === 'goldWatch';
      const m = isGold ? gold(p, 0.12) : silver(0.22, 0.25);
      const caseG = new THREE.CylinderGeometry(0.025, 0.025, 0.011, 48);
      caseG.translate(0, 0.0055, 0);
      grp.add(mesh(caseG, m));
      const face = mesh(new THREE.CircleGeometry(0.021, 48), enamel(watchFace()));
      face.rotation.x = -Math.PI / 2;
      face.position.y = 0.0111;
      grp.add(face);
      const bezel = new THREE.TorusGeometry(0.0225, 0.0018, 8, 48);
      bezel.rotateX(Math.PI / 2);
      bezel.translate(0, 0.011, 0);
      grp.add(mesh(bezel, m));
      const crown = new THREE.CylinderGeometry(0.0035, 0.0035, 0.006, 16);
      crown.rotateZ(Math.PI / 2);
      crown.translate(0.0285, 0.0055, 0);
      grp.add(mesh(crown, m));
      const ch = chainGeo(r, 14, 0.002, 0.0006);
      ch.translate(0.031, 0, 0);
      grp.add(mesh(ch, m));
      break;
    }
    case 'torc': {
      const pts = [];
      for (let k = 0; k <= 60; k++) { const a = -Math.PI * 0.85 + k / 60 * Math.PI * 1.7; pts.push(new THREE.Vector3(Math.cos(a) * 0.07, 0, Math.sin(a) * 0.065)); }
      const curve = new THREE.CatmullRomCurve3(pts);
      const strands = [];
      for (let s = 0; s < 3; s++) {
        const sp = pts.map((pt, k) => { const tw = k * 0.9 + s * 2.09; return new THREE.Vector3(pt.x * (1 + Math.cos(tw) * 0.06), Math.sin(tw) * 0.004, pt.z * (1 + Math.cos(tw) * 0.06)); });
        strands.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(sp), 160, 0.0035, 8, false).toNonIndexed());
      }
      for (const end of [0, 1]) { const pt = curve.getPoint(end); const t = new THREE.SphereGeometry(0.011, 16, 12); t.translate(pt.x, 0, pt.z); strands.push(t.toNonIndexed()); }
      const g = mergeGeometries(strands);
      g.translate(0, 0.011, 0);
      grp.add(mesh(g, gold(p, 0.18)));
      break;
    }
    case 'brooch': {
      const disc = new THREE.CylinderGeometry(0.03, 0.031, 0.005, 64);
      disc.translate(0, 0.0025, 0);
      grp.add(mesh(disc, gold(p, 0.14)));
      const garnet = gemMat(new THREE.Color(0x7a0712), 'garnet');
      for (let ring = 0; ring < 2; ring++) {
        const n = ring ? 12 : 6;
        for (let k = 0; k < n; k++) {
          const a = k / n * Math.PI * 2, rr = ring ? 0.022 : 0.011;
          const cell = mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.0016, 6), garnet);
          cell.position.set(Math.cos(a) * rr, 0.0055, Math.sin(a) * rr);
          grp.add(cell);
        }
      }
      const boss = mesh(new THREE.SphereGeometry(0.006, 20, 12), gold(p, 0.1));
      boss.position.y = 0.006;
      grp.add(boss);
      const rim = new THREE.TorusGeometry(0.03, 0.0015, 8, 64);
      rim.rotateX(Math.PI / 2);
      rim.translate(0, 0.005, 0);
      grp.add(mesh(rim, gold(p, 0.1)));
      break;
    }
    case 'mask': {
      const g = new THREE.SphereGeometry(0.1, 48, 32, 0, Math.PI * 2, 0, Math.PI / 2);
      g.scale(0.75, 0.5, 1);
      const pp = g.getAttribute('position');
      for (let i = 0; i < pp.count; i++) {
        const x = pp.getX(i), z = pp.getZ(i);
        let y = pp.getY(i);
        y += Math.exp(-((x) ** 2 / 0.0002 + (z - 0.005) ** 2 / 0.0012)) * 0.025; // nose
        y -= Math.exp(-((Math.abs(x) - 0.03) ** 2 / 0.00012 + (z + 0.02) ** 2 / 0.00006)) * 0.012; // eye sockets
        y += Math.exp(-((x) ** 2 / 0.0006 + (z - 0.045) ** 2 / 0.00004)) * 0.006; // lips
        pp.setY(i, y);
      }
      g.computeVertexNormals();
      g.rotateY(Math.PI / 2);
      grp.add(mesh(g, gold(p, 0.2)));
      for (const sx of [-1, 1]) { const eye = mesh(new THREE.SphereGeometry(0.009, 12, 8), simple('lapis', { color: 0x14246a, roughness: 0.3 })); eye.scale.set(1, 0.4, 1.6); eye.position.set(-0.02, 0.038, sx * 0.03); grp.add(eye); }
      break;
    }
    default: {
      grp.add(mesh(new THREE.SphereGeometry(0.005, 12, 8), gold(p)));
    }
  }
  grp.traverse((o) => { if (o.isMesh) o.userData.treasure = true; });
  // size for picking / visibility helpers
  const box = new THREE.Box3().setFromObject(grp);
  grp.userData.size = box.getSize(new THREE.Vector3()).length();
  return grp;
}
