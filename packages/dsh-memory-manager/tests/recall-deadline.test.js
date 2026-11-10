// Real apply/pre-step, synthetic messages and an isolated DSH_HOME.  The first
// bridge call blocks the event loop *after* Promise.race installed its timer.
// Its resolved promise then wins the microtask queue before the overdue timer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import path from 'node:path';

const budgetMs = 100;
const blockMs = 210;

test('an event-loop stall past the recall deadline cannot admit or consume a candidate', async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), 'dsh-recall-deadline-'));
  const root = path.join(parent, 'memory');
  const skills = path.join(parent, 'skills');
  const oldHome = process.env.DSH_HOME;
  let dispose;
  t.after(async () => {
    dispose?.();
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    assert.equal(path.dirname(parent), path.resolve(tmpdir()));
    assert.ok(path.basename(parent).startsWith('dsh-recall-deadline-'));
    await rm(parent, { recursive: true, force: true });
  });
  process.env.DSH_HOME = parent;
  await mkdir(path.join(root, 'functions'), { recursive: true });
  await mkdir(skills, { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), [
    '# 记忆索引', '', '## 功能模块索引（functions/）', '',
    '| 功能域 | 一句话状态 |', '|---|---|',
    '| [召回超时测试](functions/召回超时测试.md) | 召回超时测试的独立证据 |', '',
  ].join('\n'), 'utf8');
  await writeFile(path.join(root, 'functions', '召回超时测试.md'), '# 召回超时测试\n', 'utf8');

  const hooks = new Map();
  const services = new Map();
  const noop = () => {};
  let bridgeCalls = 0;
  let blockedFor = 0;
  const valves = {
    upward() {},
    negativeRules() {
      bridgeCalls++;
      if (bridgeCalls === 1) {
        const start = performance.now();
        while (performance.now() - start < blockMs) { /* intentionally block this event loop */ }
        blockedFor = performance.now() - start;
      }
      return Promise.resolve([]);
    },
  };
  const ctx = {
    tools: { register: () => noop },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    on(name, fn) { hooks.set(name, fn); return noop; },
    get(name) { return name === 'valves' ? valves : undefined; },
    set(name, service) { services.set(name, service); },
    inject(_names, fn) { fn({ webServer: undefined, workspaceRegistry: undefined }); },
  };
  const mod = await import('../server.js');
  assert.equal(mod.resolveRecallBudget(budgetMs), budgetMs);
  dispose = mod.apply(ctx, { memoryRoot: root, skillRoot: skills, recallTimeoutMs: budgetMs });
  const preStep = hooks.get('agent/pre-step');
  assert.equal(typeof preStep, 'function');
  const payload = {
    agent: { id: 'deadline-synthetic-agent' }, turn: 1,
    messages: [{ role: 'user', content: [{ type: 'text', text: '处理召回超时测试的独立证据' }] }],
  };
  const before = performance.now();
  let nextCalls = 0;
  const next = async () => { nextCalls++; return { kind: 'enter', messages: [] }; };
  const first = await preStep(payload, next);
  const elapsed = performance.now() - before;
  assert.ok(blockedFor >= blockMs && elapsed >= budgetMs, `fixture must really block past deadline (blocked ${blockedFor}ms, total ${elapsed}ms)`);
  assert.equal(bridgeCalls, 1, 'controlled stall must run in the first candidate');
  // Reading the probe takes another I/O turn, allowing an incorrectly scheduled
  // background append to proceed before we inspect the isolated usage ledger.
  const report = await services.get('memory.healthProbe').probe();
  const exposure = report.findings.some((finding) => finding.code === 'memory.recall-dual-side');
  let usage = '';
  try { usage = await readFile(path.join(root, '.usage.jsonl'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const retry = await preStep(payload, next);
  if (retry.messages.length) {
    // The production usage append is fire-and-forget; let it finish before
    // cleaning up the fixture, without adding a long sleep to the test.
    const until = performance.now() + 500;
    let observed = false;
    while (performance.now() < until) {
      try {
        const text = await readFile(path.join(root, '.usage.jsonl'), 'utf8');
        if (text.includes('functions/召回超时测试.md')) { observed = true; break; }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(observed, 'successful retry must finish its usage append inside the fixture');
  }
  t.diagnostic(`budgetMs=${budgetMs} blockedMs=${blockedFor.toFixed(1)} elapsedMs=${elapsed.toFixed(1)} firstMessages=${first.messages.length} exposure=${exposure} usageBytes=${Buffer.byteLength(usage)} retryMessages=${retry.messages.length} bridgeCalls=${bridgeCalls}`);

  assert.equal(first.messages.length, 0, 'candidate completed after the wall-clock deadline must not be injected');
  assert.equal(exposure, false, 'an over-deadline candidate must not record served exposure');
  assert.equal(usage, '', 'an over-deadline candidate must not append usage');
  assert.equal(retry.messages.length, 1, 'same agent, turn and text must remain retryable');
  assert.equal(bridgeCalls, 2, 'retry must rebuild instead of using a served signature');
  assert.match(retry.messages[0].content[0].text, /召回超时测试/);
  assert.equal(nextCalls, 2, 'each attempt invokes downstream exactly once');
});
