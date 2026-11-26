// Guided tutorial for the manual lathe: job L01 (guide pin) from the job board to the micrometer.
// Each step advances by itself as soon as its check passes (polled a few times per second and on every
// control action), like the mill tutorial. The card lives in the HUD (#ltTut) and stays visible at the
// operator position.
import { getLatheJob, barFits, pieceFrame } from './lathe-jobs.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// OD of the bar in the chuck at u mm from its free end (null when there is no material)
function odAt(sim, u) {
  const fr = pieceFrame(sim.profile);
  if (!fr) return null;
  const r = fr.rOut(u);
  return r > 0 ? 2 * r : null;
}

export const LATHE_TUTORIAL = [
  {
    id: 'job', title: 'Pick the job',
    text: 'Walk to the <b>job board</b> on the left wall (<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>, mouse to look) and press <kbd>E</kbd> on it, or press <kbd>J</kbd>. Open <b>L01 Guide pin</b> and press <b>Accept job</b>.',
    hint: 'The drawing shows a Ø24 spigot 22 long, a Ø28 shoulder, 40 long overall, a 1×45° chamfer.',
    check: (g) => g.s.jobId === 'L01',
  },
  {
    id: 'bar', title: 'Fetch the bar',
    text: 'Go to the <b>stock rack</b> on the right-hand wall and take a <b>Ø30 × 100 aluminium</b> bar (the drawing’s title block says which).',
    check: (g) => (g.carry?.kind === 'bar' && barFits(g.carry.bar, getLatheJob('L01'))) || !!g.prog?.loaded,
  },
  {
    id: 'load', title: 'Chuck the bar',
    text: 'Back at the lathe, point at the <b>chuck</b> and press <kbd>E</kbd>. Leave about <b>60 mm</b> sticking out and press <b>Load &amp; tighten</b>.',
    hint: 'Short stick-out = stiff work. 60 mm leaves room for the 40 mm part, the 3 mm parting blade and some clearance.',
    check: (g) => !!g.sim.state.stock && g.sim.state.chuck.clamped,
  },
  {
    id: 'op', title: 'Step up to the lathe',
    text: 'Press <kbd>E</kbd> on the lathe to take the <b>operator position</b>. The panel shows the handwheels, the DRO, the spindle and the feed controls.',
    check: (g) => !!g.op,
  },
  {
    id: 'guard', title: 'Close the chuck guard',
    text: 'The spindle will not start while the chuck guard is open. Press <b>GUARD</b> (right panel) or <kbd>G</kbd>, or click the guard on the lathe.',
    check: (g) => !g.sim.state.guardOpen,
  },
  {
    id: 'speed', title: 'Select the speed',
    text: 'Aluminium Ø30 at about 90 m/min needs ~1000 rpm. Use the <b>◀ ▶</b> speed selector (or <kbd>+</kbd> / <kbd>−</kbd>) to pick <b>710–1400 rpm</b>.',
    hint: 'n = Vc × 1000 / (π × D)',
    check: (g) => g.sim.state.spindle.rpmSet >= 710 && g.sim.state.spindle.rpmSet <= 1400,
  },
  {
    id: 'start', title: 'Start the spindle',
    text: 'Press <b>FWD</b> or <kbd>Space</kbd>. Seen from the tailstock the chuck turns anticlockwise: the front of the work moves <b>down</b> onto the tool’s top face.',
    check: (g) => g.sim.state.spindle.dir === 1 && g.sim.state.spindle.rpm > 300,
  },
  {
    id: 'face', title: 'Face the end',
    text: 'With <b>T1</b>, bring the tool just past the end of the bar with the carriage (<kbd>←</kbd>/<kbd>→</kbd>), then wind the cross-slide <b>in</b> (<kbd>↑</kbd>, hold <kbd>Shift</kbd> to go faster) right across the centre. Take about 0.5 mm.',
    hint: 'If nothing happens the tool is beyond the end: move the carriage 0.5 mm toward the chuck and go across again.',
    // faced = the free end is shorter than the bar as it was chucked (works even if you faced before this step)
    check: (g) => { const p = g.sim.profile, e = g.sim.endZ(); return !!p && e != null && e < p.zMax - 0.1; },
  },
  {
    id: 'zero', title: 'Touch off and zero the dial',
    text: 'Back out a little, move the tool past the end onto the outside diameter and turn the cross-slide in until it just <b>touches</b> the Ø30. Then press <b>ZERO</b> under the cross-slide dial: the dial now reads 0 at Ø30.',
    hint: 'The cross dial reads on DIAMETER: 50 divisions = 1.00 mm off the diameter.',
    check: (g, t) => t.zeroed,
  },
  {
    id: 'rough', title: 'Turn the Ø28 shoulder',
    text: 'Clear the end, dial in <b>Ø2.00</b> (100 divisions) and turn toward the chuck for about <b>45 mm</b> by hand or with the power feed (<kbd>F</kbd>, stop it with <kbd>F</kbd>).',
    check: (g) => { const d = odAt(g.sim, 30); return d != null && d <= 28.1 && d >= 27.85; },
  },
  {
    id: 'turn', title: 'Turn the Ø24 spigot',
    text: 'Now take Ø24 over the first <b>22 mm</b>: pass by pass (1 mm per side is fine in aluminium), finishing with the dial on <b>Ø6.00</b> from your zero. Watch the DRO for the 22 mm shoulder.',
    hint: 'Ø24 ±0.05: if a measurement says 24.08, dial in 4 more divisions and take a spring pass.',
    check: (g) => { const d = odAt(g.sim, 10); return d != null && d <= 24.05 && d >= 23.95; },
  },
  {
    id: 'chamfer', title: 'Chamfer the end',
    text: 'Back the tool off, index <b>T2</b> (the 45° V tool, key <kbd>2</kbd>), put its point on the end face edge and feed in about <b>1 mm</b> for a 1×45° chamfer.',
    check: (g) => { const d = odAt(g.sim, 0.3); return d != null && d < 23.0; },
  },
  {
    id: 'part', title: 'Part it off',
    text: 'Index <b>T3</b>, the 3 mm parting blade (its LEFT corner is the reference). Position it 40 mm from the faced end (+ the blade width) and feed in slowly, with coolant (<kbd>C</kbd>), until the part drops off.',
    hint: 'Power cross feed at 0.06 mm/rev parts off nicely: Shift+F.',
    check: (g) => g.pieces.length > 0 || g.carry?.kind === 'part' || !!g.plate,
  },
  {
    id: 'pick', title: 'Pick up the part',
    text: 'Stop the spindle (<kbd>Space</kbd>), step back (<kbd>Esc</kbd>) and press <kbd>E</kbd> on the part lying in the chip tray.',
    check: (g) => g.carry?.kind === 'part' || !!g.plate,
  },
  {
    id: 'inspect', title: 'Inspect it',
    text: 'Take the part to the <b>inspection bench</b> (left wall, near the front) and press <kbd>E</kbd> to put it on the surface plate. The report compares it with the drawing.',
    check: (g) => !!g.plate,
  },
  {
    id: 'measure', title: 'Measure the spigot',
    text: 'Press <b>Measure the part</b>, pick the <b>outside micrometer</b> and click on the Ø24 spigot. Compare your reading with the drawing.',
    check: (g) => g.mlog.some((l) => l.tool === 'mic'),
  },
];

