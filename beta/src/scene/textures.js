// Procedural textures drawn on canvases at startup (no image assets are downloaded).
import * as THREE from 'three';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function hash(x, y, s) {
  let n = (x * 374761393 + y * 668265263 + s * 2246822519) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

// Smooth tileable value noise.
function vnoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const p = (a) => ((a % period) + period) % period;
  const a = hash(p(xi), p(yi), seed), b = hash(p(xi + 1), p(yi), seed);
  const c = hash(p(xi), p(yi + 1), seed), d = hash(p(xi + 1), p(yi + 1), seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function fbm(x, y, period, seed, oct = 4) {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let o = 0; o < oct; o++) {
    s += a * vnoise(x * f, y * f, period * f, seed + o * 17);
    n += a;
    a *= 0.5;
    f *= 2;
  }
  return s / n;
}

function pixels(w, h, fn) {
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * w + x) * 4;
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function tex(c, { repeat = [1, 1], srgb = false, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = aniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

export function createTextures() {
  const T = {};
  // Brushed / ground steel roughness: long streaks along U.
  T.brushedRough = tex(pixels(256, 256, (x, y) => {
    const n = fbm(x / 64, y / 2, 4, 3, 3) * 0.6 + hash(x >> 3, y, 9) * 0.25 + 0.15;
    const v = 70 + n * 90;
    return [v, v, v];
  }), { repeat: [2, 2] });

  // Surface-ground cast iron table top: fine crosshatch from the grinding wheel.
  T.groundRough = tex(pixels(256, 256, (x, y) => {
    const a = Math.sin((x + y * 0.35) * 0.9) * 0.5 + 0.5;
    const n = hash(x, y, 4) * 0.35 + fbm(x / 32, y / 32, 8, 5, 3) * 0.4 + a * 0.25;
    const v = 60 + n * 110;
    return [v, v, v];
  }), { repeat: [4, 2] });

  // Painted sheet metal: faint orange peel.
  T.paintRough = tex(pixels(128, 128, (x, y) => {
    const v = 105 + fbm(x / 8, y / 8, 16, 7, 3) * 60;
    return [v, v, v];
  }), { repeat: [6, 6] });

  // Cast iron casting paint, a little blotchy.
  T.castColor = tex(pixels(256, 256, (x, y) => {
    const n = fbm(x / 40, y / 40, 6, 11, 4);
    const v = 200 + n * 55;
    return [v, v, v];
  }), { repeat: [2, 2], srgb: true });

  // Concrete floor with expansion joints.
  T.floorColor = tex(pixels(512, 512, (x, y) => {
    const n = fbm(x / 64, y / 64, 8, 21, 5);
    const s = fbm(x / 16, y / 16, 32, 23, 2);
    let v = 92 + n * 52 + s * 14 + hash(x, y, 1) * 8;
    if (x % 256 < 2 || y % 256 < 2) v *= 0.55;
    return [v * 0.98, v * 0.98, v * 0.96];
  }), { repeat: [6, 6], srgb: true });
  T.floorRough = tex(pixels(256, 256, (x, y) => {
    const v = 170 + fbm(x / 32, y / 32, 8, 25, 4) * 70;
    return [v, v, v];
  }), { repeat: [12, 12] });

  // Telescopic way cover: stainless with brushing across.
  T.wayCover = tex(pixels(256, 64, (x, y) => {
    const v = 150 + fbm(x / 2, y / 32, 128, 31, 3) * 60 + hash(x, y >> 2, 2) * 18;
    return [v, v, v];
  }), { repeat: [1, 1], srgb: true });

  // Accordion bellows: dark folds.
  T.bellows = tex(pixels(64, 256, (x, y) => {
    const f = Math.abs(Math.sin((y / 256) * Math.PI * 24));
    const v = 18 + f * 46;
    return [v, v, v + 2];
  }), { repeat: [1, 1], srgb: true });

  // Rubber anti-fatigue mat.
  T.mat = tex(pixels(128, 128, (x, y) => {
    const d = ((x % 16) - 8) ** 2 + ((y % 16) - 8) ** 2;
    const v = d < 18 ? 46 : 30;
    return [v, v, v];
  }), { repeat: [10, 6], srgb: true });

  return T;
}

// Text / sign textures.
export function labelTexture(lines, { w = 512, h = 128, bg = '#1b1e22', fg = '#e8ecf0', font = '600 52px "IBM Plex Sans Condensed", Arial', align = 'center', border = null, accent = null } = {}) {
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  if (accent) {
    ctx.fillStyle = accent;
    ctx.fillRect(0, h - h * 0.12, w, h * 0.12);
  }
  if (border) {
    ctx.strokeStyle = border;
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, w - 6, h - 6);
  }
  ctx.fillStyle = fg;
  ctx.font = font;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  const arr = Array.isArray(lines) ? lines : [lines];
  arr.forEach((t, i) => {
    const y = (h / (arr.length + 1)) * (i + 1);
    ctx.fillText(t, align === 'center' ? w / 2 : 24, y);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function hazardTexture() {
  const c = canvas(256, 32);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#e8b21a';
  ctx.fillRect(0, 0, 256, 32);
  ctx.fillStyle = '#16171a';
  for (let x = -32; x < 256 + 32; x += 32) {
    ctx.beginPath();
    ctx.moveTo(x, 32);
    ctx.lineTo(x + 16, 32);
    ctx.lineTo(x + 32, 0);
    ctx.lineTo(x + 16, 0);
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
