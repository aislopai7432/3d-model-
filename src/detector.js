// Metal detector: signal model, metal identification, coil visuals and pinpointing.
import * as THREE from 'three';
import { METAL_NAMES } from './pile.js';

const JUNK_RESP = { 1: 0.7, 2: 0.5, 3: 0.55, 4: 0.8, 5: 0.9 };

// Strongest response under the search head. Junk metal (cans, iron) answers too:
// better detectors can reject iron (notch ≥ 1) and aluminium (notch ≥ 2).
export function scan(pile, x, z, det, opts) {
  let best = null;
  pile.forTargets(x, z, det.radius, (kind, tx, tz, depth, mass, metal, ref) => {
    if (metal === 1 && opts.ironReject && det.notch >= 1) return;
    if (metal === 2 && opts.alReject && det.notch >= 2) return;
    if (mass < det.minMass || depth > det.depth) return;
    const d = Math.hypot(tx - x, tz - z);
    if (d > det.radius) return;
    // response grows with target size; trash metal answers weaker than precious metal
    const resp = Math.min(1, (Math.log10(mass / det.minMass) + 1.6) / 2.6) * (kind === 'junk' ? JUNK_RESP[metal] : 1);
    const depthF = 1 - Math.pow(depth / det.depth, 2);
    const distF = Math.exp(-Math.pow(d / (det.radius * 0.36), 2));
    const s = resp * depthF * distF;
    if (!best || s > best.s) best = { s, metal, depth, kind, ref, x: tx, z: tz, d, mass };
  });
  return best || { s: 0, metal: 0 };
}

// Tone per metal: iron grunts low, gold sings in the middle, silver high.
export const TONES = { 1: 190, 2: 470, 3: 560, 4: 880, 5: 700 };

export function idText(det, hit) {
  if (!hit || hit.s < 0.06) return '';
  if (det.idLevel === 0) return 'SIGNAL';
  if (det.idLevel === 1) return hit.metal === 1 ? 'FERROUS' : 'NON-FERROUS';
  return METAL_NAMES[hit.metal].toUpperCase();
}

export class DetectorRig {
  constructor(scene) {
    this.group = new THREE.Group();
    // search coil
    this.coilMat = new THREE.MeshStandardMaterial({ color: 0x1c1d1f, roughness: 0.4, metalness: 0.3, emissive: 0xffb52e, emissiveIntensity: 0 });
    const coil = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.014, 10, 40), this.coilMat);
    coil.rotation.x = Math.PI / 2;
    coil.scale.set(1, 1.25, 1);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.12, 32), new THREE.MeshStandardMaterial({ color: 0x2a2b2e, roughness: 0.6, transparent: true, opacity: 0.55 }));
    disc.rotation.x = -Math.PI / 2;
    disc.scale.set(1, 1.25, 1);
    this.head = new THREE.Group();
    this.head.add(coil, disc);
    this.group.add(this.head);
    // shaft and control box: leans back towards the viewer like a detector in hand
    this.shaft = new THREE.Group();
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 1, 10), new THREE.MeshStandardMaterial({ color: 0x8a8d91, metalness: 0.9, roughness: 0.3 }));
    rod.position.y = 0.5;
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.05, 0.11), new THREE.MeshStandardMaterial({ color: 0x1d1f22, roughness: 0.45 }));
    box.position.y = 0.82;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 0.03), new THREE.MeshBasicMaterial({ color: 0x7dff9a }));
    screen.position.set(0, 0.85, 0.056);
    screen.rotation.x = -0.6;
    this.screenMat = screen.material;
    const yoke = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.006, 6, 12, Math.PI), new THREE.MeshStandardMaterial({ color: 0x2a2b2e, roughness: 0.5 }));
    yoke.position.y = 0.02;
    this.shaft.add(rod, box, screen, yoke);
    this.group.add(this.shaft);
    // coverage ring on the ground
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 64), new THREE.MeshBasicMaterial({ color: 0xffd479, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }));
    this.ring.rotation.x = -Math.PI / 2;
    this.group.add(this.ring);
    // pinpoint arrow (elite)
    const arrowShape = new THREE.Shape();
    arrowShape.moveTo(0, 0.09); arrowShape.lineTo(0.05, 0.0); arrowShape.lineTo(0.018, 0.0); arrowShape.lineTo(0.018, -0.06); arrowShape.lineTo(-0.018, -0.06); arrowShape.lineTo(-0.018, 0); arrowShape.lineTo(-0.05, 0); arrowShape.closePath();
    this.arrow = new THREE.Mesh(new THREE.ShapeGeometry(arrowShape), new THREE.MeshBasicMaterial({ color: 0xffd479, transparent: true, opacity: 0.9, depthTest: false }));
    this.arrow.renderOrder = 10;
    this.group.add(this.arrow);
    scene.add(this.group);
    this.sweep = 0;
  }
  update(dt, point, normal, det, hit, enabled, camPos) {
    this.group.visible = !!point && enabled;
    if (!this.group.visible) return;
    this.sweep += dt;
    const sw = Math.sin(this.sweep * 3.2) * 0.04;
    this.head.position.set(point.x + sw, point.y + 0.07, point.z);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal || new THREE.Vector3(0, 1, 0));
    this.head.quaternion.slerp(q, Math.min(1, dt * 10));
    // lean the shaft towards the camera (horizontal direction), ~55° from the ground, scaled to view distance
    if (camPos) {
      const toCam = new THREE.Vector3(camPos.x - point.x, 0, camPos.z - point.z);
      const dist = Math.hypot(camPos.x - point.x, camPos.y - point.y, camPos.z - point.z);
      toCam.normalize();
      const dir = toCam.multiplyScalar(Math.cos(0.95)).add(new THREE.Vector3(0, Math.sin(0.95), 0)).normalize();
      this.shaft.position.copy(this.head.position);
      this.shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      this.shaft.scale.setScalar(THREE.MathUtils.clamp(dist * 0.32, 0.35, 0.95));
    }
    this.screenMat.color.setHSL(0.36, 1, 0.35 + (hit ? hit.s : 0) * 0.4);
    this.ring.position.set(point.x, point.y + 0.03, point.z);
    this.ring.scale.setScalar(det.radius);
    const s = hit ? hit.s : 0;
    this.coilMat.emissiveIntensity = THREE.MathUtils.lerp(this.coilMat.emissiveIntensity, s * 3, Math.min(1, dt * 14));
    this.coilMat.emissive.setHex(hit && hit.metal === 1 ? 0xff5a36 : 0xffb52e);
    this.ring.material.opacity = 0.09 + s * 0.25;
    this.arrow.visible = det.pinpoint && hit && hit.s > 0.04;
    if (this.arrow.visible) {
      const dx = hit.x - point.x, dz = hit.z - point.z;
      this.arrow.position.set(point.x, point.y + 0.35, point.z);
      this.arrow.rotation.set(-Math.PI / 2, 0, Math.atan2(-dx, -dz) + Math.PI);
      const close = Math.hypot(dx, dz) < 0.12;
      this.arrow.material.color.setHex(close ? 0x7dff9a : 0xffd479);
      this.arrow.scale.setScalar(close ? 1.3 + Math.sin(this.sweep * 12) * 0.2 : 1);
    }
  }
}
