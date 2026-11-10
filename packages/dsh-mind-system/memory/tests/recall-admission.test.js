// Real apply/pre-step path; all files and agent messages are synthetic and local.
// Controlled I/O, the optional valves service and mock timers make the timeout
// deterministic without depending on disk speed or a live host session.
import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t) {
  const parent = await mkdtemp(path.join(tmpdir(), 'dsh-recall-admission-'));
  const root = path.join(parent, 'memory');
  const skills = path.join(parent, 'skills');
  await mkdir(path.join(root, 'functions'), { recursive: true });
  await mkdir(skills, { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), [
    '# 记忆索引', '', '## 功能模块索引（functions/）', '',
    '| 功能域 | 一句话状态 |', '|---|---|',
    '| [召回测试功能](functions/召回测试功能.md) | 召回测试功能专属的验证内容 |', '',
  ].join('\n'));
  await writeFile(path.join(root, 'functions', '召回测试功能.md'), '# 召回测试功能\n');
  const priorHome = process.env.DSH_HOME;
  process.env.DSH_HOME = parent;
  const mod = await import('../server.js');
  const hooks = new Map();
  const services = new Map();
  const blocked = deferred();
  const reached = deferred();
  let calls = 0;
  const valves = {
    upward() {},
    negativeRules() {
      calls += 1;
      if (calls === 1) { reached.resolve(); return blocked.promise; }
      return Promise.resolve([]);
    },
  };
  const noop = () => {};
  const ctx = {
    tools: { register: () => noop },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    on(name, fn) { hooks.set(name, fn); return noop; },
    get(name) { return name === 'valves' ? valves : undefined; },
    set(name, service) { services.set(name, service); },
    inject(_names, fn) { fn({ webServer: undefined, workspaceRegistry: undefined }); },
  };
  const dispose = mod.apply(ctx, { memoryRoot: root, skillRoot: skills, recallTimeoutMs: 100 });
  const preStep = hooks.get('agent/pre-step');
  assert.equal(typeof preStep, 'function', 'the real plugin must register its pre-step listener');
  assert.ok(services.get('memory.healthProbe'), 'the real plugin must register its configured probe');
  const payload = {
    agent: { id: 'synthetic-agent' },
    messages: [{ role: 'user', content: [{ type: 'text', text: '接下来处理召回测试功能的待观察项' }] }],
  };
  const matched = mod.matchIndexRows(await readFile(path.join(root, 'MEMORY.md'), 'utf8'), mod.tokensOf(payload.messages[0].content[0].text), 3);
  assert.ok(matched.some((row) => row.href === 'functions/召回测试功能.md'), 'fixture must match a real recall row');
  t.after(async () => {
    // A deliberately pending Promise keeps no event-loop handles or writes alive.
    t.mock.timers.reset();
    dispose?.();
    if (priorHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = priorHome;
    assert.equal(path.dirname(parent), tmpdir().replace(/[\\/]$/, ''));
    assert.ok(path.basename(parent).startsWith('dsh-recall-admission-'));
    await rm(parent, { recursive: true, force: true });
  });
  return { root, preStep, payload, blocked, reached, services, getCalls: () => calls };
}

async function waitForUsage(root) {
  // The production logger is fire-and-forget; do not remove its sandbox until
  // its asynchronous write has actually completed.
  for (let i = 0; i < 1000; i++) {
    try {
      const text = await readFile(path.join(root, '.usage.jsonl'), 'utf8');
      if (text.includes('functions/召回测试功能.md')) return;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('admitted recall usage did not complete in the isolated fixture');
}

async function timedOut(t, f) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let nextCount = 0;
  const original = { kind: 'enter', messages: [] };
  const first = f.preStep(f.payload, async () => { nextCount++; return original; });
  await f.reached.promise; // Matching is complete; the optional bridge is blocked.
  t.mock.timers.tick(100); // Deterministically settle the admission budget first.
  assert.strictEqual(await first, original, 'a timed-out recall must not change the admitted messages');
  assert.equal(nextCount, 1, 'downstream next is invoked exactly once');
}

test('a completed recall is injected and then deduplicated', async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.blocked.resolve([]);
  const first = await f.preStep(f.payload, async () => ({ kind: 'enter', messages: [] }));
  assert.equal(first.messages?.length, 1);
  assert.match(first.messages[0].content[0].text, /召回测试功能/);
  await waitForUsage(f.root);
  const report = await f.services.get('memory.healthProbe').probe();
  assert.ok(report.findings.some((x) => x.code === 'memory.recall-dual-side'), 'an admitted recall is reflected by the probe');
  const again = await f.preStep(f.payload, async () => ({ kind: 'enter', messages: [] }));
  assert.equal(again.messages?.length, 0, 'a successfully served batch is not re-injected');
});

test('a rejected step does not consume the recall and a later turn can be served', async (t) => {
  const f = await fixture(t);
  f.blocked.resolve([]);
  const rejected = { kind: 'reject', reason: 'synthetic' };
  assert.strictEqual(await f.preStep({ ...f.payload, turn: 1 }, async () => rejected), rejected);
  const before = await f.services.get('memory.healthProbe').probe();
  assert.equal(before.findings.some((x) => x.code === 'memory.recall-dual-side'), false);
  const accepted = await f.preStep({ ...f.payload, turn: 1 }, async () => ({ kind: 'enter', messages: [] }));
  assert.equal(accepted.messages.length, 1, 'rejected attempt must not consume the signature');
  await waitForUsage(f.root);
  const nextTurn = await f.preStep({ ...f.payload, turn: 2 }, async () => ({ kind: 'enter', messages: [] }));
  assert.equal(nextTurn.messages.length, 1, 'identical text in a later turn is a new request');
});

test('repair uses only corrections from the last seven days', async (t) => {
  const f = await fixture(t);
  f.blocked.resolve([]);
  const row = (days) => JSON.stringify({ t: new Date(Date.now() - days * 86400000).toISOString(), href: 'functions/召回测试功能.md', kind: 'correction' });
  await writeFile(path.join(f.root, '.usage.jsonl'), [row(9), row(8)].join('\n') + '\n');
  const unrelated = { ...f.payload, messages: [{ role: 'user', content: [{ type: 'text', text: 'zzzqv91837' }] }] };
  const result = await f.preStep(unrelated, async () => ({ kind: 'enter', messages: [] }));
  assert.equal(result.messages.length, 0, 'old corrections must not be described as recent repair');
});

test('recent repeated corrections do produce the repair reminder', async (t) => {
  const f = await fixture(t);
  f.blocked.resolve([]);
  const row = (days) => JSON.stringify({ t: new Date(Date.now() - days * 86400000).toISOString(), href: 'functions/召回测试功能.md', kind: 'correction' });
  await writeFile(path.join(f.root, '.usage.jsonl'), [row(2), row(1)].join('\n') + '\n');
  const unrelated = { ...f.payload, messages: [{ role: 'user', content: [{ type: 'text', text: 'zzzqv91837' }] }] };
  const result = await f.preStep(unrelated, async () => ({ kind: 'enter', messages: [] }));
  assert.equal(result.messages.length, 1);
  assert.match(result.messages[0].content[0].text, /召回测试功能/);
  await waitForUsage(f.root);
});

test('decision repair cannot inject a candidate skill even after repeated corrections', async (t) => {
  const f = await fixture(t);
  f.blocked.resolve([]);
  await mkdir(path.join(f.root, 'skills'), { recursive: true });
  await writeFile(path.join(f.root, 'skills', 'candidate.md'), '---\nstatus: candidate\nscope: global\n---\n\n# 候选\n');
  await writeFile(path.join(f.root, 'MEMORY.md'), '| [candidate](skills/candidate.md) | 候选修复方法 | candidate |\n');
  const now = new Date().toISOString();
  await writeFile(path.join(f.root, '.usage.jsonl'), [1, 2].map(() => JSON.stringify({ t: now, href: 'skills/candidate.md', kind: 'correction' })).join('\n') + '\n');
  const unrelated = { ...f.payload, messages: [{ role: 'user', content: [{ type: 'text', text: 'zzzqv91837' }] }] };
  const result = await f.preStep(unrelated, async () => ({ kind: 'enter', messages: [] }));
  assert.equal(result.messages.length, 0);
});

test('negative rules still enter when the memory index is missing', async (t) => {
  const f = await fixture(t);
  await rm(path.join(f.root, 'MEMORY.md'));
  f.blocked.resolve([{ id: 'test-rule', statement: '禁止测试动作', keywords: ['召回测试功能'] }]);
  const result = await f.preStep(f.payload, async () => ({ kind: 'enter', messages: [] }));
  assert.equal(result.messages.length, 1);
  assert.match(result.messages[0].content[0].text, /禁止测试动作/);
  const health = await f.services.get('memory.healthProbe').probe();
  const exposure = health.findings.find((finding) => finding.code === 'memory.recall-dual-side');
  assert.ok(exposure, 'a rules-only injected message must appear in exposure telemetry');
  assert.match(exposure.message, /1 个已注入轮次/);
  assert.match(exposure.message, /最终索引\/修复项 0，档案 0，规则 1/);
  assert.match(exposure.hint, /不含无匹配、超时或拒绝的分母/);
});

test('a timed-out recall does not add an admitted round to the recall ledger', async (t) => {
  const f = await fixture(t);
  await timedOut(t, f);
  const report = await f.services.get('memory.healthProbe').probe();
  assert.equal(report.findings.some((x) => x.code === 'memory.recall-dual-side'), false,
    'a candidate that was never admitted must not be counted as a served recall');
});

test('a timed-out candidate does not suppress the same input on a later pre-step', async (t) => {
  const f = await fixture(t);
  await timedOut(t, f);
  const retried = await f.preStep(f.payload, async () => ({ kind: 'enter', messages: [] }));
  assert.equal(f.getCalls(), 2, 'the same input must be rebuilt, not discarded by served-signature deduplication');
  assert.equal(retried.messages?.length, 1, 'the later successful attempt must actually reach the model');
  assert.match(retried.messages[0].content[0].text, /召回测试功能/);
  await waitForUsage(f.root);
});

test('a background candidate completing after timeout cannot create a served ledger entry', async (t) => {
  const f = await fixture(t);
  const readStarted = deferred();
  const releaseRead = deferred();
  const originalRead = fs.promises.readFile;
  const indexText = await originalRead.call(fs.promises, path.join(f.root, 'MEMORY.md'), 'utf8');
  let intercepted = false;
  // Intercept only this fixture's first index read; restore the Node builtin in
  // finally. syncBuiltinESMExports updates util.js's imported live binding too.
  fs.promises.readFile = async (file, ...args) => {
    if (!intercepted && typeof file === 'string' && path.resolve(file) === path.join(f.root, 'MEMORY.md')) {
      intercepted = true;
      readStarted.resolve();
      await releaseRead.promise;
      return indexText;
    }
    if (typeof file === 'string' && path.resolve(file) === path.join(f.root, '.usage.jsonl')) {
      const error = new Error('no usage in isolated fixture');
      error.code = 'ENOENT';
      throw error;
    }
    return originalRead.call(fs.promises, file, ...args);
  };
  syncBuiltinESMExports();
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const original = { kind: 'enter', messages: [] };
    const first = f.preStep(f.payload, async () => original);
    await readStarted.promise;
    t.mock.timers.tick(100);
    assert.strictEqual(await first, original, 'the index read was still pending when the timeout admitted the step');
    releaseRead.resolve();
    // Both index and usage reads are controlled above; one event-loop turn
    // drains the resumed candidate's microtasks, whether it aborts or reaches valves.
    await new Promise((resolve) => setImmediate(resolve));
    const report = await f.services.get('memory.healthProbe').probe();
    assert.equal(report.findings.some((x) => x.code === 'memory.recall-dual-side'), false,
      'late background matching must not append to the served ledger after timeout');
    fs.promises.readFile = originalRead;
    syncBuiltinESMExports();
    // If cancellation stopped before reaching the bridge, allow the first
    // bridge call made by the retry; otherwise leave the old candidate parked.
    if (f.getCalls() === 0) f.blocked.resolve([]);
    const retry = await f.preStep(f.payload, async () => ({ kind: 'enter', messages: [] }));
    assert.equal(retry.messages?.length, 1, 'late completion must not mark this batch as served');
    await waitForUsage(f.root);
  } finally {
    fs.promises.readFile = originalRead;
    syncBuiltinESMExports();
    releaseRead.resolve();
  }
});
