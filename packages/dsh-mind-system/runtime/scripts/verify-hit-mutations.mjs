import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { collectModuleClosure } from './build/module-closure.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-hit-mutations-')));
function run(args, label) {
  const fd = openSync(join(root, `${label}.log`), 'w');
  let result;
  try { result = spawnSync(process.execPath, args, { stdio: ['ignore', fd, fd], timeout: 180_000 }); }
  finally { closeSync(fd); }
  return { status: result.status, error: result.error?.code ?? null,
    output: readFileSync(join(root, `${label}.log`), 'utf8') };
}
try {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  // Stage the real import graph: a hand-written list silently misses new dependencies.
  const testsInOrder = ['test/pattern-runtime.test.js', 'test/pattern-integration.test.js'];
  for (const file of collectModuleClosure(source, testsInOrder)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), readFileSync(join(source, file)));
  }
  const tests = testsInOrder.map((file) => join(root, file));
  const baseline = run(['--test', ...tests], 'baseline');
  assert.equal(baseline.status, 0, baseline.output);
  const mutants = [
    { name: 'abstention_suppresses_analysis', file: 'src/pattern-runtime.js',
      old: '    return Object.freeze({ hit: false, reason: checked.reason, analysesSuppressed: false });',
      replacement: '    return Object.freeze({ hit: false, reason: checked.reason, analysesSuppressed: true });',
      test: /not ok \d+ - an unapproved, pending or revoked pattern abstains/ },
    { name: 'out_of_scope_tool_ignored', file: 'src/pattern-runtime.js',
      old: "    if (expected !== undefined && expected !== context[key]) {",
      replacement: "    if (false) {",
      test: /not ok \d+ - a different scope, trigger or tool is out of scope/ },
    { name: 'template_version_change_ignored', file: 'src/pattern-runtime.js',
      old: "  if (pattern.recipeVersion !== undefined && pattern.recipeVersion !== context.recipeVersion) {",
      replacement: '  if (false) {',
      test: /not ok \d+ - a changed template version abstains/ },
    { name: 'insufficient_evidence_hits', file: 'src/pattern-runtime.js',
      old: "  if (evidence?.eligible !== true || (evidence.independentRuns ?? 0) < (evidence.minRuns ?? 0)) {",
      replacement: '  if (false) {',
      test: /not ok \d+ - insufficient evidence abstains/ },
    { name: 'rollback_restores_ticket', file: 'src/pattern-runtime.js',
      old: '    requiresReview: true, supersededVersion: current ?? null });',
      replacement: '    requiresReview: false, supersededVersion: current ?? null });',
      test: /not ok \d+ - a rollback restores the version but demands a fresh review/ },
    { name: 'fabricated_hit_recorded', file: 'src/pattern-runtime.js',
      old: "  if (!hit || hit.hit !== true) fail('invalid_pattern_hit'",
      replacement: "  if (false) fail('invalid_pattern_hit'",
      test: /not ok \d+ - a hit record cannot be fabricated/ },
    { name: 'abstention_not_recorded', file: 'src/exceptions.js',
      old: '        const updated = this.#store.observe(taskId, \'pattern_abstained\'',
      replacement: '        const updated = { version: run.version }, _ignored = this.#store.observe(taskId, \'pattern_abstained\'',
      test: /not ok \d+ - an abstaining pattern still lets analysis run/ },
    { name: 'hit_still_calls_analyzer', file: 'src/exceptions.js',
      old: "        return { status: 'pattern_applied', run: this.#store.getRun(taskId), decision };",
      replacement: '        void decision;',
      test: /not ok \d+ - an approved pattern answers the sixth case/ },
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
  assert.ok(basename(root).startsWith('runtime-hit-mutations-'));
  rmSync(root, { recursive: true, force: true });
}
