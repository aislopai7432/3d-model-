// Photography studio: HDR environment baked from emissive softboxes, a polished
// floor with a planar reflection, and a blurred contact shadow under the car.
import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { HorizontalBlurShader } from 'three/addons/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/addons/shaders/VerticalBlurShader.js';

export const BG = new THREE.Color(0x0a0b0d);

function softbox(w, h, intensity, color = 0xffffff) {
  const c = new THREE.Color(color).multiplyScalar(intensity);
  const m = new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide });
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
}

// Gradient softbox: brighter centre, falling off to the edges like real diffusion fabric.
function gradientBox(w, h, intensity) {
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 64;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 4, 32, 32, 34);
  g.addColorStop(0, '#fff');
  g.addColorStop(0.75, '#bbb');
  g.addColorStop(1, '#333');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(cv);
  const m = new THREE.MeshBasicMaterial({ map: t, color: new THREE.Color(intensity, intensity, intensity), side: THREE.DoubleSide });
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
}

export function buildEnvironment(renderer) {
  const env = new THREE.Scene();
  env.background = new THREE.Color(0x060607);
  const room = new THREE.Mesh(new THREE.SphereGeometry(40, 32, 16), new THREE.MeshBasicMaterial({ color: 0x0b0b0c, side: THREE.BackSide }));
  env.add(room);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(40, 32), new THREE.MeshBasicMaterial({ color: 0x050505 }));
  floor.rotation.x = -Math.PI / 2;
  env.add(floor);

  // Large overhead scrim: the long highlight that runs along bonnet and roof.
  const top = gradientBox(10, 3.6, 5.5);
  top.position.set(0, 7, 0);
  top.rotation.x = Math.PI / 2;
  env.add(top);
  // Two long strip lights each side: crisp lines down the flanks.
  for (const s of [1, -1]) {
    const strip = softbox(9, 0.45, 9);
    strip.position.set(0, 2.6, 6.5 * s);
    strip.lookAt(0, 0.6, 0);
    env.add(strip);
    const strip2 = softbox(9, 0.22, 6);
    strip2.position.set(0, 4.6, 5.8 * s);
    strip2.lookAt(0, 0.6, 0);
    env.add(strip2);
  }
  // Key softbox front-left and a warm kicker rear-right.
  const key = gradientBox(4, 3, 3.2);
  key.position.set(7, 3.5, 4);
  key.lookAt(0, 0.8, 0);
  env.add(key);
  const kick = softbox(3, 2, 2.2, 0xffd9b0);
  kick.position.set(-7, 2.5, -4);
  kick.lookAt(0, 0.8, 0);
  env.add(kick);
  // Low fill bouncing off the floor
  const fill = softbox(14, 3, 0.35);
  fill.position.set(0, 0.6, -9);
  fill.lookAt(0, 0.6, 0);
  env.add(fill);
  const fill2 = fill.clone();
  fill2.position.set(0, 0.6, 9);
  fill2.lookAt(0, 0.6, 0);
  env.add(fill2);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(env, 0.02);
  pmrem.dispose();
  return rt.texture;
}

function radialAlpha(inner, outer) {
  const s = 512, cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, s / 2 * inner, s / 2, s / 2, s / 2 * outer);
  g.addColorStop(0, '#000');
  g.addColorStop(1, '#fff');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(cv);
  return t;
}

