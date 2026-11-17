import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { collectModuleClosure } from './build/module-closure.mjs';

// Same layout as the other mutation suites: `../` from scripts/ is the package root, and the staging
// copy reuses the real import closure so a new dependency can never be silently left behind.
const source = fileURLToPath(new URL('../', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-loop-mutations-')));
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
  const testsInOrder = ['test/pattern-resolver.test.js', 'test/csv-recipe.test.js', 'test/pattern-automation.test.js'];
  for (const file of collectModuleClosure(source, testsInOrder)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), readFileSync(join(source, file)));
  }
  const tests = testsInOrder.map((file) => join(root, file));
  const baseline = run(['--test', ...tests], 'baseline');
  assert.equal(baseline.status, 0, baseline.output);
  const mutants = [
    // Activation must never be inferred from evidence alone: with no policy and no ticket, abstain.
    { name: 'reuse_without_approval', file: 'src/pattern-resolver.js',
      old: '        if (automation === null) continue;',
      replacement: '        if (automation === null) return Object.freeze({ patternId: candidate.patternId, decision: { hit: true } });',
      test: /not ok \d+ - the same evidence reuses nothing when automation stays off/ },
    // One run repairing itself must not count as independent evidence.
    { name: 'self_repair_counts_as_independence', file: 'src/repair-patterns.js',
      old: '    current.runs.add(entry.taskId);',
      replacement: '    current.runs.add(entry.taskId + Math.random());',
      test: /not ok \d+ - one task repairing itself repeatedly/ },
    // A changed template version is a new environment.
    { name: 'pattern_version_ignored', file: 'src/pattern-runtime.js',
      old: '  if (pattern.recipeVersion !== undefined && pattern.recipeVersion !== context.recipeVersion) {',
      replacement: '  if (false) {',
      test: /not ok \d+ - a changed recipe version is out of scope/ },
    // Revoked tickets must not keep working. Dropping the resolver's status filter is not enough (the
    // approval check also refuses it), so the mutant has to break the approval gate itself.
    { name: 'revoked_approval_still_applies', file: 'src/pattern-approval.js',
      old: "  if (!approval || approval.status !== 'confirmed') return { applies: false, reason: 'not_confirmed' };",
      replacement: "  if (!approval || !['confirmed', 'revoked'].includes(approval.status)) return { applies: false, reason: 'not_confirmed' };",
      test: /not ok \d+ - revocation is enforced by the approval gate itself/ },
    // Failures must stay in the denominator.
    { name: 'failed_repair_leaves_denominator', file: 'src/repair-patterns.js',
      old: '    if (classified.success) current.successes += 1;',
      replacement: '    if (classified.success) current.successes += 1; else current.samples -= 1;',
      test: /not ok \d+ - failures count against the success rate/ },
    // The resolver must not synthesize a pattern body it was never given.
    { name: 'resolver_invents_pattern_body', file: 'src/pattern-resolver.js',
      old: '      if (approved === null) continue;',
      replacement: '      if (approved === null) { if (candidate.eligible) return Object.freeze({ patternId: candidate.patternId, decision: { hit: true } }); continue; }',
      test: /not ok \d+ - an approval without its reviewed body/ },
    // The CSV verifier must compare content, not merely trust a parseable file. The mutant has to disable
    // the whole comparison: replacing only the first conjunct leaves `actual.every(...)` enforcing it.
    { name: 'csv_verifier_accepts_any_parseable_output', file: 'recipes/csv-normalize.js',
      old: '    const valid = actual.length === expected.length\n      && actual.every((row, index) => row.id === expected[index].id && row.name === expected[index].name);',
      replacement: '    const valid = Array.isArray(actual);',
      test: /not ok \d+ - an output that parses but does not match/ },
    // Quoting must be understood rather than passed through.
    { name: 'csv_quoting_not_parsed', file: 'recipes/csv-normalize.js',
      old: "    } else if (char === '\"') {",
      replacement: '    } else if (false) {',
      test: /not ok \d+ - quoting is parsed rather than taken literally/ },
    // A second recipe must exercise its own verifier identity rather than borrowing the JSON one.
    { name: 'csv_recipe_borrows_json_verifier', file: 'recipes/csv-normalize.js',
      old: "export const VERIFIER_ID = 'csv-source-output';",
      replacement: "export const VERIFIER_ID = 'json-source-output';",
      test: /not ok \d+ - a second recipe runs through the unchanged engine/ },
    // The automation must stay opt-in: a default-on policy would silently remove the human gate.
    { name: 'automation_enabled_by_default', file: 'src/pattern-approval.js',
      old: "  if (automation === null || typeof automation !== 'object' || Array.isArray(automation)) {\n    fail('automation_disabled', 'Automatic confirmation must be explicitly enabled by the caller.');\n  }",
      replacement: "  automation = automation ?? { allowAutomatic: true, operator: 'default' };",
      test: /not ok \d+ - there is no implicit enablement/ },
    // A review requirement dropped before the request would let automation confirm it blindly.
    { name: 'review_requirement_dropped', file: 'src/pattern-approval.js',
      old: '    ...(value.requiresHumanReview === true ? { requiresHumanReview: true } : {}),',
      replacement: '    ...({}),',
      test: /not ok \d+ - a pattern that wants human review cannot be auto-confirmed/ },
    // The run requirement is what stops a single task from manufacturing confidence.
    { name: 'automation_ignores_run_requirement', file: 'src/pattern-approval.js',
      old: '  if (independentRuns < minRuns) {',
      replacement: '  if (false) {',
      test: /not ok \d+ - the first evidence is never enough/ },
    // Issuing a ticket must not skip the version binding.
    { name: 'automation_skips_version_binding', file: 'src/pattern-approval.js',
      old: '  if (patternVersionOf(pattern) !== value.patternVersion) {',
      replacement: '  if (false) {',
      test: /not ok \d+ - issuing a ticket refuses a body that is not the one that was requested/ },
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
  assert.ok(basename(root).startsWith('runtime-loop-mutations-'));
  rmSync(root, { recursive: true, force: true });
}
