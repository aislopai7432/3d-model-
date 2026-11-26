// The control part of the interactive tutorial on the NGC-style (Haas) control. tutorial.js builds the
// shared steps (job board, drawing, blank, vise, inspection, measuring) and takes the steps from here
// for everything that happens at the control: POWER UP, offsets, the program (EDIT > VPS), the run.
// Every action step advances from the real control state (nothing is "clicked through"); explanation
// steps have a Next button. Targets are the exact keys (#haas [data-k]) and screen cells.
import { HAAS_TUTORIAL_STEPS } from './solutions-haas.js';
import { VPS_TEMPLATES, defaults } from '../ui/haas/haas-vps.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const KEY_OF = { 0: 'N_0', 1: 'N_1', 2: 'N_2', 3: 'N_3', 4: 'N_4', 5: 'N_5', 6: 'N_6', 7: 'N_7', 8: 'N_8', 9: 'N_9', '-': 'N_-', '.': 'N_.' };

// Which VPS variable to type, and why (the reason shown under the highlight).
const OPS = {
  face: { tpl: 'face', name: 'Face Milling', mark: /\(VPS FACE MILLING\)|\(OP1 -/, skip: [],
    why: {
      X: 'X of the front-left corner of the area to face: the blank corner is X0 in G54.',
      Y: 'Y of the front-left corner: the front face of the blank is Y0 in G54.',
      L: 'Length along X: the blank is 80 long. The VPS adds the run-in and run-out for the D50 cutter itself.',
      W: 'Width along Y: the blank is 50 wide. The D50 face mill covers it in two passes.',
      K: 'Depth of cut: the blank is 16, the drawing wants 15, so 1 mm comes off in one pass (Z-1.).',
    } },
  pocket: { tpl: 'rpocket', name: 'Rectangular Pocket', mark: /\(VPS RECTANGULAR POCKET\)|\(OP2 -/, skip: [],
    why: {
      X: 'X of the pocket CENTRE: 40 from the left edge (see the ordinate dimension on the drawing).',
      Y: 'Y of the pocket CENTRE: 25 from the front face.',
      I: 'Pocket size along X: 40.',
      J: 'Pocket size along Y: 24 (toleranced +-0.05: the width you will measure later).',
      Z: 'Floor of the pocket: 4 deep below the faced top at Z-1., so Z-5.',
      K: 'Depth per pass 2.5: the VPS cuts two levels (Z-2.5 and Z-5.) with the D10 end mill.',
    } },
  drill: { tpl: 'drill', name: 'Drilling', mark: /\(VPS DRILLING\)|\(OP3 -/, skip: ['B', 'K'],
    why: {
      A: 'Spot drill tool 0 = no spot drilling: the 6.8 twist drill starts the holes directly.',
      S: 'Spindle speed 4500 rpm for the D6.8 drill in aluminium.',
      F: 'Drilling feed 600 mm/min.',
      C: 'Cycle 0 = G81 plain drilling (holes are only 8 deep: no pecking needed).',
      Z: 'Depth of the drill POINT: faced top Z-1. - 8 deep - 2.04 for the 118 degree point = Z-11.04.',
      R: 'R plane 1: the drill rapids down to 1 above Z0 (2 above the faced top), then feeds.',
      X: 'X of the bolt circle centre: the pocket centre, X40.',
      Y: 'Y of the bolt circle centre: Y25. Holes B (10,10) and C (70,40) lie on a circle about this point.',
      I: 'Bolt circle radius 33.541: distance from the pocket centre to each hole.',
      J: 'Start angle of the first hole: 206.565 degrees (hole B).',
      L: 'Number of holes on the circle: 2 (B and C).',
    } },
};

export function haasSteps(t) {
  const app = t.app, g = t.game, P = t.part;
  const h = () => app.haas;
  const c = () => app.controller;
  const JOB = `JOB_${P.id}.MPF`;
  const opOn = () => g.op === 'pendant' || g.op === 'pc';
  const ack = (id) => !!t.st.ack?.[id];
  const kb = (id) => $(`#haas [data-k="${id}"]`);
  const key = (id, text, sub, pad) => ({ el: kb(id), text, sub, pad });
  const grp = (cls, text, pad = 4) => ({ el: $(`#haas .${cls}`), text, pad });
  const onProg = () => app.programName === JOB;
  const text = () => app.ui.editor.getValue();
  const hasOp = (op) => OPS[op].mark.test(text());
  const opDone = (op) => t.refLoaded() || t.machined() || (onProg() && hasOp(op));
  const spec = (op) => HAAS_TUTORIAL_STEPS.find((s) => s.id === op);
  const fieldsFor = (op) => {
    const s = spec(op), o = OPS[op], tpl = VPS_TEMPLATES.find((x) => x.id === o.tpl);
    const def = defaults(tpl, false);
    return tpl.vars.filter((v) => !o.skip.includes(v.k) && s.vps.fields[v.k] !== undefined && Math.abs(s.vps.fields[v.k] - def[v.k]) > 1e-9)
      .map((v) => ({ k: v.k, i: tpl.vars.indexOf(v), want: s.vps.fields[v.k], desc: v.desc }));
  };
  const fmt = (v) => String(+v.toFixed(4));
  // the editor cursor goes below the header: the VPS output is inserted after the cursor line
  const placeCursor = () => {
    const hh = h();
    const L = text().split('\n');
    const m = L.findIndex((l) => /^\(>>> /.test(l));
    if (m >= 0 && hh.editCur.line < m) hh.editCur = { line: m, word: 0 };
  };

  // ---- the target of a VPS step: walks the player through F4 > template > fields > F4 > ENTER
  const vpsTarget = (op) => {
    if (!opOn()) return null;
    const hh = h(), o = OPS[op];
    if (hh.popup) {
      const p = hh.popup;
      if (p.kind === 'list' && /^Generate/.test(p.title)) {
        if (p.row !== 0) return key('UP', 'UP: back to output 1', 'Output 1 puts the code into the active program');
        return key('ENTER', 'ENTER: output 1', 'Insert into the active program after the cursor');
      }
      return key('CANCEL', 'CANCEL closes this window');
    }
    if (hh.mode !== 'EDIT' || hh.disp !== 'edit') return key('EDIT', 'Press EDIT', 'The editor and the VPS live in EDIT mode');
    if (hh.tab.edit === 0) {
      placeCursor();
      return key('F4', 'F4: VPS tab', 'In the editor F4 opens VPS. The code is inserted below the cursor');
    }
    if (hh.vps.tpl && hh.vps.tpl !== o.tpl) return key('LEFT', 'LEFT: template list', 'Go back to the list to pick another template');
    if (!hh.vps.tpl) {
      const idx = VPS_TEMPLATES.findIndex((x) => x.id === o.tpl);
      if (hh.vps.dirRow !== idx) return { el: $(`#haas [data-cur="vpsdir"][data-row="${idx}"]`), text: `Select ${o.name}`, sub: 'UP / DOWN moves the cursor (or click the line)' };
      return key('ENTER', 'ENTER loads the template', o.name);
    }
    const need = fieldsFor(op).find((f) => Math.abs(+hh.vps.vals[f.k] - f.want) > 1e-6);
    if (!need) return key('F4', 'F4: generate the G-code', 'All values are in: F4, then ENTER for output 1');
    const cell = $(`#haas [data-cur="vps"][data-row="${need.i}"]`);
    if (hh.vps.row !== need.i) {
      return { el: cell || kb(need.i > hh.vps.row ? 'DOWN' : 'UP'), text: `${need.k}: move the cursor here`, sub: `${need.desc} (UP / DOWN, or click the row)` };
    }
    const want = fmt(need.want);
    const typed = hh.input.trim();
    if (typed === want) return key('ENTER', `ENTER writes ${need.k} = ${want}`, o.why[need.k]);
    if (typed !== '') return key('CANCEL', `CANCEL deletes a digit (need ${want})`, `${need.k} should be ${want}`);
    return { el: $('#haas .hs-input'), text: `${need.k}: type ${want}, then ENTER`, sub: o.why[need.k], pad: 3, keys: [...want].map((ch) => KEY_OF[ch]) };
  };

  const vpsText = (op) => {
    const s = spec(op), f = fieldsFor(op);
    return `${esc(s.intro)} Press <b>F4</b> in the editor (VPS tab), load <b>${OPS[op].name}</b>, and set: ${f.map((x) => `<b>${x.k} ${fmt(x.want)}</b>`).join(', ')} (leave the rest). Each value: move the cursor to the row, type it, <b>ENTER</b>. Then <b>F4</b> and <b>ENTER</b> (output 1: insert into the program).`;
  };
  const vpsStep = (op, title) => ({
    id: 'prog-' + op, title, phase: 'Program', fill: op,
    text: () => vpsText(op),
    atPanel: true,
    enter: () => { if (!app.programs.has(JOB)) app.programs.put(JOB, g.programTemplate(P)); },
    target: () => vpsTarget(op),
    done: () => opDone(op),
  });

  const explain = (id, title, phase, txt, target) => ({ id, title, phase, explain: true, atPanel: true, text: () => txt, target: () => (opOn() ? target() : null), done: () => ack(id) || t.passed(id) });

  const control = [
    explain('hScreen', 'The NGC screen', 'Control',
      'The screen: <b>top left</b> the mode (here <b>Setup: JOG</b>), the <b>program pane</b> on the left, the big <b>main display</b> on the right (positions, offsets, editor...), spindle and position panes below, and at the bottom the green <b>INPUT:</b> line, system messages and the red <b>alarm</b> field. Right now it shows <b>ALARM: 102 SERVOS OFF</b>.',
      () => ({ el: $('#hsScreen'), text: 'The screen', pad: 4 })),
    { id: 'hReset', atPanel: true, phase: 'Control', title: 'Clear the start-up alarm: RESET',
      text: () => 'After power-on the servos are off: alarm <b>102 SERVOS OFF</b>. That is normal. Press <b>RESET</b> (top left of the keyboard) to clear it and switch the servos on. RESET also stops a running program and clears alarms any other time.',
      skip: () => c().homed,
      target: () => (opOn() ? key('RESET', 'RESET', 'Clears alarm 102') : null),
      done: () => (!h().alarms.length && !c().estop) || c().homed || t.passed('hReset') },
    { id: 'hDoor', atPanel: true, phase: 'Control', title: 'Close the doors',
      text: () => 'The control refuses to move the axes with the door open (RUN mode). Close the doors: the <b>Doors</b> button here, or a door handle in the workshop.',
      skip: () => c().homed || c().door.target < 0.5,
      target: () => (opOn() ? { el: $('#gOpDoor'), text: 'Doors' } : null),
      done: () => c().door.target < 0.5 || c().homed || t.passed('hDoor') },
    { id: 'hPowerUp', atPanel: true, phase: 'Control', title: 'POWER UP: zero return',
      text: () => 'The control does not know where the axes are. Press <b>POWER UP</b>: the machine sends Z up first, then X and Y, to the home switches (and picks up the tool). Keep the table clear. Wait until the axes have stopped.',
      extra: () => (h().alarms.length ? '<div class="t-warn">An alarm is active: press <b>RESET</b> first.</div>' : h().doorOpen() ? '<div class="t-warn">The door is still open (or closing): wait until it is shut.</div>' : ''),
      target: () => (opOn() ? key('POWER_UP', 'POWER UP', 'Zero return of all axes') : null),
      done: () => c().homed || t.passed('hPowerUp') },
    explain('hModes', 'Mode keys', 'Control',
      'The <b>mode keys</b> are the pentagon keys at the left of each row: <b>EDIT</b> (program editor, VPS), <b>MEMORY</b> (run a program), <b>MDI</b> (one-off commands), <b>HANDLE JOG</b> (jog axes, set offsets), <b>ZERO RETURN</b> and <b>LIST PROGRAM</b> (program files). The mode shows top left on the screen.',
      () => grp('hg-modes', 'Mode keys')),
    explain('hDisplays', 'Display keys', 'Control',
      'The <b>display keys</b> choose what the main display shows: PROGRAM, POSITION, <b>OFFSET</b>, CURRENT COMMANDS, ALARMS, DIAGNOSTIC, SETTING, HELP. Pressing the same key again cycles its <b>tabs</b> (for OFFSET: Tool and Work). The arrow keys move the cursor in tables and the editor; typed text appears on the INPUT line.',
      () => grp('hg-display', 'Display keys')),
    explain('hTools', 'Tool offsets', 'Setup',
      'Every tool has its <b>length</b> (H, used by G43) and <b>diameter</b> (D) on the OFFSET > Tool tab. In the shop you touch each tool to the part top and press <b>TOOL OFFSET MEASURE</b> to store its length. In this training shop the tools are already measured, so the program can use <b>G43 H01</b>, <b>H02</b>, <b>H05</b> straight away.',
      () => key('TOOL_OFS_MEAS', 'TOOL OFFSET MEASURE', 'Stores the length of the tool in the spindle')),
    explain('hJog', 'Set the part zero: HANDLE JOG', 'Setup',
      'The program works in <b>G54</b>: the part zero, here the <b>top front-left corner</b> of the raw blank. By hand you press <b>HANDLE JOG</b>, pick an increment (.0001 to .1), jog the tool to the corner with the handle (X, Y; then Z), and press <b>PART ZERO SET</b> on the OFFSET > Work tab (once for X, once for Y). Here you will use the probe instead, which finds the corner for you.',
      () => key('HANDLE_JOG', 'HANDLE JOG', 'Jog with the handle, then PART ZERO SET')),
    { id: 'hOffsets', atPanel: true, phase: 'Setup', title: 'OFFSET > Work tab',
      text: () => 'Press <b>OFFSET</b>. The first tab is Tool; press <b>F4</b> (or OFFSET again) to get the <b>Work</b> tab with the rows G52, G54, G55 ... The cursor sits on the G54 row.',
      target: () => {
        if (!opOn()) return null;
        const hh = h();
        if (hh.disp !== 'offset') return key('OFFSET', 'OFFSET');
        return key('F4', 'F4: Work tab', 'Toggles the Tool and Work tabs');
      },
      done: () => (h().disp === 'offset' && h().tab.offset === 1) || (t.viseTight() && g.g54Ok()) || t.passed('hOffsets') },
    { id: 'g54', atPanel: true, phase: 'Setup', title: 'Set G54 on the blank',
      text: () => 'With the cursor on <b>G54</b> press <b>F3 (Probing Actions)</b> and choose <b>Probe corner: top front-left</b> (ENTER). The probe touches the blank and writes X, Y and Z of the corner into G54. (By hand: jog to the corner and press PART ZERO SET.)',
      extra: () => (c().homed ? '' : '<div class="t-warn">The machine is not homed: do the POWER UP step first.</div>'),
      target: () => {
        if (!opOn()) return null;
        const hh = h();
        if (hh.popup) {
          if (hh.popup.kind === 'list' && /^Probing/.test(hh.popup.title)) return hh.popup.row !== 0 ? key('UP', 'UP: top front-left', 'The first entry') : key('ENTER', 'ENTER: top front-left corner', 'Simulated probe: sets G54 X, Y and Z');
          return key('CANCEL', 'CANCEL closes this window');
        }
        if (hh.disp !== 'offset') return key('OFFSET', 'OFFSET');
        if (hh.tab.offset !== 1) return key('F4', 'F4: Work tab');
        if (hh.cursor('work', { row: 1, col: 1 }).row !== 1) return { el: $('#haas [data-cur="work"][data-row="1"]'), text: 'Put the cursor on G54', sub: 'UP / DOWN, or click the row' };
        return key('F3', 'F3: Probing Actions', 'WIPS probe: finds the corner');
      },
      done: () => (t.viseTight() && g.g54Ok()) || t.passed('g54') },
    { id: 'hList', atPanel: true, phase: 'Program', title: 'LIST PROGRAM: select the job program',
      text: () => `Press <b>LIST PROGRAM</b>: the program manager lists the files in the control's memory. Accepting the job created <b>${JOB}</b>; the <b>*</b> in the last column marks the active program. If it is not active, move the cursor onto it and press <b>SELECT PROGRAM</b>.`,
      enter: () => { if (!app.programs.has(JOB)) app.programs.put(JOB, g.programTemplate(P)); },
      target: () => {
        if (!opOn()) return null;
        const hh = h();
        if (hh.disp !== 'list') return key('LIST_PROGRAM', 'LIST PROGRAM');
        if (hh.tab.list !== 0) return key('LIST_PROGRAM', 'LIST PROGRAM again: Memory tab', 'Pressing it again cycles the device tabs');
        if (!onProg()) {
          const i = hh.lpFiles().findIndex((f) => f.name === JOB);
          if (i >= 0 && hh.lp.row !== i) return { el: $(`#haas [data-cur="lp"][data-row="${i}"]`), text: `Move the cursor to ${JOB}`, sub: 'UP / DOWN, or click the row' };
          return key('SELECT_PROGRAM', 'SELECT PROGRAM', 'Makes it the active program (*)');
        }
        return null;
      },
      done: () => (h().disp === 'list' && onProg()) || t.refLoaded() || t.machined() || (onProg() && h().mode === 'EDIT') },
    { id: 'hEdit', atPanel: true, phase: 'Program', title: 'EDIT: open the editor',
      text: () => `Press <b>EDIT</b>. The editor shows the active program. ${JOB} has the header and the end (<b>G28 G91 Y0.</b> brings the table forward, <b>M30</b> ends the program); the machining goes in between, below the line marked <b>&gt;&gt;&gt;</b>.`,
      target: () => (opOn() ? key('EDIT', 'EDIT') : null),
      done: () => (h().mode === 'EDIT' && h().disp === 'edit' && onProg()) || t.refLoaded() || t.machined() || (onProg() && hasOp('face')) },
    vpsStep('face', 'Face the top: VPS Face Milling'),
    vpsStep('pocket', 'Mill the pocket: VPS Rectangular Pocket'),
    vpsStep('drill', 'Drill the holes: VPS Drilling'),
    explain('hReview', 'Read the program', 'Program',
      `The VPS only wrote ordinary G-code into ${JOB}: <b>T1 M06</b> (tool change), <b>S3200 M03</b> (spindle), <b>G43 H01 Z..</b> (tool length offset on), <b>G01</b> cutting moves with <b>F</b> feed, <b>G81</b> / <b>G70</b> drilling the bolt circle, <b>M09</b>, <b>G53 G49 Z0.</b> (Z home). Always read what a template wrote before you run it. <b>GRAPHICS</b> can preview it first.`,
      () => ({ el: $('#haas .hs-mbody.edit') || $('#haas .hs-pbody'), text: 'The program', pad: 3 })),
  ];

  // ---- the run
  const run = [
    { id: 'closeDoors', atPanel: true, phase: 'Run', title: 'Close the doors',
      text: () => 'In RUN mode (the SETUP MODE key switch on the right of the control is locked) the control does not start a cycle with the door open. Close the doors with the <b>Doors</b> button or a door handle.',
      target: () => (opOn() ? { el: $('#gOpDoor'), text: 'Doors' } : null),
      done: () => c().door.target < 0.5 || c().exec?.kind === 'program' || t.passed('closeDoors') },
    { id: 'auto', atPanel: true, phase: 'Run', title: 'Select MEMORY',
      text: () => 'Press <b>MEMORY</b>: the control now runs the active program (<b>Operation: MEM</b>).',
      target: () => (opOn() ? key('MEMORY', 'MEMORY') : null),
      done: () => h().mode === 'MEM' || c().exec?.kind === 'program' || t.passed('auto') },
    { id: 'safety', atPanel: true, phase: 'Run', title: 'SINGLE BLOCK', explain: true,
      text: () => 'First runs of a new program: press <b>SINGLE BLOCK</b> so that each <b>CYCLE START</b> runs one block, and keep a finger on <b>FEED HOLD</b>. <b>GRAPHICS</b> previews the tool path without moving. Here a crash only costs a fresh blank, so you can run it straight away (SINGLE BLOCK is off).',
      target: () => (opOn() ? key('SINGLE_BLOCK', 'SINGLE BLOCK', 'One block per CYCLE START') : null),
      done: () => ack('safety') || c().exec?.kind === 'program' || c().pendingStart === 'start' || t.passed('safety') },
    explain('hOverrides', 'Overrides', 'Run',
      'The <b>override keys</b>: FEEDRATE -10% / 100% / +10%, SPINDLE the same, RAPID 5% / 25% / 50% / 100%. Turn the feed down on the first run; <b>100%</b> resets it. The values show in the spindle pane on the screen. FEED HOLD (lower left) stops the motion, CYCLE START continues.',
      () => grp('hg-overrides', 'Override keys')),
    { id: 'cycleStart', atPanel: true, phase: 'Run', title: 'CYCLE START',
      text: () => 'Press <b>CYCLE START</b> (lower left of the control). Push the <b>Simulation speed</b> slider to the right to watch it go faster.',
      target: () => (opOn() ? key('CYCLE_START', 'CYCLE START') : null),
      extra: () => (c().state === 'alarm' || h().alarms.length ? `<div class="t-warn">Alarm: ${esc(h().alarms[0]?.text || c().alarm || '')}. Press <b>RESET</b>, fix the program (or <b>Fill for me</b> on the program steps) and start again.</div>` : ''),
      done: () => c().exec?.kind === 'program' || c().pendingStart === 'start' || t.machined() },
    { id: 'watch', phase: 'Run', title: 'Watch it cut',
      text: () => 'The face mill, the end mill and the drill take turns. The tool path is drawn, chips fly and the program pane follows the current block. Wait for <b>M30</b> (program complete).',
      target: () => (opOn() && c().exec ? { el: $('#simSpeed'), text: 'Simulation speed', pad: 8 } : null),
      extra: () => (c().state === 'alarm' ? `<div class="t-warn">Alarm: ${esc(h().alarms[0]?.text || c().alarm || '')}. Press <b>RESET</b> and CYCLE START again.</div>` : c().state === 'hold' ? '<div class="t-warn">Stopped (FEED HOLD): press CYCLE START to continue.</div>' : ''),
      done: () => t.machined() },
  ];
  return { control, run };
}

// "Fill for me": write the reference blocks of the step (and the ones before it) into the program.
export function fillHaas(t, op) {
  const app = t.app, g = t.game, P = t.part, ed = app.ui.editor, hh = app.haas;
  const JOB = `JOB_${P.id}.MPF`;
  if (app.controller.exec) return;
  if (!app.programs.has(JOB)) app.programs.put(JOB, g.programTemplate(P));
  if (app.programName !== JOB && !t.refLoaded()) app.openProgram(JOB);
  const order = ['face', 'pocket', 'drill'];
  for (const o of order.slice(0, order.indexOf(op) + 1)) {
    if (OPS[o].mark.test(ed.getValue())) continue;
    const s = HAAS_TUTORIAL_STEPS.find((x) => x.id === o);
    const L = ed.getValue().replace(/\n$/, '').split('\n');
    // before the end of the program (the G28 G91 Y0. line), the subprogram after M30
    let at = L.findIndex((l) => /^G28 G91 Y0\./.test(l));
    if (at < 0) at = L.findIndex((l, i) => i > 0 && /^(M30|M02|%)/.test(l.trim()));
    L.splice(at, 0, ...s.blocks);
    if (s.subprogram) {
      const e = L.lastIndexOf('%');
      L.splice(e < 0 ? L.length : e, 0, ...s.subprogram);
    }
    ed.applyText(L.join('\n') + '\n', at);
    if (hh) hh.editCur = { line: at + s.blocks.length - 1, word: 0 };
  }
  app.ui.log(`Tutorial: ${op} filled in with the reference blocks`);
}
