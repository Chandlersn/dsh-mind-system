import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { apply } from '../server.js';

const clisSource = new URL('../../dsh-clis/clis-event-store.js', import.meta.url);
const valvesSource = new URL('../../dsh-valves/src/clis-event-receiver.js', import.meta.url);
const { openClisEventStore } = await import(existsSync(clisSource) ? clisSource : new URL('../../clis/clis-event-store.js', import.meta.url));
const { createClisEventReceiver } = await import(existsSync(valvesSource) ? valvesSource : new URL('../../valves/src/clis-event-receiver.js', import.meta.url));
const edge = payload => payload.edgeStatus.edges.find(item => item.id === 'valves consumption -> clis feedback');

test('server SSE tracks feedback agreement across isolated producer and consumer changes', { timeout: 30000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'graph-feedback-sse-'));
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  const storage = path.join(home, 'storages');
  let store, receiver, consumerDb, dispose, server, reader;
  const abort = new AbortController();
  try {
    await Promise.all([mkdir(root), mkdir(skills), mkdir(storage)]);
    await writeFile(path.join(root, 'MEMORY.md'), '# Memory\n');
    store = openClisEventStore(path.join(storage, 'clis-events.sqlite'));
    const consumerPath = path.join(storage, 'clis-event-inbox.sqlite');
    receiver = createClisEventReceiver({ filePath: consumerPath });
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
    let result = edge(await nextOverview());
    assert.equal(result.status, 'no_data');
    assert.match(result.detail, /matching classifications=0/);

    const eventId = randomUUID();
    const { event } = store.record({ eventId, kind: 'example', payload: { value: 1 } });
    const receipt = receiver.receive({ producerId: store.producerId, eventId, kind: event.kind, payload: event.payload }).receipt;
    store.recordReceipt({ eventId, receiptId: receipt.receiptId, evidence: receipt });
    store.recordFeedback({ schemaVersion: 1, producerId: store.producerId, eventId, receiptId: receipt.receiptId, classification: 'unsupported_kind' });
    const matched = await nextOverview();
    result = edge(matched);
    assert.equal(result.status, 'observed');
    assert.equal(result.evidenceScope, 'historical');
    assert.equal(result.currentActivity, 'unknown');
    assert.equal(matched.edgeStatus.runningGraphCount, 0);
    assert.ok(matched.edgeStatus.historicalGraphs.includes('V->C'));
    assert.match(result.detail, /matching classifications=1/);
    assert.match(result.detail, /unauthenticated.*human adoption.*unknown.*not governance eligible/);

    consumerDb = new DatabaseSync(consumerPath);
    consumerDb.exec("UPDATE clis_consumption_v1 SET classification='baseline'");
    result = edge(await nextOverview());
    assert.equal(result.status, 'unknown');
    assert.match(result.detail, /source unavailable or incomplete/);

    consumerDb.exec("UPDATE clis_consumption_v1 SET classification='unsupported_kind'");
    result = edge(await nextOverview());
    assert.equal(result.status, 'observed');
    assert.match(result.detail, /matching classifications=1/);
  } finally {
    abort.abort();
    if (reader) await reader.cancel().catch(() => {});
    dispose?.();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    consumerDb?.close();
    receiver?.close();
    store?.close();
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});
