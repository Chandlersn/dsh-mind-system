import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openUsageEventStore, newUsageEventId } from '../src/usage-event-store.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'usage-events-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'events.sqlite');
}
const input = (eventId) => ({ eventId, href: 'functions/demo.md', kind: 'positive', note: 'ok' });

test('identity persists, replays are idempotent, and conflicts are rejected', (t) => {
  const file = fixture(t), id = newUsageEventId();
  let store = openUsageEventStore(file);
  const created = store.record(input(id));
  const source = store.sourceStoreId;
  assert.equal(created.status, 'created');
  assert.equal(created.event.provenance, 'caller_declaration');
  assert.equal(created.event.governanceEligible, false);
  assert.equal(store.record(input(id)).status, 'replay');
  assert.throws(() => store.record({ ...input(id), note: 'different' }), /usage_event_conflict/);
  assert.throws(() => store.record({ ...input(newUsageEventId()), authenticated: true }), /invalid_usage_event/);
  assert.equal(store.pending().length, 1);
  store.close();
  store = openUsageEventStore(file);
  assert.equal(store.sourceStoreId, source);
  assert.equal(store.get(id).eventId, id);
  store.close();
});

test('redacts notes before persistence and rejects credential-shaped object keys', (t) => {
  const file = fixture(t), store = openUsageEventStore(file), id = newUsageEventId();
  const secret = 'sk-' + 'A'.repeat(30);
  const result = store.record({ ...input(id), note: `token ${secret}` });
  assert.equal(result.event.note, 'token [REDACTED:openai-key]');
  assert.throws(() => store.record({ ...input(newUsageEventId()), href: `functions/${secret}.md` }), /invalid_usage_event/);
  const db = new DatabaseSync(file, { readOnly: true });
  const row = db.prepare('SELECT payload FROM usage_events WHERE event_id=?').get(id);
  assert.equal(row.payload.includes(secret), false);
  db.close(); store.close();
});

test('two events with identical timestamp and payload remain distinct', (t) => {
  const store = openUsageEventStore(fixture(t));
  const OriginalDate = globalThis.Date;
  globalThis.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : ['2026-01-01T00:00:00.000Z'])); } };
  try {
    const a = store.record(input(newUsageEventId())).event;
    const b = store.record(input(newUsageEventId())).event;
    assert.equal(a.createdAt, b.createdAt);
    assert.notEqual(a.eventId, b.eventId);
    assert.equal(store.pending().length, 2);
  } finally { globalThis.Date = OriginalDate; store.close(); }
});

test('outbox insert failure rolls back the event', (t) => {
  const file = fixture(t), store = openUsageEventStore(file), id = newUsageEventId();
  const db = new DatabaseSync(file);
  db.exec("CREATE TRIGGER reject_outbox BEFORE INSERT ON usage_outbox BEGIN SELECT RAISE(ABORT,'injected'); END");
  assert.throws(() => store.record(input(id)), /injected/);
  assert.equal(store.get(id), null);
  assert.deepEqual(store.pending(), []);
  db.close(); store.close();
});

test('committed operation with lost acknowledgement reconciles by id', (t) => {
  const file = fixture(t), id = newUsageEventId();
  const store = openUsageEventStore(file);
  const original = DatabaseSync.prototype.exec;
  let injected = false;
  DatabaseSync.prototype.exec = function (sql) {
    const result = original.call(this, sql);
    if (sql === 'COMMIT' && !injected) { injected = true; throw new Error('lost acknowledgement'); }
    return result;
  };
  try { assert.throws(() => store.record(input(id)), /lost acknowledgement/); }
  finally { DatabaseSync.prototype.exec = original; }
  store.close();
  const reopened = openUsageEventStore(file);
  assert.equal(reopened.get(id).eventId, id);
  assert.equal(reopened.record(input(id)).status, 'replay');
  assert.equal(reopened.pending().length, 1);
  reopened.close();
});

