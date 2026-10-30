// Parses every source file (index.js and src/**) and checks that every named import from our own
// modules exists. The SillyTavern-side files (src/st, src/ui) can't run under node, so this is the
// only check they get before the browser: one syntax error there and the whole extension fails to
// load, with no panel and no error the player can see. Run by `npm test` first.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['index.js', ...fs.readdirSync(path.join(root, 'src'), { recursive: true }).filter(f => f.endsWith('.js')).map(f => path.join('src', f))];
let bad = 0;
for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', path.join(root, f)], { encoding: 'utf8' });
    if (r.status !== 0) { bad++; console.error(`SYNTAX ${f}\n${r.stderr.trim()}`); }
}
const exportsOf = {};
for (const f of files) {
    const s = fs.readFileSync(path.join(root, f), 'utf8');
    const names = new Set();
    for (const m of s.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of s.matchAll(/export\s*\{([^}]*)\}/g)) for (const p of m[1].split(',')) { const n = p.trim().split(/\s+as\s+/).pop(); if (n) names.add(n); }
    exportsOf[path.resolve(root, f)] = names;
}
for (const f of files) {
    const s = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of s.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
        if (!m[2].startsWith('.')) continue;
        const t = path.resolve(root, path.dirname(f), m[2]);
        if (!exportsOf[t]) continue;
        for (const p of m[1].split(',')) {
            const n = p.trim().split(/\s+as\s+/)[0].trim();
            if (n && !exportsOf[t].has(n)) { bad++; console.error(`MISSING ${n} in ${m[2]} (imported by ${f})`); }
        }
    }
}
if (bad) { console.error(`${bad} problem(s): the extension would not load.`); process.exit(1); }
console.log(`syntax ok: ${files.length} files parsed, imports resolve`);
