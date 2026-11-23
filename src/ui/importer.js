// Getting G-code from a real machine, a CAM post or an e-mail into the control's program memory.
// Pure text functions (no DOM), so they run in Node tests too.
//
//   planImport(text, store, fileName) -> [{ name, text, onum, comment, replaced, notes }]
//
// A pasted Haas program may carry a BOM, CRLF or CR line ends, tabs, trailing blanks, lower case code,
// RS-232 control characters (DC1/DC3), ";" comments or end-of-block marks, a ":1234" (Fanuc) program
// number, no "%" lines, no O number at all, or several programs one after the other (main program
// followed by its subprograms). Each program becomes one Onnnnn.MPF in memory.

// Siemens 808D programs (cycles, ";" comments, R parameters) are left alone: only line ends / BOM.
export const SIEMENS_RE = /^\s*;|\b(CYCLE\d+|POCKET[34]|MCALL|SLOT[12]|LONGHOLE|HOLES[12]|MSG\s*\(|G500|GOTO[FB]|SUPA|TRANS|AROT)\b|\bR\d+\s*=|\bD\d+\b/m;
export function looksSiemens(text) {
  return SIEMENS_RE.test(String(text).slice(0, 20000));
}

// Unmistakably Siemens (a Haas program never has these)
const SIEMENS_STRONG = /\b(CYCLE\d+|POCKET[34]|MCALL|SLOT[12]|LONGHOLE|HOLES[12]|GOTO[FB]|SUPA|AROT)\b|\bMSG\s*\(|\bR\d+\s*=|\bG500\b|\bG29[01]\b/;
const HAAS_SIGNS = /\bM0?6\b|\bG43\b|\bG5[4-9]\b|\bG8[1-9]\b|\bG28 G91\b|\bM30\b/;

const CODE_AFTER_SEMI = /^\s*(?:\/\s*)?[GMTNXYZSFHDIJKRPQLOABCUVWE]\s*[-+.\d#[]/i;

// One line: upper-case the code (not the comments), turn ";" into a comment or a block break.
function fixLine(raw, notes) {
  let out = '';
  let depth = 0;
  const n = raw.length;
  for (let i = 0; i < n; i++) {
    const ch = raw[i];
    if (depth > 0) {
      out += ch;
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      continue;
    }
    if (ch === '(') { depth = 1; out += ch; continue; }
    if (ch === ';') {
      const rest = raw.slice(i + 1);
      if (!rest.trim()) break; // end-of-block mark at the end of the line
      if (CODE_AFTER_SEMI.test(rest)) { out += '\n'; notes.add('";" between blocks became a line break'); continue; }
      out = out.replace(/ +$/, '') + ` (${rest.trim().replace(/[()]/g, ' ').replace(/\s+/g, ' ')})`;
      notes.add('";" comments became (comments)');
      break;
    }
    out += ch >= 'a' && ch <= 'z' ? ch.toUpperCase() : ch;
  }
  if (depth > 0) out += ')'; // an unclosed comment would be alarm 386 on the control
  return out.replace(/[ \t]+$/g, '');
}

export function cleanText(text) {
  return String(text ?? '')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\t/g, ' ');
}

const isEnd = (l) => /\bM0?2\b|\bM30\b|\bM99\b/.test(l.replace(/\([^)]*\)/g, ''));

// Splits one normalised text into programs: a new program starts at an O line that follows a "%" or a
// program end (M30 / M02 / M99) of a program that already has an O line.
function splitPrograms(lines) {
  const parts = [];
  let cur = [];
  let last = '';
  for (const l of lines) {
    const t = l.trim();
    if (/^O\d{1,5}\b/.test(t) && cur.some((x) => /^O\d{1,5}\b/.test(x.trim())) && (last === '%' || isEnd(last))) {
      parts.push(cur);
      cur = [];
    }
    cur.push(l);
    if (t && !/^\(.*\)$/.test(t)) last = t;
  }
  if (cur.length) parts.push(cur);
  return parts;
}

function headOf(lines) {
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    const m = /^O(\d{1,5})\s*(?:\((.*)\))?\s*$/.exec(lines[i].trim());
    if (m) return { idx: i, onum: +m[1], comment: (m[2] || '').trim() };
  }
  return { idx: -1, onum: null, comment: '' };
}

function stem(fileName) {
  return String(fileName || '').replace(/^.*[\\/]/, '').replace(/\.[A-Za-z0-9]{1,4}$/, '').replace(/[()]/g, '').trim().toUpperCase().slice(0, 30);
}

