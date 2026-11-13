// Real apply/pre-step + panel overview, exclusively against a temporary DSH_HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createUserMessage } from '../src/host.js';
import { makeCaptureMarker } from '../src/capture-events.js';
import { localDateStr } from '../src/util.js';
import { readLedger, contentHash } from '../src/write-ledger.js';
import { withMemoryRootTransaction } from '../src/root-transaction.js';

const mod = await import('../server.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const noop = () => {};
const secret = 'sk-' + 'A'.repeat(32); // synthetic, never a credential
const msg = (text, kind = 'user') => createUserMessage({
  content: [{ type: 'text', text }], source: { kind },
});

async function setup(t, enabled = true) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'capture-hook-status-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  await mkdir(root, { recursive: true });
  await mkdir(skills, { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), '# isolated index\n', 'utf8');
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const instances = [];
  function instance() {
    const hooks = new Map();
    const emits = [];
    let handler;
    const ctx = {
      tools: { register: () => noop },
      systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
      on(name, fn) { hooks.set(name, fn); return noop; },
      get() { return undefined; },
      set() {},
      emit(...args) { emits.push(args); },
      inject(_names, fn) {
        fn({
          webServer: { register(route) { if (route.path === '/api/memory-org') handler = route.handler; return noop; } },
          connection: { requestRejection: () => undefined },
          effect(f) { return f(); },
        });
      },
    };
    const dispose = mod.apply(ctx, { memoryRoot: root, skillRoot: skills, captureUserTurns: enabled, recallTimeoutMs: 100, dshRoot: process.env.DSH_INSTALL_DIR });
    const preStep = hooks.get('agent/pre-step');
    assert.equal(typeof preStep, 'function');
    assert.equal(typeof handler, 'function');
    const initialEmits = emits.length; // apply itself registers its mind signal
    async function overview() {
      let status, body;
      await handler({ method: 'GET', url: '/api/memory-org/overview' }, {
        writeHead(code) { status = code; }, end(value) { body = value; },
      });
      assert.equal(status, 200, 'use the actual overview handler');
      const data = JSON.parse(body);
      assert.ok(Array.isArray(data) && data.length === 1);
      return data[0].capture;
    }
    const run = (messages, next) => preStep({ agent: { id: 'capture-hook-test' }, turn: 1, messages }, next);
    const obj = { dispose, run, overview, emits, initialEmits };
    instances.push(obj);
    return obj;
  }
  t.after(async () => {
    for (const i of instances) i.dispose?.();
    await withMemoryRootTransaction(root, async () => {});
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    assert.equal(path.dirname(home), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('capture-hook-status-'));
    await rm(home, { recursive: true, force: true });
  });
  return { home, root, instance };
}

async function settled(instance, predicate) {
  const until = performance.now() + 3000;
  let state;
  while (performance.now() < until) {
    state = await instance.overview();
    if (state && state.pending === 0 && predicate(state)) return state;
    await sleep(10);
  }
  assert.fail(`capture status did not settle: ${JSON.stringify(state)}`);
}
const enter = async () => ({ kind: 'enter', messages: [] });

async function noInbox(home) {
  const names = await readdir(path.join(home, 'storages')).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  assert.ok(!names.some((n) => /inbox/i.test(n)), 'capture and read-only overview must not mutate an inbox');
}

