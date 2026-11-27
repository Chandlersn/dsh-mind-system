import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
const combined = new URL('../../clis/clis-event-store.js', import.meta.url);
const standalone = new URL('../../dsh-clis/clis-event-store.js', import.meta.url);
const { openClisEventStore } = await import((existsSync(combined) ? combined : standalone).href);
import { createClisEventReceiver } from '../src/clis-event-receiver.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'clis-flow-'));
  return { producer: join(dir, 'producer.sqlite'), receiver: join(dir, 'receiver.sqlite'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function envelope({ producerId, eventId, kind, payload }) { return { producerId, eventId, kind, payload }; }
function input() { return { eventId: randomUUID(), kind: 'clis.intervention', payload: { z: [1, true], a: { value: 'test' } } }; }
function count(file, table) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n; } finally { db.close(); }
}
function evidence(receipt) { return { receiptId: receipt.receiptId, eventId: receipt.eventId, evidence: receipt }; }

// Child processes open both independent databases before racing the same complete flow.
if (process.argv[2] === '--flow-worker') {
  const [producerPath, receiverPath, itemText] = process.argv.slice(3);
  const store = openClisEventStore(producerPath);
  const receiver = createClisEventReceiver({ filePath: receiverPath });
  process.send({ ready: true });
  process.once('message', () => {
    try {
      const produced = store.record(JSON.parse(itemText));
      const received = receiver.receive(envelope(store.get(produced.event.eventId)));
      const recorded = store.recordReceipt(evidence(received.receipt));
      process.send({ produced, received, recorded });
    } catch (error) { process.send({ error: error.code || error.message }); }
    finally { receiver.close(); store.close(); process.disconnect(); }
  });
}

