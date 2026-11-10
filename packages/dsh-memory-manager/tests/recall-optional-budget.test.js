import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildRecallMessage } from '../src/recall.js';
import { withMemoryRootTransaction } from '../src/root-transaction.js';

// The 8192-byte limit applies to the *complete rendered optional block*, not
// to characters, estimated tokens, individual fields, or the mandatory rules.
// These are isolated inputs; none is read from or written to the real memory.
const BUDGET = 8192;
const stats = (injected = 0, held = 0) => ({ matched: injected + held, injected, held, dropped: 0, budget: 600, usedTokens: 0 });
const asText = (message) => message.content[0].text;
const bytes = (text) => Buffer.byteLength(text, 'utf8');
const opts = { optionalBudgetBytes: BUDGET };
const longText = (prefix) => `${prefix}${'中文预算😀https://example.invalid/路径?x=%22%F0%9F%98%80&y=\\\\'.repeat(450)}结束标记`;
const row = (name, summary, extra = {}) => ({ name, summary, href: `functions/${name}.md`, zone: 'function', ...extra });

function hasBudgetOmissionNotice(text) {
  return /(?:预算|字节)[^\n]*(?:省略|略去|未带入)|(?:省略|略去|未带入)[^\n]*(?:预算|字节)/.test(text);
}

function assertWholeOrOmitted(text, payload, label) {
  const marker = payload.slice(0, Math.min(30, payload.length));
  if (text.includes(marker)) assert.ok(text.includes(payload), `${label} 不得截断输出`);
}

test('超长首条整项省略、可选渲染不超 UTF-8 预算，实际带入计数准确', () => {
  const huge = row('超长首项', longText('首条摘要开始'));
  const small = row('后续短项', '后续短项完整内容');
  const text = asText(buildRecallMessage([huge, small], [], stats(2), [], opts));
  assert.ok(bytes(text) <= BUDGET, `完整可选区 ${bytes(text)} 字节 > ${BUDGET}`);
  assertWholeOrOmitted(text, huge.summary, '超长首项');
  assert.ok(!text.includes(huge.summary), '单个条目大于预算时必须整项省略');
  assert.ok(text.includes(small.summary), '超长首项不应阻止后续能容纳的短项');
  assert.ok(hasBudgetOmissionNotice(text), '必须说明预算导致的省略');
  assert.match(text, /最终带入\s*1\s*条索引\/修复项/, '实际条数必须排除省略的强档行');
});

test('档案与决策修复按整项预算取舍，缺失档案和实际带入须可见', () => {
  const giantArchive = { kind: '## 决策共识 / 规范', text: longText('超长档案开始') };
  const smallArchive = { kind: '## 道层', text: '短档案原文：预算实验可复查。' };
  const giantRepair = row('超长修复项', longText('修复正文开始'), { repair: { corrections: 7, badRate: 0.9 } });
  const smallRepair = row('短修复项', '修复正文小样本', { repair: { corrections: 4, badRate: 0.8 } });
  const text = asText(buildRecallMessage([giantRepair, smallRepair], [], stats(2), [giantArchive, smallArchive], opts));
  assert.ok(bytes(text) <= BUDGET, `完整可选区 ${bytes(text)} 字节 > ${BUDGET}`);
  assertWholeOrOmitted(text, giantArchive.text, '档案');
  assertWholeOrOmitted(text, giantRepair.summary, '修复');
  assert.ok(!text.includes(giantArchive.text) && !text.includes(giantRepair.summary));
  assert.ok(text.includes(smallArchive.text) && text.includes(smallRepair.summary), '短档案和修复项应仍可被纳入');
  assert.match(text, /最终带入\s*1\s*条索引\/修复项/);
  assert.ok(hasBudgetOmissionNotice(text), '省略时应提示预算并说明需要查阅');
  assert.match(text, /(?:档案[^\n]*(?:1|一)|(?:1|一)[^\n]*档案)/, '必须如实提示省略一个档案');
  assert.match(text, /(?:修复[^\n]*(?:1|一)|(?:1|一)[^\n]*修复)/, '必须如实提示省略一个修复项');
});

test('长 held 名称也计入可选预算，UTF-8 不截断且总数准确', () => {
  const kept = row('短索引', '短索引内容');
  const held = Array.from({ length: 5 }, (_, i) => ({ name: longText(`暂缓名称${i}开始`), href: `functions/held-${i}.md`, zone: 'function', score: 1 }));
  const text = asText(buildRecallMessage([kept], held, stats(1, held.length), [], opts));
  assert.ok(bytes(text) <= BUDGET, `包含格式和 held 的可选区 ${bytes(text)} 字节 > ${BUDGET}`);
  for (const item of held) assertWholeOrOmitted(text, item.name, '暂缓名称');
  assert.ok(text.includes(kept.summary));
  assert.match(text, /暂缓\s*5|5\s*条相关度未达强档/, '相关度暂缓总数仍应为 5');
  assert.ok(hasBudgetOmissionNotice(text), '预算删去暂缓名称时应区分原有分档与省略');
});

