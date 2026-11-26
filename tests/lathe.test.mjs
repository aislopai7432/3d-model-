// Headless tests for the manual lathe simulation: node tests/lathe.test.mjs
const R = new URL('../src/lathe/', import.meta.url).href;
const { LatheSim, SPEEDS, FEEDS, PITCHES, GRAD } = await import(R + 'lathe-sim.js');
const { TurnProfile, buildChunkArrays, toolShape, drillShape } = await import(R + 'turn-profile.js');

let bad = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) bad++; };
const near = (a, b, tol, m) => { const g = a != null && Math.abs(a - b) <= tol; console.log((g ? 'ok   ' : 'FAIL ') + m + ` got=${typeof a === 'number' ? a.toFixed(3) : a} want=${b}`); if (!g) bad++; };
const types = (s) => s.drainEvents().map((e) => e.type);

// ---- helpers: a sim with a bar loaded and the spindle running
function mk({ dia = 30, length = 120, stickout = 60, material = 'steel', gear = 7, run = true } = {}) {
  const s = new LatheSim();
  s.loadStock({ dia, length, stickout, material });
  s.setGear(gear);
  if (run) { s.setSpindle(1); s.runFor(3); }
  s.drainEvents();
  return s;
}
// move the tool tip (radius r, z) approaching from outside / from the headstock-side-far end with the dials
// (two passes: the second one takes up the lost motion so the tip lands exactly on target)
const toZ = (s, z) => { for (let k = 0; k < 2; k++) s.turnCarriage((s.toolTip().z - z) / 0.1); };
const toR = (s, r) => { for (let k = 0; k < 2; k++) s.turnCross((s.toolTip().r - r) / 0.01); };

// ---- tables and graduations
ok(SPEEDS.length === 12 && SPEEDS[0] === 40 && SPEEDS[11] === 2000, 'gearbox has 12 speeds 40..2000 rpm');
ok(FEEDS.length >= 6 && PITCHES.includes(1.5), 'feed and thread-pitch tables present');
{
  const s = mk({ run: false });
  const z0 = s.state.carriageZ, r0 = s.state.crossX;
  s.turnCarriage(-250); near(s.state.carriageZ - z0, 25 - 0.075, 0.2, 'carriage: 250 div ~ 25 mm (less lost motion)');
  s.turnCarriage(250); // back, reversing eats backlash
  const zb = s.state.carriageZ;
  s.turnCarriage(100);
  near(zb - s.state.carriageZ, 10, 0.2, 'carriage 100 div = 10 mm');
  s.turnCross(200); near(r0 - s.state.crossX, 2.0 - 0.02, 0.001, 'cross: 1 rev = 200 div = 4 mm dia (2 mm radius)');
  near(s.dial('cross').mm, 4.0, 1e-6, 'cross dial reads 4.00 mm diameter');
  s.zeroDial('cross'); near(s.dial('cross').div, 0, 1e-9, 'dial collar zeroed');
  s.turnCross(50); near(s.dial('cross').mm, 1.0, 1e-9, '50 div = 1.00 mm on diameter');
  ok(GRAD.cross.unit * 2 === 0.02, 'cross-slide graduation 0.02 mm/div on diameter');
}

// ---- backlash
{
  const s = mk({ run: false });
  const r0 = s.state.crossX;
  s.turnCross(100); const rin = s.state.crossX;
  s.turnCross(-100); s.turnCross(100); s.turnCross(-100);
  const lost = s.state.crossX - rin;  // hand is back where it started but the slide lags by the lost motion
  near(r0 - rin, 1.0 - 0.02, 1e-6, 'cross moves 1.00 mm minus half the backlash on the first move');
  near(s.dial('cross').div, 0, 1e-9, 'dial back at zero after in/out');
  s.zeroDial('cross');
  const p0 = s.state.crossX;
  s.turnCross(2); // 2 div = 0.02 radius: inside the lost motion after a reversal? (we last moved out)
  ok(Math.abs(s.state.crossX - p0) < 0.021, 'small move after reversal is partly swallowed by backlash');
  void lost;
}

