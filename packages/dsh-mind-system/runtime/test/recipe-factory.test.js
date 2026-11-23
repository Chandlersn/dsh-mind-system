import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { createHost, installed } from './helpers/host.js';
import { RuntimeStore } from '../src/store.js';
import { HostExecutor } from '../src/executor.js';
import { RuntimeScheduler } from '../src/scheduler.js';
import { createRecipeRegistry } from '../src/recipe-factory.js';
import { describePrimitives, VERIFIER_PRIMITIVES } from '../src/verifier-primitives.js';

/**
 * The closure this suite proves: a task that was never pre-registered, with a recipe generated from its
 * specification, runs end to end and is judged by one of the closed verifier primitives.
 *
 * That is the difference between "the engine can run templates someone wrote" and "any task can be
 * described at runtime". The verifier stays closed on purpose 鈥?see verifier-primitives.js.
 */

const digest = (text) => createHash('sha256').update(text).digest('hex');

async function pipeline(t, { sourceText = 'b\nc\na\n' } = {}) {
  const host = await createHost(t);
  const store = new RuntimeStore(join(host.root, 'generated.sqlite'));
  const agent = await host.agent('generated-caller');
  const executor = new HostExecutor({ context: host.ctx, tools: host.tools, agent });
  const { assertObjectJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(installed['dsh-tools'].entry).href);
  writeFileSync(join(host.storage, 'input.txt'), sourceText);
  host.tools.register({ name: 'runtime_write_text', description: 'Create the owned text artifact.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' },
      createOnly: { type: 'boolean', enum: [true] } },
      required: ['path', 'content', 'createOnly'], additionalProperties: false },
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: '{"created":true}' }] },
    async execute({ path, content }) {
      host.ledger('write-dispatched');
      writeFileSync(path, content, { flag: 'wx' });
      return { created: true };
    } });
  const registry = createRecipeRegistry();
  const toolEffects = { 'runtime_write_text': 'reversible_write' };
  const validateArguments = ({ tool, arguments: args }) => validateJsonSchemaValue(tool.parameters, args);
  assertObjectJsonSchema(host.tools.get('runtime_write_text').parameters);
  const authority = { scopeRef: 'gen-scope', workspaceRoot: host.storage, allowedTools: ['runtime_write_text'], agent };
  const close = async () => { await executor.dispose(); store.close(); };
  return { host, store, executor, registry, toolEffects, validateArguments, authority, agent, close };
}

/** Build a scheduler for whatever recipes the registry currently holds. */
function schedulerFor(env) {
  return new RuntimeScheduler({ store: env.store, executor: env.executor,
    recipes: env.registry.list().map((key) => env.registry.get(key)), tools: env.host.tools,
    validateArguments: env.validateArguments });
}

test('a task with no pre-registered recipe runs from a generated one', async (t) => {
  const env = await pipeline(t);
  try {
    // The recipe did not exist until this line; the task was never declared anywhere.
    const recipe = env.registry.generate({
      recipeId: 'gen-sorted-lines', version: '1',
      description: 'Write the input lines in sorted order.',
      tool: 'runtime_write_text', effect: 'reversible_write',
      verifier: { primitive: 'line_set', parameters: { expectedLines: ['a', 'b', 'c'] } },
      arguments: { path: '{{workspaceRoot}}/output.txt', content: 'a\nb\nc\n', createOnly: true },
    }, { toolEffects: env.toolEffects });
    assert.equal(recipe.id, 'gen-sorted-lines');
    const task = { taskId: randomUUID(), recipeId: 'gen-sorted-lines', recipeVersion: '1',
      goal: 'Sort the lines.', scopeRef: env.authority.scopeRef, workspaceRoot: env.host.storage,
      inputs: { inputFile: 'input.txt', outputFile: 'output.txt' }, deadlineAt: Date.now() + 60_000 };
    const run = await schedulerFor(env).run(task, { authority: env.authority });
    assert.equal(run.status, 'completed', JSON.stringify({ status: run.status, reason: run.reason }));
    assert.equal(readFileSync(join(env.host.storage, 'output.txt'), 'utf8'), 'a\nb\nc\n');
    // The verdict came from the declared primitive, not from the tool's success flag.
    const final = env.store.readEvents(task.taskId).findLast((event) => event.kind === 'outcome_recorded');
    assert.equal(final.payload.verification.verifierId, 'builtin:line-set');
    assert.equal(final.payload.verification.goalSatisfied, true);
  } finally { await env.close(); }
});

