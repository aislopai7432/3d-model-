// NGC-style pendant keyboard: the key groups, their grid positions, cap colours and legends, plus the
// fixed pendant controls (power, E-STOP, jog handle, CYCLE START / FEED HOLD, side panel key switches).
// Layout follows the operator's manual keyboard figure: FUNCTION, DISPLAY and MODES along the top,
// JOG under FUNCTION, CURSOR under DISPLAY, OVERRIDES / ALPHA / NUMERIC along the bottom.

// Key cap classes: g = grey gel cap, t = teal, r = RESET red, w = white (cursor / jog arrows),
// m = mode key (pentagon pointing at its row), f = large-font F key.
const K = (id, label, cls = 'g', extra = {}) => ({ id, label, cls, ...extra });
const big = (a, b) => `<b>${a}</b><small>${b}</small>`;
const sh = (main, alt) => `<i class="sh">${alt}</i><b>${main}</b>`;
const arrow = (dir) => `<svg viewBox="0 0 20 20" class="ar"><path d="${{
  up: 'M10 3 18 16H2z', down: 'M10 17 2 4h16z', left: 'M3 10 16 2v16z', right: 'M17 10 4 18V2z',
  ne: 'M17 3 15.5 13.5 12 10 5 17 3 15l7-7-3.5-3.5z', sw: 'M3 17 4.5 6.5 8 10l7-7 2 2-7 7 3.5 3.5z',
  back: 'M2 10 10 3v4h8v6h-8v4z', fwd: 'M18 10 10 17v-4H2V7h8V3z',
}[dir]}"/></svg>`;

