// Operator panel for the manual lathe (shown at the operator position): four handwheels with graduated
// dials (drag them round, scroll over them, or use the keys), dial zeroing, a two-axis DRO, spindle
// FWD / STOP / REV + speed selector + brake, the quick-change feed box, power feed, half nut and thread
// pitch, compound swivel, the four-way tool post, the tailstock, chuck, guard, coolant, light, E-stop and
// a status line with the cutting load. Every control goes through LatheGame.act() / LatheGame.turn().
import { MATERIALS } from '../config.js';
import { GRAD, SPEEDS, FEEDS, PITCHES } from './lathe-sim.js';
import { wheelTurns } from './lathe-app.js';
import { TAIL_TOOLS, POST_TOOLS } from './lathe-game.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const TAU = Math.PI * 2;
const WHEELS = [
  { axis: 'carriage', name: 'Carriage', sub: 'Z 0.1/div', labelEvery: 25, tickEvery: 1, unit: 'mm', key: '← →' },
  { axis: 'cross', name: 'Cross', sub: 'Ø 0.02/div', labelEvery: 20, tickEvery: 1, unit: 'Ø mm', key: '↑ ↓' },
  { axis: 'compound', name: 'Compound', sub: '0.02/div', labelEvery: 10, tickEvery: 1, unit: 'mm', key: '[ ]' },
  { axis: 'quill', name: 'Quill', sub: '0.05/div', labelEvery: 10, tickEvery: 1, unit: 'mm', key: ', .' },
];
const TOOL_ICON = [
  '<svg viewBox="0 0 40 24"><path d="M4 18 14 6h22v8H16z" fill="#8d96a0"/><path d="M4 18 10 11l5 3z" fill="#d8b04a"/></svg>',
  '<svg viewBox="0 0 40 24"><path d="M6 12 16 4h20v16H16z" fill="#8d96a0"/><path d="M6 12l6-5v10z" fill="#d8b04a"/></svg>',
  '<svg viewBox="0 0 40 24"><path d="M4 9h32v6H4z" fill="#8d96a0"/><path d="M4 9h4v6H4z" fill="#d8b04a"/></svg>',
  '<svg viewBox="0 0 40 24"><path d="M5 12 14 5h22v14H14z" fill="#8d96a0"/><path d="M5 12l6-4v8z" fill="#d8b04a"/></svg>',
];

