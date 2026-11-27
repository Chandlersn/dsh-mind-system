import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createClisEventReceiver } from '../src/clis-event-receiver.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'clis-inbox-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'inbox.sqlite');
}
function event(payload = { a: 1, b: 2 }) { return { producerId: randomUUID(), eventId: randomUUID(), kind: 'clis.intervention', payload }; }
function child(file, item) {
  const moduleUrl = new URL('../src/clis-event-receiver.js', import.meta.url).href;
  const source = `import {createClisEventReceiver} from ${JSON.stringify(moduleUrl)}; const r=createClisEventReceiver({filePath:process.argv[1]}); try { console.log(JSON.stringify(r.receive(JSON.parse(process.argv[2])))); } catch(e) { console.log(JSON.stringify({error:e.code})); } finally {r.close()}`;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', source, file, JSON.stringify(item)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; p.stdout.on('data', (b) => out += b); p.stderr.on('data', (b) => err += b);
    p.on('error', reject); p.on('close', (code) => { if (code) reject(new Error(err)); else { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } } });
  });
}

test('concurrent processes serialize duplicates and conflicts and preserve a stable receipt', async (t) => {
  const file = fixture(t), original = event();
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => child(file, { ...original, payload: i < 4 ? { b: 2, a: 1 } : { a: 9 } })));
  assert.equal(results.filter((r) => r.status === 'received').length, 1);
  const winner = results.find((r) => r.status === 'received');
  const matches = results.filter((r) => r.status === 'replay');
  const conflicts = results.filter((r) => r.error === 'event_conflict');
  assert.equal(matches.length + conflicts.length, 5);
  for (const r of matches) assert.deepEqual(r.receipt, winner.receipt);
  const r = createClisEventReceiver({ filePath: file });
  assert.deepEqual(r.get(original.producerId, original.eventId), winner.receipt);
  assert.deepEqual(r.receive({ ...original, payload: winner.receipt.payload }).receipt, winner.receipt);
  assert.equal(winner.receipt.authenticated, false); assert.equal(winner.receipt.governanceEligible, false);
  r.close();
});

test('concurrent callers create one pending failure candidate and identical receipts', async t => {
  const file = fixture(t);
  const input = { ...event(), kind: 'clis.run.v1', payload: {
    source: 'clis_run', schemaVersion: 1, baseline: false, causalType: 'cyclic', planSignal: 'effective',
    feedback: { outcome: 'failed', association: 'prior_history' },
  } };
  const replies = await Promise.all(Array.from({ length: 4 }, () => child(file, input)));
  assert.equal(replies.filter(row => row.status === 'received').length, 1);
  assert.equal(replies.filter(row => row.status === 'replay').length, 3);
  for (const reply of replies) assert.deepEqual(reply.receipt, replies[0].receipt);
  const receiver = createClisEventReceiver({ filePath: file });
  try {
    assert.deepEqual(receiver.reviewCandidates().items.map(row => [row.producerId, row.eventId]), [[input.producerId, input.eventId]]);
  } finally { receiver.close(); }
});

test('retries after lost receipt survive reopen and invalid inputs are rejected', (t) => {
  const file = fixture(t), item = event(); let r = createClisEventReceiver({ filePath: file });
  const first = r.receive(item); r.close(); r = createClisEventReceiver({ filePath: file });
  assert.deepEqual(r.receive(item), { status: 'replay', receipt: first.receipt });
  assert.throws(() => r.receive({ ...item, payload: { value: 'x'.repeat(65537) } }), { code: 'invalid_payload' });
  assert.throws(() => r.receive({ ...item, extra: true }), { code: 'invalid_event' });
  assert.throws(() => r.receive({ ...item, payload: { bad: undefined } }), { code: 'invalid_payload' });
  assert.throws(() => r.receive({ ...item, payload: [,,] }), { code: 'invalid_payload' });
  assert.throws(() => r.receive({ ...item, producerId: 'caller' }), { code: 'invalid_event' });
  r.close();
});

test('failure between event and result inserts rolls back both', (t) => {
  const file = fixture(t), item = event(); let r = createClisEventReceiver({ filePath: file }); r.close();
  let db = new DatabaseSync(file); db.exec("CREATE TRIGGER fail_result BEFORE INSERT ON clis_event_results BEGIN SELECT RAISE(ABORT, 'injected failure'); END;"); db.close();
  r = createClisEventReceiver({ filePath: file }); assert.throws(() => r.receive(item), /injected failure/); assert.equal(r.get(item.producerId, item.eventId), null); r.close();
  db = new DatabaseSync(file); assert.equal(db.prepare('SELECT count(*) AS n FROM clis_event_inbox').get().n, 0); db.exec('DROP TRIGGER fail_result'); db.close();
  r = createClisEventReceiver({ filePath: file }); assert.equal(r.receive(item).status, 'received'); r.close();
});

test('corrupt payload, unknown result and missing result are explicit failures', (t) => {
  const file = fixture(t), item = event(); let r = createClisEventReceiver({ filePath: file }); r.receive(item); r.close();
  let db = new DatabaseSync(file); db.prepare('UPDATE clis_event_inbox SET payload=?').run('{broken'); db.close();
  r = createClisEventReceiver({ filePath: file }); assert.throws(() => r.get(item.producerId, item.eventId), { code: 'corrupt_event' }); assert.throws(() => r.receive(item), { code: 'corrupt_event' }); r.close();
  db = new DatabaseSync(file); db.prepare('UPDATE clis_event_inbox SET payload=?').run(JSON.stringify(item.payload)); db.exec("PRAGMA ignore_check_constraints=ON; UPDATE clis_event_results SET status='unknown'"); db.close();
  assert.throws(() => createClisEventReceiver({ filePath: file }), { code: 'corrupt_store' });
  db = new DatabaseSync(file); db.exec('DELETE FROM clis_event_results'); db.close();
  assert.throws(() => createClisEventReceiver({ filePath: file }), { code: 'corrupt_store' });
});
