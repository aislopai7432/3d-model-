// Runs every headless test suite: node tests/run.mjs
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
let failed = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith('.test.mjs')).sort()) {
  const r = spawnSync(process.execPath, [join(dir, f)], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const bad = r.status !== 0 || /FAIL/.test(out);
  if (bad) failed++;
  console.log(`${bad ? 'FAIL' : 'ok  '} ${f}`);
  if (bad) console.log(out.split('\n').filter((l) => /FAIL|Error|error/.test(l)).slice(0, 10).join('\n'));
}
console.log(failed ? `${failed} suite(s) failed` : 'all suites passed');
process.exitCode = failed ? 1 : 0;
