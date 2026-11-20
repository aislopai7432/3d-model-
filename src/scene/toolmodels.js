// Procedural cutting tools and BT40 holders. The gauge line is at y = 0 and the tool hangs down -Y,
// so a model can be dropped straight into the spindle rotor or a carousel pocket.
import * as THREE from 'three';
import { holderFor } from '../sim/tooling.js';

const mats = {};
function materials() {
  if (mats.ready) return mats;
  mats.holder = new THREE.MeshStandardMaterial({ color: 0x9aa1a8, metalness: 1, roughness: 0.28 });
  mats.holderDark = new THREE.MeshStandardMaterial({ color: 0x3a3f45, metalness: 0.9, roughness: 0.35 });
  mats.nut = new THREE.MeshStandardMaterial({ color: 0xb8bec4, metalness: 1, roughness: 0.22 });
  mats.carbide = new THREE.MeshStandardMaterial({ color: 0x8e959c, metalness: 1, roughness: 0.32 });
  mats.coated = new THREE.MeshStandardMaterial({ color: 0x6f5a8e, metalness: 0.9, roughness: 0.3 }); // AlTiN-style violet
  mats.gold = new THREE.MeshStandardMaterial({ color: 0xc89b3c, metalness: 1, roughness: 0.3 }); // TiN drill
  mats.insert = new THREE.MeshStandardMaterial({ color: 0x2a2c30, metalness: 0.7, roughness: 0.4 });
  mats.body = new THREE.MeshStandardMaterial({ color: 0x2d3238, metalness: 0.8, roughness: 0.38 });
  mats.ready = true;
  return mats;
}

