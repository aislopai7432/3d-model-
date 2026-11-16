const R = new URL('../src/', import.meta.url).href;
const { ZMap } = await import(R + 'sim/zmap.js');
const { makeCutter } = await import(R + 'sim/tooling.js');
let fail = 0;
const near = (a, b, tol, m) => { const ok = Math.abs(a - b) <= tol; console.log((ok ? 'ok   ' : 'FAIL ') + m + ` got=${a.toFixed(2)} want=${b.toFixed(2)}`); if (!ok) fail++; };
const mk = (cell = 0.1) => new ZMap({ x0: 0, y0: 0, lx: 100, ly: 50, top: 20, bottom: 0, cell, maxNodes: 2e6 });
const flat10 = makeCutter({ type: 'flat', diameter: 10, fluteLength: 25, length: 100, flutes: 3 });
let z = mk();
let v = z.sweep(10, 25, 18, 90, 25, 18, flat10);
near(v, (800 + Math.PI * 25) * 2, 25, 'flat slot volume (node sampling, ~1%)');
near(z.heightAt(50, 25), 18, 1e-6, 'slot floor height');
near(z.heightAt(50, 31), 20, 1e-6, 'outside slot untouched');
near(z.volume, 100 * 50 * 20 - v, 1e-3, 'volume bookkeeping');
const ball8 = makeCutter({ type: 'ball', diameter: 8, fluteLength: 20, length: 90, flutes: 2 });
z = mk(0.05);
v = z.sweep(50, 25, 17, 50, 25, 17, ball8);
near(v, Math.PI * 9 * (12 - 3) / 3, 1.0, 'ball plunge cap volume');
const drill = makeCutter({ type: 'drill', diameter: 6.8, tipAngle: 118, fluteLength: 45, length: 120, flutes: 2 });
z = mk(0.05);
v = z.sweep(50, 25, 25, 50, 25, 10, drill);
const tip = 3.4 / Math.tan(59 * Math.PI / 180);
near(v, Math.PI * 3.4 * 3.4 * (10 - tip) + Math.PI * 3.4 * 3.4 * tip / 3, 2, 'drill plunge volume');
near(z.heightAt(50, 25), 10, 1e-6, 'drill point depth');
// ramp: flat cutter ramp centre-line heights
z = mk(0.1);
z.sweep(10, 25, 20, 50, 25, 18, flat10);
near(z.heightAt(30, 25), 18.75, 0.02, 'ramp mid height (leading edge lowers floor) ');
// helix vs dense point sampling for ball cutter
function pathSweep(zm, pts, c) { for (let i = 1; i < pts.length; i++) zm.sweep(...pts[i - 1], ...pts[i], c); }
const helix = []; for (let k = 0; k <= 400; k++) { const a = k / 400 * Math.PI * 4; helix.push([50 + 6 * Math.cos(a), 25 + 6 * Math.sin(a), 20 - 4 * k / 400]); }
const zA = mk(0.2), zB = mk(0.2);
pathSweep(zA, helix, ball8);
for (let k = 0; k < 400 * 20; k++) { const f = k / (400 * 20); const a = f * Math.PI * 4; zB.sweep(50 + 6 * Math.cos(a), 25 + 6 * Math.sin(a), 20 - 4 * f, 50 + 6 * Math.cos(a), 25 + 6 * Math.sin(a), 20 - 4 * f, ball8); }
let md = 0; for (let i = 0; i < zA.h.length; i++) md = Math.max(md, Math.abs(zA.h[i] - zB.h[i]));
near(md, 0, 0.08, 'helix sweep matches dense point sampling (max diff)');
// shank collision detection
z = mk(0.2); z.shankExcess = 0;
const short = makeCutter({ type: 'flat', diameter: 6, fluteLength: 5, length: 70, flutes: 3 });
z.sweep(20, 25, 25, 20, 25, 12, short);
console.log((z.shankExcess > 0 ? 'ok   ' : 'FAIL ') + 'shank excess detected ' + z.shankExcess.toFixed(2)); if (!(z.shankExcess > 0)) fail++;
// perf: facing with face mill over 120x80 at balanced resolution
const face = makeCutter({ type: 'face', diameter: 50, cornerRadius: 0.8, fluteLength: 6, length: 95, flutes: 5 });
const zf = new ZMap({ x0: -60, y0: -40, lx: 120, ly: 80, top: 0, bottom: -30, cell: 0.35, maxNodes: 200000 });
let t0 = performance.now();
for (const y of [-25, 0, 25]) zf.sweep(-90, y, -1, 90, y, -1, face);
console.log(`perf: facing 3 passes on ${zf.nx}x${zf.ny} nodes: ${(performance.now() - t0).toFixed(1)} ms, removed ${zf.removedTotal.toFixed(0)} mm3 (expect ~${120 * 80})`);
t0 = performance.now();
// pocket: many small segments (like per-frame sub-steps)
let n = 0; for (let k = 0; k < 20000; k++) { const a = k * 0.002; zf.sweep(30 * Math.cos(a), 20 * Math.sin(a), -3, 30 * Math.cos(a + 0.002), 20 * Math.sin(a + 0.002), -3, flat10); n++; }
console.log(`perf: ${n} short segments: ${(performance.now() - t0).toFixed(1)} ms`);
console.log(fail ? `${fail} FAILURES` : "ALL OK");
if (fail) process.exitCode = 1;
