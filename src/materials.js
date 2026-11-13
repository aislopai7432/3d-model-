// Procedural textures and PBR materials. Everything is generated at runtime on
// canvases, so the project has no image assets to download.
import * as THREE from 'three';

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// Mulberry32: small deterministic PRNG so textures look the same on every load.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Convert a greyscale height canvas into a tangent-space normal map.
export function heightToNormal(src, strength = 2, wrap = true) {
  const w = src.width, h = src.height;
  const d = src.getContext('2d').getImageData(0, 0, w, h).data;
  const out = makeCanvas(w, h);
  const ctx = out.getContext('2d');
  const img = ctx.createImageData(w, h);
  const H = (x, y) => {
    if (wrap) { x = (x + w) % w; y = (y + h) % h; } else { x = Math.min(w - 1, Math.max(0, x)); y = Math.min(h - 1, Math.max(0, y)); }
    return d[(y * w + x) * 4] / 255;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = (H(x - 1, y) - H(x + 1, y)) * strength;
      const ny = (H(x, y + 1) - H(x, y - 1)) * strength;
      const l = Math.hypot(nx, ny, 1);
      const i = (y * w + x) * 4;
      img.data[i] = (nx / l * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny / l * 0.5 + 0.5) * 255;
      img.data[i + 2] = (1 / l * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function tex(canvas, { repeat = [1, 1], srgb = false, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = aniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Metallic flake: per-pixel random micro-normals that sparkle up close and
// average out to a smooth surface at distance (mipmapping does the blending).
function flakeNormal() {
  const s = 512, c = makeCanvas(s, s), ctx = c.getContext('2d');
  const img = ctx.createImageData(s, s), r = rng(7);
  for (let i = 0; i < s * s; i++) {
    const a = r() * Math.PI * 2, m = Math.pow(r(), 2) * 0.55;
    const nx = Math.cos(a) * m, ny = Math.sin(a) * m, nz = Math.sqrt(1 - m * m);
    img.data[i * 4] = (nx * 0.5 + 0.5) * 255;
    img.data[i * 4 + 1] = (ny * 0.5 + 0.5) * 255;
    img.data[i * 4 + 2] = (nz * 0.5 + 0.5) * 255;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// 2x2 twill carbon weave: colour map plus height for the normal map.
function carbonCanvases() {
  const s = 256, cell = 32;
  const col = makeCanvas(s, s), hgt = makeCanvas(s, s);
  const cc = col.getContext('2d'), hc = hgt.getContext('2d');
  const r = rng(3);
  for (let y = 0; y < s / cell; y++) {
    for (let x = 0; x < s / cell; x++) {
      const horizontal = ((x + y) >> 1) % 2 === 0; // twill offset: shifts one cell per row
      const px = x * cell, py = y * cell;
      const g1 = horizontal ? cc.createLinearGradient(px, py, px, py + cell) : cc.createLinearGradient(px, py, px + cell, py);
      const base = horizontal ? 34 : 22;
      g1.addColorStop(0, `rgb(${base - 14},${base - 13},${base - 11})`);
      g1.addColorStop(0.5, `rgb(${base + 12},${base + 13},${base + 16})`);
      g1.addColorStop(1, `rgb(${base - 14},${base - 13},${base - 11})`);
      cc.fillStyle = g1;
      cc.fillRect(px, py, cell, cell);
      // fibre streaks
      cc.strokeStyle = `rgba(255,255,255,${0.025 + r() * 0.02})`;
      for (let k = 0; k < 6; k++) {
        const o = r() * cell;
        cc.beginPath();
        if (horizontal) { cc.moveTo(px, py + o); cc.lineTo(px + cell, py + o); } else { cc.moveTo(px + o, py); cc.lineTo(px + o, py + cell); }
        cc.stroke();
      }
      const g2 = horizontal ? hc.createLinearGradient(px, py, px, py + cell) : hc.createLinearGradient(px, py, px + cell, py);
      g2.addColorStop(0, '#202020');
      g2.addColorStop(0.5, '#f0f0f0');
      g2.addColorStop(1, '#202020');
      hc.fillStyle = g2;
      hc.fillRect(px, py, cell, cell);
    }
  }
  return { col, hgt };
}

function honeycombHeight() {
  const w = 240, h = 208, c = makeCanvas(w, h), ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  const R = 20, hx = R * Math.sqrt(3);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 5;
  for (let row = -1; row < h / (R * 1.5) + 1; row++) {
    for (let col = -1; col < w / hx + 1; col++) {
      const cx = col * hx + (row % 2 ? hx / 2 : 0), cy = row * R * 1.5;
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = Math.PI / 6 + k * Math.PI / 3;
        const x = cx + R * Math.cos(a), y = cy + R * Math.sin(a);
        k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }
  return c;
}

function treadHeight() {
  const w = 128, h = 128, c = makeCanvas(w, h), ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#000';
  ctx.lineCap = 'round';
  // directional V sipes across the shoulders, plain rib in the middle
  ctx.lineWidth = 5;
  for (const [y0, y1, dir] of [[0, 34, 1], [94, 128, -1]]) {
    ctx.beginPath();
    ctx.moveTo(30, y0);
    ctx.lineTo(30 + dir * 0 + 26, y1);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(30 + 64, y0);
    ctx.lineTo(30 + 64 + 26, y1);
    ctx.stroke();
  }
  ctx.lineWidth = 2.5;
  for (let k = 0; k < 2; k++) {
    ctx.beginPath();
    ctx.moveTo(10 + k * 64, 44);
    ctx.lineTo(40 + k * 64, 56);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(10 + k * 64, 84);
    ctx.lineTo(40 + k * 64, 72);
    ctx.stroke();
  }
  return c;
}

function sidewallCanvases(text) {
  const w = 4096, h = 128;
  const hgt = makeCanvas(w, h), ctx = hgt.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.font = '700 46px "Michroma", "Arial Black", sans-serif';
  for (let k = 0; k < 2; k++) {
    const x0 = k * w / 2 + 120;
    ctx.fillText(text[0], x0, 64);
    ctx.font = '600 26px "Manrope", Arial, sans-serif';
    ctx.fillText(text[1], x0 + 980, 64);
    ctx.font = '700 46px "Michroma", "Arial Black", sans-serif';
  }
  // thin concentric rib lines
  ctx.fillRect(0, 12, w, 3);
  ctx.fillRect(0, 113, w, 3);
  return hgt;
}

function grainHeight(seed, scale = 1) {
  const s = 256, c = makeCanvas(s, s), ctx = c.getContext('2d');
  const r = rng(seed);
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 2600 * scale; i++) {
    const x = r() * s, y = r() * s, rad = 1 + r() * 3;
    const v = r() > 0.5 ? 255 : 0;
    ctx.fillStyle = `rgba(${v},${v},${v},0.08)`;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
    // wrap-around copies so the tile is seamless
    for (const [ox, oy] of [[s, 0], [-s, 0], [0, s], [0, -s]]) {
      ctx.beginPath();
      ctx.arc(x + ox, y + oy, rad, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return c;
}

function louvreHeight() {
  const c = makeCanvas(64, 256), ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 32);
  g.addColorStop(0, '#000');
  g.addColorStop(0.7, '#fff');
  g.addColorStop(1, '#000');
  for (let y = 0; y < 256; y += 32) {
    ctx.save();
    ctx.translate(0, y);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 32);
    ctx.restore();
  }
  return c;
}

function radialDiscCanvas() {
  // Brushed / turned finish for brake discs: concentric scratches.
  const s = 512, c = makeCanvas(s, s), ctx = c.getContext('2d'), r = rng(11);
  ctx.fillStyle = '#8a8a8a';
  ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 900; i++) {
    const rad = 60 + r() * 200, a0 = r() * Math.PI * 2, len = 0.2 + r() * 1.2;
    const v = 110 + r() * 60;
    ctx.strokeStyle = `rgba(${v},${v},${v},0.25)`;
    ctx.lineWidth = 0.6 + r();
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, rad, a0, a0 + len);
    ctx.stroke();
  }
  return c;
}

export function plateCanvas(text) {
  const w = 1040, h = 220, c = makeCanvas(w, h), ctx = c.getContext('2d');
  ctx.fillStyle = '#f2f2ee';
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 22);
  ctx.fill();
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.roundRect(12, 12, w - 24, h - 24, 16);
  ctx.stroke();
  ctx.fillStyle = '#121212';
  ctx.font = '700 150px "Manrope", "Arial Narrow", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2 + 8);
  return c;
}

export function wordmarkCanvas(text) {
  const w = 1024, h = 160, c = makeCanvas(w, h), ctx = c.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  ctx.font = '400 104px "Michroma", "Arial Black", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '38px';
  ctx.fillText(text, w / 2 + 19, h / 2);
  return c;
}

export function clusterCanvas() {
  const w = 1024, h = 360, c = makeCanvas(w, h), ctx = c.getContext('2d');
  ctx.fillStyle = '#020305';
  ctx.fillRect(0, 0, w, h);
  const cx = w / 2, cy = 215;
  // tachometer arc
  ctx.lineWidth = 14;
  ctx.strokeStyle = '#1b2a33';
  ctx.beginPath();
  ctx.arc(cx, cy, 150, Math.PI * 0.8, Math.PI * 2.2);
  ctx.stroke();
  ctx.strokeStyle = '#e8c27a';
  ctx.beginPath();
  ctx.arc(cx, cy, 150, Math.PI * 0.8, Math.PI * 1.15);
  ctx.stroke();
  ctx.strokeStyle = '#d23c2a';
  ctx.beginPath();
  ctx.arc(cx, cy, 150, Math.PI * 2.0, Math.PI * 2.2);
  ctx.stroke();
  ctx.fillStyle = '#eef3f6';
  ctx.textAlign = 'center';
  ctx.font = '600 96px "Manrope", Arial, sans-serif';
  ctx.fillText('0', cx, cy + 20);
  ctx.font = '500 26px "Manrope", Arial, sans-serif';
  ctx.fillStyle = '#7d8c96';
  ctx.fillText('KM/H', cx, cy + 62);
  ctx.font = '700 44px "Manrope", Arial, sans-serif';
  ctx.fillStyle = '#e8c27a';
  ctx.fillText('P', cx, cy - 85);
  ctx.textAlign = 'left';
  ctx.font = '500 28px "Manrope", Arial, sans-serif';
  ctx.fillStyle = '#7d8c96';
  ctx.fillText('RANGE  412 km', 60, 90);
  ctx.fillText('OIL  92 °C', 60, 140);
  ctx.textAlign = 'right';
  ctx.fillText('MODE  GT', w - 60, 90);
  ctx.fillText('19 °C', w - 60, 140);
  return c;
}

export function screenCanvas() {
  const w = 640, h = 400, c = makeCanvas(w, h), ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#071016');
  g.addColorStop(1, '#0c1820');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(120,170,190,0.35)';
  ctx.lineWidth = 3;
  // stylised route map
  ctx.beginPath();
  ctx.moveTo(40, 340);
  ctx.bezierCurveTo(160, 300, 180, 160, 320, 180);
  ctx.bezierCurveTo(440, 200, 470, 90, 600, 70);
  ctx.stroke();
  ctx.strokeStyle = '#e8c27a';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(40, 340);
  ctx.bezierCurveTo(160, 300, 180, 160, 320, 180);
  ctx.stroke();
  ctx.fillStyle = '#eef3f6';
  ctx.font = '600 34px "Manrope", Arial, sans-serif';
  ctx.fillText('Col de Turini', 34, 60);
  ctx.font = '500 22px "Manrope", Arial, sans-serif';
  ctx.fillStyle = '#7d8c96';
  ctx.fillText('38 km · 41 min', 34, 94);
  return c;
}

export function createMaterials(envIntensity = 1) {
  const flake = tex(flakeNormal(), { repeat: [1, 1] });
  const carbon = carbonCanvases();
  const carbonMap = tex(carbon.col, { srgb: true, repeat: [24, 24] });
  const carbonNormal = tex(heightToNormal(carbon.hgt, 3), { repeat: [24, 24] });
  const honey = tex(heightToNormal(honeycombHeight(), 4), { repeat: [10, 10] });
  const tread = tex(heightToNormal(treadHeight(), 6));
  const leatherN = tex(heightToNormal(grainHeight(5), 2.5));
  const louvreN = tex(heightToNormal(louvreHeight(), 6));
  const discMap = tex(radialDiscCanvas(), { srgb: true, repeat: [1, 1] });
  discMap.wrapS = discMap.wrapT = THREE.ClampToEdgeWrapping;
  const sidewallN = tex(heightToNormal(sidewallCanvases(['VELOCITÀ SPORT', '255/35 ZR20  96Y  ·  DOT 2626']), 3));
  sidewallN.wrapT = THREE.ClampToEdgeWrapping;

  const M = {};

  // Car paint: metallic base with flake micro-normals under a mirror clear coat.
  M.paint = new THREE.MeshPhysicalMaterial({
    color: 0x7a0f12,
    metalness: 0.62,
    roughness: 0.32,
    clearcoat: 1,
    clearcoatRoughness: 0.025,
    normalMap: flake,
    normalScale: new THREE.Vector2(0.22, 0.22),
    envMapIntensity: envIntensity,
  });
  M.paint.userData.flake = flake;

  M.paint.side = THREE.DoubleSide; // panel edges (door shuts, jambs) reuse the paint

  M.wall = new THREE.MeshStandardMaterial({ color: 0x080809, metalness: 0.2, roughness: 0.6, side: THREE.DoubleSide });
  M.gloss = new THREE.MeshPhysicalMaterial({ color: 0x050506, metalness: 0.1, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.03 });
  M.satin = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, metalness: 0.0, roughness: 0.55 });
  M.under = new THREE.MeshStandardMaterial({ color: 0x0a0a0b, metalness: 0.0, roughness: 0.85 });
  M.liner = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.95, side: THREE.DoubleSide });
  M.seam = new THREE.MeshBasicMaterial({ color: 0x020202 });

  M.carbon = new THREE.MeshPhysicalMaterial({
    map: carbonMap,
    normalMap: carbonNormal,
    normalScale: new THREE.Vector2(0.35, 0.35),
    color: 0xffffff,
    metalness: 0.25,
    roughness: 0.38,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    side: THREE.DoubleSide,
  });
  M.carbon.userData.maps = [carbonMap, carbonNormal];

  M.honeycomb = new THREE.MeshStandardMaterial({ color: 0x141416, metalness: 0.5, roughness: 0.4, normalMap: honey, normalScale: new THREE.Vector2(1.6, 1.6), side: THREE.DoubleSide });
  M.louvre = new THREE.MeshStandardMaterial({ color: 0x1b1c1e, metalness: 0.3, roughness: 0.45, normalMap: louvreN, normalScale: new THREE.Vector2(2.4, 2.4) });

  // Glass is drawn as two layers: a transparent tint, then a reflection-only pass added on top.
  // Additive reflections stay at full strength however dark the tint is, like real glazing.
  M.glassTint = new THREE.MeshBasicMaterial({ color: 0x05070a, transparent: true, opacity: 0.6, depthWrite: false });
  M.glassRefl = new THREE.MeshPhysicalMaterial({
    color: 0x000000, metalness: 0, roughness: 0.02, specularIntensity: 1, ior: 1.52,
    envMapIntensity: 1.6, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  M.frit = new THREE.MeshPhysicalMaterial({ color: 0x030303, metalness: 0, roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.02 });
  M.lensTint = new THREE.MeshBasicMaterial({ color: 0x0a0c10, transparent: true, opacity: 0.12, depthWrite: false });
  M.redLens = new THREE.MeshPhysicalMaterial({ color: 0x3a0306, metalness: 0, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.02, transparent: true, opacity: 0.62, depthWrite: false, envMapIntensity: 1.3 });
  M.housing = new THREE.MeshPhysicalMaterial({ color: 0x8c9198, metalness: 1, roughness: 0.32, side: THREE.DoubleSide });
  M.tailHousing = new THREE.MeshStandardMaterial({ color: 0x0c0606, metalness: 0.6, roughness: 0.35, side: THREE.DoubleSide });
  M.chrome = new THREE.MeshStandardMaterial({ color: 0xe6e8ea, metalness: 1, roughness: 0.05 });
  M.mirrorGlass = new THREE.MeshStandardMaterial({ color: 0xb8c0c8, metalness: 1, roughness: 0.0 });
  M.titanium = new THREE.MeshPhysicalMaterial({ color: 0x9a9690, metalness: 1, roughness: 0.22, iridescence: 0.25, iridescenceIOR: 1.6, iridescenceThicknessRange: [260, 420], side: THREE.DoubleSide });
  M.exhaustInner = new THREE.MeshStandardMaterial({ color: 0x050403, roughness: 0.9, side: THREE.DoubleSide });

  // Lights: emissive materials whose intensity the configurator drives.
  M.drl = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xf2f6ff, emissiveIntensity: 3.2 });
  M.ledLow = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, emissive: 0xe9f1ff, emissiveIntensity: 0.0, roughness: 0.2 });
  M.amber = new THREE.MeshStandardMaterial({ color: 0x1a0d00, emissive: 0xff8a10, emissiveIntensity: 0.0 });
  M.tail = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff0a0a, emissiveIntensity: 0.0 });
  M.brake = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff0a0a, emissiveIntensity: 0.0 });
  M.ambient = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffb36b, emissiveIntensity: 2.2 });
  M.cluster = new THREE.MeshBasicMaterial({ map: tex(clusterCanvas(), { srgb: true }), toneMapped: true });
  M.screen = new THREE.MeshBasicMaterial({ map: tex(screenCanvas(), { srgb: true }), toneMapped: true });
  M.cluster.map.wrapS = M.cluster.map.wrapT = THREE.ClampToEdgeWrapping;
  M.screen.map.wrapS = M.screen.map.wrapT = THREE.ClampToEdgeWrapping;

  // Wheels
  M.tyre = new THREE.MeshPhysicalMaterial({ color: 0x141414, roughness: 0.62, metalness: 0, sheen: 0.4, sheenRoughness: 0.8, sheenColor: new THREE.Color(0x333333), normalMap: sidewallN, normalScale: new THREE.Vector2(0.9, 0.9) });
  M.tread = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9, metalness: 0, normalMap: tread, normalScale: new THREE.Vector2(1.5, 1.5) });
  tread.repeat.set(60, 1);
  M.rim = new THREE.MeshPhysicalMaterial({ color: 0xc9cbce, metalness: 1, roughness: 0.24, clearcoat: 0.6, clearcoatRoughness: 0.08 });
  M.rimLip = new THREE.MeshStandardMaterial({ color: 0xe9eaec, metalness: 1, roughness: 0.06 });
  M.rimInner = new THREE.MeshStandardMaterial({ color: 0x3a3b3d, metalness: 0.8, roughness: 0.5 });
  M.disc = new THREE.MeshStandardMaterial({ color: 0xffffff, map: discMap, metalness: 1, roughness: 0.42 });
  M.discHat = new THREE.MeshStandardMaterial({ color: 0x2a2a2c, metalness: 0.7, roughness: 0.5 });
  M.caliper = new THREE.MeshPhysicalMaterial({ color: 0xb3121a, metalness: 0.1, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.05 });
  M.lug = new THREE.MeshStandardMaterial({ color: 0xd0d2d4, metalness: 1, roughness: 0.18 });

  // Interior
  M.leather = new THREE.MeshPhysicalMaterial({ color: 0x1d1d20, roughness: 0.55, metalness: 0, sheen: 0.6, sheenRoughness: 0.5, sheenColor: new THREE.Color(0x2a2a2e), normalMap: leatherN, normalScale: new THREE.Vector2(0.4, 0.4) });
  M.accent = new THREE.MeshPhysicalMaterial({ color: 0x6b3518, roughness: 0.6, metalness: 0, sheen: 0.8, sheenRoughness: 0.4, sheenColor: new THREE.Color(0x9a5a30), normalMap: leatherN, normalScale: new THREE.Vector2(0.3, 0.3) });
  M.trim = new THREE.MeshStandardMaterial({ color: 0x151517, roughness: 0.7, side: THREE.DoubleSide });
  M.brushed = new THREE.MeshStandardMaterial({ color: 0x9fa3a8, metalness: 1, roughness: 0.3 });

  M.plateCanvas = plateCanvas;
  M.wordmarkCanvas = wordmarkCanvas;
  M.tex = tex;
  return M;
}

