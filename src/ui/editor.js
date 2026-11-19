// G-code editor: a transparent <textarea> over a syntax-highlighted layer. Only the visible lines are
// highlighted (virtualised), so 10k+ line CAM programs stay responsive. Lines never wrap, which keeps
// line positions uniform for the gutter, error bands and the execution-line highlight.
import { highlightTokens } from '../gcode/parser.js';
import { highlightSiemens } from '../gcode/siemens.js';
import { highlightHaas } from '../gcode/haas.js';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class Editor {
  constructor(root) {
    this.root = root;
    this.lh = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lh')) || 19;
    root.innerHTML = '<div class="ed-gutter"></div><div class="ed-main"><div class="ed-bands"></div><div class="ed-hl"></div><textarea class="ed-ta" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" wrap="off" aria-label="G-code program"></textarea></div>';
    this.gutter = root.querySelector('.ed-gutter');
    this.hl = root.querySelector('.ed-hl');
    this.bands = root.querySelector('.ed-bands');
    this.ta = root.querySelector('.ed-ta');
    this.lines = [''];
    this.dialect = 'siemens';
    this.errors = new Map(); // line -> [{col,len,msg,level}]
    this.execLine = -1;
    this.listeners = [];
    this.ta.addEventListener('input', () => {
      this.lines = this.ta.value.split('\n');
      this.schedule();
      for (const fn of this.listeners) fn(this.ta.value);
    });
    this.ta.addEventListener('scroll', () => this.schedule());
    this.ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        document.execCommand ? document.execCommand('insertText', false, '  ') : null;
      }
    });
    this.ro = new ResizeObserver(() => this.schedule());
    this.ro.observe(root);
    this.gutter.addEventListener('mousemove', (e) => {
      const line = Math.floor((e.offsetY + this.ta.scrollTop) / this.lh);
      const errs = this.errors.get(line);
      this.gutter.title = errs ? errs.map((x) => x.msg).join('\n') : '';
    });
  }

  // line index of the caret
  caretLine() {
    const v = this.ta.value;
    return v.slice(0, this.ta.selectionStart).split('\n').length - 1;
  }

  lineText(n) {
    return this.lines[n] ?? '';
  }

  // Replace line n (or insert after it) and notify listeners.
  replaceLine(n, text, insert = false) {
    const lines = this.ta.value.split('\n');
    if (insert) lines.splice(n + 1, 0, ...text.split('\n'));
    else lines.splice(n, 1, ...text.split('\n'));
    this.applyText(lines.join('\n'), insert ? n + 1 : n);
  }

  applyText(text, focusLine) {
    const st = this.ta.scrollTop;
    this.ta.value = text;
    this.lines = text.split('\n');
    this.ta.scrollTop = st;
    if (focusLine != null) {
      let pos = 0;
      for (let i = 0; i < focusLine && i < this.lines.length; i++) pos += this.lines[i].length + 1;
      this.ta.setSelectionRange(pos, pos);
    }
    this.schedule();
    for (const fn of this.listeners) fn(text);
  }

  onChange(fn) {
    this.listeners.push(fn);
  }

  setValue(text) {
    this.ta.value = text;
    this.lines = text.split('\n');
    this.ta.scrollTop = 0;
    this.schedule();
  }

  getValue() {
    return this.ta.value;
  }

  setReadOnly(ro) {
    this.ta.readOnly = ro;
  }

  setDiagnostics(errors, warnings) {
    this.errors.clear();
    for (const e of errors) {
      if (!this.errors.has(e.line)) this.errors.set(e.line, []);
      this.errors.get(e.line).push({ ...e, level: 'err' });
    }
    for (const w of warnings) {
      if (!this.errors.has(w.line)) this.errors.set(w.line, []);
      this.errors.get(w.line).push({ ...w, level: 'warn', col: 0, len: 0 });
    }
    this.schedule();
  }

  setExecLine(n, follow = true) {
    if (n === this.execLine) return;
    this.execLine = n;
    if (follow && n >= 0) {
      const top = n * this.lh;
      const h = this.ta.clientHeight;
      if (top < this.ta.scrollTop + this.lh * 2 || top > this.ta.scrollTop + h - this.lh * 4) {
        this.ta.scrollTop = Math.max(0, top - h * 0.35);
      }
    }
    this.schedule();
  }

  gotoLine(n) {
    const lines = this.lines;
    let pos = 0;
    for (let i = 0; i < n && i < lines.length; i++) pos += lines[i].length + 1;
    this.ta.focus();
    this.ta.setSelectionRange(pos, pos + (lines[n] || '').length);
    this.ta.scrollTop = Math.max(0, n * this.lh - this.ta.clientHeight * 0.35);
    this.schedule();
  }

  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  render() {
    const lh = this.lh;
    const st = this.ta.scrollTop, sl = this.ta.scrollLeft;
    const h = this.ta.clientHeight || 400;
    const first = Math.max(0, Math.floor(st / lh) - 2);
    const last = Math.min(this.lines.length - 1, Math.ceil((st + h) / lh) + 2);
    const digits = String(this.lines.length).length;
    this.gutter.style.width = Math.max(44, digits * 8 + 30) + 'px';
    let hl = '', gut = '', bands = '';
    for (let i = first; i <= last; i++) {
      const y = i * lh - st;
      const errs = this.errors.get(i);
      const isErr = errs && errs.some((e) => e.level === 'err');
      const isWarn = errs && !isErr;
      gut += `<div class="gl${isErr ? ' err' : isWarn ? ' warn' : ''}${i === this.execLine ? ' cur' : ''}" style="top:${y}px">${i + 1}</div>`;
      if (i === this.execLine) bands += `<div class="ed-band cur" style="top:${y}px"></div>`;
      else if (isErr) bands += `<div class="ed-band err" style="top:${y}px"></div>`;
      hl += `<div class="ln" style="top:${y}px;transform:translateX(${-sl}px)">${this.lineHtml(this.lines[i], errs)}</div>`;
    }
    this.hl.innerHTML = hl;
    this.gutter.innerHTML = gut;
    this.bands.innerHTML = bands;
  }

  lineHtml(text, errs) {
    if (!text) return '';
    const spans = this.dialect === 'iso' ? highlightTokens(text) : this.dialect === 'haas' ? highlightHaas(text) : highlightSiemens(text);
    const bad = errs ? errs.filter((e) => e.level === 'err' && e.len > 0) : [];
    let col = 0;
    let out = '';
    for (const s of spans) {
      const start = col, end = col + s.text.length;
      col = end;
      const isBad = bad.some((e) => e.col < end && e.col + e.len > start);
      const cls = (s.cls || '') + (isBad ? ' bad' : '');
      out += cls.trim() ? `<span class="${cls.trim()}">${esc(s.text)}</span>` : esc(s.text);
    }
    return out;
  }
}
