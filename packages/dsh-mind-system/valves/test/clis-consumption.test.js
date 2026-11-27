import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRuntime } from '../index.js';
import { createClisEventReceiver } from '../src/clis-event-receiver.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'clis-consume-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filePath = join(dir, 'clis-event-inbox.sqlite');
  return { dir, filePath, open: () => createClisEventReceiver({ filePath }) };
}
function event(outcome = 'failed', baseline = false, association = 'prior_history') {
  return { producerId: randomUUID(), eventId: randomUUID(), kind: 'clis.run.v1', payload: {
    schemaVersion: 1, source: 'clis_run', causalType: 'cyclic', planSignal: 'type_misjudged', baseline, feedback: { outcome, association },
  } };
}

test('only associated caller failures become review candidates; pages preserve both IDs', t => {
  const store = fixture(t).open();
  try {
    const failure = event();
    const other = { ...failure, producerId: randomUUID() };
    for (const [input, classification] of [
      [failure, 'pending_failure_review'], [other, 'pending_failure_review'],
      [event('not_provided', true, 'none'), 'baseline'], [event('failed', true, 'no_prior_history'), 'baseline_unassociated_feedback'],
      [event('achieved'), 'caller_declared_achieved'], [event('not_tried', false, 'none'), 'not_tried'],
      [event('not_provided', false, 'none'), 'not_provided'], [event('failed', false, 'none'), 'invalid_run_payload'],
      [{ ...event(), kind: 'other' }, 'unsupported_kind'], [{ ...event(), payload: null }, 'invalid_run_payload'],
    ]) {
      const first = store.receive(input);
      const result = store.consumption(input.producerId, input.eventId);
      assert.equal(result.classification, classification);
      assert.deepEqual(store.receive(input).receipt, first.receipt);
      assert.deepEqual(store.consumption(input.producerId, input.eventId), result);
    }
    const page = store.reviewCandidates({ limit: 1 });
    assert.equal(page.items[0].producerId, failure.producerId);
    const rest = store.reviewCandidates({ after: page.next });
    assert.deepEqual(rest.items.map(row => [row.producerId, row.eventId]), [[other.producerId, failure.eventId]]);
    assert.equal(rest.next, null);
  } finally { store.close(); }
});

test('a rejected consumption write rolls back the new inbox entry and receipt', t => {
  const { open, filePath } = fixture(t);
  const receiver = open();
  const db = new DatabaseSync(filePath);
  const item = event();
  try {
    db.exec("CREATE TRIGGER reject_consume BEFORE INSERT ON clis_consumption_v1 BEGIN SELECT RAISE(ABORT, 'consume failed'); END;");
    assert.throws(() => receiver.receive(item), /consume failed/);
    for (const table of ['clis_event_inbox', 'clis_event_results', 'clis_consumption_v1']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
    db.exec('DROP TRIGGER reject_consume');
    receiver.receive(item);
    assert.equal(receiver.reviewCandidates().items.length, 1);
  } finally { db.close(); receiver.close(); }
});

test('recovery pages roll back together and include later legacy writes', t => {
  const { filePath, open } = fixture(t);
  const receiver = open();
  const db = new DatabaseSync(filePath);
  try {
    const original = event();
    receiver.receive(original);
    receiver.recover();
    const addLegacy = () => {
      const id = randomUUID();
      db.prepare('INSERT INTO clis_event_inbox SELECT producer_id,?,kind,payload,payload_hash,received_at FROM clis_event_inbox WHERE event_id=?').run(id, original.eventId);
      db.prepare("INSERT INTO clis_event_results VALUES(?,?,?,'received')").run(original.producerId, id, randomUUID());
    };
    for (let i = 0; i < 55; i++) addLegacy();
    db.exec("CREATE TRIGGER reject_second BEFORE INSERT ON clis_consumption_v1 WHEN (SELECT count(*) FROM clis_consumption_v1)=2 BEGIN SELECT RAISE(ABORT,'recover failed'); END;");
    assert.throws(() => receiver.recover(), /recover failed/);
    assert.equal(receiver.reviewCandidates().items.length, 1);
    assert.equal(db.prepare('SELECT after_receipt FROM clis_recovery_v1').get().after_receipt, 1);
    db.exec('DROP TRIGGER reject_second');
    receiver.recover();
    const partial = receiver.reviewCandidates({ limit: 100 });
    assert.equal(partial.items.length, 51);
    assert.equal(partial.recoveryScanPending, true);
    receiver.recover();
    assert.equal(receiver.reviewCandidates({ limit: 100 }).items.length, 56);
    assert.equal(receiver.reviewCandidates().recoveryScanPending, false);
    addLegacy();
    receiver.recover();
    assert.equal(receiver.reviewCandidates({ limit: 100 }).items.length, 57);
  } finally { db.close(); receiver.close(); }
});

test('host recovers legacy receipts without an outbox and replays original evidence unchanged', async t => {
  const { dir, filePath, open } = fixture(t);
  const item = event();
  const old = open();
  const original = old.receive(item).receipt;
  old.close();
  const db = new DatabaseSync(filePath);
  db.exec('DROP TABLE clis_consumption_v1; DROP TABLE clis_recovery_v1');
  db.close();
  const rt = createRuntime({ storageDir: dir });
  try {
    await rt.retryClisEvents();
    assert.equal(rt.clisEventStatus().state, 'outbox_unavailable');
    const report = await rt.govern({ principles: [], read_clis_candidates: true });
    assert.deepEqual(report.clis_review.items.map(row => [row.producerId, row.eventId]), [[item.producerId, item.eventId]]);
  } finally { rt.dispose(); }
  const restored = open();
  try {
    assert.deepEqual(restored.receive(item), { status: 'replay', receipt: original });
    assert.throws(() => restored.receive({ ...item, payload: {} }), { code: 'event_conflict' });
    assert.equal(restored.reviewCandidates().items.length, 1);
  } finally { restored.close(); }
});
