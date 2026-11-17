import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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
  for (const file of ['src/contracts.js', 'src/analyzer.js', 'src/store.js', 'src/compensation.js',
    'test/compensation.test.js']) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), readFileSync(join(source, file)));
  }
  const tests = [join(root, 'test/compensation.test.js')];
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
