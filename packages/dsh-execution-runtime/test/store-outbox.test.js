import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeStore } from '../src/store.js';
import { createOutboxDispatcher } from '../src/outbox-dispatcher.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// The real receiver lives in the sibling valve package. In the combined bundle the layout differs
// (`valves/` instead of `dsh-valves/`), so both layouts are probed and the integration test is
// skipped when neither is reachable from this copy — the standalone suite still runs it.
const valveCandidates = [
  fileURLToPath(new URL('../../dsh-valves/index.js', import.meta.url)),
  fileURLToPath(new URL('../../valves/index.js', import.meta.url)),
];
const valveModulePath = valveCandidates.find((candidate) => existsSync(candidate));
const valveModuleUrl = valveModulePath === undefined ? null : new URL(`file:///${valveModulePath.replace(/\\/g, '/')}`).href;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-outbox-'));
  const filename = join(root, 'runtime.sqlite');
  let store = new RuntimeStore(filename, { now: () => 1000 });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const reopen = () => { store.close(); store = new RuntimeStore(filename, { now: () => 1000 }); return store; };
  const options = () => ({ expectedVersion: store.getRun('task').version });
  const prepare = () => {
    store.createRun({ taskId: 'task', recipeId: 'fixture', recipeVersion: '1', goal: 'Test outbox',
      scopeRef: 'fixture', workspaceRoot: root, inputs: {}, deadlineAt: 5000, budget: { maxAnalysisCalls: 2 } });
    store.stopRun('task', 'waiting_analysis', 'exception', options());
    const { analysisId } = store.reserveAnalysis('task', options());
    store.recordAnalysis('task', analysisId, { status: 'proposed', repair: {
      kind: 'gather_evidence', diagnosis: { location: 'fixture', cause: 'wrong_guess', evidenceRefs: [] },
      requiresHumanReview: false, probeIds: ['inspect'],
    } }, options());
    return store.startRepair('task', analysisId, { ...options(), signature: 'fixture' }).repairId;
  };
  return { filename, get store() { return store; }, reopen, options, prepare };
}

test('migration preserves pending repair event across reopen and supports conditional retry and acknowledgement', (t) => {
  const f = fixture(t);
  f.store.withDatabase((db) => db.exec('DROP TABLE event_outbox'));
  f.reopen();
  const repairId = f.prepare();
  assert.deepEqual(f.store.listPendingOutbox(), []);
  f.store.finishRepair('task', repairId, { ...f.options(), status: 'blocked', reason: 'denied' });
  const [pending] = f.store.listPendingOutbox();
  const event = f.store.readEvents('task').find((item) => item.kind === 'repair_finished');
  assert.equal(pending.eventId, event.eventId);
  assert.deepEqual(pending.payload, { status: 'blocked', taskId: 'task', repairId, succeeded: false, reason: 'denied' });
  assert.equal(pending.attempts, 0);
  assert.deepEqual(f.reopen().listPendingOutbox(), [pending]);
  assert.equal(f.store.retryOutbox(pending.eventId, { expectedAttempts: 0 }), true);
  assert.equal(f.store.acknowledgeOutbox(pending.eventId, { expectedAttempts: 0 }), false);
  assert.equal(f.store.listPendingOutbox()[0].attempts, 1);
  assert.equal(f.store.acknowledgeOutbox(pending.eventId, { expectedAttempts: 1 }), true);
  assert.equal(f.store.retryOutbox(pending.eventId, { expectedAttempts: 1 }), false);
  assert.deepEqual(f.reopen().listPendingOutbox(), []);
  assert.throws(() => f.store.listPendingOutbox({ limit: 101 }), { code: 'invalid_outbox' });
});

