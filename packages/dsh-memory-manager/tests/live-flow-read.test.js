import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { apply } from '../server.js';
import { resolveDshRoot } from '../src/host.js';

const hostEntry = path.join(resolveDshRoot(process.env.DSH_INSTALL_DIR), 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
const { validateJsonSchemaValue } = createRequire(hostEntry)(hostEntry);

async function fixture(t, dependencies = {}, enableEvents = true) {
  const home = await mkdtemp(path.join(tmpdir(), 'live-flow-read-'));
  const root = path.join(home, 'memory');
  await mkdir(root);
  const oldHome = process.env.DSH_HOME;
  const oldSag = process.env.SAG_BIN;
  process.env.DSH_HOME = home;
  process.env.SAG_BIN = path.join(home, 'missing-sag');
  const tools = new Map(), listeners = new Map(), noop = () => {};
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); return noop; } },
    get() {}, systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    inject(_names, fn) { fn({ webServer: undefined, workspaceRegistry: undefined }); },
  };
  if (enableEvents) ctx.on = (name, fn) => {
    const list = listeners.get(name) ?? [];
    list.push(fn); listeners.set(name, list);
    return () => { const index = list.indexOf(fn); if (index >= 0) list.splice(index, 1); };
  };
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: path.join(home, 'skills'), dshRoot: process.env.DSH_INSTALL_DIR, dailyArchiveFirstDelayMs: 0, dailyArchiveIntervalMs: 0 }, dependencies);
  t.after(async () => {
    dispose();
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    if (oldSag === undefined) delete process.env.SAG_BIN; else process.env.SAG_BIN = oldSag;
    await rm(home, { recursive: true, force: true });
  });
  return { root, tools, listeners };
}

async function read(tool) {
  const args = { kind: 'live_flow' };
  const value = await tool.execute(args);
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, 'value'), []);
  assert.equal(tool.output.render(args, value)[0].text, value.content);
  return { value, data: JSON.parse(value.content) };
}

test('reads the live host collector through active and finished SAG execution without private details', async t => {
  const { root, tools, listeners } = await fixture(t);
  const tool = tools.get('memory_read');
  const initial = (await read(tool)).data;
  assert.deepEqual({ status: initial.status, edges: initial.edges, dropped: initial.dropped }, { status: 'available', edges: {}, dropped: 0 });
  assert.equal(initial.taskEvidenceTool, 'memory_cycle');
  assert.equal(initial.closureEvidence.correlation, 'required');
  assert.equal(initial.closureEvidence.independentReview, false);
  const before = await readdir(root);
  const exec = { token: Symbol('secret-token'), name: 'memory_sag', arguments: { action: 'search', query: 'secret-query' }, callId: 'secret-id' };
  let release;
  const pending = listeners.get('tools/execute')[0](exec, () => new Promise(resolve => { release = resolve; }));
  const active = await read(tool);
  assert.equal(active.data.edges.e15.phase, 'active');
  release({ isError: false, content: 'secret-result' });
  const result = await pending;
  listeners.get('tools/result')[0](exec, result);
  const finished = await read(tool);
  assert.equal(finished.data.edges.e15.phase, 'finished');
  assert.doesNotMatch(JSON.stringify([active, finished]), /secret|memory_sag|query|callId|token/);
  assert.deepEqual(await readdir(root), before);
  for (const extra of [{ name: 'x' }, { date: 'x' }, { token: 'x' }, { request_id: 'x' }, { limit: 1 }, { [Symbol('hidden')]: 1 }]) {
    await assert.rejects(tool.execute({ kind: 'live_flow', ...extra }), /only kind|lossless JSON object/);
  }
});

test('missing or failing instrumentation is unavailable and never reported as empty', async t => {
  const host = await fixture(t, { createLiveFlow() { throw Error('unavailable'); } });
  const { value, data } = await read(host.tools.get('memory_read'));
  assert.equal(value.found, false);
  assert.deepEqual(data, { status: 'unavailable' });
});

test('snapshot exceptions are unavailable and do not expose exception details', async t => {
  const host = await fixture(t, { createLiveFlow: () => ({ start() {}, finish() {}, snapshot() { throw Error('secret-error'); } }) });
  const { value, data } = await read(host.tools.get('memory_read'));
  assert.equal(value.found, false);
  assert.deepEqual(data, { status: 'unavailable' });
  assert.doesNotMatch(value.content, /secret/);
});

test('snapshot projection discards arbitrary fields and unknown edges', async t => {
  const host = await fixture(t, { createLiveFlow: () => ({ start() {}, finish() {}, snapshot() { return { dropped: 0, secret: 'secret', edges: { e10: { phase: 'finished', at: 1, expiresAt: 2, source: 'cache', args: 'secret' }, e15: { phase: 'finished', at: 1, expiresAt: 2, args: 'secret' }, secret: { phase: 'active', at: 1, expiresAt: 2 } } }; } }) });
  const { data } = await read(host.tools.get('memory_read'));
  assert.deepEqual({ status: data.status, edges: data.edges, dropped: data.dropped }, { status: 'available', edges: { e10: { phase: 'finished', at: 1, expiresAt: 2, source: 'cache' }, e15: { phase: 'finished', at: 1, expiresAt: 2 } }, dropped: 0 });
  assert.equal(data.taskEvidenceTool, 'memory_cycle');
  assert.equal(data.closureEvidence.chain, 'unknown');
  assert.doesNotMatch(JSON.stringify(data), /secret/);
});
