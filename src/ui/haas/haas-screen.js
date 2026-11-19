// NGC-style screen: status bar, program pane, main display (tabs, tables, editor, device manager, VPS,
// graphics), spindle / position / timer panes, icon bar, input bar, system status and alarm status.
// Everything is rendered as HTML strings; each pane is only written when its HTML changed.
import { MACHINE, MATERIALS, ACCURACY } from '../../config.js';
import { fmtTime } from '../../sim/controller.js';
import { surfaceSpeed, chipLoad } from '../../sim/tooling.js';
import { VPS_TEMPLATES, illustration } from './haas-vps.js';
import { DISPLAY_TABS, TOOL_COLS, HAAS_TYPES, lineWords, progHead, haasDialect, MACRO_ROWS } from './haas.js';
import { HAAS_ALARMS } from '../../gcode/haas.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const ALARM_TEXT = {
  102: 'SERVOS OFF', 103: 'X SERVO ERROR TOO LARGE', 104: 'Y SERVO ERROR TOO LARGE', 105: 'Z SERVO ERROR TOO LARGE', 107: 'EMERGENCY STOP',
  108: 'X SERVO OVERLOAD', 109: 'Y SERVO OVERLOAD', 110: 'Z SERVO OVERLOAD', 116: 'SPINDLE ORIENTATION FAULT', 120: 'LOW AIR PRESSURE', 121: 'LOW LUBE OR LOW PRESSURE',
  130: 'TOOL UNCLAMPED', 131: 'TOOL NOT CLAMPED', 133: 'SPINDLE INOPERATIVE', 145: 'X LIMIT SWITCH', 146: 'Y LIMIT SWITCH', 147: 'Z LIMIT SWITCH',
  150: 'Z AND TOOL INTERLOCKED', 186: 'SPINDLE NOT TURNING', 198: 'SPINDLE STALLED', 223: 'DOOR LOCK FAILURE', 302: 'INVALID R IN G02 OR G03',
  303: 'INVALID X, Y OR Z IN G02 OR G03', 304: 'INVALID I, J OR K IN G02 OR G03', 305: 'INVALID Q IN CANNED CYCLE', 307: 'SUBROUTINE NESTING TOO DEEP',
  309: 'EXCEEDED MAX FEEDRATE', 311: 'UNKNOWN CODE', 312: 'PROGRAM END', 314: 'SUBPROGRAM NOT IN MEMORY', 316: 'X OVER TRAVEL RANGE', 317: 'Y OVER TRAVEL RANGE',
  318: 'Z OVER TRAVEL RANGE', 320: 'NO FEED RATE', 324: 'DELAY TIME RANGE ERROR', 326: 'G04 WITHOUT P CODE', 329: 'UNDEFINED M CODE', 337: 'GOTO OR P LINE NOT FOUND',
  339: 'MULTIPLE CODES', 340: 'CUTTER COMP BEGIN WITH G02 OR G03', 360: 'TOOL CHANGER DISABLED', 363: 'COOLANT LOCKED OFF', 383: 'INCH IS NOT SELECTED',
  384: 'METRIC IS NOT SELECTED', 403: 'TOO MANY PROGS', 436: 'DISK FILE NOT FOUND', 508: 'DIVISION BY ZERO',
};
for (const [k, v] of Object.entries(HAAS_ALARMS)) if (!(k in ALARM_TEXT)) ALARM_TEXT[k] = v;

export const SETTINGS_GROUPS = ['General', 'Program', 'Offsets / Tools', 'Axes / Door / Spindle', 'Simulator (not on the real control)'];

// Setting definitions. Values without get/set live in the control's own store (st.set).
export function settingDefs(h) {
  if (h._defs) return h._defs;
  const app = h.app;
  const list = (opts, get, set) => ({ type: 'list', opts, get, set });
  h._defs = [
    { g: 0, n: 9, name: 'Dimensioning', ...list(['INCH', 'MM'], () => (app.settings.defaultUnits === 20 ? 'INCH' : 'MM'), (v) => { app.settings.defaultUnits = v === 'INCH' ? 20 : 21; app.save(); app.compile(); if (!app.controller.exec) h.isoModal(); h.vps.vals = null; h.vps.tpl = null; }) },
    { g: 0, n: 31, name: 'Reset Program Pointer', type: 'bool', def: true },
    { g: 0, n: 83, name: 'M30/Resets Overrides', type: 'bool', def: false },
    { g: 0, n: 88, name: 'Reset Resets Overrides', type: 'bool', def: true },
    { g: 0, n: 101, name: 'Feed Override -> Rapid', type: 'bool', def: false },
    { g: 0, n: 103, name: 'Cyc Start/Fh Same Key', type: 'bool', def: false },
    { g: 0, n: 356, name: 'Beeper Volume', type: 'num', min: 0, max: 100, get: () => Math.round(app.settings.volume * 100), set: (v) => { app.settings.volume = v / 100; app.sound.setVolume(v / 100); app.save(); } },
    { g: 1, n: 17, name: 'Opt Stop Lock Out', type: 'bool', def: false },
    { g: 1, n: 18, name: 'Block Delete Lock Out', type: 'bool', def: false },
    { g: 1, n: 19, name: 'Feedrate Override Lock', type: 'bool', def: false },
    { g: 1, n: 20, name: 'Spindle Override Lock', type: 'bool', def: false },
    { g: 1, n: 21, name: 'Rapid Override Lock', type: 'bool', def: false },
    { g: 1, n: 53, name: 'Jog w/o Zero Return', type: 'bool', def: false },
    { g: 1, n: 120, name: 'Macro Var Lock', type: 'bool', def: false },
    { g: 2, n: 64, name: 'Tool Offset Measure Uses Work', type: 'bool', def: true },
    { g: 2, n: 81, name: 'Tool At Power Up', type: 'num', min: 0, max: 99, def: 0 },
    { g: 2, n: 119, name: 'Offset Lock', type: 'bool', def: false },
    { g: 2, n: 142, name: 'Offset Chng Tolerance', type: 'num', len: true, min: 0, def: 25.4 },
    { g: 3, n: 163, name: 'Disable .1 Jog Rate', type: 'bool', def: false },
    { g: 3, n: 268, name: 'Second Home Position X', type: 'num', len: true, def: -280 },
    { g: 3, n: 269, name: 'Second Home Position Y', type: 'num', len: true, def: 0 },
    { g: 3, n: 270, name: 'Second Home Position Z', type: 'num', len: true, def: 0 },
    { g: 3, n: 292, name: 'Door Open Spindle Speed Limit', type: 'num', min: 0, max: MACHINE.maxRpm, def: 750 },
    { g: 3, n: 51, name: 'Door Hold Override (legacy)', type: 'bool', def: false, ro: true },
    { g: 4, n: 'S1', name: 'Control Style', ...list(['NGC', '808D'], () => (app.settings.control === '808d' ? '808D' : 'NGC'), (v) => h.setControl(v === '808D' ? '808d' : 'haas')) },
    { g: 4, n: 'S2', name: 'Program Dialect', type: 'list', opts: ['HAAS'], ro: true, get: () => (haasDialect() === 'haas' ? 'HAAS (Siemens-mode files still run)' : 'ISO') },
    { g: 4, n: 'S3', name: 'Fresh Blank At Each MEM Start', ...list(['OFF', 'ON'], () => (app.settings.freshBlank ? 'ON' : 'OFF'), (v) => h.ui.setOption('freshBlank', v === 'ON')) },
    { g: 4, n: 'S4', name: 'Simulation Accuracy', ...list(Object.keys(ACCURACY).map((k) => k.toUpperCase()), () => app.settings.accuracy.toUpperCase(), (v) => h.ui.setOption('accuracy', v.toLowerCase())) },
    { g: 4, n: 'S5', name: 'Show Chips', ...list(['OFF', 'ON'], () => (app.settings.showChips ? 'ON' : 'OFF'), (v) => h.ui.setOption('showChips', v === 'ON')) },
    { g: 4, n: 'S6', name: 'Show Coolant', ...list(['OFF', 'ON'], () => (app.settings.showCoolant ? 'ON' : 'OFF'), (v) => h.ui.setOption('showCoolant', v === 'ON')) },
  ];
  return h._defs;
}

// ------------------------------------------------------------------------------------------ helpers
function ax(h, mm) {
  const v = h.toD(mm);
  return (Math.abs(v) < 5e-5 ? 0 : v).toFixed(h.inch ? 4 : 3);
}
const tabsHtml = (d, active) => `<div class="hs-tabs">${DISPLAY_TABS[d].map((t, i) => `<button class="hs-tab${i === active ? ' on' : ''}" data-tab="${i}" data-disp="${d}">${t}</button>`).join('')}</div>`;
const fkeys = (list) => `<div class="hs-fk">${list.filter(Boolean).map(([k, t]) => `<span data-fk="${/^F\d$|^ENTER$|^ORIGIN$/.test(k) ? k : ''}"><kbd>${k}</kbd>${t}</span>`).join('')}</div>`;

// keeps `cur` inside a window of `rows` rows; returns the first visible row
function win(h, key, cur, total, rows) {
  rows = Math.max(1, rows);
  let top = h.view[key] || 0;
  if (cur < top) top = cur;
  if (cur >= top + rows) top = cur - rows + 1;
  top = Math.max(0, Math.min(top, Math.max(0, total - rows)));
  h.view[key] = top;
  return top;
}

// the editor shows the end-of-block marker after every block
const eob = (l) => (l.trim() && l.trim() !== '%' && !/;\s*$/.test(l) ? '<span class="eob"> ;</span>' : '');

function rowsFor(h, part, minus = 0) {
  const el = h.parts[part]?.el;
  const lh = h.rowH || 16;
  return Math.max(3, Math.floor(((el?.clientHeight || 300) - minus) / lh));
}

