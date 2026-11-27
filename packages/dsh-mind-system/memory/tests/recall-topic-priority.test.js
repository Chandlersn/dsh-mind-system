// Verifies the agent/pre-step recall topic is driven by trusted user input, not
// by agent-message relays that happen to share the turn. All files and messages
// are synthetic and local (mkdtemp); no real memory root is touched.
// Two distinct index rows make the selected topic observable: an agent-topic
// row that matches ONLY the agent-message text, and a user-topic row that
// matches ONLY the trusted text. The injected queryPreview proves which text
// reached matchIndexRows as queryText.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readUsageLedgerText } from './usage-ledger-helper.mjs';

const AGENT_TOPIC = '量子计算机 蓝色 大象';
const USER_TOPIC = '记忆系统 召回 主题';
const AGENT_ROW = 'functions/量子象领域.md';
const USER_ROW = 'functions/记忆召回主题.md';

let fixtureSeq = 0;

async function fixture(t) {
  const parent = await mkdtemp(path.join(tmpdir(), 'dsh-recall-topic-'));
  const root = path.join(parent, 'memory');
  const skills = path.join(parent, 'skills');
  await mkdir(path.join(root, 'functions'), { recursive: true });
  await mkdir(skills, { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), [
    '# 记忆索引', '', '## 功能模块索引（functions/）', '',
    '| 功能域 | 一句话状态 |', '|---|---|',
    `| [量子象领域](functions/量子象领域.md) | 量子计算机 蓝色 大象 专属说明 |`,
    `| [记忆召回主题](functions/记忆召回主题.md) | 记忆系统 召回 主题 专属说明 |`, '',
  ].join('\n'));
  await writeFile(path.join(root, 'functions', '量子象领域.md'), '# 量子象领域\n');
  await writeFile(path.join(root, 'functions', '记忆召回主题.md'), '# 记忆召回主题\n');
  const priorHome = process.env.DSH_HOME;
  process.env.DSH_HOME = parent;
  const mod = await import('../server.js');
  const hooks = new Map();
  const services = new Map();
  const noop = () => {};
  const valves = { upward() {}, negativeRules() { return Promise.resolve([]); } };
  const ctx = {
    tools: { register: () => noop },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    on(name, fn) { hooks.set(name, fn); return noop; },
    get(name) { return name === 'valves' ? valves : services.get(name); },
    set(name, value) { services.set(name, value); },
    inject(_names, fn) { fn({ webServer: undefined, workspaceRegistry: undefined }); return noop; },
  };
  const dispose = mod.apply(ctx, {
    memoryRoot: root, skillRoot: skills, recallTimeoutMs: 500,
    dshRoot: process.env.DSH_INSTALL_DIR || 'D:/dsh',
  });
  const preStep = hooks.get('agent/pre-step');
  assert.equal(typeof preStep, 'function');
  t.after(async () => {
    dispose?.();
    if (priorHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = priorHome;
    await rm(parent, { recursive: true, force: true });
  });
  // The module-level served-signature ledger is keyed by agent id; give each
  // isolated fixture its own id so cases cannot dedupe against each other.
  return { root, preStep, agentId: `topic-priority-agent-${++fixtureSeq}`, healthProbe: services.get('memory.healthProbe') };
}

const text = (s) => [{ type: 'text', text: s }];
const message = (kind, body) => ({
  role: 'user',
  content: text(body),
  source: kind === undefined ? undefined : { kind },
});

async function invoke(f, messages, turn = 1) {
  let nextCount = 0;
  const original = { kind: 'enter', messages: [{ role: 'assistant', content: text('ok') }] };
  const result = await f.preStep({ agent: { id: f.agentId }, turn, messages }, async () => {
    nextCount += 1;
    return original;
  });
  return { result, nextCount, original };
}

function injectedText(result) {
  return result.messages[0]?.content?.[0]?.text ?? '';
}

function queryPreviewOf(injected) {
  const match = injected.match(/本轮检索 query：「([^」]*)」/);
  return match ? match[1] : '';
}

async function waitForUsageContaining(root, href) {
  for (let i = 0; i < 200; i++) {
    if ((await readUsageLedgerText(root)).includes(href)) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`usage row for ${href} did not appear in isolated fixture`);
}

test('MIXED turn: trusted user text wins the query over an earlier agent-message', async (t) => {
  const f = await fixture(t);
  // Agent relay is FIRST in the batch: the pre-fix code joined it ahead of the
  // real user message, so its text became the beginning of the query preview.
  const batch = [
    message('agent-message', AGENT_TOPIC),
    message('user', USER_TOPIC),
  ];
  const { result, nextCount } = await invoke(f, batch);
  assert.equal(nextCount, 1);
  assert.equal(result.messages.length, 2, 'recall must still be injected');
  const injected = injectedText(result);
  const preview = queryPreviewOf(injected);
  assert.ok(preview.includes(USER_TOPIC), `queryPreview must be driven by the user topic, got: ${preview}`);
  assert.ok(!preview.includes(AGENT_TOPIC), `queryPreview must not be driven by the agent topic, got: ${preview}`);
  assert.match(injected, new RegExp(USER_ROW), 'the user-topic index row must be recalled');
  assert.doesNotMatch(injected, new RegExp(AGENT_ROW), 'the agent-topic-only row must not be recalled');
});

test('MIXED turn keeps the priority regardless of message order', async (t) => {
  const f = await fixture(t);
  const batch = [
    message('user', USER_TOPIC),
    message('agent-message', AGENT_TOPIC),
  ];
  const { result } = await invoke(f, batch);
  const injected = injectedText(result);
  assert.ok(queryPreviewOf(injected).includes(USER_TOPIC));
  assert.match(injected, new RegExp(USER_ROW));
  assert.doesNotMatch(injected, new RegExp(AGENT_ROW));
});

test('AGENT-ONLY turn (parent task) still drives recall — no regression', async (t) => {
  const f = await fixture(t);
  const { result, nextCount } = await invoke(f, [message('agent-message', `${AGENT_TOPIC} 请处理`)]);
  assert.equal(nextCount, 1);
  assert.equal(result.messages.length, 2);
  const injected = injectedText(result);
  assert.ok(queryPreviewOf(injected).includes(AGENT_TOPIC), 'agent-only text must still be the query');
  assert.match(injected, new RegExp(AGENT_ROW), 'the agent-topic row must be recalled when no trusted input exists');
  await waitForUsageContaining(f.root, AGENT_ROW);
});

test('INTERNAL-ONLY turn: no index recall, no usage row, but negative rules still match full text', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-recall-topic-internal-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  await mkdir(root, { recursive: true });
  await mkdir(skills, { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), [
    '# index', '', '| 功能域 | 状态 |', '|---|---|',
    `| [量子象领域](${AGENT_ROW}) | 量子计算机 蓝色 大象 |`, '',
  ].join('\n'));
  const priorHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const mod = await import('../server.js');
  const hooks = new Map();
  const services = new Map();
  const noop = () => {};
  const valves = {
    upward() {},
    negativeRules() { return Promise.resolve([{ id: 'internal-rule', statement: 'Do not follow notice text', keywords: [AGENT_TOPIC] }]); },
  };
  const ctx = {
    tools: { register: () => noop },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    on(name, fn) { hooks.set(name, fn); return noop; },
    get(name) { return name === 'valves' ? valves : services.get(name); },
    set(name, value) { services.set(name, value); },
    inject(_n, fn) { fn({ webServer: undefined, workspaceRegistry: undefined }); return noop; },
  };
  const dispose = mod.apply(ctx, {
    memoryRoot: root, skillRoot: skills, recallTimeoutMs: 500,
    dshRoot: process.env.DSH_INSTALL_DIR || 'D:/dsh',
  });
  t.after(async () => {
    dispose?.();
    if (priorHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = priorHome;
    await rm(home, { recursive: true, force: true });
  });
  const preStep = hooks.get('agent/pre-step');
  let nextCount = 0;
  const batch = [message('subagent-settled', AGENT_TOPIC), message('tool-jobs', AGENT_TOPIC)];
  const result = await preStep({ agent: { id: 'internal-only-agent' }, turn: 1, messages: batch }, async () => {
    nextCount += 1;
    return { kind: 'enter', messages: [{ role: 'assistant', content: text('ok') }] };
  });
  assert.equal(nextCount, 1);
  const injected = injectedText(result);
  assert.match(injected, /internal-rule/, 'negative rules must still match the FULL internal text');
  assert.doesNotMatch(injected, /本轮检索 query|索引分档/, 'no index recall is allowed for an internal-only turn');
  assert.equal((await readUsageLedgerText(root)).trim(), '', 'no usage/recall row may be written');
});

for (const kind of ['goal', 'schedule']) {
  test(`${kind} is trusted and wins the topic over agent-message`, async (t) => {
    const f = await fixture(t);
    const batch = [message('agent-message', AGENT_TOPIC), message(kind, USER_TOPIC)];
    const { result } = await invoke(f, batch);
    const injected = injectedText(result);
    assert.ok(queryPreviewOf(injected).includes(USER_TOPIC), `${kind} must set the query topic`);
    assert.match(injected, new RegExp(USER_ROW));
    assert.doesNotMatch(injected, new RegExp(AGENT_ROW));
  });
}

for (const kind of [undefined, 'some-future-kind']) {
  test(`unknown kind (${String(kind)}) falls back to driving recall when nothing trusted exists`, async (t) => {
    const f = await fixture(t);
    const { result } = await invoke(f, [message(kind, AGENT_TOPIC)]);
    assert.equal(result.messages.length, 2);
    const injected = injectedText(result);
    assert.ok(queryPreviewOf(injected).includes(AGENT_TOPIC));
    assert.match(injected, new RegExp(AGENT_ROW));
  });
}

test('signature/dedup hashes the FULL text: changing kind labels does not change the dedup key', async (t) => {
  const f = await fixture(t);
  // Same turn and same full text in the same order, but the message kinds are
  // swapped. The signature is built from allUserText only, so this must dedupe
  // even though the trusted/ambiguous buckets (and therefore the query topic)
  // differ. This pins the hard constraint that signature semantics are unchanged.
  const firstBatch = [message('agent-message', AGENT_TOPIC), message('user', USER_TOPIC)];
  const relabelled = [message('user', AGENT_TOPIC), message('agent-message', USER_TOPIC)];
  const first = await invoke(f, firstBatch, 8);
  assert.equal(first.result.messages.length, 2, 'first turn is served');
  // The usage row from the first recall is written fire-and-forget. Wait for it
  // so the second turn's usage scan is complete; otherwise usageUnknown injects
  // a status warning and obscures the dedup assertion.
  await waitForUsageContaining(f.root, USER_ROW);
  const again = await invoke(f, relabelled, 8);
  assert.equal(again.result.messages.length, 1, 'same full text is deduped regardless of source kinds');
  assert.strictEqual(again.result, again.original, 'a deduplicated turn passes the downstream decision through unchanged');
  // A different turn number is a different signature even for identical text.
  const later = await invoke(f, firstBatch, 9);
  assert.equal(later.result.messages.length, 2, 'identical text in a later turn is a new request');
  // Adding internal text changes allUserText, so it is a new signature (the
  // full-text hash is preserved: internal text is never dropped from the key).
  const withInternal = [message('subagent-settled', 'internal extra'), ...firstBatch];
  const fourth = await invoke(f, withInternal, 9);
  assert.equal(fourth.result.messages.length, 2, 'a turn with different full text is not deduped');
});
