import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { apply } from '../server.js';

const edge = payload => payload.edgeStatus.edges.find(item => item.id === 'outbox -> valves inbox');

test('overview and SSE propagate receipt changes from isolated SQLite stores', { timeout: 30000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'graph-sse-'));
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  const storage = path.join(home, 'storages');
  let producer, consumer, dispose, server, reader;
  const abort = new AbortController();
  try {
    await Promise.all([mkdir(root), mkdir(skills), mkdir(storage)]);
    await writeFile(path.join(root, 'MEMORY.md'), '# Memory\n');
    producer = new DatabaseSync(path.join(storage, 'clis-events.sqlite'));
    consumer = new DatabaseSync(path.join(storage, 'clis-event-inbox.sqlite'));
    producer.exec("CREATE TABLE clis_meta(key TEXT,value TEXT); INSERT INTO clis_meta VALUES('producer_id','p1'); CREATE TABLE clis_events(event_id TEXT); CREATE TABLE clis_receipts(receipt_id TEXT,event_id TEXT,evidence TEXT,evidence_hash TEXT)");
    consumer.exec('CREATE TABLE clis_event_inbox(producer_id TEXT,event_id TEXT); CREATE TABLE clis_event_results(producer_id TEXT,event_id TEXT,receipt_id TEXT,status TEXT)');
    let handler;
    const noop = () => {};
    const ctx = {
      get() {}, tools: { register: () => noop }, on: () => noop,
      inject(_names, run) { run({ webServer: { register(route) { handler = route.handler; return noop; } }, connection: { requestRejection() {} }, effect: fn => fn() }); },
      systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    };
    dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR, dailyArchiveFirstDelayMs: 0 });
    server = createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/memory-org`;
    const overview = async () => {
      const response = await fetch(`${base}/overview`);
      assert.equal(response.status, 200);
      return (await response.json())[0];
    };
    const initial = await overview();
    assert.equal(initial.edgeStatus.status, 'available');
    assert.equal(edge(initial).status, 'no_data');
    assert.equal(edge(initial).detail, 'matching receipts=0');
    const stream = await fetch(`${base}/stream`, { signal: abort.signal });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type'), /^text\/event-stream/);
    reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    async function nextOverview() {
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (frame.startsWith('event: snapshot-error\n')) throw new Error(frame);
          if (frame.startsWith('event: overview\n')) return JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6));
          continue;
        }
        const chunk = await reader.read();
        assert.equal(chunk.done, false, 'stream closed before overview');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    }
    assert.equal(edge(await nextOverview()).status, 'no_data');
    const evidence = JSON.stringify({ producerId: 'p1', eventId: 'e1', receiptId: 'r1', status: 'received' });
    const hash = createHash('sha256').update(evidence).digest('hex');
    producer.exec("INSERT INTO clis_events VALUES ('e1')");
    producer.prepare('INSERT INTO clis_receipts VALUES (?,?,?,?)').run('r1', 'e1', evidence, hash);
    consumer.exec("INSERT INTO clis_event_inbox VALUES ('p1','e1'); INSERT INTO clis_event_results VALUES ('p1','e1','r1','received')");
    const matched = await nextOverview();
    assert.equal(edge(matched).status, 'observed');
    assert.equal(edge(matched).evidenceScope, 'historical');
    assert.equal(edge(matched).currentActivity, 'unknown');
    assert.equal(matched.edgeStatus.runningGraphCount, 0);
    assert.equal(matched.edgeStatus.historicalGraphCount, 1);
    assert.deepEqual(matched.edgeStatus.historicalGraphs, ['C->V']);
    assert.equal(edge(matched).detail, 'matching receipts=1');
    assert.equal(edge(await overview()).status, 'observed');
    consumer.exec("UPDATE clis_event_results SET receipt_id='other'");
    const invalid = await nextOverview();
    assert.equal(edge(invalid).status, 'unknown');
    assert.match(edge(invalid).detail, /source unavailable or incomplete/);
    assert.equal(edge(await overview()).status, 'unknown');
  } finally {
    abort.abort();
    if (reader) await reader.cancel().catch(() => {});
    dispose?.();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    producer?.close();
    consumer?.close();
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});