export const PAINTS = [
  { id: 'rosso', name: 'Rosso Corsa Metallic', hex: '#7a0f12', metalness: 0.6, roughness: 0.32, cc: 0.025 },
  { id: 'obsidian', name: 'Obsidian Black', hex: '#0b0c0e', metalness: 0.55, roughness: 0.35, cc: 0.02 },
  { id: 'glacier', name: 'Glacier White Pearl', hex: '#d9dbd8', metalness: 0.15, roughness: 0.3, cc: 0.02 },
  { id: 'silver', name: 'Liquid Silver', hex: '#9da3a8', metalness: 0.9, roughness: 0.28, cc: 0.02 },
  { id: 'blue', name: 'Abyss Blue Metallic', hex: '#0d2a5e', metalness: 0.7, roughness: 0.3, cc: 0.02 },
  { id: 'lava', name: 'Lava Orange', hex: '#c2410c', metalness: 0.45, roughness: 0.3, cc: 0.025 },
  { id: 'green', name: 'British Racing Green', hex: '#0f3324', metalness: 0.6, roughness: 0.32, cc: 0.02 },
  { id: 'graphite', name: 'Satin Graphite', hex: '#3a3d42', metalness: 0.6, roughness: 0.45, cc: 0.42 },
];

export const WHEEL_FINISHES = [
  { id: 'silver', name: 'Sterling Silver', hex: '#c9cbce', metalness: 1, roughness: 0.24 },
  { id: 'gunmetal', name: 'Gunmetal', hex: '#45484d', metalness: 1, roughness: 0.32 },
  { id: 'black', name: 'Gloss Black', hex: '#0d0d0e', metalness: 0.4, roughness: 0.16 },
  { id: 'bronze', name: 'Satin Bronze', hex: '#8a6a3c', metalness: 1, roughness: 0.34 },
];

export const CALIPERS = [
  { id: 'red', name: 'Racing Red', hex: '#b3121a' },
  { id: 'yellow', name: 'Signal Yellow', hex: '#e0a910' },
  { id: 'black', name: 'Black', hex: '#111113' },
  { id: 'blue', name: 'Electric Blue', hex: '#1f4fd0' },
];

export const INTERIORS = [
  { id: 'cognac', name: 'Nero / Cognac', hex: '#6b3518', sheen: '#9a5a30' },
  { id: 'rosso', name: 'Nero / Rosso', hex: '#6e0e12', sheen: '#a32a2a' },
  { id: 'nero', name: 'Nero Integrale', hex: '#1d1d20', sheen: '#3a3a3e' },
  { id: 'crema', name: 'Nero / Crema', hex: '#b9ab92', sheen: '#e3d7c0' },
];
