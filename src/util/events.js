export class Emitter {
  constructor() {
    this._h = new Map();
  }
  on(name, fn) {
    if (!this._h.has(name)) this._h.set(name, new Set());
    this._h.get(name).add(fn);
    return () => this._h.get(name)?.delete(fn);
  }
  emit(name, ...args) {
    const s = this._h.get(name);
    if (s) for (const fn of s) fn(...args);
  }
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (t) => t * t * (3 - 2 * t);