export function haasCodes(m) {
  const g = (n) => (n == null ? '' : 'G' + (n < 10 ? '0' + n : String(n)));
  const motion = m.cycle && m.cycle !== 80 ? m.cycle : m.motion ?? 0;
  const units = m.units === 20 || m.unitsCode === 70 || m.unitsCode === 700 ? 'G20' : 'G21';
  const wcs = m.wcs >= 54 && m.wcs <= 59 ? g(m.wcs) : 'G54';
  return [g(motion), g(m.plane || 17), g(m.dist === 91 ? 91 : 90), g(m.feedMode === 95 ? 95 : 94), units, g(m.crc === 41 || m.crc === 42 ? m.crc : 40), g(m.tlo === 43 ? 43 : 49), g(m.cycle && m.cycle !== 0 ? m.cycle : 80), g(m.retract === 99 ? 99 : 98), 'G50', wcs, g(m.path === 61 ? 61 : 64), 'G69'];
}

function modeString(h) {
  const m = h.mode;
  if (m === 'LIST') return `Operation: ${{ AUTO: 'MEM', MDA: 'MDI', JOG: 'JOG', REF: 'ZERO' }[h.c.mode] || 'MEM'}`;
  return { EDIT: 'Edit: EDIT', MEM: 'Operation: MEM', MDI: 'Edit: MDI', JOG: 'Setup: JOG', ZERO: 'Setup: ZERO' }[m];
}

function curProgram(h) {
  const app = h.app;
  const text = h.ui.editor.getValue();
  const head = progHead(text);
  return { name: app.programName || '', onum: head.onum ? 'O' + head.onum : '', comment: head.comment };
}

const TITLES = { program: 'Program', position: 'Positions', offset: 'Offsets', commands: 'Current Commands', alarms: 'Alarms / Messages', diag: 'Diagnostics', setting: 'Settings', help: 'Help', list: 'List Programs', edit: 'Program Generation', graphics: 'Graphics' };

// ------------------------------------------------------------------------------------------ paint
export function paintScreen(h, force) {
  const scr = h.scr;
  if (force) for (const p of Object.values(h.parts)) p.html = null;
  const W = scr.clientWidth || 640;
  const fs = Math.max(8.5, Math.min(13, W / 62));
  if (h._fs !== fs) { h._fs = fs; scr.style.setProperty('--fs', fs.toFixed(2) + 'px'); }
  h.rowH = Math.round(fs * 1.5);
  if (h._rh !== h.rowH) { h._rh = h.rowH; scr.style.setProperty('--rh', h.rowH + 'px'); }
  scr.classList.toggle('off', !h.power);
  const boot = h.power && h.boot > 0;
  h.bootEl.hidden = !boot;
  if (!h.power) {
    for (const p of Object.values(h.parts)) if (p.html !== '') { p.el.innerHTML = ''; p.html = ''; }
    return;
  }
  if (boot) {
    const pct = Math.round((1 - h.boot / 2.2) * 100);
    h.bootEl.innerHTML = `<div class="hb-box"><b>VMC-MINI</b><span>NGC-style control</span><div class="hb-bar"><i style="width:${pct}%"></i></div><small>Loading software… ${pct}%</small></div>`;
    return;
  }
  const set = (part, html) => {
    const p = h.parts[part];
    if (p.html === html) return;
    p.html = html;
    p.el.innerHTML = html;
  };
  const now = new Date();
  set('modebar', `<span class="hs-mode">${esc(modeString(h))}</span><span class="hs-net"><i title="Network">⇅</i></span><span class="hs-clock">${now.toTimeString().slice(0, 8)}</span>`);
  set('mtitle', `<span>${TITLES[h.disp] || ''}</span>`);
  set('prog', progPane(h));
  if (h.disp === 'graphics') paintGraphics(h, set);
  else set('main', mainPane(h));
  set('bot', bottomPanes(h));
  set('icons', iconBar(h));
  set('inbar', inputBar(h));
  set('popup', popupHtml(h));
  h.parts.popup.el.hidden = !h.popup;
}

// ------------------------------------------------------------------------------------------ program pane (left)
function progPane(h) {
  const c = h.c;
  const mdi = h.mode === 'MDI';
  const lines = mdi ? h.mdiLines() : h.ui.editor.lines;
  const rows = rowsFor(h, 'prog', h.rowH * 1.3);
  let cur, exec = -1;
  if (mdi) {
    cur = h.mdiCur.line;
    if (c.exec?.kind === 'mdi') { const op = c.exec.ops[c.exec.i]; exec = op ? op.line : -1; }
  } else {
    exec = c.exec?.kind === 'program' || c.state === 'hold' ? c.line : -1;
    cur = exec >= 0 ? exec : h.mode === 'EDIT' ? h.editCur.line : h.memPtr;
  }
  const top = win(h, mdi ? 'progMdi' : 'progMem', Math.max(0, cur), lines.length, rows);
  const p = curProgram(h);
  const nWord = exec >= 0 ? (/\bN(\d+)/.exec(lines[exec] || '') || [])[1] : null;
  const title = mdi ? `<span>MDI</span><span>MDI PROGRAM</span><span>N${exec >= 0 ? exec + 1 : 0}</span>`
    : `<span>${h.mode === 'LIST' || h.mode === 'EDIT' ? 'MEM' : h.mode}</span><span>${esc(p.onum)} ${esc(p.name || 'NO ACTIVE PROGRAM')}</span><span>N${nWord || (exec >= 0 ? exec + 1 : 0)}</span>`;
  let body = '';
  for (let i = top; i < Math.min(lines.length, top + rows); i++) {
    const l = lines[i];
    let cls = '';
    if (i === exec) cls = 'exec';
    else if (!mdi && i === cur && exec < 0 && h.mode !== 'EDIT') cls = 'ptr';
    else if (h.mode === 'EDIT' && i === h.editCur.line) cls = 'ptr';
    let txt = (esc(l) || '&nbsp;') + eob(l);
    if (mdi && i === h.mdiCur.line && h.disp !== 'list') {
      const ws = lineWords(l);
      const w = ws[h.mdiCur.word];
      if (w) txt = esc(l.slice(0, w.a)) + `<em class="wcur">${esc(w.s)}</em>` + esc(l.slice(w.b)) + eob(l);
      cls = cls || 'curl';
    }
    body += `<div class="pl ${cls}" data-row="${i}" data-cur="${mdi ? 'mdi' : 'mem'}">${txt}</div>`;
  }
  if (!lines.length || (lines.length === 1 && !lines[0])) body = `<div class="pl dim">${mdi ? 'Type a block, e.g. G00 G90 G54 X0. Y0. ; then INSERT' : 'No active program'}</div>`;
  return `<div class="hs-ptitle">${title}</div><div class="hs-pbody">${body}</div>`;
}

// ------------------------------------------------------------------------------------------ main display
function mainPane(h) {
  const d = h.disp;
  const fn = { program: mainProgram, position: mainPosition, offset: mainOffset, commands: mainCommands, alarms: mainAlarms, diag: mainDiag, setting: mainSetting, help: mainHelp, list: mainList, edit: mainEdit }[d];
  return fn ? fn(h) : '';
}

function activeCodesSmall(h) {
  const c = h.c, m = c.modal;
  if (h.alarms.length) {
    return `<div class="sp"><div class="sp-h">Alarms</div><div class="sp-b alq">${h.alarms.map((a) => `<div><b>${esc(a.num)}</b> ${esc(a.text)}</div>`).join('')}<div class="dimtxt">RESET clears; ALARMS for details</div></div></div>`;
  }
  const gc = haasCodes(m);
  const addr = [['F', h.toD(m.feed || 0).toFixed(h.inch ? 1 : 0)], ['S', Math.round(m.rpm || c.spindle.cmd || 0)], ['T', c.tool], ['H', m.tloH || 0], ['D', m.D || 0], ['M', c.spindle.dir > 0 ? '03' : c.spindle.dir < 0 ? '04' : '05']];
  return `<div class="sp"><div class="sp-h">Active Codes</div><div class="sp-b ac-small"><div class="gcol">${gc.map((x) => `<span>${x}</span>`).join('')}</div><div class="acol">${addr.map(([k, v]) => `<span><b>${k}</b> ${v}</span>`).join('')}</div></div></div>`;
}

function mainProgram(h) {
  const c = h.c, app = h.app;
  const t = app.tools.find((x) => x.number === c.tool);
  const res = app.compiled;
  const g = t ? h.toolGeom(t) : null;
  const typeName = t ? (HAAS_TYPES.find((x) => x[0] === t.type) || [0, 'End Mill'])[1] : '';
  const cool = c.coolant.flood ? 'ON' : 'OFF';
  const p = curProgram(h);
  const prog = h.mode === 'MDI'
    ? `<div class="kv"><span>MDI program</span><b>${h.mdiLines().filter((l) => l.trim()).length} blocks</b><span>Run</span><b>CYCLE START</b><span>Erase</span><b>ERASE PROGRAM</b></div>`
    : `<div class="kv"><span>Active program</span><b>${esc(p.onum)} ${esc(p.name || '—')}</b><span>Comment</span><b>${esc(p.comment || '—')}</b><span>Blocks</span><b>${res ? res.lineCount : 0} (${res?.dialect === 'siemens' ? 'Siemens mode' : res?.dialect === 'haas' ? 'Haas' : 'ISO'})</b>
      <span>Est. cycle time</span><b>${res ? fmtTime(res.totalTime) : '--'}</b><span>Program check</span><b class="${res?.errors.length ? 'red' : ''}">${res?.errors.length ? `Line ${res.errors[0].line + 1}: ${esc(res.errors[0].msg)}` : 'OK'}</b></div>`;
  return `<div class="hs-mbody pgm"><div class="pgm-top">${activeCodesSmall(h)}
    <div class="sp"><div class="sp-h">Active Tool</div><div class="sp-b tool"><div class="tnum">${c.tool || '—'}</div>${t ? `<div>${esc(typeName)}</div><div>Ø ${ax(h, t.diameter)}</div><div>H ${ax(h, g.h)}</div>` : '<div class="dimtxt">Spindle empty</div>'}</div></div>
    <div class="sp narrow"><div class="sp-h">Coolant</div><div class="sp-b cool"><b class="${cool === 'ON' ? 'on' : ''}">${cool}</b><div class="gauge"><i></i></div><small>Level 1/1</small></div></div></div>
    <div class="sp grow"><div class="sp-h">Program</div><div class="sp-b">${prog}</div></div></div>`;
}

