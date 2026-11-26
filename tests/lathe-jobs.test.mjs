// Headless tests for the lathe jobs: drawings, stock rack, inspection of turned parts.
// node tests/lathe-jobs.test.mjs
const R = new URL('../src/lathe/', import.meta.url).href;
const { LatheSim } = await import(R + 'lathe-sim.js');
const { TurnProfile } = await import(R + 'turn-profile.js');
const J = await import(R + 'lathe-jobs.js');

let bad = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) bad++; };
const near = (a, b, tol, m) => { const g = a != null && Math.abs(a - b) <= tol; console.log((g ? 'ok   ' : 'FAIL ') + m + ` got=${typeof a === 'number' ? a.toFixed(3) : a} want=${b}`); if (!g) bad++; };

// ---- job table, drawings and bars
ok(J.LATHE_JOBS.length >= 4, `${J.LATHE_JOBS.length} lathe jobs`);
for (const j of J.LATHE_JOBS) {
  const svg = J.latheDrawingSVG(j);
  ok(svg.startsWith('<svg') && svg.endsWith('</svg>') && svg.includes(j.title) && svg.includes(j.drawingNo), `${j.id} drawing renders`);
  ok((svg.match(/<text/g) || []).length === (svg.match(/<\/text>/g) || []).length, `${j.id} drawing text tags balanced`);
  ok(!/NaN|undefined/.test(svg), `${j.id} drawing has no NaN / undefined`);
  const C = J.jobChecks(j);
  ok(C.length >= 3 && C.every((c) => c.tol[0] <= c.tol[1]), `${j.id}: ${C.length} characteristics with valid tolerances`);
  ok(J.BARS.some((b) => J.barFits(b, j)), `${j.id}: its bar Ø${j.bar.dia}×${j.bar.length} is on the rack`);
  ok(j.segs[0].u0 === 0 && j.segs[j.segs.length - 1].u1 === j.length && j.segs.every((s, k) => k === 0 || s.u0 === j.segs[k - 1].u1), `${j.id}: segments cover the part length`);
  ok(j.bar.dia >= Math.max(...j.segs.map((s) => s.d)) && j.stickout > j.length + 5 && j.bar.length - j.stickout >= 15, `${j.id}: bar and stick-out are workable`);
}
ok(J.BARS.some((b) => b.material === 'steel' && b.dia === 30 && b.length === 100) && new Set(J.BARS.map((b) => b.id)).size === J.BARS.length, 'rack has near misses and unique ids');
ok(J.tolText([-0.05, 0.05]) === '±0.05' && J.tolText([0, 0.1]) === '+0.1/0', 'tolerance text');
near(J.nominalRadius(J.getLatheJob('L01'), 0.5), 11.5, 1e-9, 'nominal radius in the chamfer');

