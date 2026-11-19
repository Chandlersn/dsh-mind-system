// R28 is a lexical sampling signal, not proof of distillation or topic coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectDistillationBacklog, apply } from '../server.js';

const bulk = (topic) => `## Section\n${topic} ${'Detailed material for review. '.repeat(30)}\n`;
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-r28-'));
  mkdirSync(path.join(root, 'functions'));
  writeFileSync(path.join(root, 'MEMORY.md'), '# Index\n');
  return root;
}
function addDays(root, texts) {
  texts.forEach((text, i) => writeFileSync(path.join(root, `2026-11-${10 + i}.md`), bulk(text)));
}
async function preStepText(root) {
  const hooks = new Map();
  const noop = () => {};
  const ctx = {
    tools: { register: () => noop },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    on(name, fn) { hooks.set(name, fn); return noop; },
    get() {}, set() {}, inject(_names, fn) { fn({ webServer: undefined, workspaceRegistry: undefined }); },
  };
  let completed;
  const scanDone = new Promise((resolve) => { completed = resolve; });
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: path.join(root, 'skills'), recallTimeoutMs: 1000 }, {
    async detectDistillationBacklog(scanRoot) {
      try { return await detectDistillationBacklog(scanRoot); } finally { completed(); }
    },
  });
  try {
    const preStep = hooks.get('agent/pre-step');
    const payload = { agent: { id: 'r28-test' }, messages: [{ role: 'user', content: [{ type: 'text', text: 'test candidate scan' }] }] };
    const next = async () => ({ kind: 'enter', messages: [] });
    await preStep({ ...payload, turn: 1 }, next);
    await scanDone;
    const result = await preStep({ ...payload, turn: 2 }, next);
    return result.messages.flatMap((m) => m.content.map((c) => c.text)).join('\n');
  } finally { dispose?.(); }
}