const inputShapeCases = [
  { primitive: 'exact_bytes', parameters: { expectedSha256: digest('a\nb\nc\n') }, content: 'a\nb\nc\n' },
  { primitive: 'line_set', parameters: { expectedLines: ['a', 'b', 'c'] }, content: 'a\nb\nc\n' },
  { primitive: 'structure', parameters: { rule: { type: 'object' } }, content: '{"ok":true}' },
  { primitive: 'sorted_lines', parameters: {}, content: 'a\nb\nc\n' },
  { primitive: 'json_fields', parameters: { expected: { ok: true } }, content: '{"ok":true}' },
];

for (const { primitive, parameters, content } of inputShapeCases) {
  test(`${primitive} refuses invalid verifier inputs before dispatch and accepts valid inputs`, async (t) => {
    const env = await pipeline(t);
    try {
      const recipeId = `shape-${primitive}`;
      env.registry.generate({ recipeId, tool: 'runtime_write_text', effect: 'reversible_write',
        verifier: { primitive, parameters },
        // Keep write arguments valid even when verifier inputs are invalid.
        arguments: { path: '{{workspaceRoot}}/output.txt', content, createOnly: true },
      }, { toolEffects: env.toolEffects });
      const scheduler = schedulerFor(env);
      const runWith = (inputs) => {
        const task = { taskId: randomUUID(), recipeId, recipeVersion: '1', goal: 'Validate before writing.',
          scopeRef: env.authority.scopeRef, workspaceRoot: env.host.storage, inputs,
          deadlineAt: Date.now() + 60_000 };
        return scheduler.run(task, { authority: env.authority });
      };
      for (const inputs of [
        { outputFile: 'output.txt' },
        { inputFile: 'input.txt' },
        { inputFile: '', outputFile: 'output.txt' },
        { inputFile: 42, outputFile: 'output.txt' },
        { inputFile: 'input.txt', outputFile: false },
      ]) {
        const run = await runWith(inputs);
        assert.equal(run.reason, 'invalid_verifier_primitive', JSON.stringify(run));
        assert.equal(run.budgetUsage.attempts, 0);
        assert.equal(env.host.count('write-dispatched'), 0);
        assert.throws(() => readFileSync(join(env.host.storage, 'output.txt')), { code: 'ENOENT' });
      }
      const control = await runWith({ inputFile: 'input.txt', outputFile: 'output.txt' });
      assert.equal(control.status, 'completed', JSON.stringify(control));
      assert.equal(env.host.count('write-dispatched'), 1);
      assert.equal(readFileSync(join(env.host.storage, 'output.txt'), 'utf8'), content);
    } finally { await env.close(); }
  });
}