function posRows(h, kind) {
  const c = h.c;
  const o = h.st.opOrigin;
  const w = c.workPos({});
  const p = kind === 0 ? { x: c.pos.x - o.x, y: c.pos.y - o.y, z: c.pos.z - o.z } : kind === 1 ? w : kind === 2 ? { x: c.pos.x, y: c.pos.y, z: c.pos.z } : c.dtg;
  return ['x', 'y', 'z'].map((a) => [a.toUpperCase(), ax(h, p[a])]);
}

function mainPosition(h) {
  const c = h.c, tab = h.tab.position;
  const wcs = c.modal.wcs >= 54 && c.modal.wcs <= 59 ? `G${c.modal.wcs}` : 'G54';
  const names = ['Operator', `Work ${wcs}`, 'Machine', 'Dist To Go'];
  let body;
  if (tab === 4) {
    body = `<div class="pos-all">${[0, 1, 2, 3].map((k) => `<div class="pa"><div class="pa-h">${names[k]}</div>${posRows(h, k).map(([a, v]) => `<div class="pr"><b>${a}</b><span>${v}</span></div>`).join('')}</div>`).join('')}</div>`;
  } else {
    body = `<div class="pos-big"><div class="pb-h">${names[tab]} <small>(${h.inch ? 'IN' : 'MM'})</small></div>${posRows(h, tab).map(([a, v]) => `<div class="pr"><b>${a}</b><span>${v}</span></div>`).join('')}</div>`;
  }
  const inc = h.inch ? [0.0001, 0.001, 0.01, 0.1][h.incIdx] : [0.001, 0.01, 0.1, 1][h.incIdx];
  const info = h.mode === 'JOG'
    ? `<div class="hs-note">Handle: <b>${h.handleMode ? { scroll: 'SCROLL', feed: 'FEED OVERRIDE', spindle: 'SPINDLE OVERRIDE' }[h.handleMode] : h.handleAxis.toUpperCase() + ' axis'}</b> · ${inc} ${h.inch ? 'in' : 'mm'}/click${h.jogLock ? ' · JOG LOCK' : ''}${!c.homed ? ' · <span class="red">NOT ZEROED</span>' : ''}</div>`
    : h.mode === 'ZERO' ? `<div class="hs-note">ZERO RETURN: <b>ALL</b> all axes · type X/Y/Z + <b>SINGLE</b> · <b>HOME G28</b> rapid home · Zeroed: ${['x', 'y', 'z'].map((a) => `${a.toUpperCase()} ${c.ref[a] ? '●' : '○'}`).join('  ')}</div>` : '';
  return `${tabsHtml('position', tab)}<div class="hs-mbody">${body}${info}</div>${fkeys([['ORIGIN', 'Zero operator position'], ['ALTER', 'Axis display']])}`;
}

