import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { collectModuleClosure } from './build/module-closure.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-repair-mutations-')));
function run(args, label) {
  const fd = openSync(join(root, `${label}.log`), 'w');
  let result;
  try { result = spawnSync(process.execPath, args, { stdio: ['ignore', fd, fd], timeout: 30_000 }); }
  finally { closeSync(fd); }
  return { status: result.status, error: result.error?.code ?? null, output: readFileSync(join(root, `${label}.log`), 'utf8') };
}
try {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  // Stage the real import graph: a hand-written list silently misses new dependencies.
  const testsInOrder = ['test/repair.test.js', 'test/store-repair.test.js', 'test/probes.test.js'];
  for (const file of collectModuleClosure(source, testsInOrder)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), readFileSync(join(source, file)));
  }
  const tests = testsInOrder.map((file) => join(root, file));
  const baseline = run(['--test', ...tests], 'baseline');
  assert.equal(baseline.status, 0, baseline.output);
  const mutants = [
    { name: 'repair_policy_replaces_goal_verifier', file: 'src/scheduler.js',
      old: 'postconditionIds: baseRecipe.postconditionIds, verifier: baseRecipe.verifier,',
      replacement: 'postconditionIds: baseRecipe.postconditionIds, verifier: policy.verifier ?? baseRecipe.verifier,',
      test: /not ok \d+ - repair policy cannot replace the fixed goal verifier/ },
    { name: 'repeated_repair_failure_never_stops', file: 'src/store.js',
      old: 'const limited = this.getRepairFailures(taskId, repair.signature) >= 2;', replacement: 'const limited = false;',
      test: /not ok \d+ - two actual failed repairs of the same native signature/ },
    { name: 'cancelled_repair_cannot_settle', file: 'src/store.js',
      old: "'failed', 'waiting_human', 'cancelled'].includes(row.status)", replacement: "'failed', 'waiting_human'].includes(row.status)",
      test: /not ok \d+ - caller cancellation during pre-execution settles the repair/ },
    { name: 'stale_artifact_enters_repair_body', file: 'recipes/json-repair.js',
      old: 'return digest(io.readFileSync(context.outputPath)) === context.observedSha256;', replacement: 'return true;',
      test: /not ok \d+ - changed artifact after analysis is not overwritten/ },
    { name: 'repair_history_ignored_by_next_choice', file: 'recipes/json-normalize.js',
      old: '    if (previous.length) {', replacement: '    if (false) {',
      test: /not ok \d+ - the plain recipe refuses to regenerate its original action/ },
    { name: 'probe_result_not_persisted', file: 'src/probes.js',
      old: '    const stored = putEvidence(`probe:${probeId}`, value);',
      replacement: '    const stored = { ref: `runtime-evidence:00000000-0000-0000-0000-000000000000#sha256:${"0".repeat(64)}`, bytes: 0 };',
      test: /not ok \d+ - a registered read-only probe records task evidence/ },
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
  assert.ok(basename(root).startsWith('runtime-repair-mutations-'));
  rmSync(root, { recursive: true, force: true });
}