const CSS = `
.lt-panel, .lt-side, .lt-opbar { display: none; }
body.lt-op .lt-panel { display: grid; }
body.lt-op .lt-side { display: flex; }
body.lt-op .lt-opbar { display: flex; }
.lt-panel { position: fixed; z-index: 30; left: 0; right: 0; bottom: 0; height: var(--ltb, 244px); grid-template-columns: auto minmax(0, 1fr) auto; grid-template-rows: 26px minmax(0, 1fr); gap: 0 10px; padding: 0 10px 8px; background: linear-gradient(#262b31, #1b1f23); border-top: 1px solid #3e464f; box-shadow: 0 -10px 30px rgba(0,0,0,.35); color: var(--text); font: 400 12px/1.3 var(--f-ui); user-select: none; -webkit-user-select: none; }
.lt-status { grid-column: 1 / -1; display: flex; align-items: center; gap: 10px; min-width: 0; font: 500 12px var(--f-mono); color: var(--text-2); border-bottom: 1px solid rgba(255,255,255,.06); }
.lt-status .msg { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: var(--f-ui); color: #ffd27a; }
.lt-status .al { padding: 1px 8px; border-radius: 4px; background: var(--err); color: #fff; font: 700 11px var(--f-cond); letter-spacing: .1em; }
.lt-status .al[hidden] { display: none; }
.lt-load { width: 120px; height: 8px; border-radius: 4px; background: #11151a; border: 1px solid #39414a; overflow: hidden; }
.lt-load i { display: block; height: 100%; width: 0; background: linear-gradient(90deg, #34c77b, #f0b429 70%, #ff5c5c); transition: width .1s; }
.lt-grp { display: flex; flex-direction: column; gap: 5px; padding-top: 6px; min-width: 0; }
.lt-cap { font: 700 10px var(--f-cond); letter-spacing: .16em; text-transform: uppercase; color: #8f9aa6; }
.lt-row { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
.lt-b { height: 28px; padding: 0 9px; border-radius: 6px; border: 1px solid #434b55; background: linear-gradient(#323941, #272d33); color: var(--text); font: 600 12px var(--f-cond); letter-spacing: .04em; cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; gap: 5px; }
.lt-b:hover { border-color: #6b7580; }
.lt-b.on { border-color: #ffc440; background: linear-gradient(#4b4021, #3a3218); color: #ffe39a; box-shadow: inset 0 0 0 1px rgba(255,196,64,.3); }
.lt-b.sq { width: 28px; padding: 0; justify-content: center; }
.lt-b.big { height: 40px; min-width: 62px; justify-content: center; font-size: 13px; }
.lt-b.fwd.on { border-color: #34c77b; background: linear-gradient(#1f5a3a, #17432c); color: #b6f5d2; }
.lt-b.rev.on { border-color: #f09a3e; background: linear-gradient(#5a3a1f, #432c17); color: #ffd2a3; }
.lt-b.stop { color: #ffb0b0; }
.lt-b.warn.on { border-color: var(--err); background: linear-gradient(#5a2222, #431818); color: #ffc0c0; }
.lt-val { min-width: 84px; padding: 0 8px; height: 28px; display: inline-flex; align-items: center; justify-content: center; border-radius: 6px; background: #0e1114; border: 1px solid #333b44; font: 600 13px var(--f-mono); color: #9fe3ff; }
.lt-val.w { min-width: 104px; }
.lt-small { font: 500 11px var(--f-mono); color: var(--muted); }
.lt-wheels { display: flex; gap: 8px; justify-content: center; align-items: stretch; min-width: 0; overflow-x: auto; overflow-y: hidden; padding-top: 4px; }
.lt-hw { display: grid; grid-template-rows: auto 1fr auto; justify-items: center; gap: 2px; width: 142px; flex: none; border-radius: 10px; padding: 3px 4px 4px; background: rgba(0,0,0,.18); border: 1px solid transparent; }
.lt-hw.flash { border-color: #ffc440; }
.lt-hw .hd { display: flex; gap: 6px; align-items: baseline; font: 600 12px var(--f-cond); letter-spacing: .04em; }
.lt-hw .hd span { font: 500 10.5px var(--f-ui); color: var(--muted); }
.lt-hw canvas { width: 124px; height: 124px; cursor: grab; touch-action: none; }
.lt-hw canvas:active { cursor: grabbing; }
.lt-hw .ft { display: flex; gap: 4px; align-items: center; }
.lt-hw .ft .lt-val { min-width: 72px; height: 24px; font-size: 12px; }
.lt-hw .ft .lt-b { height: 24px; font-size: 11px; padding: 0 6px; }
.lt-dro { display: grid; gap: 4px; padding: 6px 8px; border-radius: 8px; background: #0b0e10; border: 1px solid #2c343c; min-width: 178px; }
.lt-dro .ax { display: grid; grid-template-columns: 26px 1fr auto; align-items: center; gap: 6px; }
.lt-dro .ax i { font: 700 13px var(--f-cond); color: #ff9a6b; font-style: normal; }
.lt-dro .ax b { font: 600 20px var(--f-mono); color: #ff5f3a; text-shadow: 0 0 8px rgba(255,80,40,.45); text-align: right; letter-spacing: .02em; }
.lt-dro.off .ax b { color: #3a2620; text-shadow: none; }
.lt-tools { display: grid; grid-template-columns: repeat(2, auto); gap: 4px; }
.lt-tools .lt-b { height: 34px; padding: 0 7px 0 4px; }
.lt-tools .lt-b svg { width: 30px; height: 18px; }
.lt-tools .lt-b.broken { border-color: var(--err); color: #ffb0b0; }
.lt-side { position: fixed; z-index: 30; right: 0; top: 46px; bottom: var(--ltb, 244px); width: var(--lts, 270px); flex-direction: column; gap: 4px; padding: 8px 10px; overflow-y: auto; background: linear-gradient(90deg, #20252a, #1b1f23); border-left: 1px solid #3e464f; color: var(--text); font: 400 12px/1.3 var(--f-ui); user-select: none; -webkit-user-select: none; }
.lt-side .lt-grp { padding: 6px 0 8px; border-bottom: 1px solid rgba(255,255,255,.06); }
.lt-side select { height: 28px; flex: 1; min-width: 0; border-radius: 6px; border: 1px solid #434b55; background: #22272c; color: var(--text); font: 500 12px var(--f-ui); }
.lt-estop { width: 74px; height: 74px; border-radius: 50%; border: 6px solid #e8b21a; background: radial-gradient(circle at 40% 35%, #ff5a4f, #b3201c 70%); color: #fff; font: 800 11px var(--f-cond); letter-spacing: .06em; cursor: pointer; box-shadow: 0 4px 0 #6b1210, 0 6px 14px rgba(0,0,0,.4); }
.lt-estop.on { transform: translateY(3px); box-shadow: 0 1px 0 #6b1210; filter: brightness(.85); }
.lt-opbar { position: fixed; z-index: 31; top: 54px; left: 12px; right: calc(var(--lts, 270px) + 12px); justify-content: flex-end; gap: 6px; align-items: center; pointer-events: none; flex-wrap: wrap; }
.lt-opbar > * { pointer-events: auto; }
.lt-opbar .lt-b { background: rgba(22,25,28,.86); backdrop-filter: blur(6px); }
.lt-opbar .ttl { padding: 5px 10px; border-radius: 6px; background: rgba(22,25,28,.86); font: 700 11px var(--f-cond); letter-spacing: .12em; text-transform: uppercase; color: #ffd27a; margin-right: auto; }
body.lt-op .lt-tut ~ * {}
body.lt-op .g-hud.g-op .g-toasts { left: calc((100% - var(--lts, 270px)) / 2); top: 50px; width: min(560px, calc(100% - var(--lts, 270px) - 24px)); min-width: 0; }
@media (max-width: 1100px) { .lt-hw { width: 132px; } .lt-hw canvas { width: 112px; height: 112px; } }
@media (max-width: 820px) {
  .lt-panel { grid-template-columns: 1fr; grid-template-rows: 26px auto auto; height: auto; max-height: 52vh; overflow-y: auto; }
  .lt-side { top: auto; bottom: 0; height: 40vh; width: 100%; display: none !important; }
  body.lt-op.lt-side-open .lt-side { display: flex !important; z-index: 32; }
  .lt-opbar { right: 12px; }
}
`;