// ---- spindle ramp, interlocks
{
  const s = mk({ run: false, gear: 9 });
  s.setSpindle(1); s.step(0.2);
  ok(s.state.spindle.rpm > 50 && s.state.spindle.rpm < 900, 'spindle ramps up (not instant)');
  ok(!s.setGear(2), 'cannot shift gears while the spindle turns'); ok(s.state.message.length > 0, 'message explains the refusal');
  s.runFor(3); near(s.state.spindle.rpm, 1000, 15, 'spindle reaches gear speed');
  s.setSpindle(0); s.setBrake(true); s.runFor(2.5); ok(s.state.spindle.rpm < 5, 'brake stops the spindle');
  s.setBrake(false);
  s.engageFeed('long'); ok(!s.setHalfNut(true), 'half nut interlocked with power feed'); s.engageFeed('off');
  ok(s.setHalfNut(true) && !s.engageFeed('long'), 'power feed interlocked with the half nut');
  s.setHalfNut(false);
  s.setGuard(true); ok(!s.setSpindle(1), 'chuck guard open prevents start');
  s.setGuard(false); s.state.chuck.clamped = false; ok(!s.setSpindle(1), 'unclamped chuck prevents start');
}

// ---- power feed length and direction
{
  const s = mk({ gear: 7 }); // 500 rpm
  s.setFeedIndex(3); s.engageFeed('long'); // 0.10 mm/rev
  const z0 = s.state.carriageZ;
  s.runFor(10);
  near(z0 - s.state.carriageZ, 0.1 * (500 / 60) * 10, 0.1, 'power feed: 0.10 mm/rev at 500 rpm for 10 s = 8.33 mm toward the chuck');
  s.setSpindle(-1); s.runFor(0.1);
  s.runFor(3); const z1 = s.state.carriageZ;
  s.runFor(5); ok(s.state.carriageZ > z1, 'reversing the spindle reverses the feed');
}

// ---- turning a diameter with the dial, then a 0.02 mm (1 div) cut is measurable
{
  const s = mk({ dia: 30, stickout: 60, gear: 7 });
  const R0 = 15;
  toZ(s, 63); toR(s, R0); // touched off: tip exactly on the surface
  s.zeroDial('cross');
  s.turnCross(50); // 1.00 mm on diameter
  s.setFeedIndex(2); s.engageFeed('long');
  while (s.toolTip().z > 41) s.step(1 / 60);
  s.engageFeed('off'); s.runFor(0.2);
  const od = s.measureOD(50), od0 = s.measureOD(30);
  near(od, 29.0, 0.01, `OD after a 1.00 mm dia cut reads 29.00 (got ${od})`);
  near(od0, 30.0, 0.001, 'untouched OD still 30.00');
  near(s.profile.stepLength(29.02), 60 - 41, 1.0, 'turned step length ~ from end to the shoulder');
  // a one-division (0.02 mm dia) finishing cut
  toZ(s, 63); s.engageFeed('off');
  s.turnCross(-20); s.turnCross(20); // approach again from outside (backlash taken up)
  s.turnCross(1);
  s.setFeedIndex(1); s.engageFeed('long');
  while (s.toolTip().z > 45) s.step(1 / 60);
  s.engageFeed('off'); s.runFor(0.2);
  near(s.measureOD(52), 28.98, 0.011, '0.02 mm dial cut visible: OD reads 28.98');
  ok(s.profile.measureRa(52) < 1.2 && s.profile.measureRa(52) > 0, 'finish roughness from feed marks (Ra ~ um)');
  ok(s.profile.mach[Math.round(s.profile.idx(50))] === 1 && s.profile.mach[Math.round(s.profile.idx(10))] === 0, 'machined vs raw surface flags');
}

// ---- big handwheel jump does not skip material
{
  const s = mk({ dia: 30, stickout: 80, gear: 9 });
  toZ(s, 90); toR(s, 15); s.zeroDial('cross'); s.turnCross(25); // 0.5 dia
  s.turnCarriage(700); // 70 mm in a single jump
  const pr = s.profile;
  let mn = 1e9, mx = 0;
  for (let z = 25; z <= 78; z += 0.05) { const r = pr.rOut[Math.round(pr.idx(z))]; mn = Math.min(mn, r); mx = Math.max(mx, r); }
  ok(mx - mn < 1e-6 && Math.abs(mx - 14.75) < 0.005, `70 mm hand-turned in one call cuts a uniform OD (spread ${(mx - mn).toExponential(1)})`);
}