test('a later unrelated iteration cannot make lexical candidates disappear', async () => {
  const root = fixture();
  try {
    const area = path.join(root, 'functions', 'memory-manager.md');
    writeFileSync(area, '# Area\n## [2026-11-01] old\n');
    addDays(root, ['memory_write alpha', 'memory_read beta', 'memory_check gamma']);
    const before = await detectDistillationBacklog(root);
    appendFileSync(area, '\n## [2026-11-20] unrelated iteration\nDifferent subject.\n');
    const after = await detectDistillationBacklog(root);
    assert.deepEqual(before.due[0].days, ['2026-11-10', '2026-11-11', '2026-11-12']);
    assert.deepEqual(after.due[0].days, before.due[0].days);
    assert.equal(after.due[0].newestBlock, '2026-11-20');
    const text = await preStepText(root);
    assert.match(text, /未验证词法候选/);
    assert.doesNotMatch(text, /按纪律用 memory_write|收尾时一并蒸馏/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unrelated unmatched sections are an unverified aggregate, not a structural gap', async () => {
  const root = fixture();
  try {
    addDays(root, ['astronomy', 'baking', 'gardening']);
    const result = await detectDistillationBacklog(root);
    assert.equal(result.orphan.length, 1);
    assert.equal(result.orphan[0].days.length, 3);
    const text = await preStepText(root);
    assert.match(text, /未验证未匹配汇总/);
    assert.match(text, /可能互不相关/);
    assert.doesNotMatch(text, /⚠ 结构缺口/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing functions directory still scans daily files; empty root is valid', async () => {
  const root = fixture();
  try {
    rmSync(path.join(root, 'functions'), { recursive: true });
    assert.deepEqual(await detectDistillationBacklog(root), { due: [], orphan: [] });
    addDays(root, ['alpha', 'beta', 'gamma']);
    const result = await detectDistillationBacklog(root);
    assert.equal(result.orphan.length, 1);
    assert.equal(result.skipped, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('enumeration errors remain unknown and are visible in pre-step', async () => {
  const root = fixture();
  try {
    rmSync(path.join(root, 'functions'), { recursive: true });
    writeFileSync(path.join(root, 'functions'), 'not a directory');
    const result = await detectDistillationBacklog(root);
    assert.match(result.skipped, /ENOTDIR/);
    assert.match(await preStepText(root), /候选扫描未知.*ENOTDIR/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unreadable enumerated files make partial results visible in pre-step', async () => {
  const root = fixture();
  try {
    mkdirSync(path.join(root, 'functions', 'broken.md'));
    writeFileSync(path.join(root, 'functions', 'memory-manager.md'), '# Area\n');
    addDays(root, ['memory_write', 'memory_read', 'memory_check']);
    const result = await detectDistillationBacklog(root);
    assert.equal(result.readUnknown, 1);
    assert.equal(result.due.length, 1);
    const text = await preStepText(root);
    assert.match(text, /候选扫描不完整：1 个文件读不到/);
    assert.match(text, /未验证词法候选/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('threshold is a sampling filter, not a claim of no backlog', async () => {
  const root = fixture();
  try {
    writeFileSync(path.join(root, 'functions', 'memory-manager.md'), '# Area\n');
    addDays(root, ['memory_write', 'memory_read']);
    const result = await detectDistillationBacklog(root);
    assert.deepEqual(result.due, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a blocked scan cannot delay independent recall and is shared until completion', async () => {
  const root = fixture();
  let release;
  let scans = 0;
  let clock = 1000;
  let releaseRefresh;
  const blocked = new Promise((resolve) => { release = resolve; });
  const refresh = new Promise((resolve) => { releaseRefresh = resolve; });
  const hooks = new Map();
  const noop = () => {};
  const ctx = {
    tools: { register: () => noop },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    on(name, fn) { hooks.set(name, fn); return noop; },
    get(name) { return name === 'valves' ? { upward() {}, async negativeRules() { return [{ id: 'test-rule', statement: 'Protect independent recall', keywords: ['独立召回测试'] }]; } } : undefined; },
    set() {}, inject(_names, fn) { fn({ webServer: undefined, workspaceRegistry: undefined }); },
  };
  writeFileSync(path.join(root, 'MEMORY.md'), '# Index\n\n## 功能模块索引（functions/）\n\n| 功能域 | 一句话状态 |\n|---|---|\n| [独立召回测试](functions/独立召回测试.md) | 独立召回测试证据 |\n');
  writeFileSync(path.join(root, 'functions', '独立召回测试.md'), '# Area\n');
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: path.join(root, 'skills'), recallTimeoutMs: 1000 }, {
    now() { return clock; },
    detectDistillationBacklog() { scans++; return scans === 1 ? blocked : refresh; },
  });
  const preStep = hooks.get('agent/pre-step');
  const step = async (turn) => {
    const result = await preStep({ agent: { id: 'r28-blocked' }, turn, messages: [{ role: 'user', content: [{ type: 'text', text: '独立召回测试证据' }] }] }, async () => ({ kind: 'enter', messages: [] }));
    return result.messages.flatMap((m) => m.content.map((c) => c.text)).join('\n');
  };
  try {
    const first = await step(1);
    assert.match(first, /独立召回测试/);
    assert.match(first, /test-rule/);
    assert.match(first, /候选扫描进行中/);
    const second = await step(2);
    assert.match(second, /候选扫描进行中/);
    assert.equal(scans, 1);
    release({ due: [{ area: 'memory-manager', days: ['a', 'b', 'c'], newestBlock: null }], orphan: [] });
    await blocked;
    const third = await step(3);
    assert.match(third, /未验证词法候选：memory-manager/);
    assert.doesNotMatch(third, /候选扫描进行中/);
    assert.equal(scans, 1);
    clock += 600001;
    const fourth = await step(4);
    assert.match(fourth, /候选扫描进行中/);
    assert.match(fourth, /未验证词法候选：memory-manager/);
    assert.match(fourth, /test-rule/);
    assert.equal(scans, 2);
    await step(5);
    assert.equal(scans, 2);
    dispose();
    releaseRefresh({ due: [{ area: 'stale-result', days: ['a', 'b', 'c'] }], orphan: [] });
    await refresh;
    const afterDispose = await step(6);
    assert.doesNotMatch(afterDispose, /stale-result/);
  } finally {
    dispose();
    releaseRefresh({ due: [], orphan: [] });
    release({ due: [], orphan: [] });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a rejected background scan stays unknown and is not retried within the cache interval', async () => {
  const root = fixture();
  const hooks = new Map();
  const noop = () => {};
  let scans = 0;
  let rejectScan;
  const blocked = new Promise((_resolve, reject) => { rejectScan = reject; });
  const ctx = {
    tools: { register: () => noop },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    on(name, fn) { hooks.set(name, fn); return noop; },
    get() {}, set() {}, inject(_names, fn) { fn({ webServer: undefined, workspaceRegistry: undefined }); },
  };
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: path.join(root, 'skills') }, {
    detectDistillationBacklog() { scans++; return blocked; },
  });
  const step = async (turn) => {
    const result = await hooks.get('agent/pre-step')({ agent: { id: 'r28-failure' }, turn, messages: [{ role: 'user', content: [{ type: 'text', text: 'test scan failure' }] }] }, async () => ({ kind: 'enter', messages: [] }));
    return result.messages.flatMap((m) => m.content.map((c) => c.text)).join('\n');
  };
  try {
    assert.match(await step(1), /候选扫描进行中/);
    rejectScan(Object.assign(new Error('scan failed'), { code: 'EIO' }));
    await blocked.catch(() => {});
    assert.match(await step(2), /候选扫描未知.*EIO/);
    assert.match(await step(3), /候选扫描未知.*EIO/);
    assert.equal(scans, 1);
  } finally { dispose(); rmSync(root, { recursive: true, force: true }); }
});
