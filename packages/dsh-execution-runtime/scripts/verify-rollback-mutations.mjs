import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { collectModuleClosure } from './build/module-closure.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-rollback-mutations-')));
function run(args, label) {
  const fd = openSync(join(root, `${label}.log`), 'w');
  let result;
  try { result = spawnSync(process.execPath, args, { stdio: ['ignore', fd, fd], timeout: 120_000 }); }
  finally { closeSync(fd); }
  return { status: result.status, error: result.error?.code ?? null,
    output: readFileSync(join(root, `${label}.log`), 'utf8') };
}
try {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  // Stage the real import graph: a hand-written list silently misses new dependencies.
  const testsInOrder = ['test/rollback.test.js'];
  for (const file of collectModuleClosure(source, testsInOrder)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), readFileSync(join(source, file)));
  }
  const tests = testsInOrder.map((file) => join(root, file));
  const baseline = run(['--test', ...tests], 'baseline');
  assert.equal(baseline.status, 0, baseline.output);
  const mutants = [
    { name: 'irreversible_rollback_allowed', file: 'src/rollback.js',
      old: "  if (effect === 'irreversible' || effect === 'unknown') {",
      replacement: '  if (false) {',
      test: /not ok \d+ - irreversible and unknown effects can never be rolled back/ },
    { name: 'reversible_without_compensation', file: 'src/rollback.js',
      old: '  if (!compensation) {',
      replacement: '  if (false) {',
      test: /not ok \d+ - a reversible write without a registered compensation/ },
    { name: 'changed_environment_restored', file: 'src/rollback.js',
      old: '    if (checkpoint.environment[key] !== current[key]) {',
      replacement: '    if (false) {',
      test: /not ok \d+ - a checkpoint from a changed environment/ },
    { name: 'rollback_settles_without_target_fact', file: 'src/rollback.js',
      old: '  if (assessed.completed) {',
      replacement: '  if (true) {',
      test: /not ok \d+ - a reversible rollback is complete only when the target fact confirms it/ },
    { name: 'checkpoint_without_environment', file: 'src/rollback.js',
      old: "  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {",
      replacement: '  if (false) {',
      test: /not ok \d+ - a checkpoint requires an environment/ },
    { name: 'invalid_compensation_accepted', file: 'src/rollback.js',
      old: "    return Object.freeze({ allowed: false, reason: 'compensation_invalid', requiresCompensation: true });",
      replacement: "    return Object.freeze({ allowed: true, reason: 'compensation_invalid', requiresCompensation: true });",
      test: /not ok \d+ - an invalid compensation is refused/ },
    // The runtime must actually record checkpoints: a rollback module nothing calls proves nothing.
    { name: 'pipeline_records_no_checkpoint', file: 'src/scheduler.js',
      old: '          this.#store.recordCheckpoint(task.taskId, {',
      replacement: '          if (false) this.#store.recordCheckpoint(task.taskId, {',
      test: /not ok \d+ - the running pipeline records a checkpoint/ },
    { name: 'checkpoint_recorded_without_verification', file: 'src/scheduler.js',
      old: "        if (verification.status === 'pass' && verification.evidenceRefs.length) {",
      replacement: '        if (true) {',
      test: /not ok \d+ - a failed or unverified step records no checkpoint/ },
    // The dispatch half: persisting a rollback must actually restore the cursor and re-verify it.
    { name: 'rollback_dispatch_not_wired', file: 'src/scheduler.js',
      old: "        if (!['retry_with', 'abort', 'gather_evidence', 'rollback_to'].includes(proposal.kind)) fail('repair_branch_unavailable', 'This repair branch requires its dedicated native controller.');",
      replacement: "        if (!['retry_with', 'abort', 'gather_evidence'].includes(proposal.kind)) fail('repair_branch_unavailable', 'This repair branch requires its dedicated native controller.');",
      test: /not ok \d+ - a persisted rollback_to proposal restores the recorded cursor/ },
    { name: 'rollback_restores_without_writing', file: 'src/store.js',
      old: '        .run(JSON.stringify(checkpoint.state), this.#now(), taskId);',
      replacement: '        .run(JSON.stringify(this.getRun(taskId).state), this.#now(), taskId);',
      test: /not ok \d+ - a persisted rollback_to proposal restores the recorded cursor/ },
    { name: 'rollback_ignores_irreversible_effects', file: 'src/scheduler.js',
      old: "          const blockers = [...new Set(effects.filter((effect) => !['read', 'reversible_write'].includes(effect)))];",
      replacement: '          const blockers = [];',
      test: /not ok \d+ - an irreversible effect recorded after the checkpoint refuses/ },
    { name: 'rollback_reported_without_reverification', file: 'src/scheduler.js',
      old: "        this.#store.finishRepair(task.taskId, repairId, verification.status === 'pass' && settled.completed",
      replacement: '        this.#store.finishRepair(task.taskId, repairId, settled.completed',
      test: /not ok \d+ - a restore whose re-verification fails/ },
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
  assert.ok(basename(root).startsWith('runtime-rollback-mutations-'));
  rmSync(root, { recursive: true, force: true });
}
