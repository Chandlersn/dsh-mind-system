import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openClisEventStore, newClisEventId } from './clis-event-store.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'clis-store-'));
  const path = join(dir, 'events.sqlite');
  const stores = [];
  const open = () => { const s = openClisEventStore(path); stores.push(s); return s; };
  t.after(() => { for (const s of stores) s.close(); rmSync(dir, { recursive: true, force: true }); });
  return { path, open };
}
const event = (eventId = newClisEventId()) => ({ eventId, kind: 'intervention.evaluated', payload: { b: 2, a: 1 } });

test('reopen, idempotence, conflict, paginated pending and untrusted receipt', (t) => {
  const f = fixture(t); let s = f.open(); const producer = s.producerId; const e = event();
  assert.equal(s.record(e).status, 'created');
  assert.equal(s.record({ ...e, payload: { a: 1, b: 2 } }).status, 'replay');
  assert.throws(() => s.record({ ...e, payload: { a: 3 } }), { code: 'event_conflict' });
  const second = event(); s.record(second);
  const first = s.pending({ limit: 1 }); assert.equal(first.length, 1);
  assert.equal(s.pending({ limit: 1, after: first[0].sequence })[0].eventId, second.eventId);
  const receiptId = newClisEventId();
  assert.equal(s.recordReceipt({ receiptId, eventId: e.eventId, evidence: { status: 'accepted' } }).authenticated, false);
  assert.equal(s.recordReceipt({ receiptId, eventId: e.eventId, evidence: { status: 'accepted' } }).status, 'replay');
  assert.throws(() => s.recordReceipt({ receiptId, eventId: e.eventId, evidence: { status: 'duplicate' } }), { code: 'receipt_conflict' });
  assert.throws(() => s.markDelivered(e.eventId), { code: 'trusted_delivery_evidence_unavailable' });
  s.close(); s = f.open(); assert.equal(s.producerId, producer);
  assert.equal(s.record(e).status, 'replay'); assert.equal(s.pending().length, 2);
  assert.equal(s.receipts(e.eventId)[0].authenticated, false);
  assert.throws(() => s.pending({ limit: 101 }), { code: 'invalid_scan' });
  assert.throws(() => s.record({ ...event(), payload: { a: undefined } }), { code: 'invalid_payload' });
});

test('outbox failure rolls back the event and retry retains identity', (t) => {
  const f = fixture(t); const s = f.open(); const db = new DatabaseSync(f.path);
  db.exec("CREATE TRIGGER reject_outbox BEFORE INSERT ON clis_outbox BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  const e = event(); assert.throws(() => s.record(e), /injected failure/);
  assert.equal(s.get(e.eventId), null); assert.equal(s.pending().length, 0);
  db.exec('DROP TRIGGER reject_outbox'); db.close(); assert.equal(s.record(e).status, 'created');
});

test('different processes concurrently initialize and replay one event', async (t) => {
  const f = fixture(t); const eventId = newClisEventId();
  const source = `import { openClisEventStore, newClisEventId } from ${JSON.stringify(new URL('./clis-event-store.js', import.meta.url).href)}; const s=openClisEventStore(process.argv[1]); let invoked=0; let rejected=false; try { s.record({get eventId(){invoked++; return newClisEventId()},kind:'test',payload:{}}) } catch(e) { rejected=e.code==='invalid_payload' } if(!rejected || invoked) throw Error('unsafe accessor'); const result=s.record({eventId:process.argv[2],kind:'intervention.evaluated',payload:{value:1}}); process.stdout.write(JSON.stringify({producer:s.producerId,status:result.status})); s.close();`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, f.path, eventId], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = ''; child.stdout.on('data', x => output += x); child.stderr.on('data', x => errors += x);
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors)));
  });
  const results = await Promise.all(Array.from({ length: 6 }, run));
  assert.equal(new Set(results.map(x => x.producer)).size, 1);
  assert.equal(results.filter(x => x.status === 'created').length, 1);
  const s = f.open(); assert.equal(s.pending().length, 1); assert.equal(s.producerId, results[0].producer);
});