export class LatheTutorial {
  constructor(game) {
    this.game = game;
    this.active = false;
    this.i = 0;
    this.min = false;
    this.ctx = {};
    this._t = 0;
    this.el = typeof document !== 'undefined' ? document.getElementById('ltTut') : null;
    this.el?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tt]');
      if (!b) return;
      const k = b.dataset.tt;
      if (k === 'skip') this.go(this.i + 1);
      else if (k === 'back') this.go(Math.max(0, this.i - 1));
      else if (k === 'end') this.stop();
      else if (k === 'min') { this.min = !this.min; this.render(); }
    });
  }

  get cur() { return LATHE_TUTORIAL[this.i] || null; }

  toggle() { if (this.active) this.stop(); else this.start(); }
  start() {
    this.active = true;
    this.min = false;
    this.ctx = {};
    // skip what is already done (e.g. the job is accepted, the bar is in the chuck)
    this.i = 0;
    this.enter();
    this.game.ui.toast('Tutorial: follow the card at the top left. It moves on by itself as you work.', 'info', 4500);
    this.poke();
    this.render();
  }
  stop() {
    this.active = false;
    if (this.el) this.el.hidden = true;
    this.game.ui._objKey = '';
  }
  go(i) {
    this.i = Math.max(0, Math.min(LATHE_TUTORIAL.length, i));
    this.enter();
    this.render();
  }
  enter() {
    const st = this.game.sim.state;
    void st;
  }
  onEvent(e) {
    if (!this.active) return;
    if (e.type === 'dialZero' && e.axis === 'cross') this.ctx.zeroed = true;
    if (e.type === 'stockLoaded') this.ctx.zeroed = false; // a new bar must be touched off again
  }
  poke() { this._t = 1; }
  update(dt) {
    if (!this.active) return;
    this._t += dt;
    if (this._t < 0.3) return;
    this._t = 0;
    let moved = false;
    while (this.cur && this.cur.check(this.game, this.ctx)) {
      this.i++;
      this.enter();
      moved = true;
    }
    if (moved) {
      this.game.app.sound.tone?.(880, 0.005, 0.18, 0.12);
      if (!this.cur) {
        this.game.s.tutDone = true;
        this.game.save();
        this.game.ui.toast('Tutorial complete: you turned, chamfered, parted off and measured your first part!', 'ok', 6000);
      }
      this.render();
    }
  }
  render() {
    const el = this.el;
    if (!el) return;
    el.hidden = !this.active;
    if (!this.active) return;
    const n = LATHE_TUTORIAL.length, c = this.cur;
    el.classList.toggle('min', this.min);
    el.classList.toggle('done', !c);
    const dots = LATHE_TUTORIAL.map((_, k) => `<i class="${k < this.i ? 'd' : k === this.i ? 'c' : ''}"></i>`).join('');
    el.innerHTML = c
      ? `<div class="lt-tut-h"><span class="lbl">Tutorial ${this.i + 1}/${n}</span><b>${esc(c.title)}</b><button class="btn ghost icon" data-tt="min" title="Collapse" style="height:24px;width:24px">${this.min ? '▾' : '▴'}</button></div>
        <div class="lt-tut-b"><p>${c.text}</p>${c.hint ? `<p class="hint">${c.hint}</p>` : ''}</div>
        <div class="lt-tut-dots">${dots}</div>
        <div class="lt-tut-f"><button class="btn" data-tt="back"${this.i ? '' : ' disabled'}>Back</button><button class="btn" data-tt="skip">Skip step</button><button class="btn ghost" data-tt="end">End</button></div>`
      : `<div class="lt-tut-h"><span class="lbl">Tutorial</span><b>Complete!</b></div><div class="lt-tut-b"><p>You faced, turned to the dial, chamfered, parted off and measured a turned part. Try the other jobs on the board: a drilled bush, a grooved shaft and a screw-cut stud.</p></div><div class="lt-tut-dots">${dots}</div><div class="lt-tut-f"><button class="btn primary" data-tt="end">Close</button></div>`;
    this.game.ui._objKey = '';
  }
}
