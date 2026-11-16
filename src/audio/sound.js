// Synthesised machine sound with the Web Audio API (no audio files). Continuous voices follow the
// machine state: spindle motor (pitch tracks rpm), cutting (band-passed noise modulated at the
// tooth-passing frequency, loudness from material removal rate), axis servos and ball screws (pitch
// from axis speed) and coolant. One-shots cover the tool changer, doors, buttons and alarms.

const MAT_CUT = {
  aluminium: { f: 3400, q: 3.2, g: 1.0 },
  steel: { f: 2300, q: 2.2, g: 1.15 },
  brass: { f: 2900, q: 3.0, g: 0.9 },
  plastic: { f: 900, q: 1.1, g: 0.75 },
};

export class Sound {
  constructor() {
    this.ctx = null;
    this.volume = 0.7;
    this.muted = false;
  }

  // Must be called from a user gesture.
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 4;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(comp).connect(ctx.destination);
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    const noise = () => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.loopStart = Math.random();
      s.start(0, Math.random() * 1.5);
      return s;
    };
    const gain = (v = 0) => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };
    // spindle: motor fundamental + pole harmonic + inverter whine + bearing noise
    this.sp = { g: gain(), o1: ctx.createOscillator(), o2: ctx.createOscillator(), o3: ctx.createOscillator(), n: noise(), nf: ctx.createBiquadFilter() };
    const sp = this.sp;
    sp.o1.type = 'sawtooth';
    sp.o2.type = 'triangle';
    sp.o3.type = 'sine';
    const g1 = gain(0.05), g2 = gain(0.05), g3 = gain(0.012), gn = gain(0.05);
    sp.o1.connect(g1).connect(sp.g);
    sp.o2.connect(g2).connect(sp.g);
    sp.o3.connect(g3).connect(sp.g);
    sp.nf.type = 'bandpass';
    sp.nf.frequency.value = 1200;
    sp.nf.Q.value = 0.8;
    sp.n.connect(sp.nf).connect(gn).connect(sp.g);
    const spLp = ctx.createBiquadFilter();
    spLp.type = 'lowpass';
    spLp.frequency.value = 5000;
    sp.g.connect(spLp).connect(this.master);
    for (const o of [sp.o1, sp.o2, sp.o3]) { o.frequency.value = 50; o.start(); }
    // cutting
    this.cut = { g: gain(), am: gain(0), lfo: ctx.createOscillator(), n: noise(), bp: ctx.createBiquadFilter(), bp2: ctx.createBiquadFilter() };
    const c = this.cut;
    c.bp.type = 'bandpass';
    c.bp.frequency.value = 3000;
    c.bp.Q.value = 2.5;
    c.bp2.type = 'peaking';
    c.bp2.frequency.value = 700;
    c.bp2.gain.value = 6;
    c.n.connect(c.bp).connect(c.bp2).connect(c.g);
    c.lfo.type = 'square';
    c.lfo.frequency.value = 300;
    c.lfo.connect(c.am).connect(c.g.gain);
    c.lfo.start();
    c.g.connect(this.master);
    // servo / ball screws
    this.sv = { g: gain(), o: ctx.createOscillator(), n: noise(), lp: ctx.createBiquadFilter() };
    const sv = this.sv;
    sv.o.type = 'triangle';
    sv.o.frequency.value = 120;
    sv.o.connect(gain(0.35)).connect(sv.g);
    sv.lp.type = 'lowpass';
    sv.lp.frequency.value = 500;
    sv.n.connect(sv.lp).connect(gain(0.9)).connect(sv.g);
    sv.o.start();
    sv.g.connect(this.master);
    // coolant
    this.cl = { g: gain(), n: noise(), f: ctx.createBiquadFilter() };
    this.cl.f.type = 'bandpass';
    this.cl.f.frequency.value = 2600;
    this.cl.f.Q.value = 0.5;
    this.cl.n.connect(this.cl.f).connect(this.cl.g).connect(this.master);
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : v, this.ctx.currentTime, 0.05);
  }

  setMuted(m) {
    this.muted = m;
    this.setVolume(this.volume);
  }

  update(s) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    const k = 0.06;
    const rpm = Math.abs(s.rpm);
    const fr = Math.max(1, rpm / 60);
    const sp = this.sp;
    sp.o1.frequency.setTargetAtTime(fr * 2, t, k);
    sp.o2.frequency.setTargetAtTime(fr * 8, t, k);
    sp.o3.frequency.setTargetAtTime(2400 + fr * 4, t, k);
    sp.nf.frequency.setTargetAtTime(600 + fr * 6, t, k);
    sp.g.gain.setTargetAtTime(rpm > 5 ? 0.18 + 0.5 * Math.min(1, rpm / 12000) : 0, t, 0.12);
    // cutting
    const m = MAT_CUT[s.material] || MAT_CUT.aluminium;
    const amt = Math.min(1, Math.sqrt(Math.max(0, s.load)) * 1.6);
    const tooth = fr * Math.max(1, s.flutes || 2);
    this.cut.lfo.frequency.setTargetAtTime(Math.min(4000, tooth), t, k);
    this.cut.bp.frequency.setTargetAtTime(m.f * (0.85 + 0.3 * Math.min(1, rpm / 10000)), t, k);
    this.cut.bp.Q.setTargetAtTime(m.q, t, k);
    const cg = s.cutting ? (0.12 + 0.55 * amt) * m.g : 0;
    this.cut.g.gain.setTargetAtTime(cg, t, s.cutting ? 0.03 : 0.08);
    this.cut.am.gain.setTargetAtTime(cg * 0.45, t, 0.05);
    // servos
    const v = Math.min(1, s.speed / 400);
    this.sv.o.frequency.setTargetAtTime(90 + v * 260, t, k);
    this.sv.lp.frequency.setTargetAtTime(250 + v * 900, t, k);
    this.sv.g.gain.setTargetAtTime(v > 0.002 ? 0.04 + v * (s.rapid ? 0.22 : 0.12) : 0, t, 0.05);
    // coolant
    this.cl.g.gain.setTargetAtTime(s.coolant ? 0.11 : 0, t, 0.2);
  }

  // ---- one-shots
  env(node, a, d, peak) {
    const t = this.ctx.currentTime;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    node.connect(g).connect(this.master);
    return t + a + d + 0.05;
  }

  noiseBurst(freq, q, a, d, peak, type = 'bandpass') {
    if (!this.ready()) return;
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    s.connect(f);
    const end = this.env(f, a, d, peak);
    s.start();
    s.stop(end);
  }

  tone(freq, a, d, peak, type = 'sine', slide = 0) {
    if (!this.ready()) return;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), this.ctx.currentTime + a + d);
    const end = this.env(o, a, d, peak);
    o.start();
    o.stop(end);
  }

  ready() {
    return this.ctx && this.ctx.state === 'running';
  }

  click() { this.tone(1800, 0.001, 0.04, 0.08, 'square'); }
  air() { this.noiseBurst(4500, 0.7, 0.01, 0.35, 0.35, 'highpass'); }
  clunk() { this.noiseBurst(220, 1.2, 0.002, 0.18, 0.7); this.tone(95, 0.002, 0.2, 0.35, 'sine', -40); }
  index() { this.tone(160, 0.01, 0.12, 0.12, 'triangle', 60); this.noiseBurst(900, 2, 0.005, 0.08, 0.15); }
  slide() { this.noiseBurst(600, 0.9, 0.05, 0.6, 0.18, 'lowpass'); this.tone(70, 0.1, 0.55, 0.1, 'sawtooth', 20); }
  door() { this.noiseBurst(350, 0.6, 0.15, 0.9, 0.22, 'lowpass'); }
  alarm() { for (let i = 0; i < 3; i++) setTimeout(() => this.tone(880, 0.005, 0.14, 0.18, 'square'), i * 220); }
  crash() { this.noiseBurst(140, 0.7, 0.002, 0.7, 1.0, 'lowpass'); this.noiseBurst(2400, 1.5, 0.001, 0.25, 0.6); }
  estop() { this.tone(120, 0.002, 0.25, 0.5, 'square', -60); }
}
