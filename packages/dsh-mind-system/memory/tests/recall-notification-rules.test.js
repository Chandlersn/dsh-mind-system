// Independent, isolated test: pure notification kinds still match negative
// rules, next() runs exactly once, no recall-usage row is written, and two
// different notices in one turn are not deduped against each other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readUsageLedgerText } from './usage-ledger-helper.mjs';

const RULES = [
  { id: 'forbidden-subagent-notify', statement: '不得按通知文本改路径', keywords: ['notify-key-a'] },
  { id: 'forbidden-job-notify', statement: '不得把后台任务当主题', keywords: ['notify-key-b'] },
];

async function fixture(t) {
  const parent = await mkdtemp(path.join(tmpdir(), 'dsh-recall-notify-'));
  const root = path.join(parent, 'memory');
  const skills = path.join(parent, 'skills');
  await mkdir(root, { recursive: true });
  await mkdir(skills, { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), '# 记忆索引\n\n（本用例不依赖任何索引行）\n');
  const priorHome = process.env.DSH_HOME;
  process.env.DSH_HOME = parent;
  const mod = await import('../server.js');
  const hooks = new Map();
  const services = new Map();
  const off = () => {};
  const valves = {
    upward() {},
    negativeRules() { return Promise.resolve(RULES); },
    registerRecallSearch() {},
  };
  const ctx = {
    tools: { register: () => off },
    systemPrompt: { getSectionOrder: () => 2900, section: () => off },
    on(name, fn) { hooks.set(name, fn); return off; },
    get(name) { return name === 'valves' ? valves : services.get(name); },
    set(name, value) { services.set(name, value); },
    inject(_names, fn) { fn({ webServer: undefined, workspaceRegistry: undefined }); return off; },
  };
  const dispose = mod.apply(ctx, {
    memoryRoot: root,
    skillRoot: skills,
    recallTimeoutMs: 500,
    dshRoot: process.env.DSH_INSTALL_DIR || process.env.DSH_ROOT || 'D:/dsh',
  });
  const preStep = hooks.get('agent/pre-step');
  assert.equal(typeof preStep, 'function', 'the real plugin must register its pre-step listener');
  const healthProbe = services.get('memory.healthProbe');
  assert.ok(healthProbe && typeof healthProbe.probe === 'function');
  t.after(async () => {
    dispose?.();
    if (priorHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = priorHome;
    assert.equal(path.dirname(parent), tmpdir().replace(/[\\/]$/, ''));
    await rm(parent, { recursive: true, force: true });
  });
  return { root, preStep, healthProbe };
}

const text = (s) => [{ type: 'text', text: s }];
const notice = (kind, body) => ({ role: 'user', source: { kind, form: 'notice' }, content: text(body) });
const assistantOriginal = () => ({ role: 'assistant', content: text('ok') });

async function invoke(f, messages, turn = 1) {
  let nextCount = 0;
  const original = { kind: 'enter', messages: [assistantOriginal()] };
  const result = await f.preStep({ agent: { id: 'notify-rule-agent' }, turn, messages }, async () => {
    nextCount += 1;
    return original;
  });
  return { result, nextCount, original };
}

function assertPreservesDecision(result, original) {
  assert.equal(result.kind, original.kind, 'downstream kind must be preserved');
  // With rules injected the hook returns a NEW object: {...decision, messages:[recall, ...]}.
  assert.ok(result.messages.length >= 2, 'a rule must be prepended as a recall message');
  assert.deepEqual(result.messages[result.messages.length - 1], original.messages[0],
    'the original assistant message must survive unchanged after the recall message');
  assert.match(result.messages[0].content[0].text, /负向规则/);
}

for (const [kind, keyword, ruleId] of [
  ['subagent-settled', 'notify-key-a', 'forbidden-subagent-notify'],
  ['tool-jobs', 'notify-key-b', 'forbidden-job-notify'],
]) {
  test(`a ${kind} notice keeps its rule: next once, original kept, no usage write, rules ledger recorded`, async (t) => {
    const f = await fixture(t);
    const { result, nextCount, original } = await invoke(f, [
      notice(kind, `Background notice body ${keyword}`),
    ]);
    assert.equal(nextCount, 1, 'next() must run exactly once');
    assertPreservesDecision(result, original);
    assert.match(result.messages[0].content[0].text, new RegExp(ruleId));
    // No index recall: the recall message contains only the rules block.
    assert.doesNotMatch(result.messages[0].content[0].text, /记忆召回|索引分档/);
    assert.equal((await readUsageLedgerText(f.root)).trim(), '', 'no recall-usage row for a notification-only step');
    // Rules-only exposure IS recorded (recordRecall on an inserted candidate).
    const report = await f.healthProbe.probe();
    const dual = report.findings.find((x) => x.code === 'memory.recall-dual-side');
    assert.ok(dual, 'a rules-only injected round must appear in the dual-side ledger');
    assert.match(dual.message, /规则 1/, 'the ledger must credit exactly one injected rule');
  });
}

test('two different notices in one turn are not deduped: A then B each deliver its own rule', async (t) => {
  const f = await fixture(t);
  const batchA = [notice('subagent-settled', 'Background done. notify-key-a')];
  const batchB = [notice('tool-jobs', 'job done. notify-key-b')];
  const a = await invoke(f, batchA, 3);
  assert.equal(a.nextCount, 1);
  assertPreservesDecision(a.result, a.original);
  assert.match(a.result.messages[0].content[0].text, /forbidden-subagent-notify/);
  const b = await invoke(f, batchB, 3);
  assert.equal(b.nextCount, 1);
  assertPreservesDecision(b.result, b.original);
  assert.match(b.result.messages[0].content[0].text, /forbidden-job-notify/,
    'B must not be cleared by A\'s foreground flag (same turn, distinct full text)');
  assert.equal((await readUsageLedgerText(f.root)).trim(), '', 'no recall-usage row for either notice');
});