export const GROUPS = [
  {
    id: 'function', title: '', plate: 'grey', cols: 4, area: 'fn',
    keys: [
      K('RESET', 'RESET', 'r', { span: 2 }), K('POWER_UP', 'POWER<br>UP', 't'), K('RECOVER', 'RECOVER', 't'),
      K('F1', 'F1', 'f'), K('F2', 'F2', 'f'), K('F3', 'F3', 'f'), K('F4', 'F4', 'f'),
      K('TOOL_OFS_MEAS', 'TOOL<br>OFFSET<br>MEASURE'), K('NEXT_TOOL', 'NEXT<br>TOOL'), K('TOOL_RELEASE', 'TOOL<br>RELEASE'), K('PART_ZERO_SET', 'PART<br>ZERO<br>SET'),
    ],
  },
  {
    id: 'display', title: 'DISPLAY', plate: 'black', cols: 4, area: 'dsp',
    keys: [
      K('PROGRAM', 'PROGRAM'), K('POSITION', 'POSITION'), K('OFFSET', 'OFFSET'), K('CURRENT_COMMANDS', 'CURRENT<br>COMMANDS'),
      K('ALARMS', 'ALARMS'), K('DIAGNOSTIC', 'DIAG-<br>NOSTIC'), K('SETTING', 'SETTING'), K('HELP', 'HELP'),
    ],
  },
  {
    id: 'cursor', title: '', plate: 'blue', cols: 3, area: 'cur',
    keys: [
      K('HOME', 'HOME', 't'), K('UP', arrow('up'), 'w', { title: 'Cursor up' }), K('PAGE_UP', 'PAGE<br>UP', 't'),
      K('LEFT', arrow('left'), 'w', { title: 'Cursor left' }), { text: 'CURSOR' }, K('RIGHT', arrow('right'), 'w', { title: 'Cursor right' }),
      K('END', 'END', 't'), K('DOWN', arrow('down'), 'w', { title: 'Cursor down' }), K('PAGE_DOWN', 'PAGE<br>DOWN', 't'),
    ],
  },
  {
    id: 'modes', title: '', plate: 'light', cols: 5, area: 'mod',
    keys: [
      K('EDIT', 'EDIT', 'm'), K('INSERT', 'INSERT'), K('ALTER', 'ALTER'), K('DELETE', 'DELETE'), K('UNDO', 'UNDO'),
      K('MEMORY', 'MEMORY', 'm'), K('SINGLE_BLOCK', 'SINGLE<br>BLOCK'), K('GRAPHICS', 'GRAPHICS'), K('OPTION_STOP', 'OPTION<br>STOP'), K('BLOCK_DELETE', 'BLOCK<br>DELETE'),
      K('MDI', 'MDI', 'm'), K('COOLANT', 'COOLANT'), K('HANDLE_SCROLL', 'HANDLE<br>SCROLL'), K('ATC_FWD', 'ATC<br>FWD'), K('ATC_REV', 'ATC<br>REV'),
      K('HANDLE_JOG', 'HANDLE<br>JOG', 'm'), K('INC_1', big('.0001', '.1'), 'g inc'), K('INC_2', big('.001', '1.'), 'g inc'), K('INC_3', big('.01', '10.'), 'g inc'), K('INC_4', big('.1', '100.'), 'g inc'),
      K('ZERO_RETURN', 'ZERO<br>RETURN', 'm'), K('ALL', 'ALL'), K('ORIGIN', 'ORIGIN'), K('SINGLE', 'SINGLE'), K('HOME_G28', 'HOME<br>G28'),
      K('LIST_PROGRAM', 'LIST<br>PROGRAM', 'm'), K('SELECT_PROGRAM', 'SELECT<br>PROGRAM'), K('BACK', arrow('back'), 'g', { title: 'Back' }), K('FORWARD', arrow('fwd'), 'g', { title: 'Forward' }), K('ERASE_PROGRAM', 'ERASE<br>PROGRAM'),
    ],
  },
  {
    id: 'jog', title: '', plate: 'blue', cols: 5, area: 'jog',
    keys: [
      K('CHIP_FWD', 'CHIP<br>FWD', 't'), K('JOG_+A', `<i class="corner">+B</i><b>+A/C</b>`, 'w ac'), K('JOG_+Z', `${arrow('up')}<span>+Z</span>`, 'w jk'), K('JOG_-Y', `${arrow('ne')}<span>-Y</span>`, 'w jk'), K('CLNT_UP', 'CLNT<br>UP', 't'),
      K('CHIP_STOP', 'CHIP<br>STOP', 't'), K('JOG_+X', `<span class="row">${arrow('left')}<span>+X</span></span>`, 'w jk'), K('JOG_LOCK', 'JOG<br>LOCK', 'w'), K('JOG_-X', `<span class="row"><span>-X</span>${arrow('right')}</span>`, 'w jk'), K('CLNT_DOWN', 'CLNT<br>DOWN', 't'),
      K('CHIP_REV', 'CHIP<br>REV', 't'), K('JOG_+Y', `<span>+Y</span>${arrow('sw')}`, 'w jk'), K('JOG_-Z', `<span>-Z</span>${arrow('down')}`, 'w jk'), K('JOG_-A', `<i class="corner">-B</i><b>-A/C</b>`, 'w ac'), K('AUX_CLNT', 'AUX<br>CLNT', 't'),
    ],
  },
  {
    id: 'overrides', title: 'OVERRIDES', plate: 'black', cols: 4, area: 'ovr',
    keys: [
      K('FEED_M10', big('-10%', 'FEEDRATE')), K('FEED_100', big('100%', 'FEEDRATE')), K('FEED_P10', big('+10%', 'FEEDRATE')), K('HANDLE_FEED', big('HANDLE', 'FEED')),
      K('SPIN_M10', big('-10%', 'SPINDLE')), K('SPIN_100', big('100%', 'SPINDLE')), K('SPIN_P10', big('+10%', 'SPINDLE')), K('HANDLE_SPINDLE', big('HANDLE', 'SPINDLE')),
      K('SP_FWD', '<b>FWD</b>'), K('SP_STOP', '<b>STOP</b>'), K('SP_REV', '<b>REV</b>'), { text: 'SPINDLE' },
      K('RAPID_5', big('5%', 'RAPID')), K('RAPID_25', big('25%', 'RAPID')), K('RAPID_50', big('50%', 'RAPID')), K('RAPID_100', big('100%', 'RAPID')),
    ],
  },
  {
    id: 'alpha', title: '', plate: 'none', cols: 6, area: 'alp',
    keys: [
      K('SHIFT', 'SHIFT', 'g shift'), ...'ABCDE'.split('').map((c) => K('A_' + c, `<b>${c}</b>`, 'g ch')),
      ...'FGHIJK'.split('').map((c) => K('A_' + c, `<b>${c}</b>`, 'g ch')),
      ...'LMNOPQ'.split('').map((c) => K('A_' + c, `<b>${c}</b>`, 'g ch')),
      ...'RSTUVW'.split('').map((c) => K('A_' + c, `<b>${c}</b>`, 'g ch')),
      ...'XYZ'.split('').map((c) => K('A_' + c, `<b>${c}</b>`, 'g ch')),
      K('A_;', sh(';', '/'), 'g ch', { title: 'EOB (end of block); SHIFT: /' }), K('A_(', sh('(', '['), 'g ch'), K('A_)', sh(')', ']'), 'g ch'),
    ],
  },
  {
    id: 'numeric', title: '', plate: 'black', cols: 3, area: 'num',
    keys: [
      K('N_7', sh('7', '&'), 'g ch'), K('N_8', sh('8', '@'), 'g ch'), K('N_9', sh('9', ':'), 'g ch'),
      K('N_4', sh('4', '%'), 'g ch'), K('N_5', sh('5', '$'), 'g ch'), K('N_6', sh('6', '!'), 'g ch'),
      K('N_1', sh('1', '*'), 'g ch'), K('N_2', sh('2', "'"), 'g ch'), K('N_3', sh('3', '?'), 'g ch'),
      K('N_-', sh('-', '+'), 'g ch'), K('N_0', sh('0', '='), 'g ch'), K('N_.', sh('.', '#'), 'g ch'),
      K('CANCEL', 'CANCEL', 'g sm'), K('SPACE', 'SPACE', 'g sm'), K('ENTER', 'ENTER', 'g sm'),
    ],
  },
];

