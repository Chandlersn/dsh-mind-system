import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function setup(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-raw-protection-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  await mkdir(path.join(root, 'functions'), { recursive: true });
  await mkdir(path.join(root, 'insights'), { recursive: true });
  await mkdir(skills, { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), '# 索引\n\n## 功能模块索引\n\n| 功能域 | 一句话状态 / 待验证 |\n|---|---|\n| [source](functions/source.md) | 旧功能 |\n');
  const tools = new Map();
  const noop = () => {};
  const ctx = {
    tools: { register: (def) => { tools.set(def.name, def); return noop; } },
    on: () => noop,
    inject: (_names, fn) => fn({ webServer: undefined, workspaceRegistry: undefined }),
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
  };
  const { apply } = await import('../server.js');
  const dispose = apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR });
  t.after(async () => {
    dispose?.();
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.match(path.basename(home), /^dsh-raw-protection-/);
    await rm(home, { recursive: true, force: true });
  });
  return { root, tools };
}

function checkOutput(tool, args, result) {
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result, 'tool output must be lossless JSON');
  const schema = tool.output.schema;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(result).filter((k) => !(k in schema.properties)), [], 'no undeclared output keys');
  for (const [k, p] of Object.entries(schema.properties)) {
    if (p.required) assert.ok(Object.hasOwn(result, k), `required output ${k}`);
    if (!Object.hasOwn(result, k)) continue;
    const value = result[k];
    if (p.type === 'array') assert.ok(Array.isArray(value), `${k} must be an array`);
    else if (p.type === 'integer') assert.ok(Number.isInteger(value), `${k} must be an integer`);
    else if (p.type === 'object') assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${k} must be an object`);
    else if (p.type) assert.equal(typeof value, p.type, `${k} must match its declared type`);
  }
  const blocks = tool.output.render(args, result);
  assert.ok(Array.isArray(blocks) && blocks.every((b) => b.type === 'text' && typeof b.text === 'string'));
  return blocks.map((b) => b.text).join('\n');
}

test('memory_write resolve 保留历史日记并诚实报告未勾选', async (t) => {
  const { root, tools } = await setup(t);
  const daily = path.join(root, '2026-01-01.md');
  const original = '# 原始证据\n\n## 今日待观察\n- 遗留 → [functions/legacy.md](functions/legacy.md)\n';
  await writeFile(daily, original);
  const tool = tools.get('memory_write');
  assert.ok(tool);
  const args = { feature: 'result', title: '隔离迭代', summary: '记录此功能的新结果', resolve: 'legacy', date: '2026-01-02' };
  const result = await tool.execute(args, {});
  assert.equal(await readFile(daily, 'utf8'), original);
  assert.match(await readFile(path.join(root, 'functions', 'result.md'), 'utf8'), /隔离迭代/);
  assert.deepEqual(result.resolvedDailyLogs, []);
  assert.ok(result.warnings.some((s) => /未修改或勾选/.test(s) && /未确认/.test(s)));
  const rendered = checkOutput(tool, args, result);
  assert.match(rendered, /未修改或勾选/);
  assert.doesNotMatch(rendered, /✅ 已勾掉待观察项/);
});

for (const merge of [false, true]) test(`memory_rename ${merge ? '合并' : '改名'}只改派生链接并保留每日原文`, async (t) => {
  const { root, tools } = await setup(t);
  const source = path.join(root, 'functions', 'source.md');
  const target = path.join(root, 'functions', 'target.md');
  const daily = path.join(root, '2025-12-31.md');
  const original = '# 历史记录\n\n- 原文 [source](functions/source.md)\n';
  await writeFile(source, '# Source\n\nsource only evidence\n');
  if (merge) await writeFile(target, '# Target\n\ntarget only evidence\n');
  await writeFile(path.join(root, 'functions', 'reference.md'), '# Ref\n\n- [source](source.md)\n');
  await writeFile(path.join(root, 'insights', 'principle.md'), '# Principle\n\n- [source](../functions/source.md)\n');
  await writeFile(daily, original);
  const tool = tools.get('memory_rename');
  const args = { from: 'source', to: 'target' };
  const result = await tool.execute(args, {});
  assert.equal(result.mode, merge ? 'merged' : 'renamed');
  assert.equal(await readFile(daily, 'utf8'), original);
  assert.ok(!result.rewrittenFiles.includes('2025-12-31.md'));
  await assert.rejects(readFile(source, 'utf8'), { code: 'ENOENT' });
  const targetText = await readFile(target, 'utf8');
  assert.match(targetText, /source only evidence/);
  if (merge) assert.match(targetText, /target only evidence/);
  assert.match(await readFile(path.join(root, 'functions', 'reference.md'), 'utf8'), /target\.md/);
  assert.match(await readFile(path.join(root, 'insights', 'principle.md'), 'utf8'), /functions\/target\.md/);
  assert.ok(result.danglingAfter >= 1, '原样保留的历史链接必须被真实 R10 计数');
  assert.ok(result.warnings.some((s) => /原始证据/.test(s) && /跳过/.test(s) && /旧名/.test(s)));
  const rendered = checkOutput(tool, args, result);
  assert.match(rendered, /原始证据/);
  assert.match(rendered, /历史链接可能仍指向旧名/);
});
