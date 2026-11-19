// Line tokenizer for RS-274 / Fanuc-style G-code.
// Produces words { letter, value, dec, col, len } plus comments and syntax errors with column positions,
// so the editor can underline the exact token that is wrong.

const isDigit = (c) => c >= 48 && c <= 57;

export function parseLine(text) {
  const out = { words: [], comment: '', blockDelete: false, percent: false, errors: [] };
  const n = text.length;
  let i = 0;
  let first = true;
  while (i < n) {
    const ch = text[i];
    const code = text.charCodeAt(i);
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (ch === '(') {
      const end = text.indexOf(')', i + 1);
      if (end < 0) {
        out.errors.push({ col: i, len: n - i, msg: 'Comment is missing its closing ")"' });
        out.comment += text.slice(i + 1);
        break;
      }
      const inner = text.slice(i + 1, end);
      if (inner.includes('(')) out.errors.push({ col: i, len: end - i + 1, msg: 'Nested "(" inside a comment' });
      out.comment += (out.comment ? ' ' : '') + inner.trim();
      i = end + 1;
      continue;
    }
    if (ch === ';') { out.comment += (out.comment ? ' ' : '') + text.slice(i + 1).trim(); break; }
    if (ch === '%') {
      if (first) { out.percent = true; i++; first = false; continue; }
      out.errors.push({ col: i, len: 1, msg: '"%" is only allowed on its own line' });
      i++;
      continue;
    }
    if (ch === '/' && first) { out.blockDelete = true; i++; first = false; continue; }
    first = false;
    const upper = code & ~32;
    if (upper >= 65 && upper <= 90) {
      const letter = String.fromCharCode(upper);
      const start = i;
      i++;
      while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
      const numStart = i;
      if (i < n && (text[i] === '+' || text[i] === '-')) i++;
      let digits = 0;
      let dec = false;
      while (i < n && isDigit(text.charCodeAt(i))) { i++; digits++; }
      if (i < n && text[i] === '.') {
        dec = true;
        i++;
        while (i < n && isDigit(text.charCodeAt(i))) { i++; digits++; }
      }
      if (!digits) {
        out.errors.push({ col: start, len: Math.max(1, i - start), msg: `Word "${letter}" has no numeric value` });
        continue;
      }
      const value = parseFloat(text.slice(numStart, i));
      out.words.push({ letter, value, dec, col: start, len: i - start });
      continue;
    }
    // Unknown character: consume the run of junk so we report it once.
    const start = i;
    while (i < n && !/[A-Za-z(;\s]/.test(text[i])) i++;
    if (i === start) i++;
    out.errors.push({ col: start, len: i - start, msg: `Unexpected "${text.slice(start, i)}"` });
  }
  return out;
}

// Syntax-highlighting tokenizer used by the editor. Returns spans { cls, text } covering the whole line.
export function highlightTokens(text) {
  const spans = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '(') {
      const end = text.indexOf(')', i + 1);
      const stop = end < 0 ? n : end + 1;
      spans.push({ cls: 'c', text: text.slice(i, stop) });
      i = stop;
      continue;
    }
    if (ch === ';') { spans.push({ cls: 'c', text: text.slice(i) }); break; }
    if (ch === '%' || ch === '/') { spans.push({ cls: 'p', text: ch }); i++; continue; }
    const code = text.charCodeAt(i) & ~32;
    if (code >= 65 && code <= 90) {
      const start = i;
      i++;
      while (i < n && /[\s]/.test(text[i]) && i - start < 2) i++;
      while (i < n && /[0-9.+\-]/.test(text[i])) i++;
      const L = String.fromCharCode(code);
      let cls = 'w';
      if (L === 'G') cls = 'g';
      else if (L === 'M') cls = 'm';
      else if (L === 'X' || L === 'Y' || L === 'Z') cls = 'a' + L.toLowerCase();
      else if (L === 'I' || L === 'J' || L === 'K' || L === 'R') cls = 'r';
      else if (L === 'F' || L === 'S') cls = 'f';
      else if (L === 'T' || L === 'H' || L === 'D') cls = 't';
      else if (L === 'N' || L === 'O') cls = 'n';
      else if (L === 'P' || L === 'Q' || L === 'L') cls = 'q';
      spans.push({ cls, text: text.slice(start, i) });
      continue;
    }
    const start = i;
    while (i < n && !/[A-Za-z(;%/]/.test(text[i])) i++;
    if (i === start) i++;
    spans.push({ cls: '', text: text.slice(start, i) });
  }
  return spans;
}