// Characters typed by the alpha / numeric keys, and with SHIFT.
export const CHARS = {
  'A_;': [';', '/'], 'A_(': ['(', '['], 'A_)': [')', ']'],
  N_7: ['7', '&'], N_8: ['8', '@'], N_9: ['9', ':'], N_4: ['4', '%'], N_5: ['5', '$'], N_6: ['6', '!'],
  N_1: ['1', '*'], N_2: ['2', "'"], N_3: ['3', '?'], 'N_-': ['-', '+'], N_0: ['0', '='], 'N_.': ['.', '#'],
};
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') CHARS['A_' + c] = [c, c.toLowerCase()];

// Physical keyboard -> pendant key (when the control has focus).
export const PHYS = {
  Enter: 'ENTER', Backspace: 'CANCEL', ' ': 'SPACE', ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
  PageUp: 'PAGE_UP', PageDown: 'PAGE_DOWN', Home: 'HOME', End: 'END', Insert: 'INSERT', Delete: 'DELETE',
  F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', Pause: 'FEED_HOLD',
};
// typed characters that have a key (directly or with SHIFT)
export const CHAR_KEY = {};
for (const [id, [a, b]] of Object.entries(CHARS)) {
  if (!(a in CHAR_KEY)) CHAR_KEY[a] = [id, false];
  if (b !== a.toLowerCase() || !/[a-z]/.test(b)) CHAR_KEY[b] = CHAR_KEY[b] || [id, true];
}

function keyHtml(k) {
  if (k.text) return `<div class="hk-txt">${k.text}</div>`;
  const span = k.span ? ` style="grid-column:span ${k.span}"` : '';
  return `<button type="button" class="hk ${k.cls}" data-k="${k.id}"${span}${k.title ? ` title="${k.title}"` : ''}><span class="cap">${k.label}</span></button>`;
}

