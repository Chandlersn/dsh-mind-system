// Actual apply/pre-step and configured health probe with a completely isolated
// memory root. Exposure is checked against the message that really entered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const query = 'alpha bravo charlie delta echo';
const heldName = 'held-' + 'h'.repeat(1200);
const longSummary = 'alpha bravo charlie delta echo ' + 'z'.repeat(1800);
const repairSummary = 'repair ' + 'q'.repeat(1800);
const archive = 'alpha bravo charlie delta echo ' + '档'.repeat(900);
const refs = {
  long: 'functions/longitem.md',
  short: 'functions/shortitem.md',
  repair: 'functions/repair.md',
  held: `functions/${heldName}.md`,
};

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'memory-recall-budget-metrics-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  await mkdir(path.join(root, 'functions'), { recursive: true });
  await mkdir(skills, { recursive: true });
  const index = [
    '# 记忆索引', '', '## 功能模块索引（functions/）', '',
    '| 功能域 | 一句话状态 |', '|---|---|',
    `| [long](${refs.long}) | ${longSummary} |`,
    `| [short](${refs.short}) | alpha bravo charlie delta echo shortok |`,
    `| [held](${refs.held}) | alpha bravo charlie heldnote |`,
    `| [repair](${refs.repair}) | ${repairSummary} |`, '',
    '## 决策共识 / 规范', '', `- ${archive}`, '',
  ].join('\n');
  await writeFile(path.join(root, 'MEMORY.md'), index, 'utf8');
  for (const name of ['longitem', 'shortitem', 'repair']) {
    await writeFile(path.join(root, 'functions', `${name}.md`), `# ${name}\n`, 'utf8');
  }
  const tNow = new Date().toISOString();
  const usageFile = path.join(root, '.usage.jsonl');
  await writeFile(usageFile, [1, 2].map(() => JSON.stringify({ t: tNow, href: refs.repair, kind: 'correction' })).join('\n') + '\n');
  const beforeHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const mod = await import('../server.js');
  const hooks = new Map(), services = new Map();
  const noop = () => {};
  const ctx = {
    tools: { register: () => noop },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    on(name, fn) { hooks.set(name, fn); return noop; },
    get() { return undefined; },
    set(name, service) { services.set(name, service); },
    inject(_names, fn) { fn({ webServer: undefined, workspaceRegistry: undefined }); },
  };
  const dispose = mod.apply(ctx, { memoryRoot: root, skillRoot: skills, recallOptionalBudgetBytes: 900, recallTimeoutMs: 3000 });
  const preStep = hooks.get('agent/pre-step');
  assert.equal(typeof preStep, 'function');
  assert.ok(services.get('memory.healthProbe'), 'must use real configured plugin probe');
  // Prove the long ordinary and short rows are strong, while the long name is
  // already in the held channel. The repeated-correction repair is separate.
  const matched = mod.matchIndexRows(index, mod.tokensOf(query), 3);
  assert.deepEqual(matched.map((r) => r.href), [refs.long, refs.short]);
  assert.ok(matched.heldRows.some((r) => r.href === refs.held));
  t.after(async () => {
    dispose?.();
    if (beforeHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = beforeHome;
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.ok(path.basename(home).startsWith('memory-recall-budget-metrics-'));
    await rm(home, { recursive: true, force: true });
  });
  return { root, usageFile, preStep, probe: services.get('memory.healthProbe') };
}

async function waitForUsage(file, href) {
  for (let i = 0; i < 1000; i++) {
    const entries = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
    if (entries.some((e) => e.kind === 'recall' && e.href === href)) return entries;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('expected asynchronous exposure entry did not complete');
}

test('真实注入后的预算曝光：省略四类与 UTF-8 字节必须与实际内容一致', async (t) => {
  const f = await fixture(t);
  const payload = { agent: { id: 'budget-observation-test' }, messages: [{ role: 'user', content: [{ type: 'text', text: query }] }] };
  const rejected = { kind: 'reject' };
  assert.strictEqual(await f.preStep(payload, async () => rejected), rejected);
  const before = await f.probe.probe();
  assert.equal(before.findings.some((f) => f.code === 'memory.recall-dual-side'), false, 'a rejected candidate must not enter the exposure ledger');
  const result = await f.preStep(payload, async () => ({ kind: 'enter', messages: [] }));
  assert.equal(result.messages.length, 1, 'there must be an actual admitted message');
  const text = result.messages[0].content[0].text;
  const actualBytes = Buffer.byteLength(text, 'utf8'); // no rules in this fixture
  assert.ok(actualBytes <= 900, `the final optional text must fit: ${actualBytes}`);
  assert.match(text, /shortok/, 'short item proves useful content still enters');
  assert.doesNotMatch(text, /z{100}/, 'long strong row must be omitted');
  assert.doesNotMatch(text, /q{100}/, 'long repair must be omitted');
  assert.doesNotMatch(text, /档{100}/, 'long archive must be omitted');
  assert.doesNotMatch(text, /h{100}/, 'the long held name must be omitted');
  const omitted = /索引\/修复 (\d+) 条（其中修复 (\d+) 条）、暂缓 (\d+) 条、档案 (\d+) 条/.exec(text);
  assert.ok(omitted, 'the injected message must disclose the omitted items');
  const [, rows, repairs, held, archives] = omitted.map(Number);
  assert.deepEqual({ rows, repairs, held, archives }, { rows: 2, repairs: 1, held: 1, archives: 1 }, 'fixture independently establishes omitted counts');
  const usage = await waitForUsage(f.usageFile, refs.short);
  const exposed = usage.filter((e) => e.kind === 'recall').map((e) => e.href);
  assert.deepEqual(exposed, [refs.short], 'usage exposure records only the short row actually included');
  const report = await f.probe.probe();
  const finding = report.findings.find((f) => f.code === 'memory.recall-dual-side');
  assert.ok(finding, 'the actual configured health probe must report the admitted round');
  assert.match(finding.message, /最终索引\/修复项 1，档案 0，规则 0/);
  const budgetSection = finding.message.split('可选预算省略')[1]?.split('；')[0];
  assert.ok(budgetSection, 'probe must expose budget omissions, not only pre-budget matching');
  assert.match(budgetSection, /索引\/修复\s*2/);
  assert.match(budgetSection, /修复\s*1/);
  assert.match(budgetSection, /暂缓\s*1/);
  assert.match(budgetSection, /档案\s*1/);
  assert.match(finding.message, new RegExp(`可选文本峰值\\s*${actualBytes}\\s*字节`), 'reported UTF-8 bytes must equal the admitted text, including formatting and notices');
});
