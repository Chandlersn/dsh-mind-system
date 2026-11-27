import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { newUsageEventId, openUsageEventStore } from '../packages/dsh-memory-manager/src/usage-event-store.js';
import { openUsageEventReceiver } from '../packages/dsh-valves/src/usage-event-receiver.js';

function envelope(event) {
  const { sourceStoreId, eventId, href, kind, note, payloadHash, createdAt } = event;
  return { sourceStoreId, eventId, href, kind, note, payloadHash, createdAt };
}

test('memory events survive a lost receiver receipt and remain caller declarations', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'usage-protocol-'));
  const sourcePath = join(directory, 'source.sqlite');
  const receiverPath = join(directory, 'receiver.sqlite');
  let source, receiver;
  t.after(() => {
    source?.close();
    receiver?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const eventId = newUsageEventId();
  const originalNote = `Chinese text ${'sk-' + 'A'.repeat(24)}`;
  source = openUsageEventStore(sourcePath);
  const recorded = source.record({ eventId, href: 'functions/example.md', kind: 'positive', note: originalNote });
  assert.equal(recorded.status, 'created');
  assert.equal(recorded.event.note, 'Chinese text [REDACTED:openai-key]');
  assert.equal(recorded.event.deliveryStatus, 'unknown');
  assert.equal(recorded.event.legacyDeliveryClaim, false);
  const delivery = envelope(recorded.event);
  assert.deepEqual(Object.keys(delivery), ['sourceStoreId', 'eventId', 'href', 'kind', 'note', 'payloadHash', 'createdAt']);
  assert.equal('delivered' in delivery, false);
  assert.equal('provenance' in delivery, false);
  assert.equal('governanceEligible' in delivery, false);

  receiver = openUsageEventReceiver(receiverPath);
  receiver.receive(delivery);
  // The caller discards the receipt and cannot infer the commit outcome.
  receiver.close(); receiver = undefined;
  source.close(); source = undefined;

  source = openUsageEventStore(sourcePath);
  receiver = openUsageEventReceiver(receiverPath);
  const pending = source.pending();
  assert.equal(pending.length, 1);
  const retry = envelope(pending[0]);
  assert.deepEqual(retry, delivery);
  const replay = receiver.receive(retry);
  assert.equal(replay.status, 'replay');
  assert.equal(replay.event.provenance, 'caller_declaration');
  assert.equal(replay.event.governanceEligible, false);
  assert.equal(receiver.get(delivery.sourceStoreId, eventId).governanceEligible, false);
  assert.throws(() => source.markDelivered(eventId, delivery.payloadHash, replay), { code: 'trusted_delivery_evidence_unavailable' });
  assert.equal(source.pending().some((item) => item.eventId === eventId), true);
  source.close(); source = undefined;
  receiver.close(); receiver = undefined;
  source = openUsageEventStore(sourcePath);
  receiver = openUsageEventReceiver(receiverPath);
  assert.equal(source.pending().some((item) => item.eventId === eventId), true);
  assert.equal(source.get(eventId).deliveryStatus, 'unknown');
  assert.equal(source.get(eventId).legacyDeliveryClaim, false);
  assert.equal(receiver.receive(delivery).status, 'replay');

  const changedTime = new Date(Date.parse(delivery.createdAt) + 1000).toISOString();
  assert.throws(() => receiver.receive({ ...delivery, createdAt: changedTime }), { code: 'usage_event_conflict' });
  assert.throws(() => receiver.receive({ ...delivery, payloadHash: '0'.repeat(64) }), { code: 'usage_event_hash_mismatch' });
  const changed = { ...delivery, note: 'changed body' };
  changed.payloadHash = createHash('sha256').update(JSON.stringify({ href: changed.href, kind: changed.kind, note: changed.note }), 'utf8').digest('hex');
  assert.throws(() => receiver.receive(changed), { code: 'usage_event_conflict' });
  assert.equal(receiver.receive({ ...delivery, governanceEligible: true, provenance: 'authenticated' }).event.governanceEligible, false);

  const db = new DatabaseSync(receiverPath, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS count FROM received_usage_events').get().count, 1);
  } finally { db.close(); }

  const fakeId = newUsageEventId();
  const fakeEvent = source.record({ eventId: fakeId, href: 'functions/example.md', kind: 'correction' }).event;
  const fakeReceipt = { status: 'received', event: { sourceStoreId: fakeEvent.sourceStoreId, eventId: fakeId, payloadHash: fakeEvent.payloadHash } };
  assert.equal(receiver.get(fakeEvent.sourceStoreId, fakeId), null);
  assert.throws(() => source.markDelivered(fakeId, fakeEvent.payloadHash, fakeReceipt), { code: 'trusted_delivery_evidence_unavailable' });
  assert.equal(source.get(fakeId).deliveryStatus, 'unknown');
  assert.equal(source.pending().some((item) => item.eventId === fakeId), true);
  assert.equal(receiver.get(fakeEvent.sourceStoreId, fakeId), null);
  source.close(); source = undefined;
  source = openUsageEventStore(sourcePath);
  assert.deepEqual(new Set(source.pending().map((item) => item.eventId)), new Set([eventId, fakeId]));
});
