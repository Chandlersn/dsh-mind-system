import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createHost, installed } from './helpers/host.js';
import { RuntimeStore } from '../src/store.js';
import { jsonNormalizeRecipe } from '../recipes/json-normalize.js';
import { createExecutionRuntimePlugin } from '../src/plugin.js';

const { assertObjectJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(installed['dsh-tools'].entry).href);

/**
 * The host fixture removes its temporary root in its own teardown, so SQLite must be closed first.
 * Every case here closes the store explicitly before returning instead of relying on hook order.
 */
async function fixture(t, { withTask = true } = {}) {
  const host = await createHost(t);
  const store = new RuntimeStore(join(host.root, 'plugin.sqlite'));
  writeFileSync(join(host.storage, 'source.json'), JSON.stringify([{ id: 'a', name: ' Alpha ' }]));
  host.tools.register({ name: 'runtime.write_json', description: 'Create an owned fixture artifact.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, createOnly: { type: 'boolean', enum: [true] } },
      required: ['path', 'content', 'createOnly'], additionalProperties: false },
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: '{"created":true}' }] },
    async execute({ path, content }) { writeFileSync(path, content, { flag: 'wx' }); return { created: true }; } });
  const tasks = {};
  if (withTask) {
    tasks['fixture-normalize'] = async ({ agent }) => ({
      task: { taskId: randomUUID(), recipeId: 'json-normalize', recipeVersion: '1',
        goal: 'Create sorted normalized records.', scopeRef: 'plugin-scope', workspaceRoot: host.storage,
        inputs: { inputFile: 'source.json', outputFile: 'output.json' }, deadlineAt: Date.now() + 60_000 },
      authority: { scopeRef: 'plugin-scope', workspaceRoot: host.storage, allowedTools: ['runtime.write_json'], agent },
    });
  }
  const plugin = createExecutionRuntimePlugin({ store, recipes: [jsonNormalizeRecipe], tasks, owner: host.ctx,
    validateArguments({ tool, arguments: args }) {
      assertObjectJsonSchema(tool.parameters);
      return validateJsonSchemaValue(tool.parameters, args);
    } });
  return { host, store, plugin, close: () => { try { store.close(); } catch { /* closed */ } } };
}

// The host registry exposes get(name, scope); omitting the scope asks the global view.
const registered = (host, name) => host.tools.get(name) !== undefined;

// The host returns { isError, content, value }; asserting on `success` would test a field that never existed.
const report = (result) => {
  assert.equal(result.isError, false, JSON.stringify(result.content));
  return result.value;
};

test('the runtime loads as a real Cordis plugin and registers its task-level tools', async (t) => {
  const env = await fixture(t);
  try {
    await env.host.ctx.plugin(env.plugin, {}).await();
    assert.equal(registered(env.host, 'runtime_status'), true);
    assert.equal(registered(env.host, 'runtime_run'), true);
    assert.equal(env.plugin.healthProbe.probe().status, 'ok');
    const status = report(await env.host.execute('runtime_status', { arguments: {} }));
    assert.equal(status.tasks.length, 1);
    assert.equal(status.templates[0].recipeId, 'json-normalize');
  } finally { env.close(); }
});

test('a model may only run natively registered tasks', async (t) => {
  const env = await fixture(t);
  try {
    await env.host.ctx.plugin(env.plugin, {}).await();
    const unknown = await env.host.execute('runtime_run', { arguments: { taskRef: 'invented-task' } });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /not registered natively|task_not_registered/);
    const status = report(await env.host.execute('runtime_status', { arguments: {} }));
    assert.equal(status.templates.length, 1);
  } finally { env.close(); }
});

test('a registered task runs end to end through the plugin tool', async (t) => {
  const env = await fixture(t);
  try {
    await env.host.ctx.plugin(env.plugin, {}).await();
    // A task-level tool is only meaningful for an identified caller, so the call supplies one explicitly.
    const agent = await env.host.agent('plugin-caller');
    const run = report(await env.host.execute('runtime_run', { arguments: { taskRef: 'fixture-normalize' }, agent }));
    assert.equal(run.status, 'completed');
    const inspected = report(await env.host.execute('runtime_status', { arguments: { taskId: run.taskId } }));
    assert.equal(inspected.run.status, 'completed');
    assert.equal(inspected.run.budgetUsage.toolCalls, 1);
  } finally { env.close(); }
});

test('a task-level tool refuses to run without an identified caller', async (t) => {
  const env = await fixture(t);
  try {
    await env.host.ctx.plugin(env.plugin, {}).await();
    const anonymous = await env.host.execute('runtime_run', { arguments: { taskRef: 'fixture-normalize' } });
    assert.equal(anonymous.isError, true);
    assert.match(anonymous.content[0].text, /calling agent/);
  } finally { env.close(); }
});

test('the host stays usable after the plugin is unloaded', async (t) => {
  const env = await fixture(t);
  try {
    const fiber = await env.host.ctx.plugin(env.plugin, {});
    assert.equal(registered(env.host, 'runtime_status'), true);
    await fiber.dispose();
    // Unloading must remove the runtime's own tools; the host must still run unrelated tools.
    assert.equal(registered(env.host, 'runtime_status'), false, 'runtime_status must be gone after unload');
    assert.equal(registered(env.host, 'runtime_run'), false, 'runtime_run must be gone after unload');
    assert.equal(env.plugin.healthProbe.probe().findings[0].code, 'execution-runtime.unloaded');
    env.host.register('post-unload-probe', () => ({ alive: true }));
    const result = await env.host.execute('post-unload-probe', { arguments: {} });
    assert.equal(result.isError, false);
    assert.deepEqual(env.plugin.describe(), { disposed: true, executors: 0, schedulers: 0 });
  } finally { env.close(); }
});

test('the probe reports a not-applied state instead of a silent ok', async (t) => {
  const env = await fixture(t, { withTask: false });
  try {
    const before = env.plugin.healthProbe.probe();
    assert.equal(before.status, 'degraded');
    assert.equal(before.findings[0].code, 'execution-runtime.not-applied');
  } finally { env.close(); }
});
