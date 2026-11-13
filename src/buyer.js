// The refinery: a small 3D shop interior with a digital weighing scale.
// Items chosen for sale drop onto the pan; the display counts the weight and payout up.
import * as THREE from 'three';
import { buildTreasureModel } from './treasure.js';
import { getAtlas, signTexture, tileTexture, studioEnvScene } from './textures.js';
import { prep, tileUV } from './junk.js';
import { Audio } from './audio.js';

function lcdCanvas() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 200;
  return c;
}

export class Refinery {
  constructor(renderer) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x15110d);
    const pm = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pm.fromScene(studioEnvScene(), 0.03).texture;
    pm.dispose();
    this.scene.fog = new THREE.Fog(0x15110d, 3, 7);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 20);
    this.items = new Map(); // uid → { model, t, y0 }
    this.weight = 0;
    this.shownWeight = 0;
    this.payout = 0;
    this.shownPayout = 0;
    this.pointer = new THREE.Vector2();
    this.camera.position.set(0.02, 0.66, 0.95);
    this.build();
  }

  build() {
    const s = this.scene;
    const A = getAtlas();
    const amat = new THREE.MeshStandardMaterial({ map: A.map, normalMap: A.normalMap, roughnessMap: A.roughMetal, metalnessMap: A.roughMetal, roughness: 1, metalness: 1 });
    // counter
    const woodTex = tileTexture('wood', 1, [3, 1.2]);
    const counter = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.06, 1.0), new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.55, metalness: 0, color: 0xc8a882 }));
    counter.position.y = -0.03;
    counter.receiveShadow = true;
    s.add(counter);
    const front = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.9, 0.04), new THREE.MeshStandardMaterial({ color: 0x2a1d14, roughness: 0.6 }));
    front.position.set(0, -0.5, 0.48);
    s.add(front);
    // back wall and signage
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(6, 3), new THREE.MeshStandardMaterial({ map: tileTexture('stone', 1, [5, 2.5]), color: 0x8a6e58, roughness: 0.92 }));
    wall.position.set(0, 0.8, -0.62);
    s.add(wall);
    const signTex = signTexture(['AURUM REFINERY', 'GOLD · SILVER · GEMS · COLLECTABLES'], { fg: '#f2c14e', bg: '#120d09' });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.4), new THREE.MeshStandardMaterial({ map: signTex, emissive: 0xffffff, emissiveMap: signTex, emissiveIntensity: 0.55 }));
    sign.position.set(-0.5, 0.34, -0.6);
    sign.scale.setScalar(0.42);
    s.add(sign);
    // price board
    this.boardCanvas = document.createElement('canvas');
    this.boardCanvas.width = 512;
    this.boardCanvas.height = 384;
    this.boardTex = new THREE.CanvasTexture(this.boardCanvas);
    this.boardTex.colorSpace = THREE.SRGBColorSpace;
    const board = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.465), new THREE.MeshStandardMaterial({ map: this.boardTex, emissive: 0xffffff, emissiveMap: this.boardTex, emissiveIntensity: 0.7 }));
    board.position.set(0.56, 0.17, -0.42);
    board.scale.setScalar(0.62);
    board.rotation.x = -0.12;
    const easel = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.32, 0.02), new THREE.MeshStandardMaterial({ color: 0x2a1d14, roughness: 0.6 }));
    easel.position.set(0.56, 0.16, -0.435);
    easel.rotation.x = -0.12;
    s.add(easel);
    s.add(board);
    // safe in the corner
    const safe = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.6, 0.45), new THREE.MeshStandardMaterial({ color: 0x223028, metalness: 0.6, roughness: 0.45 }));
    safe.position.set(-1.05, 0.3, -0.3);
    s.add(safe);
    const dial = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.03, 32), new THREE.MeshStandardMaterial({ color: 0xc9b07a, metalness: 1, roughness: 0.25 }));
    dial.rotation.x = Math.PI / 2;
    dial.position.set(-1.05, 0.36, -0.065);
    s.add(dial);

    // digital scale
    const scale = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: 0xd6d8da, metalness: 1, roughness: 0.22 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.055, 0.3), new THREE.MeshStandardMaterial({ color: 0x1d1f22, roughness: 0.4, metalness: 0.2 }));
    body.position.y = 0.0275;
    body.castShadow = true;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 0.02, 16), steel);
    post.position.y = 0.065;
    this.pan = new THREE.Group();
    const pan = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.11, 0.008, 64), steel);
    pan.receiveShadow = true;
    const lip = new THREE.Mesh(new THREE.TorusGeometry(0.113, 0.004, 8, 64), steel);
    lip.rotation.x = Math.PI / 2;
    lip.position.y = 0.004;
    this.pan.add(pan, lip);
    this.pan.position.y = 0.079;
    // display console
    const consoleG = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.07, 0.06), new THREE.MeshStandardMaterial({ color: 0x232528, roughness: 0.45 }));
    consoleG.position.set(0, 0.04, 0.19);
    consoleG.rotation.x = -0.5;
    this.lcd = lcdCanvas();
    this.lcdTex = new THREE.CanvasTexture(this.lcd);
    this.lcdTex.colorSpace = THREE.SRGBColorSpace;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.055), new THREE.MeshBasicMaterial({ map: this.lcdTex, toneMapped: false }));
    screen.position.set(0, 0.058, 0.216);
    screen.rotation.x = -0.5;
    for (let k = 0; k < 3; k++) {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.006, 16), new THREE.MeshStandardMaterial({ color: k === 0 ? 0x3aa655 : 0x888888, roughness: 0.4 }));
      b.rotation.x = Math.PI / 2 - 0.5;
      b.position.set(0.1 + k * 0.0, 0.03 - k * 0.012, 0.215 + k * 0.007);
      b.position.x = -0.1 + k * 0.025;
      b.position.y = 0.024;
      scale.add(b);
    }
    scale.add(body, post, this.pan, consoleG, screen);
    s.add(scale);
    // jeweller's loupe and a cash tray as props
    const loupe = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.025, 24), new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.3, metalness: 0.5 }));
    loupe.position.set(0.32, 0.0125, 0.12);
    s.add(loupe);
    const tray = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.02, 0.2), new THREE.MeshStandardMaterial({ color: 0x5a1f1f, roughness: 0.9 }));
    tray.position.set(-0.42, 0.01, 0.05);
    s.add(tray);
    this.trayPos = tray.position.clone().add(new THREE.Vector3(0, 0.02, 0));

    // lighting: warm desk lamp over the scale
    const lamp = new THREE.SpotLight(0xffd9a8, 6, 3, 0.6, 0.6, 1.5);
    lamp.position.set(0.25, 0.95, 0.3);
    lamp.target.position.set(0, 0.08, 0);
    lamp.castShadow = true;
    lamp.shadow.mapSize.set(1024, 1024);
    lamp.shadow.bias = -0.0005;
    s.add(lamp, lamp.target);
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.1, 24, 1, true), new THREE.MeshStandardMaterial({ color: 0x1d4630, roughness: 0.4, side: THREE.DoubleSide, metalness: 0.4 }));
    shade.position.copy(lamp.position);
    s.add(shade);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.025, 12, 8), new THREE.MeshBasicMaterial({ color: 0xfff1d6 }));
    bulb.position.copy(lamp.position).add(new THREE.Vector3(0, -0.03, 0));
    s.add(bulb);
    s.add(new THREE.AmbientLight(0xffe2c4, 0.25));
    const fill = new THREE.PointLight(0xffc98a, 2, 4, 2);
    fill.position.set(-0.8, 0.9, 0.6);
    s.add(fill);
    this.drawLCD();
  }

  drawBoard(prices) {
    const c = this.boardCanvas, x = c.getContext('2d');
    x.fillStyle = '#0d0b08';
    x.fillRect(0, 0, c.width, c.height);
    x.strokeStyle = '#3a2f1e';
    x.lineWidth = 6;
    x.strokeRect(6, 6, c.width - 12, c.height - 12);
    x.fillStyle = '#f2c14e';
    x.font = '700 30px "Barlow Condensed", Arial Narrow, sans-serif';
    x.fillText("TODAY'S PRICES  £ / g", 26, 50);
    const rows = [['24ct  999', prices.gold], ['22ct  916', prices.gold * 0.916], ['18ct  750', prices.gold * 0.75], ['9ct   375', prices.gold * 0.375], ['Silver 925', prices.silver * 0.925]];
    x.font = '600 34px "Barlow Condensed", Arial Narrow, sans-serif';
    rows.forEach(([l, v], i) => {
      x.fillStyle = '#d8d0bf';
      x.fillText(l, 26, 110 + i * 54);
      x.fillStyle = '#ffe28f';
      x.textAlign = 'right';
      x.fillText(v.toFixed(2), c.width - 26, 110 + i * 54);
      x.textAlign = 'left';
    });
    this.boardTex.needsUpdate = true;
  }

  drawLCD() {
    const c = this.lcd, x = c.getContext('2d');
    x.fillStyle = '#0b1a10';
    x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = '#7dff9a';
    x.textAlign = 'right';
    x.font = '700 92px "JetBrains Mono", "Courier New", monospace';
    const w = this.shownWeight;
    const str = w >= 1000 ? (w / 1000).toFixed(3) : w.toFixed(w < 10 ? 3 : 2);
    x.fillText(str, c.width - 90, 110);
    x.font = '700 40px "JetBrains Mono", monospace';
    x.fillText(w >= 1000 ? 'kg' : 'g', c.width - 24, 110);
    x.fillStyle = '#f2c14e';
    x.font = '700 44px "JetBrains Mono", monospace';
    x.fillText('£' + this.shownPayout.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), c.width - 24, 178);
    x.textAlign = 'left';
    x.fillStyle = 'rgba(125,255,154,0.6)';
    x.font = '600 26px monospace';
    x.fillText('STABLE', 20, 176);
    this.lcdTex.needsUpdate = true;
  }

  // items: list of inventory items now on the pan
  setItems(items, payout) {
    const want = new Set(items.map((i) => i.uid));
    for (const [uid, rec] of this.items) {
      if (!want.has(uid)) { this.pan.remove(rec.model); rec.model.traverse((o) => { if (o.isMesh) o.geometry.dispose(); }); this.items.delete(uid); }
    }
    let n = this.items.size;
    for (const it of items) {
      if (this.items.has(it.uid)) continue;
      const model = buildTreasureModel(it);
      const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.z);
      const sc = maxDim > 0.15 ? 0.15 / maxDim : 1;
      model.scale.setScalar(sc);
      const a = n * 2.39996, rr = Math.min(0.085, 0.012 * Math.sqrt(n) + (n ? 0.02 : 0));
      model.position.set(Math.cos(a) * rr, 0.25 + Math.random() * 0.05, Math.sin(a) * rr);
      model.rotation.y = Math.random() * 6;
      this.pan.add(model);
      this.items.set(it.uid, { model, vy: 0, landed: false, delay: (this.items.size % 8) * 0.06, restY: 0.004 + n * 0.0006 });
      n++;
    }
    this.weight = items.reduce((a, i) => a + i.mass, 0);
    this.payout = payout;
  }
  clear() { this.setItems([], 0); }

  setPointer(x, y) { this.pointer.set(x, y); }

  update(dt) {
    let landed = 0;
    for (const rec of this.items.values()) {
      if (rec.landed) continue;
      if (rec.delay > 0) { rec.delay -= dt; continue; }
      rec.vy -= 9.8 * dt;
      rec.model.position.y += rec.vy * dt;
      if (rec.model.position.y <= rec.restY) {
        rec.model.position.y = rec.restY;
        if (Math.abs(rec.vy) > 0.4) { rec.vy = -rec.vy * 0.25; Audio.drop(); } else { rec.landed = true; landed++; }
      }
    }
    if (landed) Audio.scaleBeep();
    // pan sinks very slightly under load
    this.pan.position.y = THREE.MathUtils.lerp(this.pan.position.y, 0.079 - Math.min(0.004, this.weight * 0.000004), Math.min(1, dt * 6));
    const k = Math.min(1, dt * 4);
    const nw = Math.abs(this.weight - this.shownWeight) < 0.0005 ? this.weight : this.shownWeight + (this.weight - this.shownWeight) * k;
    const np = Math.abs(this.payout - this.shownPayout) < 0.005 ? this.payout : this.shownPayout + (this.payout - this.shownPayout) * k;
    if (nw !== this.shownWeight || np !== this.shownPayout) { this.shownWeight = nw; this.shownPayout = np; this.drawLCD(); }
    // gentle parallax
    const t = new THREE.Vector3(0.04, 0.09, -0.14);
    const pos = new THREE.Vector3(0.02 + THREE.MathUtils.clamp(this.pointer.x, -1, 1) * 0.08, 0.66 + THREE.MathUtils.clamp(this.pointer.y, -1, 1) * 0.04, 0.95);
    this.camera.position.lerp(pos, Math.min(1, dt * 3));
    this.camera.lookAt(t);
  }

  render(renderer, w, h, offsetX = 0) {
    this.camera.aspect = w / h;
    // keep the scale centred in the space not covered by the side panel
    if (offsetX) this.camera.setViewOffset(w, h, offsetX, 0, w, h); else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    renderer.render(this.scene, this.camera);
  }
}
