// Toolpath preview: tool-tip path of the compiled program in the table frame (so it rides with the
// table). Rapids are dashed amber, cutting moves blue; everything already executed dims out.
// Drawn twice: depth-tested (bright) and as a faint x-ray pass so paths inside the stock stay visible.
import * as THREE from 'three';
import { MACHINE } from '../config.js';

const vert = /* glsl */ `
  attribute float aSeg;
  attribute float aKind;
  attribute float aDist;
  varying float vSeg;
  varying float vKind;
  varying float vDist;
  void main() {
    vSeg = aSeg; vKind = aKind; vDist = aDist;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const frag = /* glsl */ `
  uniform float uDone;
  uniform float uOpacity;
  uniform vec3 uFeed;
  uniform vec3 uRapid;
  uniform vec3 uDoneFeed;
  uniform vec3 uDoneRapid;
  varying float vSeg;
  varying float vKind;
  varying float vDist;
  void main() {
    bool done = vSeg < uDone;
    if (vKind < 0.5 && mod(vDist, 6.0) > 3.4) discard;
    vec3 c = vKind < 0.5 ? (done ? uDoneRapid : uRapid) : (done ? uDoneFeed : uFeed);
    float a = uOpacity * (done ? 0.55 : 1.0);
    gl_FragColor = vec4(c, a);
  }`;

export class Toolpath {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'toolpath';
    this.uniforms = {
      uDone: { value: -1 },
      uOpacity: { value: 1 },
      uFeed: { value: new THREE.Color(0x4aa8ff) },
      uRapid: { value: new THREE.Color(0xffb02e) },
      uDoneFeed: { value: new THREE.Color(0x2b5f8f) },
      uDoneRapid: { value: new THREE.Color(0x7a5a24) },
    };
    this.mat = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms: this.uniforms, transparent: true, depthWrite: false });
    this.xrayUniforms = { ...this.uniforms, uOpacity: { value: 0.22 } };
    this.xray = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms: this.xrayUniforms, transparent: true, depthWrite: false, depthTest: false });
    this.lines = null;
    this.ghost = null;
  }

  build(ops) {
    this.clear();
    const tc = MACHINE.tableCenter, G = MACHINE.gaugeAtZ0;
    let n = 0;
    for (const op of ops) if (op.t === 'move') n += op.pts.length / 3 - 1;
    if (!n) return;
    const pos = new Float32Array(n * 6);
    const seg = new Float32Array(n * 2);
    const kind = new Float32Array(n * 2);
    const dist = new Float32Array(n * 2);
    let v = 0;
    ops.forEach((op, oi) => {
      if (op.t !== 'move') return;
      const p = op.pts;
      const L = op.tlen;
      let d = 0;
      for (let i = 3; i < p.length; i += 3) {
        const ax = p[i - 3] - tc.x, ay = p[i - 2] - tc.y, az = G + p[i - 1] - L;
        const bx = p[i] - tc.x, by = p[i + 1] - tc.y, bz = G + p[i + 2] - L;
        pos[v * 3] = ax; pos[v * 3 + 1] = az; pos[v * 3 + 2] = -ay;
        pos[v * 3 + 3] = bx; pos[v * 3 + 4] = bz; pos[v * 3 + 5] = -by;
        seg[v] = seg[v + 1] = oi;
        kind[v] = kind[v + 1] = op.rapid ? 0 : 1;
        dist[v] = d;
        d += Math.hypot(bx - ax, by - ay, bz - az);
        dist[v + 1] = d;
        v += 2;
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeg', new THREE.BufferAttribute(seg, 1));
    g.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
    g.setAttribute('aDist', new THREE.BufferAttribute(dist, 1));
    g.computeBoundingSphere();
    this.lines = new THREE.LineSegments(g, this.mat);
    this.lines.renderOrder = 5;
    this.ghost = new THREE.LineSegments(g, this.xray);
    this.ghost.renderOrder = 4;
    this.group.add(this.ghost, this.lines);
  }

  setProgress(opIndex) {
    this.uniforms.uDone.value = opIndex;
  }

  clear() {
    if (this.lines) {
      this.lines.geometry.dispose();
      this.group.remove(this.lines, this.ghost);
      this.lines = this.ghost = null;
    }
  }
}
