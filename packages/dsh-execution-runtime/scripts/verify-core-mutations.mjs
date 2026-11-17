import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = fileURLToPath(new URL('../', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'runtime-mutations-'));
const verifiedRoot = realpathSync(root);
const results = [];

function run(args, label) {
  const logfile = join(root, `${label}.log`);
  const fd = openSync(logfile, 'w');
  let result;
  try { result = spawnSync(process.execPath, args, { stdio: ['ignore', fd, fd], timeout: 15_000 }); }
  finally { closeSync(fd); }
  return { status: result.status, output: readFileSync(logfile, 'utf8'), error: result.error?.code ?? null };
}

try {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  for (const relative of ['src/contracts.js', 'src/store.js', 'src/analyzer.js', 'recipes/json-normalize.js', 'test/store.test.js', 'test/json-recipe.test.js']) {
    mkdirSync(dirname(join(root, relative)), { recursive: true });
    writeFileSync(join(root, relative), readFileSync(join(source, relative)));
  }
  const tests = [join(root, 'test/store.test.js'), join(root, 'test/json-recipe.test.js')];
  const baseline = run(['--test', ...tests], 'baseline');
  assert.equal(baseline.status, 0, baseline.output);
  const mutants = [
    {
      name: 'unknown_outcome_keeps_running', file: 'src/store.js',
      old: "const status = unknown ? 'reconciling'", replacement: "const status = unknown ? 'running'",
      test: /not ok \d+ - live acknowledgement uncertainty/,
    },
    {
      name: 'dispatch_budget_allows_one_extra', file: 'src/store.js',
      old: 'row.attempts_used >= task.budget.maxAttempts\n        || row.tool_calls_used >= task.budget.maxToolCalls',
      replacement: 'row.attempts_used > task.budget.maxAttempts\n        || row.tool_calls_used > task.budget.maxToolCalls',
      test: /not ok \d+ - a stale writer and exhausted reservation/,
    },
    {
      name: 'partial_transaction_is_committed', file: 'src/store.js',
      old: "if (this.#db.isTransaction) this.#db.exec('ROLLBACK');",
      replacement: "if (this.#db.isTransaction) this.#db.exec('COMMIT');",
      test: /not ok \d+ - transaction failure rolls back/,
    },
    {
      name: 'bad_output_marked_pass', file: 'recipes/json-normalize.js',
      old: "return { status: valid ? 'pass' : 'fail'", replacement: "return { status: true ? 'pass' : 'fail'",
      test: /not ok \d+ - a tool success claim cannot hide wrong names/,
    },
  ];
  for (const mutant of mutants) {
    const filename = join(root, mutant.file);
    const original = readFileSync(filename, 'utf8');
    assert.equal(original.split(mutant.old).length, 2, `The mutation target must match exactly once: ${mutant.name}`);
    writeFileSync(filename, original.replace(mutant.old, mutant.replacement));
    const syntax = run(['--check', filename], `${mutant.name}-syntax`);
    assert.equal(syntax.status, 0, syntax.output);
    const observed = run(['--test', ...tests], mutant.name);
    const killed = observed.status === 1 && observed.error === null && mutant.test.test(observed.output);
    results.push({ name: mutant.name, killed, exitCode: observed.status });
    writeFileSync(filename, original);
  }
  console.log(JSON.stringify({ baselineExitCode: baseline.status, mutants: results, killed: results.filter((item) => item.killed).length }, null, 2));
  if (results.some((item) => !item.killed)) process.exitCode = 1;
} finally {
  assert.equal(realpathSync(root), verifiedRoot);
  assert.equal(dirname(verifiedRoot), realpathSync(tmpdir()));
  assert.ok(basename(verifiedRoot).startsWith('runtime-mutations-'));
  rmSync(verifiedRoot, { recursive: true, force: true });
}
