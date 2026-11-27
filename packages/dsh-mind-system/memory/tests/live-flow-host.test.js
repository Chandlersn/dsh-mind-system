import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../server.js';
import { createLiveFlow } from '../src/live-flow.js';

async function fixture(dependencies = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'live-flow-host-'));
  const envNames = ['DSH_HOME', 'APPDATA', 'SAG_BIN', 'SAG_API_KEY', 'DSH_SAG_API_KEY'];
  const previousEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  process.env.DSH_HOME = home;
  process.env.APPDATA = home;
  process.env.SAG_BIN = path.join(home, 'missing-sag');
  delete process.env.SAG_API_KEY;
  delete process.env.DSH_SAG_API_KEY;
  await mkdir(path.join(home, 'com.sag.desktop'));
  await writeFile(path.join(home, 'com.sag.desktop', 'http-api.json'), '{"port":1}');
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  await Promise.all([mkdir(root), mkdir(skills)]);
  await writeFile(path.join(root, 'MEMORY.md'), '# Memory\n');
  const listeners = new Map();
  const tools = new Map();
  let handler;
  const noop = () => {};
  const ctx = {
    get(name) { return name === 'valves' ? { negativeRules: async () => [] } : undefined; },
    tools: { register(tool) { tools.set(tool.name, tool); return noop; } },
    on(name, fn) {
      const group = listeners.get(name) ?? [];
      group.push(fn); listeners.set(name, group);
      return () => { const i = group.indexOf(fn); if (i >= 0) group.splice(i, 1); };
    },
    inject(_names, run) { run({ webServer: { register(route) { handler = route.handler; return noop; } }, connection: { requestRejection() {} }, effect: fn => fn() }); },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
  };
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR, dailyArchiveFirstDelayMs: 0 }, dependencies);
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/memory-org`;
  let disposed = false;
  const stop = () => { if (!disposed) { disposed = true; dispose(); } };
  return { listeners, tools, base, root, handler, dispose: stop, async close() {
    stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const name of envNames) {
      if (previousEnv[name] === undefined) delete process.env[name]; else process.env[name] = previousEnv[name];
    }
    await rm(home, { recursive: true, force: true });
  } };
}

function streamReader(reader) {
  let buffer = '';
  const decoder = new TextDecoder();
  return async () => {
    for (;;) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        if (frame.startsWith('event: snapshot-error\n')) throw new Error(frame);
        if (frame.startsWith('event: overview\n')) return JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6));
        if (frame.startsWith('event: flow\n')) return { liveFlow: JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6)) };
        continue;
      }
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
}

test('entered index matches reach SSE with anonymous disk and cache sources', { timeout: 15000 }, async () => {
  const host = await fixture();
  const abort = new AbortController();
  let reader;
  try {
    await mkdir(path.join(host.root, 'functions'));
    await writeFile(path.join(host.root, 'MEMORY.md'), '# Index\n\n## Functions\n\n| Domain | Description |\n|---|---|\n| [alphaunique](functions/alphaunique.md) | alphaunique matching evidence |\n');
    await writeFile(path.join(host.root, 'functions', 'alphaunique.md'), '# alphaunique');
    const response = await fetch(`${host.base}/stream`, { signal: abort.signal });
    reader = response.body.getReader();
    const nextFrame = streamReader(reader);
    await nextFrame();
    const pre = host.listeners.get('agent/pre-step')[0];
    const payload = (text, turn) => ({ agent: { id: 'private-agent' }, turn, messages: [{ role: 'user', content: [{ type: 'text', text }] }] });
    await pre(payload('unrelatedzzzzz', 1), async () => ({ kind: 'enter', messages: [] }));
    assert.equal((await (await fetch(`${host.base}/overview`)).json())[0].liveFlow.edges.e10, undefined);
    await pre(payload('alphaunique', 2), async () => ({ kind: 'reject' }));
    assert.equal((await (await fetch(`${host.base}/overview`)).json())[0].liveFlow.edges.e10, undefined);
    // The rejected step populated the cache; force a fresh instance for a disk observation.
  } finally {
    abort.abort(); if (reader) await reader.cancel().catch(() => {}); await host.close();
  }
  const fresh = await fixture();
  const controller = new AbortController();
  let stream;
  try {
    await mkdir(path.join(fresh.root, 'functions'));
    await writeFile(path.join(fresh.root, 'MEMORY.md'), '# Index\n\n## Functions\n\n| Domain | Description |\n|---|---|\n| [alphaunique](functions/alphaunique.md) | alphaunique matching evidence |\n');
    await writeFile(path.join(fresh.root, 'functions', 'alphaunique.md'), '# alphaunique');
    stream = (await fetch(`${fresh.base}/stream`, { signal: controller.signal })).body.getReader();
    const next = streamReader(stream);
    await next();
    const pre = fresh.listeners.get('agent/pre-step')[0];
    const payload = turn => ({ agent: { id: 'private-agent' }, turn, messages: [{ role: 'user', content: [{ type: 'text', text: 'alphaunique' }] }] });
    await pre(payload(1), async () => ({ kind: 'enter', messages: [] }));
    let frame;
    do { frame = await next(); } while (!frame.liveFlow?.edges?.e10);
    assert.equal(frame.liveFlow.edges.e10.source, 'disk');
    assert.doesNotMatch(JSON.stringify(frame.liveFlow), /private|alphaunique/);
    await pre(payload(2), async () => ({ kind: 'enter', messages: [] }));
    do { frame = await next(); } while (frame.liveFlow?.edges?.e10?.source !== 'cache');
    assert.equal(frame.liveFlow.edges.e10.phase, 'finished');
  } finally {
    controller.abort(); if (stream) await stream.cancel().catch(() => {}); await fresh.close();
  }
});

test('host middleware and final result reach the SSE route without private data', { timeout: 20000 }, async () => {
  const host = await fixture();
  const abort = new AbortController();
  let reader;
  try {
    const response = await fetch(`${host.base}/stream`, { signal: abort.signal });
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    reader = response.body.getReader();
    const nextOverview = streamReader(reader);
    assert.deepEqual((await nextOverview()).liveFlow, { edges: {}, dropped: 0 });
    const handlers = host.listeners.get('tools/execute');
    assert.equal(handlers.length, 2, 'the write guard remains registered');
    const observer = handlers[0];
    const ignored = { callId: 'ignored', name: 'unrelated_tool', arguments: {} };
    await observer(ignored, async () => ({ isError: false }));
    host.listeners.get('tools/result')[0](ignored, { isError: false });
    const idle = await (await fetch(`${host.base}/overview`)).json();
    assert.deepEqual(idle[0].liveFlow, { edges: {}, dropped: 0 });
    const exec = { token: Symbol('private-token'), callId: 'private-call-id', name: 'memory_write', arguments: { body: 'private-arguments' } };
    let release;
    let calls = 0;
    const expected = { isError: false, value: 'private-result' };
    const pending = observer(exec, async () => { calls++; return await new Promise(resolve => { release = resolve; }); });
    let active;
    do { active = await nextOverview(); } while (active.liveFlow.edges.e2?.phase !== 'active');
    assert.equal(active.liveFlow.edges.e2.phase, 'active');
    release(expected);
    assert.strictEqual(await pending, expected);
    assert.equal(calls, 1);
    host.listeners.get('tools/result')[0](exec, expected);
    let finished;
    do { finished = await nextOverview(); } while (finished.liveFlow.edges.e2?.phase !== 'finished');
    assert.equal(finished.liveFlow.edges.e2.phase, 'finished');
    assert.doesNotMatch(JSON.stringify([active.liveFlow, finished.liveFlow]), /private|memory_write/);
    const failed = { token: Symbol('private-failure-token'), callId: 'private-failure-id', name: 'memory_dao', arguments: {} };
    await observer(failed, async () => ({ isError: true }));
    host.listeners.get('tools/result')[0](failed, { isError: true, error: 'private-error' });
    let final;
    do { final = await nextOverview(); } while (final.liveFlow.edges.e4?.phase !== 'failed');
    assert.equal(final.liveFlow.edges.e4.phase, 'failed');
    assert.doesNotMatch(JSON.stringify(final.liveFlow), /private/);
    host.dispose();
    assert.equal(host.listeners.get('tools/execute').length, 0);
    assert.equal(host.listeners.get('tools/result').length, 0);
  } finally {
    abort.abort(); if (reader) await reader.cancel().catch(() => {}); await host.close();
  }
});

test('short operations reach multiple SSE sessions immediately and disposal closes them', { timeout: 15000 }, async () => {
  const host = await fixture();
  const controllers = [new AbortController(), new AbortController()];
  const readers = [];
  try {
    for (const controller of controllers) {
      const response = await fetch(`${host.base}/stream`, { signal: controller.signal });
      readers.push(response.body.getReader());
    }
    const nextFrames = readers.map(reader => {
      let buffer = '';
      const decoder = new TextDecoder();
      return async () => {
        for (;;) {
          const end = buffer.indexOf('\n\n');
          if (end >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            if (frame.startsWith('event: flow\n')) return JSON.parse(frame.split('\n')[1].slice(6));
            continue;
          }
          const chunk = await reader.read();
          if (chunk.done) return null;
          buffer += decoder.decode(chunk.value, { stream: true });
        }
      };
    });
    for (const next of nextFrames) assert.deepEqual(await next(), { edges: {}, dropped: 0 });
    const exec = { token: Symbol('private'), name: 'memory_write', arguments: { body: 'private' } };
    const result = { isError: false, value: 'private' };
    const observer = host.listeners.get('tools/execute')[0];
    assert.strictEqual(await observer(exec, async () => result), result);
    host.listeners.get('tools/result')[0](exec, result);
    for (const next of nextFrames) {
      const active = await next();
      const finished = await next();
      assert.equal(active.edges.e2.phase, 'active');
      assert.equal(finished.edges.e2.phase, 'finished');
      assert.doesNotMatch(JSON.stringify([active, finished]), /private|memory_write/);
    }
    host.dispose();
    for (const next of nextFrames) assert.equal(await next(), null);
  } finally {
    controllers.forEach(controller => controller.abort());
    await Promise.all(readers.map(reader => reader.cancel().catch(() => {})));
    await host.close();
  }
});

test('subscription failure reports snapshot fallback without leaking errors', { timeout: 15000 }, async () => {
  const host = await fixture({ createLiveFlow: () => ({ start() {}, finish() {}, snapshot: () => ({ edges: {}, dropped: 0 }), subscribe() { throw Error('private'); } }) });
  const abort = new AbortController();
  let reader;
  try {
    const response = await fetch(`${host.base}/stream`, { signal: abort.signal });
    reader = response.body.getReader();
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    assert.match(text, /event: flow-status\ndata: {"available":false,"fallback":"snapshot"}/);
    assert.doesNotMatch(text, /private/);
  } finally {
    abort.abort(); if (reader) await reader.cancel().catch(() => {}); await host.close();
  }
});

test('pre-step records e12 only when matching index rows enter the step', async () => {
  for (const scenario of ['rejected', 'no-match', 'entered']) {
    const host = await fixture();
    try {
      await writeFile(path.join(host.root, 'MEMORY.md'), [
        '# Memory', '## 功能模块索引（functions/）', '| 功能域 | 一句话状态 |', '|---|---|',
        '| [召回测试功能](functions/召回测试功能.md) | 召回测试功能专属的验证内容 |', '',
      ].join('\n'));
      const step = host.listeners.get('agent/pre-step')[0];
      const payload = { agent: { id: `agent-${scenario}` }, turn: 1, messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: scenario === 'no-match' ? 'unmatchedxyz' : '接下来处理召回测试功能的待观察项' }] }] };
      const decision = scenario === 'rejected' ? { kind: 'reject' } : { kind: 'enter', messages: [] };
      const result = await step(payload, async () => decision);
      const data = JSON.parse((await host.tools.get('memory_read').execute({ kind: 'live_flow' })).content);
      if (scenario === 'entered') {
        assert.match(JSON.stringify(result.messages), /召回测试功能/);
        assert.equal(data.edges.e12.phase, 'finished');
      } else {
        assert.equal(data.edges.e12, undefined, scenario);
      }
    } finally { await host.close(); }
  }
});

test('e9 records only acknowledged changes to the named capability row', async () => {
  let events = 0;
  const host = await fixture({ createLiveFlow: () => {
    const flow = createLiveFlow();
    flow.subscribe(snapshot => { if (snapshot.edges.e9) events++; });
    return flow;
  } });
  try {
    const cap = host.tools.get('memory_capability');
    const read = host.tools.get('memory_read');
    const record = { action: 'record', name: 'private-tool', invocation: 'private command', summary: 'first summary' };
    await cap.execute(record);
    assert.equal(events, 1);
    let snapshot = JSON.parse((await read.execute({ kind: 'live_flow' })).content);
    assert.equal(snapshot.edges.e9.phase, 'finished');
    assert.doesNotMatch(JSON.stringify(snapshot), /private|summary/);
    await cap.execute(record);
    assert.equal(events, 1);
    const indexPath = path.join(host.root, 'MEMORY.md');
    const index = await readFile(indexPath, 'utf8');
    await writeFile(indexPath, index.replace('## 能力台账 细节子目录', '## 能力台账（可用工具 / MCP / CLI）'));
    await cap.execute(record);
    assert.equal(events, 1, 'heading migration alone is not a row change');
    await cap.execute({ ...record, summary: 'changed summary' });
    assert.equal(events, 2);
    await cap.execute({ action: 'read', name: record.name });
    await cap.execute({ action: 'list' });
    await mkdir(path.join(host.root, 'functions'), { recursive: true });
    await writeFile(path.join(host.root, 'functions', 'unrelated.md'), '# Unrelated\n');
    await host.tools.get('memory_index').execute({ zone: 'functions', name: 'unrelated', summary: 'unrelated index write' });
    assert.equal(events, 2);
    await rm(indexPath);
    await mkdir(indexPath);
    await assert.rejects(cap.execute({ ...record, summary: 'failed write' }));
    assert.equal(events, 2);
  } finally { await host.close(); }
});

test('only memory_read index execution maps to e11', async () => {
  const host = await fixture();
  try {
    const observer = host.listeners.get('tools/execute')[0];
    const finish = host.listeners.get('tools/result')[0];
    const read = host.tools.get('memory_read');
    for (const kind of ['live_flow', 'operation']) {
      const exec = { token: Symbol(kind), name: 'memory_read', arguments: { kind } };
      await observer(exec, async () => ({ isError: false }));
      finish(exec, { isError: false });
    }
    assert.equal(JSON.parse((await read.execute({ kind: 'live_flow' })).content).edges.e11, undefined);
    const exec = { token: Symbol('index'), name: 'memory_read', arguments: { kind: 'index' } };
    await observer(exec, async () => read.execute(exec.arguments));
    finish(exec, { isError: false });
    assert.equal(JSON.parse((await read.execute({ kind: 'live_flow' })).content).edges.e11.phase, 'finished');
  } finally { await host.close(); }
});

test('backpressure waits for drain and preserves ordered flow events', { timeout: 10000 }, async () => {
  let listener, unsubscribed = 0;
  const host = await fixture({ createLiveFlow: () => ({
    start() {}, finish() {}, snapshot: () => ({ phase: 'initial' }),
    subscribe(fn) { listener = fn; return () => { unsubscribed++; listener = null; }; },
  }) });
  try {
    class Response extends EventEmitter {
      writes = []; ended = 0;
      writeHead() {}
      write(data) { this.writes.push(data); return this.writes.length !== 1; }
      end() { this.ended++; }
    }
    const res = new Response();
    await host.handler({ url: '/api/memory-org/stream', method: 'GET' }, res);
    listener({ phase: 'active' }); listener({ phase: 'finished' });
    assert.equal(res.writes.length, 1);
    assert.equal(res.ended, 0);
    res.emit('drain');
    const frames = res.writes.filter(x => x.startsWith('event: flow\n'));
    assert.deepEqual(frames.map(x => JSON.parse(x.split('\n')[1].slice(6)).phase), ['initial', 'active', 'finished']);
    host.dispose();
    assert.equal(res.ended, 1);
    assert.equal(unsubscribed, 1);
    assert.equal(res.listenerCount('drain'), 0);
  } finally { await host.close(); }
});

test('blocked clients and oversized frames are bounded and cleaned up', { timeout: 10000 }, async () => {
  for (const oversized of [false, true]) {
    let listener, unsubscribed = 0;
    const host = await fixture({ createLiveFlow: () => ({
      start() {}, finish() {}, snapshot: () => ({}),
      subscribe(fn) { listener = fn; return () => { unsubscribed++; }; },
    }) });
    try {
      class Response extends EventEmitter {
        writes = []; ended = 0;
        writeHead() {}
        write(data) { this.writes.push(data); return false; }
        end() { this.ended++; }
      }
      const res = new Response();
      await host.handler({ url: '/api/memory-org/stream', method: 'GET' }, res);
      if (oversized) listener({ data: 'x'.repeat(1024 * 1024) });
      else for (let i = 0; i < 100 && !res.ended; i++) listener({ data: 'x'.repeat(20000), i });
      assert.equal(res.ended, 1);
      assert.equal(res.writes.length, 1);
      assert.equal(unsubscribed, 1);
      assert.equal(res.listenerCount('drain'), 0);
    } finally { await host.close(); }
  }
});

test('a real HTTP stream survives a frame larger than its high water mark', { timeout: 10000 }, async () => {
  let listener;
  const host = await fixture({ createLiveFlow: () => ({
    start() {}, finish() {}, snapshot: () => ({ data: 'x'.repeat(100000) }),
    subscribe(fn) { listener = fn; return () => {}; },
  }) });
  const abort = new AbortController();
  let reader;
  try {
    const response = await fetch(`${host.base}/stream`, { signal: abort.signal });
    reader = response.body.getReader();
    let text = '';
    while (!text.includes('x'.repeat(100000))) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      text += new TextDecoder().decode(chunk.value);
    }
    listener({ phase: 'after-large-frame' });
    while (!text.includes('after-large-frame')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      text += new TextDecoder().decode(chunk.value);
    }
    assert.match(text, /event: flow-status/);
  } finally {
    abort.abort(); if (reader) await reader.cancel().catch(() => {}); await host.close();
  }
});

test('flow-only changes do not resend overview and stale snapshots recover', async () => {
  const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function streamPanel('), source.indexOf('const PANEL_WRITE_SEGS', source.indexOf('function streamPanel(')));
  let now = 1000, flow = { phase: 'initial' }, listener;
  const intervals = [], writes = [];
  const response = { writeHead() {}, write(x) { writes.push(x); return true; }, on() {}, off() {}, end() {} };
  const ctx = { Buffer, Date: { now: () => now }, JSON, String,
    overviewPayload: async () => ({ count: 1, liveFlow: flow }),
    setInterval(fn, ms) { const t = { fn, ms, unref() {} }; intervals.push(t); return t; }, clearInterval() {} };
  vm.runInNewContext(`${code}\nthis.start = streamPanel`, ctx);
  ctx.start(response, '', { liveFlow: () => flow, subscribeLiveFlow(fn) { listener = fn; return () => {}; } });
  await Promise.resolve(); await Promise.resolve();
  const tick = intervals.find(x => x.ms === 2000).fn;
  const beat = intervals.find(x => x.ms === 20000).fn;
  flow = { phase: 'active' }; listener(flow); await tick();
  flow = { phase: 'finished' }; listener(flow); await tick();
  assert.equal(writes.filter(x => x.startsWith('event: overview\n')).length, 1);
  assert.equal(writes.filter(x => x.startsWith('event: flow\n')).length, 3);
  now += 90001; beat();
  assert.match(writes.at(-1), /"snapshotFresh":false/);
  await tick();
  assert.equal(writes.filter(x => x.startsWith('event: overview\n')).length, 2);
  assert.match(writes.at(-1), /^event: overview\n/);
  beat(); assert.match(writes.at(-1), /"snapshotFresh":true/);
});

test('heartbeat samples flow independently and cleans up after close', async () => {
  const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function streamPanel('), source.indexOf('const PANEL_WRITE_SEGS', source.indexOf('function streamPanel(')));
  for (const subscribed of [true, false]) {
    let now = 1000, snapshotCalls = 0, fail = false, listener, unsubscribed = 0;
    const intervals = [], writes = [], handlers = {};
    const response = { writeHead() {}, write(x) { writes.push(x); return true; }, on(name, fn) { handlers[name] = fn; }, off(name) { delete handlers[name]; }, end() {} };
    const ctx = { Buffer, Date: { now: () => now }, JSON, String,
      overviewPayload: async () => ({ count: 1 }),
      setInterval(fn, ms) { const timer = { fn, ms, unref() {} }; intervals.push(timer); return timer; }, clearInterval(timer) { if (timer) timer.cleared = true; } };
    vm.runInNewContext(`${code}\nthis.start = streamPanel`, ctx);
    const opts = subscribed ? {
      liveFlow() { snapshotCalls++; if (fail) throw Error('private observer error'); return { edges: { e2: { phase: 'finished', at: now } }, dropped: 0 }; },
      subscribeLiveFlow(fn) { listener = fn; return () => { unsubscribed++; }; },
    } : {};
    ctx.start(response, '', opts);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const beat = intervals.find(x => x.ms === 20000).fn;
    const frames = name => writes.filter(x => x.startsWith(`event: ${name}\n`)).map(x => JSON.parse(x.split('\n')[1].slice(6)));
    now += 20000; beat();
    assert.equal(frames('heartbeat').at(-1).snapshotFresh, true);
    if (subscribed) {
      assert.equal(snapshotCalls, 2);
      assert.equal(frames('flow').at(-1).edges.e2.at, now);
      fail = true; now += 20000; beat();
      assert.equal(frames('flow').length, 2);
      assert.equal(frames('flow-status').at(-1).available, false);
      assert.doesNotMatch(writes.join(''), /private observer error/);
      fail = false; now += 20000; beat();
      assert.equal(frames('flow-status').at(-1).available, true);
      assert.equal(frames('flow').at(-1).edges.e2.at, now);
    } else {
      assert.equal(frames('flow').length, 0);
      assert.equal(frames('flow-status').at(-1).available, false);
      assert.equal(Object.hasOwn(frames('heartbeat').at(-1), 'flowFresh'), false);
    }
    handlers.close();
    const callsAtClose = snapshotCalls, writesAtClose = writes.length;
    beat(); listener?.({ edges: {}, dropped: 0 });
    assert.equal(snapshotCalls, callsAtClose);
    assert.equal(writes.length, writesAtClose);
    assert.ok(intervals.every(timer => timer.cleared));
    assert.equal(unsubscribed, subscribed ? 1 : 0);
  }
});

test('instrumentation exceptions cannot alter execution, results or overview', { timeout: 15000 }, async () => {
  const host = await fixture({ createLiveFlow: () => ({ start() { throw Error('start'); }, finish() { throw Error('finish'); }, snapshot() { throw Error('snapshot'); } }) });
  try {
    const observer = host.listeners.get('tools/execute')[0];
    const result = { isError: false };
    let count = 0;
    assert.strictEqual(await observer({}, async () => { count++; return result; }), result);
    assert.equal(count, 1);
    const error = new Error('execution failure');
    await assert.rejects(observer({}, async () => { count++; throw error; }), e => e === error);
    assert.equal(count, 2);
    assert.doesNotThrow(() => host.listeners.get('tools/result')[0]({}, result));
    const payload = await (await fetch(`${host.base}/overview`)).json();
    assert.equal(payload[0].liveFlow, null);
  } finally { await host.close(); }
});
