/**
 * Collect the module graph a test entry actually needs, so a mutation script cannot silently drift
 * behind a new import. Manual file lists were the recurring failure: adding one dependency broke the
 * baseline and looked like a functional regression.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const IMPORT = /(?:^|[\s;{(])(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;

const isFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } };

/** Resolve `./x` or `./x.js` relative to the importing file, preferring an exact file first. */
function resolveSpecifier(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.js`, join(base, 'index.js')]) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Walk static and dynamic relative imports from the given entries and return repo-relative paths.
 * Node builtins and bare package names are skipped: only files that must be staged are collected.
 */
export function collectModuleClosure(sourceRoot, entries) {
  const seen = new Set();
  const queue = [];
  for (const entry of entries) {
    const absolute = resolve(sourceRoot, entry);
    if (!existsSync(absolute)) throw new Error(`Entry not found: ${entry}`);
    queue.push(absolute);
    seen.add(absolute);
  }
  while (queue.length) {
    const file = queue.pop();
    if (!file.endsWith('.js') && !file.endsWith('.mjs')) continue;
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(IMPORT)) {
      const specifier = match[1] ?? match[2];
      if (!specifier || !specifier.startsWith('.')) continue;
      const resolved = resolveSpecifier(file, specifier);
      if (!resolved || seen.has(resolved)) continue;
      seen.add(resolved);
      queue.push(resolved);
    }
  }
  // Sorting keeps generated logs and diffs stable.
  return [...seen].map((absolute) => absolute.slice(resolve(sourceRoot).length + 1).replaceAll('\\', '/')).sort();
}