test('actual hook admits only identified user events; persisted IDs survive instance reload', async (t) => {
  const f = await setup(t);
  const historicalFile = path.join(f.root, '1900-01-01.md');
  const oldHistory = `历史文件不得修改 ${secret}\n`;
  await writeFile(historicalFile, oldHistory, 'utf8');
  const a = f.instance();
  const text = `同文事件 ${secret}`;
  const user1 = msg(text), user2 = msg(text), plugin = msg('不得采集的插件消息', 'memory-manager/recall');
  const { id: _discard, ...missingId } = msg('不得采集的无 ID 消息');
  assert.ok(user1.id && user2.id && user1.id !== user2.id);
  assert.equal(user1.role, 'user');
  assert.ok(Object.isFrozen(user1), 'host constructs the real immutable user message');
  await a.run([user1, plugin, missingId, user2, user1], enter);
  let status = await settled(a, (s) => s.confirmed === 2);
  assert.equal(status.observed, 5);
  assert.equal(status.selected, 2);
  assert.equal(status.skippedSource, 1);
  assert.equal(status.skippedMissingId, 1);
  assert.equal(status.failed, 0);
  const file = path.join(f.root, `${localDateStr()}.md`);
  const captured = await readFile(file, 'utf8');
  assert.equal(captured.split('同文事件').length - 1, 2, 'different IDs with the same text must both persist');
  assert.equal(captured.split('[REDACTED:openai-key]').length - 1, 2, 'each event is redacted before persistence');
  assert.ok(!captured.includes(secret));
  assert.ok(!captured.includes('不得采集'));
  assert.equal(await readFile(historicalFile, 'utf8'), oldHistory, 'redaction must not rewrite historical files');
  assert.ok(captured.split('\n').includes(makeCaptureMarker(user1.id)));
  assert.ok(captured.split('\n').includes(makeCaptureMarker(user2.id)));
  const ledger = await readLedger(f.root);
  assert.equal(ledger.get(path.basename(file)).hash, contentHash(captured));
  const beforeLedger = await readFile(path.join(f.root, '.write-ledger.jsonl'), 'utf8');
  await a.run([user1], enter);
  status = await settled(a, (s) => s.duplicate === 1);
  assert.equal(status.confirmed, 2);
  assert.equal(await readFile(file, 'utf8'), captured);
  assert.equal(await readFile(path.join(f.root, '.write-ledger.jsonl'), 'utf8'), beforeLedger, 'replay does not write another ledger record');
  assert.equal(a.emits.length, a.initialEmits, 'capture must not emit events');
  await noInbox(f.home);

  a.dispose();
  const b = f.instance();
  const fresh = await b.overview();
  assert.equal(fresh.resetOnNewInstance, true);
  assert.equal(fresh.hasObservations, false);
  assert.equal(fresh.observed, 0);
  await b.run([user2], enter);
  const replay = await settled(b, (s) => s.duplicate === 1);
  assert.equal(replay.confirmed, 0, 'persisted marker, not in-memory status, controls dedupe after reload');
  assert.equal(await readFile(file, 'utf8'), captured);
  assert.equal(b.emits.length, b.initialEmits);
  await noInbox(f.home);
});

test('reject and downstream exceptions do not schedule or observe capture', async (t) => {
  const f = await setup(t);
  const a = f.instance();
  const candidate = msg('不能采集未准入消息');
  await a.run([candidate], async () => ({ kind: 'reject', messages: [] }));
  await assert.rejects(a.run([candidate], async () => { throw new Error('downstream failure'); }), /downstream failure/);
  await sleep(100);
  await withMemoryRootTransaction(f.root, async () => {});
  const status = await a.overview();
  assert.equal(status.hasObservations, false);
  assert.equal(status.observed, 0);
  assert.equal(status.scheduled, 0);
  assert.equal(status.pending, 0);
  assert.ok(!(await readdir(f.root)).some((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)));
  assert.equal(a.emits.length, a.initialEmits);
  await noInbox(f.home);
});

test('unverified baseline is visible as a read-only status failure and cannot rewrite history', async (t) => {
  const f = await setup(t);
  const a = f.instance();
  const file = path.join(f.root, `${localDateStr()}.md`);
  const historical = `历史原样保留 ${secret}\n`;
  await writeFile(file, historical, 'utf8'); // isolated unrecorded pre-existing fixture
  await a.run([msg('不得补写历史')], enter);
  const status = await settled(a, (s) => s.failed === 1);
  assert.equal(status.errorCodes.CAPTURE_BASELINE_UNVERIFIED, 1);
  assert.equal(status.errorStages.read, 1);
  assert.equal(status.confirmed, 0);
  assert.equal(await readFile(file, 'utf8'), historical, 'failed capture must not redact or alter existing history');
  assert.ok(!(await readdir(f.root)).includes('.write-ledger.jsonl'), 'do not falsely attest the old file');
  const again = await a.overview();
  assert.deepEqual(again, status, 'overview is read-only');
  assert.equal(a.emits.length, a.initialEmits);
  await noInbox(f.home);
});

test('overview observes pending intent without modifying it, even while capture is disabled', async (t) => {
  const f = await setup(t, false);
  const a = f.instance();
  assert.equal((await a.overview()).intentWitness, 'not_seen');
  const pending = path.join(f.root, '.daily-capture.pending');
  const witness = 'isolated witness; do not alter';
  await writeFile(pending, witness);
  assert.equal((await a.overview()).intentWitness, 'present');
  assert.equal(await readFile(pending, 'utf8'), witness);
  assert.equal(a.emits.length, a.initialEmits);
  await noInbox(f.home);
});

test('disabled capture never observes inputs or writes files', async (t) => {
  const f = await setup(t, false);
  const a = f.instance();
  const before = await readdir(f.root);
  await a.run([msg('disabled sample')], enter);
  await sleep(100);
  await withMemoryRootTransaction(f.root, async () => {});
  const status = await a.overview();
  assert.equal(status.enabled, false);
  assert.equal(status.hasObservations, false);
  assert.equal(status.observed, 0);
  assert.equal(status.scheduled, 0);
  assert.deepEqual(await readdir(f.root), before);
  assert.equal(a.emits.length, a.initialEmits);
  await noInbox(f.home);
});
