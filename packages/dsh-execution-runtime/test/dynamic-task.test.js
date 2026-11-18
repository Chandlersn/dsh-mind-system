import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHost } from './helpers/host.js';
import * as hostEntry from '../src/host-plugin.js';
import { VERIFIER_PRIMITIVES } from '../src/verifier-primitives.js';

/**
 * The general path, driven through the host: a caller describes a task that was never declared anywhere,
 * the runtime generates the recipe, and the run is judged by a built-in primitive.
 *
 * This is the closure the user asked for — "any task can be moved around and passed in" — so the tests
 * here go through `runtime_execute` exactly as a model would, and check both the artifact and the verdict.
 */

async function withRuntime(t, body) {
  const host = await createHost(t);
  writeFileSync(join(host.storage, 'input.txt'), 'c\na\nb\n');
  host.tools.register({ name: 'runtime.write_text', description: 'Create the owned text artifact.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' },
      createOnly: { type: 'boolean', enum: [true] } },
      required: ['path', 'content', 'createOnly'], additionalProperties: false },
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: '{"created":true}' }] },
    async execute({ path, content }) { writeFileSync(path, content, { flag: 'wx' }); return { created: true }; } });
  const fiber = await host.ctx.plugin(hostEntry.plugin, { enabled: true,
    stateDir: mkdtempSync(join(host.root, 'state-')), workspaceRoot: host.storage,
    scopeRef: 'dynamic-scope' });
  await fiber.await();
  try { await body(host); } finally { await fiber.dispose(); }
}

test('a task described at runtime runs and is judged by a built-in primitive', async (t) => {
  await withRuntime(t, async (host) => {
    const agent = await host.agent('dynamic-caller');
    const taskId = randomUUID();
    const result = await host.execute('runtime_execute', { agent, arguments: {
      taskId,
      goal: 'Write the three lines in sorted order.',
      recipe: { recipeId: 'sorted-lines', tool: 'runtime.write_text', effect: 'reversible_write',
        verifier: { primitive: 'line_set', parameters: { expectedLines: ['a', 'b', 'c'] } },
        arguments: { path: '{{workspaceRoot}}/output.txt', content: 'a\nb\nc\n', createOnly: true } },
      inputs: { inputFile: 'input.txt', outputFile: 'output.txt' },
    } });
    assert.equal(result.isError, false, JSON.stringify(result.content));
    assert.equal(result.value.status, 'completed', JSON.stringify(result.value));
    assert.equal(result.value.recipe, 'sorted-lines@1');
    assert.equal(result.value.verifier, 'builtin:line-set');
    assert.equal(readFileSync(join(host.storage, 'output.txt'), 'utf8'), 'a\nb\nc\n');
  });
});

test('the same specification is reusable across different tasks', async (t) => {
  await withRuntime(t, async (host) => {
    const agent = await host.agent('dynamic-caller');
    const spec = { recipeId: 'sorted-lines', tool: 'runtime.write_text', effect: 'reversible_write',
      verifier: { primitive: 'line_set', parameters: { expectedLines: ['a', 'b', 'c'] } },
      arguments: { path: '{{workspaceRoot}}/{{outputFile}}', content: 'a\nb\nc\n', createOnly: true } };
    const first = await host.execute('runtime_execute', { agent, arguments: {
      taskId: randomUUID(), goal: 'Sort into one.txt.', recipe: spec,
      inputs: { inputFile: 'input.txt', outputFile: 'one.txt' } } });
    assert.equal(first.isError, false, JSON.stringify(first.content));
    const second = await host.execute('runtime_execute', { agent, arguments: {
      taskId: randomUUID(), goal: 'Sort into two.txt.', recipe: spec,
      inputs: { inputFile: 'input.txt', outputFile: 'two.txt' } } });
    assert.equal(second.isError, false, JSON.stringify(second.content));
    assert.equal(second.value.status, 'completed', JSON.stringify(second.value));
    assert.equal(readFileSync(join(host.storage, 'two.txt'), 'utf8'), 'a\nb\nc\n');
  });
});

test('a runtime task whose output misses its declared primitive does not report success', async (t) => {
  await withRuntime(t, async (host) => {
    const agent = await host.agent('dynamic-caller');
    const result = await host.execute('runtime_execute', { agent, arguments: {
      taskId: randomUUID(),
      goal: 'Claim sorted output that is not sorted.',
      recipe: { recipeId: 'wrong-lines', tool: 'runtime.write_text', effect: 'reversible_write',
        verifier: { primitive: 'line_set', parameters: { expectedLines: ['x', 'y', 'z'] } },
        arguments: { path: '{{workspaceRoot}}/output.txt', content: 'a\nb\nc\n', createOnly: true } },
      inputs: { inputFile: 'input.txt', outputFile: 'output.txt' },
    } });
    // The tool call succeeds, but the run must not be reported as completed.
    assert.equal(result.isError, false, JSON.stringify(result.content));
    assert.notEqual(result.value.status, 'completed', JSON.stringify(result.value));
    assert.equal(result.value.reason, 'line_sets_differ');
  });
});