function mainOffset(h) {
  const app = h.app, c = h.c;
  const tab = h.tab.offset;
  if (tab === 0) {
    const cur = h.cursor('tool', { col: 1 });
    const rowsN = h.toolRows();
    const rows = rowsFor(h, 'main', h.rowH * 7.4);
    const top = win(h, 'tool', cur.row, rowsN.length, rows);
    const ncols = Math.max(2, Math.min(TOOL_COLS.length - 1, Math.floor(((h.parts.main.el.clientWidth || 500) - 70) / 92)));
    let c0 = h.view.toolCol || 1;
    if (cur.col < c0) c0 = cur.col;
    if (cur.col >= c0 + ncols) c0 = cur.col - ncols + 1;
    c0 = Math.max(1, Math.min(c0, TOOL_COLS.length - ncols));
    h.view.toolCol = c0;
    const cols = [0, ...Array.from({ length: ncols }, (_, i) => c0 + i)];
    const cell = (t, col) => {
      if (!t) return col === 0 ? '' : '0.';
      const g = h.toolGeom(t);
      switch (col) {
        case 1: return ax(h, g.h);
        case 2: return g.hW ? ax(h, g.hW) : '0.';
        case 3: return ax(h, g.dg);
        case 4: return g.dW ? ax(h, g.dW) : '0.';
        case 5: return t.flutes;
        case 6: return ax(h, t.diameter);
        case 7: return (HAAS_TYPES.find((x) => x[0] === t.type) || [0, 'End Mill'])[1];
        case 8: return ax(h, t.length);
        default: return '';
      }
    };
    let body = '';
    for (let r = top; r < Math.min(rowsN.length, top + rows); r++) {
      const n = rowsN[r];
      const t = app.tools.find((x) => x.number === n);
      body += `<tr class="${r % 2 ? 'alt' : ''}">${cols.map((col) => {
        if (col === 0) return `<td class="tno${n === c.tool ? ' spin' : ''}" data-row="${r}" data-cur="tool">${n}${n === c.tool ? ' <small>Spindle</small>' : ''}</td>`;
        return `<td class="${r === cur.row && col === cur.col ? 'cur' : ''}${t ? '' : ' empty'}" data-row="${r}" data-col="${col}" data-cur="tool">${cell(t, col)}</td>`;
      }).join('')}</tr>`;
    }
    return `${tabsHtml('offset', 0)}<div class="hs-mbody"><div class="ofs-head"><span>Active Tool: <b>${c.tool}</b></span><span>Coolant Position: <b>—</b></span><span>${h.inch ? 'INCH' : 'MM'}</span></div>
      <table class="ht"><thead><tr>${cols.map((col) => `<th>${col === 0 ? 'Tool Offset' : TOOL_COLS[col].replace(' (', '<br>(')}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>
      <div class="hs-prompt">${h.input ? '' : 'Enter A Value'}</div></div>${fkeys([['TOOL OFFSET MEAS', 'Tool Offset Measure'], ['F1', cur.col === 7 ? 'Choose Type' : 'Set Value'], ['ENTER', 'Add To Value'], ['F4', 'Work Offset']])}`;
  }
  const cur = h.cursor('work', { row: 1, col: 1 });
  const names = ['G52', 'G54', 'G55', 'G56', 'G57', 'G58', 'G59'];
  const act = c.modal.wcs;
  let body = '';
  names.forEach((nm, r) => {
    const o = r === 0 ? { x: 0, y: 0, z: 0 } : app.offsets[r - 1];
    const mat = r === 0 ? '' : r - 1 === 0 || act === 53 + r ? (app.stockEmpty ? 'No Material Selected' : MATERIALS[app.stock.material].short) : 'No Material Selected';
    body += `<tr class="${r % 2 ? 'alt' : ''}"><td class="tno${act === 53 + r ? ' spin' : ''}" data-row="${r}" data-cur="work">${nm}</td>${['x', 'y', 'z'].map((a, k) => `<td class="${r === cur.row && cur.col === k + 1 ? 'cur' : ''}" data-row="${r}" data-col="${k + 1}" data-cur="work">${Math.abs(o[a]) < 1e-9 ? '0.' : ax(h, o[a])}</td>`).join('')}<td class="${r === cur.row && cur.col === 4 ? 'cur' : ''} mat" data-row="${r}" data-col="4" data-cur="work">${esc(mat)}</td></tr>`;
  });
  return `${tabsHtml('offset', 1)}<div class="hs-mbody"><div class="ofs-head"><span></span><span>Axes Info</span><span>${h.inch ? 'INCH' : 'MM'}</span></div>
    <table class="ht"><thead><tr><th>G Code</th><th>X Axis</th><th>Y Axis</th><th>Z Axis</th><th>Work Material</th></tr></thead><tbody>${body}</tbody></table>
    <div class="hs-note">G154 P1–P99 are not available on this machine. Work offsets hold the machine position of the part zero (Z: tool tip).</div>
    <div class="hs-prompt">${h.input ? '' : 'Enter A Value'}</div></div>${fkeys([['PART ZERO SET', 'Part Zero Set'], ['F1', h.input ? 'Set Value' : 'To view options.'], ['F3', 'Probing Actions'], ['F4', 'Tool Offsets'], ['ENTER', 'Add To Value']])}`;
}

function mainCommands(h) {
  const c = h.c, app = h.app, tab = h.tab.commands;
  let body = '', fk = [];
  if (tab === 0) {
    const cur = h.cursor('cmd0');
    const devs = [
      ['Main Spindle', c.spindle.dir ? `${Math.round(Math.abs(c.spindle.rpm))} RPM ${c.spindle.dir > 0 ? 'CW' : 'CCW'}` : 'Stopped'],
      ['Main Spindle Orient', c.atc.busy ? 'Oriented' : '0.000'],
      ['Tool Release', c.atc.phase === 'unclamp tool' ? 'Unclamped' : 'Clamped'],
      ['Tool Changer', `Pocket ${c.carousel}${c.atc.busy ? ' (changing)' : ''}`],
      ['Coolant', c.coolant.flood ? 'On' : 'Off'],
      ['Door', h.doorOpen() ? 'Open' : 'Closed'],
      ['Chip Auger', h.chip > 0 ? 'Forward' : h.chip < 0 ? 'Reverse' : 'Off'],
      ['TSC', 'Not installed'],
    ];
    body = `<div class="hs-subtabs"><span class="on">Mechanisms</span><span>Workholding</span></div><table class="ht"><thead><tr><th>Device</th><th>State</th></tr></thead><tbody>${devs.map(([k, v], i) => `<tr class="${i % 2 ? 'alt' : ''}"><td class="${i === cur.row ? 'cur' : ''}" data-row="${i}" data-cur="cmd0">${k}</td><td>${v}</td></tr>`).join('')}</tbody></table>
      <div class="hs-group"><div class="hs-gt">Main Spindle</div>Type a speed and press F2 to set it (now ${app.settings.jogRpm} RPM). Hold F3 for CW or F4 for CCW; the spindle stops when the key is released.</div>`;
    fk = [['F2', 'Set RPM'], ['F3', 'Hold: CW'], ['F4', 'Hold: CCW']];
  } else if (tab === 1) {
    const cur = h.cursor('cmd1');
    const st = h.st;
    const rows = [
      ['Date / Time', new Date().toLocaleString()],
      ['Cycle Start Time', fmtTime(st.cycleTotal)],
      ['Feed Cutting Time', fmtTime(st.feedTotal)],
      ['M30 Counter #1', st.m30[0]],
      ['M30 Counter #2', st.m30[1]],
      ['This Cycle', fmtTime(h.timers.thisCycle)],
      ['Last Cycle', fmtTime(h.timers.lastCycle)],
      ['Power On Time (total)', fmtTime(st.powerOn)],
    ];
    body = `<table class="ht"><tbody>${rows.map(([k, v], i) => `<tr class="${i % 2 ? 'alt' : ''}"><td class="${i === cur.row ? 'cur' : ''}" data-row="${i}" data-cur="cmd1">${k}</td><td class="num">${esc(v)}</td></tr>`).join('')}</tbody></table>`;
    fk = [['ORIGIN', 'Reset highlighted timer / counter']];
  } else if (tab === 2) {
    const cur = h.cursor('cmd2');
    const rows = rowsFor(h, 'main', h.rowH * 5);
    const top = win(h, 'cmd2', cur.row, MACRO_ROWS.length, rows);
    let t = '';
    for (let i = top; i < Math.min(MACRO_ROWS.length, top + rows); i++) {
      const n = MACRO_ROWS[i], v = app.macroVars[n];
      t += `<tr class="${i % 2 ? 'alt' : ''}"><td class="tno">#${n}</td><td class="${i === cur.row ? 'cur' : ''} num" data-row="${i}" data-cur="cmd2">${v == null ? '<span class="dimtxt">(empty)</span>' : +(+v).toFixed(6)}</td></tr>`;
    }
    body = `<table class="ht"><thead><tr><th>Variable</th><th>Value</th></tr></thead><tbody>${t}</tbody></table>`;
    fk = [['ENTER', 'Set Value']];
  } else if (tab === 3) {
    const m = c.modal;
    const gc = haasCodes(m);
    const addr = ['N', 'X', 'Y', 'Z', 'I', 'J', 'K', 'P', 'Q', 'R'].map((k) => [k, '0.']);
    const pos = c.workPos({});
    addr[1][1] = ax(h, pos.x); addr[2][1] = ax(h, pos.y); addr[3][1] = ax(h, pos.z);
    const ln = c.line >= 0 ? (/\bN(\d+)/.exec(h.ui.editor.lines[c.line] || '') || [])[1] : null;
    addr[0][1] = ln || 0;
    if (m.cycR != null) addr[9][1] = ax(h, m.cycR);
    if (m.cycQ) addr[8][1] = ax(h, m.cycQ);
    const t = app.tools.find((x) => x.number === c.tool);
    const vc = t ? surfaceSpeed(t.diameter, Math.abs(c.spindle.rpm)) : 0;
    body = `<div class="ac-full"><div><div class="ach">G-Codes</div>${gc.map((x) => `<div>${x}</div>`).join('')}</div>
      <div><div class="ach">Address Codes</div>${addr.map(([k, v]) => `<div><b>${k}</b> ${v}</div>`).join('')}</div>
      <div><div class="ach">DHMT Codes</div><div><b>D</b> ${String(m.D || 0).padStart(2, '0')}</div><div><b>H</b> ${String(m.tloH || 0).padStart(2, '0')}</div><div><b>M</b> ${c.spindle.dir > 0 ? '03' : c.spindle.dir < 0 ? '04' : '05'}${c.coolant.flood ? ' 08' : ' 09'}</div><div><b>T</b> ${String(c.tool).padStart(2, '0')}</div></div>
      <div><div class="ach">Speeds &amp; Feeds</div><div>Programmed Feed Rate <b>${h.toD(m.feed || 0).toFixed(h.inch ? 2 : 0)}</b></div><div>Actual Feed Rate <b>${h.toD(c.speed * 60).toFixed(h.inch ? 2 : 0)}</b></div><div>Programmed Speed <b>${Math.round(m.rpm || 0)}</b></div><div>Commanded Speed <b>${Math.round(Math.abs(c.spindleTarget))}</b></div><div>Actual Speed <b>${Math.round(Math.abs(c.spindle.rpm))}</b></div><div>Direction <b>${c.spindle.dir > 0 ? 'Forward' : c.spindle.dir < 0 ? 'Reverse' : 'Stop'}</b></div><div>Surface speed <b>${h.inch ? Math.round(vc * 3.281) + ' FPM' : Math.round(vc) + ' m/min'}</b></div></div></div>`;
    fk = [['ENTER', 'View full text.']];
  } else {
    const cur = h.cursor('cmd4');
    const rows = rowsFor(h, 'main', h.rowH * 5);
    const top = win(h, 'cmd4', cur.row, MACHINE.atcPockets, rows);
    let t = '';
    for (let p = top; p < Math.min(MACHINE.atcPockets, top + rows); p++) {
      const tool = app.tools.find((x) => x.number === p + 1);
      t += `<tr class="${p % 2 ? 'alt' : ''}"><td class="tno">${p + 1}${c.carousel === p + 1 ? ' *' : ''}</td><td class="${p === cur.row ? 'cur' : ''}" data-row="${p}" data-cur="cmd4">${tool ? tool.number : '0'}</td><td>${tool ? esc(tool.name) : '<span class="dimtxt">empty</span>'}</td><td>${tool ? `${(tool.wear || 0).toFixed(0)}%` : ''}</td></tr>`;
    }
    body = `<div class="ofs-head"><span>Active Tool: <b>${c.tool}</b></span><span>Active Pocket: <b>${c.tool || '—'}</b></span></div><table class="ht"><thead><tr><th>Pocket</th><th>Tool</th><th>Description</th><th>Life used</th></tr></thead><tbody>${t}</tbody></table>`;
    fk = [['INSERT', 'Add a tool'], ['DELETE', 'Remove tool']];
  }
  return `${tabsHtml('commands', tab)}<div class="hs-mbody">${body}</div>${fkeys(fk)}`;
}

function mainAlarms(h) {
  const tab = h.tab.alarms;
  let body = '', fk = [];
  const cur = h.cursor('al' + tab);
  const rows = rowsFor(h, 'main', h.rowH * 5);
  if (tab === 0) {
    body = h.alarms.length ? h.alarms.map((a, i) => `<div class="alr ${i === cur.row ? 'cur' : ''}"><b>${esc(a.num)}</b><span>${esc(a.text)}</span><time>${a.t.toTimeString().slice(0, 8)}</time></div>`).join('') + `<div class="hs-note">${h.hasAlarm(107) ? 'Release the E-STOP (twist), then press RESET twice (107, then 102).' : 'RESET clears the alarms.'}</div>` : '<div class="noal">NO ALARM</div>';
    fk = [['RESET', 'Clear alarms'], ['PAGE UP / DOWN', 'More']];
  } else if (tab === 1) {
    const m = h.st.messages;
    body = `<div class="msgs">${m.map((t, i) => `<div class="${i === cur.row ? 'cur' : ''}" data-row="${i}" data-cur="al1">${esc(t)}</div>`).join('') || '<div class="dimtxt">No messages. Type a note on the input line and press ENTER.</div>'}</div>`;
    fk = [['ENTER', 'Add line'], ['DELETE', 'Remove line'], ['ERASE PROGRAM', 'Clear all']];
  } else if (tab === 2) {
    const L = h.alarmHist;
    const top = win(h, 'al2', cur.row, L.length, rows);
    body = L.length ? L.slice(top, top + rows).map((a, k) => `<div class="alr ${top + k === cur.row ? 'cur' : ''}"><b>${esc(a.num)}</b><span>${esc(a.text)}</span><time>${a.t.toLocaleDateString()} ${a.t.toTimeString().slice(0, 8)}</time></div>`).join('') : '<div class="noal">NO ALARM HISTORY</div>';
    fk = [['F1', 'Search (type number or text)']];
  } else if (tab === 3) {
    const L = Object.entries(ALARM_TEXT);
    const top = win(h, 'al3', cur.row, L.length, rows);
    body = L.slice(top, top + rows).map(([k, v], i) => `<div class="alr ${top + i === cur.row ? 'cur' : ''}"><b>${k}</b><span>${v}</span></div>`).join('');
    fk = [['F1', 'Search (type number or text)']];
  } else {
    const L = h.keyHist;
    const top = win(h, 'al4', cur.row, L.length, rows);
    body = L.slice(top, top + rows).map((k, i) => `<div class="alr ${top + i === cur.row ? 'cur' : ''}"><b>${k.t.toTimeString().slice(0, 8)}</b><span>${esc(k.id.replace(/^[AN]_/, '').replace(/_/g, ' '))}</span></div>`).join('') || '<div class="dimtxt">No keys pressed yet</div>';
  }
  return `${tabsHtml('alarms', tab)}<div class="hs-mbody">${body}</div>${fkeys(fk)}`;
}

