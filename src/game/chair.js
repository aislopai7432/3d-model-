// Operator chair beside the machine: press E to sit and watch the part being machined, any movement
// key (or E again) stands you back up. Self-contained: hooks into the game's interactables at start-up.
import * as THREE from 'three';

// on the operator side, clear of the doors and the pendant; the app can move it (window.__app.chairPos,
// e.g. the manual lathe puts it beside the tailstock end)
let POS = new THREE.Vector3(650, 0, 1750);
let YAW = Math.atan2(POS.x, POS.z); // facing the machine (yaw 0 looks toward -Z)
const SEAT_EYE = 1180;

function buildChair() {
  const g = new THREE.Group();
  const black = new THREE.MeshStandardMaterial({ color: 0x1d1f22, roughness: 0.55, metalness: 0.3 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xc9ced3, roughness: 0.2, metalness: 1 });
  const fabric = new THREE.MeshStandardMaterial({ color: 0x2e3a48, roughness: 0.9, metalness: 0 });
  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };
  // five-star base with casters
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const leg = add(new THREE.BoxGeometry(300, 26, 46), black, Math.cos(a) * 150, 70, Math.sin(a) * 150, 0, -a, 0);
    leg.rotation.z = 0;
    add(new THREE.SphereGeometry(26, 12, 8), black, Math.cos(a) * 290, 28, Math.sin(a) * 290);
  }
  add(new THREE.CylinderGeometry(42, 42, 50, 20), black, 0, 85, 0);
  add(new THREE.CylinderGeometry(22, 22, 330, 16), chrome, 0, 265, 0); // gas lift
  add(new THREE.BoxGeometry(200, 30, 200), black, 0, 430, 0); // mechanism
  add(new THREE.BoxGeometry(480, 80, 460), fabric, 0, 480, 0); // seat cushion
  add(new THREE.BoxGeometry(60, 40, 300), black, 0, 450, 240, -0.2); // back support arm
  add(new THREE.BoxGeometry(70, 420, 40), black, 0, 680, 270); // back post
  add(new THREE.BoxGeometry(440, 380, 80), fabric, 0, 860, 290, -0.08); // backrest (behind the sitter)
  g.position.copy(POS);
  g.rotation.y = YAW;
  g.name = 'operator-chair';
  return g;
}

function start(app) {
  const game = app.game;
  if (app.chairPos) {
    POS = new THREE.Vector3(app.chairPos.x, 0, app.chairPos.z);
    const lk = app.chairLook || { x: 0, z: 0 };
    YAW = Math.atan2(POS.x - lk.x, POS.z - lk.z);
  }
  const fp = game.fp;
  const chair = buildChair();
  app.viewer.scene.add(chair);
  let seated = false;
  let saved = null;

  const sit = () => {
    if (game.mode !== 'workshop' || game.op) return;
    saved = { walk: fp.opts.walkSpeed, sprint: fp.opts.sprintSpeed, crouch: fp.opts.crouchSpeed, eye: fp.opts.eyeHeight };
    fp.opts.walkSpeed = fp.opts.sprintSpeed = fp.opts.crouchSpeed = 0;
    fp.opts.eyeHeight = SEAT_EYE;
    fp.setPose({ pos: [POS.x, 0, POS.z], yaw: YAW, pitch: -0.12 });
    seated = true;
    game.ui?.toast?.('Sitting down. Look around with the mouse; press W/A/S/D or E to stand up.', 'info', 4000);
  };
  const stand = () => {
    if (!seated) return;
    Object.assign(fp.opts, { walkSpeed: saved.walk, sprintSpeed: saved.sprint, crouchSpeed: saved.crouch, eyeHeight: saved.eye });
    // step forward off the chair so the player isn't standing inside it
    fp.setPose({ pos: [POS.x - Math.sin(YAW) * 450, 0, POS.z - Math.cos(YAW) * 450], yaw: fp.yaw, pitch: fp.pitch });
    seated = false;
  };

  // add the chair to the game's interactables and route its interaction here
  const list = game.interactables.bind(game);
  game.interactables = () => {
    const L = list();
    if (game.mode === 'workshop') L.push({ object: chair, id: 'chair', label: seated ? 'Stand up' : 'Sit down and watch the machine' });
    return L;
  };
  const interact = game.interact.bind(game);
  game.interact = (hit) => {
    if (hit.id !== 'chair') return interact(hit);
    if (seated) stand();
    else sit();
  };
  addEventListener('keydown', (e) => {
    if (!seated) return;
    const el = document.activeElement;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) stand();
  });
  // leaving workshop mode or opening the control while seated: stand up
  setInterval(() => { if (seated && (game.mode !== 'workshop' || game.op)) stand(); }, 500);
  window.__chair = { sit, stand, get seated() { return seated; }, object: chair };
}

const wait = () => (window.__app?.game?.fp ? start(window.__app) : setTimeout(wait, 300));
wait();
