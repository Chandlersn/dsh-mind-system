import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../server.js';
import { readUsageLedgerText } from './usage-ledger-helper.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

async function fixture(t, { matching = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'scan-dedupe-'));
  await mkdir(path.join(root, 'functions'));
  await writeFile(path.join(root, 'MEMORY.md'), matching ? '| 功能域 | 一句话状态 |\n|---|---|\n| [recallwidget](functions/recallwidget.md) | recallwidget unique feature |\n' : '');
  await writeFile(path.join(root, 'functions', 'recallwidget.md'), '# recallwidget\n');
  const hooks = new Map();
  const scan = deferred();
  const refresh = deferred();
  let clock = 1000, scanCalls = 0;
  let rules = [];
  const noop = () => {};
  const ctx = {
    tools: { register: () => noop },
    systemPrompt: { getSectionOrder: () => 1, section: () => noop },
    on(name, fn) { hooks.set(name, fn); return noop; },
    get(name) { return name === 'valves' ? { upward() {}, negativeRules: () => rules } : undefined; },
    set() {}, inject(_names, fn) { fn({}); },
  };
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: path.join(root, 'skills'), recallTimeoutMs: 1000 }, { now: () => clock, detectDistillationBacklog: () => (++scanCalls === 1 ? scan.promise : refresh.promise) });
  const payload = { agent: { id: 'agent' }, turn: 1, messages: [{ role: 'user', content: [{ type: 'text', text: 'recallwidget' }] }] };
  const step = (decision = { kind: 'enter', messages: [] }) => hooks.get('agent/pre-step')(payload, async () => decision);
  t.after(async () => { dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, scan, refresh, step, advanceClock() { clock += 600001; }, setRules(value) { rules = value; } };
}

const text = (result) => result.messages.map((m) => m.content.map((part) => part.text ?? '').join('')).join('\n');
const report = { due: [{ area: 'scan-result', days: ['2026-01-01'], newestBlock: null }], orphan: [] };
const usageUnknown = '⚠ 使用账本读取失败：使用热度与纠偏状态未知，本轮仅按其他可用证据召回。';
function assertNoDuplicate(result, label) {
  const rendered = text(result);
  assert.ok(rendered === '' || rendered === usageUnknown, `${label}: unexpected output ${JSON.stringify(rendered)}`);
}
async function settle() { await new Promise((resolve) => setImmediate(resolve)); }
async function waitUsage(root) {
  for (let i = 0; i < 1000; i++) {
    if ((await readUsageLedgerText(root)).includes('recallwidget.md')) return;
    await settle();
  }
  throw new Error('usage write did not finish');
}

test('pending and completed scan are delivered independently of foreground recall', async (t) => {
  const f = await fixture(t);
  const first = text(await f.step());
  assert.match(first, /recallwidget/);
  assert.match(first, /扫描进行中/);
  assertNoDuplicate(await f.step(), 'pending is emitted only once');
  f.scan.resolve(report);
  await settle();
  const completed = text(await f.step());
  assert.match(completed, /scan-result/);
  assert.doesNotMatch(completed, /recallwidget/);
  assertNoDuplicate(await f.step(), 'the same scan report is emitted once');
  await waitUsage(f.root);
});

test('a new completed scan revision is delivered in the same turn', async (t) => {
  const f = await fixture(t, { matching: false });
  await f.step();
  f.scan.resolve(report);
  await settle();
  assert.match(text(await f.step()), /scan-result/);
  f.advanceClock();
  await f.step();
  f.refresh.resolve({ due: [{ area: 'updated-result', days: ['2026-01-02'] }], orphan: [] });
  await settle();
  assert.match(text(await f.step()), /updated-result/);
  assert.equal(text(await f.step()), '');
});

test('pending alone does not consume newly available rules', async (t) => {
  const f = await fixture(t, { matching: false });
  assert.match(text(await f.step()), /扫描进行中/);
  assert.equal(text(await f.step()), '');
  f.setRules([{ id: 'new-rule', statement: 'newly available rule', keywords: ['recallwidget'] }]);
  assert.match(text(await f.step()), /newly available rule/);
  assert.equal(text(await f.step()), '');
  f.scan.resolve(report);
  await settle();
  assert.match(text(await f.step()), /scan-result/);
});

test('rejected pending and completed reports do not consume delivery', async (t) => {
  const f = await fixture(t);
  const rejected = { kind: 'reject' };
  assert.strictEqual(await f.step(rejected), rejected);
  assert.match(text(await f.step()), /扫描进行中/);
  f.scan.resolve(report);
  await settle();
  assert.strictEqual(await f.step(rejected), rejected);
  assert.match(text(await f.step()), /scan-result/);
  assertNoDuplicate(await f.step(), 'completed report is not repeated after rejection');
  await waitUsage(f.root);
});
