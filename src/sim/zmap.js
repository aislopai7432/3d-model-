// Z-map (dexel heightfield) material removal.
//
// The stock top is sampled on a regular grid of nodes; each node stores the current material height.
// A 3-axis machine with vertical, rotationally symmetric cutters can never produce an undercut, so a
// heightfield represents the machined part exactly (to the grid resolution) for every tool in the
// library: flat, ball, bull nose, face mills, drills, spot drills and chamfer mills.
//
// Removal sweeps the cutter along each motion segment. For every node within reach the lowest point of
// the cutter envelope over the segment is computed analytically (flat tools) or by sampling the exact
// part of the segment where the node is under the cutter (profiled tools), and the node is lowered to it.
// Long segments are split so the bounding box stays tight. Changed areas are tracked in tiles so the
// renderer only rebuilds what changed.

export class ZMap {
  // All coordinates are in the table frame (mm). x0/y0 is the stock min corner.
  constructor({ x0, y0, lx, ly, top, bottom, cell, maxNodes = 400000, tile = 32 }) {
    let c = cell;
    let nx, ny;
    for (;;) {
      nx = Math.max(2, Math.round(lx / c) + 1);
      ny = Math.max(2, Math.round(ly / c) + 1);
      if (nx * ny <= maxNodes) break;
      c *= 1.08;
    }
    Object.assign(this, { x0, y0, lx, ly, top, bottom, nx, ny });
    this.dx = lx / (nx - 1);
    this.dy = ly / (ny - 1);
    this.cell = Math.max(this.dx, this.dy);
    this.cellArea = this.dx * this.dy;
    this.h = new Float32Array(nx * ny).fill(top);
    this.shade = new Uint8Array(nx * ny); // 0 = raw stock surface, otherwise machined brightness
    this.T = tile;
    this.tilesX = Math.ceil((nx - 1) / tile);
    this.tilesY = Math.ceil((ny - 1) / tile);
    this.dirty = new Uint8Array(this.tilesX * this.tilesY);
    this.anyDirty = false;
    this.edgeDirty = false;
    this.initialVolume = lx * ly * (top - bottom);
    this.removedTotal = 0;
    this.lowest = top;
    this.shankExcess = 0; // deepest engagement above the flutes since the last reset (collision check)
  }

  get volume() {
    return this.initialVolume - this.removedTotal;
  }

  markAllDirty() {
    this.dirty.fill(1);
    this.anyDirty = true;
    this.edgeDirty = true;
  }

  // Sweep cutter `c` (from tooling.makeCutter) with its tip moving from a to b. Returns removed mm^3.
  sweep(ax, ay, az, bx, by, bz, c) {
    if ((az < bz ? az : bz) >= this.top) return 0;
    const len = Math.hypot(bx - ax, by - ay);
    const maxLen = Math.max(c.r, 4 * this.cell);
    if (len <= maxLen) return this._sweep(ax, ay, az, bx, by, bz, c);
    const n = Math.ceil(len / maxLen);
    let v = 0;
    let px = ax, py = ay, pz = az;
    for (let k = 1; k <= n; k++) {
      const f = k / n;
      const qx = ax + (bx - ax) * f, qy = ay + (by - ay) * f, qz = az + (bz - az) * f;
      v += this._sweep(px, py, pz, qx, qy, qz, c);
      px = qx; py = qy; pz = qz;
    }
    return v;
  }