// Fluted cutter body built ring by ring: the cross-section has gullets that twist with the helix
// angle, and the radius is shaped at the tip for ball, bull, drill-point and chamfer geometry.
function fluteGeometry(tool, fluteLen) {
  const r = tool.diameter / 2;
  const flutes = Math.max(1, tool.flutes || 2);
  const helix = tool.type === 'drill' ? 30 : tool.type === 'spot' || tool.type === 'chamfer' ? 8 : 38;
  const twist = Math.tan((helix * Math.PI) / 180) / r; // radians per mm
  const segs = Math.max(24, flutes * 12);
  const rings = 44;
  const half = ((tool.tipAngle || 118) * Math.PI) / 360;
  const tipH = tool.type === 'ball' ? r : tool.type === 'drill' || tool.type === 'spot' || tool.type === 'chamfer' ? r / Math.tan(half) : 0;
  const rc = tool.type === 'bull' ? Math.min(tool.cornerRadius || 0, r) : 0;
  const scaleAt = (y) => {
    if (tool.type === 'ball') return y < r ? Math.sqrt(Math.max(0, r * r - (r - y) * (r - y))) / r : 1;
    if (tipH > 0) return y < tipH ? y / tipH : 1;
    if (rc > 0 && y < rc) return (r - rc + Math.sqrt(Math.max(0, rc * rc - (rc - y) * (rc - y)))) / r;
    return y < 0.15 ? 0.94 : 1;
  };
  const depth = tool.type === 'drill' ? 0.42 : tool.type === 'chamfer' ? 0.18 : 0.3;
  const pos = [];
  const idx = [];
  // ring heights concentrated near the tip
  const ys = [];
  for (let k = 0; k <= rings; k++) {
    const f = k / rings;
    const tipZone = Math.max(tipH, rc, 0.5);
    ys.push(f < 0.35 ? (f / 0.35) * Math.min(tipZone * 1.05, fluteLen) : Math.min(tipZone * 1.05, fluteLen) + ((f - 0.35) / 0.65) * (fluteLen - Math.min(tipZone * 1.05, fluteLen)));
  }
  for (let k = 0; k <= rings; k++) {
    const y = ys[k];
    const s = scaleAt(y);
    for (let i = 0; i <= segs; i++) {
      const th = (i / segs) * Math.PI * 2;
      const ph = (th * flutes) % (Math.PI * 2);
      const g = Math.pow(Math.max(0, Math.sin(ph)), 0.7) * depth;
      const rr = r * s * (1 - g * Math.min(1, y / Math.max(0.6, tipH * 0.5 + 0.6)) * (y > 0.01 ? 1 : 0) - 0) ;
      const a = th + y * twist;
      pos.push(Math.cos(a) * rr, y, Math.sin(a) * rr); // y measured UP from the tip (the group is shifted to -L afterwards)
    }
  }
  const row = segs + 1;
  for (let k = 0; k < rings; k++) {
    for (let i = 0; i < segs; i++) {
      const a = k * row + i, b = a + 1, c = a + row, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  // tip cap
  const center = pos.length / 3;
  pos.push(0, 0, 0);
  for (let i = 0; i < segs; i++) idx.push(center, i + 1, i);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function lathe(points, segs = 32) {
  const g = new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), segs);
  return g;
}

// BT40 taper + flange + collet chuck / arbor body.
function holderGeometry(tool) {
  const h = holderFor(tool);
  const top = [
    [0, 96], [7.2, 96], [7.2, 89], [5, 86], [5, 79], [11, 76], [22.5, 3], [31.75, 3], [31.75, -1],
    [27.5, -6.5], [31.75, -12], [31.75, -16],
  ];
  if (tool.type === 'face') {
    top.push([21, -16], [21, -h.length + 4], [20, -h.length], [0, -h.length]);
  } else {
    // ER32 collet chuck body, then the clamping nut.
    top.push([22, -16], [21, -38], [25, -40], [25, -56], [23.5, -58], [13, -h.length], [0, -h.length]);
  }
  return lathe(top.map(([r, y]) => [r, y]).reverse(), 36);
}

const geoCache = new Map();
function key(tool) {
  return [tool.type, tool.diameter, tool.fluteLength, tool.length, tool.cornerRadius, tool.tipAngle, tool.flutes].join('|');
}

export function buildToolModel(tool) {
  const M = materials();
  const g = new THREE.Group();
  g.name = `T${tool.number}`;
  let geos = geoCache.get(key(tool));
  const h = holderFor(tool);
  const r = tool.diameter / 2;
  const L = tool.length;
  if (!geos) {
    geos = { holder: holderGeometry(tool) };
    if (tool.type === 'face') {
      const bodyH = Math.min(42, L - h.length);
      const bodyR = r * 0.86;
      geos.body = lathe([[0, 0], [bodyR - 2, 0], [bodyR, 2], [bodyR, bodyH - 3], [bodyR - 3, bodyH], [18, bodyH], [18, bodyH + 2], [0, bodyH + 2]].map(([a, b]) => [a, b]), 40);
      geos.body.translate(0, -L, 0);
      geos.insert = new THREE.BoxGeometry(9, 6, 3.5);
      geos.bodyH = bodyH;
    } else {
      const stick = L - h.length;
      const fl = Math.min(tool.fluteLength, stick - 2);
      geos.flutes = fluteGeometry(tool, fl);
      geos.flutes.translate(0, -L, 0);
      // shank from the top of the flutes into the collet
      const shankR = tool.type === 'spot' || tool.type === 'chamfer' ? Math.min(r, 6) : r;
      const sh = stick - fl + 8;
      geos.shank = new THREE.CylinderGeometry(shankR, shankR * (fl < tool.fluteLength ? 1 : 0.97), sh, 28);
      geos.shank.translate(0, -L + fl + sh / 2, 0);
    }
    geoCache.set(key(tool), geos);
  }
  const holder = new THREE.Mesh(geos.holder, M.holder);
  holder.castShadow = true;
  g.add(holder);
  if (tool.type === 'face') {
    const body = new THREE.Mesh(geos.body, M.body);
    body.castShadow = true;
    g.add(body);
    const n = Math.max(3, tool.flutes || 5);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const ins = new THREE.Mesh(geos.insert, M.insert);
      ins.position.set(Math.cos(a) * (r - 4.3), -L + 3, Math.sin(a) * (r - 4.3));
      ins.rotation.y = -a + 0.25;
      ins.castShadow = true;
      g.add(ins);
    }
  } else {
    const cm = tool.type === 'drill' ? M.gold : tool.type === 'ball' || tool.type === 'bull' ? M.coated : M.carbide;
    const fl = new THREE.Mesh(geos.flutes, cm);
    fl.castShadow = true;
    g.add(fl);
    const sh = new THREE.Mesh(geos.shank, M.carbide);
    sh.castShadow = true;
    g.add(sh);
  }
  // Coloured ring so you can see the spindle turning.
  M.markGeo = M.markGeo || new THREE.BoxGeometry(4, 10, 3);
  M.mark = M.mark || new THREE.MeshStandardMaterial({ color: 0x2f7de1, metalness: 0.3, roughness: 0.5 });
  M.bandGeo = M.bandGeo || new THREE.TorusGeometry(31.9, 0.9, 6, 36);
  const band = new THREE.Mesh(M.bandGeo, M.holderDark);
  band.rotation.x = Math.PI / 2;
  band.position.y = -8;
  g.add(band);
  const mark = new THREE.Mesh(M.markGeo, M.mark);
  mark.position.set(0, -27, tool.type === 'face' ? 21.5 : 22.2);
  g.add(mark);
  g.userData.tool = tool.number;
  return g;
}

export function disposeToolModels() {
  for (const geos of geoCache.values()) for (const k of Object.keys(geos)) geos[k]?.dispose?.();
  geoCache.clear();
}
