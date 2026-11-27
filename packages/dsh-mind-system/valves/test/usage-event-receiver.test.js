import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openUsageEventReceiver } from '../src/usage-event-receiver.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'usage-receiver-'));
  return join(dir, 'events.sqlite');
}
function cleanup(t, file) {
  t.after(() => rmSync(join(file, '..'), { recursive: true, force: true }));
}
function event(overrides = {}) {
  const value = { sourceStoreId: randomUUID(), eventId: randomUUID(), href: 'functions/example.md', kind: 'positive', note: '中文', createdAt: '2026-11-24T00:00:00.000Z', ...overrides };
  value.payloadHash = createHash('sha256').update(JSON.stringify({ href: value.href, kind: value.kind, note: value.note }), 'utf8').digest('hex');
  return value;
}
function child(file, value, discard = false) {
  const moduleUrl = new URL('../src/usage-event-receiver.js', import.meta.url).href;
  const script = `import { openUsageEventReceiver } from ${JSON.stringify(moduleUrl)};
    const receiver = openUsageEventReceiver(process.argv[1]);
    try { const result = receiver.receive(JSON.parse(process.argv[2])); if (process.argv[3] !== 'discard') console.log(JSON.stringify(result)); }
    catch (error) { console.log(JSON.stringify({ error: error.code || error.message })); }
    finally { receiver.close(); }`;
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', script, file, JSON.stringify(value), discard ? 'discard' : 'keep'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', (data) => { out += data; });
    proc.stderr.on('data', (data) => { err += data; });
    proc.on('error', reject);
    proc.on('close', (code) => code === 0 ? resolve(out.trim() ? JSON.parse(out) : null) : reject(new Error(err)));
  });
}

test('accepts the agreed UTF-8 payload hash vector', (t) => {
  const file = fixture(t), receiver = openUsageEventReceiver(file);
  t.after(() => receiver.close());
  cleanup(t, file);
  const value = event();
  value.payloadHash = '0afd8f3402ba13297ded8cec11b85bd56588a2256d0240ec83c6d89c559cfb0a';
  assert.equal(receiver.receive(value).status, 'received');
});

test('durable replay, conflict, independent source, and forged claims', (t) => {
  const file = fixture(t), first = event();
  let receiver = openUsageEventReceiver(file);
  const received = receiver.receive({ ...first, governanceEligible: true, provenance: 'authenticated', principleId: 'forged' });
  assert.equal(received.status, 'received');
  assert.equal(received.event.governanceEligible, false);
  assert.equal(received.event.provenance, 'caller_declaration');
  assert.equal(received.event.principleId, undefined);
  receiver.close();
  receiver = openUsageEventReceiver(file);
  t.after(() => receiver.close());
  cleanup(t, file);
  assert.equal(receiver.receive(first).status, 'replay');
  assert.throws(() => receiver.receive({ ...first, payloadHash: '0'.repeat(64) }), { code: 'usage_event_hash_mismatch' });
  assert.throws(() => receiver.receive(event({ ...first, note: 'changed' })), { code: 'usage_event_conflict' });
  assert.throws(() => receiver.receive({ ...first, createdAt: '2026-11-25T00:00:00.000Z' }), { code: 'usage_event_conflict' });
  const other = { ...first, sourceStoreId: randomUUID() };
  assert.equal(receiver.receive(other).status, 'received');
  assert.deepEqual(receiver.get(first.sourceStoreId, first.eventId), received.event);
  assert.equal(receiver.get(other.sourceStoreId, other.eventId).governanceEligible, false);
});

test('failed insertion rolls back and allows retry', (t) => {
  const file = fixture(t), value = event();
  const receiver = openUsageEventReceiver(file);
  t.after(() => receiver.close());
  cleanup(t, file);
  const db = new DatabaseSync(file);
  db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON received_usage_events BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
  assert.throws(() => receiver.receive(value));
  assert.equal(receiver.get(value.sourceStoreId, value.eventId), null);
  db.exec('DROP TRIGGER reject_event');
  db.close();
  assert.equal(receiver.receive(value).status, 'received');
});

test('processes serialize simultaneous duplicate and conflicting writes', async (t) => {
  const file = fixture(t), value = event();
  cleanup(t, file);
  const init = openUsageEventReceiver(file); init.close();
  const results = await Promise.all(Array.from({ length: 6 }, () => child(file, value)));
  assert.equal(results.filter((r) => r.status === 'received').length, 1);
  assert.equal(results.filter((r) => r.status === 'replay').length, 5);
  const competing = event({ eventId: randomUUID(), sourceStoreId: value.sourceStoreId });
  const changed = event({ ...competing, note: 'different' });
  const outcomes = await Promise.all([child(file, competing), child(file, changed)]);
  assert.equal(outcomes.filter((r) => r.status === 'received').length, 1);
  assert.equal(outcomes.filter((r) => r.error === 'usage_event_conflict').length, 1);
});

test('lost commit receipt is reconciled by identity after process restart', async (t) => {
  const file = fixture(t), value = event();
  cleanup(t, file);
  assert.equal(await child(file, value, true), null);
  assert.equal((await child(file, value)).status, 'replay');
});

test('tampering with stored payload is detected on read and replay', (t) => {
  const file = fixture(t), value = event(), receiver = openUsageEventReceiver(file);
  t.after(() => receiver.close());
  cleanup(t, file);
  receiver.receive(value);
  const db = new DatabaseSync(file);
  db.prepare('UPDATE received_usage_events SET payload=?').run('{}');
  db.close();
  assert.throws(() => receiver.get(value.sourceStoreId, value.eventId), { code: 'corrupt_usage_event' });
  assert.throws(() => receiver.receive(value), { code: 'corrupt_usage_event' });
});