test('real valve receiver deduplicates a delivery when its first acknowledgement is lost', { skip: !valveModuleUrl && 'valve runtime module not reachable from this bundle layout' }, async (t) => {
  const f = fixture(t);
  const { createRuntime: createValveRuntime } = await import(valveModuleUrl);
  const repairId = f.prepare();
  f.store.finishRepair('task', repairId, { ...f.options(), status: 'blocked', reason: 'denied' });
  const producerId = f.store.getProducerId();
  const valves = createValveRuntime({ storageDir: join(f.filename, '..', 'valves') });
  let loseReceipt = true;
  const dispatcher = createOutboxDispatcher({ store: f.store, producerId, receiver: async (event) => {
    const receipt = valves.receiveRepairEvent(event);
    if (loseReceipt) { loseReceipt = false; throw new Error('receipt lost after commit'); }
    return { eventId: event.eventId, status: receipt.duplicate ? 'duplicate' : 'accepted' };
  } });
  try {
    const first = await dispatcher.dispatchOnce();
    assert.equal(first.retried, 1);
    assert.equal(valves.repairEventStatus().received, 1);
    assert.equal(f.store.listPendingOutbox().length, 1);
    const second = await dispatcher.dispatchOnce();
    assert.equal(second.duplicates, 1);
    assert.equal(valves.repairEventStatus().received, 1);
    assert.deepEqual(f.store.listPendingOutbox(), []);
    valves.dispose();
    assert.equal(valves.repairEventStatus().received, 1);
  } finally { valves.dispose(); }
});

test('producer identity persists across reopen and failed entries do not starve later entries', (t) => {
  const f = fixture(t);
  const producerId = f.store.getProducerId();
  assert.equal(f.reopen().getProducerId(), producerId);
  f.prepare();
  f.store.withDatabase((db) => {
    const event = db.prepare("INSERT INTO events(event_id, task_id, kind, payload_json, created_at) VALUES (?, 'task', 'repair_finished', ?, 1)");
    const outbox = db.prepare("INSERT INTO event_outbox(event_id, payload_json, created_at) VALUES (?, '{}', 1)");
    for (const id of ['a', 'b', 'c']) {
      event.run(id, JSON.stringify({ status: 'blocked', repairId: id }));
      outbox.run(id);
    }
  });
  const batch = f.store.listPendingOutbox({ limit: 2 });
  assert.deepEqual(batch.map((item) => item.eventId), ['a', 'b']);
  for (const row of batch) assert.equal(f.store.retryOutbox(row.eventId, { expectedAttempts: row.attempts }), true);
  assert.equal(f.store.listPendingOutbox({ limit: 1 })[0].eventId, 'c');
});

test('outbox insertion failure rolls back repair, run and event together', (t) => {
  const f = fixture(t);
  const repairId = f.prepare();
  const before = { run: f.store.getRun('task'), repair: f.store.getRepair('task', repairId), events: f.store.readEvents('task') };
  f.store.withDatabase((db) => db.exec("CREATE TRIGGER reject_outbox BEFORE INSERT ON event_outbox BEGIN SELECT RAISE(ABORT, 'outbox failure'); END"));
  assert.throws(() => f.store.finishRepair('task', repairId, { ...f.options(), status: 'blocked' }), /outbox failure/);
  assert.deepEqual({ run: f.store.getRun('task'), repair: f.store.getRepair('task', repairId), events: f.store.readEvents('task') }, before);
  assert.deepEqual(f.store.listPendingOutbox(), []);
  f.store.withDatabase((db) => db.exec('DROP TRIGGER reject_outbox'));
  f.store.finishRepair('task', repairId, { ...f.options(), status: 'blocked' });
  assert.equal(f.reopen().listPendingOutbox().length, 1);
});

test('outbox payload has a database-enforced byte limit', (t) => {
  const f = fixture(t);
  const repairId = f.prepare();
  f.store.finishRepair('task', repairId, { ...f.options(), status: 'blocked', reason: 'x'.repeat(200) });
  assert.deepEqual(f.store.listPendingOutbox()[0].payload, { status: 'blocked', taskId: 'task', repairId, succeeded: false, reason: 'x'.repeat(200) });
  f.store.withDatabase((db) => {
    assert.throws(() => db.prepare('UPDATE event_outbox SET payload_json = ?').run(JSON.stringify({ value: 'é'.repeat(1024) })), /CHECK constraint/);
  });
});