function mainDiag(h) {
  const tab = h.tab.diag, c = h.c, app = h.app;
  let body = '';
  const kv = (rows) => `<table class="ht"><tbody>${rows.map(([k, v, on], i) => `<tr class="${i % 2 ? 'alt' : ''}"><td>${k}</td><td class="num ${on === true ? 'g' : on === false ? 'dimtxt' : ''}">${v}</td></tr>`).join('')}</tbody></table>`;
  if (tab === 0) {
    body = kv([['Machine', 'Vertical machining center (3 axis)'], ['Control software', 'NGC-style simulator'], ['Visual Programming System', 'Purchased', true], ['Macros', haasDialect() === 'haas' ? 'Purchased' : 'Not available'], ['Rigid tapping', 'Not installed', false], ['Programmable coolant', 'Not installed', false], ['Through-spindle coolant', 'Not installed', false], ['WIPS probing', 'Simulated (OFFSET > Work > F3)', true], ['Auto door', 'Not installed', false], ['Max spindle speed', `${MACHINE.maxRpm} RPM`], ['Tool changer', `${MACHINE.atcPockets}-pocket umbrella`]]);
  } else if (tab === 1) {
    body = kv([['Thermal compensation', 'Off'], ['Lead screw compensation', 'Not required (simulated machine)'], ['Spindle growth', '0.']]);
  } else if (tab === 2) {
    const t = app.stats;
    body = `<div class="io2">${kv([['Door switch', h.doorOpen() ? 'OPEN' : 'CLOSED', !h.doorOpen()], ['E-Stop', h.estopLatched ? 'PRESSED' : 'OK', !h.estopLatched], ['Air pressure', 'OK', true], ['Way lube', 'OK', true], ['Tool clamped', c.atc.phase === 'unclamp tool' ? 'NO' : 'YES', true], ['Spindle at speed', Math.abs(Math.abs(c.spindle.rpm) - Math.abs(c.spindleTarget)) < 5 ? 'YES' : 'NO'], ['Coolant level', 'FULL', true], ['Zero returned X Y Z', ['x', 'y', 'z'].map((a) => (c.ref[a] ? '1' : '0')).join(' ')]])}
      ${kv([['Spindle forward', c.spindle.dir > 0 ? 'ON' : 'OFF', c.spindle.dir > 0], ['Spindle reverse', c.spindle.dir < 0 ? 'ON' : 'OFF', c.spindle.dir < 0], ['Coolant pump', c.coolant.flood ? 'ON' : 'OFF', c.coolant.flood], ['Beacon', (h.beaconNow || 'off').toUpperCase()], ['Work light', app.settings.lights !== false ? 'ON' : 'OFF'], ['Spindle load', `${(t.load || 0).toFixed(0)} %`], ['Spindle temperature', `${t.temp.toFixed(1)} °C`], ['Tool changer', c.atc.busy ? c.atc.phase.toUpperCase() : 'IN POSITION']])}</div>`;
  } else {
    body = kv([['Power on time', fmtTime(h.st.powerOn)], ['Cycle start time', fmtTime(h.st.cycleTotal)], ['Feed cutting time', fmtTime(h.st.feedTotal)], ['Tool changes', h.st.toolChanges], ['Coolant', 'Check concentration weekly'], ['Way lube', 'Check level daily'], ['Spindle', 'Warm up after 4 days idle']]);
  }
  return `${tabsHtml('diag', tab)}<div class="hs-mbody">${body}</div>${fkeys([])}`;
}

function mainSetting(h) {
  const cur = h.cursor('setting', { group: null });
  let body;
  if (cur.group == null) {
    body = `<table class="ht"><thead><tr><th>Group</th><th>Settings</th></tr></thead><tbody>${SETTINGS_GROUPS.map((g, i) => `<tr class="${i % 2 ? 'alt' : ''}"><td class="${i === cur.row ? 'cur' : ''}" data-row="${i}" data-cur="setting">${g}</td><td class="dimtxt">${settingDefs(h).filter((d) => d.g === i).map((d) => d.n).join(', ')}</td></tr>`).join('')}</tbody></table><div class="hs-note">RIGHT or ENTER opens a group. Type a setting number and press F1 to jump to it.</div>`;
  } else {
    const list = h.settingList();
    const rows = rowsFor(h, 'main', h.rowH * 6);
    const top = win(h, 'set' + cur.group, cur.srow || 0, list.length, rows);
    body = `<div class="ofs-head"><span><b>${SETTINGS_GROUPS[cur.group]}</b></span><span>LEFT returns to the groups</span></div><table class="ht"><thead><tr><th>Setting</th><th>Description</th><th>Value</th></tr></thead><tbody>${list.slice(top, top + rows).map((s, k) => {
      const i = top + k;
      let v = h.settingValue(s);
      if (s.len && typeof v === 'number') v = h.fmtNum(v);
      return `<tr class="${i % 2 ? 'alt' : ''}"><td class="tno">${s.n}</td><td>${s.name}${s.ro ? ' <small class="dimtxt">(read-only)</small>' : ''}</td><td class="${i === cur.srow ? 'cur' : ''} num" data-row="${i}" data-cur="settingrow">${esc(v)}</td></tr>`;
    }).join('')}</tbody></table>`;
  }
  return `${tabsHtml('setting', 0)}<div class="hs-mbody">${body}</div>${fkeys([['F1', 'Find setting #'], ['ENTER', 'Write value'], ['RIGHT', 'Choices'], ['ORIGIN', 'Default']])}`;
}

const HELP_TOPICS = [
  ['Keyboard', 'DISPLAY keys pick the screen (press again for the next tab). MODE keys (pointed) pick the mode; the keys to their right work in that mode. Type on the alpha / numeric keys: the text goes to the INPUT line. CANCEL deletes the last character, ENTER writes it.'],
  ['Power up', 'Release the E-STOP, close the door, press RESET to clear 102 SERVOS OFF, then POWER UP: Z returns first, then X and Y. POWER OFF / POWER ON restarts the control.'],
  ['Jogging', 'HANDLE JOG, pick .0001/.1 … .1/100. Press an axis key to select it for the handle, then turn the handle (drag or scroll). Holding an axis key jogs at the lower legend rate (in/min; mm/min ×25 in metric). JOG LOCK keeps it moving.'],
  ['Tool length', 'Load the tool, jog it down onto the part top (paper test with .0001/.1), OFFSET › Tool, highlight the tool, press TOOL OFFSET MEASURE. With Setting 64 on the value is relative to the work offset Z. NEXT TOOL loads the next tool.'],
  ['Work offset', 'OFFSET › Work (F4). Cursor to G54 X. Touch the edge, press PART ZERO SET (X), again for Y. Type a value + ENTER to add (edge finder radius), F1 to set. F3 Probing Actions sets G54 from the part like a probe cycle.'],
  ['Running', 'LIST PROGRAM, highlight, SELECT PROGRAM. MEMORY, close the door, CYCLE START. SINGLE BLOCK steps, FEED HOLD pauses, RESET stops. GRAPHICS simulates without motion.'],
  ['MDI', 'MDI, type e.g. T1 M06 ; then INSERT. Add more blocks. CYCLE START runs them. ERASE PROGRAM clears the MDI program.'],
  ['Editing', 'EDIT. Cursor selects a word. Type text: INSERT puts it after the word (with ; as a new block), ALTER replaces the word, DELETE removes it, UNDO undoes (40 steps). F2 selects blocks, F1 opens the menu (search, renumber).'],
  ['VPS', 'EDIT, then the VPS tab (or F4 in the editor). Pick a template, fill in the variables (type + ENTER), F4 generates G-code into the program, MDI or a new program. CYCLE START runs it in MDI.'],
  ['Door', 'SETUP MODE key switch locked = RUN mode: the door must be closed to run and stays locked while running. Unlocked = SETUP mode: jogging with the door open, 25 % rapids, Setting 292 spindle limit, hold CYCLE START to run.'],
];

function mainHelp(h) {
  const tab = h.tab.help;
  if (tab === 1) {
    const ex = h.calc.lines.map((l) => `<div>${esc(l)}</div>`).join('');
    const t = h.app.tools.find((x) => x.number === h.c.tool);
    const rpm = Math.abs(h.c.spindle.cmd || h.c.modal.rpm || 0);
    const mill = t ? `<div class="hs-group"><div class="hs-gt">Milling (T${t.number}, Ø${ax(h, t.diameter)})</div>Speed ${rpm} RPM → surface speed ${h.inch ? Math.round(surfaceSpeed(t.diameter, rpm) * 3.281) + ' FPM' : Math.round(surfaceSpeed(t.diameter, rpm)) + ' m/min'}; feed ${h.toD(h.c.modal.feed || 0).toFixed(h.inch ? 2 : 0)} → chip load ${h.toD(chipLoad(h.c.modal.feed || 0, rpm, t.flutes) || 0).toFixed(h.inch ? 4 : 3)} per tooth (${t.flutes} flutes).</div>` : '';
    return `${tabsHtml('help', 1)}<div class="hs-mbody"><div class="hs-group"><div class="hs-gt">Standard</div>Type an expression on the input line (+ - * / ^ ( ), sin cos tan sqrt abs pi, angles in degrees) and press ENTER.<div class="calc">${ex || '<span class="dimtxt">No calculations yet</span>'}</div></div>${mill}</div>${fkeys([['ENTER', 'Calculate'], ['F1', 'Clear']])}`;
  }
  const cur = h.cursor('help0');
  cur.row = Math.min(cur.row, HELP_TOPICS.length - 1);
  return `${tabsHtml('help', 0)}<div class="hs-mbody help2"><div class="hl">${HELP_TOPICS.map((t, i) => `<div class="${i === cur.row ? 'cur' : ''}" data-row="${i}" data-cur="help0">${t[0]}</div>`).join('')}</div><div class="ht2"><b>${HELP_TOPICS[cur.row][0]}</b><p>${HELP_TOPICS[cur.row][1]}</p></div></div>${fkeys([['UP / DOWN', 'Topic']])}`;
}

