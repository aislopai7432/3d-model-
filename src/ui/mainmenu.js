// Main menu: a 3D carousel of the available machines. A small dedicated Three.js renderer shows each
// machine on a turntable with its name and description underneath; scroll / swipe / arrow keys move
// between entries and Select (Enter) picks one. Machines with another profile store the choice and
// reload the page (config.js reads it at start-up); the control (NGC / 808D) is applied afterwards.
import { PROFILE } from '../config.js';

const ENTRIES = [
  {
    id: 'minimill', machine: 'minimill', control: 'haas', title: 'Mini Mill · NGC control', tag: 'Recommended',
    sub: 'Compact VMC with an integrated NGC-style pendant: VPS templates, Haas G-code and PART ZERO SET.',
  },
  {
    id: 'vmc560', machine: 'vmc560', control: '808d', title: 'VMC-560 · 808D control',
    sub: 'The original full-size VMC in its enclosure, with the SINUMERIK 808D-style panel, programGUIDE cycle forms and Siemens G-code.',
  },
  { id: 'lathe', title: 'Manual lathe', sub: 'Coming later.', disabled: true },
];

const css = `
.mm-root{position:fixed;inset:0;z-index:9000;display:flex;flex-direction:column;background:radial-gradient(ellipse at 50% 35%,#27303b,#0c0e11 75%);
  font-family:inherit;color:#e8edf2;user-select:none;touch-action:pan-y}
.mm-head{text-align:center;padding:18px 16px 0}
.mm-head h1{margin:0;font-size:26px;letter-spacing:.5px}
.mm-head p{margin:2px 0 0;color:#8f9ba7;font-size:13px}
.mm-stage{position:relative;flex:1;min-height:0;cursor:grab}
.mm-stage canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.mm-arrow{position:absolute;top:50%;transform:translateY(-50%);width:46px;height:46px;border-radius:50%;border:1px solid #3a4553;
  background:rgba(20,25,31,.8);color:#e8edf2;font-size:22px;cursor:pointer;z-index:2}
.mm-arrow:hover:not([disabled]){border-color:#2f7de1}.mm-arrow[disabled]{opacity:.25;cursor:default}
.mm-prev{left:14px}.mm-next{right:14px}
.mm-info{text-align:center;padding:4px 20px 22px;max-width:640px;margin:0 auto;width:100%;box-sizing:border-box}
.mm-info h2{margin:0 0 6px;font-size:24px}
.mm-info h2 em{font-style:normal;font-size:11px;margin-left:10px;padding:2px 8px;border-radius:10px;background:#2f7de1;color:#fff;vertical-align:middle}
.mm-info h2 em.cur{background:#e8b21a;color:#222}
.mm-info p{margin:0 0 14px;color:#9aa6b2;font-size:14px;line-height:1.5;min-height:42px}
.mm-dots{display:flex;gap:8px;justify-content:center;margin-bottom:14px}
.mm-dots i{width:8px;height:8px;border-radius:50%;background:#3a4553;cursor:pointer}.mm-dots i.on{background:#2f7de1}
.mm-go{font:inherit;font-size:15px;padding:10px 34px;border-radius:8px;border:0;background:#2f7de1;color:#fff;cursor:pointer}
.mm-go[disabled]{background:#2a323b;color:#6f7c88;cursor:not-allowed}
.mm-hint{margin-top:10px;font-size:12px;color:#6f7c88}
`;

