// NC program memory (part programs stored in the browser) for the program manager.
const KEY = 'milllab.programs.v1';

export function normName(n) {
  let s = String(n || '').trim().toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z0-9_.]/g, '');
  if (!/\.(MPF|SPF)$/.test(s)) s = s.replace(/\.[A-Z0-9]*$/, '') + '.MPF';
  return s;
}

export function validName(n) {
  return /^[A-Z_][A-Z0-9_]{0,23}\.(MPF|SPF)$/.test(n);
}

export class ProgramStore {
  constructor() {
    this.map = {};
    try {
      const d = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (d && d.map) {
        this.map = d.map;
        this.current = d.current;
      }
    } catch {
      /* storage unavailable: programs live for this session only */
    }
  }

  names() {
    return Object.keys(this.map).sort();
  }

  has(n) {
    return Object.prototype.hasOwnProperty.call(this.map, n);
  }

  get(n) {
    return this.map[n]?.text ?? null;
  }

  info(n) {
    return this.map[n];
  }

  put(n, text, meta = {}) {
    this.map[n] = { ...(this.map[n] || {}), ...meta, text, modified: Date.now() };
    this.save();
  }

  rename(a, b) {
    if (!this.has(a) || this.has(b)) return false;
    this.map[b] = this.map[a];
    delete this.map[a];
    if (this.current === a) this.current = b;
    this.save();
    return true;
  }

  remove(n) {
    delete this.map[n];
    if (this.current === n) this.current = null;
    this.save();
  }

  setCurrent(n) {
    this.current = n;
    this.save();
  }

  uniqueName(base) {
    const b = normName(base).replace(/\.(MPF|SPF)$/, '');
    let n = `${b}.MPF`;
    let k = 1;
    while (this.has(n)) n = `${b.slice(0, 20)}_${k++}.MPF`;
    return n;
  }

  save() {
    clearTimeout(this.t);
    this.t = setTimeout(() => {
      try {
        localStorage.setItem(KEY, JSON.stringify({ map: this.map, current: this.current }));
      } catch {
        /* ignore */
      }
    }, 300);
  }
}
