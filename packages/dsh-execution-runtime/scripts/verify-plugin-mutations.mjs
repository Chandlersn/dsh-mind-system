import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = fileURLToPath(new URL('../', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-plugin-mutations-')));
function run(args, label) {
  const fd = openSync(join(root, `${label}.log`), 'w');
  let result;
  try { result = spawnSync(process.execPath, args, { stdio: ['ignore', fd, fd], timeout: 60_000 }); }
  finally { closeSync(fd); }
  return { status: result.status, error: result.error?.code ?? null,
    output: readFileSync(join(root, `${label}.log`), 'utf8') };
}
try {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  for (const file of ['src/contracts.js', 'src/analyzer.js', 'src/store.js', 'src/admission.js', 'src/executor.js',
    'src/decision-client.js', 'src/scheduler.js', 'src/probes.js', 'src/compensation.js', 'src/exceptions.js',
    'src/plugin.js', 'recipes/json-normalize.js', 'recipes/json-repair.js',
    'test/helpers/host.js', 'test/plugin.test.js']) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), readFileSync(join(source, file)));
  }
  const tests = [join(root, 'test/plugin.test.js')];
  const baseline = run(['--test', ...tests], 'baseline');
  assert.equal(baseline.status, 0, baseline.output);
  const mutants = [
    { name: 'unknown_task_reference_allowed', file: 'src/plugin.js',
      old: "      if (typeof factory !== 'function') fail('task_not_registered'",
      replacement: "      if (false) fail('task_not_registered'",
      test: /not ok \d+ - a model may only run natively registered tasks/ },
    { name: 'anonymous_caller_accepted', file: 'src/plugin.js',
      old: "      if (!exec?.agent) fail('authority_unavailable'",
      replacement: "      if (false) fail('authority_unavailable'",
      test: /not ok \d+ - a task-level tool refuses to run without an identified caller/ },
    { name: 'unload_does_not_mark_unloaded', file: 'src/plugin.js',
      old: "        lastProbe = { plugin: 'execution-runtime', status: 'ok',\n          findings: [{ code: 'execution-runtime.unloaded', severity: 'info',",
      replacement: "        lastProbe = { plugin: 'execution-runtime', status: 'ok',\n          findings: [{ code: 'execution-runtime.loaded', severity: 'info',",
      test: /not ok \d+ - the host stays usable after the plugin is unloaded/ },
    { name: 'probe_reports_ok_before_apply', file: 'src/plugin.js',
      old: '        if (!lastProbe) {',
      replacement: '        if (false) {',
      test: /not ok \d+ - the probe reports a not-applied state/ },
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
  assert.ok(basename(root).startsWith('runtime-plugin-mutations-'));
  rmSync(root, { recursive: true, force: true });
}