// Normalises one program (array of cleaned lines) into Haas file format.
function shape(lines, notes) {
  const L = lines.map((l) => l.trim());
  while (L.length && !L[0]) L.shift();
  while (L.length && !L[L.length - 1]) L.pop();
  if (L[0] !== '%') { if (L.some((l) => l === '%')) { /* a % inside: handled below */ } else notes.add('"%" lines added'); }
  // Content between the first and second % only (the control ignores the rest)
  const first = L.indexOf('%');
  let body = L;
  if (first === 0) {
    const second = L.indexOf('%', 1);
    body = L.slice(1, second < 0 ? L.length : second);
    if (second >= 0 && second < L.length - 1) notes.add('text after the closing "%" was dropped');
  } else if (first > 0) {
    const second = L.indexOf('%', first + 1);
    if (second < 0) body = L.slice(0, first); // only a closing %
    else { body = L.slice(first + 1, second); notes.add('text before the first "%" was dropped'); }
  }
  return body;
}

// upper case, ";" and ":1234" fixed, one array entry per block line
export function fixLines(lines, notes) {
  const fixed = [];
  for (const raw of lines) for (const part of fixLine(raw, notes).split('\n')) fixed.push(part.trim());
  for (let i = 0; i < fixed.length; i++) {
    const m = /^:\s*(\d{1,5})\s*(.*)$/.exec(fixed[i]);
    if (m) { fixed[i] = `O${m[1].padStart(5, '0')}${m[2] ? ' ' + m[2] : ''}`; notes.add('":nnnn" program number became Onnnnn'); }
  }
  return fixed;
}

// ------------------------------------------------------------------------------------------ plan
export function planImport(text, store, fileName = '') {
  const cleaned = cleanText(text);
  const out = [];
  const used = new Set(store ? store.names().map((n) => n.toUpperCase()) : []);
  const reserved = new Set();
  const nameOf = (o) => `O${String(o).padStart(5, '0')}.MPF`;
  const freeNumber = () => {
    for (let n = 1; n < 100000; n++) if (!used.has(nameOf(n)) && !reserved.has(n)) return n;
    return 99999;
  };
  if (!cleaned.trim()) return out;
  // Siemens programs (and anything that is clearly not Haas) keep their text
  const haasHeader = /^\s*(%|:\d|O\d)/.test(cleaned.replace(/^\s*\n+/, ''));
  const head = cleaned.slice(0, 20000).toUpperCase();
  if (!haasHeader && (SIEMENS_STRONG.test(head) || (looksSiemens(head) && !HAAS_SIGNS.test(head)))) {
    const base = stem(fileName) || 'IMPORTED';
    let name = /^[A-Z_][A-Z0-9_]{0,23}$/.test(base) ? `${base}.MPF` : 'IMPORTED.MPF';
    if (store && store.has(name)) name = store.uniqueName(name);
    return [{ name, text: cleaned.endsWith('\n') ? cleaned : cleaned + '\n', onum: null, comment: '', replaced: false, notes: ['Siemens (808D) program: stored unchanged'] }];
  }
  const allNotes = new Set();
  const programs = splitPrograms(fixLines(cleaned.split('\n'), allNotes));
  for (const prog of programs) {
    const notes = new Set(allNotes);
    const body = shape(prog, notes);
    if (!body.some((l) => l)) continue;
    const h = headOf(body);
    let onum = h.onum, comment = h.comment;
    let rest = h.idx >= 0 ? [...body.slice(0, h.idx), ...body.slice(h.idx + 1)] : body.slice();
    if (!onum || onum > 99999 || reserved.has(onum)) {
      if (h.idx >= 0 && onum) notes.add(`O${onum} is not usable: a free number was assigned`);
      onum = freeNumber();
      notes.add(`no O number: O${String(onum).padStart(5, '0')} assigned`);
    }
    if (!comment) {
      const c0 = /^\((.*)\)$/.exec(rest.find((l) => l) || '');
      comment = (c0 && c0[1].trim()) || stem(fileName) || 'IMPORTED';
      if (c0) rest = rest.slice(rest.findIndex((l) => l) + 1);
    }
    comment = comment.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
    reserved.add(onum);
    const name = nameOf(onum);
    const head = `O${String(onum).padStart(5, '0')} (${comment})`;
    const full = ['%', head, ...rest, '%', ''].join('\n');
    const old = store && store.has(name) ? store.get(name) : null;
    out.push({ name, text: full, onum, comment, replaced: old != null && old !== full, same: old === full, notes: [...notes] });
  }
  return out;
}