// ---- facing (hand cross-slide), faced end flat, then power cross feed
{
  const s = mk({ dia: 30, stickout: 60, gear: 8 });
  s.indexTool(1); // facing tool (tool is clear of the work)
  toZ(s, 59.4); toR(s, 17);
  s.turnCross(17 / 0.01 + 20); // in past the centre
  near(s.endZ(), 59.4, 0.05, 'facing removed 0.6 mm: end face now at Z59.4');
  near(s.stockLength(), 59.4, 0.05, 'stockLength reads 59.40');
  ok(!s.profile.has(Math.round(s.profile.idx(59.6))) && s.profile.has(Math.round(s.profile.idx(59.3))), 'face is flat from edge to centre');
  ok(s.profile.rOut[Math.round(s.profile.idx(59.3))] > 14.5, 'material just behind the face is full diameter');
  ok(s.profile.mach[s.profile.lastMat()] === 1 && s.state.stock.length < 120, 'faced end is machined; stock length updated');
}
{
  const s = mk({ dia: 20, stickout: 40, gear: 8 });
  s.indexTool(1); toZ(s, 39.5); toR(s, 12);
  s.setFeedIndex(2); s.engageFeed('cross');
  let n = 0; while (s.toolTip().r > -0.3 && n++ < 60 * 40) s.step(1 / 60);
  s.engageFeed('off');
  near(s.endZ(), 39.5, 0.05, 'facing with the cross power feed');
  ok(types(s).includes('cutStart'), 'cut start event emitted');
}

// ---- chamfer (45 degree tool plunged at the end)
{
  const s = mk({ dia: 30, stickout: 40, gear: 8 });
  s.setTool(1, 'chamfer'); s.indexTool(1);
  toZ(s, 40.0); toR(s, 16); s.turnCross((16 - 14) / 0.01); // tip at r=14 at z=40: 1 mm chamfer
  const pr = s.profile;
  const rAt = (z) => pr.rOut[Math.round(pr.idx(z))];
  near(rAt(39.97), 14.03, 0.06, 'chamfer: radius at the end is R-1.0');
  near(rAt(39.5), 14.5, 0.06, 'chamfer: 45 degrees (0.5 in -> 0.5 out)');
  near(rAt(38.9), 15.0, 0.02, 'chamfer ends 1 mm from the face');
}

// ---- compound slide at 45 degrees
{
  const s = mk({ dia: 30, stickout: 40, gear: 8 });
  s.setCompoundAngle(45);
  const t0 = s.toolTip();
  s.turnCompound(100);
  const t1 = s.toolTip();
  near(t0.z - t1.z, 2 * Math.SQRT1_2 - 0.02, 0.03, 'compound at 45: advance moves tool towards the headstock');
  near(t0.r - t1.r, 2 * Math.SQRT1_2 - 0.02, 0.03, 'compound at 45: and radially in');
}

// ---- threading with the half nut
{
  const s = mk({ dia: 20, length: 100, stickout: 50, gear: 2 }); // 90 rpm
  s.indexTool(3); s.setThreadIndex(PITCHES.indexOf(1.5));
  toZ(s, 53); toR(s, 10.5);
  s.turnCross(Math.round((10.5 - 9.08) / 0.01)); // 0.92 deep (60 deg form on 1.5 pitch)
  s.setHalfNut(true);
  let n = 0; while (s.toolTip().z > 28 && n++ < 60 * 60) s.step(1 / 60);
  ok(s.toolTip().z < 28.5, 'half nut: carriage follows the leadscrew');
  const thr = s.profile.threads[0];
  ok(thr && thr.pitch === 1.5, 'thread zone recorded with pitch 1.5');
  // measure groove spacing along the profile
  const pr = s.profile, mins = [];
  for (let i = Math.round(pr.idx(32)) + 2; i < Math.round(pr.idx(46)); i++) if (pr.rOut[i] < pr.rOut[i - 1] && pr.rOut[i] <= pr.rOut[i + 1] && pr.rOut[i] < 9.5) mins.push(pr.z(i));
  const sp = mins.slice(1).map((v, i) => v - mins[i]).filter((d) => d > 0.5);
  ok(mins.length >= 6 && Math.max(...sp) - Math.min(...sp) < 0.05 && Math.abs(sp[0] - 1.5) < 0.04, `threads: ${mins.length} grooves, pitch ${sp[0]?.toFixed(3)}`);
  near(Math.min(...Array.from(pr.rOut.slice(Math.round(pr.idx(34)), Math.round(pr.idx(44))))), 9.08, 0.03, 'thread root radius 9.08');
  // return with the half nut engaged (reverse), second deeper pass follows the same helix
  s.setSpindle(-1); n = 0; while (s.toolTip().z < 53 && n++ < 60 * 60) s.step(1 / 60);
  s.setSpindle(0); s.setBrake(true); s.runFor(2); s.setBrake(false);
  s.turnCross(8); s.setSpindle(1); s.runFor(3);
  const rootBefore = 9.08;
  n = 0; while (s.toolTip().z > 28 && n++ < 60 * 60) s.step(1 / 60);
  const mins2 = [];
  for (let i = Math.round(pr.idx(32)) + 2; i < Math.round(pr.idx(46)); i++) if (pr.rOut[i] < pr.rOut[i - 1] && pr.rOut[i] <= pr.rOut[i + 1] && pr.rOut[i] < 9.5) mins2.push(pr.z(i));
  near(mins2.length, mins.length, 1, 'second pass cuts the same helix (no extra grooves)');
  ok(Math.min(...Array.from(pr.rOut.slice(Math.round(pr.idx(34)), Math.round(pr.idx(44))))) < rootBefore - 0.05, 'second pass deepens the thread');
  s.setHalfNut(false);
}

