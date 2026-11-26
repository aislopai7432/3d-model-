// Procedural canvas textures for the manual lathe: graduated dial bands, swivel angle scale,
// quill scale, leadscrew thread stripes and a shared plate atlas (speed chart, feed/thread chart,
// warning labels...). Generic markings only, no brand names.
import * as THREE from 'three';

function cv(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
function mk(c, { repeat = false, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  return t;
}

// Dial band: 100 divisions around (u), numbers every 10, ascending clockwise when seen from the operator.
// Graduated cone dial (wraps a CylinderGeometry band that LatheModel.handwheel() rotates so u = 0 sits at the
// bottom and u grows counter-clockwise seen from the operator; the fixed index is at the top, u = 0.5).
// Graduation k sits k divisions counter-clockwise of the zero, so turning the wheel clockwise (advance)
// brings higher numbers under the index, exactly like the panel dials. Labels are drawn upright for an
// operator looking down on the top of the dial.
export function dialTexture(div = 100, labelEvery = 10, tickStep = 1) {
  const W = 2048, H = 128;
  const c = cv(W, H);
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, '#e6e9ec');
  grd.addColorStop(1, '#bfc4c9');
  g.fillStyle = grd;
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#15171a';
  g.strokeStyle = '#15171a';
  const X = (k) => ((((0.5 + k / div) % 1) + 1) % 1) * W;
  for (let k = 0; k < div; k += tickStep) {
    const x = X(k);
    const major = k % labelEvery === 0, mid = k % 5 === 0;
    g.lineWidth = major ? 5 : 3;
    g.beginPath();
    g.moveTo(x, H);
    g.lineTo(x, H - (major ? 58 : mid ? 42 : 28));
    g.stroke();
    if (major) {
      g.save();
      g.translate(x, 34);
      g.rotate(Math.PI);
      g.font = '700 40px Arial, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(k), 0, 0);
      g.restore();
    }
  }
  g.fillStyle = '#b02222';
  g.fillRect(X(0) - 3, H - 64, 6, 64); // the dial's zero line (red)
  return mk(c, { repeat: true });
}

// Thread-dial face (seen from above): N numbered marks; mark m sits (m-1)/N of a turn from the bottom of
// the canvas (the operator side, where the fixed index is), going toward the canvas right.
export function threadDialTexture(N = 4) {
  const S = 256, c = cv(S, S), g = c.getContext('2d'), m = S / 2;
  g.fillStyle = '#c9ced3';
  g.beginPath(); g.arc(m, m, m - 2, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#e9ecef';
  g.beginPath(); g.arc(m, m, m - 16, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#15171a'; g.fillStyle = '#15171a';
  g.font = '700 40px Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let k = 0; k < N; k++) {
    const t = (k / N) * Math.PI * 2, sx = Math.sin(t), sy = Math.cos(t);
    g.lineWidth = 7;
    g.beginPath(); g.moveTo(m + sx * (m - 4), m + sy * (m - 4)); g.lineTo(m + sx * (m - 34), m + sy * (m - 34)); g.stroke();
    g.fillText(String(k + 1), m + sx * (m - 64), m + sy * (m - 64));
  }
  g.fillStyle = '#2a2f34';
  g.beginPath(); g.arc(m, m, 18, 0, Math.PI * 2); g.fill();
  return mk(c);
}

// Swivel scale: ring on a square canvas, 0 at the bottom (toward the operator), +angle to the right.
export function angleRingTexture() {
  const S = 512;
  const c = cv(S, S);
  const g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  const R = S / 2;
  g.fillStyle = '#c9cdd1';
  g.beginPath();
  g.arc(R, R, R - 2, 0, Math.PI * 2);
  g.arc(R, R, R * 0.70, 0, Math.PI * 2, true);
  g.fill('evenodd');
  g.strokeStyle = '#111';
  g.fillStyle = '#111';
  for (let a = -180; a < 180; a += 5) {
    const th = (a * Math.PI) / 180; // 0 at bottom, positive to the right (canvas +x)
    const dx = Math.sin(th), dy = Math.cos(th);
    const major = a % 10 === 0;
    const r0 = R - 4, r1 = R - (major ? 38 : 24);
    g.lineWidth = major ? 3 : 2;
    g.beginPath();
    g.moveTo(R + dx * r0, R + dy * r0);
    g.lineTo(R + dx * r1, R + dy * r1);
    g.stroke();
    if (a % 30 === 0 && Math.abs(a) <= 90) {
      const rt = R - 62;
      g.save();
      g.translate(R + dx * rt, R + dy * rt);
      g.font = '700 24px Arial, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(Math.abs(a)), 0, 0);
      g.restore();
    }
  }
  const t = mk(c);
  return t;
}

// Quill scale along the length (v): millimetre ticks, numbers every 10 mm. 180 mm per texture.
export function quillScaleTexture(len = 180) {
  const W = 256, H = 1024;
  const c = cv(W, H);
  const g = c.getContext('2d');
  g.fillStyle = '#a9b0b6';
  g.fillRect(0, 0, W, H);
  // brushed
  for (let i = 0; i < 400; i++) {
    g.fillStyle = `rgba(${i % 2 ? 255 : 80},${i % 2 ? 255 : 85},${i % 2 ? 255 : 90},0.05)`;
    g.fillRect(Math.random() * W, 0, 1, H);
  }
  g.fillStyle = '#111';
  const px = H / len;
  for (let mm = 0; mm <= len; mm++) {
    // v runs bottom (0) to top (H) of the canvas -> after flipY, canvas y = H - v
    const y = H - mm * px;
    const major = mm % 10 === 0, mid = mm % 5 === 0;
    g.fillRect(0, y - 1, major ? 90 : mid ? 60 : 36, major ? 3 : 2);
    if (major && mm > 0) {
      g.font = '700 26px Arial, sans-serif';
      g.textBaseline = 'middle';
      g.fillText(String(mm), 100, y);
    }
  }
  return mk(c, { repeat: true });
}

// Leadscrew / feed rod: diagonal stripes that visibly swirl when the rod turns.
export function leadscrewTexture() {
  const c = cv(64, 64);
  const g = c.getContext('2d');
  g.fillStyle = '#7d848a';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#c9ced2';
  g.beginPath();
  g.moveTo(0, 0); g.lineTo(32, 0); g.lineTo(64, 32); g.lineTo(64, 64);
  g.lineTo(32, 64); g.lineTo(0, 32); g.closePath();
  g.fill();
  g.fillStyle = '#4a5055';
  g.fillRect(0, 0, 64, 6);
  return mk(c, { repeat: true });
}

export function keywayTexture() {
  const c = cv(32, 32);
  const g = c.getContext('2d');
  g.fillStyle = '#b8bec3';
  g.fillRect(0, 0, 32, 32);
  g.fillStyle = '#3d4247';
  g.fillRect(0, 0, 5, 32); // keyway line along the rod
  return mk(c, { repeat: true });
}

// ----- plate atlas -----
const ATLAS = { w: 2048, h: 1024 };
const RECTS = {
  speeds: [0, 0, 700, 380],
  gearbox: [720, 0, 1500, 460],
  warnRotate: [0, 400, 256, 656],
  warnGlasses: [270, 400, 526, 656],
  warnChips: [540, 400, 796, 656],
  fwdStopRev: [820, 400, 1020, 680],
  serial: [1040, 400, 1540, 640],
  estop: [1560, 400, 1820, 660],
  range: [0, 700, 300, 860],
  feeddir: [320, 700, 620, 860],
  coolant: [640, 700, 940, 860],
  quill: [960, 700, 1360, 820],
  halfnut: [1380, 700, 1680, 860],
  cross: [1700, 700, 2040, 860],
};

function plateBase(g, r, bg = '#d9dcde', border = '#25292d') {
  const [x0, y0, x1, y1] = r;
  g.fillStyle = bg;
  g.fillRect(x0, y0, x1 - x0, y1 - y0);
  g.strokeStyle = border;
  g.lineWidth = 6;
  g.strokeRect(x0 + 5, y0 + 5, x1 - x0 - 10, y1 - y0 - 10);
}
function txt(g, s, x, y, size, { w = 700, color = '#14171a', align = 'center', font = 'Arial, sans-serif' } = {}) {
  g.fillStyle = color;
  g.font = `${w} ${size}px ${font}`;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillText(s, x, y);
}

export function plateAtlas() {
  const c = cv(ATLAS.w, ATLAS.h);
  const g = c.getContext('2d');
  g.fillStyle = '#888';
  g.fillRect(0, 0, ATLAS.w, ATLAS.h);

  // headstock spindle speed chart (2 ranges x 6 positions)
  {
    const r = RECTS.speeds;
    plateBase(g, r);
    txt(g, 'SPINDLE SPEEDS  rpm', r[0] + 350, r[1] + 40, 34);
    const lo = [40, 63, 100, 160, 250, 400], hi = [125, 200, 320, 500, 800, 1250];
    const sp = [40, 63, 100, 160, 250, 400, 125, 200, 320, 500, 800, 2000];
    void sp;
    g.strokeStyle = '#25292d';
    g.lineWidth = 3;
    for (let i = 0; i < 6; i++) {
      const x = r[0] + 60 + i * 110;
      txt(g, String(i + 1), x, r[1] + 95, 30);
      txt(g, String(lo[i]), x, r[1] + 170, 38, { w: 600 });
      txt(g, String(hi[i] === 1250 ? 2000 : hi[i]), x, r[1] + 270, 38, { w: 600 });
    }
    txt(g, 'LOW', r[0] + 38, r[1] + 215, 26, { color: '#7a1010' });
    g.beginPath(); g.moveTo(r[0] + 12, r[1] + 120); g.lineTo(r[2] - 12, r[1] + 120); g.moveTo(r[0] + 12, r[1] + 215 + 0); g.lineTo(r[2] - 12, r[1] + 215); g.moveTo(r[0] + 12, r[1] + 232); g.lineTo(r[2] - 12, r[1] + 232); g.stroke();
    txt(g, 'HIGH', r[0] + 46, r[1] + 320, 26, { color: '#7a1010' });
  }
  // quick-change gearbox chart: feeds and threads
  {
    const r = RECTS.gearbox;
    plateBase(g, r);
    txt(g, 'FEEDS  mm/rev      THREADS  pitch mm', r[0] + 390, r[1] + 36, 30);
    g.strokeStyle = '#25292d';
    g.lineWidth = 2;
    const cols = ['A', 'B', 'C', 'D', 'E'];
    const feeds = [0.04, 0.06, 0.08, 0.12, 0.16, 0.24, 0.32, 0.48];
    const pitches = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5];
    for (let j = 0; j < 4; j++) txt(g, cols[j], r[0] + 70 + j * 90, r[1] + 80, 28, { color: '#7a1010' });
    for (let j = 0; j < 4; j++) txt(g, cols[j], r[0] + 440 + j * 90, r[1] + 80, 28, { color: '#7a1010' });
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 4; j++) {
        txt(g, feeds[i * 4 + j].toFixed(2), r[0] + 70 + j * 90, r[1] + 140 + i * 56, 28, { w: 600 });
        txt(g, pitches[i * 4 + j].toFixed(2), r[0] + 440 + j * 90, r[1] + 140 + i * 56, 28, { w: 600 });
      }
    }
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 4; j++) {
        txt(g, (0.04 + (i + 2) * 0.1 + j * 0.02).toFixed(2), r[0] + 70 + j * 90, r[1] + 260 + i * 50, 28, { w: 600 });
        txt(g, (0.5 + (i + 2) * 0.5 + j * 0.25).toFixed(2), r[0] + 440 + j * 90, r[1] + 260 + i * 50, 28, { w: 600 });
      }
    }
    g.beginPath(); g.moveTo(r[0] + 410, r[1] + 55); g.lineTo(r[0] + 410, r[3] - 20); g.stroke();
    txt(g, 'LEVER 1 : A-D     LEVER 2 : I - II', r[0] + 390, r[3] - 30, 26);
  }
  // warning labels
  const warn = (r, draw, bg = '#f2c21b') => {
    const [x0, y0, x1, y1] = r;
    g.fillStyle = bg;
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
    g.strokeStyle = '#111';
    g.lineWidth = 8;
    g.strokeRect(x0 + 6, y0 + 6, x1 - x0 - 12, y1 - y0 - 12);
    draw((x0 + x1) / 2, (y0 + y1) / 2);
  };
  warn(RECTS.warnRotate, (cx, cy) => {
    g.fillStyle = '#111';
    g.beginPath(); g.moveTo(cx, cy - 90); g.lineTo(cx + 78, cy + 40); g.lineTo(cx - 78, cy + 40); g.closePath(); g.fill();
    g.fillStyle = '#f2c21b';
    g.fillRect(cx - 5, cy - 50, 10, 54); g.fillRect(cx - 5, cy + 14, 10, 10);
    txt(g, 'ROTATING', cx, cy + 84, 34); txt(g, 'PARTS', cx, cy + 116, 34);
  });
  warn(RECTS.warnGlasses, (cx, cy) => {
    g.fillStyle = '#1a4fa0';
    g.beginPath(); g.arc(cx, cy - 30, 60, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 8;
    g.beginPath(); g.arc(cx - 22, cy - 30, 16, 0, Math.PI * 2); g.arc(cx + 22, cy - 30, 16, 0, Math.PI * 2); g.moveTo(cx - 6, cy - 30); g.lineTo(cx + 6, cy - 30); g.stroke();
    txt(g, 'WEAR EYE', cx, cy + 62, 32); txt(g, 'PROTECTION', cx, cy + 96, 30);
  });
  warn(RECTS.warnChips, (cx, cy) => {
    g.fillStyle = '#111';
    g.beginPath(); g.moveTo(cx, cy - 90); g.lineTo(cx + 78, cy + 40); g.lineTo(cx - 78, cy + 40); g.closePath(); g.fill();
    g.fillStyle = '#f2c21b';
    g.font = '700 60px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('!', cx, cy - 6);
    txt(g, 'HOT SHARP', cx, cy + 84, 32); txt(g, 'CHIPS', cx, cy + 116, 32);
  });
  // apron spindle lever label
  {
    const r = RECTS.fwdStopRev;
    plateBase(g, r, '#202428', '#c9cdd1');
    const cx = (r[0] + r[2]) / 2;
    txt(g, 'FWD', cx, r[1] + 55, 44, { color: '#f0f2f4' });
    txt(g, 'STOP', cx, (r[1] + r[3]) / 2, 44, { color: '#f0f2f4' });
    txt(g, 'REV', cx, r[3] - 55, 44, { color: '#f0f2f4' });
    g.strokeStyle = '#f0f2f4'; g.lineWidth = 6;
    g.beginPath(); g.moveTo(cx, r[1] + 95); g.lineTo(cx, r[3] - 95); g.stroke();
  }
  // generic serial plate
  {
    const r = RECTS.serial;
    plateBase(g, r, '#b9bec3', '#25292d');
    const cx = (r[0] + r[2]) / 2;
    txt(g, 'ENGINE LATHE', cx, r[1] + 55, 52);
    txt(g, 'SWING 330 mm', cx, r[1] + 115, 34, { w: 600 });
    txt(g, 'BETWEEN CENTRES 1000 mm', cx, r[1] + 160, 34, { w: 600 });
    txt(g, 'No. 000417    400 V   3 ph   50 Hz', cx, r[1] + 205, 28, { w: 600 });
  }
  // emergency stop surround label
  {
    const r = RECTS.estop;
    g.fillStyle = '#f2c21b';
    g.fillRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
    const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
    g.strokeStyle = '#111'; g.lineWidth = 10;
    g.beginPath(); g.arc(cx, cy, 108, 0, Math.PI * 2); g.stroke();
    txt(g, 'EMERGENCY STOP', cx, r[3] - 22, 26);
  }
  // small labels
  for (const [k, lines] of [['range', ['LOW        HIGH', 'RANGE']], ['feeddir', ['FEED  ◀  ▶', 'DIRECTION']], ['coolant', ['COOLANT', 'OFF      ON']], ['quill', ['QUILL  mm   TRAVEL 100']], ['halfnut', ['HALF NUT', 'ENGAGE ▼']], ['cross', ['CROSS SLIDE 1 div = 0.02 mm dia']]]) {
    const r = RECTS[k];
    plateBase(g, r, '#d9dcde', '#25292d');
    const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
    if (lines.length === 1) txt(g, lines[0], cx, cy, k === 'cross' ? 22 : 30);
    else { txt(g, lines[0], cx, cy - 22, 34); txt(g, lines[1], cx, cy + 28, 34); }
  }
  const tex = mk(c, { aniso: 8 });
  return {
    texture: tex,
    // uv rect [u0, v0, u1, v1] for a named plate (canvas coordinates -> flipY texture coordinates)
    uv(name) {
      const [x0, y0, x1, y1] = RECTS[name];
      return [x0 / ATLAS.w, 1 - y1 / ATLAS.h, x1 / ATLAS.w, 1 - y0 / ATLAS.h];
    },
    size(name) {
      const [x0, y0, x1, y1] = RECTS[name];
      return [x1 - x0, y1 - y0];
    },
  };
}