function worker(paths, item) {
  const child = fork(new URL(import.meta.url), ['--flow-worker', paths.producer, paths.receiver, JSON.stringify(item)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  let readyResolve, resultResolve, resultReject;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const result = new Promise((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
  let value;
  child.on('message', message => { if (message.ready) readyResolve(); else value = message; });
  child.on('error', resultReject);
  child.on('exit', code => { if (code !== 0 || !value) resultReject(new Error(`worker failed: ${code} ${stderr}`)); else resultResolve(value); });
  return { ready, result, start: () => child.send('start'), child };
}

if (process.argv[2] !== '--flow-worker') {
test('pending event, lost receipt, reopen and unauthenticated receipt recording', t => {
  const paths = fixture(t), item = input();
  let store = openClisEventStore(paths.producer), receiver = createClisEventReceiver({ filePath: paths.receiver });
  t.after(() => { store.close(); receiver.close(); paths.cleanup(); });
  const created = store.record(item);
  assert.equal(created.status, 'created');
  assert.deepEqual(store.pending(), [created.event]);
  assert.throws(() => receiver.receive(created.event), { code: 'invalid_event' });
  assert.equal(count(paths.receiver, 'clis_event_inbox'), 0);
  const first = receiver.receive(envelope(created.event));
  assert.equal(first.status, 'received');
  assert.equal(first.receipt.producerId, created.event.producerId);
  assert.equal(first.receipt.eventId, created.event.eventId);
  assert.equal(first.receipt.authenticated, false);
  assert.equal(first.receipt.governanceEligible, false);
  assert.deepEqual(store.receipts(item.eventId), []);
  store.close(); receiver.close();
  store = openClisEventStore(paths.producer); receiver = createClisEventReceiver({ filePath: paths.receiver });
  assert.equal(store.producerId, created.event.producerId);
  assert.deepEqual(store.pending(), [created.event]);
  const retry = receiver.receive(envelope(store.pending()[0]));
  assert.deepEqual(retry, { status: 'replay', receipt: first.receipt });
  assert.deepEqual(store.recordReceipt(evidence(retry.receipt)), { status: 'recorded', authenticated: false });
  assert.deepEqual(store.recordReceipt(evidence(retry.receipt)), { status: 'replay', authenticated: false });
  assert.equal(store.receipts(item.eventId)[0].authenticated, false);
  assert.deepEqual(store.receipts(item.eventId)[0].evidence, first.receipt);
  assert.deepEqual(store.pending(), [created.event]);
  assert.equal(count(paths.producer, 'clis_events'), 1);
  assert.equal(count(paths.producer, 'clis_outbox'), 1);
  assert.equal(count(paths.producer, 'clis_receipts'), 1);
  assert.equal(count(paths.receiver, 'clis_event_inbox'), 1);
  assert.equal(count(paths.receiver, 'clis_event_results'), 1);
});

test('event and receipt ID conflicts leave both databases unchanged', t => {
  const paths = fixture(t), item = input();
  const store = openClisEventStore(paths.producer), receiver = createClisEventReceiver({ filePath: paths.receiver });
  t.after(() => { store.close(); receiver.close(); paths.cleanup(); });
  const event = store.record(item).event, received = receiver.receive(envelope(event)).receipt;
  assert.throws(() => store.record({ ...item, payload: { different: true } }), { code: 'event_conflict' });
  assert.throws(() => receiver.receive({ ...envelope(event), payload: { different: true } }), { code: 'event_conflict' });
  assert.deepEqual(store.recordReceipt(evidence(received)), { status: 'recorded', authenticated: false });
  assert.throws(() => store.recordReceipt({ ...evidence(received), evidence: { changed: true } }), { code: 'receipt_conflict' });
  const second = store.record(input()).event;
  assert.throws(() => store.recordReceipt({ ...evidence(received), eventId: second.eventId }), { code: 'receipt_conflict' });
  assert.deepEqual(receiver.get(event.producerId, event.eventId), received);
  assert.deepEqual(store.get(item.eventId), event);
  assert.equal(store.receipts(item.eventId).length, 1);
  assert.deepEqual(store.receipts(second.eventId), []);
  assert.equal(count(paths.receiver, 'clis_event_inbox'), 1);
  assert.equal(count(paths.receiver, 'clis_event_results'), 1);
  assert.equal(count(paths.producer, 'clis_events'), 2);
  assert.equal(count(paths.producer, 'clis_outbox'), 2);
  assert.equal(count(paths.producer, 'clis_receipts'), 1);
});

test('insert failure rolls back producer and receiver transaction pairs', t => {
  const paths = fixture(t), item = input();
  let store = openClisEventStore(paths.producer), receiver = createClisEventReceiver({ filePath: paths.receiver });
  t.after(() => { store.close(); receiver.close(); paths.cleanup(); });
  store.close(); receiver.close();
  let db = new DatabaseSync(paths.producer);
  db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON clis_outbox BEGIN SELECT RAISE(ABORT, 'outbox failure'); END"); db.close();
  store = openClisEventStore(paths.producer);
  assert.throws(() => store.record(item), /outbox failure/);
  assert.deepEqual(store.pending(), []);
  store.close();
  assert.equal(count(paths.producer, 'clis_events'), 0);
  assert.equal(count(paths.producer, 'clis_outbox'), 0);
  db = new DatabaseSync(paths.producer); db.exec('DROP TRIGGER fail_outbox'); db.close();
  store = openClisEventStore(paths.producer);
  const event = store.record(item).event;
  db = new DatabaseSync(paths.receiver);
  db.exec("CREATE TRIGGER fail_result BEFORE INSERT ON clis_event_results BEGIN SELECT RAISE(ABORT, 'result failure'); END"); db.close();
  receiver = createClisEventReceiver({ filePath: paths.receiver });
  assert.throws(() => receiver.receive(envelope(event)), /result failure/);
  assert.equal(receiver.get(event.producerId, event.eventId), null);
  assert.deepEqual(store.receipts(item.eventId), []);
  assert.deepEqual(store.pending(), [event]);
  receiver.close();
  assert.equal(count(paths.receiver, 'clis_event_inbox'), 0);
  assert.equal(count(paths.receiver, 'clis_event_results'), 0);
  db = new DatabaseSync(paths.receiver); db.exec('DROP TRIGGER fail_result'); db.close();
  receiver = createClisEventReceiver({ filePath: paths.receiver });
  const receipt = receiver.receive(envelope(event)).receipt;
  assert.deepEqual(store.recordReceipt(evidence(receipt)), { status: 'recorded', authenticated: false });
  store.close(); receiver.close();
});

test('cross-process concurrent complete flows commit one event, receipt and result', async t => {
  const paths = fixture(t), item = input();
  const store = openClisEventStore(paths.producer), receiver = createClisEventReceiver({ filePath: paths.receiver });
  const producerId = store.producerId;
  store.close(); receiver.close();
  const workers = Array.from({ length: 5 }, () => worker(paths, item));
  t.after(() => { for (const w of workers) if (w.child.exitCode === null) w.child.kill(); });
  await Promise.all(workers.map(w => w.ready));
  for (const w of workers) w.start();
  const results = await Promise.all(workers.map(w => w.result));
  assert.equal(results.filter(r => r.produced?.status === 'created').length, 1);
  assert.equal(results.filter(r => r.produced?.status === 'replay').length, 4);
  assert.equal(results.filter(r => r.received?.status === 'received').length, 1);
  assert.equal(results.filter(r => r.received?.status === 'replay').length, 4);
  assert.equal(results.filter(r => r.recorded?.status === 'recorded').length, 1);
  assert.equal(results.filter(r => r.recorded?.status === 'replay').length, 4);
  const receipt = results[0].received.receipt;
  for (const result of results) { assert.deepEqual(result.received.receipt, receipt); assert.equal(result.recorded.authenticated, false); }
  const reopenedStore = openClisEventStore(paths.producer), reopenedReceiver = createClisEventReceiver({ filePath: paths.receiver });
  t.after(() => { reopenedStore.close(); reopenedReceiver.close(); paths.cleanup(); });
  assert.equal(reopenedStore.producerId, producerId);
  assert.equal(reopenedStore.pending().length, 1);
  assert.deepEqual(reopenedReceiver.get(producerId, item.eventId), receipt);
  assert.equal(reopenedStore.receipts(item.eventId).length, 1);
  assert.equal(count(paths.producer, 'clis_events'), 1);
  assert.equal(count(paths.producer, 'clis_outbox'), 1);
  assert.equal(count(paths.producer, 'clis_receipts'), 1);
  assert.equal(count(paths.receiver, 'clis_event_inbox'), 1);
  assert.equal(count(paths.receiver, 'clis_event_results'), 1);
});
}