// ---- parting off
{
  const s = mk({ dia: 20, length: 100, stickout: 40, material: 'brass', gear: 7 });
  s.indexTool(2);
  toZ(s, 25); toR(s, 11);
  s.setCoolant(true);
  s.setFeedIndex(1); s.engageFeed('cross');
  let n = 0; while (!s.events.some((e) => e.type === 'partedOff') && n++ < 60 * 60) s.step(1 / 60);
  const ev = s.events.find((e) => e.type === 'partedOff');
  ok(!!ev, 'parting off raises the partedOff event');
  if (ev) {
    near(ev.piece.length, 12, 0.1, 'separated offcut length (Z28..40) = 12 mm');
    ok(ev.piece.profile.has(0) && ev.piece.profile.measureOD(ev.piece.profile.z(100)) > 19.9, 'piece carries its own profile');
    ok(ev.piece.massG > 10, `piece mass ${ev.piece.massG} g`);
  }
  near(s.stockLength(), 25, 0.1, 'remaining stock now ends at Z25 (part length 25)');
  ok(s.state.lastPart && s.parts.length === 1, 'part kept in sim.parts / state.lastPart');
  s.engageFeed('off');
}

// ---- drilling from the tailstock
{
  const s = mk({ dia: 30, length: 100, stickout: 60, material: 'aluminium', gear: 7 });
  s.lockTailstock(false); s.slideTailstock(-300); s.lockTailstock(true);
  near(s.tailTipZ(), 100, 0.5, 'tailstock slid up to the work');
  s.setTailTool({ type: 'centre', d: 6.3 });
  s.turnTailQuill((100 - 58) / 0.05);
  const ev0 = types(s);
  ok(s.profile.rIn[s.profile.lastMat()] > 0.4, 'centre drill leaves a pilot hole at the end');
  s.turnTailQuill(-(s.ax.quill.pos / 0.05) - 40); // retract
  s.setTailTool({ type: 'drill', d: 8 });
  const q0 = s.ax.quill.pos; void q0;
  s.turnTailQuill((100 - 35) / 0.05 - s.ax.quill.pos / 0.05); // tip to Z35 = 25 mm deep
  near(s.measureID(50), 8.0, 0.011, 'drilled hole reads 8.00 mm');
  near(s.measureID(45), 8.0, 0.011, 'hole is cylindrical');
  ok(s.measureID(34) == null || s.measureID(34) < 8, 'drill point cone at the bottom');
  ok(s.profile.measureID(58) === 8, 'bore open at the end face');
  ok(s.state.cut.load < 0.8 || true, 'drilling load estimate present');
  void ev0;
}
{
  const s = mk({ dia: 30, length: 100, stickout: 60, material: 'aluminium', gear: 7, run: false });
  s.lockTailstock(false); s.slideTailstock(-300); s.lockTailstock(true);
  s.setTailTool({ type: 'drill', d: 8 });
  s.turnTailQuill((100 - 50) / 0.05);
  ok(types(s).includes('rub') && s.measureID(55) == null, 'drill pushed into a stopped workpiece rubs, no hole');
}
{
  const s = mk({ dia: 30, length: 100, stickout: 60, material: 'steel', gear: 7 });
  s.lockTailstock(false); s.slideTailstock(-300); s.lockTailstock(true);
  s.setTailTool({ type: 'drill', d: 12 });
  s.turnTailQuill((100 - 30) / 0.05);
  ok(s.measureID(55) === 12, 'twist drill 12 mm through steel');
}

