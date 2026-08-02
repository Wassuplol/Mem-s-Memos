/** Syntax-check every .js/.mjs file in the project (no execution side effects). */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = ['index.js', 'src', 'tests', 'bridge', 'tools'];
const files = [];
function walk(p) {
    const st = statSync(p);
    if (st.isDirectory()) {
        if (p.includes('node_modules')) return;
        for (const f of readdirSync(p)) walk(join(p, f));
    } else if (/\.(js|mjs)$/.test(p)) files.push(p);
}
for (const r of roots) {
    try {
        walk(r);
    } catch { /* root missing */ }
}

let failed = 0;
for (const f of files) {
    const out = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (out.status !== 0) {
        failed++;
        console.error(`✗ ${f}\n${out.stderr.trim()}`);
    } else {
        console.log(`✓ ${f}`);
    }
}
console.log(`\n${files.length - failed}/${files.length} files OK`);
process.exit(failed ? 1 : 0);
