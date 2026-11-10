// Real apply / pre-step and host message construction, always against a temporary
// DSH_HOME. The only unmediated mutation below simulates external tampering in
// the isolated fixture to check the actual R26 health-check path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createUserMessage } from '../src/host.js';
import { dailyTemplate } from '../src/markdown.js';
import { localDateStr } from '../src/util.js';
import { contentHash, readLedger } from '../src/write-ledger.js';
import { withMemoryRootTransaction } from '../src/root-transaction.js';

const syntheticSecret = 'sk-' + 'A'.repeat(32);
const userText = `独立采集样本：保留判断与原话，测试凭据 ${syntheticSecret}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeFixture(t, enabled) {
  const home = await mkdtemp(path.join(tmpdir(), 'daily-capture-audit-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  const oldHome = process.env.DSH_HOME;
  await mkdir(root, { recursive: true });
  await mkdir(skills, { recursive: true });
  // Empty index avoids unrelated recall/usage writes.
  await writeFile(path.join(root, 'MEMORY.md'), '# 测试索引\n', 'utf8');
  process.env.DSH_HOME = home;
  const hooks = new Map();
  const services = new Map();
  const noop = () => {};
  const ctx = {
    tools: { register: () => noop },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    on(name, fn) { hooks.set(name, fn); return noop; },
    get() { return undefined; },
    set(name, value) { services.set(name, value); },
    inject(_names, fn) { fn({ webServer: undefined, workspaceRegistry: undefined }); },
  };
  const mod = await import('../server.js');
  const dispose = mod.apply(ctx, { memoryRoot: root, skillRoot: skills, captureUserTurns: enabled, recallTimeoutMs: 100, dshRoot: process.env.DSH_INSTALL_DIR });
  const preStep = hooks.get('agent/pre-step');
  assert.equal(typeof preStep, 'function', 'actual apply must register the production pre-step');
  assert.ok(services.get('memory.healthProbe'), 'actual plugin probe must be registered');
  const message = createUserMessage({ content: [{ type: 'text', text: userText }], source: { kind: 'user' } });
  assert.equal(message.role, 'user');
  assert.ok(message.id && Object.isFrozen(message), 'use the host-constructed immutable input');
  t.after(async () => {
    dispose?.();
    // Drain already enqueued root work before removing the isolated fixture.
    await withMemoryRootTransaction(root, async () => {});
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.ok(path.basename(home).startsWith('daily-capture-audit-'));
    await rm(home, { recursive: true, force: true });
  });
  let nextCalls = 0;
  const run = () => preStep({ agent: { id: `synthetic-capture-${enabled}` }, turn: 1, messages: [message] }, async () => {
    nextCalls++;
    return { kind: 'enter', messages: [] };
  });
  return { home, root, mod, run, nextCalls: () => nextCalls };
}

async function waitForCapture(root) {
  const deadline = performance.now() + 1200;
  while (performance.now() < deadline) {
    const names = await readdir(root);
    for (const name of names.filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))) {
      const text = await readFile(path.join(root, name), 'utf8');
      // Await the ledger too: the capture and its audit record may be separate I/O.
      const ledger = await readLedger(root);
      if (text.includes('独立采集样本') && ledger instanceof Map && ledger.has(name)) return { name, text, ledger };
    }
    await sleep(10);
  }
  const names = await readdir(root);
  const captured = names.filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n));
  assert.fail(`enabled capture did not produce both today's entry and its ledger within 1200ms (daily=${captured.join(',') || 'none'})`);
}

test('启用每日采集：模板、脱敏用户原话与 R26 写入账本一致，外部改写可检测', async (t) => {
  const f = await makeFixture(t, true);
  const beforeDate = localDateStr();
  const decision = await f.run();
  assert.equal(decision.kind, 'enter');
  assert.equal(f.nextCalls(), 1, 'capture must not duplicate downstream admission');
  const capture = await waitForCapture(f.root);
  const afterDate = localDateStr();
  assert.ok([`${beforeDate}.md`, `${afterDate}.md`].includes(capture.name), 'capture must use the local date at execution, including midnight boundary');
  const date = capture.name.slice(0, -3);
  assert.ok(capture.text.startsWith(dailyTemplate(date)), 'new daily file must retain the complete canonical template');
  assert.match(capture.text, /独立采集样本：保留判断与原话/);
  assert.match(capture.text, /\[REDACTED:openai-key\]/);
  assert.ok(!capture.text.includes(syntheticSecret), 'credential-shaped dummy text must not reach disk');
  assert.equal(capture.ledger.get(capture.name)?.hash, contentHash(capture.text), 'the exact daily file bytes must match its ledger record');
  // The same raw input still contains the dummy secret. Deduplicate against the
  // redacted persisted form, or it will append on every repeat.
  await f.run();
  await sleep(120);
  await withMemoryRootTransaction(f.root, async () => {});
  assert.equal(await readFile(path.join(f.root, capture.name), 'utf8'), capture.text, 'repeated redacted input must not duplicate or rewrite the entry');
  const ledgerLines = (await readFile(path.join(f.root, '.write-ledger.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(ledgerLines.filter((entry) => entry.key === capture.name).length, 1, 'an unchanged repeat must not append a second write event');
  const before = await f.mod.runHealthCheck(f.root, { ...f.mod.DEFAULTS, newFeatureGraceDays: 0 });
  assert.ok(!before.results.some((r) => r.rule === 'R26' && r.message.includes(capture.name) && r.message.includes('内容与账本记录不符')), 'freshly captured entry must reconcile');
  await writeFile(path.join(f.root, capture.name), `${capture.text}\n外部未登记修改\n`, 'utf8');
  const after = await f.mod.runHealthCheck(f.root, { ...f.mod.DEFAULTS, newFeatureGraceDays: 0 });
  assert.ok(after.results.some((r) => r.rule === 'R26' && r.message.includes(capture.name) && r.message.includes('内容与账本记录不符')), 'R26 must independently report the tampered actual daily file');
});

test('关闭每日采集：真实 pre-step 不创建当日文件或记账', async (t) => {
  const f = await makeFixture(t, false);
  const before = await readdir(f.root);
  const decision = await f.run();
  assert.equal(decision.kind, 'enter');
  assert.equal(f.nextCalls(), 1);
  // Capture is intentionally fire-and-forget; observe beyond normal I/O turns.
  await sleep(150);
  await withMemoryRootTransaction(f.root, async () => {});
  const after = await readdir(f.root);
  assert.deepEqual(after, before, 'disabled capture must not create a daily file or ledger');
});