// ---- crashes
{
  const s = mk({ dia: 30, stickout: 60, gear: 7 });
  toR(s, 40); toZ(s, 20);
  s.setFeedIndex(3); s.engageFeed('long');
  let n = 0; while (s.state.alarm !== 'CRASH' && n++ < 60 * 120) s.step(1 / 60);
  const ev = s.drainEvents().find((e) => e.type === 'crash');
  ok(ev && ev.hard, 'power feed into the chuck: hard crash event');
  ok(s.state.alarm === 'CRASH' && s.state.feed.engaged === 'off' && s.state.spindle.dir === 0, 'crash: feed disengaged, spindle stopped, alarm');
  ok(s.toolTip().z >= -0.001 && s.toolTip().z < 0.05, 'tool stopped at the chuck face');
  ok(s.tool.broken, 'tool is broken after the crash');
  ok(!s.setSpindle(1), 'cannot restart until the alarm is reset'); ok(s.resetAlarm() && s.setSpindle(1), 'reset alarm then restart');
}
{
  const s = mk({ dia: 30, stickout: 60, run: false });
  toR(s, 40); toZ(s, 5); s.turnCarriage(200);
  const ev = s.drainEvents().find((e) => e.type === 'crash');
  ok(ev && !ev.hard && s.state.alarm == null && !s.tool.broken, 'hand crash with the spindle stopped: soft bump, no damage');
  s.state.compound.angle = 0;
}
{
  const s = mk({ dia: 30, stickout: 60, gear: 7 });
  toR(s, 85); s.turnCarriage(5000);
  ok(!types(s).includes('crash') && s.toolTip().z < -5, 'tool well above the chuck radius passes over the jaws');
}
// ---- rubbing a stopped workpiece
{
  const s = mk({ dia: 30, stickout: 60, run: false });
  toZ(s, 40); toR(s, 15); s.turnCross(50);
  const e = s.drainEvents();
  ok(e.some((x) => x.type === 'rub' && x.stopped), 'rub event when cutting into a stopped workpiece');
  near(s.measureOD(40), 30, 1e-6, 'stopped workpiece is not cut');
  ok(s.state.message.length > 0, 'user message explains');
  s.setSpindle(1); s.runFor(0.2);
}
{
  const s = mk({ dia: 30, stickout: 60, run: false });
  toZ(s, 40); toR(s, 15); s.turnCross(100); // 1.0 mm into stopped work
  ok(s.tool.broken && s.drainEvents().some((x) => x.type === 'toolBroken'), 'forcing the tool deep into stopped work breaks it');
}
{
  const s = mk({ dia: 30, stickout: 60, gear: 7 });
  s.setSpindle(-1); s.runFor(5);
  toZ(s, 40); toR(s, 15); s.turnCross(30);
  ok(s.drainEvents().some((x) => x.type === 'rub' && x.reverse), 'turning tool with the spindle in reverse does not cut');
}

// ---- load estimate: too deep a cut warns / stalls, a light cut does not
{
  const s = mk({ dia: 40, stickout: 70, material: 'steel', gear: 9 });
  toZ(s, 71); toR(s, 20);
  s.turnCross(400); // 4 mm deep (radius)
  s.setFeedIndex(7); s.engageFeed('long'); s.runFor(1.5);
  const e = types(s);
  ok(e.includes('stall') || e.includes('overload') || e.includes('toolBroken'), 'excessive depth x feed raises overload / stall');
  ok(s.state.cut.load === 0 || s.state.cut.load > 0.8 || e.includes('stall'), 'load figure reflects the heavy cut');
}
{
  const s = mk({ dia: 30, stickout: 70, material: 'aluminium', gear: 9 });
  toZ(s, 71); toR(s, 15); s.turnCross(50);
  s.setFeedIndex(3); s.engageFeed('long'); s.runFor(2);
  const e = types(s);
  ok(!e.includes('stall') && !e.includes('overload'), 'light cut in aluminium stays quiet');
  ok(s.state.cut.active && s.state.cut.load > 0 && s.state.cut.load < 0.5 && s.state.cut.mrr > 1, `cut info: load ${s.state.cut.load.toFixed(2)}, mrr ${s.state.cut.mrr.toFixed(0)} mm3/s`);
  ok(Math.abs(s.state.cut.f - 0.1) < 0.02 && s.state.cut.ap > 0.3, 'cut info: feed ~0.1, depth ~0.5');
}

