// Workshop game UI: HUD (objectives, carry chip, toasts, help), the operator-view chrome (pinned
// drawing panel, step-back bar) and the game overlays (job board, drawing viewer, stock rack,
// tool crib, inspection report). Styling lives in styles.css (classes prefixed g-).
import { MATERIALS } from '../config.js';
import { PARTS } from './parts.js';
import { drawingSVG, drawingThumbSVG } from './drawing.js';
import { DrawView } from './drawview.js';
import { BLANKS, blankLabel, fmtClock } from './game.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const stars = (n) => `<span class="g-stars" aria-label="difficulty ${n} of 5">${'★'.repeat(n)}<i>${'★'.repeat(5 - n)}</i></span>`;
const matShort = (m) => MATERIALS[m]?.short || m;
const swatch = (m) => {
  const M = MATERIALS[m] || MATERIALS.aluminium;
  const hex = (v) => '#' + v.toString(16).padStart(6, '0');
  return `background:linear-gradient(135deg, ${hex(M.cut)}, ${hex(M.raw)})`;
};
const fmtN = (v, d = 3) => (v == null || !isFinite(v) ? '—' : (+v).toFixed(d));
const isTyping = (t) => !!t && (t.isContentEditable || /^(TEXTAREA|SELECT)$/.test(t.tagName) || (t.tagName === 'INPUT' && !/^(button|submit|checkbox|radio|range)$/i.test(t.type)));

const svgCache = new Map();
function sheetSVG(part) {
  let s = svgCache.get(part.id);
  if (!s) {
    s = drawingSVG(part, { width: '100%', height: '100%' });
    svgCache.set(part.id, s);
  }
  return s;
}
const thumbCache = new Map();
function thumbSVG(part) {
  let s = thumbCache.get(part.id);
  if (!s) {
    s = drawingThumbSVG(part).replace(/width="\d+" height="\d+"/, 'width="100%" height="100%"');
    thumbCache.set(part.id, s);
  }
  return s;
}

