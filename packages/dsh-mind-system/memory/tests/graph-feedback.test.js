import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const sourceClis = new URL('../../dsh-clis/clis-event-store.js', import.meta.url);
const sourceValves = new URL('../../dsh-valves/src/clis-event-receiver.js', import.meta.url);
const { openClisEventStore } = await import(existsSync(sourceClis) ? sourceClis : new URL('../../clis/clis-event-store.js', import.meta.url));
const { createClisEventReceiver } = await import(existsSync(sourceValves) ? sourceValves : new URL('../../valves/src/clis-event-receiver.js', import.meta.url));
import { collectFacts, classifyEdges } from '../src/graph-runtime.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'graph-feedback-'));
  const clisDb = join(dir, 'clis.sqlite'), valveDb = join(dir, 'valves.sqlite');
  const store = openClisEventStore(clisDb), receiver = createClisEventReceiver({ filePath: valveDb });
  const eventId = randomUUID();
  store.record({ eventId, kind: 'example', payload: { value: 1 } });
  const receipt = receiver.receive({ producerId: store.producerId, eventId, kind: 'example', payload: { value: 1 } }).receipt;
  store.recordReceipt({ eventId, receiptId: receipt.receiptId, evidence: receipt });
  store.recordFeedback({ schemaVersion: 1, producerId: store.producerId, eventId, receiptId: receipt.receiptId, classification: 'unsupported_kind' });
  store.close(); receiver.close();
  return { dir, clisDb, valveDb, receivedAt: receipt.receivedAt };
}
const edge = f => classifyEdges(collectFacts(f)).find(e => e.id === 'valves consumption -> clis feedback');
const cleanup = f => rmSync(f.dir, { recursive: true, force: true });
function mutate(path, sql) { const db = new DatabaseSync(path); try { db.exec(sql); } finally { db.close(); } }

test('matching feedback reports only technical agreement', () => {
  const f = fixture();
  try {
    const result = edge(f);
    assert.equal(result.status, 'observed');
    assert.equal(result.evidenceScope, 'historical');
    assert.equal(result.currentActivity, 'unknown');
    assert.equal(result.latestReceiptAt, f.receivedAt);
    assert.match(result.detail, /matching classifications=1/);
    assert.match(result.detail, /unauthenticated.*human adoption.*unknown.*not governance eligible/);
  } finally { cleanup(f); }
});

test('feedback uses receipt time only, including legacy and invalid timestamps', () => {
  for (const value of [undefined, 'invalid', '2026-02-30T00:00:00Z', '2026-11-26T02:30:00.000Z', '2099-01-01T00:00:00Z']) {
    const f = fixture();
    try {
      const db = new DatabaseSync(f.clisDb);
      try {
        const row = db.prepare('SELECT receipt_id, evidence FROM clis_receipts').get();
        const evidence = JSON.parse(row.evidence);
        if (value === undefined) delete evidence.receivedAt; else evidence.receivedAt = value;
        const text = JSON.stringify(evidence);
        db.prepare('UPDATE clis_receipts SET evidence=?, evidence_hash=? WHERE receipt_id=?').run(text, createHash('sha256').update(text).digest('hex'), row.receipt_id);
      } finally { db.close(); }
      const result = edge(f);
      assert.equal(result.status, 'observed');
      assert.equal(result.latestReceiptAt, ['2026-11-26T02:30:00.000Z', '2099-01-01T00:00:00Z'].includes(value) ? value : null);
      assert.equal(result.currentActivity, 'unknown');
    } finally { cleanup(f); }
  }
});

test('missing, altered, or mismatched evidence remains unknown', () => {
  for (const [which, sql] of [
    ['clisDb', "UPDATE clis_feedback_v1 SET evidence_hash='bad'"],
    ['clisDb', "UPDATE clis_receipts SET evidence_hash='bad'"],
    ['clisDb', "UPDATE clis_events SET payload_hash='bad'"],
    ['clisDb', "UPDATE clis_meta SET value='bad'"],
    ['valveDb', "UPDATE clis_consumption_v1 SET classification='baseline'"],
    ['valveDb', "UPDATE clis_event_results SET receipt_id='bad'"],
    ['valveDb', "UPDATE clis_event_inbox SET payload_hash='bad'"],
    ['valveDb', 'DELETE FROM clis_consumption_v1'],
    ['valveDb', 'DROP TABLE clis_consumption_v1'],
  ]) {
    const f = fixture();
    try { mutate(f[which], sql); assert.equal(edge(f).status, 'unknown', sql); assert.equal(edge(f).latestReceiptAt, null, sql); }
    finally { cleanup(f); }
  }
});

test('empty feedback is no_data and a scan over 100 is unknown', () => {
  const f = fixture();
  try {
    mutate(f.clisDb, 'DELETE FROM clis_feedback_v1');
    assert.equal(edge(f).status, 'no_data');
    mutate(f.clisDb, `PRAGMA foreign_keys=OFF; WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<101)
      INSERT INTO clis_feedback_v1 SELECT printf('%d',x),'{}','bad' FROM n`);
    assert.equal(edge(f).status, 'unknown');
  } finally { cleanup(f); }
});
