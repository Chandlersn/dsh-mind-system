import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { RuntimeStore } from '../src/store.js';
import { createHost } from './helpers/host.js';
import * as hostEntry from '../src/host-plugin.js';

function seed(root, workspaceRoot) {
  const store = new RuntimeStore(join(root, 'runtime.sqlite'));
  store.createRun({ taskId: 'task', recipeId: 'fixture', recipeVersion: '1', goal: 'Test outbox',
    scopeRef: 'test', workspaceRoot, inputs: {}, deadlineAt: Date.now() + 60000, budget: { maxAnalysisCalls: 2 } });
  const options = () => ({ expectedVersion: store.getRun('task').version });
  store.stopRun('task', 'waiting_analysis', 'exception', options());
  const { analysisId } = store.reserveAnalysis('task', options());
  store.recordAnalysis('task', analysisId, { status: 'proposed', repair: {
    kind: 'gather_evidence', diagnosis: { location: 'fixture', cause: 'wrong_guess', evidenceRefs: [] },
    requiresHumanReview: false, probeIds: ['inspect'],
  } }, options());
  const { repairId } = store.startRepair('task', analysisId, { ...options(), signature: 'fixture' });
  store.finishRepair('task', repairId, { ...options(), status: 'blocked' });
  const event = store.listPendingOutbox()[0];
  store.close();
  return event;
}

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for host outbox state');
}

test('host retries late service, rejects forged acknowledgements, and keeps identity after restart', async (t) => {
  const host = await createHost(t);
  const stateDir = mkdtempSync(join(host.root, 'outbox-'));
  const event = seed(stateDir, host.storage);
  const config = { enabled: true, stateDir, workspaceRoot: host.storage, outbox: { intervalMs: 15 } };
  let fiber = await host.ctx.plugin(hostEntry.plugin, config);
  await fiber.await();
  const status = host.ctx.get('executionRuntimeStatus');
  assert.equal(status.snapshot().outbox.state, 'receiver_unavailable');
  const deliveries = [];
  let response = { accepted: true, duplicate: true };
  const disposeValve = host.ctx.provide('valves', { receiveRepairEvent(message) { deliveries.push(message); return response; } });
  try {
    await until(() => deliveries.length > 0 && status.snapshot().outbox.lastPass?.retried > 0);
    assert.equal(deliveries[0].eventId, event.eventId);
    let check = new RuntimeStore(join(stateDir, 'runtime.sqlite'));
    assert.equal(check.listPendingOutbox().length, 1);
    check.close();
    response = { accepted: false, duplicate: true, eventId: 'forged' };
    const before = deliveries.length;
    await until(() => deliveries.length > before);
    check = new RuntimeStore(join(stateDir, 'runtime.sqlite'));
    assert.equal(check.listPendingOutbox().length, 1);
    check.close();
    const producerId = deliveries[0].producerId;
    assert.equal(typeof producerId, 'string');
    assert.ok(producerId.length);
    await fiber.dispose();
    fiber = await host.ctx.plugin(hostEntry.plugin, config);
    response = { accepted: false, duplicate: true };
    await fiber.await();
    await until(() => deliveries.some((item) => item.producerId === producerId) && host.ctx.get('executionRuntimeStatus').snapshot().outbox.lastPass?.duplicates === 1);
    assert.equal(deliveries.at(-1).producerId, producerId);
    check = new RuntimeStore(join(stateDir, 'runtime.sqlite'));
    assert.deepEqual(check.listPendingOutbox(), []);
    check.close();
  } finally {
    await fiber.dispose();
    if (typeof disposeValve === 'function') await disposeValve();
  }
});

test('host disposal waits for in-flight delivery before closing its store', async (t) => {
  const host = await createHost(t);
  const stateDir = mkdtempSync(join(host.root, 'outbox-'));
  seed(stateDir, host.storage);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered = false;
  const disposeValve = host.ctx.provide('valves', { async receiveRepairEvent() {
    entered = true;
    await gate;
    return { accepted: true, duplicate: false };
  } });
  const fiber = await host.ctx.plugin(hostEntry.plugin, { enabled: true, stateDir, workspaceRoot: host.storage,
    outbox: { intervalMs: 15 } });
  await fiber.await();
  await until(() => entered);
  let disposed = false;
  const stopping = fiber.dispose().then(() => { disposed = true; });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(disposed, false);
  release();
  await stopping;
  const check = new RuntimeStore(join(stateDir, 'runtime.sqlite'));
  assert.deepEqual(check.listPendingOutbox(), []);
  check.close();
  if (typeof disposeValve === 'function') await disposeValve();
});
