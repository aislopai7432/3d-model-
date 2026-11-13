// Procedural texture atlas for every rubbish material, plus ground and set-dressing textures.
// The atlas has three layers drawn in parallel: colour, height (→ normal map) and
// roughness/metalness (G = roughness, B = metalness, as three.js expects).
import * as THREE from 'three';
import { mulberry, fbm2 } from './rng.js';

export const ATLAS_SIZE = 2048;
export const TILE = 256;
const PER_ROW = ATLAS_SIZE / TILE;
const PAD = 6; // pixels of padding inside each tile (avoids mip bleeding)

function canvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

let NOISE = null;
function noiseTile() {
  if (NOISE) return NOISE;
  const c = canvas(TILE), ctx = c.getContext('2d');
  const img = ctx.createImageData(TILE, TILE);
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
    const v = (fbm2(x / 22, y / 22, 3, 5) * 0.5 + 0.5) * 255;
    const i = (y * TILE + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  NOISE = c;
  return c;
}
let SPECK = null;
function speckTile() {
  if (SPECK) return SPECK;
  const c = canvas(TILE), ctx = c.getContext('2d');
  const img = ctx.createImageData(TILE, TILE), r = mulberry(99);
  for (let i = 0; i < TILE * TILE; i++) {
    const v = r() * 255;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  SPECK = c;
  return c;
}

// grime overlay: multiply dark noise blotches
function grime(ctx, amount = 0.35, tint = '60,45,30') {
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = amount;
  ctx.drawImage(noiseTile(), 0, 0);
  ctx.globalAlpha = amount * 0.6;
  ctx.fillStyle = `rgb(${tint})`;
  const r = mulberry(Math.floor(Math.random() * 1e9));
  for (let i = 0; i < 6; i++) {
    const g = ctx.createRadialGradient(r() * TILE, r() * TILE, 2, r() * TILE, r() * TILE, 30 + r() * 70);
    g.addColorStop(0, `rgba(${tint},0.8)`);
    g.addColorStop(1, `rgba(${tint},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, TILE, TILE);
  }
  ctx.restore();
}
function speckle(ctx, alpha = 0.15, op = 'overlay') {
  ctx.save();
  ctx.globalCompositeOperation = op;
  ctx.globalAlpha = alpha;
  ctx.drawImage(speckTile(), 0, 0);
  ctx.restore();
}
function heightNoise(h, amount = 0.5, scale = 1) {
  h.save();
  h.globalAlpha = amount;
  if (scale !== 1) { h.scale(scale, scale); }
  h.drawImage(noiseTile(), 0, 0);
  h.restore();
}
function mat(m, rough, metal) {
  m.fillStyle = `rgb(0,${Math.round(rough * 255)},${Math.round(metal * 255)})`;
  m.fillRect(0, 0, TILE, TILE);
}
function text(ctx, str, x, y, font, color, align = 'left') {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(str, x, y);
}

// ---- Tile painters: (c colour, h height, m rough/metal, r rng) ------------------
const P = {};

P.cardboard = (c, h, m, r, dark) => {
  c.fillStyle = dark ? '#8a6a45' : '#b48e5c';
  c.fillRect(0, 0, TILE, TILE);
  // corrugation lines
  for (let x = 0; x < TILE; x += 6) {
    c.fillStyle = `rgba(80,55,30,${0.06 + r() * 0.05})`;
    c.fillRect(x, 0, 2, TILE);
    h.fillStyle = 'rgba(255,255,255,0.5)';
    h.fillRect(x, 0, 3, TILE);
  }
  // packing tape
  c.fillStyle = 'rgba(200,170,110,0.75)';
  c.fillRect(0, 110 + r() * 20, TILE, 28);
  // print
  c.save();
  c.globalAlpha = 0.65;
  text(c, r() < 0.5 ? 'THIS WAY UP' : 'FRAGILE', 30, 60, '700 26px Arial', '#3b2a18');
  c.strokeStyle = '#3b2a18';
  c.lineWidth = 4;
  c.beginPath(); c.moveTo(190, 40); c.lineTo(205, 20); c.lineTo(220, 40); c.moveTo(205, 20); c.lineTo(205, 70); c.stroke();
  text(c, 'No. ' + Math.floor(r() * 9000 + 1000), 30, 210, '600 18px Arial', '#3b2a18');
  c.restore();
  if (dark) { c.fillStyle = '#f2efe6'; c.fillRect(140, 170, 90, 56); text(c, 'DELIVER TO', 146, 184, '700 11px Arial', '#222'); for (let i = 0; i < 3; i++) c.fillRect(146, 196 + i * 9, 70 - i * 12, 3); }
  grime(c, dark ? 0.55 : 0.4, '70,50,25');
  heightNoise(h, 0.25);
  mat(m, 0.92, 0);
};

P.newsprint = (c, h, m, r) => {
  c.fillStyle = '#d9d4c3';
  c.fillRect(0, 0, TILE, TILE);
  const heads = ['PRICES SOAR', 'LOCAL HERO', 'STORM WARNING', 'CITY WINS', 'GOLD RUSH?', 'COUNCIL VOTE'];
  text(c, r.pick(heads), 12, 26, '900 28px Georgia, serif', '#1d1d1d');
  c.fillStyle = '#1d1d1d';
  c.fillRect(12, 44, 232, 2);
  // photo block
  const px = r() < 0.5 ? 12 : 132;
  const g = c.createLinearGradient(px, 56, px + 110, 140);
  g.addColorStop(0, '#555');
  g.addColorStop(1, '#999');
  c.fillStyle = g;
  c.fillRect(px, 56, 110, 80);
  // text columns
  for (let col = 0; col < 3; col++) {
    for (let y = 60; y < 246; y += 7) {
      const x = 12 + col * 79;
      if (y < 140 && x >= px - 5 && x < px + 110) continue;
      c.fillStyle = `rgba(30,30,30,${0.55 + r() * 0.2})`;
      c.fillRect(x, y, 70 - (r() < 0.12 ? r() * 30 : 0), 3);
    }
  }
  grime(c, 0.45, '120,100,60');
  heightNoise(h, 0.15);
  mat(m, 0.95, 0);
};

const CAN = [
  ['#c41f1f', '#ffffff', 'FIZZ'], ['#1b5bc4', '#f6d33c', 'BLUE'], ['#1d8a3c', '#ffffff', 'LIME'],
  ['#f1b81f', '#1a1a1a', 'BUZZ'], ['#151515', '#f0d070', 'LAGER'], ['#e8e8e8', '#d4271d', 'TONIC'],
];
P.can = (c, h, m, r, i) => {
  const [bg, fg, word] = CAN[i % CAN.length];
  c.fillStyle = bg;
  c.fillRect(0, 0, TILE, TILE);
  // silver top/bottom bands (v=0 bottom, v=1 top → canvas top is v=1)
  const band = (y, hgt) => { const g = c.createLinearGradient(0, y, 0, y + hgt); g.addColorStop(0, '#9da2a6'); g.addColorStop(0.5, '#e6e8ea'); g.addColorStop(1, '#8a8f93'); c.fillStyle = g; c.fillRect(0, y, TILE, hgt); };
  band(0, 22);
  band(TILE - 22, 22);
  c.save();
  c.translate(TILE / 2, TILE / 2);
  c.rotate(-Math.PI / 2);
  text(c, word, 0, -40, '900 46px Arial Black, Arial', fg, 'center');
  text(c, word, 0, 70, '900 46px Arial Black, Arial', fg, 'center');
  c.restore();
  c.fillStyle = fg;
  c.globalAlpha = 0.8;
  c.fillRect(0, 120, TILE, 8);
  c.globalAlpha = 1;
  // scuffs reveal aluminium
  for (let k = 0; k < 40; k++) { c.fillStyle = `rgba(200,205,210,${0.3 + r() * 0.5})`; c.fillRect(r() * TILE, r() * TILE, 2 + r() * 14, 1 + r() * 2); }
  grime(c, 0.25, '60,50,40');
  heightNoise(h, 0.3);
  m.fillStyle = 'rgb(0,95,200)';
  m.fillRect(0, 0, TILE, TILE);
  m.fillStyle = 'rgb(0,70,255)';
  m.fillRect(0, 0, TILE, 22);
  m.fillRect(0, TILE - 22, TILE, 22);
};

const PACK = ['cereal', 'crisps', 'pizza', 'milk', 'takeaway', 'biscuit'];
P.packaging = (c, h, m, r, i) => {
  const kind = PACK[i % PACK.length];
  let metal = 0, rough = 0.6;
  if (kind === 'cereal') {
    c.fillStyle = '#f2c230'; c.fillRect(0, 0, TILE, TILE);
    c.fillStyle = '#d13c1f'; c.beginPath(); c.arc(128, 150, 70, 0, Math.PI * 2); c.fill();
    text(c, 'CRUNCH', 128, 50, '900 40px Arial Black, Arial', '#7a1a0a', 'center');
    text(c, 'O\'S', 128, 150, '900 52px Arial Black, Arial', '#fff3c0', 'center');
  } else if (kind === 'crisps') {
    const g = c.createLinearGradient(0, 0, TILE, TILE); g.addColorStop(0, '#2f7de0'); g.addColorStop(1, '#173f8a');
    c.fillStyle = g; c.fillRect(0, 0, TILE, TILE);
    text(c, 'SALTED', 128, 80, '900 42px Arial Black, Arial', '#ffffff', 'center');
    c.fillStyle = '#f6d36a'; for (let k = 0; k < 7; k++) { c.beginPath(); c.ellipse(60 + r() * 140, 150 + r() * 70, 22, 15, r() * 3, 0, 7); c.fill(); }
    metal = 0.55; rough = 0.3;
  } else if (kind === 'pizza') {
    c.fillStyle = '#c9a777'; c.fillRect(0, 0, TILE, TILE);
    c.strokeStyle = '#a32a1c'; c.lineWidth = 8; c.strokeRect(24, 24, 208, 208);
    text(c, 'HOT PIZZA', 128, 128, 'italic 900 34px Georgia, serif', '#a32a1c', 'center');
    c.fillStyle = 'rgba(120,70,20,0.45)'; c.beginPath(); c.ellipse(170, 190, 50, 30, 0.4, 0, 7); c.fill();
    rough = 0.9;
  } else if (kind === 'milk') {
    c.fillStyle = '#f4f6f6'; c.fillRect(0, 0, TILE, TILE);
    c.fillStyle = '#2a63c9'; c.fillRect(0, 150, TILE, 70);
    text(c, 'MILK', 128, 90, '900 50px Arial Black, Arial', '#2a63c9', 'center');
    text(c, 'SEMI-SKIMMED', 128, 185, '700 22px Arial', '#ffffff', 'center');
  } else if (kind === 'takeaway') {
    c.fillStyle = '#e9e5dc'; c.fillRect(0, 0, TILE, TILE);
    c.strokeStyle = '#c33'; c.lineWidth = 5; for (let k = 0; k < 4; k++) { c.beginPath(); c.arc(128, 128, 30 + k * 26, 0, Math.PI * 2); c.stroke(); }
    text(c, 'GOLDEN DRAGON', 128, 128, '700 20px Georgia, serif', '#b22', 'center');
    rough = 0.75;
  } else {
    c.fillStyle = '#5a2d82'; c.fillRect(0, 0, TILE, TILE);
    text(c, 'CHOCO', 128, 90, '900 48px Arial Black, Arial', '#f7d25b', 'center');
    text(c, 'DIGESTIVES', 128, 150, '700 26px Arial', '#ffffff', 'center');
    metal = 0.3; rough = 0.4;
  }
  // creases and wear
  for (let k = 0; k < 8; k++) { c.strokeStyle = `rgba(255,255,255,${0.15 + r() * 0.2})`; c.lineWidth = 1 + r() * 2; c.beginPath(); c.moveTo(r() * TILE, r() * TILE); c.lineTo(r() * TILE, r() * TILE); c.stroke(); }
  grime(c, 0.35);
  heightNoise(h, 0.35);
  mat(m, rough, metal);
};

P.pcb = (c, h, m, r, i) => {
  c.fillStyle = i ? '#1f4f2c' : '#13462e';
  c.fillRect(0, 0, TILE, TILE);
  h.fillStyle = '#606060';
  h.fillRect(0, 0, TILE, TILE);
  // traces
  c.strokeStyle = 'rgba(120,190,110,0.6)';
  c.lineWidth = 2;
  for (let k = 0; k < 60; k++) {
    let x = r() * TILE, y = r() * TILE;
    c.beginPath(); c.moveTo(x, y);
    for (let s = 0; s < 4; s++) { if (r() < 0.5) x += (r() - 0.5) * 80; else y += (r() - 0.5) * 80; c.lineTo(x, y); }
    c.stroke();
  }
  // chips
  for (let k = 0; k < 7; k++) {
    const w = 20 + r() * 50, hh = 14 + r() * 30, x = r() * (TILE - w), y = r() * (TILE - hh);
    c.fillStyle = '#151515'; c.fillRect(x, y, w, hh);
    h.fillStyle = '#ffffff'; h.fillRect(x, y, w, hh);
    c.fillStyle = '#c9a646';
    for (let p = 2; p < w - 2; p += 4) { c.fillRect(x + p, y - 3, 2, 3); c.fillRect(x + p, y + hh, 2, 3); }
    text(c, 'IC' + Math.floor(r() * 900), x + 3, y + hh / 2, '600 8px Arial', '#999');
  }
  // capacitors
  for (let k = 0; k < 10; k++) { const x = r() * TILE, y = r() * TILE; c.fillStyle = r() < 0.5 ? '#2b4fa8' : '#222'; c.beginPath(); c.arc(x, y, 6, 0, 7); c.fill(); h.fillStyle = '#ddd'; h.beginPath(); h.arc(x, y, 6, 0, 7); h.fill(); }
  // gold pads
  for (let k = 0; k < 30; k++) { c.fillStyle = '#d4af37'; c.fillRect(r() * TILE, r() * TILE, 4, 4); }
  grime(c, 0.3, '50,40,30');
  m.fillStyle = 'rgb(0,110,0)';
  m.fillRect(0, 0, TILE, TILE);
};

const FAB = [
  ['#2c4a78', 'denim'], ['#8a2a2a', 'plaid'], ['#6b6f4a', 'khaki'], ['#d8d2c4', 'knit'], ['#9a5aa8', 'floral'], ['#2b2b2e', 'tee'],
];
P.fabric = (c, h, m, r, i) => {
  const [col, kind] = FAB[i % FAB.length];
  c.fillStyle = col;
  c.fillRect(0, 0, TILE, TILE);
  h.fillStyle = '#808080';
  h.fillRect(0, 0, TILE, TILE);
  if (kind === 'denim') {
    for (let y = 0; y < TILE; y += 2) { c.fillStyle = `rgba(255,255,255,${0.04 + r() * 0.06})`; c.fillRect(0, y, TILE, 1); }
    for (let x = 0; x < TILE; x += 3) { h.fillStyle = 'rgba(255,255,255,0.4)'; h.fillRect(x, 0, 1, TILE); }
    c.strokeStyle = '#d99a3a'; c.lineWidth = 2; c.setLineDash([5, 4]); c.beginPath(); c.moveTo(20, 0); c.lineTo(30, TILE); c.stroke(); c.setLineDash([]);
  } else if (kind === 'plaid') {
    for (let k = 0; k < TILE; k += 48) {
      c.fillStyle = 'rgba(20,20,40,0.45)'; c.fillRect(k, 0, 18, TILE); c.fillRect(0, k, TILE, 18);
      c.fillStyle = 'rgba(240,210,120,0.35)'; c.fillRect(k + 30, 0, 3, TILE); c.fillRect(0, k + 30, TILE, 3);
    }
  } else if (kind === 'knit') {
    for (let y = 0; y < TILE; y += 8) for (let x = 0; x < TILE; x += 8) { h.fillStyle = 'rgba(255,255,255,0.6)'; h.beginPath(); h.ellipse(x + 4, y + 4, 3, 4, 0.5, 0, 7); h.fill(); }
    c.fillStyle = '#8b3b3b'; c.fillRect(0, 90, TILE, 20); c.fillRect(0, 150, TILE, 10);
  } else if (kind === 'floral') {
    for (let k = 0; k < 40; k++) { const x = r() * TILE, y = r() * TILE; c.fillStyle = r() < 0.5 ? '#f3d8e6' : '#ffe08a'; for (let p = 0; p < 5; p++) { c.beginPath(); c.arc(x + Math.cos(p * 1.26) * 6, y + Math.sin(p * 1.26) * 6, 4, 0, 7); c.fill(); } }
  } else if (kind === 'tee') {
    text(c, 'ROCK', 128, 128, '900 54px Arial Black, Arial', '#d8d8d8', 'center');
  }
  for (let y = 0; y < TILE; y += 2) { h.fillStyle = `rgba(0,0,0,${0.1 + r() * 0.15})`; h.fillRect(0, y, TILE, 1); }
  grime(c, 0.4);
  mat(m, 1.0, 0);
};

P.wood = (c, h, m, r, i) => {
  const base = ['#b58a55', '#6e4a2c', '#5f7a5a'][i % 3];
  c.fillStyle = base;
  c.fillRect(0, 0, TILE, TILE);
  for (let k = 0; k < 70; k++) {
    const y = r() * TILE;
    c.strokeStyle = `rgba(60,35,15,${0.15 + r() * 0.25})`;
    c.lineWidth = 0.6 + r() * 2;
    c.beginPath(); c.moveTo(0, y);
    for (let x = 0; x <= TILE; x += 16) c.lineTo(x, y + Math.sin(x / 40 + k) * 4);
    c.stroke();
    h.strokeStyle = `rgba(0,0,0,${0.2 + r() * 0.3})`;
    h.lineWidth = 1;
    h.beginPath(); h.moveTo(0, y); for (let x = 0; x <= TILE; x += 16) h.lineTo(x, y + Math.sin(x / 40 + k) * 4); h.stroke();
  }
  // knots
  for (let k = 0; k < 2; k++) { const x = r() * TILE, y = r() * TILE; c.fillStyle = 'rgba(60,30,10,0.6)'; c.beginPath(); c.ellipse(x, y, 10, 5, 0, 0, 7); c.fill(); }
  if (i % 3 === 2) { // chipped paint: reveal wood
    c.fillStyle = '#9a7048';
    for (let k = 0; k < 25; k++) { c.beginPath(); c.ellipse(r() * TILE, r() * TILE, 4 + r() * 18, 3 + r() * 8, r() * 3, 0, 7); c.fill(); }
  }
  grime(c, 0.5, '50,35,20');
  mat(m, 0.85, 0);
};

P.rust = (c, h, m, r, i) => {
  const kind = i % 4;
  const bases = ['#6b3a1e', '#3f5a3a', '#8d9094', '#a24d1d'];
  c.fillStyle = bases[kind];
  c.fillRect(0, 0, TILE, TILE);
  m.fillStyle = kind === 2 ? 'rgb(0,110,210)' : kind === 1 ? 'rgb(0,150,60)' : 'rgb(0,200,90)';
  m.fillRect(0, 0, TILE, TILE);
  h.fillStyle = '#7a7a7a';
  h.fillRect(0, 0, TILE, TILE);
  for (let k = 0; k < 120; k++) {
    const x = r() * TILE, y = r() * TILE, rad = 3 + r() * 26;
    const g = c.createRadialGradient(x, y, 0, x, y, rad);
    const col = r() < 0.5 ? '150,70,25' : '90,40,15';
    g.addColorStop(0, `rgba(${col},${kind === 2 ? 0.35 : 0.75})`);
    g.addColorStop(1, `rgba(${col},0)`);
    c.fillStyle = g;
    c.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    m.fillStyle = 'rgba(0,235,20,0.6)';
    m.beginPath(); m.arc(x, y, rad * 0.6, 0, 7); m.fill();
    h.fillStyle = `rgba(${r() < 0.5 ? 255 : 0},${r() < 0.5 ? 255 : 0},${r() < 0.5 ? 255 : 0},0.15)`;
    h.beginPath(); h.arc(x, y, rad * 0.7, 0, 7); h.fill();
  }
  if (kind === 2) for (let k = 0; k < 30; k++) { c.fillStyle = `rgba(230,235,240,${0.15 + r() * 0.2})`; c.beginPath(); c.arc(r() * TILE, r() * TILE, 4 + r() * 16, 0, 7); c.fill(); }
  speckle(c, 0.25);
  heightNoise(h, 0.4);
};

P.bag = (c, h, m, r, i) => {
  c.fillStyle = i ? '#1a1b1d' : '#ecebe6';
  c.fillRect(0, 0, TILE, TILE);
  if (!i) {
    c.fillStyle = '#2a7fd0';
    text(c, 'THANK YOU', 128, 110, '900 30px Arial Black, Arial', '#c62828', 'center');
    text(c, 'FOR SHOPPING', 128, 145, '700 20px Arial', '#c62828', 'center');
  }
  h.fillStyle = '#808080';
  h.fillRect(0, 0, TILE, TILE);
  for (let k = 0; k < 90; k++) {
    const x = r() * TILE, y = r() * TILE, a = r() * Math.PI, len = 20 + r() * 80;
    h.strokeStyle = r() < 0.5 ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';
    h.lineWidth = 1 + r() * 2;
    h.beginPath(); h.moveTo(x, y); h.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); h.stroke();
    c.strokeStyle = i ? 'rgba(120,120,130,0.18)' : 'rgba(255,255,255,0.35)';
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); c.stroke();
  }
  grime(c, i ? 0.15 : 0.35);
  mat(m, i ? 0.35 : 0.45, 0);
};

P.plastic = (c, h, m) => {
  c.fillStyle = '#f2f2f2';
  c.fillRect(0, 0, TILE, TILE);
  grime(c, 0.2, '80,70,60');
  h.fillStyle = '#808080';
  h.fillRect(0, 0, TILE, TILE);
  heightNoise(h, 0.1);
  mat(m, 0.38, 0);
};

P.bottle = (c, h, m, r, i) => {
  // clear plastic body (instance colour tints it) with a printed label band in the middle
  c.fillStyle = '#e8eef0';
  c.fillRect(0, 0, TILE, TILE);
  const labels = [['#d32f2f', 'SODA'], ['#0277bd', 'SPRING'], ['#2e7d32', 'FRESH']];
  const [lc, lw] = labels[i % labels.length];
  c.fillStyle = lc;
  c.fillRect(0, 100, TILE, 70);
  text(c, lw, 128, 135, '900 34px Arial Black, Arial', '#fff', 'center');
  m.fillStyle = 'rgb(0,30,0)';
  m.fillRect(0, 0, TILE, TILE);
  m.fillStyle = 'rgb(0,140,0)';
  m.fillRect(0, 100, TILE, 70);
  h.fillStyle = '#808080';
  h.fillRect(0, 0, TILE, TILE);
  for (let y = 10; y < 90; y += 12) { h.fillStyle = 'rgba(255,255,255,0.4)'; h.fillRect(0, y, TILE, 4); }
  grime(c, 0.2);
};

P.rubber = (c, h, m) => {
  c.fillStyle = '#1b1b1c';
  c.fillRect(0, 0, TILE, TILE);
  h.fillStyle = '#404040';
  h.fillRect(0, 0, TILE, TILE);
  // tread blocks in the middle band (v 0.3..0.7)
  for (let x = 0; x < TILE; x += 22) {
    for (const y of [80, 120, 160]) { h.fillStyle = '#e0e0e0'; h.fillRect(x + ((y / 40) % 2) * 8, y, 16, 32); }
  }
  c.save();
  c.globalAlpha = 0.5;
  c.fillStyle = '#2a2a2b';
  text(c, 'ALL SEASON 205/55 R16', 128, 30, '700 16px Arial', '#333', 'center');
  c.restore();
  grime(c, 0.4, '70,60,50');
  mat(m, 0.85, 0);
};

P.glass = (c, h, m, r, i) => {
  c.fillStyle = ['#3d6b3a', '#6b3f1c', '#c9d6d2'][i % 3];
  c.fillRect(0, 0, TILE, TILE);
  grime(c, 0.25);
  h.fillStyle = '#808080';
  h.fillRect(0, 0, TILE, TILE);
  mat(m, 0.06, 0);
  m.fillStyle = 'rgba(0,140,0,0.5)';
  for (let k = 0; k < 20; k++) m.fillRect(r() * TILE, r() * TILE, 30, 20);
};

P.ceramic = (c, h, m, r) => {
  c.fillStyle = '#efece4';
  c.fillRect(0, 0, TILE, TILE);
  c.fillStyle = '#2f5aa0';
  for (let k = 0; k < 6; k++) { c.beginPath(); c.arc(40 + k * 36, 128, 10, 0, 7); c.fill(); }
  c.fillRect(0, 60, TILE, 6);
  grime(c, 0.25);
  h.fillStyle = '#808080';
  h.fillRect(0, 0, TILE, TILE);
  mat(m, 0.18, 0);
  void r;
};

P.aluminium = (c, h, m, r) => {
  c.fillStyle = '#b7bbbf';
  c.fillRect(0, 0, TILE, TILE);
  for (let y = 0; y < TILE; y++) { c.fillStyle = `rgba(${r() < 0.5 ? 255 : 60},${r() < 0.5 ? 255 : 60},${r() < 0.5 ? 255 : 60},0.06)`; c.fillRect(0, y, TILE, 1); }
  c.fillStyle = 'rgba(30,25,20,0.8)';
  c.beginPath(); c.ellipse(128, 128, 70, 60, 0, 0, 7); c.fill(); // burnt base
  grime(c, 0.35);
  h.fillStyle = '#808080';
  h.fillRect(0, 0, TILE, TILE);
  heightNoise(h, 0.2);
  mat(m, 0.32, 1);
  m.fillStyle = 'rgb(0,200,80)';
  m.beginPath(); m.ellipse(128, 128, 70, 60, 0, 0, 7); m.fill();
};

P.terracotta = (c, h, m, r) => {
  c.fillStyle = '#b35f37';
  c.fillRect(0, 0, TILE, TILE);
  // painted band pattern
  c.fillStyle = '#2b1a12';
  c.fillRect(0, 96, TILE, 10);
  c.fillRect(0, 150, TILE, 6);
  for (let x = 0; x < TILE; x += 24) { c.beginPath(); c.moveTo(x, 106); c.lineTo(x + 12, 140); c.lineTo(x + 24, 106); c.fill(); }
  speckle(c, 0.3);
  grime(c, 0.55, '60,40,25');
  h.fillStyle = '#808080';
  h.fillRect(0, 0, TILE, TILE);
  heightNoise(h, 0.5);
  mat(m, 0.9, 0);
  void r;
};

P.stone = (c, h, m, r, i) => {
  c.fillStyle = i ? '#8f8a80' : '#a39a88';
  c.fillRect(0, 0, TILE, TILE);
  c.save();
  c.globalAlpha = 0.6;
  c.drawImage(noiseTile(), 0, 0);
  c.restore();
  speckle(c, 0.4);
  for (let k = 0; k < 30; k++) { c.fillStyle = `rgba(${r() < 0.5 ? '60,55,50' : '200,195,185'},0.3)`; c.beginPath(); c.arc(r() * TILE, r() * TILE, 1 + r() * 5, 0, 7); c.fill(); }
  grime(c, 0.35, '80,70,55');
  h.fillStyle = '#808080';
  h.fillRect(0, 0, TILE, TILE);
  heightNoise(h, 0.9);
  speckle(h, 0.3, 'source-over');
  mat(m, 0.92, 0);
};

P.monitor = (c, h, m, r) => {
  // top half: beige/grey casing, bottom half: dark glass screen
  c.fillStyle = '#c8c2b0';
  c.fillRect(0, 0, TILE, TILE / 2);
  for (let x = 20; x < TILE - 20; x += 8) { c.fillStyle = '#3a3833'; c.fillRect(x, 40, 4, 40); }
  const g = c.createLinearGradient(0, TILE / 2, TILE, TILE);
  g.addColorStop(0, '#1b2224');
  g.addColorStop(1, '#0a0d0e');
  c.fillStyle = g;
  c.fillRect(0, TILE / 2, TILE, TILE / 2);
  c.fillStyle = 'rgba(255,255,255,0.08)';
  c.fillRect(30, TILE / 2 + 20, 60, 90);
  grime(c, 0.35);
  h.fillStyle = '#808080';
  h.fillRect(0, 0, TILE, TILE);
  mat(m, 0.5, 0);
  m.fillStyle = 'rgb(0,30,0)';
  m.fillRect(0, TILE / 2, TILE, TILE / 2);
  void r;
};

P.keyboard = (c, h, m, r) => {
  c.fillStyle = '#d6d0bf';
  c.fillRect(0, 0, TILE, TILE);
  h.fillStyle = '#505050';
  h.fillRect(0, 0, TILE, TILE);
  for (let y = 16; y < TILE - 16; y += 24) for (let x = 10; x < TILE - 20; x += 24) {
    if (r() < 0.06) continue; // missing key
    c.fillStyle = '#ebe6d6'; c.fillRect(x, y, 20, 20);
    c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(x, y + 17, 20, 3);
    h.fillStyle = '#ffffff'; h.fillRect(x + 1, y + 1, 18, 18);
    text(c, String.fromCharCode(65 + Math.floor(r() * 26)), x + 10, y + 10, '600 10px Arial', '#555', 'center');
  }
  grime(c, 0.4);
  mat(m, 0.55, 0);
};

P.appliance = (c, h, m) => {
  c.fillStyle = '#e9e9e4';
  c.fillRect(0, 0, TILE, TILE);
  c.fillStyle = '#9aa0a5';
  c.fillRect(200, 40, 10, 120);
  grime(c, 0.45, '120,80,40');
  h.fillStyle = '#808080';
  h.fillRect(0, 0, TILE, TILE);
  heightNoise(h, 0.15);
  mat(m, 0.3, 0.1);
};

P.foam = (c, h, m) => {
  c.fillStyle = '#e7c75b';
  c.fillRect(0, 0, TILE, TILE);
  speckle(c, 0.5);
  grime(c, 0.4);
  h.fillStyle = '#808080';
  h.fillRect(0, 0, TILE, TILE);
  speckle(h, 0.7, 'source-over');
  mat(m, 1, 0);
};

// Tile layout: name → list of tile indices
const LAYOUT = [
  ['cardboard', 2, (c, h, m, r, i) => P.cardboard(c, h, m, r, i === 1)],
  ['newsprint', 3, P.newsprint],
  ['can', 6, P.can],
  ['packaging', 6, P.packaging],
  ['pcb', 2, P.pcb],
  ['fabric', 6, P.fabric],
  ['wood', 3, P.wood],
  ['rust', 4, P.rust],
  ['bag', 2, P.bag],
  ['plastic', 1, P.plastic],
  ['bottle', 3, P.bottle],
  ['rubber', 1, P.rubber],
  ['glass', 3, P.glass],
  ['ceramic', 1, P.ceramic],
  ['aluminium', 1, P.aluminium],
  ['terracotta', 1, P.terracotta],
  ['stone', 2, P.stone],
  ['monitor', 1, P.monitor],
  ['keyboard', 1, P.keyboard],
  ['appliance', 1, P.appliance],
  ['foam', 1, P.foam],
];

export function heightToNormal(src, strength) {
  const w = src.width, hgt = src.height;
  const d = src.getContext('2d').getImageData(0, 0, w, hgt).data;
  const out = canvas(w, hgt);
  const ctx = out.getContext('2d');
  const img = ctx.createImageData(w, hgt);
  const o = img.data;
  for (let y = 0; y < hgt; y++) {
    const ym = y > 0 ? y - 1 : y, yp = y < hgt - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : x, xp = x < w - 1 ? x + 1 : x;
      const nx = (d[(y * w + xm) * 4] - d[(y * w + xp) * 4]) / 255 * strength;
      const ny = (d[(yp * w + x) * 4] - d[(ym * w + x) * 4]) / 255 * strength;
      const l = Math.sqrt(nx * nx + ny * ny + 1);
      const i = (y * w + x) * 4;
      o[i] = (nx / l * 0.5 + 0.5) * 255;
      o[i + 1] = (ny / l * 0.5 + 0.5) * 255;
      o[i + 2] = (1 / l * 0.5 + 0.5) * 255;
      o[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

let ATLAS = null;
export function getAtlas() {
  if (ATLAS) return ATLAS;
  const col = canvas(ATLAS_SIZE), hgt = canvas(ATLAS_SIZE), rm = canvas(ATLAS_SIZE);
  const cc = col.getContext('2d'), hc = hgt.getContext('2d'), mc = rm.getContext('2d');
  hc.fillStyle = '#808080';
  hc.fillRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
  const tiles = {};
  let slot = 0;
  const r = mulberry(1234);
  for (const [name, n, painter] of LAYOUT) {
    tiles[name] = [];
    for (let i = 0; i < n; i++) {
      const tx = (slot % PER_ROW) * TILE, ty = Math.floor(slot / PER_ROW) * TILE;
      for (const ctx of [cc, hc, mc]) { ctx.save(); ctx.translate(tx, ty); ctx.beginPath(); ctx.rect(0, 0, TILE, TILE); ctx.clip(); }
      painter(cc, hc, mc, r, i);
      for (const ctx of [cc, hc, mc]) ctx.restore();
      tiles[name].push(slot);
      slot++;
    }
  }
  const mk = (cv, srgb) => {
    const t = new THREE.CanvasTexture(cv);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    return t;
  };
  ATLAS = {
    map: mk(col, true),
    normalMap: mk(heightToNormal(hgt, 3.2), false),
    roughMetal: mk(rm, false),
    tiles,
    // uv rectangle for a tile slot: [u0, v0, u1, v1] in texture space (v up)
    rect(slot) {
      const x = (slot % PER_ROW) * TILE + PAD, y = Math.floor(slot / PER_ROW) * TILE + PAD, s = TILE - PAD * 2;
      return [x / ATLAS_SIZE, 1 - (y + s) / ATLAS_SIZE, (x + s) / ATLAS_SIZE, 1 - y / ATLAS_SIZE];
    },
    tile(name, i = 0) { const l = tiles[name]; return l[i % l.length]; },
  };
  return ATLAS;
}

// A single atlas tile copied into its own repeating texture (for large surfaces).
export function tileTexture(name, i = 0, repeat = [1, 1]) {
  const A = getAtlas();
  const slot = A.tile(name, i);
  const c = canvas(TILE - PAD * 2), ctx = c.getContext('2d');
  const x = (slot % PER_ROW) * TILE + PAD, y = Math.floor(slot / PER_ROW) * TILE + PAD;
  ctx.drawImage(A.map.image, x, y, TILE - PAD * 2, TILE - PAD * 2, 0, 0, c.width, c.height);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = 8;
  return t;
}

// Corrugated sheet metal for huts: ribs, rust streaks and paint.
export function corrugatedTexture(base = '#7d8a8f', repeat = [4, 2]) {
  const W = 256, c = canvas(W), x = c.getContext('2d');
  x.fillStyle = base;
  x.fillRect(0, 0, W, W);
  for (let i = 0; i < W; i += 16) {
    const g = x.createLinearGradient(i, 0, i + 16, 0);
    g.addColorStop(0, 'rgba(0,0,0,0.28)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.18)');
    g.addColorStop(1, 'rgba(0,0,0,0.28)');
    x.fillStyle = g;
    x.fillRect(i, 0, 16, W);
  }
  const r = mulberry(31);
  for (let k = 0; k < 26; k++) {
    const sx = r() * W, len = 30 + r() * 140;
    const g = x.createLinearGradient(0, 0, 0, len);
    g.addColorStop(0, 'rgba(120,55,20,0.55)');
    g.addColorStop(1, 'rgba(120,55,20,0)');
    x.fillStyle = g;
    x.fillRect(sx, 0, 3 + r() * 6, len);
  }
  x.globalCompositeOperation = 'multiply';
  x.globalAlpha = 0.35;
  x.drawImage(noiseTile(), 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = 8;
  return t;
}

// Bright photo-studio environment: makes metals read clearly in thumbnails and at the refinery.
export function studioEnvScene() {
  const s = new THREE.Scene();
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'varying vec3 vP; void main(){ float h = vP.y; vec3 c = mix(vec3(0.03,0.025,0.02), vec3(0.22,0.2,0.18), smoothstep(-0.4, 0.2, h)); c = mix(c, vec3(0.55,0.52,0.48), smoothstep(0.35, 1.0, h)); gl_FragColor = vec4(c, 1.0); }',
  });
  s.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), mat));
  const panel = (w, h, x, y, z, k) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(k, k * 0.95, k * 0.88), side: THREE.DoubleSide })); m.position.set(x, y, z); m.lookAt(0, 0, 0); s.add(m); };
  panel(5, 2.2, 0, 7, 2, 3.2);
  panel(0.8, 5, 6, 2, 3, 2.6);
  panel(0.6, 5, -6, 1.5, -2, 1.8);
  panel(8, 0.5, 0, 0.6, -7, 1.2);
  return s;
}

// ---- Ground and environment textures -------------------------------------------------
export function groundTextures(kind) {
  const S = 512, col = canvas(S), hgt = canvas(S);
  const c = col.getContext('2d'), h = hgt.getContext('2d');
  const r = mulberry(kind.length * 77 + 5);
  const pal = {
    dump: ['#5b4a37', '#6b5a43', '#3f3326'],
    scrapyard: ['#5e5751', '#6f6760', '#3d3833'],
    facility: ['#6e6d69', '#7b7a76', '#4e4d4a'],
    landfill: ['#4c4236', '#5a4e3e', '#2f281f'],
    forgotten: ['#a0805a', '#b39268', '#6e5537'],
  }[kind];
  const img = c.createImageData(S, S), himg = h.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    // tileable fbm by sampling on a torus-like wrap
    const u = x / S, v = y / S;
    const n = fbm2(Math.cos(u * 6.283) * 2 + 10, Math.sin(u * 6.283) * 2 + Math.cos(v * 6.283) * 2, 7, 5) * 0.5 + fbm2(Math.sin(v * 6.283) * 3, u * 0 + 4, 9, 3) * 0.5;
    const t = THREE.MathUtils.clamp(n * 0.9 + 0.5, 0, 1);
    const a = new THREE.Color(pal[0]), b = new THREE.Color(pal[1]), d = new THREE.Color(pal[2]);
    const cc = t < 0.5 ? d.lerp(a, t * 2) : a.lerp(b, (t - 0.5) * 2);
    const i = (y * S + x) * 4;
    const g = (r() - 0.5) * 18;
    img.data[i] = cc.r * 255 + g; img.data[i + 1] = cc.g * 255 + g; img.data[i + 2] = cc.b * 255 + g; img.data[i + 3] = 255;
    const hv = t * 200 + r() * 55;
    himg.data[i] = himg.data[i + 1] = himg.data[i + 2] = hv; himg.data[i + 3] = 255;
  }
  c.putImageData(img, 0, 0);
  h.putImageData(himg, 0, 0);
  // pebbles / debris specks
  for (let k = 0; k < (kind === 'facility' ? 30 : 700); k++) {
    const x = r() * S, y = r() * S, rad = 0.6 + r() * (kind === 'scrapyard' ? 2.6 : 1.6);
    const l = 70 + r() * 60;
    c.fillStyle = `rgba(${l},${l * 0.95},${l * 0.85},0.55)`;
    c.beginPath(); c.arc(x, y, rad, 0, 7); c.fill();
    h.fillStyle = '#fff';
    h.beginPath(); h.arc(x, y, rad, 0, 7); h.fill();
  }
  if (kind === 'facility') { // concrete joints and oil stains
    c.strokeStyle = 'rgba(40,40,40,0.5)'; c.lineWidth = 3; c.strokeRect(1, 1, S - 2, S - 2);
    for (let k = 0; k < 5; k++) { const g = c.createRadialGradient(r() * S, r() * S, 2, r() * S, r() * S, 60); g.addColorStop(0, 'rgba(20,18,15,0.5)'); g.addColorStop(1, 'rgba(20,18,15,0)'); c.fillStyle = g; c.fillRect(0, 0, S, S); }
  }
  const map = new THREE.CanvasTexture(col);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 8;
  const normal = new THREE.CanvasTexture(heightToNormal(hgt, 2.2));
  normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
  return { map, normal };
}

export function fenceTexture() {
  const S = 128, c = canvas(S), ctx = c.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  ctx.strokeStyle = '#c8ccd0';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(S, S);
  ctx.moveTo(S, 0); ctx.lineTo(0, S);
  ctx.stroke();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function signTexture(lines, { bg = '#1c1d1f', fg = '#f2c14e', w = 1024, h = 256, font = 'Saira Stencil One' } = {}) {
  const c = canvas(w, h), ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = fg;
  ctx.lineWidth = 10;
  ctx.strokeRect(14, 14, w - 28, h - 28);
  const size = h / (lines.length + 0.6);
  lines.forEach((l, i) => text(ctx, l, w / 2, h / 2 + (i - (lines.length - 1) / 2) * size * 0.95, `400 ${Math.round(size * (i === 0 ? 0.78 : 0.42))}px "${font}", Impact, sans-serif`, i === 0 ? fg : '#e8e4da', 'center'));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function glintTexture() {
  const S = 64, c = canvas(S), ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.15, 'rgba(255,240,200,0.7)');
  g.addColorStop(1, 'rgba(255,220,150,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  ctx.strokeStyle = 'rgba(255,250,235,0.9)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(S / 2, 2); ctx.lineTo(S / 2, S - 2);
  ctx.moveTo(2, S / 2); ctx.lineTo(S - 2, S / 2);
  ctx.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function softDot() {
  const S = 64, c = canvas(S), ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(c);
}
