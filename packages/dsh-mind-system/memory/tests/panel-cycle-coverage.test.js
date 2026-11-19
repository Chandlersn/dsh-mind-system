import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../server.js';

test('overview and SSE expose weekly cycle coverage without inferring success', { timeout: 30000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'memory-cycle-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  await mkdir(root);
  await mkdir(skills);
  await writeFile(path.join(root, 'MEMORY.md'), '# Memory\n');
  let service;
  let getError = false;
  let handler;
  const noop = () => {};
  const ctx = {
    get(name) { if (name === 'valves' && getError) throw new Error('lookup failed'); return name === 'valves' ? service : undefined; },
    tools: { register: () => noop },
    on: () => noop,
    inject(_names, run) {
      run({ webServer: { register(route) { handler = route.handler; return noop; } }, connection: { requestRejection() {} }, effect: (fn) => fn() });
    },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
  };
  let dispose;
  let server;
  try {
    dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR });
    assert.ok(handler);
    server = createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/memory-org`;
    const overview = async () => {
      const response = await fetch(`${base}/overview`);
      assert.equal(response.status, 200);
      return (await response.json())[0].cycleCoverage;
    };
    const empty = { at: null, ok: null, report: null };
    assert.deepEqual(await overview(), { status: 'unavailable', ...empty });
    service = {};
    assert.deepEqual(await overview(), { status: 'unavailable', ...empty });
    getError = true;
    assert.deepEqual(await overview(), { status: 'unknown', ...empty });
    getError = false;
    let kinds = [];
    service = { async lastPatrol(kind) { kinds.push(kind); return null; } };
    assert.deepEqual(await overview(), { status: 'unknown', ...empty });
    service.lastPatrol = async () => { throw new Error('read failed'); };
    assert.deepEqual(await overview(), { status: 'unknown', ...empty });
    service.lastPatrol = async () => ({ at: '2026-11-19T00:00:00Z', ok: false });
    assert.deepEqual(await overview(), { status: 'missing', at: '2026-11-19T00:00:00Z', ok: false, report: null });
    service.lastPatrol = async () => ({ at: 'yesterday', cycle_coverage: 'invalid' });
    assert.deepEqual(await overview(), { status: 'unknown', at: 'yesterday', ok: null, report: null });
    const report = { observed: 3, unknown: 1, sources: ['daily'] };
    service.lastPatrol = async (kind) => { kinds.push(kind); return { at: '2026-11-19T00:00:00Z', ok: false, cycle_coverage: report }; };
    const expected = { status: 'available', at: '2026-11-19T00:00:00Z', ok: false, report };
    assert.deepEqual(await overview(), expected);
    service.lastPatrol = async () => ({ cycle_coverage: report });
    assert.deepEqual(await overview(), { status: 'available', at: null, ok: null, report });
    service.lastPatrol = async (kind) => { kinds.push(kind); return { at: '2026-11-19T00:00:00Z', ok: false, cycle_coverage: report }; };
    const abort = new AbortController();
    const stream = await fetch(`${base}/stream`, { signal: abort.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    let data = '';
    while (!data.includes('\n\n')) data += new TextDecoder().decode((await reader.read()).value);
    const event = data.split('\n').find((line) => line.startsWith('data: '));
    assert.deepEqual(JSON.parse(event.slice(6)).cycleCoverage, expected);
    abort.abort();
    assert.ok(kinds.length >= 3 && kinds.every((kind) => kind === 'weekly'));
  } finally {
    dispose?.();
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await rm(home, { recursive: true, force: true });
  }
});