export class LathePanel {
  constructor(game) {
    this.game = game;
    this.sim = game.sim;
    this.wheels = {};
    this._t = 0;
    this._key = '';
  }

  build() {
    if (!$('#lt-panel-style')) {
      const st = document.createElement('style');
      st.id = 'lt-panel-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    const p = document.createElement('div');
    p.className = 'lt-panel';
    p.innerHTML = `
      <div class="lt-status"><span class="al" id="ltAlarm" hidden></span><span class="msg" id="ltMsg">—</span><span id="ltCut" class="lt-small"></span><span class="lt-small">LOAD</span><div class="lt-load"><i id="ltLoad"></i></div></div>
      <div class="lt-grp" style="min-width:236px">
        <div class="lt-cap">Spindle</div>
        <div class="lt-row"><button class="lt-b big rev" data-a="spindle" data-v="-1" title="Reverse (Shift+Space)">REV</button><button class="lt-b big stop" data-a="spindle" data-v="0" title="Stop (Space)">STOP</button><button class="lt-b big fwd" data-a="spindle" data-v="1" title="Forward (Space)">FWD</button></div>
        <div class="lt-row"><button class="lt-b sq" data-a="gear" data-d="-1" title="Slower (−)">◀</button><span class="lt-val w" id="ltRpm">500 rpm</span><button class="lt-b sq" data-a="gear" data-d="1" title="Faster (+)">▶</button><button class="lt-b" data-a="brake" title="Foot brake">BRAKE</button></div>
        <div class="lt-small" id="ltRpmAct">actual 0 rpm</div>
        <div class="lt-row"><button class="lt-b" data-a="step" id="ltStep" title="Divisions per scroll notch / key tap (Tab)">Step 1 div</button><button class="lt-b" data-a="side" id="ltSideBtn" title="More controls">More…</button></div>
      </div>
      <div class="lt-wheels" id="ltWheels"></div>
      <div class="lt-grp">
        <div class="lt-cap">DRO <button class="lt-b" style="height:20px;font-size:10px;margin-left:6px" data-a="droMode" id="ltDroMode">Ø</button><button class="lt-b" style="height:20px;font-size:10px" data-a="droOn" id="ltDroOn">ON</button></div>
        <div class="lt-dro" id="ltDro">
          <div class="ax"><i id="ltDroXl">XØ</i><b id="ltDroX">0.000</b><button class="lt-b sq" data-a="zeroDro" data-v="x" title="Zero X">0</button></div>
          <div class="ax"><i>Z</i><b id="ltDroZ">0.000</b><button class="lt-b sq" data-a="zeroDro" data-v="z" title="Zero Z">0</button></div>
        </div>
        <div class="lt-cap" style="margin-top:4px">Tool post</div>
        <div class="lt-tools" id="ltTools">${POST_TOOLS.map((t, i) => `<button class="lt-b" data-a="tool" data-v="${i}" title="${t.label} (${i + 1})">${TOOL_ICON[i]}<span>T${i + 1} ${t.short}</span></button>`).join('')}</div>
      </div>`;
    document.body.appendChild(p);
    this.el = p;
    const wrap = $('#ltWheels', p);
    for (const w of WHEELS) {
      const d = document.createElement('div');
      d.className = 'lt-hw';
      d.dataset.axis = w.axis;
      d.innerHTML = `<div class="hd">${w.name}<span>${w.sub}</span></div><canvas title="Drag round or scroll to turn (${w.key})"></canvas><div class="ft"><span class="lt-val" data-r="${w.axis}">0.00</span><button class="lt-b" data-a="zeroDial" data-v="${w.axis}" title="Slip the dial collar to zero">ZERO</button></div>`;
      wrap.appendChild(d);
      const cv = $('canvas', d);
      this.wheels[w.axis] = { def: w, el: d, cv, read: $('[data-r]', d), key: '' };
      this.bindWheel(w.axis, cv);
    }

    const side = document.createElement('div');
    side.className = 'lt-side';
    side.innerHTML = `
      <div class="lt-grp"><div class="lt-cap">Feed box · power feed</div>
        <div class="lt-row"><button class="lt-b sq" data-a="feedIndex" data-d="-1">◀</button><span class="lt-val w" id="ltFeed">0.10 mm/rev</span><button class="lt-b sq" data-a="feedIndex" data-d="1">▶</button></div>
        <div class="lt-row"><button class="lt-b" data-a="feed" data-v="off">OFF</button><button class="lt-b" data-a="feed" data-v="long" title="Longitudinal power feed (F)">⟷ LONG</button><button class="lt-b" data-a="feed" data-v="cross" title="Cross power feed (Shift+F)">↕ CROSS</button></div>
        <div class="lt-row"><button class="lt-b" data-a="feedDir" id="ltDir" title="Feed direction (R)">← toward chuck</button></div>
      </div>
      <div class="lt-grp"><div class="lt-cap">Screw cutting</div>
        <div class="lt-row"><button class="lt-b sq" data-a="pitch" data-d="-1">◀</button><span class="lt-val w" id="ltPitch">P 1.50</span><button class="lt-b sq" data-a="pitch" data-d="1">▶</button><button class="lt-b" data-a="halfNut" id="ltHalf" title="Half nut (N)">HALF NUT</button></div>
      </div>
      <div class="lt-grp"><div class="lt-cap">Compound swivel</div>
        <div class="lt-row"><button class="lt-b sq" data-a="compoundAngle" data-d="-5" title="−5° (Shift: −1°)">◀</button><span class="lt-val" id="ltComp">0°</span><button class="lt-b sq" data-a="compoundAngle" data-d="5" title="+5° (Shift: +1°)">▶</button><button class="lt-b" data-a="compoundAngle" data-set="0">0°</button><button class="lt-b" data-a="compoundAngle" data-set="30">30°</button></div>
      </div>
      <div class="lt-grp"><div class="lt-cap">Tailstock</div>
        <div class="lt-row"><select id="ltTail">${TAIL_TOOLS.map((t) => `<option value="${t.id}">${t.label}</option>`).join('')}</select></div>
        <div class="lt-row"><button class="lt-b" data-a="tailLock" id="ltTailLock">LOCKED</button><button class="lt-b sq" data-a="tailSlide" data-v="-5" data-hold="1" title="Slide toward the chuck">◀</button><button class="lt-b sq" data-a="tailSlide" data-v="5" data-hold="1" title="Slide away">▶</button><span class="lt-small" id="ltTailPos"></span></div>
      </div>
      <div class="lt-grp"><div class="lt-cap">Chuck · safety</div>
        <div class="lt-row"><button class="lt-b" data-a="chuck" title="Chuck key: load / tighten / open">CHUCK…</button><button class="lt-b" data-a="guard" id="ltGuard" title="Chuck guard (G)">GUARD</button><button class="lt-b" data-a="coolant" id="ltCool" title="Coolant (C)">COOLANT</button><button class="lt-b" data-a="light" id="ltLight">LIGHT</button></div>
        <div class="lt-row" style="gap:12px;margin-top:4px"><button class="lt-estop" data-a="estop" id="ltEstop" title="Emergency stop (X)">E-STOP</button><button class="lt-b" data-a="reset" title="Reset the alarm (fresh insert)">RESET ALARM</button></div>
      </div>
      <div class="lt-grp" style="border:0"><div class="lt-cap">View</div>
        <div class="lt-row"><button class="lt-b" data-a="view" data-v="work">Work</button><button class="lt-b" data-a="view" data-v="top">Top</button><button class="lt-b" data-a="view" data-v="tail">Tailstock</button><button class="lt-b" data-a="view" data-v="wide">Wide</button></div>
        <div class="lt-small" style="margin-top:4px">Drag the 3D view to look around, scroll to zoom. Click the levers on the lathe too.</div>
      </div>`;
    document.body.appendChild(side);
    this.side = side;

    const bar = document.createElement('div');
    bar.className = 'lt-opbar';
    bar.innerHTML = `<span class="ttl">Engine lathe · operator position</span><button class="lt-b" data-a="drawing" title="Drawing (Q)">Drawing</button><button class="lt-b" data-a="back" title="Step back (Esc)">← Step back <kbd>Esc</kbd></button>`;
    document.body.appendChild(bar);
    this.bar = bar;

    for (const root of [p, side, bar]) {
      root.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); }); // keep the keyboard on the lathe
      root.addEventListener('click', (e) => this.onClick(e));
      root.addEventListener('pointerdown', (e) => this.onHold(e));
    }
    $('#ltTail', side).addEventListener('change', (e) => { this.game.act('tailTool', e.target.value); e.target.blur(); });
    addEventListener('resize', () => { if (this.game.op) this.layout(); });
  }

  show(on) {
    if (on) { this.layout(); this.refresh(true); }
  }

  layout() {
    const v = this.game.app.viewer;
    const vp = v.container.getBoundingClientRect();
    const ph = this.el.getBoundingClientRect().height || 244;
    const narrow = innerWidth <= 820;
    const sw = narrow ? 0 : this.side.getBoundingClientRect().width || 270;
    document.body.style.setProperty('--ltb', `${Math.round(ph)}px`);
    const freeW = vp.width - sw, freeH = vp.height - Math.max(0, vp.bottom - (innerHeight - ph));
    v.setCenter({ x: freeW / 2, y: Math.max(80, freeH / 2) });
  }

  onHold(e) {
    const b = e.target.closest('[data-hold]');
    if (!b) return;
    const fire = () => this.game.act(b.dataset.a, +b.dataset.v);
    fire();
    let t = setTimeout(function rep() { fire(); t = setTimeout(rep, 70); }, 350);
    const stop = () => { clearTimeout(t); removeEventListener('pointerup', stop); removeEventListener('pointercancel', stop); };
    addEventListener('pointerup', stop);
    addEventListener('pointercancel', stop);
  }

  onClick(e) {
    const b = e.target.closest('[data-a]');
    if (!b || b.dataset.hold) return;
    const g = this.game, st = g.sim.state, a = b.dataset.a;
    const d = +b.dataset.d || 0;
    switch (a) {
      case 'spindle': g.act('spindle', +b.dataset.v); break;
      case 'gear': g.act('gear', st.gear + d); break;
      case 'feedIndex': g.act('feedIndex', Math.max(0, Math.min(FEEDS.length - 1, st.feed.index + d))); break;
      case 'feed': g.act('feed', b.dataset.v); break;
      case 'feedDir': g.act('feedDir', -st.feed.dir); break;
      case 'pitch': g.act('pitch', Math.max(0, Math.min(PITCHES.length - 1, st.threadIndex + d))); break;
      case 'halfNut': g.act('halfNut', !st.halfNut); break;
      case 'compoundAngle': g.act('compoundAngle', b.dataset.set != null ? +b.dataset.set : st.compound.angle + (e.shiftKey ? Math.sign(d) : d)); break;
      case 'tool': g.act('tool', +b.dataset.v); break;
      case 'tailLock': g.act('tailLock', !st.tailstock.locked); break;
      case 'guard': g.act('guard', !st.guardOpen); break;
      case 'coolant': g.act('coolant', !st.coolant); break;
      case 'light': g.act('light', !g.app.vis.light); break;
      case 'estop': g.act('estop', !st.estop); break;
      case 'reset': g.act('reset'); break;
      case 'brake': g.act('brake'); break;
      case 'chuck': g.act('chuck'); break;
      case 'zeroDial': g.act('zeroDial', b.dataset.v); break;
      case 'zeroDro': g.act('zeroDro', b.dataset.v); break;
      case 'droMode': g.app.settings.droRadius = !g.app.settings.droRadius; g.app.saveSettings(); this.refresh(true); break;
      case 'droOn': g.app.settings.dro = !g.app.settings.dro; g.app.saveSettings(); this.refresh(true); break;
      case 'step': g.step = g.step === 1 ? 10 : 1; this.refresh(true); break;
      case 'side': document.body.classList.toggle('lt-side-open'); break;
      case 'view': g.setView(b.dataset.v); this.refresh(true); break;
      case 'drawing': g.ui.toggleDrawing(); break;
      case 'back': g.exitOp(); break;
      default: break;
    }
  }

  // drag a dial round (angle about its centre) or scroll over it
  bindWheel(axis, cv) {
    const g = this.game, div = GRAD[axis].div;
    let drag = null;
    const ang = (e) => { const r = cv.getBoundingClientRect(); return Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))); };
    cv.addEventListener('pointerdown', (e) => { drag = { a: ang(e), acc: 0 }; cv.setPointerCapture(e.pointerId); e.preventDefault(); });
    cv.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const a = ang(e);
      let d = a - drag.a;
      if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU;
      drag.a = a;
      drag.acc += (d / TAU) * div * (e.shiftKey ? 0.25 : 1);
      const n = Math.trunc(drag.acc);
      if (n) { drag.acc -= n; g.turn(axis, n); }
    });
    const end = () => { drag = null; };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const n = (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 10 : g.step);
      g.turn(axis, n);
    }, { passive: false });
  }

  flashWheel(axis) {
    const w = this.wheels[axis];
    if (!w) return;
    w.el.classList.add('flash');
    clearTimeout(w.ft);
    w.ft = setTimeout(() => w.el.classList.remove('flash'), 900);
  }

  drawWheel(w) {
    const sim = this.sim, axis = w.def.axis, D = sim.dial(axis), divN = D.divPerRev;
    const turns = wheelTurns(sim, axis);
    const key = `${D.div.toFixed(2)}|${turns.toFixed(4)}|${w.cv.clientWidth}`;
    if (key === w.key) return;
    w.key = key;
    const dpr = devicePixelRatio || 1;
    const S = w.cv.clientWidth || 128;
    if (w.cv.width !== Math.round(S * dpr)) { w.cv.width = Math.round(S * dpr); w.cv.height = Math.round(S * dpr); }
    const k = w.cv.getContext('2d');
    k.setTransform(dpr, 0, 0, dpr, 0, 0);
    k.clearRect(0, 0, S, S);
    const c = S / 2, R = S * 0.47;
    // handwheel rim + spokes (turn with the wheel)
    const wa = turns * TAU;
    k.save();
    k.translate(c, c);
    k.rotate(wa);
    k.lineWidth = S * 0.05;
    k.strokeStyle = '#c9ced3';
    k.beginPath(); k.arc(0, 0, R - S * 0.03, 0, TAU); k.stroke();
    k.strokeStyle = '#1d2024';
    k.lineWidth = S * 0.05;
    for (let i = 0; i < 3; i++) { const a = (i / 3) * TAU; k.beginPath(); k.moveTo(Math.sin(a) * R * 0.5, -Math.cos(a) * R * 0.5); k.lineTo(Math.sin(a) * (R - S * 0.05), -Math.cos(a) * (R - S * 0.05)); k.stroke(); }
    // spinner handle
    k.fillStyle = '#16191c'; k.beginPath(); k.arc(0, -(R - S * 0.03), S * 0.055, 0, TAU); k.fill();
    k.fillStyle = '#5a636c'; k.beginPath(); k.arc(-S * 0.015, -(R - S * 0.03) - S * 0.015, S * 0.02, 0, TAU); k.fill();
    k.restore();
    // graduated dial (rotates with the reading; numbers under the index mark at the top)
    const dr = R * 0.66;
    const g = k.createRadialGradient(c - dr * 0.3, c - dr * 0.3, dr * 0.1, c, c, dr);
    g.addColorStop(0, '#f1f3f5'); g.addColorStop(1, '#a9b0b7');
    k.fillStyle = g;
    k.beginPath(); k.arc(c, c, dr, 0, TAU); k.fill();
    k.strokeStyle = '#4a525a'; k.lineWidth = 1; k.stroke();
    const rot = (D.div / divN) * TAU;
    k.strokeStyle = '#15181b';
    k.fillStyle = '#15181b';
    k.font = `600 ${Math.round(S * 0.07)}px Arial, sans-serif`;
    k.textAlign = 'center'; k.textBaseline = 'middle';
    const tickStep = divN > 200 ? 2 : 1;
    for (let i = 0; i < divN; i += tickStep) {
      const th = rot - (i / divN) * TAU; // graduation i sits counter-clockwise of the index by i divisions
      const s = Math.sin(th), co = -Math.cos(th);
      const long = i % w.def.labelEvery === 0, mid = i % 5 === 0;
      const l = long ? dr * 0.2 : mid ? dr * 0.13 : dr * 0.08;
      k.lineWidth = long ? 1.4 : 0.8;
      k.beginPath(); k.moveTo(c + s * dr, c + co * dr); k.lineTo(c + s * (dr - l), c + co * (dr - l)); k.stroke();
      if (long) k.fillText(String(i), c + s * (dr * 0.66), c + co * (dr * 0.66));
    }
    // fixed index mark
    k.fillStyle = '#d0312a';
    k.beginPath(); k.moveTo(c, c - dr - 1); k.lineTo(c - 5, c - dr - 9); k.lineTo(c + 5, c - dr - 9); k.closePath(); k.fill();
    // hub
    k.fillStyle = '#2a2f34'; k.beginPath(); k.arc(c, c, dr * 0.3, 0, TAU); k.fill();
    k.fillStyle = '#ffd27a';
    k.font = `700 ${Math.round(S * 0.085)}px ${getComputedStyle(document.body).getPropertyValue('--f-mono') || 'monospace'}`;
    k.fillText(String(Math.round(D.div) % divN < 0 ? (Math.round(D.div) % divN) + divN : Math.round(D.div) % divN), c, c + 1);
  }

  update(dt) {
    this._t += dt;
    for (const w of Object.values(this.wheels)) this.drawWheel(w);
    if (this._t > 0.1) { this._t = 0; this.refresh(); }
  }

  refresh(force = false) {
    const g = this.game, app = g.app, sim = this.sim, st = sim.state;
    const set = (id, txt) => { const e = document.getElementById(id); if (e && e.textContent !== txt) e.textContent = txt; };
    const on = (sel, v, root = document) => { for (const e of $$(sel, root)) e.classList.toggle('on', !!v(e)); };
    // status
    const al = $('#ltAlarm');
    al.hidden = !st.alarm;
    if (st.alarm) al.textContent = st.alarm;
    // a message stays up for a while, then the status line falls back to the workpiece summary
    if (st.message !== this._msg) { this._msg = st.message; this._msgT = performance.now(); }
    const fresh = st.message && (st.alarm || performance.now() - this._msgT < 7000);
    set('ltMsg', (fresh && st.message) || (st.stock ? `Ø${st.stock.dia} ${MATERIALS[st.stock.material].short.toLowerCase()} in the chuck, ${st.stock.stickout.toFixed(1)} mm out${st.chuck.clamped ? '' : ' (chuck open)'}` : 'Chuck empty: load a bar'));
    const c = st.cut;
    set('ltCut', c.active ? `ap ${c.ap.toFixed(2)} · f ${c.f.toFixed(2)} · Vc ${Math.round(c.vc)} m/min · ${Math.round(c.power * 1000)} W` : st.spindle.rpm > 1 && st.stock ? `Vc at Ø${(2 * Math.max(sim.toolTip().r, 0)).toFixed(1)}: ${Math.round(Math.PI * 2 * Math.max(sim.toolTip().r, 0) * st.spindle.rpm / 1000)} m/min` : '');
    $('#ltLoad').style.width = `${Math.min(100, (c.load || 0) * 80)}%`;
    // spindle
    on('[data-a="spindle"]', (e) => +e.dataset.v === st.spindle.dir, this.el);
    const half = SPEEDS.length / 2;
    set('ltRpm', `${st.spindle.rpmSet} rpm ${st.gear >= half ? 'H' : 'L'}`);
    set('ltRpmAct', `actual ${Math.round(st.spindle.rpm)} rpm${st.spindle.dir < 0 ? ' reverse' : ''}`);
    set('ltStep', `Step ${g.step} div`);
    // dials readouts
    for (const w of Object.values(this.wheels)) {
      const D = sim.dial(w.def.axis);
      const txt = w.def.axis === 'cross' ? `Ø ${D.mm.toFixed(2)}` : `${D.mm.toFixed(2)}`;
      if (w.read.textContent !== txt) w.read.textContent = txt;
    }
    // DRO
    const dro = sim.dro(), S = app.settings;
    $('#ltDro').classList.toggle('off', !S.dro);
    set('ltDroOn', S.dro ? 'ON' : 'OFF');
    set('ltDroMode', S.droRadius ? 'R' : 'Ø');
    set('ltDroXl', S.droRadius ? 'XR' : 'XØ');
    set('ltDroX', S.dro ? (S.droRadius ? dro.xRel / 2 : dro.xRel).toFixed(3) : '');
    set('ltDroZ', S.dro ? dro.zRel.toFixed(3) : '');
    // tools
    $$('[data-a="tool"]', this.el).forEach((b, i) => { b.classList.toggle('on', st.toolIndex === i); b.classList.toggle('broken', !!st.tools[i].broken); });
    // side panel
    set('ltFeed', `${st.feed.rate.toFixed(2)} mm/rev`);
    on('[data-a="feed"]', (e) => e.dataset.v === st.feed.engaged, this.side);
    const lng = st.feed.engaged === 'cross';
    set('ltDir', lng ? (st.feed.dir > 0 ? '↑ cross in' : '↓ cross out') : st.feed.dir > 0 ? '← toward chuck' : '→ toward tailstock');
    set('ltPitch', `P ${st.threadPitch.toFixed(2)}`);
    $('#ltHalf').classList.toggle('on', st.halfNut);
    set('ltComp', `${st.compound.angle.toFixed(0)}°`);
    const tl = $('#ltTail');
    const tid = (() => { const t = st.tailstock.tool; if (!t) return 'none'; return t.type === 'centre' ? 'c5' : 'd' + t.d; })();
    if (tl.value !== tid && document.activeElement !== tl) tl.value = tid;
    set('ltTailLock', st.tailstock.locked ? 'LOCKED' : 'UNLOCKED');
    $('#ltTailLock').classList.toggle('on', !st.tailstock.locked);
    set('ltTailPos', `tip Z ${sim.tailTipZ().toFixed(1)} · quill ${st.tailstock.quill.toFixed(1)}`);
    set('ltGuard', st.guardOpen ? 'GUARD OPEN' : 'GUARD SHUT');
    $('#ltGuard').classList.toggle('on', !st.guardOpen);
    $('#ltCool').classList.toggle('on', st.coolant);
    $('#ltLight').classList.toggle('on', app.vis.light);
    $('#ltEstop').classList.toggle('on', st.estop);
    on('[data-a="view"]', (e) => e.dataset.v === g.cam.preset, this.side);
    void force;
  }
}
