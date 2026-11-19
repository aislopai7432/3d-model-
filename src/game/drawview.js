// Pan / zoom viewer for an engineering drawing (inline SVG). Zoom works on the SVG viewBox, so the
// sheet stays crisp at every magnification. Mouse: wheel zoom at the cursor, drag to pan, double-click
// to zoom in. Touch: one finger pans, two fingers pinch-zoom.
const SHEET_W = 420, SHEET_H = 297;

export class DrawView {
  constructor(host) {
    this.host = host;
    host.classList.add('dv');
    this.stage = document.createElement('div');
    this.stage.className = 'dv-stage';
    host.appendChild(this.stage);
    this.svg = null;
    this.vb = { x: 0, y: 0, w: SHEET_W, h: SHEET_H };
    this.pointers = new Map();
    this._bind();
    this.ro = new ResizeObserver(() => this.apply());
    this.ro.observe(host);
  }

  setSVG(markup) {
    this.stage.innerHTML = markup;
    this.svg = this.stage.querySelector('svg');
    if (!this.svg) return;
    this.svg.removeAttribute('width');
    this.svg.removeAttribute('height');
    this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    this.fit();
  }

  clear() {
    this.stage.innerHTML = '';
    this.svg = null;
  }

  fit() {
    this.vb = { x: 0, y: 0, w: SHEET_W, h: SHEET_H };
    this.apply();
  }

  // pixels per sheet mm for the current view box (meet scaling)
  scale() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    return Math.min(w / this.vb.w, h / this.vb.h);
  }

  // sheet coordinates of a client point
  toSheet(cx, cy) {
    const r = this.host.getBoundingClientRect();
    const s = this.scale();
    const ox = (r.width - this.vb.w * s) / 2, oy = (r.height - this.vb.h * s) / 2;
    return { x: this.vb.x + (cx - r.left - ox) / s, y: this.vb.y + (cy - r.top - oy) / s };
  }

  // Frame a sheet region { x, y, w, h } (mm) with a margin (fraction of the region size).
  zoomTo(box, margin = 0.3) {
    const aspect = SHEET_H / SHEET_W;
    let w = box.w * (1 + 2 * margin), h = box.h * (1 + 2 * margin);
    if (h / w > aspect) w = h / aspect; else h = w * aspect;
    w = Math.max(SHEET_W / 3.2, Math.min(SHEET_W, w)); // keep some context around small regions
    h = w * aspect;
    this.vb = { x: box.x + box.w / 2 - w / 2, y: box.y + box.h / 2 - h / 2, w, h };
    this.clamp();
    this.apply();
  }

  zoomAt(f, cx, cy) {
    const r = this.host.getBoundingClientRect();
    if (cx == null) { cx = r.left + r.width / 2; cy = r.top + r.height / 2; }
    const p = this.toSheet(cx, cy);
    const w = Math.min(SHEET_W * 1.2, Math.max(SHEET_W / 14, this.vb.w / f));
    const k = w / this.vb.w;
    this.vb = { x: p.x - (p.x - this.vb.x) * k, y: p.y - (p.y - this.vb.y) * k, w, h: this.vb.h * k };
    this.clamp();
    this.apply();
  }

  pan(dxPx, dyPx) {
    const s = this.scale();
    this.vb.x -= dxPx / s;
    this.vb.y -= dyPx / s;
    this.clamp();
    this.apply();
  }

  clamp() {
    const v = this.vb;
    const mx = v.w * 0.6, my = v.h * 0.6;
    v.x = Math.min(SHEET_W - v.w + mx, Math.max(-mx, v.x));
    v.y = Math.min(SHEET_H - v.h + my, Math.max(-my, v.y));
  }

  apply() {
    if (!this.svg) return;
    // keep the view box aspect equal to the sheet aspect; meet scaling centres it in the host
    const v = this.vb;
    this.svg.setAttribute('viewBox', `${v.x.toFixed(2)} ${v.y.toFixed(2)} ${v.w.toFixed(2)} ${v.h.toFixed(2)}`);
  }

  _bind() {
    const el = this.host;
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018)), e.clientX, e.clientY);
    }, { passive: false });
    el.addEventListener('dblclick', (e) => this.zoomAt(2, e.clientX, e.clientY));
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      el.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      el.classList.add('drag');
    });
    el.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      if (this.pointers.size === 1) {
        this.pan(e.clientX - p.x, e.clientY - p.y);
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.entries()];
        const other = a[0] === e.pointerId ? b[1] : a[1];
        const d0 = Math.hypot(p.x - other.x, p.y - other.y);
        const d1 = Math.hypot(e.clientX - other.x, e.clientY - other.y);
        if (d0 > 4 && d1 > 4) this.zoomAt(d1 / d0, (e.clientX + other.x) / 2, (e.clientY + other.y) / 2);
        this.pan((e.clientX - p.x) / 2, (e.clientY - p.y) / 2);
      }
      p.x = e.clientX;
      p.y = e.clientY;
    });
    const up = (e) => {
      this.pointers.delete(e.pointerId);
      if (!this.pointers.size) el.classList.remove('drag');
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }
}
