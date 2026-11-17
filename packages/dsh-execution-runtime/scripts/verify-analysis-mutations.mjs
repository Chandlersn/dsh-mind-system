import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { collectModuleClosure } from './build/module-closure.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-analysis-mutations-')));
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
  const testsInOrder = ['test/analyzer.test.js', 'test/exceptions.test.js', 'test/store-analysis.test.js'];
  for (const file of collectModuleClosure(source, testsInOrder)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), readFileSync(join(source, file)));
  }
  const tests = testsInOrder.map((file) => join(root, file));
  const baseline = run(['--test', ...tests], 'baseline');
  assert.equal(baseline.status, 0, baseline.output);
  const mutants = [
    { name: 'array_kind_coercion_allowed', file: 'src/analyzer.js',
      old: "typeof value.kind !== 'string' || ", replacement: '',
      test: /not ok \d+ - array discriminators cannot coerce/ },
    { name: 'diagnosis_evidence_forged', file: 'src/analyzer.js',
      old: 'if (value.diagnosis.evidenceRefs.some((ref) => !allowedEvidenceRefs.includes(ref)))', replacement: 'if (false)',
      test: /not ok \d+ - repair rejects forged references/ },
    { name: 'analysis_ref_allowlist_removed', file: 'src/store.js',
      old: "if (!JSON.parse(analysis.evidence_refs_json).includes(ref) || !/^runtime-evidence:[0-9a-f-]{36}#sha256:[0-9a-f]{64}$/.test(ref))",
      replacement: 'if (false)', test: /not ok \d+ - evidence allowlists enforce unique bounded refs/ },
    { name: 'late_task_proposal_accepted', file: 'src/exceptions.js',
      old: 'if (this.#now() >= run.task.deadlineAt || this.#monotonicNow() >= deadlineMono)', replacement: 'if (false)',
      test: /not ok \d+ - task deadline is checked after transport return/ },
    // G-3: the "wrong artifact triggers analysis" case must die when the goal verifier is weakened.
    { name: 'goal_verifier_always_passes', file: 'recipes/json-normalize.js',
      old: "return { status: valid ? 'pass' : 'fail', progress: valid ? 'advanced' : 'unchanged', goalSatisfied: valid,",
      replacement: "return { status: 'pass', progress: 'advanced', goalSatisfied: true,",
      test: /not ok \d+ - an actual wrong artifact invokes analysis once/ },
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
  assert.ok(basename(root).startsWith('runtime-analysis-mutations-'));
  rmSync(root, { recursive: true, force: true });
}