function mainList(h) {
  const files = h.lpFiles();
  const rows = rowsFor(h, 'main', h.rowH * 6);
  const top = win(h, 'lp' + h.tab.list, h.lp.row, files.length, rows);
  const app = h.app;
  const body = files.slice(top, top + rows).map((f, k) => {
    const i = top + k;
    const mark = h.lp.marked.has(f.name) ? '☑' : '☐';
    const flag = !f.usb && f.name === app.programName ? '*' : '';
    return `<tr class="${i % 2 ? 'alt' : ''}${i === h.lp.row ? ' cur' : ''}" data-row="${i}" data-cur="lp"><td>${mark}</td><td>${f.onum ? 'O' + esc(f.onum) : ''}</td><td class="cm">${esc(f.comment)}</td><td>${esc(f.name)}</td><td class="num">${(f.size / 1024).toFixed(1)}K</td><td>${flag}</td></tr>`;
  }).join('') || `<tr><td colspan="6" class="dimtxt">${h.tab.list === 0 ? 'No programs. INSERT creates one.' : 'Empty'}</td></tr>`;
  const sel = files[h.lp.row];
  const free = 958 - Math.round(app.programs.names().reduce((s, n) => s + app.programs.get(n).length, 0) / 1e6);
  return `${tabsHtml('list', h.tab.list)}<div class="hs-mbody lp"><div class="lp-main"><div class="lp-top"><span>Current Directory: <b>${h.tab.list === 0 ? 'Memory/' : 'USB/'}</b></span><span class="lp-search">Search (TEXT) [F1], or [F1] to clear. <i>${esc(h.lp.search || '')}</i></span></div>
    <table class="ht lpt"><thead><tr><th></th><th>O #</th><th>Comment</th><th>File Name</th><th>Size</th><th></th></tr></thead><tbody>${body}</tbody></table>
    <div class="lp-foot"><span>File Name: <b>${esc(sel?.name || '')}</b></span><span>File comment: ${esc(sel?.comment || '')}</span><span>Folder Has: ${files.length} Items</span><span>Disk space: ${free} MB FREE</span><span>Selected Items: ${h.lp.marked.size}</span></div></div>
    <div class="lp-btns">${[['New', 'INSERT'], ['Load', 'SELECT PROG'], ['Edit', 'ALTER'], ['Mark', 'ENTER'], ['Copy', 'F2'], ['File', 'F3'], ['System', 'F4', true]].map(([a, b, dis]) => `<div class="lpb${dis ? ' dis' : ''}"><b>${a}</b><small>[${b}]</small></div>`).join('')}</div></div>`;
}

function mainEdit(h) {
  const tab = h.tab.edit;
  if (tab === 1) return mainVps(h);
  const ed = h.ui.editor;
  const lines = ed.lines;
  const app = h.app;
  const cur = h.editCur;
  cur.line = Math.min(cur.line, Math.max(0, lines.length - 1));
  const rows = rowsFor(h, 'main', h.rowH * 7.5);
  const top = win(h, 'edit', cur.line, lines.length, rows);
  const sel = h.sel ? [Math.min(h.sel.a, h.sel.b), Math.max(h.sel.a, h.sel.b)] : null;
  let body = '';
  for (let i = top; i < Math.min(lines.length, top + rows); i++) {
    const l = lines[i];
    let txt = (esc(l) || '&nbsp;') + eob(l);
    if (i === cur.line) {
      const ws = lineWords(l);
      const w = ws[cur.word];
      if (w) txt = esc(l.slice(0, w.a)) + `<em class="wcur">${esc(w.s)}</em>` + esc(l.slice(w.b)) + eob(l);
    }
    const err = app.compiled?.errors.some((e) => e.line === i);
    body += `<div class="el${i === cur.line ? ' curl' : ''}${sel && i >= sel[0] && i <= sel[1] ? ' sel' : ''}${err ? ' err' : ''}" data-row="${i}" data-cur="edit"><span class="ln">${i + 1}</span>${txt}</div>`;
  }
  const errs = app.compiled?.errors || [];
  const clip = h.clip ? esc(h.clip.split('\n').slice(0, 2).join(' ; ')) + (h.clip.split('\n').length > 3 ? ' …' : '') : '<span class="dimtxt">empty</span>';
  return `${tabsHtml('edit', 0)}<div class="hs-mbody edit"><div class="ed-path">MEMORY/${esc(app.programName || '(no program)')}</div><div class="ed-menu"><span>FILE</span><span>EDIT</span><span>SEARCH</span><span>MODIFY</span><span>OPTIONS</span><em>MEM TO SAVE AND LOAD | PRESS F1 TO OPEN MENU</em></div>
    <div class="ed-code">${body || '<div class="el dimtxt">No program: LIST PROGRAM, then INSERT (new) or ALTER (edit)</div>'}</div>
    <div class="ed-clip"><b>Clipboard</b> ${clip}${errs.length ? `<span class="red"> · ${errs.length} error(s): line ${errs[0].line + 1}: ${esc(errs[0].msg)}</span>` : ''}</div></div>
    ${fkeys([['INSERT', 'Insert'], ['ALTER', 'Alter'], ['DELETE', 'Delete'], ['UNDO', 'Undo'], ['F1', 'Menu'], ['F2', h.sel?.open ? 'End select' : 'Select'], ['F4', 'VPS']])}`;
}

function mainVps(h) {
  const v = h.vps;
  if (!v.tpl) {
    const cats = {};
    VPS_TEMPLATES.forEach((t, i) => { (cats[t.cat] = cats[t.cat] || []).push([t, i]); });
    const recent = v.recent.map((id) => VPS_TEMPLATES.find((t) => t.id === id)?.name).filter(Boolean);
    const sel = VPS_TEMPLATES[v.dirRow];
    return `${tabsHtml('edit', 1)}<div class="hs-mbody vps"><div class="vps-dir"><div class="vps-h">Template Directory</div>${Object.entries(cats).map(([cat, list]) => `<div class="vps-cat">VPS / ${esc(cat)}</div>${list.map(([t, i]) => `<div class="vps-it${i === v.dirRow ? ' cur' : ''}" data-row="${i}" data-cur="vpsdir">${esc(t.name)}</div>`).join('')}`).join('')}
      <div class="vps-h">Recently Used Templates</div>${recent.map((n) => `<div class="vps-it dimtxt">${esc(n)}</div>`).join('') || '<div class="vps-it dimtxt">—</div>'}</div>
      <div class="vps-prev">${sel ? `<b>${esc(sel.name)}</b>${illustration(sel, Object.fromEntries(sel.vars.map((x) => [x.k, x.def[h.inch ? 1 : 0]])), null)}<p>${esc(sel.blurb)}</p>` : ''}</div></div>${fkeys([['ENTER', 'Load template'], ['F4', '—']])}`;
  }
  const tpl = VPS_TEMPLATES.find((t) => t.id === v.tpl);
  const rows = rowsFor(h, 'main', h.rowH * 5);
  const top = win(h, 'vps', v.row, tpl.vars.length, rows);
  const unit = (x) => ({ len: h.inch ? 'in' : 'mm', feed: h.inch ? 'in/min' : 'mm/min', rpm: 'RPM', pct: '%' }[x.kind] || '');
  const t = tpl.vars.slice(top, top + rows).map((x, k) => {
    const i = top + k;
    return `<tr class="${i % 2 ? 'alt' : ''}"><td class="tno">${x.k}</td><td class="vd">${esc(x.desc)}</td><td class="${i === v.row ? 'cur' : ''} num" data-row="${i}" data-cur="vps">${v.changed.has(x.k) ? '*' : ''}${+(+v.vals[x.k]).toFixed(4)}</td><td class="dimtxt">${unit(x)}</td></tr>`;
  }).join('');
  const vr = tpl.vars[v.row];
  return `${tabsHtml('edit', 1)}<div class="hs-mbody vps"><div class="vps-vars"><div class="vps-h">VPS / ${esc(tpl.cat)} / ${esc(tpl.name)}</div><table class="ht"><tbody>${t}</tbody></table></div>
    <div class="vps-prev">${illustration(tpl, v.vals, vr.k)}<p><b>${vr.k}</b>: ${esc(vr.desc)}</p></div></div>${fkeys([['F4', 'Generate G-code'], ['CYCLE START', 'Run in MDI'], ['ORIGIN', 'Default'], ['LEFT', 'Templates']])}`;
}

