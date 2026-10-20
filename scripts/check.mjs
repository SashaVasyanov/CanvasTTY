// Syntax check for every JS file (main = CommonJS, renderer = ES modules). Used by CI.
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
let failed = 0;
for (const f of walk('main').filter((f) => f.endsWith('.js'))) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { failed++; console.error(`✗ ${f}\n${r.stderr}`); } else console.log(`✓ ${f}`);
}
for (const f of walk('renderer/js').filter((f) => f.endsWith('.js'))) {
  const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: readFileSync(f, 'utf8'), encoding: 'utf8' });
  if (r.status !== 0) { failed++; console.error(`✗ ${f}\n${r.stderr}`); } else console.log(`✓ ${f}`);
}
JSON.parse(readFileSync('package.json', 'utf8'));
if (failed) { console.error(`\n${failed} file(s) failed`); process.exit(1); }
console.log('\nAll files OK');
