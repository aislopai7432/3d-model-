// Contour designer: build a 2D contour from straight lines and arcs (with RND/CHR corners), preview
// it, and generate either a label-delimited contour for CYCLE72 or a direct G41/G42 milling path.
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f = (v) => {
  const n = Math.round(v * 1000) / 1000;
  return Object.is(n, -0) ? '0' : String(n);
};

export function defaultContour() {
  return {
    name: 'CONT',
    start: { x: -30, y: -20 },
    els: [
      { t: 'L', x: 30, y: -20, rnd: 5 },
      { t: 'L', x: 30, y: 10, rnd: 0 },
      { t: 'CCW', x: 10, y: 20, r: 20 },
      { t: 'L', x: -30, y: 20, chr: 4 },
      { t: 'L', x: -30, y: -20 },
    ],
    depth: -3, side: 42, closed: true,
  };
}

// arc centre from start, end, radius (CR>0: short arc) and direction
function arcCenter(s, e, r, cw) {
  const dx = e.x - s.x, dy = e.y - s.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-9 || d > 2 * Math.abs(r) + 1e-6) return null;
  const h = Math.sqrt(Math.max(0, r * r - (d / 2) ** 2));
  const sg = (cw ? 1 : -1) * (r > 0 ? 1 : -1);
  return { x: (s.x + e.x) / 2 + (sg * h * dy) / d, y: (s.y + e.y) / 2 - (sg * h * dx) / d };
}

export function contourPoints(c) {
  const pts = [{ ...c.start }];
  const errs = [];
  let p = c.start;
  c.els.forEach((el, i) => {
    const e = { x: +el.x, y: +el.y };
    if (el.t === 'L') pts.push(e);
    else {
      const cw = el.t === 'CW';
      const cc = arcCenter(p, e, +el.r, cw);
      if (!cc) {
        errs.push(`Element ${i + 1}: radius ${el.r} too small for the chord`);
        pts.push(e);
      } else {
        const a0 = Math.atan2(p.y - cc.y, p.x - cc.x), a1 = Math.atan2(e.y - cc.y, e.x - cc.x);
        let sw = cw ? a0 - a1 : a1 - a0;
        while (sw <= 0) sw += Math.PI * 2;
        const R = Math.hypot(p.x - cc.x, p.y - cc.y);
        const n = Math.max(6, Math.ceil(sw / 0.1));
        for (let k = 1; k <= n; k++) {
          const a = a0 + (cw ? -1 : 1) * sw * (k / n);
          pts.push({ x: cc.x + R * Math.cos(a), y: cc.y + R * Math.sin(a) });
        }
      }
    }
    p = e;
  });
  return { pts, errs };
}

// G-code blocks of the contour (Siemens syntax), starting with the positioning block.
export function contourBlocks(c) {
  const out = [`G0 X${f(c.start.x)} Y${f(c.start.y)}`];
  for (const el of c.els) {
    let b = el.t === 'L' ? `G1 X${f(+el.x)} Y${f(+el.y)}` : `${el.t === 'CW' ? 'G2' : 'G3'} X${f(+el.x)} Y${f(+el.y)} CR=${f(+el.r)}`;
    if (el.t === 'L' && +el.rnd > 0) b += ` RND=${f(+el.rnd)}`;
    else if (el.t === 'L' && +el.chr > 0) b += ` CHR=${f(+el.chr)}`;
    out.push(b);
  }
  return out;
}

