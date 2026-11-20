const R = new URL('../src/', import.meta.url).href;
const { Interpreter } = await import(R + 'gcode/interpreter.js');
const { EXAMPLES, getExample } = await import(R + 'gcode/examples.js');
const { DEFAULT_TOOLS, VISE, MACHINE } = await import(R + 'config.js');
const { Controller } = await import(R + 'sim/controller.js');
const tools = new Map(DEFAULT_TOOLS.map((t) => [t.number, t]));
let fail = 0;
for (const e of EXAMPLES) {
  const ex = getExample(e.id);
  const top = VISE.floor + VISE.jawHeight + ex.stock.protrusion;
  const offsets = [{ x: -203, y: -178, z: top - MACHINE.gaugeAtZ0 }, ...Array(5).fill({ x: 0, y: 0, z: 0 })];
  const c = new Controller();
  c.offsets = offsets;
  c.homed = true; c.pos = { x: 0, y: 0, z: 0 }; c.door.pos = c.door.target = 0;
  const it = new Interpreter({ tools, offsets, requireG43: true, arcTol: 0.01 });
  c.program = it.compile(ex.code, { pos: c.pos, tool: 0, carousel: 1 });
  let motions = 0, maxSeg = 0, lines = new Set();
  c.onMotion = (a, b) => { motions++; maxSeg = Math.max(maxSeg, Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)); return null; };
  c.on('line', (l) => lines.add(l));
  c.simSpeed = 20;
  c.cycleStart();
  let frames = 0;
  const t0 = performance.now();
  while (c.state !== 'complete' && frames < 200000 && c.state !== 'alarm') { c.update(1 / 60); frames++; }
  const ms = performance.now() - t0;
  const ep = c.program.endPos;
  const posOk = Math.hypot(c.pos.x - ep.x, c.pos.y - ep.y, c.pos.z - ep.z) < 1e-6;
  const ok = c.state === 'complete' && posOk && c.tool === c.program.endTool && Math.abs(c.elapsed - c.program.totalTime) / c.program.totalTime < 0.02;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${e.id.padEnd(12)} state=${c.state} elapsed=${c.elapsed.toFixed(1)}s est=${c.program.totalTime.toFixed(1)}s frames=${frames} motions=${motions} maxSeg=${maxSeg.toFixed(2)} tool=${c.tool} posOk=${posOk} lines=${lines.size} cpu=${ms.toFixed(0)}ms`);
}
// single block: should hold after the first line with ops
{
  const c = new Controller(); c.homed = true; c.pos = { x: 0, y: 0, z: 0 }; c.door.pos = c.door.target = 0;
  c.offsets = [{ x: -203, y: -178, z: -351 }, ...Array(5).fill({ x: 0, y: 0, z: 0 })];
  const it = new Interpreter({ tools, offsets: c.offsets, requireG43: true, arcTol: 0.01 });
  c.program = it.compile('G0 X10 Y10\nG0 X20\nG0 X30\nM30', { pos: c.pos, tool: 0 });
  c.singleBlock = true; c.cycleStart();
  for (let i = 0; i < 300; i++) c.update(1 / 60);
  const ok1 = c.state === 'hold' && c.line === 0;
  c.cycleStart(); for (let i = 0; i < 300; i++) c.update(1 / 60);
  const ok2 = c.state === 'hold' && c.line === 1;
  console.log((ok1 && ok2 ? 'ok   ' : 'FAIL ') + 'single block holds per line', c.state, c.line); if (!(ok1 && ok2)) fail++;
  // M00
  c.singleBlock = false; c.stop();
  c.program = it.compile('G0 X10\nM00\nG0 X20\nM30', { pos: c.pos, tool: 0 });
  c.cycleStart(); for (let i = 0; i < 300; i++) c.update(1 / 60);
  const ok3 = c.state === 'hold' && /M00/.test(c.holdReason);
  c.cycleStart(); for (let i = 0; i < 300; i++) c.update(1 / 60);
  console.log((ok3 && c.state === 'complete' ? 'ok   ' : 'FAIL ') + 'M00 stops then resumes', c.state); if (!(ok3 && c.state === 'complete')) fail++;
  // alarm from motion handler
  c.program = it.compile('G0 X10\nG0 X50\nM30', { pos: c.pos, tool: 0 });
  c.onMotion = (a, b) => (b.x > -203 + 30 ? 'test collision' : null);
  c.cycleStart(); for (let i = 0; i < 300; i++) c.update(1 / 60);
  console.log((c.state === 'alarm' ? 'ok   ' : 'FAIL ') + 'alarm stops machine at x=' + (c.pos.x + 280).toFixed(2)); if (c.state !== 'alarm') fail++;
  c.reset(); console.log((c.state === 'idle' ? 'ok   ' : 'FAIL ') + 'reset clears alarm');
  // homing
  c.homed = false; c.pos = { x: -100, y: -100, z: -100 }; c.onMotion = null; c.home();
  for (let i = 0; i < 600; i++) c.update(1 / 60);
  console.log((c.homed && c.pos.x === 0 && c.pos.z === 0 ? 'ok   ' : 'FAIL ') + 'homing', c.pos);
}
console.log(fail ? `${fail} FAILURES` : "ALL OK");
if (fail) process.exitCode = 1;
