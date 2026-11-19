// Chooses the dialect for a program and compiles it. Like the 808D, the control works in Siemens
// mode (G290) by default; G291 as the first command switches the program to ISO (Fanuc) dialect.
// The Haas (NGC) dialect is used when settings.dialect === 'haas' (opts.dialect) or when the program
// looks like a Haas file: a leading "%" line followed by an "Onnnnn" program-number line.
import { Interpreter } from './interpreter.js';
import { SiemensInterpreter } from './siemens.js';
import { HaasInterpreter } from './haas.js';

export function detectDialect(text, def = 'siemens') {
  const lines = text.split('\n', 60);
  let pct = false, onum = false;
  for (const raw of lines) {
    const l = raw.replace(/;.*$/, '').replace(/\([^)]*\)/g, '').trim().toUpperCase();
    if (!l) continue;
    if (l.startsWith('%')) { if (l === '%') pct = true; continue; }
    if (/^O\d+\s*$/.test(l)) { onum = true; continue; }
    if (/^(N\d+\s*)?G291\b/.test(l)) return 'iso';
    if (/^(N\d+\s*)?G290\b/.test(l)) return 'siemens';
    if (pct && onum) return 'haas';
    return def;
  }
  return pct && onum ? 'haas' : def;
}

export function compileProgram(text, opts, init = {}) {
  const dialect = opts.forceDialect || detectDialect(text, opts.dialect || 'siemens');
  const modal = init.modal && (init.modal.dialect || 'iso') === dialect ? init.modal : undefined;
  const I = dialect === 'iso' ? new Interpreter(opts) : dialect === 'haas' ? new HaasInterpreter(opts) : new SiemensInterpreter(opts);
  const res = I.compile(text, { ...init, modal });
  res.dialect = dialect;
  return res;
}
