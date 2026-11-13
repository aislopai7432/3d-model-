// Synthesised sound: everything is generated with Web Audio, so there are no sound files.
let ctx = null, master = null, sfx = null, det = null, noiseBuf = null;
let volume = 0.8, detVolume = 0.8;

function ensure() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = volume;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 4;
  master.connect(comp).connect(ctx.destination);
  sfx = ctx.createGain();
  sfx.connect(master);
  det = ctx.createGain();
  det.gain.value = detVolume;
  det.connect(master);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return ctx;
}

export const Audio = {
  unlock() { const c = ensure(); if (c && c.state === 'suspended') c.resume(); },
  setVolume(v) { volume = v; if (master) master.gain.value = v; },
  setDetectorVolume(v) { detVolume = v; if (det) det.gain.value = v; },

  tone(freq, dur, { type = 'sine', gain = 0.3, attack = 0.005, out = 'sfx', when = 0, slide = 0 } = {}) {
    if (!ensure()) return;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(out === 'det' ? det : sfx);
    o.start(t);
    o.stop(t + dur + 0.05);
  },
  noise(dur, { freq = 1200, q = 0.8, type = 'bandpass', gain = 0.3, when = 0, attack = 0.004 } = {}) {
    if (!ensure()) return;
    const t = ctx.currentTime + when;
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(sfx);
    s.start(t, Math.random() * 0.8);
    s.stop(t + dur + 0.05);
  },

  // detector beep: pitch by metal, louder with strength
  beep(freq, strength) {
    this.tone(freq, 0.07 + strength * 0.05, { type: 'square', gain: 0.05 + strength * 0.16, out: 'det' });
    this.tone(freq * 2, 0.05, { type: 'sine', gain: 0.03 * strength, out: 'det' });
  },
  rustle(material = 'soft') {
    if (material === 'metal') this.clank();
    else if (material === 'glass') { this.tone(2400 + Math.random() * 800, 0.18, { gain: 0.06 }); this.noise(0.12, { freq: 5000, q: 2, gain: 0.1 }); }
    else this.noise(0.22 + Math.random() * 0.1, { freq: 1800 + Math.random() * 1500, q: 0.6, gain: 0.22 });
  },
  clank() {
    const f = 300 + Math.random() * 500;
    for (const [m, g] of [[1, 0.12], [2.76, 0.06], [5.4, 0.04], [8.9, 0.02]]) this.tone(f * m, 0.35 + Math.random() * 0.3, { type: 'sine', gain: g });
    this.noise(0.05, { freq: 3000, gain: 0.15 });
  },
  dig() {
    this.noise(0.18, { freq: 500, q: 0.7, type: 'lowpass', gain: 0.35 });
    this.tone(90, 0.12, { type: 'sine', gain: 0.25, slide: 0.6 });
    this.noise(0.12, { freq: 2600, q: 1, gain: 0.08, when: 0.05 });
  },
  shovelScrape() { this.noise(0.25, { freq: 3500, q: 3, gain: 0.07 }); },
  collect(rarity = 0) {
    const scale = [0, 4, 7, 12, 16, 19, 24];
    const base = 880;
    const n = 2 + rarity;
    for (let i = 0; i < n; i++) {
      const f = base * Math.pow(2, scale[i % scale.length] / 12) * (i >= scale.length ? 2 : 1);
      this.tone(f, 0.5 + rarity * 0.12, { type: 'sine', gain: 0.14, when: i * 0.07 });
      this.tone(f * 2.01, 0.25, { type: 'sine', gain: 0.04, when: i * 0.07 });
    }
    if (rarity >= 2) this.noise(0.9, { freq: 9000, q: 0.5, type: 'highpass', gain: 0.05 * rarity, attack: 0.05 });
    if (rarity >= 3) this.fanfare(rarity === 4);
  },
  fanfare(big) {
    if (!ensure()) return;
    const chord = big ? [261.6, 329.6, 392, 523.3, 659.3] : [293.7, 370, 440, 587.3];
    chord.forEach((f, i) => {
      for (const det2 of [-6, 0, 6]) {
        const t = ctx.currentTime + 0.25;
        const o = ctx.createOscillator(), g = ctx.createGain(), lp = ctx.createBiquadFilter();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = det2;
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(400, t);
        lp.frequency.linearRampToValueAtTime(big ? 3200 : 2000, t + 1.2);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.035, t + 0.5 + i * 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, t + (big ? 3.6 : 2.2));
        o.connect(lp).connect(g).connect(sfx);
        o.start(t);
        o.stop(t + 4);
      }
    });
    if (big) for (let k = 0; k < 14; k++) this.tone(1500 + Math.random() * 2500, 0.4, { gain: 0.05, when: 0.4 + k * 0.12 });
  },
  sell(amount = 10) {
    this.noise(0.04, { freq: 2000, gain: 0.25 });
    this.tone(1318, 0.6, { gain: 0.16, when: 0.08 });
    this.tone(1760, 0.9, { gain: 0.14, when: 0.16 });
    const coins = Math.min(14, 3 + Math.floor(Math.log10(amount + 1) * 3));
    for (let k = 0; k < coins; k++) this.tone(3000 + Math.random() * 2500, 0.12, { gain: 0.05, when: 0.25 + k * 0.05 + Math.random() * 0.03 });
  },
  ui() { this.tone(1500, 0.04, { type: 'triangle', gain: 0.05 }); },
  error() { this.tone(140, 0.25, { type: 'square', gain: 0.07 }); },
  scaleBeep() { this.tone(2200, 0.06, { type: 'square', gain: 0.05 }); },
  drop() { this.tone(1900 + Math.random() * 600, 0.15, { gain: 0.07 }); this.noise(0.03, { freq: 4000, gain: 0.08 }); },
  scanner() { this.tone(1400, 1.2, { type: 'sine', gain: 0.12, slide: 0.15 }); this.tone(700, 1.2, { type: 'triangle', gain: 0.06, slide: 0.25, when: 0.05 }); },
  levelUp() { [523.3, 659.3, 784, 1046.5].forEach((f, i) => this.tone(f, 0.45, { type: 'triangle', gain: 0.12, when: i * 0.09 })); },
  purchase() { this.tone(660, 0.12, { type: 'triangle', gain: 0.1 }); this.tone(990, 0.3, { type: 'triangle', gain: 0.1, when: 0.1 }); this.noise(0.05, { freq: 2500, gain: 0.1 }); },
};