const ICON = {
  drawing: '<svg viewBox="0 0 24 24"><path d="M5 3.5h10l4 4V20.5H5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 11h8M8 14.5h8M8 18h5" stroke="currentColor" stroke-width="1.6"/></svg>',
  jobs: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M7 8.5h4v4H7zM13 8.5h4M13 11h4M7 15.5h10" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>',
  help: '<svg><use href="#i-help"/></svg>',
  blank: '<svg viewBox="0 0 24 24"><path d="m4 8 8-4 8 4v8l-8 4-8-4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="m4 8 8 4 8-4M12 12v8" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  part: '<svg viewBox="0 0 24 24"><path d="m4 8 8-4 8 4v8l-8 4-8-4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="9.5" r="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M10 6 4 12l6 6M4.5 12H20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

export class GameUI {
  constructor(game) {
    this.game = game;
    this.app = game.app;
    this.modals = [];
    this._objKey = '';
    this.objCollapsed = innerWidth <= 560;
    let lay = {};
    try { lay = JSON.parse(localStorage.getItem('milllab.layout') || '{}'); } catch { /* ignore */ }
    this.dp = { w: lay.dpW || null, open: lay.dpOpen ?? (innerWidth > 900) };
  }

  // ------------------------------------------------------------------ build
  build() {
    const game = this.game;
    // mode switch in the top bar
    $$('#modeSeg [data-gmode]').forEach((b) => b.addEventListener('click', () => game.setMode(b.dataset.gmode)));
    $('#jobChip').addEventListener('click', () => (game.job ? this.openDrawing(game.job) : this.openJobs()));

    const vp = $('#viewport');
    const hud = document.createElement('div');
    hud.className = 'g-hud';
    hud.innerHTML = `
      <section class="g-obj" id="gObj" aria-live="polite"></section>
      <div class="g-hudbtns">
        <button class="g-hb" data-g="drawing" title="Current drawing (Q)">${ICON.drawing}<span>Drawing</span><kbd>Q</kbd></button>
        <button class="g-hb" data-g="jobs" title="Job list (J)">${ICON.jobs}<span>Jobs</span><kbd>J</kbd></button>
        <button class="g-hb" data-g="help" title="Controls (H)">${ICON.help}<span>Help</span><kbd>H</kbd></button>
      </div>
      <div class="g-carry" id="gCarry" hidden></div>
      <div class="g-help" id="gHelp" hidden>
        <div class="g-help-h"><b>Welcome to the shop</b><button class="btn ghost icon" data-g="helpClose" aria-label="Close">✕</button></div>
        <p>Pick a job at the <b>job board</b>, take the right <b>blank</b> from the rack, clamp it in the <b>vise</b>, program and run it at the <b>control panel</b>, then check it at the <b>inspection bench</b>.</p>
        <table>
          <tr><td><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></td><td>Walk · <kbd>Shift</kbd> run · <kbd>C</kbd> crouch</td></tr>
          <tr><td>Mouse</td><td>Look around (click the view first)</td></tr>
          <tr><td><kbd>E</kbd> / click</td><td>Use what the crosshair points at</td></tr>
          <tr><td><kbd>Q</kbd></td><td>Current drawing · <kbd>J</kbd> job list</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>Release the mouse / close / step back</td></tr>
        </table>
        <p class="g-touch-only">On a touch screen: left thumb walks, right thumb looks, tap the prompt to use things.</p>
        <button class="btn primary" data-g="helpClose">Got it</button>
      </div>
      <div class="g-toasts" id="gToasts"></div>`;
    vp.appendChild(hud);
    this.hud = hud;
    hud.addEventListener('click', (e) => {
      const b = e.target.closest('[data-g]');
      if (!b) return;
      const k = b.dataset.g;
      if (k === 'drawing') this.toggleDrawing();
      else if (k === 'jobs') this.openJobs();
      else if (k === 'help') this.showHelp(!!$('#gHelp').hidden);
      else if (k === 'helpClose') this.showHelp(false);
      else if (k === 'obj') { this.objCollapsed = !this.objCollapsed; this._objKey = ''; this.renderObjectives(game.objectives()); }
    });

    // operator view chrome
    const dp = document.createElement('aside');
    dp.className = 'g-dpanel';
    dp.id = 'gDpanel';
    dp.innerHTML = `
      <div class="g-dp-h"><b id="gDpTitle">Drawing</b>
        <div class="g-dp-tools"><button class="btn ghost icon" data-dp="out" title="Zoom out">−</button><button class="btn ghost icon" data-dp="in" title="Zoom in">+</button><button class="btn ghost" data-dp="fit" title="Fit the sheet">Fit</button><button class="btn ghost" data-dp="big" title="Open the drawing viewer">Open</button><button class="btn ghost icon" data-dp="hide" title="Hide the drawing (Q)">⟨</button></div></div>
      <div class="g-dp-body"></div>
      <div class="g-dp-f" id="gDpNote"></div>
      <div class="g-dp-grip" title="Drag to resize"></div>
      <button class="g-dp-tab" data-dp="show" title="Show the drawing (Q)">${ICON.drawing}<span>DRAWING</span></button>`;
    document.body.appendChild(dp);
    this.dpEl = dp;
    this.dpView = new DrawView($('.g-dp-body', dp));
    dp.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dp]');
      if (!b) return;
      const k = b.dataset.dp;
      if (k === 'in') this.dpView.zoomAt(1.5);
      else if (k === 'out') this.dpView.zoomAt(1 / 1.5);
      else if (k === 'fit') this.dpView.fit();
      else if (k === 'big') { if (game.job) this.openDrawing(game.job); else this.openJobs(); }
      else if (k === 'hide') this.setDpanelOpen(false);
      else if (k === 'show') this.setDpanelOpen(true);
    });
    this.bindDpGrip($('.g-dp-grip', dp));
    if (this.dp.w) dp.style.setProperty('--dp-w', this.dp.w + 'px');
    dp.classList.toggle('closed', !this.dp.open);

    const bar = document.createElement('div');
    bar.className = 'g-opbar';
    bar.id = 'gOpbar';
    bar.innerHTML = `
      <span class="g-op-lbl" id="gOpLbl">Control panel</span>
      <button class="btn" data-op="door" id="gOpDoor" title="Open / close the doors">Doors</button>
      <button class="btn" data-op="drawing" title="Show / hide the drawing (Q)">${ICON.drawing}<span>Drawing</span></button>
      <button class="btn g-op-peek" data-op="peek" title="Show the machine">3D</button>
      <button class="btn primary" data-op="back" title="Step back (Esc)">${ICON.back}<span>Step back</span><kbd>Esc</kbd></button>`;
    document.body.appendChild(bar);
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-op]');
      if (!b) return;
      const k = b.dataset.op;
      if (k === 'back') game.exitOp();
      else if (k === 'door') this.app.ui.act('door');
      else if (k === 'drawing') this.setDpanelOpen(this.dpEl.classList.contains('closed'));
      else if (k === 'peek') { document.body.classList.toggle('op-peek'); this.layoutOp(); }
    });

    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('resize', () => { if (game.op) this.layoutOp(); });
    const mcp = $('#mcp');
    if (window.ResizeObserver) new ResizeObserver(() => { if (game.op) this.layoutOp(); }).observe(mcp);
  }

  syncMode() {
    const ws = this.game.mode === 'workshop';
    $$('#modeSeg [data-gmode]').forEach((b) => {
      const on = b.dataset.gmode === this.game.mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on);
    });
    this.hud.hidden = !ws;
    if (!ws) this.closeAll();
    this.syncHud();
    this._objKey = '';
    this.renderObjectives(this.game.objectives());
  }

  syncHud() {
    const g = this.game;
    const walking = g.mode === 'workshop' && !g.op && !g.measuring;
    this.hud.classList.toggle('g-walk', walking);
    this.hud.classList.toggle('g-op', !!g.op);
    this.hud.classList.toggle('g-meas', !!g.measuring);
    $('#gOpLbl').textContent = g.op === 'pc' ? 'CAM computer · offline programming' : 'Control panel · VMC-560';
    const j = g.job;
    const chip = $('#jobChip');
    chip.hidden = g.mode !== 'workshop';
    chip.innerHTML = j ? `<span class="lbl">JOB</span><b>${esc(j.id)}</b><span class="jt">${esc(j.title)}</span>` : '<span class="lbl">JOB</span><span class="jt">Pick a job</span>';
  }

  // ------------------------------------------------------------------ keyboard
  onKey(e) {
    const g = this.game;
    if (g.mode !== 'workshop') return;
    const typing = isTyping(e.target);
    if (e.key === 'Escape') {
      if (g.measuring) return; // the measuring station handles its own Esc
      if (this.topModal()) { e.preventDefault(); this.closeTop(); return; }
      if (g.op) {
        e.preventDefault();
        if (typing) e.target.blur();
        else g.exitOp();
        return;
      }
      if (!$('#gHelp').hidden) this.showHelp(false);
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey || g.measuring) return;
    const top = this.topModal();
    if (e.code === 'KeyQ' || (e.code === 'Tab' && !g.op && !top)) {
      e.preventDefault();
      if (top?.kind === 'drawing') return this.closeTop();
      if (top) return;
      if (g.op) this.setDpanelOpen(this.dpEl.classList.contains('closed'));
      else this.toggleDrawing();
    } else if (e.code === 'KeyJ' && !g.op) {
      e.preventDefault();
      if (top?.kind === 'jobs') this.closeTop();
      else if (!top) this.openJobs();
    } else if (e.code === 'KeyH' && !top) {
      this.showHelp(!!$('#gHelp').hidden);
    }
  }

  // ------------------------------------------------------------------ HUD
  toast(msg, kind = 'info', ms = 3600) {
    const box = $('#gToasts');
    if (!box) return;
    const t = document.createElement('div');
    t.className = `g-toast ${kind}`;
    t.textContent = msg;
    box.appendChild(t);
    while (box.children.length > 3) box.firstChild.remove();
    requestAnimationFrame(() => t.classList.add('in'));
    setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, ms);
  }

  showHelp(on) {
    const h = $('#gHelp');
    h.hidden = !on || this.game.mode !== 'workshop';
    if (!on && !this.game.s.helpSeen) {
      this.game.s.helpSeen = true;
      this.game.save();
    }
  }

  setCarry(c) {
    const el = $('#gCarry');
    if (!el) return;
    el.hidden = !c;
    if (c) el.innerHTML = `${ICON[c.icon] || ''}<span class="lbl">Carrying</span><span>${esc(c.text)}</span>`;
  }

  renderObjectives(m) {
    const el = $('#gObj');
    if (!el || this.game.mode !== 'workshop') return;
    const key = JSON.stringify([m.job?.id, m.steps.map((s) => s.done), Math.floor(m.time || 0), m.done, this.objCollapsed, m.best?.grade]);
    if (key === this._objKey) return;
    this._objKey = key;
    const j = m.job;
    const n = m.steps.filter((s) => s.done).length;
    el.classList.toggle('collapsed', !!this.objCollapsed);
    el.innerHTML = `
      <button class="g-obj-h" data-g="obj" title="Show / hide the checklist">
        <span class="lbl">${j ? 'Current job' : 'No job yet'}</span>
        ${j ? `<b>${esc(j.id)} · ${esc(j.title)}</b>` : '<b>Visit the job board</b>'}
        ${j ? `<span class="g-obj-meta">${n}/${m.steps.length} · ${fmtClock(m.time)}${m.best ? ` · best <i class="g-grade-s g-${m.best.grade}">${m.best.grade}</i>` : ''}</span>` : ''}
      </button>
      <ol class="g-steps">${m.steps.map((s) => `<li class="${s.done ? 'done' : s === m.next ? 'next' : ''}"><i>${s.done ? ICON.check : ''}</i><span>${esc(s.label)}${s === m.next && s.hint ? `<small>${esc(s.hint)}</small>` : ''}</span></li>`).join('')}</ol>
      ${m.done ? '<div class="g-obj-done">Job complete. Pick the next one at the job board.</div>' : ''}`;
    this.syncHud();
  }

  // ------------------------------------------------------------------ operator view layout
  setDpanelOpen(open) {
    this.dpEl.classList.toggle('closed', !open);
    this.dp.open = open;
    this.saveLayout();
    if (open && !this.dpView.svg && this.game.job) this.dpanelSetPart(this.game.job);
    this.layoutOp();
  }

  dpanelSetPart(part) {
    if (!part) return;
    if (this.dpPart === part.id && this.dpView.svg) return;
    this.dpPart = part.id;
    $('#gDpTitle').textContent = `${part.id} · ${part.drawingNo} · ${part.title}`;
    $('#gDpNote').innerHTML = `<b>Setup</b> ${esc(part.setupNote?.split('.')[0] || 'G54 on the top front-left corner of the raw blank')}. Blank ${blankLabel({ ...part.stock, material: part.material })}.`;
    this.dpView.setSVG(sheetSVG(part));
  }

  bindDpGrip(grip) {
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const w = Math.max(240, Math.min(innerWidth * 0.6, ev.clientX - 8));
        this.dpEl.style.setProperty('--dp-w', w + 'px');
        this.dp.w = Math.round(w);
        this.layoutOp();
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        this.saveLayout();
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
    });
  }

  saveLayout() {
    try {
      const lay = JSON.parse(localStorage.getItem('milllab.layout') || '{}');
      lay.dpW = this.dp.w;
      lay.dpOpen = this.dp.open;
      localStorage.setItem('milllab.layout', JSON.stringify(lay));
    } catch { /* ignore */ }
  }

  // Docked panels leave a free part of the 3D view; centre the camera's projection in it.
  layoutOp() {
    const g = this.game, v = this.app.viewer, body = document.body;
    if (!g.op) return;
    const phone = innerWidth <= 900;
    const mcp = $('#mcp');
    const mcpH = g.op === 'pc' ? 0 : mcp.offsetHeight;
    body.style.setProperty('--op-b', mcpH + 'px');
    const vr = v.canvas.getBoundingClientRect();
    const dpOpen = !this.dpEl.classList.contains('closed');
    const peek = body.classList.contains('op-peek');
    const left = !phone && dpOpen && !peek ? this.dpEl.getBoundingClientRect().right : 0;
    const cu = $('#cu').getBoundingClientRect();
    const right = !phone && !peek && cu.width ? cu.left : innerWidth;
    body.style.setProperty('--op-l', Math.round(left) + 'px');
    body.style.setProperty('--op-r', Math.round(innerWidth - right) + 'px');
    if (phone && !peek) { v.setCenter(null); return; }
    const top = vr.top, bottom = innerHeight - mcpH;
    const c = { x: (left + right) / 2 - vr.left, y: (Math.max(top, 50) + bottom) / 2 - vr.top };
    const cur = v.center;
    if (!cur || Math.abs(cur.x - c.x) > 0.5 || Math.abs(cur.y - c.y) > 0.5) v.setCenter(c);
  }

  // ------------------------------------------------------------------ modals
  topModal() {
    return this.modals[this.modals.length - 1] || null;
  }

  closeTop() {
    this.topModal()?.close();
  }

  closeAll() {
    while (this.modals.length) this.modals[this.modals.length - 1].close();
  }

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
        if (!this.modals.length && g.mode === 'workshop' && !g.op && !g.measuring) g.fp.frozen = false;
      },
    };
    $('.g-x', wrap).addEventListener('click', h.close);
    wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) h.close(); });
    this.modals.push(h);
    g.fp.frozen = true;
    return h;
  }

  toggleDrawing() {
    const g = this.game;
    if (this.topModal()?.kind === 'drawing') return this.closeTop();
    if (g.job) this.openDrawing(g.job);
    else this.openJobs();
  }

  openJobs() {
    const g = this.game;
    this.closeAll();
    const cards = PARTS.map((p) => {
      const best = g.s.jobs[p.id]?.best;
      const cur = g.s.jobId === p.id;
      return `<button class="g-job${cur ? ' cur' : ''}" data-job="${p.id}">
        <div class="g-job-thumb">${thumbSVG(p)}</div>
        <div class="g-job-b">
          <div class="g-job-t"><b>${esc(p.id)}</b><span>${esc(p.title)}</span>${cur ? '<em>Current</em>' : ''}${best ? `<i class="g-grade-s g-${best.grade}" title="Best grade">${best.grade}</i>` : ''}</div>
          <div class="g-job-m">${stars(p.difficulty)}<span><i class="g-sw" style="${swatch(p.material)}"></i>${esc(matShort(p.material))}</span><span>Blank ${p.stock.x}×${p.stock.y}×${p.stock.z}</span></div>
          <p>${esc(p.brief)}</p>
          <div class="g-job-c">${esc(p.customer)} · ${esc(p.drawingNo)} rev ${esc(p.rev)}${best ? ` · best ${best.score}/100${best.time != null ? ' in ' + fmtClock(best.time) : ''}` : ''}</div>
        </div></button>`;
    }).join('');
    const done = PARTS.filter((p) => g.s.jobs[p.id]?.best && g.s.jobs[p.id].best.grade !== 'FAIL').length;
    const m = this.modal({ kind: 'jobs', cls: 'g-wide', title: 'Job board', sub: `${done} of ${PARTS.length} jobs completed · choose a drawing`, body: `<div class="g-jobs">${cards}</div>` });
    $$('[data-job]', m.el).forEach((b) => b.addEventListener('click', () => this.openDrawing(PARTS.find((p) => p.id === b.dataset.job))));
  }

  openDrawing(part) {
    const g = this.game;
    if (!part) return;
    this.closeAll();
    g.markRead(part.id);
    const cur = g.s.jobId === part.id;
    const best = g.s.jobs[part.id]?.best;
    const feats = part.features.length;
    const side = `
      <div class="g-dw-info">
        <div class="g-dw-title"><b>${esc(part.id)} · ${esc(part.title)}</b><span>${esc(part.drawingNo)} rev ${esc(part.rev)} · ${esc(part.customer)}</span></div>
        <p class="g-dw-brief">${esc(part.brief)}</p>
        <dl class="g-kv">
          <dt>Difficulty</dt><dd>${stars(part.difficulty)}</dd>
          <dt>Material</dt><dd><i class="g-sw" style="${swatch(part.material)}"></i>${esc(MATERIALS[part.material]?.name || part.material)}</dd>
          <dt>Blank</dt><dd>${part.stock.x} × ${part.stock.y} × ${part.stock.z} mm</dd>
          <dt>Finished</dt><dd>${part.size.x} × ${part.size.y} × ${part.size.z} mm</dd>
          <dt>Features</dt><dd>${feats} (balloons A–${String.fromCharCode(64 + feats)})</dd>
          <dt>Tolerance</dt><dd>±${part.tol?.general ?? 0.1} mm unless stated</dd>
          ${best ? `<dt>Best</dt><dd><i class="g-grade-s g-${best.grade}">${best.grade}</i> ${best.score}/100${best.time != null ? ' · ' + fmtClock(best.time) : ''}</dd>` : ''}
        </dl>
        <div class="g-setup"><b>Setup</b>${esc(part.setupNote)}</div>
        <div class="g-dw-acts">
          <button class="btn primary" data-dw="accept"${cur ? ' disabled' : ''}>${cur ? 'Current job ✓' : 'Accept job'}</button>
          <button class="btn" data-dw="ref" title="A worked solution program">Load reference program</button>
          <button class="btn ghost" data-dw="jobs">All jobs</button>
        </div>
      </div>`;
    const m = this.modal({
      kind: 'drawing', cls: 'g-full', title: `Drawing ${esc(part.drawingNo)}`, sub: 'Scroll or pinch to zoom · drag to pan · double-click to zoom in',
      body: `<div class="g-dw"><div class="g-dw-sheet"><div class="g-dw-view"></div><div class="g-dw-zoom"><button class="btn icon" data-dw="out" title="Zoom out">−</button><button class="btn icon" data-dw="in" title="Zoom in">+</button><button class="btn" data-dw="fit">Fit</button></div></div>${side}</div>`,
    });
    const view = new DrawView($('.g-dw-view', m.el));
    view.setSVG(sheetSVG(part));
    m.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dw]');
      if (!b) return;
      const k = b.dataset.dw;
      if (k === 'in') view.zoomAt(1.5);
      else if (k === 'out') view.zoomAt(1 / 1.5);
      else if (k === 'fit') view.fit();
      else if (k === 'jobs') this.openJobs();
      else if (k === 'accept') {
        g.acceptJob(part.id);
        b.disabled = true;
        b.textContent = 'Current job ✓';
        this.syncHud();
      } else if (k === 'ref') {
        if (!confirm(`Load the reference program for ${part.id}?\n\nIt is a worked solution (JOB_${part.id}_REF.MPF) that machines this drawing with the default tools. Try writing your own program first: you learn more, and you can compare afterwards.`)) return;
        if (g.s.jobId !== part.id) g.acceptJob(part.id);
        g.loadReference(part.id);
        this.closeAll();
      }
    });
  }

  openRack() {
    const g = this.game;
    this.closeAll();
    const carry = g.s.carry?.kind === 'blank' ? g.s.carry.blank : null;
    const cards = BLANKS.map((b) => {
      const M = MATERIALS[b.material];
      const mass = (b.x * b.y * b.z / 1000) * M.density;
      const held = carry && carry.x === b.x && carry.y === b.y && carry.z === b.z && carry.material === b.material;
      return `<button class="g-blank${held ? ' held' : ''}" data-blank="${b.id}"${held ? ' disabled' : ''}>
        <i class="g-blk" style="${swatch(b.material)}"></i>
        <b>${b.x} × ${b.y} × ${b.z}</b><span>${esc(M.short)} · ${mass.toFixed(0)} g</span>${held ? '<em>in your hands</em>' : ''}</button>`;
    }).join('');
    const job = g.job;
    const m = this.modal({
      kind: 'rack', cls: 'g-wide', title: 'Stock rack', sub: 'Saw-cut blanks (length × width × height, mm)',
      body: `${carry ? `<div class="g-note"><span>You are carrying a ${esc(blankLabel(carry))} blank.</span><button class="btn" data-rk="back">Put it back</button></div>` : ''}
        <p class="g-hint">${job ? `Check the blank size and material in the title block of drawing <b>${esc(job.drawingNo)}</b> (press <kbd>Q</kbd>).` : 'Accept a job first, then pick the blank its drawing calls for.'}</p>
        <div class="g-blanks">${cards}</div>`,
      foot: job ? '<button class="btn" data-rk="drawing">View drawing</button>' : '',
    });
    m.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-blank],[data-rk]');
      if (!b) return;
      if (b.dataset.blank) { m.close(); g.takeBlank(b.dataset.blank); }
      else if (b.dataset.rk === 'back') { m.close(); g.putBackBlank(); }
      else if (b.dataset.rk === 'drawing') this.openDrawing(g.job);
    });
  }

  openTools() {
    const g = this.game, app = this.app;
    this.closeAll();
    const rows = app.tools.map((t) => `<tr><td class="tn">T${t.number}</td><td>${esc(t.name || t.type)}</td><td>${fmtN(t.diameter, 2)}</td><td>${fmtN(t.fluteLength, 1)}</td><td>${fmtN(t.length, 1)}</td><td>${t.flutes}</td><td>${(t.wear || 0).toFixed(0)}%</td></tr>`).join('');
    const m = this.modal({
      kind: 'tools', cls: 'g-wide', title: 'Tool crib', sub: 'Tools loaded in the machine magazine (T = pocket, D1 = cutting edge)',
      body: `<div class="g-table-wrap"><table class="g-table"><thead><tr><th>T</th><th>Tool</th><th>Ø mm</th><th>Flutes mm</th><th>Length mm</th><th>Teeth</th><th>Wear</th></tr></thead><tbody>${rows}</tbody></table></div>
        <p class="g-hint">Program a tool with <code>T2 D1 M6</code> (Siemens mode). Lengths are gauge line to tip, as measured on the tool setter. Edit them at the control under OFFSET › Tool list.</p>`,
      foot: '<button class="btn primary" data-tc="edit">Open the tool list at the control</button>',
    });
    $('[data-tc="edit"]', m.el).addEventListener('click', () => {
      m.close();
      app.ui.hmi.pages.offset = 'tools';
      g.enterOp('pendant', 'offset');
    });
  }

  openReport(rec) {
    const g = this.game;
    this.closeAll();
    const { report: r, part } = rec;
    const grade = r.grade;
    const s = r.summary || {};
    const rows = (r.items || []).map((it) => `<tr class="${it.pass ? '' : 'bad'}"><td>${esc(it.label)}</td><td>${fmtN(it.nominal)}</td><td>${it.missing ? 'missing' : fmtN(it.measured)}</td><td>±${fmtN(it.tol, 2)}</td><td class="st">${it.pass ? 'OK' : 'NOT OK'}</td></tr>`).join('');
    const log = (rec.log || g.ms?.log || []).filter(Boolean);
    const logRows = log.map((l) => `<tr><td>${esc(l.instrument || '')}</td><td>${esc(l.what || '')}</td><td>${typeof l.value === 'number' ? l.value.toFixed(l.unit === 'mm' && Math.abs(l.value) < 1000 ? 3 : 2) : esc(l.value)} ${esc(l.unit || '')}</td><td>${l.nominal != null ? fmtN(l.nominal) : '—'}</td></tr>`).join('');
    const banner = rec.complete
      ? `<div class="g-complete">${ICON.check}<div><b>Job complete${rec.time != null ? ` in ${fmtClock(rec.time)}` : ''}</b><span>${rec.isBest ? (rec.prevBest ? `New best (was ${rec.prevBest.grade} ${rec.prevBest.score}).` : 'First completion of this job.') : `Best so far: ${g.s.jobs[part.id]?.best?.grade} ${g.s.jobs[part.id]?.best?.score}.`} Measure the part with the instruments, or pick the next job.</span></div></div>`
      : `<div class="g-complete fail"><div><b>Not accepted</b><span>Fix the program or the setup and machine a new blank. ${s.wrongBlank ? 'Wrong blank: check the drawing’s blank size.' : s.notMachined ? 'The part was not machined.' : ''}</span></div></div>`;
    const m = this.modal({
      kind: 'report', cls: 'g-wide g-report', title: `Inspection report · ${esc(part.id)} ${esc(part.title)}`, sub: `${esc(part.drawingNo)} rev ${esc(part.rev)}`,
      body: `${banner}
        <div class="g-rep-top">
          <div class="g-grade g-${grade}"><b>${grade}</b><span>${Math.round(r.score)}/100</span></div>
          <div class="g-rep-sum">
            <div><span>Items in tolerance</span><b>${(r.items || []).filter((i) => i.pass).length} / ${(r.items || []).length}</b></div>
            <div><span>Area within tol.</span><b>${s.withinTol != null ? (s.withinTol * 100).toFixed(1) + ' %' : '—'}</b></div>
            <div><span>Max. material left</span><b>${fmtN(s.maxExcess, 3)} mm</b></div>
            <div><span>Max. gouge</span><b>${fmtN(s.maxGouge, 3)} mm</b></div>
          </div>
          <figure class="g-devmap"><canvas></canvas><figcaption><i class="ok"></i>within ±${part.tol?.general ?? 0.1} <i class="hi"></i>material left <i class="lo"></i>too deep</figcaption></figure>
        </div>
        ${(r.notes || []).length ? `<ul class="g-notes">${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
        <div class="g-table-wrap"><table class="g-table"><thead><tr><th>Characteristic</th><th>Nominal</th><th>Measured</th><th>Tol.</th><th>Result</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No measurable features</td></tr>'}</tbody></table></div>
        <h4 class="g-h4">Your measurements</h4>
        ${logRows ? `<div class="g-table-wrap"><table class="g-table"><thead><tr><th>Instrument</th><th>What</th><th>Reading</th><th>Nominal</th></tr></thead><tbody>${logRows}</tbody></table></div>` : '<p class="g-hint">None yet. Use the calipers, micrometer, bore gauge, depth micrometer, height gauge and dial indicator on the bench to check the part yourself.</p>'}`,
      foot: `<button class="btn" data-rp="jobs">Job board</button><button class="btn primary" data-rp="measure"${g.ms ? '' : ' disabled title="Instruments still loading"'}>Measure the part</button>`,
    });
    this.drawDeviation($('.g-devmap canvas', m.el), r, part);
    m.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-rp]');
      if (!b) return;
      if (b.dataset.rp === 'jobs') this.openJobs();
      else if (b.dataset.rp === 'measure') { m.close(); g.openMeasuring(); }
    });
  }

  // deviation map: top view of the part (front at the bottom), green within tolerance, blue material
  // left (too high), red gouges (too deep)
  drawDeviation(cv, r, part) {
    const d = r.deviation;
    if (!cv || !d || !d.data) return;
    const { nx, ny, data } = d;
    cv.width = nx;
    cv.height = ny;
    const g = cv.getContext('2d');
    const img = g.createImageData(nx, ny);
    const px = img.data;
    const tol = part.tol?.general ?? 0.1;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const v = data[j * nx + i];
        const o = ((ny - 1 - j) * nx + i) * 4;
        let R = 58, G = 64, B = 72;
        if (!Number.isNaN(v)) {
          if (Math.abs(v) <= tol) { R = 52; G = 190; B = 112; }
          else if (v > 0) { const k = Math.min(1, (v - tol) / 1.5); R = 70 - 40 * k; G = 140 - 70 * k; B = 230; }
          else { const k = Math.min(1, (-v - tol) / 1.5); R = 235; G = 90 - 60 * k; B = 70 - 40 * k; }
        }
        px[o] = R; px[o + 1] = G; px[o + 2] = B; px[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    cv.style.aspectRatio = `${nx} / ${ny}`;
  }
}