  _sweep(ax, ay, az, bx, by, bz, c) {
    const zlo = az < bz ? az : bz;
    if (zlo >= this.top) return 0;
    const { x0, y0, dx, dy, nx, ny, h, shade, bottom } = this;
    const r = c.r, r2 = c.r2;
    let i0 = Math.ceil(((ax < bx ? ax : bx) - r - x0) / dx);
    let i1 = Math.floor(((ax > bx ? ax : bx) + r - x0) / dx);
    let j0 = Math.ceil(((ay < by ? ay : by) - r - y0) / dy);
    let j1 = Math.floor(((ay > by ? ay : by) + r - y0) / dy);
    if (i0 < 0) i0 = 0;
    if (j0 < 0) j0 = 0;
    if (i1 > nx - 1) i1 = nx - 1;
    if (j1 > ny - 1) j1 = ny - 1;
    if (i0 > i1 || j0 > j1) return 0;

    const ddx = bx - ax, ddy = by - ay, dz = bz - az;
    const L2 = ddx * ddx + ddy * ddy;
    const point = L2 < 1e-12;
    const horiz = Math.abs(dz) < 1e-9;
    const prof = c.prof, pn = c.pn, pk = pn / r2;
    // Profile lookup with linear interpolation in d^2 (exact for flat tools, accurate on steep ball walls).
    const pf = (d2v) => {
      if (flat) return 0;
      const fi = d2v * pk;
      const ii = fi | 0;
      if (ii >= pn) return prof[pn];
      return prof[ii] + (prof[ii + 1] - prof[ii]) * (fi - ii);
    };
    const flute = c.flute;
    const flat = c.flat;
    const L = Math.sqrt(L2);
    const ux = L > 1e-9 ? ddx / L : 1, uy = L > 1e-9 ? ddy / L : 0;
    const markK = (Math.PI * 2) / Math.max(4 * this.cell, r * 0.16, 0.9);
    const lastI = nx - 1, lastJ = ny - 1;

    let removed = 0;
    let ci0 = nx, ci1 = -1, cj0 = ny, cj1 = -1;
    let shank = this.shankExcess;

    for (let j = j0; j <= j1; j++) {
      const py = y0 + j * dy;
      const wy = py - ay;
      const row = j * nx;
      const wj = j === 0 || j === lastJ ? 0.5 : 1;
      for (let i = i0; i <= i1; i++) {
        const idx = row + i;
        const hOld = h[idx];
        if (hOld <= zlo) continue;
        const px = x0 + i * dx;
        const wx = px - ax;
        let zc, tipz, d2;
        if (point) {
          d2 = wx * wx + wy * wy;
          if (d2 > r2) continue;
          tipz = zlo;
          zc = zlo + pf(d2);
        } else if (horiz) {
          let t = (wx * ddx + wy * ddy) / L2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const cx = wx - t * ddx, cy = wy - t * ddy;
          d2 = cx * cx + cy * cy;
          if (d2 > r2) continue;
          tipz = az;
          zc = az + pf(d2);
        } else {
          // Ramp / helix segment: find the parameter interval where this node is under the cutter.
          const b = wx * ddx + wy * ddy;
          const cc = wx * wx + wy * wy;
          const disc = b * b - L2 * (cc - r2);
          if (disc < 0) continue;
          const s = Math.sqrt(disc);
          let t0 = (b - s) / L2, t1 = (b + s) / L2;
          if (t0 < 0) t0 = 0;
          if (t1 > 1) t1 = 1;
          if (t0 > t1) continue;
          if (flat) {
            const tm = dz < 0 ? t1 : t0;
            tipz = az + dz * tm;
            zc = tipz;
            d2 = cc - 2 * b * tm + L2 * tm * tm;
          } else {
            zc = Infinity;
            tipz = az;
            d2 = 0;
            let tc = b / L2;
            for (let k = 0; k <= 7; k++) {
              const t = k < 7 ? t0 + ((t1 - t0) * k) / 6 : tc;
              if (t < t0 || t > t1) continue;
              let dd = cc - 2 * b * t + L2 * t * t;
              if (dd < 0) dd = 0;
              const tz = az + dz * t;
              const z = tz + pf(dd);
              if (z < zc) { zc = z; tipz = tz; d2 = dd; }
            }
          }
        }
        if (zc >= hOld) continue;
        const nh = zc < bottom ? bottom : zc;
        if (nh >= hOld) continue;
        const w = (i === 0 || i === lastI ? 0.5 : 1) * wj;
        removed += (hOld - nh) * w;
        const over = hOld - tipz - flute;
        if (over > shank) shank = over;
        h[idx] = nh;
        if (zc - tipz < 0.03) {
          // Cutter floor: arc-shaped feed marks like a real face/end mill leaves.
          const along = px * ux + (y0 + j * dy) * uy;
          const e2 = d2 < r2 ? r2 - d2 : 0;
          const m = Math.cos((along + Math.sqrt(e2)) * markK);
          shade[idx] = 196 + ((m * 34) | 0);
        } else {
          shade[idx] = 222;
        }
        if (i < ci0) ci0 = i;
        if (i > ci1) ci1 = i;
        if (j < cj0) cj0 = j;
        if (j > cj1) cj1 = j;
        if (nh < this.lowest) this.lowest = nh;
      }
    }
    this.shankExcess = shank;
    if (ci1 < 0) return 0;
    const T = this.T;
    const tx0 = Math.floor(Math.max(0, ci0 - 2) / T), tx1 = Math.min(this.tilesX - 1, Math.floor((ci1 + 1) / T));
    const ty0 = Math.floor(Math.max(0, cj0 - 2) / T), ty1 = Math.min(this.tilesY - 1, Math.floor((cj1 + 1) / T));
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) this.dirty[ty * this.tilesX + tx] = 1;
    this.anyDirty = true;
    if (ci0 <= 1 || ci1 >= nx - 2 || cj0 <= 1 || cj1 >= ny - 2) this.edgeDirty = true;
    const vol = removed * this.cellArea;
    this.removedTotal += vol;
    return vol;
  }

  // Highest material point within radius r of (cx, cy). Used for holder / spindle-nose collisions.
  maxInDisc(cx, cy, r) {
    const { x0, y0, dx, dy, nx, ny, h } = this;
    const i0 = Math.max(0, Math.ceil((cx - r - x0) / dx)), i1 = Math.min(nx - 1, Math.floor((cx + r - x0) / dx));
    const j0 = Math.max(0, Math.ceil((cy - r - y0) / dy)), j1 = Math.min(ny - 1, Math.floor((cy + r - y0) / dy));
    let m = -Infinity;
    const r2 = r * r;
    for (let j = j0; j <= j1; j++) {
      const wy = y0 + j * dy - cy;
      for (let i = i0; i <= i1; i++) {
        const wx = x0 + i * dx - cx;
        if (wx * wx + wy * wy > r2) continue;
        const v = h[j * nx + i];
        if (v > m) m = v;
      }
    }
    return m;
  }

  heightAt(x, y) {
    const fx = (x - this.x0) / this.dx, fy = (y - this.y0) / this.dy;
    if (fx < 0 || fy < 0 || fx > this.nx - 1 || fy > this.ny - 1) return null;
    const i = Math.min(this.nx - 2, Math.floor(fx)), j = Math.min(this.ny - 2, Math.floor(fy));
    const u = fx - i, v = fy - j;
    const h = this.h, nx = this.nx;
    const a = h[j * nx + i], b = h[j * nx + i + 1], c = h[(j + 1) * nx + i], d = h[(j + 1) * nx + i + 1];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }

  inFootprint(x, y, margin = 0) {
    return x >= this.x0 - margin && x <= this.x0 + this.lx + margin && y >= this.y0 - margin && y <= this.y0 + this.ly + margin;
  }
}
