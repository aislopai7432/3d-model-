const R = new URL('../src/', import.meta.url).href;
const { compileProgram } = await import(R + 'gcode/compile.js');
const { DEFAULT_TOOLS, MACHINE } = await import(R + 'config.js');
const { ZMap } = await import(R + 'sim/zmap.js');
const { makeCutter } = await import(R + 'sim/tooling.js');
const tools = new Map(DEFAULT_TOOLS.map((t) => [t.number, { ...t }]));
const offsets = [{ x: -203, y: -178, z: -351 }, ...Array(5).fill(0).map(() => ({ x: 0, y: 0, z: 0 }))];
let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
const comp = (code, extra = {}) => compileProgram(code, { tools, offsets, requireG43: true, arcTol: 0.005, dialect: 'siemens', ...extra }, { pos: { x: 0, y: 0, z: 0 }, tool: 2 });
const last = (r) => { const m = r.ops.filter((o) => o.t === 'move').pop(); const p = m.pts.slice(-3); return { x: p[0] - offsets[0].x, y: p[1] - offsets[0].y, z: p[2] - offsets[0].z }; };
// expressions
let r = comp('G54 D1\nR1=2*SIN(30)+POT(3)\nG0 X=R1 Y=-R1/2 Z=10\nM30');
let p = last(r);
ok(!r.errors.length && Math.abs(p.x - 10) < 1e-9 && Math.abs(p.y + 5) < 1e-9 && Math.abs(p.z - (10 + 100)) < 1e-9, `R-parameter expression X=${p.x} Y=${p.y} Zgauge=${p.z}`);
// AC / IC
r = comp('G54 D1\nG0 X10 Y10 Z10\nG91 G0 X5 Y=AC(0)\nM30'); p = last(r);
ok(Math.abs(p.x - 15) < 1e-9 && Math.abs(p.y) < 1e-9, `G91 with Y=AC(0): X=${p.x} Y=${p.y}`);
// frames
r = comp('G54 D1\nTRANS X10 Y5\nAROT RPL=90\nG0 X10 Y0 Z10\nM30'); p = last(r);
ok(Math.abs(p.x - 10) < 1e-9 && Math.abs(p.y - 15) < 1e-9, `TRANS + AROT 90: X=${p.x.toFixed(3)} Y=${p.y.toFixed(3)} (want 10, 15)`);
// arc with CR and helix TURN
r = comp('G54 D1\nG0 X0 Y0 Z5\nG1 X10 F100\nG2 X10 Y0 I-10 J0 Z0 TURN=2\nM30');
ok(!r.errors.length, 'G2 helix with TURN=2 compiles');
// errors
r = comp('G54 D1\nGOTOF NOPE\nM30'); ok(r.errors[0]?.msg.startsWith('14080'), 'missing label -> ' + r.errors[0]?.msg);
r = comp('G54 D1\nG0 X0 Y0\nG2 X50 Y0 CR=10 F100\nM30'); ok(r.errors[0]?.msg.startsWith('14040'), 'bad CR -> ' + r.errors[0]?.msg);
r = comp('G54 D1\nG0 X0 Y0 Z5\nCYCLE81(10,0,2,-5)\nM30'); ok(r.errors[0]?.msg.startsWith('61102'), 'cycle without spindle -> ' + r.errors[0]?.msg);
r = comp('G54\nFOO=3\nM30'); ok(r.errors.length && /12550/.test(r.errors[0].msg), 'unknown name -> ' + r.errors[0]?.msg);
r = comp('G54 D1\nR1=0\nLBL:\nR1=R1+1\nGOTOB LBL\nM30'); ok(r.errors.length && /loop/i.test(r.errors[0].msg), 'infinite loop detected -> ' + r.errors[0]?.msg.slice(0, 40));
r = comp('G43 H1\nM30'); ok(r.errors.length && /D1/.test(r.errors[0].msg), 'G43 in Siemens mode explained -> ' + r.errors[0]?.msg.slice(0, 60));
r = comp('G291\nG90 G54 G0 X0 Y0\nM30'); ok(r.dialect === 'iso' && !r.errors.length, 'G291 selects ISO dialect');
// CRC geometry: square 40x40 contour clockwise with G41 => outside; check cut part dimensions via Z-map
const t2 = makeCutter(tools.get(2));
function cut(code) {
  const res = comp(code);
  if (res.errors.length) { console.log(res.errors); return null; }
  const z = new ZMap({ x0: -40, y0: -40, lx: 80, ly: 80, top: 132, bottom: 100, cell: 0.1, maxNodes: 2e6 });
  for (const op of res.ops) {
    if (op.t !== 'move') continue;
    for (let i = 3; i < op.pts.length; i += 3) {
      const L = op.tlen;
      z.sweep(op.pts[i - 3] + 203, op.pts[i - 2] + 178, 483 + op.pts[i - 1] - L, op.pts[i] + 203, op.pts[i + 1] + 178, 483 + op.pts[i + 2] - L, t2);
    }
  }
  return z;
}
let zm = cut('G54 T2 D1 M6\nS5000 M3\nG0 X-35 Y-35 Z5\nG1 Z-3 F500\nG41 G1 X-20 Y-20 F1000\nY20\nX20\nY-20\nX-20\nG40 G1 X-35 Y-35\nG0 Z20\nM30');
const top = 132;
const h = (x, y) => zm.heightAt(x, y) - top;
ok(zm && Math.abs(h(19.8, 0)) < 1e-6 && Math.abs(h(20.25, 0) + 3) < 1e-6 && Math.abs(h(0, 19.8)) < 1e-6 && Math.abs(h(-20.25, 0) + 3) < 1e-6, `G41 outside square keeps a 40x40 part: h(19.8)=${h(19.8, 0)} h(20.25)=${h(20.25, 0)}`);
ok(Math.abs(h(21.5, 21.5) + 3) < 1e-6 && Math.abs(h(19.9, 19.9)) < 1e-6, `convex corner rounded by transition arc: corner h=${h(19.9, 19.9)} outside=${h(21.5, 21.5)}`);
// wear: delta radius +0.2 leaves the part 0.2 bigger per side
tools.get(2).dRadius = 0.2;
zm = cut('G54 T2 D1 M6\nS5000 M3\nG0 X-35 Y-35 Z5\nG1 Z-3 F500\nG41 G1 X-20 Y-20 F1000\nY20\nX20\nY-20\nX-20\nG40 G1 X-35 Y-35\nG0 Z20\nM30');
ok(Math.abs(h(20.1, 0)) < 1e-6 && Math.abs(h(20.35, 0) + 3) < 1e-6, `wear offset dR=+0.2 leaves 0.2 mm: h(20.1)=${h(20.1, 0)} h(20.35)=${h(20.35, 0)}`);
tools.get(2).dRadius = 0;
// inside pocket with G42 and RND
zm = cut('G54 T2 D1 M6\nS5000 M3\nG0 X0 Y0 Z5\nG1 Z-3 F500\nG41 G1 X-20 Y-20 F1000\nX20 RND=8\nY20 RND=8\nX-20 RND=8\nY-20 RND=8\nX0\nG40 G1 X0 Y0\nG0 Z20\nM30');
ok(zm && Math.abs(h(19.8, 0) + 3) < 1e-6 && Math.abs(h(20.3, 0)) < 1e-6, `G41 counter-clockwise = inside: wall at 20: h(19.8)=${h(19.8, 0)} h(20.3)=${h(20.3, 0)}`);
const cr = 20 - 8 + 8 / Math.SQRT2; // point on the RND=8 arc along the diagonal
ok(Math.abs(h(cr - 0.3, cr - 0.3) + 3) < 1e-6 && Math.abs(h(cr + 0.3, cr + 0.3)) < 1e-6, `RND=8 corner radius cut: inside=${h(cr - 0.3, cr - 0.3)} outside=${h(cr + 0.3, cr + 0.3)}`);
console.log(fail ? `${fail} FAILURES` : "ALL OK");
if (fail) process.exitCode = 1;