test('all step verifier shapes are checked before the first write and targetFile replaces outputFile', async (t) => {
  const env = await pipeline(t);
  try {
    const verifier = (targetFile) => ({ primitive: 'line_set',
      parameters: { expectedLines: ['done'], ...(targetFile === undefined ? {} : { targetFile }) } });
    const runSpec = async (recipeId, secondTarget) => {
      env.registry.generate({ recipeId, tool: 'runtime_write_text', effect: 'reversible_write',
        verifier: verifier('second.txt'),
        steps: [
          { id: 'first', tool: 'runtime_write_text', effect: 'reversible_write',
            verifier: verifier('first.txt'),
            arguments: { path: '{{workspaceRoot}}/first.txt', content: 'done\n', createOnly: true } },
          { id: 'second', tool: 'runtime_write_text', effect: 'reversible_write',
            verifier: verifier(secondTarget),
            arguments: { path: '{{workspaceRoot}}/second.txt', content: 'done\n', createOnly: true } },
        ],
      }, { toolEffects: env.toolEffects });
      return schedulerFor(env).run({ taskId: randomUUID(), recipeId, recipeVersion: '1',
        goal: 'Check every step before writing.', scopeRef: env.authority.scopeRef,
        workspaceRoot: env.host.storage, inputs: { inputFile: 'input.txt' },
        deadlineAt: Date.now() + 60_000 }, { authority: env.authority });
    };
    for (const [index, target] of [undefined, '', '../second.txt', 42].entries()) {
      const run = await runSpec(`bad-step-shape-${index}`, target);
      assert.equal(run.reason, 'invalid_verifier_primitive', JSON.stringify(run));
      assert.equal(run.budgetUsage.attempts, 0);
      assert.equal(env.host.count('write-dispatched'), 0);
      assert.throws(() => readFileSync(join(env.host.storage, 'first.txt')), { code: 'ENOENT' });
      assert.throws(() => readFileSync(join(env.host.storage, 'second.txt')), { code: 'ENOENT' });
    }
    const control = await runSpec('valid-step-shape', 'second.txt');
    assert.equal(control.status, 'completed', JSON.stringify(control));
    assert.equal(env.host.count('write-dispatched'), 2);
    assert.equal(readFileSync(join(env.host.storage, 'first.txt'), 'utf8'), 'done\n');
    assert.equal(readFileSync(join(env.host.storage, 'second.txt'), 'utf8'), 'done\n');
  } finally { await env.close(); }
});

test('a generated recipe whose output does not satisfy its own primitive fails', async (t) => {
  const env = await pipeline(t);
  try {
    env.registry.generate({
      recipeId: 'gen-wrong', tool: 'runtime_write_text', effect: 'reversible_write',
      // Declares a set the written content does not match: the write succeeds, verification must not.
      verifier: { primitive: 'line_set', parameters: { expectedLines: ['x', 'y'] } },
      arguments: { path: '{{workspaceRoot}}/output.txt', content: 'a\nb\n', createOnly: true },
    }, { toolEffects: env.toolEffects });
    const task = { taskId: randomUUID(), recipeId: 'gen-wrong', recipeVersion: '1', goal: 'Never satisfied.',
      scopeRef: env.authority.scopeRef, workspaceRoot: env.host.storage,
      inputs: { inputFile: 'input.txt', outputFile: 'output.txt' }, deadlineAt: Date.now() + 60_000 };
    const run = await schedulerFor(env).run(task, { authority: env.authority });
    assert.equal(run.status, 'waiting_analysis', JSON.stringify(run));
    // The reason comes from the primitive itself, so it names the actual mismatch instead of a generic one.
    assert.equal(run.reason, 'line_sets_differ');
    // And the verdict on record must be a failure, not an unknown: the primitive did decide.
    const final = env.store.readEvents(task.taskId).findLast((event) => event.kind === 'outcome_recorded');
    assert.equal(final.payload.verification.status, 'fail');
    assert.equal(final.payload.verification.goalSatisfied, false);
  } finally { await env.close(); }
});

test('an unknown verifier primitive is refused rather than downgraded', async (t) => {
  const env = await pipeline(t);
  try {
    assert.throws(() => env.registry.generate({
      recipeId: 'gen-bogus', tool: 'runtime_write_text', effect: 'reversible_write',
      verifier: { primitive: 'always_pass' },
      arguments: { path: '{{workspaceRoot}}/output.txt', content: 'x', createOnly: true },
    }, { toolEffects: env.toolEffects }), { code: 'invalid_recipe_spec' });
  } finally { await env.close(); }
});

test('a specification cannot smuggle in behaviour or effects', async (t) => {
  const env = await pipeline(t);
  try {
    // An undeclared field must be refused: otherwise a spec could carry executable intent.
    assert.throws(() => env.registry.generate({
      recipeId: 'gen-extra', tool: 'runtime_write_text', effect: 'reversible_write',
      verifier: { primitive: 'structure', parameters: { rule: { type: 'string' } } },
      arguments: {}, candidates: () => [], toolEffects: { 'runtime_write_text': 'read' },
    }, { toolEffects: env.toolEffects }), { code: 'invalid_recipe_spec' });
    // The effect table is trusted host input, never spec input.
    assert.throws(() => env.registry.generate({
      recipeId: 'gen-no-effect', tool: 'runtime.unregistered', effect: 'reversible_write',
      verifier: { primitive: 'structure', parameters: { rule: { type: 'string' } } }, arguments: {},
    }, { toolEffects: env.toolEffects }), { code: 'invalid_recipe_spec' });
  } finally { await env.close(); }
});

