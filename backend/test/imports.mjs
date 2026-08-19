#!/usr/bin/env node
/**
 * Check that every named import actually exists in the module it comes from.
 *
 * `node --check` only validates syntax, so a refactor that renames or moves an
 * export passes it and then fails at boot with "does not provide an export
 * named X". That has bitten this project, so it gets a check of its own.
 *
 *   node backend/test/imports.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.name.endsWith('.js') ? [full] : [];
  });
}

/** Names a module exports, including `export { a, b }` re-export lists. */
function exportsOf(source) {
  const names = new Set();
  for (const m of source.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/g)) {
    names.add(m[1]);
  }
  for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  if (/export\s+\*/.test(source)) names.add('*');
  return names;
}

const cache = new Map();
const exportsFor = (file) => {
  if (!cache.has(file)) cache.set(file, exportsOf(fs.readFileSync(file, 'utf8')));
  return cache.get(file);
};

const problems = [];
const files = walk(root);

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  for (const m of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(file), m[2]);
    const rel = path.relative(root, file);
    if (!fs.existsSync(target)) {
      problems.push(`${rel}: imports from ${m[2]}, which does not exist`);
      continue;
    }
    const available = exportsFor(target);
    if (available.has('*')) continue;
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (!name || available.has(name)) continue;
      problems.push(`${rel}: imports "${name}" from ${m[2]}, which does not export it`);
    }
  }
}

console.log(`checked ${files.length} modules`);
if (problems.length === 0) {
  console.log('every named import resolves');
  process.exit(0);
}
for (const p of problems) console.log(`  ${p}`);
console.log(`${problems.length} broken import(s)`);
process.exit(1);
