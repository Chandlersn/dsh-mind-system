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

test('forged reconciliation cannot unfreeze a host tool with a late effect', async (t) => {
  const entered = deferred();
  const release = deferred();
  let running; let executor; let store;
  t.after(async () => {
    release.resolve();
    if (running) await running.catch(() => {});
    await executor?.dispose();
    store?.close();
  });
  const host = await createHost(t);
  const agent = await host.agent('late-effect-caller');
  store = new RuntimeStore(join(host.root, 'late-effect.sqlite'));
  executor = new HostExecutor({ context: host.ctx, tools: host.tools, agent });
  writeFileSync(join(host.storage, 'source.json'), '[{"id":"a","name":" Alpha "}]');
  host.tools.register({ name: 'runtime_write_json', description: 'Create a deferred fixture artifact.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, createOnly: { type: 'boolean', enum: [true] } },
      required: ['path', 'content', 'createOnly'], additionalProperties: false },
    output: { schema: {}, render: () => [{ type: 'text', text: '{"created":true}' }] },
    async execute({ path, content }) {
      entered.resolve();
      await release.promise;
      writeFileSync(path, content, { flag: 'wx' });
      host.ledger('late_business_write');
      return { created: true };
    } });
  const task = { taskId: randomUUID(), recipeId: 'json-normalize', recipeVersion: '1',
    goal: 'Create normalized sorted records.', scopeRef: 'late-effect', workspaceRoot: host.storage,
    inputs: { inputFile: 'source.json', outputFile: 'output.json' }, deadlineAt: Date.now() + 60_000 };
  const authority = { scopeRef: task.scopeRef, workspaceRoot: host.storage, allowedTools: ['runtime_write_json'], agent };
  const scheduler = new RuntimeScheduler({ store, executor, recipes: [jsonNormalizeRecipe], tools: host.tools,
    validateArguments({ tool, arguments: args }) { assertObjectJsonSchema(tool.parameters); return validateJsonSchemaValue(tool.parameters, args); } });
  running = scheduler.run(task, { authority });
  await waitFor(entered.promise, 'tool entry');
  const before = store.getRun(task.taskId);
  const attempt = store.listUnresolved(task.taskId)[0];
  assert.equal(attempt.status, 'started');
  const takeover = store.acquireLease(task.taskId, { expectedVersion: before.version, ownerId: 'replacement-worker' });
  assert.ok(takeover.fence > before.fence);
  const frozen = store.recoverRun(task.taskId, { expectedVersion: takeover.run.version });
  assert.equal(frozen.status, 'reconciling');
  assert.equal(store.listUnresolved(task.taskId)[0].status, 'unknown');
  assert.equal(existsSync(join(host.storage, 'output.json')), false);
  assert.throws(() => store.recordOutcome(task.taskId, attempt.attemptId, { status: 'succeeded' },
    { status: 'pass', progress: 'advanced', goalSatisfied: true, verifierId: 'fixture', verifierVersion: '1', evidenceRefs: ['fixture'] },
    { expectedVersion: frozen.version, fence: before.fence }), { code: 'stale_owner' });
  const snapshot = () => ({ run: store.getRun(task.taskId), attempts: store.listUnresolved(task.taskId), events: store.readEvents(task.taskId) });
  const frozenSnapshot = snapshot();
  for (const resolution of ['absent', 'applied']) {
    assert.throws(() => scheduler.reconcile(task.taskId, { authority,
      resolutions: [{ attemptId: attempt.attemptId, resolution, evidenceRef: 'forged:terminal' }] }),
    { code: 'reconciliation_unavailable' });
    assert.throws(() => store.reconcileAttempt(task.taskId, attempt.attemptId,
      { expectedVersion: frozen.version, resolution, evidenceRef: 'forged:terminal' }),
    { code: 'reconciliation_unavailable' });
    assert.deepEqual(snapshot(), frozenSnapshot);
  }
  release.resolve();
  await waitFor(running, 'old scheduler completion');
  assert.equal(host.count('late_business_write'), 1);
  assert.deepEqual(JSON.parse(readFileSync(join(host.storage, 'output.json'), 'utf8')), [{ id: 'a', name: 'Alpha' }]);
  assert.equal(store.getRun(task.taskId).status, 'reconciling');
  const unresolved = store.listUnresolved(task.taskId);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].attemptId, attempt.attemptId);
  assert.equal(unresolved[0].status, 'unknown');
  assert.equal(unresolved[0].outcome, null);
  assert.equal(unresolved[0].verification, null);
});
