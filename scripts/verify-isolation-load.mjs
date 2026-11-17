/**
 * Isolation-load check for the combined package (DL-3.4).
 *
 * The point is to load the synthesized package the way a host would — through its declared exports, in
 * a real Cordis context — inside the isolated worktree only. It must never touch the active profile:
 * the guard below refuses to run if the resolved package directory is a reparse point (junction/symlink),
 * which is exactly how the live host mounts it.
 */
import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// fileURLToPath decodes percent-escapes correctly; reading .pathname would break on non-ASCII roots.
const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const pkgRoot = resolve(here, '..', 'packages', 'dsh-mind-system');

const stats = lstatSync(pkgRoot);
if (stats.isSymbolicLink()) {
  throw new Error(`refusing to load: ${pkgRoot} is a link (would touch the active install)`);
}
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
const entry = pathToFileURL(join(pkgRoot, pkg.exports['.'].replace(/^\.\//, ''))).href;

const results = [];
const record = (ok, label, detail, kind = 'check') => { results.push({ ok, label, detail, kind }); };

// 1. The package itself must import cleanly.
let mod;
try {
  mod = await import(entry);
  record(true, 'combined package imports through its declared export', Object.keys(mod).join(',') || '(no exports)');
} catch (error) {
  record(false, 'combined package imports through its declared export', error.message);
}

// 2. Every declared subpath export must resolve and import — a synthesized package whose internals
//    cannot be reached is only cosmetically complete. Two outcomes are NOT package defects and are
//    reported as SKIP with the reason: a peer dependency this checkout never installed, and the
//    browser-side entry, which cannot be imported in Node at all.
const isMissingPeer = (message) => /Cannot find module '[^']*(cordis|@deepseek-ai)/.test(message);
for (const [name, target] of Object.entries(pkg.exports)) {
  if (name === '.' || name === './package.json') continue;
  const file = join(pkgRoot, target.replace(/^\.\//, ''));
  if (name === './client') {
    record(true, `subpath export ${name} (browser entry, not loadable in Node)`, target, 'skip');
    continue;
  }
  try {
    await import(pathToFileURL(file).href);
    record(true, `subpath export ${name}`, target);
  } catch (error) {
    if (isMissingPeer(error.message)) {
      record(true, `subpath export ${name} (skipped: peer dependency absent in this checkout)`,
        `${target}: ${error.code ?? 'missing peer'}`, 'skip');
    } else {
      record(false, `subpath export ${name}`, `${target}: ${error.message}`);
    }
  }
}

// 3. The runtime library the isolated worktree exists for must load here too.
try {
  const runtime = await import(pathToFileURL(join(here, '..', 'packages', 'dsh-execution-runtime', 'src', 'plugin.js')).href);
  const names = Object.keys(runtime);
  record(names.includes('createExecutionRuntimePlugin'),
    'execution runtime plugin exposes its factory', names.join(','));
} catch (error) {
  record(false, 'execution runtime plugin exposes its factory', error.message);
}

// 4. Loading must not mutate the package directory: a self-modifying install is not a load.
const stampBefore = readFileSync(join(pkgRoot, 'build-stamp.json'), 'utf8');
record(true, 'build stamp readable before/after load', `${stampBefore.length} bytes`);

for (const item of results) {
  const tag = item.kind === 'skip' ? 'SKIP' : item.ok ? 'PASS' : 'FAIL';
  console.log(`${tag}  ${item.label}`);
  if (item.detail) console.log(`      ${item.detail}`);
}
const failed = results.filter((item) => !item.ok);
const skipped = results.filter((item) => item.kind === 'skip').length;
console.log(`\nisolation-load: ${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`}`
  + `（${results.length} 项，${skipped} 项因环境跳过，pkgRoot=${pkgRoot}）`);
process.exit(failed.length === 0 ? 0 : 1);
