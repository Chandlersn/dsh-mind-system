/**
 * Distillation provenance (2026-11-19).
 *
 * The ">=3 topic-relevant material days" rule used to be prompt-only: the written
 * block could assert it while nothing in the artifact showed which days were read.
 * These tests pin the three states a block can be in — verified sources, an
 * explicit caller-declared exception, and undeclared provenance — and reject a
 * declaration that cannot be resolved on disk.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function setup(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-distill-provenance-'));
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  await mkdir(path.join(root, 'functions'), { recursive: true });
  await mkdir(path.join(root, 'insights'), { recursive: true });
  await mkdir(skills, { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), '# 索引\n\n## 功能模块索引\n\n| 功能域 | 一句话状态 / 待验证 |\n|---|---|\n');
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
    assert.match(path.basename(home), /^dsh-distill-provenance-/);
    await rm(home, { recursive: true, force: true });
  });
  return { root, tools };
}

const base = { feature: 'provenance', title: '蒸馏来源核验', summary: '记录素材来源核验', date: '2026-11-19' };

async function seedDays(root, days) {
  for (const day of days) {
    await writeFile(path.join(root, `${day}.md`), `# ${day}\n\n## 判断与取舍\n- 素材 ${day}\n`);
  }
}

test('declared sources must resolve on disk and are persisted in the block', async (t) => {
  const { root, tools } = await setup(t);
  await seedDays(root, ['2026-11-17', '2026-11-18', '2026-11-19']);
  const tool = tools.get('memory_write');
  const args = { ...base, sources: ['2026-11-17', '2026-11-18', '2026-11-19'] };
  const result = await tool.execute(args, {});
  assert.deepEqual(result.sourceDays, ['2026-11-17', '2026-11-18', '2026-11-19']);
  assert.equal(result.sourceDaysUndeclared, false);
  const text = await readFile(path.join(root, 'functions', 'provenance.md'), 'utf8');
  assert.match(text, /- \*\*素材\*\*：2026-11-17、2026-11-18、2026-11-19（仅检查声明的每日文件存在且非空）/);
  const rendered = tool.output.render(args, result);
  assert.match(rendered.map((b) => b.text).join('\n'), /声明的素材日（仅检查文件存在且非空）/);
});

test('a source that does not exist is refused and leaves no block behind', async (t) => {
  const { root, tools } = await setup(t);
  await seedDays(root, ['2026-11-17', '2026-11-18']);
  const tool = tools.get('memory_write');
  await assert.rejects(
    () => tool.execute({ ...base, sources: ['2026-11-17', '2026-11-18', '2026-11-30'] }, {}),
    /2026-11-30.*伪造证据/s,
  );
  await assert.rejects(() => readFile(path.join(root, 'functions', 'provenance.md'), 'utf8'), /ENOENT/);
});

test('duplicate or malformed dates are refused before any write', async (t) => {
  const { root, tools } = await setup(t);
  await seedDays(root, ['2026-11-17', '2026-11-18', '2026-11-19']);
  const tool = tools.get('memory_write');
  await assert.rejects(() => tool.execute({ ...base, sources: ['2026-11-17', '2026-11-17', '2026-11-18'] }, {}), /duplicate date/);
  await assert.rejects(() => tool.execute({ ...base, sources: ['2026-11-17', '17/11/2026', '2026-11-18'] }, {}), /not a YYYY-MM-DD date/);
});

test('invalid calendar dates are refused even if matching files exist', async (t) => {
  const { root, tools } = await setup(t);
  await seedDays(root, ['2026-99-99', '2026-02-29']);
  for (const date of ['2026-99-99', '2026-02-29']) {
    await assert.rejects(() => tools.get('memory_write').execute({ ...base, sources: [date] }, {}), /not a YYYY-MM-DD date/);
  }
  await assert.rejects(() => readFile(path.join(root, 'functions', 'provenance.md'), 'utf8'), /ENOENT/);
});

test('an empty daily file is not evidence of a material day', async (t) => {
  const { root, tools } = await setup(t);
  await seedDays(root, ['2026-11-17', '2026-11-18']);
  await writeFile(path.join(root, '2026-11-19.md'), '   \n');
  const tool = tools.get('memory_write');
  await assert.rejects(() => tool.execute({ ...base, sources: ['2026-11-17', '2026-11-18', '2026-11-19'] }, {}), /缺失或为空/);
});

test('undeclared provenance is recorded as undeclared instead of implied', async (t) => {
  const { root, tools } = await setup(t);
  const tool = tools.get('memory_write');
  const result = await tool.execute({ ...base }, {});
  assert.equal(result.sourceDaysUndeclared, true);
  assert.deepEqual(result.sourceDays, []);
  // A clean write keeps the existing no-warning contract; the truth lives in the
  // receipt field and the block, not as noise on every write.
  assert.deepEqual(result.warnings.filter((w) => /素材/.test(w)), []);
  const text = await readFile(path.join(root, 'functions', 'provenance.md'), 'utf8');
  assert.match(text, /- \*\*素材\*\*：未声明（素材天数未知）/);
});

test('an exception without declared sources leaves the number of days unknown', async (t) => {
  const { root, tools } = await setup(t);
  const tool = tools.get('memory_write');
  for (const [feature, sources] of [['omitted', undefined], ['empty', []]]) {
    const args = { ...base, feature, cadenceException: '用户显式要求立即蒸馏', ...(sources ? { sources } : {}) };
    const result = await tool.execute(args, {});
    assert.equal(result.sourceDaysUndeclared, true);
    assert.deepEqual(result.sourceDays, []);
    assert.equal(result.cadenceException, args.cadenceException);
    const text = await readFile(path.join(root, 'functions', `${feature}.md`), 'utf8');
    assert.match(text, /未声明（素材天数未知）/);
    assert.doesNotMatch(text, /不足 3 天/);
    const rendered = tool.output.render(args, result).map((b) => b.text).join('\n');
    assert.match(rendered, /素材日：未声明/);
    assert.match(rendered, /豁免（调用方声明，未经核验）/);
  }
});

test('fewer than three days needs an explicit, labelled exception', async (t) => {
  const { root, tools } = await setup(t);
  await seedDays(root, ['2026-11-19']);
  const tool = tools.get('memory_write');
  const warned = await tool.execute({ ...base, sources: ['2026-11-19'] }, {});
  assert.ok(warned.warnings.some((w) => /<3/.test(w)), 'two-day write must warn, not silently pass');
  assert.match(await readFile(path.join(root, 'functions', 'provenance.md'), 'utf8'), /素材\*\*：2026-11-19（仅检查声明的每日文件存在且非空；声明少于 3 天）/);

  const excepted = { ...base, feature: 'excepted', sources: ['2026-11-19'], cadenceException: '当日踩坑因果：重复踩同一个坑' };
  const result = await tool.execute(excepted, {});
  assert.equal(result.cadenceException, excepted.cadenceException);
  const text = await readFile(path.join(root, 'functions', 'excepted.md'), 'utf8');
  assert.match(text, /仅检查声明的每日文件存在且非空/);
  assert.match(text, /（豁免：当日踩坑因果：重复踩同一个坑；调用方声明，未经核验）/);
  assert.doesNotMatch(text, /未声明/);
  const rendered = tool.output.render(excepted, result).map((b) => b.text).join('\n');
  assert.match(rendered, /豁免（调用方声明，未经核验）/);
});