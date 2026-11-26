// Manual vise: the blank is placed between open jaws and the player cranks the vise handle by hand.
// Hold E (or the left mouse button) while aiming at the handle to tighten, hold R (or the right
// mouse button) to loosen. The moving jaw closes onto the blank, then more turns build clamping
// force: loose -> snug -> tight -> over-tight. Touch: tap the prompt to turn the handle a notch.
const OPEN = 14; // mm the moving jaw stands back from the blank when the vise is open
const CLOSE_RATE = 12; // mm/s of jaw travel
const FORCE_UP = 0.33; // force units per second once the jaw touches
const FORCE_DOWN = 0.55;
export const FORCE_MAX = 1.3;
export const TIGHT_LEVELS = { snug: 0.1, tight: 0.4, over: 1.0 };

export class ViseClamp {
  constructor(game) {
    this.g = game;
    this.gap = OPEN;
    this.force = 0;
    this.dir = 0; // -1 loosen, 0 idle, 1 tighten (from held keys / buttons)
    this.shown = 0; // seconds the gauge stays visible after the last interaction
    this._keys = { tight: false, loose: false, mt: false, ml: false };
    this._last = '';
    this._overWarned = false;
    this._build();
    this._bind();
  }

  // ------------------------------------------------------------ state
  set(gap, force) {
    this.gap = Math.max(0, Math.min(OPEN, gap));
    this.force = Math.max(0, Math.min(FORCE_MAX, force));
  }
  setOpen() { this.set(OPEN, 0); }
  setTight() { this.set(0, 0.6); }
  get state() {
    const f = this.force;
    if (this.gap > 0.01 || f < TIGHT_LEVELS.snug) return 'loose';
    if (f < TIGHT_LEVELS.tight) return 'snug';
    if (f < TIGHT_LEVELS.over) return 'tight';
    return 'over';
  }
  get clamped() { return this.state !== 'loose'; }
  // can the blank be lifted out?
  get free() { return this.force < 0.02 && this.gap >= 3; }
  toJSON() { return { gap: +this.gap.toFixed(2), force: +this.force.toFixed(3) }; }
  fromJSON(o) { if (o && typeof o.gap === 'number' && typeof o.force === 'number') this.set(o.gap, o.force); else this.setTight(); }

  // ------------------------------------------------------------ input
  _bind() {
    const k = this._keys;
    const typing = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    addEventListener('keydown', (e) => {
      if (typing(e.target) || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.code === 'KeyE') k.tight = true;
      else if (e.code === 'KeyR') k.loose = true;
    });
    addEventListener('keyup', (e) => {
      if (e.code === 'KeyE') k.tight = false;
      else if (e.code === 'KeyR') k.loose = false;
    });
    addEventListener('blur', () => { k.tight = k.loose = k.mt = k.ml = false; });
    addEventListener('mousedown', (e) => { if (e.button === 0) k.mt = true; else if (e.button === 2) k.ml = true; });
    addEventListener('mouseup', (e) => { if (e.button === 0) k.mt = false; else if (e.button === 2) k.ml = false; });
    addEventListener('contextmenu', (e) => { if (this.g.fp.hover?.id === 'viseHandle') e.preventDefault(); });
  }

  // one notch for touch screens (tap the prompt); loosens when already over-tight
  step() {
    const dir = this.state === 'over' ? -1 : 1;
    this.advance(0.35, dir);
  }

  // ------------------------------------------------------------ simulation
  advance(dt, dir) {
    if (dir > 0) {
      if (this.gap > 0) {
        this.gap = Math.max(0, this.gap - CLOSE_RATE * dt);
        if (this.gap === 0) this.g.app.sound.clunk();
      } else this.force = Math.min(FORCE_MAX, this.force + FORCE_UP * dt);
    } else if (dir < 0) {
      if (this.force > 0) this.force = Math.max(0, this.force - FORCE_DOWN * dt);
      else this.gap = Math.min(OPEN, this.gap + CLOSE_RATE * dt);
    }
  }

