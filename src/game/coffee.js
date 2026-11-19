// Coffee break: a first-person mug comes up to the face, steams, you take a sip, it goes back down.
// Self-contained: waits for the app, adds a top-bar button and the B key, and draws in camera space.
import * as THREE from 'three';

const DUR = 4.2; // seconds for the whole break

function steamTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grd.addColorStop(0, 'rgba(255,255,255,0.85)');
  grd.addColorStop(0.5, 'rgba(255,255,255,0.3)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function buildMug() {
  // drawn on top without depth test (like the carried blank) so it never clips into walls
  const opt = { depthTest: false, depthWrite: false };
  const ceramic = new THREE.MeshStandardMaterial({ color: 0xe9e6df, roughness: 0.35, metalness: 0, ...opt });
  const band = new THREE.MeshStandardMaterial({ color: 0x2f7de1, roughness: 0.4, metalness: 0, ...opt });
  const coffee = new THREE.MeshStandardMaterial({ color: 0x3b2314, roughness: 0.2, metalness: 0, ...opt });
  const mug = new THREE.Group();
  const add = (geo, mat, y = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.y = y;
    m.renderOrder = 1001;
    m.frustumCulled = false;
    mug.add(m);
    return m;
  };
  add(new THREE.CylinderGeometry(42, 38, 95, 32, 1, true), ceramic, 0);
  add(new THREE.CylinderGeometry(38, 38, 4, 32), ceramic, -46);
  add(new THREE.CylinderGeometry(42.6, 41.6, 16, 32, 1, true), band, 18);
  add(new THREE.CircleGeometry(39, 32), coffee, 36).rotation.x = -Math.PI / 2;
  const handle = add(new THREE.TorusGeometry(24, 7, 12, 24, Math.PI * 1.25), ceramic, 2);
  handle.position.x = 44;
  handle.rotation.z = -Math.PI * 0.62;
  // steam puffs (camera space, rising out of the mug)
  const tex = steamTexture();
  const puffs = [];
  for (let i = 0; i < 14; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthTest: false, depthWrite: false }));
    s.renderOrder = 1002;
    s.frustumCulled = false;
    s.userData.phase = i / 14;
    s.userData.dx = (Math.random() - 0.5) * 30;
    mug.add(s);
    puffs.push(s);
  }
  mug.userData.puffs = puffs;
  return mug;
}

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

function start(app) {
  const cam = app.viewer.camera;
  const mug = buildMug();
  mug.visible = false;
  cam.add(mug);
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
    mug.visible = true;
  };

  const tick = (now) => {
    const dt = Math.min(0.5, (now - last) / 1000); // wall-clock time so the break always lasts ~4 s
    last = now;
    if (t >= 0) {
      t += dt;
      const f = t / DUR;
      // 0..0.18 raise, 0.18..0.8 hold + sip, 0.8..1 lower
      let up;
      if (f < 0.18) up = ease(f / 0.18);
      else if (f < 0.8) up = 1;
      else up = 1 - ease((f - 0.8) / 0.2);
      const sip = f > 0.45 && f < 0.72 ? Math.sin(((f - 0.45) / 0.27) * Math.PI) : 0;
      // rest pose just below the view, raised pose in front of the face; tilt toward the mouth while sipping
      mug.position.set(60 - 40 * up, -330 + 250 * up + 25 * sip, -330 + 70 * up + 40 * sip);
      mug.rotation.set(0.25 * (1 - up) + 0.9 * sip, -0.35, 0.12 * up);
      for (const p of mug.userData.puffs) {
        const ph = (p.userData.phase + t * 0.55) % 1;
        p.position.set(p.userData.dx * ph + Math.sin((ph + p.userData.phase) * 9) * 6, 45 + ph * 170, 0);
        const size = 30 + ph * 90;
        p.scale.set(size, size, 1);
        p.material.opacity = (1 - 0.6 * sip) * up * 0.75 * Math.sin(ph * Math.PI);
      }
      if (t >= DUR) {
        t = -1;
        mug.visible = false;
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
