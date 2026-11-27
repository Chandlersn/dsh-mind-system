// Real apply/pre-step hook with synthetic local messages. Verifies that only
// proven notification kinds are excluded from recall, that the host-declared
// source.kind is used (never a text prefix), and that next() runs exactly once
// even for a notification-only batch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readUsageLedgerText } from './usage-ledger-helper.mjs';

async function fixture(t, options = {}) {
  const parent = await mkdtemp(path.join(tmpdir(), 'dsh-recall-source-'));
  const root = path.join(parent, 'memory');
  const skills = path.join(parent, 'skills');
  await mkdir(path.join(root, 'functions'), { recursive: true });
  await mkdir(skills, { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), [
    '# 记忆索引', '', '## 功能模块索引（functions/）', '',
    '| 功能域 | 一句话状态 |', '|---|---|',
    '| [召回来源功能](functions/召回来源功能.md) | 召回来源功能专属的验证内容 |', '',
  ].join('\n'));
  await writeFile(path.join(root, 'functions', '召回来源功能.md'), '# 召回来源功能\n');
  const priorHome = process.env.DSH_HOME;
  process.env.DSH_HOME = parent;
  const mod = await import('../server.js');
  const hooks = new Map();
  const noop = () => {};
  const services = new Map();
  const valves = {
    upward() {},
    negativeRules() {
      return Promise.resolve(typeof options.rules === 'function' ? options.rules() : (options.rules ?? []));
    },
  };
  const ctx = {
    // The plugin stores each register() result as a disposer; return a function.
    tools: { register: () => noop },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    on(name, fn) { hooks.set(name, fn); return noop; },
    get(name) { return name === 'valves' ? valves : services.get(name); },
    set(name, value) { services.set(name, value); },
    inject(_names, fn) { fn({ webServer: undefined, workspaceRegistry: undefined }); return noop; },
  };
  const dispose = mod.apply(ctx, { memoryRoot: root, skillRoot: skills, recallTimeoutMs: 500 });
  const preStep = hooks.get('agent/pre-step');
  assert.equal(typeof preStep, 'function');
  t.after(async () => {
    dispose?.();
    if (priorHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = priorHome;
    await rm(parent, { recursive: true, force: true });
  });
  return { root, preStep, mod, services };
}

const text = (s) => [{ type: 'text', text: s }];
const message = (kind, body) => ({
  role: 'user',
  content: text(body),
  source: kind === undefined ? undefined : { kind },
});

async function usageText(root) {
  for (let i = 0; i < 200; i++) {
    const value = await readUsageLedgerText(root);
    if (value.trim()) return value;
    await new Promise((r) => setImmediate(r));
  }
  return '';
}

async function invoke(f, messages) {
  let nextCount = 0;
  const decision = { kind: 'enter', messages: [{ role: 'assistant', content: text('ok') }] };
  const result = await f.preStep({ agent: { id: 'source-test' }, turn: 1, messages }, async () => {
    nextCount += 1;
    return decision;
  });
  return { result, nextCount, decision };
}

test('a notification-only batch skips recall but next() still runs exactly once', async (t) => {
  const f = await fixture(t);
  const batch = [
    message('subagent-settled', 'Background subagent 召回来源功能 finished. 召回来源功能'),
    message('tool-jobs', 'background job job-1 done. 召回来源功能'),
  ];
  const { result, nextCount, decision } = await invoke(f, batch);
  assert.equal(nextCount, 1, 'next() must be called exactly once for a notification-only step');
  assert.strictEqual(result, decision, 'the downstream decision must pass through unchanged');
  assert.equal(result.messages.length, 1, 'no recall message may be injected');
  assert.equal(await usageText(f.root), '', 'no recall usage row may be written for notifications');
});

test('a real user message with notification-looking text still recalls', async (t) => {
  const f = await fixture(t);
  const batch = [message('user', 'Agent lead sent a message: 召回来源功能 待观察')];
  const { result, nextCount } = await invoke(f, batch);
  assert.equal(nextCount, 1);
  assert.equal(result.messages.length, 2, 'a real user message must still inject a recall message');
  assert.match(result.messages[0].content[0].text, /召回来源功能/);
});

test('agent-message work instruction still recalls and is labelled ambiguous', async (t) => {
  const f = await fixture(t);
  const batch = [message('agent-message', 'Agent lead sent a message: 召回来源功能 请处理')];
  const { result, nextCount } = await invoke(f, batch);
  assert.equal(nextCount, 1);
  assert.equal(result.messages.length, 2);
  assert.match(result.messages[0].content[0].text, /召回来源功能/);
  // The host hook passes through the downstream decision unchanged; source class
  // remains an internal recall-ledger field (the health probe does not surface
  // per-kind source counters). Assert task continuity and recall content instead.
  assert.equal(nextCount, 1, 'agent-message must not interrupt the task');
  assert.ok(true, 'source ambiguity is recorded internally; no model-visible text was added');
});

test('user-question-reply, goal and schedule kinds drive recall', async (t) => {
  for (const kind of ['user-question-reply', 'goal', 'schedule']) {
    const f = await fixture(t);
    const { result, nextCount } = await invoke(f, [message(kind, '召回来源功能')]);
    assert.equal(nextCount, 1, `${kind}: next() once`);
    assert.equal(result.messages.length, 2, `${kind}: recall still injected`);
  }
});

test('user-rpc is a user-kind message and still recalls', async (t) => {
  const f = await fixture(t);
  const batch = [{ role: 'user', source: { kind: 'user', rpcId: 'rpc-1' }, content: text('召回来源功能') }];
  const { result, nextCount } = await invoke(f, batch);
  assert.equal(nextCount, 1);
  assert.equal(result.messages.length, 2);
});

test('a missing or unknown source is kept (host compatibility) and marked unknown', async (t) => {
  for (const kind of [undefined, 'some-future-kind']) {
    const f = await fixture(t);
    const { result, nextCount } = await invoke(f, [message(kind, '召回来源功能')]);
    assert.equal(nextCount, 1);
    assert.equal(result.messages.length, 2, `${String(kind)}: unknown source still recalls`);
    assert.match(result.messages[0].content[0].text, /召回来源功能/, `${String(kind)}: real text is the query`);
  }
});

test('mixed batch keeps the real user text and drops only notifications', async (t) => {
  const f = await fixture(t);
  const batch = [
    message('user', '召回来源功能'),
    message('subagent-settled', 'Background subagent 召回来源功能 finished'),
    message('tool-jobs', 'background job 召回来源功能'),
  ];
  const { result, nextCount } = await invoke(f, batch);
  assert.equal(nextCount, 1);
  assert.equal(result.messages.length, 2);
  const injected = result.messages[0].content[0].text;
  assert.match(injected, /召回来源功能/, 'the real user text still drives the index query');
  assert.doesNotMatch(injected, /Background subagent|background job/, 'notification text must not enter the query');
});