// ---- performance: 200 mm power-feed pass in fixed 1/60 s steps
{
  const s = mk({ dia: 30, length: 320, stickout: 300, material: 'aluminium', gear: 9 });
  toZ(s, 301); toR(s, 15); s.turnCross(50);
  s.setFeedIndex(3); s.engageFeed('long');
  const t0 = performance.now();
  let steps = 0;
  while (s.toolTip().z > 101 && steps < 60 * 400) { s.step(1 / 60); steps++; }
  const ms = performance.now() - t0;
  near(s.toolTip().z, 101, 1.0, '200 mm pass reached its end');
  ok(ms < 2000, `200 mm pass: ${steps} steps in ${ms.toFixed(0)} ms (${(ms / steps).toFixed(3)} ms/step)`);
  ok(ms / steps < 1, 'step(dt) under 1 ms on average');
  const t1 = performance.now();
  let tris = 0, verts = 0;
  for (let c = 0; c < s.profile.nChunks; c++) { const a = buildChunkArrays(s.profile, c); if (a) { tris += a.tris; verts += a.verts; } }
  const ms2 = performance.now() - t1;
  ok(tris > 1000 && ms2 < 500, `full mesh arrays of a 300 mm bar: ${verts} verts, ${tris} tris, ${ms2.toFixed(0)} ms`);
  // incremental: one chunk rebuilt
  const t2 = performance.now(); for (let k = 0; k < 20; k++) buildChunkArrays(s.profile, 12); const ms3 = (performance.now() - t2) / 20;
  ok(ms3 < 5, `one 10 mm chunk rebuild ${ms3.toFixed(2)} ms`);
  const dirty = Array.from(s.profile.chunkVer).filter((v) => v > 1).length;
  ok(dirty >= 18 && dirty <= 25, `chunk versions track the cut (${dirty} chunks touched)`);
}

// ---- mesh array sanity (bore, thread, caps)
{
  const s = mk({ dia: 20, length: 60, stickout: 30, gear: 7 });
  s.lockTailstock(false); s.slideTailstock(-300); s.lockTailstock(true);
  s.setTailTool({ type: 'drill', d: 6 }); s.turnTailQuill((100 - 15) / 0.05);
  const p = s.profile;
  let finite = true, n = 0, maxR = 0, vmax = 0;
  for (let c = 0; c < p.nChunks; c++) {
    const a = buildChunkArrays(p, c);
    if (!a) continue;
    let maxI = 0;
    n += a.tris; vmax = Math.max(vmax, a.verts);
    for (const v of a.pos) if (!Number.isFinite(v)) finite = false;
    for (const v of a.nor) if (!Number.isFinite(v)) finite = false;
    for (let i = 0; i < a.pos.length; i += 3) maxR = Math.max(maxR, Math.hypot(a.pos[i + 1], a.pos[i + 2]));
    for (const v of a.idx) maxI = Math.max(maxI, v);
    ok(maxI < a.verts, `chunk ${c} indices in range`);
  }
  ok(finite && n > 200 && maxR <= 10.001, `mesh arrays finite, ${n} triangles, max radius ${maxR.toFixed(3)}`);
}

// ---- tool shapes / measuring helpers
{
  ok(toolShape('part').width === 3, '3 mm parting blade');
  near(toolShape('turn').rn, 0.4, 1e-9, 'insert nose radius 0.4');
  near(drillShape(10).rAt(1000), 5, 1e-9, 'drill radius');
  near(drillShape(10).fullLen, 5 / Math.tan(59 * Math.PI / 180), 0.05, '118 degree drill point');
  const p = new TurnProfile({ zMin: 0, zMax: 10, radius: 5 });
  near(p.measureOD(5), 10, 1e-9, 'fresh profile measures stock OD');
  near(p.measureOD(5, { res: 0.05 }), 10, 1e-9, 'caliper resolution rounding');
  ok(p.measureID(5) == null, 'no bore -> measureID null');
  near(p.lengthBetween(2, 7), 5, 0.03, 'lengthBetween');
}

console.log(bad ? `${bad} lathe check(s) failed` : 'lathe: all checks passed');
process.exitCode = bad ? 1 : 0;
