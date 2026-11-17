import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = fileURLToPath(new URL('../', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-pattern-mutations-')));
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
  for (const file of ['src/contracts.js', 'src/repair-patterns.js', 'test/repair-patterns.test.js']) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), readFileSync(join(source, file)));
  }
  const tests = [join(root, 'test/repair-patterns.test.js')];
  const baseline = run(['--test', ...tests], 'baseline');
  assert.equal(baseline.status, 0, baseline.output);
  const mutants = [
    { name: 'failure_counts_as_success', file: 'src/repair-patterns.js',
      old: "  if (value.succeeded !== true) return { counted: true, success: false, reason: 'verified_failure' };",
      replacement: "  if (value.succeeded !== true) return { counted: true, success: true, reason: 'verified_failure' };",
      test: /not ok \d+ - unverified, blocked and unknown outcomes never count/ },
    { name: 'verified_failure_excluded_from_rate', file: 'src/repair-patterns.js',
      old: "  if (value.succeeded !== true) return { counted: true, success: false, reason: 'verified_failure' };",
      replacement: "  if (value.succeeded !== true) return { counted: false, success: false, reason: 'verified_failure' };",
      test: /not ok \d+ - one failure among successes/ },
    { name: 'unknown_counts_as_sample', file: 'src/repair-patterns.js',
      old: "  if (value.status === 'unknown') return { counted: false, success: false, reason: 'unknown_outcome' };",
      replacement: "  if (value.status === 'unknown') return { counted: true, success: false, reason: 'unknown_outcome' };",
      test: /not ok \d+ - rejected evidence stays visible/ },
    { name: 'one_run_manufactures_samples', file: 'src/repair-patterns.js',
      old: '    current.runs.add(entry.taskId);',
      replacement: '    current.runs.add(`${entry.taskId}:${entry.repairId}`);',
      test: /not ok \d+ - repeated repairs inside one run/ },
    { name: 'duplicate_receipt_double_counted', file: 'src/repair-patterns.js',
      old: '    if (current.seenRepairs.has(entry.repairId)) continue;',
      replacement: '    if (false) continue;',
      test: /not ok \d+ - a duplicated receipt is deduplicated/ },
    { name: 'identity_collapses_transient_noise', file: 'src/repair-patterns.js',
      old: "    verifierVersion: value.verifierVersion, trigger: value.trigger, toolName: value.toolName })).digest('hex');",
      replacement: "    verifierVersion: value.verifierVersion, trigger: value.trigger, toolName: value.toolName,\n    noise: value.exitCode ?? null })).digest('hex');",
      test: /not ok \d+ - pattern identity follows what it constrains/ },
    { name: 'candidate_marked_activatable', file: 'src/repair-patterns.js',
      old: '    .map((item) => Object.freeze({ ...item, activatable: false,',
      replacement: '    .map((item) => Object.freeze({ ...item, activatable: true,',
      test: /not ok \d+ - different patterns are aggregated separately/ },
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
  assert.ok(basename(root).startsWith('runtime-pattern-mutations-'));
  rmSync(root, { recursive: true, force: true });
}
