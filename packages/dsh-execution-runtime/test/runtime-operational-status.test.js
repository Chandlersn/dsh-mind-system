import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeStore } from '../src/store.js';
import { createHost } from './helpers/host.js';
import * as entry from '../src/host-plugin.js';

const waitFor = async (fn) => {
  const deadline = Date.now() + 3000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for dispatcher state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test('host status reports configuration and absent calls without exposing secrets or writing', async (t) => {
  const host = await createHost(t);
  const stateDir = mkdtempSync(join(host.root, 'status-'));
  const seeded = new RuntimeStore(join(stateDir, 'runtime.sqlite'));
  seeded.createRun({ taskId: 'known', recipeId: 'csv-normalize', recipeVersion: '1', goal: 'Fixture',
    scopeRef: 'test', workspaceRoot: host.storage, inputs: {}, deadlineAt: Date.now() + 60000 });
  seeded.close();
  const fiber = await host.ctx.plugin(entry.plugin, { enabled: true, stateDir, workspaceRoot: host.storage,
    analysis: { endpoint: 'https://secret.example/path?token=private', model: 'private-model', apiKey: 'private-key' },
    outbox: { intervalMs: 300000 } });
  await fiber.await();
  const db = new DatabaseSync(join(stateDir, 'runtime.sqlite'), { readOnly: true });
  try {
    const before = db.prepare('PRAGMA data_version').get().data_version;
    const first = await host.execute('runtime_status', { arguments: {} });
    assert.equal(first.isError, false);
    assert.deepEqual(first.value.analysis, { configuration: 'configured_explicit', invocation: 'unknown' });
    assert.deepEqual(first.value.outbox, { startup: 'started', state: 'receiver_unavailable', lastPass: null });
    assert.ok(Array.isArray(first.value.templates));
    assert.deepEqual(first.value.tasks, []);
    assert.doesNotMatch(JSON.stringify(first.value), /secret\.example|private-key|private-model|status-|runtime\.sqlite/);
    assert.deepEqual(host.ctx.get('executionRuntimeStatus').snapshot().analysis, first.value.analysis);
    const named = await host.execute('runtime_status', { arguments: { taskId: 'known' } });
    assert.equal(named.value.run.taskId, 'known');
    assert.deepEqual(named.value.outbox, first.value.outbox);
    const second = await host.execute('runtime_status', { arguments: {} });
    assert.deepEqual(second.value.outbox, first.value.outbox);
    assert.equal(db.prepare('PRAGMA data_version').get().data_version, before);
  } finally { db.close(); await fiber.dispose(); }
});

test('identity unavailable does not claim the dispatcher started', async (t) => {
  const host = await createHost(t);
  const original = RuntimeStore.prototype.getProducerId;
  RuntimeStore.prototype.getProducerId = () => { throw new Error('private identity failure'); };
  let fiber;
  try {
    fiber = await host.ctx.plugin(entry.plugin, { enabled: true,
      stateDir: mkdtempSync(join(host.root, 'status-')), workspaceRoot: host.storage });
    await fiber.await();
    const result = await host.execute('runtime_status', { arguments: {} });
    assert.deepEqual(result.value.outbox, { startup: 'unavailable', state: 'identity_unavailable', lastPass: null });
    assert.doesNotMatch(JSON.stringify(result.value), /private identity failure/);
  } finally {
    if (fiber) await fiber.dispose();
    RuntimeStore.prototype.getProducerId = original;
  }
});

test('dispatcher pass and failure are observed through the actual registered host tool', async (t) => {
  const host = await createHost(t);
  const stateDir = mkdtempSync(join(host.root, 'status-'));
  let reads = 0;
  let fail = false;
  const original = RuntimeStore.prototype.listPendingOutbox;
  RuntimeStore.prototype.listPendingOutbox = function (...args) {
    reads++;
    if (fail) throw new Error('private path and private secret');
    return original.apply(this, args);
  };
  const unprovide = host.ctx.provide('valves', { receiveRepairEvent() { throw new Error('Unexpected delivery'); } });
  let fiber;
  try {
    fiber = await host.ctx.plugin(entry.plugin, { enabled: true, stateDir, workspaceRoot: host.storage,
      outbox: { intervalMs: 50 } });
    await fiber.await();
    const service = host.ctx.get('executionRuntimeStatus');
    await waitFor(() => service.snapshot().outbox.lastPass !== null);
    const result = await host.execute('runtime_status', { arguments: {} });
    assert.deepEqual(result.value.analysis, { configuration: 'disabled', invocation: 'unknown' });
    assert.deepEqual(result.value.outbox.lastPass, { attempted: 0, acknowledged: 0, duplicates: 0,
      retried: 0, skipped: 0, unavailable: false });
    const observedReads = reads;
    await host.execute('runtime_status', { arguments: {} });
    assert.equal(reads, observedReads);
    fail = true;
    await waitFor(() => service.snapshot().outbox.state === 'error');
    const failed = await host.execute('runtime_status', { arguments: {} });
    assert.equal(failed.value.outbox.state, 'error');
    assert.deepEqual(failed.value.outbox.lastPass, result.value.outbox.lastPass);
    assert.doesNotMatch(JSON.stringify(failed.value), /private path|private secret/);
  } finally {
    if (fiber) await fiber.dispose();
    RuntimeStore.prototype.listPendingOutbox = original;
    if (typeof unprovide === 'function') await unprovide();
  }
});
