import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { collectModuleClosure } from './build/module-closure.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-compensation-mutations-')));
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
  const testsInOrder = ['test/compensation.test.js'];
  for (const file of collectModuleClosure(source, testsInOrder)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), readFileSync(join(source, file)));
  }
  const tests = testsInOrder.map((file) => join(root, file));
  const baseline = run(['--test', ...tests], 'baseline');
  assert.equal(baseline.status, 0, baseline.output);
  const mutants = [
    { name: 'compensation_completes_without_target_fact', file: 'src/compensation.js',
      old: '  if (observedAfterSha256 !== plan.expectedAfterSha256) {',
      replacement: '  if (false) {',
      test: /not ok \d+ - completion requires a passing target verification/ },
    { name: 'irreversible_effect_compensable', file: 'src/compensation.js',
      old: "  if (!['read', 'reversible_write'].includes(effect)) {",
      replacement: '  if (false) {',
      test: /not ok \d+ - irreversible and unknown effects/ },
    { name: 'plan_may_retarget_tool', file: 'src/compensation.js',
      old: '  if (checked.targetTool !== candidate.toolName) {',
      replacement: '  if (false) {',
      test: /not ok \d+ - a plan cannot retarget another tool/ },
    { name: 'store_records_completion_without_fact', file: 'src/store.js',
      old: "    if (input.status === 'completed' && input.verifiedByTarget !== true) {",
      replacement: '    if (false) {',
      test: /not ok \d+ - only target-verified compensation/ },
    { name: 'failed_compensation_reports_finished_rollback', file: 'src/store.js',
      old: "      const nextStatus = completed ? row.status : row.status === 'running' ? 'waiting_human' : row.status;",
      replacement: '      const nextStatus = completed ? row.status : row.status === \'running\' ? \'completed\' : row.status;',
      test: /not ok \d+ - a failed compensation on a running task/ },
    { name: 'compensation_skips_recovery_reserve', file: 'src/store.js',
      old: "      this.#chargeRecoveryWithinTx(taskId, { column: 'compensations_used',\n        limitName: 'maxCompensations', kind: 'compensation' });",
      replacement: '      void 0;',
      test: /not ok \d+ - the compensation reserve bounds recovery attempts/ },
    { name: 'exhaustion_not_persisted', file: 'src/store.js',
      old: "        .run(nextStatus, 'recovery_exhausted', this.#now(), taskId);",
      replacement: '        .run(nextStatus, row.reason, this.#now(), taskId);',
      test: /not ok \d+ - the compensation reserve bounds recovery attempts/ },
    // The generic builder must bind the plan to the verifier the caller observed, not accept any attempt.
    { name: 'compensation_accepts_foreign_verifier', file: 'src/compensation.js',
      old: '  if (observed.verifierId !== verifierId) {',
      replacement: '  if (false) {',
      test: /not ok \d+ - a compensation cannot be built from a different template/ },
    // And it must not be possible to name one verifier while observing another.
    { name: 'json_wrapper_ignores_its_own_binding', file: 'src/compensation.js',
      old: "  return buildCompensation({ ...input, verifierId: 'json-source-output', targetTool: 'runtime.replace_json' });",
      replacement: "  return buildCompensation({ ...input, verifierId: input.verifierId ?? 'json-source-output', targetTool: 'runtime.replace_json' });",
      test: /not ok \d+ - the JSON wrapper cannot be talked out of its own verifier binding/ },
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
  assert.ok(basename(root).startsWith('runtime-compensation-mutations-'));
  rmSync(root, { recursive: true, force: true });
}