export function buildFloor(scene, { pixelRatio = 1 } = {}) {
  const group = new THREE.Group();
  scene.add(group);
  let reflector = null;
  {
    reflector = new Reflector(new THREE.CircleGeometry(30, 64), {
      textureWidth: Math.round(window.innerWidth * pixelRatio * 0.5),
      textureHeight: Math.round(window.innerHeight * pixelRatio * 0.5),
      color: 0x8a8a8a,
      clipBias: 0.002,
    });
    reflector.rotation.x = -Math.PI / 2;
    reflector.position.y = -0.006;
    group.add(reflector);
  }
  // Satin floor on top of the mirror; its alpha lets ~12% of the reflection through
  // near the car and fades fully into the backdrop further away.
  const fade = radialAlpha(0.12, 1.0);
  const floorMat = new THREE.MeshStandardMaterial({
    color: BG.clone(),
    roughness: 0.5,
    envMapIntensity: 0.35,
    metalness: 0,
    transparent: true,
    opacity: 1,
    alphaMap: null,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  // Opacity grows with distance: use the fade texture as alpha, offset by a base value.
  const baseAlpha = { value: 0.88 };
  floorMat.onBeforeCompile = (sh) => {
    sh.uniforms.fadeMap = { value: fade };
    sh.uniforms.baseAlpha = baseAlpha;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D fadeMap;\nuniform float baseAlpha;\nvarying vec2 vFloorUv;')
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor.a = mix(baseAlpha, 1.0, texture2D(fadeMap, vFloorUv).r);');
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vFloorUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvFloorUv = uv;');
  };
  const floor = new THREE.Mesh(new THREE.CircleGeometry(30, 96), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = false;
  floor.renderOrder = 0;
  group.add(floor);
  group.userData = {
    reflector, floor, floorMat,
    setReflections(on) {
      reflector.visible = on;
      baseAlpha.value = on ? 0.88 : 1.0;
    },
  };
  return group;
}

// Contact shadow, after the three.js "shadow contact" technique: render the car's
// depth from below into a texture, blur it twice and lay it on the floor.
export function buildContactShadow(renderer, scene, hideList) {
  const W = 6.4, H = 3.6, CH = 1.4;
  const group = new THREE.Group();
  const rt = new THREE.WebGLRenderTarget(1024, 576);
  rt.texture.generateMipmaps = false;
  const rtBlur = new THREE.WebGLRenderTarget(1024, 576);
  rtBlur.texture.generateMipmaps = false;
  const planeGeo = new THREE.PlaneGeometry(W, H).rotateX(Math.PI / 2);
  const plane = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial({ map: rt.texture, opacity: 0.92, transparent: true, depthWrite: false }));
  plane.renderOrder = 1;
  plane.scale.y = -1;
  plane.position.y = 0.001;
  group.add(plane);
  const blurPlane = new THREE.Mesh(planeGeo);
  blurPlane.visible = false;
  group.add(blurPlane);
  const cam = new THREE.OrthographicCamera(-W / 2, W / 2, H / 2, -H / 2, 0, CH);
  cam.rotation.x = Math.PI / 2;
  group.add(cam);

  const depthMat = new THREE.MeshDepthMaterial();
  depthMat.userData.darkness = { value: 1.35 };
  depthMat.onBeforeCompile = (sh) => {
    sh.uniforms.darkness = depthMat.userData.darkness;
    sh.fragmentShader = `uniform float darkness;\n${sh.fragmentShader.replace(
      'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
      'gl_FragColor = vec4( vec3( 0.0 ), pow( 1.0 - fragCoordZ, 2.2 ) * darkness );'
    )}`;
  };
  depthMat.side = THREE.DoubleSide;

  const hBlur = new THREE.ShaderMaterial(HorizontalBlurShader);
  hBlur.depthTest = false;
  const vBlur = new THREE.ShaderMaterial(VerticalBlurShader);
  vBlur.depthTest = false;

  function blur(amount) {
    blurPlane.visible = true;
    blurPlane.material = hBlur;
    hBlur.uniforms.tDiffuse.value = rt.texture;
    hBlur.uniforms.h.value = amount / 256;
    renderer.setRenderTarget(rtBlur);
    renderer.render(blurPlane, cam);
    blurPlane.material = vBlur;
    vBlur.uniforms.tDiffuse.value = rtBlur.texture;
    vBlur.uniforms.v.value = amount / 256;
    renderer.setRenderTarget(rt);
    renderer.render(blurPlane, cam);
    blurPlane.visible = false;
  }

  function update() {
    const bg = scene.background;
    scene.background = null;
    const vis = hideList.map((o) => o.visible);
    hideList.forEach((o) => (o.visible = false));
    plane.visible = false;
    scene.overrideMaterial = depthMat;
    const clearAlpha = renderer.getClearAlpha();
    renderer.setClearAlpha(0);
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(scene, cam);
    scene.overrideMaterial = null;
    blur(0.9);
    blur(0.45);
    blur(0.25);
    renderer.setRenderTarget(null);
    renderer.setClearAlpha(clearAlpha);
    scene.background = bg;
    hideList.forEach((o, k) => (o.visible = vis[k]));
    plane.visible = true;
  }
  group.userData.update = update;
  return group;
}
