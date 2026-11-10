import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withMemoryRootTransaction } from '../src/root-transaction.js';

// Instrument the ESM binding before server.js imports it. This changes only the
// module loaded into this isolated test process, never a source or memory file.
const STATE = Symbol.for('dsh.test.recall-budget-failure');
const declaration = 'export function buildBudgetedRecall(lines, heldRows = [], stats = null, archives = [], { maxOptionalBytes = 8192 } = {}) {';
let transformed = 0;
const registration = registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.endsWith('/src/recall.js')) return loaded;
    const source = String(loaded.source);
    assert.ok(source.includes(declaration), 'actual recall module must be instrumented');
    transformed++;
    const original = declaration.replace('export function buildBudgetedRecall', 'function isolatedOriginalBudgetedRecall');
    const instrumented = source.replace(declaration, original) + `\nexport function buildBudgetedRecall(...args) {\n  const state = globalThis[Symbol.for('dsh.test.recall-budget-failure')];\n  if (state) {\n    state.rendererCalls++;\n    if (state.mode === 'throw') {\n      state.threwAfterRules = state.rulesRead;\n      throw new Error('isolated optional renderer failure');\n    }\n  }\n  const result = isolatedOriginalBudgetedRecall(...args);\n  if (state?.mode === 'mutate') {\n    const text = result.message.content[0].text;\n    result.message.content[0].text = text.replace('预算失败正控完整摘要', '变异后的摘要');\n    state.mutated = text !== result.message.content[0].text;\n  }\n  return result;\n}\n`;
    return { ...loaded, source: instrumented };
  },
});

async function fixture(t, apply, mod, mode) {
  const parent = await mkdtemp(path.join(tmpdir(), 'memory-budget-failure-'));
  const root = path.join(parent, 'memory');
  const skills = path.join(parent, 'skills');
  await mkdir(path.join(root, 'functions'), { recursive: true });
  await mkdir(skills, { recursive: true });
  const summary = '预算失败正控完整摘要';
  const href = 'functions/预算失败正控.md';
  const index = [
    '# 记忆索引', '', '## 功能模块索引（functions/）', '',
    '| 功能域 | 一句话状态 |', '|---|---|',
    `| [预算失败正控](${href}) | ${summary} |`, '',
  ].join('\n');
  await writeFile(path.join(root, 'MEMORY.md'), index);
  await writeFile(path.join(root, href), '# 预算失败正控\n');
  const rules = [
    { id: 'failure-rule-a', statement: '甲：完整保留中文😀及符号 "\\/。', keywords: ['预算失败正控'] },
    { id: 'failure-rule-b', statement: '乙：不得在格式器故障时丢失这条规则。', keywords: ['预算失败正控'] },
  ];
  const payload = {
    agent: { id: `synthetic-${mode}` }, turn: 1,
    messages: [{ role: 'user', content: [{ type: 'text', text: '处理预算失败正控' }] }],
  };
  const matched = mod.matchIndexRows(index, mod.tokensOf('处理预算失败正控'), 3);
  assert.ok(matched.some((item) => item.href === href), 'fixture must actually select the optional row');
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = parent;
  const state = { mode, rulesRead: false, rendererCalls: 0, threwAfterRules: false };
  globalThis[STATE] = state;
  const hooks = new Map();
  const noop = () => {};
  const ctx = {
    tools: { register: () => noop },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    on(name, fn) { hooks.set(name, fn); return noop; },
    get(name) { return name === 'valves' ? { upward() {}, async negativeRules() { state.rulesRead = true; return rules; } } : undefined; },
    set() {},
    inject(_names, fn) { fn({ webServer: undefined, workspaceRegistry: undefined }); },
  };
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, recallOptionalBudgetBytes: 8192 });
  const preStep = hooks.get('agent/pre-step');
  assert.equal(typeof preStep, 'function');
  t.after(async () => {
    dispose?.();
    await withMemoryRootTransaction(root, async () => {});
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    delete globalThis[STATE];
    assert.equal(path.dirname(parent), path.resolve(tmpdir()));
    assert.ok(path.basename(parent).startsWith('memory-budget-failure-'));
    await rm(parent, { recursive: true, force: true });
  });
  return { root, href, summary, rules, payload, preStep, state };
}

function assertRenderedSummary(text, summary) {
  assert.ok(text.includes(summary), 'actual message must include the complete selected summary');
}

async function runCase(t, apply, mod, mode) {
  const f = await fixture(t, apply, mod, mode);
  let nextCalls = 0;
  const result = await f.preStep(f.payload, async () => { nextCalls++; return { kind: 'enter', messages: [] }; });
  assert.equal(nextCalls, 1, 'next must be called exactly once');
  assert.equal(f.state.rulesRead, true, 'real valves bridge must retrieve rules');
  assert.equal(f.state.rendererCalls, 1, 'the instrumented actual renderer must be reached');
  assert.equal(result.messages.length, 1, 'actual admission must include a recall message');
  const text = result.messages[0].content[0].text;
  const ruleHeader = '### ⛔ 负向规则（valves · 已人工确认）';
  const ruleOffset = text.indexOf(ruleHeader);
  assert.ok(ruleOffset >= 0, 'actual message must contain the rules block');
  const expectedRules = [ruleHeader, '', '以下禁令与本轮输入相关，动手前先核对，命中即换路径：', ...f.rules.map((rule) => `- [${rule.id}] ${rule.statement}`)].join('\n');
  assert.equal(text.slice(ruleOffset), expectedRules, 'all rules must be retained byte-for-byte and in order');
  // Fire-and-forget writes resolve the root asynchronously before joining its
  // queue; a single barrier can race that resolution. Positive cases wait for
  // actual bytes, while the empty case observes repeated event-loop turns.
  let recalls = [];
  for (let attempt = 0; attempt < (mode === 'throw' ? 12 : 1000); attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
    await withMemoryRootTransaction(f.root, async () => {});
    const usage = await readFile(path.join(f.root, '.usage.jsonl'), 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    recalls = usage.split('\n').filter(Boolean).map(JSON.parse).filter((entry) => entry.kind === 'recall');
    if (mode !== 'throw' && recalls.length) break;
  }
  if (mode === 'throw') {
    assert.equal(f.state.threwAfterRules, true, 'fault must occur only after the actual rule retrieval');
    assert.ok(!text.includes(f.summary), 'failed optional renderer must not expose a row');
    assert.equal(recalls.length, 0, 'usage must not record rows which were not rendered');
  } else {
    assert.deepEqual(recalls.map((entry) => entry.href), [f.href], 'positive control must observe the selected row in usage');
    if (mode === 'mutate') {
      assert.equal(f.state.mutated, true, 'the fault must actually alter the rendered message');
      assert.throws(() => assertRenderedSummary(text, f.summary), assert.AssertionError, 'the positive-control assertion must reject the mutated renderer');
    } else {
      assertRenderedSummary(text, f.summary);
    }
  }
}

test('可选渲染同步异常不丢已取得的完整规则，正常渲染正控可检出内容变异', async (t) => {
  try {
    const mod = await import('../server.js');
    assert.equal(transformed, 1, 'one actual recall module must have been instrumented');
    await t.test('正常渲染正控', async (child) => runCase(child, mod.apply, mod, 'normal'));
    await t.test('格式器真实输出被变异时正控断言会失败', async (child) => runCase(child, mod.apply, mod, 'mutate'));
    await t.test('真实 formatter 在读取规则后同步抛错', async (child) => runCase(child, mod.apply, mod, 'throw'));
  } finally {
    registration.deregister();
    delete globalThis[STATE];
  }
});
