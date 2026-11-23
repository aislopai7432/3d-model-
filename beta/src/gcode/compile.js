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
  let res;
  try {
    res = I.compile(String(text ?? ''), { ...init, modal });
  } catch (e) {
    // No input may crash the app: an internal failure becomes an error on the line being compiled.
    res = I.res || {};
    const line = Math.max(0, I.line | 0);
    const lc = res.lineCount ?? String(text ?? '').split('\n').length;
    for (const [k, v] of Object.entries({ ops: [], errors: [], warnings: [], lineCount: lc, totalTime: 0, ended: false, toolsUsed: new Set(), lineFirstOp: new Int32Array(lc).fill(-1),
      tipBounds: null, workBounds: null, feedLength: 0, rapidLength: 0, endState: null, messages: [], dprnt: [], toolOffsetWrites: [] })) if (res[k] === undefined) res[k] = v;
    res.errors.push({ line, col: 0, len: 0, msg: `Alarm 311 UNKNOWN CODE - internal compiler error (${String(e?.message || e).slice(0, 120)})`, alarm: 311 });
  }
  res.dialect = dialect;
  return res;
}