// simple ghost lathe silhouette (placeholder for the coming machine)
function ghostLathe(THREE) {
  const g = new THREE.Group();
  const m = new THREE.MeshStandardMaterial({ color: 0x5b6672, roughness: 0.6, metalness: 0.3, transparent: true, opacity: 0.55 });
  const add = (geo, x, y, z) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); g.add(o); return o; };
  add(new THREE.BoxGeometry(1700, 120, 420), 0, 780, 0);
  add(new THREE.BoxGeometry(1500, 780, 360), 0, 390, 0).scale.set(0.9, 1, 0.8);
  add(new THREE.BoxGeometry(520, 520, 460), -600, 1040, 0);
  const chuck = add(new THREE.CylinderGeometry(190, 190, 120, 28), -300, 1080, 0); chuck.rotation.z = Math.PI / 2;
  add(new THREE.BoxGeometry(300, 300, 300), 600, 960, 0);
  const q = add(new THREE.CylinderGeometry(40, 40, 260, 12), 400, 1000, 0); q.rotation.z = Math.PI / 2;
  g.position.y = 0;
  return g;
}

let openMenu = null;

function show(app) {
  if (openMenu) return;
  if (!document.getElementById('mm-style')) {
    const s = document.createElement('style');
    s.id = 'mm-style';
    s.textContent = css;
    document.head.appendChild(s);
  }
  let idx = Math.max(0, ENTRIES.findIndex((e) => e.machine === PROFILE.id));
  const root = document.createElement('div');
  root.className = 'mm-root';
  root.innerHTML = `<div class="mm-head"><h1>MillLab</h1><p>Choose the machine you want to work on</p></div>
    <div class="mm-stage"><canvas></canvas><button class="mm-arrow mm-prev" aria-label="Previous">‹</button>
    <button class="mm-arrow mm-next" aria-label="Next">›</button></div>
    <div class="mm-info"><h2></h2><p></p><div class="mm-dots">${ENTRIES.map((_, i) => `<i data-i="${i}"></i>`).join('')}</div>
    <button class="mm-go">Select</button><div class="mm-hint">← → / scroll / swipe to browse · Enter to select · Esc to close</div></div>`;
  document.body.appendChild(root);
  const q = (s) => root.querySelector(s);
  const stage = q('.mm-stage'), canvas = q('canvas'), go = q('.mm-go');

  const text = () => {
    const e = ENTRIES[idx];
    const cur = e.machine === PROFILE.id;
    q('h2').innerHTML = `${e.title}${e.tag && !cur ? `<em>${e.tag}</em>` : ''}${cur ? '<em class="cur">Current</em>' : ''}${e.disabled ? '<em>Coming later</em>' : ''}`;
    q('p').textContent = e.sub;
    go.disabled = !!e.disabled;
    go.textContent = e.disabled ? 'Coming later' : 'Select';
    root.querySelectorAll('.mm-dots i').forEach((d, i) => d.classList.toggle('on', i === idx));
    q('.mm-prev').disabled = idx === 0;
    q('.mm-next').disabled = idx === ENTRIES.length - 1;
  };
  const move = (d) => { const n = Math.min(ENTRIES.length - 1, Math.max(0, idx + d)); if (n !== idx) { idx = n; text(); } };

  const close = () => {
    openMenu = null;
    cancelAnimationFrame(raf);
    clearTimeout(buildTimer);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', resize);
    disposeGl();
    root.remove();
  };
  const choose = () => {
    const e = ENTRIES[idx];
    if (e.disabled) return;
    if (e.machine !== PROFILE.id) {
      // another machine profile: remember it (+ its control) and reload; the saved game stays
      try {
        localStorage.setItem('milllab.machine', e.machine);
        sessionStorage.setItem('milllab.pendingControl', e.control);
        sessionStorage.setItem('milllab.skipMenu', '1');
      } catch { /* storage blocked */ }
      const u = new URL(location.href);
      u.searchParams.delete('machine');
      location.replace(u.toString());
      return;
    }
    close();
    applyControl(e.control);
  };
  const onKey = (ev) => {
    if (ev.key === 'ArrowLeft') move(-1); else if (ev.key === 'ArrowRight') move(1);
    else if (ev.key === 'Enter') choose(); else if (ev.key === 'Escape') close(); else return;
    ev.preventDefault(); ev.stopPropagation();
  };
  window.addEventListener('keydown', onKey, true);
  q('.mm-prev').onclick = () => move(-1);
  q('.mm-next').onclick = () => move(1);
  go.onclick = choose;
  root.querySelectorAll('.mm-dots i').forEach((d) => { d.onclick = () => { idx = +d.dataset.i; text(); }; });
  let wheelT = 0;
  stage.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const now = performance.now();
    if (now - wheelT < 350) return;
    const d = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
    if (Math.abs(d) < 4) return;
    wheelT = now; move(d > 0 ? 1 : -1);
  }, { passive: false });
  let dragX = null, dragRot = 0;
  stage.addEventListener('pointerdown', (ev) => { if (ev.target.closest('.mm-arrow')) return; dragX = ev.clientX; dragRot = 0; });
  stage.addEventListener('pointermove', (ev) => { if (dragX != null) { dragRot += (ev.clientX - dragX) * 0.006; dragX = ev.clientX; } });
  const endDrag = (ev) => {
    if (dragX == null) return;
    dragX = null;
    if (Math.abs(dragRot) > 0.4) move(dragRot < 0 ? 1 : -1); // a horizontal swipe changes machine
    dragRot = 0;
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  text();
  openMenu = { close };

  // ---- 3D preview (loaded lazily so the text menu is instant)
  let raf = 0, buildTimer = 0, disposeGl = () => {}, resize = () => {};
  (async () => {
    const THREE = await import('three');
    if (!openMenu) return;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xdfe9f5, 0x2a2f36, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.4); key.position.set(1500, 3000, 2500); scene.add(key);
    const rim = new THREE.DirectionalLight(0x6fa8ff, 1.2); rim.position.set(-2500, 1500, -2000); scene.add(rim);
    const cam = new THREE.PerspectiveCamera(28, 1, 100, 40000);
    const SP = 3600;
    const items = ENTRIES.map(() => null); // { holder, spin, size }
    const own = []; // things to dispose
    let T = null;
    const holderFor = (i, obj) => {
      const holder = new THREE.Group(), spin = new THREE.Group();
      holder.add(spin); spin.add(obj);
      const box = new THREE.Box3().setFromObject(obj);
      const c = box.getCenter(new THREE.Vector3());
      obj.position.set(-c.x, -box.min.y, -c.z);
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 48), new THREE.MeshStandardMaterial({ color: 0x1b2129, roughness: 0.8, metalness: 0.2 }));
      const r = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 0.62;
      disc.scale.set(r, 30, r); disc.position.y = -15; spin.add(disc);
      scene.add(holder);
      items[i] = { holder, spin, h: box.max.y - box.min.y, r };
    };
    const buildEntry = async (i) => {
      const e = ENTRIES[i];
      let obj;
      if (e.id === 'lathe') obj = ghostLathe(THREE);
      else {
        if (!T) { const { createTextures } = await import('../scene/textures.js'); T = createTextures(); }
        if (!openMenu) return;
        let M;
        if (e.machine === 'vmc560') ({ Vmc560Model: M } = await import('../scene/machine-vmc560.js'));
        else ({ MachineModel: M } = await import('../scene/machine.js'));
        if (!openMenu) return;
        const m = new M(T);
        try { m.setEnclosureVisible?.(true); m.setLights?.(true); } catch { /* optional */ }
        obj = m.root;
      }
      obj.traverse((o) => { if (o.isLight) o.visible = false; });
      holderFor(i, obj);
    };
    // current entry first, the others one at a time afterwards
    const order = [idx, ...ENTRIES.map((_, i) => i).filter((i) => i !== idx)];
    const buildNext = async () => {
      const i = order.shift();
      if (i == null || !openMenu) return;
      try { await buildEntry(i); } catch (err) { console.warn('menu preview', ENTRIES[i].id, err); }
      buildTimer = setTimeout(buildNext, 60);
    };
    buildNext();

    resize = () => {
      const w = stage.clientWidth || 1, h = stage.clientHeight || 1;
      renderer.setSize(w, h, false);
      cam.aspect = w / h; cam.updateProjectionMatrix();
    };
    window.addEventListener('resize', resize);
    resize();
    let pos = idx, last = performance.now(), rot = 0.6, camR = 5500, camH = 1700;
    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      pos += (idx - pos) * Math.min(1, dt * 7);
      rot += dt * 0.5;
      const cur = items[idx];
      const need = cur ? Math.max(cur.h * 1.15, cur.r * 1.5) : 2200;
      const aspect = cam.aspect;
      const vf = Math.tan((cam.fov * Math.PI) / 360);
      const wantR = Math.max(need / vf / 1.0, (cur ? cur.r * 2.3 : 2600) / (vf * aspect)) * 0.95;
      camR += (wantR - camR) * Math.min(1, dt * 4);
      camH += ((cur ? cur.h * 0.55 : 1000) - camH) * Math.min(1, dt * 4);
      cam.position.set(0, camH + camR * 0.28, camR);
      cam.lookAt(0, camH * 0.95, 0);
      items.forEach((it, i) => {
        if (!it) return;
        it.holder.position.x = (i - pos) * SP;
        it.spin.rotation.y = rot + (dragRot || 0);
        it.holder.visible = Math.abs(i - pos) < 1.6;
      });
      renderer.render(scene, cam);
    };
    raf = requestAnimationFrame(frame);
    disposeGl = () => {
      scene.traverse((o) => {
        o.geometry?.dispose?.();
        const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
        for (const mt of ms) { for (const k in mt) if (mt[k] && mt[k].isTexture) mt[k].dispose(); mt.dispose(); }
      });
      if (T) for (const k in T) T[k]?.dispose?.();
      renderer.dispose();
      renderer.forceContextLoss();
    };
    own.length = 0;
  })().catch((err) => console.warn('menu preview failed', err));
}

