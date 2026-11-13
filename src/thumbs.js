// Small offscreen renderer for inventory thumbnails and the live 3D inspect preview.
import * as THREE from 'three';
import { studioEnvScene } from './textures.js';
import { buildTreasureModel } from './treasure.js';

export class Thumbs {
  constructor() {
    this.size = 192;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(this.size, this.size, false);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pm.fromScene(studioEnvScene(), 0.03).texture;
    pm.dispose();
    const key = new THREE.DirectionalLight(0xfff2e0, 1.2);
    key.position.set(1, 2, 1.5);
    this.scene.add(key);
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.0005, 10);
    this.cache = new Map();
    this.live = null;
  }
  key(item) { return `${item.kind}|${item.variant || ''}|${item.purity.toFixed(2)}|${item.kind === 'chain' || item.kind === 'flake' || item.kind === 'fragment' || item.kind === 'nugget' || item.kind === 'chunk' ? item.seed % 6 : 0}`; }
  frame(model, angle = 0) {
    const box = new THREE.Box3().setFromObject(model);
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-4);
    const d = r / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.08;
    const dir = new THREE.Vector3(Math.sin(angle) * 1.1, 0.95, Math.cos(angle) * 1.1).normalize();
    this.camera.position.copy(c).addScaledVector(dir, d);
    this.camera.near = d / 50;
    this.camera.far = d * 4;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(c);
  }
  get(item) {
    const k = this.key(item);
    if (this.cache.has(k)) return this.cache.get(k);
    const model = buildTreasureModel(item);
    this.scene.add(model);
    this.frame(model, 0.6);
    this.renderer.render(this.scene, this.camera);
    const url = this.renderer.domElement.toDataURL('image/png');
    this.scene.remove(model);
    model.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    this.cache.set(k, url);
    return url;
  }
  startPreview(item, canvas) {
    this.stopPreview();
    const model = buildTreasureModel(item);
    this.scene.add(model);
    this.live = { model, canvas, ctx: canvas.getContext('2d'), t: 0 };
  }
  stopPreview() {
    if (!this.live) return;
    this.scene.remove(this.live.model);
    this.live.model.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    this.live = null;
  }
  updatePreview(dt) {
    if (!this.live) return;
    const L = this.live;
    L.t += dt;
    this.frame(L.model, L.t * 0.6);
    this.renderer.render(this.scene, this.camera);
    L.ctx.clearRect(0, 0, L.canvas.width, L.canvas.height);
    L.ctx.drawImage(this.renderer.domElement, 0, 0, L.canvas.width, L.canvas.height);
  }
}