test('a runtime task cannot widen the mount\'s tool authority', async (t) => {
  await withRuntime(t, async (host) => {
    const agent = await host.agent('dynamic-caller');
    const result = await host.execute('runtime_execute', { agent, arguments: {
      taskId: randomUUID(), goal: 'Try to use a tool the mount never declared.',
      recipe: { recipeId: 'escape-attempt', tool: 'runtime.delete_everything', effect: 'reversible_write',
        verifier: { primitive: 'structure', parameters: { rule: { type: 'string' } } },
        arguments: {} },
      inputs: { inputFile: 'input.txt', outputFile: 'output.txt' },
    } });
    // Asserting only `isError` would pass for the wrong reason: an unregistered tool fails anyway. The
    // refusal has to come from the mount check, which speaks about what the mount allows.
    assert.equal(result.isError, true, 'A runtime task must not reach beyond the mounted tool set.');
    const text = JSON.stringify(result.content);
    assert.match(text, /mount does not allow/, `The refusal must be an authority check, got: ${text}`);
  });
});

test('an unknown verifier primitive is refused at the tool boundary', async (t) => {
  await withRuntime(t, async (host) => {
    const agent = await host.agent('dynamic-caller');
    const result = await host.execute('runtime_execute', { agent, arguments: {
      taskId: randomUUID(), goal: 'Ask for a verifier that does not exist.',
      recipe: { recipeId: 'no-such-verifier', tool: 'runtime.write_text', effect: 'reversible_write',
        verifier: { primitive: 'always_pass' },
        arguments: { path: '{{workspaceRoot}}/output.txt', content: 'x', createOnly: true } },
      inputs: { inputFile: 'input.txt', outputFile: 'output.txt' },
    } });
    assert.equal(result.isError, true, 'Acceptance is a closed vocabulary; it cannot be extended by a request.');
  });
});

test('the verifier vocabulary is discoverable before a task is described', async (t) => {
  await withRuntime(t, async (host) => {
    const agent = await host.agent('dynamic-caller');
    const result = await host.execute('runtime_verifiers', { agent, arguments: {} });
    assert.equal(result.isError, false, JSON.stringify(result.content));
    const names = result.value.primitives.map((item) => item.name);
    // Compare against the source list rather than a frozen literal: a hardcoded copy goes stale the moment
    // a primitive is added, and a stale copy fails for the wrong reason while a widened copy proves nothing.
    assert.deepEqual(names, [...VERIFIER_PRIMITIVES]);
    assert.ok(names.length >= 3, 'The vocabulary must stay usable, not shrink to nothing.');
    assert.ok(result.value.primitives.every((item) => typeof item.describe === 'string'));
    // Branching is part of the same closed vocabulary, so it must be discoverable too.
    assert.deepEqual(result.value.conditions.map((item) => item.kind),
      ['file_exists', 'file_sha256', 'step_less_than', 'always']);
    assert.match(result.value.steps, /steps\[\]/);
  });
});

test('a multi-step task with a branch runs through the dynamic tool', async (t) => {
  await withRuntime(t, async (host) => {
    const agent = await host.agent('dynamic-caller');
    const result = await host.execute('runtime_execute', { agent, arguments: {
      taskId: randomUUID(),
      goal: 'Write a marker, then follow whichever branch the workspace implies.',
      recipe: { recipeId: 'branching-task', tool: 'runtime.write_text', effect: 'reversible_write',
        verifier: { primitive: 'line_set', parameters: { expectedLines: ['final'], targetFile: 'output.txt' } },
        steps: [
          { id: 'seed', tool: 'runtime.write_text', effect: 'reversible_write',
            verifier: { primitive: 'line_set', parameters: { expectedLines: ['seed'], targetFile: 'marker.txt' } },
            arguments: { path: '{{workspaceRoot}}/marker.txt', content: 'seed\n', createOnly: true },
            next: [{ when: { kind: 'file_exists', parameters: { file: 'marker.txt' } }, goto: 'final' }] },
          { id: 'skipped', tool: 'runtime.write_text', effect: 'reversible_write',
            verifier: { primitive: 'line_set', parameters: { expectedLines: ['skipped'], targetFile: 'skipped.txt' } },
            arguments: { path: '{{workspaceRoot}}/skipped.txt', content: 'skipped\n', createOnly: true } },
          { id: 'final', tool: 'runtime.write_text', effect: 'reversible_write',
            verifier: { primitive: 'line_set', parameters: { expectedLines: ['final'], targetFile: 'output.txt' } },
            arguments: { path: '{{workspaceRoot}}/{{outputFile}}', content: 'final\n', createOnly: true } },
        ] },
      inputs: { inputFile: 'input.txt', outputFile: 'output.txt' },
    } });
    assert.equal(result.isError, false, JSON.stringify(result.content));
    assert.equal(result.value.status, 'completed', JSON.stringify(result.value));
    // The branch skipped a step: two attempts, and the skipped artifact is absent.
    assert.equal(result.value.budgetUsage.attempts, 2);
    assert.equal(readFileSync(join(host.storage, 'output.txt'), 'utf8'), 'final\n');
    assert.throws(() => readFileSync(join(host.storage, 'skipped.txt')), { code: 'ENOENT' });
  });
});