// applies the control (NGC / 808D) as soon as the app is ready
function applyControl(control) {
  if (!control) return;
  const apply = () => {
    const a = window.__app;
    if (!a?.haas || !a.settings) return setTimeout(apply, 200);
    if (a.settings.control !== control) a.haas.setControl(control);
  };
  apply();
}

function startMenu(app) {
  const bar = document.querySelector('.top-actions');
  if (bar && !bar.querySelector('.mm-btn')) {
    const b = document.createElement('button');
    b.className = 'btn ghost mm-btn';
    b.title = 'Choose the machine';
    b.innerHTML = '<span aria-hidden="true">☰</span><span>Machines</span>';
    b.addEventListener('click', () => show(app));
    // always directly right after the Coffee break button (it is added by a separate script, so wait for it)
    let tries = 0;
    const place = () => {
      const coffee = [...bar.children].find((c) => /coffee/i.test(c.title || c.textContent));
      if (coffee) coffee.after(b);
      else if (++tries < 50) { setTimeout(place, 200); if (!b.isConnected) bar.prepend(b); }
      else if (!b.isConnected) bar.prepend(b);
    };
    place();
  }
  window.__mainMenu = { show: () => show(app) };
}

// shown straight away on every normal start (before the 3D scene has loaded); skipped for automated
// runs (?capture), ?nomenu, and once right after a machine switch (the reload)
const q = new URLSearchParams(location.search);
let skip = false;
try {
  skip = sessionStorage.getItem('milllab.skipMenu') === '1';
  sessionStorage.removeItem('milllab.skipMenu');
  const pc = sessionStorage.getItem('milllab.pendingControl');
  sessionStorage.removeItem('milllab.pendingControl');
  if (pc) applyControl(pc);
} catch { /* storage blocked */ }
if (!q.has('capture') && !q.has('nomenu') && !skip) show(null);
const wait = () => (window.__app?.haas && window.__app.settings ? startMenu(window.__app) : setTimeout(wait, 200));
wait();
