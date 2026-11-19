import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../server.js';

test('overview and SSE read a bounded live runtime independently of the weekly report', { timeout: 30000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'memory-runtime-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  await mkdir(root);
  await mkdir(skills);
  const file = path.join(root, 'MEMORY.md');
  await writeFile(file, '# Memory\n');
  const weekly = { at: 'earlier', ok: false, cycle_coverage: { runtime: { state: 'missing' } } };
  let service;
  let lookupError = false;
  let handler;
  const noop = () => {};
  const ctx = {
    get(name) {
      if (name === 'valves') return { lastPatrol: () => weekly };
      if (name === 'executionRuntimeStatus') { if (lookupError) throw Error('lookup'); return service; }
    },
    tools: { register: () => noop }, on: () => noop,
    inject(_names, run) { run({ webServer: { register(route) { handler = route.handler; return noop; } }, connection: { requestRejection() {} }, effect: (fn) => fn() }); },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
  };
  let dispose;
  let server;
  try {
    dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR, dailyArchiveFirstDelayMs: 0 });
    server = createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/memory-org`;
    const overview = async () => {
      const response = await fetch(`${base}/overview`);
      assert.equal(response.status, 200);
      return (await response.json())[0];
    };
    assert.deepEqual((await overview()).runtimeSnapshot, { state: 'missing' });
    let calls = 0;
    const snapshot = { state: 'ready', limit: 100, truncated: true, runs: [{ taskId: 'x', status: 'failed' }], registeredTasks: { taskIds: ['x'], truncated: true } };
    service = { snapshot(options) { calls++; assert.deepEqual(options, { limit: 100 }); return snapshot; } };
    const live = await overview();
    assert.deepEqual(live.runtimeSnapshot, snapshot);
    assert.deepEqual(live.cycleCoverage.report, weekly.cycle_coverage);
    assert.equal(live.cycleCoverage.ok, false);
    const abort = new AbortController();
    const response = await fetch(`${base}/stream`, { signal: abort.signal });
    const reader = response.body.getReader();
    let text = '';
    while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
    assert.deepEqual(JSON.parse(text.split('\n').find((line) => line.startsWith('data: ')).slice(6)).runtimeSnapshot, snapshot);
    abort.abort();
    assert.equal(calls, 1);
    for (const state of ['disabled', 'unavailable', 'error']) {
      service = { snapshot: () => ({ state, ...(state === 'error' ? { error: 'snapshot_failed' } : {}) }) };
      assert.equal((await overview()).runtimeSnapshot.state, state);
    }
    const errorAbort = new AbortController();
    const errorStream = await fetch(`${base}/stream`, { signal: errorAbort.signal });
    const errorReader = errorStream.body.getReader();
    let errorText = '';
    while (!errorText.includes('\n\n')) errorText += new TextDecoder().decode((await errorReader.read()).value);
    assert.deepEqual(JSON.parse(errorText.split('\n').find((line) => line.startsWith('data: ')).slice(6)).runtimeSnapshot, { state: 'error', error: 'snapshot_failed' });
    errorAbort.abort();
    service = {};
    assert.deepEqual((await overview()).runtimeSnapshot, { state: 'unavailable' });
    lookupError = true;
    assert.equal((await overview()).runtimeSnapshot.state, 'error');
    lookupError = false;
    let hungCalls = 0;
    service = { snapshot() { hungCalls++; return new Promise(() => {}); } };
    assert.deepEqual((await overview()).runtimeSnapshot, { state: 'error', error: 'runtime_snapshot_timeout' });
    assert.equal((await overview()).runtimeSnapshot.error, 'runtime_snapshot_timeout');
    assert.equal(hungCalls, 1);
    assert.equal(await readFile(file, 'utf8'), '# Memory\n');
    assert.deepEqual(weekly, { at: 'earlier', ok: false, cycle_coverage: { runtime: { state: 'missing' } } });
  } finally {
    dispose?.();
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await rm(home, { recursive: true, force: true });
  }
});
