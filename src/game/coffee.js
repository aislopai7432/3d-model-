// Coffee break: a first-person mug comes up to the face, steams, you take a sip, it goes back down.
// Self-contained: waits for the app, adds a top-bar button and the B key, and draws in camera space.
import * as THREE from 'three';

const DUR = 4.2; // seconds for the whole break

// ---- procedural textures -------------------------------------------------------------------
function rng(seed) { let x = seed; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296); }

function steamTexture(seed) {
  const R = rng(seed), N = 128;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d');
  // wispy cloud: many soft blobs inside a radial falloff
  for (let i = 0; i < 26; i++) {
    const x = N / 2 + (R() - 0.5) * N * 0.5, y = N / 2 + (R() - 0.5) * N * 0.55, r = N * (0.08 + R() * 0.16);
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(255,255,255,${0.1 + R() * 0.16})`);
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, N, N);
  }
  g.globalCompositeOperation = 'destination-in';
  const m = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  m.addColorStop(0, 'rgba(0,0,0,1)');
  m.addColorStop(0.6, 'rgba(0,0,0,0.6)');
  m.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = m;
  g.fillRect(0, 0, N, N);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function noiseTexture(seed, base, amp) {
  const R = rng(seed), N = 128;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d');
  const id = g.createImageData(N, N);
  for (let i = 0; i < N * N; i++) {
    const v = Math.max(0, Math.min(255, base + (R() - 0.5) * amp * 255));
    id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v;
    id.data[i * 4 + 3] = 255;
  }
  g.putImageData(id, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 3);
  return t;
}

function liquidTexture() {
  // v runs from the centre (0) to the edge (1) of the lathe surface
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, '#3a1f10');
  gr.addColorStop(0.55, '#4a2814');
  gr.addColorStop(0.8, '#7a4a26');
  gr.addColorStop(0.9, '#a8723f'); // crema ring
  gr.addColorStop(0.96, '#5a3017');
  gr.addColorStop(1, '#2a1409');
  g.fillStyle = gr;
  g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function bandTexture() {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#245fb8';
  g.fillRect(0, 0, 8, 128);
  g.fillStyle = '#f4f1ea';
  g.fillRect(0, 10, 8, 6);
  g.fillRect(0, 112, 8, 6);
  g.fillStyle = '#1a4a96';
  g.fillRect(0, 22, 8, 84);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ---- geometry -------------------------------------------------------------------------------
const wallR = (y) => 42 + 0.008 * y; // gentle straight outer wall (the decal band follows it)

function mugProfile() {
  // (radius, height) from the underside centre, up the outside, over the rounded lip, down the inside
  const P = [];
  const arc = (cx, cy, r, a0, a1, n) => {
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      P.push(new THREE.Vector2(cx + r * Math.cos(a), cy + r * Math.sin(a)));
    }
  };
  P.push(new THREE.Vector2(0, -46.6), new THREE.Vector2(30, -46.6), new THREE.Vector2(32.6, -46.9));
  arc(34.2, -46.0, 1.6, Math.PI * 1.2, Math.PI * 1.5, 3); // foot ring inner edge
  arc(36.8, -46.0, 1.6, Math.PI * 1.5, Math.PI * 1.9, 3);
  arc(wallR(-38) - 3.5, -38 + 0.6, 4.2, -Math.PI * 0.32, 0.0, 6); // base fillet
  for (let y = -30; y <= 38; y += 17) P.push(new THREE.Vector2(wallR(y), y));
  arc(wallR(44) - 1.1, 44.4, 1.1, 0, Math.PI * 0.5, 6); // outer lip round
  arc(wallR(44) - 3.3, 44.4, 1.1, Math.PI * 0.5, Math.PI, 6); // inner lip round
  P.push(new THREE.Vector2(37.8, 36), new THREE.Vector2(37.6, 0), new THREE.Vector2(37.8, -30));
  arc(33.8, -37.5, 4.2, 0, -Math.PI * 0.5, 6); // inner bottom fillet
  P.push(new THREE.Vector2(0, -41.7));
  return P;
}

function handleGeometry() {
  const curve = new THREE.CatmullRomCurve3(
    [
      [39, 29], [48, 37], [61, 36], [70, 24], [72, 4], [67, -17], [56, -29], [44, -31], [38, -28],
    ].map(([x, y]) => new THREE.Vector3(x, y, 0)),
    false,
    'centripetal'
  );
  const geo = new THREE.TubeGeometry(curve, 72, 6.2, 20, false);
  // flatten the section a little (oval handle) and flare the ends into the wall
  const pos = geo.attributes.position, tmp = new THREE.Vector3();
  const seg = 20 + 1;
  for (let i = 0; i < pos.count; i++) {
    const ring = Math.floor(i / seg);
    const u = ring / 72;
    const p = curve.getPointAt(u);
    tmp.fromBufferAttribute(pos, i).sub(p);
    const flare = 1 + 0.55 * Math.pow(Math.abs(u - 0.5) * 2, 6);
    tmp.x *= flare; tmp.y *= flare; tmp.z *= 0.78 * flare;
    pos.setXYZ(i, p.x + tmp.x, p.y + tmp.y, p.z + tmp.z);
  }
  geo.computeVertexNormals();
  return geo;
}

function buildMug() {
  const ceramic = new THREE.MeshPhysicalMaterial({
    color: 0xf2efe8,
    roughness: 0.2,
    roughnessMap: noiseTexture(7, 128, 0.16),
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
    sheen: 0.2,
    sheenColor: new THREE.Color(0xffffff),
  });
  const bandMat = new THREE.MeshPhysicalMaterial({ map: bandTexture(), roughness: 0.28, clearcoat: 0.8, clearcoatRoughness: 0.1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const liquidMat = new THREE.MeshPhysicalMaterial({ map: liquidTexture(), roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.3 });
  const mug = new THREE.Group();
  const body = new THREE.Mesh(new THREE.LatheGeometry(mugProfile(), 72), ceramic);
  body.material.side = THREE.DoubleSide;
  mug.add(body);
  const handle = new THREE.Mesh(handleGeometry(), ceramic);
  mug.add(handle);
  // printed band: a thin sleeve hugging the straight outer wall
  const bp = [];
  for (let y = -6; y <= 26; y += 4) bp.push(new THREE.Vector2(wallR(y) + 0.14, y));
  const band = new THREE.Mesh(new THREE.LatheGeometry(bp, 72, Math.PI * 0.15, Math.PI * 1.15), bandMat);
  band.material.side = THREE.DoubleSide;
  mug.add(band);
  // coffee: flat surface with a rising meniscus at the wall; its group stays level while the mug tilts
  const lp = [new THREE.Vector2(0, 0), new THREE.Vector2(33, 0), new THREE.Vector2(35.6, 0.5), new THREE.Vector2(36.9, 1.5), new THREE.Vector2(37.5, 2.8)];
  const liquid = new THREE.Group();
  liquid.position.y = 31;
  const lm = new THREE.Mesh(new THREE.LatheGeometry(lp, 64), liquidMat);
  lm.material.side = THREE.DoubleSide;
  liquid.add(lm);
  mug.add(liquid);
  mug.userData.liquid = liquid;
  mug.userData.parts = { body, handle, band };
  return mug;
}

function buildSteam() {
  const g = new THREE.Group();
  const texs = [1, 2, 3, 4].map((i) => steamTexture(i * 977));
  const puffs = [];
  for (let i = 0; i < 28; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: texs[i % 4], transparent: true, opacity: 0, depthWrite: false, rotation: Math.random() * 6.28, color: 0xf4f6f8 }));
    s.frustumCulled = false;
    s.renderOrder = 5;
    s.userData = { phase: i / 28, a: Math.random() * 6.28, sx: 10 + Math.random() * 18, rot: (Math.random() - 0.5) * 0.6, sz: 0.8 + Math.random() * 0.5 };
    g.add(s);
    puffs.push(s);
  }
  g.userData.puffs = puffs;
  return g;
}

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

function start(app) {
  const viewer = app.viewer;
  const cam = viewer.camera;
  // own overlay scene, drawn after the world with a cleared depth buffer so the mug never clips into walls
  const scene = new THREE.Scene();
  scene.environment = viewer.envTex;
  const root = new THREE.Group(); // camera-space frame (same orientation as the viewer camera)
  scene.add(root);
  const ocam = new THREE.PerspectiveCamera();
  const key = new THREE.DirectionalLight(0xfff1de, 2.2);
  key.position.set(-260, 340, 220);
  const fill = new THREE.HemisphereLight(0xcfe0ff, 0x4a3a2c, 0.5);
  const rim = new THREE.DirectionalLight(0xbcd4ff, 0.8);
  rim.position.set(260, 120, -200);
  root.add(key, key.target, fill, rim, rim.target);
  const mug = buildMug();
  const steam = buildSteam();
  root.add(mug, steam);
  const ov = {
    scene,
    camera: ocam,
    visible: false,
    beforeRender(c) {
      ocam.projectionMatrix.copy(c.projectionMatrix);
      ocam.projectionMatrixInverse.copy(c.projectionMatrixInverse);
      ocam.quaternion.copy(c.quaternion);
      ocam.position.set(0, 0, 0);
      ocam.updateMatrixWorld(true);
      root.quaternion.copy(c.quaternion);
    },
  };
  viewer.overlays.push(ov);
  let t = -1;
  let last = performance.now();

  const canBreak = () => {
    const g = app.game;
    if (!g || g.mode !== 'workshop') return 'Coffee breaks are taken in the workshop (switch to Workshop mode).';
    if (g.op || g.measuring) return 'Step back from the control first.';
    if (app.controller.state === 'running') return null; // fine: watch the machine while you sip
    return null;
  };
  const toast = (m) => (app.game?.ui?.toast ? app.game.ui.toast(m, 'info') : app.ui.log(m));
  const go = () => {
    if (t >= 0) return;
    const why = canBreak();
    if (why) return toast(why);
    t = 0;
    ov.visible = true;
  };

  const tick = (now) => {
    const dt = Math.min(0.5, (now - last) / 1000); // wall-clock time so the break always lasts ~4 s
    last = now;
    if (t >= 0) {
      t = window.__coffeeFreeze != null ? window.__coffeeFreeze * DUR : t + dt; // freeze hook for screenshots
      const f = t / DUR;
      // 0..0.18 raise, 0.18..0.8 hold + sip, 0.8..1 lower
      let up;
      if (f < 0.18) up = ease(f / 0.18);
      else if (f < 0.8) up = 1;
      else up = 1 - ease((f - 0.8) / 0.2);
      const sip = f > 0.45 && f < 0.72 ? Math.sin(((f - 0.45) / 0.27) * Math.PI) : 0;
      // rest pose just below the view, raised pose in front of the face; tilt toward the mouth while sipping
      const sway = Math.sin(t * 2.3) * 3 * up, sway2 = Math.sin(t * 1.7 + 1) * 2.5 * up;
      mug.position.set(60 - 40 * up + sway, -330 + 250 * up + 25 * sip + sway2, -330 + 70 * up + 40 * sip);
      mug.rotation.set(0.25 * (1 - up) + 0.8 * sip + Math.sin(t * 1.3) * 0.015 * up, -0.35, 0.12 * up + Math.sin(t * 2.0) * 0.012 * up);
      mug.updateMatrix();
      // coffee stays level (slightly lagging) while the mug tilts
      const lq = mug.userData.liquid;
      lq.rotation.x = -mug.rotation.x * 0.62;
      lq.rotation.z = -mug.rotation.z * 0.7;
      // steam: rises from the coffee surface in camera space, curls, grows and dissipates
      const origin = new THREE.Vector3(0, 33, 0).applyMatrix4(mug.matrix);
      const dens = (1 - 0.55 * sip) * Math.min(1, up * 1.4);
      for (const p of steam.userData.puffs) {
        const u = p.userData, ph = (u.phase + t * 0.32) % 1;
        const x = origin.x + Math.sin(ph * 5 + u.a) * (6 + ph * 26) * 0.9 + Math.cos(u.a) * 10 * (1 - ph);
        p.position.set(x, origin.y + ph * 230, origin.z + Math.sin(u.a * 2 + ph * 4) * 14 + 10);
        const size = (34 + ph * 120) * u.sz;
        p.scale.set(size, size * 1.2, 1);
        p.material.rotation = u.a + ph * u.rot * 4;
        p.material.opacity = dens * 0.34 * Math.pow(Math.sin(Math.min(1, ph * 1.05) * Math.PI), 1.3) * (ph < 0.08 ? ph / 0.08 : 1);
      }
      if (t >= DUR) {
        t = -1;
        ov.visible = false;
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // top-bar button + B key
  const bar = document.querySelector('.top-actions');
  if (bar) {
    const b = document.createElement('button');
    b.className = 'btn ghost';
    b.title = 'Coffee break (B)';
    b.innerHTML = '<span aria-hidden="true">☕</span><span>Coffee break</span>';
    b.addEventListener('click', go);
    bar.prepend(b);
  }
  addEventListener('keydown', (e) => {
    if (e.code !== 'KeyB' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const el = document.activeElement;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
    go();
  });
  window.__coffee = { go, get active() { return t >= 0; } };
}

const wait = () => (window.__app?.viewer && window.__app.game ? start(window.__app) : setTimeout(wait, 300));
wait();