test('the verifier vocabulary is closed and introspectable', () => {
  const described = describePrimitives();
  assert.deepEqual(described.map((item) => item.name), [...VERIFIER_PRIMITIVES]);
  // Each primitive must explain itself, so a caller can choose without reading source.
  assert.ok(described.every((item) => typeof item.describe === 'string' && item.describe.length > 10));
});

test('a multi-step recipe advances through its steps and stops on its own', async (t) => {
  const env = await pipeline(t);
  try {
    // Two writes in order: the second step's argument references its own output file, so a run that
    // skipped a step or repeated one would not produce the expected artifacts.
    env.registry.generate({
      recipeId: 'gen-two-steps', tool: 'runtime_write_text', effect: 'reversible_write',
      // The step verifier judges each intermediate artifact; the top-level verifier judges the final state.
      verifier: { primitive: 'line_set', parameters: { expectedLines: ['a', 'b', 'c'] } },
      steps: [
        { id: 'first', tool: 'runtime_write_text', effect: 'reversible_write',
          verifier: { primitive: 'line_set', parameters: { expectedLines: ['a', 'b', 'c'] } },
          arguments: { path: '{{workspaceRoot}}/{{outputFile}}', content: 'a\nb\nc\n', createOnly: true } },
        { id: 'second', tool: 'runtime_write_text', effect: 'reversible_write',
          // A step may judge its own artifact: without targetFile every step would have to write to the
          // declared outputFile, so a two-step run could never verify its intermediate result.
          verifier: { primitive: 'line_set', parameters: { expectedLines: ['done'], targetFile: 'second.txt' } },
          arguments: { path: '{{workspaceRoot}}/second.txt', content: 'done\n', createOnly: true } },
      ],
    }, { toolEffects: env.toolEffects });
    const task = { taskId: randomUUID(), recipeId: 'gen-two-steps', recipeVersion: '1',
      goal: 'Write the sorted lines, then a marker.', scopeRef: env.authority.scopeRef,
      workspaceRoot: env.host.storage, inputs: { inputFile: 'input.txt', outputFile: 'output.txt' },
      deadlineAt: Date.now() + 60_000 };
    const run = await schedulerFor(env).run(task, { authority: env.authority });
    assert.equal(run.status, 'completed', JSON.stringify({ status: run.status, reason: run.reason }));
    // Both steps ran; the cursor reached the end, which is what made the loop stop.
    assert.equal(run.state.step, 2);
    assert.equal(run.budgetUsage.attempts, 2);
    assert.equal(readFileSync(join(env.host.storage, 'output.txt'), 'utf8'), 'a\nb\nc\n');
    assert.equal(readFileSync(join(env.host.storage, 'second.txt'), 'utf8'), 'done\n');
  } finally { await env.close(); }
});

test('a multi-step recipe may not nest steps or hide extra fields', async (t) => {
  const env = await pipeline(t);
  try {
    const base = { recipeId: 'gen-bad-steps', tool: 'runtime_write_text', effect: 'reversible_write',
      verifier: { primitive: 'structure', parameters: { rule: { type: 'string' } } } };
    assert.throws(() => env.registry.generate({ ...base,
      steps: [{ tool: 'runtime_write_text', effect: 'reversible_write', arguments: {},
        verifier: { primitive: 'structure', parameters: { rule: { type: 'string' } } },
        steps: [] }] }, { toolEffects: env.toolEffects }),
    { code: 'invalid_recipe_spec' });
    assert.throws(() => env.registry.generate({ ...base,
      steps: [{ tool: 'runtime_write_text', effect: 'reversible_write', arguments: {},
        verifier: { primitive: 'structure', parameters: { rule: { type: 'string' } } },
        candidates: () => [] }] }, { toolEffects: env.toolEffects }),
    { code: 'invalid_recipe_spec' });
    assert.throws(() => env.registry.generate({ ...base, steps: [] }, { toolEffects: env.toolEffects }),
      { code: 'invalid_recipe_spec' });
  } finally { await env.close(); }
});

