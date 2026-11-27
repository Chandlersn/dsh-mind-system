import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createHost, deferred, installed, waitFor } from './helpers/host.js';
import { RuntimeStore } from '../src/store.js';
import { HostExecutor } from '../src/executor.js';
import { RuntimeScheduler } from '../src/scheduler.js';
import { jsonNormalizeRecipe } from '../recipes/json-normalize.js';

const { assertObjectJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(installed['dsh-tools'].entry).href);

test('remaining safety gap: a downstream host wrapper can resume the body after post-gate recovery', async (t) => {
  const entered = deferred();
  const release = deferred();
  let running, executor, store, secondStore, removeWrapper;
  t.after(async () => {
    release.resolve();
    if (running) await running.catch(() => {});
    await removeWrapper?.();
    await executor?.dispose();
    secondStore?.close();
    store?.close();
  });
  const host = await createHost(t);
  const agent = await host.agent('post-gate-race');
  const db = join(host.root, 'post-gate-race.sqlite');
  store = new RuntimeStore(db);
  secondStore = new RuntimeStore(db);
  executor = new HostExecutor({ context: host.ctx, tools: host.tools, agent });
  writeFileSync(join(host.storage, 'source.json'), '[{"id":"a","name":" Alpha "}]');
  host.tools.register({ name: 'runtime_write_json', description: 'Create a fixture artifact.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, createOnly: { type: 'boolean', enum: [true] } },
      required: ['path', 'content', 'createOnly'], additionalProperties: false },
    output: { schema: {}, render: () => [{ type: 'text', text: '{}' }] },
    async execute({ path, content }) {
      host.ledger('body');
      writeFileSync(path, content, { flag: 'wx' });
      return { created: true };
    } });

  const assertDispatchAllowed = store.assertDispatchAllowed.bind(store);
  store.assertDispatchAllowed = (...args) => {
    const result = assertDispatchAllowed(...args);
    host.ledger('gate-authorized');
    return result;
  };
  // Pre-execute runs after HostExecutor registers its execute hook, but before
  // the host constructs the execute waterfall. The wrapper is downstream.
  host.ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'runtime_write_json') {
      removeWrapper = host.ctx.on('tools/execute', async (wrapped, proceed) => {
        if (wrapped !== exec) return proceed();
        host.ledger('wrapper-entered');
        entered.resolve();
        await release.promise;
        return proceed();
      });
    }
    return next();
  });
  const task = { taskId: randomUUID(), recipeId: 'json-normalize', recipeVersion: '1',
    goal: 'Normalize records.', scopeRef: 'post-gate-race', workspaceRoot: host.storage,
    inputs: { inputFile: 'source.json', outputFile: 'output.json' }, deadlineAt: Date.now() + 60_000 };
  const authority = { scopeRef: task.scopeRef, workspaceRoot: host.storage, allowedTools: ['runtime_write_json'], agent };
  const scheduler = new RuntimeScheduler({ store, executor, recipes: [jsonNormalizeRecipe], tools: host.tools,
    validateArguments({ tool, arguments: args }) { assertObjectJsonSchema(tool.parameters); return validateJsonSchemaValue(tool.parameters, args); } });
  running = scheduler.run(task, { authority });
  await waitFor(entered.promise, 'downstream wrapper entry');
  assert.deepEqual(host.rows().map((row) => row.kind), ['gate-authorized', 'wrapper-entered']);
  const before = secondStore.getRun(task.taskId);
  const attempt = secondStore.listUnresolved(task.taskId)[0];
  assert.equal(attempt.status, 'started');
  assert.equal(existsSync(join(host.storage, 'output.json')), false);
  const frozen = secondStore.recoverRun(task.taskId, { expectedVersion: before.version });
  assert.equal(frozen.status, 'reconciling');
  assert.ok(frozen.fence > before.fence);
  assert.equal(secondStore.listUnresolved(task.taskId)[0].status, 'unknown');
  assert.throws(() => assertDispatchAllowed(task.taskId, attempt.attemptId, { fence: before.fence }), { code: 'stale_owner' });
  release.resolve();
  await waitFor(running, 'scheduler completion after recovery');
  assert.deepEqual(host.rows().map((row) => row.kind), ['gate-authorized', 'wrapper-entered', 'body']);
  assert.deepEqual(JSON.parse(readFileSync(join(host.storage, 'output.json'), 'utf8')), [{ id: 'a', name: 'Alpha' }]);
  assert.equal(secondStore.getRun(task.taskId).status, 'reconciling');
  const unresolved = secondStore.listUnresolved(task.taskId);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].attemptId, attempt.attemptId);
  assert.equal(unresolved[0].status, 'unknown');
  assert.equal(unresolved[0].outcome, null);
  assert.equal(unresolved[0].verification, null);
});
