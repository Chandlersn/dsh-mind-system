import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { collectModuleClosure } from './build/module-closure.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-lease-mutations-')));
function run(args, label) {
  const fd = openSync(join(root, `${label}.log`), 'w');
  let result;
  try { result = spawnSync(process.execPath, args, { stdio: ['ignore', fd, fd], timeout: 30_000 }); }
  finally { closeSync(fd); }
  return { status: result.status, error: result.error?.code ?? null,
    output: readFileSync(join(root, `${label}.log`), 'utf8') };
}
try {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  // Stage the real import graph: a hand-written list silently misses new dependencies.
  const testsInOrder = ['test/lease.test.js'];
  for (const file of collectModuleClosure(source, testsInOrder)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), readFileSync(join(source, file)));
  }
  const tests = testsInOrder.map((file) => join(root, file));
  const baseline = run(['--test', ...tests], 'baseline');
  assert.equal(baseline.status, 0, baseline.output);
  const mutants = [
    { name: 'fence_check_ignored', file: 'src/store.js',
      old: '    if (!Number.isSafeInteger(fence) || row.fence !== fence) {',
      replacement: '    if (false) {',
      test: /not ok \d+ - a newer owner supersedes an older fence/ },
    { name: 'lease_acquisition_reuses_fence', file: 'src/store.js',
      old: '      const fence = row.fence + 1;',
      replacement: '      const fence = row.fence;',
      test: /not ok \d+ - a newer owner supersedes an older fence/ },
    { name: 'pause_allows_outstanding_work', file: 'src/store.js',
      old: '      if (unresolved.length) throw error(\'attempt_unresolved\', \'Settle or reconcile outstanding work before pausing.\');',
      replacement: '      if (false) throw error(\'attempt_unresolved\');',
      test: /not ok \d+ - pause refuses outstanding work/ },
    { name: 'resume_does_not_advance_fence', file: 'src/store.js',
      old: '      this.#db.prepare(`UPDATE runs SET status = \'running\', reason = NULL, fence = fence + 1,',
      replacement: '      this.#db.prepare(`UPDATE runs SET status = \'running\', reason = NULL, fence = fence,',
      test: /not ok \d+ - resume requires a fresh fence/ },
    { name: 'resume_ignores_deadline', file: 'src/store.js',
      old: '      if (this.#now() >= task.deadlineAt) throw error(\'budget_exceeded\', \'The task deadline elapsed while paused.\');',
      replacement: '      if (false) throw error(\'budget_exceeded\');',
      test: /not ok \d+ - resume after the deadline is refused/ },
    { name: 'scheduler_ignores_lease_fence', file: 'src/scheduler.js',
      old: '    const version = () => ({ expectedVersion: current().version, ...(fence === undefined ? {} : { fence }) });',
      replacement: '    const version = () => ({ expectedVersion: current().version });',
      test: /not ok \d+ - a superseded scheduler cannot settle/ },
    { name: 'resume_ignores_environment_change', file: 'src/store.js',
      old: '          if (!same) throw error(\'resume_environment_changed\'',
      replacement: '          if (false) throw error(\'resume_environment_changed\'',
      test: /not ok \d+ - resume refuses a changed template or authority/ },
  ];
  const observed = [];
  for (const mutant of mutants) {
    const filename = join(root, mutant.file);
    const original = readFileSync(filename, 'utf8');
    assert.equal(original.split(mutant.old).length, 2, `Mutation must match once: ${mutant.name}`);
    writeFileSync(filename, original.replace(mutant.old, mutant.replacement));
    const syntax = run(['--check', filename], `${mutant.name}-syntax`);
    assert.equal(syntax.status, 0, syntax.output);
    const result = run(['--test', ...tests], mutant.name);
    observed.push({ name: mutant.name, exitCode: result.status,
      killed: result.status === 1 && result.error === null && mutant.test.test(result.output) });
    writeFileSync(filename, original);
  }
  console.log(JSON.stringify({ baselineExitCode: baseline.status, mutants: observed,
    killed: observed.filter((item) => item.killed).length }, null, 2));
  if (observed.some((item) => !item.killed)) process.exitCode = 1;
} finally {
  assert.equal(realpathSync(root), root);
  assert.equal(dirname(root), realpathSync(tmpdir()));
  assert.ok(basename(root).startsWith('runtime-lease-mutations-'));
  rmSync(root, { recursive: true, force: true });
}
