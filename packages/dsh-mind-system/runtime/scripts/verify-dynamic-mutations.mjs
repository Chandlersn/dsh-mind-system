import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { collectModuleClosure } from './build/module-closure.mjs';

/**
 * Mutation checks for the general path: a task described at runtime, a recipe generated from it, and a
 * closed verifier vocabulary.
 *
 * Every target here is a plausible shortcut that would look fine in review: accepting an unknown
 * primitive, letting the request supply the effect table, skipping the mount's tool check, or trusting a
 * parseable artifact instead of comparing it.
 */
const source = fileURLToPath(new URL('../', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-dynamic-mutations-')));
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
  const testsInOrder = ['test/recipe-factory.test.js', 'test/dynamic-task.test.js'];
  for (const file of collectModuleClosure(source, testsInOrder)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), readFileSync(join(source, file)));
  }
  const tests = testsInOrder.map((file) => join(root, file));
  const baseline = run(['--test', ...tests], 'baseline');
  assert.equal(baseline.status, 0, baseline.output);
  const mutants = [
    // Acceptance must stay a closed vocabulary. Two layers guard it (spec validation, then buildVerifier);
    // a mutant must defeat both, otherwise it proves only that the outer layer exists.
    { name: 'unknown_primitive_accepted', file: 'src/recipe-factory.js',
      old: "  if (!VERIFIER_PRIMITIVES.includes(input.verifier.primitive)) {\n    fail('invalid_recipe_spec',\n      `spec.verifier.primitive must be one of: ${VERIFIER_PRIMITIVES.join(', ')}.`);\n  }",
      replacement: '  void VERIFIER_PRIMITIVES;',
      test: /not ok \d+ - an unknown verifier primitive is refused/ },
    // A spec must not be able to declare its own effect classes.
    { name: 'spec_supplies_effect_table', file: 'src/recipe-factory.js',
      old: '    if (!SPEC_FIELDS.includes(key)) fail(\'invalid_recipe_spec\', `Unknown specification field: ${key}.`);',
      replacement: '    if (!SPEC_FIELDS.includes(key)) continue;',
      test: /not ok \d+ - a specification cannot smuggle in behaviour or effects/ },
    // The mount decides authority, not the request.
    { name: 'request_widens_tool_authority', file: 'src/dynamic-tools.js',
      old: '        if (!mount.allowedTools.includes(name)) {',
      replacement: '        if (false) {',
      test: /not ok \d+ - a runtime task cannot widen the mount/ },
    // line_set must compare content, not merely parse it.
    { name: 'line_set_ignores_actual_content', file: 'src/verifier-primitives.js',
      old: '    const same = actual.length === expected.length && actual.every((line, index) => line === expected[index]);',
      replacement: '    const same = Array.isArray(actual);',
      test: /not ok \d+ - a runtime task whose output misses its declared primitive/ },
    // A generated recipe must still verify rather than trusting the tool result.
    { name: 'generated_recipe_skips_verification', file: 'src/recipe-factory.js',
      old: '    verifier: steps ? stepVerifier : verifier,',
      replacement: '    verifier: { id: verifier.id, version: "1", async verify() { return { status: "pass", progress: "advanced", goalSatisfied: true, verifierId: verifier.id, verifierVersion: "1", evidenceRefs: ["forged"] }; } },',
      test: /not ok \d+ - a generated recipe whose output does not satisfy/ },
    // The primitives must be discoverable, since a caller is expected to choose one.
    { name: 'primitives_not_listed', file: 'src/dynamic-tools.js',
      old: '    return { primitives: describePrimitives(), conditions: describeConditions(),',
      replacement: '    return { primitives: [], conditions: [],',
      test: /not ok \d+ - the verifier vocabulary is discoverable/ },
    // An intermediate step satisfying itself is not the task being done; claiming the goal would end the
    // run after step one.
    { name: 'intermediate_step_claims_goal', file: 'src/recipe-factory.js',
      old: "        goalSatisfied: last ? verdict.goalSatisfied : (verdict.status === 'pass' ? false : verdict.goalSatisfied),",
      replacement: '        goalSatisfied: verdict.goalSatisfied,',
      test: /not ok \d+ - a multi-step recipe advances through its steps/ },
    // A step must be able to judge its own artifact, or a two-step run can never verify the first result.
    { name: 'step_cannot_target_own_artifact', file: 'src/verifier-primitives.js',
      old: '      const paths = resolvePaths(task, state, parameters?.targetFile ?? null);',
      replacement: '      const paths = resolvePaths(task, state, null);',
      test: /not ok \d+ - a multi-step recipe advances through its steps/ },
    // A declared branch must actually change the path taken; ignoring it silently runs every step.
    { name: 'branch_target_ignored', file: 'src/recipe-factory.js',
      old: '        const nextIndex = chosen === null ? cursor + 1 : indexOfStep(chosen);',
      replacement: '        const nextIndex = cursor + 1;',
      test: /not ok \d+ - a declared branch sends the run down the path/ },
    // Conditions must be evaluated, not assumed true.
    { name: 'condition_always_true', file: 'src/recipe-factory.js',
      old: '    if (rule.when.evaluate(context)) return rule.goto;',
      replacement: '    if (true) return rule.goto;',
      test: /not ok \d+ - a branch whose condition is false/ },
    { name: 'dangling_branch_accepted', file: 'src/recipe-factory.js',
      old: '        if (!ids.includes(rule.goto)) {',
      replacement: '        if (false) {',
      test: /not ok \d+ - a branch to a step that was never declared/ },
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
  assert.ok(basename(root).startsWith('runtime-dynamic-mutations-'));
  rmSync(root, { recursive: true, force: true });
}