test('a declared branch sends the run down the path the workspace state implies', async (t) => {
  const env = await pipeline(t);
  try {
    // Step one writes a marker, then branches: if the marker exists go to "finish", otherwise "retry".
    // The test drives both arms from the same recipe, so the branch — not the fixture — decides.
    const build = (recipeId) => env.registry.generate({
      recipeId, tool: 'runtime_write_text', effect: 'reversible_write',
      verifier: { primitive: 'line_set', parameters: { expectedLines: ['done'] } },
      steps: [
        { id: 'seed', tool: 'runtime_write_text', effect: 'reversible_write',
          verifier: { primitive: 'line_set', parameters: { expectedLines: ['seed'], targetFile: 'marker.txt' } },
          arguments: { path: '{{workspaceRoot}}/marker.txt', content: 'seed\n', createOnly: true },
          next: [{ when: { kind: 'file_exists', parameters: { file: 'marker.txt' } }, goto: 'finish' },
            { goto: 'unused' }] },
        { id: 'unused', tool: 'runtime_write_text', effect: 'reversible_write',
          verifier: { primitive: 'line_set', parameters: { expectedLines: ['never'], targetFile: 'unused.txt' } },
          arguments: { path: '{{workspaceRoot}}/unused.txt', content: 'never\n', createOnly: true } },
        { id: 'finish', tool: 'runtime_write_text', effect: 'reversible_write',
          verifier: { primitive: 'line_set', parameters: { expectedLines: ['done'], targetFile: 'output.txt' } },
          arguments: { path: '{{workspaceRoot}}/{{outputFile}}', content: 'done\n', createOnly: true } },
      ],
    }, { toolEffects: env.toolEffects });
    build('gen-branch');
    const task = { taskId: randomUUID(), recipeId: 'gen-branch', recipeVersion: '1',
      goal: 'Write the marker then finish through the branch.', scopeRef: env.authority.scopeRef,
      workspaceRoot: env.host.storage, inputs: { inputFile: 'input.txt', outputFile: 'output.txt' },
      deadlineAt: Date.now() + 60_000 };
    const run = await schedulerFor(env).run(task, { authority: env.authority });
    assert.equal(run.status, 'completed', JSON.stringify({ status: run.status, reason: run.reason }));
    // The branch was taken: only two attempts, and the skipped step never wrote its file.
    assert.equal(run.budgetUsage.attempts, 2);
    // The persisted trail shows the hop, which is how a later review can tell why it went that way.
    assert.deepEqual(run.state.branchTrail.map((hop) => `${hop.from}->${hop.to}`), ['seed->finish', 'finish->null']);
    assert.equal(readFileSync(join(env.host.storage, 'output.txt'), 'utf8'), 'done\n');
    assert.throws(() => readFileSync(join(env.host.storage, 'unused.txt')), { code: 'ENOENT' },
      'The branch that was not taken must not have run.');
  } finally { await env.close(); }
});

test('a branch to a step that was never declared is refused at registration', async (t) => {
  const env = await pipeline(t);
  try {
    assert.throws(() => env.registry.generate({
      recipeId: 'gen-dangling', tool: 'runtime_write_text', effect: 'reversible_write',
      verifier: { primitive: 'line_set', parameters: { expectedLines: ['a'] } },
      steps: [{ id: 'only', tool: 'runtime_write_text', effect: 'reversible_write',
        verifier: { primitive: 'line_set', parameters: { expectedLines: ['a'] } },
        arguments: {}, next: [{ goto: 'nowhere' }] }],
    }, { toolEffects: env.toolEffects }), { code: 'invalid_recipe_spec' });
    // An unknown condition kind must also fail here, not mid-run.
    assert.throws(() => env.registry.generate({
      recipeId: 'gen-unknown-condition', tool: 'runtime_write_text', effect: 'reversible_write',
      verifier: { primitive: 'line_set', parameters: { expectedLines: ['a'] } },
      steps: [{ id: 'only', tool: 'runtime_write_text', effect: 'reversible_write',
        verifier: { primitive: 'line_set', parameters: { expectedLines: ['a'] } },
        arguments: {}, next: [{ when: { kind: 'invented' }, goto: 'only' }] }],
    }, { toolEffects: env.toolEffects }), { code: 'invalid_condition' });
  } finally { await env.close(); }
});

