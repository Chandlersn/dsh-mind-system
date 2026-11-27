import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createHost, deferred, installed, waitFor } from './helpers/host.js';
import { RuntimeStore } from '../src/store.js';
import { HostExecutor } from '../src/executor.js';
import { RuntimeScheduler } from '../src/scheduler.js';
import { jsonNormalizeRecipe } from '../recipes/json-normalize.js';

const { assertObjectJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(installed['dsh-tools'].entry).href);

async function setup(t, { barrier = 'gate', asyncGate = false } = {}) {
  const entered = deferred();
  const release = deferred();
  let running, executor, store;
  t.after(async () => { release.resolve(); if (running) await running.catch(() => {}); await executor?.dispose(); store?.close(); });
  const host = await createHost(t);
  const agent = await host.agent('fence-caller');
  store = new RuntimeStore(join(host.root, 'fence.sqlite'));
  executor = new HostExecutor({ context: host.ctx, tools: host.tools, agent });
  writeFileSync(join(host.storage, 'source.json'), '[{"id":"a","name":" Alpha "}]');
  host.tools.register({ name: 'runtime_write_json', description: 'Create a fixture artifact.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, createOnly: { type: 'boolean', enum: [true] } }, required: ['path', 'content', 'createOnly'], additionalProperties: false },
    output: { schema: {}, render: () => [{ type: 'text', text: '{}' }] },
    async execute({ path, content }) {
      if (barrier === 'body') { entered.resolve(); await release.promise; }
      writeFileSync(path, content, { flag: 'wx' });
      host.ledger('effect');
      return { created: true };
    } });
  let dispatchOutcome;
  const wrapped = { agent, async execute(candidate, options) {
    dispatchOutcome = await executor.execute(candidate, { ...options, ...(asyncGate ? { finalDispatchGate: async () => {} } : {}), beforeDispatch: async () => {
      await options.beforeDispatch();
      if (barrier === 'gate') { entered.resolve(); await release.promise; }
    } });
    return dispatchOutcome;
  } };
  const task = { taskId: randomUUID(), recipeId: 'json-normalize', recipeVersion: '1', goal: 'Normalize records.', scopeRef: 'fence', workspaceRoot: host.storage,
    inputs: { inputFile: 'source.json', outputFile: 'output.json' }, deadlineAt: Date.now() + 60_000 };
  const authority = { scopeRef: task.scopeRef, workspaceRoot: host.storage, allowedTools: ['runtime_write_json'], agent };
  const scheduler = new RuntimeScheduler({ store, executor: wrapped, recipes: [jsonNormalizeRecipe], tools: host.tools,
    validateArguments({ tool, arguments: args }) { assertObjectJsonSchema(tool.parameters); return validateJsonSchemaValue(tool.parameters, args); } });
  running = scheduler.run(task, { authority });
  await waitFor(entered.promise, 'dispatch barrier');
  return { host, store, task, release, running, outcome: () => dispatchOutcome };
}

for (const takeover of [false, true]) {
  test(`recovery ${takeover ? 'after supersession ' : ''}before the final gate blocks the host body`, async (t) => {
    const e = await setup(t);
    const old = e.store.getRun(e.task.taskId);
    const attempt = e.store.listUnresolved(e.task.taskId)[0];
    e.store.assertDispatchAllowed(e.task.taskId, attempt.attemptId, { fence: old.fence });
    assert.throws(() => e.store.assertDispatchAllowed(e.task.taskId, attempt.attemptId), { code: 'stale_owner' });
    assert.throws(() => e.store.assertDispatchAllowed(e.task.taskId, 'missing', { fence: old.fence }), { code: 'dispatch_not_allowed' });
    if (takeover) e.store.acquireLease(e.task.taskId, { expectedVersion: old.version, ownerId: 'replacement' });
    const before = e.store.getRun(e.task.taskId);
    const secondStore = new RuntimeStore(join(e.host.root, 'fence.sqlite'));
    let frozen;
    try { frozen = secondStore.recoverRun(e.task.taskId, { expectedVersion: before.version }); }
    finally { secondStore.close(); }
    assert.equal(frozen.fence, before.fence + 1);
    assert.equal(frozen.owner, null);
    assert.throws(() => e.store.assertDispatchAllowed(e.task.taskId, attempt.attemptId, { fence: old.fence }), { code: 'stale_owner' });
    e.release.resolve();
    assert.equal((await waitFor(e.running, 'scheduler completion')).status, 'reconciling');
    assert.equal(e.outcome().status, 'not_started');
    assert.equal(e.outcome().dispatchEntered, false);
    assert.equal(e.host.count('effect'), 0);
    assert.equal(existsSync(join(e.host.storage, 'output.json')), false);
    assert.equal(e.store.listUnresolved(e.task.taskId)[0].status, 'unknown');
    assert.deepEqual(e.store.recoverRun(e.task.taskId, { expectedVersion: frozen.version }), frozen);
  });
}

test('supersession alone before the final gate blocks the host body', async (t) => {
  const e = await setup(t);
  const before = e.store.getRun(e.task.taskId);
  e.store.acquireLease(e.task.taskId, { expectedVersion: before.version, ownerId: 'replacement' });
  e.release.resolve();
  await assert.rejects(e.running, { code: 'stale_owner' });
  assert.equal(e.outcome().status, 'not_started');
  assert.equal(e.host.count('effect'), 0);
  const frozen = e.store.recoverRun(e.task.taskId, { expectedVersion: e.store.getRun(e.task.taskId).version });
  assert.equal(frozen.status, 'reconciling');
  assert.equal(e.store.listUnresolved(e.task.taskId)[0].status, 'unknown');
});

test('an already entered host body can finish but cannot settle after recovery', async (t) => {
  const e = await setup(t, { barrier: 'body' });
  const before = e.store.getRun(e.task.taskId);
  const frozen = e.store.recoverRun(e.task.taskId, { expectedVersion: before.version });
  e.release.resolve();
  await waitFor(e.running, 'late scheduler completion');
  assert.equal(e.host.count('effect'), 1);
  assert.equal(e.store.getRun(e.task.taskId).status, 'reconciling');
  assert.equal(e.store.listUnresolved(e.task.taskId)[0].status, 'unknown');
  assert.equal(e.store.listUnresolved(e.task.taskId)[0].outcome, null);
  assert.equal(frozen.fence, before.fence + 1);
});

test('an asynchronous final gate is refused before dispatch', async (t) => {
  const e = await setup(t, { asyncGate: true });
  e.release.resolve();
  await waitFor(e.running, 'scheduler completion');
  assert.equal(e.outcome().status, 'not_started');
  assert.equal(e.outcome().error.code, 'executor_config');
  assert.equal(e.host.count('effect'), 0);
});

test('recovery with no unresolved work is a no-op', async (t) => {
  const e = await setup(t, { barrier: 'body' });
  e.release.resolve();
  const completed = await waitFor(e.running, 'completion');
  assert.equal(completed.status, 'completed');
  assert.deepEqual(e.store.recoverRun(e.task.taskId, { expectedVersion: completed.version }), completed);
});
