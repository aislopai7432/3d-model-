// Manual-lathe game UI: HUD (objectives, carried item, toasts, help, tutorial card host), the game
// overlays (job board, drawing viewer, stock rack, chuck, tooling, inspection report, measuring with
// calipers / micrometer / depth rod / pitch gauge) and the operator panel (lathe-panel.js).
// Reuses the workshop game's g-* styles (styles.css); lathe-only styles are injected below (lt-*).
import { MATERIALS } from '../config.js';
import { DrawView } from '../game/drawview.js';
import { drawLCD, drawMicrometerScale } from '../game/measuring.js';
import { LATHE_JOBS, BARS, barLabel, barFits, barMassG, latheDrawingSVG, jobChecks, pieceFrame, readInstrument, tolText } from './lathe-jobs.js';
import { CHUCK } from './lathe-sim.js';
import { LathePanel } from './lathe-panel.js';

function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const stars = (n) => `<span class="g-stars" aria-label="difficulty ${n} of 5">${'★'.repeat(n)}<i>${'★'.repeat(5 - n)}</i></span>`;
const hex = (v) => '#' + v.toString(16).padStart(6, '0');
const swatch = (m) => { const M = MATERIALS[m] || MATERIALS.steel; return `background:linear-gradient(180deg, ${hex(M.cut)}, ${hex(M.raw)} 55%, ${hex(M.raw)})`; };
const fmtN = (v, d = 3) => (v == null || !isFinite(v) ? '—' : (+v).toFixed(d));
const ICON = {
  drawing: '<svg viewBox="0 0 24 24"><path d="M5 3.5h10l4 4V20.5H5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 11h8M8 14.5h8M8 18h5" stroke="currentColor" stroke-width="1.6"/></svg>',
  jobs: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M7 8.5h4v4H7zM13 8.5h4M13 11h4M7 15.5h10" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>',
  help: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M9.6 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1.1.9-1.1 1.7v.4M12 16.6v.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  cap: '<svg viewBox="0 0 24 24"><path d="M2.5 9.5 12 5l9.5 4.5L12 14z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M6.5 11.5V16c1.5 1.6 3.4 2.4 5.5 2.4s4-.8 5.5-2.4v-4.5M21.5 9.5v5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  bar: '<svg viewBox="0 0 24 24"><ellipse cx="6" cy="12" rx="2.5" ry="5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M6 7h12M6 17h12" stroke="currentColor" stroke-width="1.7"/><ellipse cx="18" cy="12" rx="2.5" ry="5" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const CSS = `
body.lathe #modeSeg, body.lathe .prog-chip, body.lathe .state-pill, body.lathe [data-action="wizard"],
body.lathe .cu, body.lathe .mcp, body.lathe .haas, body.lathe .g-dpanel, body.lathe .simbox, body.lathe .mobile-tabs { display: none !important; }
body.lathe .workspace { grid-template-columns: minmax(0, 1fr) !important; }
body.lathe #app { grid-template-rows: 46px minmax(0, 1fr) !important; }
.lt-tut { position: absolute; left: 12px; top: 12px; width: 340px; max-width: calc(100% - 24px); z-index: 8; border-radius: 10px; background: rgba(14,17,21,.92); border: 1px solid rgba(255,196,64,.45); box-shadow: 0 12px 30px rgba(0,0,0,.45); color: var(--text); font: 400 13px/1.45 var(--f-ui); overflow: hidden; }
.lt-tut[hidden] { display: none; }
body.lathe .g-help { width: 460px; max-height: calc(100% - 24px); overflow: auto; }
.lt-tut-h { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: linear-gradient(rgba(255,196,64,.16), rgba(255,196,64,.02)); border-bottom: 1px solid rgba(255,255,255,.07); }
.lt-tut-h .lbl { font: 700 10px var(--f-cond); letter-spacing: .14em; text-transform: uppercase; color: #ffc440; }
.lt-tut-h b { font: 600 14.5px var(--f-cond); flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lt-tut-b { padding: 9px 12px 4px; }
.lt-tut-b p { margin: 0 0 6px; color: var(--text-2); }
.lt-tut-b p b, .lt-tut-b p kbd { color: #ffd27a; }
.lt-tut-b .hint { font-size: 12px; color: #d9b45a; }
.lt-tut-dots { display: flex; gap: 3px; padding: 0 12px 6px; }
.lt-tut-dots i { flex: 1; height: 3px; border-radius: 2px; background: #333b44; }
.lt-tut-dots i.d { background: var(--ok); } .lt-tut-dots i.c { background: #ffc440; }
.lt-tut-f { display: flex; gap: 6px; padding: 6px 12px 10px; justify-content: flex-end; }
.lt-tut-f .btn { height: 26px; font-size: 12px; }
.lt-tut.min .lt-tut-b, .lt-tut.min .lt-tut-dots { display: none; }
.lt-tut.done { border-color: rgba(52,199,123,.6); }
body.lt-op .lt-tut { left: 12px; top: 46px; width: 320px; max-height: calc(100% - var(--ltb, 244px) - 60px); overflow: auto; }
.lt-chuck-row { display: flex; align-items: center; gap: 10px; margin: 8px 0; }
.lt-chuck-row input[type=range] { flex: 1; accent-color: #ffc440; }
.lt-chuck-row output { font: 600 14px var(--f-mono); min-width: 74px; text-align: right; }
.lt-chuck-fig { width: 100%; height: 120px; display: block; background: #0f1215; border-radius: 8px; border: 1px solid var(--line-2); }
.lt-kv { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; font-size: 12.5px; margin: 6px 0 10px; }
.lt-kv dt { color: var(--muted); } .lt-kv dd { margin: 0; }
.g-blank .g-blk.bar { width: 74px; height: 22px; border-radius: 11px / 11px; }
.lt-meas { display: grid; grid-template-columns: 220px minmax(0, 1fr) 320px; gap: 12px; height: 100%; min-height: 0; }
.lt-meas-tools { display: grid; gap: 6px; align-content: start; }
.lt-meas-tools button { display: grid; gap: 2px; text-align: left; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line-2); background: var(--panel-2); color: var(--text); cursor: pointer; }
.lt-meas-tools button b { font: 600 13px var(--f-cond); }
.lt-meas-tools button span { font-size: 11.5px; color: var(--muted); }
.lt-meas-tools button.on { border-color: #ffc440; background: rgba(255,196,64,.1); }
.lt-meas-view { position: relative; min-height: 0; border-radius: 8px; border: 1px solid var(--line-2); background: #e9ebe6; overflow: hidden; cursor: crosshair; }
.lt-meas-view canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.lt-meas-hint { position: absolute; left: 10px; top: 8px; font: 600 12px var(--f-ui); color: #33404d; background: rgba(255,255,255,.8); padding: 3px 8px; border-radius: 6px; pointer-events: none; }
.lt-meas-side { display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.lt-meas-read { width: 100%; height: 150px; border-radius: 8px; background: #121518; display: block; }
.lt-meas-what { font-size: 12.5px; color: var(--text-2); min-height: 36px; }
.lt-meas-side .g-table-wrap { flex: 1; min-height: 0; }
@media (max-width: 1000px) { .lt-meas { grid-template-columns: 1fr; grid-template-rows: auto 260px auto; } .lt-meas-tools { grid-template-columns: repeat(3, 1fr); } }
.lt-tools-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
.lt-tools-grid > div { padding: 10px; border-radius: 9px; border: 1px solid var(--line-2); background: var(--panel-2); font-size: 12.5px; color: var(--text-2); }
.lt-tools-grid b { display: block; font: 600 14px var(--f-cond); color: var(--text); margin-bottom: 4px; }
`;

export class LatheUI {
  constructor(game) {
    this.game = game;
    this.app = game.app;
    this.modals = [];
    this._t = 0;
    this._objKey = '';
  }

  build() {
    if (!$('#lt-style')) {
      const st = document.createElement('style');
      st.id = 'lt-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    const g = this.game;
    $('#jobChip')?.addEventListener('click', () => (g.job ? this.openDrawing(g.job) : this.openJobs()));
    const hud = document.createElement('div');
    hud.className = 'g-hud';
    hud.innerHTML = `
      <section class="g-obj" id="gObj" aria-live="polite"></section>
      <div class="g-hudbtns">
        <button class="g-hb" data-g="drawing" title="Current drawing (Q)">${ICON.drawing}<span>Drawing</span><kbd>Q</kbd></button>
        <button class="g-hb" data-g="jobs" title="Job list (J)">${ICON.jobs}<span>Jobs</span><kbd>J</kbd></button>
        <button class="g-hb" data-g="tutorial" title="Interactive tutorial (T)">${ICON.cap}<span>Tutorial</span><kbd>T</kbd></button>
        <button class="g-hb" data-g="help" title="Controls (H)">${ICON.help}<span>Help</span><kbd>H</kbd></button>
      </div>
      <div class="g-carry" id="gCarry" hidden></div>
      <div class="g-help" id="gHelp" hidden>
        <div class="g-help-h"><b>The lathe shop</b><button class="btn ghost icon" data-g="helpClose" aria-label="Close">✕</button></div>
        <p>Pick a job at the <b>job board</b>, saw a <b>round bar</b> off at the stock rack, put it in the <b>chuck</b>, then step up to the lathe and turn it <b>by hand</b> with the handwheels. Part it off, pick it up and check it at the <b>inspection bench</b>.</p>
        <table>
          <tr><td><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></td><td>Walk · <kbd>Shift</kbd> run · <kbd>C</kbd> crouch</td></tr>
          <tr><td><kbd>E</kbd> / click</td><td>Use what the crosshair points at (E on the lathe: operator position)</td></tr>
          <tr><td colspan="2"><b>At the lathe</b></td></tr>
          <tr><td><kbd>←</kbd><kbd>→</kbd> / <kbd>A</kbd><kbd>D</kbd></td><td>Carriage handwheel (toward / away from the chuck)</td></tr>
          <tr><td><kbd>↑</kbd><kbd>↓</kbd> / <kbd>W</kbd><kbd>S</kbd></td><td>Cross-slide in / out (0.02 mm per division on Ø)</td></tr>
          <tr><td><kbd>[</kbd><kbd>]</kbd> · <kbd>,</kbd><kbd>.</kbd></td><td>Compound slide · tailstock quill</td></tr>
          <tr><td><kbd>Shift</kbd> / <kbd>Alt</kbd></td><td>Coarse / fine while holding a key · <kbd>Tab</kbd> tap = 1 or 10 divisions</td></tr>
          <tr><td><kbd>Space</kbd></td><td>Spindle forward / stop (<kbd>Shift</kbd>: reverse) · <kbd>+</kbd><kbd>−</kbd> speed</td></tr>
          <tr><td><kbd>F</kbd> · <kbd>R</kbd> · <kbd>N</kbd></td><td>Power feed (Shift: cross) · feed direction · half nut</td></tr>
          <tr><td><kbd>1</kbd>–<kbd>4</kbd> · <kbd>G</kbd> · <kbd>C</kbd> · <kbd>X</kbd></td><td>Tool post · guard · coolant · E-stop</td></tr>
          <tr><td>Mouse</td><td>Drag dials or scroll over them / over the 3D handwheels · drag the view · <kbd>V</kbd> views · <kbd>Esc</kbd> step back</td></tr>
        </table>
        <div class="g-help-acts"><span class="g-help-q">New to the lathe? The tutorial walks you through your first part.</span><button class="btn" data-g="helpClose">Skip</button><button class="btn primary" data-g="tutorial">Start tutorial</button></div>
      </div>
      <div class="g-toasts" id="gToasts"></div>
      <section class="lt-tut" id="ltTut" hidden></section>`;
    $('#viewport').appendChild(hud);
    this.hud = hud;
    hud.addEventListener('click', (e) => {
      const b = e.target.closest('[data-g]');
      if (!b) return;
      const k = b.dataset.g;
      if (k === 'drawing') this.toggleDrawing();
      else if (k === 'jobs') this.openJobs();
      else if (k === 'help') this.showHelp(!!$('#gHelp').hidden);
      else if (k === 'helpClose') this.showHelp(false);
      else if (k === 'tutorial') { this.showHelp(false); g.tut.toggle(); }
      else if (k === 'obj') { this.objCollapsed = !this.objCollapsed; this._objKey = ''; }
    });
    this.panel = new LathePanel(this.game);
    this.panel.build();
    addEventListener('keydown', (e) => this.onKey(e));
  }

  onKey(e) {
    const g = this.game;
    const t = e.target;
    const typing = t && (t.isContentEditable || /^(TEXTAREA|SELECT)$/.test(t.tagName) || (t.tagName === 'INPUT' && !/^(button|checkbox|radio|range)$/i.test(t.type)));
    if (e.key === 'Escape') {
      if (this.topModal()) { e.preventDefault(); this.closeTop(); return; }
      if (!$('#gHelp').hidden) { this.showHelp(false); return; }
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    const top = this.topModal();
    if (e.code === 'KeyQ') { e.preventDefault(); if (top?.kind === 'drawing') this.closeTop(); else if (!top) this.toggleDrawing(); }
    else if (e.code === 'KeyJ' && !top) { e.preventDefault(); this.openJobs(); }
    else if (e.code === 'KeyT' && !top) { e.preventDefault(); g.tut.toggle(); }
    else if (e.code === 'KeyH' && !top) this.showHelp(!!$('#gHelp').hidden);
  }

  // ------------------------------------------------------------------ HUD
  toast(msg, kind = 'info', ms = 3600) {
    const box = $('#gToasts');
    if (!box || !msg) return;
    // the same message twice in a row: just keep the first one up
    const last = box.lastElementChild;
    if (last && last.textContent === msg && last.classList.contains('in')) return;
    const t = document.createElement('div');
    t.className = `g-toast ${kind}`;
    t.textContent = msg;
    box.appendChild(t);
    while (box.children.length > 3) box.firstChild.remove();
    requestAnimationFrame(() => t.classList.add('in'));
    setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, ms);
  }

  showHelp(on) {
    $('#gHelp').hidden = !on;
    if (!on && !this.game.s.helpSeen) { this.game.s.helpSeen = true; this.game.save(); }
  }

  syncHud() {
    const g = this.game;
    const walking = !g.op && !g.measuring;
    this.hud.classList.toggle('g-walk', walking);
    this.hud.classList.toggle('g-op', !!g.op);
    this.hud.classList.toggle('g-meas', !!g.measuring);
    const j = g.job, chip = $('#jobChip');
    if (chip) {
      chip.hidden = false;
      chip.innerHTML = j ? `<span class="lbl">JOB</span><b>${esc(j.id)}</b><span class="jt">${esc(j.title)}</span>` : '<span class="lbl">JOB</span><span class="jt">Pick a job</span>';
    }
    const c = $('#gCarry');
    if (g.carry) {
      c.hidden = false;
      c.innerHTML = g.carry.kind === 'bar'
        ? `${ICON.bar}<span class="lbl">Carrying</span><span>${esc(barLabel(g.carry.bar))} bar</span>`
        : `${ICON.bar}<span class="lbl">Carrying</span><span>Turned part ${g.carry.piece.length.toFixed(1)} mm${g.carry.jobId ? ' · job ' + esc(g.carry.jobId) : ''}</span>`;
    } else c.hidden = true;
    this._objKey = '';
  }

  renderObjectives() {
    const g = this.game;
    const el = $('#gObj');
    if (g.tut.active) { el.hidden = true; return; }
    el.hidden = false;
    const m = g.objectives();
    const key = JSON.stringify([m.job?.id, m.steps.map((s) => s.done), m.next, m.done, Math.floor(m.time), this.objCollapsed]);
    if (key === this._objKey) return;
    this._objKey = key;
    if (!m.job) {
      el.innerHTML = `<button class="g-obj-h" data-g="obj"><span class="lbl">Lathe shop</span><b>No job yet</b><span class="g-obj-meta">Job board on the left wall · <kbd>J</kbd></span></button>`;
      return;
    }
    const li = m.steps.map((s, i) => `<li class="${s.done ? 'done' : i === m.next ? 'next' : ''}"><i>${s.done ? ICON.check : ''}</i><span>${esc(s.t)}${s.sub && i === m.next ? `<small>${esc(s.sub)}</small>` : ''}</span></li>`).join('');
    el.classList.toggle('collapsed', !!this.objCollapsed);
    el.innerHTML = `<button class="g-obj-h" data-g="obj"><span class="lbl">Job ${esc(m.job.id)} · ${fmtClock(m.time)}</span><b>${esc(m.job.title)}</b></button><ol class="g-steps">${li}</ol>${m.done ? '<div class="g-obj-done">Job complete! Pick the next one at the job board.</div>' : ''}`;
  }

  update(dt) {
    this._t += dt;
    if (this._t > 0.25) {
      this._t = 0;
      this.renderObjectives();
    }
    if (this.game.op) this.panel.update(dt);
  }

  // ------------------------------------------------------------------ modals
  topModal() { return this.modals[this.modals.length - 1] || null; }
  closeTop() { this.topModal()?.close(); }
  closeAll() { while (this.modals.length) this.modals[this.modals.length - 1].close(); }
  modal({ kind, cls = '', title, sub = '', body = '', foot = '', onClose }) {
    const wrap = document.createElement('div');
    wrap.className = `modal-wrap g-modal-wrap g-${kind}-wrap`;
    wrap.innerHTML = `<div class="modal g-modal ${cls}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-h"><b>${title}</b>${sub ? `<span class="g-sub">${sub}</span>` : ''}<button class="btn ghost icon g-x" aria-label="Close (Esc)" title="Close (Esc)">✕</button></div>
      <div class="modal-b">${body}</div>${foot ? `<div class="modal-f">${foot}</div>` : ''}</div>`;
    document.body.appendChild(wrap);
    const g = this.game;
    const h = {
      kind, el: wrap, closed: false,
      close: () => {
        if (h.closed) return;
        h.closed = true;
        wrap.remove();
        this.modals = this.modals.filter((x) => x !== h);
        onClose?.();
        if (!this.modals.length && !g.op && !g.measuring) g.fp.frozen = false;
        g.syncHandVisible();
      },
    };
    $('.g-x', wrap).addEventListener('click', h.close);
    wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) h.close(); });
    this.modals.push(h);
    g.fp.frozen = true;
    g.held.clear();
    g.syncHandVisible();
    return h;
  }

  toggleDrawing() {
    const g = this.game;
    if (this.topModal()?.kind === 'drawing') return this.closeTop();
    if (g.job) this.openDrawing(g.job); else this.openJobs();
  }

  openJobs() {
    const g = this.game;
    this.closeAll();
    const cards = LATHE_JOBS.map((p) => {
      const best = g.s.jobs[p.id]?.best, cur = g.s.jobId === p.id;
      return `<button class="g-job${cur ? ' cur' : ''}" data-job="${p.id}">
        <div class="g-job-thumb">${latheDrawingSVG(p)}</div>
        <div class="g-job-b">
          <div class="g-job-t"><b>${esc(p.id)}</b><span>${esc(p.title)}</span>${cur ? '<em>Current</em>' : ''}${best ? `<i class="g-grade-s g-${best.grade}" title="Best grade">${best.grade}</i>` : ''}</div>
          <div class="g-job-m">${stars(p.difficulty)}<span><i class="g-sw" style="${swatch(p.material)}"></i>${esc(MATERIALS[p.material].short)}</span><span>Bar Ø${p.bar.dia} × ${p.bar.length}</span></div>
          <p>${esc(p.brief)}</p>
          <div class="g-job-c">${esc(p.customer)} · ${esc(p.drawingNo)} rev ${esc(p.rev)}${best ? ` · best ${best.score}/100${best.time != null ? ' in ' + fmtClock(best.time) : ''}` : ''}</div>
        </div></button>`;
    }).join('');
    const done = LATHE_JOBS.filter((p) => g.s.jobs[p.id]?.best && g.s.jobs[p.id].best.grade !== 'FAIL').length;
    const m = this.modal({ kind: 'jobs', cls: 'g-wide', title: 'Job board · turning', sub: `${done} of ${LATHE_JOBS.length} jobs completed · choose a drawing`, body: `<div class="g-jobs">${cards}</div>` });
    $$('[data-job]', m.el).forEach((b) => b.addEventListener('click', () => this.openDrawing(LATHE_JOBS.find((p) => p.id === b.dataset.job))));
  }

  openDrawing(part) {
    const g = this.game;
    if (!part) return;
    this.closeAll();
    const cur = g.s.jobId === part.id && !g.prog?.done;
    const best = g.s.jobs[part.id]?.best;
    const feats = jobChecks(part);
    const side = `
      <div class="g-dw-info">
        <div class="g-dw-title"><b>${esc(part.id)} · ${esc(part.title)}</b><span>${esc(part.drawingNo)} rev ${esc(part.rev)} · ${esc(part.customer)}</span></div>
        <p class="g-dw-brief">${esc(part.brief)}</p>
        <dl class="g-kv">
          <dt>Difficulty</dt><dd>${stars(part.difficulty)}</dd>
          <dt>Material</dt><dd><i class="g-sw" style="${swatch(part.material)}"></i>${esc(MATERIALS[part.material].name)}</dd>
          <dt>Bar stock</dt><dd>Ø${part.bar.dia} × ${part.bar.length} mm</dd>
          <dt>Finished</dt><dd>Ø${Math.max(...part.segs.map((s) => s.d))} × ${part.length} mm</dd>
          <dt>Checked</dt><dd>${feats.length} characteristics</dd>
          <dt>Tolerance</dt><dd>±0.1 mm unless stated</dd>
          ${best ? `<dt>Best</dt><dd><i class="g-grade-s g-${best.grade}">${best.grade}</i> ${best.score}/100${best.time != null ? ' · ' + fmtClock(best.time) : ''}</dd>` : ''}
        </dl>
        <div class="g-setup"><b>Setup</b>${esc(part.setup)}</div>
        <div class="g-dw-acts">
          <button class="btn primary" data-dw="accept"${cur ? ' disabled' : ''}>${cur ? 'Current job ✓' : 'Accept job'}</button>
          <button class="btn ghost" data-dw="jobs">All jobs</button>
        </div>
      </div>`;
    const m = this.modal({
      kind: 'drawing', cls: 'g-full', title: `Drawing ${esc(part.drawingNo)}`, sub: 'Scroll or pinch to zoom · drag to pan',
      body: `<div class="g-dw"><div class="g-dw-sheet"><div class="g-dw-view"></div><div class="g-dw-zoom"><button class="btn icon" data-dw="out">−</button><button class="btn icon" data-dw="in">+</button><button class="btn" data-dw="fit">Fit</button></div></div>${side}</div>`,
    });
    const view = new DrawView($('.g-dw-view', m.el));
    view.setSVG(latheDrawingSVG(part));
    m.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dw]');
      if (!b) return;
      const k = b.dataset.dw;
      if (k === 'in') view.zoomAt(1.5);
      else if (k === 'out') view.zoomAt(1 / 1.5);
      else if (k === 'fit') view.fit();
      else if (k === 'jobs') this.openJobs();
      else if (k === 'accept') { g.acceptJob(part.id); b.disabled = true; b.textContent = 'Current job ✓'; }
    });
  }

  openRack() {
    const g = this.game;
    this.closeAll();
    const carry = g.carry?.kind === 'bar' ? g.carry.bar : null;
    const job = g.job;
    const cards = BARS.map((b) => {
      const held = carry && carry.id === b.id;
      const fit = job && barFits(b, job);
      return `<button class="g-blank${held ? ' held' : ''}" data-bar="${b.id}"${held ? ' disabled' : ''}>
        <i class="g-blk bar" style="${swatch(b.material)}"></i>
        <b>Ø${b.dia} × ${b.length}</b><span>${esc(MATERIALS[b.material].short)} · ${barMassG(b)} g</span>${held ? '<em>in your hands</em>' : fit && g.tut.active ? '<em>for your job</em>' : ''}</button>`;
    }).join('');
    const m = this.modal({
      kind: 'rack', cls: 'g-wide', title: 'Stock rack · round bar', sub: 'Bars are sawn to length when you take one (diameter × length, mm)',
      body: `${carry ? `<div class="g-note"><span>You are carrying a ${esc(barLabel(carry))} bar.</span><button class="btn" data-rk="back">Put it back</button></div>` : ''}
        <p class="g-hint">${job ? `Drawing <b>${esc(job.drawingNo)}</b> calls for <b>${esc(MATERIALS[job.material].short.toLowerCase())}</b> bar: check the title block (press <kbd>Q</kbd>).` : 'Accept a job first, then pick the bar its drawing calls for.'}</p>
        <div class="g-blanks">${cards}</div>`,
      foot: job ? '<button class="btn" data-rk="drawing">View drawing</button>' : '',
    });
    m.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-bar],[data-rk]');
      if (!b) return;
      if (b.dataset.bar) { m.close(); g.takeBar(b.dataset.bar); }
      else if (b.dataset.rk === 'back') { m.close(); g.putBackBar(); }
      else if (b.dataset.rk === 'drawing') this.openDrawing(g.job);
    });
  }

  openChuck() {
    const g = this.game, sim = g.sim, st = sim.state;
    this.closeAll();
    const turning = Math.abs(st.spindle.w) > 1;
    if (turning) return this.toast('Stop the spindle before you touch the chuck.', 'warn');
    if (!st.stock) {
      const bar = g.carry?.kind === 'bar' ? g.carry.bar : null;
      if (!bar) return this.toast(g.carry ? 'Your hands are full.' : 'The chuck is empty: fetch a bar from the stock rack (right-hand wall).', 'info', 4000);
      const job = g.job && barFits(bar, g.job) ? g.job : null;
      const maxOut = bar.length - CHUCK.minGrip;
      const def = Math.min(maxOut, job ? job.stickout : Math.round(bar.length * 0.6));
      const m = this.modal({
        kind: 'chuck', cls: '', title: 'Three-jaw chuck · load the bar', sub: esc(barLabel(bar)),
        body: `<canvas class="lt-chuck-fig"></canvas>
          <div class="lt-chuck-row"><span>Stick-out</span><input type="range" min="15" max="${maxOut}" value="${def}" step="1"><output></output></div>
          <dl class="lt-kv"><dt>Grip in the jaws</dt><dd id="ltGrip"></dd><dt>Advice</dt><dd>${job ? `Job ${esc(job.id)}: about ${job.stickout} mm out (part ${job.length} mm + parting blade + clearance).` : 'As short as the part allows: a long stick-out chatters. Keep at least 15 mm in the jaws.'}</dd></dl>`,
        foot: '<button class="btn" data-ch="open">Load, leave open</button><button class="btn primary" data-ch="tight">Load &amp; tighten</button>',
      });
      const rng = $('input', m.el), out = $('output', m.el), cv = $('canvas', m.el);
      const draw = () => {
        const so = +rng.value;
        out.textContent = `${so} mm`;
        $('#ltGrip', m.el).textContent = `${bar.length - so} mm${bar.length - so < CHUCK.minGrip ? ' (too little!)' : ''}`;
        this.drawChuckFig(cv, bar, so);
      };
      rng.addEventListener('input', draw);
      requestAnimationFrame(draw);
      m.el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-ch]');
        if (!b) return;
        if (g.loadBar(+rng.value, b.dataset.ch === 'tight')) m.close();
      });
      return;
    }
    const s = st.stock;
    const m = this.modal({
      kind: 'chuck', title: 'Three-jaw chuck', sub: `${esc(barLabel(g.loaded?.bar || { dia: s.dia, length: s.length, material: s.material }))}`,
      body: `<canvas class="lt-chuck-fig"></canvas><dl class="lt-kv"><dt>Workpiece</dt><dd>Ø${s.dia} ${esc(MATERIALS[s.material].short.toLowerCase())}, ${s.stickout.toFixed(1)} mm out of the jaws</dd><dt>Chuck</dt><dd>${st.chuck.clamped ? 'tight' : 'open'}</dd></dl>`,
      foot: `<button class="btn" data-ch="out">Take the bar out</button>${st.chuck.clamped ? '<button class="btn" data-ch="loosen">Open the chuck</button>' : '<button class="btn primary" data-ch="tight">Tighten the chuck</button>'}`,
    });
    requestAnimationFrame(() => this.drawChuckFig($('canvas', m.el), { dia: s.dia, length: s.length, material: s.material }, s.stickout, sim.profile));
    m.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ch]');
      if (!b) return;
      const k = b.dataset.ch;
      m.close();
      if (k === 'tight') g.setChuck(true);
      else if (k === 'loosen') g.setChuck(false);
      else if (k === 'out') { if (st.chuck.clamped) sim.clampChuck(false); g.removeBar(); }
    });
  }

  // side view of the chuck jaws and the bar (stick-out)
  drawChuckFig(cv, bar, stickout, profile = null) {
    if (!cv) return;
    const W = (cv.width = cv.clientWidth * (devicePixelRatio || 1)), H = (cv.height = cv.clientHeight * (devicePixelRatio || 1));
    const k = cv.getContext('2d');
    k.clearRect(0, 0, W, H);
    const s = Math.min((W * 0.62) / Math.max(bar.length, 60), (H * 0.6) / Math.max(bar.dia, 30));
    const x0 = W * 0.3, cy = H / 2;
    const M = MATERIALS[bar.material];
    // chuck body + jaws
    k.fillStyle = '#2b3036'; k.fillRect(x0 - 70 * s - 40, cy - 80 * s, 70 * s + 40 - 14 * s, 160 * s);
    k.fillStyle = '#9aa3ab';
    const jh = 38 * s, jw = 26 * s, r = (bar.dia / 2) * s;
    k.fillRect(x0 - jw, cy - r - jh, jw, jh);
    k.fillRect(x0 - jw, cy + r, jw, jh);
    // bar
    const grip = bar.length - stickout;
    const g = k.createLinearGradient(0, cy - r, 0, cy + r);
    g.addColorStop(0, hex(M.raw)); g.addColorStop(0.35, hex(M.cut)); g.addColorStop(1, hex(M.raw));
    k.fillStyle = g;
    if (profile) {
      k.beginPath();
      k.moveTo(x0 - grip * s, cy);
      for (let z = profile.zMin; z <= profile.zMax; z += 0.5) { const i = Math.round(profile.idx(z)); const rr = profile.has(i) ? profile.rOut[i] : 0; k.lineTo(x0 + z * s, cy - rr * s); }
      for (let z = profile.zMax; z >= profile.zMin; z -= 0.5) { const i = Math.round(profile.idx(z)); const rr = profile.has(i) ? profile.rOut[i] : 0; k.lineTo(x0 + z * s, cy + rr * s); }
      k.closePath(); k.fill();
    } else k.fillRect(x0 - grip * s, cy - r, bar.length * s, 2 * r);
    k.strokeStyle = '#ffc440'; k.lineWidth = 1.5 * (devicePixelRatio || 1);
    k.setLineDash([6, 4]);
    k.beginPath(); k.moveTo(x0, cy - r - jh - 8); k.lineTo(x0, cy + r + jh + 8); k.stroke();
    k.setLineDash([]);
    k.fillStyle = '#ffd27a';
    k.font = `600 ${Math.round(12 * (devicePixelRatio || 1))}px system-ui, sans-serif`;
    k.textAlign = 'center';
    k.fillText(`${stickout.toFixed ? stickout.toFixed(0) : stickout} mm out`, x0 + (stickout * s) / 2, cy - r - 10);
    k.fillStyle = '#aab4be';
    k.fillText('jaw face (Z0)', x0, cy + r + jh + 22);
  }

  openTooling() {
    this.closeAll();
    const sim = this.game.sim;
    const t = sim.state.tools;
    const m = this.modal({
      kind: 'tools', cls: 'g-wide', title: 'Lathe tooling', sub: 'Four-way tool post and tailstock drill chuck',
      body: `<div class="lt-tools-grid">
        <div><b>T1 · Turning tool 95°</b>Carbide insert, R0.4 nose. Turns diameters toward the chuck and faces the end (feed the cross-slide in past centre).${t[0].broken ? ' <em>Broken: reset the alarm for a fresh insert.</em>' : ''}</div>
        <div><b>T2 · Chamfer tool 45°</b>90° V point: plunge it radially at the end for a 45° chamfer. Also faces.</div>
        <div><b>T3 · Parting blade 3 mm</b>Grooves and parts off. The DRO / dial reference is its LEFT (chuck-side) corner. Feed slowly, lots of coolant.</div>
        <div><b>T4 · Thread tool 60°</b>Screw-cutting with the half nut. Set the pitch on the gearbox and keep the half nut closed between passes (reverse the spindle to go back).</div>
        <div><b>Tailstock</b>Centre drill Ø5, twist drills Ø6–Ø12. Unlock, slide it up to the work, lock it, then wind the quill (0.05 mm/div, 5 mm/rev).</div>
        <div><b>Dials</b>Carriage 0.1 mm/div (25 mm/rev) · cross-slide 0.02 mm per division <b>on diameter</b> (4 mm Ø per rev) · compound 0.02 mm/div. Zero a dial by slipping its collar.</div>
      </div><p class="g-hint">Speeds: Vc = π·D·n/1000. Aluminium 150–300 m/min, brass 100–200, steel 60–120 with these inserts.</p>`,
    });
    void m;
  }

  openReport(rec) {
    const g = this.game;
    this.closeAll();
    const { report: r, part } = rec;
    const grade = r.grade;
    const rows = r.items.map((it) => `<tr class="${it.pass ? '' : 'bad'}"><td>${esc(it.label)}${it.extra ? `<br><small>${esc(it.extra)}</small>` : ''}</td><td>${it.kind === 'thru' ? 'yes' : fmtN(it.nominal)}</td><td>${it.kind === 'thru' ? '—' : tolText(it.tol, 3)}</td><td>${it.missing ? 'missing' : it.kind === 'thru' ? (it.measured ? 'yes' : 'no') : fmtN(it.measured)}</td><td class="st">${it.pass ? 'OK' : 'NOT OK'}</td></tr>`).join('');
    const logRows = g.mlog.map((l) => {
      const dev = l.nominal != null && l.value != null ? l.value - l.nominal : null;
      const bad = dev != null && l.tol && (dev < l.tol[0] - 1e-9 || dev > l.tol[1] + 1e-9);
      return `<tr class="${bad ? 'bad' : ''}"><td>${esc(l.instrument)}</td><td>${esc(l.what)}</td><td>${l.value == null ? '—' : l.value.toFixed(l.dec)} mm</td><td>${l.nominal != null ? fmtN(l.nominal, l.dec) : '—'}${dev != null ? ` (${dev >= 0 ? '+' : ''}${dev.toFixed(l.dec)})` : ''}</td></tr>`;
    }).join('');
    const best = g.s.jobs[part.id]?.best;
    const banner = rec.complete
      ? `<div class="g-complete">${ICON.check}<div><b>Job complete${rec.time != null ? ` in ${fmtClock(rec.time)}` : ''}</b><span>${rec.isBest ? (rec.prevBest ? `New best (was ${rec.prevBest.grade} ${rec.prevBest.score}).` : 'First completion of this job.') : `Best so far: ${best?.grade} ${best?.score}.`} Check it yourself with the instruments, or pick the next job.</span></div></div>`
      : `<div class="g-complete fail"><div><b>Not accepted</b><span>Turn a new part: fetch another bar, or keep cutting the one in the chuck.</span></div></div>`;
    const m = this.modal({
      kind: 'report', cls: 'g-wide g-report', title: `Inspection report · ${esc(part.id)} ${esc(part.title)}`, sub: `${esc(part.drawingNo)} rev ${esc(part.rev)}`,
      body: `${banner}
        <div class="g-rep-top" style="grid-template-columns:auto minmax(0,1fr)">
          <div class="g-grade g-${grade}"><b>${grade}</b><span>${Math.round(r.score)}/100</span></div>
          <div class="g-rep-sum">
            <div><span>Characteristics in tolerance</span><b>${r.items.filter((i) => i.pass).length} / ${r.items.length}</b></div>
            <div><span>Part length</span><b>${fmtN(r.summary.length, 2)} mm</b></div>
            <div><span>Material</span><b>${esc(MATERIALS[rec.piece.material]?.short || '—')}</b></div>
            <div><span>Mass</span><b>${rec.piece.massG ?? '—'} g</b></div>
          </div>
        </div>
        ${r.notes.length ? `<ul class="g-notes">${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
        <div class="g-table-wrap"><table class="g-table"><thead><tr><th>Characteristic</th><th>Nominal</th><th>Tol.</th><th>Measured</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table></div>
        <h4 class="g-h4">Your measurements</h4>
        ${logRows ? `<div class="g-table-wrap"><table class="g-table"><thead><tr><th>Instrument</th><th>What</th><th>Reading</th><th>Nominal (dev.)</th></tr></thead><tbody>${logRows}</tbody></table></div>` : '<p class="g-hint">None yet. Measure the part with the calipers, the micrometer, the depth rod and the pitch gauge.</p>'}`,
      foot: '<button class="btn" data-rp="jobs">Job board</button><button class="btn primary" data-rp="measure">Measure the part</button>',
    });
    m.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-rp]');
      if (!b) return;
      if (b.dataset.rp === 'jobs') this.openJobs();
      else this.openMeasure();
    });
  }

  // ------------------------------------------------------------------ measuring at the inspection bench
  openMeasure() {
    const g = this.game;
    if (!g.plate) return this.toast('Put a part on the surface plate first.', 'info');
    this.closeAll();
    const { piece, part } = g.plate;
    const fr = pieceFrame(piece.profile);
    const TOOLS = [
      { id: 'calOD', kind: 'od', name: 'Digital caliper', sub: 'outside jaws · 0.01', res: 0.01 },
      { id: 'calID', kind: 'id', name: 'Digital caliper', sub: 'inside jaws (bores) · 0.01', res: 0.01 },
      { id: 'calDepth', kind: 'step', name: 'Digital caliper', sub: 'depth rod: face to shoulder · 0.01', res: 0.01 },
      { id: 'calLen', kind: 'length', name: 'Digital caliper', sub: 'overall length · 0.01', res: 0.01 },
      { id: 'mic', kind: 'od', name: 'Outside micrometer', sub: '0–25 / 25–50 mm · 0.001', res: 0.001 },
      { id: 'pitch', kind: 'pitch', name: 'Thread pitch gauge', sub: 'metric leaves 0.5–3.0', res: 0.01 },
    ];
    let sel = TOOLS[0], hoverU = null, last = null, ro = null;
    g.measuring = true;
    g.syncHandVisible();
    this.syncHud();
    const m = this.modal({
      kind: 'measure', cls: 'g-full', title: `Measuring · ${esc(part.id)} ${esc(part.title)}`, sub: 'Pick an instrument, then click on the part where you want to measure it',
      body: `<div class="lt-meas">
        <div class="lt-meas-tools">${TOOLS.map((t) => `<button data-mt="${t.id}"><b>${t.name}</b><span>${t.sub}</span></button>`).join('')}</div>
        <div class="lt-meas-view"><canvas></canvas><div class="lt-meas-hint">Face (datum A) on the right</div></div>
        <div class="lt-meas-side"><canvas class="lt-meas-read"></canvas><div class="lt-meas-what">Click on the part to take a reading.</div>
          <div class="g-table-wrap"><table class="g-table"><thead><tr><th>Instrument</th><th>Reading</th><th>Nominal</th></tr></thead><tbody></tbody></table></div></div>
      </div>`,
      foot: '<button class="btn" data-ms="report">Inspection report</button><button class="btn primary" data-ms="close">Done</button>',
      onClose: () => { ro?.disconnect(); this.measureApi = null; g.measuring = false; this.syncHud(); g.syncHandVisible(); },
    });
    const view = $('.lt-meas-view', m.el), cv = $('canvas', view), rd = $('.lt-meas-read', m.el), what = $('.lt-meas-what', m.el), tbody = $('tbody', m.el);
    const dpr = devicePixelRatio || 1;
    let geo = null;
    const layout = () => {
      const W = view.clientWidth, H = view.clientHeight;
      cv.width = W * dpr; cv.height = H * dpr;
      const L = fr.length, D = piece.profile.rBound * 2;
      const s = Math.min((W - 120) / L, (H - 140) / D);
      geo = { W, H, s, xR: W / 2 + (L * s) / 2, cy: H / 2 + 20 };
    };
    const X = (u) => geo.xR - u * geo.s;
    const draw = () => {
      if (!geo) layout();
      const k = cv.getContext('2d');
      k.setTransform(dpr, 0, 0, dpr, 0, 0);
      const { W, H, s, cy } = geo;
      k.fillStyle = '#eef0ea'; k.fillRect(0, 0, W, H);
      // grid
      k.strokeStyle = 'rgba(0,0,0,.05)'; k.lineWidth = 1;
      for (let x = 0; x < W; x += 20) { k.beginPath(); k.moveTo(x, 0); k.lineTo(x, H); k.stroke(); }
      for (let y = 0; y < H; y += 20) { k.beginPath(); k.moveTo(0, y); k.lineTo(W, y); k.stroke(); }
      // part silhouette (metal) with bore
      const M = MATERIALS[piece.material];
      const grd = k.createLinearGradient(0, cy - piece.profile.rBound * s, 0, cy + piece.profile.rBound * s);
      grd.addColorStop(0, hex(M.raw)); grd.addColorStop(0.3, hex(M.cut)); grd.addColorStop(0.5, '#ffffff'); grd.addColorStop(0.7, hex(M.cut)); grd.addColorStop(1, hex(M.raw));
      k.fillStyle = grd;
      const step = Math.max(0.02, 0.5 / s);
      k.beginPath();
      k.moveTo(X(0), cy);
      for (let u = 0; u <= fr.length; u += step) k.lineTo(X(u), cy - fr.rOut(u) * s);
      k.lineTo(X(fr.length), cy);
      for (let u = fr.length; u >= 0; u -= step) k.lineTo(X(u), cy + fr.rOut(u) * s);
      k.closePath(); k.fill();
      k.strokeStyle = '#2a3036'; k.lineWidth = 1.2; k.stroke();
      // bore (section look)
      k.fillStyle = 'rgba(40,46,54,.85)';
      for (let u = 0; u <= fr.length; u += step) { const ri = fr.rIn(u); if (ri > 0.05) k.fillRect(X(u) - step * s, cy - ri * s, step * s + 0.6, 2 * ri * s); }
      // centre line
      k.setLineDash([14, 3, 2, 3]); k.strokeStyle = '#5d6772'; k.lineWidth = 1;
      k.beginPath(); k.moveTo(X(0) + 20, cy); k.lineTo(X(fr.length) - 20, cy); k.stroke(); k.setLineDash([]);
      k.fillStyle = '#33404d'; k.font = '600 12px system-ui, sans-serif'; k.textAlign = 'center';
      k.fillText('A', X(0) + 14, cy - piece.profile.rBound * s - 8);
      // instrument preview at the cursor
      const u = hoverU;
      if (u != null) {
        k.strokeStyle = '#d0412f'; k.fillStyle = 'rgba(208,65,47,.12)'; k.lineWidth = 2;
        const x = X(u);
        if (sel.kind === 'od') {
          const r = fr.rOut(u) * s;
          const jaw = sel.id === 'mic' ? 10 : 6;
          k.fillStyle = sel.id === 'mic' ? 'rgba(80,90,100,.7)' : 'rgba(160,170,180,.75)';
          k.fillRect(x - jaw / 2, cy - r - 60, jaw, 60); k.fillRect(x - jaw / 2, cy + r, jaw, 60);
          k.beginPath(); k.moveTo(x, cy - r - 70); k.lineTo(x, cy + r + 70); k.stroke();
        } else if (sel.kind === 'id') {
          const r = fr.rIn(u) * s;
          k.beginPath(); k.moveTo(x, cy - Math.max(r, 2)); k.lineTo(x, cy + Math.max(r, 2)); k.stroke();
        } else if (sel.kind === 'step' || sel.kind === 'length') {
          const rr = piece.profile.rBound * s;
          const r = sel.kind === 'length' ? fr.length : readInstrument(fr, 'step', u)?.value ?? 0;
          k.beginPath(); k.moveTo(X(0), cy - rr - 30); k.lineTo(X(0), cy + rr + 30); k.moveTo(X(r), cy - rr - 30); k.lineTo(X(r), cy + rr + 30);
          k.moveTo(X(0), cy + rr + 22); k.lineTo(X(r), cy + rr + 22); k.stroke();
        } else if (sel.kind === 'pitch') {
          const r = fr.rOut(u) * s;
          k.beginPath(); for (let i = -6; i <= 6; i++) { const xx = x + i * 6; k.lineTo(xx, cy - r - (i % 2 ? 0 : 6)); } k.stroke();
        }
      }
    };
    const readout = (rec) => {
      const k = rd.getContext('2d');
      const W = (rd.width = rd.clientWidth * dpr), H = (rd.height = rd.clientHeight * dpr);
      k.fillStyle = '#121518'; k.fillRect(0, 0, W, H);
      if (!rec) return;
      if (rec.tool.id === 'mic' && rec.value != null) {
        drawMicrometerScale(k, W, H, rec.value, { min: rec.value >= 25 ? 25 : 0, title: rec.value >= 25 ? '25–50 mm' : '0–25 mm' });
      } else {
        drawLCD(k, W * 0.06, H * 0.2, W * 0.88, H * 0.6, rec.value == null ? '-----' : rec.value.toFixed(rec.tool.res < 0.01 ? 3 : 2), { unit: 'mm', err: rec.value == null });
      }
    };
    const nominalFor = (kind, u, v) => {
      if (kind === 'length') return { n: part.length, tol: [-0.1, 0.1] };
      if (kind === 'od') {
        const sg = part.segs.find((sg) => u >= sg.u0 && u <= sg.u1);
        if (!sg) return null;
        if (part.thread && sg === part.segs[0]) return { n: sg.d, tol: sg.tol };
        return { n: sg.d, tol: sg.tol || [-0.1, 0.1] };
      }
      if (kind === 'id' && part.bore) return { n: part.bore.d, tol: part.bore.tol };
      if (kind === 'step') {
        const sh = part.segs.slice(0, -1).map((sg) => sg.u1);
        if (!sh.length || v == null) return null;
        const best = sh.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
        return { n: best, tol: [-0.1, 0.1] };
      }
      if (kind === 'pitch' && part.thread) return { n: part.thread.pitch, tol: [-0.01, 0.01] };
      return null;
    };
    const renderLog = () => {
      tbody.innerHTML = g.mlog.slice().reverse().map((l) => {
        const dev = l.nominal != null && l.value != null ? l.value - l.nominal : null;
        const bad = dev != null && l.tol && (dev < l.tol[0] - 1e-9 || dev > l.tol[1] + 1e-9);
        return `<tr class="${bad ? 'bad' : ''}"><td>${esc(l.instrument)}<br><small>${esc(l.what)}</small></td><td>${l.value == null ? '—' : l.value.toFixed(l.dec)}</td><td>${l.nominal != null ? `${fmtN(l.nominal, 2)}${dev != null ? ` (${dev >= 0 ? '+' : ''}${dev.toFixed(l.dec)})` : ''}` : '—'}</td></tr>`;
      }).join('') || '<tr><td colspan="3">No readings yet</td></tr>';
    };
    const measure = (u) => {
      let r = readInstrument(fr, sel.kind, u, { res: sel.res });
      if (sel.id === 'mic' && r?.value > 50) r = { value: null, what: 'Too big for the 0–50 mm micrometers' };
      if (!r) { what.textContent = sel.kind === 'id' ? 'No bore there: the inside jaws find nothing.' : 'Missed the part.'; readout({ tool: sel, value: null }); return; }
      // a hand-held reading wanders by a digit now and then
      const v = r.value == null ? null : Math.round((r.value + (sel.res >= 0.01 && Math.random() < 0.3 ? (Math.random() < 0.5 ? -1 : 1) * sel.res : 0)) / sel.res) * sel.res;
      const nom = nominalFor(sel.kind, u, v);
      const dec = sel.res < 0.01 ? 3 : 2;
      last = { tool: sel, value: v };
      readout(last);
      what.innerHTML = `<b>${esc(r.what)}</b>${nom ? `<br>Drawing: ${nom.n} ${tolText(nom.tol, 3)}` : ''}`;
      if (v != null) {
        g.mlog.push({ instrument: `${sel.name}${sel.id.startsWith('cal') ? ' (' + sel.sub.split(' ·')[0] + ')' : ''}`, kind: sel.kind, tool: sel.id, what: r.what, value: v, nominal: nom?.n ?? null, tol: nom?.tol ?? null, dec });
        renderLog();
        this.app.sound.click?.();
        g.tut.poke();
      }
    };
    const toU = (e) => {
      const rc = cv.getBoundingClientRect();
      const u = (geo.xR - (e.clientX - rc.left)) / geo.s;
      return u < -2 || u > fr.length + 2 ? null : Math.max(0, Math.min(fr.length, u));
    };
    cv.addEventListener('pointermove', (e) => { hoverU = toU(e); draw(); });
    cv.addEventListener('pointerleave', () => { hoverU = null; draw(); });
    cv.addEventListener('click', (e) => { const u = toU(e); if (u != null) measure(u); });
    const pick = (id) => {
      sel = TOOLS.find((t) => t.id === id) || TOOLS[0];
      $$('[data-mt]', m.el).forEach((b) => b.classList.toggle('on', b.dataset.mt === sel.id));
      if (sel.kind === 'length') measure(0);
      draw();
    };
    m.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-mt],[data-ms]');
      if (!b) return;
      if (b.dataset.mt) pick(b.dataset.mt);
      else if (b.dataset.ms === 'close') m.close();
      else if (b.dataset.ms === 'report' && g.report) { m.close(); this.openReport(g.report); }
    });
    ro = new ResizeObserver(() => { layout(); draw(); readout(last); });
    ro.observe(view);
    pick('calOD');
    renderLog();
    this.measureApi = { pick, measure, get sel() { return sel; } };
  }
}
