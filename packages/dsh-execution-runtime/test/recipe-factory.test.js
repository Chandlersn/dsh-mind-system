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
  host.tools.register({ name: 'runtime.write_text', description: 'Create the owned text artifact.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' },
      createOnly: { type: 'boolean', enum: [true] } },
      required: ['path', 'content', 'createOnly'], additionalProperties: false },
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: '{"created":true}' }] },
    async execute({ path, content }) { writeFileSync(path, content, { flag: 'wx' }); return { created: true }; } });
  const registry = createRecipeRegistry();
  const toolEffects = { 'runtime.write_text': 'reversible_write' };
  const validateArguments = ({ tool, arguments: args }) => validateJsonSchemaValue(tool.parameters, args);
  assertObjectJsonSchema(host.tools.get('runtime.write_text').parameters);
  const authority = { scopeRef: 'gen-scope', workspaceRoot: host.storage, allowedTools: ['runtime.write_text'], agent };
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
      tool: 'runtime.write_text', effect: 'reversible_write',
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

test('a generated recipe whose output does not satisfy its own primitive fails', async (t) => {
  const env = await pipeline(t);
  try {
    env.registry.generate({
      recipeId: 'gen-wrong', tool: 'runtime.write_text', effect: 'reversible_write',
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
      recipeId: 'gen-bogus', tool: 'runtime.write_text', effect: 'reversible_write',
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
      recipeId: 'gen-extra', tool: 'runtime.write_text', effect: 'reversible_write',
      verifier: { primitive: 'structure', parameters: { rule: { type: 'string' } } },
      arguments: {}, candidates: () => [], toolEffects: { 'runtime.write_text': 'read' },
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
      recipeId: 'gen-two-steps', tool: 'runtime.write_text', effect: 'reversible_write',
      // The step verifier judges each intermediate artifact; the top-level verifier judges the final state.
      verifier: { primitive: 'line_set', parameters: { expectedLines: ['a', 'b', 'c'] } },
      steps: [
        { id: 'first', tool: 'runtime.write_text', effect: 'reversible_write',
          verifier: { primitive: 'line_set', parameters: { expectedLines: ['a', 'b', 'c'] } },
          arguments: { path: '{{workspaceRoot}}/{{outputFile}}', content: 'a\nb\nc\n', createOnly: true } },
        { id: 'second', tool: 'runtime.write_text', effect: 'reversible_write',
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
    const base = { recipeId: 'gen-bad-steps', tool: 'runtime.write_text', effect: 'reversible_write',
      verifier: { primitive: 'structure', parameters: { rule: { type: 'string' } } } };
    assert.throws(() => env.registry.generate({ ...base,
      steps: [{ tool: 'runtime.write_text', effect: 'reversible_write', arguments: {},
        verifier: { primitive: 'structure', parameters: { rule: { type: 'string' } } },
        steps: [] }] }, { toolEffects: env.toolEffects }),
    { code: 'invalid_recipe_spec' });
    assert.throws(() => env.registry.generate({ ...base,
      steps: [{ tool: 'runtime.write_text', effect: 'reversible_write', arguments: {},
        verifier: { primitive: 'structure', parameters: { rule: { type: 'string' } } },
        candidates: () => [] }] }, { toolEffects: env.toolEffects }),
    { code: 'invalid_recipe_spec' });
    assert.throws(() => env.registry.generate({ ...base, steps: [] }, { toolEffects: env.toolEffects }),
      { code: 'invalid_recipe_spec' });
  } finally { await env.close(); }
});

test('two different tasks can share one generated recipe with different placeholders', async (t) => {
  const env = await pipeline(t);
  try {
    env.registry.generate({
      recipeId: 'gen-shared', tool: 'runtime.write_text', effect: 'reversible_write',
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
