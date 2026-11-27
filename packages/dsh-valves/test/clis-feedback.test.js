import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const combined = new URL('../../clis/clis-event-store.js', import.meta.url);
const standalone = new URL('../../dsh-clis/clis-event-store.js', import.meta.url);
const { openClisEventStore, readClisFeedback } = await import((existsSync(combined) ? combined : standalone).href);
import { createClisEventReceiver } from '../src/clis-event-receiver.js';
import { createRuntime } from '../index.js';

test('legacy receipt, interrupted return, lost acknowledgement and conflicting feedback', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'clis-feedback-'));
  const file = join(dir, 'producer.sqlite');
  let store = openClisEventStore(file);
  const { event } = store.record({ eventId: randomUUID(), kind: 'future.kind', payload: { private: 'local' } });
  const { eventId, producerId } = event;
  const query = () => readClisFeedback(file, producerId, eventId);
  let peer = { pending: store.pending, recordReceipt: store.recordReceipt };
  const runtime = createRuntime({ storageDir: dir, getClisOutbox: () => peer });
  const db = new DatabaseSync(file);
  t.after(() => { runtime.dispose(); store.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  await runtime.retryClisEvents();
  assert.equal(runtime.clisEventStatus().feedbackError, 'producer_feedback_unsupported');
  const receiptBytes = () => db.prepare('SELECT * FROM clis_receipts').all();
  const original = receiptBytes();
  const receiptId = original[0].receipt_id;
  store.close();
  db.exec('DROP TABLE clis_feedback_v1');
  assert.equal(query().status, 'feedback_schema_unavailable');
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='clis_feedback_v1'").get().n, 0);
  store = openClisEventStore(file);
  peer = { pending: store.pending, recordReceipt: store.recordReceipt, recordFeedback() { throw new Error('lost before write'); } };
  async function rotate() { await runtime.retryClisEvents(); await runtime.retryClisEvents(); }
  await rotate();
  assert.equal(runtime.clisEventStatus().state, 'retry_failed');
  assert.equal(query().status, 'feedback_not_observed');
  const message = { schemaVersion: 1, eventId, producerId, receiptId, classification: 'unsupported_kind' };
  for (const [patch, code] of [[{ producerId: randomUUID() }, 'producer_mismatch'], [{ eventId: randomUUID() }, 'receipt_identity_mismatch'], [{ receiptId: randomUUID() }, 'receipt_not_found'], [{ schemaVersion: 2 }, 'invalid_feedback'], [{ governanceEligible: true }, 'invalid_feedback'], [{ classification: 'adopted' }, 'invalid_feedback']]) {
    assert.throws(() => store.recordFeedback({ ...message, ...patch }), { code });
  }
  peer.recordFeedback = value => { store.recordFeedback(value); throw new Error('lost after commit'); };
  await rotate();
  assert.equal(runtime.clisEventStatus().state, 'retry_failed');
  assert.equal(query().classification, 'unsupported_kind');
  peer = store;
  await rotate();
  assert.equal(runtime.clisEventStatus().failed, 0);
  assert.equal(store.recordFeedback(message).status, 'replay');
  assert.throws(() => store.recordFeedback({ ...message, classification: 'caller_declared_achieved' }), { code: 'feedback_conflict' });
  assert.equal(query().classification, 'unsupported_kind');
  assert.deepEqual(receiptBytes(), original);
  assert.equal(db.prepare('SELECT count(*) AS n FROM clis_feedback_v1').get().n, 1);
  assert.equal(store.pending()[0].deliveryStatus, 'pending');
  assert.equal(JSON.stringify(query()).includes('private'), false);
  assert.equal(readClisFeedback(file, producerId, randomUUID()).status, 'event_not_found');
  assert.throws(() => readClisFeedback(file, randomUUID(), eventId), { code: 'producer_mismatch' });
  db.exec("UPDATE clis_feedback_v1 SET evidence_hash='changed'");
  assert.throws(query, { code: 'corrupt_feedback' });
});

test('producer and receiver agree on the same IDs after both hosts restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'clis-feedback-restart-'));
  const producerPath = join(dir, 'producer.sqlite');
  const inboxPath = join(dir, 'valves', 'clis-event-inbox.sqlite');
  mkdirSync(join(dir, 'valves'));
  let store = openClisEventStore(producerPath);
  const { event } = store.record({ eventId: randomUUID(), kind: 'clis.run.v1', payload: {
    schemaVersion: 1, source: 'clis_run', baseline: true, causalType: 'cyclic', planSignal: 'ineffective',
    feedback: { outcome: 'failed', association: 'no_prior_history' },
  } });
  const { producerId, eventId } = event;
  let receiver = createClisEventReceiver({ filePath: inboxPath });
  const received = receiver.receive({ producerId, eventId, kind: event.kind, payload: event.payload }).receipt;
  store.recordReceipt({ receiptId: received.receiptId, eventId, evidence: received });
  const feedback = { schemaVersion: 1, producerId, eventId, receiptId: received.receiptId, classification: 'baseline_unassociated_feedback' };
  store.recordFeedback(feedback);
  const before = readClisFeedback(producerPath, producerId, eventId);
  const receiverView = receiver.consumption(producerId, eventId);
  assert.equal(before.classification, receiverView.classification);
  assert.equal(before.receiptId, received.receiptId);
  store.close(); receiver.close();
  // A fresh host process sees only the durable files under the same IDs.
  store = openClisEventStore(producerPath);
  receiver = createClisEventReceiver({ filePath: inboxPath });
  t.after(() => { store.close(); receiver.close(); rmSync(dir, { recursive: true, force: true }); });
  const after = readClisFeedback(producerPath, producerId, eventId);
  assert.deepEqual(after, { status: 'recorded', ...feedback, authenticated: false, humanAdoption: 'unknown', principleAttribution: 'unknown', governanceEligible: false });
  assert.deepEqual(after, before);
  const consumed = receiver.consumption(producerId, eventId);
  assert.equal(consumed.classification, after.classification);
  assert.equal(consumed.producerId, producerId);
  assert.equal(consumed.eventId, eventId);
  assert.equal(consumed.authenticated, false);
  assert.equal(consumed.governanceEligible, false);
  assert.equal(receiver.get(producerId, eventId).receiptId, after.receiptId);
  assert.equal(store.receipts(eventId)[0].receiptId, after.receiptId);
});
