// VPS templates of the NGC-style control: every template generates G-code that compiles without
// errors in the Haas dialect (and in ISO, the fallback), metric and inch, with all hole patterns.
import { compileProgram } from '../src/gcode/compile.js';
import { DEFAULT_TOOLS } from '../src/config.js';
import { VPS_TEMPLATES, defaults, generate, holePattern } from '../src/ui/haas/haas-vps.js';

let fail = 0;
const chk = (ok, m) => { if (!ok) { fail++; console.log('FAIL ' + m); } };
const tools = new Map(DEFAULT_TOOLS.map((t) => [t.number, { ...t, dLength: 0, dRadius: 0 }]));
const offsets = Array.from({ length: 6 }, () => ({ x: -280, y: -205, z: -430 }));
for (const tpl of VPS_TEMPLATES) {
  for (const inch of [false, true]) {
    for (const haas of [true, false]) {
      const patterns = tpl.id === 'drill' ? [1, 2, 3] : [0];
      for (const M of patterns) {
        const v = { ...defaults(tpl, inch) };
        if (tpl.id === 'drill') v.M = M;
        const res = generate(tpl, v, { inch, haas, toolDia: (n) => (tools.get(n)?.diameter || 10) / (inch ? 25.4 : 1), toolDesc: () => 'TOOL' });
        chk(!res.error, `${tpl.id} ${inch ? 'inch' : 'mm'}: ${res.error}`);
        if (res.error) continue;
        const text = ['%', 'O01234 (VPS TEST)', ...res.lines, 'M30', '%'].join('\n');
        chk(!/\d\.\d*\./.test(text), `${tpl.id}: malformed number in\n${text}`);
        const r = compileProgram(text, { tools, offsets, requireG43: true, arcTol: 0.01, forceDialect: haas ? 'haas' : 'iso' }, { pos: { x: 0, y: 0, z: 0 }, tool: 0, units: inch ? 20 : 21 });
        chk(!r.errors.length, `${tpl.id} ${inch ? 'inch' : 'mm'} ${haas ? 'haas' : 'iso'} M${M}: ${r.errors.map((e) => `line ${e.line + 1}: ${e.msg}`).join('; ')}`);
        chk(r.ops.some((o) => o.t === 'move' && !o.rapid), `${tpl.id}: no cutting moves`);
        if (tpl.id === 'drill') {
          const want = holePattern(v).length;
          const holes = r.ops.filter((o) => o.t === 'move' && !o.rapid && o.pts[o.pts.length - 1] < o.pts[2] - 1).length;
          chk(holes >= want, `${tpl.id} M${M} ${haas ? 'haas' : 'iso'}: ${holes} feed-down moves for ${want} holes`);
        }
      }
    }
  }
}
if (fail) { console.log(`${fail} failure(s)`); process.exit(1); }
console.log('haas-vps: all templates compile');
