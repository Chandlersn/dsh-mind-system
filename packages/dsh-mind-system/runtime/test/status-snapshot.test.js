import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeStore } from '../src/store.js';
import { createHost } from './helpers/host.js';
import * as hostEntry from '../src/host-plugin.js';

const task = (root, taskId) => ({ taskId, recipeId: 'csv-normalize', recipeVersion: '1', goal: 'Check a fixture.',
  scopeRef: 'test', workspaceRoot: root, inputs: {}, deadlineAt: Date.now() + 60000 });
const candidate = { candidateId: 'write', toolName: 'fixture_write', arguments: {}, preconditionIds: ['scope'],
  postconditionIds: ['output'], progressKey: 'output', effect: 'reversible_write',
  source: { recipeId: 'csv-normalize', version: '1' } };

test('host snapshot reports persisted facts without writing and enforces bounds', async (t) => {
  const host = await createHost(t);
  const stateDir = mkdtempSync(join(host.root, 'state-'));
  const filename = join(stateDir, 'runtime.sqlite');
  const seed = new RuntimeStore(filename);
  for (let i = 0; i < 102; i++) seed.createRun(task(host.storage, `run-${String(i).padStart(3, '0')}`));
  const reserved = seed.reserveAttempt('run-000', candidate, { expectedVersion: 0, attemptId: 'attempt-1' });
  seed.markStarted('run-000', 'attempt-1', { expectedVersion: reserved.run.version });
  seed.stopRun('run-001', 'failed', 'fixture_failure', { expectedVersion: 0 });
  seed.close();
  const fiber = await host.ctx.plugin(hostEntry.plugin, { enabled: true, stateDir, workspaceRoot: host.storage,
    tasks: [task(host.storage, 'run-000'), task(host.storage, 'never-run')] });
  await fiber.await();
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const service = host.ctx.get('executionRuntimeStatus');
    assert.ok(service);
    assert.deepEqual(Object.keys(service), ['snapshot']);
    const before = db.prepare('PRAGMA data_version').get().data_version;
    const events = db.prepare('SELECT count(*) AS count FROM events').get().count;
    const snapshot = service.snapshot();
    assert.equal(snapshot.state, 'ready');
    assert.equal(snapshot.limit, 100);
    assert.equal(snapshot.runs.length, 100);
    assert.equal(snapshot.truncated, true);
    assert.deepEqual(snapshot.registeredTasks, { taskIds: ['never-run', 'run-000'], truncated: false });
    const started = snapshot.runs.find((run) => run.taskId === 'run-000');
    assert.equal(started.registered, true);
    assert.deepEqual(started.unresolved, { count: 1, first: { attemptId: 'attempt-1', status: 'started' } });
    const failed = snapshot.runs.find((run) => run.taskId === 'run-001');
    assert.equal(failed.reason, 'fixture_failure');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.registered, false);
    assert.equal(service.snapshot({ limit: 1 }).registeredTasks.truncated, true);
    for (const limit of [0, 101, -1, 1.5, '2']) assert.equal(service.snapshot({ limit }).error, 'invalid_snapshot_limit');
    assert.equal(db.prepare('PRAGMA data_version').get().data_version, before);
    assert.equal(db.prepare('SELECT count(*) AS count FROM events').get().count, events);
    const tool = await host.execute('runtime_status', { arguments: {} });
    assert.equal(tool.isError, false);
    db.close();
    const writer = new DatabaseSync(filename);
    writer.exec('DROP TABLE attempts');
    writer.close();
    assert.deepEqual(service.snapshot(), { state: 'error', error: 'snapshot_failed' });
    await fiber.dispose();
    assert.equal(host.ctx.get('executionRuntimeStatus'), undefined);
    assert.equal(service.snapshot().state, 'unavailable');
  } finally { if (db.isOpen) db.close(); await fiber.dispose(); }
});

test('disabled and failed mounts expose distinct states without opening a snapshot store', async (t) => {
  const host = await createHost(t);
  const disabled = await host.ctx.plugin(hostEntry.plugin, { enabled: false });
  await disabled.await();
  const service = host.ctx.get('executionRuntimeStatus');
  assert.deepEqual(service.snapshot(), { state: 'disabled' });
  await disabled.dispose();
  assert.equal(host.ctx.get('executionRuntimeStatus'), undefined);
  host.tools.register({ name: 'runtime_write_text', description: 'Existing tool',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object' }, render: () => [] }, async execute() { return {}; } });
  const failed = await host.ctx.plugin(hostEntry.plugin, { enabled: true,
    stateDir: mkdtempSync(join(host.root, 'failed-')), workspaceRoot: host.storage });
  await failed.await();
  assert.deepEqual(host.ctx.get('executionRuntimeStatus').snapshot(), { state: 'error', error: 'runtime_assembly_failed' });
  await failed.dispose();
});
