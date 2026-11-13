// Environments: sky, lighting, ground, set dressing and ambient life for each search area.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { groundTextures, fenceTexture, signTexture, softDot, getAtlas } from './textures.js';
import { terrainHeight, CELL } from './pile.js';
import { prep, tileUV } from './junk.js';
import { mulberry, fbm3 } from './rng.js';

export const LOOKS = {
  dump: {
    skyTop: '#7f97ad', skyHorizon: '#d3d5cf', skyGround: '#5b5249', sunDir: [0.55, 0.75, 0.35], sun: '#fff1dc', sunI: 2.4,
    hemiSky: '#c3cfd9', hemiGround: '#4b4035', hemiI: 0.75, fog: '#bfc3bf', fogD: 0.018, exposure: 1.0, envI: 0.9, outdoor: true,
  },
  scrapyard: {
    skyTop: '#5f82b0', skyHorizon: '#f2c48a', skyGround: '#4f463e', sunDir: [-0.7, 0.42, 0.45], sun: '#ffc98c', sunI: 3.0,
    hemiSky: '#9fb3cc', hemiGround: '#5a4535', hemiI: 0.6, fog: '#d8b791', fogD: 0.017, exposure: 1.0, envI: 0.95, outdoor: true,
  },
  facility: {
    skyTop: '#101315', skyHorizon: '#1a1e21', skyGround: '#0d0e0f', sunDir: [0.2, 1, 0.1], sun: '#c9dcff', sunI: 0.35,
    hemiSky: '#5d6873', hemiGround: '#202122', hemiI: 0.34, fog: '#0d0f11', fogD: 0.045, exposure: 1.2, envI: 0.6, outdoor: false,
  },
  landfill: {
    skyTop: '#80837b', skyHorizon: '#c2b69c', skyGround: '#4c4337', sunDir: [0.35, 0.62, -0.5], sun: '#f4e7cf', sunI: 1.9,
    hemiSky: '#b1ad9f', hemiGround: '#463b2e', hemiI: 0.8, fog: '#ada38d', fogD: 0.03, exposure: 1.0, envI: 0.85, outdoor: true,
  },
  forgotten: {
    skyTop: '#272550', skyHorizon: '#f08a4b', skyGround: '#3a2a22', sunDir: [0.85, 0.2, -0.3], sun: '#ff9d5c', sunI: 2.6,
    hemiSky: '#7a6a9a', hemiGround: '#3c2a20', hemiI: 0.55, fog: '#8f5f4f', fogD: 0.022, exposure: 1.05, envI: 1.0, outdoor: true,
  },
};