const icon = {
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  wrench: '<svg viewBox="0 0 24 24"><path d="M14.5 3.5a5 5 0 0 0-5.6 6.7L3.5 15.6l4.9 4.9 5.4-5.4a5 5 0 0 0 6.7-5.6l-3 3-3.4-.9-.9-3.4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  mem: '<svg viewBox="0 0 24 24"><path d="M4 4h11l5 5v11H4z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 4v5h7V4" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  home2: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2v6M12 16v6M2 12h6M16 12h6" stroke="currentColor" stroke-width="1.8"/><text x="12" y="15.5" text-anchor="middle" font-size="9" font-weight="700" fill="currentColor">2</text></svg>',
  bulb: '<svg viewBox="0 0 24 24"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.3 1 2.1h5c0-.8.4-1.6 1-2.1A6 6 0 0 0 12 3z" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  door: '<svg viewBox="0 0 24 24"><path d="M4 3h7v18H4zM13 3h7v18h-7" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M9 12h1M14 12h1" stroke="currentColor" stroke-width="2"/></svg>',
  usb: '<svg viewBox="0 0 24 24"><path d="M12 2v16M12 18a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM12 7l-4 4v3M12 10l4-3V5" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="14.5" y="3" width="3" height="3" fill="currentColor"/><circle cx="8" cy="15" r="1.6" fill="currentColor"/></svg>',
};

// The handwheel: knurled rim, 100 detent graduations, a crank handle.
function handwheelSvg() {
  let ticks = '';
  for (let i = 0; i < 100; i++) {
    const a = (i / 100) * Math.PI * 2;
    const r0 = i % 10 === 0 ? 33 : 36.5, r1 = 40;
    ticks += `<line x1="${(50 + Math.sin(a) * r0).toFixed(2)}" y1="${(50 - Math.cos(a) * r0).toFixed(2)}" x2="${(50 + Math.sin(a) * r1).toFixed(2)}" y2="${(50 - Math.cos(a) * r1).toFixed(2)}"/>`;
  }
  let knurl = '';
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    knurl += `<line x1="${(50 + Math.sin(a) * 44).toFixed(2)}" y1="${(50 - Math.cos(a) * 44).toFixed(2)}" x2="${(50 + Math.sin(a) * 48.5).toFixed(2)}" y2="${(50 - Math.cos(a) * 48.5).toFixed(2)}"/>`;
  }
  return `<svg viewBox="0 0 100 100" class="hw-svg">
    <defs><radialGradient id="hwg" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#f4f5f6"/><stop offset=".55" stop-color="#b9bdc1"/><stop offset="1" stop-color="#7d8186"/></radialGradient>
    <radialGradient id="hwk" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#666"/><stop offset="1" stop-color="#111"/></radialGradient></defs>
    <circle cx="50" cy="50" r="49" fill="#3a3d40"/>
    <g class="hw-knurl" stroke="#1c1e20" stroke-width="1.2">${knurl}</g>
    <g class="hw-dial"><circle cx="50" cy="50" r="43" fill="url(#hwg)" stroke="#6b6f74" stroke-width=".8"/>
      <g stroke="#2b2e31" stroke-width=".7">${ticks}</g>
      <circle cx="50" cy="50" r="20" fill="#d9dcdf" stroke="#8a8e93" stroke-width=".8"/>
      <circle cx="50" cy="22" r="7.5" fill="url(#hwk)" stroke="#000" stroke-width=".6"/>
      <circle cx="48.3" cy="20.2" r="2" fill="#9a9a9a" opacity=".7"/></g>
    <path d="M50 1.5 46.5 -3h7z" fill="#e53" transform="translate(0 4)"/>
  </svg>`;
}

