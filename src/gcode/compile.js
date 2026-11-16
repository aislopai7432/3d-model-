// Chooses the dialect for a program and compiles it. Like the 808D, the control works in Siemens
// mode (G290) by default; G291 as the first command switches the program to ISO (Fanuc) dialect.
import { Interpreter } from './interpreter.js';
import { SiemensInterpreter } from './siemens.js';

export function detectDialect(text, def = 'siemens') {
  const lines = text.split('\n', 60);
  for (const raw of lines) {
    const l = raw.replace(/;.*$/, '').replace(/\([^)]*\)/g, '').trim().toUpperCase();
    if (!l || l.startsWith('%') || /^O\d+\s*$/.test(l)) continue;
    if (/^(N\d+\s*)?G291\b/.test(l)) return 'iso';
    if (/^(N\d+\s*)?G290\b/.test(l)) return 'siemens';
    return def;
  }
  return def;
}

export function compileProgram(text, opts, init = {}) {
  const dialect = opts.forceDialect || detectDialect(text, opts.dialect || 'siemens');
  const modal = init.modal && (init.modal.dialect || 'iso') === dialect ? init.modal : undefined;
  const I = dialect === 'iso' ? new Interpreter(opts) : new SiemensInterpreter(opts);
  const res = I.compile(text, { ...init, modal });
  res.dialect = dialect;
  return res;
}