async function isolatedHook(t) {
  const parent = await mkdtemp(path.join(tmpdir(), 'memory-optional-budget-'));
  const root = path.join(parent, 'memory');
  const skills = path.join(parent, 'skills');
  await mkdir(path.join(root, 'functions'), { recursive: true });
  await mkdir(skills, { recursive: true });
  const index = [
    '# 记忆索引', '', '## 决策共识 / 规范', '',
    `- 召回预算测试档案 ${longText('档案锚点')}`, '',
    '## 功能模块索引（functions/）', '', '| 功能域 | 一句话状态 |', '|---|---|',
    `| [召回预算测试功能](functions/召回预算测试功能.md) | 召回预算测试 ${longText('索引首项锚点')} |`,
    '| [辅助修复](functions/辅助修复.md) | 修复正文小样本 |', '',
  ].join('\n');
  await writeFile(path.join(root, 'MEMORY.md'), index);
  await writeFile(path.join(root, 'functions', '召回预算测试功能.md'), '# 召回预算测试功能\n');
  await writeFile(path.join(root, 'functions', '辅助修复.md'), '# 辅助修复\n');
  const correction = JSON.stringify({ t: new Date().toISOString(), href: 'functions/辅助修复.md', kind: 'correction' });
  await writeFile(path.join(root, '.usage.jsonl'), `${correction}\n${correction}\n`);
  const rules = [
    { id: 'rule-a', statement: longText('禁止规则甲开始'), keywords: ['召回预算测试'] },
    { id: 'rule-b', statement: longText('禁止规则乙开始'), keywords: ['召回预算测试'] },
  ];
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = parent;
  const { apply } = await import('../server.js');
  const hooks = new Map();
  const services = new Map();
  const noop = () => {};
  const ctx = {
    tools: { register: () => noop },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    on(name, fn) { hooks.set(name, fn); return noop; },
    get(name) { return name === 'valves' ? { upward() {}, async negativeRules() { return rules; } } : undefined; },
    set(name, service) { services.set(name, service); },
    inject(_names, fn) { fn({ webServer: undefined, workspaceRegistry: undefined }); },
  };
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, recallOptionalBudgetBytes: BUDGET });
  const preStep = hooks.get('agent/pre-step');
  assert.equal(typeof preStep, 'function');
  const payload = { agent: { id: 'isolated-optional-budget-agent' }, turn: 1, messages: [{ role: 'user', content: [{ type: 'text', text: '处理召回预算测试功能' }] }] };
  t.after(async () => {
    dispose?.();
    // Drain admitted recall's fire-and-forget usage updates before removing the
    // isolated root, including when an assertion above deliberately fails.
    await withMemoryRootTransaction(root, async () => {});
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    assert.equal(path.dirname(parent), path.resolve(tmpdir()));
    assert.ok(path.basename(parent).startsWith('memory-optional-budget-'));
    await rm(parent, { recursive: true, force: true });
  });
  return { root, preStep, payload, rules, services };
}

test('真实 pre-step 控制完整可选区，同时保留超预算的全部负向规则及其顺序', async (t) => {
  const f = await isolatedHook(t);
  let nextCalls = 0;
  const result = await f.preStep(f.payload, async () => { nextCalls++; return { kind: 'enter', messages: [] }; });
  assert.equal(nextCalls, 1);
  assert.equal(result.messages.length, 1, '测试必须实际接纳召回消息');
  const full = result.messages[0].content[0].text;
  const marker = '### ⛔ 负向规则';
  const separator = full.indexOf(marker);
  assert.ok(separator >= 0, '实际消息应包含负向规则块');
  const optional = full.slice(0, separator).replace(/\n\n$/, '');
  const ruleBlock = full.slice(separator);
  for (const rule of f.rules) assert.ok(ruleBlock.includes(`- [${rule.id}] ${rule.statement}`), `必须完整注入 ${rule.id}`);
  assert.ok(ruleBlock.indexOf('[rule-a]') < ruleBlock.indexOf('[rule-b]'), '保留规则原顺序');
  assert.ok(bytes(ruleBlock) > BUDGET, '正控：规则本身大于可选预算');
  const visible = ['functions/召回预算测试功能.md', 'functions/辅助修复.md'].filter((href) => optional.includes(`](${href})`));
  // Drain real fire-and-forget writes before making deliberately red budget
  // assertions or disposing of the isolated test root.
  if (visible.length) {
    let recorded = [];
    for (let i = 0; i < 1000; i++) {
      const raw = await readFile(path.join(f.root, '.usage.jsonl'), 'utf8');
      recorded = raw.trim().split('\n').map(JSON.parse).filter((event) => event.kind === 'recall').map((event) => event.href);
      if (recorded.length >= visible.length) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(recorded.sort(), visible.sort(), '曝光账本只能记录实际入选的项');
  } else {
    const raw = await readFile(path.join(f.root, '.usage.jsonl'), 'utf8');
    assert.equal(raw.split('\n').filter(Boolean).map(JSON.parse).filter((event) => event.kind === 'recall').length, 0);
  }
  assert.ok(bytes(optional) <= BUDGET, `真实 hook 可选区 ${bytes(optional)} 字节 > ${BUDGET}`);
  assert.ok(hasBudgetOmissionNotice(optional));
  assert.ok(!optional.includes(longText('档案锚点')) && !optional.includes(longText('索引首项锚点')));
  const count = /最终带入\s*(\d+)\s*条索引\/修复项/.exec(optional);
  assert.ok(count, '显示的最终带入条数必须可核对');
  assert.equal(Number(count[1]), visible.length, '消息计数必须等于真正入选的索引/修复项');
});