test('rejects damaged bytes, orphaned rows and altered payload', (t) => {
  const f = fixture(t); const s = f.open(); const e = event(); s.record(e); s.close();
  const db = new DatabaseSync(f.path); db.exec("UPDATE clis_events SET payload='{}'"); db.close();
  const reopened = f.open(); assert.throws(() => reopened.get(e.eventId), { code: 'corrupt_event' }); reopened.close();
  const db2 = new DatabaseSync(f.path); db2.exec('DELETE FROM clis_outbox'); db2.close();
  assert.throws(() => f.open(), { code: 'corrupt_store' });
  const broken = join(tmpdir(), `clis-invalid-${newClisEventId()}.sqlite`);
  t.after(() => rmSync(broken, { force: true })); writeFileSync(broken, 'not a sqlite database');
  assert.throws(() => openClisEventStore(broken));
});
test('rejects changing accessors and proxies without invoking them or writing', (t) => {
  const f = fixture(t); const s = f.open(); const a = newClisEventId(), b = newClisEventId(); let calls = 0;
  const changing = { get eventId() { return calls++ ? b : a; }, kind: 'test', payload: {} };
  assert.throws(() => s.record(changing), { code: 'invalid_payload' });
  assert.equal(calls, 0);
  const nested = { get value() { calls++; return 1; } };
  assert.throws(() => s.record({ eventId: a, kind: 'test', payload: nested }), { code: 'invalid_payload' });
  const proxy = new Proxy({}, { ownKeys() { calls++; return []; } });
  assert.throws(() => s.record({ eventId: a, kind: 'test', payload: { proxy } }), { code: 'invalid_payload' });
  assert.throws(() => s.record(new Proxy({ eventId: a, kind: 'test', payload: {} }, {})), { code: 'invalid_payload' });
  const array = [1]; Object.defineProperty(array, '0', { get() { calls++; return 1; }, enumerable: true });
  assert.throws(() => s.record({ eventId: a, kind: 'test', payload: array }), { code: 'invalid_payload' });
  assert.equal(calls, 0); assert.equal(s.get(a), null); assert.equal(s.get(b), null); assert.deepEqual(s.pending(), []);
  s.record({ eventId: a, kind: 'test', payload: {} });
  assert.throws(() => s.recordReceipt({ receiptId: newClisEventId(), eventId: a, evidence: nested }), { code: 'invalid_payload' });
  assert.deepEqual(s.receipts(a), []); assert.equal(calls, 0);
});

test('reopen detects unsynchronized changes to bound event fields', async (t) => {
  for (const field of ['event_id', 'kind', 'payload', 'created_at', 'seq', 'producer_id']) {
    await t.test(field, (child) => {
      const f = fixture(child); const s = f.open(); const id = newClisEventId();
      s.record({ eventId: id, kind: 'test', payload: { x: 1 } }); s.close();
      const db = new DatabaseSync(f.path);
      if (field === 'producer_id') db.prepare("UPDATE clis_meta SET value=? WHERE key='producer_id'").run(newClisEventId());
      else if (field === 'event_id') {
        db.exec('PRAGMA foreign_keys=OFF');
        const replacement = newClisEventId();
        db.prepare('UPDATE clis_events SET event_id=?').run(replacement);
        db.prepare('UPDATE clis_outbox SET event_id=?').run(replacement);
      } else if (field === 'seq') db.exec('UPDATE clis_events SET seq=seq+10');
      else db.prepare(`UPDATE clis_events SET ${field}=?`).run(field === 'kind' ? 'changed' : field === 'payload' ? '{}' : '2030-01-01T00:00:00.000Z');
      db.close(); const reopened = f.open();
      assert.throws(() => reopened.pending(), { code: 'corrupt_event' });
    });
  }
});