// ---- machine L01 in the simulator, part it off and inspect it
const toZ = (s, z) => { for (let k = 0; k < 2; k++) s.turnCarriage((s.toolTip().z - z) / 0.1); };
const toR = (s, r) => { for (let k = 0; k < 2; k++) s.turnCross((s.toolTip().r - r) / 0.01); };
function makeL01({ d1 = 24, d2 = 28, chamfer = true, faceZ = 59.5 } = {}) {
  const s = new LatheSim();
  s.setTool(1, 'chamfer');
  s.loadStock({ dia: 30, length: 100, stickout: 60, material: 'aluminium' });
  s.setGear(9); s.setSpindle(1); s.runFor(3);
  // face
  toR(s, 17); toZ(s, faceZ); toR(s, -0.5); toR(s, 17);
  // Ø28 to Z15, then Ø24 to the shoulder (22 from the face)
  const zSh = faceZ - 22;
  for (const r of [d2 / 2]) { toZ(s, faceZ + 2); toR(s, r); toZ(s, 15); toR(s, 17); }
  for (let r = 13; r > d1 / 2 + 0.01; r -= 1) { toZ(s, faceZ + 2); toR(s, r); toZ(s, zSh); toR(s, 17); }
  toZ(s, faceZ + 2); toR(s, d1 / 2); toZ(s, zSh); toR(s, 17);
  if (chamfer) {
    toZ(s, faceZ + 25); s.indexTool(1);
    toZ(s, faceZ); toR(s, d1 / 2 - 1); toR(s, 17);
  }
  toZ(s, faceZ + 25); s.indexTool(2);
  toZ(s, faceZ - 43); toR(s, 16);
  s.setFeedIndex(1); s.engageFeed('cross');
  let n = 0; while (!s.events.some((e) => e.type === 'partedOff') && n++ < 60 * 90) s.step(1 / 60);
  s.engageFeed('off');
  return { s, ev: s.events.find((e) => e.type === 'partedOff') };
}
{
  const { s, ev } = makeL01();
  ok(!!ev, 'L01 parted off');
  const job = J.getLatheJob('L01');
  const rep = J.inspectTurned(job, { profile: ev.piece.profile, material: ev.piece.material });
  for (const it of rep.items) ok(it.pass, `L01 ${it.label}: ${it.measured} (nominal ${it.nominal})`);
  ok(rep.pass && rep.grade !== 'FAIL', `L01 inspection passes: grade ${rep.grade} score ${rep.score}`);
  const fr = J.pieceFrame(ev.piece.profile);
  near(fr.length, 40, 0.05, 'piece frame length');
  near(J.readInstrument(fr, 'od', 10, { res: 0.001 }).value, 24, 0.01, 'micrometer on the Ø24 spigot');
  near(J.readInstrument(fr, 'od', 30, { res: 0.01 }).value, 28, 0.01, 'caliper on the Ø28 shoulder');
  near(J.readInstrument(fr, 'step', 5).value, 22, 0.05, 'depth rod: face to shoulder 22');
  near(J.readInstrument(fr, 'length', 0).value, 40, 0.05, 'caliper: overall length 40');
  ok(J.readInstrument(fr, 'id', 10) == null, 'no bore to measure');
  ok(J.readInstrument(fr, 'pitch', 5).value == null, 'no thread on the pin');
  // wrong material fails
  const r2 = J.inspectTurned(job, { profile: ev.piece.profile, material: 'brass' });
  ok(!r2.pass && r2.notes.some((n) => /material/i.test(n)), 'wrong material fails the inspection');
  // the bar left in the chuck is not the part
  ok(s.stockLength() < 18, `bar end left in the chuck (${s.stockLength()} mm out)`);
}
{
  const { ev } = makeL01({ d1: 24.4, chamfer: false });
  const rep = J.inspectTurned(J.getLatheJob('L01'), { profile: ev.piece.profile, material: 'aluminium' });
  const od = rep.items.find((i) => i.id === 'od0'), ch = rep.items.find((i) => i.id === 'ch');
  ok(!rep.pass && rep.grade === 'FAIL', 'oversize spigot fails');
  ok(od && !od.pass && od.dev > 0.3, `Ø24 reads oversize (${od?.measured})`);
  ok(ch && !ch.pass, 'missing chamfer is reported');
  ok(rep.notes.some((n) => /pass/i.test(n)), 'note suggests another pass');
}
{
  // an untouched bar (sawn off) fails everything except perhaps the length
  const p = new TurnProfile({ zMin: 0, zMax: 40, radius: 15, dz: 0.02 });
  const rep = J.inspectTurned(J.getLatheJob('L01'), { profile: p, material: 'aluminium' });
  ok(!rep.pass && rep.items.filter((i) => !i.pass).length >= 3, 'raw bar fails the inspection');
  ok(J.inspectTurned(J.getLatheJob('L01'), { profile: null }).grade === 'FAIL', 'no part = FAIL');
}
{
  // L02: drilled through bore + OD, made directly on a profile (the drilling itself is tested in lathe.test)
  const s = new LatheSim();
  s.setTool(1, 'chamfer');
  s.loadStock({ dia: 25, length: 80, stickout: 45, material: 'brass' });
  s.setGear(8); s.setSpindle(1); s.runFor(3);
  toR(s, 14); toZ(s, 44.5); toR(s, -0.5); toR(s, 22); // cross-slide well back: the tailstock comes up
  s.lockTailstock(false); s.slideTailstock(44.5 - s.tailTipZ() + 5); s.lockTailstock(true);
  s.setTailTool({ type: 'drill', d: 10 });
  for (let k = 0; k < 10; k++) s.turnTailQuill(100); // quill out 50 mm in 5 mm steps (tip from Z60 to Z10)
  ok(s.measureID(40) === 10, 'L02 drilled Ø10');
  s.turnTailQuill(-1100);
  s.lockTailstock(false); s.slideTailstock(250); s.lockTailstock(true); // tailstock out of the way
  for (const r of [11.5, 11]) { toZ(s, 47); toR(s, r); toZ(s, 20); toR(s, 14); }
  toZ(s, 70); s.indexTool(1); toZ(s, 44.5); toR(s, 10.5); toR(s, 14);
  toZ(s, 70); s.indexTool(2); toZ(s, 44.5 - 23); toR(s, 13);
  s.setFeedIndex(1); s.engageFeed('cross');
  let n = 0; while (!s.events.some((e) => e.type === 'partedOff') && n++ < 60 * 90) s.step(1 / 60);
  const ev = s.events.find((e) => e.type === 'partedOff');
  ok(!!ev, 'L02 parted off');
  if (ev) {
    const rep = J.inspectTurned(J.getLatheJob('L02'), { profile: ev.piece.profile, material: 'brass' });
    for (const it of rep.items) ok(it.pass, `L02 ${it.label}: ${it.measured}`);
    near(J.readInstrument(J.pieceFrame(ev.piece.profile), 'id', 10).value, 10, 0.01, 'caliper inside jaws read the bore');
  }
}

console.log(bad ? `${bad} lathe job check(s) failed` : 'all lathe job checks passed');
process.exitCode = bad ? 1 : 0;