// ------------------------------------------------------------------------------------------ graphics
function paintGraphics(h, set) {
  const p = h.parts.main;
  if (!p.el.querySelector('canvas.hs-gfx')) {
    p.el.innerHTML = `<div class="gfx-planes"><span class="on">[1] G17 XY</span><span>[2] G18 ZX</span><span>[3] G19 YZ</span></div><div class="gfx-wrap"><canvas class="hs-gfx"></canvas></div><div class="gfx-stat"></div>${fkeys([['F2', 'Zoom'], ['F3', 'Slower'], ['F4', 'Faster'], ['PAGE UP / DOWN', 'Zoom +/-'], ['HOME', 'Reset zoom'], ['CYCLE START', 'Run']])}`;
    p.html = '__gfx';
  }
  const cv = p.el.querySelector('canvas.hs-gfx');
  const wrap = cv.parentElement;
  const W = Math.max(50, wrap.clientWidth), H = Math.max(50, wrap.clientHeight);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const g = cv.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, W, H);
  const prog = h.graphics.prog || h.app.compiled;
  const ops = prog?.ops || [];
  // bounds of the toolpath in work coordinates (XY)
  const wo = h.app.offsets[0];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const op of ops) {
    if (op.t !== 'move') continue;
    for (let i = 0; i < op.pts.length; i += 3) {
      const x = op.pts[i] - wo.x, y = op.pts[i + 1] - wo.y;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (!isFinite(minX)) { minX = -60; maxX = 60; minY = -40; maxY = 40; }
  const pad = 20;
  const sc = Math.min((W - 2 * pad) / Math.max(1, maxX - minX), (H - 2 * pad) / Math.max(1, maxY - minY)) * h.graphics.zoom;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const X = (x) => W / 2 + (x - wo.x - cx) * sc, Y = (y) => H / 2 - (y - wo.y - cy) * sc;
  // part zero and blank outline
  const pl = h.app.placement;
  if (pl && !h.app.stockEmpty) {
    const tc = MACHINE.tableCenter;
    g.strokeStyle = '#9aa3ad';
    g.setLineDash([4, 3]);
    g.strokeRect(X(pl.x0 + tc.x), Y(pl.y0 + tc.y + pl.ly), pl.lx * sc, pl.ly * sc);
    g.setLineDash([]);
  }
  g.strokeStyle = '#1a3d8a';
  g.beginPath(); g.moveTo(X(wo.x) - 8, Y(wo.y)); g.lineTo(X(wo.x) + 8, Y(wo.y)); g.moveTo(X(wo.x), Y(wo.y) - 8); g.lineTo(X(wo.x), Y(wo.y) + 8); g.stroke();
  const tEnd = h.graphics.run || h.graphics.t > 0 ? h.graphics.t : Infinity;
  let tip = null;
  for (const op of ops) {
    if (op.t !== 'move') continue;
    if (op.tStart > tEnd) break;
    const frac = op.tStart + op.time > tEnd ? Math.max(0, (tEnd - op.tStart) / Math.max(1e-6, op.time)) : 1;
    const lim = op.len * frac;
    g.strokeStyle = op.rapid ? '#1aa34a' : '#111';
    g.setLineDash(op.rapid ? [5, 4] : []);
    g.lineWidth = op.rapid ? 1 : 1.3;
    g.beginPath();
    g.moveTo(X(op.pts[0]), Y(op.pts[1]));
    for (let i = 1; i < op.cum.length; i++) {
      if (op.cum[i] > lim) {
        const a = op.cum[i - 1], f = (lim - a) / Math.max(1e-9, op.cum[i] - a);
        const x = op.pts[(i - 1) * 3] + (op.pts[i * 3] - op.pts[(i - 1) * 3]) * f, y = op.pts[(i - 1) * 3 + 1] + (op.pts[i * 3 + 1] - op.pts[(i - 1) * 3 + 1]) * f;
        g.lineTo(X(x), Y(y));
        tip = [x, y];
        break;
      }
      g.lineTo(X(op.pts[i * 3]), Y(op.pts[i * 3 + 1]));
      tip = [op.pts[i * 3], op.pts[i * 3 + 1]];
    }
    g.stroke();
    if (op.cycle && frac >= 1) { g.strokeStyle = '#c21d1d'; g.setLineDash([]); const x = X(op.pts[op.pts.length - 3]), y = Y(op.pts[op.pts.length - 2]); g.beginPath(); g.moveTo(x - 3, y - 3); g.lineTo(x + 3, y + 3); g.moveTo(x + 3, y - 3); g.lineTo(x - 3, y + 3); g.stroke(); }
  }
  g.setLineDash([]);
  if (tip && h.graphics.run) { g.fillStyle = '#f08c00'; g.beginPath(); g.arc(X(tip[0]), Y(tip[1]), 5, 0, Math.PI * 2); g.fill(); }
  const st = p.el.querySelector('.gfx-stat');
  const txt = `Tool: T${h.c.tool} · Work G54: + · Run Speed: ${h.graphics.speed}× · ${h.graphics.run ? 'RUNNING' : h.graphics.t > 0 ? 'END' : 'CYCLE START to run'} · ${prog ? fmtTime(Math.min(h.graphics.t, prog.totalTime)) + ' / ' + fmtTime(prog.totalTime) : ''}`;
  if (st.textContent !== txt) st.textContent = txt;
}

// ------------------------------------------------------------------------------------------ bottom panes
function bar(pct) {
  const p = Math.max(0, Math.min(100, pct));
  return `<div class="lbar"><i style="left:${p}%"></i></div>`;
}

function bottomPanes(h) {
  const c = h.c, app = h.app;
  const t = app.tools.find((x) => x.number === c.tool);
  const rpm = Math.abs(c.spindle.rpm);
  const load = app.stats.load || 0;
  const vc = t ? surfaceSpeed(t.diameter, rpm) : 0;
  const fz = t && c.speed > 0 && !c.rapidMove ? chipLoad(c.speed * 60, rpm, t.flutes) : 0;
  const ov = c.overrides;
  const icon = c.spindle.dir === 0 && rpm < 1 ? '<svg viewBox="0 0 40 40" class="oct"><path d="M12 2h16l10 10v16L28 38H12L2 28V12z" fill="#d11"/><text x="20" y="24.5" text-anchor="middle" font-size="10" font-weight="700" fill="#fff">STOP</text></svg>'
    : `<svg viewBox="0 0 40 40" class="oct"><circle cx="20" cy="20" r="17" fill="#1aa34a"/><path d="${c.spindle.dir > 0 ? 'M20 9a11 11 0 1 1-10 6.5' : 'M20 9a11 11 0 1 0 10 6.5'}" fill="none" stroke="#fff" stroke-width="3"/><path d="${c.spindle.dir > 0 ? 'M6 13l4 3 3-5' : 'M34 13l-4 3-3-5'}" fill="none" stroke="#fff" stroke-width="3"/></svg>`;
  const spin = `<div class="bp spin"><div class="bp-h"><span class="tabon">MAIN SPINDLE</span></div><div class="bp-b"><div class="sp-l">${icon}<div class="ovr"><b>OVERRIDES</b><div>FEED: ${ov.feed}%</div><div>SPINDLE: ${ov.spindle}%</div><div>RAPID: ${ov.rapid}%</div></div></div>
    <div class="sp-r"><div><span>SPINDLE SPEED:</span><b>${Math.round(rpm)}</b></div><div><span>SPINDLE LOAD(kW):</span><b>${(load / 100 * MACHINE.spindlePowerKw).toFixed(1)}</b></div><div><span>SURFACE SPEED(${h.inch ? 'FPM' : 'm/min'}):</span><b>${h.inch ? Math.round(vc * 3.281) : Math.round(vc)}</b></div><div><span>CHIP LOAD:</span><b>${h.toD(fz).toFixed(h.inch ? 4 : 3)}</b></div><div><span>FEED RATE:</span><b>${h.toD(c.modal.feed || 0).toFixed(h.inch ? 2 : 0)}</b></div><div><span>ACTIVE FEED:</span><b>${h.toD(c.speed * 60).toFixed(h.inch ? 2 : 0)}</b></div></div>
    <div class="sp-load"><span>SPINDLE LOAD(%)</span>${bar(load)}<b>${load.toFixed(0)}%</b></div></div></div>`;
  // per-axis load from the axis speed (and the cut)
  const now = performance.now();
  const lp = h._lp || (h._lp = { t: now, p: { ...c.pos }, v: { x: 0, y: 0, z: 0 } });
  const dt = (now - lp.t) / 1000;
  if (dt > 0.05) {
    for (const a of ['x', 'y', 'z']) lp.v[a] = lp.v[a] * 0.5 + 0.5 * Math.abs(c.pos[a] - lp.p[a]) / dt;
    lp.p = { ...c.pos };
    lp.t = now;
  }
  const axLoad = (a) => Math.min(100, (c.homed || c.exec ? 2 : 0) + (lp.v[a] / (MACHINE.rapidXY / 60)) * 45 + (app.stats.cutting && lp.v[a] > 0.1 ? load * 0.3 : 0));
  const wcs = c.modal.wcs >= 54 && c.modal.wcs <= 59 ? `G${c.modal.wcs}` : 'G54';
  const w = c.workPos({});
  const pos = `<div class="bp pos"><div class="bp-h"><span>Positions</span><span>Program ${wcs} ${c.modal.tlo === 43 ? 'G43' : 'G49'} H${c.modal.tloH || 0}</span><span></span></div><div class="bp-b"><div class="prw hd"><span></span><span>(${h.inch ? 'IN' : 'MM'})</span><span></span><span>Load</span></div>${['x', 'y', 'z'].map((a) => {
    const l = axLoad(a);
    return `<div class="prw"><b>${a.toUpperCase()}</b><span class="v">${ax(h, w[a])}</span><span class="ld">${bar(l)}</span><em>${l.toFixed(0)}%</em></div>`;
  }).join('')}</div></div>`;
  const prog = c.program;
  const remain = c.exec?.kind === 'program' && prog ? prog.totalTime * (1 - c.progress) : prog ? prog.totalTime : 0;
  const tim = `<div class="bp tim"><div class="bp-h"><span>Timers And Counters</span></div><div class="bp-b kvs"><div><span>This Cycle:</span><b>${fmtTime(c.exec?.kind === 'program' ? c.elapsed : h.timers.thisCycle)}</b></div><div><span>Last Cycle:</span><b>${fmtTime(h.timers.lastCycle)}</b></div><div><span>Remaining:</span><b>${fmtTime(remain)}</b></div><div><span>M30 Counter #1:</span><b>${h.st.m30[0]}</b></div><div><span>M30 Counter #2:</span><b>${h.st.m30[1]}</b></div><div><span>Loops Remaining:</span><b>0</b></div></div></div>`;
  return spin + pos + tim;
}

// ------------------------------------------------------------------------------------------ icon bar / input / status
function iconBar(h) {
  const c = h.c;
  const ic = [];
  const add = (cls, glyph, cap, title = cap) => ic.push(`<span class="ib ${cls}" title="${title}"><i>${glyph}</i><small>${cap}</small></span>`);
  add(h.st.setup ? 'warn' : '', h.st.setup ? '🔓︎' : '🔒︎', h.st.setup ? 'Setup' : 'Run', h.st.setup ? 'SETUP mode (key unlocked)' : 'RUN mode (key locked)');
  if (h.st.memLock) add('', '▣', 'Mem lock');
  if (h.doorOpen()) add('warn', '◫', 'Door open');
  if (!c.homed) add('warn', '⌂', 'Zero ret');
  if (c.state === 'running' && c.exec?.kind === 'program') add('ok', '▶', 'Running');
  if (c.state === 'running' && c.exec?.kind === 'mdi') add('ok', '▶', 'MDI');
  if (c.exec?.kind === 'jog') add('ok', '✥', h.jogLock ? 'Jog lock' : 'Jog');
  if (c.exec?.kind === 'homing') add('ok', '⌂', 'Homing');
  if (c.state === 'running' && c.speed > 0) add('', c.rapidMove ? '»' : '›', c.rapidMove ? 'Rapid' : 'Feed');
  if (c.state === 'hold') add('warn', '❚❚', /Single/.test(c.holdReason) ? 'Singbk stop' : /M0/.test(c.holdReason) ? 'Prog stop' : /Door/.test(c.holdReason) ? 'Door hold' : 'Feed hold');
  if (c.singleBlock) add('', '1', 'Single blk');
  if (c.optionalStop) add('', '⊘', 'Opt stop');
  if (h.app.settings.blockDelete) add('', '/', 'Blk delete');
  if (c.atc.busy) add('ok', '⟳', 'Tool chg');
  if (c.coolant.flood) add('ok', '≋', 'Coolant');
  if (h.estopLatched) add('err', '⏻', 'E-stop');
  if (h.graphics.run) add('ok', '◰', 'Graphics');
  return ic.join('');
}

function inputBar(h) {
  const st = h.status;
  const age = performance.now() - st.t;
  const msg = st.text && age < 12000 ? st.text : h.c.state === 'hold' ? `${h.c.holdReason || 'Feed hold'}: CYCLE START continues` : '';
  const lvl = st.text && age < 12000 ? st.lvl : 'info';
  const n = h.alarms.length;
  return `<div class="hs-input"><b>INPUT:</b> <span>${esc(h.input)}</span><i class="caret"></i>${h.shift ? '<em class="shf">SHIFT</em>' : ''}</div>
    <div class="hs-sys ${lvl}">${esc(msg)}</div>
    <div class="hs-al ${n ? 'on' : ''}">${n ? `ALARM${n > 1 ? ` (${n})` : ''}: ${esc(h.alarms[0].num)} ${esc(h.alarms[0].text)}` : 'NO ALARM'}</div>`;
}

function popupHtml(h) {
  const p = h.popup;
  if (!p) return '';
  let b = '';
  if (p.kind === 'yn') b = `<p class="pq">${esc(p.text)}</p><div class="pkeys"><span><kbd>Y</kbd> Yes</span><span><kbd>N</kbd> No</span></div>`;
  else if (p.kind === 'list') b = `<div class="plist">${p.items.map((it, i) => `<div class="${i === p.row ? 'cur' : ''}">${esc(it)}</div>`).join('')}</div><div class="pkeys"><span><kbd>UP/DOWN</kbd></span><span><kbd>ENTER</kbd> Select</span><span><kbd>CANCEL</kbd> Close</span></div>`;
  else if (p.kind === 'form') b = `<table class="pform">${p.fields.map((f, i) => `<tr><td>${esc(f.label)}</td><td class="${i === p.row ? 'cur' : ''}">${esc(f.v)}${i === p.row ? '<i class="caret"></i>' : ''}</td></tr>`).join('')}</table><p class="ph">${esc(p.hint || '')}</p>`;
  else if (p.kind === 'info') b = `<div class="plist">${p.lines.map((l) => `<div>${esc(l)}</div>`).join('')}</div><div class="pkeys"><span><kbd>ENTER</kbd> Close</span></div>`;
  return `<div class="pop"><div class="pop-h">${esc(p.title)}</div><div class="pop-b">${b}</div></div>`;
}

// ------------------------------------------------------------------------------------------ 3D pendant texture
export function drawPendantTexture(h, cv) {
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const c = h.c;
  if (!h.power) {
    g.fillStyle = '#050607';
    g.fillRect(0, 0, W, H);
    h.app.machine.screenTex.needsUpdate = true;
    return;
  }
  g.fillStyle = '#d6d8db';
  g.fillRect(0, 0, W, H);
  // mode bar + title
  const lw = W * 0.36;
  g.fillStyle = '#e8e9eb';
  g.fillRect(0, 0, lw, 30);
  g.fillStyle = '#555';
  g.font = '600 17px "DejaVu Sans", Arial';
  g.fillText(modeString(h), 8, 21);
  const grd = g.createLinearGradient(0, 0, 0, 30);
  grd.addColorStop(0, '#5f8fd0');
  grd.addColorStop(1, '#3c6fb4');
  g.fillStyle = grd;
  g.fillRect(lw, 0, W - lw, 30);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.fillText(TITLES[h.disp] || '', lw + (W - lw) / 2, 21);
  g.textAlign = 'left';
  // program pane
  const ph = H * 0.56;
  g.fillStyle = '#111';
  g.fillRect(0, 30, lw, 24);
  g.fillStyle = '#fff';
  g.font = '600 15px "DejaVu Sans", Arial';
  g.fillText(`${h.mode === 'MDI' ? 'MDI' : 'MEM'}  ${(h.app.programName || '').slice(0, 18)}`, 6, 47);
  g.fillStyle = '#f2f2f2';
  g.fillRect(0, 54, lw, ph - 54);
  const lines = h.mode === 'MDI' ? h.mdiLines() : h.ui.editor.lines;
  const cur = c.line >= 0 ? c.line : 0;
  const start = Math.max(0, cur - 3);
  g.font = '14px "DejaVu Sans Mono", monospace';
  for (let i = 0; i < 12; i++) {
    const li = start + i;
    if (li >= lines.length) break;
    const y = 72 + i * 20;
    if (li === c.line) { g.fillStyle = '#ff8c00'; g.fillRect(2, y - 15, lw - 4, 19); }
    g.fillStyle = '#111';
    g.fillText((lines[li] || '').slice(0, 26), 6, y);
  }
  // main display: positions (large)
  g.fillStyle = '#ffffff';
  g.fillRect(lw + 4, 34, W - lw - 8, ph - 38);
  g.fillStyle = '#3c6fb4';
  g.fillRect(lw + 4, 34, W - lw - 8, 22);
  g.fillStyle = '#fff';
  g.font = '600 14px "DejaVu Sans", Arial';
  g.fillText(h.disp === 'offset' ? 'Offsets' : `Work ${c.modal.wcs >= 54 && c.modal.wcs <= 59 ? 'G' + c.modal.wcs : 'G54'}`, lw + 12, 50);
  const w = c.workPos({});
  g.font = '700 46px "DejaVu Sans Mono", monospace';
  ['x', 'y', 'z'].forEach((a, i) => {
    g.fillStyle = '#111';
    g.fillText(a.toUpperCase(), lw + 20, 110 + i * 62);
    g.textAlign = 'right';
    g.fillText(ax(h, w[a]), W - 20, 110 + i * 62);
    g.textAlign = 'left';
  });
  // bottom panes
  const by = ph + 4;
  const bh = H - by - 56;
  g.fillStyle = '#1b1b1b';
  g.fillRect(0, by, W, 20);
  g.fillStyle = '#fff';
  g.font = '600 13px "DejaVu Sans", Arial';
  g.fillText('MAIN SPINDLE', 8, by + 15);
  g.fillText('Positions', W * 0.37, by + 15);
  g.fillText('Timers And Counters', W * 0.78, by + 15);
  g.fillStyle = '#f2f2f2';
  g.fillRect(0, by + 20, W, bh - 20);
  g.fillStyle = '#111';
  g.font = '15px "DejaVu Sans", Arial';
  g.fillText(`SPINDLE ${Math.round(Math.abs(c.spindle.rpm))} RPM`, 10, by + 44);
  g.fillText(`FEED ${c.overrides.feed}%  SPINDLE ${c.overrides.spindle}%  RAPID ${c.overrides.rapid}%`, 10, by + 66);
  g.fillText(`T${c.tool}   F ${Math.round(h.toD(c.speed * 60))}`, 10, by + 88);
  ['x', 'y', 'z'].forEach((a, i) => g.fillText(`${a.toUpperCase()} ${ax(h, c.pos[a])}`, W * 0.37, by + 44 + i * 22));
  g.fillText(`This Cycle ${fmtTime(c.elapsed)}`, W * 0.78, by + 44);
  g.fillText(`M30 #1  ${h.st.m30[0]}`, W * 0.78, by + 66);
  // input / alarm bar
  const iy = H - 52;
  g.fillStyle = '#111';
  g.fillRect(0, iy, W, 22);
  const ig = g.createLinearGradient(0, iy + 22, 0, H);
  ig.addColorStop(0, '#00d060');
  ig.addColorStop(1, '#00a048');
  g.fillStyle = ig;
  g.fillRect(0, iy + 22, W * 0.4, 30);
  g.fillStyle = '#000';
  g.font = '600 15px "DejaVu Sans", Arial';
  g.fillText('INPUT: ' + h.input, 8, iy + 43);
  g.fillStyle = '#e0e1e3';
  g.fillRect(W * 0.4, iy + 22, W * 0.6, 30);
  if (h.alarms.length) {
    g.fillStyle = Math.floor(performance.now() / 500) % 2 ? '#c00' : '#900';
    g.fillText(`ALARM ${h.alarms[0].num} ${h.alarms[0].text}`.slice(0, 48), W * 0.42, iy + 43);
  } else if (h.status.text) {
    g.fillStyle = '#1010e0';
    g.fillText(h.status.text.slice(0, 54), W * 0.42, iy + 43);
  }
  h.app.machine.screenTex.needsUpdate = true;
}