test('abrupt process termination rolls back an incomplete transaction', (t) => {
  const file = fixture(t), store = openUsageEventStore(file), id = newUsageEventId();
  store.close();
  const script = `const {DatabaseSync}=require('node:sqlite'); const d=new DatabaseSync(process.argv[1]); d.exec('BEGIN IMMEDIATE'); d.prepare('INSERT INTO usage_events VALUES (?,?,?,?)').run(process.argv[2],'{}','x','t'); process.exit(0)`;
  const child = spawnSync(process.execPath, ['-e', script, file, id]);
  assert.equal(child.status, 0, child.stderr.toString());
  const reopened = openUsageEventStore(file);
  assert.equal(reopened.get(id), null);
  assert.deepEqual(reopened.pending(), []);
  reopened.close();
});

test('matching fabricated receipts cannot remove pending events', (t) => {
  const store = openUsageEventStore(fixture(t));
  const event = store.record(input(newUsageEventId())).event;
  for (const status of ['received', 'replay']) {
    assert.throws(() => store.markDelivered(event.eventId, event.payloadHash, { status, event }), /trusted_delivery_evidence_unavailable/);
  }
  assert.equal(store.get(event.eventId).deliveryStatus, 'unknown');
  assert.equal(store.pending().length, 1);
  store.close();
});

test('previously recorded caller claims cannot hide events', (t) => {
  const file = fixture(t), store = openUsageEventStore(file);
  const event = store.record(input(newUsageEventId())).event;
  const db = new DatabaseSync(file);
  db.prepare('UPDATE usage_outbox SET delivered=1 WHERE event_id=?').run(event.eventId);
  db.close(); store.close();
  const reopened = openUsageEventStore(file);
  assert.equal(reopened.get(event.eventId).deliveryStatus, 'unknown');
  assert.equal(reopened.get(event.eventId).legacyDeliveryClaim, true);
  assert.equal(reopened.pending()[0].eventId, event.eventId);
  reopened.close();
});

test('separate processes cannot mark fabricated receipts delivered', async (t) => {
  const file = fixture(t), store = openUsageEventStore(file);
  const event = store.record(input(newUsageEventId())).event;
  store.close();
  const moduleUrl = pathToFileURL(join(import.meta.dirname, '../src/usage-event-store.js')).href;
  const script = `import {openUsageEventStore} from ${JSON.stringify(moduleUrl)}; const s=openUsageEventStore(process.argv[1]); const e=JSON.parse(process.argv[2]); try { s.markDelivered(e.eventId,e.payloadHash,{status:'received',event:e}); process.exitCode=1; } catch (err) { console.log(err.code); } s.close();`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, file, JSON.stringify(event)]);
    let stdout = '', stderr = '';
    child.stdout.on('data', (v) => { stdout += v; });
    child.stderr.on('data', (v) => { stderr += v; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
  });
  assert.deepEqual((await Promise.all([run(), run()])).sort(), ['trusted_delivery_evidence_unavailable', 'trusted_delivery_evidence_unavailable']);
  const reopened = openUsageEventStore(file);
  assert.equal(reopened.pending()[0].eventId, event.eventId);
  reopened.close();
});

test('separate processes serialize the same identity and preserve one outbox row', async (t) => {
  const file = fixture(t), id = newUsageEventId();
  const initial = openUsageEventStore(file); initial.close();
  const moduleUrl = pathToFileURL(join(import.meta.dirname, '../src/usage-event-store.js')).href;
  const script = `import {openUsageEventStore} from ${JSON.stringify(moduleUrl)}; const s=openUsageEventStore(process.argv[1]); const r=s.record({eventId:process.argv[2],href:'functions/demo.md',kind:'positive',note:'ok'}); console.log(r.status); s.close();`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, file, id]);
    let stdout = '', stderr = '';
    child.stdout.on('data', (v) => { stdout += v; });
    child.stderr.on('data', (v) => { stderr += v; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
  });
  assert.deepEqual((await Promise.all([run(), run()])).sort(), ['created', 'replay']);
  const store = openUsageEventStore(file);
  assert.equal(store.pending().length, 1);
  store.close();
});