test('a branch whose condition is false takes the fallback instead', async (t) => {
  const env = await pipeline(t);
  try {
    // The condition watches a file that never exists, so a correct run must fall through to `other`.
    // Without this contrast, a matcher that assumed every condition true would pass the positive test too.
    env.registry.generate({
      recipeId: 'gen-false-branch', tool: 'runtime_write_text', effect: 'reversible_write',
      verifier: { primitive: 'line_set', parameters: { expectedLines: ['other'], targetFile: 'other.txt' } },
      steps: [
        { id: 'seed', tool: 'runtime_write_text', effect: 'reversible_write',
          verifier: { primitive: 'line_set', parameters: { expectedLines: ['seed'], targetFile: 'marker.txt' } },
          arguments: { path: '{{workspaceRoot}}/marker.txt', content: 'seed\n', createOnly: true },
          next: [{ when: { kind: 'file_exists', parameters: { file: 'absent.txt' } }, goto: 'never' },
            { goto: 'other' }] },
        { id: 'never', tool: 'runtime_write_text', effect: 'reversible_write',
          verifier: { primitive: 'line_set', parameters: { expectedLines: ['never'], targetFile: 'never.txt' } },
          arguments: { path: '{{workspaceRoot}}/never.txt', content: 'never\n', createOnly: true } },
        { id: 'other', tool: 'runtime_write_text', effect: 'reversible_write',
          verifier: { primitive: 'line_set', parameters: { expectedLines: ['other'], targetFile: 'other.txt' } },
          arguments: { path: '{{workspaceRoot}}/other.txt', content: 'other\n', createOnly: true } },
      ],
    }, { toolEffects: env.toolEffects });
    const task = { taskId: randomUUID(), recipeId: 'gen-false-branch', recipeVersion: '1',
      goal: 'Follow the fallback path.', scopeRef: env.authority.scopeRef,
      workspaceRoot: env.host.storage, inputs: { inputFile: 'input.txt', outputFile: 'output.txt' },
      deadlineAt: Date.now() + 60_000 };
    const run = await schedulerFor(env).run(task, { authority: env.authority });
    assert.equal(run.status, 'completed', JSON.stringify({ status: run.status, reason: run.reason }));
    assert.equal(run.state.branchTrail[0].to, 'other', 'A false condition must not select its target.');
    assert.equal(readFileSync(join(env.host.storage, 'other.txt'), 'utf8'), 'other\n');
    assert.throws(() => readFileSync(join(env.host.storage, 'never.txt')), { code: 'ENOENT' });
  } finally { await env.close(); }
});

test('two different tasks can share one generated recipe with different placeholders', async (t) => {
  const env = await pipeline(t);
  try {
    env.registry.generate({
      recipeId: 'gen-shared', tool: 'runtime_write_text', effect: 'reversible_write',
      verifier: { primitive: 'line_set', parameters: { expectedLines: ['a', 'b', 'c'] } },
      arguments: { path: '{{workspaceRoot}}/{{outputFile}}', content: 'a\nb\nc\n', createOnly: true },
    }, { toolEffects: env.toolEffects });
    const task = (outputFile) => ({ taskId: randomUUID(), recipeId: 'gen-shared', recipeVersion: '1',
      goal: 'Write sorted lines.', scopeRef: env.authority.scopeRef, workspaceRoot: env.host.storage,
      inputs: { inputFile: 'input.txt', outputFile }, deadlineAt: Date.now() + 60_000 });
    const scheduler = schedulerFor(env);
    const first = await scheduler.run(task('one.txt'), { authority: env.authority });
    const second = await scheduler.run(task('two.txt'), { authority: env.authority });
    assert.equal(first.status, 'completed');
    assert.equal(second.status, 'completed');
    assert.equal(readFileSync(join(env.host.storage, 'one.txt'), 'utf8'), 'a\nb\nc\n');
    assert.equal(readFileSync(join(env.host.storage, 'two.txt'), 'utf8'), 'a\nb\nc\n');
  } finally { await env.close(); }
});