function skyMaterial(L) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      top: { value: new THREE.Color(L.skyTop) }, horizon: { value: new THREE.Color(L.skyHorizon) }, bottom: { value: new THREE.Color(L.skyGround) },
      sunDir: { value: new THREE.Vector3(...L.sunDir).normalize() }, sunCol: { value: new THREE.Color(L.sun) }, sunStrength: { value: L.outdoor ? 1 : 0 },
    },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 top, horizon, bottom, sunDir, sunCol; uniform float sunStrength; varying vec3 vDir;
      void main(){ float h = vDir.y;
        vec3 c = h > 0.0 ? mix(horizon, top, pow(clamp(h,0.0,1.0), 0.55)) : mix(horizon, bottom, pow(clamp(-h*3.0,0.0,1.0), 0.6));
        float s = max(dot(normalize(vDir), sunDir), 0.0);
        c += sunCol * (pow(s, 900.0) * 30.0 + pow(s, 12.0) * 0.35) * sunStrength;
        gl_FragColor = vec4(c, 1.0); }`,
  });
}

export function createGroundMaterial(lookKey) {
  const { map, normal } = groundTextures(lookKey);
  return new THREE.MeshStandardMaterial({ map, normalMap: normal, normalScale: new THREE.Vector2(1.1, 1.1), roughness: lookKey === 'facility' ? 0.7 : 0.97, metalness: 0, envMapIntensity: 0.5 });
}

// Environment map: render the sky (plus a few bright cloud/lamp patches) into a PMREM.
function buildEnv(renderer, L) {
  const s = new THREE.Scene();
  s.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), skyMaterial(L)));
  if (!L.outdoor) {
    for (let k = 0; k < 6; k++) {
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(14, 0.6), new THREE.MeshBasicMaterial({ color: new THREE.Color(L.sun).multiplyScalar(5), side: THREE.DoubleSide }));
      strip.position.set(-15 + k * 6, 12, 0);
      strip.rotation.x = Math.PI / 2;
      s.add(strip);
    }
  } else {
    for (let k = 0; k < 5; k++) {
      const cl = new THREE.Mesh(new THREE.SphereGeometry(4 + k, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(L.skyHorizon).multiplyScalar(1.6) }));
      const a = k * 1.3;
      cl.position.set(Math.cos(a) * 35, 14 + k * 2, Math.sin(a) * 35);
      cl.scale.y = 0.35;
      s.add(cl);
    }
  }
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(s, 0.03);
  pm.dispose();
  return rt.texture;
}

function atlasMat() {
  const A = getAtlas();
  return new THREE.MeshStandardMaterial({ map: A.map, normalMap: A.normalMap, roughnessMap: A.roughMetal, metalnessMap: A.roughMetal, roughness: 1, metalness: 1 });
}
function boxUV(w, h, d, slot) {
  const g = prep(new THREE.BoxGeometry(w, h, d));
  tileUV(g, slot);
  return g;
}

export function buildWorld(area, renderer, pile, groundMaterial) {
  const L = LOOKS[area.look];
  const group = new THREE.Group();
  const r = mulberry(area.id.length * 1009 + 7);
  const A = getAtlas();
  const amat = atlasMat();
  const clickables = [];
  const updaters = [];

  // sky dome
  const sky = new THREE.Mesh(new THREE.SphereGeometry(90, 32, 16), skyMaterial(L));
  sky.renderOrder = -1;
  group.add(sky);
  const env = buildEnv(renderer, L);

  // lights
  const sun = new THREE.DirectionalLight(L.sun, L.sunI);
  sun.position.set(...L.sunDir).normalize().multiplyScalar(18);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -9; sc.right = 9; sc.top = 9; sc.bottom = -9; sc.near = 1; sc.far = 45;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 3;
  group.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(L.hemiSky, L.hemiGround, L.hemiI);
  group.add(hemi);

  // ground with a hole where the diggable patch sits
  {
    const S = 0.9, half = 72, patchHalf = pile.N * CELL / 2 - S; // overlap the patch by one world cell
    const n = Math.round(half * 2 / S);
    const pos = [], uv = [], idx = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
      const x = -half + i * S, z = -half + j * S;
      const far = Math.max(0, Math.hypot(x, z) - 20);
      const y = terrainHeight(x, z, pile.terrainSeed) + (L.outdoor ? far * far * 0.012 + fbm3(x * 0.03, 0, z * 0.03, 5) * far * 0.08 : 0);
      pos.push(x, y, z);
      uv.push(x / 4, z / 4);
    }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x0 = -half + i * S, z0 = -half + j * S;
      if (x0 >= -patchHalf && x0 + S <= patchHalf && z0 >= -patchHalf && z0 + S <= patchHalf) continue;
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const ground = new THREE.Mesh(g, groundMaterial);
    ground.receiveShadow = true;
    group.add(ground);
  }

  // ---- loose junk scattered around the yard (decor) ------------------------------
  {
    const keys = Object.keys(pile.lib);
    const perVariant = new Map();
    const count = area.look === 'landfill' ? 2600 : area.look === 'facility' ? 700 : 1100;
    for (let k = 0; k < count; k++) {
      const key = r.weighted(area.junk);
      if (!keys.includes(key)) continue;
      const v = r.int(0, pile.lib[key].length - 1);
      const a = r() * Math.PI * 2;
      const minR = pile.N * CELL / 2 + 0.6;
      const d = minR + Math.pow(r(), 1.6) * (area.look === 'facility' ? 6 : 26);
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      if (Math.abs(x) < pile.N * CELL / 2 + 0.3 && Math.abs(z) < pile.N * CELL / 2 + 0.3) continue;
      const list = perVariant.get(key + v) || [];
      list.push([x, z, r() * Math.PI * 2, r.range(0.8, 1.2), key, v]);
      perVariant.set(key + v, list);
    }
    for (const list of perVariant.values()) {
      const [, , , , key, v] = list[0];
      const im = new THREE.InstancedMesh(pile.lib[key][v].geo, pile.meshes[0].material, list.length);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
      list.forEach(([x, z, rot, s], i) => {
        const far = Math.max(0, Math.hypot(x, z) - 20);
        const y = terrainHeight(x, z, pile.terrainSeed) + (L.outdoor ? far * far * 0.012 + fbm3(x * 0.03, 0, z * 0.03, 5) * far * 0.08 : 0) - 0.02;
        q.setFromEuler(new THREE.Euler(r.range(-0.2, 0.2), rot, r.range(-0.2, 0.2)));
        m4.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(s, s, s));
        im.setMatrixAt(i, m4);
        im.setColorAt(i, new THREE.Color().setScalar(r.range(0.55, 0.95)));
      });
      im.castShadow = true;
      im.receiveShadow = true;
      group.add(im);
    }
  }

  // ---- set dressing per area -------------------------------------------------------------
  const rustSlot = A.tile('rust', 0), paintSlot = A.tile('rust', 1), zincSlot = A.tile('rust', 2), orangeSlot = A.tile('rust', 3);
  const addMesh = (g, m = amat, cast = true) => { const o = new THREE.Mesh(g, m); o.castShadow = cast; o.receiveShadow = true; group.add(o); return o; };
  const at = (o, x, z, rot = 0, yOff = 0) => { o.position.set(x, terrainHeight(x, z, pile.terrainSeed) + yOff, z); o.rotation.y = rot; return o; };

  // Huts: the refinery (gold buyer) and the equipment shop
  const hut = (x, z, rot, title, sub, kind, colour) => {
    const h = new THREE.Group();
    const body = new THREE.Mesh(boxUV(4.2, 2.6, 2.6, zincSlot), amat);
    body.position.y = 1.3;
    body.castShadow = body.receiveShadow = true;
    const roof = new THREE.Mesh(boxUV(4.6, 0.14, 3.0, rustSlot), amat);
    roof.position.y = 2.68;
    roof.castShadow = true;
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.95, 2.0, 0.05), new THREE.MeshStandardMaterial({ color: colour, roughness: 0.6, metalness: 0.3 }));
    door.position.set(-1.1, 1.0, 1.31);
    const win = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.8), new THREE.MeshStandardMaterial({ color: 0x0c1012, emissive: 0xffc46b, emissiveIntensity: L.outdoor ? 0.35 : 1.6, roughness: 0.1 }));
    win.position.set(0.8, 1.45, 1.31);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.85), new THREE.MeshStandardMaterial({ map: signTexture([title, sub], { fg: colour }), emissive: 0xffffff, emissiveMap: signTexture([title, sub], { fg: colour }), emissiveIntensity: L.outdoor ? 0.15 : 0.6, roughness: 0.5 }));
    sign.position.set(0, 3.25, 1.2);
    const post = new THREE.Mesh(boxUV(0.1, 0.9, 0.1, rustSlot), amat);
    post.position.set(-1.4, 2.95, 1.2);
    const post2 = post.clone();
    post2.position.x = 1.4;
    const lamp = new THREE.PointLight(0xffc27a, L.outdoor ? 3 : 8, 7, 2);
    lamp.position.set(0, 2.4, 2.2);
    h.add(body, roof, door, win, sign, post, post2, lamp);
    at(h, x, z, rot);
    h.userData.click = kind;
    h.traverse((o) => { if (o.isMesh) o.userData.click = kind; });
    group.add(h);
    clickables.push(h);
    return h;
  };
  hut(-9.5, -7.5, 0.55, 'GOLD BUYER', 'AURUM REFINERY · CASH PAID', 'refinery', '#f2c14e');
  hut(9.5, -8.2, -0.5, 'PROSPECTOR SUPPLY', 'DETECTORS · TOOLS · GEAR', 'shop', '#e8743b');

  const skip = (x, z, rot, slot) => {
    const g = new THREE.Group();
    const parts = [];
    const add = (w, h, d, px, py, pz, rx = 0) => { const b = boxUV(w, h, d, slot); b.rotateX(rx); b.translate(px, py, pz); parts.push(b); };
    add(3.2, 0.08, 1.5, 0, 0.1, 0);
    add(3.6, 1.2, 0.08, 0, 0.7, 0.85, 0.12);
    add(3.6, 1.2, 0.08, 0, 0.7, -0.85, -0.12);
    add(0.08, 1.2, 1.8, 1.75, 0.7, 0);
    add(0.08, 1.2, 1.8, -1.75, 0.7, 0);
    const m = new THREE.Mesh(mergeGeometries(parts), amat);
    m.castShadow = m.receiveShadow = true;
    g.add(m);
    at(g, x, z, rot);
    group.add(g);
  };
  const drum = (x, z, slot, tipped) => {
    const g = prep(new THREE.CylinderGeometry(0.29, 0.29, 0.88, 20, 3));
    tileUV(g, slot);
    const m = addMesh(g);
    at(m, x, z, r() * 6, tipped ? 0.29 : 0.44);
    if (tipped) m.rotation.z = Math.PI / 2;
  };
  const tyreStack = (x, z, n) => {
    const geo = pile.lib.tyre ? pile.lib.tyre[0].geo : prep(new THREE.TorusGeometry(0.26, 0.09, 10, 24)).rotateX(Math.PI / 2);
    for (let k = 0; k < n; k++) {
      const m = new THREE.Mesh(geo, amat);
      m.castShadow = true;
      at(m, x + r.range(-0.05, 0.05), z + r.range(-0.05, 0.05), r() * 6, k * 0.16);
      group.add(m);
    }
  };

  if (area.look !== 'facility') {
    // chain-link perimeter fence
    const ft = fenceTexture();
    const R0 = 16, segs = 40;
    const fenceMat = new THREE.MeshStandardMaterial({ map: ft, alphaTest: 0.4, side: THREE.DoubleSide, metalness: 0.7, roughness: 0.5, transparent: false });
    for (let k = 0; k < segs; k++) {
      const a0 = k / segs * Math.PI * 2, a1 = (k + 1) / segs * Math.PI * 2;
      if (area.look === 'forgotten' && k % 3 !== 0) continue; // broken old fence
      const p0 = new THREE.Vector3(Math.cos(a0) * R0, 0, Math.sin(a0) * R0), p1 = new THREE.Vector3(Math.cos(a1) * R0, 0, Math.sin(a1) * R0);
      const len = p0.distanceTo(p1);
      ft.repeat.set(len / 0.12, 1.9 / 0.12);
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(len, 1.9), fenceMat);
      const mid = p0.clone().add(p1).multiplyScalar(0.5);
      at(panel, mid.x, mid.z, -Math.atan2(p1.z - p0.z, p1.x - p0.x), 1.0);
      group.add(panel);
      const post = addMesh(boxUV(0.07, 2.1, 0.07, zincSlot));
      at(post, p0.x, p0.z, 0, 1.0);
    }
    // floodlight towers
    for (const a of [0.8, 2.6, 4.2]) {
      const x = Math.cos(a) * 15, z = Math.sin(a) * 15;
      const pole = addMesh(prep(new THREE.CylinderGeometry(0.08, 0.12, 7, 10)));
      tileUV(pole.geometry, zincSlot);
      at(pole, x, z, 0, 3.5);
      const head = addMesh(boxUV(0.9, 0.3, 0.4, zincSlot));
      at(head, x, z, -a, 7.0);
    }
  }

  if (area.look === 'dump') {
    skip(7, 6, 0.4, paintSlot);
    skip(-10, 4.5, 1.9, orangeSlot);
    drum(5.6, -10.5, paintSlot, false); drum(6.3, -10.1, rustSlot, true); drum(-6.5, 9.5, orangeSlot, false);
    tyreStack(11, 3, 5); tyreStack(11.6, 3.6, 3);
  } else if (area.look === 'scrapyard') {
    // crushed scrap bales
    for (let k = 0; k < 14; k++) {
      const a = r() * Math.PI * 2, d = r.range(9, 14);
      const g = boxUV(1.2, 0.7, 0.8, r.pick([rustSlot, paintSlot, orangeSlot, zincSlot]));
      const m = addMesh(g);
      at(m, Math.cos(a) * d, Math.sin(a) * d, r() * 6, 0.35 + (k % 3 === 0 ? 0.7 : 0));
    }
    // crane
    const crane = new THREE.Group();
    const lattice = (len, w) => { const parts = []; for (let i = 0; i < len / 0.8; i++) { for (const [x, z] of [[-w, -w], [w, -w], [-w, w], [w, w]]) { const b = new THREE.BoxGeometry(0.06, 0.8, 0.06); b.translate(x, i * 0.8 + 0.4, z); parts.push(b.toNonIndexed()); } const brace = new THREE.BoxGeometry(0.04, 1.1, 0.04); brace.rotateZ(0.8); brace.translate(0, i * 0.8 + 0.4, w); parts.push(brace.toNonIndexed()); } return mergeGeometries(parts); };
    const cmat = new THREE.MeshStandardMaterial({ color: 0xd9a21c, roughness: 0.6, metalness: 0.4 });
    const tower = new THREE.Mesh(lattice(14, 0.5), cmat);
    const boom = new THREE.Mesh(lattice(18, 0.35), cmat);
    boom.rotation.z = -Math.PI / 2 + 0.25;
    boom.position.y = 13.5;
    crane.add(tower, boom);
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 9), new THREE.MeshStandardMaterial({ color: 0x222222 }));
    cable.position.set(12, 9.5, 0);
    crane.add(cable);
    at(crane, -14, 12, 0.6);
    crane.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    group.add(crane);
    updaters.push((t) => { boom.rotation.y = Math.sin(t * 0.05) * 0.4; });
    tyreStack(8, 9, 6); tyreStack(8.6, 9.4, 4); tyreStack(-9, -3, 5);
    drum(10, -3, rustSlot, true); drum(10.4, -2.3, paintSlot, false);
    skip(-6, 10.5, 0.2, rustSlot);
  } else if (area.look === 'landfill') {
    // vast mounds of buried waste on the horizon, covered with scattered junk instances
    for (let k = 0; k < 9; k++) {
      const a = k / 9 * Math.PI * 2 + r.range(-0.2, 0.2), d = r.range(20, 30);
      const g = new THREE.SphereGeometry(r.range(6, 10), 24, 12, 0, Math.PI * 2, 0, Math.PI / 2);
      const p = g.getAttribute('position');
      for (let i = 0; i < p.count; i++) { const v = new THREE.Vector3().fromBufferAttribute(p, i); const n = fbm3(v.x * 0.2, v.y * 0.2, v.z * 0.2, k, 3); p.setY(i, v.y * 0.45 * (1 + n * 0.5)); }
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, groundMaterial);
      m.receiveShadow = true;
      at(m, Math.cos(a) * d, Math.sin(a) * d, 0, -0.5);
      group.add(m);
    }
    // methane vent pipes
    for (let k = 0; k < 6; k++) {
      const a = r() * Math.PI * 2, d = r.range(9, 14);
      const pipe = addMesh(prep(new THREE.CylinderGeometry(0.08, 0.08, 1.4, 12)));
      tileUV(pipe.geometry, zincSlot);
      at(pipe, Math.cos(a) * d, Math.sin(a) * d, 0, 0.7);
      const cap = addMesh(boxUV(0.25, 0.06, 0.25, rustSlot));
      at(cap, Math.cos(a) * d, Math.sin(a) * d, 0, 1.45);
    }
    skip(9, 7, 0.9, orangeSlot);
  } else if (area.look === 'facility') {
    // the hall: walls, columns, ceiling with fluorescent strips, server racks
    const hallMat = new THREE.MeshStandardMaterial({ color: 0x5a5d60, roughness: 0.85, metalness: 0.1, side: THREE.BackSide });
    const hall = new THREE.Mesh(new THREE.BoxGeometry(34, 9, 30), hallMat);
    hall.position.y = 4.4;
    hall.receiveShadow = true;
    group.add(hall);
    for (let k = 0; k < 6; k++) {
      for (const z of [-8, 0, 8]) {
        const strip = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.06, 0.25), new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xdde8ff, emissiveIntensity: k % 4 === 1 && z === 0 ? 0.05 : 2.4 }));
        strip.position.set(-12.5 + k * 5, 8.6, z);
        group.add(strip);
      }
    }
    // a few working lamps light the floor
    for (const [x, z] of [[-7.5, -8], [2.5, 0], [-2.5, 8], [7.5, -8]]) {
      const pl = new THREE.PointLight(0xdbe6ff, 22, 18, 1.7);
      pl.position.set(x, 8.2, z);
      group.add(pl);
    }
    const flick = new THREE.PointLight(0xdbe6ff, 6, 10, 2);
    flick.position.set(-7.5, 8.2, 0);
    group.add(flick);
    updaters.push((t) => { flick.intensity = Math.sin(t * 37) > 0.7 || Math.sin(t * 3.1) > 0.95 ? 0.2 : 6; });
    for (const x of [-12, -4, 4, 12]) for (const z of [-11, 11]) { const col = addMesh(boxUV(0.6, 9, 0.6, A.tile('stone', 1))); col.position.set(x, 4.4, z); }
    for (let k = 0; k < 8; k++) {
      const rack = new THREE.Group();
      const body = new THREE.Mesh(boxUV(0.65, 2.0, 1.0, A.tile('rust', 2)), amat);
      body.position.y = 1.0;
      const front = new THREE.Mesh(boxUV(0.02, 1.8, 0.9, A.tile('pcb', k % 2)), amat);
      front.position.set(0.34, 1.0, 0);
      rack.add(body, front);
      rack.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
      const side = k < 4 ? -1 : 1;
      at(rack, side * 13, -9 + (k % 4) * 6, side > 0 ? Math.PI : 0, 0);
      if (k === 2) rack.rotation.z = 0.4;
      group.add(rack);
    }
    drum(9, 8, zincSlot, false); drum(9.5, 8.6, rustSlot, false);
  } else if (area.look === 'forgotten') {
    const stone = A.tile('stone', 0);
    for (let k = 0; k < 12; k++) {
      const a = k / 12 * Math.PI * 2 + 0.2, d = r.range(10, 15);
      const h = r.range(1.2, 4.5);
      const g = prep(new THREE.CylinderGeometry(0.38, 0.42, h, 18, 6));
      tileUV(g, stone);
      const p = g.getAttribute('position');
      for (let i = 0; i < p.count; i++) if (p.getY(i) > h / 2 - 0.01) p.setY(i, p.getY(i) - Math.abs(fbm3(p.getX(i) * 6, 0, p.getZ(i) * 6, k)) * 0.6);
      g.computeVertexNormals();
      const col = addMesh(g);
      at(col, Math.cos(a) * d, Math.sin(a) * d, r() * 6, h / 2 - 0.1);
      if (k % 3 === 0) { col.rotation.z = Math.PI / 2; col.position.y = 0.3; }
      const base = addMesh(boxUV(1.0, 0.3, 1.0, stone));
      at(base, Math.cos(a) * d, Math.sin(a) * d, r() * 6, 0.1);
    }
    for (let k = 0; k < 3; k++) {
      const wall = addMesh(boxUV(r.range(3, 6), r.range(1, 2.4), 0.6, stone));
      const a = r() * Math.PI * 2;
      at(wall, Math.cos(a) * 12, Math.sin(a) * 12, -a + Math.PI / 2, 0.6);
    }
    // braziers flicker in the dusk
    for (const [x, z] of [[6.5, 7.5], [-7.5, 6.5], [7.5, -6]]) {
      const fire = new THREE.PointLight(0xff8a3a, 6, 9, 2);
      fire.position.set(x, terrainHeight(x, z, pile.terrainSeed) + 1.2, z);
      group.add(fire);
      const bowl = addMesh(prep(new THREE.CylinderGeometry(0.35, 0.15, 0.3, 12)));
      tileUV(bowl.geometry, rustSlot);
      at(bowl, x, z, 0, 0.95);
      const legs = addMesh(prep(new THREE.CylinderGeometry(0.04, 0.04, 0.9, 6)));
      tileUV(legs.geometry, rustSlot);
      at(legs, x, z, 0, 0.45);
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.5, 10), new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending }));
      at(flame, x, z, 0, 1.35);
      group.add(flame);
      updaters.push((t) => { const f = 0.8 + Math.sin(t * 11 + x) * 0.15 + Math.sin(t * 23 + z) * 0.1; fire.intensity = 6 * f; flame.scale.set(1, f * 1.1, 1); });
    }
  }

  // ---- ambient life: dust motes and gulls ---------------------------------------------
  {
    const n = 500, p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { p[i * 3] = r.range(-14, 14); p[i * 3 + 1] = r.range(0.2, 6); p[i * 3 + 2] = r.range(-14, 14); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    const dust = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.05, map: softDot(), transparent: true, opacity: L.outdoor ? 0.35 : 0.55, depthWrite: false, color: L.outdoor ? 0xfff2dc : 0xcfe0ff }));
    group.add(dust);
    updaters.push((t, dt) => {
      const a = g.getAttribute('position');
      for (let i = 0; i < n; i++) {
        let y = a.getY(i) + dt * (0.05 + Math.sin(i + t * 0.3) * 0.03);
        if (y > 6) y = 0.2;
        a.setXYZ(i, a.getX(i) + Math.sin(t * 0.2 + i) * dt * 0.08, y, a.getZ(i) + Math.cos(t * 0.17 + i * 1.3) * dt * 0.08);
      }
      a.needsUpdate = true;
    });
  }
  if (area.look === 'dump' || area.look === 'landfill') {
    const gullMat = new THREE.MeshStandardMaterial({ color: 0xeeeeea, roughness: 0.8, side: THREE.DoubleSide });
    const gulls = [];
    for (let k = 0; k < 7; k++) {
      const gg = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.22, 4, 8), gullMat);
      body.rotation.z = Math.PI / 2;
      gg.add(body);
      const wings = [];
      for (const s of [-1, 1]) {
        const w = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.14), gullMat);
        w.geometry.translate(0.25, 0, 0);
        const piv = new THREE.Group();
        piv.rotation.y = s > 0 ? -Math.PI / 2 : Math.PI / 2;
        w.rotation.x = -Math.PI / 2;
        piv.add(w);
        gg.add(piv);
        wings.push([piv, s]);
      }
      group.add(gg);
      gulls.push({ g: gg, wings, r: r.range(7, 16), h: r.range(6, 11), sp: r.range(0.12, 0.25) * r.sign(), ph: r() * 6 });
    }
    updaters.push((t) => {
      for (const b of gulls) {
        const a = b.ph + t * b.sp;
        b.g.position.set(Math.cos(a) * b.r, b.h + Math.sin(t * 0.7 + b.ph) * 0.6, Math.sin(a) * b.r);
        b.g.rotation.y = -a + (b.sp > 0 ? 0 : Math.PI);
        const flap = Math.sin(t * 7 + b.ph) * 0.45;
        for (const [piv, s] of b.wings) piv.rotation.z = flap * s;
      }
    });
  }

  return {
    group, sun, hemi, env, look: L, clickables,
    update(t, dt) { for (const u of updaters) u(t, dt); },
    dispose() { group.traverse((o) => { if (o.isMesh || o.isPoints) { o.geometry.dispose(); } }); env.dispose(); },
  };
}
