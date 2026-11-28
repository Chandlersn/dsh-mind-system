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

const base = { sourceReason: 'The three observations show the original condition, recurrence and verification.', feature: 'provenance', title: '蒸馏来源核验', summary: '记录素材来源核验', date: '2026-11-19' };

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
  assert.match(text, /- \*\*素材\*\*：2026-11-17、2026-11-18、2026-11-19（仅检查调用方声明的顶层每日文件或归档日节非空，未核验相关性、真实性或是否读过）/);
  const rendered = tool.output.render(args, result);
  assert.match(rendered.map((b) => b.text).join('\n'), /调用方声明的素材日（仅检查顶层文件或归档日节非空，未核验相关性和真实性）/);
});

test('a source that does not exist is refused and leaves no block behind', async (t) => {
  const { root, tools } = await setup(t);
  await seedDays(root, ['2026-11-17', '2026-11-18']);
  const tool = tools.get('memory_write');
  await assert.rejects(
    () => tool.execute({ ...base, sources: ['2026-11-17', '2026-11-18', '2026-11-30'] }, {}),
    /2026-11-30: missing/,
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

test('zero material days cannot create a block, including when an exception is claimed', async t => {
  const { root, tools } = await setup(t);
  const writer = tools.get('memory_write');
  for (const sources of [undefined, []]) {
    for (const cadenceException of [undefined, '安全约束：需要立即保留当天的审计依据']) {
      await assert.rejects(writer.execute({ ...base, ...(sources ? { sources } : {}), ...(cadenceException === undefined ? {} : { cadenceException }) }), /仅确认 0 个素材日/);
    }
  }
  await assert.rejects(readFile(path.join(root, 'functions', 'provenance.md')), { code: 'ENOENT' });
});

test('a short set requires a concrete classified exception and still checks every declared source', async t => {
  const { root, tools } = await setup(t);
  const writer = tools.get('memory_write');
  const days = ['2026-11-17', '2026-11-19'];
  await seedDays(root, days);
  for (const sources of [days.slice(0, 1), days]) {
    for (const cadenceException of [undefined, '', '一般理由：需要提前归档', '用户显式要求', '安全约束：安全约束', '安全约束：。。。', '当日踩坑因果：aaaa']) {
      await assert.rejects(writer.execute({ ...base, ...(sources ? { sources } : {}), ...(cadenceException === undefined ? {} : { cadenceException }) }), /cadenceException/);
    }
  }
  const target = path.join(root, 'functions', 'provenance.md');
  await assert.rejects(readFile(target), {code: 'ENOENT'});
  for (const category of ['用户显式要求', '安全约束', '当日踩坑因果']) {
    const cadenceException = `${category}：须记录当天发现的读取失败导致覆盖原文问题`;
    const result = await writer.execute({ ...base, sources: days, cadenceException });
    assert.equal(result.cadenceException, cadenceException);
    assert.ok((await readFile(target, 'utf8')).includes(cadenceException));
    assert.match(writer.output.render(base, result)[0].text, /调用方声明，未经核验/);
    const previous = await readFile(target);
    await assert.rejects(writer.execute({ ...base, sources: [...days, '2026-11-18'], cadenceException }), /missing/);
    assert.deepEqual(await readFile(target), previous);
  }
});

test('three dates without a caller selection reason are rejected', async t => {
  const { root, tools } = await setup(t);
  const days = ['2026-11-01','2026-11-09','2026-11-19'];
  await seedDays(root, days);
  const writer = tools.get('memory_write');
  const { sourceReason, ...withoutReason } = base;
  const args = { ...withoutReason, sources: days };
  await assert.rejects(writer.execute(args), /sourceReason/);
  await assert.rejects(readFile(path.join(root, 'functions', 'provenance.md')), {code:'ENOENT'});
  const result = await writer.execute({ ...args, verification: 'The last day records resolution after two earlier occurrences.' });
  assert.equal(result.sourceDays.length, 3);
  assert.match(await readFile(result.featureFile, 'utf8'), /last day records resolution/);
  const corrected = await writer.execute({ ...base, sources: days, replace: JSON.stringify({oldString: days[0], newString: 'corrected historical date'}) });
  const latest = (await readFile(corrected.featureFile, 'utf8')).split(corrected.appendedHeading).pop();
  assert.ok(latest.includes(days.join('、')), 'historical corrections must preserve the new evidence declaration');
});