// Builds the whole pendant face into `root` and returns the main element references.
export function buildPendant(root) {
  const groups = Object.fromEntries(GROUPS.map((g) => [g.area, `<div class="hg hg-${g.id} plate-${g.plate}" style="--cols:${g.cols}">${g.title ? `<div class="hg-title">${g.title}</div>` : ''}<div class="hg-keys">${g.keys.map(keyHtml).join('')}</div></div>`]));
  root.innerHTML = `
  <div class="hp-beacon" title="Beacon light"><i id="hpBeacon"></i></div>
  <div class="hp-face">
    <div class="hp-left">
      <div class="hp-power">
        <button type="button" class="hp-pwr on" data-k="POWER_ON" title="POWER ON"><span>I</span></button>
        <button type="button" class="hp-pwr off" data-k="POWER_OFF" title="POWER OFF"><span>O</span></button>
      </div>
      <div class="hp-estop-wrap"><button type="button" class="hp-estop" data-k="ESTOP" title="EMERGENCY STOP (press; press again to twist-release)"><i></i></button><span class="hp-cap">EMERGENCY STOP</span></div>
      <div class="hp-handle" id="hpHandle" title="Jog handle: drag to turn, or scroll. 100 detents per turn.">${handwheelSvg()}<span class="hp-cap" id="hpHandleCap">HANDLE</span></div>
      <div class="hp-cycle">
        <button type="button" class="hp-cs" data-k="CYCLE_START" title="CYCLE START"><svg viewBox="0 0 24 24"><rect x="5" y="6" width="14" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 8v8" stroke="currentColor" stroke-width="2.4"/></svg></button>
        <button type="button" class="hp-fh" data-k="FEED_HOLD" title="FEED HOLD"><svg viewBox="0 0 24 24"><rect x="5" y="6" width="14" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.4" fill="none" stroke="currentColor" stroke-width="2.2"/></svg></button>
        <span class="hp-cap">CYCLE START</span><span class="hp-cap">FEED HOLD</span>
      </div>
      <div class="hp-side" aria-label="Side panel">
        <div class="hp-cap side-t">SIDE PANEL</div>
        <button type="button" class="hp-ks" data-k="MEMORY_LOCK" title="MEMORY LOCK key switch"><span class="ks-ic">${icon.mem}${icon.lock}</span><span class="ks"><i></i></span><span class="ks-l" id="hpMemLbl">UNLOCKED</span></button>
        <button type="button" class="hp-ks" data-k="SETUP_MODE" title="SETUP MODE key switch: locked = RUN mode, unlocked = SETUP mode"><span class="ks-ic">${icon.wrench}${icon.lock}</span><span class="ks"><i></i></span><span class="ks-l" id="hpSetupLbl">RUN</span></button>
        <div class="hp-sbtns">
          <button type="button" class="hp-sb" data-k="SECOND_HOME" title="SECOND HOME">${icon.home2}</button>
          <button type="button" class="hp-sb" data-k="WORK_LIGHT" title="WORK LIGHT">${icon.bulb}</button>
          <button type="button" class="hp-sb" data-k="AUTO_DOOR" title="AUTO DOOR (option)">${icon.door}</button>
          <button type="button" class="hp-sb" data-k="USB" title="USB port">${icon.usb}</button>
        </div>
      </div>
    </div>
    <div class="hp-right">
      <div class="hp-lcd"><div class="hp-label">VMC-MINI · NGC-style control</div><div class="hs" id="hsScreen" tabindex="-1"></div></div>
      <div class="hp-kb" id="hpKb">
        <div class="kb-col kb-a">${groups.fn}${groups.jog}${groups.ovr}</div>
        <div class="kb-col kb-b">${groups.dsp}${groups.cur}${groups.alp}</div>
        <div class="kb-col kb-c">${groups.mod}${groups.num}</div>
      </div>
    </div>
  </div>`;
  return {
    screen: root.querySelector('#hsScreen'),
    handle: root.querySelector('#hpHandle'),
    dial: root.querySelector('.hw-dial'),
    beacon: root.querySelector('#hpBeacon'),
    keys: [...root.querySelectorAll('[data-k]')],
  };
}
