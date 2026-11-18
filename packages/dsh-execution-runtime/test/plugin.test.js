import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync, existsSync } from 'node:fs';
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
async function fixture(t, { withTask = true, slow = false } = {}) {
  const host = await createHost(t);
  const store = new RuntimeStore(join(host.root, 'plugin.sqlite'));
  writeFileSync(join(host.storage, 'source.json'), JSON.stringify([{ id: 'a', name: ' Alpha ' }]));
  let release;
  let gate = null;
  if (slow) gate = new Promise((resolve) => { release = resolve; });
  host.tools.register({ name: 'runtime_write_json', description: 'Create an owned fixture artifact.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, createOnly: { type: 'boolean', enum: [true] } },
      required: ['path', 'content', 'createOnly'], additionalProperties: false },
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: '{"created":true}' }] },
    async execute({ path, content }) {
      if (gate) await gate;
      writeFileSync(path, content, { flag: 'wx' });
      return { created: true };
    } });
  const tasks = {};
  const runIds = [];
  if (withTask) {
    tasks['fixture-normalize'] = async ({ agent }) => ({
      task: { taskId: randomUUID(), recipeId: 'json-normalize', recipeVersion: '1',
        goal: 'Create sorted normalized records.', scopeRef: 'plugin-scope', workspaceRoot: host.storage,
        inputs: { inputFile: 'source.json', outputFile: 'output.json' }, deadlineAt: Date.now() + 60_000 },
      authority: { scopeRef: 'plugin-scope', workspaceRoot: host.storage, allowedTools: ['runtime_write_json'], agent },
    });
    // Remember which run ids the native factory produced so tests can inspect persisted state.
    const factory = tasks['fixture-normalize'];
    tasks['fixture-normalize'] = async (input) => {
      const prepared = await factory(input);
      runIds.push(prepared.task.taskId);
      return prepared;
    };
  }
  const plugin = createExecutionRuntimePlugin({ store, recipes: [jsonNormalizeRecipe], tasks, owner: host.ctx,
    validateArguments({ tool, arguments: args }) {
      assertObjectJsonSchema(tool.parameters);
      return validateJsonSchemaValue(tool.parameters, args);
    } });
  return { host, store, plugin, runIds, release: () => release?.(), close: () => { try { store.close(); } catch { /* closed */ } } };
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
    assert.deepEqual(env.plugin.describe(), { disposed: true, executors: 0, schedulers: 0, active: 0 });
  } finally { env.close(); }
});

test('unloading removes the tools so a late call is refused by the host', async (t) => {
  const env = await fixture(t);
  try {
    const fiber = await env.host.ctx.plugin(env.plugin, {});
    await fiber.dispose();
    assert.equal(registered(env.host, 'runtime_run'), false);
    const agent = await env.host.agent('late-caller');
    const outcome = await env.host.execute('runtime_run', { arguments: { taskRef: 'fixture-normalize' }, agent });
    assert.equal(outcome.isError, true);
    assert.equal(outcome.error.info.code, 'UNKNOWN_TOOL');
    assert.equal(env.plugin.describe().active, 0, 'A refused call must not be tracked as in-flight work.');
  } finally { env.close(); }
});

test('an unloaded runtime refuses dispatch at its own entry too', async (t) => {
  const env = await fixture(t);
  try {
    const fiber = await env.host.ctx.plugin(env.plugin, {});
    // Capture the registered definition before unload, then call its body directly afterwards.
    const tool = env.host.tools.get('runtime_run');
    assert.ok(tool, 'runtime_run must be registered while loaded');
    await fiber.dispose();
    const agent = await env.host.agent('direct-caller');
    await assert.rejects(async () => tool.execute({ taskRef: 'fixture-normalize' }, { agent }),
      { code: 'runtime_unloaded' });
  } finally { env.close(); }
});

test('drain waits for in-flight work and the persisted run survives unload', async (t) => {
  const env = await fixture(t, { slow: true });
  try {
    const fiber = await env.host.ctx.plugin(env.plugin, {});
    const agent = await env.host.agent('slow-caller');
    const work = env.host.execute('runtime_run', { arguments: { taskRef: 'fixture-normalize' }, agent });
    // Wait until the run actually reaches the tool body, so the unload happens mid-flight.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && env.plugin.describe().active === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(env.plugin.describe().active, 1,
      'An in-flight run must be tracked; a green drain with nothing tracked proves nothing.');
    await fiber.dispose();
    assert.equal(env.plugin.healthProbe.probe().findings[0].code, 'execution-runtime.draining',
      'Unloading with work in flight must not report a plain unloaded state.');
    let drainedEarly = null;
    const early = env.plugin.drain().then((value) => { drainedEarly = value; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(drainedEarly, null, 'drain() must not resolve while the gated tool body is still running.');
    env.release();
    await early;
    assert.equal(drainedEarly.drained, 1, 'drain() must report the work it actually waited for.');
    assert.equal(drainedEarly.pending, 0);
    const result = await work;
    assert.equal(result.isError, false);
    // The persisted run outlives the plugin instance, which is what makes resume or reconcile possible.
    const run = env.store.getRun(result.value.taskId);
    assert.ok(['completed', 'waiting_analysis', 'reconciling'].includes(run.status));
    assert.equal(env.plugin.healthProbe.probe().findings[0].code, 'execution-runtime.unloaded');
  } finally { env.close(); }
});

test('a caller cancellation through the plugin tool converges instead of leaving an orphan run', async (t) => {
  const env = await fixture(t);
  try {
    await env.host.ctx.plugin(env.plugin, {}).await();
    const agent = await env.host.agent('cancelling-caller');
    // Abort while the business tool is running: the public pipeline must converge and persist a state.
    const controller = new AbortController();
    env.host.ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name === 'runtime_write_json') controller.abort('caller cancelled');
      return next();
    });
    const result = await env.host.execute('runtime_run', {
      arguments: { taskRef: 'fixture-normalize' }, agent, signal: controller.signal,
    });
    // The caller's own signal aborts the outer call as well, so the host reports it as cancelled...
    assert.equal(result.isError, true, 'A cancelled caller call is reported as an error, not a success.');
    // ...but the run it started must converge in persisted state with nothing left unresolved.
    const [taskId] = env.runIds;
    assert.ok(taskId, 'The native factory must have been invoked once.');
    const inspected = (await env.host.execute('runtime_status', { arguments: { taskId } })).value.run;
    assert.equal(inspected.status, 'cancelled', `unexpected ${inspected.status}`);
    assert.equal(env.store.listUnresolved(taskId).length, 0, 'A cancelled run leaves nothing unresolved.');
    assert.equal(existsSync(join(env.host.storage, 'output.json')), false, 'Cancelling before dispatch must not write.');
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
