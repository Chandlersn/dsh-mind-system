import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = fileURLToPath(new URL('../', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-recovery-mutations-')));
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
  for (const file of ['src/contracts.js', 'src/store.js', 'src/admission.js', 'src/executor.js',
    'src/decision-client.js', 'src/scheduler.js', 'src/analyzer.js', 'src/exceptions.js', 'src/probes.js',
    'recipes/json-normalize.js', 'recipes/json-repair.js', 'test/helpers/host.js', 'test/recovery.test.js']) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), readFileSync(join(source, file)));
  }
  const tests = [join(root, 'test/recovery.test.js')];
  const baseline = run(['--test', ...tests], 'baseline');
  assert.equal(baseline.status, 0, baseline.output);
  const mutants = [
    { name: 'unknown_effect_unfrozen', file: 'src/store.js',
      old: "const unknown = outcome.status === 'outcome_unknown' || verification.status === 'unknown';",
      replacement: 'const unknown = false;',
      test: /not ok \d+ - a crash-like unknown effect stays frozen/ },
    { name: 'reconciliation_claims_goal_success', file: 'src/store.js',
      old: "const verification = validateVerification({ status: 'unknown', progress: 'unknown', goalSatisfied: null,",
      replacement: "const verification = validateVerification({ status: 'pass', progress: 'advanced', goalSatisfied: true,",
      test: /not ok \d+ - a crash-like unknown effect stays frozen/ },
    { name: 'idempotency_key_ignored', file: 'src/store.js',
      old: '        if (claimed) throw error(\'idempotency_conflict\'',
      replacement: '        if (false) throw error(\'idempotency_conflict\'',
      test: /not ok \d+ - reserving a verified applied effect again/ },
    { name: 'reconciliation_without_evidence', file: 'src/scheduler.js',
      old: "      if (typeof item.evidenceRef !== 'string' || !item.evidenceRef || item.evidenceRef.length > 1024) {",
      replacement: '      if (false) {',
      test: /not ok \d+ - reconciliation cannot invent success/ },
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
  assert.ok(basename(root).startsWith('runtime-recovery-mutations-'));
  rmSync(root, { recursive: true, force: true });
}
