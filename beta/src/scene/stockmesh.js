// Renders a ZMap as tiled meshes. Only tiles the Z-map marks dirty are rebuilt each frame, so cutting
// costs a few small buffer uploads rather than re-meshing the whole part.
import * as THREE from 'three';

function patchThrough(mat) {
  // Discard fragments where the cutter has gone all the way through the stock.
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = 'attribute float aThru;\nvarying float vThru;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vThru = aThru;');
    shader.fragmentShader = 'varying float vThru;\n' + shader.fragmentShader.replace('void main() {', 'void main() {\n  if (vThru > 0.5) discard;');
  };
  mat.customProgramCacheKey = () => 'stock-through';
}

export class StockMesh {
  constructor(zmap, spec) {
    this.zmap = zmap;
    this.group = new THREE.Group();
    this.group.name = 'stock';
    this.raw = new THREE.Color();
    this.cut = new THREE.Color();
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.9, roughness: 0.35, envMapIntensity: 1.1 });
    patchThrough(this.material);
    this.wallMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.9, roughness: 0.35, envMapIntensity: 1.1 });
    this.setSpec(spec);
    this.buildTiles();
    this.buildWalls();
    this.update(true);
  }

  setSpec(spec) {
    this.spec = spec;
    this.raw.setHex(spec.raw);
    this.cut.setHex(spec.cut);
    for (const m of [this.material, this.wallMaterial]) {
      m.metalness = spec.metalness;
      m.roughness = spec.roughness;
      m.envMapIntensity = spec.metalness > 0.5 ? 1.05 : 0.45;
      m.needsUpdate = true;
    }
    this.baseRoughness = spec.roughness;
    if (this.tiles) {
      this.zmap.markAllDirty();
      this.update(true);
    }
  }

  setWet(w) {
    // a coolant film makes the part look glossier
    const r = this.baseRoughness * (1 - 0.45 * w);
    this.material.roughness = r;
    this.wallMaterial.roughness = r;
  }

  buildTiles() {
    const z = this.zmap;
    const T = z.T;
    this.tiles = [];
    for (let ty = 0; ty < z.tilesY; ty++) {
      for (let tx = 0; tx < z.tilesX; tx++) {
        const i0 = tx * T, i1 = Math.min(i0 + T, z.nx - 1);
        const j0 = ty * T, j1 = Math.min(j0 + T, z.ny - 1);
        const w = i1 - i0 + 1, h = j1 - j0 + 1;
        const n = w * h;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
        g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
        g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
        g.setAttribute('aThru', new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
        const idx = new (n > 65535 ? Uint32Array : Uint16Array)((w - 1) * (h - 1) * 6);
        let k = 0;
        for (let j = 0; j < h - 1; j++) {
          for (let i = 0; i < w - 1; i++) {
            const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
            idx[k++] = a; idx[k++] = b; idx[k++] = c;
            idx[k++] = b; idx[k++] = d; idx[k++] = c;
          }
        }
        g.setIndex(new THREE.BufferAttribute(idx, 1));
        const minX = z.x0 + i0 * z.dx, maxX = z.x0 + i1 * z.dx;
        const minY = z.y0 + j0 * z.dy, maxY = z.y0 + j1 * z.dy;
        g.boundingBox = new THREE.Box3(new THREE.Vector3(minX, z.bottom, -maxY), new THREE.Vector3(maxX, z.top, -minY));
        g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
        const mesh = new THREE.Mesh(g, this.material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.stock = true;
        this.group.add(mesh);
        this.tiles.push({ tx, ty, i0, i1, j0, j1, w, h, mesh });
      }
    }
  }

  fillTile(t) {
    const z = this.zmap;
    const { h: H, shade, nx, ny, x0, y0, dx, dy, bottom } = z;
    const g = t.mesh.geometry;
    const P = g.attributes.position.array, N = g.attributes.normal.array, C = g.attributes.color.array, TH = g.attributes.aThru.array;
    const raw = this.raw, cut = this.cut;
    let v = 0;
    for (let j = t.j0; j <= t.j1; j++) {
      const row = j * nx;
      const jd = j > 0 ? nx : 0, ju = j < ny - 1 ? nx : 0;
      const sy = ((j > 0 ? 1 : 0) + (j < ny - 1 ? 1 : 0)) * dy;
      for (let i = t.i0; i <= t.i1; i++) {
        const idx = row + i;
        const hz = H[idx];
        const p3 = v * 3;
        P[p3] = x0 + i * dx;
        P[p3 + 1] = hz;
        P[p3 + 2] = -(y0 + j * dy);
        // Sobel gradient: smooths the staircase of steep walls along curves
        const il = i > 0 ? 1 : 0, ir = i < nx - 1 ? 1 : 0;
        const sx = (il + ir) * dx;
        const gx = (2 * (H[idx + ir] - H[idx - il]) + (H[idx + ir + ju] - H[idx - il + ju]) + (H[idx + ir - jd] - H[idx - il - jd])) / (4 * sx);
        const gy = (2 * (H[idx + ju] - H[idx - jd]) + (H[idx + ju + ir] - H[idx - jd + ir]) + (H[idx + ju - il] - H[idx - jd - il])) / (4 * sy);
        const inv = 1 / Math.sqrt(gx * gx + gy * gy + 1);
        N[p3] = -gx * inv;
        N[p3 + 1] = inv;
        N[p3 + 2] = gy * inv;
        const s = shade[idx];
        if (s === 0) {
          C[p3] = raw.r; C[p3 + 1] = raw.g; C[p3 + 2] = raw.b;
        } else {
          const f = 0.6 + (s / 255) * 0.44;
          C[p3] = cut.r * f; C[p3 + 1] = cut.g * f; C[p3 + 2] = cut.b * f;
        }
        TH[v] = hz <= bottom + 1e-4 ? 1 : 0;
        v++;
      }
    }
    g.attributes.position.needsUpdate = true;
    g.attributes.normal.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    g.attributes.aThru.needsUpdate = true;
  }

  buildWalls() {
    const z = this.zmap;
    const n = 2 * (z.nx + z.nx + z.ny + z.ny);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    const idx = [];
    const strips = [];
    let base = 0;
    // Each strip is a row of (top, bottom) vertex pairs; winding is chosen so the outside is front-facing.
    const add = (count, nrm, flip) => {
      strips.push({ base, count, nrm });
      for (let k = 0; k < count - 1; k++) {
        const a = base + k * 2;
        if (flip) idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
        else idx.push(a, a + 2, a + 1, a + 2, a + 3, a + 1);
      }
      base += count * 2;
    };
    add(z.nx, [0, 0, 1], true); // front (table -Y)
    add(z.nx, [0, 0, -1], false); // back
    add(z.ny, [-1, 0, 0], false); // left
    add(z.ny, [1, 0, 0], true); // right
    g.setIndex(idx);
    const N = g.attributes.normal.array;
    for (const s of strips) for (let k = 0; k < s.count * 2; k++) N.set(s.nrm, (s.base + k) * 3);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(z.x0 + z.lx / 2, (z.top + z.bottom) / 2, -(z.y0 + z.ly / 2)), Math.hypot(z.lx, z.ly, z.top - z.bottom));
    this.wallStrips = strips;
    this.walls = new THREE.Mesh(g, this.wallMaterial);
    this.walls.castShadow = true;
    this.walls.receiveShadow = true;
    this.walls.userData.stock = true;
    this.group.add(this.walls);
    // bottom face
    const bot = new THREE.Mesh(new THREE.PlaneGeometry(z.lx, z.ly), new THREE.MeshStandardMaterial({ color: this.raw, metalness: 0.5, roughness: 0.6 }));
    bot.rotation.x = Math.PI / 2;
    bot.position.set(z.x0 + z.lx / 2, z.bottom, -(z.y0 + z.ly / 2));
    this.bottomMesh = bot;
    this.group.add(bot);
  }

  fillWalls() {
    const z = this.zmap;
    const { h: H, nx, ny, x0, y0, dx, dy, bottom } = z;
    const P = this.walls.geometry.attributes.position.array, C = this.walls.geometry.attributes.color.array;
    const raw = this.raw, cut = this.cut;
    // The side walls are always the original (raw) faces of the blank; only their top edge moves.
    const put = (v, x, y, zz) => {
      P[v * 3] = x; P[v * 3 + 1] = y; P[v * 3 + 2] = zz;
      C[v * 3] = raw.r * 0.92; C[v * 3 + 1] = raw.g * 0.92; C[v * 3 + 2] = raw.b * 0.92;
    };
    const [front, back, left, right] = this.wallStrips;
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * dx;
      let k = i;
      put(front.base + i * 2, x, H[k], -y0);
      put(front.base + i * 2 + 1, x, bottom, -y0);
      k = (ny - 1) * nx + i;
      put(back.base + i * 2, x, H[k], -(y0 + (ny - 1) * dy));
      put(back.base + i * 2 + 1, x, bottom, -(y0 + (ny - 1) * dy));
    }
    for (let j = 0; j < ny; j++) {
      const y = -(y0 + j * dy);
      let k = j * nx;
      put(left.base + j * 2, x0, H[k], y);
      put(left.base + j * 2 + 1, x0, bottom, y);
      k = j * nx + nx - 1;
      put(right.base + j * 2, x0 + (nx - 1) * dx, H[k], y);
      put(right.base + j * 2 + 1, x0 + (nx - 1) * dx, bottom, y);
    }
    this.walls.geometry.attributes.position.needsUpdate = true;
    this.walls.geometry.attributes.color.needsUpdate = true;
  }

  update(force = false) {
    const z = this.zmap;
    if (!z.anyDirty && !force) return 0;
    let n = 0;
    for (const t of this.tiles) {
      const k = t.ty * z.tilesX + t.tx;
      if (force || z.dirty[k]) {
        this.fillTile(t);
        z.dirty[k] = 0;
        n++;
      }
    }
    if (force || z.edgeDirty) this.fillWalls();
    z.anyDirty = false;
    z.edgeDirty = false;
    return n;
  }

  dispose() {
    for (const t of this.tiles) t.mesh.geometry.dispose();
    this.walls.geometry.dispose();
    this.bottomMesh.geometry.dispose();
    this.bottomMesh.material.dispose();
    this.material.dispose();
    this.wallMaterial.dispose();
  }
}
