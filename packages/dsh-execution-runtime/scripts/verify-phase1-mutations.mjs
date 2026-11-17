import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = fileURLToPath(new URL('../', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-phase1-mutations-')));
const results = [];
function run(args, label) {
  const logfile = join(root, `${label}.log`);
  const fd = openSync(logfile, 'w');
  let result;
  try { result = spawnSync(process.execPath, args, { stdio: ['ignore', fd, fd], timeout: 30_000 }); }
  finally { closeSync(fd); }
  return { status: result.status, output: readFileSync(logfile, 'utf8'), error: result.error?.code ?? null };
}
try {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const files = ['src/contracts.js', 'src/store.js', 'src/decision-client.js', 'src/admission.js',
    'src/executor.js', 'src/scheduler.js', 'recipes/json-normalize.js', 'test/scheduler.test.js',
    'test/store-runtime.test.js', 'test/admission.test.js', 'test/executor.test.js', 'test/helpers/host.js'];
  for (const relative of files) {
    mkdirSync(dirname(join(root, relative)), { recursive: true });
    writeFileSync(join(root, relative), readFileSync(join(source, relative)));
  }
  const tests = ['test/scheduler.test.js', 'test/store-runtime.test.js', 'test/admission.test.js', 'test/executor.test.js'].map((name) => join(root, name));
  const baseline = run(['--test', ...tests], 'baseline');
  assert.equal(baseline.status, 0, baseline.output);
  const mutants = [
    { name: 'dispatch_recheck_ignored', file: 'src/scheduler.js',
      old: "if (repeated.verdict !== 'allow') fail", replacement: 'if (false) fail',
      test: /not ok \d+ - a changed source while policy waits/ },
    { name: 'effect_downgrade_allowed', file: 'src/admission.js',
      old: 'if (declaredEffects[candidate.toolName] !== candidate.effect)', replacement: 'if (false)',
      test: /not ok \d+ - a write candidate cannot downgrade/ },
    { name: 'verifier_binding_ignored', file: 'src/scheduler.js',
      old: 'if (verification.verifierId !== recipe.verifier.id || verification.verifierVersion !== recipe.verifier.version)',
      replacement: 'if (false)', test: /not ok \d+ - verification cannot use a different registered identity/ },
    { name: 'provider_budget_bypassed', file: 'src/scheduler.js',
      old: "charge('decisionRequests');", replacement: 'void 0;',
      test: /not ok \d+ - zero provider request budget/ },
    { name: 'live_argument_binding_removed', file: 'src/executor.js',
      old: "for (const key of ['callId', 'rootCallId', 'name', 'agent', 'parent', 'arguments', 'token'])",
      replacement: 'for (const key of [])', test: /not ok \d+ - downstream wrappers cannot replace arguments/ },
    { name: 'unobserved_success_accepted', file: 'src/executor.js',
      old: "if (!dispatchEntered) return { ...base, status: 'outcome_unknown',",
      replacement: "if (false) return { ...base, status: 'outcome_unknown',",
      test: /not ok \d+ - a short-circuit success cannot omit/ },
    { name: 'caller_identity_mismatch_accepted', file: 'src/scheduler.js',
      old: 'if (!authority.agent || this.#executor.agent !== authority.agent)', replacement: 'if (false)',
      test: /not ok \d+ - admission and execution reject different caller agents/ },
    { name: 'null_exception_handler_breaks', file: 'src/scheduler.js',
      old: 'const reason = failureCode(failure);', replacement: 'const reason = failure.code;',
      test: /not ok \d+ - prepare rejecting null persists/ },
    { name: 'business_cursor_not_committed', file: 'src/store.js',
      old: '.run(status, reason, state === undefined ? row.state_json : JSON.stringify(state), this.#now(), taskId);',
      replacement: '.run(status, reason, row.state_json, this.#now(), taskId);',
      test: /not ok \d+ - outcome and business cursor update/ },
  ];
  for (const mutant of mutants) {
    const filename = join(root, mutant.file);
    const original = readFileSync(filename, 'utf8');
    assert.equal(original.split(mutant.old).length, 2, `Mutation must match once: ${mutant.name}`);
    writeFileSync(filename, original.replace(mutant.old, mutant.replacement));
    const syntax = run(['--check', filename], `${mutant.name}-syntax`);
    assert.equal(syntax.status, 0, syntax.output);
    const observed = run(['--test', ...tests], mutant.name);
    results.push({ name: mutant.name, killed: observed.status === 1 && observed.error === null
      && mutant.test.test(observed.output), exitCode: observed.status });
    writeFileSync(filename, original);
  }
  console.log(JSON.stringify({ baselineExitCode: baseline.status, mutants: results,
    killed: results.filter((result) => result.killed).length }, null, 2));
  if (results.some((result) => !result.killed)) process.exitCode = 1;
} finally {
  assert.equal(realpathSync(root), root);
  assert.equal(dirname(root), realpathSync(tmpdir()));
  assert.ok(basename(root).startsWith('runtime-phase1-mutations-'));
  rmSync(root, { recursive: true, force: true });
}