export function renderContourDesigner(c, toolR) {
  const { pts, errs } = contourPoints(c);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const pad = Math.max(10, toolR * 2 + 4);
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const w = maxX - minX, h = maxY - minY;
  const sc = Math.min(300 / w, 240 / h);
  const X = (x) => (x - minX) * sc + 5, Y = (y) => (maxY - y) * sc + 5;
  const poly = pts.map((p) => `${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
  const grid = [];
  const step = w > 120 ? 20 : 10;
  for (let gx = Math.ceil(minX / step) * step; gx <= maxX; gx += step) grid.push(`<line x1="${X(gx)}" y1="0" x2="${X(gx)}" y2="260" stroke="#eef1f4"/>`);
  for (let gy = Math.ceil(minY / step) * step; gy <= maxY; gy += step) grid.push(`<line x1="0" y1="${Y(gy)}" x2="320" y2="${Y(gy)}" stroke="#eef1f4"/>`);
  const arrows = [];
  for (let i = 1; i < pts.length; i += Math.max(1, Math.floor(pts.length / 10))) {
    const a = pts[i - 1], b = pts[i];
    const ang = (Math.atan2(-(b.y - a.y), b.x - a.x) * 180) / Math.PI;
    arrows.push(`<path d="M-4 -3 L3 0 L-4 3" transform="translate(${X((a.x + b.x) / 2)},${Y((a.y + b.y) / 2)}) rotate(${ang})" fill="none" stroke="#1d6bd0" stroke-width="1.4"/>`);
  }
  const svg = `<svg viewBox="0 0 320 260" xmlns="http://www.w3.org/2000/svg">${grid.join('')}
    <line x1="${X(0)}" y1="0" x2="${X(0)}" y2="260" stroke="#c9d1d9"/><line x1="0" y1="${Y(0)}" x2="320" y2="${Y(0)}" stroke="#c9d1d9"/>
    <polyline points="${poly}" fill="${c.closed ? 'rgba(29,107,208,.08)' : 'none'}" stroke="#22405b" stroke-width="2" stroke-linejoin="round"/>
    ${toolR > 0 ? `<polyline points="${poly}" fill="none" stroke="rgba(29,107,208,.25)" stroke-width="${Math.max(1, toolR * 2 * sc)}" stroke-linejoin="round" stroke-linecap="round"/>` : ''}
    ${arrows.join('')}<circle cx="${X(c.start.x)}" cy="${Y(c.start.y)}" r="4" fill="#c21d1d"/>
    <text x="${X(c.start.x) + 6}" y="${Y(c.start.y) - 6}" font-size="10" fill="#c21d1d" font-family="Arial">start</text></svg>`;
  const opt = (v, sel) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${{ L: 'Line G1', CW: 'Arc G2 (CW)', CCW: 'Arc G3 (CCW)' }[v]}</option>`;
  const rows = c.els.map((el, i) => `<tr data-i="${i}"><td>${i + 1}</td><td><select data-k="t">${['L', 'CW', 'CCW'].map((v) => opt(v, el.t)).join('')}</select></td>
    <td><input data-k="x" value="${esc(el.x)}"></td><td><input data-k="y" value="${esc(el.y)}"></td>
    <td>${el.t === 'L' ? `<input data-k="rnd" value="${esc(el.rnd ?? '')}" placeholder="RND">` : `<input data-k="r" value="${esc(el.r ?? '')}" placeholder="CR">`}</td>
    <td>${el.t === 'L' ? `<input data-k="chr" value="${esc(el.chr ?? '')}" placeholder="CHR">` : '<span>—</span>'}</td></tr>`).join('');
  return `<div class="hp"><div class="hbox"><div class="hbox-h">Contour designer<span class="r">${errs.length ? esc(errs[0]) : `${c.els.length} elements`}</span></div>
    <div class="hbox-b cd">
      <div>
        <div class="opts">
          <label>Name <input data-o="name" value="${esc(c.name)}"></label>
          <label>Start X <input data-o="sx" value="${esc(c.start.x)}"></label>
          <label>Start Y <input data-o="sy" value="${esc(c.start.y)}"></label>
          <label>Depth Z <input data-o="depth" value="${esc(c.depth)}"></label>
          <label>Side <select data-o="side"><option value="41" ${c.side === 41 ? 'selected' : ''}>G41 left</option><option value="42" ${c.side === 42 ? 'selected' : ''}>G42 right</option><option value="40" ${c.side === 40 ? 'selected' : ''}>G40 centre</option></select></label>
        </div>
        <div class="htable-wrap" style="margin-top:6px;max-height:190px"><table class="htable cd-table"><thead><tr><th>#</th><th>Element</th><th>X end</th><th>Y end</th><th>CR / RND</th><th>CHR</th></tr></thead><tbody>${rows}</tbody></table></div>
        <p class="hnote">RND / CHR round or chamfer the corner after a straight line (the next element must also be a line). Arcs use CR=; a negative CR gives the arc over 180°. For an outside contour climb-milled with M3, travel clockwise with G41.</p>
      </div>
      <div>${svg}<div class="preview hnote" style="margin-top:6px;white-space:pre;font-family:var(--f-mono);background:#fff;border:1px solid var(--h-line);padding:6px;max-height:110px;overflow:auto">${esc(contourBlocks(c).join('\n'))}</div></div>
    </div></div></div>`;
}

// Code to insert for the two output modes.
export function contourCycleCode(c) {
  const name = (c.name || 'CONT').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const b = contourBlocks(c);
  const def = [`; ---- CONTOUR ${name} (used by CYCLE72) ----`, `${name}_S: ${b[0]}`, ...b.slice(1, -1), `${name}_E: ${b[b.length - 1]}`];
  return { name, def, call: `CYCLE72("${name}_S:${name}_E",25,0,2,${f(+c.depth)},2,0.3,0,1200,400,111,${c.side},2,8,1200,2,8)` };
}

export function contourPathCode(c) {
  const b = contourBlocks(c);
  const s = c.start;
  const out = [`; ---- CONTOUR PATH ${c.side === 40 ? '(TOOL CENTRE)' : `WITH G${c.side}`} ----`, `G0 X${f(s.x)} Y${f(s.y - 15)}`, 'G0 Z2', `G1 Z${f(+c.depth)} F400`];
  if (c.side === 40) out.push(`G1 X${f(s.x)} Y${f(s.y)} F1200`);
  else out.push(`G${c.side} G1 X${f(s.x)} Y${f(s.y)} F1200`);
  out.push(...b.slice(1));
  if (c.side !== 40) out.push(`G40 G1 X${f(+c.els[c.els.length - 1].x)} Y${f(+c.els[c.els.length - 1].y - 15)}`);
  out.push('G0 Z25');
  return out;
}