  update(dt) {
    const g = this.g, app = g.app;
    const workshop = g.mode === 'workshop';
    if (!workshop) {
      // the simulator always has its blank clamped
      if (!app.stockEmpty) this.setTight(); else this.setOpen();
    } else if (app.stockEmpty) {
      this.setOpen();
    } else {
      const k = this._keys;
      const hov = g.fp.hover?.id === 'viseHandle' && g.fp.enabled && !g.op;
      let dir = 0;
      if (hov) {
        if (k.tight || (k.mt && g.fp.locked)) dir = 1;
        else if (k.loose || (k.ml && g.fp.locked)) dir = -1;
      }
      if (dir) {
        const c = app.controller;
        if (c.exec || Math.abs(c.spindle.rpm) > 1) {
          if (!this._busyT || performance.now() - this._busyT > 2500) { this._busyT = performance.now(); g.ui.toast('Stop the program and the spindle before touching the vise.', 'warn'); }
          dir = 0;
        }
      }
      if (dir) {
        const before = this.state;
        this.advance(dt, dir);
        this.shown = 2.5;
        this._moving = true;
        this._notify(before);
      } else if (this._moving) {
        this._moving = false;
        g.s.vc = this.toJSON();
        g.save();
      }
      if (hov) this.shown = Math.max(this.shown, 0.4);
    }
    this.shown = Math.max(0, this.shown - dt);
    this._apply();
    this._gauge();
  }

  _notify(before) {
    const st = this.state, g = this.g;
    if (st === 'over' && !this._overWarned) {
      this._overWarned = true;
      g.ui.toast('Over-tight: that is more force than needed. Thin parts can distort; ease it off with R.', 'warn', 4500);
    } else if (st !== 'over' && this.force < 0.9) this._overWarned = false;
    if (st === 'tight' && before === 'snug') { g.app.sound.clunk(); g.ui.toast('Tight: the blank is held firmly.', 'ok', 2500); }
  }

  // ------------------------------------------------------------ visuals
  _apply() {
    const v = this.g.app.vise;
    if (!v || !v.moving) return;
    v.moving.position.z = this.gap; // table -Y (front) = three +Z: positive opens the vise
    v.crank.rotation.z = -((OPEN - this.gap) * 0.9 + this.force * 2.4);
  }

  _build() {
    const st = document.createElement('style');
    st.textContent = `#viseGauge{position:fixed;left:50%;bottom:22%;transform:translateX(-50%);z-index:30;min-width:230px;padding:8px 12px 9px;
      background:rgba(14,18,24,.86);border:1px solid rgba(255,255,255,.18);border-radius:9px;color:#e8edf3;font:600 12px/1.3 system-ui,sans-serif;
      pointer-events:none;opacity:0;transition:opacity .2s}
      #viseGauge.on{opacity:1}#viseGauge .vg-t{display:flex;justify-content:space-between;margin-bottom:6px}
      #viseGauge .vg-bar{position:relative;height:9px;border-radius:5px;background:linear-gradient(90deg,#59616b 0 8%,#e0a93a 8% 30%,#3fbf74 30% 77%,#e5534b 77% 100%);opacity:.55}
      #viseGauge .vg-n{position:absolute;top:-3px;width:3px;height:15px;border-radius:2px;background:#fff;box-shadow:0 0 4px #000;left:0}
      #viseGauge .vg-l{display:flex;justify-content:space-between;margin-top:4px;font-weight:500;font-size:10px;opacity:.7}
      #viseGauge .vg-h{margin-top:5px;font-weight:500;font-size:11px;opacity:.85}`;
    document.head.appendChild(st);
    const el = document.createElement('div');
    el.id = 'viseGauge';
    el.innerHTML = '<div class="vg-t"><span>Vise clamping</span><span class="vg-s"></span></div><div class="vg-bar"><div class="vg-n"></div></div><div class="vg-l"><span>loose</span><span>snug</span><span>tight</span><span>over-tight</span></div><div class="vg-h"></div>';
    document.body.appendChild(el);
    this.el = el;
    this.elS = el.querySelector('.vg-s');
    this.elN = el.querySelector('.vg-n');
    this.elH = el.querySelector('.vg-h');
  }

  _gauge() {
    const on = this.shown > 0 && this.g.mode === 'workshop' && !this.g.app.stockEmpty && !this.g.op;
    this.el.classList.toggle('on', on);
    if (!on) return;
    const st = this.state;
    const sig = st + Math.round(this.force * 100) + Math.round(this.gap);
    if (sig === this._last) return;
    this._last = sig;
    const pos = this.gap > 0 ? 0.06 * (1 - this.gap / OPEN) : 0.08 + 0.92 * Math.min(1, this.force / FORCE_MAX);
    this.elN.style.left = `calc(${(pos * 100).toFixed(1)}% - 1px)`;
    const touch = this.g.fp.touchMode;
    this.elS.textContent = { loose: this.gap > 0.01 ? 'LOOSE (jaw open)' : 'LOOSE', snug: 'SNUG', tight: 'TIGHT', over: 'OVER-TIGHT' }[st];
    this.elS.style.color = { loose: '#aab3bd', snug: '#e0a93a', tight: '#3fbf74', over: '#e5534b' }[st];
    this.elH.textContent = touch ? 'Tap to turn the handle' : 'Hold E / left mouse: tighten · Hold R / right mouse: loosen';
  }
}
