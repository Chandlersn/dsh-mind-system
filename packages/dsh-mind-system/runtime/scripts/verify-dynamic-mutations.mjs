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
  const testsInOrder = ['test/recipe-factory.test.js', 'test/dynamic-task.test.js',
    'test/verifier-primitives.test.js', 'test/recipe-library.test.js', 'test/analysis-wiring.test.js',
    'test/knowledge-wiring.test.js', 'test/pattern-tool.test.js'];
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
    // sorted_lines must compare against the input; checking only that the output is ordered would let any
    // sorted list pass, which is the whole reason this primitive exists.
    { name: 'sorted_lines_ignores_input', file: 'src/verifier-primitives.js',
      old: "    if (!sameMultiset) {\n      return { ...base, status: 'fail', progress: 'unchanged', goalSatisfied: false, reason: 'line_multiset_differs' };\n    }",
      replacement: '    void sameMultiset;',
      test: /not ok \d+ - sorted_lines accepts a true reordering/ },
    // Duplicates must be counted, not collapsed. Dropping only the length check is not enough 鈥?the
    // multiset comparison catches the loss by itself 鈥?so the mutant must defeat the counting itself,
    // which is what a set-based implementation would have done.
    { name: 'sorted_lines_ignores_duplicates', file: 'src/verifier-primitives.js',
      old: '      for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);',
      replacement: '      for (const line of lines) if (!counts.has(line)) counts.set(line, 1);',
      test: /not ok \d+ - sorted_lines counts duplicates/ },
    // The declared direction must actually be read.
    { name: 'sorted_lines_ignores_direction', file: 'src/verifier-primitives.js',
      old: '      || comparator(outputLines[index - 1], line) * (expectAscending ? 1 : -1) <= 0);',
      replacement: '      || comparator(outputLines[index - 1], line) <= 0);',
      test: /not ok \d+ - sorted_lines honours a descending declaration/ },
    // json_fields must compare with no coercion; "3" is not 3.
    { name: 'json_fields_coerces_values', file: 'src/verifier-primitives.js',
      old: '      .filter(([key, want]) => JSON.stringify(value[key]) !== JSON.stringify(want))',
      replacement: '      .filter(([key, want]) => String(value[key]) !== String(want))',
      test: /not ok \d+ - json_fields compares values strictly/ },
    // A recipe that has only ever failed must not be offered as reusable; that would dress an unproven
    // approach as a proven one, which is the exact failure this library has to avoid.
    { name: 'suggests_never_verified', file: 'src/recipe-library.js',
      old: "      const rows = db.prepare('SELECT * FROM recipe_library WHERE verified_runs >= 1 '\n        + 'ORDER BY verified_runs DESC, updated_at DESC').all();",
      replacement: "      const rows = db.prepare('SELECT * FROM recipe_library '\n        + 'ORDER BY verified_runs DESC, updated_at DESC').all();",
      test: /not ok \d+ - a failed run is recorded as a failure/ },
    // Only a verified completion may count as success.
    { name: 'any_status_counts_as_success', file: 'src/recipe-library.js',
      old: "      const succeeded = status === 'completed';",
      replacement: '      const succeeded = true;',
      test: /not ok \d+ - only verified completion counts as success/ },
    // Failure history must not be erased by a later success.
    { name: 'success_clears_failures', file: 'src/recipe-library.js',
      old: '      db.prepare(`UPDATE recipe_library SET\n        verified_runs = verified_runs + ?, failed_runs = failed_runs + ?, last_task_id = ?, updated_at = ?\n        WHERE recipe_key = ?`).run(succeeded ? 1 : 0, succeeded ? 0 : 1, taskId, now(), recipeKey);',
      replacement: '      db.prepare(`UPDATE recipe_library SET\n        verified_runs = ?, failed_runs = ?, last_task_id = ?, updated_at = ?\n        WHERE recipe_key = ?`).run(succeeded ? 1 : 0, succeeded ? 0 : 1, taskId, now(), recipeKey);',
      test: /not ok \d+ - only verified completion counts as success/ },
    // The analysis loop must actually run for a stopped run. Removing the call is the exact regression this
    // wiring change exists to prevent: the module would keep passing its own tests while never being reached.
    { name: 'stopped_run_not_analyzed', file: 'src/plugin.js',
      old: '      const analysis = await maybeAnalyze(exec.agent, run.task.taskId, prepared.authority, exec.signal);',
      replacement: '      const analysis = null;',
      test: /not ok \d+ - a run that stops for analysis actually gets analyzed/ },
    // Analysis must be conditional on the run stopping, not attempted for every caller.
    { name: 'analysis_runs_without_waiting', file: 'src/plugin.js',
      old: "    if (current.status !== 'waiting_analysis') return null;",
      replacement: '    if (false) return null;',
      test: /not ok \d+ - a completed run is never analyzed/ },
    // A missing provider must mean "no analysis", not a component that manufactures unavailable records.
    { name: 'absent_analyzer_still_analyzes', file: 'src/plugin.js',
      old: '    if (analyzer === null) return null;',
      replacement: '    if (analyzer === null) return { analyze: async () => ({ status: \'analysis_unavailable\' }) };',
      test: /not ok \d+ - without an analyzer the plugin behaves exactly as before/ },
    // An unavailable channel must refuse with a reason. Answering with an empty result instead would read as
    // "the knowledge base has nothing", which is a different and misleading claim.
    { name: 'unconfigured_channel_returns_empty', file: 'src/dynamic-tools.js',
      old: "        return { available: false, reason: 'The knowledge channel is not configured.', endpoint };",
      replacement: '        return { available: true, action: args?.action, itemCount: 0, content: [] };',
      test: /not ok \d+ - the tool refuses with a reason/ },
    // A failure must carry its code, not be swallowed into a result shape that looks like content.
    { name: 'knowledge_failure_swallowed', file: 'src/dynamic-tools.js',
      old: "        return { available: true, action: args?.action, error: error?.code ?? 'knowledge_failed',",
      replacement: '        return { available: true, action: args?.action, itemCount: 0, content: [],',
      test: /not ok \d+ - an adapter failure is reported with its code/ },
    // Stored and indexed are different facts; collapsing them hides a write nobody can find.
    { name: 'stored_counts_as_indexed', file: 'src/knowledge.js',
      old: '  const indexed = stored && outcome.indexed === true;',
      replacement: '  const indexed = stored;',
      test: /not ok \d+ - a write reports stored and indexed as separate facts/ },
    // The domain decides trust; a scratch note must never be upgraded to verified.
    { name: 'scratch_upgraded_to_verified', file: 'src/knowledge.js',
      old: "    verified: ref.domain === 'formal' ? result.verified === true : false });",
      replacement: '    verified: result.verified === true });',
      test: /not ok \d+ - reading keeps the domain identity/ },
    // An unregistered pattern must never reach the store: the runtime takes the body from the host registry,
    // never from the request, so a caller cannot describe the rule it wants written.
    { name: 'unregistered_pattern_written', file: 'src/dynamic-tools.js',
      old: "        return { available: true, written: false, reason: 'pattern_not_registered' };",
      replacement: '        return { available: true, written: true, reason: null };',
      test: /not ok \d+ - the runtime never takes a pattern body from the request/ },
    // An approval that does not apply must not reach the store.
    { name: 'ineffective_approval_written', file: 'src/valve-bridge.js',
      old: '    if (!decision.applies) {',
      replacement: '    if (false) {',
      test: /not ok \d+ - an absent or stale approval is refused/ },
    // The version hash is what binds an approval to the reviewed body. Skipping it lets an edited pattern
    // reuse an old ticket — the exact bypass the version hash exists to prevent.
    { name: 'approval_ignores_pattern_version', file: 'src/pattern-approval.js',
      old: "  if (version !== approval.patternVersion) return { applies: false, reason: 'pattern_version_changed' };",
      replacement: '  void version;',
      test: /not ok \d+ - an approval for a different pattern version does not carry over/ },
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
